// Ash and sea spray in the air: coarse grains that extinguish twice their cross section (van de Hulst 1957), the ash of
// the 2010 Eyjafjallajokull plume (Waquet et al. 2014; Toledano et al. 2012; Ansmann et al. 2011), the sea salt of
// Lovett 1978 thickened near breaking surf (de Leeuw et al. 2000), the grey sun through them, the fog colours, the rows
// and looks, and the drive that takes ash from an eruption and spray from the sea and its surf. Load 0 changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASH_AT_FULL,
  ASH_DENSITY,
  ASH_RADIUS,
  CLEAR_AIR_EXTINCTION,
  KOSCHMIEDER,
  SPRAY_GROWTH,
  SURF_ENHANCEMENT,
  STATE_FIELDS,
  WEATHER_PRESETS,
  WeatherMachine,
  airExtinction,
  ashColor,
  ashConcentration,
  ashExtinction,
  ashForExtinction,
  coarseExtinction,
  dustExtinction,
  fogDensity,
  fogForVisibility,
  hazeLight,
  rainRate,
  seaSalt,
  smokeColor,
  smokeExtinction,
  smokeSunTransmittance,
  snowExtinction,
  sprayColor,
  sprayConcentration,
  sprayExtinction,
  sprayFromWind,
  sunTransmittance,
  visibility,
} from '../dist/index.js';
import { WeatherDrive } from '../dist/drive.js';
import { Eruption } from '../dist/eruption.js';
import { WEATHER_LOOKS, WEATHER_SETTINGS, applyWeatherSettings, weatherStateOf } from '../dist/settings.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
const rel = (a, b, r) => assert.ok(Math.abs(a / b - 1) <= r, `${a} vs ${b} (${((a / b - 1) * 100).toFixed(3)}%)`);
const engineOf = (...plugins) => ({
  plugins: new Map(plugins.map((p) => [p.name, p])),
  use: () => {},
  removePlugin: () => {},
});

test('coarse grains extinguish twice their cross section: 3 C / (2 rho r), so ash at 1 leaves about 114 m', () => {
  // 1 g/m3 of 1 micrometre grains of 1,000 kg/m3: 1.5 per metre.
  near(coarseExtinction(1e6, 1e-6, 1000), 1.5, 1e-12);
  near(ashExtinction(1), (1.5 * ASH_AT_FULL * 1e-9) / (ASH_DENSITY * ASH_RADIUS), 1e-15);
  assert.equal(ASH_RADIUS, 1.75e-6, 'the coarse mode of the 2010 plume (Waquet et al. 2014)');
  const v = visibility({ fog: 0, rain: 0, snow: 0, ash: 1 });
  assert.ok(v > 105 && v < 120, `ash 1 leaves ${v} m`);
  // Ansmann et al. 2011's distal peak, 1,500 micrograms: ash 0.12, several km.
  const a = ashForExtinction(coarseExtinction(1500, ASH_RADIUS, ASH_DENSITY));
  near(a, Math.sqrt(1500 / ASH_AT_FULL), 1e-12);
  const far = visibility({ fog: 0, rain: 0, snow: 0, ash: a });
  assert.ok(far > 5000 && far < 9000, `the distal cloud leaves ${far} m`);
  near(ashConcentration(0.5), ASH_AT_FULL / 4);
  near(ashForExtinction(ashExtinction(0.37)), 0.37, 1e-12);
  assert.equal(ashForExtinction(1), 1);
  assert.throws(() => coarseExtinction(-1, 1e-6, 1000), RangeError);
  assert.throws(() => coarseExtinction(1, 0, 1000), RangeError);
  assert.throws(() => ashForExtinction(NaN), RangeError);
});

