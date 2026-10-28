// B3: the CPU side of the view. Ground materials in first-use order, ground weights per cell (sum 255, slope rules,
// painted biomes), TerrainColors from the world, and attach refusing a WebGL engine. The real-GPU check is
// browser-check.mjs (test:gpu).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { presets } from '../dist/presets.js';
import { BiomeView, MATERIALS, groundMaterials, groundWeights, terrainColorsFor } from '../dist/view.js';

test('ground materials are the unique ground layers in first-use order, at most 8', () => {
  assert.deepEqual(groundMaterials([presets.temperate, presets.desert]), [
    'grass',
    'leaf-litter',
    'rock',
    'sand',
    'red-sand',
  ]);
  const many = Array.from({ length: 5 }, (_, i) =>
    defineBiome({ id: `b${i}`, climate: {}, ground: [{ material: `m${2 * i}` }, { material: `m${2 * i + 1}` }] }),
  );
  assert.equal(groundMaterials(many).length, 8);
  for (const key of groundMaterials(Object.values(presets))) assert.ok(MATERIALS[key], `${key} has a built-in look`);
});

test('ground weights: 8 per cell summing to 255, slope rules pick rock on cliffs, paint moves the ground', async () => {
  const steep = { field: (x) => (x > 0 ? x * 1.2 : 0) + 20 },
    world = await BiomeWorld.create({
      size: [512, 512],
      biomes: [presets.temperate, presets.desert],
      height: steep,
      climate: { latitude: 47, rainfall: 1000 },
    }),
    materials = groundMaterials(world.biomes),
    tile = await world.tile(0, 0),
    cliff = await world.tile(1, 0),
    flat = groundWeights(world, tile, materials),
    steepWeights = groundWeights(world, cliff, materials);
  for (const w of [flat, steepWeights])
    for (let k = 0; k < w.length; k += 8 * 97) {
      let sum = 0;
      for (let i = 0; i < 8; i++) sum += w[k + i];
      assert.equal(sum, 255);
    }
  const at = (w, i, j, m) => w[(j * 256 + i) * 8 + materials.indexOf(m)];
  assert.ok(
    at(flat, 100, 100, 'grass') + at(flat, 100, 100, 'leaf-litter') > 200,
    'flat moist ground is grass and leaf litter',
  );
  assert.ok(at(flat, 100, 100, 'grass') > 64);
  assert.ok(
    at(steepWeights, 100, 100, 'rock') > 150,
    `a 50 degree slope is mostly rock: ${at(steepWeights, 100, 100, 'rock')}`,
  );
  assert.equal(at(steepWeights, 100, 100, 'grass'), 0, 'and no grass');
  world.writeLayer('paint/desert', 0, 0, new Uint8Array(256 * 256).fill(255));
  const painted = groundWeights(world, await world.tile(0, 0), materials);
  assert.ok(at(painted, 100, 100, 'sand') + at(painted, 100, 100, 'red-sand') > 200, 'painted desert is sand');
  assert.throws(() => groundWeights(world, { cells: 1, layer: () => undefined }, materials), TypeError);
});

test('terrainColorsFor gives linear sand, meadow and stone colours from the world', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] }),
    c = terrainColorsFor(world);
  for (const v of [c.sand, c.meadow[0], c.meadow[1], c.stone]) {
    assert.equal(v.length, 3);
    assert.ok(v.every((x) => x >= 0 && x <= 1));
  }
  assert.ok(c.meadow[0][1] > c.meadow[0][0], 'meadow is green');
  assert.ok(Math.abs(c.stone[0] - ((0.45 + 0.055) / 1.055) ** 2.4) < 1e-6, 'stone is linear rock');
  assert.deepEqual(terrainColorsFor(world, { rock: { color: [1, 0, 0] } }).stone, [1, 0, 0]);
});

test('attach refuses a WebGL engine and bad arguments', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] });
  await assert.rejects(BiomeView.attach({ backend: 'webgl2' }, world), { name: 'MargoError', code: 'unsupported' });
  await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, {}), TypeError);
});
