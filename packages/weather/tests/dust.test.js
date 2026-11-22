// Dust: the visibility it leaves against the published PM10 to visibility relations, the colour, the saltation threshold
// that raises it, the state field, the master row and looks, and the drive that writes the wind and the extinction into a
// BlownSand and tints the sky fog. Every bound is checked against the numbers of the cited papers (see air.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DUST_AT_FULL,
  DUST_FROM_SAND_MAX,
  DUST_PM10_AT_1KM,
  DUST_PM10_EXPONENT,
  STATE_FIELDS,
  WEATHER_PRESETS,
  WeatherMachine,
  airExtinction,
  dustColor,
  dustConcentration,
  dustExtinction,
  dustFromWind,
  dustVisibility,
  fogDensity,
  fogForVisibility,
  resolveState,
  visibility,
} from '../dist/index.js';
import { WeatherDrive, driveSettings } from '../dist/drive.js';
import { WEATHER_LOOKS, WEATHER_SETTINGS, applyWeatherSettings, weatherStateOf } from '../dist/settings.js';
import { BlownSand } from '../../vfx/dist/blown-sand.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * (180 / Math.PI);
// The relations Camino et al. 2015 tabulate (Table 1): Jugder et al. 2014 and D'Almeida 1986, V in km.
const jugder = (v) => 485.67 * v ** -0.776;
const dalmeida = (v) => 914.0 * v ** -0.73 + 19.03;

test('the visibility dust leaves is the Jugder et al. relation inverted, within the spread of the published relations', () => {
  assert.equal(DUST_PM10_AT_1KM, 485.67);
  assert.equal(DUST_PM10_EXPONENT, 0.776);
  for (const km of [0.1, 0.2, 0.5, 1, 2, 5, 10]) near(dustVisibility(jugder(km)) / 1000, km, 1e-9 * km);
  // The published relations disagree by up to a factor of 2.5 from 0.2 to 10 km; the model is one of them, so it sits inside.
  for (const km of [0.2, 0.5, 1, 2, 5, 10]) {
    const ratio = dalmeida(km) / jugder(km);
    assert.ok(ratio > 1 / 2.5 && ratio < 2.5, `${km} km: D'Almeida over Jugder ${ratio}`);
  }
  assert.equal(dustVisibility(0), Infinity);
  assert.throws(() => dustVisibility(-1), RangeError);
  assert.throws(() => dustVisibility(NaN), RangeError);
  // The state: dust 0.2, 0.5 and 0.9 leave about 6 km, 570 m and 130 m of dust alone, and the clear air shortens each a little.
  for (const [dust, metres] of [
    [0.2, 6056],
    [0.5, 565],
    [0.9, 126],
  ]) {
    const alone = dustVisibility(dustConcentration(dust));
    assert.ok(rel(alone, metres) < 0.02, `dust ${dust}: ${alone} m`);
    const total = visibility({ fog: 0, rain: 0, snow: 0, dust });
    near(1 / total, 1 / alone + 1 / 23000, 1e-9);
  }
  near(dustConcentration(1), DUST_AT_FULL);
});

test('dust 0 changes nothing: the air, the fog density and the drive settings are the dustless values bit for bit', () => {
  for (const name of Object.keys(WEATHER_PRESETS)) {
    const state = WEATHER_PRESETS[name],
      { dust, ...dustless } = state;
    assert.equal(dust, 0);
    assert.equal(airExtinction(state), airExtinction(dustless), name);
    assert.equal(visibility(state), visibility(dustless), name);
    const thickness = Math.min(1, state.fog + 0.15 * Math.max(state.rain, state.snow, state.hail));
    assert.equal(fogDensity(state), 0.0002 * (0.02 / 0.0002) ** thickness, name);
    assert.equal(fogForVisibility(3000, state), fogForVisibility(3000, dustless), name);
  }
  assert.equal(dustExtinction(0), 0);
  assert.deepEqual(weatherStateOf(), { ...WEATHER_PRESETS.clear });
});

