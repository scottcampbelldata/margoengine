// B1: climate fields. Closed forms against numeric sums, analytic surfaces with known slope and curvature, the
// distance transform and Priority-Flood against brute force, rain shadow and drift on a ridge, cold-air pools and the
// treeline, determinism across tile order and tile size, golden digests and a time budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BiomeWorld,
  DEFAULT_LAYERS,
  LAYERS,
  degreeDays,
  distanceTransform,
  moistureIndex,
  priorityFlood,
  quantizeClimate,
  evapotranspiration,
  halfAmplitude,
  continentality,
  treelineMargin,
} from '../dist/index.js';
import { ONE, qacos } from '../dist/toolkit.js';
import { random } from './random.js';

const golden = JSON.parse(readFileSync(new URL('./golden/fields.json', import.meta.url), 'utf8'));
const cell = (tile, name, i, j) => {
  const l = tile.layer(name);
  return l.data[j * l.width + i] * l.scale;
};

test('qacos is within 3 units of acos over -1..1', () => {
  for (let x = -ONE; x <= ONE; x += 7) assert.ok(Math.abs(qacos(x) - Math.acos(x / ONE) * ONE) <= 3, `acos ${x}`);
  assert.equal(qacos(2 * ONE), 0);
});

test('closed-form degree days and season length equal a 365-day numeric sum of the same sinusoid (Q1)', () => {
  const rng = random(11),
    out = [0, 0];
  for (let k = 0; k < 400; k++) {
    const mean = Math.round((rng() * 50 - 25) * 100),
      half = Math.round(rng() * 2000),
      base = [90, 500, 1000][k % 3];
    degreeDays(mean, half, base, out);
    let sum = 0,
      days = 0;
    for (let d = 0; d < 365; d++) {
      const t = mean + half * Math.cos((2 * Math.PI * (d + 0.5)) / 365);
      if (t > base) {
        sum += (t - base) / 100;
        days++;
      }
    }
    // Within half a degree day per day of season, and a day of season length.
    assert.ok(
      Math.abs(out[0] - sum) <= 0.5 * Math.max(days, 1) + 1,
      `gdd ${mean} ${half} ${base}: ${out[0]} vs ${sum}`,
    );
    assert.ok(Math.abs(out[1] - days) <= 1, `days ${mean} ${half} ${base}: ${out[1]} vs ${days}`);
  }
  assert.deepEqual(degreeDays(1000, 0, 500, out), [1825, 365]);
  assert.deepEqual(degreeDays(0, 0, 500, out), [0, 0]);
  assert.deepEqual(degreeDays(-2000, 500, 500, out), [0, 0]);
});

test('treeline margin follows Korner: 6.4 C season mean and 94 days', () => {
  assert.equal(treelineMargin(640, 200), 0);
  assert.ok(treelineMargin(700, 200) > 0);
  assert.ok(treelineMargin(600, 200) < 0);
  assert.ok(treelineMargin(900, 80) < 0);
  assert.equal(treelineMargin(900, 124), 100);
});

test('moisture index (Fu-Budyko) is bounded, falls with dryness and meets its limits', () => {
  let last = ONE + 1;
  for (const pet of [1, 100, 300, 600, 900, 1200, 2000, 4000, 9000, 30000]) {
    const a = moistureIndex(pet, 900);
    assert.ok(a >= 0 && a <= ONE, `alpha ${pet}`);
    assert.ok(a <= last, `monotone at ${pet}`);
    last = a;
    // Against the float curve E/P = 1 + phi - (1 + phi^2.6)^(1/2.6).
    const phi = pet / 900,
      want = (1 + phi - (1 + phi ** 2.6) ** (1 / 2.6)) / phi;
    assert.ok(Math.abs(a / ONE - want) < 2e-3, `alpha ${pet}: ${a / ONE} vs ${want}`);
  }
  assert.equal(moistureIndex(0, 900), ONE);
  assert.equal(moistureIndex(900, 0), 0);
});

