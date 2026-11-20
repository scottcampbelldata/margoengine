// Flame (@margoengine/vfx/flame): flames at house-fire and crown-fire size. The CPU half: the blackbody colour against the
// published Planckian locus, the colour ramp that keeps every stop under its peak, Byram's and Heskestad's flame lengths
// against their formulas at stated intensities, Cetegen and Ahmed's puffing, what `Flame` (its light), `Fire`
// (`flameLength`) and `FireFront` (flames along the front and on buildings) write, and that nothing makes a GPU object
// while rows move. The real-GPU half (no pixel over the peak or white, a yellow-white core, the puffing and the flame
// height measured on frames, the light on the ground, the fixed object count, both backends) is flame-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Flame,
  FLAME_PEAK,
  HEARTH_FLAME_LENGTH,
  blackbodyChromaticity,
  blackbodyColor,
  blackbodyLuminanceRatio,
  byramFlameLength,
  byramIntensity,
  flameRamp,
  FLAME_LIGHT_FILL,
  heskestadFlameLength,
  puffingDiameter,
  puffingFrequency,
} from '../dist/flame.js';
import { Fire } from '../dist/fire.js';
import { FireFront, FUEL_MODELS, fireBehaviour } from '../dist/fire-front.js';
import { FLAME_LOOKS, FLAME_SETTINGS, applyFlameSettings, flameSettingDefaults } from '../dist/settings.js';
import { engine } from '../../../tests/support/review56-engine.js';
import { stubDevice } from '../../../tests/support/scene-owner-decoy.js';
import { optionalGPU as harness } from '../../../tests/support/optional-gpu.js';
import { Clustered } from '../../clustered/dist/index.js';
import { LocalShadows } from '../../clustered/dist/shadows.js';
import { LightGroups } from '../../clustered/dist/groups.js';

const optionalGPU = () => {
  const h = harness();
  h.engine.stats = { drawCalls: 0 };
  h.engine.lighting = {
    direction: new Float32Array([0, 3, 4, 2]),
    radiance: new Float32Array([1, 0.5, 0.25, 0.2]),
    ambient: new Float32Array([1, 2, 3]),
  };
  return h;
};

const near = (got, want, rel, label) =>
  assert.ok(Math.abs(got - want) <= rel * Math.abs(want), `${label}: ${got} against ${want} (within ${rel * 100}%)`);
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('blackbody colour: the chromaticity of Planck\'s law is the published locus within 0.012, and the colour is the sRGB of it', () => {
  // CIE 1931 2 degree Planckian locus (Kelly 1963 / Wyszecki and Stiles 1982 tables): kelvin, x, y.
  for (const [k, x, y] of [
    [1000, 0.6528, 0.3444],
    [2000, 0.5267, 0.4133],
    [3000, 0.4369, 0.4041],
    [4000, 0.3805, 0.3768],
    [5000, 0.3451, 0.3516],
    [6500, 0.3135, 0.3237],
  ]) {
    const [gx, gy] = blackbodyChromaticity(k);
    assert.ok(Math.abs(gx - x) <= 0.012 && Math.abs(gy - y) <= 0.012, `${k} K: (${gx.toFixed(4)}, ${gy.toFixed(4)}) against (${x}, ${y})`);
  }
  const white = blackbodyColor(6500);
  assert.ok(white.every((v) => v > 0.93 && v <= 1), `6,500 K is white: ${white}`);
  let last = Infinity;
  for (let k = 900; k <= 3000; k += 100) {
    const [r, g, b] = blackbodyColor(k);
    assert.equal(r, 1, 'red is the largest channel of a flame');
    assert.ok(g / r > (last === Infinity ? 0 : 0) && b <= g, `${k} K`);
    assert.ok(g / r >= (last === Infinity ? 0 : last) - 1e-12, `green over red rises with temperature at ${k} K`);
    last = g / r;
  }
  assert.throws(() => blackbodyColor(100), RangeError);
  assert.throws(() => blackbodyChromaticity(Number.NaN), RangeError);
  assert.ok(blackbodyLuminanceRatio(1000, 1900) < 1e-4, 'a 1,000 K body gives under a ten thousandth of a 1,900 K one');
  assert.equal(blackbodyLuminanceRatio(1900, 1900), 1);
});

