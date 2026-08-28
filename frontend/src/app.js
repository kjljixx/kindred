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
  resolveBlockStateConflicts,
  conflictMarkerCount,
  htmlHasAlignConflict,
  htmlHasTableConflict,
  htmlHasListConflict,
  unresolvedMergeConflictCount,
  joinConflictBoth,
  formatConflictMarkers,
  isFormatOnlyConflict,
  stripHtml,
  mergeCleanEditsIntoMarked,
  stripKindredProtocol,
  plainOffsetsToPmRange,
  plainOffsetForPmPos,
} from "./tiptapEditor.js";
import { bindLongPress } from "./longPress.js";
import { loadColoris, loadHtmlDiff } from "./optionalAssets.js";
import { warmPopularGoogleFonts } from "./fontCatalog.js";
import { alignTwoWay } from "./docAlign.js";
import { htmlToDoc, docToPlainText, htmlToPlainText, normalizeDoc, blockToHtml, isStructuralBlock, isTableBlock } from "./kindredSchema.js";
import { listDiffsFromAlignOps, resolveListConflictHtml, resolveAllListConflicts } from "./listAlign.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { CONFIG } from "./config.js";
import {
  wantsStyledDiffExport,
  hasDiffMarkers,
  serializeDiffEditorHtml,
} from "./diffExport.js";
import { debugEvent, debugVerbose, startTrace, summarizeEditor } from "./debug.js";
import {
  resolveAllTableConflicts,
  resolveTableConflictHtml,
} from "./tableDaff.js";

