import { describe, expect, it } from "vitest";
import {
  UNFILED_FILTER,
  assignDraft,
  createFolder,
  deleteFolder,
  draftFolderName,
  emptyFolderState,
  filterDraftsByFolder,
  folderOptions,
  normalizeFolderState,
  removeDraft,
  renameFolder,
  reorderFolder,
  shiftFolder,
  unfiledDrafts,
} from "../src/draftFolders.js";

function build(...specs) {
  let state = emptyFolderState();
  for (const [id, name] of specs) {
    state = createFolder(state, { id, name }).state;
  }
  return state;
}

const school = ["school", "School"];
const work = ["work", "Work"];
const home = ["home", "Home"];

const order = (state) => state.folders.map((f) => f.id);

describe("createFolder / renameFolder", () => {
  it("trims names and rejects empty ones", () => {
    const { folder } = createFolder(emptyFolderState(), { id: "a", name: "  Notes  " });
    expect(folder).toEqual({ id: "a", name: "Notes" });
    expect(() => createFolder(emptyFolderState(), { id: "b", name: "   " })).toThrow(/empty/);
    expect(() => renameFolder(build(school), "school", "")).toThrow(/empty/);
  });

  it("renames in place", () => {
    expect(renameFolder(build(school), "school", " Uni ").folders).toEqual([{ id: "school", name: "Uni" }]);
  });
});

describe("manual folder order", () => {
  it("keeps creation order and appends moved folders last", () => {
    const state = build(work, school, home);
    expect(order(state)).toEqual(["work", "school", "home"]);
    expect(order(reorderFolder(state, "work"))).toEqual(["school", "home", "work"]);
  });

  it("places a folder before another and rejects bad anchors", () => {
    const state = build(school, work, home);
    expect(order(reorderFolder(state, "home", { beforeId: "school" }))).toEqual(["home", "school", "work"]);
    expect(() => reorderFolder(state, "work", { beforeId: "work" })).toThrow(/itself/);
    expect(() => reorderFolder(state, "work", { beforeId: "nope" })).toThrow(/not found/);
  });

  it("shifts by one and stops at the edges", () => {
    const state = build(school, work, home);
    expect(order(shiftFolder(state, "work", -1))).toEqual(["work", "school", "home"]);
    expect(order(shiftFolder(state, "school", 1))).toEqual(["work", "school", "home"]);
    expect(order(shiftFolder(state, "work", 1))).toEqual(["school", "home", "work"]);
    expect(shiftFolder(state, "school", -1)).toBe(state);
    expect(shiftFolder(state, "home", 1)).toBe(state);
  });
});

describe("deleteFolder", () => {
  it("un-files the folder's drafts and keeps other assignments", () => {
    let state = build(school, work);
    state = assignDraft(assignDraft(state, "d1", "school"), "d2", "work");
    state = deleteFolder(state, "school");
    expect(order(state)).toEqual(["work"]);
    expect(state.assignments).toEqual({ d2: "work" });
  });

  it("rejects unknown folders", () => {
    expect(() => deleteFolder(build(school), "nope")).toThrow(/not found/);
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
  const filed = assignDraft(assignDraft(build(school, work), "d1", "school"), "d3", "school");

  it("lists unfiled drafts", () => {
    expect(unfiledDrafts(filed, drafts).map((d) => d.id)).toEqual(["d2", "d4"]);
  });

  it("filters drafts by all, unfiled, or one folder, keeping the given order", () => {
    expect(filterDraftsByFolder(filed, drafts, "")).toBe(drafts);
    expect(filterDraftsByFolder(filed, drafts, UNFILED_FILTER).map((d) => d.id)).toEqual(["d2", "d4"]);
    expect(filterDraftsByFolder(filed, drafts, "school").map((d) => d.id)).toEqual(["d1", "d3"]);
    expect(filterDraftsByFolder(filed, drafts, "work")).toEqual([]);
  });

  it("names a draft's folder", () => {
    expect(draftFolderName(filed, "d1")).toBe("School");
    expect(draftFolderName(filed, "d2")).toBe("");
  });

  it("lists every folder with its name as the path", () => {
    expect(folderOptions(build(work, school))).toEqual([
      { id: "work", path: "Work" },
      { id: "school", path: "School" },
    ]);
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
    expect(state.folders).toEqual([
      { id: "a", name: "A" },
      { id: "c", name: "C" },
    ]);
    expect(state.assignments).toEqual({ d1: "a" });
    expect(reports).toHaveLength(7);
  });

  it("migrates unversioned state to A–Z once, then keeps manual order", () => {
    const legacy = { folders: [{ id: "w", name: "Work" }, { id: "s", name: "School" }], assignments: {} };
    const reports = [];
    const migrated = normalizeFolderState(legacy, (message) => reports.push(message));
    expect(order(migrated)).toEqual(["s", "w"]);
    expect(migrated.version).toBe(2);
    expect(reports).toEqual(["migrated 2 folders from A–Z to manual order"]);

    const reordered = { ...migrated, folders: [...migrated.folders].reverse() };
    expect(order(normalizeFolderState(reordered))).toEqual(["w", "s"]);
  });

  it("breaks parent cycles, then flattens what remains", () => {
    const state = normalizeFolderState({
      version: 2,
      folders: [
        { id: "a", name: "A", parentId: "b" },
        { id: "b", name: "B", parentId: "a" },
        { id: "c", name: "C", parentId: "a" },
      ],
    });
    expect(state.folders).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "A / B" },
      { id: "c", name: "A / C" },
    ]);
  });
});

