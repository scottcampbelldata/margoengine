// <Outlines> on a real core engine with the toon MeshOutline replaced by a recorder (its GPU drawing has its own suite in
// packages/toon/test/outline.browser.mjs): the enclosing mesh, drei's props, live edits, re-attach and release.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { JSDOM } from 'jsdom';
const made = [];
class FakeOutline {
  static attach(engine, options) {
    const outline = new FakeOutline(options);
    made.push(outline);
    return outline;
  }
  constructor(options) {
    Object.assign(this, options);
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
  }
}
mock.module('@margoengine/toon/outline', { namedExports: { MeshOutline: FakeOutline } });
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Mesh, BoxGeometry } = await import('../dist/index.js');
const { Outlines, outlineRGB } = await import('../dist/outlines.js');
const h = React.createElement,
  scenes = [];
async function scene() {
  const canvas = document.createElement('canvas'),
    engine = await Engine.create(canvas, {
      backend: 'webgl2',
      fallback: () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} }),
    });
  const value = { engine, world: null, registry: null, shadows: null, pointerHandlers: new Map(), frames: { callbacks: new Set() } };
  scenes.push(value);
  return value;
}
const tree = (s, children) => h(StrictMode, null, h(Context.Provider, { value: s }, children));
afterEach(() => {
  cleanup();
  for (const s of scenes) s.engine.dispose();
  scenes.length = 0;
  made.length = 0;
});
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const live = () => made.filter((o) => !o.disposed);

test('outlineRGB reads hex as sRGB and numbers as linear', () => {
  assert.deepEqual(outlineRGB(undefined), [0, 0, 0]);
  assert.deepEqual(outlineRGB([0.2, 0.4, 2]), [0.2, 0.4, 2]);
  assert.deepEqual(outlineRGB('#fff'), [1, 1, 1]);
  assert.ok(Math.abs(outlineRGB('#808080')[0] - 0.2158605) < 1e-6);
  assert.throws(() => outlineRGB('red'), RangeError);
});

test('Outlines outlines the enclosing mesh with drei props, applies edits live and releases on unmount', async () => {
  const s = await scene(),
    ready = [];
  const ui = (props) =>
    tree(s, h(Mesh, { position: [1, 0, 0] }, h(BoxGeometry), h(Outlines, { onReady: (o) => ready.push(o), ...props })));
  const view = render(ui({ thickness: 0.1, color: '#ffffff', screenspace: true, angle: 0 }));
  await settle();
  assert.equal(live().length, 1);
  const outline = live()[0];
  assert.equal(ready.at(-1), outline);
  assert.equal(outline.mesh.geometry.indices.length, 36, 'the enclosing box');
  assert.deepEqual([outline.thickness, outline.screenspace, outline.angle], [0.1, true, 0]);
  assert.deepEqual(outline.color, [1, 1, 1]);
  view.rerender(ui({ thickness: 0.3, color: [0, 1, 0], screenspace: true, angle: 0, transparent: true, opacity: 0.5 }));
  await settle();
  assert.equal(live().length, 1, 'a prop edit keeps the outline');
  assert.deepEqual([outline.thickness, outline.transparent, outline.opacity], [0.3, true, 0.5]);
  assert.deepEqual(outline.color, [0, 1, 0]);
  view.rerender(ui({ thickness: 0.3, renderOrder: 2 }));
  await settle();
  assert.equal(live().length, 1);
  assert.notEqual(live()[0], outline, 'renderOrder re-attaches');
  assert.equal(live()[0].renderOrder, 2);
  view.unmount();
  assert.equal(live().length, 0);
});

// drei outlines an instancedMesh parent: inside <Instances> each drawn instance gets its own hull. The outline used
// to take the Instances root, whose geometry Instances clears, so nothing was drawn.
test('Outlines inside Instances outlines every drawn instance and follows mounts, limit and unmount', async () => {
  const { Instances, Instance } = await import('../dist/instances.js');
  const s = await scene();
  const ui = (n, limit) =>
    tree(
      s,
      h(
        Instances,
        { limit },
        h(BoxGeometry),
        h(Outlines, { thickness: 0.2, color: '#ff0000' }),
        ...Array.from({ length: n }, (_, i) => h(Instance, { key: i, position: [i, 0, 0] })),
      ),
    );
  const view = render(ui(3));
  await settle();
  const frame = async () => {
    for (const f of [...s.frames.callbacks]) f(1 / 60);
    await settle();
  };
  await frame();
  assert.equal(live().length, 3, 'one outline per instance');
  assert.equal(new Set(live().map((o) => o.mesh)).size, 3, 'each on its own instance mesh');
  assert(live().every((o) => o.geometry === undefined && o.mesh.geometry.indices.length === 36 && o.thickness === 0.2));
  view.rerender(ui(2));
  await frame();
  assert.equal(live().length, 2, 'an unmounted instance releases its outline');
  view.rerender(ui(4, 1));
  await frame();
  assert.equal(live().length, 1, 'instances past limit draw no outline');
  view.unmount();
  assert.equal(live().length, 0);
});
