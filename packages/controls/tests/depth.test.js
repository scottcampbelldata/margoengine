// Orbit target bounds, scale plane handles, free-rotation snap, held-key snap, gizmo shortcuts and drag cancel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { OrbitControls, TransformControls } from '../dist/index.js';
import { FakeElement, FakeTarget, camera, close, closeVec, pointer } from './control-fakes.js';

const toPixel = (cam, point, width = 800, height = 600) => {
  cam.update(width / height, true);
  const m = cam.matrix,
    p = [...point, 1],
    c = [0, 1, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);
  return [((c[0] / c[2] + 1) / 2) * width, ((1 - c[1] / c[2]) / 2) * height];
};
const engineWith = async () => {
  const canvas = new FakeElement(800, 600);
  canvas.width = 800;
  canvas.height = 600;
  canvas.getContext = () => null;
  canvas.dispatch = (type, props = {}) => {
    const event = {
      type,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
      ...props,
    };
    for (const listener of [...(canvas.listeners.get(type) ?? [])]) {
      listener(event);
      if (event.stopped) break;
    }
    return event;
  };
  const store = await TransformStore.create(32);
  const renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Runtime(canvas, store, renderer, { position: [0, 0, 10], target: [0, 0, 0] }, null);
  return { engine, canvas };
};
const drag = (el, from, to, extra = {}, steps = 4) => {
  pointer(el, 'pointerdown', from[0], from[1], extra);
  for (let i = 1; i <= steps; i++)
    pointer(
      el,
      'pointermove',
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
      extra,
    );
  pointer(el, 'pointerup', to[0], to[1], extra);
};

test('orbit targetBounds keeps the target in the box while panning, and the camera follows it', () => {
  const cam = camera({ position: [0, 0, 10], target: [0, 0, 0] }),
    el = new FakeElement(),
    orbit = new OrbitControls(cam, el);
  orbit.targetBounds = { min: [-1, -Infinity, -1], max: [1, Infinity, 1] };
  orbit.pan(-5000, 0); // far to the right
  orbit.update(0);
  close(cam.target[0], 1, 1e-9, 'target stops at the box');
  close(cam.position[0] - cam.target[0], 0, 1e-9, 'offset to the camera is unchanged');
  orbit.pan(0, 5000);
  orbit.update(0);
  assert.ok(Math.abs(cam.target[1]) > 1, 'an infinite bound leaves that axis free');
  orbit.targetBounds = null;
  orbit.pan(-5000, 0);
  orbit.update(0);
  assert.ok(cam.target[0] > 1, 'null removes the limit');
  orbit.dispose();
});

test('transform scale: plane handles scale two axes together and are picked', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine, { mode: 'scale' });
  gizmo.attach(mesh);
  engine.render();
  assert.ok(
    gizmo.handles().some((h) => h.name === 'XY'),
    'XY plane handle exists in scale mode',
  );
  const s = gizmo.frame().size,
    centre = [0.22 * s, 0.22 * s, 0],
    grab = toPixel(engine.camera, centre);
  assert.equal(gizmo.pick(grab[0], grab[1]), 'XY');
  drag(canvas, grab, toPixel(engine.camera, [0.44 * s, 0.44 * s, 0]));
  closeVec([mesh.scale.x, mesh.scale.y, mesh.scale.z], [2, 2, 1], 1e-3, 'both plane axes doubled, Z untouched');
  gizmo.dispose();
  engine.dispose();
});

test('transform: the free rotation disc snaps its turn to rotationSnap', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine, { mode: 'rotate', rotationSnap: Math.PI / 4 });
  gizmo.attach(mesh);
  engine.render();
  const s = gizmo.frame().size,
    inside = toPixel(engine.camera, [0.3 * s, -0.4 * s, 0]);
  assert.equal(gizmo.pick(inside[0], inside[1]), 'XYZE');
  drag(canvas, inside, [inside[0] + 100, inside[1]]);
  const angle = Math.abs(mesh.rotation.y);
  assert.ok(angle > 0.1, 'it turned');
  close(angle / (Math.PI / 4), Math.round(angle / (Math.PI / 4)), 1e-5, 'a whole number of snap steps');
  gizmo.dispose();
  engine.dispose();
});

