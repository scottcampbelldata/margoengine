import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// Svg builds its meshes with the real parseSVG of @margoengine/loaders/svg, the real geometry builders and real
// @margoengine/materials meshes on a core engine; only the GPU device and the network are stand-ins.
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Svg } = await import('../dist/geometry.js');
const { parseSVG } = await import('@margoengine/loaders/svg');
const { shapeGeometry } = await import('@margoengine/geometry');
const h = React.createElement,
  engines = [],
  fetched = [];
const drawing = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="10" y="10" width="40" height="20" fill="#ff0000" fill-opacity="0.5"/>
  <circle cx="70" cy="70" r="20" fill="none" stroke="#0000ff" stroke-width="4"/>
  <path d="M10 90 L40 60" stroke="#00ff00" stroke-width="2" stroke-opacity="0.25"/>
</svg>`;
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  return String(url).endsWith('missing.svg')
    ? { ok: false, status: 404 }
    : { ok: true, status: 200, text: async () => drawing };
};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
afterEach(async () => {
  cleanup();
  await act(async () => {});
  for (const engine of engines.splice(0)) engine.dispose();
});
async function context() {
  const gpu = optionalGPU(),
    engine = new Engine(
      { width: 64, height: 64 },
      await TransformStore.create(64),
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    errors = [];
  engines.push(engine);
  engine.onError = (error) => errors.push(error);
  const scene = {
    engine,
    world: null,
    registry: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
    resources: { models: new Set(), lighting: new Map() },
    shadows: null,
  };
  const parent = (mesh) => engine.meshes.get(engine.store.parents[mesh.id]);
  const models = () => [...engine.scene.plugins.values()].filter((plugin) => plugin.primitives);
  return {
    engine,
    scene,
    errors,
    models,
    parent,
    tree: (child) => h(StrictMode, null, h(Context.Provider, { value: scene }, child)),
  };
}

test('Svg draws each fill and stroke as an unlit transparent mesh in document order with its colour and opacity', async () => {
  const { scene, errors, models, parent, tree } = await context(),
    ref = createRef(),
    loaded = [];
  const view = render(tree(h(Svg, { ref, src: drawing, position: [1, 0, 0], onLoad: (svg) => loaded.push(svg) })));
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].viewBox, [0, 0, 100, 100]);
  const meshes = models();
  // The rect's fill, the circle's stroke and the line's stroke: no fill for `fill="none"`, no stroke where none is set.
  assert.equal(meshes.length, 3);
  const materials = meshes.map((mesh) => mesh.material);
  assert.deepEqual(
    materials.map((m) => [m.shading, m.opacity, m.transparent, m.depthWrite]),
    [
      ['basic', 0.5, true, false],
      ['basic', 1, true, false],
      ['basic', 0.25, true, false],
    ],
  );
  assert.deepEqual(
    [...scene.resources.models].map((mesh) => mesh.renderOrder),
    [0, 1, 2],
    'painted in document order',
  );
  const rect = parseSVG(drawing).paths[0],
    fill = shapeGeometry(rect.toShapes(), 12);
  assert.equal(meshes[0].primitives[0].indices.length, fill.indices.length, 'the fill is shapeGeometry of the path');
  assert.ok(
    meshes.every((mesh) => parent(parent(mesh.root)) === ref.current),
    'every part sits in the group',
  );
  assert.equal(ref.current.position.x, 1);
  view.unmount();
  await settle();
  assert.equal(models().length, 0, 'unmounting releases every part');
});

test('Svg skips fills or strokes, applies material and mesh props over the defaults, and flips y on request', async () => {
  const { errors, models, parent, tree } = await context();
  const view = render(tree(h(Svg, { src: drawing, skipFill: true, strokeMaterial: { color: '#ffffff', opacity: 1 } })));
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(models().length, 2, 'only the strokes');
  assert.ok(models().every((mesh) => mesh.material.opacity === 1));
  view.rerender(tree(h(Svg, { src: drawing, skipStrokes: true, flipY: true, fillMeshProps: { position: [0, 0, 2] } })));
  await settle();
  const [fill] = models();
  assert.equal(models().length, 1, 'only the fill');
  assert.equal(parent(fill.root).position.z, 2, 'fillMeshProps reach the fill mesh');
  const ys = [...fill.primitives[0].vertices].filter((_, i) => i % 20 === 1);
  assert.ok(
    Math.max(...ys) <= -10 + 1e-4 && Math.min(...ys) >= -30 - 1e-4,
    `flipped y: ${Math.min(...ys)}..${Math.max(...ys)}`,
  );
  view.unmount();
  await settle();
});

test('Svg fetches a URL, and reports a failed load through onError', async () => {
  const { errors, models, tree } = await context(),
    failures = [];
  render(tree(h(Svg, { src: '/art/logo.svg' })));
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(fetched.includes('/art/logo.svg'));
  assert.equal(models().length, 3);
  render(tree(h(Svg, { src: '/art/missing.svg', onError: (error) => failures.push(error) })));
  await settle();
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /missing\.svg answered 404/);
});
