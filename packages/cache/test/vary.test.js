// @margoengine/cache/vary: AssetCache entries split by the response's Vary header and by credentials, so negotiated or
// authenticated content is never served to the wrong request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { varyKeys, varyNames } from '../dist/vary.js';
import { base, fakeIndexedDB, server } from './support.js';

const text = (value) => new TextEncoder().encode(value);
const body = async (response) => new TextDecoder().decode(await response.arrayBuffer());
// Content negotiated on Accept-Language, and a file whose bytes depend on who asks.
const files = () => ({
  '/strings.json': {
    body: (request) => text(`lang:${request.headers.get('accept-language') ?? 'none'}`),
    headers: { vary: 'Accept-Language' },
  },
  '/me.json': { body: (request) => text(`user:${request.headers.get('authorization') ?? 'anon'}`) },
  '/star.json': { body: () => text('star'), headers: { vary: '*' } },
});

test('without keys one URL is one entry: a second language is served the first one (the bug varyKeys fixes)', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server(files()),
    cache = new AssetCache({ name: 'v0', fetch: network });
  assert.equal(
    await body(await cache.fetch(base + 'strings.json', { headers: { 'accept-language': 'en' } })),
    'lang:en',
  );
  await cache.flush();
  assert.equal(
    await body(await cache.fetch(base + 'strings.json', { headers: { 'accept-language': 'fr' } })),
    'lang:en',
  );
});

test('Vary splits entries by the named request headers, offline too', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server(files()),
    cache = new AssetCache({ name: 'v1', fetch: network, keys: varyKeys() });
  for (const lang of ['en', 'fr', 'en', 'fr']) {
    assert.equal(
      await body(await cache.fetch(base + 'strings.json', { headers: { 'accept-language': lang } })),
      `lang:${lang}`,
    );
    await cache.flush();
  }
  assert.equal(cache.stats.misses, 2);
  assert.equal(cache.stats.hits, 2);
  assert.equal((await cache.usage()).files, 2);
  network.offline = true;
  const offline = new AssetCache({ name: 'v1', fetch: network, keys: varyKeys() });
  for (const lang of ['fr', 'en'])
    assert.equal(
      await body(await offline.fetch(base + 'strings.json', { headers: { 'accept-language': lang } })),
      `lang:${lang}`,
    );
  await assert.rejects(
    offline.fetch(base + 'strings.json', { headers: { 'accept-language': 'de' } }),
    TypeError,
    'a language never fetched is a miss',
  );
  // delete(url) removes every variant of the URL.
  await offline.delete(base + 'strings.json');
  assert.equal((await offline.usage()).files, 0);
});

test('Authorization, credentials and the partition split entries; no header value is stored', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server(files());
  let user = 'alice';
  const cache = new AssetCache({ name: 'v2', fetch: network, keys: varyKeys({ partition: () => user }) });
  const me = (init) => cache.fetch(base + 'me.json', init).then(body);
  assert.equal(await me({ headers: { authorization: 'Bearer a' } }), 'user:Bearer a');
  assert.equal(await me({ headers: { authorization: 'Bearer b' } }), 'user:Bearer b');
  await cache.flush();
  assert.equal(await me({ headers: { authorization: 'Bearer a' } }), 'user:Bearer a');
  assert.equal(network.log.length, 2, 'the first token is a hit');
  await me({ credentials: 'include' });
  await me({ credentials: 'omit' });
  await cache.flush();
  assert.equal(network.log.length, 4, 'with and without credentials are two entries');
  user = 'bob';
  await me({ credentials: 'include' });
  assert.equal(network.log.length, 5, "another user's partition is not served alice's entry");
  await cache.flush();
  const stored = JSON.stringify([...globalThis.indexedDB.databases.get('v2').stores.get('meta').map.keys()]);
  assert.ok(!stored.includes('Bearer') && !stored.includes('alice'), 'keys hold hashes only');
});

test('Vary: * is never stored; varyNames reads a Vary value', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server(files()),
    cache = new AssetCache({ name: 'v3', fetch: network, keys: varyKeys() });
  assert.equal(await body(await cache.fetch(base + 'star.json')), 'star');
  await cache.flush();
  await cache.fetch(base + 'star.json');
  assert.equal(network.log.length, 2);
  assert.equal(cache.stats.stored, 0);
  assert.deepEqual(varyNames('Accept-Encoding, accept-language,ACCEPT-ENCODING'), [
    'accept-encoding',
    'accept-language',
  ]);
  assert.deepEqual(varyNames('Origin, *'), ['*']);
  assert.deepEqual(varyNames(null), []);
});

test('revalidation and range fills keep the request headers, so they land in the right variant', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const list = files();
  list['/strings.json'].etag = '"s"';
  const network = server(list),
    warm = new AssetCache({ name: 'v4', fetch: network, keys: varyKeys() });
  const fr = { headers: { 'accept-language': 'fr' } };
  await warm.fetch(base + 'strings.json', { headers: { ...fr.headers, range: 'bytes=0-3' } });
  await warm.flush();
  assert.equal(network.log.at(-1).headers['accept-language'], 'fr', 'the background fill asks for the same variant');
  const next = new AssetCache({ name: 'v4', fetch: network, keys: varyKeys() });
  assert.equal(await body(await next.fetch(base + 'strings.json', fr)), 'lang:fr');
  assert.equal(next.stats.revalidated, 1);
  assert.equal(network.log.at(-1).etag, '"s"');
});
