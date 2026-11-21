// Environment children and Lightformer (drei's): the children are captured into the environment the scene is lit by
// and hidden in the main view; a Lightformer is an emissive form placed by its props.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, Suspense } from 'react';
import { JSDOM } from 'jsdom';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });

// GPU stand-ins: each records what the bindings ask of it.
const cubes = [],
  formers = [],
  created = [],
  loads = [];
class FakeCube {
  constructor(options) {
    this.options = options;
    this.updates = [];
    this.texture = { label: 'cube' };
    this.name = `fake-cube-${cubes.length}`;
    cubes.push(this);
  }
  setup() {}
  update(faces) {
    const engine = engines.at(-1);
    this.updates.push({
      faces,
      background: this.background,
      position: this.position,
      exclude: [...this.exclude],
      shown: [...engine.meshes.values()].filter((m) => m.visible).map((m) => m.name),
    });
    return faces;
  }
  dispose() {
    this.disposed = true;
    engines.at(-1)?.scene.plugins.get(this.name) === this && engines.at(-1).removePlugin(this.name);
  }
}
mock.module('@margoengine/environment/cube-camera', { namedExports: { CubeCamera: FakeCube } });
class FakeLightformer {
  constructor(options) {
    Object.assign(this, options);
    this.name = `former-${formers.length}`;
    formers.push(this);
  }
  setup(engine) {
    this.node = engine.createMesh(this.parent);
    this.node.name = this.name;
  }
  dispose() {
    this.disposed = true;
  }
}
mock.module('@margoengine/environment/lightformer', {
  namedExports: {
    get Lightformer() {
      return FakeLightformer;
    },
  },
});
class FakeBackground {
  constructor(environment, options) {
    this.environment = environment;
    this.name = options?.name ?? `background:${environment.name}`;
  }
  setup() {}
  dispose() {
    this.disposed = true;
  }
}
class FakeColorBackground {
  constructor(options) {
    this.options = options;
    this.name = options?.name;
  }
  setup() {}
  dispose() {
    this.disposed = true;
  }
}
class FakeLighting {
  constructor(environment) {
    this.environment = environment;
    this.name = `lighting:${environment.name}`;
  }
  setup() {}
  dispose() {
    this.disposed = true;
  }
}
const environmentMock = {
  namedExports: {
    EnvironmentBackground: FakeBackground,
    ColorBackground: FakeColorBackground,
    EnvironmentLighting: FakeLighting,
    loadEnvironmentImage: async (src) => (loads.push(src), { src }),
    Environment: {
      create: async (engine, source, options) => {
        const value = {
          name: options?.name ?? 'environment',
          source,
          refreshes: 0,
          setup() {},
          refresh() {
            this.refreshes++;
            return Promise.resolve();
          },
          dispose() {
            this.disposed = true;
          },
        };
        created.push(value);
        return value;
      },
    },
  },
};
// The bindings import /main and /loaders (KB-REACT-ENVDECODERS1); mock every specifier they may use.
for (const id of ['@margoengine/environment', '@margoengine/environment/main', '@margoengine/environment/loaders'])
  mock.module(id, environmentMock);

