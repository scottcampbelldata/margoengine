// Dead fuel moisture from the weather, pinned against the reports in fuel-moisture.ts: Simard's equilibrium moisture
// regressions as the NFDRS gives them (Cohen and Deeming 1985, equations 1a to 1c), the sun's correction at the fuel bed
// by cloud cover, 35 percent in rain and the 100-hour rain boundary, and Fosberg's timelag response; the state's
// humidity and temperature, their rows and presets, and a METAR's dew point.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FUEL_TIMELAGS,
  FuelMoistureModel,
  RAIN_FUEL_MOISTURE,
  STATE_FIELDS,
  WEATHER_PRESETS,
  WeatherMachine,
  equilibriumMoisture,
  fuelLevelAir,
  fuelMoistureTarget,
} from '../dist/index.js';
import { WEATHER_LOOKS, WEATHER_SETTINGS, weatherStateOf } from '../dist/settings.js';
import { weatherFromMetar } from '../dist/data.js';
import { WeatherDrive } from '../dist/drive.js';

const near = (a, b, tolerance = 1e-12, message = '') => assert.ok(Math.abs(a - b) <= tolerance, `${message} ${a} vs ${b}`);
const F = (c) => (c * 9) / 5 + 32;

test("the equilibrium moisture is Simard's regression in each of its three humidity bands", () => {
  // Hand-evaluated from Cohen and Deeming 1985, equations 1a to 1c (RH in percent, T in F, EMC in percent).
  near(equilibriumMoisture(0.05, 35), (0.03229 + 0.281073 * 5 - 0.000578 * F(35) * 5) / 100, 1e-15, '1a');
  near(equilibriumMoisture(0.3, 30), (2.22749 + 0.160107 * 30 - 0.014784 * F(30)) / 100, 1e-15, '1b');
  near(equilibriumMoisture(0.3, 30), 0.0575928, 1e-7, '1b value');
  near(equilibriumMoisture(0.8, 15), (21.0606 + 0.005565 * 6400 - 0.00035 * 80 * F(15) - 0.483199 * 80) / 100, 1e-15, '1c');
  near(equilibriumMoisture(0.8, 15), 0.1636868, 1e-7, '1c value');
  // Wetter air holds wetter wood, warmer air drier wood; saturated air about 26 percent (the fibre-saturation side).
  let last = -1;
  for (let h = 0; h <= 1.0001; h += 0.01) {
    const m = equilibriumMoisture(h, 20);
    assert.ok(m >= last - 0.002, `rising with humidity at ${h}`);
    last = m;
  }
  assert.ok(equilibriumMoisture(0.4, 35) < equilibriumMoisture(0.4, 5));
  assert.ok(equilibriumMoisture(1, 15) > 0.24 && equilibriumMoisture(1, 15) < 0.28);
  near(equilibriumMoisture(0, 50), 0.0003229, 1e-15);
});

test('the fuel bed in the sun: add 25, 19, 12 or 5 F and scale the humidity by cloud cover; at night the air as it is', () => {
  const at = (cloud) => fuelLevelAir({ humidity: 0.4, temperature: 20, cloud });
  near(at(0).temperature, 20 + (25 * 5) / 9, 1e-12);
  near(at(0).humidity, 0.3, 1e-12);
  near(at(0.3).humidity, 0.4 * 0.83, 1e-12);
  near(at(0.7).temperature, 20 + (12 * 5) / 9, 1e-12);
  near(at(0.7).humidity, 0.4 * 0.92, 1e-12);
  assert.deepEqual(at(1), { humidity: 0.4, temperature: 20 + (5 * 5) / 9 });
  assert.deepEqual(fuelLevelAir({ humidity: 0.4, temperature: 20, cloud: 0 }, false), { humidity: 0.4, temperature: 20 });
});

