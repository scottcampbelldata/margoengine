// Test stand-ins shared by the cache tests: an in-memory IndexedDB and a tiny HTTP server as a fetch function.

/**
 * Minimal in-memory IndexedDB: the calls the cache entries make. Request callbacks run after the call (microtasks), a
 * transaction commits on a later task, records are structured clones, and an optional byte quota on stored Blobs aborts
 * the transaction with QuotaExceededError. Each transaction reads a snapshot plus its own writes and commits only the
 * keys it wrote (a read-only one commits nothing), so overlapping transactions do not undo each other. Versioned open
 * runs onupgradeneeded with the old version; a lower version than stored fails with VersionError. Object stores support
 * createIndex(name, keyPath) and index(name).openCursor() in ascending key order, with cursor.continue() and delete().
 * `refuseBlobs` makes a readwrite transaction that puts a Blob fail with UnknownError, as WebKit's ephemeral sessions do.
 * `counts.reads` counts the records handed out by get, getAll and cursors.
 */
export function fakeIndexedDB({ quota = Infinity, broken = false, refuseBlobs = false } = {}) {
  const databases = new Map(),
    counts = { reads: 0 },
    later = (fn) => setTimeout(fn, 0);
  const copy = (value) => (value instanceof Blob ? value : structuredClone(value));
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const store = (target, writable, log) => {
    const { map, indexes } = target;
    const request = (run) => {
      const r = {};
      queueMicrotask(() => {
        r.result = run();
        r.onsuccess?.({ target: r });
      });
      return r;
    };
    const write = (key, run) => {
      if (!writable) throw new DOMException('read only', 'ReadOnlyError');
      log.add(key);
      return request(run);
    };
    return {
      get: (key) =>
        request(() => {
          if (map.has(key)) counts.reads++;
          return copy(map.get(key));
        }),
      getAll: () =>
        request(() => {
          counts.reads += map.size;
          return [...map.values()].map(copy);
        }),
      getAllKeys: () => request(() => [...map.keys()]),
      count: () => request(() => map.size),
      put: (value, key) =>
        write(key, () => {
          map.set(key, copy(value));
          return key;
        }),
      delete: (key) =>
        write(key, () => {
          map.delete(key);
        }),
      clear: () => {
        if (!writable) throw new DOMException('read only', 'ReadOnlyError');
        log.cleared = true;
        for (const key of map.keys()) log.add(key);
        return request(() => map.clear());
      },
      createIndex: (name, keyPath) => {
        indexes.set(name, keyPath);
      },
      index: (name) => {
        const path = indexes.get(name);
        if (!path) throw new DOMException(`no index ${name}`, 'NotFoundError');
        return {
          count: () => request(() => [...map.values()].filter((v) => v?.[path] !== undefined).length),
          openCursor: () => {
            const r = {},
              rows = [...map.entries()]
                .filter(([, v]) => v !== null && typeof v === 'object' && v[path] !== undefined)
                .sort((a, b) => order(a[1][path], b[1][path]) || order(a[0], b[0]));
            let i = 0;
            const step = () =>
              queueMicrotask(() => {
                // Rows deleted since the cursor opened are skipped, as a live cursor would.
                while (i < rows.length && !map.has(rows[i][0])) i++;
                if (i >= rows.length) {
                  r.result = null;
                } else {
                  const [key, value] = rows[i++];
                  counts.reads++;
                  r.result = {
                    primaryKey: key,
                    key: value[path],
                    value: copy(value),
                    continue: step,
                    delete: () =>
                      write(key, () => {
                        map.delete(key);
                      }),
                  };
                }
                r.onsuccess?.({ target: r });
              });
            step();
            return r;
          },
        };
      },
    };
  };
  return {
    databases,
    counts,
    open(name, version = 1) {
      const request = {};
      later(() => {
        if (broken) {
          request.error = new DOMException('blocked', 'InvalidStateError');
          request.onerror?.();
          return;
        }
        let db = databases.get(name);
        if (db && version < db.version) {
          request.error = new DOMException('lower version', 'VersionError');
          request.onerror?.();
          return;
        }
        if (!db) databases.set(name, (db = { version: 0, stores: new Map() }));
        const old = db.version,
          stores = db.stores,
          handle = (request.result = {
            closed: false,
            get version() {
              return db.version;
            },
            close() {
              handle.closed = true;
            },
            createObjectStore(n) {
              stores.set(n, { map: new Map(), indexes: new Map() });
              return store(stores.get(n), true, new Set());
            },
            transaction(names, mode) {
              if (handle.closed) throw new DOMException('closed', 'InvalidStateError');
              const staged = new Map(
                  [names].flat().map((n) => [n, { map: new Map(stores.get(n).map), indexes: stores.get(n).indexes }]),
                ),
                logs = new Map([names].flat().map((n) => [n, new Set()])),
                t = {
                  error: null,
                  objectStore: (n) => store(staged.get(n), mode === 'readwrite', logs.get(n)),
                };
              later(() => {
                const after = (n) => {
                  const live = new Map(stores.get(n).map);
                  if (logs.get(n).cleared) live.clear();
                  for (const key of logs.get(n))
                    if (staged.get(n).map.has(key)) live.set(key, staged.get(n).map.get(key));
                    else live.delete(key);
                  return live;
                };
                const next = new Map([...staged.keys()].map((n) => [n, after(n)]));
                if (
                  refuseBlobs &&
                  mode === 'readwrite' &&
                  [...next.values()].some((map) => [...map.values()].some((v) => v instanceof Blob))
                ) {
                  t.error = new DOMException('Error preparing Blob/File data to be stored in object store', 'UnknownError');
                  t.onabort?.();
                  return;
                }
                const bytes = [...next.values()]
                  .flatMap((map) => [...map.values()])
                  .reduce((sum, v) => sum + (v instanceof Blob ? v.size : v instanceof ArrayBuffer ? v.byteLength : 0), 0);
                if (bytes > quota && mode === 'readwrite') {
                  t.error = new DOMException('quota', 'QuotaExceededError');
                  t.onabort?.();
                  return;
                }
                if (mode === 'readwrite') for (const [n, map] of next) stores.get(n).map = map;
                t.oncomplete?.();
              });
              return t;
            },
          });
        if (version > old) {
          db.version = version;
          request.transaction = {
            objectStore: (n) => store(stores.get(n), true, new Set()),
          };
          request.onupgradeneeded?.({ oldVersion: old, newVersion: version });
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
}

/**
 * A tiny HTTP server as a fetch function: ETag / Last-Modified / 304, single byte ranges (`a-b`, `a-`, `-n`) answered 206
 * with Content-Range, Cache-Control and extra headers per file, offline and hanging modes. `fetch.log` records requests.
 */
export function server(files) {
  const log = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init),
      file = files[new URL(request.url).pathname];
    log.push({
      url: request.url,
      range: request.headers.get('range'),
      etag: request.headers.get('if-none-match'),
      since: request.headers.get('if-modified-since'),
      headers: Object.fromEntries(request.headers),
      credentials: request.credentials,
    });
    if (fetch.offline) throw new TypeError('Failed to fetch');
    if (fetch.hang)
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)));
    if (!file) return new Response('missing', { status: 404 });
    const body = typeof file.body === 'function' ? file.body(request) : file.body;
    const headers = {
      'content-type': 'model/gltf-binary',
      ...(file.etag && { etag: file.etag }),
      ...(file.modified && { 'last-modified': file.modified }),
      ...(file.control && { 'cache-control': file.control }),
      ...file.headers,
    };
    if (
      (file.etag && request.headers.get('if-none-match') === file.etag) ||
      (!file.etag && file.modified && request.headers.get('if-modified-since') === file.modified)
    )
      return new Response(null, { status: 304, headers });
    const range = !file.noRanges && /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    if (range && (range[1] || range[2])) {
      const size = body.length,
        start = range[1] ? +range[1] : Math.max(0, size - +range[2]),
        end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
      if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      return new Response(body.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` },
      });
    }
    return new Response(body, { status: 200, headers });
  };
  fetch.log = log;
  return fetch;
}

export const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255);
export const read = async (response) => new Uint8Array(await response.arrayBuffer());
export const base = 'https://cdn.example/';
