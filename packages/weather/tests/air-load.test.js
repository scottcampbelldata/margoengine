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

test('the sky fog takes the ash or spray colour, each by its share of the load, and the sun dims grey', async () => {
  // The glow held by hand: this sky does not draw the load, so the fog takes the haze's own colour (KB-SKY-HAZEHORIZON1).
  const { holdFromWeather } = await import('../../shared/settings.js'),
    atmosphere = {};
  holdFromWeather(atmosphere, 'scatteredLight');
  const sky = {
      name: 'sky',
      options: { fog: { density: 0.01, falloff: 'exp' }, atmosphere },
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
          options: { fog: { density: 0.01, falloff: 'exp' } },
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

// KB-SKY-NIGHTPALL1: at night under a thick smoke pall the sky dome showed clear stars. The drive writes the layer's
// direct transmittance straight up as `layerTransmittance` (the sky sees its night through it), and the light the moon,
// the twilight and the fires under it put on the layer as part of `scatteredLight`; both come back when the load clears.
test('at night under a pall the sky takes the layer transmittance and its moonlit and firelit glow', async () => {
  const { fireHazeLight, hazeReflectance } = await import('../dist/index.js');
  const sun = new Float32Array([0, -0.4, 0.9]),
    moon = Math.asin(0.5),
    moonUnderClouds = { direction: new Float32Array([0, 0.5, Math.cos(moon), 0.3]), radiance: [0.8, 0.85, 1] },
    sky = { name: 'sky', options: { lighting: { intensity: 2 } }, sun, airControls: true, moonUnderClouds },
    fire = { options: {}, smokeEmission: 0, radiantPower: 4e9 },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: machine, advance: false, fires: fire, smokeFromFire: false });
  drive.setup(engine);
  drive.update(0);
  assert.equal(sky.options.atmosphere, undefined, 'no load: the sky is not touched');
  const state = { smoke: 0.6 };
  applyWeatherSettings(machine, state);
  drive.update(0);
  const a = sky.options.atmosphere,
    zenith = sunTransmittance(state, Math.PI / 2);
  for (let i = 0; i < 3; i++) near(a.layerTransmittance[i], zenith[i], 1e-15);
  assert.ok(
    a.layerTransmittance[2] < 1e-5,
    `a pall that thick lets almost no starlight through: ${a.layerTransmittance}`,
  );
  const through = hazeLight(state, moon),
    direct = sunTransmittance(state, moon),
    back = hazeReflectance(state),
    flames = fireHazeLight(4e9),
    want = [0, 1, 2].map(
      (i) =>
        ((through[i] - direct[i]) * 0.5 * moonUnderClouds.direction[3] * moonUnderClouds.radiance[i]) / 2 +
        back[i] * flames[i],
    );
  for (let i = 0; i < 3; i++) near(a.scatteredLight[i], want[i], 1e-12);
  // At optical depth about 10 in red the slab is nearly semi-infinite: R = g2 / (k + g1) (Meador and Weaver 1980), red albedo 0.89, g 0.62.
  const g1 = 2 - 0.89 * 1.62,
    g2 = 0.89 * 0.38;
  near(back[0], g2 / (Math.sqrt(g1 * g1 - g2 * g2) + g1), 1e-4);
  assert.ok(want[0] > want[2], 'the firelit pall glows warm');
  // Thinner smoke lets more of the night through and glows less.
  applyWeatherSettings(machine, { smoke: 0.05 });
  drive.update(0);
  assert.ok(a.layerTransmittance.every((v, i) => v > zenith[i]));
  applyWeatherSettings(machine, {});
  drive.update(0);
  assert.equal(a.layerTransmittance, undefined, 'cleared: the value it had comes back');
  assert.equal(a.scatteredLight, undefined);
  // The reflectance is the two-stream slab's: none without a load, and R + T = 1 for a slab that absorbs nothing.
  assert.deepEqual(hazeReflectance({}), [0, 0, 0]);
});

// KB-VFX-GLOWUNITS1: the fire columns' glow was referred to a sun of intensity pi while the haze over them takes the
// sky's lighting.intensity; the drive writes that noon sun on the fronts that take one.
test("the drive writes its sky's noon sun on the fires' smoke glow", () => {
  const sky = {
      name: 'sky',
      options: { lighting: { intensity: 5 } },
      sun: new Float32Array([0, 1, 0]),
      airControls: true,
    },
    front = { options: {}, smokeEmission: 0, noon: undefined },
    plain = { options: {}, smokeEmission: 0 },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: machine, advance: false, fires: [front, plain] });
  drive.setup(engine);
  drive.update(0);
  assert.equal(front.noon, 5);
  assert.ok(!('noon' in plain), 'a fire without the setter is left alone');
  delete sky.options.lighting;
  drive.update(0);
  assert.equal(front.noon, 1, "the sky's default intensity");
});

