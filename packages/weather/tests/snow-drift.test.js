// SnowDrift: snowfall by Rasmussen 1999, wind scour and lee deposition, cornices, sloughing past the angle of repose,
// the slide state, determinism over film time, and the field Snow draws. Each bound is measured on the real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STABILITY_MAX,
  SnowDrift,
  newSnowDensity,
  snowShare,
  snowStability,
  snowThreshold,
  snowTransport,
  snowVisibility,
  snowfallRate,
  validateSnowDrift,
} from '../dist/snow-drift.js';
import { SNOW_FIELD_BINDINGS, Snow, snowDepthAt, snowFieldAt, snowFieldCover, snowFieldDepth } from '../dist/snow.js';
import { WeatherMachine, visibility } from '../dist/index.js';
import {
  SNOW_DRIFT_LOOKS,
  SNOW_DRIFT_SETTINGS,
  SNOW_SETTINGS,
  applySnowDriftSettings,
  applySnowSettings,
  snowDriftSettingDefaults,
  snowSettingValues,
} from '../dist/settings.js';

const coreShader = readFileSync(new URL('../../core/src/shaders.ts', import.meta.url), 'utf8').split('`')[1];

// A ridge across a wind toward +X: a 30 m windward ramp to an 8 m crest at x = 40, a 53 degree lee drop to x = 46.
const W = 96,
  D = 8;
function ridge() {
  const g = new Float32Array(W * D);
  for (let j = 0; j < D; j++)
    for (let i = 0; i < W; i++) g[j * W + i] = i < 40 ? 8 * Math.max(0, 1 - (40 - i) / 30) : 8 * Math.max(0, 1 - (i - 40) / 6);
  return g;
}
const mean = (a, from, to) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[4 * W + i];
  return s / (to - from);
};
const balance = (d, initial) =>
  d.mass + d.budget.cornices - (initial + d.budget.fallen + d.budget.blownIn - d.budget.blownOut - d.budget.sublimated);

test('snowfall and visibility follow Rasmussen et al. 1999 and the weather visibility', () => {
  // sigma = 2 S / (Vt m/A): the rate whose extinction is the one the weather's visibility uses.
  assert.ok(Math.abs(snowfallRate(0.35) - 0.88) < 0.01 && Math.abs(snowfallRate(0.65) - 1.878) < 0.01);
  assert.ok(Math.abs(snowfallRate(1) - 4.024) < 0.01, `heavy snow ${snowfallRate(1)} mm/h`);
  assert.equal(snowfallRate(0), 0);
  for (const s of [0.2, 0.5, 0.8, 1]) {
    const fromRate = snowVisibility(snowfallRate(s)),
      weather = 3.912 / (3.912 / visibility({ fog: 0, rain: 0, snow: s }) - 3.912 / 23000);
    assert.ok(Math.abs(fromRate / weather - 1) < 1e-9, `snow ${s}: ${fromRate} against ${weather}`);
  }
  // 1 mm/h of dry snow leaves about 1.4 km; wet snow (Vt 1.5, m/A 0.8) six times as far for the same water.
  assert.ok(Math.abs(snowVisibility(1) - 1408.3) < 0.1);
  assert.ok(Math.abs(snowVisibility(1, 1.5, 0.8) / snowVisibility(1) - 6) < 1e-9);
  assert.equal(snowVisibility(0), Infinity);
  assert.throws(() => snowfallRate(2), RangeError);
  assert.throws(() => snowVisibility(-1), RangeError);
});

