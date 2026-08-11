import LightningFS from "@isomorphic-git/lightning-fs";
import git from "isomorphic-git";

const VOLUME = "kindred";
  const ROOT = "/texts";
  const LEGACY_KEY = "kindred-review:drafts";
  const MIGRATED_KEY = "kindred:drafts-migrated";
  const AUTHOR = { name: "kindred", email: "kindred@local" };
  const TEXT_FILE = "text.html";
  const TRACKED = [TEXT_FILE, "review.json", "chats.json", "meta.json"];
  const TITLE_FILE = "title.txt";
  const DEFAULT_MODEL = "openai/gpt-5.6-luna";

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

  function asPlain(value) {
    return String(value ?? "").replace(/\u00a0/g, " ");
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

  /**
   * TipTap getHTML() → plain (same idea as editor getText).
   * Only call on known editor HTML — never on already-plain baselines
   * (plain may contain literal "<em>test</em>" etc.).
   */
  function tipTapHtmlToPlain(html) {
    const raw = String(html ?? "");
    if (!raw) return "";
    const doc = new DOMParser().parseFromString(raw, "text/html");
    const root = doc.body;
    root.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    const blocks = [...root.children];
    if (!blocks.length) {
      return asPlain(root.textContent || "");
    }
    return blocks.map((b) => asPlain(b.textContent || "")).join("\n\n");
  }

  /**
   * Pretty-print with newlines only between sibling blocks.
   * Never injects \\n before closing tags (that would sit inside paragraph text).
   */
  function prettyPrintHtml(html) {
    const compact = String(html || "")
      .replace(/>\s+</g, "><")
      .trim();
    if (!compact) return "";
    return compact
      .replace(
        /><(p|h[1-6]|ul|ol|li|blockquote|pre|hr|div)(\s[^>]*)?>/gi,
        ">\n<$1$2>"
      )
      .trim();
  }

  /** Drop trailing empty hard breaks / whitespace at the end of a block. */
  function trimTrailingInsignificant(el) {
    while (el.lastChild) {
      const last = el.lastChild;
      if (last.nodeType === Node.TEXT_NODE) {
        const trimmed = (last.nodeValue || "").replace(/[\s\u00a0]+$/g, "");
        if (!trimmed) {
          el.removeChild(last);
          continue;
        }
        if (trimmed !== last.nodeValue) last.nodeValue = trimmed;
        break;
      }
      if (last.nodeType === Node.ELEMENT_NODE && last.tagName === "BR") {
        el.removeChild(last);
        continue;
      }
      if (last.nodeType === Node.ELEMENT_NODE) {
        trimTrailingInsignificant(last);
        break;
      }
      break;
    }
  }

  /** Stable style attrs for dirty compare (trailing ; / prop order / spacing). */
  function canonicalizeStyleAttr(style) {
    return String(style || "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((decl) => {
        const i = decl.indexOf(":");
        if (i < 0) return decl.replace(/\s+/g, " ");
        const prop = decl.slice(0, i).trim().toLowerCase();
        const val = decl.slice(i + 1).trim().replace(/\s+/g, " ");
        return `${prop}: ${val}`;
      })
      .sort()
      .join("; ");
  }

  /**
   * Mark-preserving HTML normalize for save + dirty compare.
   * Mirrors tiptapEditor.canonicalizeTextHtml (gitStore cannot import ESM).
   */
  function canonicalizeTextHtml(html) {
    const raw = String(html || "").trim();
    if (!raw) return "";
    const doc = new DOMParser().parseFromString(raw, "text/html");
    const root = doc.body;
    for (const el of root.querySelectorAll(
      "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, div"
    )) {
      trimTrailingInsignificant(el);
    }
    for (const el of root.querySelectorAll("[style]")) {
      const next = canonicalizeStyleAttr(el.getAttribute("style"));
      if (next) el.setAttribute("style", next);
      else el.removeAttribute("style");
    }
    return prettyPrintHtml(root.innerHTML);
  }

  function htmlHasConflictMarkers(html) {
    const s = String(html || "");
    return s.includes("<<<<<<<") || /\bdata-kindred-align-ours\s*=/i.test(s);
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

  /**
   * DOM round-trip escapes raw <<<<<<< markers; keep conflict HTML verbatim.
   */
  function storeTextHtml(html, { hasConflict = false } = {}) {
    const raw = html == null ? "" : String(html);
    if (hasConflict || htmlHasConflictMarkers(raw)) return raw;
    return canonicalizeTextHtml(raw);
  }

  /** Baseline field is always plain text — never HTML-parse it. */
  function plainBaselineFrom(value) {
    return asPlain(value);
  }

  /** text body from the app is TipTap getHTML(); canonicalize for stable dirty. */
  function textHtmlFromEditor(value) {
    return storeTextHtml(value);
  }

  /** One-shot localStorage migration — not used for live type/paste/save. */
  function migrateLegacyTextBody(html, text) {
    const raw =
      html != null && String(html) !== "" ? String(html) : String(text ?? "");
    if (!raw) return "";
    if (/^\s*<p[\s>]/i.test(raw)) return textHtmlFromEditor(raw);
    return plainTextToHtml(raw);
  }

  function titleFromText(text) {
    // Callers pass TipTap getHTML() (or empty). Project to plain for the title line.
    const raw = tipTapHtmlToPlain(text || "");
    const line = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (!line) return "Empty draft";
    return line.length > 56 ? `${line.slice(0, 56)}...` : line;
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
      revisionCost: Number(m.revisionCost) || 0,
      totalCost: Number(m.totalCost) || 0,
      createdAt: Number(m.createdAt) || now,
      updatedAt: Number(m.updatedAt) || now,
      activeBranch: m.activeBranch || "main",
      hasConflict: !!m.hasConflict,
      pendingMerge: m.pendingMerge || null,
      customTitle: !!m.customTitle,
    };
  }

  function normalizeReview(review) {
    if (!review || typeof review !== "object") {
      return { result: null, baseline: "" };
    }
    return {
      result: review.result ?? null,
      baseline:
        typeof review.baseline === "string"
          ? plainBaselineFrom(review.baseline)
          : "",
    };
  }

  function normalizeChats(chats) {
    if (chats && typeof chats === "object" && !Array.isArray(chats)) return chats;
    return {};
  }

  async function writeTitleFile(dir, title) {
    await writeText(`${dir}/${TITLE_FILE}`, title || "");
  }

  async function readTitleFile(dir) {
    return (await readText(`${dir}/${TITLE_FILE}`, "")).trim();
  }

  async function resolveTitle(dir, text, preferred, customTitle = false) {
    // Pinned titles (explicit rename) win; otherwise always derive from body.
    if (customTitle) {
      if (typeof preferred === "string" && preferred.trim()) {
        return preferred.trim();
      }
      const fromFile = await readTitleFile(dir);
      if (fromFile) return fromFile;
      // Migrate legacy meta.title → title.txt
      const rawMeta = await readJson(`${dir}/meta.json`, null);
      if (rawMeta && typeof rawMeta.title === "string" && rawMeta.title.trim()) {
        const legacy = rawMeta.title.trim();
        await writeTitleFile(dir, legacy);
        return legacy;
      }
    }
    return titleFromText(text || "");
  }

  // text / review / chats content (excludes meta bookkeeping + title.txt).
  function dirtyContentKey(state) {
    const hasConflict =
      !!state.hasConflict ||
      !!(state.meta && state.meta.hasConflict);
    return JSON.stringify({
      html: storeTextHtml(state.html || state.text || "", { hasConflict }),
      baseline: state.baseline || "",
      result: state.result ?? null,
      chats: normalizeChats(state.chats),
      model: state.model || DEFAULT_MODEL,
      revisionCost: Number(state.revisionCost) || 0,
      totalCost: Number(state.totalCost) || 0,
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
        revisionCost: state.revisionCost ?? state.meta?.revisionCost,
        totalCost: state.totalCost ?? state.meta?.totalCost,
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
    await writeJson(`${dir}/review.json`, {
      result: state.result ?? null,
      baseline: plainBaselineFrom(state.baseline || ""),
    });
    await writeJson(`${dir}/chats.json`, normalizeChats(state.chats));
    await writeJson(`${dir}/meta.json`, meta);
    return { meta, title };
  }

  async function readWorkingFiles(id) {
    const dir = textDir(id);
    const html = await readText(`${dir}/${TEXT_FILE}`, "");
    const review = normalizeReview(await readJson(`${dir}/review.json`, null));
    const chats = normalizeChats(await readJson(`${dir}/chats.json`, {}));
    const meta = normalizeMeta(await readJson(`${dir}/meta.json`, null), id);
    const title = await resolveTitle(dir, html, null, meta.customTitle);
    return {
      id,
      html,
      text: html,
      baseline: review.baseline,
      result: review.result,
      chats,
      model: meta.model,
      revisionCost: meta.revisionCost,
      totalCost: meta.totalCost,
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
      return !!(
        state.html ||
        state.text ||
        state.result ||
        state.baseline ||
        (state.chats && Object.keys(state.chats).length)
      );
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
          hasAnalysis: !!state.result || commitCount > 0,
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
      baseline: "",
      result: null,
      chats: {},
      model: DEFAULT_MODEL,
      revisionCost: 0,
      totalCost: 0,
      ...(trimmedTitle ? { title: trimmedTitle, customTitle: true } : { customTitle: false }),
      createdAt: now,
      updatedAt: now,
      activeBranch: "main",
      hasConflict: false,
      pendingMerge: null,
    });
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
      // Conflict marker HTML must not DOM-canonicalize (escapes <<<<<<<).
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

  async function commitAnalyze(id, state) {
    const dir = textDir(id);
    const now = Date.now();
    await writeWorkingFiles(dir, {
      ...state,
      id,
      updatedAt: now,
      hasConflict: false,
      pendingMerge: null,
    });
    const oid = await commitFiles(dir, autoMessage("Analyze", new Date(now)));
    const meta = normalizeMeta(await readJson(`${dir}/meta.json`, null), id);
    meta.activeBranch =
      (await git.currentBranch({ fs, dir, test: true })) || meta.activeBranch;
    await writeJson(`${dir}/meta.json`, meta);
    await flush();
    return { oid, state: await readWorkingFiles(id) };
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
    const review = normalizeReview(await readPath("review.json", true));
    const chats = normalizeChats(await readPath("chats.json", true));
    const metaRaw = await readPath("meta.json", true);
    return {
      html: body,
      text: body,
      baseline: review.baseline,
      result: review.result,
      chats,
      model: metaRaw?.model || DEFAULT_MODEL,
      revisionCost: Number(metaRaw?.revisionCost) || 0,
      totalCost: Number(metaRaw?.totalCost) || 0,
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
    await writeWorkingFiles(dir, {
      ...prev,
      html: body,
      text: body,
      result: snap.result,
      chats: snap.chats,
      model: snap.model,
      revisionCost: snap.revisionCost,
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
      baseline: snap.baseline,
      result: snap.result,
      chats: snap.chats,
      model: snap.model,
      revisionCost: snap.revisionCost,
      totalCost: snap.totalCost,
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
    try {
      const branches = await git.listBranches({ fs, dir });
      if (branches.length) return branches.sort();
    } catch {
      /* empty */
    }
    const cur = await git.currentBranch({ fs, dir, test: true });
    return cur ? [cur] : ["main"];
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

  async function checkoutBranch(id, name, { force = false } = {}) {
    const dir = textDir(id);
    const ref = String(name || "").trim();
    if (!ref) throw new Error("Branch name required");
    const contentDirty = await isDirty(id);
    if (!force && contentDirty) {
      const err = new Error("DIRTY");
      err.code = "DIRTY";
      throw err;
    }
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
    await git.checkout({ fs, dir, ref, force: !!force });
    if (preservedTitle) {
      await writeTitleFile(dir, preservedTitle);
    }
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
    if (ref === "main") throw new Error("Cannot delete main");
    const cur = await currentBranch(id);
    if (cur === ref) throw new Error("Cannot delete the current branch");
    await git.deleteBranch({ fs, dir, ref });
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
  };

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
        if (/^\d+(\.\d+)?$/.test(raw)) return `${raw}px`;
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

  /** Pull exclusive mark values from a open tag (style + legacy attrs). */
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

  /**
   * Equal plain text → clean text segments and format-only conflicts for exclusive clashes.
   * Orthogonal marks always auto-union onto both clean and conflict sides.
   */
  function equalPlainMergeSegments(
    plain,
    baseMarks,
    oursMarks,
    theirsMarks,
    labelOurs,
    labelTheirs
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
    let anyConflict = false;
    for (const type of EXCLUSIVE_MARK_TYPES) {
      const resolved = resolveExclusivePerChar(
        markExclusiveValues(baseMarks, type, length),
        markExclusiveValues(oursMarks, type, length),
        markExclusiveValues(theirsMarks, type, length),
        length
      );
      exclusiveAuto[type] = resolved.auto;
      exclusiveConflict[type] = resolved.conflict;
      for (let i = 0; i < length; i++) {
        if (resolved.conflict[i]) {
          anyConflict = true;
          break;
        }
      }
    }

    function charHasExclusiveConflict(i) {
      for (const type of EXCLUSIVE_MARK_TYPES) {
        if (exclusiveConflict[type][i]) return true;
      }
      return false;
    }

    const segments = [];
    let i = 0;
    while (i < length) {
      const isConflict = charHasExclusiveConflict(i);
      let j = i + 1;
      while (j < length && charHasExclusiveConflict(j) === isConflict) j++;
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
        segments.push({
          type: "conflict",
          labelOurs,
          labelTheirs,
          ours: {
            plain: slicePlain,
            marks: orthoSlice.concat(exclusiveMarksOnly(clipMarks(oursMarks, i, j))),
          },
          theirs: {
            plain: slicePlain,
            marks: orthoSlice.concat(
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
        plain += asPlain(chunk.replace(/\u00a0/g, " "));
        continue;
      }
      const close = /^<\/\s*([a-zA-Z0-9]+)/i.exec(chunk);
      if (close) {
        const name = close[1].toUpperCase();
        if (name === "P" || name === "DIV") {
          closeAllMarks();
          continue;
        }
        if (name === "SPAN" || name === "FONT") {
          const opened = spanExclusiveOpened.pop() || [];
          for (let k = opened.length - 1; k >= 0; k--) closeExclusive(opened[k]);
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
        if (blockCount > 0) {
          closeAllMarks();
          plain += "\n\n";
        }
        blockAligns.push(parseTextAlignFromOpenTag(chunk));
        blockCount++;
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

  function formatConflict(labelOurs, oursStr, labelTheirs, theirsStr) {
    const a = oursStr.endsWith("\n") ? oursStr : `${oursStr}\n`;
    const b = theirsStr.endsWith("\n") ? theirsStr : `${theirsStr}\n`;
    return `<<<<<<< ${labelOurs}\n${a}=======\n${b}>>>>>>> ${labelTheirs}\n`;
  }

  function blocksFromDoc(doc) {
    const plain = String(doc?.plain ?? "");
    const aligns = (doc?.blockAligns || []).slice();
    if (!plain && !aligns.length) return [];
    const plains = plain ? plain.split(/\n\n+/) : [""];
    while (aligns.length < plains.length) aligns.push("left");
    return plains.map((p, i) => ({ plain: p, align: aligns[i] || "left" }));
  }

  function threeWayAlignDecision(baseAlign, oursBlock, theirsBlock, labelOurs, labelTheirs) {
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
    if (o === b) {
      decision.align = t;
      return decision;
    }
    if (t === b) {
      decision.align = o;
      return decision;
    }
    decision.conflict = true;
    decision.align = o;
    decision.oursAlign = o;
    decision.theirsAlign = t;
    decision.labelOurs = labelOurs;
    decision.labelTheirs = labelTheirs;
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
  function matchParagraphAlignDecisions(baseDoc, oursDoc, theirsDoc, labelOurs, labelTheirs) {
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
          labelTheirs
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
          labelTheirs
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
              labelTheirs
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
              labelTheirs
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
    labelTheirs
  ) {
    const decisions = matchParagraphAlignDecisions(
      baseDoc,
      oursDoc,
      theirsDoc,
      labelOurs,
      labelTheirs
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
    labelTheirs
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
      labelTheirs
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

  /** Plain-text 3-way merge: orthogonal union + exclusive format-only conflicts. */
  function mergeText(baseText, oursText, theirsText, labelOurs, labelTheirs) {
    const baseHtml = baseText ?? "";
    const oursHtml = oursText ?? "";
    const theirsHtml = theirsText ?? "";
    if (oursHtml === theirsHtml) return { cleanMerge: true, mergedText: oursHtml };
    if (oursHtml === baseHtml) return { cleanMerge: true, mergedText: theirsHtml };
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
        labelTheirs
      );
      return finishMergeWithAlign(
        baseDoc,
        oursDoc,
        theirsDoc,
        result.segments,
        result.cleanMerge,
        labelOurs,
        labelTheirs
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
            labelTheirs
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
        const slice = sliceDoc(theirsDoc, theirsTok, b.sideLo, b.sideHi);
        pushText(slice.plain, slice.marks);
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
              labelTheirs
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
              labelTheirs
            )
          );
        }
      } else if (!sawA) {
        const slice = sliceForOut(
          theirsDoc,
          theirsTok,
          tMap,
          clusterLo,
          clusterHi,
          bSideLo,
          bSideHi,
          bOut
        );
        pushText(slice.plain, slice.marks);
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
          labelTheirs
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
      labelTheirs
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

  async function finishCleanMerge(id, dir, mergeOid) {
    const synced = await restoreCommitToWorkingTree(id, mergeOid);
    synced.baseline = tipTapHtmlToPlain(synced.html || synced.text || "");
    synced.hasConflict = false;
    synced.pendingMerge = null;
    synced.updatedAt = Date.now();
    await writeWorkingFiles(dir, synced);
    await flush();
    let oid = mergeOid;
    if (await isDirty(id)) {
      const info = await git.readCommit({ fs, dir, oid: mergeOid });
      const parents = info.commit.parent || [];
      await stageTracked(dir);
      oid = await git.commit({
        fs,
        dir,
        message: info.commit.message || autoMessage("Merge"),
        author: AUTHOR,
        parent: parents.length >= 2 ? parents : [mergeOid],
      });
      await flush();
    }
    return {
      ok: true,
      conflict: false,
      oid,
      state: await readWorkingFiles(id),
    };
  }

  async function writeConflictMerge(id, dir, ours, theirsBranch, text) {
    const state = await readWorkingFiles(id);
    state.html = text;
    state.text = text;
    state.hasConflict = true;
    state.pendingMerge = { ours, theirs: theirsBranch };
    state.updatedAt = Date.now();
    await writeWorkingFiles(dir, state);
    await flush();
    return {
      ok: false,
      conflict: true,
      files: [TEXT_FILE],
      state: await readWorkingFiles(id),
    };
  }

  /**
   * isomorphic-git cannot merge when findMergeBase returns 0 or >1 bases
   * (throws MergeNotSupportedError). Fall back to a single-base 3-way merge.
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
          baseline: "",
          result: null,
          chats: {},
          model: DEFAULT_MODEL,
          revisionCost: 0,
          totalCost: 0,
        };

    const text = mergeText(
      baseSnap.html || baseSnap.text || "",
      oursSnap.html || oursSnap.text || "",
      theirsSnap.html || theirsSnap.text || "",
      ours,
      theirsBranch
    );

    const prev = await readWorkingFiles(id);
    const mergedState = {
      ...prev,
      html: text.mergedText,
      text: text.mergedText,
      baseline: text.cleanMerge
        ? tipTapHtmlToPlain(text.mergedText)
        : plainBaselineFrom(
            pickThreeWay(baseSnap.baseline, oursSnap.baseline, theirsSnap.baseline) ||
              ""
          ),
      result: pickThreeWay(baseSnap.result, oursSnap.result, theirsSnap.result),
      chats: pickThreeWay(baseSnap.chats, oursSnap.chats, theirsSnap.chats) || {},
      model: pickThreeWay(baseSnap.model, oursSnap.model, theirsSnap.model) ||
        DEFAULT_MODEL,
      revisionCost:
        Number(
          pickThreeWay(
            baseSnap.revisionCost,
            oursSnap.revisionCost,
            theirsSnap.revisionCost
          )
        ) || 0,
      totalCost: Math.max(
        Number(oursSnap.totalCost) || 0,
        Number(theirsSnap.totalCost) || 0
      ),
      activeBranch: ours,
      updatedAt: Date.now(),
      hasConflict: !text.cleanMerge,
      pendingMerge: text.cleanMerge ? null : { ours, theirs: theirsBranch },
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

    const oid = await commitFiles(dir, autoMessage("Merge"), {
      parent: [oursOid, theirsOid],
    });
    return {
      ok: true,
      conflict: false,
      oid,
      state: await readWorkingFiles(id),
    };
  }

  async function mergeBranch(id, theirs) {
    const dir = textDir(id);
    const branch = String(theirs || "").trim();
    if (!branch) throw new Error("Branch required");
    const ours = await currentBranch(id);
    if (branch === ours) throw new Error("Already on that branch");

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

    // isomorphic-git only supports exactly one merge base.
    if (bases.length !== 1) {
      return manualThreeWayMerge(id, ours, branch, oursOid, theirsOid, bases);
    }

    try {
      const result = await git.merge({
        fs,
        dir,
        ours,
        theirs: branch,
        abortOnConflict: false,
        author: AUTHOR,
        message: autoMessage("Merge"),
        mergeDriver: async ({ branches, contents, path }) => {
          const baseText = contents[0] ?? "";
          const oursText = contents[1] ?? "";
          const theirsText = contents[2] ?? "";
          if (path !== TEXT_FILE) {
            return { cleanMerge: true, mergedText: oursText };
          }
          const labelOurs = branches[1] || "ours";
          const labelTheirs = branches[2] || "theirs";
          return mergeText(
            baseText,
            oursText,
            theirsText,
            labelOurs,
            labelTheirs
          );
        },
      });
      await flush();
      const mergeOid =
        (result && result.oid) ||
        (await git.resolveRef({ fs, dir, ref: "HEAD" }));
      return finishCleanMerge(id, dir, mergeOid);
    } catch (err) {
      if (
        err &&
        (err.code === "MergeNotSupportedError" ||
          err.name === "MergeNotSupportedError")
      ) {
        return manualThreeWayMerge(id, ours, branch, oursOid, theirsOid, bases);
      }
      const isConflict =
        err &&
        (err.code === "MergeConflictError" ||
          err.name === "MergeConflictError" ||
          (Array.isArray(err.data) && err.data.length));
      if (!isConflict) throw err;

      let text = await readText(`${dir}/${TEXT_FILE}`, "");
      if (!text.includes("<<<<<<<")) {
        try {
          const oursSnap = await readFilesAtOid(dir, oursOid);
          const theirsSnap = await readFilesAtOid(dir, theirsOid);
          const baseOid = bases[0];
          let baseText = "";
          if (baseOid) {
            const baseSnap = await readFilesAtOid(dir, baseOid);
            baseText = baseSnap.html || baseSnap.text || "";
          }
          text = mergeText(
            baseText,
            oursSnap.html || oursSnap.text || "",
            theirsSnap.html || theirsSnap.text || "",
            ours,
            branch
          ).mergedText;
        } catch (markerErr) {
          console.warn("kindred: could not build conflict markers", markerErr);
        }
      }
      return writeConflictMerge(id, dir, ours, branch, text);
    }
  }

  async function migrateFromLocalStorage() {
    if (localStorage.getItem(MIGRATED_KEY) === "1") return { migrated: 0 };
    let raw;
    try {
      raw = localStorage.getItem(LEGACY_KEY);
    } catch {
      return { migrated: 0 };
    }
    if (!raw) {
      localStorage.setItem(MIGRATED_KEY, "1");
      return { migrated: 0 };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      localStorage.setItem(MIGRATED_KEY, "1");
      return { migrated: 0 };
    }
    if (!Array.isArray(parsed) || !parsed.length) {
      localStorage.setItem(MIGRATED_KEY, "1");
      return { migrated: 0 };
    }

    await ensureDir(ROOT);
    let migrated = 0;
    for (const draft of parsed) {
      if (!draft || typeof draft.id !== "string") continue;
      const dir = textDir(draft.id);
      if (await pathExists(`${dir}/.git`)) continue;

      await ensureDir(dir);
      await git.init({ fs, dir, defaultBranch: "main" });

      let revisions = Array.isArray(draft.revisions) ? draft.revisions : null;
      if (!revisions && draft.result) {
        revisions = [
          {
            text: draft.text || "",
            baseline: draft.baseline || "",
            result: draft.result,
            chats: draft.chats || {},
            model: draft.model || DEFAULT_MODEL,
            revisionCost: Number(draft.revisionCost) || 0,
            createdAt: draft.updatedAt || draft.createdAt || Date.now(),
          },
        ];
      }
      if (!revisions) revisions = [];

      const createdAt = Number(draft.createdAt) || Date.now();
      const totalCost = Number(draft.totalCost) || 0;

      if (!revisions.length) {
        const body = migrateLegacyTextBody(draft.html, draft.text);
        await writeWorkingFiles(dir, {
          id: draft.id,
          html: body,
          text: body,
          baseline: plainBaselineFrom(draft.baseline || ""),
          result: draft.result || null,
          chats: draft.chats || {},
          model: draft.model || DEFAULT_MODEL,
          revisionCost: Number(draft.revisionCost) || 0,
          totalCost,
          title: titleFromText(body),
          createdAt,
          updatedAt: Number(draft.updatedAt) || createdAt,
          activeBranch: "main",
        });
      } else {
        for (const rev of revisions) {
          const ts = Number(rev.createdAt) || Date.now();
          const body = migrateLegacyTextBody(
            rev.html,
            rev.text ?? draft.text
          );
          await writeWorkingFiles(dir, {
            id: draft.id,
            html: body,
            text: body,
            baseline: plainBaselineFrom(rev.baseline || ""),
            result: rev.result || null,
            chats: rev.chats || {},
            model: rev.model || DEFAULT_MODEL,
            revisionCost: Number(rev.revisionCost) || 0,
            totalCost,
            title: titleFromText(body),
            createdAt,
            updatedAt: ts,
            activeBranch: "main",
          });
          await commitFiles(dir, autoMessage("Analyze", new Date(ts)));
        }
        const idx = Number(draft.activeRevisionIndex);
        if (Number.isFinite(idx) && idx >= 0 && idx < revisions.length) {
          // Leave WT at last migrated commit (head); head is the natural open state.
        }
      }
      migrated += 1;
    }

    localStorage.setItem(MIGRATED_KEY, "1");
    await flush();
    console.info(`kindred: migrated ${migrated} drafts to isomorphic-git`);
    return { migrated };
  }

  async function init() {
    await ensureDir(ROOT);
    await migrateFromLocalStorage();
    await flush();
  }

const KindredGitStore = {
  init,
  listDrafts,
  createDraft,
  deleteDraft,
  renameDraft,
  saveWorkingTree,
  commitAnalyze,
  commitWorkingTree,
  listCommits,
  readAtCommit,
  readHead,
  restoreCommitToWorkingTree,
  resetToHead,
  listBranches,
  currentBranch,
  createBranch,
  checkoutBranch,
  deleteBranch,
  mergeBranch,
  isDirty,
  readWorkingFiles,
  autoMessage,
  titleFromText,
  htmlToPlain: tipTapHtmlToPlain,
};

export { KindredGitStore };
export default KindredGitStore;
