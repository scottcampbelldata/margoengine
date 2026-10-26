// @ts-check
// Texture handling for margo-convert. `sharp` (libvips) is used for WebP, AVIF and JPEG encoding and for resizing
// when the project has it installed; nothing is downloaded and it is never required.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {any} Sharp the `sharp` module's default export (typed loosely: it is an optional tool) */

/** @type {Promise<Sharp|null>|undefined} */
let sharpPromise;

/**
 * The `sharp` module if it is installed, otherwise null. Looked up once: first where this package can see it, then in
 * the project the command runs in (`npx margo-convert` runs from a cache folder that cannot see the project's modules).
 * @returns {Promise<Sharp|null>}
 */
export function loadSharp() {
  sharpPromise ??= (async () => {
    for (const find of [
      () => import('sharp'),
      () => import(pathToFileURL(createRequire(join(process.cwd(), 'noop.js')).resolve('sharp')).href),
    ]) {
      try {
        const module = await find();
        return module.default ?? module;
      } catch {
        // not installed there
      }
    }
    return null;
  })();
  return sharpPromise;
}