test('flameRamp: a clear core-to-edge ramp (hot, bright, yellow-orange to cool, dim, red) and no stop over its peak', () => {
  for (const peak of [0.25, 1, 3]) {
    const stops = flameRamp({ peak });
    assert.equal(stops.length, 7);
    near(Math.max(...stops[0].color), peak, 1e-12, 'the core is at the peak');
    for (const s of stops) assert.ok(Math.max(...s.color) <= peak * (1 + 1e-12), `stop ${s.at} over the peak ${peak}`);
    for (let i = 1; i < stops.length; i++) {
      assert.ok(luma(stops[i].color) < luma(stops[i - 1].color), 'the luminance falls from core to edge');
      assert.ok(stops[i].at > stops[i - 1].at);
    }
    const [core, edge] = [stops[0].color, stops.at(-1).color];
    assert.ok(core[1] / core[0] > 0.2, `the core is hot enough to be orange: g/r ${core[1] / core[0]}`);
    assert.ok(edge[1] / edge[0] < 0.03, `the edge is the red of glowing soot: g/r ${edge[1] / edge[0]}`);
    assert.ok(luma(edge) < 0.15 * luma(core), `the edge is dim: ${luma(edge) / luma(core)} of the core`);
  }
  // exposure 0 keeps every stop at the peak; 1 is the physical fall of Planck's law.
  const flat = flameRamp({ exposure: 0 }),
    physical = flameRamp({ exposure: 1, core: 1900, edge: 1000 });
  for (const s of flat) near(Math.max(...s.color), FLAME_PEAK, 1e-12, 'exposure 0');
  for (const s of physical)
    near(Math.max(...s.color), blackbodyLuminanceRatio(1000 + 900 * (1 - s.at) ** 1.2, 1900), 1e-9, `stop ${s.at} at exposure 1 is Planck's luminance ratio`);
  assert.throws(() => flameRamp({ edge: 3000, core: 1000 }), RangeError);
  assert.throws(() => flameRamp({ peak: 0 }), RangeError);
});

test('Byram\'s flame length 0.0775 I^0.46 at stated intensities, and its inverse', () => {
  // Hand-evaluated from Byram 1959: kW/m, metres.
  for (const [I, L] of [
    [100, 0.645],
    [1000, 1.859],
    [4000, 3.518],
    [10000, 5.362],
    [50000, 11.242],
  ]) {
    assert.ok(Math.abs(byramFlameLength(I) - L) <= 0.0005, `${I} kW/m: ${byramFlameLength(I)} against ${L}`);
    near(byramIntensity(byramFlameLength(I)), I, 1e-12, 'the inverse');
  }
  assert.equal(byramFlameLength(0), 0);
  assert.throws(() => byramFlameLength(-1), RangeError);
  assert.throws(() => byramIntensity(Number.POSITIVE_INFINITY), RangeError);
});

test('Heskestad\'s flame height 0.235 Q^(2/5) - 1.02 D at stated heat releases, never below 0', () => {
  for (const [Q, D, L] of [
    [1e6, 1, 2.704],
    [5e6, 2, 5.05],
    [30e6, 4.3, 10.132],
  ])
    assert.ok(Math.abs(heskestadFlameLength(Q, D) - L) <= 0.0005, `${Q} W over ${D} m: ${heskestadFlameLength(Q, D)} against ${L}`);
  assert.equal(heskestadFlameLength(1e4, 10), 0, 'a source wider than its flame');
  assert.throws(() => heskestadFlameLength(-1, 1), RangeError);
  assert.throws(() => heskestadFlameLength(1, -1), RangeError);
});

test('puffing: Cetegen and Ahmed 1.5 D^(-1/2) Hz over the diameter of a compact fire, or twice the depth of a line of fire', () => {
  near(puffingFrequency(1), 1.5, 1e-12);
  near(puffingFrequency(4), 0.75, 1e-12);
  near(puffingFrequency(9), 0.5, 1e-12);
  near(puffingDiameter([3, 3]), Math.sqrt((4 * 9) / Math.PI), 1e-12, 'a square fire puffs as the circle of its area');
  near(puffingDiameter([60, 2]), 4, 1e-12, 'a long line of fire puffs as twice its depth');
  near(puffingDiameter([0, 0]), 0.05, 1e-12, 'a point fire is held at 5 cm');
  assert.throws(() => puffingFrequency(0), RangeError);
  assert.throws(() => puffingFrequency(Number.NaN), RangeError);
});

