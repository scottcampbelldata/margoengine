// Where saves live: one small interface (read, write, delete, keys; promises with AbortSignal) and the adapters for
// memory, Web Storage (localStorage), IndexedDB and, in ./node, files. Each write is atomic in its medium: a Map set,
// one setItem, one IndexedDB transaction, a file renamed into place.
import { MargoError } from '@margoengine/math/errors';

/** Options every storage call takes. */
export interface StorageCallOptions {
  /** Stops the call; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** A place to keep saves under string keys. Every call is async and takes an AbortSignal. */
export interface SaveStorage {
  /** The bytes under `key`, or null when there are none. */
  read(key: string, options?: StorageCallOptions): Promise<Uint8Array | null>;
  /** Store `bytes` under `key`, replacing what was there in one step. */
  write(key: string, bytes: Uint8Array, options?: StorageCallOptions): Promise<void>;
  /** Remove `key`; resolves whether it existed. */
  delete(key: string, options?: StorageCallOptions): Promise<boolean>;
  /** Every key, sorted. */
  keys(options?: StorageCallOptions): Promise<string[]>;
}

const checkKey = (key: string): void => {
  if (typeof key !== 'string' || !key) throw new TypeError('Save key must be a non-empty string, e.g. "slot-1"');
};
const checkBytes = (bytes: Uint8Array): void => {
  if (!(bytes instanceof Uint8Array))
    throw new TypeError('Save bytes must be a Uint8Array; encode the document with encodeSave');
};

/** Saves in a Map, for tests, servers and undo snapshots. */
export function memoryStorage(): SaveStorage {
  const map = new Map<string, Uint8Array>();
  return {
    async read(key, options) {
      options?.signal?.throwIfAborted();
      checkKey(key);
      const bytes = map.get(key);
      return bytes ? bytes.slice() : null;
    },
    async write(key, bytes, options) {
      options?.signal?.throwIfAborted();
      checkKey(key);
      checkBytes(bytes);
      map.set(key, bytes.slice());
    },
    async delete(key, options) {
      options?.signal?.throwIfAborted();
      checkKey(key);
      return map.delete(key);
    },
    async keys(options) {
      options?.signal?.throwIfAborted();
      return [...map.keys()].sort();
    },
  };
}

// Base64 for Web Storage, which holds strings only (RFC 4648, section 4).
export const toBase64 = (bytes: Uint8Array): string => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
export const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The part of the Web Storage interface the adapter uses (`localStorage` and `sessionStorage` have it). */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * Saves in Web Storage (default `localStorage`), base64 under `prefix + key` (default prefix `'margo-save:'`).
 * Web Storage holds about 5 MB per origin: compress saves, or use {@link indexedDBStorage} for big worlds.
 * @throws MargoError `'unsupported'` when there is no Web Storage (Node, a worker): pass one or use another adapter.
 */
export function webStorage(storage?: WebStorageLike, prefix = 'margo-save:'): SaveStorage {
  const store = storage ?? (globalThis as { localStorage?: WebStorageLike }).localStorage;
  if (!store)
    throw new MargoError(
      'unsupported',
      'localStorage is not available here; pass a Storage or use indexedDBStorage or memoryStorage',
    );
  return {
    async read(key, options) {
      options?.signal?.throwIfAborted();
      checkKey(key);
      const text = store.getItem(prefix + key);
      if (text === null) return null;
      try {
        return fromBase64(text);
      } catch (error) {
        throw Object.assign(
          new TypeError(`Saved data under '${key}' is not base64; it was not written by webStorage, delete it`),
          { cause: error },
        );
      }
    },
    async write(key, bytes, options) {
      options?.signal?.throwIfAborted();
      checkKey(key);
      checkBytes(bytes);
      try {
        store.setItem(prefix + key, toBase64(bytes));
      } catch (error) {
        throw Object.assign(
          new MargoError(
            'failed',
            `Web Storage refused the save '${key}' (it is full or blocked); compress saves or use indexedDBStorage`,
          ),
          {
            cause: error,
          },
        );
      }
    },
    async delete(key, options) {
      options?.signal?.throwIfAborted();
      checkKey(key);
      const had = store.getItem(prefix + key) !== null;
      store.removeItem(prefix + key);
      return had;
    },
    async keys(options) {
      options?.signal?.throwIfAborted();
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const name = store.key(i);
        if (name?.startsWith(prefix)) keys.push(name.slice(prefix.length));
      }
      return keys.sort();
    },
  };
}

