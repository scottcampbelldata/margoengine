// The master weather panel: rows, ranges, the storm level, visibility and rain rate as state, the named looks, and the
// vane test of R1: with every package's value at its default (null, follow the weather), moving the one wind slider
// moves the sea, grass, scatter, rain, smoke, fire and fog together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherDrive } from '../dist/drive.js';
import {
  WEATHER_LIVE_SETTINGS,
  WEATHER_LOOKS,
  WEATHER_SETTINGS,
  applyWeatherSettings,
  weatherSettingDefaults,
  weatherStateOf,
} from '../dist/settings.js';
import {
  WEATHER_PRESETS,
  WeatherMachine,
  beaufort,
  fogForVisibility,
  rainRate,
  visibility,
  windBend,
} from '../dist/index.js';
import { VFX } from '../../vfx/dist/index.js';
import { Water } from '../../water/dist/index.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
const heading = (x, z) => Math.atan2(x, z),
  off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * (180 / Math.PI);

test('every row is a live number; every row but storm and windDirection follows the storm level at null', () => {
  assert.equal(WEATHER_SETTINGS.length, 17);
  assert.deepEqual(WEATHER_LIVE_SETTINGS, WEATHER_SETTINGS);
  for (const row of WEATHER_SETTINGS) {
    assert.equal(row.kind, 'number');
    assert.equal(row.live, true, row.name);
    assert.ok(row.about.length > 20 && row.unit !== undefined && row.max > row.min && row.step > 0, row.name);
    if (row.name === 'storm' || row.name === 'windDirection')
      assert.ok(!row.nullable && typeof row.default === 'number');
    else assert.ok(row.nullable && row.default === null && row.weather === 'storm', row.name);
  }
  assert.match(WEATHER_SETTINGS.find((r) => r.name === 'wind').about, /Beaufort/);
});

test('the defaults are the clear preset, and the storm level walks clear, rain, storm', () => {
  assert.deepEqual(weatherStateOf(), { ...WEATHER_PRESETS.clear });
  assert.deepEqual(weatherStateOf(weatherSettingDefaults()), { ...WEATHER_PRESETS.clear });
  assert.deepEqual(weatherStateOf({ storm: 0.5 }), { ...WEATHER_PRESETS.rain });
  assert.deepEqual(weatherStateOf({ storm: 1 }), { ...WEATHER_PRESETS.storm });
  const quarter = weatherStateOf({ storm: 0.25 });
  near(quarter.wind, (WEATHER_PRESETS.clear.wind + WEATHER_PRESETS.rain.wind) / 2);
  near(quarter.rain, WEATHER_PRESETS.rain.rain / 2);
});

test("a value replaces the storm level's number; null follows it again", () => {
  const s = weatherStateOf({ storm: 1, wind: 3, cloud: null, windDirection: 90 });
  assert.equal(s.wind, 3);
  assert.equal(s.cloud, WEATHER_PRESETS.storm.cloud);
  assert.equal(s.rain, WEATHER_PRESETS.storm.rain);
  near(s.windDirection, Math.PI / 2);
  near(weatherStateOf({ windDirection: 270 }).windDirection, -Math.PI / 2);
});

