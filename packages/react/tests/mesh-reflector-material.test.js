// MeshReflectorMaterial (drei's): the mesh keeps its own PbrMaterial and a native MeshReflector, parented to the mesh
// and fitted to its flat geometry, draws the reflection over it with the props passed through.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, Suspense } from 'react';
import { JSDOM } from 'jsdom';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });

// The native reflector renders through the GPU; here a stand-in records what the binding asks of it.
const made = [];
let count = 0;
class FakeReflector {
  constructor(options) {
    this.options = options;
    this.name = `fake-reflector-${count++}`;
    made.push(this);
  }
  setup(engine) {
    this.node = engine.createMesh(this.options.parent);
  }
  dispose() {
    this.disposed = true;
  }
}
mock.module('@margoengine/environment/reflector-pbr', { namedExports: { MeshReflector: FakeReflector } });

const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Mesh, BoxGeometry } = await import('../dist/index.js');
const { PlaneGeometry } = await import('../dist/geometry.js');
const { MeshReflectorMaterial } = await import('../dist/materials.js');
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
  const frame = () => act(async () => advanceFrames(scene.frames, engine, 1 / 60));
  return { scene, engine, errors, tree, frame };
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('MeshReflectorMaterial fits a MeshReflector to its plane and passes its props', async () => {
  const { engine, errors, tree, frame } = await context();
  const floor = (props, geometry = h(PlaneGeometry, { args: [4, 2] })) =>
    tree(h(Mesh, { rotation: [-Math.PI / 2, 0, 0] }, geometry, h(MeshReflectorMaterial, props)));
  const view = render(
    floor({
      resolution: 32,
      mixStrength: 40,
      blur: 300,
      mixBlur: 1,
      roughness: 0.5,
      mirror: 0.25,
      depthScale: 2,
      reflectorOffset: -0.1,
      color: '#ffffff',
      metalness: 1,
    }),
  );
  await settle();
  await settle();
  await frame();
  assert.deepEqual(errors, []);
  const live = made.filter((r) => !r.disposed);
  assert.equal(live.length, 1, 'one reflector for the mesh');
  const r = live[0],
    mesh = [...engine.meshes.values()].find((m) => m.geometry && m !== r.node);
  assert.equal(r.options.parent, mesh, 'parented to the mesh');
  assert.deepEqual(r.options.exclude, [mesh], 'the mesh stays out of its own capture');
  assert.deepEqual([r.width, r.height, r.node.visible], [4, 2, true], 'fitted to the plane');
  assert.deepEqual(
    [r.resolution, r.mixStrength, r.blurSize, r.mixBlur, r.mirror, r.depthScale, r.reflectorOffset, r.f0],
    [0.5, 40, [300, 300], 0.5, 0.25, 2, -0.1, [1, 1, 1]],
    'pixels to a canvas fraction, one blur number for both axes, mixBlur times roughness, a metal F0 from its colour',
  );
  view.rerender(floor({}));
  await frame();
  assert.deepEqual(
    [r.resolution, r.mixStrength, r.blurSize, r.mixBlur, r.mirror, r.f0],
    [2, 1, [0, 0], 1, 0, [0.04, 0.04, 0.04]],
    'defaults (256 px on a 64 px canvas is the 2x cap)',
  );
  view.rerender(floor({}, h(BoxGeometry)));
  await frame();
  assert.equal(r.node.visible, false, 'hidden on a geometry that is not flat');
  assert.match(String(errors.at(-1)?.message), /flat geometry in its local XY plane/);
  view.unmount();
  await settle();
  assert.ok(
    made.every((m) => m.disposed),
    'unmount disposes it',
  );
});
