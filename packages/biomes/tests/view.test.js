// B3: the CPU side of the view. Ground materials in first-use order, ground weights per cell (sum 255, slope rules,
// painted biomes), TerrainColors from the world, and attach refusing a WebGL engine. The real-GPU check is
// browser-check.mjs (test:gpu).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { presets, presetWorlds } from '../dist/presets.js';
import {
  BiomeView,
  MATERIALS,
  MAX_GROUND_MATERIALS,
  groundMaterials,
  groundWeights,
  overviewWeights,
  terrainColorsFor,
  viewTile,
} from '../dist/view.js';

test('ground materials are the unique ground layers in first-use order, all of them', () => {
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
  assert.equal(groundMaterials(many).length, 10, 'no material is cut (main cut at 8)');
  for (const key of groundMaterials(Object.values(presets))) assert.ok(MATERIALS[key], `${key} has a built-in look`);
});

test('ground weights: 16 per cell summing to 255, slope rules pick rock on cliffs, paint moves the ground', async () => {
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
    for (let k = 0; k < w.length; k += 16 * 97) {
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += w[k + i];
      assert.equal(sum, 255);
    }
  const at = (w, i, j, m) => w[(j * 256 + i) * 16 + materials.indexOf(m)];
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

// Biome look plan item 1: the 8 presets need 15 ground materials. Main cut the list at 8 and drew every dropped
// material as material 0 (grass), so painted desert sand drew as grass; the default world's boreal needles too.
test('the 8 presets give 15 materials and every one draws as itself: painted desert is sand, not grass', async () => {
  const all = Object.values(presets),
    keys = groundMaterials(all);
  assert.equal(keys.length, 15);
  assert.equal(new Set(keys).size, 15);
  assert.equal(MAX_GROUND_MATERIALS, 16);
  for (const b of all) for (const g of b.ground) assert.ok(keys.includes(g.material), `${b.id} ${g.material}`);
  const world = await BiomeWorld.create({ size: [512, 512], biomes: all, climate: { latitude: 47, rainfall: 1000 } }),
    sand = keys.indexOf('sand');
  assert.ok(sand >= 8, `sand is past the old limit: ${sand}`);
  world.writeLayer('paint/desert', 0, 0, new Uint8Array(256 * 256).fill(255));
  const tile = await world.tile(0, 0),
    w = groundWeights(world, tile, keys),
    // Relief scaled to world size makes part of this tile steep rock; the check reads a painted texel that is flat sand
    // (the view tile has half the resolution, so texel (i, j) there is (2i, 2j) here).
    flat = (() => {
      for (let j = 0; j < 128; j++)
        for (let i = 0; i < 128; i++) {
          const at = (2 * j * 256 + 2 * i) * 16;
          if (w[at + sand] + w[at + keys.indexOf('red-sand')] > 200) return { i, j };
        }
      throw new Error('no flat sand texel on the painted tile');
    })(),
    k = (2 * flat.j * 256 + 2 * flat.i) * 16;
  // Desert ground is sand and red sand; their weight sits at their own index and grass has none.
  assert.ok(w[k + sand] + w[k + keys.indexOf('red-sand')] > 200, `desert is sand: ${[...w.subarray(k, k + 16)]}`);
  assert.equal(w[k + keys.indexOf('grass')], 0, 'and not grass');
  assert.equal(w[k + 15], 0, 'the byte past the 15 materials is 0');
  // The view tile packs 4 materials per texture: 4 textures for 15, sand in texture 2 (index 11), channel 3.
  const t = viewTile(world, tile, keys, 2);
  assert.equal(t.weights.length, 4);
  const texel = (flat.j * t.count + flat.i) * 4;
  assert.equal(t.weights[sand >> 2][texel + (sand & 3)], w[k + sand]);
  // Fewer materials keep 2 textures (the terrain's least).
  const small = await BiomeWorld.create({ size: [512, 512], biomes: [presets.temperate] });
  assert.equal(viewTile(small, await small.tile(0, 0), groundMaterials(small.biomes), 2).weights.length, 2);
});

test('the default world draws its 9th material (boreal needles), and an unknown key throws', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] }),
    keys = groundMaterials(world.biomes);
  assert.ok(keys.includes('needles'), `needles kept: ${keys}`);
  assert.ok(keys.length > 8);
  const tile = await world.tile(0, 0);
  assert.equal(viewTile(world, tile, keys, 2).weights.length, 3);
  // A materials list without a biome's key once drew that key as material 0; now it names the key.
  assert.throws(() => groundWeights(world, tile, keys.slice(0, 8)), { name: 'RangeError', message: /needles/ });
});

test('more than 16 ground materials is a RangeError at attach naming the count and the materials option', async () => {
  const many = Array.from({ length: 6 }, (_, i) =>
      defineBiome({
        id: `b${i}`,
        climate: {},
        ground: [{ material: `m${3 * i}` }, { material: `m${3 * i + 1}` }, { material: `m${3 * i + 2}` }],
      }),
    ),
    keys = groundMaterials(many);
  assert.equal(keys.length, 18);
  const world = await BiomeWorld.create({
      size: [512, 512],
      biomes: many.slice(0, 5).concat(
        defineBiome({
          id: 'b5',
          climate: {},
          ground: [{ material: 'm15' }, { material: 'm16' }],
        }),
      ),
    }),
    seventeen = groundMaterials(world.biomes);
  assert.equal(seventeen.length, 17);
  await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, world), {
    name: 'RangeError',
    message: /up to 16 ground materials and these biomes use 17.*`materials` option/,
  });
  const tile = await world.tile(0, 0);
  assert.throws(() => groundWeights(world, tile, seventeen), RangeError);
});

