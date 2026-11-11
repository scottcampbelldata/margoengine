// WebKit's ephemeral sessions (Safari Private Browsing) refuse every Blob put into IndexedDB with UnknownError. The
// caches keep the bytes instead, so a second visit in the same session is served from the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { RangeCache } from '../dist/ranges.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

test('AssetCache stores bytes when the database refuses Blobs, and serves them back from the store', async () => {
  globalThis.indexedDB = fakeIndexedDB({ refuseBlobs: true });
  const body = bytes(3000),
    network = server({ '/chair.glb': { body, etag: '"v1"' } }),
    first = new AssetCache({ name: 'refuse-a', fetch: network });
  assert.deepEqual(await read(await first.fetch(base + 'chair.glb')), body);
  await first.flush();
  assert.equal(first.stats.stored, 1, 'the file was stored');
  assert.equal(first.stats.errors, 0);
  // A new session finds it in the database and revalidates; the bytes come from the store, not the network.
  const second = new AssetCache({ name: 'refuse-a', fetch: network }),
    response = await second.fetch(base + 'chair.glb');
  assert.equal(response.headers.get('content-type'), 'model/gltf-binary');
  assert.deepEqual(await read(response), body);
  assert.equal(second.stats.hits, 1);
  assert.equal(second.stats.revalidated, 1);
  assert.deepEqual(await second.usage(), { bytes: 3000, files: 1, quota: undefined, usage: undefined });
});

test('RangeCache stores its blocks as bytes when the database refuses Blobs', async () => {
  globalThis.indexedDB = fakeIndexedDB({ refuseBlobs: true });
  const body = bytes(5000),
    network = server({ '/model.glb': { body, etag: '"v1"' } }),
    cache = new RangeCache({ name: 'refuse-r', block: 1024, fetch: network });
  const get = (range) => cache.fetch(base + 'model.glb', { headers: { range } });
  assert.deepEqual(await read(await get('bytes=10-19')), body.slice(10, 20));
  await cache.flush();
  assert.equal(cache.stats.errors, 0);
  assert.deepEqual(await cache.usage(), { bytes: 1024, files: 1, blocks: 1 });
  const requests = network.log.length;
  assert.deepEqual(await read(await get('bytes=100-900')), body.slice(100, 901), 'a stored block answers');
  assert.equal(network.log.length, requests, 'no new request');
});
