// Smoke: the visibility it leaves (4 m2/g of mass extinction, Reid et al. 2005, with Koschmieder), the sun it dims and
// reddens (optical depth over a layer, an Angstrom exponent of 1.8, Eck et al. 1999), the haze colour, the state field,
// the row and looks, and the drive that dims the sky's sun, tints its fog and takes smoke from a fire front.
// Every bound is checked against the numbers of the cited papers (see air.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRE_LIGHT_COLOR,
  NOON_IRRADIANCE,
  fireHazeLight,
  hazeLight,
  SMOKE_ANGSTROM,
  SMOKE_AT_FULL,
  SMOKE_LAYER_DEPTH,
  SMOKE_MASS_EXTINCTION,
  STATE_FIELDS,
  WEATHER_PRESETS,
  WeatherMachine,
  airExtinction,
  dustColor,
  dustExtinction,
  fogDensity,
  fogForVisibility,
  resolveState,
  smokeColor,
  smokeConcentration,
  smokeExtinction,
  smokeExtinctionOf,
  smokeFromEmission,
  smokeOpticalDepth,
  smokeSunTransmittance,
  smokeVisibility,
  visibility,
} from '../dist/index.js';
import { WeatherDrive, driveSettings } from '../dist/drive.js';
import { WEATHER_LOOKS, WEATHER_SETTINGS, applyWeatherSettings, weatherStateOf } from '../dist/settings.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
const deg = (d) => (d * Math.PI) / 180;
const engineOf = (...plugins) => ({
  plugins: new Map(plugins.map((p) => [p.name, p])),
  use: () => {},
  removePlugin: () => {},
});

test('the extinction of smoke is 4 m2/g of the PM2.5 mass and the visibility is Koschmieder over it', () => {
  assert.equal(SMOKE_MASS_EXTINCTION, 4);
  assert.equal(SMOKE_AT_FULL, 5000);
  near(smokeExtinctionOf(1), 4e-6, 1e-18);
  near(smokeExtinctionOf(250), 1e-3, 1e-15);
  // 1,000 micrograms: 4 mm^-1 x 1e-3 = 0.004 per metre, 3.912 / 0.004 = 978 m. 5,000: 196 m, the same as fog 1.
  near(smokeVisibility(1000), 978, 0.01);
  near(smokeVisibility(SMOKE_AT_FULL), 195.6, 0.01);
  assert.equal(smokeVisibility(0), Infinity);
  assert.equal(smokeConcentration(1), 5000);
  assert.equal(smokeConcentration(0.2), 200);
  assert.equal(smokeConcentration(2), 5000, 'clamped');
  assert.equal(smokeConcentration(-1), 0);
  assert.throws(() => smokeExtinctionOf(-1), RangeError);
  assert.throws(() => smokeExtinctionOf(NaN), RangeError);
  assert.throws(() => smokeVisibility(Infinity), RangeError);
});

test('smoke 0 changes nothing: the air, the visibility, the fog density and the drive settings are the smokeless values bit for bit', () => {
  const state = resolveState('overcast');
  assert.equal(state.smoke, 0);
  const without = { fog: state.fog, rain: state.rain, snow: state.snow, dust: state.dust };
  assert.equal(airExtinction({ ...without, smoke: 0 }), airExtinction(without));
  assert.equal(visibility({ ...without, smoke: 0 }), visibility(without));
  assert.equal(smokeExtinction(0), 0);
  assert.deepEqual(smokeSunTransmittance(0, 0.7), [1, 1, 1]);
  assert.deepEqual(smokeSunTransmittance(0, -2), [1, 1, 1]);
  assert.equal(fogDensity(state), fogDensity({ ...state, smoke: 0 }));
  const a = driveSettings(state),
    b = driveSettings({ ...state, smoke: 0 });
  assert.deepEqual(a, b);
  assert.equal(a.smoke, 0);
});