test('threshold, new snow density, snow share and transport match their papers', () => {
  // Li and Pomeroy 1997: 9.43 m/s at 0 C, lowest about 6.98 m/s near -27 C, wet snow 9.9.
  assert.ok(Math.abs(snowThreshold(0) - 9.43) < 1e-12);
  assert.ok(Math.abs(snowThreshold(-27.27) - 6.98) < 0.01);
  assert.ok(snowThreshold(-10) < snowThreshold(-2) && snowThreshold(2) === 9.9);
  // Hedstrom and Pomeroy 1998: 119 kg/m3 at 0 C, 68 in deep cold.
  assert.ok(Math.abs(newSnowDensity(0) - 119.17) < 0.01 && Math.abs(newSnowDensity(-40) - 67.92) < 0.01);
  assert.equal(snowShare(-5), 1);
  assert.equal(snowShare(1), 0.5);
  assert.equal(snowShare(3), 0);
  // No transport at or below threshold; it grows with the wind; at 15 m/s over an 8.6 m/s threshold it is the PBSM
  // total 15^4.04 / 714801 (1 - (8.6/15)^2), larger than the saltation alone.
  assert.equal(snowTransport(8, 8.6), 0);
  assert.equal(snowTransport(8.6, 8.6), 0);
  let last = 0;
  for (let u = 9; u <= 40; u += 1) {
    const q = snowTransport(u, 8.6);
    assert.ok(q > last, `transport grows: ${q} at ${u}`);
    last = q;
  }
  assert.ok(Math.abs(snowTransport(15, 8.6) - (15 ** 4.04 / 714801) * (1 - (8.6 / 15) ** 2)) < 1e-12);
  // Near the threshold the saltation of Pomeroy and Gray 1990 is the larger.
  const log = Math.log(10 / 0.0005),
    u = (0.4 * 9) / log,
    ut = (0.4 * 8.6) / log,
    rho = 101325 / (287.05 * 268.15);
  assert.ok(Math.abs(snowTransport(9, 8.6) - (0.68 * rho * ut * (u * u - ut * ut)) / (u * 9.81)) < 1e-12);
});

test('the wind scours the windward slope and the crest and drops the snow in the lee, and every kilogram is counted', () => {
  const ground = ridge(),
    calm = new SnowDrift({ width: W, depth: D, ground, initialDepth: 0.3, wind: 0, snowfall: 2, temperature: -8 }),
    windy = new SnowDrift({ width: W, depth: D, ground, initialDepth: 0.3, wind: 16, windDirection: 90, snowfall: 2, temperature: -8 });
  calm.seek(3 * 3600);
  windy.seek(3 * 3600);
  const c = calm.snowDepth(),
    w = windy.snowDepth(),
    flat = mean(c, 0, 8);
  // Calm: the same depth on the flat and the gentle windward ramp.
  assert.ok(Math.abs(mean(c, 14, 36) - flat) < 1e-6, `calm ramp ${mean(c, 14, 36)} vs ${flat}`);
  // Windy: the ramp loses a third, the crest is bare, the foot of the lee holds over double.
  assert.ok(mean(w, 24, 38) < 0.75 * flat, `windward ${mean(w, 24, 38)} against flat ${flat}`);
  assert.ok(w[4 * W + 40] < 0.05, `crest ${w[4 * W + 40]}`);
  assert.ok(Math.max(...Array.from(w.subarray(4 * W + 41, 4 * W + 50))) > 2 * flat, 'a deep lee drift');
  // Mass: what lies plus cornices equals what was there, fell and blew in, less what blew out or sublimated.
  const initial = 0.3 * 250 * W * D;
  assert.ok(Math.abs(balance(windy, initial)) < 1e-6 * initial, `budget off by ${balance(windy, initial)} kg`);
  assert.ok(windy.budget.blownIn > 0 && windy.budget.blownOut > 0 && windy.budget.sublimated > 0);
  assert.ok(Math.abs(balance(calm, initial)) < 1e-6 * initial);
  // A bare upwind edge brings no snow in.
  const bare = new SnowDrift({ width: W, depth: D, ground, wind: 16, windDirection: 90, snowfall: 2, inflow: false });
  bare.seek(3600);
  assert.equal(bare.budget.blownIn, 0);
  assert.ok(bare.depthAt(0, 4) < bare.depthAt(80, 4), 'the upwind edge is scoured');
});

test('drifting turns with the wind: a wind toward -X puts the drift on the other side', () => {
  const V = 97,
    g = new Float32Array(V * D);
  for (let j = 0; j < D; j++) for (let i = 0; i < V; i++) g[j * V + i] = 6 * Math.max(0, 1 - Math.abs(i - 48) / 8);
  const east = new SnowDrift({ width: V, depth: D, ground: g, wind: 16, windDirection: 90, snowfall: 2 }),
    west = new SnowDrift({ width: V, depth: D, ground: g, wind: 16, windDirection: -90, snowfall: 2 });
  east.seek(7200);
  west.seek(7200);
  const e = east.snowDepth(),
    w = west.snowDepth(),
    at = (a, i) => a[4 * V + i],
    avg = (a, f, t) => { let s = 0; for (let i = f; i < t; i++) s += at(a, i); return s / (t - f); };
  assert.ok(avg(e, 49, 56) > 1.5 * avg(e, 41, 48), `east lee ${avg(e, 49, 56)} windward ${avg(e, 41, 48)}`);
  assert.ok(avg(w, 41, 48) > 1.5 * avg(w, 49, 56), `west lee ${avg(w, 41, 48)} windward ${avg(w, 49, 56)}`);
  // Mirror image, as the grid is symmetric about x = 48.
  for (let i = 1; i < 48; i++) assert.ok(Math.abs(at(e, 48 + i) - at(w, 48 - i)) < 1e-9, `mirror at ${i}`);
});

