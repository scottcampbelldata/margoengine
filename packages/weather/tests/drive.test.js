// WeatherDrive writes a state's cloud, fog, rain and hail numbers into the sky, cloud layers, fog and fog volumes, and
// steps the weather; the fog it writes keeps the visibility of fogDensity whatever the falloff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherDrive, driveSettings, validateDrive } from '../dist/drive.js';
import { WEATHER_PRESETS, WeatherMachine, fogDensity, skyWeather, windProfile } from '../dist/index.js';

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
  // Clouds at 1,500 m drift downwind at U10 (150)^(1/7) = 2.05 times the ground wind (the 1/7 power law): toward +X for
  // windDirection pi/2. A plain windAloft factor still wins.
  const w = driveSettings({ ...WEATHER_PRESETS.clear, wind: 4, windDirection: Math.PI / 2 }).cloudWind;
  near(w[0], 4 * 150 ** (1 / 7), 1e-9);
  near(driveSettings({ ...WEATHER_PRESETS.clear, wind: 4, windDirection: Math.PI / 2 }, 3).cloudWind[0], 12, 1e-9);
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
  // The deck drifts with the wind field's own vector at the camera, grown to its 1,500 m base by the 1/7 power law.
  const field = weather.wind.sample(0, 0, 0, weather.time),
    aloft = windProfile(1, 1500);
  assert.deepEqual(layers[0].options, {
    weather: weather.state,
    coverage: 1,
    density: s.cloudDensity,
    wind: [field[0] * aloft, field[2] * aloft],
    steps: 64,
  });
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

test('fogWind blows its fog volumes with the wind at the listener; others keep their own wind', () => {
  const weather = new WeatherMachine({ wind: 16, gust: 0.5, snow: 1, fog: 1 }, { seed: 4 });
  const fog = { options: { density: 0.01, wind: [1, 0, 0] } },
    still = { options: { density: 0.01, wind: [1, 0, 0] } };
  new WeatherDrive({ weather, fogVolumes: still, listener: { position: [3, 1, 20] } }).update(2);
  assert.deepEqual(still.options.wind, [1, 0, 0], 'Not in fogWind: the volume keeps its wind');
  // Blown but not in fogVolumes: the drive sets its wind and leaves its density to the scene.
  const drive = new WeatherDrive({ weather, fogWind: fog, listener: { position: [3, 1, 20] } });
  for (const t of [0.5, 0.5, 0.5]) {
    drive.update(t);
    const v = weather.wind.sample(3, 1, 20, weather.time);
    assert.deepEqual(fog.options.wind, [v[0], 0, v[2]]);
  }
  assert.equal(fog.options.density, 0.01, 'density untouched');
  assert.throws(() => new WeatherDrive({ weather, fogWind: 'yes' }), /fogWind needs an object with options/);
});

