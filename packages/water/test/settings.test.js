// The settings table of @margoengine/water/settings: every row is well formed, every default is what a Water does without
// the option (written changes nothing the GPU receives), ranges are enforced, applying every live row each frame creates
// nothing, null follows the weather, and the named looks are only row values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import {
  WATER_LIVE_SETTINGS,
  WATER_LOOKS,
  WATER_SETTINGS,
  applyWaterSettings,
  waterSettingDefaults,
} from '../dist/settings.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const byName = new Map(WATER_SETTINGS.map((s) => [s.name, s]));
// The uniform a frame writes: 576 B of the Water's values.
// Index 20 is the wave clock, which every frame advances; the rest is what the settings write.
const frameValues = (h) => {
  const v = new Float32Array(h.resources.find((r) => !r.destroyed && r.size === 576).data).slice();
  v[20] = 0;
  return v;
};
const attach = (options = {}) => {
  const h = optionalGPU(),
    water = new Water({ segments: 4, ...options });
  h.engine.use(water);
  h.frame();
  return { h, water };
};

test('every row is well formed, names are unique, every row is live', () => {
  assert.equal(byName.size, WATER_SETTINGS.length);
  assert.equal(WATER_SETTINGS.length, 13);
  assert.deepEqual(WATER_LIVE_SETTINGS, WATER_SETTINGS);
  for (const s of WATER_SETTINGS) {
    assert.ok(typeof s.about === 'string' && s.about.length > 20, s.name);
    assert.equal(typeof s.live, 'boolean', s.name);
    assert.ok(['wind', 'surface', 'look'].includes(s.group), s.name);
    assert.ok(typeof s.unit === 'string', s.name);
    if (s.kind === 'number') {
      assert.ok(s.min < s.max && s.step > 0, s.name);
      if (s.default !== null) assert.ok(s.min <= s.default && s.default <= s.max, s.name);
    } else assert.ok(s.default.every((x) => x >= s.min && x <= s.max), s.name);
  }
});

test('the rows the weather drives are nullable and name the weather slider that drives them', () => {
  for (const name of ['windSpeed', 'windDirection', 'whitecaps', 'chop']) {
    const s = byName.get(name);
    assert.equal(s.nullable, true, name);
    assert.equal(s.default, null, name);
    assert.ok(['wind', 'windDirection'].includes(s.weather), name);
  }
  assert.equal(byName.get('waveHeight').nullable, true);
  assert.equal(byName.get('seaLevel').nullable, true);
  assert.equal(byName.get('seaLevel').default, null);
  for (const name of ['fetch', 'color', 'foamDistance']) assert.equal(byName.get(name).nullable, undefined, name);
});

test('every row default is what a Water does without the option: applying them changes no byte of the frame', () => {
  for (const options of [{}, { wind: { speed: 11, fetch: 4000, direction: [0, 1] } }]) {
    const { h, water } = attach(options),
      before = frameValues(h);
    applyWaterSettings(water, {
      ...(options.wind ? { fetch: 4000 } : {}),
    });
    h.frame();
    assert.deepEqual(frameValues(h), before, JSON.stringify(options));
  }
  // A Water made with its own waves is left alone by the defaults too.
  const { h, water } = attach({ waves: [{ direction: [1, 0.3], amplitude: 0.3, wavelength: 12 }] }),
    before = frameValues(h);
  applyWaterSettings(water);
  h.frame();
  assert.deepEqual(frameValues(h), before);
});

