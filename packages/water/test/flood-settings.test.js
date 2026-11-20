// The Flood rows of @margoengine/water/settings (disaster water push 5): every row is well formed, the defaults are what a
// Flood does without the option (the uniform of every tick is byte-identical), each row moves what it names, null
// follows the weather and a number holds it against the drive, the looks are only row values, and a bad value is refused
// before anything is written. No GPU: the uniform is what the solver reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Flood, waveMakerSignal } from '../dist/flood.js';
import { FLOOD_LIVE_SETTINGS, FLOOD_LOOKS, FLOOD_SETTINGS, applyFloodSettings, floodSettingDefaults } from '../dist/settings.js';
import { heldFromWeather } from '../../shared/settings.js';

// A Water stand-in with one swell train in its uniform (direction, amplitude 0.5 m, wavenumber, steepness, frequency, phase, fade).
const water = () => {
  const values = new Float32Array(140);
  values[23] = 1;
  values.set([1, 0, 0.5, 0.05, 0.5, 0.7, 0, 1], 32);
  return { name: 'water-0', setWaveHeight() {}, values, options: { terrain: { heightmap: () => undefined, origin: [0, 0], size: [10, 10] } } };
};
const make = (extra = {}) => {
  const flood = new Flood({ surface: water(), boundary: { west: 'sea' }, sources: [{ position: [3, 4], discharge: 5 }], ...extra });
  flood.waveMaker({ position: [5, 5], direction: [1, 0], amplitude: 1, period: 10, at: 0, ramp: 0 });
  return flood;
};
// Floats of the uniform: the swell head, the first train's amplitude, the first maker's signal.
const SWELL = 216,
  TRAIN_AMPLITUDE = SWELL + 4 + 2,
  MAKER_SIGNAL = SWELL + 4 + 64 + 4;
const tick = (flood, k = 1000) => {
  flood.advanceTime(0);
  const data = new Float32Array(316);
  flood.writeUniform(data, k);
  return Array.from(data);
};
const byName = new Map(FLOOD_SETTINGS.map((s) => [s.name, s]));

test('every flood row is well formed, unique and live', () => {
  assert.equal(byName.size, FLOOD_SETTINGS.length);
  assert.equal(FLOOD_SETTINGS.length, 9);
  assert.deepEqual(FLOOD_LIVE_SETTINGS, FLOOD_SETTINGS);
  for (const s of FLOOD_SETTINGS) {
    assert.ok(s.about.length > 30, s.name);
    assert.ok(['sea', 'flow'].includes(s.group) && s.kind === 'number' && s.live === true, s.name);
    assert.ok(s.min < s.max && s.step > 0, s.name);
    if (s.default !== null) assert.ok(s.min <= s.default && s.default <= s.max, s.name);
  }
  assert.deepEqual(
    FLOOD_SETTINGS.filter((s) => s.nullable).map((s) => [s.name, s.default, s.weather]),
    [
      ['surge', null, undefined],
      ['rain', null, 'storm'],
    ],
  );
  assert.deepEqual(floodSettingDefaults(), { surge: null, surgeRise: 600, shelfLength: 50000, shelfDepth: 20, swell: 1, waveMaker: 1, rain: null, roughness: 0.03, inflow: 1 });
});

test('the defaults are what a Flood does without the options: every tick of the uniform is unchanged', () => {
  const plain = make(),
    set = make({ roughness: 0.2, inflow: 4, rain: 50, surge: 3, surgeRise: 5, shelf: { length: 10, depth: 1 } }),
    easy = make({ roughness: 0.2, inflow: 4, rain: 50 });
  for (const f of [plain, set, easy]) f.setWind({ speed: 30, direction: [1, 0] });
  applyFloodSettings(set);
  applyFloodSettings(easy);
  for (const k of [0, 1, 600, 5000]) assert.deepEqual(tick(easy, k), tick(plain, k), 'tick ' + k);
  // A surge that was set eases back to the wind set-up over the default 600 s, and is the same after it.
  assert.notDeepEqual(tick(set, 0), tick(plain, 0), 'the old surge is still there at the start of the ease');
  assert.deepEqual(tick(set, 80000), tick(plain, 80000), 'and gone after it');
  assert.equal(heldFromWeather(set, 'rain'), false);
});

test('each row moves what it names', () => {
  const flood = make();
  const moved = (values) => (applyFloodSettings(flood, values), tick(flood));
  assert.equal(moved({ roughness: 0.07 })[8], Math.fround(0.07), 'roughness');
  assert.equal(moved({ inflow: 2 })[26], 10, 'inflow');
  assert.equal(moved({ rain: 36 })[22], Math.fround(36 / 3.6e6), 'rain');
  assert.equal(moved({ surge: 2, surgeRise: 0 })[16], 2, 'surge, as a step');
  assert.equal(moved({ swell: 2 })[TRAIN_AMPLITUDE], 1, 'swell doubles the train let in');
  assert.equal(moved({ swell: 0 })[SWELL + 1], 0, 'swell 0 lets no train in');
  const signal = Math.sin((2 * Math.PI * 1000.5) / 120 / 10);
  assert.equal(moved({ swell: 1, waveMaker: 2 })[MAKER_SIGNAL], Math.fround(2 * signal), 'waveMaker doubles the signal');
  flood.setWind({ speed: 30, direction: [1, 0] });
  const windSet = moved({ surge: null, shelfLength: 50000, shelfDepth: 20, surgeRise: 0 })[16];
  assert.ok(windSet > 0.5 && windSet < 1.5, 'a null surge is the wind set-up: ' + windSet);
  assert.ok(moved({ surge: null, shelfLength: 100000, shelfDepth: 20, surgeRise: 0 })[16] > windSet * 1.99, 'shelfLength doubles it');
  assert.ok(moved({ surge: null, shelfLength: 50000, shelfDepth: 10, surgeRise: 0 })[16] > windSet * 1.99, 'a shallower shelf raises it');
  flood.advanceTime(10);
  applyFloodSettings(flood, { surge: 4, surgeRise: 100 });
  flood.advanceTime(50);
  const data = new Float32Array(316);
  flood.writeUniform(data, 60 * 120);
  assert.ok(data[16] > 0 && data[16] < 4, 'surgeRise eases in, got ' + data[16]);
});