test('Flame: a length, an intensity (Byram) or a heat (Heskestad) sizes it, its puffing follows its footprint, and no GPU object follows its moves', () => {
  const h = optionalGPU(),
    byLength = Flame.attach(h.engine, { position: [1, 2, 3], length: 6, footprint: [10, 4] }),
    byIntensity = Flame.attach(h.engine, { position: [0, 0, 0], intensity: 10000 }),
    byHeat = Flame.attach(h.engine, { position: [0, 0, 0], heat: 5e6, footprint: [2, 2] });
  h.frame();
  assert.equal(byLength.flameLength, 6);
  near(byIntensity.flameLength, byramFlameLength(10000), 1e-12, "intensity gives Byram's length");
  near(byHeat.flameLength, heskestadFlameLength(5e6, Math.sqrt((4 * 2 * 2) / Math.PI)), 1e-12, "heat gives Heskestad's length");
  near(byLength.puffing, puffingFrequency(puffingDiameter([10, 4])), 1e-12, 'the puffing of its footprint');
  assert.ok(byLength.time > 0, 'the clock runs on frame deltas');
  assert.deepEqual(byLength.lights, [], 'no lights without lights');
  assert.throws(() => Flame.attach(h.engine, { position: [0, 0, 0] }), TypeError);
  assert.throws(() => Flame.attach(h.engine, { position: [0, 0], length: 1 }), TypeError);
  assert.throws(() => Flame.attach(h.engine, { position: [0, 0, 0], length: -1 }), RangeError);
  assert.throws(() => Flame.attach(h.engine, { position: [0, 0, 0], length: 1, flicker: 4 }), RangeError);
  assert.throws(() => Flame.attach(h.engine, { position: [0, 0, 0], length: 1, tongues: 0.1 }), RangeError);
  assert.throws(() => Flame.attach(h.engine, { position: [0, 0, 0], length: 1, lights: {} }), TypeError);
  // 60 frames of a flame that grows, moves, leans and widens: no buffer or texture.
  const made = h.resources.length;
  for (let f = 0; f < 60; f++) {
    byLength.options.length = 1 + f / 4;
    byLength.options.position[0] = f;
    byLength.options.footprint = [3 + f, 5];
    byLength.options.wind = [f / 10, -f / 20];
    h.frame();
  }
  assert.equal(h.resources.length, made, 'no buffer or texture made over 60 frames');
  byLength.setLength(0);
  h.frame();
  assert.equal(byLength.flameLength, 0, 'a length of 0 puts the flames out');
});

test('Flame.plume: the hot plume HeatHaze reads follows the flame (base, length, footprint as drawn, yaw, lean, clock) (KB-FLAME-HEATHAZE1)', () => {
  const h = optionalGPU(),
    flame = Flame.attach(h.engine, { position: [1, 2, 3], length: 4, footprint: [6, 2], yaw: 0.5, wind: [3, 0] });
  assert.equal(flame.plume.length, 0, 'no plume before the first frame');
  h.frame();
  const p = flame.plume,
    rise = 0.5 * Math.sqrt(9.80665 * 4);
  assert.deepEqual([...p.position], [1, 2, 3]);
  assert.equal(p.length, 4);
  assert.deepEqual([...p.footprint], [6, 2]);
  assert.equal(p.yaw, 0.5);
  near(p.lean[0], 3 / rise, 1e-6, 'the plume leans atan(U / w) downwind');
  assert.equal(p.lean[1], 0);
  assert.equal(p.time, flame.time, "the plume runs on the flame's clock");
  flame.setFlameLook({ 'flames.size': 2 });
  flame.setLength(0);
  h.frame();
  assert.equal(flame.plume.length, 0, 'a flame put out has no plume');
  assert.deepEqual([...flame.plume.footprint], [12, 4], 'the footprint as drawn');
  assert.equal(flame.plume, p, 'one object, rewritten on each read');
});

test('Flame crowns and dither: a crown fire takes a tree spacing, the box reaches down into the crowns, and the dither shift follows the clock (KB-FLAME-LOOK2)', () => {
  const h = optionalGPU(),
    crown = Flame.attach(h.engine, { position: [0, 14, 0], length: 20, footprint: [40, 10], crowns: 8 }),
    surface = Flame.attach(h.engine, { position: [0, 0, 0], length: 20, footprint: [40, 10] });
  h.frame();
  const extra = 48 + 16 * 4; // the extra vec4 after the temperature table
  assert.equal(crown.values[extra + 1], 8, 'the spacing reaches the shader');
  assert.equal(surface.values[extra + 1], 0, 'a surface fire has none');
  near(crown.values[42], -0.46 * 20, 1e-5, 'the box starts 0.46 flame lengths down, where the lowest torching tree starts');
  near(surface.values[42], -0.16 * 20, 1e-5);
  const shift = crown.values[extra];
  h.frame();
  assert.notEqual(crown.values[extra], shift, 'each new frame moves the dither');
  assert.ok(crown.values[extra] < 4096 && Number.isInteger(crown.values[extra]));
  assert.throws(() => Flame.attach(h.engine, { position: [0, 0, 0], length: 4, crowns: -1 }), RangeError);
  assert.throws(() => Flame.attach(h.engine, { position: [0, 0, 0], length: 4, crowns: 2000 }), RangeError);
});

