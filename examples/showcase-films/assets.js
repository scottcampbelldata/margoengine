// Where the films find their asset files. Assets never go in git: they live in the asset library
// (its showcase-films folder, ../../Assets/blender-library beside the checkout by default), which the repository's Vite dev server serves at
// /asset-library/ (vite.config.mjs assetLibrary, folder set by MARGO_ASSET_LIBRARY). A page's ?assets= parameter names
// another root, absolute or relative to the page, for example ?assets=https://cdn.example.com/showcase-films/.

/** The default asset root: the showcase-films folder of the asset library, as the examples server serves it. */
export const DEFAULT_ASSET_ROOT = '/asset-library/showcase-films/';

/**
 * The asset root for a page address: its `assets` query parameter, or else {@link DEFAULT_ASSET_ROOT}.
 * @param {string | URL} [page] The page address; the current page in a browser.
 * @returns {URL} The root, always ending in a slash.
 */
export function assetRoot(page = globalThis.location?.href) {
  if (page === undefined) throw new TypeError('assetRoot needs a page address outside a browser');
  const base = new URL(page),
    named = base.searchParams.get('assets');
  const root = named?.trim() ? named.trim() : DEFAULT_ASSET_ROOT;
  return new URL(root.endsWith('/') ? root : root + '/', base);
}

/**
 * The address of one asset file under the asset root.
 * @param {string} path The file's path inside the root, for example `technical-films/turbofan.glb`.
 * @param {string | URL} [page] The page address; the current page in a browser.
 * @returns {string}
 */
export function asset(path, page) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..'))
    throw new RangeError(`asset path must be relative and stay inside the asset root: ${String(path)}`);
  return new URL(path, assetRoot(page)).href;
}
