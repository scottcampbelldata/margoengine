// The blown-sand settings table: the rows and their live flags, every row at both ends of its range passes the layer's
// own validation, the defaults leave the wind to the weather, and one weather wind slider moves the sand's wind (within
// 5 degrees) while a value on the row overrides it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BlownSand } from '../dist/blown-sand.js';
import {
  SAND_LIVE_SETTINGS,
  SAND_LOOKS,
  SAND_SETTINGS,
  applySandSettings,
  sandSettingDefaults,
  sandSettingValues,
} from '../dist/settings.js';
import { WeatherDrive } from '../../weather/dist/drive.js';
import { WeatherMachine } from '../../weather/dist/index.js';
import { applyWeatherSettings } from '../../weather/dist/settings.js';

const ground = () => 0;
const make = (options = {}) => new BlownSand({ ground, wind: { speed: 0 }, ...options });
const off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * (180 / Math.PI);

test('the rows: wind and fog follow the weather at null, the layout rows are not live, the rest are', () => {
  const dead = SAND_SETTINGS.filter((r) => !r.live).map((r) => r.name);
  assert.deepEqual(dead, ['amount', 'seed', 'limit', 'range', 'softness']);
  assert.equal(SAND_LIVE_SETTINGS.length, SAND_SETTINGS.length - 5);
  for (const row of SAND_SETTINGS) assert.ok(row.about.length > 15 && row.max > row.min && row.step > 0, row.name);
  const follows = SAND_SETTINGS.filter((r) => r.weather).map((r) => [r.name, r.weather]);
  assert.deepEqual(follows, [['wind.speed', 'wind'], ['wind.direction', 'windDirection'], ['wind.gust', 'gust'], ['fog', 'visibility']]);
  for (const row of SAND_SETTINGS.filter((r) => r.weather)) assert.ok(row.nullable && row.default === null);
  assert.throws(() => applySandSettings(make(), { nope: 1 }), TypeError);
  assert.throws(() => applySandSettings(make(), { opacity: 2 }), RangeError);
  assert.throws(() => applySandSettings(make(), { 'wind.speed': 90 }), RangeError);
  assert.throws(() => applySandSettings(make(), { opacity: null }), RangeError);
});

test('every row at both ends of its range builds a BlownSand; the defaults leave the wind to the weather', () => {
  for (const row of SAND_SETTINGS) {
    if (row.kind === 'color') continue;
    for (const end of [row.min, row.max]) {
      const o = { ground, wind: { speed: 0 }, depth: () => undefined },
        values = row.name.startsWith('wind.') && row.name !== 'wind.speed' ? { 'wind.speed': 10, [row.name]: end } : { [row.name]: end };
      applySandSettings({ options: o }, values);
      assert.doesNotThrow(() => new BlownSand(o), `${row.name} = ${end}`);
      if (!row.name.startsWith('wind.')) assert.equal(sandSettingValues({ options: o })[row.name], end, row.name);
    }
  }
  const o = { ground, wind: { speed: 0 } };
  applySandSettings({ options: o }, {});
  assert.deepEqual(o.wind, { speed: 0 });
  for (const key of ['gustiness', 'threshold', 'fog']) assert.equal(key in o, false, key);
  assert.deepEqual(sandSettingValues({ options: o }), sandSettingDefaults());
  new BlownSand(o);
  for (const look of Object.values(SAND_LOOKS)) {
    const p = { ground, wind: { speed: 0 } };
    applySandSettings({ options: p }, look);
    new BlownSand(p);
  }
});

test('values read back as written, and the wind is written in radians', () => {
  const o = { ground, wind: { speed: 0 } },
    values = { ...sandSample(), 'wind.speed': 14, 'wind.direction': 135, 'wind.gust': 0.6 };
  applySandSettings({ options: o }, values);
  assert.equal(o.wind.speed, 14);
  assert.ok(Math.abs(o.wind.direction - (135 * Math.PI) / 180) < 1e-12);
  assert.equal(o.wind.gust, 0.6);
  assert.deepEqual(sandSettingValues({ options: o }), { ...sandSettingDefaults(), ...values });
});
function sandSample() {
  return { threshold: 8.5, grainSize: 0.0005, windHeight: 12, color: [0.6, 0.5, 0.3], streak: 1.1, height: 0.4, opacity: 0.7, gustiness: 0.5, fog: 0.001, amount: 0.8, seed: 9, limit: 4096, range: 120 };
}

test('with the wind rows at null one weather wind slider moves the sand within 5 degrees; a value on the row overrides it', () => {
  const machine = new WeatherMachine('clear', { seed: 6 }),
    sand = make(),
    own = make();
  applySandSettings(sand, {});
  applySandSettings(own, { 'wind.speed': 11, 'wind.direction': 40 });
  const engine = { plugins: new Map([[sand.name, sand], [own.name, own]]), use: () => {}, removePlugin: () => {} },
    drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  for (const [speed, azimuth] of [[2, 15], [9, 95], [21, 200], [14, 330]]) {
    applyWeatherSettings(machine, { wind: speed, windDirection: azimuth, gust: 0.2 });
    drive.update(0.25);
    assert.equal(sand.options.wind.speed, speed);
    assert.ok(off(sand.options.wind.direction, (azimuth * Math.PI) / 180) < 5, `azimuth ${azimuth}`);
    assert.equal(own.options.wind.speed, 11);
    assert.ok(off(own.options.wind.direction, (40 * Math.PI) / 180) < 1e-9);
  }
  // Back to null: the sand follows the weather again.
  applySandSettings(own, {});
  drive.update(0.25);
  assert.equal(own.options.wind.speed, 14);
});
