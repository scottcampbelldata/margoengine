// water/flood without a GPU (disaster water push 3): option checks, walls and breaches as the uniform holds them, the
// clock's whole steps, and disposal handing the Water back. The solver itself is tested on the GPU in flood.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Flood, tsunamiElevation, windStress } from '../dist/flood.js';
import { readdirSync } from 'node:fs';

// The bridge is internal: its maps are the WeakMaps of the built query-state chunk; the solver map is the one holding
// the Water after attach.
const chunk = readdirSync(new URL('../dist/', import.meta.url)).find((f) => /^query-state-.*\.js$/.test(f));
const maps = Object.values(await import(`../dist/${chunk}`)).filter((v) => v instanceof WeakMap);

const water = () => ({ name: 'water-0', setWaveHeight() {}, options: { terrain: { heightmap: () => undefined, origin: [0, 0], size: [10, 10] } } });
const engine = (surface, gpu = {}) => ({
  gpu,
  hasPlugin: (name) => name === surface.name,
  use(plugin) {
    plugin.setup(this);
  },
  sceneOf: () => ({ removePlugin() {} }),
});

test('Flood refuses what it cannot run', () => {
  assert.throws(() => new Flood(), /surface/);
  assert.throws(() => new Flood({ surface: {} }), /Water as surface/);
  assert.throws(() => new Flood({ surface: { setWaveHeight() {}, options: {} } }), /terrain/);
  const surface = water();
  assert.throws(() => new Flood({ surface, roughness: 0.5 }), RangeError);
  assert.throws(() => new Flood({ surface, maxDepth: 0 }), RangeError);
  assert.throws(() => new Flood({ surface, boundary: { west: 'ocean' } }), RangeError);
  assert.doesNotThrow(() => new Flood({ surface, boundary: { west: 'sea', east: 'open', north: 'wall' } }));
  assert.throws(() => new Flood({ surface, rain: -1 }), RangeError);
  assert.throws(() => new Flood({ surface, rain: 5000 }), RangeError);
  assert.throws(() => new Flood({ surface, surge: 51 }), RangeError);
  assert.throws(() => new Flood({ surface, surgeRise: -1 }), RangeError);
  assert.throws(() => new Flood({ surface, shelf: { depth: 0 } }), RangeError);
  assert.throws(() => new Flood({ surface, shelf: { length: 0 } }), RangeError);
  assert.throws(() => new Flood({ surface, obstacles: 3 }), TypeError);
  assert.throws(() => new Flood({ surface, sources: Array(17).fill({ position: [0, 0], discharge: 1 }) }), RangeError);
  assert.throws(() => new Flood({ surface, sources: [{ position: [0, NaN], discharge: 1 }] }), TypeError);
  assert.throws(() => new Flood({ surface, walls: [{ from: [0, 0], to: [1, 1] }] }), RangeError, 'a wall needs its top');
  const flood = new Flood({ surface, walls: Array.from({ length: 16 }, () => ({ from: [0, 0], to: [1, 0], top: 1 })) });
  assert.throws(() => flood.wall({ from: [0, 0], to: [1, 0], top: 1 }), RangeError, 'at most 16 walls');
  assert.throws(() => flood.breach(16), RangeError);
  assert.throws(() => Flood.attach(engine(surface, null), { surface }), /WebGPU/);
  assert.throws(() => Flood.attach({ ...engine(surface), hasPlugin: () => false }, { surface }), /Attach the Water/);
});

test('walls, breaches and sources go into the uniform as the kernel reads them', () => {
  const flood = new Flood({
    surface: water(),
    sources: [{ position: [3, 4], discharge: 5, radius: 2 }],
    walls: [{ from: [1, 2], to: [3, 4], top: 9, width: 2 }],
    roughness: 0.02,
  });
  assert.equal(flood.wall({ from: [5, 5], to: [5, 9], top: 4, open: 0.5 }), 1);
  const data = new Float32Array(316);
  assert.equal(flood.writeUniform(data, 0), false);
  assert.deepEqual([data[8], data[10], data[11]], [Math.fround(0.02), 1, 2]);
  assert.deepEqual(Array.from(data.subarray(24, 28)), [3, 4, 5, 2]);
  assert.deepEqual(Array.from(data.subarray(88, 104)), [1, 2, 3, 4, 9, 1, 0, 0, 5, 5, 5, 9, 4, 0, 0.5, 0]);
  // Breach wall 1 from t = 10 over 4 s: from half open at 10 to fully open at 14, moving until then. A tick is 1 / 120 s.
  flood.breach(1, { at: 10, over: 4 });
  assert.equal(flood.writeUniform(data, 9 * 120), true);
  assert.equal(data[102], 0.5);
  assert.equal(flood.writeUniform(data, 12 * 120), true);
  assert.equal(data[102], 0.75);
  assert.equal(flood.writeUniform(data, 20 * 120), false);
  assert.equal(data[102], 1);
  flood.breach(0, { at: 1, over: 0 });
  flood.writeUniform(data, 60);
  assert.equal(data[94], 0, 'not before its time');
  flood.writeUniform(data, 120);
  assert.equal(data[94], 1, 'at once with over 0');
});

