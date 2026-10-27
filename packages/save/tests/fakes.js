// Small stand-ins for the browser storage APIs the adapters use, written from the Web Storage and IndexedDB specs'
// interfaces (only the calls the adapters make). Requests settle asynchronously, as in a browser.

/** A Web Storage (`localStorage`) object with an optional quota in characters. */
export function fakeWebStorage(quota = Infinity) {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      const used = [...map].reduce((n, [key, value]) => n + (key === k ? 0 : key.length + value.length), 0);
      if (used + k.length + String(v).length > quota) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => void map.delete(k),
  };
}

/** An IDBFactory holding object stores in Maps; `failWrites` makes every readwrite transaction fail. */
export function fakeIndexedDB() {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const factory = {
    failWrites: false,
    open(name) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        let stores = databases.get(name);
        const fresh = !stores;
        if (fresh) databases.set(name, (stores = new Map()));
        const db = {
          objectStoreNames: { contains: (s) => stores.has(s) },
          createObjectStore: (s) => stores.set(s, new Map()),
          transaction(storeName, mode) {
            const data = stores.get(storeName);
            const pending = new Map(data);
            const tx = { error: null, oncomplete: null, onabort: null, onerror: null, aborted: false };
            let open = 0;
            const finish = () => {
              if (tx.aborted) return;
              if (mode === 'readwrite' && factory.failWrites) {
                tx.error = new Error('QuotaExceededError');
                tx.aborted = true;
                tx.onerror?.();
                return;
              }
              if (mode === 'readwrite') {
                data.clear();
                for (const [k, v] of pending) data.set(k, v);
              }
              tx.oncomplete?.();
            };
            const run = (op) => {
              const r = { result: undefined, error: null, onsuccess: null, onerror: null };
              open++;
              later(() => {
                if (tx.aborted) {
                  r.error = new Error('AbortError');
                  r.onerror?.();
                  return;
                }
                r.result = op();
                r.onsuccess?.();
                if (--open === 0) later(finish);
              });
              return r;
            };
            tx.abort = () => {
              if (tx.aborted) return;
              tx.aborted = true;
              tx.error = new Error('AbortError');
              later(() => tx.onabort?.());
            };
            tx.objectStore = () => ({
              get: (k) => run(() => pending.get(k)),
              put: (v, k) => run(() => void pending.set(k, v)),
              delete: (k) => run(() => void pending.delete(k)),
              count: (k) => run(() => (pending.has(k) ? 1 : 0)),
              getAllKeys: () => run(() => [...pending.keys()]),
            });
            return tx;
          },
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return factory;
}
