import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { box } from '@margoengine/core';
import { Engine, TransformStore, engineRuntime } from '@margoengine/core/extension';
import { Spline } from '@margoengine/splines';
import {
  PresentationControls,
  ScrollControls,
  ScrollArea,
  PathControls,
  MotionPathControls,
} from '../dist/presentation.js';
import { FakeElement, pointer, close, closeVec, camera, run } from './control-fakes.js';
class Canvas extends FakeElement {
  width = 800;
  height = 600;
}
async function rig(options = {}) {
  const el = new Canvas(),
    engine = new Engine(
      el,
      await TransformStore.create(32),
      { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 10], target: [0, 0, 0] },
      null,
    );
  const mesh = engine.createMesh().setGeometry(box());
  engine.render();
  const control = new PresentationControls(engine, mesh, options);
  return { el, engine, mesh, control };
}
test('presentation: only the product starts a drag unless global is set, pointer ownership and cancellation', async () => {
  const { el, engine, control } = await rig();
  const events = [];
  for (const type of ['start', 'end']) control.addEventListener(type, (e) => events.push(e.type));
  pointer(el, 'pointerdown', 0, 0);
  assert.equal(el.captured.size, 0);
  pointer(el, 'pointerdown', 400, 300);
  assert.equal(el.captured.size, 1);
  pointer(el, 'pointermove', 460, 330, { pointerId: 2 });
  control.update(0.1);
  closeVec(control.angles, [0, 0], 0);
  pointer(el, 'pointermove', 460, 330);
  control.update(0.1);
  assert.ok(control.angles.every((v) => v > 0));
  pointer(el, 'pointercancel', 460, 330);
  run(control, 4);
  closeVec(control.angles, [0, 0], 1e-6);
  assert.equal(el.captured.size, 0);
  control.global = true;
  pointer(el, 'pointerdown', 0, 0);
  assert.equal(el.captured.size, 1);
  pointer(el, 'pointerup', 0, 0);
  assert.deepEqual(events, ['start', 'end', 'start', 'end']);
  engine.dispose();
  assert.equal(el.listenerCount, 0);
  assert.equal(el.style.touchAction, 'auto');
});
test('presentation: bounds constrain even a bouncy spring, polar zoom and snap-back preserve the original pose', async () => {
  const { el, engine, mesh, control } = await rig({
    global: true,
    polar: [-0.2, 0.2],
    azimuth: [-0.3, 0.3],
    zoom: 1.5,
    snap: true,
    spring: { damping: 4 },
  });
  pointer(el, 'pointerdown', 400, 300);
  pointer(el, 'pointermove', 1200, 1100);
  for (let i = 0; i < 120; i++) {
    control.update(1 / 60);
    assert.ok(control.angles[0] <= 0.2 && control.angles[1] <= 0.3);
  }
  closeVec(control.angles, [0.2, 0.3], 1e-6);
  close(mesh.scale.x, 1.5, 1e-6);
  pointer(el, 'pointerup', 1200, 1100);
  run(control, 10);
  closeVec(control.angles, [0, 0], 1e-6);
  close(mesh.scale.x, 1, 1e-6);
  engine.dispose();
});
test('presentation: frame-rate independent exact springs and duration settings', async () => {
  const results = [];
  for (const fps of [30, 120]) {
    const { el, engine, control } = await rig({ global: true, spring: { duration: 0.5, bounce: 0.1 } });
    pointer(el, 'pointerdown', 400, 300);
    pointer(el, 'pointermove', 450, 340);
    run(control, 0.5, fps);
    results.push([...control.angles]);
    engine.dispose();
  }
  closeVec(results[0], results[1], 1e-12);
});
test('presentation: invalid options do not register plugins; disabled and disposed products stay still', async () => {
  const { el, engine, mesh, control } = await rig({ global: true });
  const count = engine.plugins.size;
  assert.throws(() => new PresentationControls(engine, mesh, { polar: [1, 2] }), RangeError);
  assert.equal(engine.plugins.size, count);
  control.enabled = false;
  pointer(el, 'pointerdown', 400, 300);
  pointer(el, 'pointermove', 460, 340);
  assert.equal(control.update(1), false);
  control.enabled = true;
  mesh.dispose();
  assert.equal(control.update(), false);
  assert.equal(el.listenerCount, 0);
  engine.dispose();
});
test('scroll: zero delta with an infinite speed limit is finite, wheel units and helper intervals', () => {
  const el = new FakeElement(100, 100),
    control = new ScrollControls(camera(), { element: el, pages: 3, damping: 0 });
  el.dispatch('wheel', { deltaY: 50, deltaMode: 0 });
  control.update(0);
  close(control.offset, 0.25, 0);
  assert.equal(control.range(0, 0.5), 0.5);
  close(control.curve(0, 0.5), 1, 1e-15);
  assert.equal(control.visible(0.2, 0.1), true);
  el.dispatch('wheel', { deltaY: 1, deltaMode: 2 });
  control.update();
  close(control.offset, 0.75, 0);
  el.dispatch('wheel', { deltaY: 10, deltaMode: 1 });
  control.update();
  close(control.offset, 1, 0);
  control.setProgress(0.5, true);
  control.update(0);
  assert.equal(control.delta, 0);
  assert.throws(() => control.range(0, 0), RangeError);
  assert.throws(() => control.setProgress(NaN), RangeError);
  control.enabled = false;
  el.dispatch('wheel', { deltaY: -100, deltaMode: 0 });
  control.update();
  assert.equal(control.offset, 0.5);
  control.dispose();
  assert.equal(el.listenerCount, 0);
  assert.throws(() => control.setProgress(0), /disposed/);
});
test('scroll: damping matches across frame rates, maxSpeed applies and infinite wheel progress wraps continuously', () => {
  const values = [];
  for (const fps of [30, 120]) {
    const c = new ScrollControls(camera(), { damping: 0.2 });
    c.setProgress(1);
    run(c, 0.5, fps);
    values.push(c.offset);
    c.dispose();
  }
  close(values[0], values[1], 1e-12);
  const c = new ScrollControls(camera(), { damping: 0, maxSpeed: 0.1 });
  c.setProgress(1);
  c.update(1);
  close(c.offset, 0.1, 1e-15);
  c.dispose();
  const el = new FakeElement(100, 100),
    loop = new ScrollControls(camera(), { element: el, infinite: true, damping: 0 });
  loop.setProgress(0.9, true);
  el.dispatch('wheel', { deltaY: 20, deltaMode: 0 });
  loop.update();
  close(loop.offset, 0.1, 1e-12);
  close(loop.delta, 0.2, 1e-12);
  loop.dispose();
});
test('scroll: native vertical/horizontal scrollers retain browser defaults and infinite mode recentres at the ends', () => {
  for (const horizontal of [false, true]) {
    const el = new FakeElement(100, 100);
    el.scrollHeight = el.scrollWidth = 500;
    el.scrollTop = el.scrollLeft = 0;
    const c = new ScrollControls(camera(), { element: el, horizontal, damping: 0 });
    if (horizontal) el.scrollLeft = 200;
    else el.scrollTop = 200;
    el.dispatch('scroll');
    c.update();
    close(c.offset, 0.5, 0);
    assert.equal(el.dispatch('wheel', { deltaY: 50, deltaMode: 0 }).defaultPrevented, false);
    c.dispose();
    const loop = new ScrollControls(camera(), { element: el, horizontal, infinite: true, damping: 0 });
    assert.equal(horizontal ? el.scrollLeft : el.scrollTop, 200);
    if (horizontal) el.scrollLeft = 400;
    else el.scrollTop = 400;
    el.dispatch('scroll');
    loop.update();
    close(loop.offset, 0.5, 0);
    assert.equal(horizontal ? el.scrollLeft : el.scrollTop, 200);
    el.dispatch('scroll');
    loop.update();
    close(loop.delta, 0, 0);
    if (horizontal) el.scrollLeft = 0;
    else el.scrollTop = 0;
    el.dispatch('scroll');
    loop.update();
    close(loop.offset, 0, 0);
    loop.dispose();
  }
});
test('ScrollArea owns DOM, content extent, accessibility, prepend and restores parent styles exactly', () => {
  const dom = new JSDOM('<div id="viewer"><canvas></canvas></div>'),
    doc = dom.window.document,
    canvas = doc.querySelector('canvas'),
    parent = canvas.parentElement;
  const area = new ScrollArea(canvas, { pages: 3, prepend: true });
  assert.equal(parent.firstElementChild, area.element);
  assert.equal(area.content.style.height, '300%');
  assert.equal(area.element.tabIndex, 0);
  assert.equal(area.element.getAttribute('role'), 'region');
  assert.equal(parent.style.position, 'relative');
  area.dispose();
  area.dispose();
  assert.equal(parent.style.position, '');
  assert.equal(parent.children.length, 1);
  const horizontal = new ScrollArea(canvas, { horizontal: true, pages: 2, distance: 2 });
  assert.equal(horizontal.content.style.width, '400%');
  horizontal[Symbol.dispose]();
  assert.throws(() => new ScrollArea(canvas, { pages: 0 }), RangeError);
  assert.equal(parent.children.length, 1);
  dom.window.close();
});
test('path: alias, zero-delta/endpoints, camera forward and arc-length spline sampling', () => {
  assert.equal(MotionPathControls, PathControls);
  const spline = new Spline([
      [0, 0, 5],
      [1, 0, 5],
      [8, 0, 5],
    ]),
    cam = camera(),
    path = new PathControls(cam, spline, { loop: false, damping: 0 });
  path.current = 0.5;
  path.update(0);
  closeVec(cam.position, [...spline.atDistance(spline.length * 0.5)], 1e-12);
  path.current = 1;
  path.update(0);
  closeVec(cam.position, [8, 0, 5], 1e-12);
  assert.ok(cam.target[0] > cam.position[0]);
  assert.ok(cam.position.every(Number.isFinite));
  path.current = -2;
  path.update(0);
  closeVec(cam.position, [0, 0, 5], 1e-12);
  path.dispose();
});
test('path: scroll driver, smooth focus and parented mesh world positions and orientation', async () => {
  const { engine, mesh, control } = await rig();
  control.dispose();
  const parent = engine.createMesh().setScale([2, 2, 2]).setRotation([0, 0.3, 0]).setPosition([2, 1, 0]);
  mesh.setParent(parent);
  engine.render();
  const spline = new Spline([
      [0, 0, 0],
      [4, 0, 0],
    ]),
    scroll = { offset: 0.25 },
    path = new PathControls(engine, spline, {
      object: mesh,
      scroll,
      loop: false,
      damping: 0,
      focus: [0, 0, -10],
      focusDamping: 0,
    });
  path.update(0);
  engine.render();
  const s = engineRuntime(engine).store,
    id = engineRuntime(engine).store.transforms;
  const matrix = s.matrices.subarray(0, 16);
  closeVec([...matrix.slice(12, 15)], [1, 0, 0], 1e-5);
  assert.ok([...matrix].every(Number.isFinite));
  assert.ok(id);
  scroll.offset = 0.75;
  path.update(0);
  engine.render();
  closeVec([...s.matrices.subarray(12, 15)], [3, 0, 0], 1e-5);
  const focus = engine.createMesh().setGeometry(box()).setPosition([0, 0, -5]);
  engine.render();
  path.focus = focus;
  path.update(0);
  assert.ok(Number.isFinite(mesh.rotation.y));
  engine.dispose();
  assert.equal(path.update(), false);
});
test('path: vertical tangent, repeated points, loop seams, invalid samples and disposal', () => {
  const cam = camera(),
    path = new PathControls(cam, { at: (t) => [0, t, 0] }, { loop: false, damping: 0 });
  path.current = 1;
  path.update(0);
  closeVec(cam.up, [0, 0, 1], 0);
  assert.ok(cam.target[1] > cam.position[1]);
  path.dispose();
  const stationary = new PathControls(cam, { at: () => [1, 2, 3] }, { damping: 0 });
  stationary.update(0);
  assert.ok(Math.hypot(...cam.position.map((v, i) => v - cam.target[i])) > 0);
  stationary.dispose();
  const loop = new PathControls(
    cam,
    { at: (t) => [Math.cos(t * 2 * Math.PI), 0, Math.sin(t * 2 * Math.PI)] },
    { offset: 0.9, damping: 0 },
  );
  loop.current = 1.1;
  loop.update(0);
  close(loop.offset, 0.1, 1e-12);
  loop.dispose();
  assert.equal(loop.update(), false);
  const bad = new PathControls(cam, { at: () => [NaN, 0, 0] });
  assert.throws(() => bad.update(), RangeError);
  bad.dispose();
});