test('rain sets the 1 and 10 hour target to 35 percent and the 100-hour boundary to 0.5 d + 41 percent', () => {
  const wet = { humidity: 0.95, temperature: 10, cloud: 1, rain: 0.3 };
  assert.equal(RAIN_FUEL_MOISTURE, 0.35);
  assert.deepEqual(fuelMoistureTarget(wet, 0), { moisture: 0.35, moisture10: 0.35, moisture100: 0.41 });
  near(fuelMoistureTarget(wet, 10).moisture100, 0.46, 1e-12);
  near(fuelMoistureTarget(wet, 100).moisture100, 0.53, 1e-12, 'the day of rain caps the boundary');
  const dry = fuelMoistureTarget({ ...wet, rain: 0 });
  assert.ok(dry.moisture < 0.25 && dry.moisture === dry.moisture100);
});

test('each class moves toward its target by its timelag: 63 percent of the gap in one timelag, a drying half-life of ln 2 timelags', () => {
  assert.deepEqual(FUEL_TIMELAGS, [1, 10, 100]);
  const start = { moisture: 0.35, moisture10: 0.35, moisture100: 0.35 },
    air = { humidity: 0.3, temperature: 30, cloud: 1, rain: 0 },
    target = fuelMoistureTarget(air).moisture,
    fuel = new FuelMoistureModel({ start });
  const one = fuel.step(air, 3600);
  near(one.moisture, 0.35 + (target - 0.35) * (1 - Math.exp(-1)), 1e-12, '1-hour after an hour');
  near(one.moisture10, 0.35 + (target - 0.35) * (1 - Math.exp(-0.1)), 1e-12, '10-hour after an hour');
  near(one.moisture100, 0.35 + (target - 0.35) * (1 - Math.exp(-0.01)), 1e-12, '100-hour after an hour');
  const half = new FuelMoistureModel({ start }).step(air, Math.LN2 * 3600);
  near(half.moisture, (0.35 + target) / 2, 1e-12, 'half the gap in ln 2 hours');
  // Steps add up: 60 one-minute steps are the one-hour step.
  const steps = new FuelMoistureModel({ start });
  for (let i = 0; i < 60; i++) steps.step(air, 60);
  near(steps.moisture.moisture, one.moisture, 1e-12);
  // timeScale runs the fuel clock: one second at 3,600 is an hour.
  near(new FuelMoistureModel({ start, timeScale: 3600 }).step(air, 1).moisture, one.moisture, 1e-12);
  // No start: the first step starts at the target. Rain counts its spell and a dry step ends it.
  const fresh = new FuelMoistureModel();
  assert.equal(fresh.moisture, undefined);
  near(fresh.step(air, 10).moisture, target, 0);
  fresh.step({ ...air, rain: 0.5 }, 7200);
  assert.equal(fresh.rainSpell, 2);
  fresh.step(air, 1);
  assert.equal(fresh.rainSpell, 0);
  assert.throws(() => fresh.step(air, -1), RangeError);
  assert.throws(() => new FuelMoistureModel({ start: { moisture: -1, moisture10: 0, moisture100: 0 } }), RangeError);
  assert.throws(() => new FuelMoistureModel({ timeScale: Number.NaN }), RangeError);
});

test('the state holds humidity and temperature: ranges, presets, rows and looks', () => {
  assert.deepEqual(STATE_FIELDS.humidity, [0, 1]);
  assert.deepEqual(STATE_FIELDS.temperature, [-80, 60]);
  assert.equal(WEATHER_PRESETS.clear.temperature, 15, 'the ICAO standard atmosphere at sea level');
  assert.equal(WEATHER_PRESETS.fog.humidity, 1, 'fog is saturated air');
  for (const name of ['snow', 'blizzard', 'sleet']) assert.ok(WEATHER_PRESETS[name].temperature <= 1, name);
  for (const name of ['drizzle', 'rain', 'storm']) assert.ok(WEATHER_PRESETS[name].humidity >= 0.95, name);
  const rows = Object.fromEntries(WEATHER_SETTINGS.map((r) => [r.name, r]));
  for (const name of ['humidity', 'temperature']) assert.ok(rows[name].nullable && rows[name].default === null && rows[name].weather === 'storm', name);
  assert.equal(weatherStateOf().humidity, WEATHER_PRESETS.clear.humidity, 'null follows the storm level');
  near(weatherStateOf({ storm: 0.25 }).humidity, (WEATHER_PRESETS.clear.humidity + WEATHER_PRESETS.rain.humidity) / 2, 1e-12);
  const flag = weatherStateOf(WEATHER_LOOKS.redFlag);
  assert.ok(flag.humidity === 0.15 && flag.temperature === 32);
  near(fuelMoistureTarget(flag).moisture, 0.023345, 1e-5, 'the red-flag look dries fine fuel to about 2 percent');
  near(fuelMoistureTarget(WEATHER_PRESETS.clear).moisture, 0.0699, 1e-3, 'a fair afternoon, about 7 percent');
  assert.throws(() => new WeatherMachine({ humidity: 1.2 }), RangeError);
  assert.throws(() => new WeatherMachine({ temperature: 70 }), RangeError);
});