test('Hargreaves PET has the expected size and grows with heat and diurnal range', () => {
  const c = quantizeClimate({ latitude: 45 }),
    half = halfAmplitude(c, continentality(500_000));
  const temperate = evapotranspiration(c, 1000, half, 1000);
  assert.ok(temperate > 500 && temperate < 1100, `PET at 10 C, 45 N: ${temperate} mm`);
  assert.ok(evapotranspiration(c, 2000, half, 1000) > temperate);
  assert.ok(evapotranspiration(c, 1000, half, 1500) > temperate);
  const tropic = quantizeClimate({ latitude: 5 });
  assert.ok(evapotranspiration(tropic, 2600, halfAmplitude(tropic, 0), 900) > 1200);
  // Seasonal swing grows with latitude and inland distance.
  assert.ok(halfAmplitude(c, continentality(2_000_000)) > halfAmplitude(c, continentality(0)));
  assert.ok(halfAmplitude(quantizeClimate({ latitude: 65 }), 0) > halfAmplitude(c, 0));
});

test('distance transform equals brute force; Priority-Flood equals the brute-force minimal filled surface', () => {
  const rng = random(12);
  for (let k = 0; k < 30; k++) {
    const nx = 3 + Math.floor(rng() * 20),
      nz = 3 + Math.floor(rng() * 20),
      src = new Uint8Array(nx * nz).map(() => (rng() < 0.05 ? 1 : 0)),
      d = distanceTransform(src, nx, nz);
    const any = src.some(Boolean);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        let best = any ? Infinity : -1;
        for (let v = 0; v < nz; v++)
          for (let u = 0; u < nx; u++) if (src[v * nx + u]) best = Math.min(best, (u - x) ** 2 + (v - z) ** 2);
        assert.equal(d[z * nx + x], best, `edt ${nx}x${nz} at ${x},${z}`);
      }
    // Brute force fill: lower water from +inf until stable, W = max(h, min over neighbours of W), border fixed.
    const h = Int32Array.from({ length: nx * nz }, () => Math.floor(rng() * 50)),
      sea = new Uint8Array(nx * nz),
      w = new Float64Array(nx * nz);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) w[z * nx + x] = x && z && x < nx - 1 && z < nz - 1 ? Infinity : h[z * nx + x];
    for (let changed = true; changed; ) {
      changed = false;
      for (let z = 1; z < nz - 1; z++)
        for (let x = 1; x < nx - 1; x++) {
          let low = Infinity;
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) if (dx || dz) low = Math.min(low, w[(z + dz) * nx + x + dx]);
          const v = Math.max(h[z * nx + x], low);
          if (v < w[z * nx + x]) {
            w[z * nx + x] = v;
            changed = true;
          }
        }
    }
    const fill = priorityFlood(h, nx, nz, sea);
    for (let i = 0; i < nx * nz; i++) assert.equal(fill[i], w[i] - h[i], `fill ${nx}x${nz} at ${i}`);
  }
});

const flat = { field: () => 100 };