test('smoke adds its extinction to the air, the visibility and the fog density, and fogForVisibility leaves room for it', () => {
  const base = { fog: 0, rain: 0, snow: 0, dust: 0 };
  near(airExtinction({ ...base, smoke: 0.5 }) - airExtinction(base), smokeExtinction(0.5), 1e-15);
  near(smokeExtinction(0.5), 4e-6 * 1250, 1e-15);
  // 0.5 smoke: PM2.5 1,250, 0.005 per metre, about 780 m by itself.
  near(3.912 / smokeExtinction(0.5), 782.4, 0.01);
  const v = visibility({ ...base, smoke: 0.5 });
  assert.ok(v < 782.4 && v > 700, `${v}`);
  const fogged = { ...resolveState('clear'), smoke: 0.5 };
  assert.ok(fogDensity(fogged) > fogDensity(resolveState('clear')) + 0.0049);
  // The fog that leaves 500 m with this smoke in the air, then the visibility is 500 m.
  const fog = fogForVisibility(500, { rain: 0, snow: 0, smoke: 0.5 });
  near(visibility({ fog, rain: 0, snow: 0, smoke: 0.5 }), 500, 1e-6);
  assert.equal(fogForVisibility(1500, { rain: 0, snow: 0, smoke: 0.5 }), 0, 'smoke alone already leaves less');
});

test('the sun through smoke: dimmer with more smoke and a lower sun, and redder because blue goes first (Angstrom 1.8)', () => {
  assert.equal(SMOKE_ANGSTROM, 1.8);
  assert.equal(SMOKE_LAYER_DEPTH, 2000);
  // 0.2 smoke: PM2.5 200, extinction 8e-4 per metre, optical depth 1.6 over 2 km at 550 nm.
  near(smokeOpticalDepth(0.2), 1.6, 1e-12);
  const noon = smokeSunTransmittance(0.2, Math.PI / 2);
  near(noon[1], Math.exp(-1.6), 1e-12);
  near(noon[0], Math.exp(-1.6 * (670 / 550) ** -1.8), 1e-12);
  near(noon[2], Math.exp(-1.6 * (440 / 550) ** -1.8), 1e-12);
  assert.ok(noon[0] > noon[1] && noon[1] > noon[2], 'red passes, blue is taken');
  assert.ok(noon[0] / noon[2] > 3, `a red sun, red over blue ${noon[0] / noon[2]}`);
  // Lower sun, longer path, 1 / sin(elevation).
  const low = smokeSunTransmittance(0.2, deg(30));
  near(low[1], Math.exp(-1.6 / Math.sin(deg(30))), 1e-12);
  assert.ok(low.every((t, i) => t < noon[i]));
  // More smoke dims more; the order is strict.
  const thick = smokeSunTransmittance(0.6, Math.PI / 2);
  assert.ok(thick.every((t, i) => t < noon[i]));
  assert.ok(thick[1] < 1e-5, 'a black day leaves no direct sun');
  // Below 3 degrees the air mass stops growing, so a sun at the horizon or under it is finite.
  assert.deepEqual(smokeSunTransmittance(0.2, deg(3)), smokeSunTransmittance(0.2, deg(-20)));
  assert.ok(Number.isFinite(smokeSunTransmittance(0.2, 0)[0]));
  assert.throws(() => smokeSunTransmittance(0.2, NaN), RangeError);
});

test('the smoke colour is a grey brown, red over green over blue, a little less yellow than dust', () => {
  const c = smokeColor(),
    d = dustColor();
  assert.ok(c[0] > c[1] && c[1] > c[2], `${c}`);
  assert.ok(
    c.every((x) => x > 0.2 && x < 0.7),
    `${c}`,
  );
  // Smoke is darker than desert dust: its albedo is lower (0.84 to 0.89 against 0.92 to 0.96).
  assert.ok(
    c.every((x, i) => x < d[i]),
    `${c} vs ${d}`,
  );
  assert.deepEqual(smokeColor(), c, 'a pure function');
});

test('a fire of so many grams a second makes the smoke a box model gives', () => {
  // 4,000 g/s in 5 m/s over 2 km wide and 2 km deep: 4e9 micrograms / (5 x 2000 x 2000) = 200 micrograms, smoke 0.2.
  near(smokeFromEmission(4000, 5), 0.2, 1e-12);
  assert.equal(smokeFromEmission(0, 5), 0);
  assert.equal(smokeFromEmission(1e12, 5), 1, 'capped');
  // Half the wind or twice the fire raises the concentration; the smoke follows its square root.
  near(smokeFromEmission(4000, 2.5) / smokeFromEmission(4000, 5), Math.SQRT2, 1e-12);
  assert.equal(smokeFromEmission(4000, 0), smokeFromEmission(4000, 1), 'a calm is taken as 1 m/s');
  near(smokeFromEmission(4000, 5, 1000) / smokeFromEmission(4000, 5, 2000), Math.SQRT2, 1e-12);
  assert.throws(() => smokeFromEmission(-1, 5), RangeError);
  assert.throws(() => smokeFromEmission(1, -5), RangeError);
  assert.throws(() => smokeFromEmission(1, 5, 0), RangeError);
});

