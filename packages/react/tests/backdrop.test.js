// <Backdrop> on a real core engine and the real staging builder: a cyclorama mesh with UVs along the sweep.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { backdropGeometry } = await import('@margoengine/studio/backdrop');
const { Context } = await import('../dist/internal.js');
const { PbrMaterial } = await import('../dist/index.js');
const { Backdrop } = await import('../dist/geometry.js');
const { geometrySources } = await import('../dist/texture-geometry.js');
const h = React.createElement,
  scenes = [];
async function scene() {
  const canvas = document.createElement('canvas'),
    engine = await Engine.create(canvas, {
      backend: 'webgl2',
      fallback: () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} }),
    });
  const value = {
    engine,
    world: null,
    registry: null,
    shadows: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
  };
  scenes.push(value);
  return { value, engine };
}
const tree = (s, children) => h(StrictMode, null, h(Context.Provider, { value: s.value }, children));
afterEach(() => {
  cleanup();
  for (const s of scenes) {
    assert.equal(s.engine.meshes.size, 0);
    s.engine.dispose();
  }
  scenes.length = 0;
});
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};
test('Backdrop builds the staging cyclorama with a matte default and UVs across and along the sweep', async () => {
  const s = await scene(),
    ref = createRef();
  const view = render(tree(s, h(Backdrop, { ref, width: 4, segments: 8, position: [0, -1, 0] })));
  await settle();
  const expected = backdropGeometry({ width: 4, segments: 8 }),
    geometry = ref.current.geometry;
  assert.deepEqual([...geometry.vertices], [...expected.vertices]);
  assert.deepEqual([...geometry.indices], [...expected.indices]);
  assert.equal(ref.current.receiveShadow, true);
  assert.deepEqual(
    [...ref.current.material.data.slice(0, 3)].map((v) => Math.round(v * 1000)),
    [479, 479, 479],
  );
  const uvs = geometrySources.get(geometry).uvs;
  assert.deepEqual([...uvs.slice(0, 4)], [0, 0, 1, 0], 'front edge: u 0..1, v 0');
  assert.deepEqual([...uvs.slice(-4)], [0, 1, 1, 1], 'wall top: v 1');
  for (let i = 3; i < uvs.length; i += 2) assert.ok(uvs[i] >= uvs[i - 2], 'v grows along the sweep');
  view.rerender(tree(s, h(Backdrop, { ref, width: 4, segments: 16 })));
  await settle();
  assert.equal(ref.current.geometry.vertices.length / 6, (16 + 3) * 2);
});
test('a material child replaces the matte default', async () => {
  const s = await scene(),
    ref = createRef();
  render(tree(s, h(Backdrop, { ref }, h(PbrMaterial, { color: '#000000', roughness: 0.25 }))));
  await settle();
  assert.deepEqual([...ref.current.material.data.slice(0, 3)], [0, 0, 0]);
});
test('an invalid shape reports the staging error to onError', async () => {
  const s = await scene(),
    errors = [];
  s.engine.onError = () => {};
  render(tree(s, h(Backdrop, { radius: 10, onError: (e) => errors.push(e) })));
  await settle();
  assert.match(String(errors[0]?.message), /Invalid backdrop dimensions/);
});
