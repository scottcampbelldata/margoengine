// GAP-FILM-RESET: every weather clock's `resetTime()` leaves it as a fresh one with the same options, before and after
// a seek: Hail, LensDrops, Puddles, GLTFWeather, WeatherRegions, WeatherMachine (its schedule or random walk replayed
// from the start, its seed's place included), WeatherDrive (the weather it steps and its fuel moisture), Eruption,
// LavaFlow, Avalanche and SnowDrift. Then a whole weather world (the one of seek.test.js) is run, reset and seeked: it
// equals a fresh world seeked as far, field for field, and the replay calls no listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherMachine } from '../dist/index.js';
import { WeatherDrive } from '../dist/drive.js';
import { Hail } from '../dist/hail.js';
import { Puddles } from '../dist/puddles.js';
import { LensDrops } from '../dist/lens.js';
import { GLTFWeather } from '../dist/gltf.js';
import { WeatherRegions } from '../dist/regions.js';
import { Eruption } from '../dist/eruption.js';
import { LavaFlow } from '../dist/lava.js';
import { Avalanche } from '../dist/avalanche.js';
import { SnowDrift } from '../dist/snow-drift.js';
import { Weather } from '../../sky/dist/weather.js';
import { assertResetLikeFresh, clockState, usedDeltas } from '../../../tests/support/clock-reset.js';

const schedule = () =>
  new WeatherMachine('clear', { seed: 3 }).schedule(
    [
      { to: 'rain', seconds: 4, hold: 3 },
      { to: 'thunderstorm', seconds: 5, hold: 2 },
      { to: 'snow', seconds: 6, hold: 4 },
    ],
    { loop: true },
  );
const walker = () =>
  new WeatherMachine('clear', { seed: 9 }).randomWalk('clear', { hold: [1, 5], blend: [1, 4], seed: 11 });

test('Hail, LensDrops, Puddles and GLTFWeather reset as fresh ones (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Hail({ seed: 5, intensity: 0.8, fadeSeconds: 2 }), { label: 'Hail' });
  assertResetLikeFresh(() => new LensDrops({ rain: 1 }), { label: 'LensDrops' });
  // `values` is the GPU block each frame update writes from the clock before it draws.
  assertResetLikeFresh(() => new Puddles({ wetness: 1, rain: 1 }), { label: 'Puddles', ignore: ['values'] });
  assertResetLikeFresh(() => new GLTFWeather({ puddles: { wetness: 1, rain: 1 } }), {
    label: 'GLTFWeather',
    ignore: ['values'],
  });
});

test('WeatherRegions and both machines reset as fresh ones; a call after time moved is dropped (GAP-FILM-RESET)', () => {
  const regions = () =>
    new WeatherRegions({
      base: 'partlyCloudy',
      fronts: [{ origin: [-50, 0], direction: Math.PI / 2, speed: 8, width: 20, behind: 'rain' }],
      cells: [{ center: [10, 3], radius: 40, weather: 'fog', velocity: [0, -1] }],
    });
  assertResetLikeFresh(regions, { label: 'WeatherRegions' });
  assertResetLikeFresh(schedule, { label: 'WeatherMachine schedule', steps: 1800 });
  assertResetLikeFresh(walker, { label: 'WeatherMachine walk', steps: 1800 });
  assertResetLikeFresh(() => new WeatherMachine('fog').transitionTo('rain', { seconds: 20 }), {
    label: 'WeatherMachine blend',
  });
  // A set() made after time moved is not part of the start.
  const m = new WeatherMachine('clear'),
    fresh = new WeatherMachine('clear');
  m.advanceTime(5);
  m.set('snow');
  m.advanceTime(5);
  m.resetTime();
  assert.deepEqual(m.state, fresh.state);
  assert.equal(m.time, 0);
  // Never stepped: nothing to put back.
  const idle = new WeatherMachine('rain');
  idle.resetTime();
  assert.deepEqual(clockState(idle), clockState(new WeatherMachine('rain')));
});

test('WeatherDrive.resetTime resets the weather it steps and its fuel moisture (GAP-FILM-RESET)', () => {
  const make = () => {
    const sky = new Weather({ lightning: { seed: 7 } }),
      hail = new Hail({ seed: 5 });
    return new WeatherDrive({ weather: schedule(), precipitation: sky, hail, position: [0, 2, 0] });
  };
  assertResetLikeFresh(make, { label: 'WeatherDrive', steps: 900 });
  // With advance off the weather is the scene's to step and reset.
  const machine = schedule(),
    drive = new WeatherDrive({ weather: machine, advance: false });
  machine.advanceTime(30);
  drive.resetTime();
  assert.equal(machine.time, 30, 'a weather the drive does not step is left alone');
});

