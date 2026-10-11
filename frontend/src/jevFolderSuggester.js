/** Ask Jev which of the given folders a new draft belongs in; resolves to a folder id or null. */
export async function suggestFolderWithJev(draft, folders, fetchImpl = fetch) {
  const response = await fetchImpl("/api/folders/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, folders }),
  });

  if (!response.ok) {
    throw new Error(`Folder suggestion failed (${response.status})`);
  }

  const { folderId } = await response.json();
  return folderId;
}
