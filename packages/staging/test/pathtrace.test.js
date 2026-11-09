import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressiveStill } from '../dist/pathtrace.js';
import { MeshPathTracer } from '@margoengine/voxel-pathtracer/mesh';

function harness(t) {
  const passes = [],
    plugins = new Map(),
    tracer = {
      enabled: true,
      stats: { samples: 0 },
      ready: Promise.resolve(),
      status: 'ready',
      resets: 0,
      reset() {
        this.resets++;
      },
      dispose() {
        this.status = 'disposed';
        this.disposals = (this.disposals ?? 0) + 1;
      },
      async setScene(s, { signal } = {}) {
        signal?.throwIfAborted();
        if (s === 'bad') throw new RangeError('bad snapshot');
        this.scene = s;
      },
      renderImage(o) {
        return Promise.resolve(o);
      },
      capture(o) {
        return Promise.resolve(o);
      },
    };
  t.mock.method(MeshPathTracer, 'create', async (_engine, options) => {
    tracer.options = options;
    return tracer;
  });
  const engine = {
    use(p) {
      plugins.set(p.name, p);
      p.setup(this);
      p.registerPasses({
        add(pass) {
          passes.push(pass);
        },
      });
    },
    sceneOf(p) {
      assert.equal(plugins.get(p.name), p);
      return {
        removePlugin(name) {
          plugins.delete(name);
        },
      };
    },
  };
  const context = {
    backend: 'webgpu',
    width: 64,
    height: 64,
    delta: 0.125,
    camera: { matrix: new Float32Array(16), position: [0, 1, 4], target: [0, 0, 0], up: [0, 1, 0] },
  };
  const frame = () => passes[0].execute(context);
  return { tracer, engine, plugins, context, frame, passes };
}
test('still waits for idle, resets on every camera and dimension change, and owns its renderer', async (t) => {
  const h = harness(t),
    s = await ProgressiveStill.attach(h.engine, { scene: { models: [] }, idleDelay: 0.25 });
  assert.equal(s.active, false);
  assert.equal(h.tracer.options.order, 20);
  assert.equal(h.passes[0].order, 19);
  h.frame();
  h.frame();
  assert.equal(s.active, false);
  h.frame();
  assert.equal(s.active, true);
  for (const change of [
    () => h.context.camera.matrix[0]++,
    () => h.context.camera.position[0]++,
    () => h.context.camera.target[0]++,
    () => h.context.camera.up[0]++,
    () => h.context.width++,
    () => h.context.height++,
  ]) {
    change();
    h.frame();
    assert.equal(s.active, false);
    h.frame();
    h.frame();
    assert.equal(s.active, true);
  }
  const resets = h.tracer.resets;
  s.invalidate();
  assert.equal(s.active, false);
  assert.equal(h.tracer.resets, resets + 1);
  h.frame();
  h.context.delta = Number.MAX_VALUE;
  h.frame();
  assert.equal(s.active, true, 'huge finite delta saturates');
  s.onDeviceRestored(h.engine);
  assert.equal(s.active, false);
  h.context.delta = 0.125;
  h.frame();
  h.frame();
  h.frame();
  assert.equal(s.active, true);
  assert.equal(s.stats, h.tracer.stats);
  await s.ready;
  s.dispose();
  s.dispose();
  assert.equal(h.tracer.disposals, 1);
  assert.equal(h.plugins.size, 0);
  assert.equal(s.active, false);
  assert.throws(() => s.invalidate(), { code: 'disposed' });
});
test('hostile idle/delta values reject; exact zero starts immediately; multiple views refuse explicitly', async (t) => {
  const h = harness(t);
  for (const options of [undefined, null, [], {}])
    await assert.rejects(
      ProgressiveStill.attach(h.engine, options),
      (error) => error instanceof TypeError && error.message.includes('https://margoengine.com/errors#'),
    );
  for (const idleDelay of [-1, 61, NaN, Infinity, -Infinity])
    await assert.rejects(ProgressiveStill.attach(h.engine, { scene: { models: [] }, idleDelay }), RangeError);
  const s = await ProgressiveStill.attach(h.engine, { scene: { models: [] }, idleDelay: 0 });
  try {
    h.frame();
    assert.equal(s.active, true);
    for (const delta of [-1, NaN, Infinity]) {
      h.context.delta = delta;
      assert.throws(h.frame, RangeError);
    }
    h.context.delta = 0;
    h.context.view = { count: 2 };
    assert.throws(h.frame, (e) => e.code === 'unsupported' && e.message.includes('https://'));
  } finally {
    s.dispose();
  }
});
test('failed or cancelled scene replacement preserves active history; successful update restarts idle', async (t) => {
  const h = harness(t),
    s = await ProgressiveStill.attach(h.engine, { scene: { models: [] }, idleDelay: 0 });
  h.frame();
  assert.equal(s.active, true);
  const resets = h.tracer.resets;
  await assert.rejects(s.setScene('bad'), RangeError);
  assert.equal(s.active, true);
  assert.equal(h.tracer.resets, resets);
  await assert.rejects(s.setScene({}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(s.active, true);
  await s.setScene({ revision: 2 });
  assert.equal(s.active, false);
  assert.equal(h.tracer.resets, resets + 1);
  assert.deepEqual(await s.renderImage({ width: 16 }), { width: 16 });
  assert.deepEqual(await s.capture({ height: 16 }), { height: 16 });
  s.dispose();
});
test('controller registration failure rolls back the already-created renderer', async (t) => {
  const h = harness(t);
  h.engine.use = () => {
    throw new Error('registration failed');
  };
  await assert.rejects(ProgressiveStill.attach(h.engine, { scene: { models: [] } }), /registration failed/);
  assert.equal(h.tracer.disposals, 1);
});

test('attachment snapshots caller arrays before lazy module loading, retaining content-key identity', async (t) => {
  const h = harness(t),
    key = () => 'identity, not cloneable';
  const input = {
    models: [{ contentKey: key, voxels: new Uint8Array([1]) }],
    meshes: [{ positions: new Float32Array([1, 2, 3]) }],
  };
  const pending = ProgressiveStill.attach(h.engine, { scene: input });
  input.models[0].voxels[0] = 9;
  input.meshes[0].positions[0] = 9;
  const still = await pending;
  try {
    assert.equal(h.tracer.options.scene.models[0].voxels[0], 1);
    assert.equal(h.tracer.options.scene.meshes[0].positions[0], 1);
    assert.equal(h.tracer.options.scene.models[0].contentKey, key);
  } finally {
    still.dispose();
  }
});

test('temporal raster jitter does not reset the idle timer or tracer, including zero delay', async (t) => {
  const { temporalCameraSource } = await import('../../shared/temporal-camera.js');
  const { jitterProjection } = await import('../../taa/dist/index.js');
  for (const idleDelay of [0.25, 0]) {
    const h = harness(t),
      still = await ProgressiveStill.attach(h.engine, { scene: { models: [] }, idleDelay });
    const camera = h.context.camera,
      jittered = Object.assign(Object.create(camera), {
        matrix: new Float32Array(16),
        [temporalCameraSource]: camera,
      });
    for (let i = 0; i < 16; i++) {
      jitterProjection(jittered.matrix, camera.matrix, i, 64, 64);
      h.context.camera = jittered;
      h.frame();
      if (still.active) assert.equal(h.context.camera, camera, 'the integrator receives the unjittered camera');
      h.passes[1].execute(h.context);
      assert.equal(h.context.camera, jittered, 'raster camera restored before the temporal resolve');
    }
    assert(still.active);
    assert.equal(h.tracer.resets, 1, 'one history reset for a stationary camera');
    camera.matrix[0]++;
    h.frame();
    h.passes[1].execute(h.context);
    assert.equal(h.tracer.resets, 2, 'real projection edits still invalidate');
    still.dispose();
  }
});

test('a failed trace frame cannot restore a stale raster camera on a later idle frame', async (t) => {
  const { temporalCameraSource } = await import('../../shared/temporal-camera.js');
  const h = harness(t),
    still = await ProgressiveStill.attach(h.engine, { scene: { models: [] }, idleDelay: 0.25 });
  const source = h.context.camera,
    first = Object.assign(Object.create(source), { [temporalCameraSource]: source });
  h.context.camera = first;
  h.frame();
  h.frame();
  h.frame();
  assert(still.active);
  // A throw from the integrator would prevent the order-21 restore pass from running.
  const moved = { ...source, position: [1, 1, 4] },
    current = Object.assign(Object.create(moved), { [temporalCameraSource]: moved });
  h.context.camera = current;
  h.frame();
  assert(!still.active);
  h.passes[1].execute(h.context);
  assert.equal(h.context.camera, current, 'the next raster frame retains its current camera');
  still.dispose();
});