test('the state holds smoke 0 to 1, the master row follows the storm level, and the looks leave the visibility they name', () => {
  assert.deepEqual(STATE_FIELDS.smoke, [0, 1]);
  for (const name of Object.keys(WEATHER_PRESETS)) assert.equal(WEATHER_PRESETS[name].smoke, 0, name);
  const row = WEATHER_SETTINGS.find((r) => r.name === 'smoke');
  assert.ok(row && row.default === null, 'follows the storm level');
  assert.equal(weatherStateOf({}).smoke, 0);
  assert.equal(weatherStateOf({ smoke: 0.3 }).smoke, 0.3);
  const km = (look) => visibility(weatherStateOf(WEATHER_LOOKS[look])) / 1000;
  assert.ok(km('smokeHaze') > 5 && km('smokeHaze') < 8, `${km('smokeHaze')}`);
  assert.ok(km('wildfireSmoke') > 1.2 && km('wildfireSmoke') < 2, `${km('wildfireSmoke')}`);
  assert.ok(km('blackDay') > 0.2 && km('blackDay') < 0.4, `${km('blackDay')}`);
  // A smoke haze reddens the noon sun; a black day takes it.
  assert.ok(smokeSunTransmittance(0.15, Math.PI / 2)[0] > 0.3);
  assert.ok(smokeSunTransmittance(0.8, Math.PI / 2)[0] < 1e-6);
  const m = new WeatherMachine('clear', { seed: 2 });
  applyWeatherSettings(m, { smoke: 0.4 });
  assert.equal(m.state.smoke, 0.4);
  assert.throws(() => applyWeatherSettings(m, { smoke: 2 }), RangeError);
});

test('the drive dims and reddens the sun of the sky, never touches it with no smoke, and gives the colour back', () => {
  const machine = new WeatherMachine('clear', { seed: 6 }),
    atmosphere = { sunIntensity: 1 },
    sky = { name: 'sky', options: { atmosphere }, sun: new Float32Array([0, 1, 0]) },
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  drive.update(0.5);
  assert.deepEqual(Object.keys(atmosphere), ['sunIntensity'], 'no smoke: nothing written');
  applyWeatherSettings(machine, { smoke: 0.2 });
  drive.update(0.5);
  assert.deepEqual(atmosphere.sunColor, smokeSunTransmittance(0.2, Math.PI / 2));
  // A lower sun is dimmer still.
  sky.sun.set([0.866, 0.5, 0]);
  drive.update(0.5);
  near(atmosphere.sunColor[1], Math.exp(-1.6 / 0.5), 1e-6);
  // Smoke gone: the sun colour had none, so it goes again.
  applyWeatherSettings(machine, { smoke: 0 });
  drive.update(0.5);
  assert.equal('sunColor' in atmosphere, false);
  // A sun colour the sky had comes back and is multiplied meanwhile; one a person changes in between is the one to come back to.
  atmosphere.sunColor = [1, 0.9, 0.8];
  applyWeatherSettings(machine, { smoke: 0.1 });
  sky.sun.set([0, 1, 0]);
  drive.update(0.5);
  const t = smokeSunTransmittance(0.1, Math.PI / 2);
  near(atmosphere.sunColor[0], t[0], 1e-12);
  near(atmosphere.sunColor[1], 0.9 * t[1], 1e-12);
  near(atmosphere.sunColor[2], 0.8 * t[2], 1e-12);
  atmosphere.sunColor = [2, 2, 2];
  drive.update(0.5);
  near(atmosphere.sunColor[0], 2 * t[0], 1e-12);
  applyWeatherSettings(machine, { smoke: 0 });
  drive.update(0.5);
  assert.deepEqual(atmosphere.sunColor, [2, 2, 2]);
});

