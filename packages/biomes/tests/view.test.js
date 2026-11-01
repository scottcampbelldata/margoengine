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
  clipmapLevels,
  SEA,
  groundMaterials,
  materialPixels,
  groundWeights,
  overviewRows,
  overviewWeights,
  terrainColorsFor,
  viewTile,
} from '../dist/view.js';
import { riverWater, riverWaterOptions } from '../dist/rivers.js';
import { canopyCorners, canopyCover, canopyShare, CANOPY_KINDS, darkenTile } from '../dist/cover.js';

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

test('riverWaterOptions makes the ground texture once per device and destroys it', async () => {
  const usage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
  try {
    const gpu = () => {
        const made = {
          textures: [],
          writes: 0,
          createTexture(descriptor) {
            const texture = { descriptor, destroyed: 0, destroy: () => texture.destroyed++ };
            made.textures.push(texture);
            return texture;
          },
          queue: { writeTexture: () => made.writes++ },
        };
        return made;
      },
      first = gpu(),
      second = gpu();
    let device;
    const river = riverWaterOptions(
        {
          bounds: [0, 0, 100, 100],
          heights: new Float32Array(25).fill(10),
          width: 5,
          depth: 5,
          lines: [new Int32Array([0, 50000, 100000, 50000])],
          heightAt: () => 10,
          sea: 0,
        },
        () => device,
      ),
      { heightmap } = river.options.terrain;
    assert.equal(river.options.still, true);
    assert.deepEqual(river.options.terrain.origin, [0, 0]);
    assert.deepEqual(river.options.terrain.size, [100, 100]);
    assert.equal(river.options.fill(50, 50), 11.5);
    assert.equal(heightmap(), undefined, 'no device yet, no texture');
    device = first;
    const texture = heightmap();
    assert.equal(heightmap(), texture, 'one texture per device');
    assert.deepEqual([first.textures.length, first.writes], [1, 1]);
    assert.deepEqual(texture.descriptor.size, [4, 4]);
    assert.equal(texture.descriptor.format, 'r32float');
    device = second;
    assert.notEqual(heightmap(), texture, 'made again after a device restore');
    river.dispose();
    assert.equal(second.textures[0].destroyed, 1);
  } finally {
    globalThis.GPUTextureUsage = usage;
  }
});

test('river water: bad rivers are a TypeError before anything loads', async () => {
  const world = await BiomeWorld.create({ size: [512, 512] });
  await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, world, { water: { rivers: 'all' } }), TypeError);
  world.dispose();
});

