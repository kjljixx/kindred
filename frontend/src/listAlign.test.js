import { describe, it, expect } from "vitest";
import {
  diffList,
  createListReviewConflict,
  mergeListWithAlign,
  parseListConflicts,
  resolveListConflictHtml,
  resolveAllListConflicts,
} from "./listAlign.js";
import { htmlToDoc, blockToHtml, mergeAdjacentTopLevelLists, normalizeDoc } from "./kindredSchema.js";

function listNodeFromHtml(html) {
  const doc = htmlToDoc(html);
  return doc.content.find((node) => node.type === "bulletList" || node.type === "orderedList");
}

function listConflictsFromHtml(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const list = parsed.querySelector("ul, ol");
  return parseListConflicts(list?.getAttribute("data-kindred-list-conflicts"));
}

function countTextConflictMarkers(html) {
  return (String(html || "").match(/data-kindred-text-conflict/g) || []).length;
}

function mockLeafMerge(_base, _ours, _theirs, labelOurs, labelTheirs) {
  return {
    cleanMerge: false,
    mergedText:
      `<p>Alpha <span data-kindred-text-conflict` +
      ` data-kindred-label-ours="${labelOurs}"` +
      ` data-kindred-label-theirs="${labelTheirs}"` +
      ` data-kindred-ours="Beta"` +
      ` data-kindred-theirs="Beta changed"></span> Gamma</p>`,
  };
}

describe("diffList", () => {
  it("equal lists mark all items as equal", () => {
    const html = "<ul><li><p>Alpha</p></li><li><p>Beta</p></li><li><p>Gamma</p></li></ul>";
    const list = listNodeFromHtml(html);
    const { items } = diffList(list, listNodeFromHtml(html));
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.action === "equal")).toBe(true);
  });

  it("one text edit marks one item edit, others equal", () => {
    const oldHtml = "<ul><li><p>Alpha</p></li><li><p>Beta</p></li><li><p>Gamma</p></li></ul>";
    const newHtml = "<ul><li><p>Alpha</p></li><li><p>Beta changed</p></li><li><p>Gamma</p></li></ul>";
    const { items } = diffList(listNodeFromHtml(oldHtml), listNodeFromHtml(newHtml));
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.action === "edit")).toHaveLength(1);
    expect(items.filter((item) => item.action === "equal")).toHaveLength(2);
  });
});

describe("createListReviewConflict", () => {
  it("one edit embeds inline text conflict, not list JSON content conflict", () => {
    const current = "<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul>";
    const dirty = "<ul><li><p>Alpha</p></li><li><p>Beta changed</p></li></ul>";
    const html = createListReviewConflict(
      current,
      dirty,
      "Current",
      "Dirty",
      mockLeafMerge
    );
    expect(html).toBeTruthy();
    expect(html).toContain("data-kindred-text-conflict");
    expect(html).toContain("Beta changed");
    expect(countTextConflictMarkers(html)).toBe(1);
    expect(listConflictsFromHtml(html)).toBeNull();
  });

  it("one edit uses leaf merge for word-level conflict spans", () => {
    const current =
      "<ul><li><p>Alpha Beta Gamma</p></li></ul>";
    const dirty =
      "<ul><li><p>Alpha Beta changed Gamma</p></li></ul>";
    const html = createListReviewConflict(
      current,
      dirty,
      "Current",
      "Dirty",
      mockLeafMerge
    );
    expect(html).toBeTruthy();
    expect(countTextConflictMarkers(html)).toBe(1);
    const parsed = new DOMParser().parseFromString(html, "text/html");
    expect(parsed.body.textContent.replace(/\s/g, "")).toBe("AlphaGamma");
  });

  it("new item produces an item conflict", () => {
    const current = "<ul><li><p>Alpha</p></li></ul>";
    const dirty = "<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul>";
    const html = createListReviewConflict(current, dirty, "Current", "Dirty");
    const data = listConflictsFromHtml(html);
    expect(data.conflicts).toHaveLength(1);
    expect(data.conflicts[0]).toMatchObject({
      kind: "item",
      itemIndex: 1,
      oursHtml: "",
    });
    expect(data.conflicts[0].theirsHtml).toContain("Beta");
  });

  it("indent change produces an indent conflict", () => {
    const current = "<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul>";
    const dirty = "<ul><li><p>Alpha</p><ul><li><p>Beta</p></li></ul></li></ul>";
    const html = createListReviewConflict(current, dirty, "Current", "Dirty");
    const data = listConflictsFromHtml(html);
    expect(data.conflicts).toHaveLength(1);
    expect(data.conflicts[0]).toMatchObject({
      kind: "indent",
      itemIndex: 1,
    });
    expect(data.conflicts[0].indentHtml).toContain("Beta");
    expect(data.conflicts[0].outdentHtml).toContain("Beta");
  });

  it("preserves list item index through schema round-trip", () => {
    const current = "<ul><li><p>Alpha</p></li></ul>";
    const dirty = "<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul>";
    const html = createListReviewConflict(current, dirty, "Current", "Dirty");
    const doc = htmlToDoc(html);
    const listNode = doc.content.find(
      (node) => node.type === "bulletList" || node.type === "orderedList"
    );
    expect(blockToHtml(listNode)).toContain("data-kindred-list-item-index");
  });
});

