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
  stripHtml,
  mergeCleanEditsIntoMarked,
  stripKindredProtocol,
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
  const chatListEl = document.getElementById("chat-list");
  const draftListEl = document.getElementById("draft-list");
  const draftsHeading = document.getElementById("drafts-heading");
  const chatBackBtn = document.getElementById("chat-back-btn");
  const chatHeading = document.getElementById("chat-heading");
  const newChatBtn = document.getElementById("new-chat-btn");
  const paneModeCluster = document.getElementById("pane-mode-cluster");
  const gitPane = document.getElementById("git-pane");
  const gitDirtySection = document.getElementById("git-dirty-section");
  const gitDirtyModes = document.getElementById("git-dirty-modes");
  const gitBranchList = document.getElementById("git-branch-list");
  const gitCommitList = document.getElementById("git-commit-list");
  const gitNewBranchBtn = document.getElementById("git-new-branch");
  const chatComposer = document.getElementById("chat-composer");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const statusEl = document.getElementById("status");
  const metaEl = document.getElementById("meta");
  const commitBtn = document.getElementById("commit-btn");
  const importBtn = document.getElementById("import-btn");
  const exportControls = document.getElementById("export-controls");
  const exportBtn = document.getElementById("export-btn");
  const exportMenuBtn = document.getElementById("export-menu-btn");
  const exportMenu = document.getElementById("export-menu");
  const homeBtn = document.getElementById("home-btn");
  const draftHeaderSep = document.getElementById("draft-header-sep");
  const draftHeaderTitleEl = document.getElementById("draft-header-title");
  const draftHeaderTitleInput = document.getElementById("draft-header-title-input");
  const panes = document.getElementById("panes");
  const draftPane = document.getElementById("draft-pane");
  const divider = document.getElementById("divider");

  const DEFAULT_MODEL = "openai/gpt-5.6-luna";
  // HtmlDiff treats "<...>" as tags; shield raw "<" in plain text.
  const HTMLDIFF_LT = "\uE000";
  const HTMLDIFF_ACTION = { equal: 0, delete: 1, insert: 2, none: 3, replace: 4 };
  let diffsCacheKey = null;
  let diffsCacheParts = null;

  /** History overlay baseline (previous commit plain); not analysis. */
  let baseline = "";
  let currentText = "";
  let currentHtml = "";
  /** Working-tree body for auto-title + counts (not history / review markup). */
  let dirtyHtml = "";
  let dirtyText = "";
  let paneMode = "chat";
  let chatRecords = [];
  let activeChatId = null;
  /** @type {"list"|"thread"} */
  let chatView = "list";
  let chatBusy = false;
  let composerDraft = "";
  let renamingChatId = null;
  let rendering = false;
  let converting = false;
  let applyingHistory = false;
  let currentModel = DEFAULT_MODEL;
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
  /** @type {{ kind: "commit"|"branch", key: string } | null} */
  let renamingGit = null;

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
      } else if (dirtyViewMode === "Diff") {
        // Dirty: vs HEAD. History: vs previous commit (baseline set by loadSnapshotState).
        refreshOverlay(tipTap, {
          baseline: viewing ? baseline : headPlain,
          currentPlain: currentText,
          highlight: null,
          markedHtml: "",
          conflictMode,
        });
      } else {
        refreshOverlay(tipTap, {
          baseline: "",
          currentPlain: currentText,
          highlight: null,
          showDiffs: false,
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
      const tipHtml = getHtml(tipTap);
      const merged = mergeCleanEditsIntoMarked(currentHtml, tipHtml);
      if (merged != null) currentHtml = merged;
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
        converting ||
        applyingHistory ||
        gitBusy ||
        isViewingHistory()
      ) {
        return;
      }
      pullFromEditor();
      syncDirtyBodyFromCurrent();
      if (pendingMerge || hasConflict || htmlHasAlignConflict(currentHtml)) syncMergeStatus();
      refreshStatusLeft();
      workingDirty = true;
      updateCommitBtn();
      syncOverlayFromState();
      syncHeaderTitle();
      void ensureDraftForText(currentText).then(() => {
        syncRightPane();
        updateCommitBtn();
      });
      persistActiveDraftSoon();
    },
    placeholder: editor.dataset.placeholder || "Paste or type your text here. Double-click to import.",
  });
  bindToolbar(tipTap, toolbarEl);

  const stashChatKeptSelection = () => {
    if (!tipTap) return;
    const { from, to } = tipTap.state.selection;
    tipTap.commands.setKeptSelection({ from, to });
  };
  const markChatComposerKeep = () => {
    chatComposer.dataset.keepSelection = "1";
    stashChatKeptSelection();
  };

  // Whole composer (input, Send, padding) is a keep-target — not focus-only.
  chatComposer.addEventListener("pointerdown", markChatComposerKeep);
  chatComposer.addEventListener("focusin", markChatComposerKeep);
  chatComposer.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (chatComposer.contains(document.activeElement)) return;
      if (chatComposer.dataset.keepSelection === "1") return;
      const active = document.activeElement;
      if (
        active &&
        toolbarEl &&
        (active === toolbarEl.querySelector("[data-font-size]") ||
          active === toolbarEl.querySelector("[data-font-family]") ||
          active === toolbarEl.querySelector("[data-font-family-trigger]") ||
          active === toolbarEl.querySelector("[data-color-input]") ||
          active?.closest?.("[data-font-family-panel]"))
      ) {
        return;
      }
      if (document.querySelector(".clr-picker.clr-open")) return;
      tipTap?.commands.clearKeptSelection();
    });
  });
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("#chat-composer")) return;
    if (chatComposer.dataset.keepSelection !== "1") return;
    delete chatComposer.dataset.keepSelection;
  });
  tipTap.on("focus", () => {
    delete chatComposer.dataset.keepSelection;
  });

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

  /** True when there is exportable WT/base body (conflict views omit sides from plain text). */
  function hasExportableBody() {
    if ((dirtyText || "").trim()) return true;
    if ((dirtyHtml || "").trim() && dirtyHtml !== "<p></p>") return true;
    if (unresolvedMergeConflictCount(currentHtml) > 0) {
      const side = dirtyReviewing
        ? htmlTakingTheirs(currentHtml)
        : htmlTakingOurs(currentHtml);
      const plain = store ? store.htmlToPlain(side) : "";
      return !!(plain || "").trim();
    }
    return !editorIsEmpty();
  }

  /**
   * Clean HTML for export (never conflict protocol).
   * Dirty review → working-tree (theirs); live merge → base branch (ours).
   */
  function htmlForExport() {
    const html = currentHtml || "<p></p>";
    if (unresolvedMergeConflictCount(html) > 0) {
      return dirtyReviewing ? htmlTakingTheirs(html) : htmlTakingOurs(html);
    }
    return dirtyHtml || html;
  }

  function setExportMenuOpen(open) {
    const next = !!open && !exportMenuBtn.disabled && !exportControls.hidden;
    exportMenu.hidden = !next;
    exportMenuBtn.setAttribute("aria-expanded", next ? "true" : "false");
    exportControls.classList.toggle("is-open", next);
  }

  function updateExportBtn() {
    const exportDisabled =
      converting || gitBusy || !hasExportableBody() || isViewingHistory();
    importBtn.hidden = !activeDraftId;
    exportControls.hidden = !activeDraftId;
    importBtn.disabled = !canOpenImportDialog();
    exportBtn.disabled = exportDisabled;
    exportMenuBtn.disabled = exportDisabled;
    if (exportDisabled || !activeDraftId) setExportMenuOpen(false);
  }

  function updateCommitBtn() {
    const hasText = !editorIsEmpty();
    const unresolved = unresolvedMergeConflictCount(currentHtml) > 0;
    const finishMerge = !!(pendingMerge && !unresolved);
    // Dirty review: Commit stays enabled; unresolved hunks auto-keep Dirty on commit.
    const blockCommitForConflicts = unresolved && !dirtyReviewing;
    commitBtn.hidden = !activeDraftId || paneMode !== "git";
    commitBtn.textContent = pendingMerge ? "Merge" : "Commit";
    commitBtn.disabled =
      converting ||
      gitBusy ||
      !hasText ||
      isViewingHistory() ||
      blockCommitForConflicts ||
      (!workingDirty && !finishMerge);
    updateExportBtn();
  }

  async function refreshWorkingDirty() {
    if (!activeDraftId || !store) {
      workingDirty = false;
      updateCommitBtn();
      return;
    }
    try {
      workingDirty = await store.isDirty(activeDraftId);
    } catch (err) {
      console.warn("kindred: dirty check failed", err);
      workingDirty = true;
    }
    updateCommitBtn();
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

  /** Resolve conflict HTML to one side (ours = base branch, theirs = incoming/dirty). */
  function htmlTakingSide(sourceHtml, side) {
    const takeTheirs = side === "theirs";
    const segments = parseConflictSegments(sourceHtml);
    let html = sourceHtml;
    if (segments) {
      const parts = [];
      for (const seg of segments) {
        if (seg.type === "text") parts.push(seg.text);
        else parts.push(takeTheirs ? seg.theirs : seg.ours);
      }
      html = parts.join("");
    }
    const alignAttr = takeTheirs
      ? "data-kindred-align-theirs"
      : "data-kindred-align-ours";
    html = String(html || "").replace(/<p\b([^>]*)>/gi, (full, attrs) => {
      if (!/\bdata-kindred-align-(?:ours|theirs)\s*=/i.test(attrs)) return full;
      const m = attrs.match(
        new RegExp(`\\b${alignAttr}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i")
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
    return html || "<p></p>";
  }

  function htmlTakingOurs(sourceHtml) {
    return htmlTakingSide(sourceHtml, "ours");
  }

  function htmlTakingTheirs(sourceHtml) {
    return htmlTakingSide(sourceHtml, "theirs");
  }

  /** Keep auto-title/counts on WT body; skip while viewing history. */
  function syncDirtyBodyFromCurrent() {
    if (isViewingHistory()) return;
    let html = currentHtml || "<p></p>";
    if (unresolvedMergeConflictCount(html) > 0) {
      // Dirty review → working tree (theirs). Live merge → base branch (ours).
      html = dirtyReviewing ? htmlTakingTheirs(html) : htmlTakingOurs(html);
      dirtyHtml = html;
      dirtyText = store.htmlToPlain(html);
      return;
    }
    dirtyHtml = html;
    dirtyText = currentText || store.htmlToPlain(html);
  }

  function refreshStatusLeft() {
    const { words, chars, sentences, paragraphs } = countStats(dirtyText);
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

  function formatCost(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return "$0.0000";
    return `$${v.toFixed(4)}`;
  }

  function updateMeta() {
    metaEl.textContent = `${currentModel} · ${formatCost(draftCost)} total`;
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
      store.titleFromText(dirtyHtml || dirtyText || "") ||
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
      model: currentModel,
      hasConflict,
      pendingMerge,
      activeBranch: currentBranchName,
    };
  }

  function chatsState() {
    return { activeChatId, chats: chatRecords, totalCost: draftCost };
  }

  async function persistChatsNow() {
    if (!activeDraftId || !store) return;
    try {
      const next = await store.saveChats(activeDraftId, chatsState());
      activeChatId = next.activeChatId;
      chatRecords = next.chats;
      draftCost = Number(next.totalCost) || 0;
    } catch (err) {
      console.warn("kindred: failed to save chats", err);
    }
  }

  async function loadChatsForDraft(id) {
    if (!id || !store) {
      chatRecords = [];
      activeChatId = null;
      chatView = "list";
      draftCost = 0;
      return;
    }
    try {
      const state = await store.readChats(id);
      chatRecords = state.chats || [];
      activeChatId = state.activeChatId || null;
      draftCost = Number(state.totalCost) || 0;
      chatView = activeChatId ? "thread" : "list";
      if (activeChatId && !chatRecords.some((c) => c.id === activeChatId)) {
        activeChatId = null;
        chatView = "list";
      }
    } catch (err) {
      console.warn("kindred: failed to load chats", err);
      chatRecords = [];
      activeChatId = null;
      draftCost = 0;
      chatView = "list";
    }
  }

  function clearChatState() {
    chatRecords = [];
    activeChatId = null;
    chatView = "list";
    chatBusy = false;
    composerDraft = "";
    renamingChatId = null;
    draftCost = 0;
  }

  function activeChat() {
    if (!activeChatId) return null;
    return chatRecords.find((c) => c.id === activeChatId) || null;
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
    paneMode = "chat";
    clearChatState();
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
    updateCommitBtn();
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

  function syncChatHeader() {
    const showChatChrome = !!(activeDraftId && paneMode === "chat");
    const inList = showChatChrome && chatView === "list";
    const inThread = showChatChrome && chatView === "thread";
    draftsHeading.hidden = !!activeDraftId;
    if (chatBackBtn) {
      chatBackBtn.hidden = !inThread;
      chatBackBtn.textContent = "All";
    }
    if (chatHeading) chatHeading.hidden = true;
    if (newChatBtn) {
      newChatBtn.hidden = !showChatChrome;
      newChatBtn.textContent = "New";
      newChatBtn.classList.toggle("btn-primary", inList);
      newChatBtn.classList.toggle("btn-secondary", !inList);
    }
  }

  function showHomePane() {
    paneMode = "chat";
    paneModeCluster.hidden = true;
    draftsHeading.hidden = false;
    if (chatHeading) chatHeading.hidden = true;
    if (newChatBtn) newChatBtn.hidden = true;
    if (chatBackBtn) chatBackBtn.hidden = true;
    feedbackEl.hidden = true;
    if (chatListEl) chatListEl.hidden = true;
    chatComposer.hidden = true;
    gitPane.hidden = true;
    draftListEl.hidden = false;
    commitBtn.hidden = true;
    importBtn.hidden = true;
    exportControls.hidden = true;
    setExportMenuOpen(false);
    renderDraftList();
    syncPaneModeTabs();
  }

  function showGitPane() {
    draftsHeading.hidden = true;
    draftListEl.hidden = true;
    if (chatHeading) chatHeading.hidden = true;
    if (newChatBtn) newChatBtn.hidden = true;
    if (chatBackBtn) chatBackBtn.hidden = true;
    feedbackEl.hidden = true;
    if (chatListEl) chatListEl.hidden = true;
    chatComposer.hidden = true;
    paneModeCluster.hidden = false;
    gitPane.hidden = false;
    syncPaneModeTabs();
    renderGitPane();
    updateCommitBtn();
  }

  function showChatPane() {
    draftsHeading.hidden = true;
    draftListEl.hidden = true;
    paneModeCluster.hidden = false;
    gitPane.hidden = true;
    syncPaneModeTabs();
    syncChatHeader();
    if (chatView === "list") {
      feedbackEl.hidden = true;
      chatComposer.hidden = true;
      if (chatListEl) {
        chatListEl.hidden = false;
        renderChatList();
      }
    } else {
      if (chatListEl) chatListEl.hidden = true;
      feedbackEl.hidden = false;
      chatComposer.hidden = false;
      renderChatThread();
      syncChatComposer();
    }
    updateCommitBtn();
  }

  function syncRightPane() {
    if (!activeDraftId) showHomePane();
    else if (paneMode === "git") showGitPane();
    else showChatPane();
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
    baseline = historyBaseline !== undefined ? historyBaseline : "";
    currentHtml = snap.html || snap.text || "";
    if (!currentHtml) currentHtml = "<p></p>";
    currentText = ""; // filled by applyRevisionToEditor via getPlain
    currentModel = snap.model || DEFAULT_MODEL;
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
    clearHistory();
    applyRevisionToEditor();
    if (!historical) syncDirtyBodyFromCurrent();
    setEditorEditable(!historical);
    updateMeta();
    syncMergeStatus();
    refreshStatusLeft();
    syncHeaderTitle();
    updateCommitBtn();
    syncRightPane();
  }

  function resetEditorState({ text = "", keepHistory = false } = {}) {
    baseline = "";
    currentHtml = text ? plainToHtml(text) : "<p></p>";
    currentText = "";
    clearChatState();
    currentModel = DEFAULT_MODEL;
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
    renamingGit = null;
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
    syncDirtyBodyFromCurrent();
    setEditorEditable(true);
    updateMeta();
    setStatus("");
    refreshStatusLeft();
    updateCommitBtn();
    syncRightPane();
  }

  async function goHome() {
    await flushSaveTimer();
    activeDraftId = null;
    paneMode = "chat";
    clearChatState();
    resetEditorState({ text: "" });
    syncHeaderTitle();
    tipTap?.commands.focus();
  }

  async function openDraft(id) {
    await flushSaveTimer();
    const draft = findDraft(id) || (await store.readWorkingFiles(id));
    if (!draft) return;
    activeDraftId = id;
    paneMode = "chat";
    viewingOid = null;
    renamingGit = null;
    const wt = await store.readWorkingFiles(id);
    hasConflict = !!wt.hasConflict;
    pendingMerge = wt.pendingMerge || null;
    if (hasConflict) paneMode = "git";
    await refreshCommits();
    await loadChatsForDraft(id);
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
      clearChatState();
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
      // Dirty review must not touch the status bar.
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
    currentHtml = htmlTakingTheirs(currentHtml);
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
    syncDirtyBodyFromCurrent();
    refreshStatusLeft();
    syncHeaderTitle();
    persistActiveDraftSoon();
    await refreshWorkingDirty();
  }

  async function setDirtyEditView(mode) {
    if (mode !== "Text" && mode !== "Diff") return;
    if (pendingMerge) return;
    if (dirtyReviewing) await leaveDirtyReview();
    dirtyViewMode = mode;
    renderGitPane();
    syncOverlayFromState();
  }

  async function enterDirtyReview() {
    if (!activeDraftId || !store) return;
    if (isViewingHistory()) return;
    if (pendingMerge) return;
    if (dirtyReviewing) return;
    if (unresolvedMergeConflictCount(currentHtml) > 0) return;
    if (!headOid) return;
    if (!workingDirty) return;
    await flushSaveTimer();
    pullFromEditor();
    const dirty = await store.isDirty(activeDraftId);
    if (!dirty) return;
    const head = await store.readHead(activeDraftId);
    if (!head) return;
    const headHtml = head.html || head.text || "";
    const result = store.reviewWorkingTree(
      headHtml,
      currentHtml,
      currentBranchName || "HEAD"
    );
    if (result.cleanMerge) return;
    currentHtml = result.mergedText || "<p></p>";
    hasConflict = true;
    dirtyReviewing = true;
    workingDirty = true;
    applyRevisionToEditor();
    syncDirtyBodyFromCurrent();
    syncMergeStatus();
    refreshStatusLeft();
    syncHeaderTitle();
    updateCommitBtn();
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
    syncDirtyBodyFromCurrent();
    syncMergeStatus();
    refreshStatusLeft();
    syncHeaderTitle();
    updateCommitBtn();
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
      if (!stripHtml(seg.ours) || !stripHtml(seg.theirs)) return;
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
    currentText = getPlain(tipTap);
    workingDirty = true;
    syncDirtyBodyFromCurrent();
    syncOverlayFromState();
    syncMergeStatus();
    refreshStatusLeft();
    syncHeaderTitle();
    updateCommitBtn();
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

  /** Plain offsets for TipTap selection (paragraphs joined with \n\n). */
  function caretSelectionOffsets() {
    if (!tipTap) return { from: 0, to: 0 };
    const { from, to } = tipTap.state.selection;
    const fromOff = tipTap.state.doc.textBetween(0, from, "\n\n", "\n").length;
    const toOff = tipTap.state.doc.textBetween(0, to, "\n\n", "\n").length;
    return { from: Math.min(fromOff, toOff), to: Math.max(fromOff, toOff) };
  }

  function canUseComposer() {
    if (!activeDraftId || chatView !== "thread" || !activeChatId) return false;
    if (chatBusy || converting || gitBusy || isViewingHistory()) return false;
    return true;
  }

  function resizeTextarea(el) {
    if (!el) return;
    const maxPx = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--size-composer-max"),
    ) || 128;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  }

  function syncChatComposer() {
    const show = !!(
      activeDraftId &&
      paneMode === "chat" &&
      chatView === "thread" &&
      activeChatId
    );
    chatComposer.hidden = !show;
    if (!show) {
      chatComposer.classList.remove("is-separated");
      return;
    }
    const enabled = canUseComposer();
    chatInput.placeholder = "Ask about the draft...";
    chatInput.setAttribute("aria-label", "Ask about the draft");
    if (document.activeElement !== chatInput) {
      chatInput.value = composerDraft;
      resizeTextarea(chatInput);
    }
    chatInput.disabled = !enabled;
    chatSend.disabled = !enabled || !(chatInput.value || "").trim();
    chatComposer.setAttribute("aria-busy", chatBusy ? "true" : "false");
    requestAnimationFrame(() => syncComposerSeparators());
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
  }

  function bindComposerScrollWatch(el) {
    if (!el || el.dataset.sepScroll === "1") return;
    el.dataset.sepScroll = "1";
    el.addEventListener("scroll", () => syncComposerSeparators(), {
      passive: true,
    });
  }

  function renderChatList() {
    if (!chatListEl) return;
    if (!chatRecords.length) {
      chatListEl.innerHTML =
        `<p class="draft-list-empty">No chats yet. Start a new chat to ask about this draft.</p>`;
      return;
    }
    const sorted = chatRecords
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    chatListEl.innerHTML = sorted
      .map((c) => {
        const branch = c.lastBranch ? ` · ${c.lastBranch}` : "";
        const title = escapeHtml(c.title || store.DEFAULT_CHAT_TITLE);
        const renaming = renamingChatId === c.id;
        const titleHtml = renaming
          ? `<input class="draft-item-title-input" data-action="rename-input" value="${title}" aria-label="Chat title" />`
          : `<span class="draft-item-title">${title}</span>`;
        return (
          `<div class="draft-item" role="listitem" data-id="${escapeHtml(c.id)}">` +
          `<div class="draft-item-body" data-action="open">` +
          titleHtml +
          `<span class="draft-item-meta">${escapeHtml(formatDraftTime(c.updatedAt))}${escapeHtml(branch)}</span>` +
          `</div>` +
          `<button type="button" class="draft-item-delete" data-action="delete" title="Delete chat" aria-label="Delete chat">×</button>` +
          `</div>`
        );
      })
      .join("");
    if (renamingChatId) {
      const input = chatListEl.querySelector(
        `.draft-item[data-id="${CSS.escape(renamingChatId)}"] .draft-item-title-input`
      );
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  function renderChatThread({ stickBottom = false } = {}) {
    const chat = activeChat();
    if (!chat) {
      feedbackEl.innerHTML = `<p class="muted">Select or create a chat.</p>`;
      return;
    }
    const msgs = Array.isArray(chat.messages) ? chat.messages : [];
    const scrollTop = feedbackEl.scrollTop;
    const wasAtBottom = scrollAreaAtBottom(feedbackEl);
    if (!msgs.length) {
      feedbackEl.innerHTML = `<p class="muted">Ask anything about the draft.</p>`;
    } else {
      feedbackEl.innerHTML =
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
        `</div>`;
    }
    requestAnimationFrame(() => {
      if (stickBottom || wasAtBottom) {
        feedbackEl.scrollTop = feedbackEl.scrollHeight;
      } else {
        feedbackEl.scrollTop = scrollTop;
      }
      bindComposerScrollWatch(feedbackEl);
      syncComposerSeparators();
    });
  }

  async function createChat() {
    if (!activeDraftId) return;
    const now = Date.now();
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `chat-${now}-${Math.random().toString(36).slice(2, 10)}`;
    const chat = {
      id,
      title: store.DEFAULT_CHAT_TITLE || "New Chat",
      lastBranch: currentBranchName || "main",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    chatRecords = [chat, ...chatRecords];
    activeChatId = id;
    chatView = "thread";
    composerDraft = "";
    await persistChatsNow();
    syncRightPane();
    tipTap?.commands.focus();
  }

  async function openChat(id) {
    const chat = chatRecords.find((c) => c.id === id);
    if (!chat) return;
    activeChatId = id;
    chat.lastBranch = currentBranchName || chat.lastBranch || "main";
    chat.updatedAt = Date.now();
    chatView = "thread";
    composerDraft = "";
    await persistChatsNow();
    syncRightPane();
  }

  async function deleteChat(id) {
    const chat = chatRecords.find((c) => c.id === id);
    if (!chat) return;
    const ok = window.confirm(`Delete chat “${chat.title || "New Chat"}”?`);
    if (!ok) return;
    chatRecords = chatRecords.filter((c) => c.id !== id);
    if (activeChatId === id) {
      activeChatId = null;
      chatView = "list";
      composerDraft = "";
    }
    if (renamingChatId === id) renamingChatId = null;
    await persistChatsNow();
    syncRightPane();
  }

  async function finishChatRename(id, value, { cancel = false } = {}) {
    if (renamingChatId !== id) return;
    renamingChatId = null;
    const chat = chatRecords.find((c) => c.id === id);
    if (!chat) {
      renderChatList();
      return;
    }
    if (!cancel) {
      const trimmed = String(value ?? "").trim();
      chat.title = trimmed || store.DEFAULT_CHAT_TITLE || "New Chat";
      chat.updatedAt = Date.now();
      await persistChatsNow();
    }
    renderChatList();
    syncChatHeader();
  }

  function showChatList() {
    chatView = "list";
    composerDraft = "";
    syncRightPane();
  }

  function setPaneMode(next) {
    if (next !== "chat" && next !== "git") return;
    if (paneMode === next) {
      syncPaneModeTabs();
      return;
    }
    paneMode = next;
    syncPaneModeTabs();
    updateCommitBtn();
    syncRightPane();
    syncOverlayFromState();
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
        const renaming =
          renamingGit?.kind === "branch" && renamingGit.key === name;
        const titleHtml = renaming
          ? `<input class="git-row-title-input" data-git="rename-input" value="${escapeHtml(name)}" aria-label="Branch name" />`
          : `<span class="git-row-title">${escapeHtml(name)}</span>`;
        const actions = current
          ? ""
          : `<div class="git-row-actions">` +
            `<button type="button" class="btn btn-tertiary" data-git="merge" data-branch="${escapeHtml(name)}">Merge</button>` +
            `<button type="button" class="draft-item-delete" data-git="delete" data-branch="${escapeHtml(name)}" title="Delete branch" aria-label="Delete branch">×</button>` +
            `</div>`;
        return (
          `<div class="git-row${current ? " active" : ""}" role="listitem" data-git="checkout" data-branch="${escapeHtml(name)}">` +
          `<div class="git-row-body">` +
          titleHtml +
          `</div>${actions}</div>`
        );
      })
      .join("");
    gitBranchList.innerHTML =
      branchRows || `<p class="git-empty">No branches yet.</p>`;

    if (!commits.length) {
      gitDirtySection.hidden = true;
      gitDirtyModes.innerHTML = "";
      gitCommitList.innerHTML = `<p class="git-empty">No commits yet. Commit to create one.</p>`;
    } else {
      const atDirty = !viewingOid;
      const modesLocked = gitBusy || !!pendingMerge;
      const textActive = !dirtyReviewing && dirtyViewMode === "Text";
      const diffActive = !dirtyReviewing && dirtyViewMode === "Diff";
      const reviewActive = atDirty && dirtyReviewing;
      const reviewDisabled =
        modesLocked || !!viewingOid || (!workingDirty && !dirtyReviewing);
      const dirtyBtn = (label, action, active, disabled) =>
        `<button type="button" class="tab btn btn-secondary${active ? " active" : ""}" data-git="${action}" role="tab" aria-selected="${active ? "true" : "false"}"${disabled ? " disabled" : ""}>${label}</button>`;
      gitDirtySection.hidden = false;
      gitDirtyModes.innerHTML =
        dirtyBtn("Text", "dirty-text", textActive, modesLocked) +
        dirtyBtn("Diff", "dirty-diff", diffActive, modesLocked) +
        dirtyBtn("Review", "dirty-review", reviewActive, reviewDisabled);
      const dirtyRow =
        `<div class="git-row git-row-dirty${atDirty ? " active" : ""}" role="listitem" data-git="dirty">` +
        `<div class="git-row-body">` +
        `<span class="git-row-title">dirty</span>` +
        `</div></div>`;
      const commitRows = commits
        .slice()
        .reverse()
        .map((c) => {
          const active = viewingOid === c.oid ? " active" : "";
          const head = c.oid === headOid ? " · head" : "";
          const msg = (c.message || "").split("\n")[0];
          const isHead = c.oid === headOid;
          const renaming =
            renamingGit?.kind === "commit" && renamingGit.key === c.oid;
          const titleHtml = renaming
            ? `<input class="git-row-title-input" data-git="rename-input" value="${escapeHtml(msg)}" aria-label="Commit message" />`
            : `<span class="git-row-title">${escapeHtml(msg)}</span>`;
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
            titleHtml +
            `<span class="git-row-meta">${escapeHtml(shortOid(c.oid))}${head} · ${escapeHtml(formatDraftTime(c.timestamp))}</span>` +
            `</div>${actions}</div>`
          );
        })
        .join("");
      gitCommitList.innerHTML = dirtyRow + commitRows;
    }
    gitNewBranchBtn.disabled = gitBusy || !commits.length;

    if (renamingGit) {
      const sel =
        renamingGit.kind === "branch"
          ? `#git-branch-list .git-row[data-branch="${CSS.escape(renamingGit.key)}"] .git-row-title-input`
          : `#git-commit-list .git-row[data-oid="${CSS.escape(renamingGit.key)}"] .git-row-title-input`;
      const input = gitPane.querySelector(sel);
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  async function runGit(fn) {
    if (!activeDraftId || gitBusy) return;
    gitBusy = true;
    updateCommitBtn();
    try {
      await fn();
    } catch (err) {
      setStatus(String(err.message || err), "danger");
    } finally {
      gitBusy = false;
      updateCommitBtn();
      if (paneMode === "git") renderGitPane();
    }
  }

  async function manualCommit() {
    if (isViewingHistory()) {
      setStatus("Restore this commit before committing.");
      return;
    }
    // Dirty review: keep Dirty for any unresolved hunks, then commit clean HTML.
    if (dirtyReviewing) await leaveDirtyReview();
    await flushSaveTimer();
    const verb = hasConflict || pendingMerge ? "Merge" : "Commit";
    await store.saveWorkingTree(activeDraftId, snapshotState());
    const dirty = await store.isDirty(activeDraftId);
    if (!dirty && !pendingMerge) {
      workingDirty = false;
      updateCommitBtn();
      setStatus("Nothing to commit");
      return;
    }
    const { oid } = await store.commitWorkingTree(activeDraftId, { verb });
    hasConflict = false;
    pendingMerge = null;
    dirtyReviewing = false;
    viewingOid = null;
    workingDirty = false;
    await refreshCommits();
    const wt = await store.readWorkingFiles(activeDraftId);
    loadSnapshotState(wt, { historical: false });
    setStatus("");
    await refreshDraftList();
    renamingGit = { kind: "commit", key: oid };
    updateCommitBtn();
  }

  commitBtn.addEventListener("click", () => {
    void runGit(manualCommit);
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
    if (converting || gitBusy || applyingHistory) return false;
    if (isViewingHistory()) return false;
    // Import replaces the doc (allowed during dirty review and live merges).
    return true;
  }

  async function importChosenFile(file) {
    if (!file) return;
    converting = true;
    updateCommitBtn();
    setStatus("importing...");
    try {
      if (pendingMerge && activeDraftId && store) {
        await flushSaveTimer();
        await store.resetToHead(activeDraftId);
        viewingOid = null;
        hasConflict = false;
        pendingMerge = null;
        dirtyReviewing = false;
        await refreshCommits();
      }
      const html = stripKindredProtocol(await importFileToHtml(file));
      suppressEditorUpdate = true;
      try {
        setHtml(tipTap, html, { emitUpdate: false });
      } finally {
        suppressEditorUpdate = false;
      }
      // Replace buffer outright — pullFromEditor would merge into stale conflict markers.
      currentHtml = html || "<p></p>";
      currentText = getPlain(tipTap);
      dirtyReviewing = false;
      hasConflict = unresolvedMergeConflictCount(currentHtml) > 0;
      pendingMerge = null;
      syncDirtyBodyFromCurrent();
      await ensureDraftForText(currentText);
      await persistActiveDraftNow();
      syncOverlayFromState();
      syncRightPane();
      if (paneMode === "git") renderGitPane();
      updateCommitBtn();
      refreshStatusLeft();
      syncHeaderTitle();
      await refreshWorkingDirty();
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(String(err.message || err), "danger");
    } finally {
      converting = false;
      updateCommitBtn();
    }
  }

  function openImportDialog() {
    if (!canOpenImportDialog()) return;
    importFileInput.value = "";
    importFileInput.click();
  }

  editor.addEventListener("dblclick", (e) => {
    if (hasExportableBody() || !canOpenImportDialog()) return;
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
    if (exportBtn.disabled) return;
    setExportMenuOpen(false);
    converting = true;
    updateCommitBtn();
    setStatus("exporting...");
    try {
      pullFromEditor();
      syncDirtyBodyFromCurrent();
      const exportHtml = htmlForExport();
      const exportPlain = store.htmlToPlain(exportHtml);
      if (!(exportPlain || "").trim() && exportHtml === "<p></p>") {
        setStatus("Nothing to export.", "warn");
        return;
      }
      const base = sanitizeDownloadBase(
        activeDraftDisplayTitle() ||
          store.titleFromText(exportHtml || dirtyHtml || dirtyText || ""),
      );
      const { blob, format } = await htmlToExportBlob(
        exportHtml,
        formatId || "docx",
      );
      downloadBlob(blob, `${base}.${format.ext}`);
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(String(err.message || err), "danger");
    } finally {
      converting = false;
      updateCommitBtn();
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
    tipTap?.commands.focus();
  }

  async function createBranchAuto() {
    const name = store.nextSequentialName("branch", branches);
    await store.createBranch(activeDraftId, name, { checkout: true });
    viewingOid = null;
    await refreshCommits();
    const wt = await store.readWorkingFiles(activeDraftId);
    loadSnapshotState(wt, { historical: false });
    await refreshDraftList();
    renamingGit = { kind: "branch", key: name };
    await refreshWorkingDirty();
  }

  function startGitRename(kind, key) {
    if (!key) return;
    if (kind === "commit" && key !== headOid) return;
    renamingGit = { kind, key };
    renderGitPane();
  }

  async function finishGitRename(value, { cancel = false } = {}) {
    const current = renamingGit;
    if (!current) return;
    renamingGit = null;
    const trimmed = String(value ?? "").trim();
    if (cancel || !trimmed) {
      renderGitPane();
      return;
    }
    try {
      if (current.kind === "commit") {
        if (current.key !== headOid) {
          renderGitPane();
          return;
        }
        const head = commits.find((c) => c.oid === current.key);
        const prevMsg = (head?.message || "").split("\n")[0];
        if (trimmed !== prevMsg) {
          const { oid, previousOid } = await store.amendCommitMessage(
            activeDraftId,
            trimmed
          );
          if (viewingOid === previousOid) viewingOid = oid;
          await refreshCommits();
        }
      } else if (current.kind === "branch") {
        if (trimmed !== current.key) {
          await store.renameBranch(activeDraftId, current.key, trimmed);
          await refreshCommits();
          await refreshDraftList();
        }
      }
    } catch (err) {
      setStatus(String(err.message || err), "danger");
      await refreshCommits();
      await refreshDraftList();
    }
    renderGitPane();
    await refreshWorkingDirty();
    refreshStatusLeft();
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
    updateCommitBtn();
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
    runGit(createBranchAuto);
  });

  gitPane.addEventListener("click", (e) => {
    if (e.target.closest(".git-row-title-input")) return;
    const actionEl = e.target.closest("[data-git]");
    if (!actionEl || !gitPane.contains(actionEl)) return;
    const action = actionEl.dataset.git;
    e.preventDefault();
    e.stopPropagation();
    if (action === "rename-input") return;
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

  gitPane.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".git-row-title-input")) return;
    if (e.target.closest(".git-row-actions")) return;
    const branchRow = e.target.closest("#git-branch-list .git-row[data-branch]");
    if (branchRow) {
      e.preventDefault();
      startGitRename("branch", branchRow.dataset.branch);
      return;
    }
    const commitRow = e.target.closest('#git-commit-list .git-row[data-git="view"]');
    if (commitRow && commitRow.dataset.oid === headOid) {
      e.preventDefault();
      startGitRename("commit", commitRow.dataset.oid);
    }
  });

  gitPane.addEventListener("keydown", (e) => {
    const input = e.target.closest(".git-row-title-input");
    if (!input) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finishGitRename(input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishGitRename(input.value, { cancel: true });
    }
  });

  gitPane.addEventListener("focusout", (e) => {
    const input = e.target.closest(".git-row-title-input");
    if (!input || !renamingGit) return;
    setTimeout(() => {
      // Ignore remounts: renderGitPane destroys the focused input and focusout would
      // clear renamingGit even though a new rename input was just focused.
      if (!renamingGit || !input.isConnected) return;
      if (document.activeElement !== input) {
        finishGitRename(input.value);
      }
    }, 0);
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

  function apiMessagesFromChat(messages) {
    return (messages || [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => {
        if (m.role === "assistant") {
          return { role: "assistant", content: m.content || "" };
        }
        const item = {
          role: "user",
          content: m.content || "",
          draft_text: m.draftText ?? "",
        };
        if (m.selection && typeof m.selection === "object") {
          item.selection = {
            from: Number(m.selection.from) || 0,
            to: Number(m.selection.to) || 0,
          };
        }
        return item;
      });
  }

  async function sendChat() {
    if (!canUseComposer()) return;
    const chat = activeChat();
    if (!chat) return;
    const text = (chatInput?.value || composerDraft || "").trim();
    if (!text) return;

    pullFromEditor();
    const draftText = tipTap ? getPlain(tipTap) : currentText || "";
    const selection = caretSelectionOffsets();
    const prior = Array.isArray(chat.messages) ? chat.messages.slice() : [];
    const userMsg = {
      role: "user",
      content: text,
      draftText,
      selection,
    };
    chat.messages = [...prior, userMsg];
    chat.lastBranch = currentBranchName || chat.lastBranch || "main";
    chat.updatedAt = Date.now();
    composerDraft = "";
    if (chatInput) {
      chatInput.value = "";
      resizeTextarea(chatInput);
    }
    renderChatThread({ stickBottom: true });
    syncChatComposer();

    chatBusy = true;
    syncChatComposer();
    setStatus("replying...");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: currentModel,
          messages: apiMessagesFromChat(prior),
          message: text,
          draft_text: draftText,
          selection,
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
      chat.messages = [
        ...(Array.isArray(chat.messages) ? chat.messages : prior),
        { role: "assistant", content: reply },
      ];
      chat.lastBranch = currentBranchName || chat.lastBranch || "main";
      chat.updatedAt = Date.now();
      draftCost += cost;
      updateMeta();
      setStatus("");
      renderChatThread({ stickBottom: true });
      await persistChatsNow();
    } catch (err) {
      chat.messages = prior;
      renderChatThread({ stickBottom: true });
      setStatus(String(err.message || err), "danger");
      await persistChatsNow();
    } finally {
      chatBusy = false;
      syncChatComposer();
    }
  }

  newChatBtn?.addEventListener("click", () => {
    void createChat();
  });

  chatBackBtn?.addEventListener("click", () => {
    showChatList();
  });

  chatListEl?.addEventListener("click", (e) => {
    const item = e.target.closest(".draft-item");
    if (!item || !chatListEl.contains(item)) return;
    const id = item.dataset.id;
    const actionEl = e.target.closest("[data-action]");
    const action = actionEl?.dataset.action;
    if (action === "delete") {
      e.preventDefault();
      e.stopPropagation();
      void deleteChat(id);
      return;
    }
    if (action === "rename-input") return;
    void openChat(id);
  });

  chatListEl?.addEventListener("contextmenu", (e) => {
    const item = e.target.closest(".draft-item");
    if (!item || !chatListEl.contains(item)) return;
    if (e.target.closest("[data-action='delete']")) return;
    if (e.target.closest(".draft-item-title-input")) return;
    e.preventDefault();
    renamingChatId = item.dataset.id;
    renderChatList();
  });

  chatListEl?.addEventListener("keydown", (e) => {
    const input = e.target.closest(".draft-item-title-input");
    if (!input || !chatListEl.contains(input)) return;
    const item = input.closest(".draft-item");
    const id = item?.dataset.id;
    if (!id) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void finishChatRename(id, input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      void finishChatRename(id, input.value, { cancel: true });
    }
  });

  chatListEl?.addEventListener("focusout", (e) => {
    const input = e.target.closest(".draft-item-title-input");
    if (!input || !chatListEl.contains(input)) return;
    const item = input.closest(".draft-item");
    const id = item?.dataset.id;
    if (!id || renamingChatId !== id) return;
    setTimeout(() => {
      if (renamingChatId === id) {
        void finishChatRename(id, input.value);
      }
    }, 0);
  });

  chatComposer.addEventListener("submit", (e) => {
    e.preventDefault();
    void sendChat();
  });

  chatInput.addEventListener("input", () => {
    composerDraft = chatInput.value || "";
    resizeTextarea(chatInput);
    syncChatComposer();
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendChat();
    }
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
