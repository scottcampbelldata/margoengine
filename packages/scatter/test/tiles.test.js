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

test('off path: without bounds, densityMap and follow the distribute shader and frame are as before', () => {
  assert.equal(sha(scatterCullShader({})), ORIGINAL);
  const h = optionalGPU(),
    effect = new Scatter(box(), { count: 16, wind: [1, 0, 0.5] });
  h.engine.use(effect);
  h.frame();
  assert.equal(sha(h.pipelines.find((p) => p.compute).compute.module.code), ORIGINAL);
  assert.equal(h.resources.filter((r) => r.size === 320).length >= 1, true, 'an 80-float frame');
  effect.dispose();
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
  assert.equal(code, tilesCullShader());
  assert.match(code, /var<storage,read> records:array<vec2u>/);
  assert.match(code, /if\(slot>=tiles\[0\]\[ring\+1u\]\)\{atomicSub/);
  assert.ok(tiles.removeTile('0,0'));
  assert.ok(!tiles.removeTile('0,0'));
  tiles.setTile('0,1', [0, 256], 256, Uint8Array.from(record(3, 4, 1)));
  tiles.onDeviceRestored(h.engine);
  h.frame();
  tiles.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

/** The table and records ScatterTiles uploaded: [tile count, ring capacities] and per tile [x, z, side, count, first]. */
function uploaded(h, tiles) {
  const table = h.resources.find((r) => r.size === 4 * (4 + 8 * tiles.slots) && !r.destroyed),
    u = new Uint32Array(table.data),
    f = new Float32Array(table.data),
    list = [];
  for (let k = 0; k < u[0]; k++) list.push([f[4 + 8 * k], f[5 + 8 * k], f[6 + 8 * k], u[7 + 8 * k], u[8 + 8 * k]]);
  return { count: u[0], rings: [u[1], u[2], u[3]], list };
}

test('ScatterTiles memory follows what is held: packed records, rings sized from the camera, shared meshes', () => {
  const h = optionalGPU(),
    lod = [100, 300, 1000],
    trunks = new ScatterTiles(box(), { bounds: [0, 0, 4096, 4096], slots: 16, slotSize: 4096, lod }),
    crowns = new ScatterTiles(box(), { bounds: [0, 0, 4096, 4096], slots: 16, slotSize: 4096, lod, share: trunks });
  h.engine.use(trunks);
  h.engine.use(crowns);
  const tile = (n, species = 0) => Uint8Array.from(Array.from({ length: n }, (_, k) => record(k, k, species)).flat());
  // Three tiles in a row from the camera at (128, 0, 128): the first holds it, the next start 128 and 384 m away.
  Object.assign(h.engine.camera.position, [128, 0, 128]);
  trunks.setTile('0,0', [0, 0], 256, tile(3000));
  trunks.setTile('1,0', [256, 0], 256, tile(200));
  crowns.setTile('2,0', [512, 0], 256, tile(100)); // a sharing mesh hands its tiles to the leader
  assert.equal(trunks.size, 3);
  assert.equal(crowns.size, 3);
  h.frame();
  let t = uploaded(h, trunks);
  assert.deepEqual(
    t.list.map((e) => [e[0], e[3], e[4]]),
    [
      [0, 3000, 0],
      [256, 200, 3000],
      [512, 100, 3200],
    ],
  );
  // Ring needs at this camera: near (100 m) only the first tile, middle (300 m) two, far all three; each with headroom.
  const room = (n) => Math.ceil(n * 1.5) + 256;
  assert.deepEqual(t.rings, [room(3000), room(3200), room(3300)]);
  // Bytes: the records (3,000 outgrew the first 1,024 slots, with headroom) and the three rings; the sharing mesh holds
  // none of its own, and both draw one set of rings.
  assert.equal(trunks.gpuBytes, room(3000) * 8 + (room(3000) + room(3200) + room(3300)) * 32 + 4 * (4 + 8 * 16));
  assert.equal(crowns.gpuBytes, 0);
  const rings = h.resources.filter((r) => !r.destroyed && r.size >= room(3000) * 32);
  assert.equal(rings.length, 3, 'one set of rings for both meshes');
  // A removed tile leaves a hole; a new tile goes after the last one while it fits. Records stay byte for byte.
  trunks.removeTile('1,0');
  trunks.setTile('3,0', [768, 0], 256, tile(900));
  h.frame();
  t = uploaded(h, trunks);
  assert.deepEqual(
    t.list.map((e) => [e[0], e[3], e[4]]),
    [
      [0, 3000, 0],
      [512, 100, 3200],
      [768, 900, 3300],
    ],
  );
  const records = h.resources.find((r) => !r.destroyed && r.size === room(3000) * 8),
    words = new Uint32Array(records.data);
  assert.equal(words[2 * (3300 + 7)], 7 | (7 << 16), "tile 3,0's record 7 sits at 3,307");
  // A tile that does not fit after the last one closes the holes first: everything moves together.
  trunks.removeTile('0,0');
  trunks.setTile('4,0', [1024, 0], 256, tile(4000));
  h.frame();
  t = uploaded(h, trunks);
  assert.deepEqual(
    t.list.map((e) => [e[0], e[3], e[4]]),
    [
      [512, 100, 0],
      [768, 900, 100],
      [1024, 4000, 1000],
    ],
  );
  // A far camera shrinks the near and middle rings once they use under a quarter of their buffers.
  Object.assign(h.engine.camera.position, [4000, 0, 4000]);
  h.frame();
  t = uploaded(h, trunks);
  assert.deepEqual(t.rings.slice(0, 2), [room(0), room(0)]);
  crowns.dispose();
  trunks.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});