test("an eruption's falling ash at the camera becomes the weather's ash, with the same visibility as the eruption gives", () => {
  const eruption = new Eruption({ vent: [0, 0, 0], wind: 10, windDirection: 90, start: 0, massRate: 1e7 });
  eruption.seek(3000);
  const drive = new WeatherDrive({
    weather: new WeatherMachine('clear', { seed: 3 }),
    eruptions: eruption,
    advance: false,
  });
  let checked = 0;
  for (const x of [5000, 15000, 30000, 60000]) {
    const v = eruption.visibility(x, 0);
    drive.options.position = [x, 0, 0];
    const s = drive.update(0);
    if (s.ash >= 1 || v > 20000) continue;
    rel(s.visibility, v, 1e-9);
    checked++;
  }
  assert.ok(checked >= 2, `${checked} places under the ash`);
  // Upwind of the vent only the far tail of the fall's spread (under 0.1 percent of ash 1); off, there is none.
  drive.options.position = [-30000, 0, 0];
  assert.ok(drive.update(0).ash < 1e-3);
  drive.options.position = [15000, 0, 0];
  drive.options.ashFromEruption = false;
  assert.equal(drive.update(0).ash, 0);
  assert.throws(() => new WeatherDrive({ weather: new WeatherMachine('clear'), eruptions: {} }), TypeError);
  assert.throws(() => new WeatherDrive({ weather: new WeatherMachine('clear'), ashFromEruption: 1 }), TypeError);
  assert.throws(() => new WeatherDrive({ weather: new WeatherMachine('clear'), ashLight: 101 }), RangeError);
});

test('Eruption.attach names it eruption:N and steps it, and a drive in the scene finds it by that name', () => {
  const plugins = new Map(),
    engine = {
      plugins,
      use: (p) => (plugins.set(p.name, p), p.setup?.(engine)),
      removePlugin: (n) => plugins.delete(n),
    };
  const eruption = Eruption.attach(engine, { vent: [0, 0, 0], wind: 10, windDirection: 90 });
  assert.match(eruption.name, /^eruption:\d+$/);
  eruption.onPreUpdate(2000);
  assert.equal(eruption.time, 2000);
  const drive = WeatherDrive.attach(engine, {
    weather: new WeatherMachine('clear', { seed: 3 }),
    position: [15000, 0, 0],
    advance: false,
  });
  drive.setup(engine);
  assert.ok(drive.update(0).ash > 0, 'the drive takes the ash of an attached eruption by itself');
  eruption.dispose();
  assert.equal(plugins.has(eruption.name), false);
  assert.equal(drive.update(0).ash, 0);
});

test('ash and spray dim the sun grey (Angstrom 0) where smoke reddens it; a state with none leaves [1, 1, 1]', () => {
  assert.deepEqual(sunTransmittance({ smoke: 0, ash: 0, spray: 0 }, 0.5), [1, 1, 1]);
  assert.deepEqual(sunTransmittance({ smoke: 0.3 }, 0.5), smokeSunTransmittance(0.3, 0.5));
  const [r, g, b] = sunTransmittance({ ash: 0.2 }, Math.PI / 2);
  assert.equal(r, g);
  assert.equal(g, b);
  near(g, Math.exp(-ashExtinction(0.2) * 3000), 1e-12);
  // Lower sun, longer path.
  near(sunTransmittance({ ash: 0.2 }, Math.PI / 6)[0], Math.exp(-ashExtinction(0.2) * 3000 * 2), 1e-12);
  const both = sunTransmittance({ smoke: 0.2, ash: 0.1 }, 1),
    smoke = smokeSunTransmittance(0.2, 1),
    grey = sunTransmittance({ ash: 0.1 }, 1)[0];
  for (let i = 0; i < 3; i++) near(both[i], smoke[i] * grey, 1e-15);
  near(sunTransmittance({ spray: 0.5 }, Math.PI / 2)[2], Math.exp(-sprayExtinction(0.5) * 500), 1e-12);
});

test('ash is a neutral grey and spray a white, where smoke is a grey brown', () => {
  const a = ashColor(),
    s = sprayColor(),
    k = smokeColor();
  assert.ok(Math.max(...a) / Math.min(...a) < 1.1, `ash ${a}`);
  assert.ok(a[2] >= a[0], 'ash a touch bluer than red (Toledano et al. 2012: lower albedo toward the red)');
  assert.ok(k[0] / k[2] > Math.max(...a) / Math.min(...a), 'smoke is redder than ash');
  assert.ok(Math.min(...s) > 0.85 && s[0] === s[2], `spray ${s}`);
  assert.ok(Math.min(...s) > Math.max(...a), 'spray is brighter than ash');
});