test('the clock owes whole ticks of 1 / 120 s, at most 240 a frame', () => {
  const flood = new Flood({ surface: water() });
  for (let i = 0; i < 60; i++) flood.advanceTime(1 / 60);
  assert.equal(flood.owedTicks(0), 120);
  assert.equal(flood.owedTicks(100), 20);
  flood.advanceTime(-5);
  assert.ok(Math.abs(flood.time - 1) < 1e-12, 'a negative delta moves nothing');
  flood.advanceTime(10);
  assert.equal(flood.owedTicks(120), 240);
  assert.equal(flood.owedTicks(120, 50), 50, 'settle takes chunks');
  assert.equal(flood.owedTicks(5000), 0);
});

test('24, 30 and 60 fps give the same inputs at every tick', () => {
  const run = (fps, seconds) => {
    const flood = new Flood({ surface: water(), boundary: { west: 'sea' }, walls: [{ from: [0, 0], to: [0, 9], top: 5 }] }),
      frames = Math.round(seconds * fps),
      rows = [];
    for (let i = 0; i < frames; i++) {
      // The film's calls, at its own times, whatever the frame rate.
      const t = flood.time;
      if (Math.abs(t - 2) < 1e-9) flood.breach(0, { at: 2, over: 3 });
      if (Math.abs(t - 3) < 1e-9) flood.setSources([{ position: [4, 4], discharge: 7 }]);
      if (Math.abs(t - 4) < 1e-9) flood.setWind({ speed: 30, direction: [1, 0] });
      if (Math.abs(t - 5) < 1e-9) flood.tsunami({ height: 2, period: 60, at: 6 });
      flood.advanceTime(1 / fps);
    }
    const data = new Float32Array(316);
    for (let k = 0; k < Math.floor(seconds * 120); k += 7) {
      flood.writeUniform(data, k);
      rows.push(Array.from(data).join());
    }
    return rows;
  };
  const a = run(30, 12),
    b = run(60, 12),
    c = run(24, 12);
  assert.deepEqual(b, a, '60 fps equals 30 fps tick for tick');
  assert.deepEqual(c, a, '24 fps equals 30 fps tick for tick');
  assert.ok(new Set(a).size > 20, 'and the inputs did change');
});

test('a setting takes effect at the next tick and the log keeps one entry per change', () => {
  const flood = new Flood({ surface: water() }),
    data = new Float32Array(316);
  flood.advanceTime(0.5);
  flood.setSources([{ position: [1, 1], discharge: 4 }]);
  flood.setSources([{ position: [1, 1], discharge: 4 }]);
  flood.setSources([{ position: [1, 1], discharge: 6 }]);
  flood.advanceTime(1);
  flood.writeUniform(data, 59);
  assert.equal(data[10], 0, 'the tick before it has none');
  flood.writeUniform(data, 60);
  assert.deepEqual([data[10], data[26]], [1, 6], 'the same tick takes the last of its changes');
  assert.equal(flood['log'].length, 2, 'repeats add nothing');
  flood.options.roughness = 0.1;
  flood.advanceTime(0.1);
  flood.writeUniform(data, 180);
  assert.equal(data[8], Math.fround(0.1), 'a live option read at the next advance takes effect from there');
  flood.writeUniform(data, 100);
  assert.equal(data[8], Math.fround(0.03), 'and not before');
});