test('a sky with a look but no atmosphere gets one for the sun; a sky with neither is left alone', () => {
  const machine = new WeatherMachine('clear', { seed: 6 });
  applyWeatherSettings(machine, { smoke: 0.2 });
  const looked = { name: 'sky', options: { look: {} } },
    plain = { name: 'sky', options: { clouds: { coverage: 0.1 } } };
  for (const [sky, made] of [
    [looked, true],
    [plain, false],
  ]) {
    const engine = engineOf(sky),
      drive = WeatherDrive.attach(engine, { weather: machine });
    drive.setup(engine);
    drive.update(0.5);
    assert.equal(sky.options.atmosphere !== undefined, made);
    if (made)
      assert.deepEqual(
        sky.options.atmosphere.sunColor,
        smokeSunTransmittance(0.2, Math.PI / 2),
        'no sun vector: the zenith',
      );
  }
});

// KB-SKY-PALLHAZE1: the fog colour was the haze's share of a white surface's light drawn as it was, while the sky draws
// the same layer's light (scatteredLight) as that share times its zenith sun over pi, at its exposure and picture scale:
// about 2.2 times brighter under a sun of 5, so a far ridge under the pall was a dark cut-out against the sky. A sky
// with `zenithSun` gets the haze in its own drawn units.
test('the fog colour under a load is in the units the sky draws its haze in (KB-SKY-PALLHAZE1)', async () => {
  // The glow held by hand, so this sky does not draw the load and the drive writes the haze's own colour.
  const { holdFromWeather } = await import('../../shared/settings.js'),
    atmosphere = { sunIntensity: 1.5 };
  holdFromWeather(atmosphere, 'scatteredLight');
  const zenithSun = 4 * Math.PI * 0.55,
    pictureScale = 5 / zenithSun,
    sky = {
      name: 'sky',
      zenithSun,
      pictureScale,
      options: { exposure: -0.6, fog: { density: 0.01, falloff: 'exp' }, atmosphere },
    },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  applyWeatherSettings(machine, { smoke: 0.5 });
  drive.update(0.5);
  const l5 = hazeLight({ smoke: 0.5 }, Math.PI / 2),
    k = (zenithSun * 1.5 * 2 ** -0.6 * pictureScale) / Math.PI;
  for (let i = 0; i < 3; i++) near(sky.options.fog.color[i], smokeColor()[i] * l5[i] * k, 1e-12);
  // Balanced by day (pictureScale = lightScale), a share of 1 is the engine sun's 5 on a white surface, 5 / pi.
  near(k, (5 * 1.5 * 2 ** -0.6) / Math.PI, 1e-12);
});

// KB-SKY-HAZEHORIZON1: under a smoke pall the drive wrote the fog a colour of its own, so a far ridge, all haze, ended
// at that colour and not at the sky drawn right above it: in timber-valley's ridge-smoke shot an orange (119, 73, 10)
// wedge cut hard against a brown sky of (98, 66, 24). A long enough path ends at the horizon sky (Koschmieder 1924).
test('a sky that draws the load leaves the fog on its own radiance, gives back the colour after, and dust still tints', async () => {
  const { holdFromWeather } = await import('../../shared/settings.js');
  for (const extra of [{ options: { atmosphere: {} } }, { options: { look: {} } }, { airControls: true, options: {} }]) {
    const sky = {
        name: 'sky',
        zenithSun: 4 * Math.PI * 0.55,
        ...extra,
        options: { fog: { density: 0.01, falloff: 'exp', color: [0.3, 0.4, 0.5] }, ...extra.options },
      },
      machine = new WeatherMachine('clear', { seed: 8 }),
      engine = engineOf(sky),
      drive = WeatherDrive.attach(engine, { weather: machine });
    drive.setup(engine);
    for (const load of [{ smoke: 0.5 }, { ash: 0.5 }, { spray: 0.6 }, { smoke: 0.3, ash: 0.3 }]) {
      applyWeatherSettings(machine, load);
      drive.update(0.5);
      assert.equal(sky.options.fog.color, undefined, JSON.stringify(load));
    }
    // Dust is not in the sky's pall, so a load with dust keeps the haze's own colour.
    applyWeatherSettings(machine, { dust: 0.5, smoke: 0.2 });
    drive.update(0.5);
    assert.equal(sky.options.fog.color.length, 3);
    applyWeatherSettings(machine, { smoke: 0.5 });
    drive.update(0.5);
    assert.equal(sky.options.fog.color, undefined);
    applyWeatherSettings(machine, {});
    drive.update(0.5);
    assert.deepEqual(sky.options.fog.color, [0.3, 0.4, 0.5]);
  }
  // A sky with no atmosphere, look or air controls, or one whose glow or sun colour is held, does not draw the load.
  for (const [options, key] of [[{}, undefined], [{ atmosphere: {} }, 'scatteredLight'], [{ atmosphere: {} }, 'sunColor']]) {
    if (key) holdFromWeather(options.atmosphere, key);
    const sky = { name: 'sky', options: { fog: { density: 0.01, falloff: 'exp' }, ...options } },
      machine = new WeatherMachine('clear', { seed: 8 }),
      engine = engineOf(sky),
      drive = WeatherDrive.attach(engine, { weather: machine });
    drive.setup(engine);
    applyWeatherSettings(machine, { smoke: 0.5 });
    drive.update(0.5);
    assert.equal(sky.options.fog.color.length, 3, String(key));
  }
});