test('sea spray: Lovett 1978 over the open sea, up to 30 times that at the breakers, wet particles twice the dry radius', () => {
  near(seaSalt(0), Math.exp(1.45), 1e-12);
  near(seaSalt(10), Math.exp(3.05), 1e-12);
  near(seaSalt(10, 0), SURF_ENHANCEMENT * Math.exp(3.05), 1e-9);
  near(seaSalt(10, 2000), (1 + 29 / Math.E) * Math.exp(3.05), 1e-9);
  assert.ok(seaSalt(10, 25000) < 1.001 * seaSalt(10), 'back to the open sea far out');
  near(sprayExtinction(0.4), coarseExtinction(sprayConcentration(0.4), 1.5e-6, 2165) * SPRAY_GROWTH ** 2, 1e-15);
  // The open sea in a fresh breeze is a light haze; the surf zone in a gale is a thick one.
  const open = visibility({ fog: 0, rain: 0, snow: 0, spray: sprayFromWind(10) }),
    surf = visibility({ fog: 0, rain: 0, snow: 0, spray: sprayFromWind(15, 0) }),
    gale = visibility({ fog: 0, rain: 0, snow: 0, spray: sprayFromWind(25, 0) });
  assert.ok(open > 15000 && open < 23000, `open sea at 10 m/s: ${open} m`);
  assert.ok(surf < 5000 && gale < surf && gale > 300, `surf at 15 m/s ${surf} m, at 25 m/s ${gale} m`);
  let last = 0;
  for (const d of [20000, 5000, 1000, 0]) {
    const sp = sprayFromWind(12, d);
    assert.ok(sp > last, 'thicker nearer the breakers');
    last = sp;
  }
  assert.throws(() => seaSalt(-1), RangeError);
  assert.throws(() => seaSalt(5, -1), RangeError);
});

test('load 0 is bit for bit the air before ash and spray, in the extinction, the fog and the drive', () => {
  for (const state of [
    WEATHER_PRESETS.clear,
    WEATHER_PRESETS.storm,
    { ...WEATHER_PRESETS.fog, dust: 0.3, smoke: 0.2 },
  ]) {
    const old =
      CLEAR_AIR_EXTINCTION +
      0.0002 * (100 ** state.fog - 1) +
      3.65e-4 * rainRate(state) ** 0.63 +
      snowExtinction(state.snow) +
      dustExtinction(state.dust) +
      smokeExtinction(state.smoke);
    assert.equal(airExtinction(state), old);
    assert.equal(airExtinction({ ...state, ash: 0, spray: 0 }), old);
    assert.equal(visibility(state), KOSCHMIEDER / old);
    assert.equal(fogForVisibility(500, state), fogForVisibility(500, { ...state, ash: undefined, spray: undefined }));
    const thickness = Math.min(1, state.fog + 0.15 * Math.max(state.rain, state.snow, state.hail));
    assert.equal(
      fogDensity(state),
      0.0002 * (0.02 / 0.0002) ** thickness + dustExtinction(state.dust) + smokeExtinction(state.smoke),
    );
  }
  assert.deepEqual(STATE_FIELDS.ash, [0, 1]);
  assert.deepEqual(STATE_FIELDS.spray, [0, 1]);
  for (const p of Object.values(WEATHER_PRESETS)) assert.equal(p.ash + p.spray, 0);
  // No sea, no eruption: the sky is not touched.
  const atmosphere = { sunIntensity: 1 },
    sky = { name: 'sky', options: { atmosphere, fog: { density: 0.01, falloff: 'exp' } } },
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: new WeatherMachine('clear', { seed: 6 }) });
  drive.setup(engine);
  drive.update(0.5);
  assert.deepEqual(Object.keys(atmosphere), ['sunIntensity']);
  assert.equal('color' in sky.options.fog, false);
  assert.equal(drive.settings.ash, 0);
  assert.equal(drive.settings.spray, 0);
});