test('a null rain follows the weather drive, a number holds it against the drive', () => {
  const flood = make();
  flood.setRainRate(20);
  applyFloodSettings(flood, { rain: null });
  assert.equal(tick(flood)[22], Math.fround(20 / 3.6e6), 'the drive sets the rain');
  assert.equal(heldFromWeather(flood, 'rain'), false);
  applyFloodSettings(flood, { rain: 5 });
  flood.setRainRate(40);
  assert.equal(tick(flood)[22], Math.fround(5 / 3.6e6), 'a set rain wins');
  assert.equal(heldFromWeather(flood, 'rain'), true);
  applyFloodSettings(flood, {});
  assert.equal(heldFromWeather(flood, 'rain'), false);
  assert.equal(tick(flood)[22], Math.fround(40 / 3.6e6), 'handed back');
});

test('every look is only row values and changes the flood from its default', () => {
  const names = Object.keys(FLOOD_LOOKS);
  assert.deepEqual([...names].sort(), ['flashFlood', 'muddy', 'stormSurge']);
  const flood = make(),
    base = tick(flood);
  for (const name of names) {
    for (const key of Object.keys(FLOOD_LOOKS[name])) assert.ok(byName.has(key), `${name}.${key}`);
    applyFloodSettings(flood, FLOOD_LOOKS[name]);
    assert.notDeepEqual(tick(flood), base, name);
  }
});

test('unknown names and values outside their rows are refused before anything is written', () => {
  const flood = make();
  applyFloodSettings(flood, { roughness: 0.05 });
  const before = tick(flood);
  assert.throws(() => applyFloodSettings(flood, { roughnes: 0.1 }), TypeError);
  assert.throws(() => applyFloodSettings(flood, { roughness: 0.3, inflow: 3 }), RangeError);
  assert.throws(() => applyFloodSettings(flood, { inflow: -1 }), RangeError);
  assert.throws(() => applyFloodSettings(flood, { rain: 2001 }), RangeError);
  assert.throws(() => applyFloodSettings(flood, { surge: 51 }), RangeError);
  assert.throws(() => applyFloodSettings(flood, { shelfDepth: 0 }), RangeError);
  assert.throws(() => applyFloodSettings(flood, { surgeRise: null }), RangeError);
  assert.throws(() => applyFloodSettings(flood, { swell: 11 }), RangeError);
  assert.throws(() => applyFloodSettings(flood, { waveMaker: -0.1 }), RangeError);
  assert.deepEqual(tick(flood), before);
});

test('a wave maker eases in and out over its ramp and is refused when malformed', () => {
  const m = { amplitude: 2, period: 8, phase: 0, at: 10, duration: 40, ramp: 16 };
  assert.equal(waveMakerSignal(9.9, m), 0, 'nothing before it starts');
  assert.ok(Math.abs(waveMakerSignal(12, m)) < 2 * 0.1, 'small at the start of the ramp');
  assert.ok(Math.abs(waveMakerSignal(28, m) - 2) < 1e-12, 'the full amplitude after the ramp (a crest at a quarter period)');
  assert.ok(Math.abs(waveMakerSignal(48, m) + 2 * 0.04296875) < 1e-12, 'easing out over the last ramp (a trough, 2 s before the end)');
  assert.equal(waveMakerSignal(50, m), 0, 'nothing after its duration');
  assert.ok(Math.abs(waveMakerSignal(8012, { ...m, duration: null }) - 2) < 1e-9, 'a null duration runs on');
  const flood = make();
  assert.throws(() => flood.waveMaker({ position: [0, 0], direction: [0, 0] }), RangeError);
  assert.throws(() => flood.waveMaker({ position: [0, 0], direction: [1, 0], period: 0.1 }), RangeError);
  assert.throws(() => flood.waveMaker({ position: [0, 0], direction: [1, 0], amplitude: 51 }), RangeError);
  assert.throws(() => flood.waveMaker({ position: [0], direction: [1, 0] }), TypeError);
  for (let i = 1; i < 4; i++) flood.waveMaker({ position: [0, 0], direction: [0, 1] });
  assert.throws(() => flood.waveMaker({ position: [0, 0], direction: [1, 0] }), RangeError, 'at most 4');
  flood.setWaveMakers([]);
  assert.equal(tick(flood)[SWELL + 2], 0, 'setWaveMakers replaces them');
});
