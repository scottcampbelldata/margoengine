// B3: the CPU side of the view. Ground materials in first-use order, ground weights per cell (sum 255, slope rules,
// painted biomes), TerrainColors from the world, and attach refusing a WebGL engine. The real-GPU check is
// browser-check.mjs (test:gpu).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { presets, presetWorlds } from '../dist/presets.js';
import {
  BiomeView,
  MATERIALS,
  MAX_GROUND_MATERIALS,
  SEA,
  groundMaterials,
  materialPixels,
  groundWeights,
  overviewRows,
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
  assert.ok(Math.abs(c.stone[0] - ((MATERIALS.rock.color[0] + 0.055) / 1.055) ** 2.4) < 1e-6, 'stone is linear rock');
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
  const all = Object.values(presets).filter((b) => b.id !== 'beach'),
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
      biomes: Object.values(presets).filter((b) => b.id !== 'beach'),
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

// Regression: the overview sampled the world with world.sample, which answers from a cached tile where one exists, so
// the far field depended on which tiles the page had made before (268,452 bytes of the zero-config overview changed
// after 16 tiles were made), and a worker replica with other tiles cached would give other bytes.
test('the overview is the same whatever tiles were made, and its row bands are the bytes of the whole', async () => {
  const world = await BiomeWorld.create({ size: [1024, 1024] }),
    keys = groundMaterials(world.biomes),
    before = overviewWeights(world, keys, 2);
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) await world.tile(x, z);
  const after = overviewWeights(world, keys, 2);
  assert.deepEqual(after.weights, before.weights, 'cached tiles change nothing');
  const s = world.sample(100, 100),
    r = world.sampleRegion(100, 100);
  assert.notEqual(s.height, r.height, 'sample reads the cached tile, sampleRegion the region');
  // Bands of uneven sizes, an empty one and one past the end, joined, are the whole.
  const joined = before.weights.map((w) => new Uint8Array(w.length));
  for (const [v0, v1] of [
    [0, 1],
    [1, 200],
    [200, 200],
    [200, 333],
    [333, 9999],
  ]) {
    const band = overviewRows(world, keys, 2, v0, v1);
    assert.equal(band.v1 - band.v0, Math.max(0, Math.min(before.depth, v1) - v0));
    band.weights.forEach((w, i) => {
      assert.equal(w.length, (band.v1 - band.v0) * before.width * 4);
      joined[i].set(w, band.v0 * before.width * 4);
    });
  }
  assert.deepEqual(joined, before.weights);
});

test('water: a bad option is a TypeError before anything loads', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] });
  await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, world, { water: 'yes' }), TypeError);
});

test('sky and material relief: bad options are errors before anything loads', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] });
  for (const sky of [null, 3, {}, { reflectionTexture: undefined }])
    await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, world, { sky }), {
      name: 'TypeError',
      message: /sky/,
    });
  for (const look of [{ bump: 2 }, { macro: -0.1 }, { bump: '1' }])
    await assert.rejects(
      BiomeView.attach({ backend: 'webgpu' }, world, { materials: { rock: { color: [0.5, 0.5, 0.5], ...look } } }),
      { name: 'RangeError', message: /rock.*bump and macro/ },
    );
});

test('the sea defaults are an ocean swell the water draws without folding', () => {
  assert.equal(SEA.segments, 512);
  assert.equal(SEA.foamDistance, 6);
  assert.deepEqual(SEA.color, [0.02, 0.24, 0.34]);
  assert.deepEqual(
    SEA.waves.map((w) => [w.wavelength, w.amplitude]),
    [
      [48, 0.9],
      [27, 0.44],
    ],
  );
  // Water rejects steepness x amplitude x wavenumber over 1 / waves (steepness default 0.5).
  for (const w of SEA.waves) assert.ok(0.5 * w.amplitude * ((2 * Math.PI) / w.wavelength) <= 1 / SEA.waves.length);
  // 8 m cells on a 4 km world: the shortest swell spans over 3 cells.
  assert.ok(SEA.waves.every((w) => w.wavelength / (4096 / SEA.segments) > 3));
});

test('ground looks: rock and snow have relief and macro tone, textures have a fine grain octave', () => {
  assert.deepEqual([MATERIALS.rock.bump, MATERIALS.rock.macro, MATERIALS.rock.detail], [1, 1, 0.6]);
  assert.deepEqual([MATERIALS.snow.bump, MATERIALS.snow.macro], [0.35, 0.15]);
  for (const [key, look] of Object.entries(MATERIALS))
    assert.ok(look.bump > 0 && look.bump <= 1 && look.macro > 0 && look.macro <= 1, `${key} relief and macro`);
  // The alpine preset's snow outweighs the rock it lies on.
  assert.equal(presets.alpine.ground.find((g) => g.material === 'snow').weight, 3);
  const levels = materialPixels('rock', MATERIALS.rock);
  assert.equal(levels.length, 9);
  assert.deepEqual(
    levels.map((l) => l.length),
    [256, 128, 64, 32, 16, 8, 4, 2, 1].map((s) => s * s * 4),
  );
  // The 256-cell octave: neighbouring texels differ (two octaves of 16 and 64 cells changed by about 1 in 255).
  const base = levels[0];
  let step = 0;
  for (let i = 0; i < 255; i++) step += Math.abs(base[i * 4] - base[i * 4 + 4]);
  assert.ok(step / 255 > 3, `mean step between neighbouring texels: ${step / 255}`);
  assert.equal(
    createHash('sha256')
      .update(Buffer.concat(levels.map((l) => Buffer.from(l))))
      .digest('hex')
      .slice(0, 16),
    'd55e967f053eed4a',
  );
});
