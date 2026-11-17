/** One lock per S3 folder, owned by a request, so two extractions never write the same folder at once. */
export interface ScopeLocks {
  /** All-or-nothing. Re-claiming paths the request already owns succeeds. Returns the first conflicting path, if any. */
  claim(paths: string[], requestId: string): Promise<{ ok: true } | { ok: false; path: string }>;
  release(paths: string[], requestId: string): Promise<void>;
}
