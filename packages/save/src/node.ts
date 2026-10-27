// File storage for Node, Electron and other servers: one file per key in a directory, written to a temporary file and
// renamed into place, so a crash mid-write leaves the previous save whole. A separate entry, so browser bundles never
// see node:fs.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SaveStorage } from './storage.js';

const SUFFIX = '.save';
const checkKey = (key: string): void => {
  if (typeof key !== 'string' || !key) throw new TypeError('Save key must be a non-empty string, e.g. "slot-1"');
};
const isMissing = (error: unknown): boolean => (error as { code?: string })?.code === 'ENOENT';
/** Node rejects an aborted fs call with its own AbortError; report the signal's reason, as every adapter does. */
const reason = (error: unknown, signal?: AbortSignal): unknown => (signal?.aborted ? signal.reason : error);

let counter = 0;

/**
 * Saves as files in `directory` (created on first write): `encodeURIComponent(key) + '.save'`. Writes go to a
 * temporary file first and are renamed over the old save, which is atomic on one file system.
 */
export function fileStorage(directory: string): SaveStorage {
  if (typeof directory !== 'string' || !directory)
    throw new TypeError('fileStorage needs a directory path, e.g. "./saves"');
  const file = (key: string): string => join(directory, encodeURIComponent(key) + SUFFIX);
  return {
    async read(key, options) {
      checkKey(key);
      options?.signal?.throwIfAborted();
      try {
        return new Uint8Array(await readFile(file(key), { signal: options?.signal }));
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
      await mkdir(directory, { recursive: true });
      const temporary = `${file(key)}.${Date.now().toString(36)}-${++counter}.tmp`;
      try {
        await writeFile(temporary, bytes, { signal: options?.signal, flush: true });
        options?.signal?.throwIfAborted();
        await rename(temporary, file(key));
      } catch (error) {
        await rm(temporary, { force: true });
        throw reason(error, options?.signal);
      }
    },
    async delete(key, options) {
      checkKey(key);
      options?.signal?.throwIfAborted();
      try {
        await rm(file(key));
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