test('unknown names throw TypeError, out of range or wrong kind RangeError, null only where nullable', () => {
  assert.throws(() => weatherStateOf({ windspeed: 5 }), TypeError);
  for (const bad of [
    { wind: -1 },
    { wind: 61 },
    { storm: 1.1 },
    { storm: null },
    { windDirection: null },
    { visibility: 100 },
    { rainRate: 81 },
    { gust: NaN },
    { fog: '0.5' },
  ])
    assert.throws(() => weatherStateOf(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => applyWeatherSettings({ set() {} }, { windDirection: 361 }), RangeError);
});

test("a rain rate in mm/h is the state's rain, and the visibility asked is the one left", () => {
  for (const r of [0, 0.64, 17, 50, 80]) near(rainRate(weatherStateOf({ rainRate: r })), r, 1e-9);
  for (const v of [200, 500, 1000, 5000, 20000]) {
    const s = weatherStateOf({ visibility: v });
    assert.ok(Math.abs(visibility(s) / v - 1) < 1e-6, `${v} gives ${visibility(s)}`);
  }
  // With rain falling the fog is solved around it, and a visibility the rain alone beats cannot be raised (fog 0).
  const wet = weatherStateOf({ rainRate: 5, visibility: 2000 });
  assert.ok(Math.abs(visibility(wet) / 2000 - 1) < 1e-6);
  const downpour = weatherStateOf({ rainRate: 80, visibility: 20000 });
  assert.equal(downpour.fog, 0);
  assert.ok(visibility(downpour) < 1000);
  assert.ok(weatherStateOf({ visibility: 200 }).fog > 0.99, 'about 196 m is the thickest fog');
  assert.ok(weatherStateOf({ visibility: 200, fog: 0 }).fog > 0.99, 'visibility wins over fog');
  assert.equal(fogForVisibility(23000, { rain: 0, snow: 0 }), 0);
  assert.throws(() => fogForVisibility(0, { rain: 0, snow: 0 }), RangeError);
});

test('the named looks are values of the rows and mean what they say', () => {
  const names = Object.keys(WEATHER_LOOKS);
  assert.deepEqual(names, [
    'natural',
    'calm',
    'breeze',
    'gale',
    'storm',
    'hurricane',
    'fog',
    'drizzle',
    'downpour',
    'dustHaze',
    'sandstorm',
    'haboob',
    'smokeHaze',
    'wildfireSmoke',
    'blackDay',
    'ashfall',
    'ashDarkness',
    'seaSpray',
    'surfHaze',
    'blizzard',
    'redFlag',
    'animatedFeature',
  ]);
  const state = Object.fromEntries(names.map((n) => [n, weatherStateOf(WEATHER_LOOKS[n])]));
  assert.equal(beaufort(state.calm.wind), 0);
  assert.equal(beaufort(state.breeze.wind), 3);
  assert.equal(beaufort(state.gale.wind), 8);
  assert.equal(state.gale.rain, 0);
  assert.equal(beaufort(state.hurricane.wind), 12);
  assert.deepEqual(state.storm, { ...WEATHER_PRESETS.storm });
  assert.ok(visibility(state.fog) < 400 && state.fog.rain === 0);
  near(rainRate(state.drizzle), 0.64, 1e-9);
  near(rainRate(state.downpour), 50, 1e-9);
  assert.ok(state.blizzard.snow === 1 && state.blizzard.rain === 0 && state.blizzard.wind === 25);
});

test('applyWeatherSettings writes the machine at once and returns the state', () => {
  const machine = new WeatherMachine('clear');
  machine.transitionTo('storm', { seconds: 100 });
  const state = applyWeatherSettings(machine, WEATHER_LOOKS.gale);
  assert.deepEqual(machine.state, state);
  assert.equal(machine.transitioning, false);
  assert.deepEqual(applyWeatherSettings(machine, {}), { ...WEATHER_PRESETS.clear });
});

test('vane: with every package at its default, one wind slider moves sea, grass, scatter, rain, smoke, fire and fog', () => {
  const machine = new WeatherMachine('clear', { seed: 3 }),
    sea = new Water({ wind: 3 }),
    smoke = new VFX({ capacity: 8, velocity: [0, 3, 0] }),
    fire = new VFX({ capacity: 8, velocity: [0, 5, 0] }),
    scatter = { name: 'scatter:1', options: {} },
    grass = { name: 'grass-field:1', windDirection: [1, 0.35], windStrength: 0.45, windSpeed: 1.2 },
    rain = { name: 'weather', options: { intensity: 0 } },
    volume = { name: 'volumetric-fog', options: { density: 0.0002 } },
    engine = { plugins: new Map(), use: () => {}, removePlugin: () => {} };
  for (const [name, plugin] of [
    [sea.name, sea],
    [smoke.name, smoke],
    [fire.name, fire],
    ['scatter:1', scatter],
    ['grass-field:1', grass],
    ['weather', rain],
    ['volumetric-fog', volume],
  ])
    engine.plugins.set(name, plugin);
  const drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  const seen = [];
  for (const [speed, azimuth] of [
    [3, 70],
    [10, 70],
    [20, 70],
    [10, 250],
  ]) {
    applyWeatherSettings(machine, {
      storm: 0.5,
      rainRate: 20,
      wind: speed,
      windDirection: azimuth,
      gust: 0,
      visibility: 4000 - speed * 100,
    });
    for (let i = 0; i < 4; i++) drive.update(0.5);
    const w = machine.wind.sample(0, 0, 0, machine.time),
      toward = heading(w[0], w[2]),
      mean = (azimuth * Math.PI) / 180;
    assert.ok(off(toward, mean) < 30, `the field blows toward ${azimuth}: ${(toward * 180) / Math.PI}`);
    // Every package follows the field's one vector (within 5 degrees); the sea runs with the state's mean wind.
    const dirs = {
      scatter: heading(scatter.options.wind[0], scatter.options.wind[1]),
      grass: heading(grass.windDirection[0], grass.windDirection[1]),
      smoke: heading(...smoke.options.wind),
      fire: heading(...fire.options.wind),
      rain: heading(...rain.options.wind),
    };
    for (const [name, d] of Object.entries(dirs))
      assert.ok(off(d, toward) < 5, `${name} follows the wind at ${speed} m/s`);
    assert.ok(
      off(heading(sea.windSea.direction[0], sea.windSea.direction[1]), mean) < 5,
      'the sea runs with the mean wind',
    );
    near(sea.windSea.speed, speed, 1e-6);
    near(Math.hypot(...smoke.options.wind), Math.hypot(w[0], w[2]));
    near(scatter.options.wind[2], windBend(Math.hypot(w[0], w[2])));
    assert.equal(rain.options.precipitation, 'rain');
    assert.ok(Math.abs(rain.options.rainRate - 20) < 0.1);
    seen.push({
      speed,
      swell: Math.max(...Array.from({ length: sea.values[23] }, (_, i) => sea.values[34 + i * 8])),
      bend: scatter.options.wind[2],
      fog: volume.options.density,
    });
  }
  // A stronger wind raises the sea and bends harder.
  assert.ok(seen[0].swell < seen[1].swell && seen[1].swell < seen[2].swell, JSON.stringify(seen));
  assert.ok(seen[0].bend < seen[1].bend && seen[1].bend < seen[2].bend);
  // A shorter visibility thickens the fog volume.
  applyWeatherSettings(machine, { visibility: 5000 });
  drive.update(0);
  const thin = volume.options.density;
  applyWeatherSettings(machine, { visibility: 300 });
  drive.update(0);
  assert.ok(volume.options.density > 5 * thin, `fog ${thin} to ${volume.options.density}`);
});

test('a Water with no options, whose sea is the default wind, is driven too', () => {
  const machine = new WeatherMachine('storm'),
    plain = new Water(),
    engine = { plugins: new Map([[plain.name, plain]]), use() {}, removePlugin() {} };
  const drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  drive.update(0);
  applyWeatherSettings(machine, { storm: 1, wind: 25 });
  drive.update(0);
  near(plain.windSea.speed, 25);
});
test('a sea built with its own waves is left alone by the drive, and one with a wind is set only when the wind changes', () => {
  const machine = new WeatherMachine('storm'),
    fixed = new Water({ waves: [{ direction: [1, 0], amplitude: 0.5, wavelength: 20 }] }),
    windy = new Water({ wind: 1 }),
    engine = {
      plugins: new Map([
        [fixed.name, fixed],
        [windy.name, windy],
      ]),
      use() {},
      removePlugin() {},
    };
  let calls = 0;
  const real = windy.setWind.bind(windy);
  windy.setWind = (wind) => (calls++, real(wind));
  const drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  for (let i = 0; i < 5; i++) drive.update(0);
  assert.equal(fixed.windSea, undefined);
  assert.equal(calls, 1, 'one setWind for an unchanged wind');
  applyWeatherSettings(machine, { storm: 1, wind: 25 });
  drive.update(0);
  assert.equal(calls, 2);
  near(windy.windSea.speed, 25);
});

test('a wind given to a particle effect (its settings rows, or a Fire) overrides the weather; null gives it back', async () => {
  const { applyVfxSettings } = await import('../../vfx/dist/settings.js');
  const machine = new WeatherMachine('storm', { seed: 7 }),
    effect = new VFX({ capacity: 8 }),
    engine = { plugins: new Map([[effect.name, effect]]), use() {}, removePlugin() {} },
    drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  drive.update(0.5);
  const field = machine.wind.sample(0, 0, 0, machine.time);
  assert.ok(Math.abs(effect.options.wind[0] - field[0]) < 1e-9, 'unset follows the weather');
  applyVfxSettings(effect, { 'wind.x': 7, 'wind.z': -1 });
  drive.update(0.5);
  assert.deepEqual(effect.options.wind, [7, -1], 'a value overrides the weather');
  applyVfxSettings(effect, { 'wind.x': null, 'wind.z': null });
  drive.update(0.5);
  const again = machine.wind.sample(0, 0, 0, machine.time);
  assert.ok(
    Math.abs(effect.options.wind[0] - again[0]) < 1e-9 && effect.options.wind[0] !== 7,
    'null follows the weather again',
  );
  const given = new VFX({ capacity: 8, wind: [3, 3] });
  engine.plugins.set(given.name, given);
  drive.update(0.5);
  assert.deepEqual(given.options.wind, [3, 3], 'a wind passed at construction overrides it too');
});
