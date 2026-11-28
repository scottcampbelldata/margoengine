// The shared air and wind physics (beaufort, windProfile, rainRate, visibility) and the drive that finds its targets
// among the scene's plugins by name. Each bound is the measured one of the elements plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherDrive } from '../dist/drive.js';
import {
  CLEAR_AIR_EXTINCTION,
  WEATHER_PRESETS,
  WeatherMachine,
  airExtinction,
  beaufort,
  rainRate,
  visibility,
  windProfile,
} from '../dist/index.js';

test("beaufort follows the WMO table and Beaufort's law within half a force", () => {
  for (const [speed, force] of [
    [0, 0],
    [0.2, 0],
    [0.3, 1],
    [1.5, 2],
    [5.4, 4],
    [10.6, 5],
    [10.7, 6],
    [17.2, 8],
    [24.4, 10],
    [32.6, 12],
    [60, 12],
  ])
    assert.equal(beaufort(speed), force, `${speed} m/s`);
  for (let b = 1; b <= 12; b++) {
    const v = 0.836 * b ** 1.5; // Beaufort's law at the centre of force b
    assert.ok(Math.abs(beaufort(v) - b) <= 1, `law ${b}`);
  }
  assert.throws(() => beaufort(-1), RangeError);
  assert.throws(() => beaufort(NaN), RangeError);
});

test('windProfile is the 1/7 power law: 2.05 U10 at 1,500 m within 5 percent, U10 at 10 m', () => {
  assert.equal(windProfile(8, 10), 8);
  assert.ok(Math.abs(windProfile(8, 1500) / 8 - 2.05) / 2.05 < 0.05);
  assert.equal(windProfile(8, 0), windProfile(8, 1));
  assert.throws(() => windProfile(-1, 10), RangeError);
});

test('rainRate: 0 dry, rising with rain, the drizzle, rain and storm presets in their WMO classes', () => {
  assert.equal(rainRate({ rain: 0 }), 0);
  assert.equal(rainRate({ rain: 1 }), 80);
  assert.ok(rainRate(WEATHER_PRESETS.drizzle) < 2.5, 'drizzle is light');
  assert.ok(rainRate(WEATHER_PRESETS.rain) > 7.6 && rainRate(WEATHER_PRESETS.rain) < 50, 'rain is heavy');
  assert.ok(rainRate(WEATHER_PRESETS.storm) > 50, 'a storm is violent');
});

test('visibility: 23 km clear, 200 m in dense fog, Koschmieder 2 percent contrast, 1.3 km in 25 mm/h rain', () => {
  const clear = { fog: 0, rain: 0, snow: 0 };
  assert.ok(Math.abs(visibility(clear) - 23000) < 1);
  assert.ok(Math.abs(visibility({ ...clear, fog: 1 }) - 200) / 200 < 0.05);
  for (const state of [clear, { ...clear, fog: 0.5 }, { ...clear, rain: 0.7 }, { ...clear, snow: 1 }]) {
    const contrast = Math.exp(-airExtinction(state) * visibility(state));
    assert.ok(Math.abs(contrast - 0.02) < 0.005, `contrast ${contrast}`);
  }
  const rain25 = visibility({ ...clear, rain: (25 / 80) ** (1 / 3) });
  assert.ok(rain25 > 1200 && rain25 < 1500, `${rain25}`);
  assert.ok(Math.abs(visibility({ ...clear, snow: 1 }) - 350) / 350 < 0.1, 'heavy snow 350 m');
  assert.ok(Math.abs(visibility({ ...clear, snow: 0.35 }) - 1600) / 1600 < 0.1, 'light snow 1,600 m');
  // Monotone: more fog, rain or snow never lets you see farther.
  let last = Infinity;
  for (let i = 0; i <= 20; i++) {
    const v = visibility({ fog: i / 20, rain: i / 40, snow: 0 });
    assert.ok(v <= last);
    last = v;
  }
  assert.equal(airExtinction(clear), CLEAR_AIR_EXTINCTION);
});

