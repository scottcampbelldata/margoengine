// Integration regressions for shared generation, with real world/view data and controlled worker completion.
// The stand-in device records transport only; the package browser suite supplies real GPU evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { BiomeView, viewTile } from '../dist/view.js';
import { presets } from '../dist/presets.js';

const turn = () => new Promise(setImmediate);
const rect = [0, 0, 256, 256];

async function fixture(t, options = {}, worldOptions = {}) {
  const world = await BiomeWorld.create({ size: [1024, 1024], workers: false, ...worldOptions });
  const plugins = [],
    calls = [];
  const engine = {
    backend: 'webgpu',
    gpu: { limits: { maxTextureDimension2D: 8192 }, queue: { writeTexture() {} } },
    camera: { position: [-400, 0, -400] },
    use(plugin) {
      plugins.push(plugin);
    },
    removePlugin() {},
  };
  const view = await BiomeView.attach(engine, world, {
    objects: false,
    water: false,
    radius: 1,
    budget: 500,
    textureResolution: 16,
    ...options,
  });
  t.after(() => {
    view.dispose();
    world.dispose();
  });
  await view.ready;
  const worker = {
    size: 1,
    posts: 0,
    run(message, { signal }) {
      assert.equal(message.op, 'view');
      worker.posts++;
      // Snapshot at submission, like a worker's independent world revision, before a later edit.
      const output = world
        .tile(message.x, message.z)
        .then((tile) => viewTile(world, tile, message.materials, message.step));
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        calls.push({
          message,
          signal,
          reject(reason) {
            signal?.removeEventListener('abort', abort);
            reject(reason);
          },
          async finish() {
            signal?.removeEventListener('abort', abort);
            const value = await output;
            resolve(value);
            return value;
          },
        });
      });
    },
  };
  Object.defineProperty(world, 'workers', { value: worker });
  const frame = () => plugins.find((p) => p.onPreUpdate)?.onPreUpdate(0);
  const stream = async () => {
    engine.camera.position = [128, 0, 128];
    frame();
    frame();
    await turn();
  };
  return { world, view, engine, calls, stream, frame };
}

for (const first of ['streaming', 'prefetch'])
  test(`prefetch and ${first}-first streaming share one worker generation`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    let prefetched;
    if (first === 'streaming') {
      await f.stream();
      prefetched = f.view.prefetch(rect);
    } else {
      prefetched = f.view.prefetch(rect);
      await f.stream();
    }
    await turn();
    assert.equal(f.calls.length, 1, 'one submission for the same tile and revision');
    await f.calls[0].finish();
    await prefetched;
    f.frame();
    await f.view.whenIdle();
    assert.equal(f.view.streaming.pending, 0);
    await f.view.prefetch(rect);
    assert.equal(f.calls.length, 1, 'finished prefetched data stays reusable');
  });

test('prefetch aborts only its subscriber, including when streaming still needs the tile', {
  timeout: 30000,
}, async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    reason = new Error('one caller left');
  const one = f.view.prefetch(rect, { signal: controller.signal });
  const rejected = assert.rejects(one, (e) => e === reason);
  const two = f.view.prefetch(rect);
  await f.stream();
  controller.abort(reason);
  await rejected;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal.aborted, false);
  await f.calls[0].finish();
  await two;
  f.frame();
  await f.view.whenIdle();
});

test('last subscriber abort retires the job and a later caller starts fresh', { timeout: 30000 }, async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    reason = new Error('all callers left');
  const rejected = assert.rejects(f.view.prefetch(rect, { signal: controller.signal }), (e) => e === reason);
  await turn();
  controller.abort(reason);
  await rejected;
  assert.equal(f.calls[0].signal.aborted, true);
  const next = f.view.prefetch(rect);
  await turn();
  assert.equal(f.calls.length, 2);
  await f.calls[1].finish();
  await next;
});

test('shared failure rejects every caller and does not poison a later request', { timeout: 30000 }, async (t) => {
  const f = await fixture(t),
    reason = new Error('worker failure');
  const a = assert.rejects(f.view.prefetch(rect), (e) => e === reason);
  const b = assert.rejects(f.view.prefetch(rect), (e) => e === reason);
  await turn();
  assert.equal(f.calls.length, 1);
  f.calls[0].reject(reason);
  await Promise.all([a, b]);
  const next = f.view.prefetch(rect);
  await turn();
  assert.equal(f.calls.length, 2);
  await f.calls[1].finish();
  await next;
});

