// A package that declares @margoengine/math imports its public entries instead of bundling a copy of each (KB-INL1).
// Bundled, every package dist carried its own MargoError class, and an app holding several packages held one class per
// package. Module workers keep their copy: a worker reads no import map, so build-workers.js bundles everything.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
