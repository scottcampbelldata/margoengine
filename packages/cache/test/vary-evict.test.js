// KB5974e: the Vary names record a URL's entries share leaves with its last entry, on either eviction path, and stays
// while another entry of that URL and credential set still needs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { evictionIndex } from '../dist/eviction.js';
import { varyKeys } from '../dist/vary.js';
import { base, fakeIndexedDB, server } from './support.js';

const text = (value) => new TextEncoder().encode(value);
const body = async (response) => new TextDecoder().decode(await response.arrayBuffer());
const files = () => ({
  '/strings.json': {
    body: (request) => text(`lang:${request.headers.get('accept-language') ?? 'none'}`),
    headers: { vary: 'Accept-Language' },
  },
  '/a.json': { body: () => text('aaaaaaa') },
  '/b.json': { body: () => text('bbbbbbb') },
});

for (const [label, eviction] of [
  ['default eviction', undefined],
  ['evictionIndex', evictionIndex],
])
  test(`${label}: a Vary names record is evicted with the last entry that uses it`, async () => {
    globalThis.indexedDB = fakeIndexedDB();
    const name = `vary-evict-${label}`,
      network = server(files()),
      cache = new AssetCache({ name, fetch: network, keys: varyKeys(), maxBytes: 14, eviction: eviction?.() }),
      records = () =>
        [...globalThis.indexedDB.databases.get(name).stores.get('meta').map].filter(
          ([key, value]) => key.startsWith(`${base}strings.json\n`) && Array.isArray(value),
        ).length,
      get = async (path, lang) => {
        const answer = await body(
          await cache.fetch(base + path, lang ? { headers: { 'accept-language': lang } } : undefined),
        );
        await cache.flush();
        return answer;
      };
    assert.equal(await get('strings.json', 'en'), 'lang:en');
    assert.equal(await get('strings.json', 'fr'), 'lang:fr');
    assert.equal(records(), 1, 'both languages share one names record');
    assert.equal(await get('a.json'), 'aaaaaaa');
    assert.equal(records(), 1, 'the French entry still needs the record');
    const sent = network.log.length;
    assert.equal(await get('strings.json', 'fr'), 'lang:fr');
    assert.equal(network.log.length, sent, 'French is still a hit');
    assert.equal(await get('b.json'), 'bbbbbbb');
    assert.equal(await get('a.json'), 'aaaaaaa');
    assert.equal(records(), 0, 'no entry of strings.json is left, so neither is its names record');
    assert.equal((await cache.usage()).files, 2);
  });
