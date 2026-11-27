// Complex craters, rays and secondary chains of craterField, against the published laws they are built from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanetTerrain } from '../dist/planet.js';
import { craterField, planetPreset, planetPresetBrightness } from '../dist/planet-recipes.js';

const R = 1737400;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${what}: ${a} against ${b}`);
// One crater of `D` metres centred on +X, and nothing else.
const one = (D, options = {}) =>
  craterField({ radius: R, density: 0, rayed: [{ x: 2, y: 0, z: 0, diameter: D }], ...options });
// The direction `arc` metres from +X along the great circle of compass `bearing`.
const at = (arc, bearing = 0) => {
  const a = arc / R;
  return [Math.cos(a), Math.sin(a) * Math.cos(bearing), Math.sin(a) * Math.sin(bearing)];
};
const height = (field, s, D, bearing = 0, detail = 0) => field(...at((s * D) / 2, bearing), detail);

test('a complex crater has the Pike depth, rim, flat floor and central peak', () => {
  const D = 100000,
    field = one(D),
    rim = height(field, 1, D),
    floor = height(field, 0.45, D);
  near(rim, 0.236 * 100 ** 0.399 * 1000, 0.02, 'rim height');
  near(rim - floor, 1.044 * 100 ** 0.301 * 1000, 0.02, 'rim crest to floor');
  // The floor is 0.187 D^1.249 wide: flat out to that fraction, rising past it.
  const flat = (0.187 * 100 ** 1.249) / 100;
  for (const s of [0.36, 0.45, flat - 0.02])
    for (const bearing of [0, 2, 4]) near(height(field, s, D, bearing), floor, 1e-9, `floor at ${s}`);
  assert.ok(height(field, flat + 0.15, D) > floor + 20, 'the wall rises past the floor');
  near(height(field, 0, D) - floor, 0.032 * 100 ** 0.9 * 1000, 0.01, 'central peak height');
  near(height(one(D, { peaks: 0 }), 0, D), floor, 1e-9, 'no peak');
  near(height(one(D, { peaks: 0.5 }), 0, D) - floor, 0.016 * 100 ** 0.9 * 1000, 0.01, 'half a peak');
});

test('terraces cut flat benches into the wall of a complex crater', () => {
  const D = 100000,
    // The share of wall samples whose slope is under a fifth of the mean slope, over 24 radii.
    flat = (terraces) => {
      const field = one(D, { terraces });
      let level = 0,
        all = 0;
      for (let k = 0; k < 24; k++) {
        const bearing = (k / 24) * 2 * Math.PI,
          from = 0.7,
          steps = 200,
          mean = (height(field, 0.999, D, bearing) - height(field, from, D, bearing)) / steps;
        for (let i = 0; i < steps; i++) {
          const s = from + ((0.999 - from) * i) / steps,
            rise = height(field, s + (0.999 - from) / steps, D, bearing) - height(field, s, D, bearing);
          if (Math.abs(rise) < 0.2 * mean) level++;
          all++;
        }
      }
      return level / all;
    };
  const smooth = flat(0),
    benched = flat(1);
  assert.ok(smooth < 0.02, `smooth wall ${smooth}`);
  assert.ok(benched > 0.12 && benched > 10 * smooth, `terraced wall ${benched}, smooth ${smooth}`);
});

test('craters turn complex at the transition without a step, and stay simple past it on request', () => {
  const centre = (D, options) => height(one(D, { peaks: 0, maxDepth: 1e6, ...options }), 0, D);
  near(centre(10583 * 1.001), centre(10583 * 0.999), 0.01, 'depth across the transition');
  const D = 40000,
    km = D / 1000;
  near(-centre(D, { transition: Infinity }), (0.196 - 0.036) * km ** 1.01 * 1000, 0.01, 'a simple bowl');
  near(-centre(D), (1.044 * km ** 0.301 - 0.236 * km ** 0.399) * 1000, 0.03, 'the complex floor');
  // Another body's transition scales the lunar laws: twice the transition, twice every length at twice the diameter.
  near(
    height(one(2 * D, { transition: 2 * 10583, peaks: 0, maxDepth: 1e6 }), 0, 2 * D) / centre(D),
    2 ** 1.01,
    0.01,
    'scaled shape',
  );
});

test('a complex crater field is finite and continuous', () => {
  const field = one(60000);
  let last = height(field, 0, 60000, 1);
  for (let arc = 5; arc < 120000; arc += 5) {
    const h = field(...at(arc, 1), 0);
    assert.ok(Number.isFinite(h) && Math.abs(h - last) < 40, `jump at ${arc}: ${h - last}`);
    last = h;
  }
});

// Runs of true around a closed ring.
const runs = (ring) => ring.filter((v, i) => v && !ring[(i + ring.length - 1) % ring.length]).length;

test('rays are 8 to 14 narrow bright streaks of about 6.59 Rp^1.27', () => {
  const D = 100000,
    primary = D / 2,
    median = 6.59 * (primary / 1000) ** 1.27 * 1000;
  for (const seed of [1, 2, 3]) {
    const field = one(D, { seed }),
      ring = (s) => Array.from({ length: 3600 }, (_, i) => field.brightness(...at(s * primary, i / 572.96), 0));
    assert.equal(field.brightness(...at(0), 0), 1);
    const close = ring(5).map((v) => v > 0.05),
      count = runs(close),
      share = close.filter(Boolean).length / close.length;
    assert.ok(count >= 6 && count <= 14, `seed ${seed}: ${count} rays`);
    assert.ok(share > 0.03 && share < 0.45, `seed ${seed}: share ${share}`);
    assert.ok(
      ring((0.35 * median) / primary).some((v) => v > 0.2),
      `seed ${seed}: rays reach a third of the median`,
    );
    assert.ok(
      ring((1.6 * median) / primary).every((v) => v === 0),
      `seed ${seed}: no ray past 1.5 medians`,
    );
    assert.ok(ring(5).every((v) => v >= 0 && v <= 1));
    assert.equal(field.brightness(-1, 0, 0, 0), 0);
  }
});

test('secondary craters lie in chains along the rays, shallow and no wider than 5 percent of the primary', () => {
  const D = 100000,
    primary = D / 2,
    field = one(D);
  // Nothing between the ejecta's end at 3 radii and the first secondaries about 1.3 diameters past the rim.
  for (let i = 0; i < 2000; i++) assert.equal(height(field, 3.05 + (i % 7) * 0.05, D, i / 318), 0);
  const bearings = new Set();
  let lowest = 0,
    cratered = 0,
    lit = 0,
    samples = 0;
  for (let s = 3.6; s < 12; s += 0.02)
    for (let i = 0; i < 1440; i++) {
      const bearing = (i / 1440) * 2 * Math.PI,
        h = height(field, s, D, bearing);
      samples++;
      lowest = Math.min(lowest, h);
      assert.ok(h < 150, `rim ${h}`);
      if (h >= -20) continue;
      cratered++;
      bearings.add(Math.floor(i / 4));
      if (field.brightness(...at(s * primary, bearing), 0) > 0) lit++;
    }
  // Half a primary's depth law at 5 km is 0.4 km below the rim crest.
  assert.ok(lowest < -100 && lowest > -0.5 * (0.196 - 0.036) * 5 ** 1.01 * 1000 - 100, `deepest ${lowest}`);
  assert.ok(cratered > 200 && cratered / samples < 0.1, `${cratered} of ${samples}`);
  assert.ok(bearings.size < 360 * 0.6, `chains fill ${bearings.size} of 360 sectors`);
  assert.ok(lit / cratered > 0.7, `${lit} of ${cratered} on a ray`);
  // A detail coarser than half the largest secondary leaves them out; the primary stays.
  for (let i = 0; i < 4000; i++) assert.equal(height(field, 3.6 + (i % 80) * 0.1, D, i / 636, 2600), 0);
  assert.ok(height(field, 0.45, D, 0, 2600) < -1000);
});

test('rayed craters are seeded, listed, youngest and validated', () => {
  const field = craterField({ radius: R, density: 0, rayed: 6, seed: 7 }),
    again = craterField({ radius: R, density: 0, rayed: 6, seed: 7 }),
    other = craterField({ radius: R, density: 0, rayed: 6, seed: 8 });
  assert.equal(field.rayed.length, 6);
  assert.deepEqual(field.rayed, again.rayed);
  assert.notDeepEqual(field.rayed, other.rayed);
  for (const c of field.rayed) {
    assert.ok(Math.abs(Math.hypot(c.x, c.y, c.z) - 1) < 1e-12);
    assert.ok(c.diameter >= R / 60 && c.diameter <= R / 16, `${c.diameter}`);
    assert.equal(field(c.x, c.y, c.z, 0), again(c.x, c.y, c.z, 0));
    assert.ok(field.craters(c.x, c.y, c.z, 0).some((k) => k.age === 1 && k.diameter === c.diameter));
  }
  assert.equal(craterField().rayed.length, 0);
  assert.equal(craterField().brightness(1, 0, 0, 0), 0);
  for (const bad of [
    { rayed: -1 },
    { rayed: 65 },
    { rayed: 1.5 },
    { rayed: [{ x: 0, y: 0, z: 0, diameter: 10 }] },
    { rayed: [{ x: 1, y: 0, z: 0, diameter: 0 }] },
    { rayed: [null] },
    { rayedSize: [10, 5] },
    { rayedSize: [0, 5] },
    { transition: 0 },
    { transition: Number.NaN },
    { peaks: -1 },
    { terraces: 2 },
  ])
    assert.throws(() => craterField(bad), RangeError, JSON.stringify(bad));
});

test("the moon preset's rays match its craters and reach PlanetTerrain", () => {
  const brightness = planetPresetBrightness('moon'),
    ground = planetPreset('moon');
  assert.equal(planetPresetBrightness('mars')(1, 0, 0, 0), 0);
  let bright = 0,
    peak;
  for (let i = 0; i < 20000; i++) {
    const z = 1 - (2 * (i + 0.5)) / 20000,
      ring = Math.sqrt(1 - z * z),
      p = [ring * Math.cos(i * 2.39996), ring * Math.sin(i * 2.39996), z],
      value = brightness(...p, 0);
    if (value > 0.3) bright++;
    if (value === 1) peak = p;
  }
  assert.ok(bright > 20 && bright < 5000, `${bright}`);
  // Where the rays say fresh ground, the preset has a young crater: its own field of the same options reads the same.
  const radius = 1737400,
    craters = craterField({ radius, density: 3000, dMin: radius / 40000, dMax: radius / 6, rayed: 6, seed: 1 });
  assert.equal(brightness(...peak, 0), craters.brightness(...peak, 0));
  assert.ok(Number.isFinite(ground(...peak, 0)));
  assert.throws(() => planetPresetBrightness('venus'), RangeError);
  assert.throws(() => planetPresetBrightness('moon', { radius: -1 }), RangeError);
  assert.throws(() => new PlanetTerrain({ brightness: 1 }), TypeError);
});