test('a tsunami is an N-wave: the trough first, the crest after, nothing outside its window', () => {
  const w = { height: 3, period: 300, at: 100, leading: 'trough' };
  assert.equal(tsunamiElevation(99, w), 0);
  assert.equal(tsunamiElevation(401, w), 0);
  let lo = 0,
    hi = 0,
    tLo = 0,
    tHi = 0;
  for (let t = 100; t <= 400; t += 0.1) {
    const e = tsunamiElevation(t, w);
    if (e < lo) ((lo = e), (tLo = t));
    if (e > hi) ((hi = e), (tHi = t));
  }
  assert.ok(Math.abs(lo + 3) < 0.01 && Math.abs(hi - 3) < 0.01, `trough ${lo} and crest ${hi} are the height`);
  assert.ok(tLo < tHi, 'the sea draws back before the crest arrives');
  assert.ok(Math.abs(tLo + tHi - 500) < 0.5, 'symmetric about the middle of the window');
  const flip = { ...w, leading: 'crest' };
  assert.ok(Math.abs(tsunamiElevation(tHi, flip) - tsunamiElevation(tLo, w)) < 1e-9, 'crest first is the same wave run backwards');
  assert.ok(tsunamiElevation(tLo, flip) > 2.9, 'the crest comes first');
});

test('a solitary tsunami is one crest of its height in the middle of its window', () => {
  const w = { height: 0.5, period: 40, at: 10, leading: 'trough', shape: 'solitary' };
  assert.ok(Math.abs(tsunamiElevation(30, w) - 0.5) < 1e-12, 'the crest at the middle');
  assert.ok(Math.abs(tsunamiElevation(25, w) - tsunamiElevation(35, w)) < 1e-12, 'symmetric');
  assert.ok(tsunamiElevation(10, w) < 1e-5 && tsunamiElevation(50, w) < 1e-5, 'gone at the window ends');
  for (let t = 10; t <= 50; t += 0.5) assert.ok(tsunamiElevation(t, w) >= 0, 'never a trough');
  assert.equal(tsunamiElevation(9, w), 0);
});

test('a tsunami needs a sea side and its limits are checked', () => {
  assert.throws(() => new Flood({ surface: water() }).tsunami(), /'sea' side/);
  const flood = new Flood({ surface: water(), boundary: { east: 'sea' } });
  assert.throws(() => flood.tsunami({ height: -1 }), RangeError);
  assert.throws(() => flood.tsunami({ period: 0 }), RangeError);
  assert.throws(() => flood.tsunami({ leading: 'wave' }), RangeError);
  assert.throws(() => flood.tsunami({ shape: 'bump' }), RangeError);
  for (let i = 0; i < 8; i++) flood.tsunami({ at: i });
  assert.throws(() => flood.tsunami(), RangeError, 'at most 8');
});

test('wind stress and the surge law, with the numbers of the plan', () => {
  assert.ok(Math.abs(windStress(18) - 0.776) < 0.005);
  assert.ok(Math.abs(windStress(40) / (1.225 * 1600) - windStress(26) / (1.225 * 676)) < 1e-12, 'the drag coefficient stops growing at 26 m/s');
  const flood = new Flood({ surface: water(), boundary: { east: 'sea' }, surgeRise: 0 });
  flood.setWind({ speed: 18 });
  flood.advanceTime(1);
  assert.ok(Math.abs(flood.surgeAt() - 0.2) < 0.01, `0.2 m at 18 m/s, got ${flood.surgeAt()}`);
  flood.setWind({ speed: 40, direction: [0, 1] });
  flood.advanceTime(1);
  assert.ok(Math.abs(flood.surgeAt() - 1.2) < 0.06, `1.2 m at 40 m/s, got ${flood.surgeAt()}`);
  const data = new Float32Array(316);
  flood.writeUniform(data, 2 * 120);
  assert.ok(Math.abs(data[21] * 1000 - windStress(40)) < 1e-3, 'stress over the density, along the wind');
  assert.equal(data[20], 0);
  flood.options.surge = 2.5;
  flood.advanceTime(1);
  assert.equal(flood.surgeAt(), 2.5, 'an option wins over the wind');
  flood.writeUniform(data, 3 * 120);
  assert.equal(data[16], 2.5, 'the outer sea at the surge');
  assert.throws(() => flood.setWind({ speed: -1 }), RangeError);
  assert.throws(() => flood.setWind({ speed: 3, direction: [0, 0] }), RangeError);
});

