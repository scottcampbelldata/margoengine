import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { box } from '@margoengine/core';
import { tessellate } from '../dist/index.js';
import { ArcballControls, ArcballGizmo } from '../dist/arcball.js';
import { FakeElement, FakeTarget, camera, close, closeVec, key, pointer } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
const STEP = Math.PI / 36;
const rig = () => {
  const el = new FakeElement(),
    cam = camera(),
    control = new ArcballControls(cam, el),
    keys = new FakeTarget();
  control.listenToKeyEvents(keys);
  return { el, cam, control, keys };
};
async function onEngine() {
  const canvas = new Canvas(),
    engine = new Runtime(
      canvas,
      await TransformStore.create(16),
      { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 10], target: [0, 0, 0] },
      null,
    );
  engine.createMesh().setGeometry(box());
  engine.render();
  return { canvas, engine, control: new ArcballControls(engine) };
}

test('keyboard: arrows turn the camera the way they point, by keyRotateStep, about the target', () => {
  const { cam, control, keys } = rig();
  key(keys, 'keydown', 'ArrowLeft');
  closeVec(cam.position, [-10 * Math.sin(STEP), 0, 10 * Math.cos(STEP)], 1e-9, 'left');
  key(keys, 'keydown', 'ArrowRight');
  closeVec(cam.position, [0, 0, 10], 1e-9, 'and back');
  key(keys, 'keydown', 'ArrowUp');
  closeVec(cam.position, [0, 10 * Math.sin(STEP), 10 * Math.cos(STEP)], 1e-9, 'up');
  key(keys, 'keydown', 'ArrowDown');
  closeVec(cam.position, [0, 0, 10], 1e-9);
  closeVec(cam.target, [0, 0, 0], 1e-12);
  control.dispose();
});

test('keyboard: Q and E roll, Shift + arrows pan, + and - zoom, Home resets', () => {
  const { cam, control, keys } = rig();
  key(keys, 'keydown', 'KeyQ');
  closeVec(cam.up, [-Math.sin(STEP), Math.cos(STEP), 0], 1e-9, 'Q rolls the top of the view left');
  closeVec(cam.position, [0, 0, 10], 1e-9, 'in place');
  key(keys, 'keydown', 'KeyE');
  closeVec(cam.up, [0, 1, 0], 1e-9);
  key(keys, 'keydown', 'ArrowRight', { shiftKey: true });
  assert.ok(cam.target[0] > 0, 'the camera goes the way the arrow points, as the turns do');
  close(cam.position[0], cam.target[0], 1e-9, 'camera and target together');
  key(keys, 'keydown', 'Equal');
  close(control.getDistance(), 10 * 2 ** -0.25, 1e-9, 'plus zooms in');
  key(keys, 'keydown', 'Minus');
  close(control.getDistance(), 10, 1e-9);
  key(keys, 'keydown', 'Home');
  closeVec(cam.position, [0, 0, 10], 1e-12);
  closeVec(cam.target, [0, 0, 0], 1e-12);
  control.dispose();
});

test('keyboard: enable flags, modifiers, text fields, rebinding, and clean up', () => {
  const { cam, control, keys } = rig(),
    moved = () => Math.hypot(cam.position[0], cam.position[1], cam.position[2] - 10) > 1e-9;
  control.enableRotate = false;
  key(keys, 'keydown', 'ArrowLeft');
  key(keys, 'keydown', 'KeyQ');
  control.enableRotate = true;
  control.enablePan = false;
  key(keys, 'keydown', 'ArrowLeft', { shiftKey: true });
  control.enablePan = true;
  control.enableZoom = false;
  key(keys, 'keydown', 'Equal');
  control.enableZoom = true;
  control.enabled = false;
  key(keys, 'keydown', 'ArrowLeft');
  control.enabled = true;
  key(keys, 'keydown', 'ArrowLeft', { ctrlKey: true });
  key(keys, 'keydown', 'ArrowLeft', { target: { tagName: 'INPUT' } });
  assert.equal(moved(), false);
  control.keys.left = 'KeyA';
  key(keys, 'keydown', 'ArrowLeft');
  assert.equal(moved(), false);
  key(keys, 'keydown', 'KeyA');
  assert.equal(moved(), true);
  const pressed = key(keys, 'keydown', 'KeyA');
  assert.equal(pressed.defaultPrevented ?? pressed.prevented ?? true, true);
  control.dispose();
  const at = [...cam.position];
  key(keys, 'keydown', 'KeyA');
  assert.deepEqual([...cam.position], at, 'dispose stops listening');
});