test('the drive raises spray over a sea and thickens it near the surf line; sprayFromSea false turns it off', () => {
  const machine = new WeatherMachine('clear', { seed: 4 });
  applyWeatherSettings(machine, { wind: 14, gust: 0 });
  const sea = { name: 'water:1', options: { waves: [] }, setWind() {} },
    engine = engineOf(sea),
    drive = WeatherDrive.attach(engine, { weather: machine, advance: false });
  drive.setup(engine);
  near(drive.update(0).spray, sprayFromWind(14), 1e-12);
  // A breaker line along z = 0 from x = -1 km to 1 km; the camera 500 m off it, then 10 km.
  drive.options.surf = [
    [-1000, 0],
    [1000, 0],
  ];
  drive.options.position = [0, 5, 500];
  near(drive.update(0).spray, sprayFromWind(14, 500), 1e-12);
  drive.options.position = [3000, 5, 0];
  near(drive.update(0).spray, sprayFromWind(14, 2000), 1e-12, 'past the end of the line, the distance to its end');
  drive.options.position = [0, 5, 10000];
  assert.ok(drive.update(0).spray < sprayFromWind(14, 500));
  // The state's own spray is the floor; off, it is the state's.
  applyWeatherSettings(machine, { wind: 14, gust: 0, spray: 0.9 });
  assert.equal(drive.update(0).spray, 0.9);
  applyWeatherSettings(machine, { wind: 14, gust: 0 });
  drive.options.sprayFromSea = false;
  assert.equal(drive.update(0).spray, 0);
  // Surf alone, with no sea found, is a coast too.
  const coast = new WeatherDrive({ weather: machine, surf: [[0, 0]], position: [0, 0, 0], advance: false });
  near(coast.update(0).spray, sprayFromWind(14, 0), 1e-12);
  for (const bad of [[], [[0]], [[0, NaN]], 'line'])
    assert.throws(() => new WeatherDrive({ weather: machine, surf: bad }), TypeError);
});

test('the sky fog takes the ash or spray colour, each by its share of the load, and the sun dims grey', () => {
  const sky = {
      name: 'sky',
      options: { fog: { density: 0.01, falloff: 'exp' }, atmosphere: {} },
      sun: new Float32Array([0, 1, 0]),
    },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  applyWeatherSettings(machine, { ash: 0.5 });
  drive.update(0.5);
  const up = Math.PI / 2,
    lit5 = (c, state) => c.map((v, i) => v * hazeLight(state, up)[i]);
  assert.deepEqual(sky.options.fog.color, lit5(ashColor(), { ash: 0.5 }));
  assert.deepEqual(sky.options.atmosphere.sunColor, sunTransmittance({ ash: 0.5 }, Math.PI / 2));
  applyWeatherSettings(machine, { spray: 0.6 });
  drive.update(0.5);
  assert.deepEqual(sky.options.fog.color, lit5(sprayColor(), { spray: 0.6 }));
  applyWeatherSettings(machine, { ash: 0.4, smoke: 0.4 });
  drive.update(0.5);
  const ae = ashExtinction(0.4),
    se = smokeExtinction(0.4),
    a = ashColor(),
    k = smokeColor();
  const both = hazeLight({ ash: 0.4, smoke: 0.4 }, up);
  for (let i = 0; i < 3; i++) near(sky.options.fog.color[i], ((a[i] * ae + k[i] * se) / (ae + se)) * both[i], 1e-12);
  // Cleared: the fog and the sun get back what they had.
  applyWeatherSettings(machine, {});
  drive.update(0.5);
  assert.equal(sky.options.fog.color, undefined);
  assert.equal(sky.options.atmosphere.sunColor, undefined);
  // ashLight scales the ash's share only.
  const other = { name: 'sky', options: { fog: { density: 0.01, falloff: 'exp' } } },
    lit = WeatherDrive.attach(engineOf(other), { weather: machine, ashLight: 0.5, advance: false });
  lit.setup(engineOf(other));
  applyWeatherSettings(machine, { ash: 0.5 });
  lit.update(0);
  const l5 = hazeLight({ ash: 0.5 }, up);
  for (let i = 0; i < 3; i++) near(other.options.fog.color[i], a[i] * 0.5 * l5[i], 1e-12);
});

