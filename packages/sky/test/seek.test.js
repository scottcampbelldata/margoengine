// GAP-FILM-TIME: a sky started at film time T holds the state a continuous run holds at T, bit for bit. Run A takes
// n + 1 live frame updates; run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs, plugins in attach order), then takes one live update. Film code sets the wind from
// its own step in both runs, and the wind changes on the way. Every field of every clock must be equal, and a
// replayed lightning strike calls no listener. The pictures are proved on a real GPU by seek-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky } from '@margoengine/sky';
import { AstroSky } from '@margoengine/sky/astro';
import { degrees } from '@margoengine/sky/sun';
import { HillaireSky } from '@margoengine/sky/hillaire';
import { VolumetricClouds } from '@margoengine/sky/volumetric-clouds';
import { Weather } from '@margoengine/sky/weather';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const FPS = 60;
// Plain state of an object, numbers by value (Object.is), typed arrays as arrays; listeners and functions are left out,
// and an object met again (the sky inside the clouds' options) is named, not walked.
function state(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (value instanceof Date) return value.getTime();
  if (value instanceof Set || value instanceof Map) return undefined;
  if (seen.has(value)) return '[seen]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => state(v, seen));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, state(v, seen)]).filter(([, v]) => v !== undefined));
}

function world() {
  const sky = new Sky({ hours: 18.2, timeScale: 120 / 3600, clouds: { coverage: 0.5, speed: 30 }, night: {} }),
    clouds = new VolumetricClouds({ sky, temporal: true, wind: [4, 1] }),
    weather = new Weather({
      precipitation: 'rain',
      intensity: 1,
      fadeSeconds: 3,
      wind: [4, 1],
      lightning: { seed: 7, rate: 600, threshold: 0 },
    }),
    astro = new AstroSky({
      latitude: degrees(52),
      longitude: degrees(0),
      date: new Date('2026-06-21T20:30:00Z'),
      timeScale: 30,
      sky: { options: { night: {} }, nightFactor: 1 },
    }),
    hillaire = new HillaireSky({ hours: 6.5, timeScale: 90 / 3600 }),
    heard = { strikes: 0, thunder: 0 };
  weather.onLightning(() => heard.strikes++);
  weather.onThunder(() => heard.thunder++);
  // Attach order, the order the engine updates them and a seek replays them.
  return { plugins: [astro, hillaire, sky, clouds, weather], sky, clouds, weather, astro, hillaire, heard };
}
// Film code: what a film sets from its own step, live or replayed (ctx.seek), so both runs read the same inputs.
const film = (w, step) => {
  const gust = step >= 300 ? [14, -3] : [4, 1];
  w.weather.options.wind = gust;
  w.clouds.options.wind = gust;
};
const live = (w, step) => {
  film(w, step);
  for (const p of w.plugins) p.onPreUpdate(1 / FPS);
};
const replay = (w, steps) => {
  for (let step = 0; step < steps; step++) {
    film(w, step);
    for (const p of w.plugins) p.advanceTime(1 / FPS);
  }
};
const snapshot = (w) => w.plugins.map((p) => state(p));

for (const n of [1, 600, 54000])
  test(`a sky replayed ${n} steps equals a continuous run, field for field`, () => {
    const a = world(),
      b = world();
    for (const p of b.plugins) assert.equal(p.time, 0, `${p.constructor.name} starts at 0`);
    for (let step = 0; step < n; step++) live(a, step);
    const before = { ...a.heard };
    live(a, n);
    replay(b, n);
    assert.deepEqual(b.heard, { strikes: 0, thunder: 0 }, 'a replayed strike calls no listener');
    live(b, n);
    assert.deepEqual(snapshot(b), snapshot(a));
    for (const p of b.plugins) assert.ok(Object.is(p.time, a.plugins[b.plugins.indexOf(p)].time));
    // The one live frame hears what the continuous run heard on that frame.
    assert.deepEqual(b.heard, { strikes: a.heard.strikes - before.strikes, thunder: a.heard.thunder - before.thunder });
    if (n === 54000) assert.ok(a.heard.strikes > 100, `the storm struck ${a.heard.strikes} times`);
  });