test('edits retire prefetch-only generations and old completion cannot replace the new cache', {
  timeout: 30000,
}, async (t) => {
  const f = await fixture(
    t,
    {},
    { biomes: [presets.temperate, presets.desert], height: { field: () => 20 }, climate: { rainfall: 1000 } },
  );
  const old = f.view.prefetch(rect);
  await turn();
  f.world.writeLayer('paint/desert', 2, 2, new Uint8Array(256 * 256).fill(255));
  const fresh = f.view.prefetch(rect);
  await turn();
  assert.equal(f.calls.length, 2, 'revision change needs a new worker generation');
  const current = await f.calls[1].finish();
  await fresh;
  const stale = await f.calls[0].finish();
  await old;
  assert.notDeepEqual(current.weights, stale.weights, 'the worker snapshots span the actual edit');
  await f.view.prefetch(rect);
  assert.equal(f.calls.length, 2, 'old job completion leaves the current cached generation intact');
  const writes = [],
    device = f.engine.gpu;
  device.createTexture = (descriptor) => ({ descriptor, destroy() {} });
  device.queue.writeTexture = (dest, data) => writes.push({ dest, data: data.slice() });
  const usage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
  let textures;
  try {
    textures = f.view.terrain.options.textures(device);
  } finally {
    globalThis.GPUTextureUsage = usage;
  }
  writes.length = 0;
  await f.stream();
  f.frame();
  await f.view.whenIdle();
  assert.equal(f.calls.length, 2, 'streaming consumes the cached result');
  assert.deepEqual(writes.find((w) => w.dest.texture === textures.weights[0]).data, current.weights[0]);
});

test('disposal aborts detached generations and rejects future and cached/empty prefetch', {
  timeout: 30000,
}, async (t) => {
  const f = await fixture(t);
  const old = assert.rejects(f.view.prefetch(rect), (e) => e.code === 'disposed');
  await turn();
  f.world.writeLayer(`paint/${f.world.biomes[0].id}`, 2, 2, new Uint8Array(256 * 256).fill(255));
  const fresh = assert.rejects(f.view.prefetch(rect), (e) => e.code === 'disposed');
  await turn();
  f.view.dispose();
  await Promise.all([old, fresh]);
  assert(f.calls.every((c) => c.signal.aborted));
  await assert.rejects(f.view.prefetch([2000, 2000, 2100, 2100]), (e) => e.code === 'disposed');
});

test('already-aborted prefetch rejects even when no tile is requested or it is cached', {
  timeout: 30000,
}, async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    reason = new Error('already aborted');
  const done = f.view.prefetch(rect);
  await turn();
  await f.calls[0].finish();
  await done;
  controller.abort(reason);
  for (const area of [rect, [2000, 2000, 2100, 2100]])
    await assert.rejects(f.view.prefetch(area, { signal: controller.signal }), (e) => e === reason);
  assert.equal(f.calls.length, 1);
});

test('simultaneous prefetch completions respect the documented 1024-tile cache bound', {
  timeout: 30000,
}, async (t) => {
  const f = await fixture(
    t,
    { textureResolution: 128 },
    {
      size: [4352, 4096],
      tileSize: 128,
      resolution: 4,
      regionResolution: 128,
      height: { field: () => 20 },
    },
  );
  const done = f.view.prefetch(f.world.bounds);
  await turn();
  const total = f.world.tilesX * f.world.tilesZ;
  assert(total > 1024);
  assert.equal(f.calls.length, total, 'the full rectangle is generated');
  await Promise.all(f.calls.map((c) => c.finish()));
  await done;
  f.engine.camera.position = [f.world.bounds[2] - 64, 0, f.world.bounds[3] - 64];
  f.frame();
  f.frame();
  await turn();
  assert.equal(f.calls.length, total + 1, 'streaming regenerates the last tile outside the bounded prefetch cache');
});

for (const started of [false, true])
  test(`disposal cancels ${started ? 'started' : 'queued'} streaming without a prefetch subscriber`, {
    timeout: 30000,
  }, async (t) => {
    const f = await fixture(t);
    f.engine.camera.position = [128, 0, 128];
    f.frame();
    assert.equal(f.view.streaming.pending, 1);
    assert.equal(f.calls.length, 0, 'the first frame queues the worker send');
    if (started) {
      f.frame();
      await turn();
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].signal.aborted, false);
    }
    const plans = f.view.streaming.plans;
    f.view.dispose();
    assert(
      f.calls.every((c) => c.signal.aborted),
      'the lifetime abort reaches started raw work',
    );
    await f.view.whenIdle();
    f.frame();
    await turn();
    assert.equal(f.calls.length, +started, 'queued work never reaches a worker after disposal');
    assert.deepEqual(f.view.streaming, { pending: 0, arrived: 0, plans });
  });