// KB-AIR-HAZELIGHT1: the haze was lit at full light under any load, so the thickest smoke or ash read brighter than a
// thin one. The airlight (Koschmieder 1924) is the in-scattered light, which the layer itself takes away.
test('the haze is lit by the light that reaches it through the layer: the fog darkens as smoke, ash or spray thickens', () => {
  assert.deepEqual(hazeLight({}, 0.5), [1, 1, 1]);
  assert.deepEqual(hazeLight({ smoke: 0, ash: 0, spray: 0 }, 1), [1, 1, 1]);
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (const [key, color] of [
    ['smoke', smokeColor],
    ['ash', ashColor],
    ['spray', sprayColor],
  ]) {
    let last = Infinity,
      lastLight = [1, 1, 1];
    for (const load of [0.25, 0.35, 0.5, 0.65, 0.8, 1]) {
      const sky = {
          name: 'sky',
          options: { fog: { density: 0.01, falloff: 'exp' }, atmosphere: {} },
          sun: new Float32Array([0, Math.sin(0.8), Math.cos(0.8)]),
        },
        machine = new WeatherMachine('clear', { seed: 8 }),
        engine = engineOf(sky),
        drive = WeatherDrive.attach(engine, { weather: machine });
      drive.setup(engine);
      applyWeatherSettings(machine, { [key]: load });
      drive.update(0);
      const fog = sky.options.fog.color,
        light = hazeLight({ [key]: load }, Math.asin(sky.sun[1]));
      for (let i = 0; i < 3; i++) {
        assert.ok(
          light[i] > 0 && light[i] < lastLight[i],
          `${key} ${load}: the light on the haze falls, channel ${i}: ${light} after ${lastLight}`,
        );
        assert.ok(light[i] >= sunTransmittance({ [key]: load }, 0.8)[i], 'at least the direct sun that gets through');
        near(fog[i], color()[i] * light[i], 1e-12);
      }
      assert.ok(lum(fog) < last, `${key} ${load}: the fog colour darkens as the load rises: ${fog} after ${last}`);
      last = lum(fog);
      lastLight = light;
    }
  }
  // The thickest looks are dark: a black day's and the ash darkness's haze is lit by under a thousandth of the light.
  assert.ok(lum(hazeLight({ smoke: 0.8 }, 0.8)) < 1e-3 && lum(hazeLight({ ash: 0.8 }, 0.8)) < 1e-3);
  // A thin sea spray barely dims it.
  assert.ok(lum(hazeLight({ spray: 0.12 }, 0.8)) > 0.99);
  assert.throws(() => hazeLight({ ash: 0.2 }, NaN), RangeError);
});

test('ash and spray rows follow the weather while null, set the state, and the looks give their visibility', () => {
  for (const name of ['ash', 'spray']) {
    const row = WEATHER_SETTINGS.find((r) => r.name === name);
    assert.ok(row, name);
    assert.equal(row.default, null);
    assert.equal(row.nullable, true);
    assert.equal(row.live, true);
    assert.equal(row.min, 0);
    assert.equal(row.max, 1);
  }
  assert.equal(weatherStateOf({ ash: 0.3 }).ash, 0.3);
  assert.equal(weatherStateOf({ spray: 0.2 }).spray, 0.2);
  assert.equal(weatherStateOf({}).ash, 0);
  const sight = (look) => visibility(weatherStateOf(WEATHER_LOOKS[look]));
  assert.ok(sight('ashfall') > 600 && sight('ashfall') < 1500, `ashfall ${sight('ashfall')}`);
  assert.ok(sight('ashDarkness') < 250, `ash darkness ${sight('ashDarkness')}`);
  assert.ok(sight('seaSpray') > 8000 && sight('seaSpray') < 18000, `sea spray ${sight('seaSpray')}`);
  assert.ok(sight('surfHaze') > 1500 && sight('surfHaze') < 5000, `surf haze ${sight('surfHaze')}`);
  assert.throws(() => weatherStateOf({ ash: 2 }), RangeError);
});