// KB-SKY-PALLFALLOFF1: the fires' light on the pall and the haze was one even glow, so a ridge did not stand out against
// it. A fire that says where it burns lights them by the cosine law from straight over each source, which spreads the
// same P / 2 over the plane, and the sources add; fires that say nothing light them evenly as before.
test('fires that say where they burn light the pall and haze as a spot over each source', async () => {
  const { fireHazeLight, fireLayerLight, hazeReflectance, smokeColor, SMOKE_LAYER_DEPTH } = await import(
      '../dist/index.js'
    ),
    h = SMOKE_LAYER_DEPTH / 2,
    peak = fireLayerLight(4e9);
  near(peak[0], 4e9 / (4 * Math.PI * h * h) / 1000, 1e-12);
  // Over the plane: the upward half of the power. Its mean over the box's disc: fireHazeLight's even value.
  let total = 0,
    disc = 0;
  const rho = 2000 / Math.sqrt(Math.PI);
  for (let r = 0.5; r < 2e6; r += r < 2e4 ? 1 : 100) {
    const e = fireLayerLight(4e9, 0, r)[0] * 1000 * 2 * Math.PI * r * (r < 2e4 ? 1 : 100);
    total += e;
    if (r < rho) disc += e;
  }
  const rel = (a, b, t) => assert.ok(Math.abs(a / b - 1) <= t, `${a} vs ${b}`);
  rel(total, 0.5 * 4e9, 2e-3);
  rel(disc / (2000 * 2000) / 1000, fireHazeLight(4e9)[0], 2e-3);
  assert.ok(fireLayerLight(4e9, 0, 3000)[0] < 0.1 * peak[0], 'falls off away from the fire');
  assert.ok(fireLayerLight(4e9, 800)[0] < peak[0], 'a spread fire is softer');
  assert.throws(() => fireLayerLight(1, -1), /spread/);

  // Two stretches of one front 3 km apart: the west one two segments 200 m apart, 3 GW; the east one 2 GW. The
  // radiant power is shared by the segments' convective heat.
  const sun = new Float32Array([0, -0.4, 0.9]),
    sky = { name: 'sky', options: { lighting: { intensity: 2 }, fog: { falloff: 'exp' } }, sun, airControls: true },
    segments = [
      { x: -1600, y: 40, z: -1200, heat: 2e9 },
      { x: -1400, y: 70, z: -1200, heat: 1e9 },
      { x: 1400, y: 80, z: -600, heat: 2e9 },
      { x: 0, y: 0, z: 0, heat: 0 },
    ],
    west = { x: -4600 / 3, y: 50, z: -1200, spread: 0, power: 3e9 },
    east = { x: 1400, y: 80, z: -600, spread: 0, power: 2e9 },
    placed = { options: {}, smokeEmission: 0, radiantPower: 5e9, segments: () => segments },
    unplaced = { options: {}, smokeEmission: 0, radiantPower: 1e9 },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, {
      weather: machine,
      advance: false,
      fires: [placed, unplaced],
      smokeFromFire: false,
    });
  // The west stretch's RMS distance: 2/3 of its power 200/3 m off its centre, 1/3 of it 400/3 m off.
  west.spread = Math.sqrt((2 * (200 / 3) ** 2 + (400 / 3) ** 2) / 3);
  drive.setup(engine);
  applyWeatherSettings(machine, { smoke: 0.6 });
  drive.update(0);
  const a = sky.options.atmosphere,
    fog = sky.options.fog,
    back = hazeReflectance({ smoke: 0.6 });
  assert.equal(a.fireSpots.length, 2);
  assert.equal(fog.fireSpots.length, 2);
  for (const [k, src] of [west, east].entries()) {
    const light = fireLayerLight(src.power, src.spread),
      on = a.fireSpots[k],
      hz = fog.fireSpots[k];
    near(on.x, src.x, 1e-12);
    near(on.height, src.y + h, 1e-12);
    near(on.z, src.z, 1e-12);
    near(on.reach, Math.hypot(h, src.spread), 1e-12);
    for (let i = 0; i < 3; i++) near(on.color[i], back[i] * light[i], 1e-12);
    // The haze falls off round the same point by the same law, in the haze's own colour.
    assert.deepEqual([hz.x, hz.z, hz.reach], [on.x, on.z, on.reach]);
    for (let i = 0; i < 3; i++) near(hz.color[i], smokeColor()[i] * light[i], 1e-12);
  }
  // The even share holds only the fire that says nothing.
  const even = fireHazeLight(1e9);
  for (let i = 0; i < 3; i++) near(a.scatteredLight[i], back[i] * even[i], 1e-12);
  // A low ray sees the layer as far across as the haze's light comes from.
  near(a.fireSight, 2 / fog.density, 1e-9);

  // More places than the sky takes spots, over two fires: eight sources, the two 100 m apart as one at their centre,
  // none of the power lost.
  const at = (x) => ({ x, y: 0, z: 0, heat: 1e9 }),
    long = Array.from({ length: 9 }, (_, i) => at(i * 1000));
  placed.segments = () => long;
  placed.radiantPower = 9e9;
  unplaced.segments = () => [at(8100)];
  drive.update(0);
  assert.equal(a.fireSpots.length, 8);
  assert.deepEqual([...a.scatteredLight], [0, 0, 0], 'every fire is placed');
  const merged = a.fireSpots.find((s) => Math.abs(s.x - 8050) < 1e-9);
  assert.ok(merged, 'the pair 100 m apart merged: ' + a.fireSpots.map((s) => s.x));
  near(merged.reach, Math.hypot(h, 50), 1e-12);
  const lit = fireLayerLight(2e9, 50);
  for (let i = 0; i < 3; i++) near(merged.color[i], back[i] * lit[i], 1e-12);
  const again = a.fireSpots;
  drive.update(0);
  assert.deepEqual(a.fireSpots, again, 'the same fires, the same spots');

  // fireLight 0 leaves the fires out.
  drive.options.fireLight = 0;
  drive.update(0);
  assert.equal(a.fireSpots, undefined);
  assert.equal(fog.fireSpots, undefined);
  delete drive.options.fireLight;
  drive.update(0);
  assert.equal(a.fireSpots.length, 8);
  // When the smoke clears the sky gets its own values back.
  applyWeatherSettings(machine, { smoke: 0 });
  drive.update(0);
  assert.equal(a.fireSpots, undefined);
  assert.equal(a.fireSight, undefined);
  assert.equal(fog.fireSpots, undefined);
});