test('snow sloughs off ground steeper than the angle of repose', () => {
  // A 60 degree wall 6 m high in calm snowfall: with repose 45 the snow surface slope stays near 45; with 90, it stays on.
  const g = new Float32Array(32 * 4);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 32; i++) g[j * 32 + i] = Math.min(6, Math.max(0, (i - 10) * Math.tan(Math.PI / 3)));
  const slide = new SnowDrift({ width: 32, depth: 4, ground: g, snowfall: 10, temperature: -10, repose: 45 }),
    stick = new SnowDrift({ width: 32, depth: 4, ground: g, snowfall: 10, temperature: -10, repose: 90 });
  slide.seek(6 * 3600);
  stick.seek(6 * 3600);
  const s = slide.snowDepth(),
    t = stick.snowDepth();
  for (let i = 12; i <= 14; i++) assert.ok(s[2 * 32 + i] < 0.75 * t[2 * 32 + i], `steep cell ${i}: ${s[2 * 32 + i]} against ${t[2 * 32 + i]}`);
  // Where the upper cell holds snow, the snow surface rises no more than repose (tan 45 = 1 per metre) and a little.
  for (let i = 6; i < 18; i++) {
    const rise = slide.surfaceAt(i + 1, 2) - slide.surfaceAt(i, 2);
    assert.ok(rise <= 1.05 || s[2 * 32 + i + 1] < 0.01, `surface rise ${rise} at ${i}`);
  }
  // Without sloughing the rise follows the 60 degree ground.
  assert.ok(stick.surfaceAt(12, 2) - stick.surfaceAt(11, 2) > 1.7);
  assert.ok(s[2 * 32 + 10] > 1.2 * t[2 * 32 + 10], 'the foot collects what slid');
  for (let i = 0; i < 32; i++) assert.ok(Math.abs(t[2 * 32 + i] - t[2 * 32 + 0]) < 1e-9, 'repose 90 keeps an even fall');
  assert.ok(Math.abs(slide.mass - stick.mass) < 1e-6 * stick.mass, 'sloughing moves snow and keeps it');
});

test('cornices grow on the lee edge, lean downwind, and break off onto the slope below', () => {
  const ground = ridge(),
    d = new SnowDrift({ width: W, depth: D, ground, wind: 18, windDirection: 90, snowfall: 0, initialDepth: 0.5, temperature: -10 });
  d.seek(1800);
  const early = d.cornices();
  d.seek(4 * 3600);
  const late = d.cornices();
  assert.equal(late.length, D, 'one per row along the edge');
  for (const c of late) {
    assert.equal(c.x, 40, 'on the crest');
    assert.ok(Math.abs(c.direction[0] - 1) < 1e-9 && Math.abs(c.direction[1]) < 1e-9, 'leaning downwind');
    assert.ok(Math.abs(c.overhang - Math.sqrt(c.mass / 400 / (0.15 * Math.PI))) < 1e-12 && c.height === 0.6 * c.overhang);
  }
  assert.ok(late[0].overhang > early[0].overhang * 1.5, `grows: ${early[0].overhang} then ${late[0].overhang}`);
  // A short corniceMax breaks them; the debris lands on the lee cell and nothing is lost.
  const b = new SnowDrift({ width: W, depth: D, ground, wind: 18, windDirection: 90, initialDepth: 0.5, temperature: -10, corniceMax: 0.3, repose: 90 });
  b.seek(4 * 3600);
  const falls = b.corniceFalls();
  assert.ok(falls.length >= D, `${falls.length} falls`);
  assert.ok(falls.every((f) => f.x === 40 && f.mass > 0 && f.time > 0));
  for (const c of b.cornices()) assert.ok(c.overhang < 0.3);
  assert.ok(Math.abs(balance(b, 0.5 * 250 * W * D)) < 1e-6 * 0.5 * 250 * W * D);
  // No wind, no cornices; capture 0, none.
  const still = new SnowDrift({ width: W, depth: D, ground, wind: 0, snowfall: 3 });
  still.seek(7200);
  assert.equal(still.cornices().length, 0);
  const none = new SnowDrift({ width: W, depth: D, ground, wind: 18, windDirection: 90, initialDepth: 0.5, corniceCapture: 0 });
  none.seek(3600);
  assert.equal(none.cornices().length, 0);
});

