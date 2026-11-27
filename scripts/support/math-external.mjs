// A package that declares @margoengine/math imports its public entries instead of bundling a copy of each (KB-INL1).
// Bundled, every package dist carried its own MargoError class, and an app holding several packages held one class per
// package. Module workers keep their copy: a worker reads no import map, so build-workers.js bundles everything.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MATH = '@margoengine/math';

/** True when `manifest` declares @margoengine/math as a dependency or a peer dependency. */
export const declaresMath = (manifest) => Boolean({ ...manifest.dependencies, ...manifest.peerDependencies }[MATH]);

/**
 * Rollup `external` test for @margoengine/math and its subpaths, or a test that matches nothing when `manifest` does
 * not declare math (a package cannot import what it does not install).
 * @param {{ dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }} manifest
 * @returns {(id: string) => boolean}
 */
export function mathExternal(manifest) {
  if (!declaresMath(manifest)) return () => false;
  return (id) => id === MATH || id.startsWith(MATH + '/');
}

/**
 * `external` list or test with @margoengine/math added for a package that declares it.
 * @param {{ dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }} manifest
 * @param {Array<string | RegExp> | ((id: string) => boolean)} external
 * @returns {(id: string) => boolean}
 */
export function withMathExternal(manifest, external) {
  const math = mathExternal(manifest);
  const other =
    typeof external === 'function'
      ? external
      : (id) => external.some((entry) => (typeof entry === 'string' ? entry === id : entry.test(id)));
  return (id) => math(id) || Boolean(other(id));
}

/**
 * `withMathExternal` for the package in folder `root`, for build scripts that do not read their manifest.
 * @param {string} root
 * @param {Array<string | RegExp> | ((id: string) => boolean)} external
 */
export const packageExternal = (root, external) =>
  withMathExternal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), external);

/**
 * Packages whose dists import `@margoengine/math/helpers` for the shared error and hypot helpers instead of bundling a
 * copy of packages/shared/errors.js and hypot.js (KB-INL1 part B). errors.js is redirected whole, so a package here
 * may import only the names the entry exports (fault, margoError, rangeError, typeError; tests/no-inlined-margo-error.test.js
 * checks every dist import). Adding a package here needs its GPU checks run.
 */
export const SHARED_HELPERS = Object.freeze([
  '@margoengine/controls',
  '@margoengine/environment',
  '@margoengine/shadows',
]);

const SHARED = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/shared');
const HELPER_FILES = new Set(['errors.js', 'hypot.js'].map((file) => join(SHARED, file)));

/**
 * Vite plugin for a package on SHARED_HELPERS that declares math: an import that resolves to packages/shared/errors.js
 * or hypot.js becomes the external `@margoengine/math/helpers`. Any other package, or one without math, gets a plugin that changes
 * nothing. Never for module workers (build-workers.js): a worker reads no import map.
 * @param {{ name?: string, dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }} manifest
 */
export function sharedHelpers(manifest) {
  const on = SHARED_HELPERS.includes(manifest.name) && declaresMath(manifest);
  return {
    name: 'margo-shared-helpers',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!on || !importer || !/^\.{1,2}\//.test(source)) return null;
      const target = resolve(dirname(importer.split('?')[0]), source);
      // Side-effect free, as the entry is: a module that imports nothing from it then keeps no bare import of it.
      return HELPER_FILES.has(target) ? { id: `${MATH}/helpers`, external: true, moduleSideEffects: false } : null;
    },
  };
}