test('transform: holding Ctrl snaps with heldSnap steps when no explicit snap is set', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine);
  gizmo.attach(mesh);
  engine.render();
  const s = gizmo.frame().size,
    from = toPixel(engine.camera, [0.6 * s, 0, 0]),
    to = toPixel(engine.camera, [0.6 * s + 0.4, 0, 0]);
  drag(canvas, from, to);
  close(mesh.position.x, 0.4, 1e-3, 'free drag');
  mesh.setPosition([0, 0, 0]);
  engine.render();
  drag(canvas, from, to, { ctrlKey: true });
  close(mesh.position.x, 0.5, 1e-9, 'Ctrl snaps 0.4 to the 0.25 grid');
  mesh.setPosition([0, 0, 0]);
  engine.render();
  gizmo.setTranslationSnap(1);
  drag(canvas, from, to, { ctrlKey: true });
  close(mesh.position.x, 0, 1e-9, 'an explicit snap wins');
  gizmo.dispose();
  engine.dispose();
});

test('transform shortcuts: W/E/R modes, Q space, +/- size, ignored in text fields, off after dispose', async () => {
  const { engine } = await engineWith();
  const gizmo = new TransformControls(engine),
    keys = new FakeTarget();
  gizmo.listenToKeyEvents(keys);
  const press = (code, extra) => keys.dispatch('keydown', { code, ...extra });
  press('KeyE');
  assert.equal(gizmo.mode, 'rotate');
  press('KeyR');
  assert.equal(gizmo.mode, 'scale');
  press('KeyW');
  assert.equal(gizmo.mode, 'translate');
  press('KeyQ');
  assert.equal(gizmo.space, 'local');
  press('Equal');
  close(gizmo.size, 1.1, 1e-12, 'larger');
  press('Minus');
  close(gizmo.size, 1, 1e-12, 'smaller');
  press('KeyE', { target: { tagName: 'INPUT' } });
  assert.equal(gizmo.mode, 'translate', 'typing in a field does not switch modes');
  press('KeyE', { ctrlKey: true });
  assert.equal(gizmo.mode, 'translate', 'Ctrl+E is left to the page');
  gizmo.keys.rotate = 'KeyG';
  press('KeyG');
  assert.equal(gizmo.mode, 'rotate', 'keys are configurable');
  gizmo.dispose();
  assert.equal(keys.listenerCount, 0);
  engine.dispose();
});

test('transform: Escape cancels a drag and restores the transform, ending the drag', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box()).setPosition([1, 0, 0]),
    gizmo = new TransformControls(engine),
    keys = new FakeTarget();
  gizmo.attach(mesh);
  gizmo.listenToKeyEvents(keys);
  engine.render();
  const s = gizmo.frame().size,
    from = toPixel(engine.camera, [1 + 0.6 * s, 0, 0]);
  pointer(canvas, 'pointerdown', ...from);
  pointer(canvas, 'pointermove', from[0] + 80, from[1]);
  assert.ok(gizmo.dragging && mesh.position.x > 1.2, 'dragging moved it');
  const seen = [];
  gizmo.addEventListener('dragging-changed', (e) => seen.push(e.value));
  keys.dispatch('keydown', { code: 'Escape' });
  assert.equal(gizmo.dragging, false);
  closeVec([mesh.position.x, mesh.position.y, mesh.position.z], [1, 0, 0], 1e-9, 'back where the drag began');
  assert.deepEqual(seen, [false]);
  pointer(canvas, 'pointermove', from[0] + 120, from[1]);
  close(mesh.position.x, 1, 1e-9, 'later moves do nothing');
  assert.equal(gizmo.cancelDrag(), false, 'nothing left to cancel');
  gizmo.dispose();
  engine.dispose();
});
