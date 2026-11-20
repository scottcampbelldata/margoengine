// <Caustics> on a real core engine with the staging catcher replaced by a recorder (its GPU transport has its own
// suites): world triangles of the children, re-traced on motion, live options and release.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const calls = [];
class FakeCaustics {
  static async attach(engine, options) {
    const made = new FakeCaustics(options);
    calls.push(['attach', made]);
    return made;
  }
  constructor(options) {
    const { signal: _signal, geometry, ...rest } = options;
    this.options = rest;
    this.geometry = geometry;
    this.invalidated = 0;
    this.disposed = false;
  }
  async setGeometry(geometry) {
    this.geometry = geometry;
    calls.push(['setGeometry', this]);
  }
  invalidate() {
    this.invalidated++;
  }
  dispose() {
    this.disposed = true;
  }
}
mock.module('@margoengine/studio/caustics', { namedExports: { ProductCaustics: FakeCaustics } });
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Mesh, BoxGeometry } = await import('../dist/index.js');
const { Caustics } = await import('../dist/caustics.js');
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
  calls.length = 0;
});
const frames = async (s, n = 4) => {
  for (let i = 0; i < n; i++)
    await act(async () => {
      for (const callback of [...s.frames.callbacks]) callback(s.engine, 1 / 60);
    });
};
test('Caustics traces its children in world space, re-traces when one moves and keeps options live', async () => {
  const s = await scene(),
    ready = [];
  const ui = (y, ior) =>
    tree(
      s,
      h(
        Caustics,
        { position: [2, 0, 0], ior, intensity: 2, onReady: (c) => ready.push(c) },
        h(Mesh, { position: [0, y, 0] }, h(BoxGeometry)),
      ),
    );
  const view = render(ui(1, 1.5));
  await frames(s);
  assert.equal(calls.filter(([k]) => k === 'attach').length, 1);
  const caustics = ready[0];
  assert.deepEqual(caustics.options.position, [2, 0, 0], 'the floor defaults to the group position');
  assert.equal(caustics.options.ior, 1.5);
  assert.equal(caustics.options.intensity, 2);
  const ys = (g) => g.positions.filter((_, i) => i % 3 === 1);
  const xs = (g) => g.positions.filter((_, i) => i % 3 === 0);
  assert.deepEqual([Math.min(...ys(caustics.geometry)), Math.max(...ys(caustics.geometry))], [0.5, 1.5]);
  assert.deepEqual([Math.min(...xs(caustics.geometry)), Math.max(...xs(caustics.geometry))], [1.5, 2.5], 'world space');
  assert.equal(caustics.geometry.indices.length, 36);
  view.rerender(ui(2, 1.5));
  await frames(s);
  assert.equal(calls.filter(([k]) => k === 'setGeometry').length, 1, 'one re-trace for one move');
  assert.equal(Math.max(...ys(caustics.geometry)), 2.5);
  await frames(s);
  assert.equal(calls.filter(([k]) => k === 'setGeometry').length, 1, 'nothing moved, no re-trace');
  const before = caustics.invalidated;
  view.rerender(ui(2, 1.33));
  await frames(s, 1);
  assert.equal(caustics.options.ior, 1.33);
  assert.ok(caustics.invalidated > before, 'a changed option restarts the map');
  view.unmount();
  assert.equal(caustics.disposed, true);
});
