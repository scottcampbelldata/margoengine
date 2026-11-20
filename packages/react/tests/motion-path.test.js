// <MotionPathControls> on a real core engine with real geometry curves.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { LineCurve3 } = await import('@margoengine/geometry');
const { Context } = await import('../dist/internal.js');
const { Mesh, BoxGeometry } = await import('../dist/index.js');
const { MotionPathControls, useMotion } = await import('../dist/controls-extra.js');
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
});
const frame = async (s, delta = 1 / 60) => {
  await act(async () => {
    for (const callback of [...s.frames.callbacks]) callback(s.engine, delta);
  });
};
const close = (a, b, label, eps = 1e-6) =>
  b.forEach((v, i) => assert.ok(Math.abs(a[i] - v) < eps, `${label}: ${[...a]} vs ${b}`));
// Two segments, 1 and 3 long: progress is by arc length over the whole path.
const path = [new LineCurve3([0, 0, 0], [1, 0, 0]), new LineCurve3([1, 0, 0], [1, 0, 3])];
test('the camera moves by arc length along the curves and looks along the path', async () => {
  const s = await scene(),
    ref = createRef();
  render(tree(s, h(MotionPathControls, { ref, curves: path })));
  ref.current.current = 0.5;
  await frame(s);
  close(s.engine.camera.position, [1, 0, 1], 'halfway is a third along the long segment');
  close(ref.current.tangent, [0, 0, 1], 'tangent');
  assert.ok(s.engine.camera.target[2] > 1 && Math.abs(s.engine.camera.target[0] - 1) < 1e-6, 'looks ahead');
  ref.current.current = 0.125;
  await frame(s);
  close(s.engine.camera.position, [0.5, 0, 0], 'on the first segment');
});
test('offset eases current with the damping time constant; loop takes the short way round', async () => {
  const s = await scene(),
    ref = createRef();
  const view = render(tree(s, h(MotionPathControls, { ref, curves: path, offset: 0.5, damping: 1, loop: false })));
  ref.current.current = 0;
  await frame(s, 1);
  assert.ok(
    Math.abs(ref.current.current - 0.5 * (1 - Math.exp(-1))) < 1e-9,
    `one time constant: ${ref.current.current}`,
  );
  view.rerender(tree(s, h(MotionPathControls, { ref, curves: path, offset: 0.1, damping: 0 })));
  ref.current.current = 0.9;
  await frame(s);
  assert.ok(Math.abs(ref.current.current - 0.1) < 1e-9, 'damping 0 jumps');
  view.rerender(tree(s, h(MotionPathControls, { ref, curves: path, offset: 0.05, damping: 1 })));
  ref.current.current = 0.95;
  await frame(s, 0.1);
  assert.ok(
    ref.current.current > 0.95 || ref.current.current < 0.05,
    `forward across the seam: ${ref.current.current}`,
  );
});
test('a mesh object faces its focus with +Z; useMotion reads the same state', async () => {
  const s = await scene(),
    object = createRef(),
    target = createRef(),
    seen = [];
  function Reader() {
    seen.push(useMotion());
    return null;
  }
  render(
    tree(
      s,
      h(
        React.Fragment,
        null,
        h(Mesh, { ref: object }, h(BoxGeometry)),
        h(MotionPathControls, { curves: path, object, focus: [5, 0, 0], offset: 0.25, damping: 0 }, h(Reader)),
      ),
    ),
  );
  await frame(s);
  const m = object.current;
  close([m.position.x, m.position.y, m.position.z], [1, 0, 0], 'at the corner');
  // +Z of the mesh from its Euler XYZ rotation: the third column of Rx Ry Rz.
  const [x, y] = [m.rotation.x, m.rotation.y],
    z = [Math.sin(y), -Math.sin(x) * Math.cos(y), Math.cos(x) * Math.cos(y)];
  close(z, [1, 0, 0], 'faces +x toward the focus', 1e-5);
  assert.equal(seen.at(-1).current, 0.25);
  assert.throws(() => render(tree(s, h(MotionPathControls, { curves: [] }))), /curves must be a non-empty array/);
  assert.throws(() => render(tree(s, h(Reader))), /useMotion requires MotionPathControls/);
  void target;
});