test('Flame lights: points over the footprint at a third of the height, as bright as the silhouette at the peak, flickering about their mean', async (t) => {
  const e = await engine(t);
  stubDevice(e.gpu);
  const clustered = Clustered.attach(e),
    flame = Flame.attach(e, { position: [10, 0, -4], length: 4, footprint: [12, 3], lights: clustered }),
    L = 4,
    total = FLAME_LIGHT_FILL * L * (0.5 * (12 + 3) + 0.24 * L),
    sums = [],
    one = [];
  for (let f = 0; f < 900; f++) {
    e.render({ delta: 1 / 30 });
    sums.push(flame.lights.reduce((s, l) => s + l.intensity, 0));
    one.push(flame.lights[0].intensity);
  }
  const lit = flame.lights.filter((l) => l.intensity > 0);
  assert.equal(lit.length, 3, 'a 12 m stretch of 4 m flames takes three points');
  near(flame.steadyIntensities.reduce((a, b) => a + b, 0), total, 1e-9, 'intensity is the peak radiance times half the silhouette');
  for (const l of lit) {
    near(l.position[1], 0.35 * L, 1e-12, 'a third of the way up');
    assert.ok(Math.abs(l.position[2] + 4) < 1e-9 && Math.abs(l.position[0] - 10) <= 0.4 * 12 + 1e-9, 'over the footprint');
  }
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
  assert.ok(Math.abs(mean / total - 1) < 0.1, `the flicker swings about the mean: ${mean} against ${total}`);
  assert.ok(Math.max(...one) / Math.min(...one) > 1.5, `each point visibly: ${Math.max(...one) / Math.min(...one)}`);
  applyFlameSettings(flame, { 'flames.peak': 2, 'flames.radiance': 0.5, 'flames.flicker': 0 });
  e.render({ delta: 1 / 30 });
  near(flame.steadyIntensities.reduce((a, b) => a + b, 0), total, 1e-9, 'peak 2 at radiance 0.5 is the same light');
  near(flame.lights.reduce((s, l) => s + l.intensity, 0), total, 1e-9, 'flicker 0 holds the light steady');
  const warm = [...flame.lights[0].color];
  applyFlameSettings(flame, { 'flames.core': 1400 });
  e.render({ delta: 1 / 30 });
  assert.ok(flame.lights[0].color[1] < warm[1], 'a cooler core gives a redder light');
});

