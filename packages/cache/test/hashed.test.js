import test from 'node:test';
import assert from 'node:assert/strict';
import { HashedAssets, hashBytes } from '../dist/hashed.js';

const bytes = (text) => new TextEncoder().encode(text);
const cacheOf = (files) => {
  const log = [],
    deleted = [];
  return {
    log,
    deleted,
    fetch: async (url) => {
      log.push(String(url));
      const body = files[url];
      return new Response(body ?? null, { status: body ? 200 : 404 });
    },
    delete: async (url) => void deleted.push(url),
  };
};
const a = 'https://x.test/a.glb';

test('hashBytes is SHA-256 hex', async () => {
  assert.equal(await hashBytes(bytes('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('a listed file is fetched under its hash, checked once, and an unlisted one passes through', async () => {
  const hash = await hashBytes(bytes('one')),
    cache = cacheOf({ [`${a}?v=${hash}`]: bytes('one'), 'https://x.test/b': bytes('b') }),
    assets = new HashedAssets(cache, { [a]: hash });
  assert.equal(await (await assets.fetch(a)).text(), 'one');
  assert.equal(await (await assets.fetch(a)).text(), 'one');
  assert.deepEqual(cache.log, [`${a}?v=${hash}`, `${a}?v=${hash}`]);
  assert.equal(await (await assets.fetch('https://x.test/b')).text(), 'b');
});
test('wrong bytes drop the stored copy and throw a coded error; a 404 is the caller’s', async () => {
  const hash = await hashBytes(bytes('one')),
    name = `${a}?v=${hash}`,
    cache = cacheOf({ [name]: bytes('tampered') }),
    assets = new HashedAssets(cache, { [a]: hash, 'https://x.test/gone': 'ff' });
  await assert.rejects(assets.fetch(a), (e) => e.code === 'failed' && /publish the file and manifest/.test(e.message));
  assert.deepEqual(cache.deleted, [name]);
  assert.equal((await assets.fetch('https://x.test/gone')).status, 404);
});
test('update drops only the files that changed or left', async () => {
  const cache = cacheOf({}),
    assets = new HashedAssets(cache, { [a]: '11', 'https://x.test/b?q=1': '22', 'https://x.test/c': '33' });
  assert.equal(await assets.update({ [a]: '11', 'https://x.test/b?q=1': '99' }), 2);
  assert.deepEqual(cache.deleted, ['https://x.test/b?q=1&v=22', 'https://x.test/c?v=33']);
});
