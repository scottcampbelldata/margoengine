// CubeCamera and the PbrMaterial envMap prop: the cube follows its group, leaves its children out and feeds envMap.
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
    this.updates.push({ faces, position: [...this.position], exclude: [...this.exclude].map((m) => m.id) });
    return faces;
  }
  dispose() {
    this.disposed = true;
  }
}
mock.module('@margoengine/environment/cube-camera', { namedExports: { CubeCamera: FakeCube } });

const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Mesh, PbrMaterial, BoxGeometry } = await import('../dist/index.js');
const { TextureProvider } = await import('../dist/textures.js');
const { CubeCamera } = await import('../dist/environment.js');
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
    h(
      StrictMode,
      null,
      h(Context.Provider, { value: scene }, h(TextureProvider, null, h(Suspense, { fallback: null }, child))),
    );
  return { scene, engine, errors, tree };
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('PbrMaterial envMap reaches the native material as a six-layer GPUTexture, and a new one replaces it', async () => {
  const { scene, errors, tree } = await context();
  const cube = (label) => ({ label, depthOrArrayLayers: 6, dimension: '2d', createView: () => ({}) });
  const first = cube('first'),
    second = cube('second');
  const view = render(tree(h(Mesh, null, h(BoxGeometry), h(PbrMaterial, { envMap: first, envMapIntensity: 0.5 }))));
  await settle();
  await settle();
  const models = () => [...scene.engine.scene.plugins.values()].filter((plugin) => plugin.primitives);
  assert.deepEqual(errors, []);
  assert.equal(models().length, 1);
  assert.equal(models()[0].material.envMap, first);
  assert.equal(models()[0].material.envMapIntensity, 0.5);
  view.rerender(tree(h(Mesh, null, h(BoxGeometry), h(PbrMaterial, { envMap: second }))));
  await settle();
  await settle();
  assert.equal(models().length, 1);
  assert.equal(models()[0].material.envMap, second);
  assert.equal(models()[0].material.envMapIntensity, 1);
  view.unmount();
  await settle();
});

test('CubeCamera captures at its group, leaves its children out, hands the texture to children and stops after frames', async () => {
  const { scene, engine, errors, tree } = await context();
  const seen = [],
    created = [];
  const cubeCamera = (props) =>
    h(
      CubeCamera,
      {
        position: [1, 2, 3],
        resolution: 64,
        near: 0.5,
        far: 50,
        mips: true,
        onCreated: (c) => created.push(c),
        ...props,
      },
      (texture) => {
        seen.push(texture);
        return h(Mesh, { position: [0, 1, 0] }, h(BoxGeometry));
      },
    );
  const view = render(
    tree(h(StrictMode, null, cubeCamera({ frames: 2 }), h(Mesh, { position: [5, 0, 0] }, h(BoxGeometry)))),
  );
  await settle();
  await settle();
  assert.deepEqual(errors, []);
  const live = made.filter((c) => !c.disposed);
  assert.equal(live.length, 1, 'one native cube camera while mounted');
  const native = live[0];
  assert.deepEqual(native.options, { size: 64, near: 0.5, far: 50, mips: true });
  assert.equal(created.at(-1), native);
  assert.equal(seen.at(-1), native.texture, 'children get the live texture');
  for (let i = 0; i < 4; i++) await act(async () => advanceFrames(scene.frames, engine, 1 / 60));
  assert.equal(native.updates.length, 2, 'frames={2} captures the first two frames only');
  assert.deepEqual(native.updates[0].position, [1, 2, 3], 'at the group world origin');
  assert.equal(native.updates[0].faces, 6);
  // The group and the reflective child are left out; the other box is captured.
  const outside = [...engine.meshes.values()].find((m) => m.matrix[12] === 5);
  assert.ok(outside);
  assert.ok(!native.updates[0].exclude.includes(outside.id));
  assert.equal(native.updates[0].exclude.length, 2);
  // A replaced texture (device restore) reaches the children.
  native.version = 1;
  native.texture = { label: 'restored' };
  view.rerender(tree(h(StrictMode, null, cubeCamera({ frames: Infinity }))));
  await act(async () => advanceFrames(scene.frames, engine, 1 / 60));
  await settle();
  assert.equal(seen.at(-1).label, 'restored');
  view.unmount();
  await settle();
  assert.ok(
    made.every((c) => c.disposed),
    'unmount disposes the native cube camera',
  );
});

test('CubeCamera refuses a frame count that is not a positive integer', async () => {
  const { tree } = await context();
  for (const frames of [0, 1.5, -1])
    assert.throws(
      () => render(tree(h(CubeCamera, { frames }))),
      /CubeCamera frames must be a positive integer or Infinity/,
    );
});

test('CubeCamera inside a named <Scene> leaves its group out of its cube and keeps its private fog in that scene', async () => {
  const { scene, engine, errors, tree } = await context();
  const world = engine.createScene('item');
  scene.world = world;
  const view = render(
    tree(
      h(CubeCamera, { resolution: 64, frames: 1, fog: { far: 20 } }, () =>
        h(Mesh, { position: [0, 1, 0] }, h(BoxGeometry)),
      ),
    ),
  );
  await settle();
  await settle();
  await act(async () => advanceFrames(scene.frames, engine, 1 / 60));
  await settle();
  assert.deepEqual(errors, []);
  const native = made.find((c) => !c.disposed);
  assert.equal(native.updates.length, 1, 'the cube captures a frame');
  assert.equal(native.updates[0].exclude.length, 2, 'the group and its child, both in the named scene, are left out');
  const fogs = (plugins) => [...plugins.values()].filter((p) => p.name?.startsWith('cube-camera-fog'));
  assert.equal(fogs(world.plugins).length, 1, 'the private fog is in the named scene');
  assert.equal(fogs(engine.scene.plugins).length, 0, 'not in the default scene');
  view.unmount();
  await settle();
  assert.equal(fogs(world.plugins).length, 0, 'unmount removes it');
});