// Sheet row 8: the drive gave a VolumetricFog the load's density but not its colour, so an ash or smoke volume stayed
// white while the sky fog went grey or brown.
test('a fog volume takes the colour of its dust, smoke, ash and spray by their share of its extinction, with the override rule', async () => {
  const { holdFromWeather } = await import('../../shared/settings.js');
  const volume = { name: 'volumetric-fog', options: { height: 3 } },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(volume),
    drive = WeatherDrive.attach(engine, { weather: machine, advance: false });
  drive.setup(engine);
  // No load: no colour, bit for bit as before.
  applyWeatherSettings(machine, {});
  drive.update(0);
  assert.equal('color' in volume.options, false);
  applyWeatherSettings(machine, { ash: 0.5 });
  drive.update(0);
  const all = volume.options.density,
    ae = ashExtinction(0.5),
    a = ashColor();
  assert.ok(all > ae, 'the volume carries the clear air too');
  for (let i = 0; i < 3; i++) near(volume.options.color[i], (all - ae + ae * a[i]) / all, 1e-12);
  assert.ok(Math.max(...volume.options.color) < 0.9, `ash greys the volume: ${volume.options.color}`);
  // Smoke and dust together: their colours by extinction share, smoke grey brown (red over blue).
  applyWeatherSettings(machine, { smoke: 0.5, dust: 0.3 });
  drive.update(0);
  const se = smokeExtinction(0.5),
    de = dustExtinction(0.3),
    k = smokeColor(),
    d = (await import('../dist/index.js')).dustColor(),
    t = volume.options.density;
  for (let i = 0; i < 3; i++) near(volume.options.color[i], (t - se - de + se * k[i] + de * d[i]) / t, 1e-12);
  assert.ok(volume.options.color[0] > volume.options.color[2]);
  // Spray alone stays near white.
  applyWeatherSettings(machine, { spray: 0.6 });
  drive.update(0);
  assert.ok(Math.min(...volume.options.color) > 0.85 && Math.min(...volume.options.color) < 1);
  // Cleared: the colour goes away again.
  applyWeatherSettings(machine, {});
  drive.update(0);
  assert.equal('color' in volume.options, false);
  // A colour of the person's comes back after the load; a held colour is never written; a volume given a visibility is left.
  volume.options.color = [0.7, 0.6, 0.5];
  applyWeatherSettings(machine, { ash: 0.5 });
  drive.update(0);
  assert.notDeepEqual(volume.options.color, [0.7, 0.6, 0.5]);
  applyWeatherSettings(machine, {});
  drive.update(0);
  assert.deepEqual(volume.options.color, [0.7, 0.6, 0.5]);
  holdFromWeather(volume.options, 'color');
  volume.options.color = [0.2, 0.2, 0.2];
  applyWeatherSettings(machine, { ash: 0.5 });
  drive.update(0);
  assert.deepEqual(volume.options.color, [0.2, 0.2, 0.2], 'a held colour is the override');
  const seen = { name: 'volumetric-fog', options: { visibility: 800 } },
    other = WeatherDrive.attach(engineOf(seen), { weather: machine, advance: false });
  other.setup(engineOf(seen));
  other.update(0);
  assert.equal('color' in seen.options, false, 'a volume with its own visibility is left alone');
});