test('a surge eases in over surgeRise', () => {
  const flood = new Flood({ surface: water(), boundary: { east: 'sea' }, surge: 0, surgeRise: 100 });
  flood.options.surge = 2;
  flood.advanceTime(0);
  flood.advanceTime(50);
  assert.ok(Math.abs(flood.surgeAt() - 1) < 1e-9, 'half way at half the rise (smoothstep)');
  flood.advanceTime(60);
  assert.equal(flood.surgeAt(), 2);
});

test('rain is a depth rate, held by the option or driven', () => {
  const flood = new Flood({ surface: water() }),
    data = new Float32Array(316);
  flood.setRainRate(100);
  flood.advanceTime(1);
  flood.writeUniform(data, 120);
  assert.ok(Math.abs(data[22] - 100 / 3.6e6) < 1e-12);
  flood.options.rain = 10;
  flood.advanceTime(1);
  flood.writeUniform(data, 240);
  assert.ok(Math.abs(data[22] - 10 / 3.6e6) < 1e-12, 'an option beats the driven rate');
  assert.throws(() => flood.setRainRate(-1), RangeError);
});

test('the Water level follows the flood and a level a person sets becomes the base', () => {
  const disposers = [],
    surface = {
      ...water(),
      seaLevel: 1,
      setSeaLevel(y) {
        this.seaLevel = Math.fround(y);
      },
      onDispose: (f) => disposers.push(f),
    };
  const flood = new Flood({ surface, boundary: { west: 'sea' }, surge: 1, surgeRise: 0 });
  flood.advanceTime(1);
  assert.equal(surface.seaLevel, 2, 'base 1 plus the surge');
  surface.setSeaLevel(5);
  flood.advanceTime(1);
  assert.equal(surface.seaLevel, 6, 'a level set meanwhile is the new base');
  assert.equal(flood.seaLevelAt(), 6);
  flood.tsunami({ height: 2, period: 4, at: 2 });
  flood.advanceTime(1.3);
  assert.ok(Math.abs(surface.seaLevel - 6) > 0.1 && Math.abs(surface.seaLevel - 6) <= 2.0001, 'a tsunami lifts it');
  flood.dispose();
  assert.equal(surface.seaLevel, 5, 'the Water gets its own level back');
  const gone = { ...surface, seaLevel: 1, setSeaLevel: () => assert.fail('a disposed Water is left alone') },
    second = new Flood({ surface: gone, surge: 1, surgeRise: 0 });
  disposers.at(-1)();
  second.advanceTime(1);
  second.dispose();
});

test('attach registers the solver on the Water and dispose takes it away, once', async () => {
  const surface = water(),
    flood = Flood.attach(engine(surface), { surface });
  const solvers = maps.filter((m) => m.has(surface));
  assert.equal(solvers.length, 1, 'one bridge map holds the Water');
  assert.equal(typeof solvers[0].get(surface), 'function');
  assert.throws(() => Flood.attach(engine(surface), { surface }), /already has a flood solver/);
  assert.match(flood.name, /^water:flood-\d+$/);
  flood.dispose();
  flood.dispose();
  assert.equal(solvers[0].has(surface), false);
  assert.throws(() => flood.wall({ from: [0, 0], to: [1, 0], top: 1 }), /disposed/);
  await assert.rejects(flood.read(), /disposed/);
});

// Disaster water push 5: `inflow` is a live multiplier of every source's discharge, a function of the tick like the rest.
test('inflow scales every source from the next tick and is checked', () => {
  const flood = new Flood({ surface: water(), sources: [{ position: [3, 4], discharge: 5, radius: 2 }, { position: [6, 6], discharge: 2 }] });
  const data = new Float32Array(316);
  flood.writeUniform(data, 0);
  assert.equal(data[26], 5, 'default 1 keeps the discharge as given');
  flood.advanceTime(1);
  flood.options.inflow = 3;
  flood.advanceTime(1);
  flood.writeUniform(data, 119);
  assert.equal(data[26], 5, 'the change is not in the past');
  flood.writeUniform(data, 120);
  assert.equal(data[26], 15);
  assert.equal(data[30], 6, 'every source');
  flood.options.inflow = 0;
  flood.advanceTime(0);
  flood.writeUniform(data, 240);
  assert.equal(data[26], 0, '0 shuts the sources');
  assert.throws(() => new Flood({ surface: water(), inflow: -1 }), RangeError);
  assert.throws(() => new Flood({ surface: water(), inflow: 101 }), RangeError);
  flood.options.inflow = 500;
  assert.throws(() => flood.advanceTime(0), RangeError, 'a live value is checked when it is read');
});