test("a METAR's temperature and dew point give the state's temperature and humidity (Magnus form)", () => {
  const s = weatherFromMetar('EGLL 071150Z 24015KT 9999 FEW020 12/09 Q1003');
  assert.equal(s.temperature, 12);
  const e = (c) => Math.exp((17.625 * c) / (c + 243.04));
  near(s.humidity, e(9) / e(12), 1e-12);
  near(s.humidity, 0.817, 0.002, 'about 82 percent');
  const frost = weatherFromMetar('UUEE 071200Z 02002MPS CAVOK M05/M08 Q1025');
  assert.equal(frost.temperature, -5);
  assert.ok(frost.humidity > 0.75 && frost.humidity < 0.8);
  assert.equal(weatherFromMetar('EGLL 071150Z 24015KT 9999 FEW020 Q1003').humidity, 0.5, 'no temperature group: the clear preset');
});

test('a drive with no fire leaves its settings and targets as before; with one it reports the fuel moisture', () => {
  const weather = new WeatherMachine('clear'),
    bare = new WeatherDrive({ weather });
  bare.update(1);
  assert.equal(bare.fuelMoisture, undefined, 'no fire, no fuel model');
  const fire = { options: {}, smokeEmission: 0 },
    drive = new WeatherDrive({ weather, fires: fire, fuelTimeScale: 60 });
  drive.update(1);
  near(fire.options.moisture, fuelMoistureTarget(weather.state).moisture, 0);
  assert.deepEqual(drive.fuelMoisture, { moisture: fire.options.moisture, moisture10: fire.options.moisture10, moisture100: fire.options.moisture100 });
  assert.throws(() => new WeatherDrive({ weather, fuelTimeScale: -1 }), RangeError);
  assert.throws(() => new WeatherDrive({ weather, fuelMoistureFromWeather: 1 }), TypeError);
  // A sky whose sun is down: the fuel sees the air as it is (wetter than in the sun).
  const night = { options: {}, smokeEmission: 0 },
    dark = new WeatherDrive({ weather, fires: night, sky: { options: {}, sun: [0, -0.2, 1] } });
  dark.update(1);
  assert.ok(night.options.moisture > fire.options.moisture);
});

// KB-FIRE-DRIVEWIND1: a fire handed to the drive as `fires` (a front stepped without an engine, as timber-valley's
// rollFire runs a fire's past) dried with the weather but never got its wind, so the 1910 gale burned in still air.
test('a fire given as fires spreads in the weather wind; a wind it was given by hand overrides it', () => {
  const weather = new WeatherMachine({ wind: 20, windDirection: Math.PI }),
    fire = { options: {}, smokeEmission: 0, setWind(w) { this.options.wind = w; } },
    drive = new WeatherDrive({ weather, fires: fire });
  drive.update(1);
  assert.ok(Array.isArray(fire.options.wind), 'the drive wrote the fire a wind');
  assert.ok(Math.hypot(...fire.options.wind) > 10, `the gale reached the fire: ${fire.options.wind}`);
  const own = { options: { wind: [3, 0] }, smokeEmission: 0, setWind() {} };
  new WeatherDrive({ weather, fires: own }).update(1);
  assert.deepEqual(own.options.wind, [3, 0], 'a wind given by hand stays');
});
