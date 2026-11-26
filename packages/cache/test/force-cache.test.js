// `cache: 'force-cache'` (Fetch request cache modes): AssetCache and RangeCache use their stored copy without asking the
// server, fresh or not. HashedAssets asks that way, as bytes named by their hash cannot change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { HashedAssets, hashBytes } from '../dist/hashed.js';
import { RangeCache } from '../dist/ranges.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

const url = `${base}a.glb`;
const body = bytes(3000, 5);

/** Loads once in one cache, then returns a new one (a new session) and the requests made from there on. */
async function second(Cache, options, load) {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server({ '/a.glb': { body, etag: '"a"' } }),
    first = new Cache({ ...options, fetch: network });
  await load(first);
  await first.flush();
  const cache = new Cache({ ...options, fetch: network }),
    from = network.log.length;
  return { cache, network, asked: () => network.log.slice(from) };
}

test('AssetCache serves a stale stored file under force-cache with no request; no-cache still asks', async () => {
  const { cache, asked } = await second(AssetCache, { name: 'f1' }, async (c) => read(await c.fetch(url)));
  assert.deepEqual(await read(await cache.fetch(url, { cache: 'force-cache' })), body);
  assert.deepEqual(asked(), []);
  await read(await cache.fetch(url, { cache: 'force-cache', headers: { 'cache-control': 'no-cache' } }));
  assert.equal(asked().length, 1, "the request's own no-cache header revalidates");
});

test('RangeCache serves stored blocks under force-cache with no request', async () => {
  const range = { headers: { range: 'bytes=0-999' } },
    { cache, asked } = await second(RangeCache, { name: 'f2', block: 1024 }, async (c) =>
      read(await c.fetch(url, range)),
    );
  assert.deepEqual(await read(await cache.fetch(url, { ...range, cache: 'force-cache' })), body.slice(0, 1000));
  assert.deepEqual(asked(), []);
  await read(await cache.fetch(url, range));
  assert.equal(asked().length, 1, 'the default mode still revalidates once');
});

test('a file named by its hash is read in a new session without asking the server', async () => {
  const hash = await hashBytes(body),
    load = (c) => new HashedAssets(c, { [url]: hash }).fetch(url).then(read),
    { cache, asked } = await second(AssetCache, { name: 'f3' }, load);
  assert.deepEqual(await load(cache), body);
  const assets = new HashedAssets(cache, { [url]: hash });
  assert.deepEqual(await read(await assets.fetch(new Request(url))), body);
  assert.deepEqual(asked(), []);
});

test('a mode the caller names is kept, and wrong bytes are asked for again past any HTTP cache', async () => {
  const hash = await hashBytes(body),
    modes = [];
  let served = bytes(10, 1);
  const assets = new HashedAssets(
    {
      fetch: async (input, init) => {
        modes.push(new Request(input, init).cache);
        return new Response(served);
      },
      delete: async () => {},
    },
    { [url]: hash },
  );
  await assert.rejects(assets.fetch(url), { code: 'failed' });
  served = body;
  await assets.fetch(url);
  await assets.fetch(url);
  await assets.fetch(url, { cache: 'no-cache' });
  await assets.fetch(new Request(url, { cache: 'no-store' }));
  assert.deepEqual(modes, ['force-cache', 'reload', 'force-cache', 'no-cache', 'no-store']);
});