test('Fire with a flameLength: its flames are a Flame volume of that length that lights through the fire lights, and its embers grow with it', async (t) => {
  const e = await engine(t);
  stubDevice(e.gpu);
  const clustered = Clustered.attach(e);
  LocalShadows.attach(e, { lights: clustered });
  const groups = LightGroups.attach(e, clustered),
    small = Fire.attach(e, { position: [0, 0, 0], lights: groups }),
    big = Fire.attach(e, { position: [0, 0, 0], flameLength: 10, width: 12, breadth: 6, axis: [0, 0, 1], lights: groups });
  big.flame.onPreUpdate(1 / 30);
  assert.equal(big.particles.flames, undefined, 'no billboards');
  assert.equal(big.flame.flameLength, 10);
  assert.deepEqual(big.flame.options.footprint, [12, 6]);
  near(big.flame.options.yaw, -Math.PI / 2, 1e-12, 'the footprint runs along the axis');
  assert.equal(big.lights.length, 0, "the light is the flame's");
  assert.ok(big.flame.lights.some((l) => l.intensity > 0), 'and it is on');
  assert.ok(big.particles.embers.options.size > small.particles.embers.options.size, 'larger embers');
  assert.ok(big.particles.embers.options.rate < small.particles.embers.options.rate * 40, 'but not that many more');
  const before = big.flame.steadyIntensities.reduce((a, b) => a + b, 0);
  applyFlameSettings(big, FLAME_LOOKS.animatedFeature);
  big.flame.onPreUpdate(1 / 30);
  near(big.flame.steadyIntensities.reduce((a, b) => a + b, 0), before * FLAME_LOOKS.animatedFeature['flames.radiance'], 1e-9, 'the flame rows reach the volume');
  // A large fire stands a column on the flame tips with the heat of its flame length (KB-FLAME-LOOK2); a large Fire
  // was refused as a Smoke source before (KB-SMOKE-BIGFIRE1).
  assert.equal(small.smoke, undefined, 'a hearth has no smoke column');
  assert.ok(big.smoke, 'a fire with a flame length smokes by default (KB-FIRE-SMOKEVEIL1 fixed)');
  const smoky = Fire.attach(e, { position: [0, 0, 0], flameLength: 10, width: 12, breadth: 6 });
  assert.deepEqual(smoky.smoke.options.position, [0, 10, 0], 'the column stands on the flame tips');
  const D = Math.sqrt((4 * 12 * 6) / Math.PI);
  near(smoky.smoke.options.heat, 0.7 * 1000 * ((10 + 1.02 * D) / 0.235) ** 2.5, 1e-9, "Heskestad's heat, 70% convected");
  near(smoky.smoke.options.radius, D / 2, 1e-12, 'as wide as the flames');
  assert.equal(smoky.smoke.options.fire, smoky, 'the column follows the fire and its wind');
  const plain = Fire.attach(e, { position: [0, 0, 0], flameLength: 4, smoke: false }),
    grey = Fire.attach(e, { position: [0, 0, 0], flameLength: 4, smoke: { color: [0.1, 0.1, 0.1], opacity: 0.8 } });
  assert.equal(plain.smoke, undefined, 'smoke: false makes none');
  assert.deepEqual(grey.smoke.options.color, [0.1, 0.1, 0.1]);
  assert.throws(() => Fire.attach(e, { position: [0, 0, 0], flameLength: 4, smoke: 3 }), TypeError);
  grey.dispose();
  assert.equal(grey.smoke.disposed, true, 'the column goes with the fire');
  assert.throws(() => Fire.attach(e, { position: [0, 0, 0], flameLength: 0 }), RangeError);
  assert.throws(() => Fire.attach(e, { position: [0, 0, 0], flameLength: 5000 }), RangeError);
});

const MIDFLAME = 8 * 0.4;
function runFront(extra = {}) {
  return FireFront.create({
    size: [600, 300],
    cell: 4,
    fuel: 'FM4',
    moisture: 0.05,
    wind: [8, 0],
    spotting: 0,
    segment: 60,
    ignitions: [{ at: [-200, 0], radius: 10 }],
    ...extra,
  });
}

test('FireFront.flames: a stretch of the front is as long as Byram flame of its fireline intensity, grass to chaparral', () => {
  const lengths = {};
  for (const fuel of ['FM1', 'FM4', 'FM13']) {
    const front = runFront({ fuel }),
      head = fireBehaviour(FUEL_MODELS[fuel], { moisture: 0.05, moisture10: 0.06, moisture100: 0.07, liveMoisture: 0.9, wind: MIDFLAME });
    front.advanceTime(120);
    const flames = front.flames();
    assert.ok(flames.length >= 1 && flames.every((f) => f.kind === 'front' && f.structure === -1), `${fuel}: stretches of front`);
    for (const f of flames) {
      near(f.intensity, head.firelineIntensity, 1e-9, `${fuel}: the cells burn at the head fire's intensity (kW/m)`);
      near(f.flameLength, 0.0775 * f.intensity ** 0.46, 1e-12, `${fuel}: Byram's law`);
      near(f.flameLength, head.flameLength, 1e-9, `${fuel}: the same as fireBehaviour's flame length`);
      // Along the stretch's line (KB-FIRE-FLATBOX1): at most the segment's diagonal plus a cell, at least a cell across.
      assert.ok(f.footprint[0] >= 4 && f.footprint[1] >= 4 && f.footprint[0] <= 64 * Math.SQRT2 + 4 && f.footprint[1] <= f.footprint[0], `a line of cells within its segment: ${f.footprint}`);
    }
    for (let i = 1; i < flames.length; i++) assert.ok(flames[i - 1].heat >= flames[i].heat, 'hottest first');
    lengths[fuel] = flames[0].flameLength;
  }
  assert.ok(lengths.FM1 > 1 && lengths.FM1 < 3, `grass flames are about 2 m: ${lengths.FM1}`);
  assert.ok(lengths.FM4 > 6 && lengths.FM4 < 10, `chaparral flames are about 8 m: ${lengths.FM4}`);
});

