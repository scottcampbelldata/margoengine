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
 * Packages whose dists import HELPERS_ENTRY for the shared error and hypot helpers instead of bundling a
 * copy of packages/shared/errors.js and hypot.js (KB-INL1 part B). Since Scott's 2026-11-26 ruling the entry is
 * core's own: `@margoengine/core/extension` exports the same seven helpers, so the app holds one copy, core's. errors.js is redirected whole, so a package here
 * may import only the names the entry exports (fault, margoError, rangeError, typeError; tests/no-inlined-margo-error.test.js
 * checks every dist import). Adding a package here needs its GPU checks run.
 */
export const SHARED_HELPERS = Object.freeze([
  '@margoengine/controls',
  '@margoengine/environment',
  '@margoengine/gltf',
  '@margoengine/shadows',
]);

/** Where the SHARED_HELPERS packages take the shared helpers from; `@margoengine/math/helpers` exports the same names. */
export const HELPERS_ENTRY = '@margoengine/core/extension';
const CORE = '@margoengine/core';
/** Whether a manifest lists `@margoengine/core` as a dependency or peer dependency. */
export const declaresCore = (manifest) => Boolean({ ...manifest.dependencies, ...manifest.peerDependencies }[CORE]);

const SHARED = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/shared');
/**
 * Files of a SHARED_HELPERS package that its data entries load (no core, no GPU: tests/modern-data-subpaths.test.js).
 * They import the same helpers from `@margoengine/math/helpers`, which the package declares, so a data entry needs no
 * core and the dist still holds no copy (KB-GLTF-DATADEP1).
 */
const DATA_IMPORTERS = new Set(
  [
    'packages/gltf/src/accessor.ts',
    'packages/gltf/src/asset.ts',
    'packages/gltf/src/draco-state.ts',
    'packages/shared/glb.js',
    'packages/shared/loading.js',
  ].map((file) => resolve(dirname(fileURLToPath(import.meta.url)), '../..', file)),
);
/** Where a data importer takes the shared helpers from. */
export const DATA_HELPERS_ENTRY = '@margoengine/math/helpers';
const HELPER_FILES = new Set(['errors.js', 'hypot.js'].map((file) => join(SHARED, file)));

/**
 * Vite plugin for a package on SHARED_HELPERS that declares core: an import that resolves to packages/shared/errors.js
 * or hypot.js becomes the external HELPERS_ENTRY. Any other package, or one without core, gets a plugin that changes
 * nothing. Never for module workers (build-workers.js): a worker reads no import map.
 * @param {{ name?: string, dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }} manifest
 */
export function sharedHelpers(manifest) {
  const on = SHARED_HELPERS.includes(manifest.name) && declaresCore(manifest);
  return {
    name: 'margo-shared-helpers',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!on || !importer || !/^\.{1,2}\//.test(source)) return null;
      const target = resolve(dirname(importer.split('?')[0]), source);
      // Side-effect free, as the entry is: a module that imports nothing from it then keeps no bare import of it.
      if (!HELPER_FILES.has(target)) return null;
      const id = DATA_IMPORTERS.has(resolve(importer.split('?')[0])) ? DATA_HELPERS_ENTRY : HELPERS_ENTRY;
      return { id, external: true, moduleSideEffects: false };
    },
  };
}
