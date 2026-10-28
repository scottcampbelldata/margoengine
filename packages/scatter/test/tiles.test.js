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

test('ScatterTiles keeps records per slot, filters a palette index, frees slots and restores the device', () => {
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
  assert.equal(code, tilesCullShader(64));
  assert.match(code, /var<storage,read> records:array<vec2u>/);
  assert.match(code, /if\(slot>=CAPACITY\)\{atomicSub/);
  assert.ok(tiles.removeTile('0,0'));
  assert.ok(!tiles.removeTile('0,0'));
  tiles.setTile('0,1', [0, 256], 256, Uint8Array.from(record(3, 4, 1)));
  tiles.onDeviceRestored(h.engine);
  h.frame();
  tiles.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});
