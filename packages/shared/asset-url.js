// URIs read from inside a model file (glTF buffers and images, FBX/MTL texture names, 3MF/USDZ references) are
// untrusted. They resolve against the file's own URL and must stay inside its directory on the same origin; anything
// else (absolute or cross-origin URLs, `../` past the base, non-HTTP schemes such as javascript:, file: or blob:) is
// refused unless it lies under one of the app's `allowedURLs` entries. data: URIs are decoded by each loader within
// its byte budget and never reach this function.

// Encoded separators and encoded dot segments are refused on every branch: some servers decode `..%2F` or `%2e%2e`
// into a parent step after this check, so a path that looks contained here could leave the directory there.
const ENCODED_ESCAPE = /%2f|%5c|(^|\/)(\.|%2e){1,2}(\/|$)/i;

/**
 * True when url lies under the allowedURLs entry prefix. An entry ending in `/` is a directory and matches everything
 * below it; any other entry matches that exact path, or a directory of that name (`/assets` matches `/assets`,
 * `/assets/x.png` and `/assets?v=1`, never `/assets-other`). An entry with a query string matches only that query.
 */
function underPrefix(url, prefix) {
  let entry;
  try {
    entry = new URL(prefix);
  } catch {
    throw new TypeError(`allowedURLs entry ${String(prefix)} is not an absolute URL; pass a full http(s) URL`);
  }
  if (entry.origin !== url.origin || (entry.protocol !== 'http:' && entry.protocol !== 'https:')) return false;
  if (entry.search && entry.search !== url.search) return false;
  const dir = entry.pathname;
  if (dir.endsWith('/')) return url.pathname.startsWith(dir);
  return url.pathname === dir || url.pathname.startsWith(`${dir}/`);
}

/** Resolve a model-file URI against base (the model's URL), or throw a TypeError naming the refused URL. */
export function assetURL(uri, base, allowedURLs = [], label = 'Asset') {
  if (typeof uri !== 'string' || !uri || uri.length > 8192)
    throw new TypeError(`Invalid ${label} URI; pass a shorter string`);
  let url;
  try {
    url = new URL(uri, base);
  } catch {
    throw new TypeError(`Invalid ${label} URI; pass a valid URL`);
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !ENCODED_ESCAPE.test(url.pathname)) {
    for (const prefix of allowedURLs) if (underPrefix(url, prefix)) return url;
    const root = base === undefined ? undefined : new URL('.', base);
    if (root && url.origin === root.origin && url.pathname.startsWith(root.pathname)) return url;
  }
  throw new TypeError(
    `${label} URI ${url.href} leaves the model's directory; add its prefix to allowedURLs to load it`,
  );
}

/**
 * Check where a fetch of a model-file resource ended up: fetch follows redirects, so the final `response.url` passes
 * the same assetURL policy (base and allowedURLs) as the URI did. On a violation the body is cancelled unread and a
 * TypeError names the final URL. A response with no url (a custom fetch that builds its own Response) is taken as the
 * URL it was asked for.
 */
export function checkRedirect(response, base, allowedURLs = [], label = 'Asset') {
  if (!response.url) return response;
  try {
    assetURL(response.url, base, allowedURLs, label);
  } catch {
    response.body?.cancel().catch(() => {});
    throw new TypeError(
      `${label} URI redirected to ${response.url}, which leaves the model's directory; add its prefix to allowedURLs to load it`,
    );
  }
  return response;
}