describe("mergeListWithAlign", () => {
  const base = "<ul><li><p>Alpha</p></li><li><p>Beta</p></li><li><p>Gamma</p></li></ul>";

  it("auto-merges non-overlapping edits", () => {
    const ours = "<ul><li><p>Alpha changed</p></li><li><p>Beta</p></li><li><p>Gamma</p></li></ul>";
    const theirs = "<ul><li><p>Alpha</p></li><li><p>Beta changed</p></li><li><p>Gamma</p></li></ul>";
    const merged = mergeListWithAlign(base, ours, theirs, "Ours", "Theirs");
    expect(merged.conflictCount).toBe(0);
    expect(merged.html).toContain("Alpha changed");
    expect(merged.html).toContain("Beta changed");
    expect(merged.html).not.toContain("data-kindred-text-conflict");
  });

  it("embeds inline text conflict when both sides edit the same item", () => {
    const ours = "<ul><li><p>Alpha</p></li><li><p>Beta ours</p></li><li><p>Gamma</p></li></ul>";
    const theirs = "<ul><li><p>Alpha</p></li><li><p>Beta theirs</p></li><li><p>Gamma</p></li></ul>";
    const merged = mergeListWithAlign(base, ours, theirs, "Ours", "Theirs", mockLeafMerge);
    expect(merged.conflictCount).toBe(0);
    expect(merged.html).toContain("data-kindred-text-conflict");
    expect(countTextConflictMarkers(merged.html)).toBe(1);
    expect(listConflictsFromHtml(merged.html)).toBeNull();
  });
});

describe("middle delete review", () => {
  it("delete middle item produces one item delete conflict", () => {
    const head =
      "<ul><li><p>Top</p></li><li><p>Middle</p></li><li><p>Bottom</p></li></ul>";
    const dirty = "<ul><li><p>Top</p></li><li><p>Bottom</p></li></ul>";
    const listNode = (html) =>
      htmlToDoc(html).content.find(
        (n) => n.type === "bulletList" || n.type === "orderedList"
      );
    const diff = diffList(listNode(head), listNode(dirty));
    expect(diff.items.map((i) => i.action)).toEqual(["equal", "delete", "equal"]);
    const review = createListReviewConflict(head, dirty, "main", "dirty");
    expect(review).toBeTruthy();
    expect(review).toContain("data-kindred-list-conflicts");
  });

  it("mergeAdjacentTopLevelLists joins split top-level lists", () => {
    const split =
      "<ul><li><p>Top</p></li></ul><ul><li><p>Bottom</p></li></ul>";
    const doc = mergeAdjacentTopLevelLists(normalizeDoc(htmlToDoc(split)));
    const lists = doc.content.filter(
      (n) => n.type === "bulletList" || n.type === "orderedList"
    );
    expect(lists).toHaveLength(1);
    expect(lists[0].content).toHaveLength(2);
  });
});