/** Options of {@link indexedDBStorage}. */
export interface IndexedDBStorageOptions {
  /** Database name (default `'margo-saves'`). */
  database?: string;
  /** Object store name (default `'saves'`). */
  store?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`). */
  factory?: IDBFactory;
}

const request = <T>(req: IDBRequest<T>, signal?: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal!.reason);
    signal?.addEventListener('abort', abort, { once: true });
    req.onsuccess = () => {
      signal?.removeEventListener('abort', abort);
      resolve(req.result);
    };
    req.onerror = () => {
      signal?.removeEventListener('abort', abort);
      reject(
        Object.assign(
          new MargoError('failed', 'IndexedDB request failed; check the storage quota and private-mode settings'),
          { cause: req.error },
        ),
      );
    };
  });

/**
 * Saves in IndexedDB: large, binary, asynchronous, one transaction per write. The database opens on first use.
 * @throws MargoError `'unsupported'` (on first use) when there is no IndexedDB: pass a factory or use another adapter.
 */
export function indexedDBStorage(options: IndexedDBStorageOptions = {}): SaveStorage {
  const name = options.database ?? 'margo-saves',
    storeName = options.store ?? 'saves';
  let opened: Promise<IDBDatabase> | null = null;
  const open = (signal?: AbortSignal): Promise<IDBDatabase> => {
    signal?.throwIfAborted();
    const factory = options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory)
      return Promise.reject(
        new MargoError('unsupported', 'IndexedDB is not available here; pass options.factory or use memoryStorage'),
      );
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opened = null;
        reject(
          Object.assign(
            new MargoError(
              'failed',
              `IndexedDB database '${name}' did not open; check private-mode and storage settings`,
            ),
            { cause: req.error },
          ),
        );
      };
    });
    return opened;
  };
  const transaction = async <T>(
    mode: IDBTransactionMode,
    signal: AbortSignal | undefined,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open(signal);
    signal?.throwIfAborted();
    // Strict: the transaction completes once the data is on the disk, not when the system has it (Indexed Database 3.0, 2.7).
    const tx = db.transaction(storeName, mode, { durability: mode === 'readwrite' ? 'strict' : 'default' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(
          Object.assign(new MargoError('failed', 'IndexedDB transaction failed; check the storage quota'), {
            cause: tx.error,
          }),
        );
    });
    const abort = (): void => tx.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // Both settle; Promise.all also handles the second rejection when the request and the transaction both fail.
      const [result] = await Promise.all([request(run(tx.objectStore(storeName))), done]);
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  };
  return {
    async read(key, opts) {
      checkKey(key);
      const value = await transaction('readonly', opts?.signal, (store) => store.get(key) as IDBRequest<unknown>);
      if (value === undefined) return null;
      if (!(value instanceof Uint8Array))
        throw new TypeError(
          `Saved data under '${key}' is not bytes; it was not written by indexedDBStorage, delete it`,
        );
      return value;
    },
    async write(key, bytes, opts) {
      checkKey(key);
      checkBytes(bytes);
      await transaction('readwrite', opts?.signal, (store) => store.put(bytes.slice(), key));
    },
    async delete(key, opts) {
      checkKey(key);
      const signal = opts?.signal;
      const had = (await transaction('readonly', signal, (store) => store.count(key))) > 0;
      await transaction('readwrite', signal, (store) => store.delete(key));
      return had;
    },
    async keys(opts) {
      const keys = await transaction('readonly', opts?.signal, (store) => store.getAllKeys());
      return (keys as IDBValidKey[]).map(String).sort();
    },
  };
}