test('analytic surfaces: planes give their slope and aspect, bowls their curvature, flat ground zero', async () => {
  // A plane rising 0.2 m per m eastward: slope 0.2, downslope to the west (aspect 270), curvature and position 0.
  const plane = await BiomeWorld.create({ size: [512, 512], height: { field: (x) => 0.2 * x + 500 } });
  const p = await plane.tile(1, 1);
  for (const [i, j] of [
    [10, 10],
    [100, 200],
  ]) {
    assert.ok(Math.abs(cell(p, 'slope', i, j) - 0.2) < 0.005, 'plane slope');
    assert.ok(Math.abs(cell(p, 'aspect', i, j) - -90) < 0.1, `plane aspect ${cell(p, 'aspect', i, j)}`);
    assert.ok(Math.abs(cell(p, 'curvature', i, j)) < 0.0002);
    assert.ok(Math.abs(cell(p, 'tpi', i, j)) < 0.11);
  }
  // A plane falling toward +z (south): aspect 180.
  const south = await (
    await BiomeWorld.create({ size: [512, 512], height: { field: (_x, z) => -0.5 * z + 500 } })
  ).tile(0, 0);
  assert.ok(Math.abs(Math.abs(cell(south, 'aspect', 50, 50)) - 180) < 0.1);
  assert.ok(Math.abs(cell(south, 'slope', 50, 50) - 0.5) < 0.005);
  // A bowl h = c (x^2 + z^2): general curvature -4c everywhere, negative (concave).
  const c = 0.002,
    bowl = await (await BiomeWorld.create({ size: [512, 512], height: { field: (x, z) => c * (x * x + z * z) } })).tile(
      1,
      1,
    );
  assert.ok(Math.abs(cell(bowl, 'curvature', 30, 40) - -4 * c) < 0.0003, `bowl ${cell(bowl, 'curvature', 30, 40)}`);
  // Flat ground: nothing but the climate.
  const level = await (await BiomeWorld.create({ size: [512, 512], height: flat })).tile(0, 1);
  for (const name of ['slope', 'curvature', 'tpi'])
    assert.ok(
      level.layer(name).data.every((v) => v === 0),
      name,
    );
  assert.ok(
    level.layer('exposure').data.every((v) => v === 128),
    'flat exposure is neutral',
  );
});

test('a sinusoid gives slope |A k cos(k x)| within quantisation', async () => {
  const A = 20,
    k = (2 * Math.PI) / 400,
    w = await BiomeWorld.create({ size: [512, 512], height: { field: (x) => A * Math.sin(k * x) } }),
    t = await w.tile(1, 0);
  for (const i of [0, 37, 120, 200]) {
    const x = t.origin[0] + i,
      want = Math.abs(A * k * Math.cos(k * x));
    assert.ok(Math.abs(cell(t, 'slope', i, 10) - want) < 0.006, `slope at ${x}: ${cell(t, 'slope', i, 10)} vs ${want}`);
  }
});

/** A ridge across the wind: 1,200 m high at x = 0, Gaussian, 1.5 km wide. */
const ridge = { field: (x) => 1200 * Math.exp(-((x / 1500) ** 2)) };

test('rain shadow on a ridge: the windward slope is wetter, the peak falls past the crest, the lee keeps a floor (Q9)', async () => {
  const w = await BiomeWorld.create({ size: [16384, 1024], height: ridge, climate: { latitude: 45, wind: [1, 0] } });
  const at = (x) => w.sample(x, 0).rainfall;
  const windward = at(-1500),
    lee = at(1800),
    far = at(-7000);
  assert.ok(windward > far * 1.2, `windward ${windward} vs open ground ${far}`);
  assert.ok(lee < windward * 0.8, `lee ${lee} vs windward ${windward}`);
  assert.ok(lee >= 900 * 0.25, 'lee floor');
  let peak = -Infinity,
    peakX = 0;
  for (let x = -6000; x <= 6000; x += 32) {
    const r = at(x);
    if (r > peak) [peak, peakX] = [r, x];
  }
  assert.ok(peakX > -1500, `rain peak at ${peakX} m, not far up the windward foot`);
  // Wind the other way flips it.
  const back = await BiomeWorld.create({
    size: [16384, 1024],
    height: ridge,
    climate: { latitude: 45, wind: [-1, 0] },
  });
  assert.ok(back.sample(1500, 0).rainfall > back.sample(-1800, 0).rainfall);
});

