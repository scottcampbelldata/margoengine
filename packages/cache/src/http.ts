// HTTP helpers shared by the cache entries (internal, not a package entry).

/**
 * One byte range of a `size`-byte file from a `Range` header (RFC 9110 section 14.1.2): `[start, end]` inclusive,
 * `null` when the header is absent or not a single `bytes=` range (a multi-range request), or `'unsatisfiable'`.
 */
export function byteRange(header: string | null, size: number): [number, number] | null | 'unsatisfiable' {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || !(match[1] || match[2])) return null;
  const start = match[1] ? +match[1] : Math.max(0, size - +match[2]),
    end = match[1] && match[2] ? Math.min(+match[2], size - 1) : size - 1;
  return start > end ? 'unsatisfiable' : [start, end];
}

/** Content-Range `bytes a-b/size` as `[a, b, size]`; undefined when absent, malformed or of unknown size. */
export function contentRange(header: string | null): [number, number, number] | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? '');
  return match ? [+match[1], +match[2], +match[3]] : undefined;
}

/** Freshness end time (ms since the epoch) from `Cache-Control: max-age`; 0 (revalidate) for `no-cache` or none. */
export function freshUntil(headers: Headers, now: number): number {
  const control = headers.get('cache-control') ?? '',
    age = /max-age=(\d+)/i.exec(control);
  return age && !/no-cache/i.test(control) ? now + +age[1] * 1e3 : 0;
}

/** Runs body in one transaction over the given stores; resolves when it commits, rejects when it aborts. */
export async function transact(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (...stores: IDBObjectStore[]) => void,
): Promise<void> {
  const t = db.transaction(stores, mode);
  body(...stores.map((name) => t.objectStore(name)));
  await new Promise<void>((ok, no) => {
    t.oncomplete = () => ok();
    t.onerror = t.onabort = () => no(t.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}