// A scene: an engine whose `plugins` hold the plugins by name, as `engine.plugins` does.
const sceneWith = (...plugins) => {
  const engine = {
    plugins: new Map(plugins.map((p) => [p.name, p])),
    use: (p) => (engine.plugins.set(p.name, p), p.setup(engine)),
    removePlugin: () => {},
  };
  return engine;
};

test('the drive finds sky, clouds, fog volume, rain and hail by name with no targets given', () => {
  const sky = { name: 'sky', options: { clouds: { coverage: 0 } } },
    clouds = { name: 'sky:volumetric-clouds', options: { coverage: 0, bottom: 1500 } },
    fog = { name: 'volumetric-fog', options: { density: 0 } },
    rain = { name: 'weather', options: {} },
    hail = { name: 'hail', options: {} },
    engine = sceneWith(sky, clouds, fog, rain, hail),
    weather = new WeatherMachine('storm', { seed: 2 });
  WeatherDrive.attach(engine, { weather });
  engine.plugins.get('weather-drive').update(0);
  const state = weather.state;
  assert.equal(sky.options.clouds.coverage, state.cloud);
  assert.equal(clouds.options.coverage, state.cloud);
  assert.ok(fog.options.density > 0);
  assert.equal(rain.options.precipitation, 'rain');
  assert.equal(hail.options.intensity, state.hail);
});

test('a target handed in wins over the one found; auto: false finds nothing', () => {
  const found = { name: 'weather', options: {} },
    given = { options: {} },
    engine = sceneWith(found),
    weather = new WeatherMachine('rain', { seed: 2 });
  const drive = WeatherDrive.attach(engine, { weather, precipitation: given });
  drive.update(0);
  assert.equal(given.options.precipitation, 'rain');
  assert.deepEqual(found.options, {});
  const off = { name: 'weather', options: {} };
  WeatherDrive.attach(sceneWith(off), { weather, auto: false }).update(0);
  assert.deepEqual(off.options, {});
});

test('vane: rain, hail and cloud drift all move within 5 degrees of the wind field', () => {
  const weather = new WeatherMachine('storm', { seed: 5 }),
    field = weather.wind;
  const clouds = { name: 'sky:volumetric-clouds', options: { bottom: 3000 } },
    rain = { name: 'weather', options: {} },
    hail = { name: 'hail', options: {} },
    engine = sceneWith(clouds, rain, hail);
  const drive = WeatherDrive.attach(engine, { weather });
  for (let i = 0; i < 20; i++) drive.update(0.5);
  const sample = field.sample(0, 0, 0, weather.time),
    heading = (x, z) => Math.atan2(x, z),
    off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * (180 / Math.PI);
  const reference = heading(sample[0], sample[2]);
  assert.ok(off(heading(...rain.options.wind), reference) < 5, 'rain');
  assert.ok(off(heading(...hail.options.wind), reference) < 5, 'hail');
  assert.ok(off(heading(...clouds.options.wind), reference) < 5, 'clouds');
  // The deck at 3,000 m drifts faster than the ground wind: (300)^(1/7) = 2.26.
  const speed = Math.hypot(...clouds.options.wind),
    ground = Math.hypot(sample[0], sample[2]);
  assert.ok(speed > 2 * ground * 0.9 && speed < 2.6 * ground * 1.1);
});

test('the drive finds every cloud layer by the name prefix (KB-SKY-CLOUDTWO1)', () => {
  const deck = { name: 'sky:volumetric-clouds', options: { coverage: 0, bottom: 1500 } },
    scud = { name: 'sky:volumetric-clouds:scud', options: { coverage: 0, bottom: 300 } },
    stranger = { name: 'sky:volumetric-cloudsx', options: { coverage: 0 } },
    engine = sceneWith(deck, scud, stranger),
    weather = new WeatherMachine('storm', { seed: 2 });
  WeatherDrive.attach(engine, { weather });
  engine.plugins.get('weather-drive').update(0);
  assert.equal(deck.options.coverage, weather.state.cloud);
  assert.equal(scud.options.coverage, weather.state.cloud);
  assert.equal(stranger.options.coverage, 0);
  // Each layer drifts at the wind of its own base: the low one slower than the deck in a power-law profile.
  assert.ok(Math.hypot(...scud.options.wind) < Math.hypot(...deck.options.wind));
});
