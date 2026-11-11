import test from 'node:test';
import assert from 'node:assert/strict';
import { craterField, ridgeNoise, domainWarp, combine, planetPreset, planetPresetRadius } from '../dist/planet-recipes.js';
import { cubeSphere } from '../dist/planet.js';

const R = 1737400;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${what}: ${a} against ${b}`);
// A unit direction `arc` metres along the equator from +X on a planet of radius `radius`.
const along = (arc, radius) => [Math.cos(arc / radius), Math.sin(arc / radius), 0];
// One isolated crater: a population with a single known crater found by scanning for the first one.
function isolated(options) {
  const field = craterField({ radius: R, dMin: 5000, dMax: 10000, count: 40, seed: 3, ...options });
  for (let i = 0; i < 20000; i++) {
    const [x, y, z] = cubeSphere(i % 6, ((i * 0.618) % 2) - 1, ((i * 0.377) % 2) - 1);
    const list = field.craters(x, y, z, 0);
    if (list.length !== 1) continue;
    const c = list[0];
    // The sample must be this crater's alone (no neighbour within its reach): a wider list at the centre excludes it.
    if (field.craters(c.x, c.y, c.z, 0).length === 1) return { field, crater: c };
  }
  throw new Error('no isolated crater found');
}
// A direction `arc` metres from the crater's centre, along a great circle.
function away(c, arc) {
  const up = Math.abs(c.z) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let tx = up[1] * c.z - up[2] * c.y,
    ty = up[2] * c.x - up[0] * c.z,
    tz = up[0] * c.y - up[1] * c.x;
  const l = Math.hypot(tx, ty, tz);
  tx /= l;
  ty /= l;
  tz /= l;
  const a = arc / R;
  return [c.x * Math.cos(a) + tx * Math.sin(a), c.y * Math.cos(a) + ty * Math.sin(a), c.z * Math.cos(a) + tz * Math.sin(a)];
}

test('an isolated crater has the Pike depth and rim ratios and the McGetchin ejecta', () => {
  const { field, crater } = isolated({});
  const D = crater.diameter,
    km = D / 1000,
    Rm = D / 2;
  const centre = field(crater.x, crater.y, crater.z, 0);
  near(-centre / D, (0.196 * km ** 1.01 * 1000) / D, 0.02, 'depth over diameter');
  const rim = field(...away(crater, Rm), 0);
  const expectedRim = 0.036 * km ** 1.01 * 1000;
  near(rim / D, expectedRim / D, 0.02, 'rim height over diameter');
  const without = craterField({ radius: R, dMin: 5000, dMax: 10000, count: 40, seed: 3, ejecta: false });
  const p = away(crater, 2 * Rm);
  const blanket = field(...p, 0) - without(...p, 0);
  near(blanket, 0.14 * Rm ** 0.74 * 2 ** -3, 0.02, 'ejecta thickness at 2R');
  assert.equal(field(...away(crater, 3.2 * Rm), 0), 0);
});

test('a flat floor stays flat and a deep crater is capped at the depth limit', () => {
  const { field, crater } = isolated({ floor: 0.4 });
  const a = field(...away(crater, 0.1 * crater.diameter / 2), 0),
    b = field(...away(crater, 0.35 * crater.diameter / 2), 0),
    c = field(crater.x, crater.y, crater.z, 0);
  assert.ok(Math.abs(a - c) < 1e-6 && Math.abs(b - c) < 1e-6, 'floor is flat');
  const big = craterField({ radius: R, dMin: 200000, dMax: 300000, count: 300, seed: 5, maxDepth: 3400 });
  let deepest = 0;
  for (let i = 0; i < 20000; i++) {
    const [x, y, z] = cubeSphere(i % 6, ((i * 0.618) % 2) - 1, ((i * 0.377) % 2) - 1);
    deepest = Math.min(deepest, big(x, y, z, 0));
  }
  assert.ok(deepest >= -3400 - 1e-6 && deepest < -1000, `deepest ${deepest}`);
});

test('diameters follow the power law (Kolmogorov-Smirnov under 0.02) with a bounded work per sample', () => {
  const radius = 10000,
    dMin = 100,
    dMax = 1000,
    exponent = 2,
    field = craterField({ radius, dMin, dMax, exponent, density: 2e7, seed: 9 });
  const seen = new Map();
  let reads = 0,
    samples = 0,
    worst = 0;
  const rings = Math.ceil((Math.PI * radius) / 90);
  for (let i = 0; i <= rings; i++) {
    const lat = (i / rings) * Math.PI - Math.PI / 2,
      ring = Math.max(1, Math.ceil((2 * Math.PI * radius * Math.cos(lat)) / 90));
    for (let j = 0; j < ring; j++) {
      const lon = (j / ring) * 2 * Math.PI,
        x = Math.cos(lat) * Math.cos(lon),
        y = Math.sin(lat),
        z = Math.cos(lat) * Math.sin(lon),
        list = field.craters(x, y, z, 0);
      samples++;
      reads += list.length;
      worst = Math.max(worst, list.length);
      for (const c of list) seen.set(`${c.x.toFixed(9)},${c.y.toFixed(9)},${c.z.toFixed(9)}`, c.diameter);
    }
  }
  const d = [...seen.values()].sort((a, b) => a - b);
  assert.ok(d.length > 3000, `${d.length} craters`);
  // Truncated power law CDF: F(D) = (dMin^-e - D^-e) / (dMin^-e - dMax^-e).
  const cdf = (v) => (dMin ** -exponent - v ** -exponent) / (dMin ** -exponent - dMax ** -exponent);
  let ks = 0;
  d.forEach((v, i) => (ks = Math.max(ks, Math.abs(cdf(v) - i / d.length), Math.abs(cdf(v) - (i + 1) / d.length))));
  assert.ok(ks < 0.02, `KS ${ks} over ${d.length} craters`);
  // The count matches the density: craters of at least dMin per area (every crater is found by the scan).
  near(d.length, (2e7 / 1e12) * 4 * Math.PI * radius * radius, 0.05, 'crater count');
  assert.ok(reads / samples < 60 && worst < 400, `reads ${reads / samples}, worst ${worst}`);
});

test('a seed decides the population, and detail prunes small craters', () => {
  const a = craterField({ radius: 10000, dMin: 100, dMax: 1000, density: 2e7, seed: 1 }),
    again = craterField({ radius: 10000, dMin: 100, dMax: 1000, density: 2e7, seed: 1 }),
    b = craterField({ radius: 10000, dMin: 100, dMax: 1000, density: 2e7, seed: 2 });
  let differ = 0,
    smaller = 0,
    all = 0,
    pruned = 0;
  for (let i = 0; i < 3000; i++) {
    const [x, y, z] = cubeSphere(i % 6, ((i * 0.618) % 2) - 1, ((i * 0.377) % 2) - 1);
    assert.equal(a(x, y, z, 0), again(x, y, z, 0));
    if (a(x, y, z, 0) !== b(x, y, z, 0)) differ++;
    const full = a.craters(x, y, z, 0),
      cut = a.craters(x, y, z, 150);
    all += full.length;
    pruned += cut.length;
    smaller += full.filter((c) => c.diameter < 300).length;
    assert.ok(cut.every((c) => c.diameter >= 300));
  }
  assert.ok(differ > 500, `${differ} points differ between seeds`);
  assert.ok(pruned < all && all - pruned === smaller, 'detail removes exactly the craters under twice its size');
});

test('craterField is finite everywhere and has no seams at the cube face edges', () => {
  const field = craterField({ radius: 1000, dMin: 10, dMax: 200, density: 1e9, seed: 4 });
  let min = 0,
    max = 0;
  for (let i = 0; i < 100000; i++) {
    const [x, y, z] = cubeSphere(i % 6, ((i * 0.6180339) % 2) - 1, ((i * 0.3819660) % 2) - 1);
    const h = field(x, y, z, 0);
    assert.ok(Number.isFinite(h));
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  assert.ok(min < 0 && max > 0);
  // Heights are continuous: 1 mm apart on the same crater gives almost the same height.
  for (let i = 0; i < 2000; i++) {
    const [x, y, z] = cubeSphere(i % 6, ((i * 0.6180339) % 2) - 1, ((i * 0.3819660) % 2) - 1),
      [u, v, w] = along(0.001, 1000),
      h0 = field(x, y, z, 0),
      h1 = field(x + 1e-6 * u, y + 1e-6 * v, z + 1e-6 * w, 0);
    assert.ok(Math.abs(h1 - h0) < 0.5, `jump ${h1 - h0}`);
  }
});

test('craterField rejects invalid options and a density no cell can hold', () => {
  for (const bad of [
    { radius: 0 },
    { radius: Infinity },
    { dMin: 0 },
    { dMin: 10, dMax: 5 },
    { dMax: 1e9 },
    { exponent: 0.5 },
    { exponent: 3.5 },
    { seed: 1.5 },
    { density: -1 },
    { count: 10, density: 10 },
    { floor: 1 },
    { blend: 2 },
    { maxDepth: 0 },
    { ejecta: 1 },
  ])
    assert.throws(() => craterField(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => craterField({ radius: 1000, dMin: 1, dMax: 100, density: 1e15 }), /raise dMin or lower the density/);
  assert.equal(craterField({ radius: 1000, dMin: 1, dMax: 100, density: 0 })(1, 0, 0, 0), 0);
});

test('ridgeNoise stays in 0..relief, is deterministic and drops octaves below the detail', () => {
  const ridge = ridgeNoise({ radius: 1e6, relief: 500, seed: 4 });
  let min = Infinity,
    max = -Infinity,
    finer = 0;
  for (let i = 0; i < 20000; i++) {
    const [x, y, z] = cubeSphere(i % 6, ((i * 0.618) % 2) - 1, ((i * 0.377) % 2) - 1),
      h = ridge(x, y, z, 0);
    assert.equal(h, ridge(x, y, z, 0));
    min = Math.min(min, h);
    max = Math.max(max, h);
    if (ridge(x, y, z, 200000) !== h) finer++;
  }
  assert.ok(min >= 0 && max <= 500 && max > 100, `${min}..${max}`);
  assert.ok(finer > 10000, 'coarse detail changes the sum');
  assert.equal(ridgeNoise({ relief: 0 })(1, 0, 0, 0), 0);
  for (const bad of [{ radius: -1 }, { relief: -1 }, { octaves: 0 }, { octaves: 25 }, { gain: -1 }, { frequency: 0 }, { seed: 0.5 }])
    assert.throws(() => ridgeNoise(bad), RangeError);
});

test('domainWarp moves where the ground is read from by at most its amplitude, and is the identity at zero', () => {
  const base = (x, y, z) => 1000 * x + 500 * y;
  const same = domainWarp(base, { amplitude: 0 });
  const warped = domainWarp(base, { radius: 1e6, amplitude: 50000, frequency: 4, levels: 2 });
  let moved = 0;
  for (let i = 0; i < 5000; i++) {
    const [x, y, z] = cubeSphere(i % 6, ((i * 0.618) % 2) - 1, ((i * 0.377) % 2) - 1);
    assert.ok(Math.abs(same(x, y, z, 0) - base(x, y, z)) < 1e-9);
    const d = Math.abs(warped(x, y, z, 0) - base(x, y, z));
    if (d > 1) moved++;
    // The slope of base is at most 1118 m per radian; two levels shift at most 2 * amplitude / radius radians.
    assert.ok(d <= 1118 * 2 * 0.05 * 1.01 + 1e-6, `moved ${d}`);
  }
  assert.ok(moved > 2500);
  assert.throws(() => domainWarp(1), TypeError);
  assert.throws(() => domainWarp(base, { levels: 3 }), TypeError);
  assert.throws(() => domainWarp(base, { amplitude: -1 }), TypeError);
});

test('combine adds, takes the maximum or joins smoothly, and rejects bad input', () => {
  const a = () => 10,
    b = () => 4;
  assert.equal(combine([a, b])(0, 0, 1, 0), 14);
  assert.equal(combine([a, b], { mode: 'max' })(0, 0, 1, 0), 10);
  const joined = combine([a, b], { mode: 'smoothMax', smooth: 100 })(0, 0, 1, 0);
  assert.ok(joined > 10 && joined <= 10 + 25, `${joined}`);
  assert.equal(combine([a, () => 1000], { mode: 'smoothMax', smooth: 10 })(0, 0, 1, 0), 1000);
  assert.equal(combine([a, b], { mode: 'smoothMax', smooth: 0 })(0, 0, 1, 0), 10);
  assert.equal(combine([(x, y, z, d) => d])(0, 0, 1, 7), 7);
  assert.throws(() => combine([]), TypeError);
  assert.throws(() => combine([1]), TypeError);
  assert.throws(() => combine([a], { mode: 'min' }), RangeError);
  assert.throws(() => combine([a], { smooth: -1 }), RangeError);
});

test('presets give finite, plausible heights for every body and reject bad input', () => {
  for (const name of ['moon', 'mars', 'asteroid', 'ice']) {
    const radius = planetPresetRadius(name),
      height = planetPreset(name);
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < 100000; i++) {
      const [x, y, z] = cubeSphere(i % 6, ((i * 0.6180339) % 2) - 1, ((i * 0.3819660) % 2) - 1),
        h = height(x, y, z, 0);
      assert.ok(Number.isFinite(h), `${name} ${h}`);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    assert.ok(hi - lo > 1 && Math.abs(lo) < radius && hi < radius, `${name} ${lo}..${hi}`);
    assert.ok(planetPreset(name, { seed: 2 }));
  }
  assert.throws(() => planetPreset('venus'), RangeError);
  assert.throws(() => planetPresetRadius('toString'), RangeError);
  assert.throws(() => planetPreset('moon', { radius: -1 }), RangeError);
  assert.throws(() => planetPreset('moon', { seed: 0.5 }), RangeError);
});
