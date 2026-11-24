// GAP-FILM-TIME: a weather started at film time T holds the state a continuous run holds at T, bit for bit. Run A takes
// n + 1 live frame updates; run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs: plugins in attach order, then the clocks passed as `extra`), then takes one live
// update. A looping machine schedule and a random walk change the weather on the way, the drive writes the wind at a
// moving camera into the sky's Weather and Hail, and film code changes the wind aloft at step 300. Every field of every
// clock must be equal, and a replayed transition calls no listener. Hail and puddle pictures: seek-check.mjs on a GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherMachine } from '../dist/index.js';
import { WeatherDrive } from '../dist/drive.js';
import { Hail } from '../dist/hail.js';
import { Puddles } from '../dist/puddles.js';
import { LensDrops } from '../dist/lens.js';
import { GLTFWeather } from '../dist/gltf.js';
import { WeatherRegions } from '../dist/regions.js';
import { Weather } from '../../sky/dist/weather.js';

const FPS = 60;
// Plain state of an object, numbers by value, typed arrays as arrays; listeners and functions are left out, and an
// object met again (the machine inside the drive's and the lens's options) is named, not walked.
function state(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (value instanceof Set || value instanceof Map) return undefined;
  if (seen.has(value)) return '[seen]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => state(v, seen));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, state(v, seen)]).filter(([, v]) => v !== undefined));
}

function world() {
  const machine = new WeatherMachine('clear', { seed: 3 }).schedule(
      [
        { to: 'rain', seconds: 4, hold: 3 },
        { to: 'thunderstorm', seconds: 5, hold: 2 },
        { to: 'hail', seconds: 3, hold: 2 },
        { to: 'snow', seconds: 6, hold: 4 },
      ],
      { loop: true },
    ),
    walker = new WeatherMachine('clear', { seed: 9 }).randomWalk('clear', { hold: [1, 5], blend: [1, 4], seed: 11 }),
    sky = new Weather({ lightning: { seed: 7 } }),
    hail = new Hail({ seed: 5 }),
    drive = new WeatherDrive({ weather: machine, precipitation: sky, hail, position: [0, 2, 0] }),
    puddles = new Puddles({ weather: machine }),
    lens = new LensDrops({ weather: machine }),
    gltf = new GLTFWeather({ puddles: { weather: machine } }),
    regions = new WeatherRegions({
      base: 'partlyCloudy',
      fronts: [{ origin: [-50, 0], direction: Math.PI / 2, speed: 8, width: 20, behind: 'rain' }],
      cells: [{ center: [10, 3], radius: 40, weather: 'fog', velocity: [0, -1] }],
    }),
    heard = { start: 0, arrive: 0, strikes: 0 };
  for (const m of [machine, walker]) m.on((event) => heard[event.type]++);
  sky.onLightning(() => heard.strikes++);
  // Attach order (the order the engine updates plugins and a seek replays them), then the clocks passed as `extra`.
  return { plugins: [drive, sky, hail, puddles, lens, gltf], extra: [walker, regions], machine, sky, drive, heard };
}
// Film code: what a film sets from its own step, live or replayed (ctx.seek), so both runs read the same inputs.
const film = (w, step) => {
  w.drive.options.position = [step * 0.05, 2, -step * 0.02];
  w.drive.options.windAloft = step >= 300 ? 5 : 3;
};
const live = (w, step) => {
  film(w, step);
  for (const p of w.plugins) p.onPreUpdate(1 / FPS);
  for (const c of w.extra) c.update(1 / FPS);
};
const replay = (w, steps) => {
  for (let step = 0; step < steps; step++) {
    film(w, step);
    for (const c of [...w.plugins, ...w.extra]) c.advanceTime(1 / FPS);
  }
};
const clocks = (w) => [...w.plugins, ...w.extra];
const snapshot = (w) => clocks(w).map((c) => state(c));

for (const n of [1, 600, 54000])
  test(`a weather replayed ${n} steps equals a continuous run, field for field`, () => {
    const a = world(),
      b = world();
    for (const c of clocks(b)) assert.equal(c.time, 0, `${c.constructor.name} starts at 0`);
    for (let step = 0; step < n; step++) live(a, step);
    const before = { ...a.heard };
    live(a, n);
    const opening = { ...b.heard };
    replay(b, n);
    assert.deepEqual(b.heard, opening, 'a replayed transition or strike calls no listener');
    live(b, n);
    assert.deepEqual(snapshot(b), snapshot(a));
    clocks(b).forEach((c, i) => assert.ok(Object.is(c.time, clocks(a)[i].time), c.constructor.name));
    assert.deepEqual(a.drive.settings, b.drive.settings);
    // The one live frame hears what the continuous run heard on that frame.
    for (const key of Object.keys(before)) assert.equal(b.heard[key] - opening[key], a.heard[key] - before[key], key);
    if (n === 54000) {
      assert.ok(a.heard.arrive > 200, `the schedule and walk arrived ${a.heard.arrive} times`);
      assert.ok(a.heard.strikes > 10, `the storm struck ${a.heard.strikes} times`);
      assert.ok(a.machine.snowCover > 0 && a.machine.wetness > 0, 'the ground integrated rain and snow');
    }
  });

test('a fresh world drawn at T without the replay differs (the restart a film cut showed)', () => {
  const a = world(),
    c = world();
  for (let step = 0; step <= 600; step++) live(a, step);
  live(c, 600);
  assert.notDeepEqual(snapshot(c), snapshot(a));
  assert.notEqual(c.machine.wetness, a.machine.wetness);
});

test('a drive following a source without advanceTime steps it with update; the drive reads its time', () => {
  const steps = [],
    source = { state: new WeatherMachine('rain').state, time: 0, update: (d) => steps.push(d) },
    drive = new WeatherDrive({ weather: source });
  drive.advanceTime(0.5);
  assert.deepEqual(steps, [0.5]);
  new WeatherDrive({ weather: source, advance: false }).advanceTime(0.25);
  assert.deepEqual(steps, [0.5], 'advance: false leaves the weather to the caller');
  source.time = 7;
  assert.equal(drive.time, 7);
  assert.equal(new WeatherDrive({ weather: { state: source.state } }).time, 0);
});

test('advanceTime refuses what update refuses', () => {
  assert.throws(() => new WeatherMachine().advanceTime(-1), RangeError);
  assert.throws(() => new Hail().advanceTime(Number.NaN), RangeError);
  assert.throws(() => new Puddles().advanceTime(Infinity), RangeError);
  assert.throws(() => new LensDrops().advanceTime(-0.1), RangeError);
  assert.throws(() => new WeatherRegions().advanceTime(-1), RangeError);
  const m = new WeatherMachine();
  m.dispose();
  assert.throws(() => m.advanceTime(0.1), /disposed/);
});
