// WebKit refuses every Blob put into IndexedDB in an ephemeral session (Safari Private Browsing, Playwright contexts):
// the request fails with UnknownError. ArrayBuffer values are accepted there, so a store that sees the refusal once
// keeps bytes from then on and reads either kind back as a Blob.

/** True for the error a browser raises when it will not store a Blob in IndexedDB (not a full quota, not an abort). */
export function blobRefused(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'UnknownError' || name === 'DataCloneError';
}

/** The value to put: the Blob itself, or its bytes once this database has refused Blobs. */
export function storable(blob: Blob, bytes: boolean): Blob | Promise<ArrayBuffer> {
  return bytes ? blob.arrayBuffer() : blob;
}

/** A stored value read back as a Blob, whichever form it was put in. */
export function asBlob(value: unknown, type = ''): Blob | undefined {
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return new Blob([value], { type });
  return undefined;
}

/** Key of the probe record, put and deleted again in one transaction, so nothing is left behind. */
const PROBE = '\0blob-probe';

/**
 * Whether this database stores Blobs, asked once when a cache opens. A refused Blob put must be the first request of
 * its transaction: in WebKit (Playwright 2026-11) a transaction that sent any request before the refused put never
 * completes or aborts, not even on `abort()`, and every later transaction on its stores waits behind it. So the caches
 * never find out inside a real write: this probe sends the Blob put first and alone, then deletes it. A failure that
 * is not a refusal (a full quota) answers true, and the write's own fallback still applies.
 */
export function storesBlobs(db: IDBDatabase, store: string): Promise<boolean> {
  return new Promise((ok) => {
    const t = db.transaction(store, 'readwrite'),
      data = t.objectStore(store);
    data.put(new Blob([new Uint8Array(1)]), PROBE);
    data.delete(PROBE);
    t.oncomplete = () => ok(true);
    t.onabort = () => ok(!blobRefused(t.error));
  });
}
