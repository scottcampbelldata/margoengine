// @margoengine/cache/ranges: byte ranges kept as aligned blocks, so files read in pieces (progressive glTF streaming)
// load from disk and offline. The last test runs gltf-pro's own streaming code through the cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { RangeCache } from '../dist/ranges.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';
import { bigGLB } from '../../../tests/support/big-glb.js';

const B = 1024; // a small block keeps the files small
const get = (cache, path, range) => cache.fetch(base + path, range ? { headers: { range } } : undefined);
const ranges = (network) => network.log.map((entry) => entry.range);

test('a range miss is fetched as whole blocks and stored; covered ranges are then answered without the network', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const body = bytes(10_000),
    network = server({ '/model.glb': { body, etag: '"v1"' } }),
    cache = new RangeCache({ name: 'r1', block: B, fetch: network });
  const first = await get(cache, 'model.glb', 'bytes=10-19');
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), 'bytes 10-19/10000');
  assert.deepEqual(await read(first), body.slice(10, 20));
  assert.deepEqual(ranges(network), ['bytes=0-1023'], 'widened to the block');
  await cache.flush();
  assert.deepEqual(await cache.usage(), { bytes: 1024, files: 1, blocks: 1 });
  // Inside the stored block: no request. Across into the next: only the missing block is asked for.
  assert.deepEqual(await read(await get(cache, 'model.glb', 'bytes=100-1000')), body.slice(100, 1001));
  assert.equal(network.log.length, 1);
  assert.deepEqual(await read(await get(cache, 'model.glb', 'bytes=1000-2100')), body.slice(1000, 2101));
  assert.deepEqual(ranges(network).slice(1), ['bytes=1024-3071']);
  await cache.flush();
  assert.deepEqual(
    { hits: cache.stats.hits, partial: cache.stats.partial, misses: cache.stats.misses },
    { hits: 1, partial: 1, misses: 1 },
  );
  // The last block is short; open and suffix ranges end at the file's size.
  assert.deepEqual(await read(await get(cache, 'model.glb', 'bytes=9990-')), body.slice(9990));
  assert.deepEqual(ranges(network).at(-1), 'bytes=9216-9999');
  const suffix = await get(cache, 'model.glb', 'bytes=-5');
  assert.equal(suffix.headers.get('content-range'), 'bytes 9995-9999/10000');
  assert.deepEqual(await read(suffix), body.slice(9995));
  assert.equal((await get(cache, 'model.glb', 'bytes=10000-')).status, 416);
  await cache.flush();
  assert.deepEqual(await cache.usage(), { bytes: 3 * 1024 + 784, files: 1, blocks: 4 });
});

test('a new session revalidates once with a one-byte conditional request; offline it serves stored blocks only', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const body = bytes(5000, 3),
    network = server({ '/m.glb': { body, etag: '"a"' } }),
    warm = new RangeCache({ name: 'r2', block: B, fetch: network });
  await read(await get(warm, 'm.glb', 'bytes=0-2047'));
  await warm.flush();
  const second = new RangeCache({ name: 'r2', block: B, fetch: network }),
    before = network.log.length;
  assert.deepEqual(await read(await get(second, 'm.glb', 'bytes=5-1500')), body.slice(5, 1501));
  assert.deepEqual(
    network.log.slice(before).map((e) => [e.range, e.etag]),
    [['bytes=0-0', '"a"']],
  );
  assert.deepEqual(await read(await get(second, 'm.glb', 'bytes=0-9')), body.slice(0, 10));
  assert.equal(network.log.length, before + 1, 'the same RangeCache does not revalidate twice');
  assert.equal(second.stats.revalidated, 1);
  network.offline = true;
  const offline = new RangeCache({ name: 'r2', block: B, fetch: network });
  assert.deepEqual(await read(await get(offline, 'm.glb', 'bytes=1000-1100')), body.slice(1000, 1101));
  assert.equal(offline.stats.offline, 1);
  await assert.rejects(get(offline, 'm.glb', 'bytes=3000-3100'), TypeError, 'a block never fetched cannot be served');
  network.offline = false;
  network.hang = true;
  const slow = new RangeCache({ name: 'r2', block: B, fetch: network, timeout: 20 });
  assert.deepEqual(await read(await get(slow, 'm.glb', 'bytes=0-99')), body.slice(0, 100));
  assert.equal(slow.stats.offline, 1);
});

