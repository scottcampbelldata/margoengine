import test from 'node:test';
import assert from 'node:assert/strict';
import { DecodedAssetCache } from '../dist/decoded.js';
import { fakeIndexedDB } from './support.js';

const key = { sourceHash: 'ab'.repeat(32), deviceFormat: 'rgba8unorm-srgb', decoder: 'basis-test-1' };
const geometry = () => ({
  vertexCount: 2,
  positions: new Float32Array([1, 2, 3, -1, -2, -3]),
  indices: new Uint16Array([0, 1, 0]),
  attributes: { JOINTS_0: { array: new Uint8Array([3, 2]), itemSize: 1, componentType: 5121 } },
});

test('Draco arrays persist across instances with exact types, independent copies and no second decode', {
  timeout: 5000,
}, async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const cache = new DecodedAssetCache();
  let decodes = 0;
  const first = await cache.getOrDecode(key, async () => {
    decodes++;
    return geometry();
  });
  first.positions[0] = 999;
  const next = new DecodedAssetCache();
  const hit = await next.getOrDecode(key, async () => {
    decodes++;
    return geometry();
  });
  assert.deepEqual(hit, geometry());
  assert.equal(decodes, 1);
  hit.positions[0] = 123;
  assert.deepEqual(await cache.get(key), geometry());
  await cache.remove(key);
  assert.equal(await cache.get(key), undefined);
  cache.dispose();
  next.dispose();
});

test('KTX2 mip views and all identity dimensions stay distinct', { timeout: 5000 }, async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const cache = new DecodedAssetCache(),
    backing = new Uint8Array([99, 1, 2, 3, 4, 88]);
  const mip = {
    width: 2,
    height: 2,
    format: 'rgba8unorm-srgb',
    target: 'rgba8',
    hasAlpha: true,
    srgb: true,
    mipmaps: [
      { width: 2, height: 2, byteLength: 4, data: backing.subarray(1, 5) },
      { width: 1, height: 1, byteLength: 1, data: backing.subarray(2, 3) },
    ],
  };
  await cache.set(key, mip);
  backing.fill(0);
  const hit = await cache.get(key);
  assert.deepEqual(
    hit.mipmaps.map((m) => [...m.data]),
    [[1, 2, 3, 4], [2]],
  );
  assert.equal(hit.srgb, true);
  for (const change of [
    { deviceFormat: 'bc7-rgba-unorm-srgb' },
    { sourceHash: 'cd'.repeat(32) },
    { decoder: 'basis-test-2' },
    { variant: 'flip-y' },
  ]) {
    const other = { ...key, ...change };
    assert.equal(await cache.get(other), undefined);
    await cache.set(other, geometry());
    assert.deepEqual(await cache.get(other), geometry());
  }
  assert.deepEqual(await cache.get({ ...key, sourceHash: key.sourceHash.toUpperCase() }), hit);
  cache.dispose();
});

test('binary types and plain metadata round-trip without interpreting property names', { timeout: 5000 }, async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const cache = new DecodedAssetCache();
  const value = {
    nested: [null, true, 1, 'tag', undefined],
    raw: new Uint8Array([1, 2]).buffer,
    view: new DataView(new Uint8Array([3, 4]).buffer),
    constructors: [
      new Int8Array([-5]),
      new Uint8ClampedArray([7]),
      new Int16Array([-500]),
      new Int32Array([-90000]),
      new Uint32Array([90000]),
      new Float64Array([1 / 3]),
      new BigInt64Array([-8n]),
      new BigUint64Array([9n]),
    ],
    names: JSON.parse('{"__proto__":{"safe":true},"constructor":"value"}'),
  };
  await cache.set(key, value);
  assert.deepEqual(await cache.get(key), value);
  cache.dispose();
});

test('LRU, byte budget, version invalidation and storage failures use existing policies', {
  timeout: 5000,
}, async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const cache = new DecodedAssetCache({ maxBytes: 800 });
  const second = { ...key, variant: 'second' },
    third = { ...key, variant: 'third' };
  await cache.set(key, new Uint8Array(350));
  await cache.set(second, new Uint8Array(350));
  await cache.get(key);
  await cache.flush();
  await cache.set(third, new Uint8Array(350));
  assert.ok(await cache.get(key));
  assert.equal(await cache.get(second), undefined);
  await cache.set(key, new Uint8Array(1000));
  assert.equal((await cache.get(key)).byteLength, 350);
  const changed = new DecodedAssetCache({ version: 'next' });
  assert.equal(await changed.get(key), undefined);
  cache.dispose();
  changed.dispose();
  for (const db of [undefined, fakeIndexedDB({ broken: true }), fakeIndexedDB({ quota: 1 })]) {
    globalThis.indexedDB = db;
    const unavailable = new DecodedAssetCache();
    assert.deepEqual(await unavailable.getOrDecode(key, async () => geometry()), geometry());
    assert.equal(await unavailable.get(key), undefined);
    unavailable.dispose();
  }
});

test('abort, decode failure, malformed identity and unsupported data never persist', { timeout: 5000 }, async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const cache = new DecodedAssetCache(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(cache.get(key, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(
    cache.getOrDecode(key, async () => {
      throw new TypeError('decode failed');
    }),
    /decode failed/,
  );
  assert.equal(await cache.get(key), undefined);
  for (const change of [{ sourceHash: 'wrong' }, { deviceFormat: '' }, { decoder: '' }, { deviceFormat: 7 }])
    await assert.rejects(cache.get({ ...key, ...change }), TypeError);
  const cycle = {};
  cycle.self = cycle;
  for (const data of [undefined, cycle, new Date(), () => {}, NaN])
    await assert.rejects(cache.set(key, data), TypeError);
  cache.dispose();
});