// Sheet row 8: the surf line was given by hand only; a Water with `terrain.heights` now reports its own breaker line.
test('the drive finds the breaker line of the seas in the scene when no surf line is given; a surf line overrides it', () => {
  const line = [
      [
        [-100, 50],
        [100, 50],
      ],
    ],
    water = { name: 'water:0', options: { waves: [] }, setWind() {}, breakerLine: () => line },
    machine = new WeatherMachine('clear', { seed: 8 });
  applyWeatherSettings(machine, { wind: 12 });
  const at = (position, extra = {}) => {
    const drive = WeatherDrive.attach(engineOf(water), { weather: machine, advance: false, position, ...extra });
    drive.setup(engineOf(water));
    return drive.update(0).spray;
  };
  near(at([0, 2, 50]), sprayFromWind(12, 0), 1e-12);
  near(at([0, 2, 550]), sprayFromWind(12, 500), 1e-12);
  assert.ok(at([0, 2, 50]) > at([0, 2, 10050]) * 3, 'the spray thickens at the breakers');
  near(at([0, 2, 50], { surf: [[0, 1050]] }), sprayFromWind(12, 1000), 1e-12);
  // Without a line (no heights), the open sea's spray.
  const plain = { name: 'water:0', options: {}, setWind() {}, breakerLine: () => [] },
    drive = WeatherDrive.attach(engineOf(plain), { weather: machine, advance: false, position: [0, 2, 50] });
  drive.setup(engineOf(plain));
  near(drive.update(0).spray, sprayFromWind(12), 1e-12);
});

// KB-AIR-SKYLIGHT1: the sky stayed the clear sky under a thick load, so a fog volume's ambient (the horizon sky) was too.
// The drive gives a sky that takes `atmosphere` (airControls) one under a load, and writes the light the layers scatter
// down, hazeLight less the direct share times the sine of the sun's height, as `scatteredLight`; held values and a sky
// without the look feature are left alone, and the value it had comes back when the load clears.
test('the sky under smoke, ash or spray takes the light the layer scatters down, and only a sky that takes it', async () => {
  const { holdFromWeather } = await import('../../shared/settings.js');
  const sun = new Float32Array([0, Math.sin(0.6), Math.cos(0.6)]),
    sky = { name: 'sky', options: {}, sun, airControls: true },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: machine, advance: false });
  drive.setup(engine);
  drive.update(0);
  assert.equal(sky.options.atmosphere, undefined, 'no load: the sky is not touched');
  for (const state of [{ ash: 0.35 }, { smoke: 0.6 }, { spray: 0.4 }]) {
    applyWeatherSettings(machine, state);
    drive.update(0);
    const e = Math.asin(sun[1]),
      t = sunTransmittance(state, e),
      h = hazeLight(state, e),
      want = h.map((v, i) => (v - t[i]) * Math.sin(e));
    for (let i = 0; i < 3; i++) near(sky.options.atmosphere.scatteredLight[i], want[i], 1e-12);
    assert.ok(
      want.every((v) => v > 0),
      `${JSON.stringify(state)} scatters light down: ${want}`,
    );
  }
  // A thicker ash scatters less down: the sky darkens with the load.
  applyWeatherSettings(machine, { ash: 0.35 });
  drive.update(0);
  const thin = [...sky.options.atmosphere.scatteredLight];
  applyWeatherSettings(machine, { ash: 1 });
  drive.update(0);
  assert.ok(
    sky.options.atmosphere.scatteredLight.every((v, i) => v < thin[i]),
    'more ash, a dimmer sky',
  );
  applyWeatherSettings(machine, {});
  drive.update(0);
  assert.equal(sky.options.atmosphere.scatteredLight, undefined, 'cleared: the value it had comes back');
  // A held value stays; a sky without the look feature (no airControls, no look) gets no atmosphere.
  const held = { name: 'sky', options: { atmosphere: { scatteredLight: [0.2, 0.2, 0.2] } }, sun, airControls: true },
    plain = { name: 'sky', options: {}, sun };
  holdFromWeather(held.options.atmosphere, 'scatteredLight');
  for (const target of [held, plain]) {
    const d = WeatherDrive.attach(engineOf(target), { weather: machine, advance: false });
    d.setup(engineOf(target));
    applyWeatherSettings(machine, { ash: 0.35 });
    d.update(0);
  }
  assert.deepEqual(held.options.atmosphere.scatteredLight, [0.2, 0.2, 0.2]);
  assert.equal(plain.options.atmosphere, undefined);
});