test('FireFront.flames: a burning house gives Heskestad\'s flame of its heat over its vent, and its smoke heat is megawatts, not 18 kW a cell', () => {
  const front = runFront({
      structures: [{ at: [-120, 0], radius: 6 }],
      structureExposure: 5,
      ignitions: [{ at: [-120, 0], radius: 3 }],
    }),
    house = FUEL_MODELS.STRUCTURE;
  assert.ok(house.structure);
  front.advanceTime(20);
  const flames = front.flames(),
    h = flames.find((f) => f.kind === 'structure');
  assert.ok(h, 'the house burns');
  assert.equal(h.structure, 0, 'the first building');
  assert.equal(h.intensity, 0);
  const cells = h.cells,
    q = h.heat / 0.7 / 1000,
    d = Math.sqrt((4 * 0.1 * cells * 16) / Math.PI);
  near(h.flameLength, Math.max(0.235 * q ** 0.4 - 1.02 * d, 0), 1e-12, 'Heskestad\'s law over the vent');
  assert.ok(h.heat / cells >= 1e6, `a building cell releases megawatts: ${h.heat / cells} W`);
  assert.ok(h.flameLength > 3, `a house fire has flames over 3 m: ${h.flameLength}`);
  assert.ok(front.segments().some((s) => s.heat >= 1e6), 'the smoke heat of a house is megawatts');
  // A second ignition-free house elsewhere is unburnt and has no flame; the vent share changes the length.
  const tight = runFront({ structures: [{ at: [-120, 0], radius: 6 }], ignitions: [{ at: [-120, 0], radius: 3 }], structureVent: 0.5 });
  tight.advanceTime(20);
  assert.ok(tight.flames().find((f) => f.kind === 'structure').flameLength < h.flameLength, 'a wider vent spreads the heat: shorter flames');
  assert.throws(() => runFront({ structureVent: 0 }), RangeError);
});

test('FireFront with an engine: a fixed pool of flame volumes sits on the hottest stretches and houses, and no GPU object follows', async () => {
  const h = optionalGPU(),
    front = FireFront.attach(h.engine, {
      size: [600, 300],
      cell: 4,
      fuel: 'FM4',
      moisture: 0.05,
      wind: [8, 0],
      spotting: 0,
      segment: 60,
      columns: 0,
      flames: 3,
      buildingFlames: 2,
      structures: [{ at: [-100, 0], radius: 6 }, { at: [0, 20], radius: 6 }],
      structureExposure: 5,
      ignitions: [{ at: [-200, 0], radius: 10 }],
    });
  await front.ready;
  assert.equal(front.flameVolumes.length, 3);
  assert.equal(front.buildingFlameVolumes.length, 2);
  h.frame();
  const made = h.resources.length;
  let moved = 0,
    previous = [];
  for (let step = 0; step < 90; step++) {
    front.advanceTime(2);
    h.frame();
    const now = front.flameVolumes.map((f) => f.options.position[0]);
    if (previous.length && now.some((x, i) => Math.abs(x - previous[i]) > 1e-9)) moved++;
    previous = now;
  }
  assert.equal(h.resources.length, made, 'a front moving for 180 s made no GPU object');
  assert.ok(moved > 10, `the volumes followed the front: ${moved} moves`);
  const flames = front.flames();
  for (const kind of ['front', 'structure']) {
    const pool = kind === 'front' ? front.flameVolumes : front.buildingFlameVolumes,
      top = flames.filter((f) => f.kind === kind).slice(0, pool.length),
      lengths = pool.map((f) => f.options.length).sort((a, b) => b - a);
    assert.ok(top.length > 0, `${kind} flames exist`);
    assert.deepEqual(top.map((f) => f.flameLength).sort((a, b) => b - a), lengths.slice(0, top.length), `${kind} volumes are as long as their stretch's flame`);
    for (const f of top) {
      const flame = pool.find((p) => Math.abs(p.options.position[0] - f.x) < 1e-9 && Math.abs(p.options.position[2] - f.z) < 1e-9);
      assert.ok(flame, `a volume stands on the ${kind} at ${f.x}, ${f.z}`);
      assert.equal(flame.options.length, f.flameLength);
      assert.deepEqual([...flame.options.wind], [MIDFLAME, 0], 'the midflame wind leans the flames');
    }
  }
  // A volume keeps its stretch as the others come and go: its key stays while it is in the top.
  const keys = [...front.flames().filter((f) => f.kind === 'front').slice(0, 3)].map((f) => f.key);
  front.advanceTime(1);
  h.frame();
  const keysAfter = front.flames().filter((f) => f.kind === 'front').slice(0, 3).map((f) => f.key);
  assert.ok(keys.filter((k) => keysAfter.includes(k)).length >= 2, 'the same stretches keep their volumes');
  front.dispose();
  assert.equal(front.flameVolumes.length, 0, 'disposed with the front');
  assert.throws(() => FireFront.create({ flames: 300 }), RangeError, 'a pool above 256 is refused');
  assert.throws(() => FireFront.create({ buildingFlames: -1 }), RangeError);
});

