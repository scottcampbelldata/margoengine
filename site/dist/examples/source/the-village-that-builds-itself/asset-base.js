// Heavy example files stay out of git. They load from this bucket.
// Change ASSET_BASE to move them. ASSET_FALLBACK is the same keys on this site,
// used when a direct fetch to the bucket fails. Set globalThis.MARGO_EXAMPLES_ASSET_BASE
// before the modules load to override the bucket for a whole page.
export const ASSET_BASE = 'https://assets.margoengine.com/examples/';
export const ASSET_FALLBACK = '/examples/assets/';

function withSlash(base) {
  return base.endsWith('/') ? base : `${base}/`;
}

function activeBase() {
  const override = globalThis.MARGO_EXAMPLES_ASSET_BASE;
  return withSlash(override || ASSET_BASE);
}

/** Absolute URL for one heavy file. `key` is the path under the bucket, such as `last-tram/depot.glb`. */
export function exampleAsset(key) {
  return new URL(String(key).replace(/^\//, ''), activeBase()).href;
}

/** Site path for a file that ships with the build, under /examples/packed/. */
export function packedAsset(key) {
  return `/examples/packed/${String(key).replace(/^\//, '')}`;
}

/**
 * Fetch a heavy file from the bucket, then from ASSET_FALLBACK if that request fails or is not ok.
 * glTF loads use exampleAsset() instead, so relative buffers resolve next to the model.
 */
export async function fetchExampleAsset(key, init) {
  const primary = exampleAsset(key);
  try {
    const response = await fetch(primary, init);
    if (response.ok) return response;
  } catch (error) {
    if (init && init.signal && init.signal.aborted) throw error;
  }
  const fallback = new URL(String(key).replace(/^\//, ''), withSlash(ASSET_FALLBACK)).href;
  if (fallback === primary) return fetch(primary, init);
  return fetch(fallback, init);
}
