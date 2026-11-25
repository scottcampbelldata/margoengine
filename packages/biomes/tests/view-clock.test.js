// KB-FILM-CLOCK1: the tiles a frame copies in must not depend on how fast the machine is. The stand-in device records
// transport only; the package browser suite supplies real GPU evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { BiomeView } from '../dist/view.js';

async function timeline(extra, cost) {
  const world = await BiomeWorld.create({ size: [1024, 1024], workers: false }),
    plugins = [],
    engine = {
      backend: 'webgpu',
      gpu: { limits: { maxTextureDimension2D: 8192 }, queue: { writeTexture() {} } },
      camera: { position: [128, 0, 128] },
      use: (p) => plugins.push(p),
      removePlugin() {},
      sceneOf: () => undefined,
    },
    real = performance.now.bind(performance);
  let t = 0;
  performance.now = () => (t += cost);
  const view = await BiomeView.attach(engine, world, {
      objects: false,
      water: false,
      radius: 600,
      textureResolution: 16,
      ...extra,
    }),
    out = [];
  try {
    const frame = () => plugins.find((p) => p.onPreUpdate)?.onPreUpdate(0);
    frame();
    frame();
    // Every tile job the two frames started has come back (no fixed sleep: a loaded machine takes longer).
    for (const deadline = Date.now() + 30000; view.streaming.pending; ) {
      if (Date.now() > deadline) throw new Error(`tile jobs still on their way: ${view.streaming.pending}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    out.push(view.streaming.arrived);
    for (let i = 0; i < 4; i++) {
      frame();
      out.push(view.streaming.arrived);
    }
  } finally {
    performance.now = real;
    view.dispose();
    world.dispose();
  }
  return out;
}

test('maxSteps copies the same tiles on the same frames on a slow machine and a fast one', {
  timeout: 60000,
}, async () => {
  const fast = await timeline({ maxSteps: 2 }, 0.001),
    slow = await timeline({ maxSteps: 2 }, 5);
  assert.deepEqual(slow, fast);
  assert.deepEqual(fast, [16, 14, 12, 10, 8]);
});

test('the live millisecond budget still follows the clock (a slow clock copies fewer tiles a frame)', {
  timeout: 60000,
}, async () => {
  const fast = await timeline({}, 0.001),
    slow = await timeline({}, 5);
  assert.notDeepEqual(slow, fast);
  const clocked = await timeline(
    {
      clock: (() => {
        let n = 0;
        return () => (n += 5);
      })(),
    },
    0.001,
  );
  assert.deepEqual(clocked.slice(1), slow.slice(1));
});

test('maxSteps and clock are checked', { timeout: 60000 }, async () => {
  const world = await BiomeWorld.create({ size: [1024, 1024], workers: false }),
    engine = {
      backend: 'webgpu',
      gpu: { limits: { maxTextureDimension2D: 8192 } },
      camera: { position: [0, 0, 0] },
      use() {},
      removePlugin() {},
      sceneOf: () => undefined,
    };
  await assert.rejects(BiomeView.attach(engine, world, { maxSteps: 0 }), RangeError);
  await assert.rejects(BiomeView.attach(engine, world, { clock: 3 }), TypeError);
  world.dispose();
});