// A FireFront as a flame-look target (timber-valley, scenes plan push 13): a scene's look family and a shot's flame rows
// go through applyFlameSettings, which had no way into a front's flame volumes (it threw reading `particles` of the
// front). setFlameLook writes the rows onto every volume, and onto the volumes made after it is called.
test('applyFlameSettings writes a FireFront\'s flame volumes, the ones made later too', async () => {
  const h = optionalGPU(),
    front = FireFront.attach(h.engine, {
      size: [300, 300],
      cell: 4,
      fuel: 'FM4',
      columns: 0,
      flames: 2,
      buildingFlames: 1,
      flameCapacity: 200,
      ignitions: [{ at: [0, 0], radius: 10 }],
    });
  applyFlameSettings(front, { 'flames.radiance': 2 });
  await front.ready;
  const volumes = [...front.flameVolumes, ...front.buildingFlameVolumes];
  assert.equal(volumes.length, 3);
  for (const v of volumes) assert.equal(v.look['flames.radiance'], 2, 'a volume made after the call takes the look');
  applyFlameSettings(front, { 'flames.radiance': 0.5, 'flames.opacity': 0.8 });
  for (const v of volumes) {
    assert.equal(v.look['flames.radiance'], 0.5);
    assert.equal(v.look['flames.opacity'], 0.8);
  }
  front.dispose();
});

test('Flame slope and glow: the base follows the ground plane, the glow sources, haze and box reach the shader, and the depth pass follows the colour (KB-FLAME-FRONTEMBERS1)', () => {
  const h = optionalGPU(),
    flame = Flame.attach(h.engine, { position: [0, 0, 0], length: 10, footprint: [40, 6], yaw: Math.PI / 2, slope: [0.3, -0.1] }),
    off = Flame.attach(h.engine, { position: [0, 0, 0], length: 10, footprint: [40, 6], glow: 0 }),
    lit = Flame.attach(h.engine, { position: [0, 0, 0], length: 10, footprint: [8, 6], lights: Clustered.attach(h.engine) });
  h.frame();
  const extra = 48 + 16 * 4,
    v = flame.values;
  // Yaw 90 degrees: the footprint's x axis is world -z and its z axis world +x.
  near(v[extra + 4], 0.1, 1e-5, 'slope along the footprint x (world -z)');
  near(v[extra + 5], 0.3, 1e-5, 'slope along the footprint z (world x)');
  assert.equal(v[extra + 6], Math.fround(0.15), 'forest litter albedo with no lights');
  assert.equal(v[extra + 7], Math.fround(0.0005), 'a light haze by default');
  assert.equal(v[extra + 3], 4, 'four glow sources along a 40 m line of 10 m flames');
  near(v[extra + 2], 30, 1e-6, 'the glow reaches three flame lengths');
  assert.ok(v[extra + 12] >= 30 * 1.3 && v[extra + 13] >= 3.5 + 30 * 1.3, 'the glow box holds the glow radius through the slope');
  assert.ok(v[extra + 8] > 0 && v[extra + 8] > v[extra + 10], 'warm glow sources');
  assert.equal(off.values[extra + 3], 0, 'glow 0: no sources');
  assert.equal(lit.values[extra + 6], 0, 'with lights, the point lights light the ground');
  assert.ok(lit.values[extra + 7] > 0, 'with lights the air still glows');
  applyFlameSettings(flame, { 'flames.glow': 0 });
  h.frame();
  assert.equal(flame.values[extra + 3], 0, 'the flames.glow row turns it off');
  applyFlameSettings(flame, { 'flames.haze': 4 });
  h.frame();
  assert.equal(flame.values[extra + 7], Math.fround(0.002), 'the flames.haze row scales the haze');
  for (const bad of [{ slope: [11, 0] }, { slope: [0, Number.NaN] }, { glow: -1 }, { haze: 2 }, { groundAlbedo: 1.5 }, { glowRadius: 0.1 }])
    assert.throws(() => Flame.attach(h.engine, { position: [0, 0, 0], length: 4, ...bad }), /slope|glow|haze|groundAlbedo|glowRadius/);
  const passes = [];
  flame.registerPasses({ add: (p) => passes.push(p) });
  assert.deepEqual(
    passes.map((p) => [p.name.split(':').at(-1), p.order]),
    [
      ['draw', 5.95],
      ['depth', 5.96],
    ],
    'the colour before the particles (6), its depth right after',
  );
});

