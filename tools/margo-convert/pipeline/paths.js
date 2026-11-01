// File-system containment for margo-convert. A .gltf names its external buffers and images by URI, and a build's
// manifest names the files it wrote: both are input the tool did not choose, so every path read from them must stay
// inside its folder (lexically and after following symlinks) before anything is read, written or deleted.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, win32 } from 'node:path';

/** The MargoError shape (name `MargoError`, a `code`; docs/conventions.md), local because the tool ships on its own. */
export const margoError = (/** @type {string} */ code, /** @type {string} */ message) =>
  Object.assign(new Error(message), { name: 'MargoError', code });

/** True when target (absolute) is folder itself or below it. @param {string} folder @param {string} target */
function under(folder, target) {
  const rel = relative(folder, target);
  return !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

/** An absolute path in either OS's syntax: `/x`, `\x`, `C:\x`, `C:x` (drive relative), `\\server\share`, `//x`. */
const absoluteAnywhere = (/** @type {string} */ path) =>
  posix.isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path);

/**
 * The absolute path of `path` inside `folder`, or undefined when it is absolute in any OS's syntax, has a NUL, or
 * resolves (after `..` and after following symlinks of the parts that exist) outside the folder.
 * @param {string} folder @param {string} path @returns {string|undefined}
 */
export function inside(folder, path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || absoluteAnywhere(path)) return undefined;
  // `\` is a separator on Windows; treat it as one everywhere so a path means the same on every OS.
  const root = resolve(folder),
    target = resolve(root, path.replace(/\\/g, '/'));
  if (!under(root, target)) return undefined;
  // A symlink inside the folder may point out of it: compare the real paths of the deepest part that exists.
  let probe = target;
  while (!existsSync(probe) && under(root, probe) && probe !== root) probe = resolve(probe, '..');
  if (existsSync(probe) && existsSync(root) && !under(realpathSync(root), realpathSync(probe))) return undefined;
  return target;
}

/**
 * The path of a file a model names by URI (already percent-decoded), inside the model's folder.
 * @param {string} folder the folder of the .gltf @param {string} uri @returns {string}
 * @throws {Error} MargoError `failed` when the URI leaves the folder
 */
export function modelFile(folder, uri) {
  const path = inside(folder, uri);
  if (path === undefined)
    throw margoError(
      'failed',
      `external file ${uri} is outside the model's folder; copy it next to the .gltf (or into a subfolder) and point the uri there`,
    );
  return path;
}

/**
 * True when a and b name the same file: one path, a `./` or case alias (Windows and macOS file systems ignore case),
 * a symlink or a hard link. A path that does not exist is not the same as any file.
 * @param {string} a @param {string} b @returns {boolean}
 */
export function sameFile(a, b) {
  if (resolve(a) === resolve(b)) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  const x = statSync(a, { bigint: true }),
    y = statSync(b, { bigint: true });
  if (x.ino !== 0n && x.dev === y.dev && x.ino === y.ino) return true;
  // File systems without stable inode numbers: compare the real paths, ignoring case on Windows.
  const real = (/** @type {string} */ p) => {
    const path = realpathSync.native(p);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  };
  return real(a) === real(b);
}