test('the cornice mesh is closed, faces outward and reaches past the edge', () => {
  const d = new SnowDrift({ width: W, depth: D, ground: ridge(), wind: 18, windDirection: 90, initialDepth: 0.5, temperature: -10 });
  d.seek(4 * 3600);
  const m = d.corniceGeometry(),
    cs = d.cornices(),
    per = (8 * 2 + 2 * 6) * 3;
  assert.equal(m.indices.length, cs.length * per);
  assert.equal(m.positions.length, m.normals.length);
  let out = 0,
    maxX = -Infinity;
  for (let t = 0; t < m.indices.length; t += 3) {
    const c = cs[Math.floor(t / per)],
      v = [0, 1, 2].map((q) => m.indices[t + q] * 3),
      mid = [0, 1, 2].map((a) => (m.positions[v[0] + a] + m.positions[v[1] + a] + m.positions[v[2] + a]) / 3),
      n = [m.normals[v[0]], m.normals[v[0] + 1], m.normals[v[0] + 2]];
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6);
    const centre = [c.x + 0.25 * c.overhang, c.y + 0.5 * c.height, c.z];
    if ((mid[0] - centre[0]) * n[0] + (mid[1] - centre[1]) * n[1] + (mid[2] - centre[2]) * n[2] > -1e-6) out++;
    maxX = Math.max(maxX, mid[0]);
  }
  assert.ok(out > 0.9 * (m.indices.length / 3), `${out} of ${m.indices.length / 3} faces face out`);
  assert.ok(maxX > 40 + 0.5 * cs[0].overhang, 'the lip reaches past the edge');
});

test('the slide state: a slab on a weak layer, the Foehn index, burial, sintering and a trigger', () => {
  // A 38 degree plane slope (tan 0.78), 40 m long.
  const S = 40,
    g = new Float32Array(S * 4);
  for (let j = 0; j < 4; j++) for (let i = 0; i < S; i++) g[j * S + i] = 0.78 * (S - i);
  const o = { width: S, depth: 4, ground: g, initialDepth: 0.5, snowfall: 0, temperature: -10, burial: 3600, sintering: 0 };
  const d = new SnowDrift(o);
  d.seek(10);
  let s = d.slide();
  // No new snow yet: no slab, every index the cap.
  assert.equal(s.release, 0);
  assert.ok(s.index.every((x) => x === STABILITY_MAX) && s.slabMass.every((x) => x === 0));
  assert.ok(Math.abs(s.slope[2 * S + 20] - (Math.atan(0.78) * 180) / Math.PI) < 1e-3);
  // Snow on it: a slab whose weight sets the stress rho g h sin cos and the index strength / stress.
  o.snowfall = 40;
  d.seek(4 * 3600);
  s = d.slide();
  const k = 2 * S + 20,
    psi = Math.atan(0.78),
    m = s.slabMass[k],
    tau = m * 9.81 * Math.sin(psi) * Math.cos(psi),
    strength = 500 + 0.2 * m * 9.81 * Math.cos(psi) ** 2;
  assert.ok(m > 0 && Math.abs(s.stress[k] / tau - 1) < 1e-5 && Math.abs(s.strength[k] / strength - 1) < 1e-5);
  assert.ok(Math.abs(s.index[k] - Math.min(STABILITY_MAX, strength / tau)) < 1e-4);
  assert.ok(s.index[k] < 1, `160 kg/m2 of new snow on a weak layer at 38 degrees releases: ${s.index[k]}`);
  assert.ok(s.release > 0 && snowStability(s.index[k]) === 'release');
  assert.ok(Math.abs(d.stabilityAt(20, 2) - s.index[k]) < 1e-6);
  // A trigger lowers it; sintering raises it with age.
  o.trigger = 300;
  assert.ok(d.slide().index[k] < s.index[k]);
  o.trigger = 0;
  o.sintering = 100;
  assert.ok(d.slide().index[k] > s.index[k]);
  o.sintering = 0;
  // A fair spell longer than `burial` buries the slab: it becomes old snow and the new surface is the weak layer.
  o.snowfall = 0;
  d.seek(4 * 3600 + 3600 + 20);
  s = d.slide();
  assert.ok(s.slabMass.every((x) => x === 0) && s.baseDepth[k] > 0.5);
  assert.equal(s.release, 0);
  // Classes.
  assert.deepEqual([0.5, 1.2, 2, 3, STABILITY_MAX].map(snowStability), ['release', 'poor', 'fair', 'good', 'none']);
});