test('a changed file (other ETag or size) drops its stored blocks and is fetched again', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = { '/c.glb': { body: bytes(4000), etag: '"1"' } },
    network = server(files),
    warm = new RangeCache({ name: 'r3', block: B, fetch: network });
  await read(await get(warm, 'c.glb', 'bytes=0-4095'));
  await warm.flush();
  files['/c.glb'] = { body: bytes(4000, 9), etag: '"2"' };
  // Every block stored: the conditional request sees the new ETag.
  const next = new RangeCache({ name: 'r3', block: B, fetch: network });
  assert.deepEqual(await read(await get(next, 'c.glb', 'bytes=100-199')), files['/c.glb'].body.slice(100, 200));
  await next.flush();
  assert.deepEqual(await next.usage(), { bytes: 1024, files: 1, blocks: 1 }, 'old blocks dropped');
  // A missing block whose answer has another ETag or size: the file is dropped and the request asked again.
  files['/c.glb'] = { body: bytes(6000, 4), etag: '"3"' };
  assert.deepEqual(await read(await get(next, 'c.glb', 'bytes=2000-2999')), files['/c.glb'].body.slice(2000, 3000));
  await next.flush();
  network.offline = true;
  const offline = new RangeCache({ name: 'r3', block: B, fetch: network });
  assert.deepEqual(await read(await get(offline, 'c.glb', 'bytes=2048-2999')), files['/c.glb'].body.slice(2048, 3000));
  await assert.rejects(get(offline, 'c.glb', 'bytes=100-199'), TypeError, 'blocks of the old file are gone');
});

test('whole-file requests use and fill the blocks; a server without range support fills them all at once', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const body = bytes(3000, 5),
    network = server({ '/w.bin': { body, etag: '"w"' }, '/plain.bin': { body, noRanges: true } }),
    cache = new RangeCache({ name: 'r4', block: B, fetch: network });
  await read(await get(cache, 'w.bin', 'bytes=1024-2047'));
  await cache.flush();
  const whole = await get(cache, 'w.bin');
  assert.equal(whole.status, 200);
  assert.deepEqual(await read(whole), body);
  assert.deepEqual(ranges(network).slice(1), ['bytes=0-1023', 'bytes=2048-2999'], 'only the missing blocks');
  const plain = await get(cache, 'plain.bin', 'bytes=10-20');
  assert.equal(plain.status, 206, 'answered as asked from the whole file');
  assert.deepEqual(await read(plain), body.slice(10, 21));
  await cache.flush();
  network.offline = true;
  const offline = new RangeCache({ name: 'r4', block: B, fetch: network });
  assert.deepEqual(await read(await get(offline, 'plain.bin', 'bytes=2500-2999')), body.slice(2500));
  assert.deepEqual(await read(await get(offline, 'w.bin')), body);
  assert.equal(
    (await get(offline, 'w.bin', 'bytes=0-1,5-6').catch((error) => error)).name,
    'TypeError',
    'multi-range requests go to the network',
  );
});

