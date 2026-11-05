// The world-rectangle options (bounds, densityMap, follow) and the tiles entry: without the options the distribute
// shader is the original text byte for byte; each option rewrites only its own part; ScatterTiles keeps records per
// tile slot, filters a palette index, frees slots and survives device restoration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { box } from '@margoengine/core';
import { Scatter, scatterCullShader } from '../dist/index.js';
import { ScatterTiles, tilesCullShader } from '../dist/tiles.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
// SHA-256 of the distribute shader before the world-rectangle options existed (main at 0765a2c1).
const ORIGINAL = '63b49bcd65f7277d9606496ea67532a1b80a1d72d23baf3f5f46211560f3976d';
// SHA-256 of the kernel WebGPU compiles from it: the candidate kernel of the ordered cull (src/order.ts), no atomics.
const ORDERED = '5df19e53e3cae3ef32e5740b504efa0ef30e46fb86b3eff20653b0c28326b9d7';

test('off path: without bounds, densityMap and follow the distribute shader and frame are as before', () => {
  assert.equal(sha(scatterCullShader({})), ORIGINAL);
  const h = optionalGPU(),
    effect = new Scatter(box(), { count: 16, wind: [1, 0, 0.5] });
  h.engine.use(effect);
  h.frame();
  const code = h.pipelines.find((p) => p.compute).compute.module.code;
  assert.equal(sha(code), ORDERED);
  assert.doesNotMatch(code, /atomic/);
  assert.equal(h.resources.filter((r) => r.size === 320).length >= 1, true, 'an 80-float frame');
  effect.dispose();
});

test('inner: only its own shader part, on an extended frame, and off at 0', () => {
  const base = scatterCullShader({}),
    plain = scatterCullShader({ inner: 100 }),
    follow = scatterCullShader({ inner: 100, follow: true });
  assert.equal(sha(scatterCullShader({ inner: 0, innerFade: 20 })), ORIGINAL);
  assert.equal(
    plain.replace('||d<frame.offset.z+frame.offset.w*hash(i*7u+7u)', '').replace(',offset:vec4f,bounds:vec4f', ''),
    base,
  );
  assert.match(follow, /d<frame\.offset\.z\+frame\.offset\.w\*hash\(key\*7u\+7u\)/);
  const h = optionalGPU(),
    effect = new Scatter(box(), { count: 16, inner: 30, innerFade: 5 });
  h.engine.use(effect);
  h.frame();
  assert.equal(h.resources.filter((r) => r.size === 352).length >= 1, true, 'an 88-float frame');
  effect.dispose();
  for (const bad of [{ inner: -1 }, { inner: 120 }, { inner: Number.NaN }, { inner: 10, innerFade: -1 }])
    assert.throws(() => new Scatter(box(), bad), /Scatter inner must be/, JSON.stringify(bad));
});

