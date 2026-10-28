import { describe, expect, it } from "vitest";
import {
  assignDraft,
  buildFolderTree,
  createFolder,
  deleteFolder,
  draftFolderPath,
  emptyFolderState,
  flattenFolders,
  folderOptions,
  indentFolder,
  moveFolder,
  normalizeFolderState,
  outdentFolder,
  removeDraft,
  renameFolder,
  reorderFolder,
  setFolderCollapsed,
  shiftFolder,
  unfiledDrafts,
} from "../src/draftFolders.js";

function build(...specs) {
  let state = emptyFolderState();
  for (const [id, name, parentId] of specs) {
    state = createFolder(state, { id, name, parentId: parentId ?? null }).state;
  }
  return state;
}

const school = ["school", "School"];
const math = ["math", "Math", "school"];
const work = ["work", "Work"];

describe("createFolder / renameFolder", () => {
  it("trims names and rejects empty ones", () => {
    const { folder } = createFolder(emptyFolderState(), { id: "a", name: "  Notes  " });
    expect(folder).toEqual({ id: "a", name: "Notes", parentId: null, collapsed: false });
    expect(() => createFolder(emptyFolderState(), { id: "b", name: "   " })).toThrow(/empty/);
    expect(() => renameFolder(build(school), "school", "")).toThrow(/empty/);
  });

  it("rejects a missing parent", () => {
    expect(() => createFolder(emptyFolderState(), { id: "a", name: "A", parentId: "nope" })).toThrow(/not found/);
  });
});

describe("moveFolder", () => {
  it("moves a folder under another and back to top level", () => {
    let state = moveFolder(build(school, work), "work", "school");
    expect(state.folders.find((f) => f.id === "work").parentId).toBe("school");
    state = moveFolder(state, "work", null);
    expect(state.folders.find((f) => f.id === "work").parentId).toBeNull();
  });

  it("blocks moving a folder into itself or a descendant", () => {
    const state = build(school, math);
    expect(() => moveFolder(state, "school", "school")).toThrow(/itself/);
    expect(() => moveFolder(state, "school", "math")).toThrow(/itself/);
  });
});

describe("manual folder order", () => {
  const home = ["home", "Home"];
  const top = (state) => state.folders.filter((f) => !f.parentId).map((f) => f.id);
  const childrenOf = (state, parentId) => state.folders.filter((f) => f.parentId === parentId).map((f) => f.id);

  it("keeps creation order and appends moved folders last", () => {
    const state = build(work, school, home);
    expect(top(state)).toEqual(["work", "school", "home"]);
    expect(top(reorderFolder(state, "work", {}))).toEqual(["school", "home", "work"]);
  });

  it("places a folder before a sibling, including across parents", () => {
    const state = build(school, math, work, home);
    expect(top(reorderFolder(state, "home", { beforeId: "school" }))).toEqual(["home", "school", "work"]);
    const nested = reorderFolder(state, "home", { parentId: "school", beforeId: "math" });
    expect(childrenOf(nested, "school")).toEqual(["home", "math"]);
  });

  it("rejects cycles and non-sibling anchors", () => {
    const state = build(school, math, work);
    expect(() => reorderFolder(state, "school", { parentId: "math" })).toThrow(/itself/);
    expect(() => reorderFolder(state, "work", { beforeId: "math" })).toThrow(/sibling/);
    expect(() => reorderFolder(state, "work", { beforeId: "work" })).toThrow(/sibling/);
  });

  it("shifts among siblings only and stops at the edges", () => {
    const state = build(school, math, work, home);
    expect(top(shiftFolder(state, "work", -1))).toEqual(["work", "school", "home"]);
    expect(top(shiftFolder(state, "school", 1))).toEqual(["work", "school", "home"]);
    expect(top(shiftFolder(state, "work", 1))).toEqual(["school", "home", "work"]);
    expect(shiftFolder(state, "school", -1)).toBe(state);
    expect(shiftFolder(state, "home", 1)).toBe(state);
    expect(shiftFolder(state, "math", 1)).toBe(state);
  });

  it("indents into the previous sibling and expands it", () => {
    const state = setFolderCollapsed(build(school, work, home), "school", true);
    const indented = indentFolder(state, "work");
    expect(childrenOf(indented, "school")).toEqual(["work"]);
    expect(indented.folders.find((f) => f.id === "school").collapsed).toBe(false);
    expect(indentFolder(state, "school")).toBe(state);
  });

  it("indents as the last child of the previous sibling", () => {
    const state = build(school, math, work);
    expect(childrenOf(indentFolder(state, "work"), "school")).toEqual(["math", "work"]);
  });

  it("outdents to directly after the former parent", () => {
    const state = build(school, math, work);
    const outdented = outdentFolder(state, "math");
    expect(top(outdented)).toEqual(["school", "math", "work"]);
    expect(outdentFolder(state, "school")).toBe(state);
  });
});