test('the extinction follows Koschmieder over the relation and thins to nothing with no step below its 10 km limit', () => {
  const edge = Math.sqrt(dustConcentrationAt10km() / DUST_AT_FULL);
  function dustConcentrationAt10km() {
    return jugder(10);
  }
  near(dustExtinction(edge + 1e-9), dustExtinction(edge - 1e-9), 1e-9);
  near(dustExtinction(edge), 3.912 / 10000, 1e-7);
  near(dustExtinction(0.5), 3.912 / dustVisibility(750), 1e-12);
  let last = 0;
  for (let d = 0; d <= 1; d += 0.01) {
    const e = dustExtinction(d);
    assert.ok(e >= last, `monotone at ${d}`);
    last = e;
  }
  near(dustExtinction(1), 3.912 / dustVisibility(3000), 1e-12);
  assert.ok(dustVisibility(3000) > 90 && dustVisibility(3000) < 100, String(dustVisibility(3000)));
});

test('the dust colour is a yellow-brown from the single-scattering albedos of desert dust', () => {
  const [r, g, b] = dustColor();
  // (1 - s) / (1 + s), s = sqrt((1 - w) / (1 - 0.75 w)) at w = 0.96, 0.94, 0.92.
  near(r, 0.4512, 2e-3);
  near(g, 0.379, 2e-3);
  near(b, 0.3257, 2e-3);
  assert.ok(r > g && g > b && b > 0);
});

test('wind over sand raises dust by the saltation flux: none at the threshold, the cap far above it', () => {
  assert.equal(dustFromWind(0), 0);
  assert.equal(dustFromWind(6.6), 0);
  assert.equal(dustFromWind(3), 0);
  let last = 0;
  for (let u = 6.6; u <= 60; u += 0.5) {
    const d = dustFromWind(u);
    assert.ok(d >= last && d <= DUST_FROM_SAND_MAX, `${u}`);
    last = d;
  }
  // Owen's flux 1 - exp(-1.5 (r^3 - r) / 6) at 12 m/s over 6.6.
  const r = 12 / 6.6;
  near(dustFromWind(12), 0.5 * (1 - Math.exp((-1.5 * (r ** 3 - r)) / 6)), 1e-12);
  assert.ok(dustFromWind(18) > 0.45);
  near(dustFromWind(10, 10), 0);
  assert.ok(dustFromWind(12, 10) > 0 && dustFromWind(12, 10) < dustFromWind(12));
  assert.throws(() => dustFromWind(-1), RangeError);
  assert.throws(() => dustFromWind(5, 0), RangeError);
});

test('the state holds dust 0 to 1, the master row follows the storm level, and the looks leave the visibility they name', () => {
  assert.deepEqual(STATE_FIELDS.dust, [0, 1]);
  assert.throws(() => resolveState({ dust: 2 }), RangeError);
  assert.equal(resolveState({ dust: 0.4 }).dust, 0.4);
  const row = WEATHER_SETTINGS.find((r) => r.name === 'dust');
  assert.ok(row.nullable && row.default === null && row.weather === 'storm' && row.live === true && row.max === 1);
  assert.equal(weatherStateOf({ storm: 1 }).dust, 0);
  assert.equal(weatherStateOf({ dust: 0.3 }).dust, 0.3);
  const haze = weatherStateOf(WEATHER_LOOKS.dustHaze),
    sand = weatherStateOf(WEATHER_LOOKS.sandstorm),
    haboob = weatherStateOf(WEATHER_LOOKS.haboob);
  assert.ok(visibility(haze) > 3500 && visibility(haze) < 8000, String(visibility(haze)));
  assert.ok(visibility(sand) > 400 && visibility(sand) < 700, String(visibility(sand)));
  assert.ok(visibility(haboob) > 90 && visibility(haboob) < 170, String(visibility(haboob)));
  assert.ok(haboob.rain === 0 && haboob.wind === 25 && sand.wind === 18);
  // A visibility asked for with dust in the air sets the fog that leaves it.
  const v = weatherStateOf({ dust: 0.5, visibility: 300 });
  near(visibility(v), 300, 0.5);
  // Sun and fog remain: the dust adds to the fog's own extinction.
  assert.ok(dustExtinction(0.5) < driveSettings(sand).extinction);
});