(() => {
  const DIFF_EQUAL = 0;
  const DIFF_INSERT = 1;
  const DIFF_DELETE = -1;
  const SAVE_DEBOUNCE_MS = 250;
  const UI_STATE_DEBOUNCE_MS = 300;
  let store = null;
  const storeReady = import("./gitStore.js").then(async ({ KindredGitStore }) => {
    store = KindredGitStore;
    await store.init();
    return store;
  });
  const EXPORT_FORMATS = [
    { id: "docx", label: "DOCX" },
    { id: "md", label: "Markdown" },
    { id: "html", label: "HTML" },
    { id: "txt", label: "Plain text" },
    { id: "pdf", label: "PDF" },
  ];
  let pandocModulePromise = null;
  const CHEVRON_SVG = `
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M 2.5 4.5 L 6 8 L 9.5 4.5"
      />
    </svg>
  `.trim();
  
  function loadPandocModule() {
    if (!pandocModulePromise) pandocModulePromise = import("./pandocConvert.js");
    return pandocModulePromise;
  }

  function warmPandocAfterStartup() {
    const warm = () => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => {
          void loadPandocModule().then(({ preloadPandoc }) => preloadPandoc());
        });
      } else {
        void loadPandocModule().then(({ preloadPandoc }) => preloadPandoc());
      }
    };
    window.setTimeout(warm, 3000);
  }

  function warmPopularFontsAfterIdle() {
    const warm = () => warmPopularGoogleFonts();
    if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 5000 });
    else window.setTimeout(warm, 1000);
  }

  const appRoot = document.getElementById("app");
  const editor = document.getElementById("editor");
  const toolbarEl = document.getElementById("editor-toolbar");
  const feedbackEl = document.getElementById("feedback");
  const chatListEl = document.getElementById("chat-list");
  const draftListEl = document.getElementById("draft-list");
  const draftsHeading = document.getElementById("drafts-heading");
  const chatBackBtn = document.getElementById("chat-back-btn");
  const chatHeading = document.getElementById("chat-heading");
  const newChatBtn = document.getElementById("new-chat-btn");
  const finishStackBtn = document.getElementById("finish-stack-btn");
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
  const workspaceActions = document.querySelectorAll("[data-workspace-action]");
  const compactLayout = window.matchMedia("(max-width: 770px)");
  const touchInput = window.matchMedia("(hover: none), (pointer: coarse)");

  const DEFAULT_MODEL = CONFIG.chat.model;
  const EPHEMERAL_STATUS_MESSAGES = new Set([
    "suggestion applied",
    "restored into working tree",
    "nothing to commit",
    "nothing to export",
    "the requested character range is invalid",
    "suggestion could not be safely located in the current draft",
  ]);
  // HtmlDiff treats "<...>" as tags; shield raw "<" in plain text.
  const HTMLDIFF_LT = "\uE000";
  const HTMLDIFF_ACTION = { equal: 0, delete: 1, insert: 2, none: 3, replace: 4 };
  let diffsCacheKey = null;
  let diffsCacheParts = null;

  /** History overlay baseline (previous commit plain); not analysis. */
  let baseline = "";
  let baselineHtml = "";
  let currentText = "";
  let currentHtml = "";
  /** Working-tree body for auto-title + counts (not history / review markup). */
  let dirtyHtml = "";
  let dirtyText = "";
  let paneMode = "chat";
  let activeWorkspace = "draft";
  let wasCompactLayout = compactLayout.matches;
  let openingDraftId = null;
  let chatRecords = [];
  let activeChatId = null;
  /** @type {"list"|"thread"} */
  let chatView = "list";
  let chatBusy = false;
  let composerDraft = "";
  let renamingChatId = null;
  let editingChatMessage = null;
  let rendering = false;
  let converting = false;
  let applyingHistory = false;
  let currentModel = DEFAULT_MODEL;
  let draftCost = 0;
  let statusMessage = "";
  let statusLevel = "";
  let statusClearTimer = null;
  let drafts = [];
  let activeDraftId = null;
  let saveTimer = null;
  let uiSaveTimer = null;
  /** @type {{ destroy: Function, getState: Function, applyState: Function } | null} */
  let toolbarController = null;
  let commits = [];
  let activeCommitIndex = -1;
  let viewingOid = null;
  let headOid = null;
  let headPlain = "";
  let headHtml = "";
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
  let renamingStackIndex = null;

  let tipTap = null;
  let suppressEditorUpdate = false;

  function getChatStacks(chat) {
    if (!chat) return [];
    if (!chat.stacks) {
      chat.stacks = [
        {
          id: `stack-${Date.now()}`,
          title: "Stack 1",
          collapsed: false,
          messages: Array.isArray(chat.messages) ? chat.messages : [],
        },
      ];
    }
    return chat.stacks;
  }

  function getActiveStack(chat) {
    const stacks = getChatStacks(chat);
    if (!stacks.length) {
      const s = {
        id: `stack-${Date.now()}`,
        title: "Stack 1",
        collapsed: false,
        messages: [],
      };
      stacks.push(s);
      return s;
    }
    return stacks[stacks.length - 1];
  }

  async function finishStackRename(stackIndex, value, { cancel = false } = {}) {
    if (renamingStackIndex !== stackIndex) return;
    renamingStackIndex = null;
    const chat = activeChat();
    if (chat) {
      const stacks = getChatStacks(chat);
      if (stacks && stacks[stackIndex] && !cancel) {
        const trimmed = String(value ?? "").trim();
        stacks[stackIndex].title = trimmed || `Stack ${stackIndex + 1}`;
        chat.updatedAt = Date.now();
        await persistChatsNow();
      }
    }
    renderChatThread();
  }

  function syncOverlayFromState() {
    if (!tipTap) return;
    debugEvent("app", "syncOverlay:start", {
      dirtyViewMode,
      dirtyReviewing,
      viewingHistory: isViewingHistory(),
      currentText,
      currentHtml,
    });
    const unresolved = unresolvedMergeConflictCount(currentHtml);
    const inConflictMode =
      dirtyReviewing || (!!pendingMerge && unresolved > 0);
    const marked = inConflictMode && unresolved > 0 ? currentHtml : "";
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
          showConflictChrome: inConflictMode,
          formatHunks: [],
          imageDiffs: null,
        });
        if (store) void store.hydrateImageElements(activeDraftId, editor, viewingOid);
      } else if (dirtyViewMode === "Diff") {
        // Dirty: vs HEAD. History: vs previous commit (baseline set by loadSnapshotState).
        const basePlain = viewing ? baseline : headPlain;
        const baseHtml = viewing ? baselineHtml : headHtml;
        const baseDoc = htmlToDoc(baseHtml || "<p></p>");
        const currentDoc = normalizeDoc(tipTap.getJSON());
        const ops = alignTwoWay(baseDoc, currentDoc);
        const parts = diffs(basePlain, currentText, baseDoc, currentDoc);
        const formatHunks = store.formatHunksFromDiff(
          baseHtml,
          currentHtml,
          parts
        );
        debugEvent("diff", "overlay-input", {
          viewing,
          basePlain,
          currentText,
          opCount: ops.length,
          parts,
          formatHunks,
          imageDiffs: imageDiffsFromOps(ops),
          tableDiffs: tableDiffsFromOps(ops),
          listDiffs: listDiffsFromOps(ops),
        });
        refreshOverlay(tipTap, {
          baseline: basePlain,
          currentPlain: currentText,
          highlight: null,
          markedHtml: "",
          conflictMode,
          showConflictChrome: inConflictMode,
          formatHunks,
          imageDiffs: imageDiffsFromOps(ops),
          tableDiffs: tableDiffsFromOps(ops),
          listDiffs: listDiffsFromOps(ops),
        });
        if (store) void store.hydrateImageElements(activeDraftId, editor, viewingOid);
      } else {
        refreshOverlay(tipTap, {
          baseline: "",
          currentPlain: currentText,
          highlight: null,
          showDiffs: false,
          markedHtml: "",
          conflictMode,
          showConflictChrome: inConflictMode,
          formatHunks: [],
          imageDiffs: null,
          tableDiffs: null,
          listDiffs: null,
        });
      }
    } finally {
      suppressEditorUpdate = wasSuppressed;
      debugEvent("app", "syncOverlay:end", { suppressEditorUpdate });
    }
  }

  function imageInfo(node) {
    if (node?.type !== "image" || !node.attrs?.src) return null;
    return {
      src: node.attrs.src,
      alt: node.attrs.alt || "",
      title: node.attrs.title || "",
    };
  }

  function sameImage(a, b) {
    return a?.src === b?.src && a?.alt === b?.alt && a?.title === b?.title;
  }

  function imageDiffsFromOps(ops) {
    const added = [];
    const deleted = [];
    for (const op of ops) {
      const base = imageInfo(op.base);
      const current = imageInfo(op.theirs || op.node);
      if (op.type === "insert" && op.side === "theirs" && current) {
        added.push(current);
      } else if (op.type === "delete" && op.side === "theirs" && base) {
        deleted.push(base);
      } else if (op.type === "replace" && !sameImage(base, current)) {
        if (base) deleted.push(base);
        if (current) added.push(current);
      }
    }
    return added.length || deleted.length ? { added, deleted } : null;
  }

  function tableDiffsFromOps(ops) {
    const added = [];
    const deleted = [];
    const replacements = [];
  
    for (const op of ops) {
      if (op.type === "insert" && op.side === "theirs" && isTableBlock(op.theirs || op.node)) {
        added.push(blockToHtml(op.theirs || op.node));
      } else if (op.type === "delete" && op.side === "theirs" && isTableBlock(op.base || op.ours)) {
        deleted.push(blockToHtml(op.base || op.ours));
      } else if (op.type === "replace" && (isTableBlock(op.base) || isTableBlock(op.theirs))) {
        const oldHtml = isTableBlock(op.base) ? blockToHtml(op.base) : "";
        const newHtml = isTableBlock(op.theirs) ? blockToHtml(op.theirs) : "";
        if (oldHtml && newHtml) {
          replacements.push({ oldHtml, newHtml });
          added.push(newHtml);
        } else if (oldHtml) {
          deleted.push(oldHtml);
        } else if (newHtml) {
          added.push(newHtml);
        }
      }
    }
  
    return added.length || deleted.length || replacements.length
      ? { added, deleted, replacements }
      : null;
  }
  
  function listDiffsFromOps(ops) {
    return listDiffsFromAlignOps(ops);
  }

  async function htmlAtCommitOid(oid) {
    if (!oid || !activeDraftId || !store) return "";
    const snap = await store.readAtCommit(activeDraftId, oid);
    return snap.html || snap.text || "";
  }

  async function refreshHeadPlain() {
    if (!headOid) {
      headPlain = "";
      headHtml = "";
      return;
    }
    headHtml = await htmlAtCommitOid(headOid);
    headPlain = store.htmlToPlain(headHtml);
  }

  /** Snapshot of the commit before `index` (oldest→newest), or empty if none. */
  async function previousCommitSnap(index) {
    if (index <= 0 || !commits.length) return { plain: "", html: "" };
    const html = await htmlAtCommitOid(commits[index - 1].oid);
    return { html, plain: store.htmlToPlain(html) };
  }

  function pullFromEditor() {
    if (!tipTap) return;
    if (suppressEditorUpdate) {
      debugEvent("app", "pullFromEditor:skipped", { reason: "suppressEditorUpdate" });
      return;
    }
    const before = { currentHtml, currentText };
    if (conflictMarkerCount(currentHtml) > 0) {
      const tipHtml = getHtml(tipTap);
      const merged = mergeCleanEditsIntoMarked(currentHtml, tipHtml);
      if (merged != null) currentHtml = merged;
      currentText = getPlain(tipTap);
      debugEvent("app", "pullFromEditor", {
        mode: "conflict-marked",
        before,
        after: { currentHtml, currentText },
        editor: summarizeEditor(tipTap),
      });
      return;
    }
    currentHtml = getHtml(tipTap);
    currentText = getPlain(tipTap);
    debugEvent("app", "pullFromEditor", {
      mode: "clean",
      before,
      after: { currentHtml, currentText },
      editor: summarizeEditor(tipTap),
    });
  }

  tipTap = createKindredEditor({
    element: editor,
    content: "",
    diffsFn: (a, b) => diffs(a, b),
    onConflictAction: (action, index) => handleConflictAction(action, index),
    onAlignConflictAction: (action, paraPos) => handleAlignConflictAction(action, paraPos),
    onTableConflictAction: (action, tablePos, conflictId) =>
      handleTableConflictAction(action, tablePos, conflictId),
    onListConflictAction: (action, listPos, conflictId) =>
      handleListConflictAction(action, listPos, conflictId),
    onUpdate: () => {
      if (
        suppressEditorUpdate ||
        rendering ||
        converting ||
        applyingHistory ||
        gitBusy ||
        isViewingHistory()
      ) {
        debugEvent("app", "editorUpdate:skipped", {
          suppressEditorUpdate,
          rendering,
          converting,
          applyingHistory,
          gitBusy,
          viewingHistory: isViewingHistory(),
        });
        return;
      }
      debugEvent("app", "editorUpdate", { editor: summarizeEditor(tipTap) });
      pullFromEditor();
      if (store) void store.hydrateImageElements(activeDraftId, editor, viewingOid);
      syncDirtyBodyFromCurrent();
      if (pendingMerge || hasConflict || htmlHasAlignConflict(currentHtml) || htmlHasTableConflict(currentHtml) || htmlHasListConflict(currentHtml)) syncMergeStatus();
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
  tipTap.on("kindredImage", async ({ file }) => {
    try {
      if (!activeDraftId) await createDraft("");
      const src = await store.addImage(activeDraftId, file);
      tipTap.chain().focus().setImage({ src, alt: file.name }).run();
      await store.hydrateImageElements(activeDraftId, editor);
    } catch (err) {
      setStatus(String(err.message || err), "danger");
    }
  });
  tipTap.on("selectionUpdate", () => {
    refreshStatusLeft();
    persistUiStateSoon();
  });
  toolbarController = bindToolbar(tipTap, toolbarEl, {
    onStateChange: () => persistUiStateSoon(),
  });
  editor?.addEventListener("scroll", () => persistUiStateSoon(), { passive: true });
  resetEditorState({ text: "" });
  requestAnimationFrame(() => tipTap?.commands.focus());
  toolbarEl.querySelectorAll(".toolbar-color")?.forEach((el) => {
    el.addEventListener("pointerdown", () => {
      void loadColoris().catch((error) => console.warn("Color picker failed to load:", error));
    }, { once: true });
  });

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

  function focusEditorSoon() {
    if (!tipTap || !activeDraftId || isViewingHistory()) return;
    requestAnimationFrame(() => tipTap?.commands.focus());
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
  function htmlForExport(formatId = CONFIG.export.defaultFormat) {
    const html = currentHtml || "<p></p>";
    if (unresolvedMergeConflictCount(html) > 0) {
      return dirtyReviewing ? htmlTakingTheirs(html) : htmlTakingOurs(html);
    }
    const textHtml = dirtyHtml || html;
    const wantsStyled = wantsStyledDiffExport(CONFIG, dirtyViewMode, formatId);
    if (wantsStyled && tipTap) {
      const styledHtml = serializeDiffEditorHtml(tipTap);
      if (hasDiffMarkers(styledHtml)) return styledHtml;
    }
    return textHtml;
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
    const unresolved = unresolvedMergeConflictCount(currentHtml) > 0;
    const finishMerge = !!(pendingMerge && !unresolved);
    // Dirty review: Commit stays enabled; unresolved hunks auto-keep Dirty on commit.
    // Use hasExportableBody — conflict display anchors can make getPlain() empty.
    const blockCommitForConflicts = unresolved && !dirtyReviewing;
    commitBtn.hidden = !activeDraftId || paneMode !== "git";
    commitBtn.textContent = pendingMerge ? "Merge" : "Commit";
    commitBtn.disabled =
      converting ||
      gitBusy ||
      !hasExportableBody() ||
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
    if (paneMode === "git") {
      renderGitPane();
    }
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

  function getLayoutMode() {
    if (!compactLayout.matches) return "wide";
    return touchInput.matches ? "touch" : "narrowDesktop";
  }

  function syncWorkspaceNavigation() {
    if (getLayoutMode() === "wide") {
      delete appRoot.dataset.workspace;
      delete appRoot.dataset.homeWorkspace;
      return;
    }
    appRoot.dataset.homeWorkspace = String(!activeDraftId);
    appRoot.dataset.workspace = activeWorkspace;
    workspaceActions.forEach((tab) => {
      const workspace = tab.dataset.workspaceAction;
      const active = workspace === activeWorkspace;
      const home = !activeDraftId;
      tab.hidden = home && workspace === "history";
      if (workspace === "draft") tab.textContent = home ? "New" : "Draft";
      if (workspace === "chat") tab.textContent = home ? "Drafts" : "Chat";
      if (workspace === "history") tab.textContent = "Git";
      tab.setAttribute("aria-current", active ? "page" : "false");
      if (tab.getAttribute("role") === "tab") tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.classList.toggle("active", active);
    });
  }

  function setWorkspace(next) {
    if (next !== "draft" && next !== "chat" && next !== "history") return;
    activeWorkspace = next;
    if (!activeDraftId) clearEditorForHome();
    if (next === "chat") setPaneMode("chat");
    if (next === "history") setPaneMode("git");
    syncWorkspaceNavigation();
    persistUiStateSoon();
  }

  workspaceActions.forEach((tab) => {
    tab.addEventListener("click", () => setWorkspace(tab.dataset.workspaceAction));
  });

  compactLayout.addEventListener("change", (event) => {
    if (event.matches && !wasCompactLayout) activeWorkspace = "draft";
    wasCompactLayout = event.matches;
    syncWorkspaceNavigation();
  });
  touchInput.addEventListener("change", syncWorkspaceNavigation);

  syncWorkspaceNavigation();

  function setStatus(msg, level = "") {
    if (statusClearTimer !== null) {
      clearTimeout(statusClearTimer);
      statusClearTimer = null;
    }
    statusMessage = (msg || "").toLowerCase();
    statusLevel = statusMessage ? level : "";
    refreshStatusLeft();
    if (EPHEMERAL_STATUS_MESSAGES.has(statusMessage)) {
      statusClearTimer = setTimeout(() => {
        statusClearTimer = null;
        setStatus("");
      }, 5000);
    }
  }

  function countStats(html) {
    const plain = htmlToPlainText(html || "<p></p>");
    return countStatsText(plain);
  }

  function countStatsText(raw) {
    const trimmed = raw.trim();
    const chars = raw.replace(/[\r\n\t]/g, "").length;
    const words = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
    let sentences = 0;
    let paragraphs = 0;
    if (trimmed) {
      paragraphs = trimmed.split(/[\r\n\t]+/).filter((p) => p.trim()).length || 1;
      sentences = trimmed.split(/(?<=[.!?])\s+|[\r\n\t]+/).filter((s) => s.trim()).length;
    }
    return { words, chars, sentences, paragraphs };
  }

  function pluralize(n, singular) {
    return `${n} ${singular}${n === 1 ? "" : "s"}`;
  }

  function selectionStats() {
    if (!tipTap || tipTap.state.selection.empty) return null;
    const { from, to } = tipTap.state.selection;
    const raw = tipTap.state.doc.textBetween(from, to, "\n\n").replace(/\u00a0/g, " ");
    return countStatsText(raw);
  }

  function formatStat(selected, total, singular) {
    const prefix = selected == null ? "" : `${selected}/`;
    return `${prefix}${pluralize(total, singular)}`;
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
    let html = resolveBlockStateConflicts(sourceHtml || "<p></p>", side);
  
    // 1. Resolve inline text conflicts
    const segments = parseConflictSegments(html);
    if (segments) {
      const parts = [];
      for (const seg of segments) {
        if (seg.type === "text") parts.push(seg.text);
        else parts.push(takeTheirs ? seg.theirs : seg.ours);
      }
      html = parts.join("");
    }

    html = resolveAllTableConflicts(html, side);
    html = resolveAllListConflicts(html, side);
  
    // 2. DOM-based resolution for alignments, tables, and lists
    const doc = new DOMParser().parseFromString(
      `<div id="__kindred_root">${html}</div>`,
      "text/html"
    );
    const root = doc.getElementById("__kindred_root");
    if (!root) return html || "<p></p>";
  
    const alignAttr = takeTheirs ? "data-kindred-align-theirs" : "data-kindred-align-ours";
    const tableAttr = takeTheirs ? "data-kindred-table-theirs" : "data-kindred-table-ours";
    const listAttr  = takeTheirs ? "data-kindred-list-theirs"  : "data-kindred-list-ours";
  
    // Resolve paragraph alignments
    root.querySelectorAll("[data-kindred-align-ours]").forEach((el) => {
      const align = el.getAttribute(alignAttr) || "left";
      el.style.textAlign = align;
      el.removeAttribute("data-kindred-align-ours");
      el.removeAttribute("data-kindred-align-theirs");
      el.removeAttribute("data-kindred-align-label-ours");
      el.removeAttribute("data-kindred-align-label-theirs");
    });
  
    // Resolve table conflicts
    root.querySelectorAll("[data-kindred-table-ours]").forEach((el) => {
      const chosen = el.getAttribute(tableAttr);
      if (chosen && chosen.trim()) {
        const wrap = doc.createElement("div");
        wrap.innerHTML = chosen;
        const replacement = wrap.firstElementChild;
        if (replacement) {
          el.replaceWith(doc.importNode(replacement, true));
          return;
        }
      }
      // If the chosen side is empty (e.g. table deleted on this side), remove it
      el.remove();
    });
  
    // Resolve list conflicts
    root.querySelectorAll("[data-kindred-list-ours]").forEach((el) => {
      const chosen = el.getAttribute(listAttr);
      if (chosen && chosen.trim()) {
        const wrap = doc.createElement("div");
        wrap.innerHTML = chosen;
        const replacement = wrap.firstElementChild;
        if (replacement) {
          el.replaceWith(doc.importNode(replacement, true));
          return;
        }
      }
      // If the chosen side is empty (e.g. list deleted on this side), remove it
      el.remove();
    });
  
    return root.innerHTML || "<p></p>";
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
      dirtyText = store ? store.htmlToPlain(html) : stripHtml(html);
      return;
    }
    dirtyHtml = html;
    dirtyText = currentText || (store ? store.htmlToPlain(html) : stripHtml(html));
  }

  function refreshStatusLeft() {
    const { words, chars, sentences, paragraphs } = countStats(isViewingHistory() ? currentHtml : dirtyHtml);
    const selected = selectionStats();
    const counts = [
      formatStat(selected?.words, words, "word"),
      formatStat(selected?.chars, chars, "char"),
      formatStat(selected?.sentences, sentences, "sentence"),
      formatStat(selected?.paragraphs, paragraphs, "paragraph"),
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
            : "status-progress";
      statusParts.push(statusSpan(statusMessage, cls));
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
    if (activeDraftId) {
      let statusParts = [];
      if (currentBranchName) statusParts.push(currentBranchName);
      const oid = viewingOid || headOid;
      if (oid) statusParts.push(shortOid(oid));
      metaEl.textContent = `${statusParts.join(" · ")}\u2003|\u2003${currentModel} · ${formatCost(draftCost)} total`;
    }
    else {
      metaEl.textContent = "";
    }
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

  function uiStateSnapshot() {
    const { from, to } = tipTap?.state?.selection || { from: 0, to: 0 };
    return {
      toolbar: toolbarController?.getState?.() || {},
      view: {
        paneMode,
        activeWorkspace,
        dirtyViewMode,
        viewingOid,
        editorScrollTop: editor?.scrollTop || 0,
        selection: { from, to },
      },
    };
  }

  async function persistUiStateNow() {
    if (!activeDraftId || !store) return;
    try {
      await store.saveUiState(activeDraftId, uiStateSnapshot());
    } catch (err) {
      console.warn("failed to save ui state", err);
    }
  }

  function persistUiStateSoon() {
    if (!activeDraftId || !store) return;
    if (uiSaveTimer != null) clearTimeout(uiSaveTimer);
    uiSaveTimer = setTimeout(() => {
      uiSaveTimer = null;
      void persistUiStateNow();
    }, UI_STATE_DEBOUNCE_MS);
  }

  async function flushUiStateTimer() {
    if (uiSaveTimer != null) {
      clearTimeout(uiSaveTimer);
      uiSaveTimer = null;
      await persistUiStateNow();
    }
  }

  function restoreEditorChrome(view = {}) {
    requestAnimationFrame(() => {
      if (tipTap && view.selection && typeof view.selection.from === "number") {
        const size = tipTap.state.doc.content.size;
        const from = Math.min(Math.max(0, view.selection.from), size);
        const to = Math.min(Math.max(from, Number(view.selection.to) || from), size);
        tipTap.commands.setTextSelection({ from, to });
      }
      const scrollTop = Number(view.editorScrollTop);
      if (editor && Number.isFinite(scrollTop) && scrollTop >= 0) {
        editor.scrollTop = scrollTop;
      }
    });
  }

  async function applySavedUiState(ui, { hasConflict = false } = {}) {
    if (!ui) return;
    toolbarController?.applyState?.(ui.toolbar);

    if (compactLayout.matches) {
      const ws = ui.view?.activeWorkspace;
      if (ws === "draft" || ws === "chat" || ws === "history") {
        setWorkspace(ws);
      } else {
        setPaneMode(hasConflict ? "git" : ui.view?.paneMode === "git" ? "git" : "chat");
      }
    } else if (hasConflict || ui.view?.paneMode === "git") {
      setPaneMode("git");
    } else if (ui.view?.paneMode === "chat") {
      setPaneMode("chat");
    }

    if (!viewingOid && ui.view?.dirtyViewMode === "Diff") {
      await setDirtyEditView("Diff");
    }

    restoreEditorChrome(ui.view);
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
      await store.saveChats(activeDraftId, chatsState());
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
      chatRecords.forEach((c) => getChatStacks(c));
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
    editingChatMessage = null;
    draftCost = 0;
  }

  function activeChat() {
    if (!activeChatId) return null;
    return chatRecords.find((c) => c.id === activeChatId) || null;
  }

  async function focusOrStartChat() {
    if (!activeDraftId) return;
  
    if (paneMode !== "chat") {
      setPaneMode("chat");
    }
  
    if (chatView === "thread" && activeChatId) {
      if (!chatInput.disabled) {
        chatInput.focus();
      }
    } else {
      await createChat();
    }
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
    syncWorkspaceNavigation();
    commits = [];
    activeCommitIndex = -1;
    viewingOid = null;
    headOid = null;
    headPlain = "";
    headHtml = "";
    currentBranchName = "main";
    branches = ["main"];
    hasConflict = false;
    pendingMerge = null;
    dirtyViewMode = "Text";
    dirtyReviewing = false;
    workingDirty = !!(text || "").trim();
    paneMode = "chat";
    clearChatState();
    await refreshDraftList();
    await persistUiStateNow();
    return draft;
  }

  async function ensureDraftForText(text) {
    if (activeDraftId) {
      persistActiveDraftSoon();
      return findDraft(activeDraftId);
    }
    if (!(text || "").length) return null;
    await storeReady;
    const draft = await createDraft(text);
    syncRightPane({ stickChatBottom: true });
    updateCommitBtn();
    return draft;
  }

  async function refreshCommits() {
    if (!activeDraftId) {
      commits = [];
      activeCommitIndex = -1;
      headOid = null;
      headPlain = "";
      headHtml = "";
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

  function showChatPane({ stickBottom = false } = {}) {
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
      renderChatThread({ stickBottom });
      syncChatComposer();
    }
    updateCommitBtn();
  }

  function syncRightPane({ stickChatBottom = false } = {}) {
    if (!activeDraftId) showHomePane();
    else if (paneMode === "git") showGitPane();
    else showChatPane({ stickBottom: stickChatBottom });
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

  function startDraftListRename(item) {
    if (!item) return false;
    renamingDraftId = item.dataset.id;
    renameSource = "list";
    if (draftHeaderTitleInput) draftHeaderTitleInput.hidden = true;
    syncHeaderTitle();
    renderDraftList();
    return true;
  }

  function applyRevisionToEditor() {
    debugEvent("app", "applyRevisionToEditor:start", { currentHtml });
    suppressEditorUpdate = true;
    rendering = true;
    try {
      const hasMarkers = conflictMarkerCount(currentHtml) > 0;
      const unresolved =
        hasMarkers || htmlHasAlignConflict(currentHtml) || htmlHasTableConflict(currentHtml) || htmlHasListConflict(currentHtml);
      // Drop stale conflict widgets before setContent so index-0 is not rebound to old sides.
      if (tipTap) {
        refreshOverlay(tipTap, {
          baseline: "",
          currentPlain: "",
          highlight: null,
          markedHtml: "",
          imageDiffs: null,
        });
      }
      if (unresolved) {
        hasConflict = true;
        if (hasMarkers) {
          setHtml(tipTap, conflictDisplayHtml(currentHtml), { emitUpdate: false, source: "applyRevisionToEditor:conflict" });
        } else {
          setHtml(tipTap, currentHtml || "<p></p>", { emitUpdate: false, source: "applyRevisionToEditor" });
        }
      } else {
        setHtml(tipTap, currentHtml || "<p></p>", { emitUpdate: false, source: "applyRevisionToEditor" });
      }
      currentText = getPlain(tipTap);
      void store.hydrateImageElements(activeDraftId, editor, viewingOid);
      syncOverlayFromState();
    } finally {
      rendering = false;
      suppressEditorUpdate = false;
      debugEvent("app", "applyRevisionToEditor:end", {
        currentHtml,
        currentText,
        editor: summarizeEditor(tipTap),
      });
    }
  }

  function loadSnapshotState(snap, { historical = false, historyBaseline = undefined, historyBaselineHtml = undefined } = {}) {
    // Past commits / tip-after-commit: diff against previous commit when provided.
    baseline = historyBaseline !== undefined ? historyBaseline : "";
    baselineHtml = historyBaselineHtml !== undefined ? historyBaselineHtml : "";
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

  function clearEditorForHome({ text = "" } = {}) {
    baseline = "";
    baselineHtml = "";
    currentHtml = text ? plainToHtml(text) : "<p></p>";
    currentText = "";
    currentModel = DEFAULT_MODEL;
    commits = [];
    activeCommitIndex = -1;
    viewingOid = null;
    headOid = null;
    headPlain = "";
    headHtml = "";
    currentBranchName = "main";
    branches = [];
    hasConflict = false;
    pendingMerge = null;
    dirtyViewMode = "Text";
    dirtyReviewing = false;
    workingDirty = false;
    renamingGit = null;
    suppressEditorUpdate = true;
    rendering = true;
    try {
      setHtml(tipTap, currentHtml, { emitUpdate: false, source: "clearEditorForHome" });
      currentText = getPlain(tipTap);
      syncOverlayFromState();
    } finally {
      rendering = false;
      suppressEditorUpdate = false;
    }
    syncDirtyBodyFromCurrent();
    setEditorEditable(true);
    toolbarController?.applyState?.({ formatLock: false, lockedMarks: null });
    if (editor) editor.scrollTop = 0;
    if (tipTap) {
      const pos = Math.min(1, tipTap.state.doc.content.size);
      tipTap.commands.setTextSelection({ from: pos, to: pos });
    }
    updateMeta();
    setStatus("");
    refreshStatusLeft();
    updateCommitBtn();
  }

  function resetEditorState({ text = "", keepHistory = false } = {}) {
    clearEditorForHome({ text });
    clearChatState();
    draftCost = 0;
    if (!keepHistory) clearHistory();
    syncRightPane();
  }

  async function enterDraftsHome() {
    await flushSaveTimer();
    await flushUiStateTimer();
    activeDraftId = null;
    paneMode = "chat";
    activeWorkspace = "draft";
    resetEditorState({ text: "" });
    syncWorkspaceNavigation();
    syncHeaderTitle();
    tipTap?.commands.focus();
  }

  async function openDraft(id) {
    if (openingDraftId) return;
    openingDraftId = id;
    activeWorkspace = "draft";
    syncWorkspaceNavigation();
    try {
      await flushSaveTimer();
      await flushUiStateTimer();
      const draft = findDraft(id) || (await store.readWorkingFiles(id));
      if (!draft) return;
      const ui = await store.readUiState(id);
      activeDraftId = id;
      viewingOid = null;
      renamingGit = null;
      paneMode = "chat";
      const wt = await store.readWorkingFiles(id);
      hasConflict = !!wt.hasConflict;
      pendingMerge = wt.pendingMerge || null;
      if (compactLayout.matches && hasConflict) activeWorkspace = "history";
      syncWorkspaceNavigation();
      await refreshCommits();
      await loadChatsForDraft(id);

      const savedOid = ui.view?.viewingOid;
      const restoreCommit = savedOid && commits.some((c) => c.oid === savedOid);
      if (restoreCommit) {
        await viewCommitOid(savedOid);
      } else {
        loadSnapshotState(wt, { historical: false });
        if (commits.length) activeCommitIndex = commits.length - 1;
      }

      await applySavedUiState(ui, { hasConflict });
      await refreshDraftList();
      if (paneMode === "git") renderGitPane();
      await refreshWorkingDirty();
    } finally {
      openingDraftId = null;
    }
  }

  async function deleteDraft(id) {
    const summary = findDraft(id);
    if (summary && summary.commitCount > 0) {
      const ok = window.confirm("Delete this draft and its commit history?");
      if (!ok) return;
    }
    await flushSaveTimer();
    await flushUiStateTimer();
    await store.deleteDraft(id);
    if (activeDraftId === id) {
      activeDraftId = null;
      activeWorkspace = "draft";
      resetEditorState({ text: "" });
      syncWorkspaceNavigation();
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
    if (id === activeDraftId) focusEditorSoon();
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
    startDraftListRename(item);
  });
  bindLongPress(draftListEl, (e) => {
    const item = e.target.closest(".draft-item");
    if (!item || e.target.closest("[data-action='delete']") || e.target.closest(".draft-item-title-input")) return false;
    return startDraftListRename(item);
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
    void enterDraftsHome();
  });

  function syncMergeStatus() {
    const unresolved = unresolvedMergeConflictCount(currentHtml) > 0;
    hasConflict = unresolved;
    if (dirtyReviewing) {
      // Review hunks (dirty or clean pending-merge review) must not claim a live
      // merge conflict in the status bar.
      if (!unresolved && !pendingMerge) {
        dirtyReviewing = false;
        if (paneMode === "git") renderGitPane();
      }
      if (pendingMerge) {
        setStatus("merge ready; commit to finish merge");
      }
      return;
    }
    if (unresolved) {
      setStatus("merge conflict; choose a resolution for each change", "warn");
    } else if (pendingMerge) {
      setStatus("merge ready; commit to finish merge");
    } else if (
      statusLevel === "warn" &&
      /merge conflict|conflicts resolved|merge ready/i.test(statusMessage)
    ) {
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
    debugEvent("review", "postTakeAllTheirs", { currentHtml });
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
    if (mode === "Diff") await loadHtmlDiff();
    // Leaving Review must win over the pending-merge lock: review hunks look like
    // unresolved conflicts but are not a live merge conflict.
    if (dirtyReviewing) {
      await leaveDirtyReview();
      dirtyViewMode = mode;
      syncMergeStatus();
      renderGitPane();
      syncOverlayFromState();
      focusEditorSoon();
      persistUiStateSoon();
      return;
    }
    if (pendingMerge && unresolvedMergeConflictCount(currentHtml) > 0) return;
    if (
      !pendingMerge &&
      unresolvedMergeConflictCount(currentHtml) > 0
    ) {
      takeAllTheirsConflicts();
      hasConflict = false;
      workingDirty = true;
      applyRevisionToEditor();
      syncDirtyBodyFromCurrent();
      persistActiveDraftSoon();
    }
    dirtyViewMode = mode;
    renderGitPane();
    syncOverlayFromState();
    focusEditorSoon();
    persistUiStateSoon();
  }

  async function enterDirtyReview() {
    startTrace("review", "enter", { activeDraftId, currentBranchName });
    if (!activeDraftId || !store) {
      debugEvent("review", "skipped", { reason: "missing-draft-or-store" });
      return;
    }
    if (isViewingHistory()) return;
    if (pendingMerge && unresolvedMergeConflictCount(currentHtml) > 0) return;
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
    const headBody = head.html || head.text || "";
    debugEvent("review", "calculate", {
      headBody,
      currentHtml,
      label: currentBranchName || "HEAD",
    });
    const result = store.reviewWorkingTree(
      headBody,
      currentHtml,
      currentBranchName || "HEAD"
    );
    debugEvent("review", "result", {
      cleanMerge: result.cleanMerge,
      mergedText: result.mergedText,
      opCount: result.ops?.length || 0,
      ops: result.ops || [],
    });
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
    focusEditorSoon();
  }

  function replaceConflictAt(index, replacement, blockSide = "") {
    if (blockSide) {
      currentHtml = resolveBlockStateConflicts(currentHtml, blockSide, index);
    } else {
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
              seg.theirs,
              seg.oursState,
              seg.theirsState
            )
          );
        }
        conflictI++;
      }
      currentHtml = parts.join("");
    }
    workingDirty = true;
    applyRevisionToEditor();
    syncDirtyBodyFromCurrent();
    syncMergeStatus();
    refreshStatusLeft();
    syncHeaderTitle();
    updateCommitBtn();
    persistActiveDraftSoon();
    focusEditorSoon();
  }

  function handleConflictAction(action, index) {
    const segments = parseConflictSegments(currentHtml);
    if (!segments) return;
    const conflicts = segments.filter((s) => s.type === "conflict");
    const seg = conflicts[index];
    if (!seg) return;
    if (action === "ours") {
      if (seg.oursState === "deleted" || seg.theirsState === "deleted") {
        replaceConflictAt(index, "", "ours");
        return;
      }
      replaceConflictAt(index, seg.ours);
      return;
    }
    if (action === "theirs") {
      if (seg.oursState === "deleted" || seg.theirsState === "deleted") {
        replaceConflictAt(index, "", "theirs");
        return;
      }
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
    focusEditorSoon();
  }

  function handleTableConflictAction(action, tablePos, conflictId = null) {
    if (!tipTap || tablePos == null) return;
    const node = tipTap.state.doc.nodeAt(tablePos);
    if (!node || node.type.name !== "table") return;
    const chosenHtml =
      conflictId && node.attrs.tableConflicts
        ? resolveTableConflictHtml(blockToHtml(node), conflictId, action)
        : action === "theirs"
          ? node.attrs.tableTheirs
          : node.attrs.tableOurs;
  
    suppressEditorUpdate = true;
    try {
      let tr;
      if (chosenHtml && chosenHtml.trim()) {
        const chosenDoc = htmlToDoc(chosenHtml);
        const chosenTableNode = chosenDoc.content?.[0];
        if (chosenTableNode) {
          tr = tipTap.state.tr.replaceWith(
            tablePos,
            tablePos + node.nodeSize,
            tipTap.schema.nodeFromJSON(chosenTableNode)
          );
        }
      } else {
        // Table was deleted on chosen side: delete the node from the doc
        tr = tipTap.state.tr.delete(tablePos, tablePos + node.nodeSize);
      }
      if (tr) tipTap.view.dispatch(tr);
    } finally {
      suppressEditorUpdate = false;
    }
  
    pullFromEditor();
    workingDirty = true;
    syncDirtyBodyFromCurrent();
    syncOverlayFromState();
    syncMergeStatus();
    refreshStatusLeft();
    syncHeaderTitle();
    updateCommitBtn();
    persistActiveDraftSoon();
    focusEditorSoon();
  }

  function listBlockIndexAtPos(doc, listPos) {
    let idx = 0;
    let found = -1;
    doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.type.name !== "bulletList" && node.type.name !== "orderedList") return;
      if (pos === listPos) found = idx;
      idx++;
    });
    return found;
  }

  function patchNthTopLevelList(html, index, listHtml) {
    const raw = String(html || "");
    const doc = new DOMParser().parseFromString(
      `<div id="__kindred_root">${raw}</div>`,
      "text/html"
    );
    const root = doc.getElementById("__kindred_root");
    if (!root) return raw;
    const lists = [...root.children].filter(
      (el) => el.tagName === "UL" || el.tagName === "OL"
    );
    if (index < 0 || index >= lists.length) return raw;
    if (!String(listHtml || "").trim()) {
      lists[index].remove();
      return root.innerHTML;
    }
    const parsed = new DOMParser().parseFromString(listHtml, "text/html");
    const newList = parsed.querySelector("ul, ol");
    if (!newList) return raw;
    lists[index].replaceWith(doc.importNode(newList, true));
    return root.innerHTML;
  }

  function handleListConflictAction(action, listPos, conflictId = null) {
    if (!tipTap || listPos == null) return;
    const node = tipTap.state.doc.nodeAt(listPos);
    if (!node || (node.type.name !== "bulletList" && node.type.name !== "orderedList")) return;
    const listIndex = listBlockIndexAtPos(tipTap.state.doc, listPos);
    const chosenHtml =
      conflictId && node.attrs.listConflicts
        ? resolveListConflictHtml(blockToHtml(node), conflictId, action)
        : action === "theirs"
          ? node.attrs.listTheirs
          : node.attrs.listOurs;

    suppressEditorUpdate = true;
    try {
      let tr;
      if (chosenHtml && chosenHtml.trim()) {
        const chosenDoc = htmlToDoc(chosenHtml);
        const chosenListNode = chosenDoc.content?.[0];
        if (chosenListNode) {
          tr = tipTap.state.tr.replaceWith(
            listPos,
            listPos + node.nodeSize,
            tipTap.schema.nodeFromJSON(chosenListNode)
          );
        }
      } else {
        tr = tipTap.state.tr.delete(listPos, listPos + node.nodeSize);
      }
      if (tr) tipTap.view.dispatch(tr);
    } finally {
      suppressEditorUpdate = false;
    }

    if (conflictMarkerCount(currentHtml) > 0 && listIndex >= 0) {
      currentHtml = patchNthTopLevelList(currentHtml, listIndex, chosenHtml);
      currentText = getPlain(tipTap);
    } else {
      pullFromEditor();
    }
    workingDirty = true;
    hasConflict = unresolvedMergeConflictCount(currentHtml) > 0;
    syncDirtyBodyFromCurrent();
    syncOverlayFromState();
    syncMergeStatus();
    refreshStatusLeft();
    syncHeaderTitle();
    updateCommitBtn();
    persistActiveDraftSoon();
    focusEditorSoon();
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
        
        // eq was equal on both sides, so include it in both del (base) and ins (current)
        let del = L.del + eq + R.del;
        let ins = L.ins + eq + R.ins;
  
        run = [];
        if (del) run.push([DIFF_DELETE, del]);
        if (ins) run.push([DIFF_INSERT, ins]);
      }
  
      out.push(...flattenChangeRun(run));
    }
    return out;
  }

  function wordDiffParts(oldText, newText) {
    if (oldText === newText) {
      return newText ? [[DIFF_EQUAL, newText]] : [];
    }
    const hd = new HtmlDiff(protectLt(oldText), protectLt(newText));
    hd.splitInputsIntoWords();
    hd.matchGranularity = Math.min(4, hd.oldWords.length, hd.newWords.length);
    const ops = hd.operations();
    const parts = [];
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
    return coalesceShortEquals(parts);
  }

  /** Project AST ops → plain DIFF parts (shape from aligner; words inside replace). */
  function diffsFromAstOps(ops) {
    const parts = [];
    let firstCurrent = true;
    let firstBase = true;
  
    for (const op of ops) {
      if (op.type === "equal") {
        const text = docToPlainText(op.node);
        if (!text) continue; // Skip empty blocks so no phantom \n\n is added
  
        if (!firstCurrent) parts.push([DIFF_EQUAL, "\n\n"]);
        firstCurrent = false;
        firstBase = false;
        parts.push([DIFF_EQUAL, text]);
        continue;
      }
  
      if (op.type === "replace") {
        const oldT = docToPlainText(op.base || op.ours);
        const newT = docToPlainText(op.theirs);
        if (!oldT && !newT) continue;
  
        if (isStructuralBlock(op.ours || op.theirs || op.base)) {
          if (!firstCurrent && newT) parts.push([DIFF_EQUAL, "\n\n"]);
          if (newT) {
            firstCurrent = false;
            parts.push([DIFF_EQUAL, newT]);
          }
          firstBase = false;
          continue;
        }
  
        // If new text was emptied, treat it as a delete
        if (oldT && !newT) {
          if (!firstBase) parts.push([DIFF_DELETE, "\n\n"]);
          firstBase = false;
          parts.push([DIFF_DELETE, oldT]);
          continue;
        }
  
        if (!firstCurrent) parts.push([DIFF_EQUAL, "\n\n"]);
        firstCurrent = false;
        firstBase = false;
        const inner = wordDiffParts(oldT, newT);
        if (inner.length) parts.push(...inner);
        else if (newT) parts.push([DIFF_EQUAL, newT]);
        continue;
      }
  
      if (op.type === "insert") {
        const text = docToPlainText(op.theirs || op.node);
        if (!text) continue;
  
        if (!firstCurrent) parts.push([DIFF_INSERT, "\n\n"]);
        firstCurrent = false;
  
        if (isStructuralBlock(op.theirs || op.node)) {
          parts.push([DIFF_EQUAL, text]);
        } else {
          parts.push([DIFF_INSERT, text]);
        }
        continue;
      }
  
      if (op.type === "delete") {
        if (isStructuralBlock(op.base || op.ours)) {
          continue;
        }
        if (op.side === "theirs") {
          const text = docToPlainText(op.base || op.ours);
          if (!text) continue;
  
          if (!firstBase) parts.push([DIFF_DELETE, "\n\n"]);
          firstBase = false;
          parts.push([DIFF_DELETE, text]);
        } else if (op.side === "ours") {
          const text = docToPlainText(op.theirs || op.base);
          if (!text) continue;
  
          if (!firstCurrent) parts.push([DIFF_INSERT, "\n\n"]);
          firstCurrent = false;
          parts.push([DIFF_INSERT, text]);
        }
      }
    }
  
    return parts;
  }

  function diffs(baselineText, current, baseDoc, currentDoc) {
    const key = baselineText + "\0" + current;
    if (diffsCacheKey === key) {
      debugEvent("diff", "cache-hit", { baselineText, current, parts: diffsCacheParts });
      return diffsCacheParts;
    }

    debugEvent("diff", "start", {
      baselineText,
      current,
      hasBaseDoc: Boolean(baseDoc),
      hasCurrentDoc: Boolean(currentDoc),
    });
    let parts;
    if (baseDoc && currentDoc) {
      try {
        const ops = alignTwoWay(baseDoc, currentDoc);
        parts = diffsFromAstOps(ops);
        // Guard: if AST projection disagrees with plain equality, fall back.
        const projectedCurrent = parts
          .filter(([op]) => op !== DIFF_DELETE)
          .map(([, text]) => text)
          .join("")
          .replace(/\u00a0/g, " ");
        
        const exactCurrent = String(current || "")
          .replace(/\u00a0/g, " ");
        
        if (projectedCurrent !== exactCurrent) {
          debugEvent("diff", "ast-projection-mismatch", {
            projectedCurrent,
            current: exactCurrent,
            projectedLength: projectedCurrent.length,
            currentLength: exactCurrent.length,
            delta: exactCurrent.length - projectedCurrent.length,
          });
        
          parts = null;
        } else {
          debugEvent("diff", "strategy", { type: "ast", opCount: ops.length });
        }
      } catch (error) {
        debugEvent("diff", "ast-error", { message: String(error?.message || error) });
        parts = null;
      }
    }

    if (!parts) {
      setStatus("ast doc mismatch; check console", "danger");
    }

    debugEvent("diff", "result", { partCount: parts.length, parts });
    diffsCacheKey = key;
    diffsCacheParts = parts;
    return parts;
  }

  function caretSelectionOffsets() {
    if (!tipTap) return { from: 0, to: 0 };
    const { from, to } = tipTap.state.selection;
    const doc = tipTap.state.doc;
    const fromOff = plainOffsetForPmPos(doc, from);
    const toOff = plainOffsetForPmPos(doc, to);
    return { from: Math.min(fromOff, toOff), to: Math.max(fromOff, toOff) };
  }

  function canUseComposer() {
    if (!activeDraftId || chatView !== "thread" || !activeChatId) return false;
    if (chatBusy || converting || gitBusy || isViewingHistory()) return false;
    return true;
  }

  function resizeTextarea(el) {
    if (!el) return;
    if (!el.value) {
      el.style.height = "";
      return;
    }
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
    chatInput.disabled = false; //the input text box itself should always be enabled.
    chatSend.disabled = !enabled || !(chatInput.value || "").trim();
    if (finishStackBtn) {
      const active = activeChat();
      const currentStack = active ? getActiveStack(active) : null;
      finishStackBtn.disabled = !enabled || !currentStack?.messages?.length;
    }
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

    const containerTop = feedbackEl.getBoundingClientRect().top;
    feedbackEl.querySelectorAll(".chat-stack-header").forEach((header) => {
      const headerTop = header.getBoundingClientRect().top;
      header.classList.toggle("is-stuck", headerTop <= containerTop + 8);
    });
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

  async function finishCurrentStack() {
    const chat = activeChat();
    if (!chat || chatBusy) return;
    const active = getActiveStack(chat);
    if (!active.messages.length) return;
    active.collapsed = true;
    const nextNum = getChatStacks(chat).length + 1;
    chat.stacks.push({
      id: `stack-${Date.now()}`,
      title: `Stack ${nextNum}`,
      collapsed: false,
      messages: [],
    });
    chat.updatedAt = Date.now();
    renderChatThread({ stickBottom: true });
    syncChatComposer();
    await persistChatsNow();
  }

  function renderChatThread({ stickBottom = false } = {}) {
    const chat = activeChat();
    if (!chat) {
      feedbackEl.innerHTML = `<p class="muted">Select or create a chat.</p>`;
      return;
    }
    const stacks = getChatStacks(chat);
    const scrollTop = feedbackEl.scrollTop;
    const wasAtBottom = scrollAreaAtBottom(feedbackEl);
    const hasAnyMessages = stacks.some((s) => s.messages && s.messages.length > 0);
    if (!hasAnyMessages) {
      feedbackEl.innerHTML = `<p class="chat-thread-empty">Ask anything about the draft.</p>`;
    } else {
      feedbackEl.innerHTML =
        `<div class="chat-thread" role="log" aria-live="polite">` +
        stacks
          .map((stack, stackIdx) => {
            const msgs = stack.messages || [];

            const isRenaming = renamingStackIndex === stackIdx;
            const titleHtml = isRenaming
              ? `<input class="stack-title-input" data-stack-index="${stackIdx}" value="${escapeHtml(stack.title || `Stack ${stackIdx + 1}`)}" aria-label="Stack title" />`
              : `<span>${escapeHtml(stack.title || `Stack ${stackIdx + 1}`)}</span>`;
            
            const headerHtml =
              `<div class="chat-stack-header" data-chat-action="toggle-stack" data-stack-index="${stackIdx}">` +
              `<button type="button" class="btn btn-tertiary" data-chat-action="toggle-stack" data-stack-index="${stackIdx}">` +
              `${CHEVRON_SVG}${titleHtml}` +
              `</button>` +
              `</div>`;
            // const headerHtml =
            //   `<div class="chat-stack-header" data-chat-action="toggle-stack" data-stack-index="${stackIdx}">` +
            //   `<button type="button" class="btn btn-tertiary" data-chat-action="toggle-stack" data-stack-index="${stackIdx}">` +
            //   `${CHEVRON_SVG}<span>${escapeHtml(stack.title || `Current Stack`)}</span>` +
            //   `</button>` +
            //   `</div>`;
            if (stack.collapsed) {
              return `<div class="chat-stack is-collapsed">${headerHtml}</div>`;
            }
            const msgsHtml = msgs
              .map((m, index) => {
                const role = m.role === "assistant" ? "assistant" : "user";
                const label = role === "assistant" ? "Coach" : "You";
                const editing =
                  editingChatMessage?.stackIndex === stackIdx &&
                  editingChatMessage?.msgIndex === index &&
                  role === "user";
  
                let thinkingHtml = "";
                if (role === "assistant" && m.thinking) {
                  const isCollapsed = m.thinkingCollapsed !== false;
                  const btnHtml =
                    `<button type="button" class="btn btn-tertiary chat-thinking-btn" data-chat-action="toggle-thinking" data-stack-index="${stackIdx}" data-msg-index="${index}">` +
                    `${CHEVRON_SVG}<span>Thinking</span>` +
                    `</button>`;
                  if (isCollapsed) {
                    thinkingHtml = `<div class="chat-thinking is-collapsed">${btnHtml}</div>`;
                  } else {
                    thinkingHtml = `<div class="chat-thinking"><div class="chat-thinking-body">${renderMarkdown(m.thinking)}</div>${btnHtml}</div>`;
                  }
                }
  
                const body = editing
                  ? `<div class="chat-message-edit" data-chat-edit-stack="${stackIdx}" data-chat-edit-msg="${index}" contenteditable="true" role="textbox" aria-label="Edit message">${escapeHtml(m.content || "")}</div>`
                  : role === "assistant"
                    ? `${thinkingHtml}${renderCoachReply(m.content || "", stackIdx, index)}`
                    : escapeHtml(m.content || "");
                const actions = editing
                  ? `<div class="chat-msg-actions"><button type="button" class="btn btn-tertiary" data-chat-action="save-edit" data-stack-index="${stackIdx}" data-msg-index="${index}">Send</button><button type="button" class="btn btn-tertiary" data-chat-action="cancel-edit">Cancel</button></div>`
                  : role === "assistant"
                    ? `<div class="chat-msg-actions"><button type="button" class="btn btn-tertiary" data-chat-action="retry" data-stack-index="${stackIdx}" data-msg-index="${index}">Retry</button></div>`
                    : `<div class="chat-msg-actions"><button type="button" class="btn btn-tertiary" data-chat-action="edit" data-stack-index="${stackIdx}" data-msg-index="${index}">Edit</button></div>`;
                return (
                  `<div class="chat-msg ${role}" aria-label="${label}">` +
                  `<div class="chat-msg-body">${body}</div>${actions}` +
                  `</div>`
                );
              })
              .join("");
            return `<div class="chat-stack">${headerHtml}<div class="chat-stack-body">${msgsHtml}</div></div>`;
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
      const edit = feedbackEl.querySelector(".chat-message-edit");
      if (edit) {
        edit.focus();
        const range = document.createRange();
        range.selectNodeContents(edit);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (renamingStackIndex != null) {
        const input = feedbackEl.querySelector(`.stack-title-input[data-stack-index="${renamingStackIndex}"]`);
        if (input) {
          input.focus();
          input.select();
        }
      }
    });
  }

  function mergeConflictContext() {
    if (!currentHtml || unresolvedMergeConflictCount(currentHtml) === 0) return "";
    const segments = parseConflictSegments(currentHtml) || [];
    const textConflicts = segments
      .filter((segment) => segment.type === "conflict")
      .map((segment, index) =>
        `Conflict ${index + 1} (${segment.oursLabel || "current"} / ${segment.theirsLabel || "incoming"}):\n` +
        `Current: ${stripHtml(segment.ours)}\nIncoming: ${stripHtml(segment.theirs)}`
      );
    const doc = new DOMParser().parseFromString(currentHtml, "text/html");
    const alignmentConflicts = [...doc.querySelectorAll("[data-kindred-align-ours]")].map((el, index) =>
      `Alignment conflict ${index + 1}: ${el.textContent || "paragraph"} ` +
      `(${el.getAttribute("data-kindred-align-ours")} / ${el.getAttribute("data-kindred-align-theirs")})`
    );
    return [...textConflicts, ...alignmentConflicts].join("\n\n");
  }

  function draftRange(start, end) {
    if (!tipTap) return null;
    const range = plainOffsetsToPmRange(tipTap.state.doc, start, end);
    if (range.to < range.from) {
      setStatus("the requested character range is invalid", "warn");
      return null;
    }
    return range;
  }

  function mentionDraftRange(start, end) {
    const range = draftRange(start, end);
    if (!range) {
      return;
    }
    tipTap.commands.focus();
    tipTap.commands.setTextSelection(range);
  }

  function resolveTextAnchor(anchor) {
    if (!anchor || typeof anchor !== "object") return null;
    const original = typeof anchor.original === "string" ? anchor.original : null;
    const prefix = typeof anchor.prefix === "string" ? anchor.prefix : null;
    const suffix = typeof anchor.suffix === "string" ? anchor.suffix : null;
    if (!original || prefix == null || suffix == null) return null;
  
    const matchesContext = (start) =>
      currentText.slice(start, start + original.length) === original &&
      currentText.slice(Math.max(0, start - prefix.length), start) === prefix &&
      currentText.slice(start + original.length, start + original.length + suffix.length) === suffix;
  
    const declaredStart = Number(anchor.start);
    const hasDeclaredStart = Number.isInteger(declaredStart);
  
    if (hasDeclaredStart && matchesContext(declaredStart)) {
      return { start: declaredStart, end: declaredStart + original.length, original };
    }
  
    const matches = [];
    for (let start = currentText.indexOf(original); start !== -1; start = currentText.indexOf(original, start + 1)) {
      if (matchesContext(start)) matches.push(start);
    }
  
    if (matches.length === 1) {
      return { start: matches[0], end: matches[0] + original.length, original };
    }

    if (matches.length > 1 && hasDeclaredStart) {
      const closestStart = matches.reduce((best, curr) =>
        Math.abs(curr - declaredStart) < Math.abs(best - declaredStart) ? curr : best
      );

      return { start: closestStart, end: closestStart + original.length, original };
    } 

    const stripPunct = (s) => String(s || "")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    const cleanPrefix = stripPunct(prefix);
    const cleanSuffix = stripPunct(suffix);

    const matchesRelaxed = (start) => {
      if (currentText.slice(start, start + original.length) !== original) return false;
      const textBefore = stripPunct(currentText.slice(Math.max(0, start - prefix.length - 24), start));
      const textAfter = stripPunct(currentText.slice(start + original.length, start + original.length + suffix.length + 24));
      const prefixOk = !cleanPrefix || textBefore.endsWith(cleanPrefix) || cleanPrefix.endsWith(textBefore);
      const suffixOk = !cleanSuffix || textAfter.startsWith(cleanSuffix) || cleanSuffix.startsWith(textAfter);
      return prefixOk && suffixOk;
    };

    const fallbackMatches = [];
    for (let start = currentText.indexOf(original); start !== -1; start = currentText.indexOf(original, start + 1)) {
      if (matchesRelaxed(start)) fallbackMatches.push(start);
    }

    if (fallbackMatches.length === 1) {
      return { start: fallbackMatches[0], end: fallbackMatches[0] + original.length, original };
    }

    if (fallbackMatches.length > 1) {
      const closestStart = hasDeclaredStart
        ? fallbackMatches.reduce((best, curr) => Math.abs(curr - declaredStart) < Math.abs(best - declaredStart) ? curr : best)
        : fallbackMatches[0];
      return { start: closestStart, end: closestStart + original.length, original };
    }

    const rawMatches = [];
    for (let start = currentText.indexOf(original); start !== -1; start = currentText.indexOf(original, start + 1)) {
      rawMatches.push(start);
    }

    if (rawMatches.length === 1) {
      return { start: rawMatches[0], end: rawMatches[0] + original.length, original };
    }

    if (rawMatches.length > 1) {
      const closestStart = hasDeclaredStart
        ? rawMatches.reduce((best, curr) => Math.abs(curr - declaredStart) < Math.abs(best - declaredStart) ? curr : best)
        : rawMatches[0];
      return { start: closestStart, end: closestStart + original.length, original };
    }

    return null;
  }

  function applyChatSuggestion(start, end, replacement, expectedText) {
    if (currentText.slice(Number(start), Number(end)) !== expectedText) {
      setStatus("suggestion could not be safely located in the current draft", "warn");
      return false;
    }
    const range = draftRange(start, end);
    if (!range) {
      return false;
    }
    tipTap.commands.focus();
    tipTap.view.dispatch(tipTap.state.tr.insertText(replacement, range.from, range.to));
    pullFromEditor();
    const sel = plainOffsetsToPmRange(tipTap.state.doc, start, Number(start) + replacement.length);
    tipTap.commands.setTextSelection(sel);
    workingDirty = true;
    persistActiveDraftSoon();
    setStatus("suggestion applied");
    return true;
  }

  function showSuggestionPreview(start, end, replacement = null) {
    if (!tipTap) return;
    refreshOverlay(tipTap, {
      baseline: currentText,
      currentPlain: currentText,
      highlight: { start: Number(start), end: Number(end), replacement },
      showDiffs: false,
    });
  }

  function clearSuggestionPreview() {
    syncOverlayFromState();
  }

  function markSuggestionReplaced(stackIndex, msgIndex, start, end, current, replacement, token = "") {
    const message = activeChat()?.stacks?.[stackIndex]?.messages?.[msgIndex];
    if (!message || message.role !== "assistant") return;
    const source = token || "[[suggest:" + start + ":" + end + "=>" + replacement + "]]";
    message.content = message.content.replace(
      source,
      "[[replaced:" + current + "=>" + replacement + "]]"
    );
    renderChatThread();
    void persistChatsNow();
  }

  function parseTextAnchor(payload) {
    try {
      const anchor = JSON.parse(payload);
      return anchor && typeof anchor === "object" ? anchor : null;
    } catch {
      return null;
    }
  }

  function renderVerifiedTextAnchor(anchor, action, stackIndex, msgIndex, token) {
    const location = resolveTextAnchor(anchor);
    if (!location) {
      if (action === "suggest") {
        return '<span class="chat-suggestion chat-suggestion-replaced">' +
          '<span class="suggestion-static suggestion-current">' + escapeHtml(anchor.original || "") + '</span>' +
          '<span class="suggestion-static suggestion-replacement">' + escapeHtml(anchor.replacement || "") + '</span>' +
          '</span>';
      }
      return '<span class="chat-mention suggestion-static">' + escapeHtml(anchor.original || "") + '</span>';
    }
    const attributes =
      'data-start="' + location.start + '" data-end="' + location.end +
      '" data-anchor="' + encodeURIComponent(JSON.stringify(anchor)) +
      '" data-suggestion-token="' + encodeURIComponent(token) + '"';
    if (action === "mention") {
      return '<span class="chat-mention"><button type="button" class="btn btn-tertiary" ' +
        'data-chat-action="mention" data-preview="current" ' + attributes + '>' +
        escapeHtml(location.original) + '</button></span>';
    }
    return '<span class="chat-suggestion">' +
      '<button type="button" class="btn btn-tertiary suggestion-current" ' +
      'data-chat-action="current" data-preview="current" ' + attributes + '>' +
      escapeHtml(location.original) + '</button>' +
      '<button type="button" class="btn btn-tertiary" data-chat-action="suggest" ' +
      'data-preview="replacement" data-stack-index="' + stackIndex + '" data-msg-index="' + msgIndex + '" ' +
      'data-replacement="' + escapeHtml(anchor.replacement) + '" ' + attributes + '>' +
      escapeHtml(anchor.replacement) + '</button></span>';
  }

  function renderCoachReply(content, stackIndex, msgIndex) {
    const anchored = String(content || "")
      .replace(/\[{1,2}mention:(\{[\s\S]*?\})\]{1,2}/g, (token, payload) => {
        const anchor = parseTextAnchor(payload);
        return anchor ? renderVerifiedTextAnchor(anchor, "mention", stackIndex, msgIndex, token) : token;
      })
      .replace(/\[{1,2}suggest:(\{[\s\S]*?\})\]{1,2}/g, (token, payload) => {
        const anchor = parseTextAnchor(payload);
        return anchor && typeof anchor.replacement === "string"
          ? renderVerifiedTextAnchor(anchor, "suggest", stackIndex, msgIndex, token)
          : token;
      });
    return renderMarkdown(anchored).replace(/\[{1,2}mention:(\d+):(\d+)\]{1,2}/g, (_, start, end) =>
      `<span class="chat-mention">` +
      `<button type="button" class="btn btn-tertiary" data-chat-action="mention" data-preview="current" data-start="${start}" data-end="${end}">${escapeHtml(currentText.slice(Number(start), Number(end)))}</button>` +
      `</span>`
    ).replace(/\[{1,2}suggest:(\d+):(\d+)=(?:>|&gt;)([\s\S]*?)\]{1,2}/g, (_, start, end, replacement) =>
      `<span class="chat-suggestion">` +
      `<button type="button" class="btn btn-tertiary suggestion-current" data-chat-action="current" data-preview="current" data-start="${start}" data-end="${end}">${escapeHtml(currentText.slice(Number(start), Number(end)))}</button>` +
      `<button type="button" class="btn btn-tertiary" data-chat-action="suggest" data-preview="replacement" data-stack-index="${stackIndex}" data-msg-index="${msgIndex}" data-start="${start}" data-end="${end}" data-replacement="${escapeHtml(replacement)}">${escapeHtml(replacement)}</button>` +
      `</span>`
    ).replace(/\[{1,2}replaced:(?!\d+:\d+:)([^\]]*?)=(?:>|&gt;)([\s\S]*?)\]{1,2}/g, (_, current, replacement) =>
      '<span class="chat-suggestion chat-suggestion-replaced">' +
      '<span class="suggestion-static suggestion-current">' + escapeHtml(current) + '</span>' +
      '<span class="suggestion-static suggestion-replacement">' + escapeHtml(replacement) + '</span>' +
      '</span>'
    ).replace(/\[{1,2}replaced:(\d+):(\d+):([\s\S]*?)=(?:>|&gt;)([\s\S]*?)\]{1,2}/g, (_, _start, _end, current, replacement) =>
      `<span class="chat-suggestion chat-suggestion-replaced">` +
      `<span class="suggestion-static suggestion-current">${escapeHtml(current)}</span>` +
      `<span class="suggestion-static suggestion-replacement">${escapeHtml(replacement)}</span>` +
      `</span>`
    );
  }

  function chatTitleFromMessage(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return store.DEFAULT_CHAT_TITLE || "New Chat";
    return clean.length > 56 ? `${clean.slice(0, 56).trimEnd()}...` : clean;
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
      stacks: [
        {
          id: `stack-${now}`,
          title: "Stack 1",
          collapsed: false,
          messages: [],
        },
      ],
    };
    chatRecords = [chat, ...chatRecords];
    activeChatId = id;
    chatView = "thread";
    composerDraft = "";
    await persistChatsNow();
    syncRightPane({ stickChatBottom: true });
    if (!chatInput.disabled) chatInput.focus();
  }

  async function openChat(id) {
    const chat = chatRecords.find((c) => c.id === id);
    if (!chat) return;
    activeChatId = id;
    chat.lastBranch = currentBranchName || chat.lastBranch || "main";
    chat.updatedAt = Date.now();
    getChatStacks(chat);
    chatView = "thread";
    composerDraft = "";
    await persistChatsNow();
    syncRightPane({ stickChatBottom: true });
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
      if (compactLayout.matches) activeWorkspace = next === "git" ? "history" : "chat";
      syncPaneModeTabs();
      syncWorkspaceNavigation();
      return;
    }
    paneMode = next;
    if (compactLayout.matches) activeWorkspace = next === "git" ? "history" : "chat";
    syncPaneModeTabs();
    syncWorkspaceNavigation();
    updateCommitBtn();
    syncRightPane({ stickChatBottom: paneMode === "chat" });
    syncOverlayFromState();
    if (paneMode === "git") {
      renderGitPane();
      void refreshWorkingDirty();
    }
    persistUiStateSoon();
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
      const unresolved = unresolvedMergeConflictCount(currentHtml) > 0;
      const modesLocked =
        gitBusy || (!!pendingMerge && unresolved && !dirtyReviewing);
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
    gitPane.classList.add("is-busy");
    gitPane.setAttribute("aria-busy", "true");
    updateCommitBtn();
    try {
      await fn();
    } catch (err) {
      setStatus(String(err.message || err), "danger");
    } finally {
      gitBusy = false;
      gitPane.classList.remove("is-busy");
      gitPane.setAttribute("aria-busy", "false");
      updateCommitBtn();
      if (paneMode === "git") renderGitPane();
    }
  }

  async function manualCommit() {
    if (isViewingHistory()) {
      setStatus("restore this commit before committing");
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
      setStatus("nothing to commit");
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
    let slowTimer = setTimeout(() => {
      setStatus("importing... please be patient, pandoc may be downloading...");
    }, 3000);
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
      const { importFileToHtml } = await loadPandocModule();
      const { invertHtmlColorsImport } = await import("./colorInvert.js");
      let html = stripKindredProtocol(await importFileToHtml(file));
      if (CONFIG.export.invertColorsForDarkMode) {
        html = invertHtmlColorsImport(html);
      }
      suppressEditorUpdate = true;
      try {
        setHtml(tipTap, html, { emitUpdate: false, source: "import" });
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
      clearTimeout(slowTimer);
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

  async function exportDraft(formatId = CONFIG.export.defaultFormat) {
    if (exportBtn.disabled) return;
    setExportMenuOpen(false);
    converting = true;
    updateCommitBtn();
    setStatus("exporting...");
    try {
      pullFromEditor();
      syncDirtyBodyFromCurrent();
      const exportHtml = htmlForExport(formatId);
      const styledDiff =
        wantsStyledDiffExport(CONFIG, dirtyViewMode, formatId) &&
        hasDiffMarkers(exportHtml);
      const exportPlain = store.htmlToPlain(exportHtml);
      if (!(exportPlain || "").trim() && exportHtml === "<p></p>") {
        setStatus("nothing to export", "warn");
        return;
      }
      const base = sanitizeDownloadBase(
        activeDraftDisplayTitle() ||
          store.titleFromText(exportHtml || dirtyHtml || dirtyText || ""),
      );
      let slowTimer = setTimeout(() => {
        setStatus("exporting... please be patient, pandoc may be downloading...");
      }, 3000);
      const { htmlToExportBlob } = await loadPandocModule();
      const { blob, format } = await htmlToExportBlob(
        exportHtml,
        formatId || CONFIG.export.defaultFormat,
        { styledDiff },
      );
      clearTimeout(slowTimer);
      setStatus("exporting...");
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
    void exportDraft();
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
      focusEditorSoon();
      return;
    }
    try {
      if (current.kind === "commit") {
        if (current.key !== headOid) {
          renderGitPane();
          focusEditorSoon();
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
    focusEditorSoon();
  }

  async function mergeIntoCurrent(name) {
    await flushSaveTimer();
    const result = await store.mergeBranch(activeDraftId, name);
    viewingOid = null;
    paneMode = "git";
    if (compactLayout.matches) activeWorkspace = "history";
    loadSnapshotState(result.state, { historical: false });
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
    persistUiStateSoon();
  }

  async function viewCommitOid(oid) {
    await flushSaveTimer();
    const idx = commits.findIndex((c) => c.oid === oid);
    if (idx < 0) return;
    if (!isViewingHistory()) {
      await loadHtmlDiff();
      dirtyViewMode = "Diff";
    }
    viewingOid = oid;
    activeCommitIndex = idx;
    const [snap, prev] = await Promise.all([
      store.readAtCommit(activeDraftId, oid),
      previousCommitSnap(idx),
    ]);
    loadSnapshotState(snap, {
      historical: true,
      historyBaseline: prev.plain,
      historyBaselineHtml: prev.html,
    });
    renderGitPane();
    updateCommitBtn();
    persistUiStateSoon();
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
    setStatus("restored into working tree");
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
  bindLongPress(gitPane, (e) => {
    if (e.target.closest(".git-row-title-input") || e.target.closest(".git-row-actions")) return false;
    const branchRow = e.target.closest("#git-branch-list .git-row[data-branch]");
    if (branchRow) {
      startGitRename("branch", branchRow.dataset.branch);
      return true;
    }
    const commitRow = e.target.closest('#git-commit-list .git-row[data-git="view"]');
    if (commitRow && commitRow.dataset.oid === headOid) {
      startGitRename("commit", commitRow.dataset.oid);
      return true;
    }
    return false;
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

  async function readChatStream(res, onDelta = null, onThinkingDelta = null) {
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
        if (event.type === "thinking_delta") {
          if (typeof onThinkingDelta === "function") onThinkingDelta(String(event.delta || ""));
        } else if (event.type === "delta") {
          if (typeof onDelta === "function") onDelta(String(event.delta || ""));
        } else if (event.type === "done") {
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

  async function sendChat({ retryStackIndex = null, retryUserIndex = null, overrideText = null } = {}) {
    if (!canUseComposer()) return;
    const chat = activeChat();
    if (!chat) return;

    const targetChatId = chat.id;
    const isViewingThisChat = () =>
      paneMode === "chat" && chatView === "thread" && activeChatId === targetChatId;

    const isRetrying = Number.isInteger(retryStackIndex) && Number.isInteger(retryUserIndex);
    const targetStack = isRetrying ? chat.stacks?.[retryStackIndex] : getActiveStack(chat);
    const source = isRetrying ? targetStack?.messages?.[retryUserIndex] : null;
    if (isRetrying && (!source || source.role !== "user")) return;
    const text = String(
      isRetrying ? (overrideText ?? source.content) : (chatInput?.value || composerDraft || "")
    ).trim();
    if (!text) return;

    pullFromEditor();
    const draftText = isRetrying
      ? String(source.draftText ?? "")
      : tipTap ? getPlain(tipTap) : currentText || "";
    const selection = isRetrying
      ? source.selection || { from: 0, to: 0 }
      : caretSelectionOffsets();

    let priorMessages = [];
    if (isRetrying) {
      const priorInStack = targetStack.messages.slice(0, retryUserIndex);
      const stacksBefore = chat.stacks.slice(0, retryStackIndex);
      priorMessages = [
        ...stacksBefore.flatMap((s) => s.messages || []),
        ...priorInStack,
      ];
      targetStack.messages = [
        ...priorInStack,
        { role: "user", content: text, draftText, selection },
        { role: "assistant", content: "" },
      ];
    } else {
      priorMessages = getChatStacks(chat).flatMap((s) => s.messages || []);
      const userMsg = { role: "user", content: text, draftText, selection };
      targetStack.messages.push(userMsg, { role: "assistant", content: "" });
    }

    const allMsgs = getChatStacks(chat).flatMap((s) => s.messages || []);
    if (
      !allMsgs.some((m) => m.role === "user" && m.content !== text) &&
      (!chat.title || chat.title === (store.DEFAULT_CHAT_TITLE || "New Chat"))
    ) {
      chat.title = chatTitleFromMessage(text);
    }
    chat.lastBranch = currentBranchName || chat.lastBranch || "main";
    chat.updatedAt = Date.now();
    composerDraft = "";
    editingChatMessage = null;
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
          messages: apiMessagesFromChat(priorMessages),
          message: text,
          draft_text: draftText,
          selection,
          conflict_context: mergeConflictContext(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const detail = data.detail;
        throw new Error(
          typeof detail === "string" ? detail : res.statusText || "Chat failed"
        );
      }
      const pendingReply = targetStack.messages[targetStack.messages.length - 1];
      const data = await readChatStream(
        res,
        (delta) => {
          pendingReply.content += delta;
          if (isViewingThisChat()) renderChatThread({ stickBottom: true });
        },
        (thinkingDelta) => {
          pendingReply.thinking = (pendingReply.thinking || "") + thinkingDelta;
          if (isViewingThisChat()) renderChatThread({ stickBottom: true });
        }
      );
      const reply = String(data.reply || "");
      const cost = Number(data.cost) || 0;
      pendingReply.content = reply || pendingReply.content;
      if (data.reasoning_summary) {
        pendingReply.thinking = data.reasoning_summary;
      }
      chat.lastBranch = currentBranchName || chat.lastBranch || "main";
      chat.updatedAt = Date.now();
      draftCost += cost;
      updateMeta();
      setStatus("");

      if (isViewingThisChat()) {
        renderChatThread({ stickBottom: true });
      } else if (paneMode === "chat" && chatView === "list") {
        renderChatList();
      }
      await persistChatsNow();
    } catch (err) {
      targetStack.messages.pop();
      if (!isRetrying) targetStack.messages.pop();
      if (isViewingThisChat()) {
        renderChatThread({ stickBottom: true });
        setStatus(String(err.message || err), "danger");
      }
      await persistChatsNow();
    } finally {
      chatBusy = false;
      syncChatComposer();
    }
  }

  newChatBtn?.addEventListener("click", () => {
    void createChat();
  });

  finishStackBtn?.addEventListener("click", () => {
    void finishCurrentStack();
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
  bindLongPress(chatListEl, (e) => {
    const item = e.target.closest(".draft-item");
    if (!item || e.target.closest("[data-action='delete']") || e.target.closest(".draft-item-title-input")) return false;
    renamingChatId = item.dataset.id;
    renderChatList();
    return true;
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

  feedbackEl.addEventListener("click", (e) => {
    if (e.target.closest(".stack-title-input")) return;
    const button = e.target.closest("[data-chat-action]");
    if (!button || !feedbackEl.contains(button)) return;

    const action = button.dataset.chatAction;
    const stackIndex = Number(button.dataset.stackIndex);
    const msgIndex = Number(button.dataset.msgIndex);
    const anchor = button.dataset.anchor
      ? parseTextAnchor(decodeURIComponent(button.dataset.anchor))
      : null;
    const location = anchor ? resolveTextAnchor(anchor) : null;

    if (action === "toggle-stack") {
      const chat = activeChat();
      if (chat && chat.stacks?.[stackIndex]) {
        chat.stacks[stackIndex].collapsed = !chat.stacks[stackIndex].collapsed;
        renderChatThread();
        if (!chatBusy) void persistChatsNow();
      }
      return;
    }
    
    if (action === "toggle-thinking") {
      const chat = activeChat();
      const msg = chat?.stacks?.[stackIndex]?.messages?.[msgIndex];
      if (msg) {
        msg.thinkingCollapsed = msg.thinkingCollapsed === false;
        renderChatThread();
        if (!chatBusy) void persistChatsNow();
      }
      return;
    }

    if (["mention", "current", "suggest"].includes(action) && !location) {
      setStatus("suggestion could not be safely located in the current draft", "warn");
      return;
    }
    if (action === "mention" || action === "current") {
      mentionDraftRange(location.start, location.end);
    } else if (action === "suggest") {
      const current = location.original;
      const replacement = button.dataset.replacement || "";
      const replaced = applyChatSuggestion(
        location.start,
        location.end,
        replacement,
        location.original
      );
      if (replaced) {
        markSuggestionReplaced(
          Number(button.dataset.stackIndex),
          Number(button.dataset.msgIndex),
          location.start,
          location.end,
          current,
          replacement,
          decodeURIComponent(button.dataset.suggestionToken || "")
        );
      }
    } else if (chatBusy) {
      return;
    } else if (action === "edit" && Number.isInteger(stackIndex) && Number.isInteger(msgIndex)) {
      editingChatMessage = { stackIndex, msgIndex };
      renderChatThread();
    } else if (action === "cancel-edit") {
      editingChatMessage = null;
      renderChatThread();
    } else if (action === "save-edit" && Number.isInteger(stackIndex) && Number.isInteger(msgIndex)) {
      const input = feedbackEl.querySelector(
        `[data-chat-edit-stack="${stackIndex}"][data-chat-edit-msg="${msgIndex}"]`
      );
      const value = String(input?.textContent || "").trim();
      if (value) void sendChat({ retryStackIndex: stackIndex, retryUserIndex: msgIndex, overrideText: value });
    } else if (action === "retry" && Number.isInteger(stackIndex) && Number.isInteger(msgIndex)) {
      const stack = activeChat()?.stacks?.[stackIndex];
      const messages = stack?.messages || [];
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          void sendChat({ retryStackIndex: stackIndex, retryUserIndex: i });
          break;
        }
      }
    }
  });

  feedbackEl.addEventListener("pointerover", (e) => {
    const button = e.target.closest("[data-preview]");
    if (!button || !feedbackEl.contains(button) || chatBusy) return;
    const anchor = button.dataset.anchor
      ? parseTextAnchor(decodeURIComponent(button.dataset.anchor))
      : null;
    const location = anchor ? resolveTextAnchor(anchor) : null;
    showSuggestionPreview(
      location?.start ?? button.dataset.start,
      location?.end ?? button.dataset.end,
      button.dataset.preview === "replacement" ? button.dataset.replacement || "" : null
    );
  });

  feedbackEl.addEventListener("pointerout", (e) => {
    const button = e.target.closest("[data-preview]");
    if (!button || !feedbackEl.contains(button) || button.contains(e.relatedTarget)) return;
    clearSuggestionPreview();
  });

  feedbackEl.addEventListener("contextmenu", (e) => {
    const header = e.target.closest(".chat-stack-header");
    if (header && feedbackEl.contains(header) && !chatBusy) {
      e.preventDefault();
      renamingStackIndex = Number(header.dataset.stackIndex);
      renderChatThread();
      return;
    }
    const message = e.target.closest(".chat-msg.user");
    if (!message || !feedbackEl.contains(message) || chatBusy) return;
    const stackEl = message.closest(".chat-stack");
    const stackIndex = Number(stackEl?.querySelector("[data-stack-index]")?.dataset.stackIndex);
    const messages = [...(stackEl?.querySelectorAll(".chat-msg") || [])];
    const msgIndex = messages.indexOf(message);
    if (msgIndex < 0 || !Number.isInteger(stackIndex)) return;
    e.preventDefault();
    editingChatMessage = { stackIndex, msgIndex };
    renderChatThread();
  });
  bindLongPress(feedbackEl, (e) => {
    const header = e.target.closest(".chat-stack-header");
    if (header && !chatBusy) {
      renamingStackIndex = Number(header.dataset.stackIndex);
      renderChatThread();
      return true;
    }
    const message = e.target.closest(".chat-msg.user");
    if (!message || chatBusy) return false;
    const stackEl = message.closest(".chat-stack");
    const stackIndex = Number(stackEl?.querySelector("[data-stack-index]")?.dataset.stackIndex);
    const msgIndex = [...(stackEl?.querySelectorAll(".chat-msg") || [])].indexOf(message);
    if (!Number.isInteger(stackIndex) || msgIndex < 0) return false;
    editingChatMessage = { stackIndex, msgIndex };
    renderChatThread();
    return true;
  });

  feedbackEl.addEventListener("keydown", (e) => {
    const input = e.target.closest(".stack-title-input");
    if (input && feedbackEl.contains(input)) {
      const stackIdx = Number(input.dataset.stackIndex);
      if (e.key === "Enter") {
        e.preventDefault();
        void finishStackRename(stackIdx, input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void finishStackRename(stackIdx, input.value, { cancel: true });
      }
      return;
    }
    const edit = e.target.closest(".chat-message-edit");
    if (!edit || !feedbackEl.contains(edit) || chatBusy) return;
    const stackIndex = Number(edit.dataset.chatEditStack);
    const msgIndex = Number(edit.dataset.chatEditMsg);
    if (e.key === "Escape") {
      e.preventDefault();
      editingChatMessage = null;
      renderChatThread();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const value = String(edit.textContent || "").trim();
      if (value && Number.isInteger(stackIndex) && Number.isInteger(msgIndex)) {
        void sendChat({ retryStackIndex: stackIndex, retryUserIndex: msgIndex, overrideText: value });
      }
    }
  });

  feedbackEl.addEventListener("focusout", (e) => {
    const input = e.target.closest(".stack-title-input");
    if (input && feedbackEl.contains(input)) {
      const stackIdx = Number(input.dataset.stackIndex);
      setTimeout(() => {
        if (renamingStackIndex === stackIdx) {
          void finishStackRename(stackIdx, input.value);
        }
      }, 0);
    }
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
    const min = 360;
    const max = rect.width - 300 - 5;
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
    if (compactLayout.matches) return;
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = true;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    divider.setPointerCapture(e.pointerId);
  });

  divider.addEventListener("pointermove", (e) => {
    if (compactLayout.matches) return;
    if (!resizing) return;
    setSplitFromClientX(e.clientX);
  });

  divider.addEventListener("pointerup", endResize);
  divider.addEventListener("pointercancel", endResize);

  divider.addEventListener("keydown", (e) => {
    if (compactLayout.matches) return;
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

  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.altKey || e.shiftKey) return;
  
      const key = e.key.toLowerCase();

      if (key === ";") {
        e.preventDefault();
        e.stopPropagation();
        if (compactLayout.matches) setWorkspace("draft");
        focusEditorSoon();
      }
      else if (key === "[") {
        if (activeDraftId) {
          e.preventDefault();
          e.stopPropagation();
          setPaneMode("chat");
        }
      }
      else if (key === "]") {
        if (activeDraftId) {
          e.preventDefault();
          e.stopPropagation();
          setPaneMode("git");
        }
      }
      else if (key === "enter") {
        if (paneMode === "git" && activeDraftId && !gitBusy && !isViewingHistory() && hasExportableBody()) {
          e.preventDefault();
          e.stopPropagation();
          void runGit(manualCommit);
        }
        if (paneMode === "chat" && canUseComposer()) {
          e.preventDefault();
          e.stopPropagation();
          void finishCurrentStack();
          void sendChat();
        }
      }
      else if (key === "/") {
        e.preventDefault();
        e.stopPropagation();
        void focusOrStartChat();
      }
      else if (key === "8") {
        e.preventDefault();
        e.stopPropagation();
        void runGit(() => setDirtyEditView("Text"));
      } else if (key === "9") {
        e.preventDefault();
        e.stopPropagation();
        void runGit(() => setDirtyEditView("Diff"));
      } else if (key === "0") {
        e.preventDefault();
        e.stopPropagation();
        void runGit(enterDirtyReview);
      }
    },
    true
  );

  (async () => {
    try {
      setStatus("loading drafts...");
      await storeReady;
      await refreshDraftList();
      updateMeta();
      setStatus("");
      warmPopularFontsAfterIdle();
      warmPandocAfterStartup();
    } catch (err) {
      console.error(err);
      setStatus(String(err.message || err), "danger");
    }
  })();
})();