test('Eruption, LavaFlow, Avalanche and SnowDrift reset as fresh ones (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Eruption({ massRate: 1e7, rise: 1, wind: 3, duration: 600 }), {
    label: 'Eruption',
    delta: 2,
  });
  assertResetLikeFresh(
    () => new LavaFlow({ vent: [0, 1000, 0], ground: (x, z) => 1000 - 0.05 * z + 0.2 * Math.abs(x), maxLength: 800 }),
    { label: 'LavaFlow', delta: 5 },
  );
  const slope = (deg, length = 400, cell = 4, across = 3) => {
    const depth = Math.round(length / cell) + 1,
      ground = new Float32Array(across * depth);
    for (let j = 0; j < depth; j++)
      for (let i = 0; i < across; i++) ground[j * across + i] = -Math.tan((deg * Math.PI) / 180) * j * cell;
    return { width: across, depth, cellSize: cell, ground };
  };
  // `version` counts uploads: a reset grows it so the views take the snow again.
  assertResetLikeFresh(
    () => new Avalanche({ ...slope(35), cover: 1, release: { at: [4, 200], size: [100, 40] }, cloud: false }),
    { label: 'Avalanche', delta: 0.5, steps: 120, ignore: ['version'] },
  );
  const W = 48,
    D = 4,
    ground = new Float32Array(W * D).map((_, k) => 4 * Math.max(0, 1 - Math.abs((k % W) - 20) / 10));
  assertResetLikeFresh(
    () => new SnowDrift({ width: W, depth: D, ground, initialDepth: 0.3, wind: 16, windDirection: 90, snowfall: 2 }),
    { label: 'SnowDrift', delta: 60, steps: 60, ignore: ['version'] },
  );
  const drift = new SnowDrift({ width: W, depth: D, ground, wind: 16, windDirection: 90, snowfall: 2 }),
    before = drift.version;
  for (const d of usedDeltas) drift.advanceTime(d * 600);
  drift.resetTime();
  assert.ok(drift.version > before, 'a reset drift is uploaded again');
});

// The world of seek.test.js: a looping schedule and a random walk, the drive writing into the sky's Weather and Hail.
function world() {
  const machine = schedule(),
    walk = walker(),
    sky = new Weather({ lightning: { seed: 7 } }),
    hail = new Hail({ seed: 5 }),
    drive = new WeatherDrive({ weather: machine, precipitation: sky, hail, position: [0, 2, 0] }),
    puddles = new Puddles({ weather: machine }),
    lens = new LensDrops({ weather: machine }),
    gltf = new GLTFWeather({ puddles: { weather: machine } }),
    heard = { start: 0, arrive: 0, strikes: 0 };
  for (const m of [machine, walk]) m.on((event) => heard[event.type]++);
  sky.onLightning(() => heard.strikes++);
  return { clocks: [drive, sky, hail, puddles, lens, gltf, walk], heard };
}
// A live frame: plugins take onPreUpdate, the walk (a clock passed as `extra`) its update, so listeners hear it.
const live = (w) => {
  for (const c of w.clocks) typeof c.onPreUpdate === 'function' ? c.onPreUpdate(1 / 60) : c.update(1 / 60);
};
const replay = (w, steps) => {
  for (let step = 0; step < steps; step++) for (const c of w.clocks) c.advanceTime(1 / 60);
};

test('a weather world run, reset and seeked equals a fresh world seeked as far (GAP-FILM-RESET)', () => {
  const a = world(),
    b = world();
  for (let step = 0; step < 1200; step++) live(a);
  assert.ok(a.heard.arrive > 0, 'the first cut changed the weather');
  const heard = { ...a.heard };
  for (const c of a.clocks) c.resetTime();
  replay(a, 900);
  replay(b, 900);
  assert.deepEqual(a.heard, heard, 'neither the reset nor the replay called a listener');
  // Then one live frame each, which writes the GPU blocks from the clocks.
  for (const w of [a, b]) live(w);
  const state = (w) => w.clocks.map((c) => clockState(c));
  assert.deepEqual(state(a), state(b));
  assert.deepEqual(
    a.heard.strikes - heard.strikes,
    b.heard.strikes,
    'the live frame after the seek hears what a fresh one does',
  );
});
