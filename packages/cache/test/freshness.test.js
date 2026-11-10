// AssetCache freshness (option `freshness`): Expires and Age as RFC 9111 sections 4.2.1 and 4.2.3 define them, so a
// fresh file skips revalidation and a file already old when received does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { RangeCache } from '../dist/ranges.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

const at = (seconds) => new Date(Date.now() + seconds * 1e3).toUTCString();
// Fetches each file in one session, then counts the requests a second session makes for them.
async function revalidations(files, options = {}) {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server(files),
    first = new AssetCache({ name: 'f', fetch: network, ...options });
  for (const path of Object.keys(files)) await read(await first.fetch(base + path.slice(1)));
  await first.flush();
  const second = new AssetCache({ name: 'f', fetch: network, ...options }),
    asked = {};
  for (const path of Object.keys(files)) {
    const before = network.log.length;
    await read(await second.fetch(base + path.slice(1)));
    asked[path] = network.log.length - before;
  }
  return asked;
}
const file = (headers) => ({ body: bytes(20), etag: '"e"', headers });

test('Expires in the future skips revalidation; in the past, invalid or with no lifetime it revalidates', async () => {
  assert.deepEqual(
    await revalidations({
      '/future': file({ date: at(0), expires: at(3600) }),
      '/past': file({ date: at(0), expires: at(-60) }),
      '/zero': file({ expires: '0' }),
      '/none': file({}),
      '/no-cache': file({ expires: at(3600), 'cache-control': 'no-cache' }),
    }),
    { '/future': 0, '/past': 1, '/zero': 1, '/none': 1, '/no-cache': 1 },
  );
});

test('max-age wins over Expires; Age and an old Date count against the lifetime', async () => {
  assert.deepEqual(
    await revalidations({
      '/max-age-wins': file({ 'cache-control': 'max-age=3600', expires: at(-60) }),
      '/young': file({ 'cache-control': 'max-age=3600', age: '600' }),
      '/aged-out': file({ 'cache-control': 'max-age=600', age: '600' }),
      '/old-date': file({ 'cache-control': 'max-age=30', date: at(-120) }),
      '/s-maxage': file({ 'cache-control': 's-maxage=3600' }),
    }),
    {
      '/max-age-wins': 0,
      '/young': 0,
      '/aged-out': 1,
      '/old-date': 1,
      '/s-maxage': 1,
    },
  );
});

test("freshness: 'max-age' keeps to max-age alone, as before", async () => {
  assert.deepEqual(
    await revalidations(
      { '/expires': file({ expires: at(3600) }), '/aged': file({ 'cache-control': 'max-age=600', age: '600' }) },
      { freshness: 'max-age' },
    ),
    { '/expires': 1, '/aged': 0 },
  );
});

test('a 304 with Expires makes the stored file fresh for the next session', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = { '/a': file({}) },
    network = server(files);
  const first = new AssetCache({ name: 'g', fetch: network });
  await read(await first.fetch(base + 'a'));
  await first.flush();
  files['/a'] = file({ date: at(0), expires: at(3600) });
  const second = new AssetCache({ name: 'g', fetch: network });
  await read(await second.fetch(base + 'a'));
  await second.flush();
  assert.equal(network.log.at(-1).etag, '"e"', 'revalidated with a 304');
  const before = network.log.length;
  await read(await new AssetCache({ name: 'g', fetch: network }).fetch(base + 'a'));
  assert.equal(network.log.length, before);
});

test('RangeCache honours Expires and Age the same way', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server({
      '/fresh': { body: bytes(2000), etag: '"r"', headers: { expires: at(3600) } },
      '/aged': { body: bytes(2000), etag: '"r"', headers: { 'cache-control': 'max-age=60', age: '120' } },
    }),
    first = new RangeCache({ name: 'h', block: 1024, fetch: network });
  for (const path of ['fresh', 'aged']) await read(await first.fetch(base + path, { headers: { range: 'bytes=0-9' } }));
  await first.flush();
  const second = new RangeCache({ name: 'h', block: 1024, fetch: network }),
    before = network.log.length;
  await read(await second.fetch(base + 'fresh', { headers: { range: 'bytes=0-9' } }));
  assert.equal(network.log.length, before, 'fresh blocks need no request');
  await read(await second.fetch(base + 'aged', { headers: { range: 'bytes=0-9' } }));
  assert.equal(network.log.length, before + 1, 'aged blocks are revalidated');
});

for (const revalidated of [false, true])
  test(`RangeCache counts request transit against freshness after ${revalidated ? 'a 304' : 'a miss'}`, async (t) => {
    let now = 100_000;
    t.mock.method(Date, 'now', () => now);
    for (const age of [3, 8]) {
      globalThis.indexedDB = fakeIndexedDB();
      now = 100_000;
      const files = { '/a': file({ 'cache-control': revalidated ? 'max-age=0' : 'max-age=10', age: String(age) }) };
      const network = server(files);
      const options = {
        name: `transit-${revalidated}-${age}`,
        block: 16,
        fetch: async (input, init) => {
          const response = await network(input, init);
          now += 4000; // A controlled clock, without a real wait or a speed assertion.
          return response;
        },
      };
      const fetchSession = async () => {
        const cache = new RangeCache(options);
        assert.deepEqual(await read(await cache.fetch(base + 'a')), bytes(20));
        cache.dispose();
        await cache.flush();
      };
      await fetchSession();
      if (revalidated) {
        files['/a'] = file({ 'cache-control': 'max-age=10', age: String(age) });
        await fetchSession();
        assert.equal(network.log.at(-1).etag, '"e"');
      }
      // Age 3 plus four seconds in transit leaves three seconds; Age 8 leaves none.
      now += age === 3 ? 3001 : 1;
      const before = network.log.length;
      await fetchSession();
      assert.equal(network.log.length, before + 1, 'expired blocks must revalidate in the next session');
    }
  });
