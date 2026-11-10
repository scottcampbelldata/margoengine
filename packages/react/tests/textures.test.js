import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, Suspense } from 'react';
import { JSDOM } from 'jsdom';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Mesh, PbrMaterial, BoxGeometry } = await import('../dist/index.js');
const { TextureMaterial, TextureProvider, useTexture, useKTX2 } = await import('../dist/textures.js');
const { Texture, Material, PbrMaterial: NativePbrMaterial, UnlitMaterial, PhongMaterial } = await import('@margoengine/materials');
const h = React.createElement;
const engines = [];
afterEach(async () => { cleanup(); await act(async () => {}); for (const engine of engines.splice(0)) engine.dispose(); });
async function context(named = false) {
  const gpu = optionalGPU();
  const engine = new Engine({ width: 64, height: 64 }, await TransformStore.create(64), {
    backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {},
  }, { position: [0, 0, 4], target: [0, 0, 0] }, null);
  engines.push(engine);
  const { createAssetCache } = await import('../dist/assets.js');
  const scene = { engine, world: named ? engine.createScene('textures') : null, registry: null, pointerHandlers: new Map(), frames: { callbacks: new Set() }, resources: { models: new Set(), lighting: new Map() }, shadows: null, assetCache: createAssetCache(engine) };
  engine.onError = (error) => { throw error; };
  return { scene, tree: (child) => h(StrictMode, null, h(Context.Provider, { value: scene }, h(TextureProvider, null, h(Suspense, { fallback: null }, child)))) };
}
const tex = () => new Texture({ data: new Uint8Array([128, 128, 255, 255]), width: 1, height: 1 });
test('every native material class binds all map slots in both Scenes, survives updates and releases models', async () => {
  for (const named of [false, true]) for (const Type of [Material, NativePbrMaterial, UnlitMaterial, PhongMaterial]) {
    const { scene, tree } = await context(named);
    const texture = tex(), material = new Type({ color: '#ffffff' });
    const child = (roughness) => h(Mesh, null, h(BoxGeometry), h(TextureMaterial, { material, map: texture, normalMap: texture, roughnessMap: texture, emissiveMap: texture, roughness }));
    const view = render(tree(child(0.7)));
    await act(async () => {});
    const world = scene.world ?? scene.engine.scene;
    const models = () => [...world.plugins.values()].filter((plugin) => plugin.primitives);
    assert.equal(models().length, 1);
    assert.equal(models()[0].material.map, texture);
    assert.equal(models()[0].material.normalMap, texture);
    assert.equal(models()[0].material.emissiveMap, texture);
    assert.equal(material.map, null, 'borrowed material unchanged');
    assert.equal(models()[0].material.metalRoughnessMap, texture);
    const { pbrShader } = await import('../../gltf-pro/src/shader.ts');
    assert.ok(!models()[0].material.shader(pbrShader, 3).includes('mr.b*f.factors.y'), 'roughness leaves metalness independent');
    view.rerender(tree(child(0.2))); await act(async () => {});
    assert.equal(models().length, 1);
    assert.equal(models()[0].material.roughness, 0.2);
    view.unmount(); await act(async () => {});
    assert.equal(models().length, 0);
    assert.equal(scene.engine.meshes.size, 0);
    material.dispose(); texture.dispose();
  }
});
test('root PbrMaterial map props use preserved Box UVs in a named Scene', async () => {
  const { scene, tree } = await context(true);
  const texture = tex();
  const view = render(tree(h(Mesh, null, h(BoxGeometry), h(PbrMaterial, { normalMap: texture, roughnessMap: texture, emissiveMap: texture }))));
  await act(async () => { await import('../dist/textures.js'); });
  const model = [...scene.world.plugins.values()].find((plugin) => plugin.primitives);
  assert.ok(model);
  assert.ok(model.primitives[0].vertices.some((v, i) => i % 20 === 12 && v !== 0), 'UVs survive core geometry');
  view.unmount(); await act(async () => {}); texture.dispose();
});
test('a separate roughness map preserves a borrowed material metalness map and shader channel', async () => {
  const { scene, tree } = await context(true), metalness = tex(), roughness = tex();
  const material = new Material({ metalRoughnessMap: metalness, metalness: 0.8 });
  const view = render(tree(h(Mesh, null, h(BoxGeometry), h(TextureMaterial, { material, roughnessMap: roughness }))));
  await act(async () => {});
  const model = [...scene.world.plugins.values()].find((plugin) => plugin.primitives);
  assert.equal(model.material.metalRoughnessMap, metalness);
  const { pbrShader } = await import('../../gltf-pro/src/shader.ts');
  const shader = model.material.features[0].shader(model.material.shader(pbrShader, 3), 3, model.material);
  assert.ok(shader.includes('mr.b*f.factors.y'), 'the original blue channel still controls metalness');
  assert.ok(shader.includes('textureSample(reactRoughness,reactRoughnessSampler,reactRoughUV(i)).g*f.factors.x'));
  view.unmount(); await act(async () => {});
  assert.equal(material.metalRoughnessMap, metalness);
  material.dispose(); metalness.dispose(); roughness.dispose();
});
test('image hooks return scalar, tuple and record shapes with cached loading and decoder cancellation signals', async () => {
  const { tree } = await context();
  const originalFetch = globalThis.fetch, originalBitmap = globalThis.createImageBitmap;
  let loads = 0, closes = 0, result, decoded = 0;
  globalThis.fetch = async () => { loads++; return new Response(new Uint8Array([1, 2, 3])); };
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() { closes++; } });
  const decoder = { async transcode(_, { signal }) { assert.ok(signal instanceof AbortSignal); decoded++; return { width: 1, height: 1, format: 'rgba8unorm', levels: [{ data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 }] }; } };
  function Read() {
    const one = useTexture('/image.png');
    const array = useTexture(['/image.png', '/image2.png']);
    const record = useTexture({ normalMap: '/normal.png', emissiveMap: '/emissive.png' });
    const ktx = useKTX2('/map.ktx2', { decoder });
    result = { one, array, record, ktx }; return null;
  }
  try {
    const view = render(tree(h(Read)));
    // Sequential Suspense reveals can start the next hook only after the prior load resolves.
    for (let i = 0; i < 4; i++) await act(async () => {});
    assert.ok(result.one instanceof Texture); assert.equal(result.array.length, 2);
    assert.deepEqual(Object.keys(result.record), ['normalMap', 'emissiveMap']);
    assert.ok(result.ktx instanceof Texture); assert.equal(decoded, 1);
    view.rerender(tree(h(Read))); await act(async () => {});
    assert.equal(loads, 6, 'rerender reuses each cached request');
    view.unmount(); engines[0].dispose();
    assert.equal(closes, 5, 'each owned bitmap closes with the Canvas');
  } finally { globalThis.fetch = originalFetch; globalThis.createImageBitmap = originalBitmap; }
});
