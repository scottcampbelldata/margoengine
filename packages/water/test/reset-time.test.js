// GAP-FILM-RESET: every water clock's `resetTime()` leaves it as a fresh one with the same options, before and after a
// seek. The floating bodies are reset after riding a wave, the flood after inputs set later than tick 0 (which a fresh
// flood never had), and the flood and the Water both start a fresh GPU flow at the next frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { Water } from '../dist/index.js';
import { FFTOcean } from '../dist/fft.js';
import { WaterFlow } from '../dist/flow.js';
import { WaterRain } from '../dist/rain.js';
import { Flood } from '../dist/flood.js';
import { Iceberg, SeaIce } from '../dist/ice.js';
import { Floater, ShipWakes } from '../dist/ships.js';
import { ShotSplash } from '../dist/splash.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';

const wave = { sample: (x, z) => ({ height: 0.6 * Math.sin(0.3 * z + 0.1 * x), velocity: [0.2, 0, 0.1] }) };
const surface = () => {
  const h = optionalGPU(),
    water = new Water({ segments: 4 });
  h.engine.use(water);
  return water;
};

test('Water, FFTOcean, WaterFlow and WaterRain reset as fresh ones (GAP-FILM-RESET)', () => {
  const h = optionalGPU(),
    make = () => {
      const water = new Water({ segments: 4 });
      h.engine.use(water);
      return water;
    };
  assertResetLikeFresh(make, { label: 'Water' });
  assertResetLikeFresh(() => new FFTOcean({ segments: 1 }), { label: 'FFTOcean' });
  const water = surface();
  assertResetLikeFresh(() => new WaterFlow({ surface: water, direction: [1, 0.5] }), { label: 'WaterFlow' });
  assertResetLikeFresh(() => new WaterRain({ surface: water }), { label: 'WaterRain' });
});

test('Floater, Iceberg and SeaIce go back where they were built, at rest (GAP-FILM-RESET)', () => {
  const ride = (body) => body.update(wave, 0.1);
  assertResetLikeFresh(
    () => new Floater({ hull: { length: 40, beam: 8, draft: 2 }, position: [3, 0, 4], heading: 30, drift: 0.5 }),
    {
      label: 'Floater',
      use: ride,
    },
  );
  const block = { positions: new Float64Array(boxTriangles(20, 12, 30)) };
  assertResetLikeFresh(() => new Iceberg({ mesh: block, position: [5, 0, 7] }), { label: 'Iceberg', use: ride });
  assertResetLikeFresh(() => new SeaIce({ size: [50, 50], wind: { speed: 12, direction: [0.6, 0.8] }, seed: 9 }), {
    label: 'SeaIce',
    use: ride,
  });
});

test('ShipWakes forget their trails and ShotSplash its splashes (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(
    () =>
      new ShipWakes({
        surface: { onDispose: () => () => {} },
        trail: 200,
        ships: [{ hull: { length: 20, beam: 4, draft: 1 }, path: (t) => [0, 5 * t] }],
      }),
    { label: 'ShipWakes', use: (w) => w.build() },
  );
  const emitter = () => ({ options: {}, burst() {} }),
    impact = { time: 0.2, position: [10, 0.5, 20], velocity: [100, -150, 0], radius: 0.0783, density: 7200 };
  assertResetLikeFresh(() => new ShotSplash({ source: [impact], particles: emitter, slots: 2 }), {
    label: 'ShotSplash',
    use: (s) => s.add({ ...impact, time: 0.4 }),
  });
});

test('Flood.resetTime drops inputs set after tick 0 and makes the Water build a fresh solver (GAP-FILM-RESET)', () => {
  const chunk = readdirSync(new URL('../dist/', import.meta.url)).find((f) => /^query-state-.*\.js$/.test(f));
  const fake = () => ({
    name: 'water-0',
    setWaveHeight() {},
    options: { terrain: { heightmap: () => undefined, origin: [0, 0], size: [10, 10] } },
  });
  const make = () =>
    new Flood({ surface: fake(), boundary: { west: 'sea' }, walls: [{ from: [1, 1], to: [4, 1], top: 2 }] });
  assertResetLikeFresh(make, {
    label: 'Flood',
    use: (f) => {
      f.wall({ from: [2, 5], to: [6, 5], top: 1 });
      f.tsunami({ height: 2, period: 120, at: 30 });
      f.setRainRate(40);
    },
  });
  return import(`../dist/${chunk}`).then((bridge) => {
    const solvers = Object.values(bridge).filter((v) => v instanceof WeakMap),
      water = fake(),
      flood = new Flood({ surface: water }),
      engine = { gpu: {}, hasPlugin: (n) => n === water.name, sceneOf: () => ({ removePlugin() {} }) };
    flood.setup(engine);
    const map = solvers.find((m) => m.has(water)),
      before = map.get(water);
    flood.advanceTime(1);
    flood.resetTime();
    assert.notEqual(map.get(water), before, 'a new factory: the Water rebuilds its flow');
    assert.equal(flood.time, 0);
  });
});

function boxTriangles(w, h, l) {
  const x = [-w / 2, w / 2],
    y = [-h / 2, h / 2],
    z = [-l / 2, l / 2],
    p = (i, j, k) => [x[i], y[j], z[k]],
    quads = [
      [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
      [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
      [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
      [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
      [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
      [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
    ];
  return quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d].flat());
}

test('Water.resetTime makes the next frame build a fresh coastal flow, with no river or solver (GAP-FILM-RESET)', () => {
  // The rebuild compared the recorded river and solver with the current ones; with neither, an unset record compared
  // equal and the reset Water kept the flow it had (and its state) instead of the fresh one a fresh Water builds.
  const h = optionalGPU(),
    terrain = h.engine.gpu.createTexture({
      size: [16, 16],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  const water = new Water({ segments: 4, terrain: { heightmap: () => terrain, origin: [-8, -8], size: [16, 16] } });
  h.engine.use(water);
  h.frame();
  const first = water['coastal'];
  assert.ok(first, 'the first frame builds the flow');
  water.resetTime();
  h.frame();
  assert.notEqual(water['coastal'], first, 'the frame after a reset builds a fresh flow');
  assert.ok(
    first.states.every((t) => t.destroyed),
    "the old flow's state is released",
  );
});