test('each world option rewrites only its own part of the shader', () => {
  const base = scatterCullShader({}),
    bounds = scatterCullShader({ bounds: [0, 0, 100, 100] }),
    follow = scatterCullShader({ follow: true }),
    density = scatterCullShader({ bounds: [0, 0, 100, 100], densityMap: () => undefined, follow: true });
  assert.match(bounds, /frame\.bounds\.zw-frame\.bounds\.xy/);
  assert.doesNotMatch(bounds, /densityMap|frame\.offset\.x/);
  assert.match(follow, /let key=\(bitcast<u32>\(i32\(i%frame\.ids\.z\)\+i32\(frame\.offset\.x\)\)/);
  assert.doesNotMatch(follow, /hash\(i\*7u\+/);
  assert.match(density, /@binding\(7\) var densityMap:texture_2d<f32>/);
  assert.match(density, /hash\(key\*7u\+6u\)>=textureLoad\(densityMap/);
  for (const code of [bounds, follow, density]) assert.ok(code.length > base.length);
  assert.throws(() => new Scatter(box(), { densityMap: () => undefined }), /needs bounds/);
  assert.throws(() => new Scatter(box(), { follow: true, heightmap: () => undefined }), /needs bounds/);
  assert.throws(() => new Scatter(box(), { bounds: [0, 0, -1, 1] }), RangeError);
});

test('follow moves the grid in whole cells and keys each instance by its world cell', () => {
  const h = optionalGPU(),
    effect = new Scatter(box(), { count: 100, area: [10, 10], follow: true });
  h.engine.use(effect);
  h.engine.camera.position[0] = 23.4;
  h.engine.camera.position[2] = -7.9;
  h.frame();
  const values = effect.values;
  // 10 x 10 grid of 1 m cells around the camera: offset is the camera cell minus 5, centre on a cell corner.
  assert.deepEqual([values[80], values[81]], [18, -13]);
  assert.deepEqual([values[22], values[23]], [23, -8]);
  effect.dispose();
});

const record = (x, z, species, scale = 128, yaw = 0, age = 0) => [
  x & 255,
  x >> 8,
  z & 255,
  z >> 8,
  species,
  scale,
  yaw,
  age << 4,
];

test('ScatterTiles packs held records, filters a palette index, frees tiles and restores the device', () => {
  const h = optionalGPU(),
    tiles = new ScatterTiles(box(), { bounds: [0, 0, 512, 512], slots: 2, slotSize: 4, drawn: 64, species: 1 });
  h.engine.use(tiles);
  tiles.setTile(
    '0,0',
    [0, 0],
    256,
    Uint8Array.from([...record(10, 20, 1), ...record(30, 40, 0), ...record(50, 60, 1)]),
  );
  tiles.setTile('1,0', [256, 0], 256, Uint8Array.from(record(1, 2, 1)));
  assert.equal(tiles.size, 2);
  assert.throws(() => tiles.setTile('0,1', [0, 256], 256, new Uint8Array(8)), /no free slot/);
  assert.throws(
    () => tiles.setTile('1,0', [256, 0], 256, Uint8Array.from(Array.from({ length: 5 }, () => record(0, 0, 1)).flat())),
    /slotSize/,
  );
  h.frame();
  const code = h.pipelines.find((p) => p.compute).compute.module.code;
  // The candidate kernel of the tiles shader: the rings' capacities bound the compaction, not an atomic slot.
  assert.equal(sha(code), 'aaa7d495a2e7b3788e6ec5f9cdfe2c14ef15935038999916cf51426f5f775296');
  assert.match(code, /var<storage,read> records:array<vec2u>/);
  assert.doesNotMatch(code, /atomic/);
  assert.doesNotMatch(tilesCullShader(), /atomicSub/);
  assert.ok(tiles.removeTile('0,0'));
  assert.ok(!tiles.removeTile('0,0'));
  tiles.setTile('0,1', [0, 256], 256, Uint8Array.from(record(3, 4, 1)));
  tiles.onDeviceRestored(h.engine);
  h.frame();
  tiles.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

/**
 * What ScatterTiles uploaded: the ring capacities and, per used page (64 records), [page, origin x, origin z, side,
 * records in it], read from the page table (the one buffer of 16 bytes per page plus a header).
 */
function uploaded(h, pages) {
  const table = h.resources.find((r) => !r.destroyed && r.size === 16 * (1 + pages)),
    u = new Uint32Array(table.data),
    f = new Float32Array(table.data),
    used = [];
  for (let p = 0; p < pages; p++) {
    const e = 4 * (1 + p);
    if (u[e + 3]) used.push([p, f[e], f[e + 1], f[e + 2], u[e + 3]]);
  }
  return { rings: [u[1], u[2], u[3]], used };
}

test('ScatterTiles memory follows what is held: records in pages, rings sized from the camera, shared meshes', () => {
  const h = optionalGPU(),
    lod = [100, 300, 1000],
    trunks = new ScatterTiles(box(), { bounds: [0, 0, 4096, 4096], slots: 16, slotSize: 4096, lod }),
    crowns = new ScatterTiles(box(), { bounds: [0, 0, 4096, 4096], slots: 16, slotSize: 4096, lod, share: trunks });
  h.engine.use(trunks);
  h.engine.use(crowns);
  const tile = (n, species = 0) => Uint8Array.from(Array.from({ length: n }, (_, k) => record(k, k, species)).flat());
  // Three tiles in a row from the camera at (128, 0, 128): the first holds it, the next start 128 and 384 m away.
  Object.assign(h.engine.camera.position, [128, 0, 128]);
  trunks.setTile('0,0', [0, 0], 256, tile(100)); // 2 pages
  trunks.setTile('1,0', [256, 0], 256, tile(64)); // 1 page
  crowns.setTile('2,0', [512, 0], 256, tile(30)); // 1 page; a sharing mesh hands its tiles to the leader
  assert.equal(trunks.size, 3);
  assert.equal(crowns.size, 3);
  h.frame();
  // The pool starts with 16 pages; pages are taken from the low end.
  let t = uploaded(h, 16);
  assert.deepEqual(t.used, [
    [0, 0, 0, 256, 64],
    [1, 0, 0, 256, 36],
    [2, 256, 0, 256, 64],
    [3, 512, 0, 256, 30],
  ]);
  // Ring needs at this camera: near (100 m) only the first tile, middle (300 m) two, far all three; each with headroom.
  const room = (n) => Math.ceil(n * 1.5) + 256;
  assert.deepEqual(t.rings, [room(100), room(164), room(194)]);
  // Bytes: 16 pages of records, the three rings and the page table; the sharing mesh holds none of its own, and both
  // draw one set of rings.
  // The ordered cull of 1,024 record slots: 32 bytes each for the instances, 12 for the ring flags, then the slots and
  // the prefix count's levels (192 + 12 sums, 3,073 + 193 + 13 counts) and six 16-byte uniforms (five steps, the lanes).
  const cull = 1024 * 32 + 1024 * 12 + (192 + 12) * 4 + (3073 + 193 + 13) * 4 + 6 * 16;
  assert.equal(trunks.gpuBytes, 16 * 64 * 8 + (room(100) + room(164) + room(194)) * 32 + 16 * 17 + cull);
  assert.equal(crowns.gpuBytes, 0);
  assert.equal(
    h.resources.filter((r) => !r.destroyed && r.size === room(100) * 32).length,
    1,
    'one near ring for both',
  );
  // A removed tile frees its page; the next tile takes it, and nothing else moves.
  trunks.removeTile('1,0');
  trunks.setTile('3,0', [768, 0], 256, tile(20));
  h.frame();
  t = uploaded(h, 16);
  assert.deepEqual(
    t.used.map((e) => [e[0], e[1], e[4]]),
    [
      [0, 0, 64],
      [1, 0, 36],
      [2, 768, 20],
      [3, 512, 30],
    ],
  );
  const records = (pages) => new Uint32Array(h.resources.find((r) => !r.destroyed && r.size === pages * 64 * 8).data);
  assert.equal(records(16)[2 * (2 * 64 + 7)], 7 | (7 << 16), "tile 3,0's record 7 is in page 2");
  assert.equal(records(16)[2 * (1 * 64 + 5)], 69 | (69 << 16), "tile 0,0's record 69 is the 6th of its second page");
  // More than the free pages: the pool grows with headroom, the held pages keep their places.
  trunks.setTile('4,0', [1024, 0], 256, tile(4000)); // 63 pages
  h.frame();
  const grown = Math.ceil((Math.ceil((16 + 63 - 12) * 64 * 1.5) + 256) / 64);
  t = uploaded(h, grown);
  assert.equal(t.used.length, 4 + 63);
  assert.deepEqual(
    t.used.slice(0, 4).map((e) => [e[0], e[1]]),
    [
      [0, 0],
      [1, 0],
      [2, 768],
      [3, 512],
    ],
  );
  assert.equal(records(grown)[2 * (3 * 64 + 29)], 29 | (29 << 16), 'tile 2,0 kept its page');
  // A dense tile at the camera grows the near ring; a far camera shrinks it again once it uses under a quarter (rings
  // under 1,024 instances stay, so a camera moving back and forth does not remake them).
  trunks.setTile('0,0', [0, 0], 256, tile(2000)); // 32 of the 40 free pages
  h.frame();
  assert.equal(uploaded(h, grown).rings[0], room(2000));
  Object.assign(h.engine.camera.position, [4000, 0, 4000]);
  h.frame();
  t = uploaded(h, grown);
  assert.deepEqual(t.rings.slice(0, 2), [room(0), room(0)]);
  crowns.dispose();
  trunks.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});
