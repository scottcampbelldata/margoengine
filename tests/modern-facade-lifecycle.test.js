import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';

const constructed = [];
function plugin(name) {
  return class {
    constructor(options = {}) {
      this.name = name;
      this.options = options;
      this.frames = 0;
      this.disposals = 0;
      constructed.push(this);
    }
    setup(engine) {
      this.buffer = engine.gpu.createBuffer();
      if (this.options.failAt === 'setup') throw this.options.error;
    }
    registerPasses(graph) {
      graph.add({ name: `${this.name}:test`, order: 1, execute: () => this.frames++ });
      if (this.options.failAt === 'register') throw this.options.error;
    }
    dispose() {
      this.disposals++;
      this.buffer?.destroy();
    }
  };
}

const SkyMoon = plugin('sky-moon'),
  GPUParticles = plugin('gpu-particles'),
  PostProcessing = plugin('post-processing');
const Shadows = class extends plugin('shadows') {
  casters = [];
  add(mesh) {
    this.casters.push(mesh);
    return () => {};
  }
};
// EnvironmentLighting.load owns fetching, abort checks and attachment (tested in packages/environment); the stage forwards to it.
const loads = [];
const EnvironmentLighting = {
  async load(...args) {
    loads.push(args);
    return { name: 'environment:lighting' };
  },
};
mock.module('@margoengine/scenery/sky', { namedExports: { SkyMoon } });
mock.module('@margoengine/creative/particles', { namedExports: { GPUParticles } });
mock.module('@margoengine/creative/post', { namedExports: { PostProcessing } });
mock.module('@margoengine/shadows', { namedExports: { Shadows } });
mock.module('@margoengine/environment', { namedExports: { EnvironmentLighting } });
const { Stage } = await import('../packages/margoengine/dist/index.js');
const features = [
  ['sky', SkyMoon],
  ['particles', GPUParticles],
  ['effects', PostProcessing],
  ['shadows', Shadows],
];

async function scene() {
  const store = await TransformStore.create(2),
    resources = new Set(),
    buffers = [];
  const gpu = {
    createBuffer() {
      const buffer = {
        destroys: 0,
        destroy() {
          this.destroys++;
          resources.delete(this);
        },
      };
      buffers.push(buffer);
      resources.add(buffer);
      return buffer;
    },
  };
  const renderer = { backend: 'webgpu', gpu, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    store,
    renderer,
    undefined,
    null,
  );
  return { app: new Stage(engine), engine, resources, buffers };
}

test('facade feature helpers preserve options, plugin identity, passes and owned-resource disposal', async () => {
  const { app, engine, resources, buffers } = await scene();
  const attached = [];
  try {
    for (const [method, Class] of features) {
      const options = { label: method },
        effect = await app[method](options);
      assert.ok(effect instanceof Class);
      assert.equal(effect.options, options);
      assert.equal(engine.hasPlugin(effect.name), true);
      attached.push(effect);
    }
    assert.equal(resources.size, features.length);
    engine.frameGraph.execute({ backend: 'webgpu', draw() {} });
    assert.deepEqual(
      attached.map((effect) => effect.frames),
      features.map(() => 1),
    );
  } finally {
    app.dispose();
  }
  app.dispose();
  assert.equal(resources.size, 0);
  assert.deepEqual(
    attached.map((effect) => effect.disposals),
    features.map(() => 1),
  );
  assert.deepEqual(
    buffers.map((buffer) => buffer.destroys),
    features.map(() => 1),
  );
});

test('shadows casts from the meshes present when it is called', async () => {
  const { app } = await scene();
  try {
    const box = app.box(),
      orb = app.sphere();
    const shadows = await app.shadows();
    assert.deepEqual(shadows.casters, [box, orb]);
    app.box();
    assert.equal(shadows.casters.length, 2, 'later meshes are added by the caller');
  } finally {
    app.dispose();
  }
});

test('environment hands the stage engine, source and options to EnvironmentLighting.load and returns its lighting', async () => {
  const { app, engine } = await scene(),
    options = { intensity: 2 };
  try {
    const lighting = await app.environment('/studio.hdr', options);
    assert.deepEqual(loads.at(-1), [engine, '/studio.hdr', options]);
    assert.equal(lighting.name, 'environment:lighting');
  } finally {
    app.dispose();
  }
});

for (const [method, Class] of features) {
  test(`${method} does not construct or attach a plugin when disposal wins the import race`, async () => {
    for (const disposeEngine of [false, true]) {
      const { app, engine, resources } = await scene(),
        before = constructed.length;
      const pending = app[method]({ label: 'pending' });
      const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
      if (disposeEngine) engine.dispose();
      else app.dispose();
      await rejected;
      assert.equal(constructed.length, before, 'A disposed stage constructed an orphan plugin');
      assert.equal(resources.size, 0);
      assert.equal(engine.disposed, true);
      await assert.rejects(app[method](), (error) => error.name === 'AbortError');
      assert.equal(constructed.length, before);
    }
  });

  for (const failAt of ['setup', 'register']) {
    test(`${method} releases partially allocated resources after ${failAt} failure and can retry`, async () => {
      const { app, engine, resources, buffers } = await scene();
      const error = new Error(`${method} ${failAt} failure`);
      let failed, attached;
      try {
        await assert.rejects(app[method]({ failAt, error }), (value) => value === error);
        failed = constructed.at(-1);
        assert.ok(failed instanceof Class);
        assert.equal(failed.disposals, 1);
        assert.equal(resources.size, 0);
        assert.equal(buffers[0].destroys, 1);
        assert.equal(engine.hasPlugin(failed.name), false);
        engine.frameGraph.execute({ backend: 'webgpu', draw() {} });
        assert.equal(failed.frames, 0, 'A failed plugin retained its frame pass');

        attached = await app[method]();
        assert.equal(engine.hasPlugin(attached.name), true);
        assert.equal(resources.size, 1);
        engine.frameGraph.execute({ backend: 'webgpu', draw() {} });
        assert.equal(attached.frames, 1);
        assert.equal(failed.frames, 0);
      } finally {
        app.dispose();
      }
      assert.equal(resources.size, 0);
      assert.equal(failed.disposals, 1);
      assert.equal(attached.disposals, 1);
      assert.deepEqual(
        buffers.map((buffer) => buffer.destroys),
        [1, 1],
      );
    });
  }
}