test('attach runs it before each frame; bad options throw by name; dispose ends it', () => {
  const plugins = [];
  const engine = {
    use: (p) => (plugins.push(p), p.setup(engine)),
    // One scene: the engine stands for it. The drive leaves through the scene it joined.
    sceneOf: (p) => (plugins.includes(p) ? engine : undefined),
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

// The weather is the master (Scott, 2026-11-17): a value set by hand is an override the drive never writes, and handing
// it back (holdFromWeather false, which a null settings row does) lets the weather write it again.
import { holdFromWeather } from '../../shared/settings.js';

const stormy = () =>
  new WeatherMachine({ wind: 12, gust: 0.4, rain: 0.8, cloud: 0.9, fog: 0.3, hail: 0.5, dust: 0.4 }, { seed: 3 });
const frames = (drive, n = 5) => {
  for (let i = 0; i < n; i++) drive.update(0.1);
};
// One target: build it, name what to read, and what the drive passes it as.
const OVERRIDES = {
  'sky cloud coverage': (w) => {
    const sky = { options: { clouds: { coverage: 0.123 } } };
    return {
      drive: new WeatherDrive({ weather: w, sky }),
      obj: sky.options.clouds,
      key: 'coverage',
      read: () => sky.options.clouds.coverage,
      set: 0.123,
    };
  },
  'sky fog density': (w) => {
    const fog = { density: 0.0123 },
      sky = { options: { fog } };
    return {
      drive: new WeatherDrive({ weather: w, sky }),
      obj: fog,
      key: 'density',
      read: () => fog.density,
      set: 0.0123,
    };
  },
  'sky fog colour': (w) => {
    const color = [0.1, 0.2, 0.3],
      fog = { density: 0.01, color },
      sky = { options: { fog } };
    return { drive: new WeatherDrive({ weather: w, sky }), obj: fog, key: 'color', read: () => fog.color, set: color };
  },
  'cloud layer density': (w) => {
    const layer = { options: { density: 0.0321 } };
    return {
      drive: new WeatherDrive({ weather: w, clouds: layer }),
      obj: layer.options,
      key: 'density',
      read: () => layer.options.density,
      set: 0.0321,
    };
  },
  'cloud layer coverage': (w) => {
    const layer = { options: { coverage: 0.0321 } };
    return {
      drive: new WeatherDrive({ weather: w, clouds: layer }),
      obj: layer.options,
      key: 'coverage',
      read: () => layer.options.coverage,
      set: 0.0321,
    };
  },
  'cloud layer wind': (w) => {
    const wind = [1, 2],
      layer = { options: { wind } };
    return {
      drive: new WeatherDrive({ weather: w, clouds: layer }),
      obj: layer.options,
      key: 'wind',
      read: () => layer.options.wind,
      set: wind,
    };
  },
  'scene fog density': (w) => {
    const fog = { density: 0.0042 };
    return {
      drive: new WeatherDrive({ weather: w, fog }),
      obj: fog,
      key: 'density',
      read: () => fog.density,
      set: 0.0042,
    };
  },
  'fog volume density': (w) => {
    const volume = { options: { density: 0.0042 } };
    return {
      drive: new WeatherDrive({ weather: w, fogVolumes: volume }),
      obj: volume.options,
      key: 'density',
      read: () => volume.options.density,
      set: 0.0042,
    };
  },
  'fog volume wind': (w) => {
    const wind = [3, 0, 4],
      volume = { options: { wind } };
    return {
      drive: new WeatherDrive({ weather: w, fogWind: volume }),
      obj: volume.options,
      key: 'wind',
      read: () => volume.options.wind,
      set: wind,
    };
  },
  'scatter wind': (w) => {
    const wind = [0.3, 0.4, 0.5],
      scatter = { options: { wind } };
    return {
      drive: new WeatherDrive({ weather: w, scatter }),
      obj: scatter.options,
      key: 'wind',
      read: () => scatter.options.wind,
      set: wind,
    };
  },
  'grass wind strength': (w) => {
    const grass = { windDirection: [1, 0.35], windStrength: 0.0777, windSpeed: 0.5 };
    return {
      drive: new WeatherDrive({ weather: w, grass }),
      obj: grass,
      key: 'windStrength',
      read: () => grass.windStrength,
      set: 0.0777,
    };
  },
  'grass wind speed': (w) => {
    const grass = { windDirection: [1, 0.35], windStrength: 0.2, windSpeed: 0.0777 };
    return {
      drive: new WeatherDrive({ weather: w, grass }),
      obj: grass,
      key: 'windSpeed',
      read: () => grass.windSpeed,
      set: 0.0777,
    };
  },
  'grass wind direction': (w) => {
    const dir = [0, 1],
      grass = { windDirection: dir, windStrength: 0.2, windSpeed: 0.5 };
    return {
      drive: new WeatherDrive({ weather: w, grass }),
      obj: grass,
      key: 'windDirection',
      read: () => grass.windDirection,
      set: dir,
    };
  },
  'vfx wind': (w) => {
    const wind = [5, 6],
      fx = { options: { wind }, setWind() {} };
    return {
      drive: new WeatherDrive({ weather: w, vfx: fx }),
      obj: fx.options,
      key: 'wind',
      read: () => fx.options.wind,
      set: wind,
      unset: () => delete fx.options.wind,
    };
  },
  'rain intensity': (w) => {
    const rain = { options: { intensity: 0.0123 } };
    return {
      drive: new WeatherDrive({ weather: w, precipitation: rain }),
      obj: rain.options,
      key: 'intensity',
      read: () => rain.options.intensity,
      set: 0.0123,
    };
  },
  'hail intensity': (w) => {
    const hail = { options: { intensity: 0.0123 } };
    return {
      drive: new WeatherDrive({ weather: w, hail }),
      obj: hail.options,
      key: 'intensity',
      read: () => hail.options.intensity,
      set: 0.0123,
    };
  },
  'blown sand wind': (w) => {
    const wind = { speed: 9, direction: 1 },
      sand = { options: { wind } };
    return {
      drive: new WeatherDrive({ weather: w, blownSand: sand }),
      obj: sand.options,
      key: 'wind',
      read: () => sand.options.wind,
      set: wind,
      unset: () => (sand.options.wind = { speed: 0 }),
    };
  },
  'blown sand fog': (w) => {
    const sand = { options: { fog: 0.0042 } };
    return {
      drive: new WeatherDrive({ weather: w, blownSand: sand }),
      obj: sand.options,
      key: 'fog',
      read: () => sand.options.fog,
      set: 0.0042,
      unset: () => delete sand.options.fog,
    };
  },
};
for (const [name, build] of Object.entries(OVERRIDES))
  test(`override: ${name} holds a set value and follows the weather once handed back`, () => {
    const { drive, obj, key, read, set, unset } = build(stormy());
    holdFromWeather(obj, key);
    frames(drive);
    assert.equal(read(), set, 'a held value is never written');
    holdFromWeather(obj, key, false);
    unset?.();
    frames(drive);
    assert.notEqual(read(), set, 'a released value follows the weather again');
  });

test('override: a sea with a held wind is not written; released, it takes the weather wind at once', () => {
  const calls = [],
    sea = { options: {}, setWind: (w) => calls.push(w) },
    drive = new WeatherDrive({ weather: stormy(), water: sea });
  holdFromWeather(sea, 'wind');
  frames(drive);
  assert.equal(calls.length, 0);
  holdFromWeather(sea, 'wind', false);
  frames(drive);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].speed > 0);
});

test('override: a fog volume given a visibility is left alone (density must not accompany it)', () => {
  const volume = { options: { visibility: 800 } },
    drive = new WeatherDrive({ weather: stormy(), fogVolumes: volume });
  frames(drive);
  assert.equal(volume.options.density, undefined);
  assert.equal(volume.options.visibility, 800);
  delete volume.options.visibility;
  frames(drive);
  assert.ok(volume.options.density > 0, 'null visibility follows the weather again');
});

// Disaster water push 5: a sea with `setRainRate` (a Flood) is given the weather's rain in mm/h, once per change, and a
// rain a person set is the override the drive never writes.
test('a sea that takes rain gets the weather rain rate; a held rain is left alone and handed back', () => {
  const calls = [],
    sea = { options: {}, setWind() {}, setRainRate: (r) => calls.push(r) },
    plain = { options: {}, setWind() {} },
    drive = new WeatherDrive({ weather: stormy(), water: [sea, plain] });
  frames(drive);
  assert.equal(calls.length, 1, 'once while the rain is unchanged');
  assert.ok(calls[0] > 1, 'a storm rains: ' + calls[0]);
  assert.equal(calls[0], drive.settings.rainRate);
  holdFromWeather(sea, 'rain');
  const was = calls.length;
  frames(drive);
  assert.equal(calls.length, was, 'a held rain is never written');
  holdFromWeather(sea, 'rain', false);
  frames(drive);
  assert.equal(calls.length, was + 1, 'handed back, it follows the weather again');
});

test('the attached drive finds a plugin named water:* with setRainRate on the engine and feeds it', () => {
  const calls = [],
    flood = { name: 'water:flood-0', options: {}, setWind() {}, setRainRate: (r) => calls.push(r) },
    list = [];
  const engine = {
    plugins: new Map([[flood.name, flood]]),
    use: (p) => (list.push(p), p.setup(engine)),
    sceneOf: (p) => (list.includes(p) ? engine : undefined),
    removePlugin() {},
  };
  WeatherDrive.attach(engine, { weather: stormy() });
  list[0].onPreUpdate(0.5);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] > 1);
});