test('each row moves what it names', () => {
  const { h, water } = attach(),
    base = frameValues(h);
  const moved = (values) => {
    applyWaterSettings(water, values);
    h.frame();
    return frameValues(h);
  };
  const differs = (a, b) => a.some((v, i) => v !== b[i]);
  assert.ok(differs(moved({ windSpeed: 20 }), base), 'windSpeed');
  assert.equal(water.wind.speed, 20);
  assert.ok(differs(moved({ windSpeed: 20, windDirection: 90 }), moved({ windSpeed: 20, windDirection: 0 })), 'windDirection');
  assert.ok(differs(moved({ fetch: 2000 }), moved({ fetch: 200000 })), 'fetch');
  const stormy = moved({ windSpeed: 25 });
  assert.equal(stormy[130] > 0, true, 'wind foam');
  assert.equal(moved({ windSpeed: 25, whitecaps: 0 })[130], 0, 'whitecaps 0');
  assert.equal(moved({ windSpeed: 25, whitecaps: 0.4 })[130], Math.fround(0.4), 'whitecaps 0.4');
  assert.equal(moved({ chop: 0.7 })[131], Math.fround(0.7), 'chop');
  const trains = (v) => Math.max(...Array.from({ length: 8 }, (_, i) => v[34 + i * 8]));
  assert.ok(Math.abs(trains(moved({ windSpeed: 6, waveHeight: 0.1 })) - 0.1) < 1e-6, 'waveHeight scales the largest train');
  assert.ok(trains(moved({ windSpeed: 6 })) > 0.1, 'waveHeight null gives the wind amplitudes back');
  assert.deepEqual([...moved({ color: [0.5, 0.25, 0.125] }).slice(24, 27)], [0.5, 0.25, 0.125]);
  assert.equal(moved({ foamDistance: 7 })[22], 7);
  assert.equal(moved({ seaLevel: 2.5 })[21], 2.5, 'seaLevel');
  assert.equal(water.seaLevel, 2.5);
  assert.equal(moved({})[21], 2.5, 'a null seaLevel keeps the level');
});

// Disaster water push 1: the sea level is live, so a surge or a tide is a value per frame, and a Water made with
// `height` keeps it under the default (null) row.
test('the sea level is live: setSeaLevel writes the frame, refuses what is not a level, and defaults keep height', () => {
  const { h, water } = attach({ height: -3 }),
    before = frameValues(h);
  assert.equal(water.seaLevel, -3);
  applyWaterSettings(water);
  h.frame();
  assert.deepEqual(frameValues(h), before, 'the defaults keep a Water made with height');
  water.setSeaLevel(1.25);
  h.frame();
  assert.equal(frameValues(h)[21], 1.25);
  for (const bad of [NaN, Infinity, 1e6, -100001, '1'])
    assert.throws(() => water.setSeaLevel(bad), RangeError, String(bad));
  assert.throws(() => applyWaterSettings(water, { seaLevel: 1001 }), RangeError);
  h.frame();
  assert.equal(frameValues(h)[21], 1.25, 'a refused level writes nothing');
});

test('null follows the weather: a wind set by the drive survives, and a null chop is left alone', () => {
  const { h, water } = attach();
  water.setWind({ speed: 17, direction: [0, 1] }).setChop(0.33);
  applyWaterSettings(water, { windSpeed: null, windDirection: null, chop: null });
  h.frame();
  assert.equal(water.wind.speed, 17);
  assert.deepEqual(water.wind.direction, [0, 1]);
  assert.equal(frameValues(h)[131], Math.fround(0.33));
  assert.equal(frameValues(h)[130] > 0, true, 'null whitecaps lets the wind decide');
  applyWaterSettings(water, { windSpeed: 3 });
  assert.equal(water.wind.speed, 3);
  assert.deepEqual(water.wind.direction, [0, 1], 'a null direction keeps the held one');
});

test('a Water made with waves refuses wind rows, and takes the others', () => {
  const { h, water } = attach({ waves: [{ direction: [1, 0.3], amplitude: 0.3, wavelength: 12 }] });
  for (const values of [{ windSpeed: 5 }, { windDirection: 10 }, { fetch: 500 }])
    assert.throws(() => applyWaterSettings(water, values), TypeError);
  applyWaterSettings(water, { whitecaps: 0.5, chop: 0.2, color: [0.1, 0.1, 0.1], foamDistance: 2, waveHeight: 0.2 });
  h.frame();
  assert.equal(frameValues(h)[34], Math.fround(0.2));
  applyWaterSettings(water, { waveHeight: null });
  h.frame();
  assert.equal(frameValues(h)[34], Math.fround(0.3));
});

