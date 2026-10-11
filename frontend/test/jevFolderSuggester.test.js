import { describe, expect, it, vi } from "vitest";
import { suggestFolderWithJev } from "../src/jevFolderSuggester.js";

const draft = { title: "Essay", text: "Why I want to study CS" };
const folders = [{ id: "f1", path: "College apps" }];

describe("suggestFolderWithJev", () => {
  it("posts the draft and folders and returns the suggested folder id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ folderId: "f1", probabilities: { f1: 0.9 } }),
    });

    expect(await suggestFolderWithJev(draft, folders, fetchImpl)).toBe("f1");
    expect(fetchImpl).toHaveBeenCalledWith("/api/folders/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft, folders }),
    });
  });

  it("returns null when Jev leaves the draft unfiled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ folderId: null, probabilities: {} }),
    });

    expect(await suggestFolderWithJev(draft, folders, fetchImpl)).toBeNull();
  });

  it("throws when the request fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502 });

    await expect(suggestFolderWithJev(draft, folders, fetchImpl)).rejects.toThrow(
      "Folder suggestion failed (502)",
    );
  });
});
