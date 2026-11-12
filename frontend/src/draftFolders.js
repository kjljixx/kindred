const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const FOLDER_STATE_VERSION = 2;
export const UNFILED_FILTER = "unfiled";

export function emptyFolderState() {
  return { version: FOLDER_STATE_VERSION, folders: [], assignments: {} };
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

/** Turns legacy nesting into flat folders named "Parent / Child", keeping depth-first order. */
function flattenNestedFolders(folders, report) {
  const childrenByParent = new Map();
  for (const folder of folders) {
    const siblings = childrenByParent.get(folder.parentId) || [];
    siblings.push(folder);
    childrenByParent.set(folder.parentId, siblings);
  }
  const flat = [];
  const walk = (parentId, parentName) => {
    for (const folder of childrenByParent.get(parentId) || []) {
      const name = parentName ? `${parentName} / ${folder.name}` : folder.name;
      if (parentName) report(`flattened nested folder ${folder.id} to "${name}"`);
      flat.push({ id: folder.id, name });
      walk(folder.id, name);
    }
  };
  walk(null, "");
  return flat;
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
  if (folders.length && source.version !== FOLDER_STATE_VERSION) {
    report(`migrated ${folders.length} folders from A–Z to manual order`);
    folders.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
  }
  return { version: FOLDER_STATE_VERSION, folders: flattenNestedFolders(folders, report), assignments };
}

export function createFolder(state, { id, name }) {
  const cleaned = cleanFolderName(name);
  if (!id) throw new Error("Folder id is required");
  const folder = { id, name: cleaned };
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

/** Places the folder before `beforeId` (or last when `beforeId` is null). */
export function reorderFolder(state, id, { beforeId = null } = {}) {
  const folder = requireFolder(state, id);
  if (beforeId) {
    requireFolder(state, beforeId);
    if (beforeId === id) throw new Error("A folder cannot be placed before itself");
  }
  const rest = state.folders.filter((candidate) => candidate.id !== id);
  const index = beforeId ? rest.findIndex((candidate) => candidate.id === beforeId) : rest.length;
  rest.splice(index, 0, folder);
  return { ...state, folders: rest };
}

/** Swaps the folder with its previous (`-1`) or next (`1`) neighbour; returns `state` when at the edge. */
export function shiftFolder(state, id, offset) {
  requireFolder(state, id);
  const target = state.folders.findIndex((folder) => folder.id === id) + offset;
  if (target < 0 || target >= state.folders.length) return state;
  const beforeId = (offset < 0 ? state.folders[target] : state.folders[target + 1])?.id ?? null;
  return reorderFolder(state, id, { beforeId });
}

/** Drafts in the deleted folder become unfiled. */
export function deleteFolder(state, id) {
  requireFolder(state, id);
  const assignments = Object.fromEntries(
    Object.entries(state.assignments).filter(([, folderId]) => folderId !== id)
  );
  return { ...state, folders: state.folders.filter((folder) => folder.id !== id), assignments };
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

export function draftFolderName(state, draftId) {
  return folderById(state, state.assignments[draftId])?.name ?? "";
}

/** `{ id, path }` for every folder; `path` is the folder name, e.g. "College apps / Essays". */
export function folderOptions(state) {
  return state.folders.map((folder) => ({ id: folder.id, path: folder.name }));
}

export function unfiledDrafts(state, drafts) {
  return drafts.filter((draft) => !state.assignments[draft.id]);
}

/** `filter` is "" for every draft, `UNFILED_FILTER` for unfiled drafts, or a folder id. */
export function filterDraftsByFolder(state, drafts, filter) {
  if (!filter) return drafts;
  if (filter === UNFILED_FILTER) return unfiledDrafts(state, drafts);
  return drafts.filter((draft) => state.assignments[draft.id] === filter);
}
