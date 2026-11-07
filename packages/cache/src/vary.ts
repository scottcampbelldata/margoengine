import type { AssetCacheKeys } from './index.js';

/** Options for `varyKeys(...)`. */
export interface VaryKeysOptions {
  /**
   * Who the content is for, such as the signed-in user's id, or a function read on every request. Entries stored under
   * one partition are never served under another. A page cannot read the cookies a request sends, so set this when
   * cookies decide the content. Default `''`.
   */
  partition?: string | (() => string);
  /** Request headers that split entries whatever `Vary` says, lowercase. Default `['authorization']`. */
  headers?: readonly string[];
}

const hex = async (value: unknown) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');

/** The header names of a `Vary` value, lowercase, sorted and unique; `['*']` for `Vary: *`. */
export function varyNames(vary: string | null): string[] {
  const names = [
    ...new Set(
      (vary ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
  return names.includes('*') ? ['*'] : names;
}

/**
 * Cache keys that split stored entries by the response's `Vary` header and by credentials, so negotiated or
 * authenticated content is never served to the wrong request (RFC 9111 section 4.1). Pass it as AssetCache's `keys`.
 * A request's key covers whether it sends credentials (its `credentials` mode and origin), the `partition`, the values
 * of `headers` (Authorization by default) and the values of the request headers the stored response's `Vary` names.
 * Every value goes into the key as a SHA-256 hash, so no header value is written to storage. `Vary: *` is never
 * stored. Each URL and credential set remembers the last `Vary` it saw; entries stored under an older one are no longer
 * found and are evicted in time.
 */
export function varyKeys({ partition = '', headers = ['authorization'] }: VaryKeysOptions = {}): AssetCacheKeys {
  const base = (request: Request, url: string) => {
    const origin = globalThis.location?.origin,
      credentials =
        request.credentials === 'include' ||
        (request.credentials === 'same-origin' && !!origin && new URL(url).origin === origin);
    return hex([
      credentials,
      typeof partition === 'function' ? partition() : partition,
      headers.map((name) => request.headers.get(name)),
    ]);
  };
  const variant = async (request: Request, url: string, first: string, names: string[]) =>
    `${url}\n${await hex([first, names, names.map((name) => request.headers.get(name))])}`;
  return {
    async lookup(request, url, read) {
      const first = await base(request, url),
        names = await read(`${url}\n${first}`);
      return variant(request, url, first, Array.isArray(names) ? names : []);
    },
    async store(request, url, response) {
      const names = varyNames(response.headers.get('vary'));
      if (names[0] === '*') return;
      const first = await base(request, url);
      return { key: await variant(request, url, first, names), records: [[`${url}\n${first}`, names]] };
    },
  };
}