test('unknown names and values outside their rows are refused before anything is written', () => {
  const { h, water } = attach(),
    before = frameValues(h);
  assert.throws(() => applyWaterSettings(water, { windspeed: 5 }), TypeError);
  assert.throws(() => applyWaterSettings(water, { windSpeed: 101 }), RangeError);
  assert.throws(() => applyWaterSettings(water, { windSpeed: -1 }), RangeError);
  assert.throws(() => applyWaterSettings(water, { windSpeed: 'a' }), RangeError);
  assert.throws(() => applyWaterSettings(water, { fetch: null }), RangeError);
  assert.throws(() => applyWaterSettings(water, { fetch: 0 }), RangeError);
  assert.throws(() => applyWaterSettings(water, { whitecaps: 1.1 }), RangeError);
  assert.throws(() => applyWaterSettings(water, { chop: -0.1 }), RangeError);
  assert.throws(() => applyWaterSettings(water, { color: [0, 0] }), RangeError);
  assert.throws(() => applyWaterSettings(water, { color: [0, 0, 2] }), RangeError);
  assert.throws(() => applyWaterSettings(water, { foamDistance: 0 }), RangeError);
  assert.throws(() => applyWaterSettings(water, { windSpeed: 12, foamDistance: 101 }), RangeError);
  h.frame();
  assert.deepEqual(frameValues(h), before);
});

test('every named look is only row values, applies without throwing and draws a different sea from the default; natural draws the default', () => {
  const names = Object.keys(WATER_LOOKS);
  assert.ok(names.length >= 10);
  const { h, water } = attach(),
    base = frameValues(h);
  for (const name of names) {
    for (const key of Object.keys(WATER_LOOKS[name])) assert.ok(byName.has(key), `${name}.${key}`);
    applyWaterSettings(water, WATER_LOOKS[name]);
    h.frame();
    if (name === 'natural') assert.deepEqual(frameValues(h), base, name);
    else assert.notDeepEqual(frameValues(h), base, name);
  }
  applyWaterSettings(water, WATER_LOOKS.breeze);
  h.frame();
  const calmer = frameValues(h);
  applyWaterSettings(water, WATER_LOOKS.hurricane);
  h.frame();
  assert.ok(frameValues(h)[34] > calmer[34] || frameValues(h)[130] > calmer[130]);
});

test('applying every live row each frame for 60 frames creates no pipeline, buffer, texture, bind group or view', () => {
  const { h, water } = attach();
  const counted = { pipelines: 0 };
  for (const key of ['createRenderPipeline', 'createComputePipeline']) {
    const make = h.engine.gpu[key];
    if (make) h.engine.gpu[key] = (...a) => (counted.pipelines++, make.apply(h.engine.gpu, a));
  }
  const before = { ...h.counts };
  const draw = (values) => {
    applyWaterSettings(water, values);
    h.frame();
  };
  for (let i = 0; i < 60; i++) {
    const t = i / 59,
      values = {};
    for (const s of WATER_LIVE_SETTINGS) {
      if (s.name === 'windDirection') values[s.name] = t * 360;
      else if (s.kind === 'color') values[s.name] = [t, 1 - t, 0.5];
      else if (s.name === 'waveHeight') values[s.name] = null;
      else if (s.name === 'fetch') values[s.name] = 1000 + t * 1e6;
      else if (s.name === 'windSpeed') values[s.name] = 2 + t * 20;
      else if (s.name === 'foamDistance') values[s.name] = 0.5 + t * 5;
      else if (s.name === 'seaLevel') values[s.name] = -2 + 4 * t;
      else if (s.name === 'glitterRoughness') values[s.name] = 0.02 + 0.5 * t;
      else values[s.name] = t;
    }
    draw(values);
  }
  assert.equal(counted.pipelines, 0);
  for (const key of ['buffers', 'textures', 'groups', 'views']) assert.equal(h.counts[key], before[key], key);
  // The last frame equals writing those values once into a fresh Water.
  const last = frameValues(h);
  const fresh = attach();
  applyWaterSettings(fresh.water, {
    windSpeed: 22,
    windDirection: 360,
    fetch: 1001000,
    whitecaps: 1,
    chop: 1,
    waveHeight: null,
    color: [1, 0, 0.5],
    foamDistance: 5.5,
    seaLevel: 2,
    glitterRoughness: 0.52,
    foamSoftness: 1,
    shallowColor: [1, 0, 0.5],
    shallowDepth: 1,
  });
  fresh.h.frame();
  const once = frameValues(fresh.h);
  for (const i of [21, 22, 24, 25, 26, 34, 130, 131, 134, 135, 136, 137, 138, 139]) assert.equal(once[i], last[i], `value ${i}`);
});

