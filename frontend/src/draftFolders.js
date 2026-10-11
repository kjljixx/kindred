const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function emptyFolderState() {
  return { folders: [], assignments: {} };
}

function folderById(state, id) {
  return state.folders.find((folder) => folder.id === id) || null;
}

function cleanFolderName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("Folder name cannot be empty");
  return trimmed;
}

function requireFolder(state, id) {
  const folder = folderById(state, id);
  if (!folder) throw new Error(`Folder not found: ${id}`);
  return folder;
}

function formsCycle(byId, start) {
  const visited = new Set();
  let current = start.parentId;
  while (current && !visited.has(current)) {
    if (current === start.id) return true;
    visited.add(current);
    current = byId.get(current)?.parentId || null;
  }
  return false;
}

/** Repairs persisted state; `report` receives one message per repair. */
export function normalizeFolderState(raw, report = () => {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const folders = [];
  const seen = new Set();
  for (const item of Array.isArray(source.folders) ? source.folders : []) {
    const id = typeof item?.id === "string" ? item.id : "";
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!id || !name || seen.has(id)) {
      report(`dropped invalid folder ${JSON.stringify(item)}`);
      continue;
    }
    seen.add(id);
    folders.push({
      id,
      name,
      parentId: typeof item.parentId === "string" ? item.parentId : null,
      collapsed: !!item.collapsed,
    });
  }
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    if (folder.parentId && !byId.has(folder.parentId)) {
      report(`folder ${folder.id} lost missing parent ${folder.parentId}`);
      folder.parentId = null;
    }
  }
  for (const folder of folders) {
    if (folder.parentId && formsCycle(byId, folder)) {
      report(`folder ${folder.id} was part of a cycle; moved to top level`);
      folder.parentId = null;
    }
  }
  const assignments = {};
  const rawAssignments =
    source.assignments && typeof source.assignments === "object" ? source.assignments : {};
  for (const [draftId, folderId] of Object.entries(rawAssignments)) {
    if (typeof folderId === "string" && byId.has(folderId)) assignments[draftId] = folderId;
    else report(`dropped assignment of draft ${draftId} to missing folder ${JSON.stringify(folderId)}`);
  }
  return { folders, assignments };
}

/** True when `candidateId` is `folderId` or lies anywhere beneath it. */
export function isSelfOrDescendant(state, folderId, candidateId) {
  const visited = new Set();
  let current = candidateId;
  while (current && !visited.has(current)) {
    if (current === folderId) return true;
    visited.add(current);
    current = folderById(state, current)?.parentId || null;
  }
  return false;
}

export function createFolder(state, { id, name, parentId = null }) {
  const cleaned = cleanFolderName(name);
  if (!id) throw new Error("Folder id is required");
  if (parentId) requireFolder(state, parentId);
  const folder = { id, name: cleaned, parentId, collapsed: false };
  return { state: { ...state, folders: [...state.folders, folder] }, folder };
}

export function renameFolder(state, id, name) {
  const cleaned = cleanFolderName(name);
  requireFolder(state, id);
  return {
    ...state,
    folders: state.folders.map((folder) => (folder.id === id ? { ...folder, name: cleaned } : folder)),
  };
}

export function setFolderCollapsed(state, id, collapsed) {
  requireFolder(state, id);
  return {
    ...state,
    folders: state.folders.map((folder) => (folder.id === id ? { ...folder, collapsed: !!collapsed } : folder)),
  };
}

export function moveFolder(state, id, parentId) {
  requireFolder(state, id);
  if (parentId) {
    requireFolder(state, parentId);
    if (isSelfOrDescendant(state, id, parentId)) {
      throw new Error("A folder cannot be moved into itself or one of its subfolders");
    }
  }
  return {
    ...state,
    folders: state.folders.map((folder) => (folder.id === id ? { ...folder, parentId: parentId || null } : folder)),
  };
}

/** Subfolders and drafts of the deleted folder move up one level. */
export function deleteFolder(state, id) {
  const target = requireFolder(state, id);
  const parentId = target.parentId;
  const assignments = {};
  for (const [draftId, folderId] of Object.entries(state.assignments)) {
    if (folderId !== id) assignments[draftId] = folderId;
    else if (parentId) assignments[draftId] = parentId;
  }
  return {
    folders: state.folders
      .filter((folder) => folder.id !== id)
      .map((folder) => (folder.parentId === id ? { ...folder, parentId } : folder)),
    assignments,
  };
}

export function assignDraft(state, draftId, folderId) {
  const assignments = { ...state.assignments };
  if (folderId) {
    requireFolder(state, folderId);
    assignments[draftId] = folderId;
  } else {
    delete assignments[draftId];
  }
  return { ...state, assignments };
}

export function removeDraft(state, draftId) {
  if (!(draftId in state.assignments)) return state;
  return assignDraft(state, draftId, null);
}

export function hasSubfolders(state, id) {
  return state.folders.some((folder) => folder.parentId === id);
}

export function folderPath(state, folderId) {
  const names = [];
  const visited = new Set();
  let current = folderId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const folder = folderById(state, current);
    if (!folder) break;
    names.unshift(folder.name);
    current = folder.parentId;
  }
  return names;
}

export function draftFolderPath(state, draftId) {
  return folderPath(state, state.assignments[draftId]).join(" / ");
}

/** `{ id, path }` for every folder, e.g. "College apps / Essays". */
export function folderOptions(state) {
  return state.folders.map((folder) => ({
    id: folder.id,
    path: folderPath(state, folder.id).join(" / "),
  }));
}

function childFolders(state, parentId) {
  return state.folders
    .filter((folder) => (folder.parentId || null) === parentId)
    .sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
}

/** Folders A–Z at each level; `drafts` keep the order given. */
export function buildFolderTree(state, drafts) {
  const draftsByFolder = new Map();
  for (const draft of drafts) {
    const folderId = state.assignments[draft.id];
    if (!folderId) continue;
    if (!draftsByFolder.has(folderId)) draftsByFolder.set(folderId, []);
    draftsByFolder.get(folderId).push(draft);
  }
  const build = (parentId) =>
    childFolders(state, parentId).map((folder) => ({
      folder,
      folders: build(folder.id),
      drafts: draftsByFolder.get(folder.id) || [],
    }));
  return build(null);
}

export function unfiledDrafts(state, drafts) {
  return drafts.filter((draft) => !state.assignments[draft.id]);
}

/** Depth-first folder list for menus; skips `excludeId` and everything beneath it. */
export function flattenFolders(state, { excludeId = null } = {}) {
  const rows = [];
  const walk = (parentId, depth) => {
    for (const folder of childFolders(state, parentId)) {
      if (folder.id === excludeId) continue;
      rows.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