describe("nested folder migration", () => {
  const nested = {
    version: 2,
    folders: [
      { id: "physics", name: "Physics", parentId: null, collapsed: true },
      { id: "essays", name: "Essays", parentId: null, collapsed: false },
      { id: "problem", name: "Problem sets", parentId: "physics", collapsed: false },
      { id: "week3", name: "Week 3", parentId: "problem", collapsed: false },
      { id: "labs", name: "Lab reports", parentId: "physics", collapsed: false },
    ],
    assignments: { d1: "week3", d2: "physics", d3: "essays" },
  };

  it("names subfolders by path and keeps depth-first order", () => {
    const state = normalizeFolderState(nested);
    expect(state.folders).toEqual([
      { id: "physics", name: "Physics" },
      { id: "problem", name: "Physics / Problem sets" },
      { id: "week3", name: "Physics / Problem sets / Week 3" },
      { id: "labs", name: "Physics / Lab reports" },
      { id: "essays", name: "Essays" },
    ]);
  });

  it("keeps every draft in its folder", () => {
    expect(normalizeFolderState(nested).assignments).toEqual(nested.assignments);
  });

  it("reports one message per flattened folder", () => {
    const reports = [];
    normalizeFolderState(nested, (message) => reports.push(message));
    expect(reports).toEqual([
      'flattened nested folder problem to "Physics / Problem sets"',
      'flattened nested folder week3 to "Physics / Problem sets / Week 3"',
      'flattened nested folder labs to "Physics / Lab reports"',
    ]);
  });

  it("does nothing on a second pass", () => {
    const once = normalizeFolderState(nested);
    const reports = [];
    expect(normalizeFolderState(once, (message) => reports.push(message))).toEqual(once);
    expect(reports).toEqual([]);
  });

  it("flattens again when an older build writes nesting back", () => {
    const once = normalizeFolderState(nested);
    const rewritten = { ...once, folders: once.folders.map((f) => (f.id === "labs" ? { ...f, name: "Labs", parentId: "essays" } : f)) };
    expect(normalizeFolderState(rewritten).folders.find((f) => f.id === "labs").name).toBe("Essays / Labs");
  });

  it("sorts legacy unversioned nesting A–Z before flattening", () => {
    const state = normalizeFolderState({
      folders: [
        { id: "z", name: "Zed" },
        { id: "a", name: "Alpha" },
        { id: "k", name: "Kid", parentId: "z" },
      ],
    });
    expect(state.folders).toEqual([
      { id: "a", name: "Alpha" },
      { id: "z", name: "Zed" },
      { id: "k", name: "Zed / Kid" },
    ]);
  });

  it("drops parentId and collapsed from the saved shape", () => {
    for (const folder of normalizeFolderState(nested).folders) {
      expect(Object.keys(folder).sort()).toEqual(["id", "name"]);
    }
  });
});
