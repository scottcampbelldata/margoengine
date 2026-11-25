import { ownedByEngine } from '../../../tests/support/owner-shell.js';
import { base, bytes, fakeIndexedDB, server } from './support.js';

const files = { '/a.bin': { body: bytes(64), etag: '"a"' } };
// Cache work runs in the first render check, outside the owner's scope: the runtime's own Request and fetch internals
// subscribe to signals too, and only the cache's own construction, timers and subscriptions are what is being owned.
const once = (work) => {
  let done = false;
  return async ({ phase }) => {
    if (phase === 'render' && !done) {
      done = true;
      await work();
    }
  };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// IndexedDB is read when a cache is constructed: the in-memory one is in place for that call only, and every database
// connection the cache opens is recorded, so a connection left open after disposal is seen.
function storage() {
  const fake = fakeIndexedDB(),
    open = fake.open,
    connections = [];
  fake.open = (...args) => {
    const request = open(...args);
    let result;
    Object.defineProperty(request, 'result', {
      configurable: true,
      get: () => result,
      set: (value) => {
        result = value;
        connections.push(value);
      },
    });
    return request;
  };
  const construct = (make) => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { value: fake, configurable: true, writable: true });
    try {
      return make();
    } finally {
      if (had) Object.defineProperty(globalThis, 'indexedDB', had);
      else delete globalThis.indexedDB;
    }
  };
  const closed = () => {
    if (!connections.length) throw new Error('OWNER_FIXTURE: the cache never opened its database');
    if (connections.some((db) => !db.closed))
      throw new Error('OWNER_LIFETIME: a cache disposal left its database connection open');
  };
  return { construct, closed };
}

export async function fixtures(load = (entry) => import(entry)) {
  const { AssetCache } = await load('../dist/index.js');
  const { StreamingAssetCache } = await load('../dist/stream.js');
  const { DecodedAssetCache } = await load('../dist/decoded.js');
  const { RangeCache } = await load('../dist/ranges.js');
  const { Prefetcher } = await load('../dist/prefetch.js');
  const { LoadingManager } = await load('../dist/manager.js');
  const entries = [];
  const cached = (name, make, use) =>
    entries.push({
      name,
      async create({ scene }) {
        const store = storage(),
          cache = store.construct(() => make({ fetch: server(files), name: `owner-${name}` }));
        return ownedByEngine(scene, name, () => cache.dispose(), {
          check: once(() => use(cache)),
          cleanup: async () => {
            await cache.flush().catch(() => {});
            await settle();
            store.closed();
          },
        });
      },
    });
  cached(
    'AssetCache',
    (o) => new AssetCache(o),
    async (c) => {
      await (await c.fetch(base + 'a.bin')).arrayBuffer();
      await c.flush();
    },
  );
  cached(
    'StreamingAssetCache',
    (o) => new StreamingAssetCache(o),
    async (c) => {
      await (await c.fetch(base + 'a.bin')).arrayBuffer();
      await c.flush();
    },
  );
  cached(
    'DecodedAssetCache',
    (o) => new DecodedAssetCache(o),
    async (c) => {
      await c.set({ sourceHash: 'a'.repeat(64), deviceFormat: 'rgba8unorm', decoder: 'owner-lifetime' }, { n: 1 });
    },
  );
  cached(
    'RangeCache',
    (o) => new RangeCache(o),
    async (c) => {
      await (await c.fetch(base + 'a.bin', { headers: { range: 'bytes=0-9' } })).arrayBuffer();
      await c.flush();
    },
  );
  // The signal is the app's own and outlives the prefetcher: its abort listener must go with the prefetcher.
  const prefetcher = (name, options) =>
    entries.push({
      name,
      create({ scene }) {
        const controller = new AbortController();
        const hold = (input, init) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }),
          );
        const prefetch = new Prefetcher({ fetch: hold, idle: false, signal: controller.signal, ...options });
        return ownedByEngine(scene, name, () => prefetch.dispose(), {
          check: once(() => void prefetch.add([base + 'a.bin', base + 'b.bin'])),
        });
      },
    });
  prefetcher('Prefetcher', {});
  prefetcher('Prefetcher.idle', { idle: true, idleTimeout: 50 });
  // A LoadingManager has no dispose: a request lets go of its abort listener when it settles. Ending one is the app's
  // `manager.abort()` (or the body read to its end); the owner's release waits for the request to settle and one task
  // more, after which nothing of the request may still listen.
  const managed = (name, start) =>
    entries.push({
      name,
      create({ scene }) {
        const hold = (input, init) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }),
          );
        // No Request is made: the runtime's own Request follows a signal too, and only the manager's listeners are owned.
        const manager = new LoadingManager({
          fetch: (input, init) =>
            String(input).endsWith('b.bin')
              ? hold(input, init)
              : Promise.resolve(new Response(bytes(64), { headers: { 'content-length': '64' } })),
        });
        const request = start(manager),
          settled = request.then(
            () => {},
            () => {},
          );
        let releasing;
        return ownedByEngine(
          scene,
          name,
          () =>
            (releasing ??= (async () => {
              if (name !== 'LoadingManager.read') manager.abort();
              await settled;
              await new Promise((resolve) => setTimeout(resolve, 0));
              if (manager.pending) throw new Error('OWNER_LIFETIME: a settled request still counts as pending');
            })()),
        );
      },
    });
  managed('LoadingManager', (m) => m.fetch(base + 'b.bin'));
  managed('LoadingManager.signal', (m) => m.fetch(base + 'b.bin', { signal: new AbortController().signal }));
  managed('LoadingManager.read', (m) => m.fetch(base + 'a.bin').then((r) => r.arrayBuffer()));
  return entries;
}
