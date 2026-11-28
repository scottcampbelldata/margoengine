// @margoengine/water/banks without a GPU: the WGSL it adds to the surface shader and the options it refuses. The
// pictures are checked by banks.browser.mjs on WebGPU and the WebGL2 compatibility layer (KB-BIOMES-RIVERSTEP1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { WaterBanks, banksShader } from '@margoengine/water/banks';

const surface = { name: 'water', onDispose: () => () => {} };
const good = { surface, heightmap: () => undefined, origin: [-256, -256], size: [512, 512] };

test('banksShader binds its frame and ground texture at the binding it is given and the next', () => {
  const code = banksShader(7);
  assert.match(code, /@group\(0\) @binding\(7\) var<uniform> banks:BanksFrame;/);
  assert.match(code, /@group\(0\) @binding\(8\) var banksGround:texture_2d<f32>;/);
  for (const fn of ['banksGroundAt', 'banksSlack', 'banksPull', 'banksDry'])
    assert.match(code, new RegExp(`fn ${fn}\\(`));
  assert.equal(code.match(/@binding\(/g).length, 2, 'two bindings and no others');
});

test('WaterBanks takes good options and gives each one its own plugin name', () => {
  const a = new WaterBanks(good),
    b = new WaterBanks({ ...good, cell: 2, resolution: 128, centre: [10, 20], slope: 0.5, limit: 1 });
  assert.match(a.name, /^water:banks-\d+$/);
  assert.notEqual(a.name, b.name);
});

test('WaterBanks refuses what it cannot draw', () => {
  assert.throws(() => new WaterBanks({ ...good, surface: undefined }), /Water surface/);
  assert.throws(() => new WaterBanks({ ...good, heightmap: null }), /heightmap must be a function/);
  assert.throws(() => new WaterBanks({ ...good, origin: [0] }), /origin must be \[x, z\]/);
  assert.throws(() => new WaterBanks({ ...good, size: [0, 512] }), /size must be above 0/);
  assert.throws(() => new WaterBanks({ ...good, size: [200000, 512] }), /size/);
  assert.throws(() => new WaterBanks({ ...good, resolution: 4 }), /resolution must be a finite number from 8 to 256/);
  assert.throws(() => new WaterBanks({ ...good, cell: 0 }), /cell must be above 0/);
  assert.throws(() => new WaterBanks({ ...good, slope: 11 }), /slope must be a finite number from 0 to 10/);
  assert.throws(() => new WaterBanks({ ...good, limit: Number.NaN }), /limit must be a finite number from 0 to 100/);
  assert.throws(() => new WaterBanks({ ...good, centre: [1, 2, 3] }), /centre must be \[x, z\]/);
});