test('focus: a double-click centres the point on the target plane, keeping turn and distance', () => {
  const el = new FakeElement(),
    cam = camera(),
    control = new ArcballControls(cam, el),
    seen = [];
  control.addEventListener('start', () => seen.push('start'));
  control.addEventListener('end', () => seen.push('end'));
  const { direction, origin } = control.rayAt(el.clientWidth * 0.75, el.clientHeight / 2),
    t = -origin[2] / direction[2],
    want = [origin[0] + direction[0] * t, origin[1] + direction[1] * t, 0];
  pointer(el, 'dblclick', el.clientWidth * 0.75, el.clientHeight / 2);
  closeVec(cam.target, want, 1e-9);
  closeVec(cam.position, [want[0], want[1], 10], 1e-9);
  assert.deepEqual(seen, ['start', 'end']);
  control.enableFocus = false;
  pointer(el, 'dblclick', 0, 0);
  closeVec(cam.target, want, 1e-9, 'enableFocus off');
  control.dispose();
});

test('focus: pick wins, its null falls back to the plane, and damping glides there', () => {
  const el = new FakeElement(),
    cam = camera(),
    control = new ArcballControls(cam, el, { pick: () => [1, 2, 3] });
  pointer(el, 'dblclick', 10, 10);
  closeVec(cam.target, [1, 2, 3], 1e-9);
  closeVec(cam.position, [1, 2, 13], 1e-9);
  control.pick = () => null;
  control.focus([0, 0, 0]);
  pointer(el, 'dblclick', el.clientWidth / 2, el.clientHeight / 2);
  closeVec(cam.target, [0, 0, 0], 1e-9, 'the centre of the view is already centred');
  control.enableDamping = true;
  control.focus([4, 0, 0]);
  closeVec(cam.target, [0, 0, 0], 1e-12, 'nothing yet');
  control.update(1 / 60);
  assert.ok(cam.target[0] > 0 && cam.target[0] < 4);
  for (let i = 0; i < 2000; i++) control.update(1 / 60);
  closeVec(cam.target, [4, 0, 0], 1e-6);
  control.dispose();
});

test('gizmo: three rings and an outline at the size of the ball, the far halves dimmed', async () => {
  const { engine, control } = await onEngine(),
    gizmo = ArcballGizmo.attach(control, { autoHide: false }),
    prims = gizmo.prims();
  assert.equal(prims.length, 4);
  // The ball is half the smaller side: at 600 px tall that is the whole half height of the view at the target.
  const half = 10 * Math.tan((engine.camera.fov * Math.PI) / 360);
  close(gizmo.radius(), half, 1e-9);
  for (const prim of prims) for (const p of prim.points) close(Math.hypot(...p), half, 1e-9);
  const ring = prims[1], // about Y, seen from +Z: its near half has z above 0
    bright = Math.max(...ring.colors.map((c) => c[3]));
  ring.colors.forEach((c, i) => {
    const middle = (ring.points[i * 2][2] + ring.points[i * 2 + 1][2]) / 2;
    close(c[3], middle >= 0 ? bright : bright * 0.25, 1e-12, `segment ${i}`);
  });
  assert.ok(
    tessellate(prims, engine.camera.matrix, 800, 600).length > 0,
    'the lines tessellate for the overlay',
  );
  gizmo.dispose();
  control.dispose();
  engine.dispose();
});

test('gizmo: follows the target and the distance; needs an engine; removes its pass', async () => {
  const { engine, control } = await onEngine(),
    gizmo = new ArcballGizmo(control);
  assert.equal(gizmo.autoHide, true);
  assert.equal(engine.hasPlugin(gizmo.pluginName), true);
  const near = gizmo.radius();
  engine.camera.position = [3, 0, 20];
  engine.camera.target = [3, 0, 0];
  close(gizmo.radius(), near * 2, 1e-9);
  closeVec(
    gizmo.prims()[3].points.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / 128),
    [3, 0, 0],
    1e-9,
    'centred on the target',
  );
  gizmo.dispose();
  assert.equal(engine.hasPlugin(gizmo.pluginName), false);
  gizmo.dispose();
  const bare = new ArcballControls(camera(), new FakeElement());
  assert.throws(() => new ArcballGizmo(bare), TypeError);
  bare.dispose();
  control.dispose();
  engine.dispose();
});
