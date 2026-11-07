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

/**
 * Until when (ms since the epoch) a response is fresh, as a private cache computes it (RFC 9111 sections 4.2.1 and
 * 4.2.3): its lifetime is `Cache-Control: max-age`, else `Expires` minus `Date`; its age when received is the larger of
 * `Age` plus the request's round trip and how far `Date` lies behind the clock. 0 (revalidate) for `no-cache`, no
 * lifetime, an invalid `Expires` or a response already older than its lifetime. `maxAgeOnly` keeps to `max-age` alone
 * and ignores `Age`, as AssetCache did before its `freshness` option. `sent` and `received` are when the request went
 * out and the response came back.
 */
export function freshUntil(headers: Headers, received: number, sent = received, maxAgeOnly = false): number {
  const control = headers.get('cache-control') ?? '',
    maxAge = /(?:^|[,\s])max-age\s*=\s*"?(\d+)/i.exec(control);
  if (/no-cache/i.test(control)) return 0;
  if (maxAgeOnly) return maxAge ? received + +maxAge[1] * 1e3 : 0;
  const date = Date.parse(headers.get('date') ?? ''),
    origin = Number.isNaN(date) ? received : date,
    expires = headers.get('expires'),
    lifetime = maxAge ? +maxAge[1] * 1e3 : expires === null ? Number.NaN : Date.parse(expires) - origin,
    age = /^\d+$/.test(headers.get('age')?.trim() ?? '') ? +headers.get('age')! * 1e3 : 0,
    initial = Math.max(0, received - origin, age + received - sent);
  return lifetime > initial ? received + lifetime - initial : 0;
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