test('FireFront embers and slope: one ember effect per front flame volume, over its flames and in the wind, none where it is out; flames stand on the ground (KB-FLAME-FRONTEMBERS1)', async () => {
  const h = optionalGPU(),
    ground = (x, z) => 0.25 * x - 0.1 * z,
    make = (extra) =>
      FireFront.attach(h.engine, {
        size: [600, 200],
        origin: [-300, -100],
        cell: 5,
        fuel: 'FM4',
        moisture: 0.05,
        wind: [8, 0],
        spotting: 0,
        segment: 60,
        columns: 0,
        flames: 3,
        buildingFlames: 0,
        ground,
        ignitions: [{ at: [-200, 0], radius: 10 }],
        ...extra,
      }),
    front = make({}),
    bare = make({ flameEmbers: false });
  await Promise.all([front.ready, bare.ready]);
  assert.equal(front.flameEmbers.length, 3, 'one ember effect a front volume');
  assert.equal(bare.flameEmbers.length, 0, 'flameEmbers: false makes none');
  for (const e of front.flameEmbers) assert.equal(e.options.rate, 0, 'idle before the fire burns');
  for (let i = 0; i < 40; i++) front.advanceTime(2);
  const placed = front.flames().filter((f) => f.kind === 'front');
  assert.ok(placed.length > 0);
  for (const f of placed) {
    near(f.slope[0], 0.25, 1e-6, 'slope x from the ground');
    near(f.slope[1], -0.1, 1e-6, 'slope z from the ground');
  }
  let burning = 0;
  front.flameVolumes.forEach((flame, i) => {
    const e = front.flameEmbers[i].options,
      L = flame.options.length;
    assert.deepEqual(flame.options.slope, front.flames().find((f) => f.x === flame.options.position[0])?.slope ?? flame.options.slope);
    if (!(L > 0)) return assert.equal(e.rate, 0, 'no embers where the volume is out');
    burning++;
    near(e.position[0], flame.options.position[0], 1e-9, 'over the flames');
    near(e.position[1], flame.options.position[1] + L / 3, 1e-9, 'a third of the flame up');
    assert.ok(e.rate > 0 && e.velocity[1] > 0, 'born and lofted');
    assert.ok(e.wind[0] > 0, 'carried downwind, ahead of the front');
  });
  assert.ok(burning > 0, 'some volume burns');
  const rate = front.flameEmbers.map((e) => e.options.rate);
  applyFlameSettings(front, { 'embers.count': 2 });
  front.flameEmbers.forEach((e, i) => near(e.options.rate, 2 * rate[i], 1e-9, 'the embers.count row scales the rate'));
  front.dispose();
  assert.equal(front.flameEmbers.length, 0, 'disposed with the front');
});

// The volume is WebGPU only, with no WebGL2 preview route: the preview is refused before the flame is built, so it
// cannot attach and then silently draw nothing (scripts/check-preview-contract.mjs, KB-ROOT-RED18).
test('Flame refuses the small WebGL2 preview before it is built and stays off the engine', async () => {
  const { Engine, TransformStore } = await import('../../core/dist/extension.js');
  const preview = new Engine(
    { width: 64, height: 64 },
    await TransformStore.create(16),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
  );
  try {
    const before = preview.plugins.size;
    assert.throws(
      () => Flame.attach(preview, { position: [0, 0, 0], length: 2 }),
      (error) => error.code === 'unsupported' && error.message.includes('https://margoengine.com/errors#webgpu'),
    );
    assert.equal(preview.plugins.size, before);
  } finally {
    preview.dispose();
  }
});
