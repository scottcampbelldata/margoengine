// <Merged> on a real core engine: one instanced draw per source, components per source in array and record form.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, box, PbrMaterial: Material } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Merged } = await import('../dist/instances.js');
const h = React.createElement,
  scenes = [];
async function scene() {
  const canvas = document.createElement('canvas'),
    draws = [],
    engine = await Engine.create(canvas, {
      backend: 'webgl2',
      fallback: () => ({
        backend: 'webgl2',
        add() {},
        remove() {},
        render(_c, _l, batches) {
          draws.push(batches.filter((b) => b.count).map((b) => b.count).sort());
        },
        dispose() {},
      }),
    });
  const value = { engine, world: null, registry: null, shadows: null, pointerHandlers: new Map(), frames: { callbacks: new Set() } };
  scenes.push(value);
  const frame = () => {
    for (const f of value.frames.callbacks) f(engine, 0);
    engine.render({ culling: false });
  };
  return { value, engine, draws, frame };
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
test('Merged draws each source once, in array order, with per-instance refs, transforms and tints', async () => {
  const s = await scene(),
    cube = { geometry: box(), material: new Material({ color: '#ffffff', roughness: 0.25 }) },
    slab = { geometry: box(2, 0.2, 2) },
    a = createRef(),
    b = createRef(),
    c = createRef();
  const view = render(
    tree(
      s,
      h(Merged, { meshes: [cube, slab] }, (Cube, Slab) => [
        h(Cube, { key: 1, ref: a, position: [1, 0, 0], color: '#ff0000' }),
        h(Cube, { key: 2, ref: b, position: [-1, 0, 0] }),
        h(Slab, { key: 3, ref: c, position: [0, -1, 0], onClick() {} }),
      ]),
    ),
  );
  await act(async () => {});
  s.frame();
  assert.deepEqual(s.draws.at(-1), [1, 2]);
  assert.equal(a.current.geometry, cube.geometry);
  assert.equal(b.current.geometry, cube.geometry);
  assert.equal(c.current.geometry, slab.geometry);
  assert.deepEqual([...a.current.material.data.slice(0, 3)], [1, 0, 0]);
  assert.ok(Math.abs(b.current.material.data[4] - 0.25) < 1e-6, 'the source material is shared');
  assert.equal(a.current.matrix[12], 1);
  assert.equal(c.current.matrix[13], -1);
  assert.ok(s.value.pointerHandlers.has(c.current.id));
  view.unmount();
  assert.equal(a.current, null);
});
test('Merged with a record hands children a record of components, and refuses a source without geometry', async () => {
  const s = await scene(),
    ref = createRef();
  const view = render(
    tree(s, h(Merged, { meshes: { Box: { geometry: box() } } }, ({ Box }) => h(Box, { ref, scale: [2, 2, 2] }))),
  );
  await act(async () => {});
  s.frame();
  assert.deepEqual(s.draws.at(-1), [1]);
  assert.equal(ref.current.matrix[0], 2);
  view.unmount();
  const { Merged: M } = await import('../dist/instances.js');
  assert.throws(() => M({ meshes: [{ geometry: null }], children: () => null }), /Merged needs a geometry/);
});