test('the sky fog takes the smoke colour while smoke is most of the air, and a mix of dust and smoke by their extinction share', () => {
  const sky = { name: 'sky', options: { fog: { density: 0.01, falloff: 'exp' } } },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  applyWeatherSettings(machine, { smoke: 0.5 });
  drive.update(0.5);
  // Lit by the light that reaches the air through the smoke (no sun vector: the zenith).
  const up = Math.PI / 2,
    l5 = hazeLight({ smoke: 0.5 }, up);
  assert.deepEqual(
    sky.options.fog.color,
    smokeColor().map((c, i) => c * l5[i]),
  );
  near(sky.options.fog.density, Math.min(1, drive.settings.extinction), 1e-12);
  assert.ok(drive.settings.extinction > smokeExtinction(0.5));
  // Dust and smoke together: a blend weighted by extinction.
  applyWeatherSettings(machine, { smoke: 0.5, dust: 0.5 });
  drive.update(0.5);
  const de = dustExtinction(0.5),
    se = smokeExtinction(0.5),
    w = de / (de + se),
    dc = dustColor(),
    sc = smokeColor();
  for (let i = 0; i < 3; i++) near(sky.options.fog.color[i], (dc[i] * w + sc[i] * (1 - w)) * l5[i], 1e-12);
  // Dust alone is the dust colour exactly, as before smoke existed.
  applyWeatherSettings(machine, { smoke: 0, dust: 0.5 });
  drive.update(0.5);
  assert.deepEqual(sky.options.fog.color, dustColor());
  // Neither: the fog has the colour it had.
  applyWeatherSettings(machine, { dust: 0 });
  drive.update(0.5);
  assert.equal(sky.options.fog.color, undefined);
  // smokeLight scales the tint.
  const lit = WeatherDrive.attach(engine, { weather: machine, smokeLight: 0.5, advance: false });
  lit.setup(engine);
  applyWeatherSettings(machine, { smoke: 0.5 });
  lit.update(0);
  near(sky.options.fog.color[0], smokeColor()[0] * 0.5 * l5[0], 1e-12);
  assert.throws(() => WeatherDrive.attach(engine, { weather: machine, smokeLight: -1 }), RangeError);
  assert.throws(() => WeatherDrive.attach(engine, { weather: machine, smokeWidth: 0 }), RangeError);
  assert.throws(() => WeatherDrive.attach(engine, { weather: machine, smokeFromFire: 'yes' }), TypeError);
});

