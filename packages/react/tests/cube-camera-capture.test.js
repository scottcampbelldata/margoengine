// CubeCamera envMap and fog (drei's): the faces draw their own background and fog, the main view keeps the scene's.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, Suspense } from 'react';
import { JSDOM } from 'jsdom';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });

// The native CubeCamera renders through the GPU; here a stand-in records what the binding asks of it.
const made = [];
class FakeCube {
  constructor(options) {
    this.options = options;
    this.version = 0;
    this.updates = [];
    this.layers = 0xffffffff;
    this.texture = { label: 'cube 0', depthOrArrayLayers: 6, dimension: '2d', createView: () => ({}) };
    made.push(this);
  }
  setup() {}
  get name() {
    return 'fake-cube';
  }
  update(faces) {
    const fogs = [...engines.at(-1).plugins.values()].filter((p) => p instanceof FakeFog);
    this.updates.push({
      faces,
      background: this.background,
      fogs: fogs.map((f) => ({
        name: f.name,
        enabled: f.enabled,
        color: f.color,
        near: f.near,
        far: f.far,
        density: f.density,
      })),
    });
    return faces;
  }
  dispose() {
    this.disposed = true;
  }
}
mock.module('@margoengine/environment/cube-camera', { namedExports: { CubeCamera: FakeCube } });
// The environment package's Fog, Environment and EnvironmentBackground stand-ins: plain values the binding swaps.
class FakeFog {
  constructor(options = {}) {
    this.name = options.name ?? 'fog';
    Object.assign(this, {
      color: '#ffffff',
      near: 1,
      far: 1000,
      density: 0,
      heightFalloff: 0,
      height: 0,
      enabled: true,
    });
  }
  static attach(engine, options) {
    const fog = new FakeFog(options);
    engine.use(fog);
    return fog;
  }
  setup() {}
  add(model) {
    (this.models ??= new Set()).add(model);
    return () => this.models.delete(model);
  }
  dispose() {
    this.disposed = true;
  }
}
const loads = [];
class FakeBackground {
  constructor(environment, options) {
    this.environment = environment;
    this.name = options?.name;
  }
  dispose() {
    this.disposed = true;
  }
}
const environmentMock = {
  namedExports: {
    Fog: FakeFog,
    EnvironmentBackground: FakeBackground,
    loadEnvironmentImage: async (src) => (loads.push(src), { src }),
    Environment: {
      create: async (engine, image, options) => ({
        name: options.name,
        image,
        setup() {},
        dispose() {
          this.disposed = true;
        },
      }),
    },
  },
};
// The bindings import /main and /loaders (KB-REACT-ENVDECODERS1); mock every specifier they may use.
for (const id of ['@margoengine/environment', '@margoengine/environment/main', '@margoengine/environment/loaders'])
  mock.module(id, environmentMock);

const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { CubeCamera, Fog } = await import('../dist/environment.js');
const { advanceFrames } = await import('../dist/frame-priority.js');
const h = React.createElement;
const engines = [];
afterEach(async () => {
  cleanup();
  await act(async () => {});
  for (const engine of engines.splice(0)) engine.dispose();
  made.length = 0;
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
  return { scene, engine, errors, tree };
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const frame = () => act(async () => advanceFrames(scene_.frames, scene_.engine, 1 / 60));
let scene_;

test('CubeCamera fog sets the scene fog for the faces only, and fog={false} turns it off there', async () => {
  const { scene, engine, errors, tree } = await context();
  scene_ = scene;
  const view = render(
    tree(
      h(
        React.Fragment,
        null,
        h(Fog, { color: '#ff0000', near: 2, far: 20 }),
        h(CubeCamera, { fog: { color: '#0000ff', far: 5 } }),
      ),
    ),
  );
  await settle();
  await settle();
  await frame();
  assert.deepEqual(errors, []);
  const native = made.find((c) => !c.disposed),
    fog = [...engine.plugins.values()].find((p) => p instanceof FakeFog);
  assert.deepEqual(
    native.updates.at(-1).fogs,
    [{ name: 'fog', enabled: true, color: '#0000ff', near: 1, far: 5, density: 0 }],
    'the faces see the CubeCamera fog, its left-out options at their defaults',
  );
  assert.deepEqual(
    [fog.color, fog.near, fog.far, fog.enabled],
    ['#ff0000', 2, 20, true],
    'the main view keeps its own',
  );
  view.rerender(
    tree(h(React.Fragment, null, h(Fog, { color: '#ff0000', near: 2, far: 20 }), h(CubeCamera, { fog: false }))),
  );
  await settle();
  await frame();
  assert.equal(native.updates.at(-1).fogs[0].enabled, false);
  assert.equal(fog.enabled, true);
  view.unmount();
  await settle();
});

test('CubeCamera fog without a scene Fog draws a private fog in the faces, off in the main view, dropped on unmount', async () => {
  const { scene, engine, errors, tree } = await context();
  scene_ = scene;
  const view = render(tree(h(CubeCamera, { fog: { color: '#00ff00', density: 0.1 } })));
  await settle();
  await settle();
  await frame();
  assert.deepEqual(errors, []);
  const native = made.find((c) => !c.disposed),
    [face] = native.updates.at(-1).fogs;
  assert.deepEqual([face.enabled, face.color, face.density], [true, '#00ff00', 0.1]);
  const own = [...engine.plugins.values()].find((p) => p instanceof FakeFog);
  assert.equal(own.enabled, false, 'off in the main view');
  view.unmount();
  await settle();
  assert.ok(![...engine.plugins.values()].some((p) => p instanceof FakeFog));
  assert.ok(own.disposed);
});

test('CubeCamera envMap loads its own environment, holds the faces until then, and the main view keeps its background', async () => {
  const { scene, engine, errors, tree } = await context();
  scene_ = scene;
  const view = render(tree(h(CubeCamera, { envMap: '/studio.hdr', frames: 1 })));
  await settle();
  await settle();
  await frame();
  await frame();
  assert.deepEqual(errors, []);
  assert.deepEqual(loads, ['/studio.hdr']);
  const native = made.find((c) => !c.disposed);
  assert.equal(native.updates.length, 1, 'a single-frame capture waits for the background');
  const background = native.updates[0].background;
  assert.ok(background instanceof FakeBackground);
  assert.equal(background.environment.image.src, '/studio.hdr');
  assert.ok(engine.hasPlugin(background.environment.name), 'the environment is attached for its device lifetime');
  assert.ok(![...engine.plugins.values()].includes(background), 'the background is never a main-view pass');
  view.rerender(tree(h(CubeCamera, { frames: 2 })));
  await settle();
  await frame();
  assert.equal(native.updates.at(-1).background, null, 'without envMap the faces draw the scene background');
  assert.ok(background.disposed && background.environment.disposed);
  view.unmount();
  await settle();
});