test('waterSettingDefaults is a fresh object of every default', () => {
  const a = waterSettingDefaults(),
    b = waterSettingDefaults();
  assert.deepEqual(Object.keys(a), WATER_SETTINGS.map((s) => s.name));
  assert.notEqual(a, b);
  assert.notEqual(a.color, b.color);
  assert.equal(a.windSpeed, null);
  assert.equal(a.fetch, 100000);
});

test('a sea wind given a value is held from the weather drive; null hands it back', async () => {
  const { heldFromWeather } = await import('../../shared/settings.js');
  const noop = () => undefined,
    water = { wind: { speed: 6 }, setWind: noop, setWhitecaps: noop, setChop: noop, setWaveHeight: noop, setSeaLevel: noop, setColor: noop, setFoamDistance: noop, setGlitterRoughness: noop, setFoamSoftness: noop, setShallow: noop };
  applyWaterSettings(water, { windSpeed: 12 });
  assert.equal(heldFromWeather(water, 'wind'), true);
  applyWaterSettings(water, {});
  assert.equal(heldFromWeather(water, 'wind'), false);
});

// KB-LOOK-WATER-GLITTER1: the glitter roughness floor, the foam softness and the shallow colour band are rows, written
// into the frame uniform (values 135, 134 and 136 to 139) and refused out of range; the animatedFeature look sets them.
test('glitter roughness, foam softness and the shallow band are rows the frame carries, with their ranges', () => {
  const { h, water } = attach();
  const at = () => frameValues(h);
  assert.equal(at()[135], Math.fround(0.12), 'the default glitter floor is the sea floor');
  assert.equal(at()[134], 0);
  assert.equal(at()[139], 0, 'the shallow band is off by default');
  applyWaterSettings(water, { glitterRoughness: 0.3, foamSoftness: 0.5, shallowColor: [0.1, 0.4, 0.5], shallowDepth: 3 });
  h.frame();
  const v = at();
  assert.equal(v[135], Math.fround(0.3));
  assert.equal(v[134], Math.fround(0.5));
  assert.deepEqual([...v.slice(136, 140)], [0.1, 0.4, 0.5, 3].map(Math.fround));
  for (const bad of [{ glitterRoughness: 0.01 }, { glitterRoughness: 0.7 }, { foamSoftness: 1.1 }, { shallowDepth: 101 }, { shallowColor: [2, 0, 0] }])
    assert.throws(() => applyWaterSettings(water, bad), RangeError, JSON.stringify(bad));
  const look = WATER_LOOKS.animatedFeature;
  assert.ok(look.glitterRoughness > 0.12 && look.foamSoftness > 0 && look.shallowDepth > 0, 'the look sets all three');
  applyWaterSettings(water, look);
  h.frame();
  assert.equal(at()[139], look.shallowDepth);
});

test('null rows hand back a wind and a chop the rows set: {} after a look draws the Water as it was made', () => {
  // Regression: a null chop kept the look's chop and a null wind the look's wind, so `natural` after `animatedFeature`
  // left the sea choppy (KB-SCENES-LOOKFAMILY-PARTS1).
  for (const options of [{}, { wind: { speed: 9, direction: [0, 1] }, chop: 0.3 }]) {
    const fresh = attach(options),
      used = attach(options);
    applyWaterSettings(used.water, { ...WATER_LOOKS.animatedFeature, windSpeed: 14, windDirection: 120 });
    used.h.frame();
    assert.notDeepEqual(frameValues(used.h), frameValues(fresh.h));
    applyWaterSettings(used.water, {});
    used.h.frame();
    fresh.h.frame();
    assert.deepEqual(frameValues(used.h), frameValues(fresh.h), JSON.stringify(options));
    assert.deepEqual(used.water.wind.speed, fresh.water.wind.speed);
  }
});