describe("resolveListConflictHtml", () => {
  it("removes a resolved item conflict", () => {
    const current = "<ul><li><p>Alpha</p></li></ul>";
    const dirty = "<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul>";
    const html = createListReviewConflict(current, dirty, "Current", "Dirty");
    const conflictId = listConflictsFromHtml(html).conflicts[0].id;
    const resolved = resolveListConflictHtml(html, conflictId, "theirs");
    expect(listConflictsFromHtml(resolved)).toBeNull();
    expect(resolved).toContain("Beta");
  });

  it("resolves indent conflict with outdent", () => {
    const current = "<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul>";
    const dirty = "<ul><li><p>Alpha</p><ul><li><p>Beta</p></li></ul></li></ul>";
    const html = createListReviewConflict(current, dirty, "Current", "Dirty");
    const conflictId = listConflictsFromHtml(html).conflicts[0].id;
    const resolved = resolveListConflictHtml(html, conflictId, "outdent");
    expect(listConflictsFromHtml(resolved)).toBeNull();
    const parsed = new DOMParser().parseFromString(resolved, "text/html");
    const topItems = [...parsed.querySelector("ul").children].filter(
      (el) => el.tagName === "LI"
    );
    expect(topItems).toHaveLength(2);
    expect(topItems[0].textContent).toContain("Alpha");
    expect(topItems[1].textContent).toContain("Beta");
    expect(parsed.querySelector("ul ul")).toBeNull();
  });
});

describe("resolveAllListConflicts", () => {
  function countLi(html) {
    return new DOMParser().parseFromString(html, "text/html").querySelectorAll("li").length;
  }

  const nestedCurrent = "<ul><li><p>test</p></li></ul>";
  const nestedDirty =
    "<ul><li><p>test</p><ul><li><p>test</p><ul><li><p>test</p></li></ul></li></ul></li></ul>";

  function nestedReviewHtml() {
    return createListReviewConflict(nestedCurrent, nestedDirty, "Current", "Dirty");
  }

  function conflictAt(html, itemIndex) {
    return listConflictsFromHtml(html).conflicts.find((c) => c.itemIndex === itemIndex);
  }

  it("keeps nested insert count when leaving review with all theirs", () => {
    const html = nestedReviewHtml();
    expect(html).toBeTruthy();
    expect(countLi(html)).toBe(3);
    const resolved = resolveAllListConflicts(html, "theirs");
    expect(countLi(resolved)).toBe(3);
  });

  it("remove inner nested insert drops only that row", () => {
    const html = nestedReviewHtml();
    const conflict = conflictAt(html, 2);
    const resolved = resolveListConflictHtml(html, conflict.id, "ours");
    expect(countLi(resolved)).toBe(2);
    const parsed = new DOMParser().parseFromString(resolved, "text/html");
    expect(parsed.querySelectorAll("li:empty").length).toBe(0);
    expect(parsed.body.textContent.replace(/\s/g, "")).toBe("testtest");
  });

  it("remove middle nested insert promotes inner row", () => {
    const html = nestedReviewHtml();
    const conflict = conflictAt(html, 1);
    const resolved = resolveListConflictHtml(html, conflict.id, "ours");
    expect(countLi(resolved)).toBe(2);
    const parsed = new DOMParser().parseFromString(resolved, "text/html");
    const top = [...parsed.querySelector("ul").children].filter((el) => el.tagName === "LI");
    expect(top).toHaveLength(1);
    expect(top[0].textContent.replace(/\s/g, "")).toBe("testtest");
    expect(top[0].querySelectorAll("li").length).toBe(1);
  });
});
