// KB-WEATHER-MATERIALSWET1: every Material mesh joins its scene's surface hooks (`materialSurface` of the
// `weather-puddles`, `weather-snow` and `weather-cover` plugins) by itself, in their order, and leaves them when they go.
// The GPU proof that a wet Material then matches a wet core surface is packages/weather/tests/material-wet-browser.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Material, createMesh, materialSurfaceHooks } from '../dist/index.js';
import { SceneSurfaces } from '../src/scene-surfaces.ts';

function world() {
  const runtime = {},
    plugins = new Map();
  let reads = 0;
  const scene = {
    plugins: {
      get: (name) => {
        reads++;
        return plugins.get(name);
      },
    },
  };
  runtime.sceneOf = () => scene;
  const model = {
    lighting: [],
    addLighting(effect) {
      this.lighting.push(effect);
      return () => this.lighting.splice(this.lighting.indexOf(effect), 1);
    },
  };
  const effect = (order) => ({ order, owner: runtime, shader: (s) => s, bindings: () => [] });
  return { runtime, plugins, model, effect, reads: () => reads };
}

test('a Material mesh joins its scene surface hooks in their order and leaves them when they go', () => {
  const { runtime, plugins, model, effect } = world();
  const surfaces = new SceneSurfaces(runtime);
  const puddles = effect(-1),
    snow = effect(-1),
    cover = effect(-0.5);
  // The cover attached first still composes after the entries it shelters, as its core pass follows theirs.
  plugins.set('weather-cover', { name: 'weather-cover', materialSurface: cover });
  plugins.set('weather-puddles', { name: 'weather-puddles', materialSurface: puddles });
  surfaces.next();
  surfaces.sync(model, true);
  assert.deepEqual(model.lighting, [puddles, cover]);
  // Frame after frame with the same plugins nothing is added again.
  for (let k = 0; k < 5; k++) {
    surfaces.next();
    surfaces.sync(model, true);
  }
  assert.deepEqual(model.lighting, [puddles, cover]);
  plugins.set('weather-snow', { name: 'weather-snow', materialSurface: snow });
  surfaces.next();
  surfaces.sync(model, true);
  assert.deepEqual(model.lighting, [puddles, snow, cover]);
  plugins.delete('weather-puddles');
  surfaces.next();
  surfaces.sync(model, true);
  assert.deepEqual(model.lighting, [snow, cover]);
  // An unlit mesh, or one with sceneSurfaces false, leaves them.
  surfaces.sync(model, false);
  assert.deepEqual(model.lighting, []);
  surfaces.sync(model, true);
  assert.deepEqual(model.lighting, [snow, cover]);
});

test('only effects of this engine with shader and bindings join; the scene is read once a frame', () => {
  const { runtime, plugins, model, effect, reads } = world();
  const surfaces = new SceneSurfaces(runtime);
  plugins.set('weather-puddles', { name: 'weather-puddles', materialSurface: { ...effect(-1), owner: {} } });
  plugins.set('weather-snow', { name: 'weather-snow', materialSurface: { order: -1, owner: runtime } });
  plugins.set('weather-cover', { name: 'weather-cover' });
  plugins.set('other', { name: 'other', materialSurface: effect(0) });
  surfaces.next();
  const others = Array.from({ length: 100 }, () => ({ ...model, lighting: [] }));
  for (const m of others) surfaces.sync(m, true);
  assert.ok(others.every((m) => m.lighting.length === 0));
  // A hundred meshes in one scene read its plugins once this frame.
  assert.equal(reads(), materialSurfaceHooks.length);
  assert.deepEqual(materialSurfaceHooks, ['weather-puddles', 'weather-snow', 'weather-cover']);
});

test('createMesh meshes take the scene surface hooks by default; sceneSurfaces is a live boolean', async () => {
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(32),
    { backend: 'webgpu', gpu: mockGPU().device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  try {
    const mesh = createMesh(
      engine,
      { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0] },
      new Material(),
    );
    assert.equal(mesh.sceneSurfaces, true);
    mesh.sceneSurfaces = false;
    assert.equal(mesh.sceneSurfaces, false);
    assert.throws(() => {
      mesh.sceneSurfaces = 1;
    }, TypeError);
    mesh.dispose();
  } finally {
    engine.dispose();
  }
});
