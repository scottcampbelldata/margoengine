import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelChunk } from '../dist/index.js';
import { decodeChunk } from '../dist/codec.js';
import { IndexedDBChunkStore, MemoryChunkStore } from '../dist/stream.js';

// Minimal in-memory IndexedDB (the pattern of packages/cache/test): the calls IndexedDBChunkStore makes, array keys,
// request callbacks after the call (microtasks), readwrite commits on a later task, structured-clone records, and a
// switch that aborts commits (QuotaExceededError). Not a real IndexedDB: browsers are not exercised here.
function fakeIndexedDB() {
  const databases = new Map(),
    later = (fn) => setTimeout(fn, 0),
    fake = { databases, commits: 0, failCommits: false };
  const id = (key) => JSON.stringify(key);
  const store = (map, writable) => {
    const request = (run) => {
      const r = {};
      queueMicrotask(() => {
        r.result = run();
        r.onsuccess?.();
      });
      return r;
    };
    const write = (run) => {
      if (!writable) throw new DOMException('read only', 'ReadOnlyError');
      return request(run);
    };
    return {
      get: (key) => request(() => structuredClone(map.get(id(key))?.value)),
      put: (value, key) =>
        write(() => {
          map.set(id(key), { key: structuredClone(key), value: structuredClone(value) });
        }),
      delete: (key) =>
        write(() => {
          map.delete(id(key));
        }),
    };
  };
  fake.open = (name, version) => {
    assert.equal(version, 1);
    const request = {};
    later(() => {
      let stores = databases.get(name);
      const created = !stores;
      if (created) databases.set(name, (stores = new Map()));
      request.result = {
        createObjectStore(n) {
          stores.set(n, new Map());
        },
        transaction(names, mode = 'readonly') {
          const list = [].concat(names),
            staged = new Map(list.map((n) => [n, new Map(stores.get(n))])),
            t = { error: null, objectStore: (n) => store(staged.get(n), mode === 'readwrite') };
          if (mode === 'readwrite')
            later(() => {
              if (fake.failCommits) {
                t.error = new DOMException('quota', 'QuotaExceededError');
                t.onabort?.();
                return;
              }
              fake.commits++;
              for (const [n, map] of staged) stores.set(n, map);
              t.oncomplete?.();
            });
          return t;
        },
      };
      if (created) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  };
  return fake;
}

const chunkWith = (state, light = 0) => {
  const chunk = new VoxelChunk(state);
  chunk.set(1, 2, 3, state + 1);
  if (light) chunk.setLight(4, 5, 6, light);
  return chunk;
};
const same = (a, b) => a && b && a.get(1, 2, 3) === b.get(1, 2, 3) && a.get(0, 0, 0) === b.get(0, 0, 0);

async function storeContract(store) {
  assert.equal(await store.get(0, 0, 0), undefined);
  const chunk = chunkWith(5, 0x3c);
  const put = store.put(-3, 7, 2 ** 26 - 1, chunk);
  chunk.fill(9); // the store keeps the chunk as it was when put was called
  const back = await store.get(-3, 7, 2 ** 26 - 1); // before the write settles
  assert.equal(back.get(1, 2, 3), 6);
  assert.equal(back.getLight(4, 5, 6), 0x3c);
  await put;
  assert.ok(same(await store.get(-3, 7, 2 ** 26 - 1), chunkWith(5)));
  await store.put(-3, 7, 2 ** 26 - 1, chunkWith(20));
  assert.ok(same(await store.get(-3, 7, 2 ** 26 - 1), chunkWith(20)));
  store.delete(-3, 7, 2 ** 26 - 1);
  assert.equal(await store.get(-3, 7, 2 ** 26 - 1), undefined);
  await store.flush();
  assert.equal(await store.get(-3, 7, 2 ** 26 - 1), undefined);
  await assert.rejects(store.get(0.5, 0, 0), RangeError);
  await assert.rejects(store.get(2 ** 26, 0, 0), RangeError);
  // Argument errors throw at the call (storage failures reject the promise instead).
  assert.throws(() => store.put(0, '0', 0, chunk), TypeError);
  assert.throws(() => store.put(0, 0, 0, {}), TypeError);
  assert.throws(() => store.delete(0, 0, 2 ** 40), RangeError);
  assert.equal(await store.get(0, 0, 0), undefined);
}

test('MemoryChunkStore keeps chunk snapshots: get, put, delete, flush', async () => {
  await storeContract(new MemoryChunkStore());
});

test('IndexedDBChunkStore: one deflated record per chunk keyed [cx, cy, cz], batched, read-your-writes', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  try {
    await storeContract(new IndexedDBChunkStore('contract'));
    const fake = globalThis.indexedDB,
      store = new IndexedDBChunkStore('world-1');
    // 40 puts and a delete in one task: one transaction, applied in call order.
    for (let i = 0; i < 40; i++) store.put(i, -i, 2 * i, chunkWith(i));
    store.put(0, 0, 0, chunkWith(99));
    store.delete(39, -39, 78);
    const commits = fake.commits;
    await store.flush();
    assert.equal(fake.commits, commits + 1);
    const records = fake.databases.get('world-1').get('chunks');
    assert.equal(records.size, 39);
    const record = records.get(JSON.stringify([5, -5, 10]));
    assert.deepEqual(record.key, [5, -5, 10]);
    assert.ok(record.value instanceof Uint8Array && record.value[1] & 4, 'deflated encodeChunk bytes');
    assert.ok(same(await decodeChunk(record.value), chunkWith(5)));
    // A second store on the same database reads what the first committed.
    const reopened = new IndexedDBChunkStore('world-1');
    assert.ok(same(await reopened.get(0, 0, 0), chunkWith(99)));
    assert.ok(same(await reopened.get(38, -38, 76), chunkWith(38)));
    assert.equal(await reopened.get(39, -39, 78), undefined);
    // Writes in later tasks commit after earlier ones: the last put of a key wins.
    const first = store.put(1, 1, 1, chunkWith(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.put(1, 1, 1, chunkWith(2));
    await first;
    await store.flush();
    assert.ok(same(await reopened.get(1, 1, 1), chunkWith(2)));
  } finally {
    delete globalThis.indexedDB;
  }
});

test('IndexedDBChunkStore reports failed commits through put and the next flush, then recovers', async () => {
  const fake = (globalThis.indexedDB = fakeIndexedDB());
  try {
    const store = new IndexedDBChunkStore('full-disk');
    await store.put(0, 0, 0, chunkWith(1));
    fake.failCommits = true;
    const failing = store.put(0, 0, 0, chunkWith(2));
    await assert.rejects(
      failing,
      (e) => e.name === 'MargoError' && e.code === 'failed' && /QuotaExceeded/.test(e.message),
    );
    // The failed write no longer shadows the stored chunk, and flush reports it once.
    assert.ok(same(await store.get(0, 0, 0), chunkWith(1)));
    await assert.rejects(store.flush(), (e) => e.code === 'failed');
    await store.flush();
    // An ignored put is no unhandled rejection: its failure reaches the next flush.
    store.put(2, 2, 2, chunkWith(4));
    await assert.rejects(store.flush(), (e) => e.code === 'failed');
    fake.failCommits = false;
    await store.put(0, 0, 0, chunkWith(3));
    assert.ok(same(await new IndexedDBChunkStore('full-disk').get(0, 0, 0), chunkWith(3)));
  } finally {
    delete globalThis.indexedDB;
  }
  assert.throws(
    () => new IndexedDBChunkStore('x'),
    (e) => e.name === 'MargoError' && e.code === 'unsupported',
  );
  globalThis.indexedDB = fakeIndexedDB();
  try {
    assert.throws(() => new IndexedDBChunkStore(''), TypeError);
  } finally {
    delete globalThis.indexedDB;
  }
});