test('a fire front in the scene raises the weather smoke by its emission; none, or smokeFromFire false, leaves it', () => {
  const sky = { name: 'sky', options: { atmosphere: {} }, sun: new Float32Array([0, 1, 0]) },
    fire = { name: 'fire-front:1', options: {}, smokeEmission: 4000 },
    machine = new WeatherMachine('clear', { seed: 9 });
  applyWeatherSettings(machine, { wind: 5, gust: 0 });
  const engine = engineOf(sky, fire),
    drive = WeatherDrive.attach(engine, { weather: machine });
  drive.setup(engine);
  drive.update(0.5);
  near(drive.settings.smoke, smokeFromEmission(4000, machine.state.wind), 1e-12);
  assert.ok(drive.settings.smoke > 0.05);
  assert.deepEqual(sky.options.atmosphere.sunColor, smokeSunTransmittance(drive.settings.smoke, Math.PI / 2));
  // Two fires add their emission; the state's own smoke is the floor.
  const second = { name: 'fire-front:2', options: {}, smokeEmission: 4000 },
    both = engineOf(sky, fire, second),
    drive2 = WeatherDrive.attach(both, { weather: machine, advance: false });
  drive2.setup(both);
  drive2.update(0);
  near(drive2.settings.smoke, smokeFromEmission(8000, machine.state.wind), 1e-12);
  applyWeatherSettings(machine, { smoke: 0.9 });
  drive2.update(0);
  assert.equal(drive2.settings.smoke, 0.9);
  // Off, or a fire that is out: the smoke is the state's.
  applyWeatherSettings(machine, { smoke: null });
  const off = WeatherDrive.attach(engine, { weather: machine, smokeFromFire: false, advance: false });
  off.setup(engine);
  off.update(0);
  assert.equal(off.settings.smoke, 0);
  fire.smokeEmission = 0;
  const out = WeatherDrive.attach(engine, { weather: machine, advance: false });
  out.setup(engine);
  out.update(0);
  assert.equal(out.settings.smoke, 0);
  // A target handed in is used; one without a number is a TypeError of the drive's options.
  const given = WeatherDrive.attach(engineOf(sky), {
    weather: machine,
    fires: { options: {}, smokeEmission: 4000 },
    advance: false,
  });
  given.setup(engineOf(sky));
  given.update(0);
  assert.ok(given.settings.smoke > 0.05);
});

test('the smoke haze hands its sunlight over to the moon and twilight at night, by the sky blend (KB-WEATHER-NIGHTHAZE1)', () => {
  // A sky at night: the sun 20 degrees down (blend 1), the moon 18 degrees up at 0.25 of the noon sun's 5, bluish.
  const up = deg(18),
    moon = { direction: [0, Math.sin(up), Math.cos(up), 0.25], radiance: [0.8, 0.9, 1.1] },
    twilight = { direction: [0, Math.SQRT1_2, Math.SQRT1_2, 0], radiance: [1, 1, 1] },
    sky = {
      name: 'sky',
      options: { fog: { density: 0.01, falloff: 'exp' }, lighting: { intensity: 5 } },
      sun: [0, -Math.sin(deg(20)), Math.cos(deg(20))],
      nightFactor: 1,
      moonUnderClouds: moon,
      twilightLight: twilight,
    },
    machine = new WeatherMachine('clear', { seed: 8 }),
    engine = engineOf(sky),
    drive = WeatherDrive.attach(engine, { weather: machine, advance: false });
  drive.setup(engine);
  applyWeatherSettings(machine, { smoke: 0.5 });
  drive.update(0);
  const through = hazeLight({ smoke: 0.5 }, up),
    night = sky.options.fog.color;
  for (let i = 0; i < 3; i++) near(night[i], smokeColor()[i] * ((0.25 * moon.radiance[i]) / 5) * through[i], 1e-12);
  // Far darker than the sunlit haze, and bluer: blue over red rises from the smoke's to the moon's.
  const noon = smokeColor().map((c, i) => c * hazeLight({ smoke: 0.5 }, Math.PI / 2)[i]);
  for (let i = 0; i < 3; i++) assert.ok(night[i] < noon[i] / 10, `${night[i]} vs ${noon[i]}`);
  assert.ok(night[2] / night[0] > noon[2] / noon[0]);
  // Half way through the handover: the mean of the two lights, with the sun's share at the sun's elevation.
  sky.nightFactor = 0.5;
  sky.sun = [0, Math.sin(deg(1)), Math.cos(deg(1))];
  twilight.direction[3] = 0.02;
  drive.update(0);
  const day = hazeLight({ smoke: 0.5 }, deg(1)),
    sideways = hazeLight({ smoke: 0.5 }, Math.PI / 4);
  for (let i = 0; i < 3; i++)
    near(
      sky.options.fog.color[i],
      smokeColor()[i] *
        (0.5 * day[i] + (0.5 * (0.25 * moon.radiance[i] * through[i] + 0.02 * twilight.radiance[i] * sideways[i])) / 5),
      1e-12,
    );
  // Without a nightFactor the sky's own smoothstep of its sun is taken: 20 degrees down is full night.
  delete sky.nightFactor;
  sky.sun = [0, -Math.sin(deg(20)), Math.cos(deg(20))];
  twilight.direction[3] = 0;
  drive.update(0);
  for (let i = 0; i < 3; i++) near(sky.options.fog.color[i], night[i], 1e-12);
  // A dust haze at night is moonlit too; by day it keeps the dust colour exactly.
  applyWeatherSettings(machine, { smoke: 0, dust: 0.5 });
  drive.update(0);
  for (let i = 0; i < 3; i++) near(sky.options.fog.color[i], dustColor()[i] * ((0.25 * moon.radiance[i]) / 5), 1e-12);
  sky.nightFactor = 0;
  drive.update(0);
  assert.deepEqual(sky.options.fog.color, dustColor());
});

