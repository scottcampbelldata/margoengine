// <Mask> and useMask on a core engine with the GPU test device and the real materials package.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { JSDOM } from 'jsdom';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Mesh, BoxGeometry } = await import('../dist/index.js');
const { Mask, useMask } = await import('../dist/materials.js');
const { TextureMaterial } = await import('../dist/textures.js');
const h = React.createElement,
  engines = [];
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
    );
  engines.push(engine);
  const scene = {
    engine,
    world: null,
    registry: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
    resources: { models: new Set(), lighting: new Map() },
    shadows: null,
  };
  engine.onError = (error) => {
    throw error;
  };
  return { scene, tree: (child) => h(StrictMode, null, h(Context.Provider, { value: scene }, child)) };
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};
function Masked({ inverse }) {
  return h(Mesh, null, h(BoxGeometry), h(TextureMaterial, { color: '#ff0000', ...useMask(3, inverse) }));
}
test('Mask writes its id into the stencil buffer first and useMask tests it, inside or inverted', async () => {
  const { scene, tree } = await context(),
    world = scene.engine.scene,
    models = () => [...world.plugins.values()].filter((plugin) => plugin.primitives),
    stencil = () => [...world.plugins.values()].filter((plugin) => plugin.name === 'materials:stencil-buffer');
  const view = render(tree(h(React.Fragment, null, h(Mask, { id: 3 }, h(BoxGeometry)), h(Masked, { inverse: false }))));
  await settle();
  assert.equal(stencil().length, 1, 'one stencil attachment while a Mask is mounted');
  const [mask, masked] = models().sort((a, b) => a.material.stencilFunc.localeCompare(b.material.stencilFunc));
  assert.deepEqual(
    [mask.material.colorWrite, mask.material.depthWrite, mask.material.stencilWrite, mask.material.stencilRef],
    [false, false, true, 3],
  );
  assert.deepEqual([mask.material.stencilFunc, mask.material.stencilZPass], ['always', 'replace']);
  assert.deepEqual(
    [
      masked.material.stencilWrite,
      masked.material.stencilRef,
      masked.material.stencilFunc,
      masked.material.stencilWriteMask,
    ],
    [true, 3, 'equal', 0],
  );
  view.rerender(tree(h(React.Fragment, null, h(Mask, { id: 3 }, h(BoxGeometry)), h(Masked, { inverse: true }))));
  await settle();
  assert.ok(
    models().some((m) => m.material.stencilFunc === 'not-equal'),
    'inverse draws outside the mask',
  );
  view.unmount();
  await settle();
  assert.equal(stencil().length, 0, 'the last Mask removes the stencil attachment');
  assert.equal(models().length, 0);
});
test('Mask and useMask refuse an id outside 1..255', () => {
  assert.throws(() => useMask(0), /Mask id must be an integer from 1 to 255/);
  assert.throws(() => useMask(256), /Mask id must be an integer from 1 to 255/);
  assert.deepEqual(useMask(255, true), {
    stencilWrite: true,
    stencilRef: 255,
    stencilFunc: 'not-equal',
    stencilWriteMask: 0,
  });
});