test('a fresh world drawn at T without the replay differs (the restart a film cut showed)', () => {
  const a = world(),
    c = world();
  for (let step = 0; step <= 600; step++) live(a, step);
  live(c, 600);
  assert.notDeepEqual(snapshot(c), snapshot(a));
  assert.notEqual(c.clouds.time, a.clouds.time);
});

test('the weather listener follows the engine camera at each update, not the last draw', () => {
  const h = optionalGPU(),
    weather = new Weather({ lightning: { seed: 3 } }),
    camera = h.engine.camera;
  camera.position = new Float32Array([10, 2, -5]);
  h.engine.use(weather);
  weather.advanceTime(1 / FPS);
  assert.deepEqual([...weather.listener], [10, 2, -5]);
  camera.position.set([1, 2, 3]);
  const strike = weather.strike({ distance: 100, azimuth: 0 });
  assert.deepEqual(strike.position, [10, 0, 95], 'a strike is placed from the listener of the last update');
});

for (const n of [1, 600, 54000])
  test(`an aurora replayed ${n} steps equals a continuous run`, async () => {
    const { Aurora } = await import('@margoengine/sky/aurora'),
      a = new Aurora({ intensity: 100, speed: 1 }),
      b = new Aurora({ intensity: 100, speed: 1 });
    assert.equal(b.time, 0, 'a fresh Aurora starts at 0');
    // Film code makes the folds livelier on the way, in both runs.
    const film = (x, step) => (x.options.speed = step >= 300 ? 4 : 1);
    for (let step = 0; step <= n; step++) {
      film(a, step);
      a.onPreUpdate(1 / FPS);
    }
    for (let step = 0; step < n; step++) {
      film(b, step);
      b.advanceTime(1 / FPS);
    }
    film(b, n);
    b.onPreUpdate(1 / FPS);
    assert.ok(Object.is(b.time, a.time));
    assert.deepEqual(state(b), state(a));
    assert.throws(() => b.advanceTime(-1), RangeError);
  });

// KB-FILM-CLOUDPHASE1: a Reflector, Refractor or CubeCamera capture renders the scene with delta 0 before the frame's
// own update (engine.onFrame), and the clouds draw inside it. The frame's own draw must march from the start a seek
// gives at that frame, however many captures came first; a still frame drawn again must still move the start.
{
  // The draw's uniform write, on a mock device: v[41] is the march start offset.
  const march = (clouds) => {
    let offset;
    const c = {
      camera: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0]), position: [0, 1, 0] },
      format: 'rgba16float',
      device: { queue: { writeBuffer: (_b, _o, v) => (offset = v[41]) } },
    };
    clouds['write'](c);
    return offset;
  };
  const make = () => new VolumetricClouds({ sky: new Sky({ hours: 12 }), temporal: true });
  // One engine frame: `captures` zero-delta renders (update then draw), then the frame's update and its own draw.
  const frame = (clouds, delta, captures) => {
    for (let i = 0; i < captures; i++) {
      clouds.onPreUpdate(0);
      march(clouds);
    }
    clouds.onPreUpdate(delta);
    return march(clouds);
  };
  for (const captures of [1, 2])
    test(`clouds behind ${captures} capture(s) a frame march from the start a seek gives`, () => {
      const a = make(),
        plain = make(),
        b = make();
      const n = 37,
        seen = [],
        alone = [];
      for (let step = 0; step <= n; step++) {
        seen.push(frame(a, 1 / FPS, captures));
        alone.push(frame(plain, 1 / FPS, 0));
      }
      assert.deepEqual(seen, alone, 'captures change no frame draw');
      for (let step = 0; step < n; step++) b.advanceTime(1 / FPS);
      assert.equal(frame(b, 1 / FPS, 0), seen[n]);
      assert.equal(new Set(seen).size, n + 1, 'each frame marches from its own start');
    });
  test('a still frame drawn again moves the march start; the next timed update drops those steps', () => {
    const a = make(),
      b = make();
    for (let step = 0; step < 5; step++) frame(a, 1 / FPS, 1), b.advanceTime(1 / FPS);
    const still = [frame(a, 0, 1), frame(a, 0, 1), frame(a, 0, 0)];
    assert.equal(new Set(still).size, 3, 'still frames march from new starts');
    b.advanceTime(0), b.advanceTime(0), b.advanceTime(0);
    assert.equal(frame(a, 1 / FPS, 1), frame(b, 1 / FPS, 0), 'the seek lands where the run with still frames is');
  });
}
