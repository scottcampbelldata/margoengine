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
// GAP-OUTLINES-INSTANCED: inside a <Model> the binding attaches ModelOutlines (world units, or pixels with screenspace).
const hulls = [];
const fakeModels = (screenspace) =>
  class FakeModelOutlines {
    static attach(engine, options) {
      const outline = new FakeModelOutlines(options);
      hulls.push(outline);
      return outline;
    }
    constructor(options) {
      Object.assign(this, options, { screenspace });
      this.disposed = false;
    }
    dispose() {
      this.disposed = true;
    }
  };
mock.module('@margoengine/toon/models', { namedExports: { ModelOutlines: fakeModels(false) } });
mock.module('@margoengine/toon/screen-outline', { namedExports: { ModelOutlines: fakeModels(true) } });
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { Context, ModelContext, ModelScope } = await import('../dist/internal.js');
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
  const value = {
    engine,
    world: null,
    registry: null,
    shadows: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
  };
  scenes.push(value);
  return value;
}
const tree = (s, children) => h(StrictMode, null, h(Context.Provider, { value: s }, children));
afterEach(() => {
  cleanup();
  for (const s of scenes) s.engine.dispose();
  scenes.length = 0;
  made.length = 0;
  hulls.length = 0;
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

// A <Model>'s children see its registry in ModelScope and the model in ModelContext, as model.tsx provides them.
const inModel = (s, model, children, registry = null) =>
  h(ModelScope.Provider, { value: registry }, h(ModelContext.Provider, { value: model }, children));
const fakeModel = () => {
  const root = { id: 1, name: '' },
    leg = { id: 2, name: 'Leg' };
  return { root, nodes: [root, leg], disposed: false };
};
const hullsLive = () => hulls.filter((o) => !o.disposed);

test('Outlines inside a Model outlines its skinned primitives with ModelOutlines, live, and releases (GAP-OUTLINES-INSTANCED)', async () => {
  const s = await scene(),
    model = fakeModel(),
    ready = [];
  const ui = (props) => tree(s, inModel(s, model, h(Outlines, { onModelReady: (o) => ready.push(o), ...props })));
  const view = render(ui({ thickness: 0.1, color: '#ffffff' }));
  await settle();
  assert.equal(made.length, 0, 'no MeshOutline: the model is the parent');
  assert.equal(hullsLive().length, 1);
  const hull = hullsLive()[0];
  assert.equal(ready.at(-1), hull);
  assert.deepEqual(hull.models, [model]);
  assert.deepEqual([hull.outline, hull.smooth, hull.nodes, hull.screenspace], [0.1, true, undefined, false]);
  assert.deepEqual(hull.color, [1, 1, 1]);
  view.rerender(ui({ thickness: 0.2, color: [0, 1, 0], angle: 0, node: 'Leg' }));
  await settle();
  assert.equal(hullsLive().length, 1, 'a prop edit keeps the hull');
  assert.deepEqual([hull.outline, hull.smooth, hull.nodes], [0.2, false, [model.nodes[1]]]);
  view.rerender(ui({ thickness: 3, screenspace: true }));
  await settle();
  assert.equal(hullsLive().length, 1, 'screenspace re-attaches the pixel variant');
  assert.equal(hullsLive()[0].screenspace, true);
  assert.equal(hullsLive()[0].outline, 3);
  view.unmount();
  assert.equal(hullsLive().length, 0);
});

test('Outlines inside a Model refuses props ModelOutlines cannot draw and unknown nodes, never ignoring them', async () => {
  for (const [props, words] of [
    [{ transparent: true, opacity: 0.5 }, 'transparent'],
    [{ toneMapped: false }, 'toneMapped'],
    [{ polygonOffset: true }, 'polygonOffset'],
    [{ renderOrder: 2 }, 'renderOrder'],
    [{ angle: 1 }, 'angle 1'],
    [{ node: 'Tail' }, "node 'Tail'"],
  ]) {
    const s = await scene(),
      errors = [];
    s.engine.onError = () => {};
    render(tree(s, inModel(s, fakeModel(), h(Outlines, { ...props, onError: (e) => errors.push(e) }))));
    await settle();
    assert.equal(hullsLive().length, 0, `${words}: nothing attached`);
    assert.equal(errors.length, 1, words);
    assert.ok(errors[0] instanceof RangeError && errors[0].message.includes(words), errors[0].message);
    cleanup();
  }
});

test('Outlines in a Mesh inside a Model outlines the mesh; node outside a Model is refused', async () => {
  const s = await scene(),
    errors = [];
  s.engine.onError = () => {};
  render(tree(s, inModel(s, fakeModel(), h(Mesh, null, h(BoxGeometry), h(Outlines, { thickness: 0.1 })))));
  await settle();
  assert.deepEqual([live().length, hullsLive().length], [1, 0], 'the nearer <Mesh> wins');
  cleanup();
  render(tree(s, h(Mesh, null, h(BoxGeometry), h(Outlines, { node: 'Leg', onError: (e) => errors.push(e) }))));
  await settle();
  // StrictMode mounts effects twice in development, so the refusal may arrive once per mount.
  assert.ok(
    errors.length >= 1 && errors.every((e) => e instanceof RangeError && /needs a <Model> parent/.test(e.message)),
  );
});

test('Outlines inside a Model waits for the model to load before attaching', async () => {
  const s = await scene();
  const ui = (model) => tree(s, inModel(s, model, h(Outlines, { thickness: 0.1 })));
  const view = render(ui(null));
  await settle();
  assert.equal(hullsLive().length, 0);
  const model = fakeModel();
  view.rerender(ui(model));
  await settle();
  assert.deepEqual(
    hullsLive().map((o) => o.models[0]),
    [model],
  );
});