// Biome look plan item 3: ground layers ruled by temperature. Main's view read only slope, height, moisture and
// curvature, so a snow layer ruled by temperature alone had no rule left and showed on every cell, warm or cold.
test('a temperature ground rule puts snow where it is cold and none where it is warm', async () => {
  const cold = defineBiome({
      id: 'cold',
      climate: {},
      ground: [{ material: 'tundra' }, { material: 'snow', temperature: [null, -6] }],
    }),
    // A ramp from 0 to 4,000 m: about 9 C at the foot, well below -6 C at the top (6.5 C per km).
    world = await BiomeWorld.create({
      size: [512, 512],
      biomes: [cold],
      height: { field: (x) => ((x + 256) / 512) * 4000 },
      climate: { latitude: 47, rainfall: 1000 },
    }),
    keys = groundMaterials(world.biomes),
    snow = keys.indexOf('snow');
  let warm = 0,
    frozen = 0;
  for (const [x, z] of [
    [0, 0],
    [1, 0],
  ]) {
    const tile = await world.tile(x, z),
      t = tile.layer('temperature'),
      w = groundWeights(world, tile, keys);
    for (let k = 0; k < tile.cells * tile.cells; k += 7) {
      const c = t.data[k] * t.scale;
      // The open side blends over 1.5 C around -6 C: all snow's share below -6.75, none above -5.25.
      if (c >= -5.2) {
        warm++;
        assert.equal(w[k * 16 + snow], 0, `no snow at ${c.toFixed(2)} C`);
      } else if (c <= -6.8) {
        frozen++;
        assert.ok(w[k * 16 + snow] >= 120, `snow at ${c.toFixed(2)} C: ${w[k * 16 + snow]}`);
      }
    }
  }
  assert.ok(warm > 1000 && frozen > 1000, `both sides tested: ${warm} warm, ${frozen} frozen cells`);
});

test('the tundra world lies under snow: snow weight above 25 percent of its cells', async () => {
  const { climate, relief } = presetWorlds.tundra,
    world = await BiomeWorld.create({
      size: [1024, 1024],
      biomes: Object.values(presets),
      climate,
      height: { relief },
    }),
    keys = groundMaterials(world.biomes),
    snow = keys.indexOf('snow');
  let sum = 0,
    n = 0;
  for (let z = 0; z < 4; z += 3)
    for (let x = 0; x < 4; x += 3) {
      const tile = await world.tile(x, z),
        w = groundWeights(world, tile, keys);
      for (let k = 0; k < tile.cells * tile.cells; k += 5, n++) sum += w[k * 16 + snow];
    }
  assert.ok(sum / n / 255 > 0.25, `snow share ${(sum / n / 255).toFixed(3)}`);
});

// Biome look plan item 6: the overview a view draws before (and beyond) its tiles. Main sampled every 32 m, nearest,
// and gave each biome its first ground layer only, so far hills were all meadow: against the alpine world's tiles its
// mean absolute difference was 51/255 for rock and 64/255 for meadow.
test('the overview runs the ground rules on the region grid and matches made tiles within 40/255 per material', async () => {
  const { climate, relief } = presetWorlds.alpine,
    world = await BiomeWorld.create({ climate, height: { relief } }),
    keys = groundMaterials(world.biomes),
    ov = overviewWeights(world, keys, 2),
    o = world.overview();
  assert.equal(ov.width, 2049);
  assert.equal(ov.weights.length, 3);
  for (let t = 0; t < ov.width * ov.depth * 4; t += 4 * 4099) {
    let sum = 0;
    for (const w of ov.weights) sum += w[t] + w[t + 1] + w[t + 2] + w[t + 3];
    assert.equal(sum, 255);
  }
  // Tiles over the whole range of the world, the highest (snow) and the lowest among them.
  const heights = [];
  for (let z = 0; z < world.tilesZ; z++)
    for (let x = 0; x < world.tilesX; x++) heights.push([o.height[(z * 16 + 8) * o.width + x * 16 + 8], x, z]);
  heights.sort((a, b) => a[0] - b[0]);
  const picks = [0, 0.2, 0.4, 0.6, 0.8, 0.9, 1].map(
      (f) => heights[Math.min(heights.length - 1, Math.floor(f * heights.length))],
    ),
    diff = new Array(keys.length).fill(0);
  let n = 0;
  for (const [, tx, tz] of picks) {
    const tile = await world.tile(tx, tz),
      g = groundWeights(world, tile, keys);
    for (let j = 0; j < 256; j += 2)
      for (let i = 0; i < 256; i += 2, n++) {
        const t = (((tz * 256 + j) / 2) * ov.width + (tx * 256 + i) / 2) * 4,
          k = (j * 256 + i) * 16;
        for (let m = 0; m < keys.length; m++) diff[m] += Math.abs(ov.weights[m >> 2][t + (m & 3)] - g[k + m]);
      }
  }
  const mean = Object.fromEntries(keys.map((key, m) => [key, diff[m] / n]));
  for (const key of keys) assert.ok(mean[key] < 40, `${key}: ${mean[key].toFixed(1)}/255 (${JSON.stringify(mean)})`);
  assert.ok(
    picks.some(([h]) => h > 2800),
    'a snow tile is among them',
  );
  assert.throws(() => overviewWeights(world, keys, 1.5), RangeError);
});

test('water: a bad option is a TypeError before anything loads', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] });
  await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, world, { water: 'yes' }), TypeError);
});