describe("deleteFolder", () => {
  it("lifts subfolders into the deleted folder's slot", () => {
    const state = build(school, ["a", "A", "school"], ["b", "B", "school"], work);
    const next = deleteFolder(state, "school");
    expect(next.folders.map((f) => [f.id, f.parentId])).toEqual([
      ["a", null],
      ["b", null],
      ["work", null],
    ]);
  });

  it("moves subfolders and drafts up one level", () => {
    let state = build(school, math);
    state = assignDraft(assignDraft(state, "d1", "math"), "d2", "school");
    state = deleteFolder(state, "math");
    expect(state.folders.map((f) => f.id)).toEqual(["school"]);
    expect(state.assignments).toEqual({ d1: "school", d2: "school" });
  });

  it("un-files drafts and lifts subfolders when a top-level folder is deleted", () => {
    let state = assignDraft(build(school, math), "d1", "school");
    state = deleteFolder(state, "school");
    expect(state.folders).toEqual([{ id: "math", name: "Math", parentId: null, collapsed: false }]);
    expect(state.assignments).toEqual({});
  });
});

describe("assignDraft / removeDraft", () => {
  it("assigns, reassigns, and un-files", () => {
    let state = assignDraft(build(school, work), "d1", "school");
    state = assignDraft(state, "d1", "work");
    expect(state.assignments).toEqual({ d1: "work" });
    state = assignDraft(state, "d1", null);
    expect(state.assignments).toEqual({});
  });

  it("rejects unknown folders and ignores unknown drafts on removal", () => {
    const state = build(school);
    expect(() => assignDraft(state, "d1", "nope")).toThrow(/not found/);
    expect(removeDraft(state, "ghost")).toBe(state);
  });
});

describe("views", () => {
  const drafts = [{ id: "d1" }, { id: "d2" }, { id: "d3" }, { id: "d4" }];

  it("builds a tree with folders in manual order and drafts in the given order", () => {
    let state = build(work, school, math);
    state = assignDraft(assignDraft(assignDraft(state, "d1", "math"), "d3", "math"), "d2", "work");
    const tree = buildFolderTree(state, drafts);
    expect(tree.map((node) => node.folder.name)).toEqual(["Work", "School"]);
    expect(tree[1].folders[0].folder.name).toBe("Math");
    expect(tree[1].folders[0].drafts.map((d) => d.id)).toEqual(["d1", "d3"]);
    expect(tree[0].drafts.map((d) => d.id)).toEqual(["d2"]);
  });

  it("lists unfiled drafts", () => {
    const state = assignDraft(build(school), "d2", "school");
    expect(unfiledDrafts(state, drafts).map((d) => d.id)).toEqual(["d1", "d3", "d4"]);
  });

  it("formats a draft's folder path", () => {
    const state = assignDraft(build(school, math), "d1", "math");
    expect(draftFolderPath(state, "d1")).toBe("School / Math");
    expect(draftFolderPath(state, "d2")).toBe("");
  });

  it("lists every folder with its full path", () => {
    expect(folderOptions(build(work, school, math))).toEqual([
      { id: "work", path: "Work" },
      { id: "school", path: "School" },
      { id: "math", path: "School / Math" },
    ]);
  });

  it("flattens folders depth-first and can exclude a subtree", () => {
    const state = build(work, school, math);
    expect(flattenFolders(state).map((row) => [row.folder.id, row.depth])).toEqual([
      ["work", 0],
      ["school", 0],
      ["math", 1],
    ]);
    expect(flattenFolders(state, { excludeId: "school" }).map((row) => row.folder.id)).toEqual(["work"]);
  });

  it("toggles collapsed state", () => {
    const state = setFolderCollapsed(build(school), "school", true);
    expect(state.folders[0].collapsed).toBe(true);
  });
});

describe("normalizeFolderState", () => {
  it("returns an empty state for junk input", () => {
    expect(normalizeFolderState(null)).toEqual(emptyFolderState());
    expect(normalizeFolderState("x")).toEqual(emptyFolderState());
  });

  it("drops invalid folders and assignments, and reports each repair", () => {
    const reports = [];
    const state = normalizeFolderState(
      {
        folders: [
          { id: "a", name: " A " },
          { id: "a", name: "Duplicate" },
          { id: "b", name: "" },
          { id: "c", name: "C", parentId: "missing" },
          null,
        ],
        assignments: { d1: "a", d2: "gone", d3: 7 },
      },
      (message) => reports.push(message)
    );
    expect(state.folders.map((f) => [f.id, f.name, f.parentId])).toEqual([
      ["a", "A", null],
      ["c", "C", null],
    ]);
    expect(state.assignments).toEqual({ d1: "a" });
    expect(reports).toHaveLength(7);
  });

  it("migrates unversioned state to A–Z once, then keeps manual order", () => {
    const legacy = { folders: [{ id: "w", name: "Work" }, { id: "s", name: "School" }], assignments: {} };
    const reports = [];
    const migrated = normalizeFolderState(legacy, (message) => reports.push(message));
    expect(migrated.folders.map((f) => f.id)).toEqual(["s", "w"]);
    expect(migrated.version).toBe(2);
    expect(reports).toEqual(["migrated 2 folders from A–Z to manual order"]);

    const reordered = { ...migrated, folders: [...migrated.folders].reverse() };
    expect(normalizeFolderState(reordered).folders.map((f) => f.id)).toEqual(["w", "s"]);
  });

  it("breaks parent cycles", () => {
    const state = normalizeFolderState({
      folders: [
        { id: "a", name: "A", parentId: "b" },
        { id: "b", name: "B", parentId: "a" },
        { id: "c", name: "C", parentId: "a" },
      ],
    });
    const parents = Object.fromEntries(state.folders.map((f) => [f.id, f.parentId]));
    expect(parents).toEqual({ a: null, b: "a", c: "a" });
  });
});
