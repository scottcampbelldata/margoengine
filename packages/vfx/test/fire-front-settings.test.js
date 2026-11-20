// The fire front settings table: rows and their ranges, values read back as written, the looks, and with the wind rows at
// null one weather wind slider drives the front (the drive finds it by name) while a value on the row overrides it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FireFront } from '../dist/fire-front.js';
import {
  FIRE_LIVE_SETTINGS,
  FIRE_LOOKS,
  FIRE_SETTINGS,
  applyFireSettings,
  fireSettingDefaults,
  fireSettingValues,
} from '../dist/settings.js';
import { WeatherDrive } from '../../weather/dist/drive.js';
import { WeatherMachine } from '../../weather/dist/index.js';

test('the rows: all live, wind follows the weather at null, ranges and errors are enforced', () => {
  assert.equal(FIRE_LIVE_SETTINGS.length, FIRE_SETTINGS.length);
  for (const row of FIRE_SETTINGS) assert.ok(row.about.length > 15 && row.max > row.min, row.name);
  assert.deepEqual(FIRE_SETTINGS.filter((r) => r.weather).map((r) => [r.name, r.weather]), [
    ['moisture', 'humidity'],
    ['moisture10', 'humidity'],
    ['moisture100', 'humidity'],
    ['wind.x', 'wind'],
    ['wind.z', 'wind'],
  ]);
  assert.throws(() => applyFireSettings({ options: {} }, { nope: 1 }), TypeError);
  assert.throws(() => applyFireSettings({ options: {} }, { moisture: 2 }), RangeError);
  assert.throws(() => applyFireSettings({ options: {} }, { spotting: -1 }), RangeError);
});

test('every row at both ends of its range builds a front and reads back; the defaults are an unconfigured front', () => {
  for (const row of FIRE_SETTINGS.filter((r) => !r.name.startsWith('wind.'))) {
    for (const value of [row.min, row.max]) {
      const front = FireFront.create({ size: [64, 64], ignitions: [{ at: [0, 0] }] });
      applyFireSettings(front, { ...fireSettingDefaults(), [row.name]: value });
      assert.equal(fireSettingValues(front)[row.name], value, row.name);
      front.advanceTime(2);
    }
  }
  const front = FireFront.create({ size: [64, 64] });
  applyFireSettings(front, {});
  assert.equal(front.options.wind, undefined, 'both wind rows null leave the wind unset');
  assert.equal(front.options.moisture, undefined, 'the moisture rows at null leave it unset, for the weather');
  // With no weather a null moisture is the 0.06 of an unconfigured front, bit for bit.
  const a = FireFront.create({ size: [128, 128], fuel: 'FM4', ignitions: [{ at: [0, 0], radius: 6 }] }),
    b = FireFront.create({ size: [128, 128], fuel: 'FM4', ignitions: [{ at: [0, 0], radius: 6 }] });
  applyFireSettings(b, {});
  a.advanceTime(60);
  b.advanceTime(60);
  assert.deepEqual(a.read(), b.read());
  for (const look of Object.values(FIRE_LOOKS)) applyFireSettings(front, look);
});

test('the looks are only row values and a drier, windier look burns faster', () => {
  const run = (look) => {
    const front = FireFront.create({ size: [400, 400], cell: 4, fuel: 'FM4', ignitions: [{ at: [0, 0], radius: 6 }], spotting: 0 });
    applyFireSettings(front, { ...look, spotting: 0 });
    front.advanceTime(400);
    return front.arrivalTime(-60, 60);
  };
  const mild = run(FIRE_LOOKS.mild),
    ana = run(FIRE_LOOKS.santaAna);
  assert.ok(ana > 0 && (mild < 0 || ana < mild), `santa ana ${ana} against mild ${mild}`);
});

test('the weather drive writes the wind of a front found by name; a value on the wind rows overrides it; null hands it back', () => {
  const weather = new WeatherMachine({ wind: 12, gust: 0 }, { seed: 2 }),
    front = FireFront.create({ size: [64, 64] }),
    engine = { plugins: new Map([[front.name, front]]), use() {} },
    drive = new WeatherDrive({ weather });
  drive.setup(engine);
  drive.update(0.1);
  assert.ok(Array.isArray(front.options.wind) && Math.hypot(...front.options.wind) > 5, 'the weather wind blows the front');
  applyFireSettings(front, { 'wind.x': 3, 'wind.z': -4 });
  drive.update(0.1);
  assert.deepEqual(front.options.wind, [3, -4], 'a value overrides the weather');
  applyFireSettings(front, {});
  drive.update(0.1);
  assert.ok(Math.hypot(...front.options.wind) > 5 && front.options.wind[0] !== 3, 'null follows the weather again');
});

// The dead fuel follows the weather: with the moisture rows at null the drive writes the 1, 10 and 100 hour moistures of
// the weather's humidity, temperature and rain (FuelMoistureModel in @margoengine/weather); a value on a row overrides it;
// rain wets the fuel and the front slows.
test('the weather drive dries and wets the dead fuel of a front; a value on a moisture row overrides it', () => {
  const weather = new WeatherMachine({ wind: 6, gust: 0, humidity: 0.15, temperature: 32, cloud: 0 }, { seed: 2 }),
    front = FireFront.create({ size: [64, 64] }),
    engine = { plugins: new Map([[front.name, front]]), use() {} },
    drive = new WeatherDrive({ weather });
  applyFireSettings(front, {});
  drive.setup(engine);
  drive.update(0.1);
  // Clear sky: 32 C + 25 F and 0.15 x 0.75 humidity at the fuel, Simard band 10 to 50 percent: 2.335 percent.
  assert.ok(Math.abs(front.options.moisture - 0.02335) < 2e-4, `red-flag 1-hour moisture ${front.options.moisture}`);
  assert.equal(front.options.moisture10, front.options.moisture);
  applyFireSettings(front, { moisture: 0.2 });
  drive.update(0.1);
  assert.equal(front.options.moisture, 0.2, 'a value overrides the weather');
  assert.equal(front.options.moisture10, drive.fuelMoisture.moisture10, 'rows left at null still follow');
  applyFireSettings(front, {});
  weather.set({ wind: 6, gust: 0, humidity: 0.95, temperature: 12, cloud: 1, rain: 0.6 });
  for (let i = 0; i < 60; i++) drive.update(60); // an hour of rain
  assert.ok(front.options.moisture > 0.2 && front.options.moisture < 0.35, `an hour of rain wets the fine fuel: ${front.options.moisture}`);
  assert.ok(front.options.moisture100 < 0.05, 'the 100-hour fuel barely moves in an hour');
  const off = FireFront.create({ size: [64, 64] }),
    still = new WeatherDrive({ weather, fires: off, fuelMoistureFromWeather: false });
  still.update(1);
  assert.equal(off.options.moisture, undefined, 'fuelMoistureFromWeather: false leaves the fire alone');
});
