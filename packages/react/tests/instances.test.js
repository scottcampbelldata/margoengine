import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, box, PbrMaterial: Material } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Instances, Instance } = await import('../dist/instances.js');
const { BoxGeometry, PbrMaterial, Group } = await import('../dist/index.js');
const h = React.createElement,
  scenes = [];
async function scene(named = false) {
  const canvas = document.createElement('canvas'),
    draws = [],
    engine = await Engine.create(canvas, {
      backend: 'webgl2',
      fallback: () => ({
        backend: 'webgl2',
        add() {},
        remove() {},
        render(_c, _l, batches) {
          draws.push(batches.filter((b) => b.count).map((b) => b.count));
        },
        dispose() {},
      }),
    });
  const world = named ? engine.createScene('instances') : null;
  const value = {
    engine,
    world,
    registry: null,
    shadows: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
  };
  scenes.push(value);
  const frame = () => {
    for (const f of value.frames.callbacks) f(engine, 0);
    engine.render({
      culling: false,
      ...(world ? { views: [{ scene: world, camera: engine.camera, viewport: [0, 0, 1, 1] }] } : {}),
    });
  };
  return { ...value, value, draws, frame };
}
const tree = (s, children) => h(StrictMode, null, h(Context.Provider, { value: s.value }, children));
afterEach(() => {
  cleanup();
  for (const s of scenes) {
    assert.equal(s.engine.meshes.size, 0);
    assert.equal(s.pointerHandlers.size, 0);
    assert.equal(s.frames.callbacks.size, 0);
    s.engine.dispose();
  }
  scenes.length = 0;
});
test('shared geometry draws once with independent native refs, transforms, tints and pointer identities', async () => {
  const s = await scene(),
    a = createRef(),
    b = createRef(),
    root = createRef();
  const view = render(
    tree(
      s,
      h(
        Instances,
        { ref: root, position: [1, 0, 0] },
        h(BoxGeometry),
        h(PbrMaterial, { color: '#ffffff', roughness: 0.8 }),
        h(Instance, {
          ref: a,
          color: '#ff0000',
          position: [-1, 0, 0],
          rotation: [0, 0.3, 0],
          scale: [2, 1, 1],
          onClick() {},
        }),
        h(Group, { position: [2, 0, 0] }, h(Instance, { ref: b, color: '#00ff00', onPointerOver() {} })),
      ),
    ),
  );
  await act(async () => {});
  s.frame();
  assert.deepEqual(s.draws.at(-1), [2]);
  assert.equal(root.current.geometry, null);
  assert.equal(a.current.geometry, b.current.geometry);
  assert.notEqual(a.current.material, b.current.material);
  assert.deepEqual([...a.current.material.data.slice(0, 3)], [1, 0, 0]);
  assert.deepEqual([...b.current.material.data.slice(0, 3)], [0, 1, 0]);
  assert.ok(Math.abs(a.current.material.data[4] - 0.8) < 1e-6);
  assert.equal(a.current.matrix[12], 0);
  assert.equal(b.current.matrix[12], 3);
  assert.ok(s.pointerHandlers.has(a.current.id));
  assert.ok(s.pointerHandlers.has(b.current.id));
  const live = a.current;
  live.setPosition([2, 0, 0]);
  s.frame();
  assert.equal(a.current, live);
  assert.equal(a.current.matrix[12], 3);
  view.unmount();
  assert.equal(a.current, null);
  assert.equal(b.current, null);
});
test('named Scene, range, unmount, prototype replacement and live material edits keep shared drawing', async () => {
  const s = await scene(true),
    a = createRef(),
    b = createRef(),
    geometry = box(),
    next = box(2, 1, 1),
    material = new Material({ color: '#ffffff' });
  const content = (range, geometry, color = '#ffffff', second = true) =>
    tree(
      s,
      h(
        Instances,
        { geometry, material, limit: 2, range },
        h(Instance, { ref: a, color, key: 'a' }),
        second && h(Instance, { ref: b, key: 'b' }),
      ),
    );
  const view = render(content(1, geometry));
  await act(async () => {});
  s.frame();
  assert.equal(a.current.scene, s.world);
  assert.equal(a.current.geometry, geometry);
  assert.equal(b.current.geometry, null);
  const first = a.current;
  view.rerender(content(2, next, '#ff0000'));
  await act(async () => {});
  s.frame();
  assert.equal(a.current, first);
  assert.equal(a.current.geometry, next);
  assert.equal(b.current.geometry, next);
  assert.deepEqual(s.draws.at(-1), [2]);
  material.set({ color: [0.5, 0.5, 0.5] });
  s.frame();
  assert.deepEqual([...a.current.material.data.slice(0, 3)], [0.5, 0, 0]);
  view.rerender(content(2, next, '#ffffff', false));
  await act(async () => {});
  s.frame();
  assert.deepEqual(s.draws.at(-1), [1]);
  assert.equal(b.current, null);
  view.rerender(content(0, next));
  await act(async () => {});
  s.frame();
  assert.deepEqual(s.draws.at(-1), []);
});
test('instance visibility and nested providers stay independent', async () => {
  const s = await scene(),
    a = createRef(),
    b = createRef(),
    ga = box(),
    gb = box(2, 2, 2);
  const view = render(
    tree(
      s,
      h(
        Instances,
        { geometry: ga },
        h(Instance, { ref: a, visible: false }),
        h(Instances, { geometry: gb }, h(Instance, { ref: b })),
      ),
    ),
  );
  await act(async () => {});
  s.frame();
  assert.equal(a.current.geometry, ga);
  assert.equal(b.current.geometry, gb);
  assert.equal(a.current.visible, false);
  assert.deepEqual(s.draws.at(-1), [1]);
  view.unmount();
});