test('the snow at a time is the same however it got there, and seeking back replays it', () => {
  const opts = { width: W, depth: D, ground: ridge(), initialDepth: 0.3, wind: 15, windDirection: 70, snowfall: 2, timeScale: 60, step: 10 };
  const once = new SnowDrift(opts),
    steps = new SnowDrift(opts);
  once.seek(90);
  for (let t = 0; t < 900; t++) steps.update(0.1);
  assert.ok(Math.abs(steps.time - 90) < 1e-9);
  assert.deepEqual(steps.snowDepth(), once.snowDepth());
  const v = once.version;
  once.seek(30);
  const back = new SnowDrift(opts);
  back.seek(30);
  assert.deepEqual(once.snowDepth(), back.snowDepth());
  assert.ok(once.version !== v);
  once.seek(90);
  assert.deepEqual(once.snowDepth(), steps.snowDepth());
  // A fixed option changed after construction starts the snow again.
  opts.step = 20;
  once.seek(90);
  const twenty = new SnowDrift({ ...opts });
  twenty.seek(90);
  assert.deepEqual(once.snowDepth(), twenty.snowDepth());
});

test('null rows follow the weather; a value overrides it', () => {
  const machine = new WeatherMachine('blizzard', { seed: 1 }),
    d = new SnowDrift({ width: 16, depth: 4, weather: machine }),
    w = new SnowDrift({ width: 16, depth: 4, wind: machine.state.wind, windDirection: (machine.state.windDirection * 180) / Math.PI, snowfall: snowfallRate(machine.state.snow), temperature: machine.state.temperature, humidity: machine.state.humidity });
  d.seek(600);
  w.seek(600);
  assert.ok(d.budget.fallen > 0);
  assert.deepEqual(d.snowDepth(), w.snowDepth());
  d.options.snowfall = 0;
  const before = d.budget.fallen;
  d.seek(1200);
  assert.equal(d.budget.fallen, before, 'a snowfall of 0 wins over the blizzard');
  // No weather: calm, no snow.
  const none = new SnowDrift({ width: 4, depth: 4 });
  none.seek(3600);
  assert.equal(none.mass, 0);
});

test('bad options throw', () => {
  assert.throws(() => new SnowDrift({ width: 1, depth: 4 }), RangeError);
  assert.throws(() => new SnowDrift({ width: 4, depth: 4, ground: [1, 2] }), TypeError);
  assert.throws(() => new SnowDrift({ width: 4, depth: 4, repose: 10 }), RangeError);
  assert.throws(() => new SnowDrift({ width: 4, depth: 4, weather: {} }), TypeError);
  assert.throws(() => validateSnowDrift(null), TypeError);
  const d = new SnowDrift({ width: 4, depth: 4 });
  assert.throws(() => d.update(-1), RangeError);
  d.options.wind = 99;
  assert.throws(() => d.update(1), RangeError);
});