const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Mesh, BoxGeometry } = await import('../dist/index.js');
const { Environment, Lightformer } = await import('../dist/environment.js');
const { advanceFrames } = await import('../dist/frame-priority.js');
const h = React.createElement;
const engines = [];
afterEach(async () => {
  cleanup();
  await act(async () => {});
  for (const engine of engines.splice(0)) engine.dispose();
  cubes.length = formers.length = created.length = loads.length = 0;
});
async function context() {
  const gpu = optionalGPU();
  const engine = new Engine(
    { width: 64, height: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  engines.push(engine);
  const { createAssetCache } = await import('../dist/assets.js');
  const errors = [];
  const scene = {
    engine,
    world: null,
    registry: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set(), elapsed: 0, last: null, mode: 'always' },
    resources: { models: new Set(), lighting: new Map() },
    shadows: null,
    assetCache: createAssetCache(engine),
  };
  engine.onError = (error) => errors.push(error);
  const tree = (child) =>
    h(StrictMode, null, h(Context.Provider, { value: scene }, h(Suspense, { fallback: null }, child)));
  const frame = () => act(async () => advanceFrames(scene.frames, engine, 1 / 60));
  return { scene, engine, errors, tree, frame };
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('Lightformer passes form, colour and intensity through and sizes and turns its node', async () => {
  const { errors, tree } = await context();
  const view = render(
    tree(
      h(Lightformer, {
        form: 'ring',
        intensity: 4,
        color: '#ff0000',
        scale: [2, 3],
        position: [5, 0, 0],
        target: [0, 0, 0],
      }),
    ),
  );
  await settle();
  await settle();
  assert.deepEqual(errors, []);
  const former = formers.find((f) => !f.disposed);
  assert.deepEqual([former.form, former.intensity, former.color], ['ring', 4, '#ff0000']);
  assert.ok(former.parent, 'parented to the Mesh the props place');
  const xyz = (v) => [v.x, v.y, v.z];
  assert.deepEqual(xyz(former.node.scale), [2, 3, 1], '[width, height] scales x and y');
  // Facing -X (from x = 5 toward the origin): +Z turned onto -X about +Y, a -90 degree turn.
  const turn = xyz(former.node.rotation),
    expected = [0, -Math.PI / 2, 0];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(turn[i] - expected[i]) < 1e-6, `rotation ${turn} toward the target`);
  view.rerender(tree(h(Lightformer, { form: 'circle', intensity: 2, color: [0, 1, 0], scale: 5 })));
  await settle();
  assert.deepEqual([former.form, former.intensity, former.color], ['circle', 2, [0, 1, 0]], 'live, no rebuild');
  assert.deepEqual(xyz(former.node.scale), [5, 5, 5]);
  assert.deepEqual(xyz(former.node.rotation), [0, 0, 0], 'no target, no turn');
  assert.equal(formers.filter((f) => !f.disposed).length, 1);
  view.unmount();
  await settle();
  assert.ok(former.disposed);
});

test('Lightformer rejects a malformed scale with a coded error', async () => {
  const { tree } = await context();
  const original = console.error;
  console.error = () => {};
  try {
    assert.throws(() => render(tree(h(Lightformer, { scale: [1, 2, 3, 4] }))), /Lightformer scale/);
  } finally {
    console.error = original;
  }
});

test('Environment children are captured once into the lighting, over black, and hidden in the main view', async () => {
  const { engine, errors, tree, frame } = await context();
  const view = render(
    tree(
      h(
        React.Fragment,
        null,
        h(Mesh, { position: [0, 0, 0] }, h(BoxGeometry)),
        h(Environment, { resolution: 64 }, h(Lightformer, { form: 'rect', intensity: 3, position: [0, 2, 0] })),
      ),
    ),
  );
  await settle();
  await settle();
  await frame();
  await settle();
  await frame();
  await settle();
  assert.deepEqual(errors, []);
  const cube = cubes.find((c) => !c.disposed),
    former = formers.find((f) => !f.disposed);
  assert.deepEqual([cube.options.size, cube.options.near, cube.options.far], [64, 1, 1000]);
  assert.equal(cube.updates.length, 1, 'frames 1 captures once');
  const [capture] = cube.updates;
  assert.ok(capture.background instanceof FakeColorBackground, 'over a colour background');
  assert.equal(capture.background.options.color, '#000000');
  assert.ok(capture.shown.includes(former.name), 'the Lightformer is shown in its capture');
  assert.equal(capture.exclude.length, 1, 'the scene box outside the Environment is left out');
  assert.equal(former.node.visible, false, 'the Lightformer is hidden in the main view');
  const environment = created.find((e) => e.source === cube);
  assert.ok(environment, 'the cube becomes the environment');
  assert.ok(engine.hasPlugin(environment.name));
  assert.ok(
    [...engine.plugins.values()].some((p) => p instanceof FakeLighting && p.environment === environment),
    'the captured environment lights the scene',
  );
  assert.ok(
    [...engine.plugins.values()].some((p) => p instanceof FakeBackground && p.environment === environment),
    'and is the background',
  );
  await frame();
  assert.equal(cube.updates.length, 1);
  view.unmount();
  await settle();
  assert.ok(environment.disposed && cube.disposed && former.disposed);
});

test('Environment frames above 1 refresh the captured environment in place', async () => {
  const { errors, tree, frame } = await context();
  render(tree(h(Environment, { frames: 3 }, h(Lightformer, { position: [0, 0, -2] }))));
  await settle();
  await settle();
  for (let i = 0; i < 5; i++) {
    await frame();
    await settle();
  }
  assert.deepEqual(errors, []);
  const cube = cubes.find((c) => !c.disposed);
  assert.equal(cube.updates.length, 3);
  assert.equal(created.filter((e) => e.source === cube).length, 1, 'one environment');
  assert.equal(created.find((e) => e.source === cube).refreshes, 2, 'refreshed by the later captures');
});

test('Environment src with children draws the src environment behind them and lights with the capture', async () => {
  const { engine, errors, tree, frame } = await context();
  render(tree(h(Environment, { src: '/studio.hdr' }, h(Lightformer, { position: [0, 0, -2] }))));
  for (let i = 0; i < 4; i++) {
    await settle();
    await frame();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(loads, ['/studio.hdr']);
  const cube = cubes.find((c) => !c.disposed),
    [capture] = cube.updates;
  assert.ok(capture.background instanceof FakeBackground);
  assert.deepEqual(capture.background.environment.source, { src: '/studio.hdr' });
  const captured = created.find((e) => e.source === cube);
  const lighting = [...engine.plugins.values()].filter((p) => p instanceof FakeLighting);
  assert.deepEqual(
    lighting.map((p) => p.environment),
    [captured],
    'the capture lights the scene, not the bare src',
  );
});
