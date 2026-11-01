import test from 'node:test';
import assert from 'node:assert/strict';
import { animateFlicker, flickerAt } from '../dist/flicker.js';
import { shadowBudget } from '../dist/budget.js';

test('named flicker curves are repeatable, stay within 0 to 1 and differ by seed', () => {
  for (const curve of ['candle', 'fire', 'fluorescent', 'pulse', 'strobe']) {
    const values = new Set();
    for (let t = 0; t < 20; t += 0.013) {
      const v = flickerAt(curve, t, 3);
      assert.ok(v >= 0 && v <= 1, `${curve} at ${t}: ${v}`);
      assert.equal(v, flickerAt(curve, t, 3));
      values.add(v);
    }
    assert.ok(values.size > 1, `${curve} changes`);
    const times = Array.from({ length: 400 }, (_, i) => i * 0.05);
    assert.notEqual(
      times.map((t) => flickerAt(curve, t, 0)).join(),
      times.map((t) => flickerAt(curve, t, 1)).join(),
      `${curve} seeds`,
    );
  }
  assert.equal(
    flickerAt((t) => t * 2, 3),
    6,
  );
  assert.throws(() => flickerAt('torch', 0), TypeError);
  assert.throws(() => flickerAt(() => -1, 0), RangeError);
  assert.throws(() => flickerAt(() => NaN, 0), RangeError);
});

test('animateFlicker scales only flickering lights each frame and stops on the steady list', () => {
  let frame;
  const calls = [],
    engine = { onFrame: (f) => ((frame = f), () => (frame = undefined)) },
    clustered = { setLights: (l) => calls.push(l.map((x) => x.intensity)) },
    lights = [
      { position: [0, 0, 0], range: 5, intensity: 4, flicker: { curve: () => 0.5 } },
      { position: [1, 0, 0], range: 5, intensity: 2 },
      { position: [2, 0, 0], range: 5, intensity: 8, flicker: { curve: (t) => t, speed: 2 } },
    ];
  const stop = animateFlicker(engine, clustered, lights);
  assert.deepEqual(calls.at(-1), [2, 2, 0]);
  frame(0, 0.25);
  assert.deepEqual(calls.at(-1), [2, 2, 4]);
  assert.equal(lights[0].intensity, 4, 'the caller keeps its steady values');
  stop();
  assert.deepEqual(calls.at(-1), [4, 2, 8]);
  assert.equal(frame, undefined);
});

const spot = (x, intensity = 1) => ({
  position: [x, 0, 0],
  direction: [0, -1, 0],
  range: 9,
  intensity,
  castShadow: true,
});
test('shadowBudget favours near bright lights, stays inside its budget and leaves the input alone', () => {
  const lights = [
      spot(40),
      spot(1),
      { position: [5, 0, 0], range: 9, castShadow: true },
      { position: [2, 0, 0], range: 9 },
    ],
    out = shadowBudget(lights, { viewer: [0, 0, 0], texels: 1024 * 512, resolution: 512 });
  assert.equal(out[1].shadow.resolution, 512, 'the nearest gets the largest map');
  const drawn = out.reduce((sum, light, i) => {
    if (!light.castShadow) return sum;
    return sum + light.shadow.resolution ** 2 * (i === 2 ? 6 : 1);
  }, 0);
  assert.ok(drawn <= 1024 * 512, `drawn ${drawn}`);
  assert.equal(out[3].castShadow, undefined, 'a light that does not cast stays out');
  assert.equal(lights[1].shadow, undefined);
  assert.ok(lights[1] !== out[1]);
});

test('shadowBudget stops casting past maxLights and below the smallest map', () => {
  const out = shadowBudget([spot(1), spot(2), spot(3)], { viewer: [0, 0, 0], texels: 1e9, maxLights: 2 });
  assert.deepEqual(
    out.map((l) => l.castShadow),
    [true, true, false],
  );
  const poor = shadowBudget([spot(1)], { viewer: [0, 0, 0], texels: 100, minResolution: 64 });
  assert.equal(poor[0].castShadow, false);
  for (const bad of [
    { texels: 0 },
    { texels: 1, minResolution: 8 },
    { texels: 1, resolution: 32 },
    { texels: 1, maxLights: 0 },
  ])
    assert.throws(() => shadowBudget([], { viewer: [0, 0, 0], ...bad }), RangeError);
});
