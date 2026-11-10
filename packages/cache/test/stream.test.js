import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingAssetCache } from '../dist/stream.js';
import { fakeIndexedDB } from './support.js';

const url = 'https://assets.test/model.bin';
const setup = (options = {}) => {
  globalThis.indexedDB = fakeIndexedDB();
  let source,
    pulls = 0,
    cancelled;
  const cache = new StreamingAssetCache({
    fetch: async () => {
      const response = new Response(
        new ReadableStream(
          {
            start(controller) {
              source = controller;
            },
            pull() {
              pulls++;
            },
            cancel(reason) {
              cancelled = reason;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { etag: '"one"', 'cache-control': 'max-age=3600' } },
      );
      Object.defineProperty(response, 'url', { value: 'https://cdn.test/model.bin' });
      return response;
    },
    ...options,
  });
  return { cache, source: () => source, pulls: () => pulls, cancelled: () => cancelled };
};

test('miss returns headers and the first chunk before EOF, without reading ahead; complete bytes persist', {
  timeout: 5000,
}, async () => {
  const { cache, source, pulls } = setup();
  const response = await cache.fetch(url);
  assert.equal(response.url, 'https://cdn.test/model.bin');
  assert.equal(response.headers.get('etag'), '"one"');
  assert.equal(pulls(), 0);
  const reader = response.body.getReader(),
    first = reader.read();
  source().enqueue(new Uint8Array([1, 2]));
  assert.deepEqual((await first).value, new Uint8Array([1, 2]));
  assert.equal(pulls(), 1);
  assert.equal((await cache.usage()).files, 0);
  const last = reader.read();
  source().enqueue(new Uint8Array([3]));
  assert.deepEqual((await last).value, new Uint8Array([3]));
  source().close();
  assert.equal((await reader.read()).done, true);
  await cache.flush();
  assert.equal(cache.stats.stored, 1);
  assert.deepEqual(new Uint8Array(await (await cache.fetch(url)).arrayBuffer()), new Uint8Array([1, 2, 3]));
  cache.dispose();
});

test('cancel discards partial bytes, cancels upstream and settles flush', { timeout: 5000 }, async () => {
  const { cache, source, cancelled } = setup();
  const reader = (await cache.fetch(url)).body.getReader();
  const read = reader.read();
  source().enqueue(new Uint8Array([9]));
  await read;
  await reader.cancel('left scene');
  await cache.flush();
  assert.equal(cancelled(), 'left scene');
  assert.equal((await cache.usage()).files, 0);
  cache.dispose();
});

test('failed bodies propagate and never store partial bytes', { timeout: 5000 }, async () => {
  const { cache, source } = setup();
  const reader = (await cache.fetch(url)).body.getReader();
  const read = reader.read();
  source().error(new TypeError('broken network'));
  await assert.rejects(read, /broken network/);
  await cache.flush();
  assert.equal((await cache.usage()).files, 0);
  cache.dispose();
});

test('bodies above the storage budget still stream successfully', { timeout: 5000 }, async () => {
  const { cache, source } = setup({ maxBytes: 1 });
  const response = await cache.fetch(url),
    bytes = response.arrayBuffer();
  source().enqueue(new Uint8Array([1, 2, 3]));
  source().close();
  assert.equal((await bytes).byteLength, 3);
  await cache.flush();
  assert.equal((await cache.usage()).files, 0);
  cache.dispose();
});

test('AbortSignal cancels an unread body and settles flush without a partial write', { timeout: 5000 }, async () => {
  const { cache, cancelled } = setup(),
    abort = new AbortController();
  const response = await cache.fetch(url, { signal: abort.signal });
  abort.abort(new DOMException('left', 'AbortError'));
  await assert.rejects(response.arrayBuffer(), { name: 'AbortError' });
  await cache.flush();
  assert.equal(cancelled().name, 'AbortError');
  assert.equal((await cache.usage()).files, 0);
  cache.dispose();
});

test('no-store and non-200 responses pass through immediately', { timeout: 5000 }, async () => {
  for (const options of [{ status: 404 }, { headers: { 'cache-control': 'no-store' } }]) {
    const response = new Response('pass', options);
    const { cache } = setup({ fetch: async () => response });
    assert.equal(await cache.fetch(url), response);
    await cache.flush();
    assert.equal((await cache.usage()).files, 0);
    cache.dispose();
  }
});
