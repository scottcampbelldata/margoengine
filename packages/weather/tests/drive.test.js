// WeatherDrive writes a state's cloud, fog, rain and hail numbers into the sky, cloud layers, fog and fog volumes, and
// steps the weather; the fog it writes keeps the visibility of fogDensity whatever the falloff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherDrive, driveSettings, validateDrive } from '../dist/drive.js';
import { WEATHER_PRESETS, WeatherMachine, fogDensity, skyWeather } from '../dist/index.js';

const near = (a, b, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);

test('settings: coverage is cloud, storms thicken the layer, both fogs leave 5 percent contrast at 3 / sigma', () => {
  const s = driveSettings(WEATHER_PRESETS.thunderstorm);
  assert.equal(s.coverage, 1);
  near(s.cloudDensity, 0.02 + 0.06 * 0.9);
  assert.equal(driveSettings(WEATHER_PRESETS.clear).cloudDensity, 0.02);
  for (const name of ['clear', 'fog', 'rain', 'blizzard']) {
    const state = WEATHER_PRESETS[name],
      { extinction, squaredDensity } = driveSettings(state),
      d = 3 / extinction;
    near(extinction, fogDensity(state));
    near(Math.exp(-extinction * d), Math.exp(-3), 1e-12);
    near(Math.exp(-((d * squaredDensity) ** 2)), Math.exp(-3), 1e-12);
  }
  // Clouds drift downwind at three times the ground wind: toward +X for windDirection pi/2.
  const w = driveSettings({ ...WEATHER_PRESETS.clear, wind: 4, windDirection: Math.PI / 2 }).cloudWind;
  near(w[0], 12, 1e-9);
  near(w[1], 0, 1e-9);
});

test('update writes every target and steps the weather', () => {
  const weather = new WeatherMachine('clear', { seed: 4 });
  const sky = { options: { clouds: { coverage: 0.45, speed: 8 }, fog: { depth: () => undefined, density: 0.01 } } };
  const layers = [{ options: { coverage: 0.5, density: 0.04, wind: [10, 3], steps: 64 } }, { options: {} }];
  const fog = { density: 0 },
    volume = { options: { density: 0.02, height: 3 } },
    rain = { options: { intensity: 0.5, radius: 25 } },
    hail = { options: { intensity: 0 } };
  const drive = new WeatherDrive({ weather, sky, clouds: layers, fog, fogVolumes: volume, precipitation: rain, hail });
  weather.transitionTo('thunderstorm', { seconds: 10 });
  for (let i = 0; i < 20; i++) drive.update(1);
  assert.equal(weather.time, 20, 'the drive stepped the weather');
  const state = weather.state,
    s = driveSettings(state);
  assert.equal(sky.options.clouds.coverage, 1);
  assert.equal(sky.options.clouds.speed, 8, 'other cloud settings stay');
  near(sky.options.fog.density, s.squaredDensity);
  assert.deepEqual(layers[0].options, { coverage: 1, density: s.cloudDensity, wind: s.cloudWind, steps: 64 });
  assert.equal(layers[1].options.coverage, 1);
  near(fog.density, s.squaredDensity);
  assert.equal(volume.options.density, s.extinction);
  assert.equal(volume.options.height, 3);
  assert.equal(rain.options.precipitation, 'rain');
  assert.equal(rain.options.radius, 25);
  assert.equal(rain.options.intensity, skyWeather(state).intensity);
  assert.equal(hail.options.intensity, state.hail);
  // An exponential sky fog gets the extinction itself.
  sky.options.fog.falloff = 'exp';
  drive.update(0);
  near(sky.options.fog.density, s.extinction);
  // A sky with no cloud sheet or fog is left without them.
  const bare = { options: {} };
  drive.options.sky = bare;
  drive.update(0);
  assert.deepEqual(bare.options, {});
});

test('advance false leaves stepping to you; the wind is sampled at the listener', () => {
  const weather = new WeatherMachine({ wind: 10, gust: 0.8, rain: 0.5 }, { seed: 9 });
  const rain = { options: {} };
  const drive = new WeatherDrive({
    weather,
    precipitation: rain,
    advance: false,
    listener: { position: [40, 2, -15] },
  });
  weather.update(3);
  drive.update(1);
  assert.equal(weather.time, 3);
  const v = weather.wind.sample(40, 2, -15, 3);
  assert.deepEqual(rain.options.wind, [v[0], v[2]]);
});

test('attach runs it before each frame; bad options throw by name; dispose ends it', () => {
  const plugins = [];
  const engine = {
    use: (p) => (plugins.push(p), p.setup(engine)),
    removePlugin: (name) =>
      plugins.splice(
        plugins.findIndex((p) => p.name === name),
        1,
      ),
  };
  const weather = new WeatherMachine('fog');
  const fog = { density: 0 };
  const drive = WeatherDrive.attach(engine, { weather, fog });
  plugins[0].onPreUpdate(0.5);
  assert.equal(weather.time, 0.5);
  near(fog.density, fogDensity(WEATHER_PRESETS.fog) / Math.sqrt(3));
  assert.throws(() => validateDrive({}), /weather needs a state/);
  assert.throws(() => validateDrive({ weather, fog: {} }), /numeric density/);
  assert.throws(() => validateDrive({ weather, clouds: [1] }), /clouds needs an object/);
  assert.throws(() => validateDrive({ weather, windAloft: 50 }), RangeError);
  assert.throws(() => drive.update(-1), RangeError);
  drive.dispose();
  assert.equal(plugins.length, 0);
  assert.throws(
    () => drive.update(0),
    (e) => e.code === 'disposed',
  );
});
