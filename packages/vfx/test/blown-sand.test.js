// Wind-blown sand (@margoengine/vfx/blown-sand) with no GPU: the threshold, the emission rule over a dune (nothing
// below the threshold, more on crests and windward slopes than in troughs, none on the slip face), the CPU twin of the
// shader (determinism for a seed and a time, gusts making transport come and go near the threshold) and the settings
// table. The real-GPU check is test/blown-sand-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOWN_SAND_SETTINGS, BlownSand, sandEmission, sandFlux, sandThreshold } from '../dist/blown-sand.js';

// Transverse dunes every 60 m across a wind blowing toward +z: a 12 degree windward side rising 4 m to a rounded
// brink, then a 32 degree slip face down to the trough.
const tanStoss = Math.tan((12 * Math.PI) / 180),
  tanLee = Math.tan((32 * Math.PI) / 180),
  rise = 4,
  stoss = rise / tanStoss,
  lee = rise / tanLee,
  spacing = stoss + lee;
function dunes(_x, z) {
  const p = ((z % spacing) + spacing) % spacing;
  const raw = p < stoss ? p * tanStoss : rise - (p - stoss) * tanLee;
  // Round the brink over 3 m, as a real crest is.
  const d = p - stoss;
  return Math.abs(d) < 3 ? raw - (0.5 * (tanStoss + tanLee) * (3 - Math.abs(d)) ** 2) / 6 : raw;
}
const crest = stoss - 2, // just upwind of the brink
  trough = 1, // the foot of the windward side, 1 m past the slip face's toe
  windward = stoss * 0.6,
  slipFace = stoss + lee / 2;
const wind = (speed, gust = 0.35) => ({ speed, direction: 0, gust });

test('the threshold is Bagnold\'s fluid threshold carried up the log profile: 6.6 m/s at 10 m for 0.25 mm sand', () => {
  const u = sandThreshold();
  // u*t = 0.1 sqrt((2650 - 1.225) / 1.225 * 9.81 * 0.00025) = 0.2303 m/s; u(10) = u*t / 0.4 ln(10 / 0.0001).
  assert.ok(Math.abs(u - (0.2303 / 0.4) * Math.log(1e5)) < 0.01, `threshold ${u}`);
  assert.ok(sandThreshold(0.0005) > u && sandThreshold(0.00012) < u, 'coarser sand needs more wind');
  assert.ok(sandThreshold(0.00025, 2) < u, 'the same wind is slower nearer the ground');
  assert.throws(() => sandThreshold(0.01), RangeError);
  assert.equal(sandFlux(1), 0);
  assert.equal(sandFlux(0.5), 0);
  assert.ok(sandFlux(1.5) > 0 && sandFlux(2) > sandFlux(1.5) && sandFlux(3) < 1);
});

test('no sand moves below the threshold, anywhere and at any time', () => {
  // The largest speed-up is sqrt(3) and the largest gust 1.35: 2.5 m/s times both stays under 6.6 m/s.
  const options = { ground: dunes, wind: wind(2.5) };
  for (const z of [crest, trough, windward, slipFace, 7, 31]) assert.equal(sandEmission(options, 3, z).flux, 0, `z ${z}`);
  const sand = new BlownSand(options);
  for (const t of [0, 0.7, 3.1, 19.4, 120]) {
    sand.time = t;
    const grains = sand.grains([0, 2, 0]);
    assert.ok(grains.length > 1000, `particles are laid out ${grains.length}`);
    assert.equal(grains.filter((g) => g.alpha > 0).length, 0, `time ${t}`);
  }
  // An explicit threshold above the wind does the same; one below it moves sand.
  assert.equal(sandEmission({ ground: dunes, wind: wind(10), threshold: 30 }, 0, crest).flux, 0);
  assert.ok(sandEmission({ ground: dunes, wind: wind(10), threshold: 4 }, 0, crest).flux > 0);
});

test('crests and windward slopes move more sand than troughs; slip faces none', () => {
  const options = { ground: dunes, wind: wind(9) },
    at = (z) => sandEmission(options, 5, z);
  assert.ok(at(crest).speedUp > 1.1, `crest speed-up ${at(crest).speedUp}`);
  assert.ok(at(crest).speedUp > at(windward).speedUp, 'the speed-up grows up the windward side to the crest');
  assert.ok(at(windward).speedUp > at(trough).speedUp, 'windward over trough');
  assert.ok(at(trough).speedUp < 1, `the trough is sheltered ${at(trough).speedUp}`);
  assert.equal(at(slipFace).speedUp, 0, 'the slip face lies in the separation bubble');
  assert.ok(at(crest).flux > 2 * at(trough).flux, `flux crest ${at(crest).flux} trough ${at(trough).flux}`);
  assert.equal(at(stoss + 0.5).brink, true, 'spindrift blows off the brink');
  assert.equal(at(windward).brink, false);
  // A mask (wet sand, grass) holds the sand.
  assert.equal(sandEmission({ ...options, mask: () => 0 }, 5, crest).flux, 0);
  // Over time the particles show it: per square metre more moving sand on the upper windward side than in troughs.
  const sand = new BlownSand(options),
    band = (g, lo, hi) => {
      const p = ((g.position[2] % spacing) + spacing) % spacing;
      return p >= lo && p < hi;
    };
  let high = 0,
    low = 0;
  for (const t of [1, 2.5, 4, 7.5, 11]) {
    sand.time = t;
    for (const g of sand.grains([0, 2, 0])) {
      if (g.kind !== 0 || !(g.alpha > 0)) continue;
      if (band(g, stoss - 8, stoss)) high += g.alpha / 8;
      else if (band(g, 0, 8)) low += g.alpha / 8;
    }
  }
  assert.ok(high > 1.5 * low, `moving sand near crests ${high.toFixed(2)} over troughs ${low.toFixed(2)}`);
});

