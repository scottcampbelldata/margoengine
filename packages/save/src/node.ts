// File storage for Node, Electron and other servers: one file per key in a directory, written to a temporary file and
// renamed into place, so a crash mid-write leaves the previous save whole. A separate entry, so browser bundles never
// see node:fs.
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep, toNamespacedPath } from 'node:path';
import { MargoError } from '@margoengine/math/errors';
import { keyQueue } from './queue.js';
import type { SaveStorage } from './storage.js';

const SUFFIX = '.save';
/** Capitals are escaped too, as most Windows and Mac disks fold case, and `*`, which Windows refuses in a name. */
const fileName = (key: string): string =>
  encodeURIComponent(key).replace(/%[0-9A-F]{2}|[A-Z*]/g, (found) =>
    found.length > 1 ? found : `%${found.charCodeAt(0).toString(16).toUpperCase()}`,
  ) + SUFFIX;
const checkKey = (key: string): void => {
  if (typeof key !== 'string' || !key) throw new TypeError('Save key must be a non-empty string, e.g. "slot-1"');
};
const isMissing = (error: unknown): boolean => (error as { code?: string })?.code === 'ENOENT';
/** Node rejects an aborted fs call with its own AbortError; report the signal's reason, as every adapter does. */
const reason = (error: unknown, signal?: AbortSignal): unknown => (signal?.aborted ? signal.reason : error);

let counter = 0;

/** Options of {@link fileStorage}. */
export interface FileStorageOptions {
  /**
   * The largest save a read accepts, in bytes; a bigger file is refused from its size, before any of it is read.
   * Default 268,435,456 (256 MiB), the `decodeSave` default.
   */
  maxBytes?: number;
}

// Windows refuses to rename over a file with any open handle. Reads, renames and deletes of one file take turns, across
// every fileStorage of this process; the slow part of a write, its temporary file, does not wait.
const turn = keyQueue();
/** On Windows these mean the target is open elsewhere. */
const isHeld = (error: unknown): boolean =>
  process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes((error as { code?: string })?.code ?? '');

/**
 * Makes a folder's entries reach the disk: fsync of a file does not cover its name (Pillai et al., OSDI 2014). Windows
 * has no fsync of a folder, and a file system that has none answers EINVAL or ENOTSUP.
 */
async function syncFolder(folder: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(folder, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes((error as { code?: string })?.code ?? '')) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Saves as files in `directory` (created on first write): the key, percent-escaped with its capitals, and `.save`. Writes go to a
 * temporary file first, made exclusively under this process's id, and are renamed over the old save, which is atomic on
 * one file system, and the folder is then fsynced where the system has that. On Windows a save that
 * another program has open cannot be replaced: the write rejects with MargoError `'failed'` and the old save stands.
 * Use one writer per folder: a second process saving the same key races the first, and the last rename wins.
 * @throws RangeError when `maxBytes` is not a whole number of 0 or more.
 */
export function fileStorage(directory: string, options: FileStorageOptions = {}): SaveStorage {
  if (typeof directory !== 'string' || !directory)
    throw new TypeError('fileStorage needs a directory path, e.g. "./saves"');
  const maxBytes = options?.maxBytes ?? 268_435_456;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('fileStorage maxBytes must be a whole number of bytes, 0 or more; pass a byte count');
  const file = (key: string): string => join(directory, fileName(key));
  /** The file's bytes, refused from its size when past `maxBytes`, so a huge or hostile file is never read. */
  const load = async (key: string, path: string, signal?: AbortSignal): Promise<Uint8Array> => {
    const handle = await open(path);
    try {
      const { size } = await handle.stat();
      if (size > maxBytes)
        throw new MargoError(
          'failed',
          `Save '${key}' is ${size} bytes, past maxBytes ${maxBytes}; it is not a save of this game, or pass a larger maxBytes to fileStorage`,
        );
      const out = new Uint8Array(size);
      let at = 0;
      while (at < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(out, at, size - at, at);
        if (!bytesRead) break;
        at += bytesRead;
      }
      // A file cut short by another program reads as what is left; safeStorage's checksum finds that damage.
      return at === size ? out : out.subarray(0, at);
    } finally {
      await handle.close();
    }
  };
  return {
    async read(key, options) {
      checkKey(key);
      options?.signal?.throwIfAborted();
      try {
        const path = file(key);
        return await turn(resolve(path), () => load(key, path, options?.signal));
      } catch (error) {
        if (isMissing(error)) return null;
        throw reason(error, options?.signal);
      }
    },
    async write(key, bytes, options) {
      checkKey(key);
      if (!(bytes instanceof Uint8Array))
        throw new TypeError('Save bytes must be a Uint8Array; encode the document with encodeSave');
      options?.signal?.throwIfAborted();
      const made = await mkdir(directory, { recursive: true });
      const temporary = `${file(key)}.${process.pid}-${Date.now().toString(36)}-${++counter}.tmp`;
      try {
        // 'wx': made only if no file has the name, so two writers never fill one temporary file.
        await writeFile(temporary, bytes, { signal: options?.signal, flush: true, flag: 'wx' });
        options?.signal?.throwIfAborted();
        await turn(resolve(file(key)), () => rename(temporary, file(key)));
      } catch (error) {
        if ((error as { code?: string })?.code === 'EEXIST')
          throw Object.assign(
            new MargoError(
              'failed',
              `Save '${key}' could not make its temporary file, as another writer has one of that name; use one fileStorage writer per folder`,
            ),
            { cause: error },
          );
        await rm(temporary, { force: true });
        if (isHeld(error) && !options?.signal?.aborted)
          throw Object.assign(
            new MargoError(
              'failed',
              `Save '${key}' is open in another program, so the old save stands; close it and save again`,
            ),
            { cause: error },
          );
        throw reason(error, options?.signal);
      }
      await syncFolder(directory);
      // A folder this write made is an entry of its parent, up to the first that was already there.
      // mkdir answers with a namespaced path, so the levels are counted on that form.
      if (made) {
        const levels = toNamespacedPath(resolve(directory)).split(sep).length - made.split(sep).length;
        for (let level = 0, folder = dirname(resolve(directory)); level <= levels; level++, folder = dirname(folder))
          await syncFolder(folder);
      }
    },
    async delete(key, options) {
      checkKey(key);
      options?.signal?.throwIfAborted();
      try {
        await turn(resolve(file(key)), () => rm(file(key)));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async keys(options) {
      options?.signal?.throwIfAborted();
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      return names
        .filter((name) => name.endsWith(SUFFIX))
        .map((name) => decodeURIComponent(name.slice(0, -SUFFIX.length)))
        .sort();
    },
  };
}
