import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { TransformControls } from '../dist/transform.js';
import { FakeElement, close } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
async function rig(t, given = {}) {
  const canvas = new Canvas(),
    store = await TransformStore.create(32),
    renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Runtime(canvas, store, renderer, { position: [6, 4, 6], target: [0, 0, 0] }, null),
    mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine, given);
  gizmo.attach(mesh);
  engine.render();
  t.after(() => {
    gizmo.dispose();
    engine.dispose();
  });
  return { engine, mesh, gizmo, s: gizmo.frame().size };
}
/** A ray from `from` through `to`. */
const toward = (from, to) => [from, to.map((v, i) => v - from[i])];

test('a ray lights the handle it points at and a miss puts the light out', async (t) => {
  const { gizmo, s } = await rig(t),
    seen = [];
  gizmo.addEventListener('axis-changed', (e) => seen.push(e.value));
  assert.equal(gizmo.rayHover(...toward([0.6 * s, 2, 3], [0.6 * s, 0, 0])), 'X');
  assert.equal(gizmo.axis, 'X');
  assert.equal(gizmo.rayHover(...toward([0, 2, 3], [0, 0.6 * s, 0])), 'Y');
  assert.equal(gizmo.rayHover([0, 2, 3], [0, 1, 0]), null, 'a ray into the sky hits nothing');
  assert.equal(gizmo.axis, null);
  gizmo.rayHover(...toward([0.6 * s, 2, 3], [0.6 * s, 0, 0]));
  gizmo.rayUp();
  assert.deepEqual(seen, ['X', 'Y', null, 'X', null], 'rayUp with no drag puts the light out');
  assert.equal(gizmo.rayDown([0, 2, 3], [0, 1, 0]), false, 'a miss grabs nothing');
  assert.equal(gizmo.dragging, false);
});

test('a ray grab drags along X by the distance the ray travels along the axis', async (t) => {
  const { mesh, gizmo, s } = await rig(t),
    hand = [0.6 * s, 2, 3],
    events = [];
  gizmo.addEventListener('dragging-changed', (e) => events.push(e.value));
  assert.equal(gizmo.rayDown(...toward(hand, [0.6 * s, 0, 0])), true);
  assert.equal(gizmo.dragging, true);
  // Turning the wrist so the ray meets the axis one unit further on moves the object one unit.
  gizmo.rayMove(...toward(hand, [0.6 * s + 1, 0, 0]));
  close(mesh.position.x, 1, 1e-9, 'turned to a point one unit along');
  // Carrying the hand along the axis with the same aim moves it as far, though the ray no longer meets the axis line.
  gizmo.rayMove(...toward([hand[0] + 2, 2.5, 3], [0.6 * s + 2, 0, 0]));
  close(mesh.position.x, 2, 1e-9, 'carried two units along');
  assert.deepEqual([mesh.position.y, mesh.position.z], [0, 0], 'the drag stays on the axis');
  gizmo.rayUp();
  assert.equal(gizmo.dragging, false);
  assert.deepEqual(events, [true, false]);
  gizmo.rayMove(...toward(hand, [9, 0, 0]));
  close(mesh.position.x, 2, 1e-9, 'a move after the release does nothing');
});

test('a ray nearly parallel to the dragged axis is stable and follows the hand along the axis', async (t) => {
  const { mesh, gizmo, s } = await rig(t),
    hand = [-3, 0.5, 0];
  assert.equal(gizmo.rayDown(...toward(hand, [0.6 * s, 0, 0])), true);
  gizmo.rayMove(...toward(hand, [0.6 * s + 0.25, 0, 0]));
  close(mesh.position.x, 0.25, 1e-9);
  // The ray swings to lie along the axis. A plane or an unguarded closest point throws the handle far away here.
  for (const tilt of [1e-3, 1e-5, 1e-9, 0, -1e-9, -1e-5, -1e-3]) {
    gizmo.rayMove(hand, [1, tilt, tilt]);
    assert.ok(Number.isFinite(mesh.position.x));
    close(mesh.position.x, 0.25, 1e-9, `held still at tilt ${tilt}`);
  }
  // Along the axis the hand's own travel moves the handle.
  gizmo.rayMove([-2.5, 0.5, 0], [1, 0, 0]);
  close(mesh.position.x, 0.75, 1e-9, 'pushed half a unit along');
  // Leaving parallel does not jump: the handle carries on from where it is.
  gizmo.rayMove(...toward([-2.5, 0.5, 0], [0.6 * s + 0.25, 0, 0]));
  close(mesh.position.x, 0.75, 1e-9, 'no jump on leaving parallel');
  gizmo.rayMove(...toward([-2.5, 0.5, 0], [0.6 * s + 0.5, 0, 0]));
  close(mesh.position.x, 1, 1e-9, 'and follows the ray again');
  gizmo.rayUp();
});

test('a ray on a ring turns the object by the angle the ray sweeps on the ring plane', async (t) => {
  const { mesh, gizmo, s } = await rig(t, { mode: 'rotate' }),
    at = (deg) => [Math.cos((deg * Math.PI) / 180) * s, 0, Math.sin((deg * Math.PI) / 180) * s],
    hand = [1, 4, 1];
  assert.equal(gizmo.rayHover(...toward(hand, at(45))), 'Y');
  assert.equal(gizmo.rayDown(...toward(hand, at(45))), true);
  gizmo.rayMove(...toward(hand, at(15)));
  close(mesh.rotation.x, 0, 1e-6);
  close(mesh.rotation.z, 0, 1e-6);
  close(mesh.rotation.y, Math.PI / 6, 1e-6, 'turned 30 degrees about Y');
  // The hand moving does not matter, only where its ray meets the ring plane.
  gizmo.rayMove(...toward([-2, 3, 0.5], at(-45)));
  close(mesh.rotation.y, Math.PI / 2, 1e-6, 'turned 90 degrees about Y');
  gizmo.rayUp();
  assert.deepEqual([mesh.position.x, mesh.position.y, mesh.position.z], [0, 0, 0]);
});