test('fires light the smoke haze from below by their radiant power, so a burning valley glows at night (KB-WEATHER-FIREHAZE1)', () => {
  // The box: half the radiant power upward, the share through a disc of the box's area at the layer's middle, over it.
  const h = SMOKE_LAYER_DEPTH / 2,
    rho = 2000 / Math.sqrt(Math.PI),
    share = (0.5 * 1e10 * (1 - h / Math.hypot(h, rho))) / (2000 * 2000) / NOON_IRRADIANCE;
  const light = fireHazeLight(1e10);
  for (let i = 0; i < 3; i++) near(light[i], FIRE_LIGHT_COLOR[i] * share, 1e-12);
  assert.ok(light[0] > light[1] && light[1] > light[2], 'the flames light it orange');
  assert.deepEqual(fireHazeLight(0), [0, 0, 0]);
  near(fireHazeLight(2e10)[0], 2 * light[0], 1e-12);
  assert.ok(fireHazeLight(1e10, 8000)[0] < light[0] / 4, 'a wider box spreads the light thinner');
  assert.throws(() => fireHazeLight(-1), RangeError);
  assert.throws(() => fireHazeLight(1, 0), RangeError);
  // A moonless night (no moon, no twilight): the haze over a fire that reports no light is black, as before the fix.
  const sky = {
      name: 'sky',
      options: { fog: { density: 0.01, falloff: 'exp' }, lighting: { intensity: 5 } },
      sun: [0, -Math.sin(deg(20)), Math.cos(deg(20))],
      nightFactor: 1,
    },
    fire = { name: 'fire-front:1', options: {}, smokeEmission: 36000 },
    machine = new WeatherMachine('clear', { seed: 8 });
  applyWeatherSettings(machine, { wind: 5, gust: 0 });
  const engine = engineOf(sky, fire),
    drive = WeatherDrive.attach(engine, { weather: machine, advance: false });
  drive.setup(engine);
  drive.update(0);
  assert.deepEqual(sky.options.fog.color, [0, 0, 0]);
  // The same fire reporting its radiant power (the 0.3 of the release that made the smoke, FireFront.radiantPower):
  // the haze is the smoke colour times the flames' light on it, orange and bright enough to see.
  fire.radiantPower = (0.3 * 36000 * 18.622e6) / 15;
  drive.update(0);
  const glow = fireHazeLight(fire.radiantPower),
    lit = sky.options.fog.color;
  for (let i = 0; i < 3; i++) near(lit[i], smokeColor()[i] * glow[i], 1e-12);
  assert.ok(lit[0] > 0.02, `a 45 GW blowup lights the haze to ${lit[0]} of the noon haze's white`);
  assert.ok(lit[0] > 2 * lit[1] && lit[1] > 2 * lit[2], `orange: ${lit}`);
  // fireLight scales it and 0 turns it off; moonlight adds to it.
  const half = WeatherDrive.attach(engine, { weather: machine, advance: false, fireLight: 0.5 });
  half.setup(engine);
  half.update(0);
  for (let i = 0; i < 3; i++) near(sky.options.fog.color[i], lit[i] / 2, 1e-12);
  const off = WeatherDrive.attach(engine, { weather: machine, advance: false, fireLight: 0 });
  off.setup(engine);
  off.update(0);
  assert.deepEqual(sky.options.fog.color, [0, 0, 0]);
  assert.throws(() => WeatherDrive.attach(engine, { weather: machine, fireLight: -1 }), RangeError);
  const up = deg(18);
  sky.moonUnderClouds = { direction: [0, Math.sin(up), Math.cos(up), 0.25], radiance: [0.8, 0.9, 1.1] };
  drive.update(0);
  const through = hazeLight({ smoke: drive.settings.smoke }, up);
  for (let i = 0; i < 3; i++)
    near(
      sky.options.fog.color[i],
      smokeColor()[i] * ((0.25 * sky.moonUnderClouds.radiance[i] * through[i]) / 5 + glow[i]),
      1e-12,
    );
});