test('riverWater stands the surface 1.5 m over the ground along the line, inside a corridor', async () => {
  const world = await BiomeWorld.create({
      height: { relief: { seed: 3, relief: 900, base: 300, rivers: 1, coast: 'south' } },
    }),
    { width, depth, height: heights } = world.overview(),
    line = world.rivers[0],
    river = riverWater({
      bounds: world.bounds,
      heights,
      width,
      depth,
      lines: world.rivers,
      heightAt: (x, z) => world.heightAt(x, z),
      sea: 0,
    });
  assert.equal(world.rivers.length, 1);
  assert.ok(river.width >= 2 && river.width <= 512 && river.ground.length === river.width * river.depth);
  const cell = 4096 / river.width; // float division: metres per cell
  const levels = [];
  for (let k = 1; k < line.length / 2; k++) {
    const x = line[2 * k] / 1000, // float division
      z = line[2 * k + 1] / 1000, // float division
      level = river.fill(x, z),
      ground = world.heightAt(x, z);
    assert.ok(level !== undefined, `surface at line point ${k}`);
    assert.ok(Math.abs(level - ground - 1.5) < 1, `line point ${k}: surface ${level}, ground ${ground}`);
    levels.push(level);
    // The cell under the line holds water; the ground is at or below the bed there.
    const i = Math.floor((x - world.bounds[0]) / cell), // float division
      j = Math.floor((z - world.bounds[1]) / cell); // float division
    assert.ok(river.ground[j * river.width + i] <= level - 1, `cut to the bed at line point ${k}`);
  }
  assert.ok(levels[levels.length - 1] > levels[0] + 10, `the surface rises upstream: ${levels}`);
  // Far from the line there is no fill.
  const [mx, mz] = [line[8] / 1000, line[9] / 1000]; // float division
  assert.equal(river.fill(mx + 400, mz), undefined);
  assert.equal(river.fill(1e7, 0), undefined);
  // Under water below the sea no fill: the sea's own.
  assert.equal(
    riverWater({
      bounds: [0, 0, 64, 64],
      heights: new Float32Array(25).fill(-9),
      width: 5,
      depth: 5,
      lines: [new Int32Array([0, 32000, 64000, 32000])],
      heightAt: () => -9,
      sea: 0,
    }).fill(32, 32),
    undefined,
  );
  // Lines are checked.
  assert.throws(
    () =>
      riverWater({
        bounds: [0, 0, 64, 64],
        heights: new Float32Array(4),
        width: 2,
        depth: 2,
        lines: [[0, 0, 1, 1]],
        heightAt: () => 0,
        sea: 0,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      riverWater({
        bounds: [0, 0, 0, 64],
        heights: new Float32Array(4),
        width: 2,
        depth: 2,
        lines: [],
        heightAt: () => 0,
        sea: 0,
      }),
    RangeError,
  );
  // A world from samples has no lines.
  const flat = await BiomeWorld.create({
    size: [512, 512],
    height: { samples: new Float32Array(25), width: 5, depth: 5 },
  });
  assert.deepEqual(flat.rivers, []);
  flat.dispose();
  world.dispose();
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

test('seasons: a view takes BiomeSeasons of its own world only, refused before anything loads', async () => {
  const { BiomeSeasons } = await import('../dist/seasons.js'),
    world = await BiomeWorld.create({ size: [512, 512] }),
    other = await BiomeWorld.create({ size: [512, 512] });
  for (const seasons of [null, 3, {}, BiomeSeasons.attach(other, { dayOfYear: 10 })])
    await assert.rejects(BiomeView.attach({ backend: 'webgpu' }, world, { seasons }), {
      name: 'TypeError',
      message: /seasons/,
    });
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
  assert.deepEqual([MATERIALS.rock.bump, MATERIALS.rock.macro, MATERIALS.rock.detail], [1, 0.5, 0.45]);
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
    '8a4fe8c41bfe93ed',
  );
});

test('regression: clipmapLevels reaches the whole world, so the terrain no longer ends at 1 km (main drew 6 rings)', () => {
  const world = (side) => [-side / 2, -side / 2, side / 2, side / 2],
    // The guaranteed reach of the outer ring: the camera snaps to its spacing, so 31 cells of 64 are safe.
    reach = (levels, cell = 1, res = 64) => (res / 2 - 1) * cell * 2 ** (levels - 1);
  assert.equal(clipmapLevels(world(4000), 1000), 9, '4 km world: diagonal 5.7 km');
  assert.equal(clipmapLevels(world(65000), 1000), 12, '65 km world: the most the terrain takes');
  assert.equal(clipmapLevels(world(256), 100), 5, 'small world: the fewest rings that reach its corner');
  assert.equal(clipmapLevels(world(256), 3000), 8, 'radius larger than the world wins');
  assert.equal(clipmapLevels(world(4000), 1000, { cellSize: 2, resolution: 32 }), 9);
  for (const side of [100, 1000, 4000, 20000]) {
    const levels = clipmapLevels(world(side), 500);
    assert.ok(reach(levels) >= Math.hypot(side, side) || levels === 12, `${side} m reached`);
    assert.ok(levels === 1 || reach(levels - 1) < Math.max(500, Math.hypot(side, side)), `${side} m fewest`);
  }
  // Explicit settings are kept, and a short one is a coded RangeError naming both distances.
  assert.equal(clipmapLevels(world(4000), 1000, { levels: 7 }), 7);
  assert.throws(
    () => clipmapLevels(world(4000), 1000, { levels: 5 }),
    (e) => e instanceof RangeError && /reaches 496 m but radius is 1000 m/.test(e.message),
  );
});

/** A preset's plants without the placement data of S4 (dry land, stands, tree size 2.4), for tests pinned to the bytes before it. */
const asBefore = (b) => ({
  ...b,
  plants: b.plants?.map(({ suitability, stands, ...p }) => (p.size ? { ...p, size: { ...p.size, max: 1.6 } } : p)),
});

test('canopy cover: a temperate world is mostly crowns, a desert empty, stands open clearings, the sea has none', async () => {
  const flat = { field: () => 40 },
    make = (biomes, height = flat) =>
      BiomeWorld.create({ size: [512, 512], biomes, height, climate: { latitude: 47, rainfall: 1000 } });
  const temperate = await make([asBefore(presets.temperate)]),
    full = canopyCover(temperate);
  assert.equal(full.width, 33);
  assert.equal(full.depth, 33);
  // Oak and beech: density x crown area x mean crown size squared is 0.68 of the ground (the placed crowns of tile (1, 1)
  // read 0.38: the hard core thins them, and cover is meant to read as forest from afar).
  assert.ok(
    full.data.every((v) => v === 174),
    `crowns over a temperate world: ${full.data[0]}`,
  );
  assert.deepEqual(full.kinds[CANOPY_KINDS.indexOf('broadleaf')], full.data, 'and they are broadleaf');
  assert.ok(full.kinds[CANOPY_KINDS.indexOf('conifer')].every((v) => v === 0));
  const desert = await make([presets.desert]);
  assert.ok(
    canopyCover(desert).data.every((v) => v === 0),
    'a desert has no canopy',
  );
  const under = await make([asBefore(presets.temperate)], { field: (x) => (x < 0 ? -20 : 40) }),
    sea = canopyCover(under);
  assert.equal(sea.data[16 * 33 + 2], 0, 'none under the sea');
  assert.equal(sea.data[16 * 33 + 30], 174, 'crowns on land');
  const stands = await make([
      {
        ...presets.temperate,
        plants: presets.temperate.plants.map((p) => ({ ...p, stands: { scale: 150, cover: 0.5 } })),
      },
    ]),
    patchy = canopyCover(stands);
  assert.ok(patchy.data.some((v) => v === 0) && patchy.data.some((v) => v === 255), 'stands and clearings');
  assert.deepEqual(canopyCover(stands).data, patchy.data, 'the same bytes twice');
  assert.throws(() => canopyCover(temperate, 0), RangeError);
  for (const w of [temperate, desert, under, stands]) w.dispose();
});

test('alpine scree lies in hollows: concave ground at 20 degrees takes it, the same slope on a dome does not', async () => {
  const at = async (sign) => {
    const world = await BiomeWorld.create({
        size: [512, 512],
        biomes: [presets.alpine],
        height: { field: (x, z) => 3000 + sign * 0.002 * (x * x + z * z) },
        climate: { latitude: 46, rainfall: 1400 },
      }),
      materials = groundMaterials(world.biomes),
      tile = await world.tile(1, 1),
      view = viewTile(world, tile, materials, 2),
      i = materials.indexOf('scree');
    // Tile (1, 1) runs from the origin to +256 at 2 m a texel: the point (91, 0) slopes at 20 degrees.
    const weight = view.weights[i >> 2][45 * 4 + (i & 3)];
    world.dispose();
    return weight;
  };
  const hollow = await at(1),
    dome = await at(-1);
  assert.ok(hollow > 40, `scree in the hollow: ${hollow}`);
  assert.equal(dome, 0, 'no scree on the dome');
});

test('the canopy material takes its share of the ground and each texel still sums to 255', async () => {
  const world = await BiomeWorld.create({
      size: [512, 512],
      biomes: [asBefore(presets.temperate)],
      height: { field: () => 40 },
      climate: { latitude: 47, rainfall: 1000 },
    }),
    plain = groundMaterials(world.biomes),
    materials = [...plain, 'canopy'],
    tile = await world.tile(0, 0),
    i = materials.length - 1,
    a = viewTile(world, tile, plain, 2),
    b = viewTile(world, tile, materials, 2);
  darkenTile(world, b, 2, materials, 0.6);
  const sum = (t, k) => t.weights.reduce((n, w) => n + w[k] + w[k + 1] + w[k + 2] + w[k + 3], 0);
  for (let k = 0; k < 40; k += 4) {
    assert.equal(sum(b, k), 255);
    assert.ok(Math.abs(b.weights[i >> 2][k + (i & 3)] - 0.6 * 174) <= 1, 'canopy takes 0.6 of the cover');
    assert.ok(b.weights[0][k] <= a.weights[0][k]);
  }
  assert.equal(canopyShare(world, 0.6), 0.6);
  assert.throws(() => canopyShare(world, 2), RangeError);
  const over = overviewWeights(world, materials, 2, canopyCorners(world, materials, 0.6));
  // A tile matches the far ground it replaces, up to the bilinear rounding.
  assert.ok(Math.abs(over.weights[i >> 2][i & 3] - b.weights[i >> 2][i & 3]) <= 1);
  world.dispose();
});

test('far forest: its cover raster stays within reason on huge worlds', async () => {
  const { farStep } = await import('../dist/far.js');
  assert.equal(farStep({ bounds: [-2048, -2048, 2048, 2048] }), 16);
  assert.equal(farStep({ bounds: [-32768, -32768, 32768, 32768] }), 64);
});