test('Snow draws a drift field: its depth on the field ground, the weather elsewhere', () => {
  const d = new SnowDrift({ width: W, depth: D, ground: ridge(), initialDepth: 0.3, wind: 16, windDirection: 90, snowfall: 2, origin: [-10, -3] });
  d.seek(3600);
  for (let x = -10; x < 85; x += 1.7) {
    const g = snowFieldAt(d, x, 0.4);
    assert.ok(Math.abs(g[1] - d.depthAt(x, 0.4)) < 1e-5 && Math.abs(g[0] + g[1] - d.surfaceAt(x, 0.4)) < 1e-5);
  }
  assert.equal(snowFieldAt(d, -10.6, 0), undefined);
  assert.deepEqual(snowFieldAt(d, -10.4, 0), snowFieldAt(d, -10, 0), 'half a cell past the edge reads the edge');
  // On the field ground: the field depth and a cover by it; above the band: the weather's.
  const [ground, depth] = snowFieldAt(d, 20, 0);
  assert.equal(snowFieldDepth(d, 20, ground, 0, 0.5, { depth: 0.2 }), depth);
  assert.equal(snowFieldDepth(d, 20, ground + 1, 0, 0.5, { depth: 0.2, variation: 0 }), snowDepthAt(20, 0, 1, 0.5, { depth: 0.2, variation: 0 }));
  assert.equal(snowFieldCover(d, 20, ground + depth, 0, 0.4), depth > 0.03 ? 1 : snowFieldCover(d, 20, ground + depth, 0, 0.4));
  assert.equal(snowFieldCover(d, 20, ground + depth + 1, 0, 0.4), 0.4);
  assert.equal(snowFieldCover(d, 200, 0, 0, 0.4), 0.4);
  // The hook: the field functions and their two bindings in the shader, the plain hook without.
  const snow = new Snow({ field: d });
  const patched = snow.patch(coreShader);
  // The field's tests read the position at the centroid, a covered sample on the triangle, with no pixel slack: a
  // multisampled edge pixel's centre lies off the triangle, and an extrapolated position there whitened a bare ridge's edge.
  assert.ok(patched.includes('weather_snow_field_cover(i.weatherSnowAt,weatherSnow.a.x)'));
  assert.match(patched, /struct Output \{[^}]*,@location\(4\) @interpolate\(perspective,centroid\) weatherSnowAt:vec3f\}/);
  assert.ok(patched.includes('o.position=p.xyz;o.weatherSnowAt=p.xyz;'));
  assert.ok(!patched.includes('fwidth'), 'no pixel slack in the field tests');
  // Patched twice (another surface hook first) keeps one varying.
  assert.equal(snow.patch(patched).split('weatherSnowAt:vec3f').length, 2);
  assert.ok(patched.includes('weather_snow_field_uniform(p.xyz,weatherSnow)'));
  assert.ok(snow.shaderDeclarations().includes(`@binding(${SNOW_FIELD_BINDINGS[1]}) var weatherSnowMap:texture_2d<f32>`));
  const plain = new Snow({});
  assert.ok(!plain.patch(coreShader).includes('weather_snow_field'));
  assert.equal(plain.variant(), '');
  assert.equal(snow.variant(), 'field');
  assert.throws(() => new Snow({ field: { width: 1 } }), TypeError);
  assert.throws(() => new Snow({ band: -1 }), RangeError);
});

test('settings rows: shared shape, weather rows follow, applying writes the options and holds overrides', () => {
  for (const rows of [SNOW_SETTINGS, SNOW_DRIFT_SETTINGS])
    for (const r of rows) {
      assert.ok(r.name && r.group && r.kind && typeof r.about === 'string' && typeof r.live === 'boolean');
      if (r.nullable && r.weather) assert.equal(r.default, null);
    }
  assert.deepEqual(
    SNOW_DRIFT_SETTINGS.filter((r) => r.weather).map((r) => [r.name, r.weather]),
    [
      ['wind', 'wind'],
      ['windDirection', 'windDirection'],
      ['snowfall', 'snow'],
      ['temperature', 'temperature'],
      ['humidity', 'humidity'],
    ],
  );
  // Every option of SnowDrift but its grid and weather has a row.
  const rowNames = new Set(SNOW_DRIFT_SETTINGS.map((r) => r.name));
  for (const key of ['wind', 'repose', 'corniceMax', 'weakLayer', 'trigger', 'settle', 'fetch', 'inflow', 'burial', 'step'])
    assert.ok(rowNames.has(key), key);
  const d = new SnowDrift({ width: 8, depth: 8 });
  applySnowDriftSettings(d, SNOW_DRIFT_LOOKS.blizzard);
  assert.equal(d.options.wind, 24);
  assert.equal(d.options.corniceMax, 2.5);
  assert.equal(d.options.inflow, true);
  assert.equal(d.options.threshold, undefined);
  applySnowDriftSettings(d, { inflow: 'bare', wind: null });
  assert.equal(d.options.inflow, false);
  assert.equal(d.options.wind, undefined);
  assert.equal(snowSettingValues(d, true).inflow, 'bare');
  assert.deepEqual(Object.keys(snowDriftSettingDefaults()), SNOW_DRIFT_SETTINGS.map((r) => r.name));
  assert.throws(() => applySnowDriftSettings(d, { repose: 5 }), RangeError);
  assert.throws(() => applySnowDriftSettings(d, { nope: 1 }), TypeError);
  // Snow: a held cover wins over the weather until handed back.
  const machine = { snowCover: 0.9 },
    snow = new Snow({ weather: machine });
  assert.equal(snow.cover, 0.9);
  applySnowSettings(snow, { cover: 0.2, depth: 0.3 });
  assert.equal(snow.cover, 0.2);
  assert.equal(snow.options.depth, 0.3);
  applySnowSettings(snow, { cover: null });
  assert.equal(snow.cover, 0.9);
  assert.equal(snowSettingValues(snow).depth, 0.12);
});