test('treeline falls with latitude on a cone, and a closed basin is colder at night than its rim (Q8)', async () => {
  const cone = { field: (x, z) => Math.max(0, 3000 - Math.hypot(x, z) * 1.2) };
  const line = async (latitude) => {
    const w = await BiomeWorld.create({ size: [8192, 8192], height: cone, climate: { latitude } });
    for (let r = 0; r <= 2500; r += 25) if (w.sample(r, 0).treeline >= 0) return 3000 - r * 1.2; // the highest ground with trees
    return 0;
  };
  const low = await line(20),
    mid = await line(45),
    high = await line(60);
  assert.ok(low > mid && mid > high, `treeline ${low} > ${mid} > ${high} m`);
  const basin = { field: (x, z) => 400 + 150 * Math.min(1, Math.hypot(x, z) / 1500) };
  const pooled = await BiomeWorld.create({ size: [4096, 4096], height: basin });
  const still = await BiomeWorld.create({ size: [4096, 4096], height: basin, climate: { coldAir: 0 } });
  const floor = pooled.sample(0, 0),
    calm = still.sample(0, 0);
  assert.ok(floor.temperature < calm.temperature - 0.3, `pool ${floor.temperature} vs ${calm.temperature}`);
});

test('determinism: any tile order, tile size 128, 256 or 512, and the region sample agree cell by cell', async () => {
  const options = { seed: 3, size: [1024, 1024], climate: { latitude: 52 } };
  const a = await BiomeWorld.create({ ...options, tileSize: 256 }),
    b = await BiomeWorld.create({ ...options, tileSize: 128 }),
    c = await BiomeWorld.create({ ...options, tileSize: 512 });
  const big = await c.tile(1, 0);
  // Tiles of a in reverse order, b in a shuffled order.
  const order = [3, 1, 2, 0];
  for (const k of order) {
    const x = 4 + (k & 1),
      z = k >> 1;
    const small = await b.tile(4 + (k & 1), k >> 1);
    for (const name of DEFAULT_LAYERS)
      for (let j = 0; j < 128; j += 9)
        for (let i = 0; i < 128; i += 7) {
          const gi = (x - 4) * 128 + i,
            gj = z * 128 + j;
          assert.equal(
            small.layer(name).data[j * 128 + i],
            big.layer(name).data[gj * 512 + gi],
            `${name} at ${gi},${gj}`,
          );
        }
  }
  const t = await a.tile(2, 0);
  for (const name of DEFAULT_LAYERS) {
    const per = LAYERS[name].format === 'rgba8' ? 4 : 1;
    for (let j = 0; j < 256; j += 17)
      for (let i = 0; i < 256; i += 13)
        for (let c = 0; c < per; c++)
          assert.equal(
            t.layer(name).data[(j * 256 + i) * per + c],
            big.layer(name).data[(j * 512 + i) * per + c],
            `256 vs 512 ${name}`,
          );
  }
  // Two worlds from the same options give the same digest; another seed does not.
  const again = await BiomeWorld.create({ ...options, tileSize: 256 });
  assert.equal(await again.digest(3, 2), await a.digest(3, 2));
  assert.notEqual(await (await BiomeWorld.create({ ...options, seed: 4 })).digest(3, 2), await a.digest(3, 2));
});

test('golden digests: default world tiles and an R16-style coastal world (fields)', async () => {
  const plain = await BiomeWorld.create();
  assert.equal(await plain.digest(8, 8), golden.default88);
  assert.equal(await plain.digest(0, 15), golden.default015);
  const coast = await BiomeWorld.create({
    seed: 2,
    height: { relief: { coast: 'west', rivers: 2, relief: 1400 } },
    climate: { latitude: 47 },
  });
  assert.equal(await coast.digest(0, 7), golden.coast07);
  assert.equal(await coast.digest(9, 3), golden.coast93);
  const max = await BiomeWorld.create({ seed: 0xffffffff });
  assert.equal(await max.digest(5, 5), golden.seedmax55);
});