test('the byte budget evicts the least recently used files; no-store, errors and non-GET pass through', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = {
      '/a': { body: bytes(2048) },
      '/b': { body: bytes(2048, 2) },
      '/c': { body: bytes(2048, 3) },
      '/secret': { body: bytes(100), control: 'no-store' },
    },
    network = server(files),
    cache = new RangeCache({ name: 'r5', block: B, maxBytes: 4096, fetch: network });
  for (const path of ['a', 'b']) {
    await read(await get(cache, path, 'bytes=0-2047'));
    await cache.flush();
    await new Promise((r) => setTimeout(r, 2));
  }
  await read(await get(cache, 'a', 'bytes=0-9'));
  await cache.flush();
  await new Promise((r) => setTimeout(r, 2));
  await read(await get(cache, 'c', 'bytes=0-2047'));
  await cache.flush();
  assert.equal(cache.stats.evicted, 1);
  assert.deepEqual(await cache.usage(), { bytes: 4096, files: 2, blocks: 4 });
  await read(await get(cache, 'secret', 'bytes=0-9'));
  assert.equal((await get(cache, 'missing', 'bytes=0-9')).status, 404);
  await cache.flush();
  assert.equal((await cache.usage()).files, 2, 'no-store and 404 are not kept');
  const before = network.log.length;
  await cache.fetch(base + 'a', { method: 'POST', body: 'x' });
  assert.equal(network.log.length, before + 1);
  network.offline = true;
  const offline = new RangeCache({ name: 'r5', block: B, maxBytes: 4096, fetch: network });
  await assert.rejects(get(offline, 'b', 'bytes=0-9'), TypeError, 'b was evicted');
  assert.deepEqual(await read(await get(offline, 'c', 'bytes=0-9')), files['/c'].body.slice(0, 10));
  await offline.delete(base + 'c');
  assert.equal((await offline.usage()).files, 1);
  await offline.clear();
  assert.deepEqual(await offline.usage(), { bytes: 0, files: 0, blocks: 0 });
  assert.throws(() => new RangeCache({ block: 0 }), RangeError);
});

test('without IndexedDB every request goes to the network', async () => {
  globalThis.indexedDB = undefined;
  const network = server({ '/a': { body: bytes(3000) } }),
    cache = new RangeCache({ block: B, fetch: network });
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await read(await get(cache, 'a', 'bytes=5-9')), bytes(3000).slice(5, 10));
  await cache.flush();
  assert.equal(network.log.length, 2);
});

// gltf-pro's progressive streaming code (GLTFStream, the half that runs in its worker) with the global fetch answered by
// the cache, as a service worker answers the worker's requests. Its final buffers must equal the file, cold and offline.
test('progressive glTF streaming loads through the cache, and again offline from the stored blocks', async () => {
  const dist = new URL('../../gltf-pro/dist/', import.meta.url),
    chunk = readdirSync(dist).find((name) => /^stream-.*\.js$/.test(name));
  const { GLTFStream } = await import(new URL(chunk, dist).href);
  const glb = bigGLB({ segments: 120, meshes: 3 }),
    view = new DataView(glb.buffer, glb.byteOffset),
    json = view.getUint32(12, true),
    bin = glb.slice(28 + json, 28 + json + view.getUint32(20 + json, true));
  assert.ok(glb.length > 1 << 20, 'big enough to stream in many ranges');
  const stream = async (cache) => {
    const saved = globalThis.fetch;
    globalThis.fetch = cache.fetch;
    try {
      return await new Promise((resolve, reject) => {
        const s = new GLTFStream(
          new URL(base + 'grids.glb'),
          (message) => {
            if (message.type === 'doc') queueMicrotask(() => s.setOrder([...s.needs.keys()]));
            if (message.type === 'done') resolve(message.buffers);
            if (message.type === 'error') reject(Object.assign(new Error(message.error.message), message.error));
          },
          new AbortController().signal,
        );
        s.run();
      });
    } finally {
      globalThis.fetch = saved;
    }
  };
  globalThis.indexedDB = fakeIndexedDB();
  const network = server({ '/grids.glb': { body: glb, etag: '"g"' } }),
    cold = new RangeCache({ name: 'r6', fetch: network });
  const first = await stream(cold);
  assert.deepEqual(first[0], bin);
  assert.ok(
    network.log.length > 2 && network.log.every((entry) => /^bytes=\d+-\d+$/.test(entry.range)),
    'streamed as ranges',
  );
  await cold.flush();
  assert.equal((await cold.usage()).bytes, glb.length, 'every byte the stream read is stored');
  network.offline = true;
  const offline = new RangeCache({ name: 'r6', fetch: network }),
    before = network.log.length;
  assert.deepEqual((await stream(offline))[0], bin);
  assert.equal(network.log.length, before + 1, 'one failed revalidation, no other request');
  assert.ok(offline.stats.hits > 2 && offline.stats.misses === 0);
});