test('changing ground (ground-change:*) takes the weather rain as its wetness; a held rain is left alone', () => {
  const ground = { name: 'ground-change:0', options: {}, look: { rain: null } },
    list = [];
  const engine = {
    plugins: new Map([[ground.name, ground]]),
    use: (p) => (list.push(p), p.setup(engine)),
    sceneOf: (p) => (list.includes(p) ? engine : undefined),
    removePlugin() {},
  };
  WeatherDrive.attach(engine, { weather: stormy() });
  list[0].onPreUpdate(0.5);
  assert.ok(ground.look.rain > 0.5, 'a storm wets the ground: ' + ground.look.rain);
  ground.look.rain = 0.1;
  holdFromWeather(ground.look, 'rain');
  list[0].onPreUpdate(0.5);
  assert.equal(ground.look.rain, 0.1, 'a held rain is never written');
  const dry = { options: {}, look: { rain: null } };
  new WeatherDrive({ weather: new WeatherMachine(), grounds: dry }).update(0);
  assert.equal(dry.look.rain, 0, 'a clear weather leaves it dry');
});

test('rock (terrain:rocks:*, a RockSurface) takes the weather rain as its wetness, found by name', () => {
  // Fails on the old drive, which found only ground-change:* plugins: the rock stayed dry in a storm.
  const rock = { name: 'terrain:rocks:3', options: {}, look: { rain: null } },
    list = [];
  const engine = {
    plugins: new Map([[rock.name, rock]]),
    use: (p) => (list.push(p), p.setup(engine)),
    sceneOf: (p) => (list.includes(p) ? engine : undefined),
    removePlugin() {},
  };
  WeatherDrive.attach(engine, { weather: stormy() });
  list[0].onPreUpdate(0.5);
  assert.ok(rock.look.rain > 0.5, 'a storm wets the rock: ' + rock.look.rain);
  rock.look.rain = 0.2;
  holdFromWeather(rock.look, 'rain');
  list[0].onPreUpdate(0.5);
  assert.equal(rock.look.rain, 0.2, 'a held rain is never written');
});