test('every layer is in range, tiles hold what was asked, sample reads the tile once it is made', async () => {
  const w = await BiomeWorld.create({ seed: 9 }),
    t = await w.tile(6, 9, { layers: [...DEFAULT_LAYERS, 'profile', 'plan'] });
  assert.deepEqual(t.layers, Object.keys(LAYERS));
  assert.equal(t.cells, 256);
  const temperature = t.layer('temperature').data;
  for (let i = 0; i < temperature.length; i += 97) {
    assert.ok(t.layer('coldest').data[i] <= temperature[i] && temperature[i] <= t.layer('warmest').data[i]);
    assert.ok(t.layer('season').data[i] <= 365);
  }
  const only = await w.tile(6, 9, { layers: ['height', 'slope'] });
  assert.deepEqual(only.layers, ['height', 'slope']);
  const def = await w.tile(6, 9);
  const x = def.origin[0] + 10,
    z = def.origin[1] + 20,
    s = w.sample(x, z);
  assert.equal(s.temperature, cell(def, 'temperature', 10, 20));
  assert.equal(s.height, cell(def, 'height', 10, 20));
});

test('validation, abort, update, onChange and dispose', async () => {
  await assert.rejects(BiomeWorld.create(null), TypeError);
  for (const bad of [
    { seed: -1 },
    { tileSize: 300 },
    { resolution: 3 },
    { size: [100, 100] },
    { size: [1000, 1000] },
    { regionResolution: 6 },
    { climate: { latitude: 95 } },
    { climate: { wind: [0, 0] } },
    { height: { samples: new Float32Array(3), width: 2, depth: 2 } },
  ])
    await assert.rejects(BiomeWorld.create(bad), RangeError, JSON.stringify(bad));
  await assert.rejects(BiomeWorld.create({ backend: 'gpu' }), { name: 'MargoError', code: 'unsupported' });
  await assert.rejects(BiomeWorld.create({ height: { field: 3 } }), TypeError);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(BiomeWorld.create({ signal: controller.signal }), /stop/);
  const w = await BiomeWorld.create({ size: [512, 512] });
  await assert.rejects(w.tile(0, 0, { signal: controller.signal }), /stop/);
  await assert.rejects(w.tile(2, 0), RangeError);
  await assert.rejects(w.tile(0, 0, { layers: ['nope'] }), RangeError);
  const before = await w.digest(1, 1),
    rects = [];
  const off = w.onChange((rect) => {
    rects.push(rect);
    assert.throws(() => w.update({ climate: {} }), { name: 'MargoError', code: 'state' });
  });
  w.update({ climate: { latitude: 30 } });
  assert.deepEqual(rects, [[-256, -256, 256, 256]]);
  assert.notEqual(await w.digest(1, 1), before);
  w.update({ climate: {} });
  assert.equal(await w.digest(1, 1), before, 'back to the defaults, back to the same bytes');
  off();
  w.update({ height: flat });
  assert.equal(rects.length, 2);
  assert.ok((await w.tile(0, 0)).layer('height').data.every((v) => v === 100_000));
  // Heights from samples: a 3 x 3 Float32 tilted grid, Catmull-Rom between them.
  const s = await BiomeWorld.create({
    size: [512, 512],
    height: { samples: new Float32Array([0, 10, 20, 0, 10, 20, 0, 10, 20]), width: 3, depth: 3 },
  });
  const st = await s.tile(0, 0);
  assert.equal(cell(st, 'height', 0, 0), 0);
  assert.ok(Math.abs(cell(st, 'height', 128, 5) - 5) < 0.01, `${cell(st, 'height', 128, 5)}`);
  w[Symbol.dispose]();
  await assert.rejects(w.tile(0, 0), { name: 'MargoError', code: 'disposed' });
  assert.throws(() => w.sample(0, 0), { name: 'MargoError', code: 'disposed' });
});

test('time budget: one default 256 m tile at 1 m in under 400 ms (measured about 37 ms on the reference PC)', async () => {
  const w = await BiomeWorld.create({ seed: 5 });
  await w.tile(0, 0);
  const start = performance.now();
  for (let i = 1; i <= 4; i++) await w.tile(i, 0);
  const each = (performance.now() - start) / 4;
  assert.ok(each < 400, `tile fields took ${each.toFixed(1)} ms`);
});
