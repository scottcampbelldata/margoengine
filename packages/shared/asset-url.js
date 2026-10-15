// URIs read from inside a model file (glTF buffers and images, FBX/MTL texture names, 3MF/USDZ references) are
// untrusted. They resolve against the file's own URL and must stay inside its directory on the same origin; anything
// else (absolute or cross-origin URLs, `../` past the base, non-HTTP schemes such as javascript:, file: or blob:) is
// refused unless it starts with one of the app's `allowedURLs` prefixes. data: URIs are decoded by each loader within
// its byte budget and never reach this function.

/** Resolve a model-file URI against base (the model's URL), or throw a TypeError naming the refused URL. */
export function assetURL(uri, base, allowedURLs = [], label = 'Asset') {
  if (typeof uri !== 'string' || !uri || uri.length > 8192) throw new TypeError(`Invalid ${label} URI`);
  let url;
  try {
    url = new URL(uri, base);
  } catch {
    throw new TypeError(`Invalid ${label} URI`);
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    for (const prefix of allowedURLs) if (url.href.startsWith(new URL(prefix).href)) return url;
    const root = base === undefined ? undefined : new URL('.', base);
    // Encoded separators are refused too: some servers decode `..%2F` into a parent step after this check.
    if (root && url.origin === root.origin && url.pathname.startsWith(root.pathname) && !/%2f|%5c/i.test(url.pathname))
      return url;
  }
  throw new TypeError(
    `${label} URI ${url.href} leaves the model's directory; add its prefix to allowedURLs to load it`,
  );
}
