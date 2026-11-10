import { MargoError } from '@margoengine/math/errors';
import { keyQueue } from './queue.js';
import { fromBase64, toBase64, type SaveStorage } from './storage.js';

/** Options of {@link opfsStorage}. */
export interface OPFSStorageOptions {
  /** Subdirectory of the origin's private root. Default 'margo-saves'. */
  namespace?: string;
  /** An already opened private root, for workers or an application-owned directory. Default navigator.storage.getDirectory(). */
  directory?: FileSystemDirectoryHandle;
}

const header = new Uint8Array([77, 79, 80, 70, 1]);
const missing = (error: unknown): boolean => (error as { name?: string })?.name === 'NotFoundError';
const nameOf = (key: string): string => {
  if (typeof key !== 'string' || !key || new TextDecoder().decode(new TextEncoder().encode(key)) !== key)
    throw new TypeError('OPFS save key must be non-empty well-formed Unicode; supply a slot name');
  const name =
    's-' +
    toBase64(new TextEncoder().encode(key)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') +
    '.bin';
  if (name.length > 240) throw new RangeError('OPFS save key exceeds 175 UTF-8 bytes; use a shorter slot name');
  return name;
};
const keyOf = (name: string): string | undefined => {
  if (!/^s-[A-Za-z0-9_-]+\.bin$/.test(name)) return undefined;
  try {
    const key = new TextDecoder('utf-8', { fatal: true }).decode(
      fromBase64(name.slice(2, -4).replaceAll('-', '+').replaceAll('_', '/')),
    );
    return nameOf(key) === name ? key : undefined;
  } catch (error) {
    if (
      error instanceof TypeError ||
      error instanceof RangeError ||
      (error as { name?: string })?.name === 'InvalidCharacterError'
    )
      return undefined;
    throw error;
  }
};

/**
 * Origin Private File System storage. A writable stream's close atomically swaps its temporary file into place.
 * Operations on one key run in call order per adapter; separate adapters/tabs have last-close-wins semantics.
 * Abort is checked after each filesystem await and immediately before close, the irreversible commit point.
 * Empty files left by an interrupted first write are uncommitted and do not appear in reads or keys.
 * @throws MargoError 'unsupported' without OPFS; 'failed' for an invalid committed frame. Use another adapter or delete damaged data.
 * @throws TypeError for invalid namespace/key/bytes; RangeError for an oversized key. Supply valid options and shorter keys.
 */
export function opfsStorage(options: OPFSStorageOptions = {}): SaveStorage {
  const { namespace = 'margo-saves', directory } = options;
  if (!namespace || namespace === '.' || namespace === '..' || /[/\\\0]/.test(namespace))
    throw new TypeError('OPFS namespace must be a single directory name; use a name such as margo-saves');
  const turn = keyQueue();
  let opened: FileSystemDirectoryHandle | undefined;
  const open = async (signal?: AbortSignal): Promise<FileSystemDirectoryHandle> => {
    signal?.throwIfAborted();
    if (!opened) {
      const storage = globalThis.navigator?.storage;
      if (!directory && typeof storage?.getDirectory !== 'function')
        throw new MargoError(
          'unsupported',
          'OPFS is unavailable; use indexedDBStorage or memoryStorage, or supply a private directory',
        );
      const root = directory ?? (await storage.getDirectory());
      signal?.throwIfAborted();
      const found = await root.getDirectoryHandle(namespace, { create: true });
      signal?.throwIfAborted();
      opened = found;
    }
    return opened;
  };
  const file = async (root: FileSystemDirectoryHandle, name: string): Promise<File | null> => {
    try {
      return await (await root.getFileHandle(name)).getFile();
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  };
  return {
    async read(key, call) {
      const name = nameOf(key),
        signal = call?.signal;
      return turn(key, async () => {
        const root = await open(signal),
          found = await file(root, name);
        signal?.throwIfAborted();
        if (!found?.size) return null;
        const bytes = new Uint8Array(await found.arrayBuffer());
        signal?.throwIfAborted();
        if (!header.every((byte, i) => bytes[i] === byte))
          throw new MargoError('failed', `OPFS save '${key}' has an invalid frame; restore a backup or delete it`);
        return bytes.slice(header.length);
      });
    },
    async write(key, bytes, call) {
      const name = nameOf(key),
        signal = call?.signal;
      if (!(bytes instanceof Uint8Array)) throw new TypeError('OPFS save bytes must be a Uint8Array; use encodeSave');
      const framed = new Uint8Array(header.length + bytes.length);
      framed.set(header);
      framed.set(bytes, header.length);
      return turn(key, async () => {
        const root = await open(signal);
        signal?.throwIfAborted();
        const handle = await root.getFileHandle(name, { create: true });
        signal?.throwIfAborted();
        const stream = await handle.createWritable({ keepExistingData: false });
        try {
          signal?.throwIfAborted();
          await stream.write(framed);
          signal?.throwIfAborted();
          await stream.close();
        } catch (error) {
          try {
            await stream.abort(error);
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              'OPFS write and cleanup failed; inspect both errors and restore a backup',
            );
          }
          throw error;
        }
      });
    },
    async delete(key, call) {
      const name = nameOf(key),
        signal = call?.signal;
      return turn(key, async () => {
        const root = await open(signal),
          found = await file(root, name);
        signal?.throwIfAborted();
        if (!found) return false;
        try {
          await root.removeEntry(name);
        } catch (error) {
          if (missing(error)) return false;
          throw error;
        }
        return found.size > 0;
      });
    },
    async keys(call) {
      const signal = call?.signal,
        root = await open(signal),
        keys: string[] = [];
      for await (const [name, handle] of root.entries()) {
        signal?.throwIfAborted();
        if (handle.kind !== 'file') continue;
        const key = keyOf(name);
        if (key !== undefined && (await file(root, name))?.size) keys.push(key);
      }
      signal?.throwIfAborted();
      return keys.sort();
    },
  };
}