// KB-VFX-COLUMNAMBIENT1: a front's smoke columns took no light from the firelit pall round them, so over a burning valley
// at night they read blue-black against it. The drive writes the pall's light over each front on its `air`: the spots'
// light at the front's heat-weighted centre; a fire with no segments gets the even light; one without the setter none.
test("the drive writes the firelit pall's light on each front's smoke air", async () => {
  const { fireLayerLight, fireHazeLight } = await import('../dist/index.js'),
    sky = { name: 'sky', options: { lighting: { intensity: 5 } }, sun: new Float32Array([0, 1, 0]), airControls: true },
    segs = [
      { x: 0, y: 0, z: 0, heat: 6e8 },
      { x: 30, y: 0, z: 0, heat: 4e8 },
    ],
    front = { options: {}, smokeEmission: 0, radiantPower: 2e9, air: undefined, segments: () => segs },
    even = { options: {}, smokeEmission: 0, radiantPower: 1e9, air: undefined },
    plain = { options: {}, smokeEmission: 0, radiantPower: 1e9 },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: machine, advance: false, fires: [front, even, plain] });
  drive.setup(engine);
  drive.update(0);
  assert.ok(front.air && front.air.length === 3, 'the front takes the light');
  // The even light of the two fires that say nothing of where they burn, plus the spots at the front's centre.
  const flat = fireHazeLight(2e9);
  for (let i = 0; i < 3; i++) assert.ok(front.air[i] > flat[i] * 0.999, `channel ${i} at least the even light`);
  assert.ok(front.air[0] > front.air[1] && front.air[1] > front.air[2], 'the flames orange');
  assert.ok(front.air[0] >= fireLayerLight(1e9, 0, 30)[0], 'at least a spot 30 m off');
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(even.air[i] - flat[i]) <= flat[i] * 1e-9, 'a fire with no segments takes the even light alone');
  assert.ok(!('air' in plain), 'a fire without the setter is left alone');
  front.radiantPower = 0;
  even.radiantPower = 0;
  plain.radiantPower = 0;
  drive.update(0);
  assert.equal(front.air, undefined, 'no fire, no light');
});
