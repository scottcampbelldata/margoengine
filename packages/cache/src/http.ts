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
 * Whether a request's `If-Range` lets a stored copy answer its `Range` (RFC 9110 section 13.1.5): true when absent; an
 * entity tag must equal the stored strong ETag (strong comparison, so a weak one never matches); a date must equal the
 * stored Last-Modified exactly. False sends the whole file.
 */
export function ifRange(header: string | null, etag: string | null, modified: string | null): boolean {
  if (header === null) return true;
  const value = header.trim();
  if (value.startsWith('"')) return etag !== null && etag === value;
  return modified !== null && !value.startsWith('W/') && modified.trim() === value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATES = [
  // IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
  /^(?:mon|tue|wed|thu|fri|sat|sun), (\d{2}) ([a-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) gmt$/,
  // rfc850-date: Sunday, 06-Nov-94 08:49:37 GMT
  /^(?:mon|tues|wednes|thurs|fri|satur|sun)day, (\d{2})-([a-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) gmt$/,
  // asctime-date: Sun Nov  6 08:49:37 1994 (its fields come in another order, so it is read apart below)
  /^(?:mon|tue|wed|thu|fri|sat|sun) ([a-z]{3}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/,
];

/**
 * An HTTP-date (RFC 9110 section 5.6.7: IMF-fixdate, the RFC 850 form and asctime, all UTC) in ms since the epoch,
 * matched case-insensitively as RFC 9111 section 4.2 asks of a cache; NaN for anything else, which a cache takes as
 * already expired (RFC 9111 section 5.3). A two-digit year more than 50 years ahead is the century before.
 */
export function httpDate(value: string | null, now = Date.now()): number {
  const text = value?.trim().toLowerCase() ?? '';
  let day: string, month: string, year: number, time: string[];
  let match = DATES[0].exec(text) ?? DATES[1].exec(text);
  if (match) {
    [, day, month] = match;
    year = +match[3];
    time = match.slice(4, 7);
    if (match[3].length === 2) {
      const current = new Date(now).getUTCFullYear();
      year += Math.floor(current / 100) * 100;
      if (year > current + 50) year -= 100;
    }
  } else if ((match = DATES[2].exec(text))) {
    [, month, day] = match;
    year = +match[6];
    time = match.slice(3, 6);
  } else return Number.NaN;
  const m = MONTHS.findIndex((name) => name.toLowerCase() === month),
    [h, min, s] = time.map(Number),
    d = +day.trim(),
    // A leap second (60) counts as the next second; Date.UTC would also roll a day or month over, so check it did not.
    ms = Date.UTC(year, m, d, h, min, s);
  return m < 0 || h > 23 || min > 59 || s > 60 || new Date(ms - (s === 60 ? 1000 : 0)).getUTCDate() !== d
    ? Number.NaN
    : ms;
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
  const date = httpDate(headers.get('date'), received),
    origin = Number.isNaN(date) ? received : date,
    expires = headers.get('expires'),
    lifetime = maxAge ? +maxAge[1] * 1e3 : expires === null ? Number.NaN : httpDate(expires, received) - origin,
    age = /^\d+$/.test(headers.get('age')?.trim() ?? '') ? +headers.get('age')! * 1e3 : 0,
    initial = Math.max(0, received - origin, age + received - sent);
  return lifetime > initial ? received + lifetime - initial : 0;
}

/** Retain omitted lifetime fields on validation; Date and Age come from the current response. */
export function freshnessPolicy(
  headers: Headers,
  received: number,
  sent = received,
  maxAgeOnly = false,
  saved?: { control?: string; expires?: string | null },
): { fresh: number; control: string; expires: string | null } {
  const merged = new Headers(headers);
  for (const [name, value] of [
    ['cache-control', saved?.control],
    ['expires', saved?.expires],
  ] as const)
    if (!merged.has(name) && value != null) merged.set(name, value);
  return {
    fresh: freshUntil(merged, received, sent, maxAgeOnly),
    control: merged.get('cache-control') ?? '',
    expires: merged.get('expires'),
  };
}

/** Whether a meta record is a stored file's entry (the other records are the version and what `keys` writes). */
export const isEntry = <T extends { size: number }>(value: unknown): value is T =>
  typeof (value as T | null)?.size === 'number';

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
    failure(t, no);
  });
}

/**
 * Rejects `no` when the transaction fails. A failed request raises `error` on the transaction first, while
 * `transaction.error` is still null; its own error (WebKit's UnknownError for a refused Blob) is the cause worth keeping.
 */
export function failure(t: IDBTransaction, no: (reason: unknown) => void): void {
  const why = (event?: Event) =>
    (event?.target as IDBRequest | null)?.error ?? t.error ?? new DOMException('Transaction aborted', 'AbortError');
  t.onerror = t.onabort = (event) => no(why(event));
}

/**
 * The network fetch of a cache made without one: `globalThis.fetch` as it is when the cache is made. Read later, a page
 * that then sets `globalThis.fetch = cache.fetch` made the cache call itself without end and no request ever left.
 */
export function defaultFetch(): typeof globalThis.fetch {
  const base = globalThis.fetch;
  return (input, init) => (base ?? globalThis.fetch)(input, init);
}