test('ray drags snap with the same steps as pointer drags', async (t) => {
  const { mesh, gizmo, s } = await rig(t, { translationSnap: 0.5 }),
    hand = [0.6 * s, 2, 3];
  gizmo.rayDown(...toward(hand, [0.6 * s, 0, 0]));
  gizmo.rayMove(...toward(hand, [0.6 * s + 0.8, 0, 0]));
  close(mesh.position.x, 1, 1e-9, '0.8 snaps to 1');
  gizmo.rayUp();
  gizmo.setMode('rotate');
  gizmo.setRotationSnap(Math.PI / 4);
  mesh.setPosition([0, 0, 0]);
  gizmo.engine.render();
  const r = gizmo.frame().size,
    at = (deg) => [Math.cos((deg * Math.PI) / 180) * r, 0, Math.sin((deg * Math.PI) / 180) * r];
  gizmo.rayDown(...toward([1, 4, 1], at(45)));
  gizmo.rayMove(...toward([1, 4, 1], at(5)));
  close(mesh.rotation.y, Math.PI / 4, 1e-6, '40 degrees snaps to 45');
  gizmo.rayUp();
});

test('a plane handle follows the ray over its plane', async (t) => {
  const { mesh, gizmo, s } = await rig(t),
    quad = gizmo.handles().find((h) => h.name === 'XZ').prims[0].points,
    centre = quad.reduce((sum, p) => sum.map((v, i) => v + p[i] / quad.length), [0, 0, 0]),
    hand = [1, 3, 2];
  assert.ok(s > 0);
  assert.equal(gizmo.rayDown(...toward(hand, centre)), true);
  assert.equal(gizmo.axis, 'XZ');
  gizmo.rayMove(...toward(hand, [centre[0] + 1, 0, centre[2] - 2]));
  close(mesh.position.x, 1, 1e-9);
  close(mesh.position.y, 0, 1e-9);
  close(mesh.position.z, -2, 1e-9);
  gizmo.rayUp();
});

test('a two-point scale sizes the object by the factor, in any mode, with the scale snap', async (t) => {
  const { mesh, gizmo } = await rig(t, { mode: 'translate' });
  mesh.setScale([1, 2, 3]);
  gizmo.engine.render();
  assert.equal(gizmo.scaleDown(), true);
  assert.equal(gizmo.dragging, true);
  assert.equal(gizmo.scaleDown(), false, 'one drag at a time');
  gizmo.scaleTo(2);
  assert.deepEqual([mesh.scale.x, mesh.scale.y, mesh.scale.z], [2, 4, 6]);
  gizmo.scaleTo(0.5);
  assert.deepEqual([mesh.scale.x, mesh.scale.y, mesh.scale.z], [0.5, 1, 1.5]);
  assert.throws(() => gizmo.scaleTo(0), RangeError);
  assert.throws(() => gizmo.scaleTo(NaN), RangeError);
  assert.equal(gizmo.cancelDrag(), true, 'Escape puts the size back');
  assert.deepEqual([mesh.scale.x, mesh.scale.y, mesh.scale.z], [1, 2, 3]);
  gizmo.setScaleSnap(0.5);
  gizmo.scaleDown();
  gizmo.scaleTo(1.3);
  assert.deepEqual([mesh.scale.x, mesh.scale.y, mesh.scale.z], [1.5, 2.5, 4]);
  gizmo.rayUp();
  assert.equal(gizmo.dragging, false);
  gizmo.scaleTo(3);
  assert.deepEqual([mesh.scale.x, mesh.scale.y, mesh.scale.z], [1.5, 2.5, 4], 'no scale after the release');
});

test('ray input is checked, and a disabled or empty gizmo takes no ray', async (t) => {
  const { gizmo, s } = await rig(t),
    aim = toward([0.6 * s, 2, 3], [0.6 * s, 0, 0]);
  for (const bad of [
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [NaN, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 0],
      [Infinity, 0, 0],
    ],
  ]) {
    assert.throws(() => gizmo.rayHover(...bad), RangeError);
    assert.throws(() => gizmo.rayDown(...bad), RangeError);
  }
  gizmo.enabled = false;
  assert.equal(gizmo.rayHover(...aim), null);
  assert.equal(gizmo.rayDown(...aim), false);
  assert.equal(gizmo.scaleDown(), false);
  gizmo.enabled = true;
  gizmo.detach();
  assert.equal(gizmo.rayDown(...aim), false);
  assert.equal(gizmo.scaleDown(), false);
});

test('a pointer drag is unchanged by the ray path and a ray cannot take it over', async (t) => {
  const { mesh, gizmo, s } = await rig(t);
  gizmo.axis = 'X';
  gizmo.pointerDown(400, 300);
  assert.equal(gizmo.dragging, true);
  assert.equal(gizmo.rayDown(...toward([0.6 * s, 2, 3], [0.6 * s, 0, 0])), false);
  gizmo.rayMove(...toward([0.6 * s, 2, 3], [5, 0, 0]));
  gizmo.rayUp();
  assert.equal(gizmo.dragging, true, 'rayUp leaves a pointer drag alone');
  close(mesh.position.x, 0, 1e-9);
  gizmo.cancelDrag();
});
