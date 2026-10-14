/** Random per-export token that keeps text sentinels from colliding with user text. */
export function createExportNonce() {
  return crypto.randomUUID().slice(0, 8);
}
