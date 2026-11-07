// A cache made without `fetch` takes `globalThis.fetch` as it is then. Read at each request instead, a page that set
// `globalThis.fetch = cache.fetch` (every loader cached at once) made the cache call itself without end: no request
// left and the promise never settled (found by the real-browser check, scripts/test-browser.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { LoadingManager } from '../dist/manager.js';
import { RangeCache } from '../dist/ranges.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

/** Runs `use` with globalThis.fetch set to a stand-in server, then restores it. */
async function withServer(use) {
  const saved = globalThis.fetch,
    network = server({ '/a': { body: bytes(3000), etag: '"a"' } });
  globalThis.fetch = network;
  globalThis.indexedDB = fakeIndexedDB();
  try {
    return await use(network);
  } finally {
    globalThis.fetch = saved;
  }
}

test('globalThis.fetch set to AssetCache.fetch goes to the network once, not to itself', { timeout: 5000 }, () =>
  withServer(async (network) => {
    const cache = new AssetCache({ name: 'g1' });
    globalThis.fetch = cache.fetch;
    assert.deepEqual(await read(await globalThis.fetch(base + 'a')), bytes(3000));
    assert.equal(network.log.length, 1);
    await cache.flush();
  }));

test('globalThis.fetch set to RangeCache.fetch goes to the network once, not to itself', { timeout: 5000 }, () =>
  withServer(async (network) => {
    const ranges = new RangeCache({ name: 'g2' });
    globalThis.fetch = ranges.fetch;
    const response = await globalThis.fetch(base + 'a', { headers: { Range: 'bytes=10-19' } });
    assert.equal(response.status, 206);
    assert.deepEqual(await read(response), bytes(3000).slice(10, 20));
    assert.equal(network.log.length, 1);
    await ranges.flush();
  }));

test('globalThis.fetch set to LoadingManager.fetch goes to the network once, not to itself', { timeout: 5000 }, () =>
  withServer(async (network) => {
    const manager = new LoadingManager();
    globalThis.fetch = manager.fetch;
    assert.deepEqual(await read(await globalThis.fetch(base + 'a')), bytes(3000));
    assert.equal(network.log.length, 1);
  }));
