// @ts-check
// File-system identity for margo-convert-cad: the CLI refuses an output path that names its input.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

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