test('with every package at null the drive writes the weather into a BlownSand: its wind within 5 degrees, the air as its fog', () => {
  const machine = new WeatherMachine('clear', { seed: 4 }),
    sand = new BlownSand({ ground: () => 0, wind: { speed: 0 } }),
    engine = { plugins: new Map([[sand.name, sand]]), use: () => {}, removePlugin: () => {} },
    drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  for (const [speed, azimuth] of [
    [4, 20],
    [12, 100],
    [25, 250],
    [9, 310],
  ]) {
    applyWeatherSettings(machine, { wind: speed, windDirection: azimuth, gust: 0.4 });
    drive.update(0.5);
    const w = sand.options.wind;
    near(w.speed, speed, 1e-9);
    assert.ok(off(w.direction, (azimuth * Math.PI) / 180) < 5, `azimuth ${azimuth}: ${w.direction}`);
    near(w.gust, 0.4, 1e-9);
    near(sand.options.fog, Math.min(1, drive.settings.extinction), 1e-12);
  }
  // The same object each frame (no allocation), and the sand reads it.
  const was = sand.options.wind;
  drive.update(0.5);
  assert.equal(sand.options.wind, was);
  // The wind of a person's (a speed above 0) wins, and so does a fog density.
  const own = new BlownSand({ ground: () => 0, wind: { speed: 5, direction: 1 }, fog: 0.002 });
  const engine2 = { plugins: new Map([[own.name, own]]), use: () => {}, removePlugin: () => {} },
    drive2 = WeatherDrive.attach(engine2, { weather: machine });
  drive2.setup(engine2);
  drive2.update(0.5);
  assert.deepEqual(own.options.wind, { speed: 5, direction: 1 });
  assert.equal(own.options.fog, 0.002);
});

test('wind over the sand raises the dust and the sky fog turns dust coloured; no sand, no dust; the colour returns', () => {
  const sky = { name: 'sky', options: { fog: { density: 0.01, falloff: 'exp' } } },
    sand = new BlownSand({ ground: () => 0, wind: { speed: 0 } }),
    machine = new WeatherMachine('clear', { seed: 5 });
  const withSand = {
      plugins: new Map([
        ['sky', sky],
        [sand.name, sand],
      ]),
      use: () => {},
      removePlugin: () => {},
    },
    drive = WeatherDrive.attach(withSand, { weather: machine });
  drive.setup(withSand);
  applyWeatherSettings(machine, { wind: 3 });
  drive.update(0.5);
  assert.equal(drive.settings.dust, 0);
  assert.equal(sky.options.fog.color, undefined);
  applyWeatherSettings(machine, { wind: 18 });
  drive.update(0.5);
  near(drive.settings.dust, dustFromWind(18), 1e-12);
  assert.ok(drive.settings.dust > 0.4);
  assert.ok(drive.settings.extinction > dustExtinction(drive.settings.dust));
  assert.deepEqual(sky.options.fog.color, dustColor());
  near(sky.options.fog.density, Math.min(1, drive.settings.extinction), 1e-12);
  // Dust the state holds itself is not lowered by a calm.
  applyWeatherSettings(machine, { wind: 3, dust: 0.6 });
  drive.update(0.5);
  assert.equal(drive.settings.dust, 0.6);
  assert.deepEqual(sky.options.fog.color, dustColor());
  // Back to calm: the fog has the colour it had (none).
  applyWeatherSettings(machine, { wind: 3 });
  drive.update(0.5);
  assert.equal(sky.options.fog.color, undefined);
  // A colour a person gave the fog comes back too, and dustLight scales the tint.
  sky.options.fog.color = [0.2, 0.3, 0.4];
  const lit = WeatherDrive.attach(withSand, { weather: machine, dustLight: 0.5, advance: false });
  lit.setup(withSand);
  applyWeatherSettings(machine, { wind: 3, dust: 0.8 });
  lit.update(0);
  near(sky.options.fog.color[0], dustColor()[0] * 0.5, 1e-12);
  applyWeatherSettings(machine, { wind: 3 });
  lit.update(0);
  assert.deepEqual(sky.options.fog.color, [0.2, 0.3, 0.4]);
  // Without a sand layer nothing is raised, and dustFromSand false turns it off.
  const bare = { plugins: new Map([['sky', sky]]), use: () => {}, removePlugin: () => {} },
    d3 = WeatherDrive.attach(bare, { weather: machine });
  d3.setup(bare);
  applyWeatherSettings(machine, { wind: 25 });
  d3.update(0);
  assert.equal(d3.settings.dust, 0);
  const off2 = WeatherDrive.attach(withSand, { weather: machine, dustFromSand: false });
  off2.setup(withSand);
  off2.update(0);
  assert.equal(off2.settings.dust, 0);
  assert.throws(() => WeatherDrive.attach(withSand, { weather: machine, dustLight: -1 }), RangeError);
});
