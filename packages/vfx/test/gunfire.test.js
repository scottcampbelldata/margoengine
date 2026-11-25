// Gunfire (@margoengine/vfx/gunfire): the CPU half. Black powder's products (Noble and Abel 1875), the flash and its
// exposure over a shutter, the powder puff against the closed forms of a momentum puff (Richards 1965) and a thermal
// (Scorer 1957; MTT 1956) and its level-off in stable air, Richardson's dispersion, the shot's flight against the vacuum
// range, the smoke colour of soot (Mulholland and Croarkin 2000), the vent laws of Kawagoe 1958 and Law 1978, and the
// Battery and HullFire classes on the optional-GPU harness: shots on schedule, the light as bright as the flash, banks
// that drift with the wind and thin, the same state for the same frames and after a seek, and a fire that rides its
// ship. The GPU half (drawn frames on WebGPU and the WebGL2 layer) is gunfire-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK_POWDER,
  Battery,
  FLASH_ALPHA,
  FLASH_DURATION,
  HullFire,
  PowderPuff,
  flashExposure,
  muzzleFlash,
  powderProducts,
  shotFlight,
  smokeColor,
  smokeDispersion,
  sphereDrag,
  ventBurningRate,
  ventFlameHeight,
} from '../dist/gunfire.js';
import {
  GUNFIRE_SETTINGS,
  HULL_FIRE_SETTINGS,
  GUNFIRE_LOOKS,
  HULL_FIRE_LOOKS,
  applyGunfireSettings,
  applyHullFireSettings,
  gunfireSettingValues,
  hullFireSettingValues,
} from '../dist/settings.js';
import { optionalGPU as harness } from '../../../tests/support/optional-gpu.js';

