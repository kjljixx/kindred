import LightningFS from "@isomorphic-git/lightning-fs";
import git from "isomorphic-git";
import { mergeHtmlViaAst } from "./docMerge.js";
import { canonicalizeTextHtml, htmlToPlainText } from "./kindredSchema.js";
import { CONFIG } from "./config.js";

const VOLUME = "kindred";
  const ROOT = "/texts";
  const AUTHOR = { name: "kindred", email: "kindred@local" };
  const TEXT_FILE = "text.html";
  const ASSETS_DIR = "assets";
  const TRACKED = [TEXT_FILE, "meta.json"];
  const TITLE_FILE = "title.txt";
  const BRANCH_ACCESS_FILE = "branch-access.json";
  const CHATS_FILE = "draft-chats.json";
  const UI_STATE_FILE = "draft-ui.json";
  const DEFAULT_MODEL = CONFIG.chat.model;
  const DEFAULT_CHAT_TITLE = "New Chat";
  const DEFAULT_HIGHLIGHT_COLOR = "rgba(117, 114, 12, 1.0)";

  const fs = new LightningFS(VOLUME);
  const pfs = fs.promises;

  function textDir(id) {
    return `${ROOT}/${id}`;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatStamp(date = new Date()) {
    const y = date.getFullYear();
    const m = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    const h = pad2(date.getHours());
    const min = pad2(date.getMinutes());
    const s = pad2(date.getSeconds());
    return `${y}-${m}-${d} at ${h}:${min}:${s}`;
  }

  function autoMessage(verb, date) {
    return `${verb} on ${formatStamp(date)}`;
  }

  /** `base`, then `base2`, `base3`, … skipping names already in `existing`. */
  function nextSequentialName(base, existing) {
    const names = new Set(existing || []);
    const root = String(base || "").trim() || "branch";
    if (!names.has(root)) return root;
    let n = 2;
    while (names.has(`${root}${n}`)) n += 1;
    return `${root}${n}`;
  }

  function asPlain(value) {
    return String(value ?? "").replace(/\u00a0/g, " ");
  }

  /** Decode entities in HTML *source* text chunks (not DOM textContent). */
  function decodeHtmlEntities(text) {
    const s = String(text ?? "");
    if (!s.includes("&")) return s;
    const el = document.createElement("textarea");
    el.innerHTML = s;
    return el.value;
  }

  /** Escape plain text (incl. literal "<em>") into TipTap paragraph HTML. */
  function plainTextToHtml(text) {
    const escaped = String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (!escaped.trim()) return "";
    return escaped
      .split(/\n\n+/)
      .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  function titleFromText(text) {
    const raw = String(text || "");
    const plain = raw.includes("<") ? htmlToPlainText(raw) : raw;
    const line = plain
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (!line) return "Empty draft";
    return line.length > 56 ? `${line.slice(0, 56)}...` : line;
  }

  function htmlHasConflictMarkers(html) {
    const s = String(html || "");
    if (!s) return false;
    if (
      !s.includes("data-kindred-text-conflict") &&
      !s.includes("data-kindred-align-ours")
    ) {
      return false;
    }
    const doc = new DOMParser().parseFromString(s, "text/html");
    return !!(
      doc.body.querySelector("[data-kindred-text-conflict]") ||
      doc.body.querySelector("[data-kindred-align-ours]")
    );
  }

  function formatConflict(labelOurs, oursStr, labelTheirs, theirsStr) {
    return (
      `<span data-kindred-text-conflict` +
      ` data-kindred-label-ours="${escapeHtmlAttr(labelOurs)}"` +
      ` data-kindred-label-theirs="${escapeHtmlAttr(labelTheirs)}"` +
      ` data-kindred-ours="${escapeHtmlAttr(oursStr)}"` +
      ` data-kindred-theirs="${escapeHtmlAttr(theirsStr)}"` +
      `></span>`
    );
  }

  /** Drop protocol nodes/attrs from non-merge HTML (import / stray attrs). */
  function stripKindredProtocol(html) {
    const raw = String(html || "");
    if (!raw) return "";
    if (!raw.includes("data-kindred-")) return raw;
    const doc = new DOMParser().parseFromString(
      `<div id="__kindred_root">${raw}</div>`,
      "text/html"
    );
    const root = doc.getElementById("__kindred_root");
    if (!root) return raw;
    root.querySelectorAll("[data-kindred-text-conflict]").forEach((el) => {
      const ours = el.getAttribute("data-kindred-ours") || "";
      if (!ours) {
        el.remove();
        return;
      }
      const wrap = doc.createElement("div");
      wrap.innerHTML = ours;
      const frag = doc.createDocumentFragment();
      while (wrap.firstChild) frag.appendChild(wrap.firstChild);
      el.replaceWith(frag);
    });
    root.querySelectorAll("[data-kindred-conflict]").forEach((el) => {
      el.remove();
    });
    root.querySelectorAll("[data-kindred-align-ours]").forEach((el) => {
      el.removeAttribute("data-kindred-align-ours");
      el.removeAttribute("data-kindred-align-theirs");
      el.removeAttribute("data-kindred-align-label-ours");
      el.removeAttribute("data-kindred-align-label-theirs");
    });
    root.querySelectorAll("[data-kindred-table-ours]").forEach((el) => {
      el.removeAttribute("data-kindred-table-ours");
      el.removeAttribute("data-kindred-table-theirs");
      el.removeAttribute("data-kindred-table-label-ours");
      el.removeAttribute("data-kindred-table-label-theirs");
    });
    root.querySelectorAll("[data-kindred-list-ours]").forEach((el) => {
      el.removeAttribute("data-kindred-list-ours");
      el.removeAttribute("data-kindred-list-theirs");
      el.removeAttribute("data-kindred-list-label-ours");
      el.removeAttribute("data-kindred-list-label-theirs");
    });
    root.querySelectorAll("[data-kindred-list-conflicts]").forEach((el) => {
      el.removeAttribute("data-kindred-list-conflicts");
    });
    return root.innerHTML;
  }

  function parseTextAlignFromOpenTag(chunk) {
    const style = /\bstyle\s*=\s*(["'])(.*?)\1/i.exec(chunk || "");
    if (!style) return "left";
    const m = /(?:^|;)\s*text-align\s*:\s*([^;]+)/i.exec(style[2]);
    if (!m) return "left";
    const v = m[1].trim().toLowerCase();
    if (v === "center" || v === "right" || v === "justify" || v === "left") return v;
    return "left";
  }

  function escapeHtmlAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  /** Conflict HTML is stored verbatim; otherwise strip protocol and canonicalize. */
  function storeTextHtml(html, { hasConflict = false } = {}) {
    const raw = html == null ? "" : String(html);
    if (hasConflict || htmlHasConflictMarkers(raw)) return raw;
    return canonicalizeTextHtml(stripKindredProtocol(raw));
  }

  /** text body from the app is TipTap getHTML(); canonicalize for stable dirty. */
  function textHtmlFromEditor(value) {
    return storeTextHtml(value);
  }

  function newDraftId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function ensureDir(path) {
    try {
      await pfs.mkdir(path);
    } catch (err) {
      if (err && err.code !== "EEXIST") throw err;
    }
  }

  async function flush() {
    if (typeof fs.flush !== "function") return;
    await new Promise((resolve, reject) => {
      fs.flush((err) => (err ? reject(err) : resolve()));
    });
  }

  async function writeText(path, text) {
    await pfs.writeFile(path, text ?? "", "utf8");
  }

  function assetPathFromReference(reference) {
    const match = /^kindred-image:(assets\/[a-f0-9]{64}\.[a-z0-9]+)$/i.exec(String(reference || ""));
    return match ? match[1] : null;
  }

  function assetReferences(html) {
    const refs = new Set();
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    for (const image of doc.body.querySelectorAll("img[src]")) {
      const path = assetPathFromReference(image.getAttribute("src"));
      if (path) refs.add(path);
    }
    return [...refs];
  }

  function imageExtension(file) {
    const fromType = {
      "image/avif": "avif",
      "image/gif": "gif",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/svg+xml": "svg",
      "image/webp": "webp",
    }[String(file?.type || "").toLowerCase()];
    if (fromType) return fromType;
    const match = /\.([a-z0-9]+)$/i.exec(String(file?.name || ""));
    return match ? match[1].toLowerCase() : "png";
  }

  async function addImage(id, file) {
    if (!file || !String(file.type || "").startsWith("image/")) {
      throw new Error("Choose an image file");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const dir = textDir(id);
    const path = `${ASSETS_DIR}/${hash}.${imageExtension(file)}`;
    await ensureDir(`${dir}/${ASSETS_DIR}`);
    if (!(await pathExists(`${dir}/${path}`))) {
      await pfs.writeFile(`${dir}/${path}`, bytes);
      await flush();
    }
    return `kindred-image:${path}`;
  }

  async function hydrateImageElements(id, root, oid = null) {
    if (!id || !root) return;
    const dir = textDir(id);
    const images = [...root.querySelectorAll("img[src^='kindred-image:']")];
    await Promise.all(images.map(async (image) => {
      const path = assetPathFromReference(image.getAttribute("src"));
      if (!path || image.dataset.kindredAssetLoaded === path) return;
      try {
        let bytes;
        if (oid) ({ blob: bytes } = await git.readBlob({ fs, dir, oid, filepath: path }));
        else bytes = await pfs.readFile(`${dir}/${path}`);
        image.src = URL.createObjectURL(new Blob([bytes]));
        image.dataset.kindredAssetLoaded = path;
      } catch (err) {
        console.warn("kindred: image asset unavailable", path, err);
      }
    }));
  }

  async function copyAssetsFromOid(dir, oid, html) {
    for (const path of assetReferences(html)) {
      if (await pathExists(`${dir}/${path}`)) continue;
      try {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: path });
        await ensureDir(`${dir}/${ASSETS_DIR}`);
        await pfs.writeFile(`${dir}/${path}`, blob);
      } catch {
        // Asset may live on another merge side, or be a malformed legacy reference.
      }
    }
  }

  async function readText(path, fallback = "") {
    try {
      return await pfs.readFile(path, "utf8");
    } catch {
      return fallback;
    }
  }

  async function writeJson(path, value) {
    await writeText(path, JSON.stringify(value ?? null));
  }

  async function readJson(path, fallback = null) {
    try {
      const raw = await pfs.readFile(path, "utf8");
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async function pathExists(path) {
    try {
      await pfs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  function normalizeMeta(meta, id) {
    const now = Date.now();
    const m = meta && typeof meta === "object" ? meta : {};
    return {
      id,
      model: m.model || DEFAULT_MODEL,
      createdAt: Number(m.createdAt) || now,
      updatedAt: Number(m.updatedAt) || now,
      activeBranch: m.activeBranch || "main",
      hasConflict: !!m.hasConflict,
      pendingMerge: m.pendingMerge || null,
      customTitle: !!m.customTitle,
    };
  }

  function normalizeSelection(sel) {
    if (!sel || typeof sel !== "object") return { from: 0, to: 0 };
    const from = Math.max(0, Number(sel.from) || 0);
    const to = Math.max(0, Number(sel.to) || from);
    return { from, to: Math.max(from, to) };
  }

  function normalizeChatMessage(msg) {
    if (!msg || typeof msg !== "object") return null;
    const role = String(msg.role || "").trim();
    const content = String(msg.content || "");
    if (role !== "user" && role !== "assistant") return null;
    if (role === "assistant") {
      const out = { role, content };
      if (typeof msg.thinking === "string" && msg.thinking) {
        out.thinking = msg.thinking;
      }
      if (typeof msg.thinkingCollapsed === "boolean") {
        out.thinkingCollapsed = msg.thinkingCollapsed;
      }
      return out;
    }
    return {
      role,
      content,
      draftText: String(msg.draftText ?? ""),
      selection: normalizeSelection(msg.selection),
    };
  }

  function normalizeChatStack(stack) {
    if (!stack || typeof stack !== "object") return null;
    const id = String(stack.id || "").trim() || `stack-${Date.now()}`;
    const title = String(stack.title || "").trim() || "Stack";
    const collapsed = !!stack.collapsed;
    const messages = Array.isArray(stack.messages)
      ? stack.messages.map(normalizeChatMessage).filter(Boolean)
      : [];
    return { id, title, collapsed, messages };
  }
  
  function normalizeChatRecord(chat, fallbackBranch = "main") {
    if (!chat || typeof chat !== "object") return null;
    const id = String(chat.id || "").trim();
    if (!id) return null;
    const now = Date.now();
    const rawMessages = Array.isArray(chat.messages)
      ? chat.messages.map(normalizeChatMessage).filter(Boolean)
      : [];
    const stacks = Array.isArray(chat.stacks) && chat.stacks.length
      ? chat.stacks.map(normalizeChatStack).filter(Boolean)
      : [
          {
            id: `stack-${now}`,
            title: "Stack 1",
            collapsed: false,
            messages: rawMessages,
          },
        ];
    const messages = rawMessages.length
      ? rawMessages
      : stacks.flatMap((s) => s.messages);
  
    return {
      id,
      title: String(chat.title || "").trim() || DEFAULT_CHAT_TITLE,
      lastBranch: String(chat.lastBranch || fallbackBranch || "main").trim() || "main",
      createdAt: Number(chat.createdAt) || now,
      updatedAt: Number(chat.updatedAt) || now,
      messages,
      stacks,
    };
  }

  function normalizeChatsState(raw, fallbackBranch = "main") {
    const empty = { activeChatId: null, chats: [], totalCost: 0 };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
    // Legacy unit-scoped map (e.g. { text: [...] }) — drop; no migration.
    if (Array.isArray(raw.chats) === false && !("activeChatId" in raw)) {
      return empty;
    }
    const chats = (Array.isArray(raw.chats) ? raw.chats : [])
      .map((c) => normalizeChatRecord(c, fallbackBranch))
      .filter(Boolean);
    let activeChatId =
      typeof raw.activeChatId === "string" && raw.activeChatId
        ? raw.activeChatId
        : null;
    if (activeChatId && !chats.some((c) => c.id === activeChatId)) {
      activeChatId = null;
    }
    return { activeChatId, chats, totalCost: Number(raw.totalCost) || 0 };
  }

  async function readChats(id) {
    const dir = textDir(id);
    const meta = normalizeMeta(await readJson(`${dir}/meta.json`, null), id);
    let branch = meta.activeBranch || "main";
    try {
      branch =
        (await git.currentBranch({ fs, dir, test: true })) || branch;
    } catch {
      /* keep meta branch */
    }
    return normalizeChatsState(
      await readJson(`${dir}/${CHATS_FILE}`, null),
      branch
    );
  }

  async function saveChats(id, state) {
    const dir = textDir(id);
    const meta = normalizeMeta(await readJson(`${dir}/meta.json`, null), id);
    const next = normalizeChatsState(state, meta.activeBranch || "main");
    await writeJson(`${dir}/${CHATS_FILE}`, next);
    await flush();
    return next;
  }

  function normalizeToolbarState(raw) {
    const t = raw && typeof raw === "object" ? raw : {};
    const formatLock = !!t.formatLock;
    let lockedMarks = null;
    if (formatLock && Array.isArray(t.lockedMarks) && t.lockedMarks.length) {
      lockedMarks = t.lockedMarks.filter(
        (mark) => mark && typeof mark === "object" && typeof mark.type === "string"
      );
      if (!lockedMarks.length) lockedMarks = null;
    }
    const lastHighlightColor =
      typeof t.lastHighlightColor === "string" && t.lastHighlightColor.trim()
        ? t.lastHighlightColor.trim()
        : DEFAULT_HIGHLIGHT_COLOR;
    return { formatLock, lockedMarks, lastHighlightColor };
  }

  function normalizeViewState(raw) {
    const v = raw && typeof raw === "object" ? raw : {};
    const paneMode = v.paneMode === "git" ? "git" : "chat";
    const activeWorkspace =
      v.activeWorkspace === "chat" || v.activeWorkspace === "history"
        ? v.activeWorkspace
        : "draft";
    const dirtyViewMode = v.dirtyViewMode === "Diff" ? "Diff" : "Text";
    const viewingOid =
      typeof v.viewingOid === "string" && v.viewingOid.trim()
        ? v.viewingOid.trim()
        : null;
    return {
      paneMode,
      activeWorkspace,
      dirtyViewMode,
      viewingOid,
      editorScrollTop: Math.max(0, Number(v.editorScrollTop) || 0),
      selection: normalizeSelection(v.selection),
    };
  }

  function normalizeUiState(raw) {
    const empty = {
      toolbar: normalizeToolbarState(null),
      view: normalizeViewState(null),
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
    return {
      toolbar: normalizeToolbarState(raw.toolbar),
      view: normalizeViewState(raw.view),
    };
  }

  async function readUiState(id) {
    const dir = textDir(id);
    return normalizeUiState(await readJson(`${dir}/${UI_STATE_FILE}`, null));
  }

  async function saveUiState(id, state) {
    const dir = textDir(id);
    const next = normalizeUiState(state);
    await writeJson(`${dir}/${UI_STATE_FILE}`, next);
    await flush();
    return next;
  }

  async function writeTitleFile(dir, title) {
    await writeText(`${dir}/${TITLE_FILE}`, title || "");
  }

  async function readTitleFile(dir) {
    return (await readText(`${dir}/${TITLE_FILE}`, "")).trim();
  }

  async function readBranchAccess(dir) {
    const raw = await readJson(`${dir}/${BRANCH_ACCESS_FILE}`, {});
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    for (const [name, ts] of Object.entries(raw)) {
      const n = Number(ts);
      if (name && Number.isFinite(n) && n > 0) out[name] = n;
    }
    return out;
  }

  async function writeBranchAccess(dir, map) {
    await writeJson(`${dir}/${BRANCH_ACCESS_FILE}`, map || {});
  }

  async function touchBranchAccess(dir, name, at = Date.now()) {
    const ref = String(name || "").trim();
    if (!ref) return;
    const map = await readBranchAccess(dir);
    map[ref] = at;
    await writeBranchAccess(dir, map);
  }

  async function resolveTitle(dir, text, preferred, customTitle = false) {
    // Pinned titles (explicit rename) win; otherwise always derive from body.
    if (customTitle) {
      if (typeof preferred === "string" && preferred.trim()) {
        return preferred.trim();
      }
      const fromFile = await readTitleFile(dir);
      if (fromFile) return fromFile;
    }
    return titleFromText(text || "");
  }

  // text + model content (excludes meta bookkeeping, title, chats).
  function dirtyContentKey(state) {
    const hasConflict =
      !!state.hasConflict ||
      !!(state.meta && state.meta.hasConflict);
    return JSON.stringify({
      html: storeTextHtml(state.html || state.text || "", { hasConflict }),
      model: state.model || DEFAULT_MODEL,
    });
  }

  function saveContentKey(state) {
    return JSON.stringify({
      dirty: dirtyContentKey(state),
      activeBranch: state.activeBranch || "main",
    });
  }

  async function writeWorkingFiles(dir, state) {
    const id = state.id || dir.split("/").pop();
    const hasConflict =
      "hasConflict" in state
        ? !!state.hasConflict
        : !!(state.meta && state.meta.hasConflict);
    const pendingMerge =
      "pendingMerge" in state
        ? state.pendingMerge || null
        : (state.meta && state.meta.pendingMerge) || null;
    const customTitle =
      "customTitle" in state
        ? !!state.customTitle
        : !!(state.meta && state.meta.customTitle);
    const meta = normalizeMeta(
      {
        ...(state.meta || {}),
        model: state.model ?? state.meta?.model,
        createdAt: state.createdAt ?? state.meta?.createdAt,
        updatedAt: state.updatedAt ?? Date.now(),
        activeBranch: state.activeBranch ?? state.meta?.activeBranch,
        hasConflict,
        pendingMerge,
        customTitle,
      },
      id
    );
    const html = storeTextHtml(state.html ?? state.text ?? "", { hasConflict });
    const title = await resolveTitle(dir, html, state.title, customTitle);
    await writeTitleFile(dir, title);
    await writeText(`${dir}/${TEXT_FILE}`, html);
    await writeJson(`${dir}/meta.json`, meta);
    return { meta, title };
  }

  async function readWorkingFiles(id) {
    const dir = textDir(id);
    const html = await readText(`${dir}/${TEXT_FILE}`, "");
    const meta = normalizeMeta(await readJson(`${dir}/meta.json`, null), id);
    const title = await resolveTitle(dir, html, null, meta.customTitle);
    return {
      id,
      html,
      text: html,
      model: meta.model,
      title,
      customTitle: meta.customTitle,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      activeBranch: meta.activeBranch,
      hasConflict: meta.hasConflict,
      pendingMerge: meta.pendingMerge,
      meta,
    };
  }

  async function stageTracked(dir) {
    for (const filepath of TRACKED) {
      try {
        await git.add({ fs, dir, filepath });
      } catch (err) {
        console.warn("kindred: git add failed", filepath, err);
      }
    }
    try {
      const assets = await pfs.readdir(`${dir}/${ASSETS_DIR}`);
      for (const name of assets.sort()) await git.add({ fs, dir, filepath: `${ASSETS_DIR}/${name}` });
    } catch {
      // Draft has no images yet.
    }
  }

  async function commitFiles(dir, message, extra = {}) {
    await stageTracked(dir);
    const oid = await git.commit({
      fs,
      dir,
      message,
      author: AUTHOR,
      ...extra,
    });
    await flush();
    return oid;
  }

  async function hasHead(dir) {
    try {
      await git.resolveRef({ fs, dir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  async function isDirty(id) {
    const dir = textDir(id);
    const state = await readWorkingFiles(id);
    if (!(await hasHead(dir))) {
      return !!(state.html || state.text);
    }
    const headOid = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const head = await readFilesAtOid(dir, headOid);
    return dirtyContentKey(state) !== dirtyContentKey(head);
  }

  async function listDrafts() {
    await ensureDir(ROOT);
    let names = [];
    try {
      names = await pfs.readdir(ROOT);
    } catch {
      return [];
    }
    const drafts = [];
    for (const name of names) {
      const dir = textDir(name);
      if (!(await pathExists(`${dir}/.git`))) continue;
      try {
        const state = await readWorkingFiles(name);
        const branch =
          (await git.currentBranch({ fs, dir, test: true })) ||
          state.activeBranch ||
          "main";
        const commitCount = (await listCommits(name, branch)).length;
        drafts.push({
          id: name,
          title: state.title || titleFromText(state.text),
          customTitle: !!state.customTitle,
          text: state.text,
          updatedAt: state.updatedAt,
          createdAt: state.createdAt,
          activeBranch: branch,
          commitCount,
          hasConflict: state.hasConflict,
        });
      } catch (err) {
        console.warn("kindred: skip draft", name, err);
      }
    }
    drafts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return drafts;
  }

  async function createDraft({ text = "", html, title = "" } = {}) {
    await ensureDir(ROOT);
    const id = newDraftId();
    const dir = textDir(id);
    await ensureDir(dir);
    await git.init({ fs, dir, defaultBranch: "main" });
    const now = Date.now();
    // Prefer TipTap getHTML() from the app; plain text is escaped as literals.
    const body =
      html !== undefined && html !== null
        ? textHtmlFromEditor(html)
        : plainTextToHtml(text ?? "");
    const trimmedTitle = String(title || "").trim();
    await writeWorkingFiles(dir, {
      id,
      html: body,
      text: body,
      model: DEFAULT_MODEL,
      ...(trimmedTitle ? { title: trimmedTitle, customTitle: true } : { customTitle: false }),
      createdAt: now,
      updatedAt: now,
      activeBranch: "main",
      hasConflict: false,
      pendingMerge: null,
    });
    await writeJson(`${dir}/${CHATS_FILE}`, {
      activeChatId: null,
      chats: [],
      totalCost: 0,
    });
    await writeJson(`${dir}/${UI_STATE_FILE}`, normalizeUiState(null));
    await touchBranchAccess(dir, "main", now);
    await flush();
    return readWorkingFiles(id);
  }

  async function deleteDraft(id) {
    const dir = textDir(id);
    async function rmRecursive(path) {
      let st;
      try {
        st = await pfs.stat(path);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        const kids = await pfs.readdir(path);
        for (const kid of kids) {
          await rmRecursive(`${path}/${kid}`);
        }
        await pfs.rmdir(path);
      } else {
        await pfs.unlink(path);
      }
    }
    await rmRecursive(dir);
    await flush();
  }

  async function renameDraft(id, title) {
    const dir = textDir(id);
    const state = await readWorkingFiles(id);
    const trimmed = String(title || "").trim();
    const customTitle = !!trimmed;
    const next = trimmed || titleFromText(state.text);
    await writeTitleFile(dir, next);
    const meta = normalizeMeta(await readJson(`${dir}/meta.json`, null), id);
    meta.updatedAt = Date.now();
    meta.customTitle = customTitle;
    await writeJson(`${dir}/meta.json`, meta);
    await flush();
    return next;
  }

  async function saveWorkingTree(id, partial) {
    const prev = await readWorkingFiles(id);
    const next = {
      ...prev,
      ...partial,
      id,
    };
    if (partial.html != null || (partial.text != null && partial.html == null)) {
      // App persists TipTap getHTML(); do not re-interpret as HTML source.
      // Conflict protocol HTML must not be stripped/canonicalized away.
      const raw = partial.html != null ? partial.html : partial.text;
      const hasConflict =
        !!(next.hasConflict ?? prev.hasConflict) ||
        htmlHasConflictMarkers(raw);
      const body = storeTextHtml(raw, { hasConflict });
      next.html = body;
      next.text = body;
    }
    if (partial.title != null) {
      const trimmed = String(partial.title || "").trim();
      if (trimmed) {
        next.title = trimmed;
        next.customTitle = true;
      } else {
        next.title = titleFromText(next.html || next.text || "");
        next.customTitle = false;
      }
    } else if ("customTitle" in partial) {
      next.customTitle = !!partial.customTitle;
      if (!next.customTitle) {
        next.title = titleFromText(next.html || next.text || "");
      }
    }
    if (
      saveContentKey(prev) === saveContentKey(next) &&
      partial.title == null &&
      !("customTitle" in partial)
    ) {
      return prev;
    }
    next.updatedAt = Date.now();
    await writeWorkingFiles(textDir(id), next);
    await flush();
    return readWorkingFiles(id);
  }

  async function commitWorkingTree(id, { verb = "Commit" } = {}) {
    const dir = textDir(id);
    const now = Date.now();
    const state = await readWorkingFiles(id);
    const pending = state.pendingMerge;
    const isMergeCommit = !!(pending && pending.ours && pending.theirs);
    if (!isMergeCommit && (await hasHead(dir)) && !(await isDirty(id))) {
      const err = new Error("Nothing to commit");
      err.code = "NOTHING_TO_COMMIT";
      throw err;
    }
    let messageVerb = verb;
    state.updatedAt = now;
    if (verb === "Merge" || verb === "Commit") {
      state.hasConflict = false;
      state.pendingMerge = null;
    }
    await writeWorkingFiles(dir, state);
    const extra = {};
    if (isMergeCommit) {
      try {
        const oursOid = await git.resolveRef({ fs, dir, ref: pending.ours });
        const theirsOid = await git.resolveRef({ fs, dir, ref: pending.theirs });
        extra.parent = [oursOid, theirsOid];
        messageVerb = "Merge";
      } catch (err) {
        console.warn("kindred: merge parents unavailable", err);
      }
    }
    const oid = await commitFiles(
      dir,
      autoMessage(messageVerb, new Date(now)),
      extra
    );
    await flush();
    return { oid, state: await readWorkingFiles(id) };
  }

  /** Replace HEAD commit message only (same tree/parents; ignores dirty WT). */
  async function amendCommitMessage(id, message) {
    const dir = textDir(id);
    const msg = String(message ?? "").trim();
    if (!msg) throw new Error("Commit message required");
    if (!(await hasHead(dir))) throw new Error("No commits to amend");
    const headOid = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const { commit } = await git.readCommit({ fs, dir, oid: headOid });
    const oid = await git.commit({
      fs,
      dir,
      message: msg,
      author: AUTHOR,
      amend: true,
      tree: commit.tree,
    });
    await flush();
    return { oid, previousOid: headOid, state: await readWorkingFiles(id) };
  }

  async function listCommits(id, branch) {
    const dir = textDir(id);
    const ref =
      branch ||
      (await git.currentBranch({ fs, dir, test: true })) ||
      "main";
    try {
      const entries = await git.log({ fs, dir, ref });
      // Oldest → newest for 1..n scrubbing
      return entries
        .slice()
        .reverse()
        .map((e) => ({
          oid: e.oid,
          message: e.commit.message,
          timestamp: (e.commit.author?.timestamp || 0) * 1000,
        }));
    } catch {
      return [];
    }
  }

  async function readFilesAtOid(dir, oid) {
    async function readPath(filepath, asJson) {
      try {
        const { blob } = await git.readBlob({
          fs,
          dir,
          oid,
          filepath,
        });
        const text = new TextDecoder().decode(blob);
        return asJson ? JSON.parse(text) : text;
      } catch {
        return asJson ? null : "";
      }
    }
    const body = await readPath(TEXT_FILE, false);
    const metaRaw = await readPath("meta.json", true);
    return {
      html: body,
      text: body,
      model: metaRaw?.model || DEFAULT_MODEL,
      createdAt: metaRaw?.createdAt,
      updatedAt: metaRaw?.updatedAt,
      activeBranch: metaRaw?.activeBranch || "main",
      hasConflict: !!metaRaw?.hasConflict,
      pendingMerge: metaRaw?.pendingMerge || null,
    };
  }

  async function readAtCommit(id, oid) {
    const dir = textDir(id);
    const snap = await readFilesAtOid(dir, oid);
    const meta = normalizeMeta(await readJson(`${dir}/meta.json`, null), id);
    const title = await resolveTitle(dir, snap.text, null, meta.customTitle);
    return { ...snap, title };
  }

  async function readHead(id) {
    const dir = textDir(id);
    if (!(await hasHead(dir))) return null;
    const oid = await git.resolveRef({ fs, dir, ref: "HEAD" });
    return readAtCommit(id, oid);
  }

  async function restoreCommitToWorkingTree(id, oid) {
    const dir = textDir(id);
    const snap = await readFilesAtOid(dir, oid);
    const prev = await readWorkingFiles(id);
    const body = textHtmlFromEditor(snap.html || snap.text || "");
    await copyAssetsFromOid(dir, oid, body);
    await writeWorkingFiles(dir, {
      ...prev,
      html: body,
      text: body,
      model: snap.model,
      updatedAt: Date.now(),
      hasConflict: false,
      pendingMerge: null,
    });
    await flush();
    return readWorkingFiles(id);
  }

  /** Discard working-tree edits and abort any merge; sync files to HEAD (tip). */
  async function resetToHead(id) {
    const dir = textDir(id);
    if (!(await hasHead(dir))) {
      throw new Error("No commits yet");
    }
    const preservedTitle = await readTitleFile(dir);
    const preservedCustom = normalizeMeta(
      await readJson(`${dir}/meta.json`, null),
      id
    ).customTitle;
    try {
      if (typeof git.abortMerge === "function") {
        await git.abortMerge({ fs, dir });
      }
    } catch (err) {
      // No merge in progress, or already clean.
      console.info("kindred: abortMerge skipped", err?.code || err?.message || err);
    }
    const branch =
      (await git.currentBranch({ fs, dir, test: true })) ||
      (await currentBranch(id));
    try {
      await git.checkout({ fs, dir, ref: branch, force: true });
    } catch (err) {
      console.warn("kindred: force checkout during reset failed", err);
    }
    const headOid = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const snap = await readFilesAtOid(dir, headOid);
    const prev = await readWorkingFiles(id);
    const body = textHtmlFromEditor(snap.html || snap.text || "");
    await writeWorkingFiles(dir, {
      ...prev,
      html: body,
      text: body,
      model: snap.model,
      activeBranch: branch,
      updatedAt: Date.now(),
      hasConflict: false,
      pendingMerge: null,
      customTitle: preservedCustom,
      ...(preservedCustom && preservedTitle ? { title: preservedTitle } : {}),
    });
    await flush();
    return readWorkingFiles(id);
  }

  async function listBranches(id) {
    const dir = textDir(id);
    let names = [];
    try {
      names = await git.listBranches({ fs, dir });
    } catch {
      /* empty */
    }
    if (!names.length) {
      const cur = await git.currentBranch({ fs, dir, test: true });
      names = cur ? [cur] : ["main"];
    }
    const access = await readBranchAccess(dir);
    return names.slice().sort((a, b) => {
      const ta = access[a] || 0;
      const tb = access[b] || 0;
      if (tb !== ta) return tb - ta;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  async function currentBranch(id) {
    const dir = textDir(id);
    const cur = await git.currentBranch({ fs, dir, test: true });
    if (cur) return cur;
    const meta = normalizeMeta(await readJson(`${dir}/meta.json`, null), id);
    return meta.activeBranch || "main";
  }

  async function createBranch(id, name, { checkout = false } = {}) {
    const dir = textDir(id);
    const ref = String(name || "").trim();
    if (!ref) throw new Error("Branch name required");
    if (!(await hasHead(dir))) {
      throw new Error("Commit once before creating branches");
    }
    const preservedTitle = await readTitleFile(dir);
    const preservedCustom = normalizeMeta(
      await readJson(`${dir}/meta.json`, null),
      id
    ).customTitle;
    if (checkout && !(await isDirty(id))) {
      await restoreMetaFromHead(dir);
    }
    await git.branch({ fs, dir, ref, checkout });
    if (preservedTitle) {
      await writeTitleFile(dir, preservedTitle);
    }
    await touchBranchAccess(dir, ref);
    if (checkout) {
      await saveWorkingTree(id, {
        activeBranch: ref,
        customTitle: preservedCustom,
        ...(preservedCustom && preservedTitle ? { title: preservedTitle } : {}),
      });
    }
    await flush();
    return ref;
  }

  async function renameBranch(id, oldName, newName) {
    const dir = textDir(id);
    const oldref = String(oldName || "").trim();
    const ref = String(newName || "").trim();
    if (!oldref || !ref) throw new Error("Branch name required");
    if (oldref === ref) return ref;
    const existing = await listBranches(id);
    if (existing.includes(ref)) throw new Error(`Branch “${ref}” already exists`);
    const cur = await currentBranch(id);
    const checkout = cur === oldref;
    await git.renameBranch({ fs, dir, oldref, ref, checkout });
    const access = await readBranchAccess(dir);
    const prevTs = access[oldref];
    delete access[oldref];
    access[ref] = checkout ? Date.now() : prevTs || Date.now();
    await writeBranchAccess(dir, access);
    if (checkout) {
      await saveWorkingTree(id, { activeBranch: ref });
    }
    await flush();
    return ref;
  }

  async function restoreMetaFromHead(dir) {
    if (!(await hasHead(dir))) return;
    try {
      const headOid = await git.resolveRef({ fs, dir, ref: "HEAD" });
      const { blob } = await git.readBlob({
        fs,
        dir,
        oid: headOid,
        filepath: "meta.json",
      });
      await writeText(`${dir}/meta.json`, new TextDecoder().decode(blob));
    } catch (err) {
      console.warn("kindred: could not restore meta.json from HEAD", err);
    }
  }

  function isCheckoutConflictError(err) {
    if (!err) return false;
    if (err.code === "CheckoutConflictError" || err.code === "CHECKOUT_CONFLICT") {
      return true;
    }
    const name = String(err.name || "");
    const msg = String(err.message || "");
    return (
      name === "CheckoutConflictError" ||
      /would be overwritten by checkout/i.test(msg)
    );
  }

  async function checkoutBranch(id, name, { force = false } = {}) {
    const dir = textDir(id);
    const ref = String(name || "").trim();
    if (!ref) throw new Error("Branch name required");
    const contentDirty = await isDirty(id);
    // Keep title.txt (untracked) across checkout; reset meta noise so git
    // checkout does not refuse when only updatedAt/activeBranch differ.
    const preservedTitle = await readTitleFile(dir);
    const preservedCustom = normalizeMeta(
      await readJson(`${dir}/meta.json`, null),
      id
    ).customTitle;
    if (!contentDirty) {
      await restoreMetaFromHead(dir);
    }
    try {
      await git.checkout({ fs, dir, ref, force: !!force });
    } catch (err) {
      if (!force && isCheckoutConflictError(err)) {
        const conflict = new Error(
          err.message || "Local changes would be overwritten by checkout"
        );
        conflict.code = "CHECKOUT_CONFLICT";
        conflict.cause = err;
        throw conflict;
      }
      throw err;
    }
    if (preservedTitle) {
      await writeTitleFile(dir, preservedTitle);
    }
    await touchBranchAccess(dir, ref);
    await saveWorkingTree(id, {
      activeBranch: ref,
      hasConflict: false,
      pendingMerge: null,
      customTitle: preservedCustom,
      ...(preservedCustom && preservedTitle ? { title: preservedTitle } : {}),
    });
    await flush();
    return readWorkingFiles(id);
  }

  async function deleteBranch(id, name) {
    const dir = textDir(id);
    const ref = String(name || "").trim();
    if (!ref) throw new Error("Branch name required");
    const cur = await currentBranch(id);
    if (cur === ref) throw new Error("Cannot delete the current branch");
    await git.deleteBranch({ fs, dir, ref });
    const access = await readBranchAccess(dir);
    if (access[ref] != null) {
      delete access[ref];
      await writeBranchAccess(dir, access);
    }
    await flush();
  }

  /** Boolean marks that stack (bold∪underline). */
  const ORTHOGONAL_MARK_TYPES = ["bold", "italic", "underline", "strike"];
  const MARK_FROM_TAG = {
    STRONG: "bold",
    B: "bold",
    EM: "italic",
    I: "italic",
    U: "underline",
    S: "strike",
    STRIKE: "strike",
  };
  const MARK_TO_TAG = {
    bold: "strong",
    italic: "em",
    underline: "u",
    strike: "s",
    highlight: "mark",
  };

  function normalizeColorWithAlpha(raw) {
    if (/^#[0-9a-fA-F]{8}$/.test(raw)) return raw.toLowerCase();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return `${raw.toLowerCase()}ff`;
    const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:,\s*([\d.]+))?\)/i.exec(raw);
    if (rgba) {
      const hex = (n) => Number(n).toString(16).padStart(2, "0");
      const alpha =
        rgba[4] != null
          ? Math.round(Number(rgba[4]) * 255)
              .toString(16)
              .padStart(2, "0")
          : "ff";
      return `#${hex(rgba[1])}${hex(rgba[2])}${hex(rgba[3])}${alpha}`.toLowerCase();
    }
    return raw;
  }

  /**
   * Exclusive valued marks: one value per char; both-sides clash → format conflict.
   * Add a type here (normalize + wrapHtml + parseFromStyle) for new valued styles.
   */
  const EXCLUSIVE_MARKS = {
    color: {
      normalize(value) {
        const raw = String(value || "").trim();
        if (!raw) return null;
        if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
        if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
          const r = raw[1];
          const g = raw[2];
          const b = raw[3];
          return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
        }
        const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
        if (rgb) {
          const hex = (n) => Number(n).toString(16).padStart(2, "0");
          return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
        }
        return raw.toLowerCase();
      },
      wrapHtml(inner, value) {
        const color = String(value || "").replace(/"/g, "");
        return `<span style="color: ${color}">${inner}</span>`;
      },
      parseFromStyle(styleText) {
        const m = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(styleText || "");
        return m ? m[1].trim() : null;
      },
      parseFromOpenTag(chunk) {
        const attr = /\bcolor\s*=\s*(["'])(.*?)\1/i.exec(chunk);
        return attr ? attr[2].trim() : null;
      },
    },
    fontSize: {
      normalize(value) {
        const raw = String(value || "").trim().toLowerCase();
        if (!raw) return null;
        if (/^\d+(\.\d+)?$/.test(raw)) return `${raw}pt`;
        const m = /^(\d+(\.\d+)?)(px|pt|em|rem|%)$/.exec(raw);
        if (m) return `${m[1]}${m[3]}`;
        return raw.replace(/\s+/g, "");
      },
      wrapHtml(inner, value) {
        const size = String(value || "").replace(/"/g, "");
        return `<span style="font-size: ${size}">${inner}</span>`;
      },
      parseFromStyle(styleText) {
        const m = /(?:^|;)\s*font-size\s*:\s*([^;]+)/i.exec(styleText || "");
        return m ? m[1].trim() : null;
      },
    },
    fontFamily: {
      normalize(value) {
        let raw = String(value || "").trim();
        if (!raw) return null;
        raw = raw
          .replace(/\s*,\s*/g, ", ")
          .replace(/\s+/g, " ")
          .replace(/["']/g, "")
          .toLowerCase();
        return raw || null;
      },
      wrapHtml(inner, value) {
        const family = String(value || "").replace(/"/g, "'");
        return `<span style="font-family: ${family}">${inner}</span>`;
      },
      parseFromStyle(styleText) {
        const m = /(?:^|;)\s*font-family\s*:\s*([^;]+)/i.exec(styleText || "");
        return m ? m[1].trim() : null;
      },
      parseFromOpenTag(chunk) {
        const attr = /\bface\s*=\s*(["'])(.*?)\1/i.exec(chunk);
        return attr ? attr[2].trim() : null;
      },
    },
    link: {
      normalize(value) {
        const href = String(value || "").trim();
        return /^(https?:|mailto:|#|\/)/i.test(href) ? href : null;
      },
      wrapHtml(inner, value) {
        const href = String(value || "").replace(/"/g, "&quot;");
        return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${inner}</a>`;
      },
      parseFromOpenTag(chunk) {
        const attr = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(chunk);
        return attr ? attr[2].trim() : null;
      },
    },
    highlight: {
      normalize(value) {
        const raw = String(value || "").trim();
        if (!raw) return null;
        return normalizeColorWithAlpha(raw);
      },
      wrapHtml(inner, value) {
        return `<mark style="background-color: ${value}">${inner}</mark>`;
      },
      parseFromStyle(styleText) {
        const m = /(?:^|;)\s*background-color\s*:\s*([^;]+)/i.exec(styleText || "");
        return m ? m[1].trim() : null;
      },
    },
  };
  const EXCLUSIVE_MARK_TYPES = Object.keys(EXCLUSIVE_MARKS);

  function escapeHtmlText(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function normalizeExclusiveValue(type, value) {
    const spec = EXCLUSIVE_MARKS[type];
    if (!spec || value == null || value === "") return null;
    return spec.normalize(value);
  }

  function isExclusiveMarkType(type) {
    return Object.prototype.hasOwnProperty.call(EXCLUSIVE_MARKS, type);
  }

  /** Pull exclusive mark values from an open tag (style + presentational attrs). */
  function exclusiveAttrsFromOpenTag(chunk) {
    const found = [];
    const style = /\bstyle\s*=\s*(["'])(.*?)\1/i.exec(chunk);
    const styleText = style ? style[2] : "";
    for (const type of EXCLUSIVE_MARK_TYPES) {
      const spec = EXCLUSIVE_MARKS[type];
      let raw = spec.parseFromStyle?.(styleText) ?? null;
      if (raw == null) raw = spec.parseFromOpenTag?.(chunk) ?? null;
      const value = normalizeExclusiveValue(type, raw);
      if (value) found.push({ type, value });
    }
    return found;
  }

  /** Plain word/whitespace tokens + char starts (no HTML). */
  function tokenizePlain(plain) {
    const text = String(plain ?? "");
    const tokens = text.match(/\S+|\s+/g) || [];
    const starts = [];
    let pos = 0;
    for (const t of tokens) {
      starts.push(pos);
      pos += t.length;
    }
    return { plain: text, tokens, starts };
  }

  function tokenCharRange(tok, lo, hi) {
    if (lo >= hi) {
      const at = lo < tok.starts.length ? tok.starts[lo] : tok.plain.length;
      return [at, at];
    }
    const from = tok.starts[lo];
    const lastStart = tok.starts[hi - 1];
    return [from, lastStart + tok.tokens[hi - 1].length];
  }

  function sameTokens(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function compressOrthogonalRuns(flagsByType, length) {
    const marks = [];
    for (const type of ORTHOGONAL_MARK_TYPES) {
      const flags = flagsByType[type];
      let i = 0;
      while (i < length) {
        if (!flags[i]) {
          i++;
          continue;
        }
        let j = i + 1;
        while (j < length && flags[j]) j++;
        marks.push({ from: i, to: j, type });
        i = j;
      }
    }
    return marks;
  }

  function compressExclusiveRuns(type, values, length) {
    const marks = [];
    let i = 0;
    while (i < length) {
      const value = values[i];
      if (!value) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < length && values[j] === value) j++;
      marks.push({ from: i, to: j, type, value });
      i = j;
    }
    return marks;
  }

  function markPresence(marks, type, length) {
    const flags = new Array(length).fill(false);
    for (const m of marks) {
      if (m.type !== type) continue;
      const a = Math.max(0, m.from);
      const b = Math.min(length, m.to);
      for (let i = a; i < b; i++) flags[i] = true;
    }
    return flags;
  }

  function markExclusiveValues(marks, type, length) {
    const values = new Array(length).fill(null);
    for (const m of marks) {
      if (m.type !== type || m.value == null) continue;
      const value = normalizeExclusiveValue(type, m.value);
      if (!value) continue;
      const a = Math.max(0, m.from);
      const b = Math.min(length, m.to);
      for (let i = a; i < b; i++) values[i] = value;
    }
    return values;
  }

  function mergeOrthogonalMarksEqualPlain(baseMarks, oursMarks, theirsMarks, length) {
    const flagsByType = {};
    for (const type of ORTHOGONAL_MARK_TYPES) {
      const b = markPresence(baseMarks, type, length);
      const o = markPresence(oursMarks, type, length);
      const t = markPresence(theirsMarks, type, length);
      const out = new Array(length).fill(false);
      for (let i = 0; i < length; i++) {
        if (o[i] === t[i]) out[i] = o[i];
        else if (o[i] === b[i]) out[i] = t[i];
        else if (t[i] === b[i]) out[i] = o[i];
        else out[i] = o[i] || t[i];
      }
      flagsByType[type] = out;
    }
    return compressOrthogonalRuns(flagsByType, length);
  }

  /** 3-way exclusive values; conflict when both sides changed away from base differently. */
  function resolveExclusivePerChar(baseVals, oursVals, theirsVals, length) {
    const auto = new Array(length).fill(null);
    const conflict = new Array(length).fill(false);
    for (let i = 0; i < length; i++) {
      const b = baseVals[i];
      const o = oursVals[i];
      const t = theirsVals[i];
      if (o === t) auto[i] = o;
      else if (o === b) auto[i] = t;
      else if (t === b) auto[i] = o;
      else conflict[i] = true;
    }
    return { auto, conflict };
  }

  function clipMarks(marks, from, to) {
    const out = [];
    for (const m of marks) {
      const a = Math.max(m.from, from);
      const b = Math.min(m.to, to);
      if (a < b) {
        const clipped = { from: a - from, to: b - from, type: m.type };
        if (m.value != null) clipped.value = m.value;
        out.push(clipped);
      }
    }
    return out;
  }

  function exclusiveMarksOnly(marks) {
    return (marks || []).filter((m) => isExclusiveMarkType(m.type));
  }

  function markMaps(marks, length) {
    const ortho = Object.create(null);
    for (const type of ORTHOGONAL_MARK_TYPES) {
      ortho[type] = markPresence(marks, type, length);
    }
    const exclusive = Object.create(null);
    for (const type of EXCLUSIVE_MARK_TYPES) {
      exclusive[type] = markExclusiveValues(marks, type, length);
    }
    return { ortho, exclusive };
  }

  function oursTheirsMarksDiffer(i, oursMaps, theirsMaps) {
    for (const type of ORTHOGONAL_MARK_TYPES) {
      if (oursMaps.ortho[type][i] !== theirsMaps.ortho[type][i]) return true;
    }
    for (const type of EXCLUSIVE_MARK_TYPES) {
      if (oursMaps.exclusive[type][i] !== theirsMaps.exclusive[type][i]) {
        return true;
      }
    }
    return false;
  }

  /**
   * Equal plain text → clean text segments and format-only conflicts.
   * Live merge: exclusive both-changed clashes; orthogonal always auto-union.
   * Review: any ours≠theirs mark (orthogonal or exclusive) is a format conflict.
   */
  function equalPlainMergeSegments(
    plain,
    baseMarks,
    oursMarks,
    theirsMarks,
    labelOurs,
    labelTheirs,
    review = false
  ) {
    const length = plain.length;
    if (!length) return { cleanMerge: true, segments: [] };

    const ortho = mergeOrthogonalMarksEqualPlain(
      baseMarks,
      oursMarks,
      theirsMarks,
      length
    );
    const exclusiveAuto = Object.create(null);
    const exclusiveConflict = Object.create(null);
    for (const type of EXCLUSIVE_MARK_TYPES) {
      const resolved = resolveExclusivePerChar(
        markExclusiveValues(baseMarks, type, length),
        markExclusiveValues(oursMarks, type, length),
        markExclusiveValues(theirsMarks, type, length),
        length
      );
      exclusiveAuto[type] = resolved.auto;
      exclusiveConflict[type] = resolved.conflict;
    }

    const oursMaps = review ? markMaps(oursMarks, length) : null;
    const theirsMaps = review ? markMaps(theirsMarks, length) : null;

    function charHasExclusiveConflict(i) {
      for (const type of EXCLUSIVE_MARK_TYPES) {
        if (exclusiveConflict[type][i]) return true;
      }
      return false;
    }

    function charHasConflict(i) {
      if (review) return oursTheirsMarksDiffer(i, oursMaps, theirsMaps);
      return charHasExclusiveConflict(i);
    }

    const segments = [];
    let anyConflict = false;
    let i = 0;
    while (i < length) {
      const isConflict = charHasConflict(i);
      let j = i + 1;
      while (j < length && charHasConflict(j) === isConflict) j++;
      const slicePlain = plain.slice(i, j);
      const orthoSlice = clipMarks(ortho, i, j);

      if (!isConflict) {
        let marks = orthoSlice;
        for (const type of EXCLUSIVE_MARK_TYPES) {
          marks = marks.concat(
            compressExclusiveRuns(type, exclusiveAuto[type].slice(i, j), j - i)
          );
        }
        segments.push({ type: "text", plain: slicePlain, marks });
      } else {
        anyConflict = true;
        segments.push({
          type: "conflict",
          labelOurs,
          labelTheirs,
          ours: {
            plain: slicePlain,
            marks: review
              ? clipMarks(oursMarks, i, j)
              : orthoSlice.concat(exclusiveMarksOnly(clipMarks(oursMarks, i, j))),
          },
          theirs: {
            plain: slicePlain,
            marks: review
              ? clipMarks(theirsMarks, i, j)
              : orthoSlice.concat(
                  exclusiveMarksOnly(clipMarks(theirsMarks, i, j))
                ),
          },
        });
      }
      i = j;
    }
    return { cleanMerge: !anyConflict, segments };
  }

  /**
   * TipTap-ish HTML → plain + mark ranges (orthogonal + exclusive valued).
   */
  function htmlToPlainAndMarks(html) {
    const raw = String(html ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/>\s*\n\s*</g, "><");
    if (!raw) return { plain: "", marks: [], blockAligns: [] };

    let plain = "";
    const openMarks = Object.create(null);
    const exclusiveStacks = Object.create(null);
    for (const type of EXCLUSIVE_MARK_TYPES) exclusiveStacks[type] = [];
    /** @type {string[][]} types opened by each SPAN/FONT */
    const spanExclusiveOpened = [];
    const finished = [];
    const blockAligns = [];
    let blockCount = 0;
    let listDepth = 0;
    let liIndex = 0;

    function openMark(type) {
      if (openMarks[type] == null) openMarks[type] = plain.length;
    }

    function closeMark(type) {
      const startOff = openMarks[type];
      if (startOff == null) return;
      if (startOff < plain.length) {
        finished.push({ from: startOff, to: plain.length, type });
      }
      delete openMarks[type];
    }

    function closeExclusive(type) {
      const stack = exclusiveStacks[type];
      const cur = stack.pop();
      if (!cur) return;
      if (cur.start < plain.length) {
        finished.push({
          from: cur.start,
          to: plain.length,
          type,
          value: cur.value,
        });
      }
      if (stack.length) stack[stack.length - 1].start = plain.length;
    }

    function openExclusive(type, value) {
      const normalized = normalizeExclusiveValue(type, value);
      if (!normalized) return;
      const stack = exclusiveStacks[type];
      if (stack.length) {
        const cur = stack[stack.length - 1];
        if (cur.start < plain.length) {
          finished.push({
            from: cur.start,
            to: plain.length,
            type,
            value: cur.value,
          });
        }
      }
      stack.push({ value: normalized, start: plain.length });
    }

    function closeAllMarks() {
      for (const type of EXCLUSIVE_MARK_TYPES) {
        while (exclusiveStacks[type].length) closeExclusive(type);
      }
      spanExclusiveOpened.length = 0;
      for (const type of ORTHOGONAL_MARK_TYPES) {
        if (openMarks[type] != null) closeMark(type);
      }
    }

    const re = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const chunk = m[0];
      if (chunk.startsWith("<!--")) continue;
      if (chunk[0] !== "<") {
        plain += asPlain(decodeHtmlEntities(chunk.replace(/\u00a0/g, " ")));
        continue;
      }
      const close = /^<\/\s*([a-zA-Z0-9]+)/i.exec(chunk);
      if (close) {
        const name = close[1].toUpperCase();
        if (name === "P" || name === "DIV") {
          closeAllMarks();
          continue;
        }
        if (name === "UL" || name === "OL") {
          closeAllMarks();
          listDepth = Math.max(0, listDepth - 1);
          if (listDepth === 0) liIndex = 0;
          continue;
        }
        if (name === "LI") {
          closeAllMarks();
          continue;
        }
        if (name === "SPAN" || name === "FONT") {
          const opened = spanExclusiveOpened.pop() || [];
          for (let k = opened.length - 1; k >= 0; k--) closeExclusive(opened[k]);
          continue;
        }
        if (name === "A") {
          closeExclusive("link");
          continue;
        }
        if (name === "MARK") {
          closeExclusive("highlight");
          continue;
        }
        const mt = MARK_FROM_TAG[name];
        if (mt) closeMark(mt);
        continue;
      }
      const open = /^<\s*([a-zA-Z0-9]+)/i.exec(chunk);
      if (!open) continue;
      const name = open[1].toUpperCase();
      if (name === "BR") {
        plain += "\n";
        continue;
      }
      if (name === "P" || name === "DIV") {
        if (listDepth === 0 && blockCount > 0) {
          closeAllMarks();
          plain += "\n\n";
        }
        blockAligns.push(parseTextAlignFromOpenTag(chunk));
        blockCount++;
        continue;
      }
      if (name === "UL" || name === "OL") {
        if (listDepth === 0 && blockCount > 0) {
          closeAllMarks();
          plain += "\n\n";
        }
        listDepth++;
        liIndex = 0;
        if (listDepth === 1) {
          blockAligns.push("left");
          blockCount++;
        }
        continue;
      }
      if (name === "LI") {
        if (liIndex > 0) {
          closeAllMarks();
          plain += "\n";
        }
        liIndex++;
        continue;
      }
      if ((name === "SPAN" || name === "FONT") && !/\/>$/.test(chunk)) {
        const attrs = exclusiveAttrsFromOpenTag(chunk);
        const opened = [];
        for (const attr of attrs) {
          openExclusive(attr.type, attr.value);
          opened.push(attr.type);
        }
        spanExclusiveOpened.push(opened);
        continue;
      }
      if (name === "A" && !/\/>$/.test(chunk)) {
        openExclusive("link", EXCLUSIVE_MARKS.link.parseFromOpenTag(chunk));
        continue;
      }
      if (name === "MARK" && !/\/>$/.test(chunk)) {
        const style = /\bstyle\s*=\s*(["'])(.*?)\1/i.exec(chunk);
        const styleText = style ? style[2] : "";
        const bg = EXCLUSIVE_MARKS.highlight.parseFromStyle(styleText);
        openExclusive("highlight", bg || "#75720c");
        continue;
      }
      const mt = MARK_FROM_TAG[name];
      if (mt && !/\/>$/.test(chunk)) openMark(mt);
    }
    closeAllMarks();

    const byType = Object.create(null);
    for (const mark of finished) {
      if (!byType[mark.type]) byType[mark.type] = [];
      byType[mark.type].push({ ...mark });
    }
    const merged = [];
    for (const type of ORTHOGONAL_MARK_TYPES) {
      const list = (byType[type] || []).sort((a, b) => a.from - b.from);
      let cur = null;
      for (const mark of list) {
        if (cur && mark.from <= cur.to) {
          cur.to = Math.max(cur.to, mark.to);
        } else {
          cur = { ...mark };
          merged.push(cur);
        }
      }
    }
    for (const type of EXCLUSIVE_MARK_TYPES) {
      const list = (byType[type] || []).sort((a, b) => a.from - b.from);
      let cur = null;
      for (const mark of list) {
        if (cur && mark.from <= cur.to && mark.value === cur.value) {
          cur.to = Math.max(cur.to, mark.to);
        } else {
          cur = { ...mark };
          merged.push(cur);
        }
      }
    }
    return { plain, marks: merged, blockAligns };
  }

  function wrapMarkHtml(type, inner, value) {
    const exclusive = EXCLUSIVE_MARKS[type];
    if (exclusive) return exclusive.wrapHtml(inner, value);
    const tag = MARK_TO_TAG[type];
    return `<${tag}>${inner}</${tag}>`;
  }

  /** Render plain[from:to) with marks (absolute offsets into plain). */
  function renderPlainSlice(plain, marks, from, to) {
    const text = plain.slice(from, to);
    if (!text) return "";
    const localMarks = clipMarks(marks, from, to);
    const len = text.length;
    const bounds = new Set([0, len]);
    for (const mk of localMarks) {
      bounds.add(mk.from);
      bounds.add(mk.to);
    }
    const points = [...bounds].sort((a, b) => a - b);
    let html = "";
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a >= b) continue;
      let chunk = escapeHtmlText(text.slice(a, b)).replace(/\n/g, "<br>");
      const active = localMarks.filter((mk) => mk.from <= a && mk.to >= b);
      for (let k = ORTHOGONAL_MARK_TYPES.length - 1; k >= 0; k--) {
        const type = ORTHOGONAL_MARK_TYPES[k];
        if (active.some((mk) => mk.type === type)) chunk = wrapMarkHtml(type, chunk);
      }
      for (let k = EXCLUSIVE_MARK_TYPES.length - 1; k >= 0; k--) {
        const type = EXCLUSIVE_MARK_TYPES[k];
        const exclusiveMark = active.find((mk) => mk.type === type && mk.value);
        if (exclusiveMark) {
          chunk = wrapMarkHtml(type, chunk, exclusiveMark.value);
        }
      }
      html += chunk;
    }
    return html;
  }

  function marksDifferPair(bI, cI, baseMaps, curMaps) {
    for (const type of ORTHOGONAL_MARK_TYPES) {
      if (baseMaps.ortho[type][bI] !== curMaps.ortho[type][cI]) return true;
    }
    for (const type of EXCLUSIVE_MARK_TYPES) {
      if (baseMaps.exclusive[type][bI] !== curMaps.exclusive[type][cI]) {
        return true;
      }
    }
    return false;
  }

  /**
   * After a plain DIFF (0=eq, 1=ins, -1=del), find equal-text runs whose marks
   * differ. Offsets are in current-plain (same as overlay getText).
   */
  function formatHunksFromDiff(baseHtml, currentHtml, parts) {
    const DIFF_EQUAL = 0;
    const DIFF_INSERT = 1;
    const DIFF_DELETE = -1;
    const baseDoc = htmlToPlainAndMarks(baseHtml);
    const curDoc = htmlToPlainAndMarks(currentHtml);
    let ops = parts;
    if (!ops || !ops.length) {
      if (baseDoc.plain && baseDoc.plain === curDoc.plain) {
        ops = [[DIFF_EQUAL, curDoc.plain]];
      } else {
        return [];
      }
    }
    const baseMaps = markMaps(baseDoc.marks, baseDoc.plain.length);
    const curMaps = markMaps(curDoc.marks, curDoc.plain.length);
    const hunks = [];
    let bPos = 0;
    let cPos = 0;
    for (const part of ops) {
      const op = part[0];
      const text = String(part[1] ?? "");
      const n = text.length;
      if (op === DIFF_EQUAL) {
        if (
          text.trim() &&
          baseDoc.plain.slice(bPos, bPos + n) === text &&
          curDoc.plain.slice(cPos, cPos + n) === text
        ) {
          let i = 0;
          while (i < n) {
            const differ = marksDifferPair(
              bPos + i,
              cPos + i,
              baseMaps,
              curMaps
            );
            let j = i + 1;
            while (
              j < n &&
              marksDifferPair(bPos + j, cPos + j, baseMaps, curMaps) === differ
            ) {
              j++;
            }
            if (differ && text.slice(i, j).trim()) {
              hunks.push({
                from: cPos + i,
                to: cPos + j,
                oldHtml: renderPlainSlice(
                  baseDoc.plain,
                  baseDoc.marks,
                  bPos + i,
                  bPos + j
                ),
              });
            }
            i = j;
          }
        }
        bPos += n;
        cPos += n;
      } else if (op === DIFF_INSERT) {
        cPos += n;
      } else if (op === DIFF_DELETE) {
        bPos += n;
      }
    }
    return hunks;
  }

  function plainAndMarksToHtml(plain, marks) {
    const text = String(plain ?? "");
    if (!text) return "<p></p>";
    const parts = [];
    const seps = [];
    const re = /\n\n+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      seps.push([m.index, m.index + m[0].length]);
    }
    seps.push([text.length, text.length]);
    let prev = 0;
    for (const [sepStart, sepEnd] of seps) {
      parts.push(
        `<p>${renderPlainSlice(text, marks, prev, sepStart) || "<br>"}</p>`
      );
      prev = sepEnd;
      if (sepStart === text.length) break;
    }
    return parts.join("\n");
  }

  /** Join replacements separated only by whitespace. */
  function coalesceWhitespaceReps(baseToks, reps) {
    if (reps.length < 2) return reps;
    const out = [
      {
        baseLo: reps[0].baseLo,
        baseHi: reps[0].baseHi,
        sideLo: reps[0].sideLo,
        sideHi: reps[0].sideHi,
        out: reps[0].out.slice(),
      },
    ];
    for (let i = 1; i < reps.length; i++) {
      const prev = out[out.length - 1];
      const cur = reps[i];
      const gap = baseToks.slice(prev.baseHi, cur.baseLo);
      if (gap.every((t) => /^\s*$/.test(t))) {
        prev.out.push(...gap, ...cur.out);
        prev.baseHi = cur.baseHi;
        prev.sideHi = cur.sideHi;
      } else {
        out.push({
          baseLo: cur.baseLo,
          baseHi: cur.baseHi,
          sideLo: cur.sideLo,
          sideHi: cur.sideHi,
          out: cur.out.slice(),
        });
      }
    }
    return out;
  }

  /** Myers diff → [{ kind: 'eq'|'del'|'ins', tokens }] */
  function diffTokens(oldToks, newToks) {
    const n = oldToks.length;
    const m = newToks.length;
    if (!n && !m) return [];
    if (!n) return [{ kind: "ins", tokens: newToks.slice() }];
    if (!m) return [{ kind: "del", tokens: oldToks.slice() }];

    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 1);
    v.fill(-1);
    v[offset + 1] = 0;
    const trace = [];

    outer: for (let d = 0; d <= max; d++) {
      trace.push(Int32Array.from(v));
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
          x = v[offset + k + 1];
        } else {
          x = v[offset + k - 1] + 1;
        }
        let y = x - k;
        while (x < n && y < m && oldToks[x] === newToks[y]) {
          x++;
          y++;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) break outer;
      }
    }

    const opsRev = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
      const vPrev = trace[d];
      const k = x - y;
      let prevK;
      if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      const prevX = vPrev[offset + prevK];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        opsRev.push({ kind: "eq", tokens: [oldToks[x - 1]] });
        x--;
        y--;
      }
      if (d === 0) break;
      if (x === prevX) {
        opsRev.push({ kind: "ins", tokens: [newToks[y - 1]] });
        y--;
      } else {
        opsRev.push({ kind: "del", tokens: [oldToks[x - 1]] });
        x--;
      }
    }

    opsRev.reverse();
    const ops = [];
    for (const op of opsRev) {
      const last = ops[ops.length - 1];
      if (last && last.kind === op.kind) last.tokens.push(op.tokens[0]);
      else ops.push({ kind: op.kind, tokens: op.tokens.slice() });
    }
    return ops;
  }

  /** Replacements on base + side token axes. */
  function replacementsFromDiff(baseToks, sideToks) {
    const ops = diffTokens(baseToks, sideToks);
    const reps = [];
    let bi = 0;
    let si = 0;
    let pending = null;
    for (const op of ops) {
      if (op.kind === "eq") {
        if (pending) {
          reps.push(pending);
          pending = null;
        }
        bi += op.tokens.length;
        si += op.tokens.length;
      } else if (op.kind === "del") {
        if (!pending) {
          pending = { baseLo: bi, baseHi: bi, sideLo: si, sideHi: si, out: [] };
        }
        pending.baseHi += op.tokens.length;
        bi += op.tokens.length;
      } else if (op.kind === "ins") {
        if (!pending) {
          pending = { baseLo: bi, baseHi: bi, sideLo: si, sideHi: si, out: [] };
        }
        pending.out.push(...op.tokens);
        pending.sideHi += op.tokens.length;
        si += op.tokens.length;
      }
    }
    if (pending) reps.push(pending);
    return reps;
  }

  function blocksFromDoc(doc) {
    const plain = String(doc?.plain ?? "");
    const aligns = (doc?.blockAligns || []).slice();
    if (!plain && !aligns.length) return [];
    const plains = plain ? plain.split(/\n\n+/) : [""];
    while (aligns.length < plains.length) aligns.push("left");
    return plains.map((p, i) => ({ plain: p, align: aligns[i] || "left" }));
  }

  function threeWayAlignDecision(
    baseAlign,
    oursBlock,
    theirsBlock,
    labelOurs,
    labelTheirs,
    review = false
  ) {
    const b = baseAlign || "left";
    const o = (oursBlock && oursBlock.align) || "left";
    const t = (theirsBlock && theirsBlock.align) || "left";
    const decision = {
      align: o,
      conflict: false,
      oursPlain: oursBlock ? oursBlock.plain : "",
      theirsPlain: theirsBlock ? theirsBlock.plain : "",
    };
    if (o === t) {
      decision.align = o;
      return decision;
    }
    if (review || (o !== b && t !== b)) {
      decision.conflict = true;
      decision.align = o;
      decision.oursAlign = o;
      decision.theirsAlign = t;
      decision.labelOurs = labelOurs;
      decision.labelTheirs = labelTheirs;
      return decision;
    }
    if (o === b) {
      decision.align = t;
      return decision;
    }
    decision.align = o;
    return decision;
  }

  function findBaseAlign(baseBlocks, oursBlock, theirsBlock) {
    if (!baseBlocks.length) return "left";
    const byOurs = baseBlocks.find((x) => x.plain === oursBlock.plain);
    if (byOurs) return byOurs.align;
    const byTheirs = baseBlocks.find((x) => x.plain === theirsBlock.plain);
    if (byTheirs) return byTheirs.align;
    return "left";
  }

  /** Pair ours/theirs paragraphs via sequence diff; 3-way resolve text-align. */
  function matchParagraphAlignDecisions(
    baseDoc,
    oursDoc,
    theirsDoc,
    labelOurs,
    labelTheirs,
    review = false
  ) {
    const base = blocksFromDoc(baseDoc);
    const ours = blocksFromDoc(oursDoc);
    const theirs = blocksFromDoc(theirsDoc);
    if (!ours.length && !theirs.length) return [];

    if (ours.length === theirs.length && (base.length === ours.length || !base.length)) {
      return ours.map((o, i) =>
        threeWayAlignDecision(
          base[i] ? base[i].align : "left",
          o,
          theirs[i],
          labelOurs,
          labelTheirs,
          review
        )
      );
    }

    if (ours.length === theirs.length) {
      return ours.map((o, i) =>
        threeWayAlignDecision(
          findBaseAlign(base, o, theirs[i]),
          o,
          theirs[i],
          labelOurs,
          labelTheirs,
          review
        )
      );
    }

    const pairs = [];
    const ops = diffTokens(
      ours.map((b) => b.plain),
      theirs.map((b) => b.plain)
    );
    let oi = 0;
    let ti = 0;
    let i = 0;
    while (i < ops.length) {
      const op = ops[i];
      if (op.kind === "eq") {
        for (let k = 0; k < op.tokens.length; k++) {
          const o = ours[oi++];
          const t = theirs[ti++];
          pairs.push(
            threeWayAlignDecision(
              findBaseAlign(base, o, t),
              o,
              t,
              labelOurs,
              labelTheirs,
              review
            )
          );
        }
        i++;
      } else if (op.kind === "del" && i + 1 < ops.length && ops[i + 1].kind === "ins") {
        const nDel = op.tokens.length;
        const nIns = ops[i + 1].tokens.length;
        const n = Math.min(nDel, nIns);
        for (let k = 0; k < n; k++) {
          const o = ours[oi + k];
          const t = theirs[ti + k];
          pairs.push(
            threeWayAlignDecision(
              findBaseAlign(base, o, t),
              o,
              t,
              labelOurs,
              labelTheirs,
              review
            )
          );
        }
        oi += nDel;
        ti += nIns;
        i += 2;
      } else if (op.kind === "del") {
        oi += op.tokens.length;
        i++;
      } else {
        ti += op.tokens.length;
        i++;
      }
    }
    return pairs;
  }

  function mergedPlainFromSegments(segments) {
    let plain = "";
    for (const seg of segments) {
      if (seg.type === "conflict") plain += seg.ours?.plain || "";
      else plain += seg.plain || "";
    }
    return plain;
  }

  function alignMetaForSegments(segments, decisions) {
    const mergedPlain = mergedPlainFromSegments(segments);
    const outPlains = mergedPlain ? mergedPlain.split(/\n\n+/) : [];
    if (!outPlains.length && decisions.length) {
      return decisions.map((d) => ({ ...d }));
    }
    const byOurs = new Map();
    const byTheirs = new Map();
    for (const d of decisions) {
      if (d.oursPlain != null) byOurs.set(d.oursPlain, d);
      if (d.theirsPlain != null) byTheirs.set(d.theirsPlain, d);
    }
    return outPlains.map((plain, idx) => {
      const d = byOurs.get(plain) || byTheirs.get(plain) || decisions[idx];
      if (!d) return { align: "left", conflict: false };
      return d;
    });
  }

  function openParagraphTag(meta) {
    const align = (meta && meta.align) || "left";
    let tag = "<p";
    if (meta && meta.conflict) {
      tag += ` style="text-align: ${align}"`;
      tag += ` data-kindred-align-ours="${escapeHtmlAttr(meta.oursAlign || align)}"`;
      tag += ` data-kindred-align-theirs="${escapeHtmlAttr(meta.theirsAlign || "")}"`;
      tag += ` data-kindred-align-label-ours="${escapeHtmlAttr(meta.labelOurs || "")}"`;
      tag += ` data-kindred-align-label-theirs="${escapeHtmlAttr(meta.labelTheirs || "")}"`;
    } else if (align && align !== "left") {
      tag += ` style="text-align: ${align}"`;
    }
    return `${tag}>`;
  }

  function finishMergeWithAlign(
    baseDoc,
    oursDoc,
    theirsDoc,
    segments,
    cleanMerge,
    labelOurs,
    labelTheirs,
    review = false
  ) {
    const decisions = matchParagraphAlignDecisions(
      baseDoc,
      oursDoc,
      theirsDoc,
      labelOurs,
      labelTheirs,
      review
    );
    const alignMeta = alignMetaForSegments(segments, decisions);
    const anyAlignConflict = alignMeta.some((m) => m && m.conflict);
    return {
      cleanMerge: cleanMerge && !anyAlignConflict,
      mergedText: serializeMergeSegments(segments, alignMeta),
    };
  }

  /** base token index → side char offset at that boundary. */
  function baseTokToSideChar(baseTok, sideTok) {
    const ops = diffTokens(baseTok.tokens, sideTok.tokens);
    const map = new Int32Array(baseTok.tokens.length + 1);
    let bi = 0;
    let si = 0;
    let sc = 0;
    for (const op of ops) {
      if (op.kind === "eq") {
        for (let i = 0; i < op.tokens.length; i++) {
          map[bi] = sc;
          sc += sideTok.tokens[si].length;
          bi++;
          si++;
        }
      } else if (op.kind === "del") {
        for (let i = 0; i < op.tokens.length; i++) {
          map[bi] = sc;
          bi++;
        }
      } else if (op.kind === "ins") {
        for (let i = 0; i < op.tokens.length; i++) {
          sc += sideTok.tokens[si].length;
          si++;
        }
      }
    }
    map[bi] = sc;
    return map;
  }

  function sliceDoc(doc, tok, lo, hi) {
    const [c0, c1] = tokenCharRange(tok, lo, hi);
    return {
      plain: doc.plain.slice(c0, c1),
      marks: clipMarks(doc.marks, c0, c1),
    };
  }

  function sliceForOut(doc, tok, map, clusterLo, clusterHi, sideLo, sideHi, outTokens) {
    const plain = outTokens.join("");
    if (sideHi >= sideLo) {
      const direct = sliceDoc(doc, tok, sideLo, sideHi);
      if (direct.plain === plain) return direct;
    }
    const c0 = map[clusterLo];
    const c1 = map[clusterHi];
    if (c1 >= c0 && doc.plain.slice(c0, c1) === plain) {
      return { plain, marks: clipMarks(doc.marks, c0, c1) };
    }
    if (doc.plain.slice(c0, c0 + plain.length) === plain) {
      return { plain, marks: clipMarks(doc.marks, c0, c0 + plain.length) };
    }
    return { plain, marks: [] };
  }

  function equalBaseRangeMerge(
    baseDoc,
    oursDoc,
    theirsDoc,
    baseTok,
    oursTok,
    theirsTok,
    baseLo,
    baseHi,
    labelOurs,
    labelTheirs,
    review = false
  ) {
    const [c0, c1] = tokenCharRange(baseTok, baseLo, baseHi);
    const len = c1 - c0;
    if (len <= 0) return { cleanMerge: true, segments: [] };
    const baseMarks = clipMarks(baseDoc.marks, c0, c1);
    const oMap = baseTokToSideChar(baseTok, oursTok);
    const tMap = baseTokToSideChar(baseTok, theirsTok);
    const o0 = oMap[baseLo];
    const o1 = oMap[baseHi];
    const t0 = tMap[baseLo];
    const t1 = tMap[baseHi];
    const oursMarks =
      o1 - o0 === len ? clipMarks(oursDoc.marks, o0, o1) : baseMarks;
    const theirsMarks =
      t1 - t0 === len ? clipMarks(theirsDoc.marks, t0, t1) : baseMarks;
    return equalPlainMergeSegments(
      baseDoc.plain.slice(c0, c1),
      baseMarks,
      oursMarks,
      theirsMarks,
      labelOurs,
      labelTheirs,
      review
    );
  }

  function serializeMergeSegments(segments, alignMeta) {
    let out = "";
    let paraOpen = false;
    let paraIndex = 0;
    function ensurePara() {
      if (!paraOpen) {
        if (out && !out.endsWith("\n")) out += "\n";
        out += openParagraphTag(alignMeta && alignMeta[paraIndex]);
        paraOpen = true;
      }
    }
    function closePara() {
      if (paraOpen) {
        out += "</p>";
        paraOpen = false;
        paraIndex++;
      }
    }
    for (const seg of segments) {
      if (seg.type === "conflict") {
        ensurePara();
        out += formatConflict(
          seg.labelOurs,
          renderPlainSlice(
            seg.ours.plain,
            seg.ours.marks,
            0,
            seg.ours.plain.length
          ),
          seg.labelTheirs,
          renderPlainSlice(
            seg.theirs.plain,
            seg.theirs.marks,
            0,
            seg.theirs.plain.length
          )
        );
        continue;
      }
      let offset = 0;
      let rest = seg.plain;
      while (rest.length) {
        const idx = rest.indexOf("\n\n");
        if (idx === -1) {
          ensurePara();
          out += renderPlainSlice(
            seg.plain,
            seg.marks,
            offset,
            offset + rest.length
          );
          break;
        }
        ensurePara();
        out += renderPlainSlice(seg.plain, seg.marks, offset, offset + idx);
        closePara();
        out += "\n";
        const skip = rest.slice(idx).match(/^\n\n+/)[0].length;
        offset += idx + skip;
        rest = seg.plain.slice(offset);
      }
    }
    closePara();
    return out || "<p></p>";
  }

  /**
   * 3-way merge: AST block aligner + leaf mark/token merge inside paragraphs.
   * Pass `{ leaf: true }` to skip the aligner (used when merging one block).
   */
  function mergeText(
    baseText,
    oursText,
    theirsText,
    labelOurs,
    labelTheirs,
    options = {}
  ) {
    const review = !!options.review;
    const baseHtml = baseText ?? "";
    const oursHtml = oursText ?? "";
    const theirsHtml = theirsText ?? "";
    if (oursHtml === theirsHtml) return { cleanMerge: true, mergedText: oursHtml, ops: [] };
    if (!review && oursHtml === baseHtml) {
      return { cleanMerge: true, mergedText: theirsHtml, ops: [] };
    }
    if (theirsHtml === baseHtml) {
      return { cleanMerge: true, mergedText: oursHtml, ops: [] };
    }
    if (!options.leaf) {
      return mergeHtmlViaAst(
        baseHtml,
        oursHtml,
        theirsHtml,
        labelOurs,
        labelTheirs,
        options,
        mergeFlatHtml
      );
    }
    return mergeFlatHtml(
      baseHtml,
      oursHtml,
      theirsHtml,
      labelOurs,
      labelTheirs,
      options
    );
  }

  /** Leaf merge: plain+marks 3-way (orthogonal union + exclusive format conflicts). */
  function mergeFlatHtml(
    baseText,
    oursText,
    theirsText,
    labelOurs,
    labelTheirs,
    options = {}
  ) {
    const review = !!options.review;
    const baseHtml = baseText ?? "";
    const oursHtml = oursText ?? "";
    const theirsHtml = theirsText ?? "";
    if (oursHtml === theirsHtml) return { cleanMerge: true, mergedText: oursHtml };
    if (!review && oursHtml === baseHtml) {
      return { cleanMerge: true, mergedText: theirsHtml };
    }
    if (theirsHtml === baseHtml) return { cleanMerge: true, mergedText: oursHtml };

    const baseDoc = htmlToPlainAndMarks(baseHtml);
    const oursDoc = htmlToPlainAndMarks(oursHtml);
    const theirsDoc = htmlToPlainAndMarks(theirsHtml);

    if (oursDoc.plain === theirsDoc.plain) {
      const baseMarks =
        baseDoc.plain === oursDoc.plain ? baseDoc.marks : [];
      const result = equalPlainMergeSegments(
        oursDoc.plain,
        baseMarks,
        oursDoc.marks,
        theirsDoc.marks,
        labelOurs,
        labelTheirs,
        review
      );
      return finishMergeWithAlign(
        baseDoc,
        oursDoc,
        theirsDoc,
        result.segments,
        result.cleanMerge,
        labelOurs,
        labelTheirs,
        review
      );
    }

    const baseTok = tokenizePlain(baseDoc.plain);
    const oursTok = tokenizePlain(oursDoc.plain);
    const theirsTok = tokenizePlain(theirsDoc.plain);
    const aReps = coalesceWhitespaceReps(
      baseTok.tokens,
      replacementsFromDiff(baseTok.tokens, oursTok.tokens)
    );
    const bReps = coalesceWhitespaceReps(
      baseTok.tokens,
      replacementsFromDiff(baseTok.tokens, theirsTok.tokens)
    );
    const oMap = baseTokToSideChar(baseTok, oursTok);
    const tMap = baseTokToSideChar(baseTok, theirsTok);

    const segments = [];
    let cleanMerge = true;
    let ai = 0;
    let bi = 0;
    let pos = 0;

    function overlaps(a, b) {
      return a.baseLo <= b.baseHi && b.baseLo <= a.baseHi;
    }

    function pushText(plain, marks) {
      if (!plain && !(marks && marks.length)) return;
      const last = segments[segments.length - 1];
      if (last && last.type === "text") {
        const origin = last.plain.length;
        last.plain += plain;
        for (const mk of marks || []) {
          const shifted = {
            from: mk.from + origin,
            to: mk.to + origin,
            type: mk.type,
          };
          if (mk.value != null) shifted.value = mk.value;
          last.marks.push(shifted);
        }
      } else {
        segments.push({
          type: "text",
          plain,
          marks: (marks || []).map((mk) => ({ ...mk })),
        });
      }
    }

    function absorbEqualMerge(result) {
      if (!result.cleanMerge) cleanMerge = false;
      for (const seg of result.segments) {
        if (seg.type === "text") pushText(seg.plain, seg.marks);
        else segments.push(seg);
      }
    }

    function oursSliceForBaseRange(baseLo, baseHi) {
      const [c0, c1] = tokenCharRange(baseTok, baseLo, baseHi);
      const basePlain = baseDoc.plain.slice(c0, c1);
      const o0 = oMap[baseLo];
      const o1 = oMap[baseHi];
      if (oursDoc.plain.slice(o0, o1) === basePlain) {
        return {
          plain: oursDoc.plain.slice(o0, o1),
          marks: clipMarks(oursDoc.marks, o0, o1),
        };
      }
      return {
        plain: basePlain,
        marks: clipMarks(baseDoc.marks, c0, c1),
      };
    }

    function pushReviewConflict(oursSlice, theirsSlice) {
      if (
        !(oursSlice.plain || (oursSlice.marks && oursSlice.marks.length)) &&
        !(theirsSlice.plain || (theirsSlice.marks && theirsSlice.marks.length))
      ) {
        return;
      }
      cleanMerge = false;
      segments.push({
        type: "conflict",
        labelOurs,
        labelTheirs,
        ours: oursSlice,
        theirs: theirsSlice,
      });
    }

    while (ai < aReps.length || bi < bReps.length) {
      const a = aReps[ai];
      const b = bReps[bi];
      const aLo = a ? a.baseLo : Infinity;
      const bLo = b ? b.baseLo : Infinity;

      if (pos < aLo && pos < bLo) {
        const upto = Math.min(aLo, bLo);
        absorbEqualMerge(
          equalBaseRangeMerge(
            baseDoc,
            oursDoc,
            theirsDoc,
            baseTok,
            oursTok,
            theirsTok,
            pos,
            upto,
            labelOurs,
            labelTheirs,
            review
          )
        );
        pos = upto;
        continue;
      }

      const onlyA = a && (!b || (aLo < bLo && !overlaps(a, b)));
      const onlyB = b && (!a || (bLo < aLo && !overlaps(a, b)));

      if (onlyA) {
        const slice = sliceDoc(oursDoc, oursTok, a.sideLo, a.sideHi);
        pushText(slice.plain, slice.marks);
        pos = a.baseHi;
        ai++;
        continue;
      }
      if (onlyB) {
        const theirsSlice = sliceDoc(theirsDoc, theirsTok, b.sideLo, b.sideHi);
        if (review) {
          pushReviewConflict(oursSliceForBaseRange(b.baseLo, b.baseHi), theirsSlice);
        } else {
          pushText(theirsSlice.plain, theirsSlice.marks);
        }
        pos = b.baseHi;
        bi++;
        continue;
      }

      let clusterLo = Math.min(aLo, bLo);
      let clusterHi = clusterLo;
      let iA = ai;
      let iB = bi;
      let aOut = [];
      let bOut = [];
      let aCursor = clusterLo;
      let bCursor = clusterLo;
      let aSideLo = Infinity;
      let aSideHi = -1;
      let bSideLo = Infinity;
      let bSideHi = -1;
      let sawA = false;
      let sawB = false;
      let growing = true;

      while (growing) {
        growing = false;
        while (iA < aReps.length && aReps[iA].baseLo <= clusterHi) {
          const r = aReps[iA];
          if (r.baseLo > clusterHi) break;
          if (
            r.baseLo === clusterHi &&
            r.baseHi === clusterHi &&
            clusterHi > clusterLo &&
            sawA
          ) {
            break;
          }
          aOut.push(...baseTok.tokens.slice(aCursor, r.baseLo));
          aOut.push(...r.out);
          aSideLo = Math.min(aSideLo, r.sideLo);
          aSideHi = Math.max(aSideHi, r.sideHi);
          aCursor = r.baseHi;
          clusterHi = Math.max(clusterHi, r.baseHi);
          sawA = true;
          iA++;
          growing = true;
        }
        while (iB < bReps.length && bReps[iB].baseLo <= clusterHi) {
          const r = bReps[iB];
          if (r.baseLo > clusterHi) break;
          if (
            r.baseLo === clusterHi &&
            r.baseHi === clusterHi &&
            clusterHi > clusterLo &&
            sawB
          ) {
            break;
          }
          bOut.push(...baseTok.tokens.slice(bCursor, r.baseLo));
          bOut.push(...r.out);
          bSideLo = Math.min(bSideLo, r.sideLo);
          bSideHi = Math.max(bSideHi, r.sideHi);
          bCursor = r.baseHi;
          clusterHi = Math.max(clusterHi, r.baseHi);
          sawB = true;
          iB++;
          growing = true;
        }
      }

      if (aCursor < clusterHi) {
        aOut.push(...baseTok.tokens.slice(aCursor, clusterHi));
      }
      if (bCursor < clusterHi) {
        bOut.push(...baseTok.tokens.slice(bCursor, clusterHi));
      }
      if (!sawA) aOut = baseTok.tokens.slice(clusterLo, clusterHi);
      if (!sawB) bOut = baseTok.tokens.slice(clusterLo, clusterHi);
      if (!sawA) {
        aSideLo = 0;
        aSideHi = 0;
      }
      if (!sawB) {
        bSideLo = 0;
        bSideHi = 0;
      }

      if (sameTokens(aOut, bOut)) {
        const plain = aOut.join("");
        const basePlain = baseTok.tokens.slice(clusterLo, clusterHi).join("");
        if (plain === basePlain) {
          absorbEqualMerge(
            equalBaseRangeMerge(
              baseDoc,
              oursDoc,
              theirsDoc,
              baseTok,
              oursTok,
              theirsTok,
              clusterLo,
              clusterHi,
              labelOurs,
              labelTheirs,
              review
            )
          );
        } else {
          const aSlice = sliceForOut(
            oursDoc,
            oursTok,
            oMap,
            clusterLo,
            clusterHi,
            aSideLo,
            aSideHi,
            aOut
          );
          const bSlice = sliceForOut(
            theirsDoc,
            theirsTok,
            tMap,
            clusterLo,
            clusterHi,
            bSideLo,
            bSideHi,
            bOut
          );
          absorbEqualMerge(
            equalPlainMergeSegments(
              plain,
              [],
              aSlice.plain === plain ? aSlice.marks : [],
              bSlice.plain === plain ? bSlice.marks : [],
              labelOurs,
              labelTheirs,
              review
            )
          );
        }
      } else if (!sawA) {
        const theirsSlice = sliceForOut(
          theirsDoc,
          theirsTok,
          tMap,
          clusterLo,
          clusterHi,
          bSideLo,
          bSideHi,
          bOut
        );
        if (review) {
          pushReviewConflict(oursSliceForBaseRange(clusterLo, clusterHi), theirsSlice);
        } else {
          pushText(theirsSlice.plain, theirsSlice.marks);
        }
      } else if (!sawB) {
        const slice = sliceForOut(
          oursDoc,
          oursTok,
          oMap,
          clusterLo,
          clusterHi,
          aSideLo,
          aSideHi,
          aOut
        );
        pushText(slice.plain, slice.marks);
      } else {
        cleanMerge = false;
        segments.push({
          type: "conflict",
          labelOurs,
          labelTheirs,
          ours: sliceForOut(
            oursDoc,
            oursTok,
            oMap,
            clusterLo,
            clusterHi,
            aSideLo,
            aSideHi,
            aOut
          ),
          theirs: sliceForOut(
            theirsDoc,
            theirsTok,
            tMap,
            clusterLo,
            clusterHi,
            bSideLo,
            bSideHi,
            bOut
          ),
        });
      }

      ai = iA;
      bi = iB;
      pos = clusterHi;
    }

    if (pos < baseTok.tokens.length) {
      absorbEqualMerge(
        equalBaseRangeMerge(
          baseDoc,
          oursDoc,
          theirsDoc,
          baseTok,
          oursTok,
          theirsTok,
          pos,
          baseTok.tokens.length,
          labelOurs,
          labelTheirs,
          review
        )
      );
    }

    return finishMergeWithAlign(
      baseDoc,
      oursDoc,
      theirsDoc,
      segments,
      cleanMerge,
      labelOurs,
      labelTheirs,
      review
    );
  }

  /** Force every HEAD↔dirty delta into merge-conflict markers (no pendingMerge). */
  function reviewWorkingTree(headHtml, dirtyHtml, labelOurs = "HEAD") {
    return mergeText(
      headHtml || "",
      headHtml || "",
      dirtyHtml || "",
      labelOurs || "HEAD",
      "dirty",
      { review: true }
    );
  }

  function pickThreeWay(baseVal, oursVal, theirsVal) {
    const b = JSON.stringify(baseVal ?? null);
    const o = JSON.stringify(oursVal ?? null);
    const t = JSON.stringify(theirsVal ?? null);
    if (o === t) return oursVal;
    if (o === b) return theirsVal;
    if (t === b) return oursVal;
    return oursVal;
  }

  /**
   * Apply a 3-way merge into the working tree without committing (like
   * `git merge --no-commit`). Sets pendingMerge so the user finishes via Merge.
   */
  async function manualThreeWayMerge(id, ours, theirsBranch, oursOid, theirsOid, bases) {
    const dir = textDir(id);
    const baseOid = Array.isArray(bases) && bases.length ? bases[0] : null;
    const oursSnap = await readFilesAtOid(dir, oursOid);
    const theirsSnap = await readFilesAtOid(dir, theirsOid);
    const baseSnap = baseOid
      ? await readFilesAtOid(dir, baseOid)
      : {
          text: "",
          model: DEFAULT_MODEL,
        };

    const text = mergeText(
      baseSnap.html || baseSnap.text || "",
      oursSnap.html || oursSnap.text || "",
      theirsSnap.html || theirsSnap.text || "",
      ours,
      theirsBranch
    );

    await copyAssetsFromOid(dir, oursOid, text.mergedText);
    await copyAssetsFromOid(dir, theirsOid, text.mergedText);

    const prev = await readWorkingFiles(id);
    const mergedState = {
      ...prev,
      html: text.mergedText,
      text: text.mergedText,
      model: pickThreeWay(baseSnap.model, oursSnap.model, theirsSnap.model) ||
        DEFAULT_MODEL,
      activeBranch: ours,
      updatedAt: Date.now(),
      hasConflict: !text.cleanMerge,
      pendingMerge: { ours, theirs: theirsBranch },
    };
    await writeWorkingFiles(dir, mergedState);
    await flush();

    if (!text.cleanMerge) {
      return {
        ok: false,
        conflict: true,
        files: [TEXT_FILE],
        state: await readWorkingFiles(id),
      };
    }

    return {
      ok: true,
      conflict: false,
      state: await readWorkingFiles(id),
    };
  }

  async function mergeBranch(id, theirs) {
    const branch = String(theirs || "").trim();
    if (!branch) throw new Error("Branch required");
    const ours = await currentBranch(id);
    if (branch === ours) throw new Error("Already on that branch");

    const dir = textDir(id);
    const oursOid = await git.resolveRef({ fs, dir, ref: ours });
    const theirsOid = await git.resolveRef({ fs, dir, ref: branch });
    let bases = [];
    try {
      bases = await git.findMergeBase({
        fs,
        dir,
        oids: [oursOid, theirsOid],
      });
      if (!Array.isArray(bases)) bases = bases ? [bases] : [];
    } catch (err) {
      console.warn("kindred: findMergeBase failed", err);
      bases = [];
    }

    return manualThreeWayMerge(id, ours, branch, oursOid, theirsOid, bases);
  }

  async function init() {
    await ensureDir(ROOT);
    await flush();
  }

  function looksBinaryText(text) {
    if (!text) return false;
    if (text.includes("\u0000")) return true;
    let weird = 0;
    const n = Math.min(text.length, 4096);
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 0xfffd || (c < 9) || (c > 13 && c < 32)) weird++;
    }
    return weird / n > 0.1;
  }

  /** Readable LightningFS tree for debugging (text files as strings; binaries summarized). */
  async function dumpFsTree(rootPath = "/") {
    async function walk(dir) {
      const entries = {};
      let names;
      try {
        names = await pfs.readdir(dir);
      } catch (err) {
        return { __error: String(err && err.message ? err.message : err) };
      }
      names = names.slice().sort();
      for (const name of names) {
        const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
        let st;
        try {
          st = await pfs.stat(path);
        } catch (err) {
          entries[name] = { __error: String(err && err.message ? err.message : err) };
          continue;
        }
        const isDir = typeof st.isDirectory === "function" ? st.isDirectory() : st.type === "dir";
        if (isDir) {
          entries[name] = await walk(path);
          continue;
        }
        try {
          const text = await pfs.readFile(path, "utf8");
          if (looksBinaryText(text)) {
            const buf = await pfs.readFile(path);
            const size = buf && (buf.byteLength ?? buf.length) || 0;
            entries[name] = { __binary: true, size };
          } else {
            entries[name] = text;
          }
        } catch {
          try {
            const buf = await pfs.readFile(path);
            const size = buf && (buf.byteLength ?? buf.length) || 0;
            entries[name] = { __binary: true, size };
          } catch (err) {
            entries[name] = { __error: String(err && err.message ? err.message : err) };
          }
        }
      }
      return entries;
    }

    await flush();
    return { root: rootPath, tree: await walk(rootPath) };
  }

const KindredGitStore = {
  init,
  listDrafts,
  createDraft,
  deleteDraft,
  renameDraft,
  saveWorkingTree,
  commitWorkingTree,
  listCommits,
  readAtCommit,
  readHead,
  restoreCommitToWorkingTree,
  resetToHead,
  listBranches,
  currentBranch,
  createBranch,
  renameBranch,
  checkoutBranch,
  deleteBranch,
  mergeBranch,
  amendCommitMessage,
  isDirty,
  readWorkingFiles,
  readChats,
  saveChats,
  readUiState,
  saveUiState,
  autoMessage,
  nextSequentialName,
  titleFromText,
  htmlToPlain: htmlToPlainText,
  formatHunksFromDiff,
  reviewWorkingTree,
  dumpFsTree,
  addImage,
  hydrateImageElements,
  DEFAULT_CHAT_TITLE,
};

export { KindredGitStore };
export default KindredGitStore;