test('the same seed and time draw the same sand, from any camera path', () => {
  const make = (seed = 4) => new BlownSand({ ground: dunes, wind: wind(11), seed });
  const a = make(),
    b = make();
  // a reaches 12.5 s in uneven frame steps; b is set there at once and first laid out from another place.
  for (const d of [1 / 60, 1 / 30, 0, 1 / 24, 0.5, 1 / 60]) a.advanceTime(d);
  a.advanceTime(12.5 - a.time);
  b.grains([90, 3, -40]);
  b.time = 12.5;
  const ga = a.grains([0, 2, 0]),
    gb = b.grains([0, 2, 0]);
  assert.equal(ga.length, gb.length);
  assert.deepEqual(ga, gb);
  assert.ok(ga.some((g) => g.alpha > 0), 'sand moves at 11 m/s');
  b.time = 12.6;
  assert.notDeepEqual(b.grains([0, 2, 0]), ga, 'a tenth of a second later the sand has moved');
  const c = make(5);
  c.time = 12.5;
  assert.notDeepEqual(c.grains([0, 2, 0]), ga, 'another seed draws other sand');
  // A particle is the same wherever the camera stands, as long as its tile is drawn at the same detail.
  const key = (g) => g.position.map((v) => v.toFixed(4)).join(),
    near = new Set(ga.filter((g) => Math.hypot(g.position[0] - 4, g.position[2] - 4) < 6).map(key));
  const moved = make();
  moved.time = 12.5;
  const there = new Set(moved.grains([8, 2, 8]).map(key));
  assert.ok(near.size > 10);
  for (const k of near) assert.ok(there.has(k), 'a near particle moves with the world, not the camera');
});

test('near the threshold gusts make transport come and go', () => {
  const threshold = sandThreshold(),
    sand = new BlownSand({ ground: () => 0, wind: wind(threshold * 1.05, 0.4) }),
    moving = [];
  for (let t = 0; t < 60; t += 2.5) {
    sand.time = t;
    // Within 6 m of one place: gusts are patches tens of metres long swept past by the wind.
    moving.push(sand.grains([0, 2, 0]).filter((g) => g.alpha > 0 && Math.hypot(g.position[0], g.position[2]) < 6).length);
  }
  assert.ok(Math.min(...moving) < 0.5 * Math.max(...moving), `moving particles over time ${moving}`);
  assert.ok(Math.max(...moving) > 0);
});

test('every setting has its default inside its range, and bad options throw', () => {
  for (const [key, spec] of Object.entries(BLOWN_SAND_SETTINGS))
    if (spec.range && typeof spec.default === 'number')
      assert.ok(spec.default >= spec.range[0] && spec.default <= spec.range[1], key);
  assert.deepEqual(BLOWN_SAND_SETTINGS.color.default, [0.5, 0.42, 0.29]);
  assert.throws(() => new BlownSand({ wind: wind(5) }), TypeError);
  assert.throws(() => new BlownSand({ ground: dunes }), TypeError);
  assert.throws(() => new BlownSand({ ground: dunes, wind: wind(-1) }), RangeError);
  assert.throws(() => new BlownSand({ ground: dunes, wind: wind(5), amount: 2 }), RangeError);
  assert.throws(() => new BlownSand({ ground: dunes, wind: wind(5), softness: 1 }), TypeError);
  assert.throws(() => new BlownSand({ ground: { samples: [0, 1], width: 2, depth: 2 }, wind: wind(5) }), RangeError);
  // A height grid and a WindField-like object work too.
  const grid = new BlownSand({
    ground: { samples: new Float32Array(64 * 64), width: 64, depth: 64, origin: [-32, -32] },
    wind: { options: { speed: 12, direction: Math.PI / 2, gust: 0.2, gustPeriod: 6 } },
    amount: 0.5,
  });
  grid.time = 3;
  assert.ok(grid.grains([0, 2, 0]).some((g) => g.alpha > 0));
  // amount 0 lays out nothing.
  assert.equal(new BlownSand({ ground: dunes, wind: wind(12), amount: 0 }).grains([0, 2, 0]).length, 0);
});
