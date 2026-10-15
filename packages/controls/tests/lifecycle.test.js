import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { OrbitControls, TransformControls } from '../dist/index.js';

class Target {
  listeners = new Map();
  calls = 0;
  failAt = Infinity;
  clientWidth = 800;
  clientHeight = 600;
  style = { touchAction: 'auto' };
  addEventListener(type, listener) {
    if (++this.calls === this.failAt) throw this.failure;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  get count() {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}
function engine(canvas) {
  return {
    canvas,
    camera: new Camera({ position: [0, 0, 10], target: [0, 0, 0] }),
    disposed: false,
    plugins: new Map(),
    use(plugin) {
      this.plugins.set(plugin.name, plugin);
      plugin.setup();
    },
    hasPlugin(name) {
      return this.plugins.has(name);
    },
    removePlugin(name) {
      const plugin = this.plugins.get(name);
      this.plugins.delete(name);
      plugin?.dispose();
    },
  };
}

test('failed camera/gizmo listener initialization releases partial listeners and engine plugins', () => {
  for (const [Control, listenerCount] of [
    [OrbitControls, 7],
    [TransformControls, 5],
  ])
    for (let failAt = 1; failAt <= listenerCount; failAt++) {
      const target = new Target(),
        runtime = engine(target),
        failure = new Error(`listener ${failAt}`);
      target.failAt = failAt;
      target.failure = failure;
      assert.throws(
        () => new Control(runtime),
        (error) => error === failure,
      );
      assert.equal(target.count, 0, `${Control.name}: partial listeners`);
      assert.equal(target.style.touchAction, 'auto');
      assert.equal(runtime.plugins.size, 0, `${Control.name}: engine plugin`);
    }
});

test('failed reconnect leaves controls disconnected and allows a later successful connection', () => {
  for (const Control of [OrbitControls, TransformControls]) {
    const original = new Target(),
      runtime = engine(original),
      control = new Control(runtime);
    const failed = new Target();
    failed.failAt = 2;
    failed.failure = new Error('reconnect');
    assert.throws(
      () => control.connect(failed),
      (error) => error === failed.failure,
    );
    assert.equal(original.count, 0);
    assert.equal(failed.count, 0);
    assert.equal(control.element, null);
    assert.equal(failed.style.touchAction, 'auto');
    const next = new Target();
    control.connect(next);
    assert.ok(next.count > 0);
    control.dispose();
    assert.equal(next.count, 0);
    assert.equal(runtime.plugins.size, 0);
  }
});

test('disposed camera/gizmo controls reject reconnect without installing listeners', () => {
  for (const Control of [OrbitControls, TransformControls]) {
    const target = new Target(),
      runtime = engine(target),
      control = new Control(runtime);
    control.dispose();
    assert.throws(() => control.connect(target), /disposed/);
    control.dispose();
    assert.equal(target.count, 0);
    assert.equal(runtime.plugins.size, 0);
  }
});

test('failed GPU overlay growth retains a usable buffer and retries growth successfully', () => {
  const savedUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { VERTEX: 32, COPY_DST: 8 };
  const target = new Target(),
    control = new TransformControls(engine(target)),
    resources = [],
    writes = [],
    pipelines = [];
  const failure = new Error('buffer growth');
  let allocations = 0;
  const device = {
    createShaderModule: () => ({}),
    createRenderPipeline(descriptor) {
      pipelines.push(descriptor);
      return {};
    },
    createBuffer({ size }) {
      if (++allocations === 2) throw failure;
      const resource = {
        size,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      resources.push(resource);
      return resource;
    },
    queue: {
      writeBuffer(buffer) {
        assert.equal(buffer.destroyed, false, 'writing a destroyed buffer');
        writes.push(buffer);
      },
    },
  };
  const ctx = {
    backend: 'webgpu',
    device,
    format: 'bgra8unorm',
    color: {},
    descriptor: { multisample: { count: 4 } },
    encoder: { beginRenderPass: () => ({ setPipeline() {}, setVertexBuffer() {}, draw() {}, end() {} }) },
  };
  try {
    control.overlay.draw(ctx, new Float32Array(24));
    const original = resources[0];
    assert.throws(
      () => control.overlay.draw(ctx, new Float32Array(2048)),
      (error) => error === failure,
    );
    assert.equal(original.destroyed, false, 'allocation failure must preserve the old usable buffer');
    control.overlay.draw(ctx, new Float32Array(24));
    assert.equal(writes.at(-1), original);
    control.overlay.draw(ctx, new Float32Array(2048));
    assert.notEqual(writes.at(-1), original);
    assert.equal(original.destroyed, true);
    assert.equal(pipelines.length, 1);
    assert.equal(pipelines[0].multisample.count, 4);
  } finally {
    control.dispose();
    if (savedUsage === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = savedUsage;
  }
  assert.ok(resources.every((resource) => resource.destroyed));
});