const optionalGPU = () => {
  const h = harness();
  h.engine.stats = { drawCalls: 0 };
  h.engine.lighting = {
    direction: new Float32Array([0, 3, 4, 2]),
    radiance: new Float32Array([1, 0.5, 0.25, 0.2]),
    ambient: new Float32Array([1, 2, 3]),
  };
  return h;
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

test('black powder burns to Noble and Abel products', () => {
  const p = powderProducts(4.5);
  near(p.smoke, 4.5 * 0.5591, 1e-12, 'smoke');
  near(p.gas + p.smoke + p.water, 4.5, 1e-9, 'mass is kept');
  near(p.heat / 4.5, 718.1 * 4184, 1e-6, 'heat of explosion');
  near(p.gasVolume, 4.5 * 0.2713, 1e-12, 'gas volume');
  assert.equal(BLACK_POWDER.saltpetre + BLACK_POWDER.charcoal + BLACK_POWDER.sulphur, 1);
});

test('the flash is a ball of the charge gas at its explosion temperature', () => {
  const f = muzzleFlash(4.5),
    p = powderProducts(4.5),
    volume = ((p.gasVolume + (p.water * 22.414) / 18.015) * 2473) / 273.15;
  near((4 / 3) * Math.PI * f.radius ** 3, volume, 1e-9, 'fireball volume');
  // Twice the charge, 2^(1/3) the radius.
  near(muzzleFlash(9).radius / f.radius, Math.cbrt(2), 1e-12, 'cube-root scaling');
  assert.ok(f.color[0] === 1 && f.color[2] < 0.2, 'orange');
});

test('a flash exposed over the shutter carries the same light at every frame rate and shows on the frame that holds it', () => {
  for (const fps of [24, 30, 60, 120]) {
    const frame = 1 / fps;
    let sum = 0;
    // A 360 degree shutter: the frames' exposures add up to the flash's light, duration x peak.
    for (let k = 0; k < 400; k++) sum += flashExposure((0.0123 % frame) + k * frame, frame) * frame;
    near(sum, FLASH_DURATION, 1e-9, `${fps} fps energy`);
  }
  // A 5 ms flash fired 16 ms before a 60 fps frame with its shutter open 16.7 ms: the camera saw the flash in the
  // shutter, so the frame records it; sampling the curve at the frame instant would miss most of it.
  const short = 0.005;
  assert.ok(flashExposure(0.05, 1 / 60, short) < 1e-3, 'a frame whose shutter opened after the flash is dark');
  assert.ok(
    flashExposure(0.016, 1 / 60, short) > 5 * Math.exp(-0.016 / short),
    'the shutter catches a flash that a point sample misses',
  );
  assert.equal(flashExposure(-0.01, 1 / 60), 0);
  near(flashExposure(0.02, 0), Math.exp(-0.02 / FLASH_DURATION), 1e-15, 'a closed shutter samples');
});

test('a momentum puff travels as the closed form s^4 = s0^4 + 3 P t / (pi alpha^3)', () => {
  const puff = new PowderPuff({ charge: 4.5, muzzleVelocity: 490, heatFraction: 0, stability: 0 }),
    a = 0.25,
    s0 = puff.startRadius / a;
  for (const t of [0.01, 0.1, 1, 10, 100]) {
    const s = (s0 ** 4 + (3 * puff.momentum * t) / (Math.PI * a ** 3)) ** 0.25,
      p = puff.at(t);
    near(p.along, s - s0, 2e-3 * (s - s0) + 1e-6, `along at ${t} s`);
    near(p.radius, a * s, 2e-3 * a * s, `radius at ${t} s`);
    near(p.rise, 0, 1e-9, 'no buoyancy, no rise');
  }
});

test('a thermal rises as the closed form s^4 = s0^4 + 3 B t^2 / (2 pi alpha^3)', () => {
  const puff = new PowderPuff({ charge: 4.5, muzzleVelocity: 490, momentum: 0, stability: 0 }),
    a = 0.25,
    s0 = puff.startRadius / a;
  for (const t of [1, 10, 100, 500]) {
    const s = (s0 ** 4 + (3 * puff.buoyancy * t * t) / (2 * Math.PI * a ** 3)) ** 0.25;
    near(puff.at(t).rise, s - s0, 3e-3 * (s - s0), `rise at ${t} s`);
  }
});

test('in stable air the bank levels off at a height that scales as (B / N^2)^(1/4)', () => {
  const peak = (charge, n2) => {
    const p = new PowderPuff({
      charge,
      muzzleVelocity: 490,
      momentum: 0,
      stability: n2,
      duration: 3000,
      entrainment: 0.25,
    });
    let best = 0;
    for (let t = 0; t <= 3000; t += 2) best = Math.max(best, p.at(t).rise + p.startRadius / 0.25);
    return { best, late: p.at(3000).rise, peak: best - p.startRadius / 0.25 };
  };
  const a = peak(4.5, 1e-4),
    b = peak(4.5 * 16, 1e-4),
    c = peak(4.5, 16e-4);
  // From the virtual origin: 16 times the buoyancy doubles it, 16 times N^2 halves it.
  near(b.best / a.best, 2, 0.06, 'buoyancy^(1/4)');
  near(a.best / c.best, 2, 0.06, 'N^(-1/2)');
  assert.ok(a.late < a.peak, 'it overshoots and settles below its peak');
  const neutral = new PowderPuff({ charge: 4.5, muzzleVelocity: 490, momentum: 0, stability: 0, duration: 3000 });
  assert.ok(neutral.at(3000).rise > 2 * a.peak, 'neutral air does not stop it');
});

test('Richardson dispersion is sqrt(g eps t^3) with the sea surface dissipation', () => {
  const ustar = Math.sqrt(1.2e-3) * 5,
    eps = ustar ** 3 / (0.4 * 10);
  near(smokeDispersion(60, 5), Math.sqrt(0.5 * eps * 60 ** 3), 1e-12, 'law');
  assert.equal(smokeDispersion(60, 0), 0);
  near(smokeDispersion(120, 5) / smokeDispersion(60, 5), 2 ** 1.5, 1e-12, 't^(3/2)');
});

test('the shot flies the vacuum range without drag and falls short with it', () => {
  const v = 490,
    th = (3 * Math.PI) / 180;
  const vacuum = shotFlight([0, 0.001, 0], [Math.cos(th), Math.sin(th), 0], v, {}, { drag: false });
  near(vacuum.position[0], (v * v * Math.sin(2 * th)) / 9.81, 1.5, 'range');
  near(vacuum.time, (2 * v * Math.sin(th)) / 9.81, 0.003, 'time of flight');
  const real = shotFlight([0, 0.001, 0], [Math.cos(th), Math.sin(th), 0], v, {}, { fireTime: 10 });
  assert.ok(real.position[0] < 0.8 * vacuum.position[0], 'drag shortens it');
  assert.ok(real.time > 10, 'impact on the film clock');
  near(real.radius, Math.cbrt((3 * 14.5) / (4 * Math.PI * 7200)), 1e-12, 'a 32-pounder ball');
  assert.ok(sphereDrag(0) === 0.47 && sphereDrag(1.2) === 0.95 && sphereDrag(3) === 0.92);
  assert.equal(shotFlight([0, 5, 0], [0, 1, 0], 10, {}, { maxTime: 0.5 }), undefined);
});

test('soot darkens the smoke by its extinction and albedo', () => {
  near(smokeColor(0)[0], 0.97, 1e-12, 'white powder smoke');
  near(smokeColor(1)[0], 0.25, 1e-12, 'soot');
  // 10% soot by mass is a quarter of the extinction and already drops the albedo below 0.8.
  assert.ok(smokeColor(0.1)[0] < 0.8 && smokeColor(0.1)[0] > smokeColor(0.35)[0]);
});

test('the vent laws of Kawagoe and Law', () => {
  near(ventBurningRate(2, 1), 0.18, 1e-12, 'Kawagoe 0.09 A sqrt(H)');
  near(ventFlameHeight(0.5, 1, 1), 12.8 * Math.cbrt(0.25) - 1, 1e-12, 'Law');
  assert.equal(ventFlameHeight(0.001, 1, 1), 0);
});

const gun = { position: [0, 3, 0], direction: [1, 0, 0] };

test('a battery fires on schedule: the flash, its light, the bank and the shot', () => {
  const { engine } = optionalGPU();
  const clustered = {
    maxLights: 64,
    list: [],
    setLights(l) {
      this.list = l;
    },
  };
  const b = Battery.attach(engine, {
    guns: [gun, { ...gun, position: [0, 3, 10] }],
    shots: [{ gun: 0, time: 0.5 }],
    wind: [4, 0],
    lights: clustered,
  });
  b.broadside(2, 0.5, [1]);
  for (let i = 0; i < 15; i++) b.advanceTime(1 / 30);
  assert.equal(b.fired.length, 0);
  b.advanceTime(1 / 30);
  assert.equal(b.fired.length, 1);
  const fo = b.flashes[0].options,
    f = muzzleFlash(4.5),
    exposure = flashExposure(b.time - 0.5, 0.5 / 30);
  near(fo.intensity, (40 * exposure) / FLASH_ALPHA, 1e-6, 'flash brightness is the exposure');
  assert.equal(b.flashes[1].options.intensity, 0);
  // The light: a sphere of the flash radius as bright as the flash.
  near(b.lights[0].intensity, Math.PI * f.radius ** 2 * 40 * exposure, 1e-6, 'light');
  assert.equal(clustered.list.length, 2);
  assert.ok(b.fired[0].impact && b.fired[0].impact.time > 0.5, 'the shot reaches the water');
  for (let i = 0; i < 60; i++) b.advanceTime(1 / 30);
  assert.equal(b.fired.length, 2, 'the broadside gun fired at 2 s');
  assert.ok(b.flashes[0].options.intensity < 1e-6, 'the first flash is out');
  assert.equal(b.impacts().length, 2);
  b.dispose();
});

test('a bank drifts with the wind on top of its own path and thins as it grows', () => {
  const { engine } = optionalGPU();
  const b = Battery.attach(engine, { guns: [gun], shots: [{ gun: 0, time: 0 }], wind: [5, 0], stability: 0 });
  b.advanceTime(1 / 30);
  const puff = b.puffOf(0),
    bank = () => b.clouds.clouds.find((c) => c.options.opacity > 0);
  const at = [];
  for (const until of [10, 60]) {
    while (b.time < until - 1e-9) b.advanceTime(1 / 30);
    const m = bank().matrix,
      p = puff.at(b.time);
    near(m[12], p.along + 5 * b.time, 1e-3, `x at ${until} s: path plus drift`);
    near(m[13], 3 + p.rise, 1e-3, `y at ${until} s`);
    at.push(bank().options.opacity);
  }
  assert.ok(at[1] < at[0], 'thinner after a minute');
  b.dispose();
});

test('the weather wind written on the flashes moves the banks; an own wind overrides it', () => {
  const { engine } = optionalGPU();
  const b = Battery.attach(engine, { guns: [gun] });
  b.flashes[0].options.wind = [3, -1]; // as WeatherDrive writes it
  assert.deepEqual(b.wind(), [3, -1]);
  b.options.wind = [0, 2];
  assert.deepEqual(b.wind(), [0, 2]);
  b.dispose();
});

test('the same frames give the same battery (a seek replays the same frame deltas)', () => {
  const run = (steps) => {
    const { engine } = optionalGPU();
    const b = Battery.attach(engine, { guns: [gun, { ...gun, position: [0, 3, 8] }], wind: [3, 1] });
    b.broadside(0.2, 0.3);
    for (const d of steps) b.advanceTime(d);
    const out = {
      fired: b.fired.map((s) => [s.time, ...s.drift]),
      banks: b.clouds.clouds.map((c) => [...c.matrix, c.options.opacity]),
      i: b.flashes.map((f) => f.options.intensity),
    };
    b.dispose();
    return out;
  };
  const frames = new Array(300).fill(1 / 30);
  assert.deepEqual(run(frames), run(frames));
  // Drift adds up per frame, so a seek replays the same deltas: 300 of 1/30 s.
  const seek = run(frames);
  assert.equal(seek.fired.length, 2);
});

test('a burning hull grows, flames out of its ports at Law height and rides its ship', () => {
  const { engine } = optionalGPU();
  const pose = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const ship = { matrix: () => pose };
  const fire = HullFire.attach(engine, { ship, spread: 0.1, ports: [{ position: [6.5, 3, 0], size: [0.8, 0.7] }] });
  for (let i = 0; i < 30; i++) fire.advanceTime(1 / 30);
  const early = fire.heat;
  for (let i = 0; i < 30 * 120; i++) fire.advanceTime(1 / 30);
  assert.ok(fire.heat > 5 * early, 'the fire spreads');
  const port = fire.flames().find((f) => f.kind === 'port');
  near(port.length - 0.7, ventFlameHeight(ventBurningRate(0.56, 0.7), 0.8, 0.7), 1e-9, 'Law height above the port top');
  near(
    fire.smokeColumns.reduce((s, c) => s + c.options.heat, 0),
    0.7 * fire.heat,
    1e-3 * fire.heat,
    'smoke takes 0.7 of the heat',
  );
  assert.deepEqual(fire.smokeColumns[0].options.color, smokeColor(0.35));
  const before = fire.flameVolumes[0].options.position;
  pose[12] = 40;
  pose[14] = -5;
  fire.advanceTime(1 / 30);
  near(fire.flameVolumes[0].options.position[0] - before[0], 40, 1e-6, 'rides x');
  near(fire.flameVolumes[0].options.position[2] - before[2], -5, 1e-6, 'rides z');
  fire.dispose();
});

test('settings rows write the battery and the hull, and null wind follows the weather', () => {
  for (const row of [...GUNFIRE_SETTINGS, ...HULL_FIRE_SETTINGS]) assert.equal(row.live, true, row.name);
  const { engine } = optionalGPU();
  const b = Battery.attach(engine, { guns: [gun] });
  applyGunfireSettings(b, GUNFIRE_LOOKS.trafalgar);
  assert.equal(b.options.stability, 4e-4);
  assert.equal(b.options.wind, undefined);
  applyGunfireSettings(b, { 'wind.x': 3 });
  assert.deepEqual(b.options.wind, [3, 0]);
  assert.equal(gunfireSettingValues(b)['wind.x'], 3);
  assert.throws(() => applyGunfireSettings(b, { flashSize: -1 }), RangeError);
  assert.throws(() => applyGunfireSettings(b, { nope: 1 }), TypeError);
  const fire = HullFire.attach(engine, { ship: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) });
  applyHullFireSettings(fire, HULL_FIRE_LOOKS.tarred);
  assert.equal(fire.options.soot, 0.6);
  assert.equal(hullFireSettingValues(fire).spread, 0.08);
  b.dispose();
  fire.dispose();
});

test('bad options throw', () => {
  const { engine } = optionalGPU();
  assert.throws(() => Battery.attach(engine, { guns: [] }), TypeError);
  assert.throws(() => Battery.attach(engine, { guns: [{ position: [0, 0, 0], direction: [0, 0, 0] }] }), RangeError);
  assert.throws(() => Battery.attach(engine, { guns: [gun], shots: [{ gun: 3, time: 0 }] }), RangeError);
  assert.throws(() => HullFire.attach(engine, { ship: {} }), TypeError);
  assert.throws(() => new PowderPuff({ charge: -1, muzzleVelocity: 400 }), RangeError);
});
