import {
  createKindredEditor,
  bindToolbar,
  getPlain,
  getHtml,
  setHtml,
  refreshOverlay,
  plainToHtml,
  conflictDisplayHtml,
  parseConflictSegments,
  conflictMarkerCount,
  htmlHasAlignConflict,
  unresolvedMergeConflictCount,
  joinConflictBoth,
  formatConflictMarkers,
  isFormatOnlyConflict,
} from "./tiptapEditor.js";
import { importFileToHtml, htmlToExportBlob, EXPORT_FORMATS } from "./pandocConvert.js";
import { KindredGitStore } from "./gitStore.js";
import { marked } from "marked";
import DOMPurify from "dompurify";

(() => {
  const DIFF_EQUAL = 0;
  const DIFF_INSERT = 1;
  const DIFF_DELETE = -1;
  const SAVE_DEBOUNCE_MS = 250;
  const store = KindredGitStore;

  const editor = document.getElementById("editor");
  const toolbarEl = document.getElementById("editor-toolbar");
  const feedbackEl = document.getElementById("feedback");
  const draftListEl = document.getElementById("draft-list");
  const draftsHeading = document.getElementById("drafts-heading");
  const feedbackTabs = document.getElementById("feedback-tabs");
  const paneModeCluster = document.getElementById("pane-mode-cluster");
  const gitPane = document.getElementById("git-pane");
  const gitBranchList = document.getElementById("git-branch-list");
  const gitCommitList = document.getElementById("git-commit-list");
  const gitNewBranchBtn = document.getElementById("git-new-branch");
  const chatComposer = document.getElementById("chat-composer");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const statusEl = document.getElementById("status");
  const metaEl = document.getElementById("meta");
  const analyzeBtn = document.getElementById("analyze-btn");
  const importBtn = document.getElementById("import-btn");
  const exportControls = document.getElementById("export-controls");
  const exportBtn = document.getElementById("export-btn");
  const exportMenuBtn = document.getElementById("export-menu-btn");
  const exportMenu = document.getElementById("export-menu");
  const homeBtn = document.getElementById("home-btn");
  const draftHeaderSep = document.getElementById("draft-header-sep");
  const draftHeaderTitleEl = document.getElementById("draft-header-title");
  const draftHeaderTitleInput = document.getElementById("draft-header-title-input");
  const scopeTabs = feedbackTabs.querySelectorAll(".tab");
  const panes = document.getElementById("panes");
  const draftPane = document.getElementById("draft-pane");
  const divider = document.getElementById("divider");

  const DEFAULT_MODEL = "openai/gpt-5.6-luna";
  // HtmlDiff treats "<...>" as tags; shield raw "<" in plain text.
  const HTMLDIFF_LT = "\uE000";
  const HTMLDIFF_ACTION = { equal: 0, delete: 1, insert: 2, none: 3, replace: 4 };
  let diffsCacheKey = null;
  let diffsCacheParts = null;

  let baseline = "";
  let currentText = "";
  let currentHtml = "";
  let result = null;
  let mode = "global";
  let paneMode = "review";
  let activeSentence = null;
  let activeParagraph = null;
  let chatFocus = { scope: "text", index: null };
  let chats = {};
  let chatBusy = false;
  let chatDrafts = { text: "", sentence: "", paragraph: "" };
  let localSentencePct = 40.00;
  let localResizing = false;
  let rendering = false;
  let analyzing = false;
  let converting = false;
  let applyingHistory = false;
  let currentModel = DEFAULT_MODEL;
  let revisionCost = 0;
  let draftCost = 0;
  let statusMessage = "";
  let statusLevel = "";
  let drafts = [];
  let activeDraftId = null;
  let saveTimer = null;
  let commits = [];
  let activeCommitIndex = -1;
  let viewingOid = null;
  let headOid = null;
  let headPlain = "";
  let dirtyViewMode = "Text"; // "Diff" | "Text"
  let dirtyReviewing = false;
  let currentBranchName = "main";
  let branches = [];
  let hasConflict = false;
  let pendingMerge = null;
  let gitBusy = false;
  let workingDirty = false;
  let renamingDraftId = null;
  let renameSource = null; // "header" | "list"

  let tipTap = null;
  let suppressEditorUpdate = false;

  function syncOverlayFromState() {
    if (!tipTap) return;
    const marked =
      unresolvedMergeConflictCount(currentHtml) > 0 ? currentHtml : "";
    const viewing = isViewingHistory();
    const conflictMode = dirtyReviewing ? "review" : "merge";
    const wasSuppressed = suppressEditorUpdate;
    suppressEditorUpdate = true;
    try {
      if (marked) {
        refreshOverlay(tipTap, {
          baseline: "",
          currentPlain: "",
          highlight: null,
          markedHtml: marked,
          conflictMode,
        });
      } else if (viewing) {
        // History view diffs vs previous commit; analysis spans use a different baseline.
        refreshOverlay(tipTap, {
          baseline,
          currentPlain: currentText,
          highlight: null,
          markedHtml: "",
          conflictMode,
        });
      } else if (dirtyViewMode === "Diff") {
        refreshOverlay(tipTap, {
          baseline: headPlain,
          currentPlain: currentText,
          highlight: null,
          markedHtml: "",
          conflictMode,
        });
      } else {
        // text: empty both so whole-doc is not painted as insert
        refreshOverlay(tipTap, {
          baseline: "",
          currentPlain: "",
          highlight: null,
          markedHtml: "",
          conflictMode,
        });
      }
    } finally {
      suppressEditorUpdate = wasSuppressed;
    }
  }

  async function plainAtCommitOid(oid) {
    if (!oid || !activeDraftId || !store) return "";
    const snap = await store.readAtCommit(activeDraftId, oid);
    return store.htmlToPlain(snap.html || snap.text || "");
  }

  async function refreshHeadPlain() {
    if (!headOid) {
      headPlain = "";
      return;
    }
    headPlain = await plainAtCommitOid(headOid);
  }

  /** Plain text of the commit before `index` (oldest→newest), or "" if none. */
  async function previousCommitPlain(index) {
    if (index <= 0 || !commits.length) return "";
    return plainAtCommitOid(commits[index - 1].oid);
  }

  function pullFromEditor() {
    if (!tipTap || suppressEditorUpdate) return;
    if (conflictMarkerCount(currentHtml) > 0) {
      // Text conflict markers use display anchors — don't pull TipTap HTML.
      currentText = getPlain(tipTap);
      return;
    }
    currentHtml = getHtml(tipTap);
    currentText = getPlain(tipTap);
  }

  tipTap = createKindredEditor({
    element: editor,
    content: "",
    diffsFn: (a, b) => diffs(a, b),
    onConflictAction: (action, index) => handleConflictAction(action, index),
    onAlignConflictAction: (action, paraPos) => handleAlignConflictAction(action, paraPos),
    onUpdate: () => {
      if (
        suppressEditorUpdate ||
        rendering ||
        analyzing ||
        converting ||
        applyingHistory ||
        gitBusy ||
        isViewingHistory()
      ) {
        return;
      }
      pullFromEditor();
      if (pendingMerge || hasConflict || htmlHasAlignConflict(currentHtml)) syncMergeStatus();
      refreshStatusLeft();
      workingDirty = true;
      updateAnalyzeBtn();
      syncOverlayFromState();
      syncHeaderTitle();
      void ensureDraftForText(currentText).then(() => {
        syncRightPane();
        updateAnalyzeBtn();
      });
      persistActiveDraftSoon();
    },
    placeholder: editor.dataset.placeholder || "Paste or type your text here. Double-click to import.",
  });
  bindToolbar(tipTap, toolbarEl);

  function clearHistory() {
    tipTap?.commands.clearHistory?.();
  }

  function isViewingHistory() {
    return !!viewingOid;
  }

  function setEditorEditable(editable) {
    tipTap?.setEditable(editable);
  }

  function editorIsEmpty() {
    return !(currentText || "").trim();
  }

  function setExportMenuOpen(open) {
    const next = !!open && !exportMenuBtn.disabled && !exportControls.hidden;
    exportMenu.hidden = !next;
    exportMenuBtn.setAttribute("aria-expanded", next ? "true" : "false");
    exportControls.classList.toggle("is-open", next);
  }

  function updateExportBtn() {
    const hasText = !editorIsEmpty();
    const exportDisabled =
      converting || analyzing || gitBusy || !hasText || isViewingHistory();
    importBtn.hidden = !activeDraftId;
    exportControls.hidden = !activeDraftId;
    importBtn.disabled = !canOpenImportDialog();
    exportBtn.disabled = exportDisabled;
    exportMenuBtn.disabled = exportDisabled;
    if (exportDisabled || !activeDraftId) setExportMenuOpen(false);
  }

  function updateAnalyzeBtn() {
    const hasText = !editorIsEmpty();
    const unresolved = unresolvedMergeConflictCount(currentHtml) > 0;
    const finishMerge = !!(pendingMerge && !unresolved);
    analyzeBtn.hidden = !activeDraftId;
    if (paneMode === "git") {
      analyzeBtn.textContent = pendingMerge ? "Merge" : "Commit";
      analyzeBtn.disabled =
        analyzing ||
        converting ||
        gitBusy ||
        !hasText ||
        isViewingHistory() ||
        unresolved ||
        (!workingDirty && !finishMerge);
    } else {
      analyzeBtn.textContent = "Analyze";
      analyzeBtn.disabled =
        analyzing || converting || gitBusy || !hasText || isViewingHistory();
    }
    updateExportBtn();
  }

  async function refreshWorkingDirty() {
    if (!activeDraftId || !store) {
      workingDirty = false;
      updateAnalyzeBtn();
      return;
    }
    try {
      workingDirty = await store.isDirty(activeDraftId);
    } catch (err) {
      console.warn("kindred: dirty check failed", err);
      workingDirty = true;
    }
    updateAnalyzeBtn();
  }

  function syncScopeTabSelection() {
    scopeTabs.forEach((t) => {
      const on = t.dataset.mode === mode;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function syncPaneModeTabs() {
    paneModeCluster.querySelectorAll(".tab[data-pane]").forEach((t) => {
      const on = t.dataset.pane === paneMode;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    paneModeCluster.querySelectorAll(".tab-group").forEach((g) => {
      g.classList.toggle("is-active", g.dataset.group === paneMode);
    });
  }

  function setStatus(msg, level = "") {
    statusMessage = (msg || "").toLowerCase();
    statusLevel = statusMessage ? level : "";
    refreshStatusLeft();
  }

  function countStats(text) {
    const raw = text || "";
    const trimmed = raw.trim();
    const chars = raw.length;
    const words = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
    let sentences = 0;
    let paragraphs = 0;
    if (trimmed) {
      paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim()).length || 1;
      sentences = trimmed.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length;
    }
    return { words, chars, sentences, paragraphs };
  }

  function pluralize(n, singular) {
    return `${n} ${singular}${n === 1 ? "" : "s"}`;
  }

  function statusSpan(text, cls) {
    const el = document.createElement("span");
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  }

  function appendStatusParts(parent, parts) {
    parts.forEach((part, i) => {
      if (i > 0) parent.append(" · ");
      parent.append(part);
    });
  }

  function refreshStatusLeft() {
    const { words, chars, sentences, paragraphs } = countStats(currentText);
    const counts = [
      pluralize(words, "word"),
      pluralize(chars, "char"),
      pluralize(sentences, "sentence"),
      pluralize(paragraphs, "paragraph"),
    ].join(" · ");

    const statusParts = [];
    if (isViewingHistory()) {
      statusParts.push(statusSpan("viewing old commit", "status-warn"));
    }
    if (statusMessage) {
      const cls =
        statusLevel === "danger"
          ? "status-danger"
          : statusLevel === "warn" || hasConflict
            ? "status-warn"
            : "";
      statusParts.push(statusSpan(statusMessage, cls));
    }
    if (activeDraftId) {
      if (currentBranchName) statusParts.push(currentBranchName);
      const oid = viewingOid || headOid;
      if (oid) statusParts.push(shortOid(oid));
    }

    statusEl.replaceChildren();
    statusEl.append(counts);
    if (statusParts.length) {
      statusEl.append("\u2003|\u2003");
      appendStatusParts(statusEl, statusParts);
    }
  }

  function formatAnalysisProgress(event) {
    return [
      `analyzing...`,
      `sentences ${event.sentences_done}/${event.sentences_total}`,
      `paragraphs ${event.paragraphs_done}/${event.paragraphs_total}`,
      `text ${event.text_done}/${event.text_total}`,
    ].join(" · ");
  }

  function formatCost(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return "$0.0000";
    return `$${v.toFixed(4)}`;
  }

  function updateMeta() {
    metaEl.textContent =
      `${currentModel} · ${formatCost(revisionCost)} this revision` +
      ` · ${formatCost(draftCost)} total`;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderMarkdown(text) {
    return DOMPurify.sanitize(marked.parse(text || "", { breaks: true }));
  }

  function formatDraftTime(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function draftTitle(draft) {
    if (draft.title) return draft.title;
    return store.titleFromText(draft.text || "");
  }

  function activeDraftDisplayTitle() {
    if (!activeDraftId) return "";
    const draft = findDraft(activeDraftId);
    if (draft?.customTitle) return draftTitle(draft);
    return (
      store.titleFromText(currentHtml || currentText || "") ||
      (draft ? draftTitle(draft) : "")
    );
  }

  function isHeaderRenaming() {
    return (
      !!renamingDraftId &&
      renameSource === "header" &&
      renamingDraftId === activeDraftId
    );
  }

  function syncHeaderTitle() {
    if (!draftHeaderTitleEl || !draftHeaderTitleInput) return;
    if (isHeaderRenaming()) return;
    draftHeaderTitleInput.hidden = true;
    if (!activeDraftId) {
      draftHeaderTitleEl.textContent = "";
      draftHeaderTitleEl.hidden = true;
      draftHeaderTitleEl.removeAttribute("title");
      if (draftHeaderSep) draftHeaderSep.hidden = true;
      return;
    }
    const title = activeDraftDisplayTitle();
    draftHeaderTitleEl.textContent = title;
    draftHeaderTitleEl.hidden = !title;
    draftHeaderTitleEl.title = title ? "Rename draft" : "";
    if (draftHeaderSep) draftHeaderSep.hidden = !title;
  }

  function startHeaderRename() {
    if (!activeDraftId || !draftHeaderTitleEl || !draftHeaderTitleInput) return;
    if (isViewingHistory()) return;
    renamingDraftId = activeDraftId;
    renameSource = "header";
    const title = activeDraftDisplayTitle();
    draftHeaderTitleEl.hidden = true;
    if (draftHeaderSep) draftHeaderSep.hidden = false;
    draftHeaderTitleInput.hidden = false;
    draftHeaderTitleInput.value = title;
    draftHeaderTitleInput.focus();
    draftHeaderTitleInput.select();
  }

  function findDraft(id) {
    return drafts.find((d) => d.id === id) || null;
  }

  async function refreshDraftList() {
    drafts = await store.listDrafts();
    syncHeaderTitle();
    // Avoid remounting the rename input (focusout would commit after one key).
    if (renamingDraftId) return;
    renderDraftList();
  }

  function snapshotState() {
    return {
      html: currentHtml,
      text: currentHtml,
      baseline,
      result,
      chats,
      model: currentModel,
      revisionCost,
      totalCost: draftCost,
      hasConflict,
      pendingMerge,
      activeBranch: currentBranchName,
    };
  }

  async function persistActiveDraftNow() {
    if (!activeDraftId || isViewingHistory()) return;
    try {
      await store.saveWorkingTree(activeDraftId, snapshotState());
      await refreshDraftList();
      await refreshWorkingDirty();
    } catch (err) {
      console.warn("kindred: failed to save draft", err);
    }
  }

  function persistActiveDraftSoon() {
    if (!activeDraftId || isViewingHistory()) return;
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistActiveDraftNow();
    }, SAVE_DEBOUNCE_MS);
  }

  async function flushSaveTimer() {
    if (saveTimer != null) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await persistActiveDraftNow();
    }
  }

  async function createDraft(text) {
    const html =
      tipTap && !(hasConflict || unresolvedMergeConflictCount(currentHtml) > 0)
        ? getHtml(tipTap)
        : currentHtml || plainToHtml(text || "");
    const draft = await store.createDraft({ html, text: html });
    activeDraftId = draft.id;
    commits = [];
    activeCommitIndex = -1;
    viewingOid = null;
    headOid = null;
    headPlain = "";
    currentBranchName = "main";
    branches = ["main"];
    hasConflict = false;
    pendingMerge = null;
    dirtyReviewing = false;
    workingDirty = !!(text || "").trim();
    paneMode = "review";
    await refreshDraftList();
    return draft;
  }

  async function ensureDraftForText(text) {
    if (activeDraftId) {
      persistActiveDraftSoon();
      return findDraft(activeDraftId);
    }
    if (!(text || "").length) return null;
    const draft = await createDraft(text);
    syncRightPane();
    updateAnalyzeBtn();
    return draft;
  }

  async function refreshCommits() {
    if (!activeDraftId) {
      commits = [];
      activeCommitIndex = -1;
      headOid = null;
      headPlain = "";
      refreshStatusLeft();
      return;
    }
    currentBranchName = await store.currentBranch(activeDraftId);
    branches = await store.listBranches(activeDraftId);
    commits = await store.listCommits(activeDraftId, currentBranchName);
    headOid = commits.length ? commits[commits.length - 1].oid : null;
    if (viewingOid) {
      const idx = commits.findIndex((c) => c.oid === viewingOid);
      activeCommitIndex = idx >= 0 ? idx : commits.length - 1;
      if (idx < 0) viewingOid = null;
    } else if (commits.length) {
      activeCommitIndex = commits.length - 1;
    } else {
      activeCommitIndex = -1;
    }
    await refreshHeadPlain();
    refreshStatusLeft();
  }

  function showHomePane() {
    paneMode = "review";
    feedbackTabs.hidden = true;
    paneModeCluster.hidden = true;
    draftsHeading.hidden = false;
    feedbackEl.hidden = true;
    chatComposer.hidden = true;
    gitPane.hidden = true;
    draftListEl.hidden = false;
    analyzeBtn.hidden = true;
    importBtn.hidden = true;
    exportControls.hidden = true;
    setExportMenuOpen(false);
    renderDraftList();
    syncPaneModeTabs();
  }

  function showComposePane() {
    draftsHeading.hidden = true;
    draftListEl.hidden = true;
    paneModeCluster.hidden = false;
    syncPaneModeTabs();
    if (paneMode === "git") {
      feedbackTabs.hidden = true;
      feedbackEl.hidden = true;
      chatComposer.hidden = true;
      gitPane.hidden = false;
      renderGitPane();
    } else {
      feedbackTabs.hidden = true;
      feedbackEl.hidden = false;
      chatComposer.hidden = true;
      gitPane.hidden = true;
      renderFeedback();
    }
    updateAnalyzeBtn();
  }

  function showReviewPane() {
    draftsHeading.hidden = true;
    draftListEl.hidden = true;
    paneModeCluster.hidden = false;
    syncPaneModeTabs();
    if (paneMode === "git") {
      feedbackTabs.hidden = true;
      feedbackEl.hidden = true;
      chatComposer.hidden = true;
      gitPane.hidden = false;
      renderGitPane();
    } else {
      feedbackTabs.hidden = !result;
      feedbackEl.hidden = false;
      gitPane.hidden = true;
      syncChatComposer();
      renderFeedback();
    }
    updateAnalyzeBtn();
  }

  function syncRightPane() {
    if (!activeDraftId) showHomePane();
    else if (result || hasConflict) showReviewPane();
    else showComposePane();
  }

  function renderDraftList() {
    if (!drafts.length) {
      draftListEl.innerHTML =
        `<p class="draft-list-empty">No drafts yet. Type or paste on the left to create one.</p>`;
      return;
    }
    draftListEl.innerHTML = drafts
      .map((d) => {
        const active = d.id === activeDraftId ? " active" : "";
        const branch = d.activeBranch ? ` · ${d.activeBranch}` : "";
        const title = escapeHtml(draftTitle(d));
        const renaming = renamingDraftId === d.id && renameSource === "list";
        const titleHtml = renaming
          ? `<input class="draft-item-title-input" data-action="rename-input" value="${title}" aria-label="Draft title" />`
          : `<span class="draft-item-title">${title}</span>`;
        return (
          `<div class="draft-item${active}" role="listitem" data-id="${escapeHtml(d.id)}">` +
          `<div class="draft-item-body" data-action="open">` +
          titleHtml +
          `<span class="draft-item-meta">${escapeHtml(formatDraftTime(d.updatedAt))}${escapeHtml(branch)}</span>` +
          `</div>` +
          `<button type="button" class="draft-item-delete" data-action="delete" title="Delete draft" aria-label="Delete draft">×</button>` +
          `</div>`
        );
      })
      .join("");
    if (renamingDraftId && renameSource === "list") {
      const input = draftListEl.querySelector(
        `.draft-item[data-id="${CSS.escape(renamingDraftId)}"] .draft-item-title-input`
      );
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  function applyRevisionToEditor() {
    suppressEditorUpdate = true;
    rendering = true;
    try {
      const hasMarkers = conflictMarkerCount(currentHtml) > 0;
      const unresolved =
        hasMarkers || htmlHasAlignConflict(currentHtml);
      // Drop stale conflict widgets before setContent so index-0 is not rebound to old sides.
      if (tipTap) {
        refreshOverlay(tipTap, {
          baseline: "",
          currentPlain: "",
          highlight: null,
          markedHtml: "",
        });
      }
      if (unresolved) {
        hasConflict = true;
        if (hasMarkers) {
          setHtml(tipTap, conflictDisplayHtml(currentHtml), { emitUpdate: false });
        } else {
          setHtml(tipTap, currentHtml || "<p></p>", { emitUpdate: false });
        }
      } else {
        setHtml(tipTap, currentHtml || "<p></p>", { emitUpdate: false });
      }
      currentText = getPlain(tipTap);
      syncOverlayFromState();
    } finally {
      rendering = false;
      suppressEditorUpdate = false;
    }
  }

  function loadSnapshotState(snap, { historical = false, historyBaseline = undefined } = {}) {
    // Past commits / tip-after-commit: diff against previous commit when provided.
    baseline =
      historyBaseline !== undefined
        ? historyBaseline
        : snap.baseline || "";
    currentHtml = snap.html || snap.text || "";
    if (!currentHtml) currentHtml = "<p></p>";
    currentText = ""; // filled by applyRevisionToEditor via getPlain
    result = snap.result || null;
    chats =
      snap.chats && typeof snap.chats === "object" && !Array.isArray(snap.chats)
        ? snap.chats
        : {};
    currentModel = snap.model || DEFAULT_MODEL;
    revisionCost = Number(snap.revisionCost);
    if (!Number.isFinite(revisionCost)) revisionCost = 0;
    if (snap.totalCost != null) {
      draftCost = Number(snap.totalCost);
      if (!Number.isFinite(draftCost)) draftCost = revisionCost;
    }
    if (historical) {
      // Merge bookkeeping is working-tree only; never adopt it from old commits.
      hasConflict = false;
      pendingMerge = null;
      dirtyReviewing = false;
    } else {
      hasConflict =
        !!snap.hasConflict || unresolvedMergeConflictCount(currentHtml) > 0;
      pendingMerge = snap.pendingMerge || null;
      dirtyReviewing = hasConflict && !pendingMerge;
    }
    activeSentence = null;
    activeParagraph = null;
    chatFocus = { scope: "text", index: null };
    chatDrafts = { text: "", sentence: "", paragraph: "" };
    mode = "global";
    syncScopeTabSelection();
    clearHistory();
    applyRevisionToEditor();
    setEditorEditable(!historical);
    updateMeta();
    syncMergeStatus();
    refreshStatusLeft();
    updateAnalyzeBtn();
    syncRightPane();
  }

  function resetEditorState({ text = "", keepHistory = false } = {}) {
    baseline = "";
    currentHtml = text ? plainToHtml(text) : "<p></p>";
    currentText = "";
    result = null;
    chats = {};
    chatFocus = { scope: "text", index: null };
    chatDrafts = { text: "", sentence: "", paragraph: "" };
    activeSentence = null;
    activeParagraph = null;
    mode = "global";
    syncScopeTabSelection();
    currentModel = DEFAULT_MODEL;
    revisionCost = 0;
    draftCost = 0;
    commits = [];
    activeCommitIndex = -1;
    viewingOid = null;
    headOid = null;
    headPlain = "";
    currentBranchName = "main";
    branches = [];
    hasConflict = false;
    pendingMerge = null;
    dirtyReviewing = false;
    workingDirty = false;
    if (!keepHistory) clearHistory();
    suppressEditorUpdate = true;
    rendering = true;
    try {
      setHtml(tipTap, currentHtml, { emitUpdate: false });
      currentText = getPlain(tipTap);
      syncOverlayFromState();
    } finally {
      rendering = false;
      suppressEditorUpdate = false;
    }
    setEditorEditable(true);
    updateMeta();
    setStatus("");
    refreshStatusLeft();
    updateAnalyzeBtn();
    syncRightPane();
  }

  async function goHome() {
    await flushSaveTimer();
    activeDraftId = null;
    paneMode = "review";
    resetEditorState({ text: "" });
    syncHeaderTitle();
    tipTap?.commands.focus();
  }

  async function openDraft(id) {
    await flushSaveTimer();
    const draft = findDraft(id) || (await store.readWorkingFiles(id));
    if (!draft) return;
    activeDraftId = id;
    paneMode = "review";
    viewingOid = null;
    const wt = await store.readWorkingFiles(id);
    draftCost = Number(wt.totalCost);
    if (!Number.isFinite(draftCost)) draftCost = 0;
    hasConflict = !!wt.hasConflict;
    pendingMerge = wt.pendingMerge || null;
    if (hasConflict) paneMode = "git";
    await refreshCommits();
    loadSnapshotState(wt, { historical: false });
    if (commits.length) activeCommitIndex = commits.length - 1;
    await refreshDraftList();
    if (paneMode === "git") renderGitPane();
    await refreshWorkingDirty();
  }

  async function deleteDraft(id) {
    const summary = findDraft(id);
    if (summary && summary.commitCount > 0) {
      const ok = window.confirm("Delete this draft and its commit history?");
      if (!ok) return;
    }
    await flushSaveTimer();
    await store.deleteDraft(id);
    if (activeDraftId === id) {
      activeDraftId = null;
      resetEditorState({ text: "" });
    }
    await refreshDraftList();
  }

  async function finishRename(id, value, { cancel = false } = {}) {
    if (renamingDraftId !== id) return;
    renamingDraftId = null;
    renameSource = null;
    if (!cancel) {
      try {
        await store.renameDraft(id, value);
      } catch (err) {
        setStatus(String(err.message || err), "danger");
      }
    }
    await refreshDraftList();
  }

  draftListEl.addEventListener("click", (e) => {
    const item = e.target.closest(".draft-item");
    if (!item) return;
    const id = item.dataset.id;
    const actionEl = e.target.closest("[data-action]");
    const action = actionEl?.dataset.action;
    if (action === "delete") {
      e.preventDefault();
      e.stopPropagation();
      deleteDraft(id);
      return;
    }
    if (action === "rename-input") return;
    openDraft(id);
  });

  draftListEl.addEventListener("contextmenu", (e) => {
    const item = e.target.closest(".draft-item");
    if (!item) return;
    if (e.target.closest("[data-action='delete']")) return;
    if (e.target.closest(".draft-item-title-input")) return;
    e.preventDefault();
    renamingDraftId = item.dataset.id;
    renameSource = "list";
    if (draftHeaderTitleInput) draftHeaderTitleInput.hidden = true;
    syncHeaderTitle();
    renderDraftList();
  });

  draftListEl.addEventListener("keydown", (e) => {
    const input = e.target.closest(".draft-item-title-input");
    if (!input) return;
    const item = input.closest(".draft-item");
    const id = item?.dataset.id;
    if (!id) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finishRename(id, input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishRename(id, input.value, { cancel: true });
    }
  });

  draftListEl.addEventListener("focusout", (e) => {
    const input = e.target.closest(".draft-item-title-input");
    if (!input) return;
    const item = input.closest(".draft-item");
    const id = item?.dataset.id;
    if (!id || renamingDraftId !== id || renameSource !== "list") return;
    // Defer so Enter handler can run first
    setTimeout(() => {
      if (renamingDraftId === id && renameSource === "list") {
        finishRename(id, input.value);
      }
    }, 0);
  });

  draftHeaderTitleEl?.addEventListener("click", (e) => {
    e.preventDefault();
    startHeaderRename();
  });

  draftHeaderTitleInput?.addEventListener("keydown", (e) => {
    if (!isHeaderRenaming()) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finishRename(renamingDraftId, draftHeaderTitleInput.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishRename(renamingDraftId, draftHeaderTitleInput.value, { cancel: true });
    }
  });

  draftHeaderTitleInput?.addEventListener("focusout", () => {
    if (!isHeaderRenaming()) return;
    const id = renamingDraftId;
    const value = draftHeaderTitleInput.value;
    setTimeout(() => {
      if (renamingDraftId === id && renameSource === "header") {
        finishRename(id, value);
      }
    }, 0);
  });

  homeBtn.addEventListener("click", () => {
    goHome();
  });

  function syncMergeStatus() {
    const unresolved = unresolvedMergeConflictCount(currentHtml) > 0;
    hasConflict = unresolved;
    if (dirtyReviewing && !pendingMerge) {
      if (
        statusLevel === "warn" &&
        /merge conflict|conflicts resolved/i.test(statusMessage)
      ) {
        setStatus("");
      }
      if (!unresolved) {
        dirtyReviewing = false;
        if (paneMode === "git") renderGitPane();
      }
      return;
    }
    if (unresolved) {
      setStatus("merge conflict; choose a resolution for each change", "warn");
    } else if (pendingMerge) {
      setStatus("conflicts resolved; commit to finish merge", "warn");
    } else if (statusLevel === "warn" && /merge conflict|conflicts resolved/i.test(statusMessage)) {
      setStatus("");
    }
  }

  /** True for a live branch merge (pendingMerge), not dirty review. */
  function isActiveMerge({ pendingMerge: pending }) {
    return !!pending;
  }

  function takeAllTheirsConflicts() {
    const segments = parseConflictSegments(currentHtml);
    let html = currentHtml;
    if (segments) {
      const parts = [];
      for (const seg of segments) {
        if (seg.type === "text") parts.push(seg.text);
        else parts.push(seg.theirs);
      }
      html = parts.join("");
    }
    html = String(html || "").replace(/<p\b([^>]*)>/gi, (full, attrs) => {
      if (!/\bdata-kindred-align-theirs\s*=/i.test(attrs)) return full;
      const m = attrs.match(
        /\bdata-kindred-align-theirs\s*=\s*(["'])([\s\S]*?)\1/i
      );
      const align = (m && m[2]) || "left";
      let next = attrs.replace(
        /\s*data-kindred-align-(?:ours|theirs|label-ours|label-theirs)\s*=\s*(["'])[\s\S]*?\1/gi,
        ""
      );
      if (/\bstyle\s*=/i.test(next)) {
        next = next.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i, (_, q, style) => {
          let s = String(style)
            .replace(/(?:^|;)\s*text-align\s*:\s*[^;]*/i, "")
            .replace(/^;\s*|\s*;$/g, "")
            .trim();
          s = s ? `${s}; text-align: ${align}` : `text-align: ${align}`;
          return `style=${q}${s}${q}`;
        });
      } else {
        next = ` style="text-align: ${align}"${next}`;
      }
      return `<p${next}>`;
    });
    currentHtml = html || "<p></p>";
  }

  async function leaveDirtyReview() {
    if (!dirtyReviewing) return;
    if (unresolvedMergeConflictCount(currentHtml) > 0) {
      takeAllTheirsConflicts();
      workingDirty = true;
      applyRevisionToEditor();
    }
    dirtyReviewing = false;
    hasConflict = unresolvedMergeConflictCount(currentHtml) > 0;
    persistActiveDraftSoon();
    await refreshWorkingDirty();
  }

  async function setDirtyEditView(mode) {
    if (mode !== "Text" && mode !== "Diff") return;
    if (dirtyReviewing) await leaveDirtyReview();
    dirtyViewMode = mode;
    renderGitPane();
    if (viewingOid) {
      await exitToDirty();
    } else {
      syncOverlayFromState();
    }
  }

  async function enterDirtyReview() {
    if (!activeDraftId || !store) return;
    if (isViewingHistory()) {
      setStatus("Restore or exit history before reviewing");
      return;
    }
    if (pendingMerge) {
      setStatus("Finish or abort the merge before reviewing dirty changes");
      return;
    }
    if (dirtyReviewing) return;
    if (unresolvedMergeConflictCount(currentHtml) > 0) {
      setStatus("Resolve existing conflicts before reviewing dirty changes");
      return;
    }
    if (!headOid) {
      setStatus("Commit once before reviewing dirty changes");
      return;
    }
    await flushSaveTimer();
    pullFromEditor();
    const dirty = await store.isDirty(activeDraftId);
    if (!dirty) {
      setStatus("Nothing to review");
      return;
    }
    const head = await store.readHead(activeDraftId);
    if (!head) {
      setStatus("Nothing to review");
      return;
    }
    const headHtml = head.html || head.text || "";
    const result = store.reviewWorkingTree(
      headHtml,
      currentHtml,
      currentBranchName || "HEAD"
    );
    if (result.cleanMerge) {
      setStatus("Nothing to review");
      return;
    }
    currentHtml = result.mergedText || "<p></p>";
    hasConflict = true;
    dirtyReviewing = true;
    workingDirty = true;
    applyRevisionToEditor();
    syncMergeStatus();
    refreshStatusLeft();
    updateAnalyzeBtn();
    persistActiveDraftSoon();
    renderGitPane();
  }

  function replaceConflictAt(index, replacement) {
    const segments = parseConflictSegments(currentHtml);
    if (!segments) return;
    let conflictI = 0;
    const parts = [];
    for (const seg of segments) {
      if (seg.type === "text") {
        parts.push(seg.text);
        continue;
      }
      if (conflictI === index) parts.push(replacement);
      else {
        parts.push(
          formatConflictMarkers(
            seg.oursLabel,
            seg.ours,
            seg.theirsLabel,
            seg.theirs
          )
        );
      }
      conflictI++;
    }
    currentHtml = parts.join("");
    workingDirty = true;
    applyRevisionToEditor();
    syncMergeStatus();
    refreshStatusLeft();
    updateAnalyzeBtn();
    persistActiveDraftSoon();
  }

  function handleConflictAction(action, index) {
    const segments = parseConflictSegments(currentHtml);
    if (!segments) return;
    const conflicts = segments.filter((s) => s.type === "conflict");
    const seg = conflicts[index];
    if (!seg) return;
    if (action === "ours") {
      replaceConflictAt(index, seg.ours);
      return;
    }
    if (action === "theirs") {
      replaceConflictAt(index, seg.theirs);
      return;
    }
    if (action === "both") {
      if (isFormatOnlyConflict(seg.ours, seg.theirs)) return;
      replaceConflictAt(index, joinConflictBoth(seg.ours, seg.theirs));
    }
  }

  function paragraphIndexAtPos(doc, paraPos) {
    let idx = 0;
    let found = -1;
    doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.type.name !== "paragraph") return;
      if (pos === paraPos) found = idx;
      idx++;
    });
    return found;
  }

  function patchNthParagraphAlign(html, index, align) {
    let i = 0;
    return String(html || "").replace(/<p\b[^>]*>/gi, (tag) => {
      if (i++ !== index) return tag;
      let next = tag.replace(
        /\s*data-kindred-align-(?:ours|theirs|label-ours|label-theirs)\s*=\s*(["'])[\s\S]*?\1/gi,
        ""
      );
      if (/\bstyle\s*=/i.test(next)) {
        next = next.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i, (_, q, style) => {
          let s = String(style)
            .replace(/(?:^|;)\s*text-align\s*:\s*[^;]*/i, "")
            .replace(/^;\s*|\s*;$/g, "")
            .trim();
          s = s ? `${s}; text-align: ${align}` : `text-align: ${align}`;
          return `style=${q}${s}${q}`;
        });
      } else {
        next = next.replace(/^<p\b/i, `<p style="text-align: ${align}"`);
      }
      return next;
    });
  }

  function handleAlignConflictAction(action, paraPos) {
    if (!tipTap || paraPos == null) return;
    const node = tipTap.state.doc.nodeAt(paraPos);
    if (!node || node.type.name !== "paragraph") return;
    const chosen =
      action === "theirs" ? node.attrs.alignTheirs : node.attrs.alignOurs;
    if (!chosen) return;
    const paraIndex = paragraphIndexAtPos(tipTap.state.doc, paraPos);
    if (paraIndex < 0) return;

    suppressEditorUpdate = true;
    try {
      const tr = tipTap.state.tr.setNodeMarkup(paraPos, undefined, {
        ...node.attrs,
        textAlign: chosen,
        alignOurs: null,
        alignTheirs: null,
        alignLabelOurs: null,
        alignLabelTheirs: null,
      });
      tipTap.view.dispatch(tr);
    } finally {
      suppressEditorUpdate = false;
    }

    if (conflictMarkerCount(currentHtml) > 0) {
      currentHtml = patchNthParagraphAlign(currentHtml, paraIndex, chosen);
    } else {
      currentHtml = tipTap.getHTML();
    }
    workingDirty = true;
    syncOverlayFromState();
    syncMergeStatus();
    refreshStatusLeft();
    updateAnalyzeBtn();
    persistActiveDraftSoon();
  }

  function getCurrentText() {
    return currentText;
  }

  function protectLt(s) {
    return s.replace(/</g, HTMLDIFF_LT);
  }

  function unprotectLt(s) {
    return s.replaceAll(HTMLDIFF_LT, "<");
  }

  function joinWords(words, start, end) {
    return unprotectLt(words.slice(start, end).join(""));
  }

  /** Glue between word edits: whitespace / punctuation only (no letters or digits). */
  function isShortEqual(text) {
    return text.length > 0 && text.length <= 16 && !/[\p{L}\p{N}]/u.test(text);
  }

  function changeTexts(run) {
    let del = "";
    let ins = "";
    for (const [op, data] of run) {
      if (op === DIFF_DELETE) del += data;
      else if (op === DIFF_INSERT) ins += data;
    }
    return { del, ins };
  }

  function flattenChangeRun(run) {
    const { del, ins } = changeTexts(run);
    const out = [];
    if (del) out.push([DIFF_DELETE, del]);
    if (ins) out.push([DIFF_INSERT, ins]);
    return out;
  }

  /** Merge change hunks split only by short equals into one phrase-level replace. */
  function coalesceShortEquals(parts) {
    const out = [];
    let i = 0;
    while (i < parts.length) {
      if (parts[i][0] === DIFF_EQUAL) {
        out.push(parts[i]);
        i++;
        continue;
      }

      let run = [];
      while (i < parts.length && parts[i][0] !== DIFF_EQUAL) {
        run.push(parts[i]);
        i++;
      }

      while (
        i < parts.length &&
        parts[i][0] === DIFF_EQUAL &&
        isShortEqual(parts[i][1]) &&
        i + 1 < parts.length &&
        parts[i + 1][0] !== DIFF_EQUAL
      ) {
        const eq = parts[i][1];
        i++;
        const next = [];
        while (i < parts.length && parts[i][0] !== DIFF_EQUAL) {
          next.push(parts[i]);
          i++;
        }
        const L = changeTexts(run);
        const R = changeTexts(next);
        let del = L.del + (R.del ? eq + R.del : "");
        let ins = L.ins + (R.ins ? eq + R.ins : "");
        // Delete then insert across glue → treat glue as part of the replace.
        if (L.del && !L.ins && R.ins && !R.del) del += eq;
        if (L.ins && !L.del && R.del && !R.ins) ins += eq;
        run = [];
        if (del) run.push([DIFF_DELETE, del]);
        if (ins) run.push([DIFF_INSERT, ins]);
      }

      out.push(...flattenChangeRun(run));
    }
    return out;
  }

  function diffs(baselineText, current) {
    const key = baselineText + "\0" + current;
    if (diffsCacheKey === key) return diffsCacheParts;

    let parts;
    if (baselineText === current) {
      parts = current ? [[DIFF_EQUAL, current]] : [];
    } else {
      const hd = new HtmlDiff(protectLt(baselineText), protectLt(current));
      hd.splitInputsIntoWords();
      // Same as HtmlDiff.build(): findMatch loops matchGranularity→1.
      hd.matchGranularity = Math.min(4, hd.oldWords.length, hd.newWords.length);
      const ops = hd.operations();
      parts = [];
      for (const opp of ops) {
        const action = opp.action;
        if (action === HTMLDIFF_ACTION.none) continue;
        if (action === HTMLDIFF_ACTION.equal) {
          parts.push([
            DIFF_EQUAL,
            joinWords(hd.newWords, opp.startInNew, opp.endInNew),
          ]);
        } else if (action === HTMLDIFF_ACTION.delete) {
          parts.push([
            DIFF_DELETE,
            joinWords(hd.oldWords, opp.startInOld, opp.endInOld),
          ]);
        } else if (action === HTMLDIFF_ACTION.insert) {
          parts.push([
            DIFF_INSERT,
            joinWords(hd.newWords, opp.startInNew, opp.endInNew),
          ]);
        } else if (action === HTMLDIFF_ACTION.replace) {
          parts.push([
            DIFF_DELETE,
            joinWords(hd.oldWords, opp.startInOld, opp.endInOld),
          ]);
          parts.push([
            DIFF_INSERT,
            joinWords(hd.newWords, opp.startInNew, opp.endInNew),
          ]);
        }
      }
      parts = coalesceShortEquals(parts);
    }

    diffsCacheKey = key;
    diffsCacheParts = parts;
    return parts;
  }

  /** Map caret offset in current text → baseline offset (inserts use the anchor basePos). */
  function mapCurrentToBaseline(baselineText, current, currentOffset) {
    if (!baselineText) return null;
    if (baselineText === current) return currentOffset;

    const parts = diffs(baselineText, current);
    let basePos = 0;
    let curPos = 0;

    for (const [op, data] of parts) {
      const len = data.length;
      if (op === DIFF_EQUAL) {
        if (currentOffset <= curPos + len) {
          return basePos + (currentOffset - curPos);
        }
        basePos += len;
        curPos += len;
      } else if (op === DIFF_INSERT) {
        if (currentOffset <= curPos + len) {
          return basePos;
        }
        curPos += len;
      } else if (op === DIFF_DELETE) {
        basePos += len;
      }
    }
    return basePos;
  }

  /** Current text corresponding to a baseline [start, end) span after edits. */
  function currentSliceForBaselineRange(baselineText, current, start, end) {
    if (!baselineText) return "";
    if (baselineText === current) return baselineText.slice(start, end);
    const parts = diffs(baselineText, current);
    let basePos = 0;
    let out = "";
    for (const [op, data] of parts) {
      const len = data.length;
      if (op === DIFF_EQUAL) {
        const sliceStart = Math.max(0, start - basePos);
        const sliceEnd = Math.min(len, end - basePos);
        if (sliceStart < sliceEnd) out += data.slice(sliceStart, sliceEnd);
        basePos += len;
      } else if (op === DIFF_DELETE) {
        basePos += len;
      } else if (op === DIFF_INSERT) {
        // Match sent-hl: inserts whose baseline anchor falls in the span belong to it.
        if (basePos >= start && basePos < end) out += data;
      }
    }
    return out;
  }

  function caretCurrentOffset() {
    if (!tipTap) return 0;
    const { from } = tipTap.state.selection;
    return tipTap.state.doc.textBetween(0, from, "\n\n", "\n").length;
  }

  function findUnitAt(units, offset) {
    if (offset == null || !units) return null;
    for (const u of units) {
      if (offset >= u.start && offset < u.end) return u;
    }
    for (let i = units.length - 1; i >= 0; i--) {
      const u = units[i];
      if (offset === u.end) return u;
    }
    return null;
  }

  function findParagraphForSentence(sentence) {
    if (!result || !sentence) return null;
    for (const p of result.paragraphs) {
      if (sentence.start >= p.start && sentence.start < p.end) return p;
    }
    return null;
  }

  /** True when caret sits in blank lines between (or outside) paragraph spans. */
  function isBetweenParagraphs(offset, paragraphs) {
    if (offset == null || !paragraphs || !paragraphs.length) return false;
    if (offset < paragraphs[0].start) return true;
    for (let i = 0; i < paragraphs.length - 1; i++) {
      if (offset > paragraphs[i].end && offset < paragraphs[i + 1].start) {
        return true;
      }
    }
    return offset > paragraphs[paragraphs.length - 1].end;
  }

  function activeHighlight() {
    if (mode !== "local") return null;
    if (
      chatFocus.scope === "paragraph" &&
      activeParagraph
    ) {
      return { start: activeParagraph.start, end: activeParagraph.end };
    }
    if (!activeSentence) return null;
    return { start: activeSentence.start, end: activeSentence.end };
  }

  function selectionIsEditorRange() {
    if (!tipTap) return false;
    const { from, to } = tipTap.state.selection;
    return tipTap.isFocused && to > from;
  }

  function syncEditorHighlight(force = false) {
    if (!force && selectionIsEditorRange()) return;
    syncOverlayFromState();
  }

  function applyLocalFromCaret() {
    const prevSentenceIndex = activeSentence ? activeSentence.index : null;
    updateLocalFromCaret();
    const sentenceChanged =
      (activeSentence ? activeSentence.index : null) !== prevSentenceIndex;
    if (activeSentence && sentenceChanged) {
      syncLocalChatFocus({ preferSentence: true });
    }
    if (selectionIsEditorRange()) {
      if (activeSentence) {
        mode = "local";
        syncScopeTabSelection();
        renderFeedback();
      } else if (mode === "local") {
        setMode("global");
      }
      return;
    }
    if (activeSentence) {
      if (mode !== "local") setMode("local");
      else if (sentenceChanged) {
        renderFeedback();
        syncEditorHighlight(true);
      }
    } else if (mode === "local") {
      setMode("global");
    } else {
      syncEditorHighlight();
    }
  }

  function chatKey(scope, index) {
    if (scope === "text") return "text";
    return `${scope}:${index}`;
  }

  function messagesForKey(scope, index) {
    const key = chatKey(scope, index);
    const list = chats[key];
    return Array.isArray(list) ? list : [];
  }

  function canChatScope(scope) {
    if (!result || chatBusy || analyzing) return false;
    if (scope === "text") return true;
    if (scope === "sentence") return !!activeSentence;
    if (scope === "paragraph") return !!activeParagraph;
    return false;
  }

  function chatPlaceholder(scope) {
    if (scope === "sentence") return "Ask about this sentence";
    if (scope === "paragraph") return "Ask about this paragraph";
    return "Ask about the text";
  }

  function captureChatDrafts() {
    if (chatInput && !chatComposer.hidden) {
      chatDrafts.text = chatInput.value || "";
    }
    feedbackEl.querySelectorAll(".unit-composer textarea").forEach((ta) => {
      const form = ta.closest(".unit-composer");
      if (!form) return;
      const scope = form.dataset.scope;
      if (scope === "sentence" || scope === "paragraph") {
        chatDrafts[scope] = ta.value || "";
      }
    });
  }

  function resizeTextarea(el) {
    if (!el) return;
    const maxPx = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--size-composer-max"),
    ) || 128;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  }

  function syncComposerControls(form, input, sendBtn, scope) {
    const enabled = canChatScope(scope);
    const draft = chatDrafts[scope] || "";
    input.placeholder = chatPlaceholder(scope);
    input.setAttribute("aria-label", chatPlaceholder(scope));
    if (document.activeElement !== input) {
      input.value = draft;
      resizeTextarea(input);
    }
    input.disabled = !enabled;
    sendBtn.disabled = !enabled || !(input.value || "").trim();
    form.setAttribute("aria-busy", chatBusy ? "true" : "false");
  }

  function syncChatComposer() {
    const showGlobal = !!(result && mode === "global");
    chatComposer.hidden = !showGlobal;
    if (showGlobal) {
      syncComposerControls(chatComposer, chatInput, chatSend, "text");
    }
    feedbackEl.querySelectorAll(".unit-composer").forEach((form) => {
      const scope = form.dataset.scope;
      const input = form.querySelector("textarea");
      const sendBtn = form.querySelector(".chat-send");
      if (!input || !sendBtn) return;
      if (scope === "sentence" || scope === "paragraph") {
        syncComposerControls(form, input, sendBtn, scope);
      }
    });
    syncComposerSeparators();
    requestAnimationFrame(() => {
      bindComposerScrollWatch(feedbackEl);
      if (typeof composerSepObserver !== "undefined") {
        feedbackEl.querySelectorAll(".local-pane-scroll").forEach((el) => {
          composerSepObserver.observe(el);
          bindComposerScrollWatch(el);
        });
      } else {
        feedbackEl.querySelectorAll(".local-pane-scroll").forEach((el) => {
          bindComposerScrollWatch(el);
        });
      }
      syncComposerSeparators();
    });
  }

  function scrollAreaOverflows(el) {
    if (!el) return false;
    return el.scrollHeight > el.clientHeight + 1;
  }

  function scrollAreaAtBottom(el) {
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  }

  function composerNeedsSeparator(scrollEl) {
    return scrollAreaOverflows(scrollEl) && !scrollAreaAtBottom(scrollEl);
  }

  function syncComposerSeparators() {
    if (!chatComposer.hidden) {
      chatComposer.classList.toggle(
        "is-separated",
        composerNeedsSeparator(feedbackEl)
      );
    } else {
      chatComposer.classList.remove("is-separated");
    }
    feedbackEl.querySelectorAll(".local-pane > .unit-composer").forEach((form) => {
      const scroll = form.previousElementSibling;
      const needs =
        scroll &&
        scroll.classList.contains("local-pane-scroll") &&
        composerNeedsSeparator(scroll);
      form.classList.toggle("is-separated", !!needs);
    });
  }

  function bindComposerScrollWatch(el) {
    if (!el || el.dataset.sepScroll === "1") return;
    el.dataset.sepScroll = "1";
    el.addEventListener("scroll", () => syncComposerSeparators(), {
      passive: true,
    });
  }

  function renderUnitComposer(scope, index) {
    const enabled = canChatScope(scope);
    const placeholder = chatPlaceholder(scope);
    const draft = escapeHtml(chatDrafts[scope] || "");
    return (
      `<form class="chat-composer unit-composer" data-scope="${scope}" data-index="${index}" aria-busy="false">` +
      `<div class="chat-composer-row">` +
      `<textarea rows="1" class="chat-input" placeholder="${placeholder}" aria-label="${placeholder}" autocomplete="off"${enabled ? "" : " disabled"}>${draft}</textarea>` +
      `<button type="submit" class="btn btn-primary chat-send"${enabled ? "" : " disabled"}>Send</button>` +
      `</div>` +
      `</form>`
    );
  }

  function renderChatThread(scope, index) {
    const msgs = messagesForKey(scope, index);
    if (!msgs.length) return "";
    return (
      `<div class="chat-thread" role="log" aria-live="polite">` +
      msgs
        .map((m) => {
          const role = m.role === "assistant" ? "assistant" : "user";
          const label = role === "assistant" ? "Coach" : "You";
          const body =
            role === "assistant"
              ? renderMarkdown(m.content || "")
              : escapeHtml(m.content || "");
          return (
            `<div class="chat-msg ${role}" aria-label="${label}">` +
            `<div class="chat-msg-body">${body}</div>` +
            `</div>`
          );
        })
        .join("") +
      `</div>`
    );
  }

  function unitPayload(scope, index) {
    const originalText = baseline || currentText;
    const liveText = currentText || originalText;
    const textChanged =
      !!originalText && !!liveText && originalText !== liveText;

    if (scope === "text") {
      return {
        scope: "text",
        unit_text: "",
        unit_feedback: result?.text || "",
        text_current: textChanged ? liveText : "",
        unit_text_current: "",
      };
    }
    if (scope === "sentence" && activeSentence && activeSentence.index === index) {
      const originalUnit = activeSentence.text || "";
      let unitCurrent = "";
      if (textChanged && baseline) {
        unitCurrent = currentSliceForBaselineRange(
          baseline,
          currentText,
          activeSentence.start,
          activeSentence.end
        );
      }
      return {
        scope: "sentence",
        unit_text: originalUnit,
        unit_feedback: activeSentence.feedback || "",
        text_current: textChanged ? liveText : "",
        unit_text_current:
          unitCurrent && unitCurrent !== originalUnit ? unitCurrent : "",
      };
    }
    if (scope === "paragraph" && activeParagraph && activeParagraph.index === index) {
      const originalUnit = activeParagraph.text || "";
      let unitCurrent = "";
      if (textChanged && baseline) {
        unitCurrent = currentSliceForBaselineRange(
          baseline,
          currentText,
          activeParagraph.start,
          activeParagraph.end
        );
      }
      return {
        scope: "paragraph",
        unit_text: originalUnit,
        unit_feedback: activeParagraph.feedback || "",
        text_current: textChanged ? liveText : "",
        unit_text_current:
          unitCurrent && unitCurrent !== originalUnit ? unitCurrent : "",
      };
    }
    return null;
  }

  function syncLocalChatFocus({ preferSentence = false } = {}) {
    if (!activeSentence) {
      chatFocus = { scope: "sentence", index: null };
      return;
    }
    if (
      !preferSentence &&
      chatFocus.scope === "paragraph" &&
      activeParagraph &&
      chatFocus.index === activeParagraph.index
    ) {
      return;
    }
    if (
      !preferSentence &&
      chatFocus.scope === "sentence" &&
      chatFocus.index === activeSentence.index
    ) {
      return;
    }
    chatFocus = { scope: "sentence", index: activeSentence.index };
  }

  function captureScrollState(el) {
    if (!el) return null;
    return {
      top: el.scrollTop,
      atBottom: scrollAreaAtBottom(el),
    };
  }

  function captureFeedbackScroll() {
    const snapshot = {
      global: null,
      sentence: null,
      paragraph: null,
    };
    if (mode === "global") {
      snapshot.global = captureScrollState(feedbackEl);
      return snapshot;
    }
    snapshot.sentence = captureScrollState(
      feedbackEl.querySelector(".local-sentence .local-pane-scroll")
    );
    snapshot.paragraph = captureScrollState(
      feedbackEl.querySelector(".local-paragraph .local-pane-scroll")
    );
    return snapshot;
  }

  function applyScrollState(el, state, stickBottom) {
    if (!el) return;
    if (stickBottom) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (state) el.scrollTop = state.top;
  }

  function restoreFeedbackScroll(snapshot, stickBottomScope) {
    if (!snapshot) return;
    if (mode === "global") {
      applyScrollState(
        feedbackEl,
        snapshot.global,
        stickBottomScope === "text"
      );
      return;
    }
    applyScrollState(
      feedbackEl.querySelector(".local-sentence .local-pane-scroll"),
      snapshot.sentence,
      stickBottomScope === "sentence"
    );
    applyScrollState(
      feedbackEl.querySelector(".local-paragraph .local-pane-scroll"),
      snapshot.paragraph,
      stickBottomScope === "paragraph"
    );
  }

  function renderFeedback({ stickBottomScope = null } = {}) {
    captureChatDrafts();
    const scrollSnapshot = captureFeedbackScroll();
    feedbackEl.classList.remove("local-split-host");
    if (!result) {
      feedbackEl.innerHTML = `<p class="muted">Analyze a draft to see feedback.</p>`;
      syncChatComposer();
      return;
    }

    if (mode === "global") {
      chatFocus = { scope: "text", index: null };
      feedbackEl.innerHTML =
        `<div class="block focused">` +
        `<div class="body">${renderMarkdown(result.text)}</div>` +
        `</div>` +
        renderChatThread("text", null);
      syncChatComposer();
      requestAnimationFrame(() => {
        restoreFeedbackScroll(scrollSnapshot, stickBottomScope);
        syncComposerSeparators();
      });
      return;
    }

    if (!activeSentence) {
      feedbackEl.innerHTML =
        `<p class="muted">Click into a sentence to see local feedback.</p>`;
      syncChatComposer();
      return;
    }

    syncLocalChatFocus();
    const para = activeParagraph;
    const sentFocused =
      chatFocus.scope === "sentence" && chatFocus.index === activeSentence.index;
    const paraFocused =
      para &&
      chatFocus.scope === "paragraph" &&
      chatFocus.index === para.index;

    const sentenceHtml =
      `<div class="block" data-scope="sentence" data-index="${activeSentence.index}">` +
      `<p class="quote">${escapeHtml(activeSentence.text)}</p>` +
      `<div class="body">${renderMarkdown(activeSentence.feedback)}</div>` +
      `</div>` +
      renderChatThread("sentence", activeSentence.index);

    let paragraphHtml;
    if (para) {
      paragraphHtml =
        `<div class="block" data-scope="paragraph" data-index="${para.index}">` +
        `<p class="quote">${escapeHtml(para.text)}</p>` +
        `<div class="body">${renderMarkdown(para.feedback)}</div>` +
        `</div>` +
        renderChatThread("paragraph", para.index);
    } else {
      paragraphHtml = `<p class="muted">No paragraph feedback for this selection.</p>`;
    }

    feedbackEl.classList.add("local-split-host");
    feedbackEl.innerHTML =
      `<div class="local-split">` +
      `<div class="local-pane local-sentence${sentFocused ? " focused" : ""}" data-scope="sentence" data-index="${activeSentence.index}">` +
      `<div class="local-pane-scroll">${sentenceHtml}</div>` +
      renderUnitComposer("sentence", activeSentence.index) +
      `</div>` +
      `<div id="local-divider" role="separator" aria-orientation="horizontal" aria-label="Resize sentence and paragraph panes" tabindex="0"></div>` +
      `<div class="local-pane local-paragraph${paraFocused ? " focused" : ""}"${para ? ` data-scope="paragraph" data-index="${para.index}"` : ""}>` +
      `<div class="local-pane-scroll">${paragraphHtml}</div>` +
      (para ? renderUnitComposer("paragraph", para.index) : "") +
      `</div>` +
      `</div>`;
    applyLocalSplit();
    bindLocalDivider();
    syncChatComposer();
    requestAnimationFrame(() => {
      restoreFeedbackScroll(scrollSnapshot, stickBottomScope);
      syncComposerSeparators();
    });
  }

  function applyLocalSplit() {
    const sentencePane = feedbackEl.querySelector(".local-sentence");
    if (!sentencePane) return;
    sentencePane.style.flex = `0 0 ${localSentencePct}%`;
    syncComposerSeparators();
  }

  function setLocalSplitFromClientY(clientY) {
    const split = feedbackEl.querySelector(".local-split");
    if (!split) return;
    const rect = split.getBoundingClientRect();
    if (rect.height <= 0) return;
    const y = clientY - rect.top;
    const min = 64;
    const max = rect.height - 64 - 5;
    const clamped = Math.min(max, Math.max(min, y));
    localSentencePct = (clamped / rect.height) * 100;
    applyLocalSplit();
  }

  function bindLocalDivider() {
    const localDivider = document.getElementById("local-divider");
    if (!localDivider || localDivider.dataset.bound === "1") return;
    localDivider.dataset.bound = "1";

    function endLocalResize() {
      if (!localResizing) return;
      localResizing = false;
      localDivider.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    localDivider.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      localResizing = true;
      localDivider.classList.add("dragging");
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      localDivider.setPointerCapture(e.pointerId);
    });

    localDivider.addEventListener("pointermove", (e) => {
      if (!localResizing) return;
      setLocalSplitFromClientY(e.clientY);
    });

    localDivider.addEventListener("pointerup", endLocalResize);
    localDivider.addEventListener("pointercancel", endLocalResize);

    localDivider.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 8 : 3;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        localSentencePct = Math.min(
          80,
          Math.max(15, localSentencePct + (e.key === "ArrowUp" ? -step : step))
        );
        applyLocalSplit();
      }
    });
  }

  function updateLocalFromCaret() {
    if (!result || !baseline) {
      activeSentence = null;
      activeParagraph = null;
      return;
    }
    const curOff = caretCurrentOffset();
    const baseOff = mapCurrentToBaseline(baseline, currentText, curOff);
    if (baseOff == null || isBetweenParagraphs(baseOff, result.paragraphs)) {
      activeSentence = null;
      activeParagraph = null;
      return;
    }
    activeSentence = findUnitAt(result.sentences, baseOff);
    activeParagraph = activeSentence
      ? findParagraphForSentence(activeSentence)
      : findUnitAt(result.paragraphs, baseOff);
  }

  function setMode(next) {
    mode = next;
    syncScopeTabSelection();
    if (mode === "local") {
      updateLocalFromCaret();
      syncLocalChatFocus({ preferSentence: true });
    } else {
      activeSentence = null;
      chatFocus = { scope: "text", index: null };
    }
    renderFeedback();
    syncEditorHighlight(true);
  }

  scopeTabs.forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });

  function setPaneMode(next) {
    if (next !== "review" && next !== "git") return;
    if (hasConflict) next = "git";
    if (paneMode === next) {
      syncPaneModeTabs();
      return;
    }
    paneMode = next;
    syncPaneModeTabs();
    updateAnalyzeBtn();
    syncRightPane();
    if (paneMode === "git") {
      renderGitPane();
      void refreshWorkingDirty();
    }
  }

  paneModeCluster.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab[data-pane]");
    if (!tab || !paneModeCluster.contains(tab)) return;
    setPaneMode(tab.dataset.pane);
  });

  function shortOid(oid) {
    return (oid || "").slice(0, 7);
  }

  function renderGitPane() {
    if (!activeDraftId) return;
    const branchRows = branches
      .map((name) => {
        const current = name === currentBranchName;
        const actions = current
          ? ""
          : `<div class="git-row-actions">` +
            `<button type="button" class="btn btn-tertiary" data-git="merge" data-branch="${escapeHtml(name)}">Merge</button>` +
            (name === "main"
              ? ""
              : `<button type="button" class="draft-item-delete" data-git="delete" data-branch="${escapeHtml(name)}" title="Delete branch" aria-label="Delete branch">×</button>`) +
            `</div>`;
        return (
          `<div class="git-row${current ? " active" : ""}" role="listitem" data-git="checkout" data-branch="${escapeHtml(name)}">` +
          `<div class="git-row-body">` +
          `<span class="git-row-title">${escapeHtml(name)}</span>` +
          `</div>${actions}</div>`
        );
      })
      .join("");
    gitBranchList.innerHTML =
      branchRows || `<p class="git-empty">No branches yet.</p>`;

    if (!commits.length) {
      gitCommitList.innerHTML = `<p class="git-empty">No commits yet. Analyze or Commit to create one.</p>`;
    } else {
      const atDirty = !viewingOid;
      const dirtyTextActive = atDirty && !dirtyReviewing && dirtyViewMode === "Text";
      const dirtyDiffActive = atDirty && !dirtyReviewing && dirtyViewMode === "Diff";
      const dirtyReviewActive = atDirty && dirtyReviewing;
      const dirtyBtn = (label, action, active) =>
        `<button type="button" class="btn btn-tertiary${active ? " is-active" : ""}" data-git="${action}" aria-pressed="${active ? "true" : "false"}"${gitBusy ? " disabled" : ""}>${label}</button>`;
      const dirtyRow =
        `<div class="git-row git-row-dirty${atDirty ? " active" : ""}" role="listitem" data-git="dirty">` +
        `<div class="git-row-body">` +
        `<span class="git-row-title">dirty</span>` +
        `</div>` +
        `<div class="git-row-actions">` +
        dirtyBtn("Text", "dirty-text", dirtyTextActive) +
        dirtyBtn("Diff", "dirty-diff", dirtyDiffActive) +
        dirtyBtn("Review", "dirty-review", dirtyReviewActive) +
        `</div></div>`;
      const commitRows = commits
        .slice()
        .reverse()
        .map((c) => {
          const active = viewingOid === c.oid ? " active" : "";
          const head = c.oid === headOid ? " · head" : "";
          const msg = (c.message || "").split("\n")[0];
          const isHead = c.oid === headOid;
          const actions = isHead
            ? `<div class="git-row-actions">` +
              `<button type="button" class="btn btn-tertiary" data-git="reset"${gitBusy ? " disabled" : ""}>Reset</button>` +
              `</div>`
            : `<div class="git-row-actions">` +
              `<button type="button" class="btn btn-tertiary" data-git="restore" data-oid="${escapeHtml(c.oid)}"${gitBusy ? " disabled" : ""}>Restore</button>` +
              `</div>`;
          return (
            `<div class="git-row${active}" role="listitem" data-git="view" data-oid="${escapeHtml(c.oid)}">` +
            `<div class="git-row-body">` +
            `<span class="git-row-title">${escapeHtml(msg)}</span>` +
            `<span class="git-row-meta">${escapeHtml(shortOid(c.oid))}${head} · ${escapeHtml(formatDraftTime(c.timestamp))}</span>` +
            `</div>${actions}</div>`
          );
        })
        .join("");
      gitCommitList.innerHTML = dirtyRow + commitRows;
    }
    gitNewBranchBtn.disabled = gitBusy || !commits.length;
  }

  async function runGit(fn) {
    if (!activeDraftId || gitBusy) return;
    gitBusy = true;
    updateAnalyzeBtn();
    try {
      await fn();
    } catch (err) {
      setStatus(String(err.message || err), "danger");
    } finally {
      gitBusy = false;
      updateAnalyzeBtn();
      if (paneMode === "git") renderGitPane();
    }
  }

  async function manualCommit() {
    if (isViewingHistory()) {
      setStatus("Restore this commit before committing.");
      return;
    }
    await flushSaveTimer();
    baseline = currentText;
    const verb = hasConflict || pendingMerge ? "Merge" : "Commit";
    await store.saveWorkingTree(activeDraftId, snapshotState());
    const dirty = await store.isDirty(activeDraftId);
    if (!dirty && !pendingMerge) {
      workingDirty = false;
      updateAnalyzeBtn();
      setStatus("Nothing to commit");
      return;
    }
    await store.commitWorkingTree(activeDraftId, { verb });
    hasConflict = false;
    pendingMerge = null;
    viewingOid = null;
    workingDirty = false;
    await refreshCommits();
    const wt = await store.readWorkingFiles(activeDraftId);
    loadSnapshotState(wt, { historical: false });
    setStatus("");
    await refreshDraftList();
    renderGitPane();
    updateAnalyzeBtn();
  }

  async function analyzeOrCommit() {
    if (paneMode === "git") {
      await runGit(manualCommit);
      return;
    }
    await analyze();
  }

  editor.addEventListener("click", (e) => {
    if (!result) return;
    applyLocalFromCaret();
  });

  editor.addEventListener("keyup", (e) => {
    if (!result) return;
    const nav = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (nav.includes(e.key)) applyLocalFromCaret();
  });

  const importFileInput = document.createElement("input");
  importFileInput.type = "file";
  importFileInput.hidden = true;
  document.body.appendChild(importFileInput);

  function sanitizeDownloadBase(name) {
    const cleaned = String(name || "draft")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return cleaned || "draft";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function canOpenImportDialog() {
    if (converting || analyzing || gitBusy || applyingHistory) return false;
    if (isViewingHistory()) return false;
    if (hasConflict || unresolvedMergeConflictCount(currentHtml) > 0) return false;
    return true;
  }

  async function importChosenFile(file) {
    if (!file) return;
    converting = true;
    updateAnalyzeBtn();
    setStatus("importing...");
    try {
      const html = await importFileToHtml(file);
      suppressEditorUpdate = true;
      try {
        setHtml(tipTap, html, { emitUpdate: false });
      } finally {
        suppressEditorUpdate = false;
      }
      pullFromEditor();
      await ensureDraftForText(currentText);
      persistActiveDraftSoon();
      syncOverlayFromState();
      syncRightPane();
      updateAnalyzeBtn();
      refreshStatusLeft();
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(String(err.message || err), "danger");
    } finally {
      converting = false;
      updateAnalyzeBtn();
    }
  }

  function openImportDialog() {
    if (!canOpenImportDialog()) return;
    importFileInput.value = "";
    importFileInput.click();
  }

  editor.addEventListener("dblclick", (e) => {
    if (!editorIsEmpty() || !canOpenImportDialog()) return;
    e.preventDefault();
    openImportDialog();
  });

  importFileInput.addEventListener("change", () => {
    const file = importFileInput.files && importFileInput.files[0];
    importFileInput.value = "";
    if (!file) return;
    void importChosenFile(file);
  });

  importBtn.addEventListener("click", () => {
    openImportDialog();
  });

  async function exportDraft(formatId = "docx") {
    if (exportBtn.disabled || editorIsEmpty()) return;
    setExportMenuOpen(false);
    converting = true;
    updateAnalyzeBtn();
    setStatus("exporting...");
    try {
      pullFromEditor();
      const draft = activeDraftId ? findDraft(activeDraftId) : null;
      const base = sanitizeDownloadBase(
        draft ? draftTitle(draft) : store.titleFromText(currentText || ""),
      );
      const { blob, format } = await htmlToExportBlob(
        currentHtml || "<p></p>",
        formatId || "docx",
      );
      downloadBlob(blob, `${base}.${format.ext}`);
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(String(err.message || err), "danger");
    } finally {
      converting = false;
      updateAnalyzeBtn();
    }
  }

  for (const format of EXPORT_FORMATS) {
    const item = document.createElement("button");
    item.type = "button";
    item.role = "menuitem";
    item.dataset.format = format.id;
    item.textContent = format.label;
    exportMenu.appendChild(item);
  }

  exportBtn.addEventListener("click", () => {
    void exportDraft("docx");
  });

  exportMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (exportMenuBtn.disabled) return;
    setExportMenuOpen(exportMenu.hidden);
  });

  exportMenu.addEventListener("click", (e) => {
    const item = e.target.closest("button[data-format]");
    if (!item || !exportMenu.contains(item)) return;
    void exportDraft(item.dataset.format);
  });

  document.addEventListener("click", (e) => {
    if (exportMenu.hidden) return;
    if (exportControls.contains(e.target)) return;
    setExportMenuOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !exportMenu.hidden) {
      setExportMenuOpen(false);
    }
  });

  async function readReviewStream(res, onProgress) {
    if (!res.body) {
      throw new Error(res.statusText || "Review failed");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          throw new Error("Invalid progress event from server");
        }
        if (event.type === "progress") {
          onProgress(event);
        } else if (event.type === "done") {
          finalResult = event.result;
        } else if (event.type === "error") {
          throw new Error(event.detail || "Review failed");
        }
      }
    }
    if (!finalResult) {
      throw new Error("Review ended without a result");
    }
    return finalResult;
  }

  async function analyze() {
    if (isViewingHistory()) {
      setStatus("Return to the latest commit before analyzing.");
      return;
    }
    const text = (currentText || "").trim();
    if (!text) {
      setStatus("Paste or type some text first.");
      return;
    }
    analyzing = true;
    updateAnalyzeBtn();
    syncChatComposer();
    setStatus("analyzing...");
    try {
      await ensureDraftForText(text);
      await flushSaveTimer();
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const detail = data.detail;
        throw new Error(
          typeof detail === "string" ? detail : res.statusText || "Review failed"
        );
      }
      const data = await readReviewStream(res, (event) => {
        setStatus(formatAnalysisProgress(event));
      });
      result = data;
      baseline = text;
      currentText = text;
      currentModel = data.model || DEFAULT_MODEL;
      revisionCost = Number(data.total_cost) || 0;
      draftCost += revisionCost;
      chats = {};
      chatFocus = { scope: "text", index: null };
      chatDrafts = { text: "", sentence: "", paragraph: "" };
      clearHistory();
      syncOverlayFromState();
      activeSentence = null;
      activeParagraph = null;
      setMode("global");
      await store.commitAnalyze(activeDraftId, snapshotState());
      viewingOid = null;
      workingDirty = false;
      await refreshCommits();
      activeCommitIndex = commits.length - 1;
      updateMeta();
      setStatus("");
      await refreshDraftList();
      syncRightPane();
      await refreshWorkingDirty();
    } catch (err) {
      setStatus(String(err.message || err), "danger");
    } finally {
      analyzing = false;
      updateAnalyzeBtn();
      syncChatComposer();
    }
  }

  analyzeBtn.addEventListener("click", () => {
    analyzeOrCommit();
  });

  async function switchBranch(name) {
    if (!activeDraftId || name === currentBranchName) return;
    await flushSaveTimer();
    const wtFlags = await store.readWorkingFiles(activeDraftId);
    const abortingMerge = isActiveMerge({
      pendingMerge: wtFlags.pendingMerge,
      hasConflict: wtFlags.hasConflict,
      text: wtFlags.text,
    });
    let wt;
    if (abortingMerge) {
      const ok = window.confirm(
        "Abort the merge and discard uncommitted edits to switch branches?"
      );
      if (!ok) return;
      wt = await store.checkoutBranch(activeDraftId, name, { force: true });
    } else {
      try {
        wt = await store.checkoutBranch(activeDraftId, name, { force: false });
      } catch (err) {
        if (err && err.code === "CHECKOUT_CONFLICT") {
          const ok = window.confirm(
            "Local changes would be overwritten. Discard uncommitted edits and switch?"
          );
          if (!ok) return;
          wt = await store.checkoutBranch(activeDraftId, name, { force: true });
        } else {
          throw err;
        }
      }
    }
    viewingOid = null;
    hasConflict = false;
    pendingMerge = null;
    await refreshCommits();
    loadSnapshotState(wt, { historical: false });
    await refreshDraftList();
    renderGitPane();
    await refreshWorkingDirty();
  }

  async function createBranchPrompt() {
    const name = window.prompt("New branch name");
    if (!name || !name.trim()) return;
    await store.createBranch(activeDraftId, name.trim(), { checkout: true });
    viewingOid = null;
    await refreshCommits();
    const wt = await store.readWorkingFiles(activeDraftId);
    loadSnapshotState(wt, { historical: false });
    await refreshDraftList();
    renderGitPane();
    await refreshWorkingDirty();
  }

  async function mergeIntoCurrent(name) {
    await flushSaveTimer();
    const result = await store.mergeBranch(activeDraftId, name);
    if (result.conflict) {
      hasConflict = true;
      pendingMerge = result.state.pendingMerge;
      paneMode = "git";
      loadSnapshotState(result.state, { historical: false });
      setStatus("merge conflict; choose a resolution for each change", "warn");
    } else {
      hasConflict = false;
      pendingMerge = null;
      viewingOid = null;
      await refreshCommits();
      const wt = await store.readWorkingFiles(activeDraftId);
      loadSnapshotState(wt, { historical: false });
      setStatus("");
    }
    await refreshDraftList();
    syncPaneModeTabs();
    syncRightPane();
    renderGitPane();
    await refreshWorkingDirty();
  }

  async function deleteBranchNamed(name) {
    if (name === "main") return;
    const ok = window.confirm(`Delete branch “${name}”?`);
    if (!ok) return;
    await store.deleteBranch(activeDraftId, name);
    await refreshCommits();
    await refreshDraftList();
    renderGitPane();
  }

  async function exitToDirty() {
    if (!viewingOid) return;
    await flushSaveTimer();
    viewingOid = null;
    activeCommitIndex = commits.length ? commits.length - 1 : -1;
    const wt = await store.readWorkingFiles(activeDraftId);
    loadSnapshotState(wt, { historical: false });
    await refreshWorkingDirty();
    renderGitPane();
  }

  async function viewCommitOid(oid) {
    await flushSaveTimer();
    const idx = commits.findIndex((c) => c.oid === oid);
    if (idx < 0) return;
    viewingOid = oid;
    activeCommitIndex = idx;
    const [snap, prevPlain] = await Promise.all([
      store.readAtCommit(activeDraftId, oid),
      previousCommitPlain(idx),
    ]);
    loadSnapshotState(snap, { historical: true, historyBaseline: prevPlain });
    renderGitPane();
    updateAnalyzeBtn();
  }

  async function restoreCommitOid(oid) {
    if (!oid || oid === headOid) return;
    await flushSaveTimer();
    const dirty = await store.isDirty(activeDraftId);
    const wtFlags = await store.readWorkingFiles(activeDraftId);
    const abortingMerge = isActiveMerge({
      pendingMerge: wtFlags.pendingMerge,
      hasConflict: wtFlags.hasConflict,
      text: wtFlags.text,
    });
    const ok = window.confirm(
      abortingMerge
        ? "Abort the merge and restore this commit into the working tree?"
        : dirty
          ? "Discard uncommitted edits and restore this commit into the working tree?"
          : "Restore this commit into the working tree?"
    );
    if (!ok) return;
    await store.restoreCommitToWorkingTree(activeDraftId, oid);
    viewingOid = null;
    hasConflict = false;
    pendingMerge = null;
    const wt = await store.readWorkingFiles(activeDraftId);
    await refreshCommits();
    activeCommitIndex = commits.length - 1;
    loadSnapshotState(wt, { historical: false });
    setStatus("Restored into working tree");
    await refreshDraftList();
    renderGitPane();
    await refreshWorkingDirty();
  }

  async function resetToHeadCommit() {
    await flushSaveTimer();
    const dirty = await store.isDirty(activeDraftId);
    const wtFlags = await store.readWorkingFiles(activeDraftId);
    const abortingMerge = isActiveMerge({
      pendingMerge: wtFlags.pendingMerge,
      hasConflict: wtFlags.hasConflict,
      text: wtFlags.text,
    });
    if (dirty || abortingMerge) {
      const ok = window.confirm(
        abortingMerge
          ? "Abort the merge and discard uncommitted edits?"
          : "Discard uncommitted edits and reset to HEAD?"
      );
      if (!ok) return;
    }
    const wt = await store.resetToHead(activeDraftId);
    viewingOid = null;
    hasConflict = false;
    pendingMerge = null;
    await refreshCommits();
    activeCommitIndex = commits.length - 1;
    loadSnapshotState(wt, { historical: false });
    await refreshDraftList();
    syncPaneModeTabs();
    syncRightPane();
    renderGitPane();
    await refreshWorkingDirty();
  }

  gitNewBranchBtn.addEventListener("click", () => {
    runGit(createBranchPrompt);
  });

  gitPane.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-git]");
    if (!actionEl || !gitPane.contains(actionEl)) return;
    const action = actionEl.dataset.git;
    e.preventDefault();
    e.stopPropagation();
    if (action === "checkout") {
      runGit(() => switchBranch(actionEl.dataset.branch));
    } else if (action === "merge") {
      runGit(() => mergeIntoCurrent(actionEl.dataset.branch));
    } else if (action === "delete") {
      runGit(() => deleteBranchNamed(actionEl.dataset.branch));
    } else if (action === "dirty") {
      runGit(exitToDirty);
    } else if (action === "dirty-text") {
      runGit(() => setDirtyEditView("Text"));
    } else if (action === "dirty-diff") {
      runGit(() => setDirtyEditView("Diff"));
    } else if (action === "dirty-review") {
      runGit(enterDirtyReview);
    } else if (action === "view") {
      runGit(() => viewCommitOid(actionEl.dataset.oid));
    } else if (action === "restore") {
      runGit(() => restoreCommitOid(actionEl.dataset.oid));
    } else if (action === "reset") {
      runGit(resetToHeadCommit);
    }
  });

  feedbackEl.addEventListener("click", (e) => {
    if (!result || mode !== "local") return;
    if (e.target.closest("#local-divider")) return;
    if (e.target.closest(".unit-composer")) return;
    const pane = e.target.closest(".local-pane[data-scope]");
    if (!pane || !feedbackEl.contains(pane)) return;
    const scope = pane.dataset.scope;
    if (scope !== "sentence" && scope !== "paragraph") return;
    const index = Number(pane.dataset.index);
    if (!Number.isFinite(index)) return;
    if (chatFocus.scope === scope && chatFocus.index === index) return;
    chatFocus = { scope, index };
    renderFeedback();
    syncEditorHighlight(true);
  });

  async function readChatStream(res) {
    if (!res.body) {
      throw new Error(res.statusText || "Chat failed");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneEvent = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          throw new Error("Invalid chat event from server");
        }
        if (event.type === "done") {
          doneEvent = event;
        } else if (event.type === "error") {
          throw new Error(event.detail || "Chat failed");
        }
      }
    }
    if (!doneEvent) {
      throw new Error("Chat ended without a reply");
    }
    return doneEvent;
  }

  async function sendChat(scope, index, inputEl) {
    if (!canChatScope(scope)) return;
    const text = (inputEl?.value || chatDrafts[scope] || "").trim();
    if (!text) return;
    const payload = unitPayload(scope, index);
    if (!payload) return;

    chatFocus = { scope, index: index == null ? null : index };
    const prior = messagesForKey(scope, index).slice();
    const key = chatKey(scope, index);
    chats[key] = [...prior, { role: "user", content: text }];
    chatDrafts[scope] = "";
    if (inputEl) {
      inputEl.value = "";
      resizeTextarea(inputEl);
    }
    renderFeedback({ stickBottomScope: scope });

    chatBusy = true;
    syncChatComposer();
    setStatus("replying...");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: baseline || currentText,
          text_current: payload.text_current || "",
          model: currentModel,
          scope: payload.scope,
          unit_text: payload.unit_text,
          unit_feedback: payload.unit_feedback,
          unit_text_current: payload.unit_text_current || "",
          messages: prior,
          message: text,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const detail = data.detail;
        throw new Error(
          typeof detail === "string" ? detail : res.statusText || "Chat failed"
        );
      }
      const data = await readChatStream(res);
      const reply = String(data.reply || "");
      const cost = Number(data.cost) || 0;
      chats[key] = [
        ...(Array.isArray(chats[key]) ? chats[key] : prior),
        { role: "assistant", content: reply },
      ];
      draftCost += cost;
      updateMeta();
      setStatus("");
      renderFeedback({ stickBottomScope: scope });
      persistActiveDraftNow();
    } catch (err) {
      chats[key] = prior;
      renderFeedback({ stickBottomScope: scope });
      setStatus(String(err.message || err), "danger");
    } finally {
      chatBusy = false;
      syncChatComposer();
    }
  }

  chatComposer.addEventListener("submit", (e) => {
    e.preventDefault();
    sendChat("text", null, chatInput);
  });

  chatInput.addEventListener("input", () => {
    chatDrafts.text = chatInput.value || "";
    resizeTextarea(chatInput);
    syncChatComposer();
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat("text", null, chatInput);
    }
  });

  feedbackEl.addEventListener("submit", (e) => {
    const form = e.target.closest(".unit-composer");
    if (!form || !feedbackEl.contains(form)) return;
    e.preventDefault();
    const scope = form.dataset.scope;
    const index = Number(form.dataset.index);
    const input = form.querySelector("textarea");
    if (scope !== "sentence" && scope !== "paragraph") return;
    if (!Number.isFinite(index)) return;
    sendChat(scope, index, input);
  });

  feedbackEl.addEventListener("input", (e) => {
    const ta = e.target.closest(".unit-composer textarea");
    if (!ta || !feedbackEl.contains(ta)) return;
    const form = ta.closest(".unit-composer");
    const scope = form?.dataset.scope;
    if (scope !== "sentence" && scope !== "paragraph") return;
    chatDrafts[scope] = ta.value || "";
    resizeTextarea(ta);
    const sendBtn = form.querySelector(".chat-send");
    if (sendBtn) {
      sendBtn.disabled = !canChatScope(scope) || !(ta.value || "").trim();
    }
  });

  feedbackEl.addEventListener("keydown", (e) => {
    const ta = e.target.closest(".unit-composer textarea");
    if (!ta || !feedbackEl.contains(ta)) return;
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const form = ta.closest(".unit-composer");
    const scope = form?.dataset.scope;
    const index = Number(form?.dataset.index);
    if (scope !== "sentence" && scope !== "paragraph") return;
    if (!Number.isFinite(index)) return;
    sendChat(scope, index, ta);
  });

  // Resizable divider between draft and feedback
  let resizing = false;

  function setSplitFromClientX(clientX) {
    const rect = panes.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = clientX - rect.left;
    const min = 160;
    const max = rect.width - 160 - 5;
    const clamped = Math.min(max, Math.max(min, x));
    const leftPct = (clamped / rect.width) * 100;
    draftPane.style.flex = `0 0 ${leftPct}%`;
  }

  function endResize() {
    if (!resizing) return;
    resizing = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  divider.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = true;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    divider.setPointerCapture(e.pointerId);
  });

  divider.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    setSplitFromClientX(e.clientX);
  });

  divider.addEventListener("pointerup", endResize);
  divider.addEventListener("pointercancel", endResize);

  divider.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 40 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const rect = panes.getBoundingClientRect();
      const current = draftPane.getBoundingClientRect().width;
      const next = current + (e.key === "ArrowLeft" ? -step : step);
      setSplitFromClientX(rect.left + next);
    }
  });

  window.addEventListener("beforeunload", () => {
    if (saveTimer != null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // Fire-and-forget; browsers may truncate async work on unload.
    persistActiveDraftNow();
  });

  let composerSepObserver;
  composerSepObserver = new ResizeObserver(() => {
    syncComposerSeparators();
  });
  composerSepObserver.observe(feedbackEl);
  composerSepObserver.observe(chatComposer);
  window.addEventListener("resize", () => syncComposerSeparators());

  (async () => {
    try {
      if (!store) throw new Error("gitStore failed to load");
      setStatus("Loading drafts...");
      await store.init();
      await refreshDraftList();
      updateMeta();
      resetEditorState({ text: "" });
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(String(err.message || err), "danger");
    }
  })();
})();