test("the drive merges its lightning rate into the weather's lightning option and leaves the light, deck flash and link", () => {
  const weather = new WeatherMachine('thunderstorm', { seed: 4 }),
    mine = { seed: 9, hold: 0.3, light: { scale: 2 }, cloud: { base: 700 }, link: { fog: false } },
    rain = { options: { lightning: mine } },
    drive = new WeatherDrive({ weather, precipitation: rain });
  drive.update(1);
  assert.equal(rain.options.lightning, mine, 'the object a person gave stays the same object');
  assert.deepEqual(mine.light, { scale: 2 });
  assert.deepEqual(mine.cloud, { base: 700 });
  assert.deepEqual(mine.link, { fog: false });
  assert.equal(mine.seed, 9);
  assert.equal(mine.hold, 0.3);
  assert.equal(mine.rate, skyWeather(weather.state).lightning.rate, 'the rate follows the state');
  assert.equal(mine.threshold, 0);
  // A calm state stops the strikes and keeps every other key.
  weather.transitionTo('clear', { seconds: 0.1 });
  for (let i = 0; i < 5; i++) drive.update(1);
  assert.equal(mine.rate, 0);
  assert.equal(mine.seed, 9);
  assert.deepEqual(mine.light, { scale: 2 });
  // A rate held by hand (settings apply) is an override the drive never writes.
  mine.rate = 7;
  holdFromWeather(mine, 'rate', true);
  weather.transitionTo('thunderstorm', { seconds: 0.1 });
  for (let i = 0; i < 5; i++) drive.update(1);
  assert.equal(mine.rate, 7);
  assert.equal(mine.threshold, 0, 'the threshold still follows');
  // With no lightning option, a storm makes one; a calm weather leaves none.
  const bare = { options: {} },
    calm = new WeatherDrive({ weather: new WeatherMachine('clear', { seed: 1 }), precipitation: bare });
  calm.update(1);
  assert.equal(bare.options.lightning, undefined);
  const stormy = { options: {} };
  new WeatherDrive({ weather: new WeatherMachine('thunderstorm', { seed: 1 }), precipitation: stormy }).update(1);
  assert.equal(stormy.options.lightning.threshold, 0);
  assert.ok(stormy.options.lightning.rate > 0);
});

test("a storm's cloud layer gets the weather only: its cover, density and turning cloud are the storm's", () => {
  const weather = new WeatherMachine('thunderstorm', { seed: 2 });
  const plain = { options: {} },
    storm = { options: { hurricane: {}, coverage: 0.4, density: 0.02, wind: [3, 1] } },
    typed = { options: { type: 'hurricane' } },
    held = { options: { hurricane: {}, coverage: 0.7 } };
  holdFromWeather(held.options, 'coverage');
  const drive = new WeatherDrive({ weather, clouds: [plain, storm, typed, held] });
  drive.update(1);
  assert.equal(plain.options.coverage, weather.state.cloud);
  for (const layer of [storm, typed]) {
    assert.deepEqual(layer.options.weather, weather.state);
    assert.ok(
      !('coverage' in layer.options) && !('density' in layer.options) && !('wind' in layer.options),
      JSON.stringify(layer.options),
    );
  }
  assert.equal(held.options.coverage, 0.7, 'a value held by hand stays');
});
