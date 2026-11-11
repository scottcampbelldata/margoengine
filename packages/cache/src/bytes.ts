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
