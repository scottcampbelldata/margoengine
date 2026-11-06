import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore, meshRuntime } from '@margoengine/core/extension';
import { TransformControls } from '../dist/index.js';
import { FakeElement, close, closeVec } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
const HALF = Math.SQRT1_2;
const TURN_Y = [0, HALF, 0, HALF]; // a quarter turn about +Y
async function rig(given = {}) {
  const canvas = new Canvas(),
    store = await TransformStore.create(32),
    renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Runtime(canvas, store, renderer, { position: [0, 8, 12], target: [0, 0, 0] }, null),
    mesh = (at) => engine.createMesh().setGeometry(box()).setPosition(at),
    a = mesh([-2, 0, 0]),
    b = mesh([2, 0, 0]),
    c = mesh([3, 0, 3]),
    gizmo = new TransformControls(engine, given);
  engine.render();
  return { canvas, engine, a, b, c, mesh, gizmo };
}
function pixel(cam, p) {
  const m = cam.matrix,
    x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [((x / w + 1) / 2) * 800, ((1 - y / w) / 2) * 600];
}
const size = (mesh) => [mesh.scale.x, mesh.scale.y, mesh.scale.z];
const quat = (mesh) => {
  const r = meshRuntime(mesh),
    t = r.engine.store.transforms,
    id = r.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
};
const world = (engine, mesh) => {
  engine.render();
  const r = meshRuntime(mesh),
    at = r.id * 16;
  return [...r.engine.store.matrices.subarray(at + 12, at + 15)];
};
/** Drags `axis` by a world offset from its tip: the pixel math stays in the test, independent of the control. */
function drag(engine, gizmo, axis, from, to) {
  gizmo.axis = axis;
  gizmo.pointerDown(...pixel(engine.camera, from));
  gizmo.pointerMove(...pixel(engine.camera, to));
}
/** A quarter turn about +Y by the Y ring, grabbed on +X of the ring and carried to where that point lands. */
function quarterY(engine, gizmo) {
  const f = gizmo.frame(),
    o = f.origin,
    r = f.size;
  drag(engine, gizmo, 'Y', [o[0] + r, o[1], o[2]], [o[0], o[1], o[2] - r]);
}

test('attachMany: the active object, repeats, an empty list, one object, and refusals', async () => {
  const { engine, a, b, c, gizmo } = await rig();
  gizmo.attachMany([a, b, a]);
  assert.equal(gizmo.object, b, 'the last is active');
  assert.deepEqual([...gizmo.objects], [a, b]);
  gizmo.attachMany([a, b, c], a);
  assert.equal(gizmo.object, a);
  assert.throws(() => gizmo.attachMany([a, b], c), TypeError);
  gizmo.attachMany([c]);
  assert.deepEqual([...gizmo.objects], [c]);
  gizmo.attachMany([]);
  assert.equal(gizmo.object, null);
  assert.deepEqual([...gizmo.objects], []);
  gizmo.attachMany([a, b]);
  gizmo.attach(c);
  assert.deepEqual([...gizmo.objects], [c], 'attach replaces the set');
  gizmo.dispose();
  engine.dispose();
});

test('pivot: the gizmo sits on the median, or the active origin, and setPivot reports the change', async () => {
  const { engine, a, b, c, gizmo } = await rig(),
    seen = [];
  assert.equal(gizmo.pivot, 'median');
  gizmo.addEventListener('pivot-changed', (e) => seen.push(e.value));
  gizmo.attachMany([a, b, c], c);
  closeVec(gizmo.frame().origin, [1, 0, 1], 1e-6, 'median');
  gizmo.setPivot('active');
  closeVec(gizmo.frame().origin, [3, 0, 3], 1e-6, 'active');
  gizmo.setPivot('individual');
  closeVec(gizmo.frame().origin, [1, 0, 1], 1e-6, 'the gizmo of individual sits on the median');
  gizmo.setPivot('individual');
  assert.deepEqual(seen, ['active', 'individual']);
  gizmo.dispose();
  engine.dispose();
});

test('translate: every object moves by the same world step, also under a turned, scaled parent', async () => {
  const { engine, a, b, mesh, gizmo } = await rig(),
    parent = mesh([0, 0, -2]).setQuaternion(TURN_Y).setScale([2, 2, 2]),
    child = engine.createMesh().setGeometry(box());
  child.setParent(parent);
  child.setPosition([1, 0, 0]);
  engine.render();
  const start = world(engine, child);
  gizmo.attachMany([a, b, child], b);
  const o = gizmo.frame().origin,
    A = world(engine, a);
  drag(engine, gizmo, 'X', [o[0] + 0.5, o[1], o[2]], [o[0] + 2, o[1], o[2]]);
  closeVec(world(engine, a), [A[0] + 1.5, A[1], A[2]], 1e-3);
  closeVec(world(engine, b), [3.5, 0, 0], 1e-3);
  closeVec(world(engine, child), [start[0] + 1.5, start[1], start[2]], 1e-3, 'through the parent');
  gizmo.dispose();
  engine.dispose();
});

test('rotate: about the median, the active origin, or each in place', async () => {
  for (const [pivot, wantA, wantB] of [
    ['median', [0, 0, 2], [0, 0, -2]],
    ['active', [2, 0, 4], [2, 0, 0]],
    ['individual', [-2, 0, 0], [2, 0, 0]],
  ]) {
    const { engine, a, b, gizmo } = await rig({ mode: 'rotate', pivot });
    gizmo.attachMany([a, b]);
    quarterY(engine, gizmo);
    closeVec(world(engine, a), wantA, 1e-3, pivot);
    closeVec(world(engine, b), wantB, 1e-3, pivot);
    closeVec(quat(a), TURN_Y, 1e-3, `${pivot} turns a`);
    closeVec(quat(b), TURN_Y, 1e-3, `${pivot} turns b`);
    gizmo.dispose();
    engine.dispose();
  }
});

test('local and individual: each object follows its own axes; world space and median do not', async () => {
  const { engine, a, b, gizmo } = await rig({ pivot: 'individual', space: 'local' });
  b.setQuaternion(TURN_Y); // b's X is world -Z
  engine.render();
  gizmo.attachMany([a, b], a);
  const o = gizmo.frame().origin;
  drag(engine, gizmo, 'X', [o[0] + 0.5, o[1], o[2]], [o[0] + 1.5, o[1], o[2]]);
  closeVec(world(engine, a), [-1, 0, 0], 1e-3, 'a along its X');
  closeVec(world(engine, b), [2, 0, -1], 1e-3, 'b along its own X');
  gizmo.cancelDrag();
  closeVec(world(engine, b), [2, 0, 0], 1e-6);

  gizmo.setMode('rotate');
  gizmo.setSpace('local');
  const f = gizmo.frame(),
    r = f.size,
    p = f.origin;
  drag(engine, gizmo, 'Z', [p[0] + r, p[1], p[2]], [p[0], p[1] + r, p[2]]);
  closeVec(quat(a), [0, 0, HALF, HALF], 1e-3, 'a about its Z');
  // b's own Z is world +X: its old turn, then a quarter about that axis.
  closeVec(quat(b), [0.5, 0.5, 0.5, 0.5], 1e-3, 'b about its own Z');
  gizmo.dispose();
  engine.dispose();
});

test('scale: positions spread about the pivot, sizes take the factor; in place only sizes change', async () => {
  for (const [pivot, wantA, wantB] of [
    ['median', [-4, 0, 0], [4, 0, 0]],
    ['active', [-6, 0, 0], [2, 0, 0]],
    ['individual', [-2, 0, 0], [2, 0, 0]],
  ]) {
    const { engine, a, b, gizmo } = await rig({ mode: 'scale', pivot });
    gizmo.attachMany([a, b]);
    const o = gizmo.frame().origin;
    drag(engine, gizmo, 'X', [o[0] + 0.5, o[1], o[2]], [o[0] + 1, o[1], o[2]]);
    closeVec(world(engine, a), wantA, 1e-3, pivot);
    closeVec(world(engine, b), wantB, 1e-3, pivot);
    closeVec(size(a), [2, 1, 1], 1e-3, `${pivot} sizes a`);
    closeVec(size(b), [2, 1, 1], 1e-3, `${pivot} sizes b`);
    gizmo.dispose();
    engine.dispose();
  }
});

test('scale: a turned object takes the stretch of the axis lined up with it, and a single object keeps its own axes', async () => {
  const { engine, a, b, gizmo } = await rig({ mode: 'scale' });
  b.setQuaternion(TURN_Y);
  engine.render();
  gizmo.attachMany([a, b], a);
  assert.deepEqual(gizmo.frame().axes[0], [1, 0, 0]);
  const o = gizmo.frame().origin;
  drag(engine, gizmo, 'X', [o[0] + 0.5, o[1], o[2]], [o[0] + 1, o[1], o[2]]);
  closeVec(size(b), [1, 1, 2], 1e-3, "world X is b's Z");
  gizmo.cancelDrag();
  gizmo.attach(b);
  closeVec(gizmo.frame().axes[0], [0, 0, -1], 1e-6, 'one object scales along its own axes');
  gizmo.dispose();
  engine.dispose();
});

test('hierarchy: a child attached with its parent is carried once, not moved twice', async () => {
  const { engine, a, b, gizmo } = await rig();
  b.setParent(a);
  b.setPosition([1, 0, 0]);
  engine.render();
  gizmo.attachMany([a, b]);
  closeVec(gizmo.frame().origin, [-2, 0, 0], 1e-6, 'the median counts the parent alone');
  drag(engine, gizmo, 'X', [-1.5, 0, 0], [-0.5, 0, 0]);
  closeVec(world(engine, a), [-1, 0, 0], 1e-3);
  closeVec(world(engine, b), [0, 0, 0], 1e-3);
  gizmo.dispose();
  engine.dispose();
});

test('Escape and reset put back every object; snapping steps the pivot', async () => {
  const { engine, a, b, gizmo } = await rig({ translationSnap: 1 });
  gizmo.attachMany([a, b]);
  drag(engine, gizmo, 'X', [0.5, 0, 0], [1.9, 0, 0]);
  closeVec(world(engine, a), [-1, 0, 0], 1e-3, 'one step of the snap');
  closeVec(world(engine, b), [3, 0, 0], 1e-3);
  assert.equal(gizmo.cancelDrag(), true);
  closeVec(world(engine, a), [-2, 0, 0], 1e-6);
  closeVec(world(engine, b), [2, 0, 0], 1e-6);
  a.setPosition([9, 9, 9]);
  b.setPosition([8, 8, 8]);
  gizmo.reset();
  closeVec(world(engine, a), [-2, 0, 0], 1e-6, 'reset');
  closeVec(world(engine, b), [2, 0, 0], 1e-6);
  gizmo.dispose();
  engine.dispose();
});

test('disposal: a member disposed mid-drag drops out; losing the active object ends the drag on the next one', async () => {
  const { engine, a, b, c, gizmo } = await rig();
  gizmo.attachMany([a, b, c], c);
  const o = gizmo.frame().origin;
  drag(engine, gizmo, 'X', [o[0] + 0.5, o[1], o[2]], [o[0] + 1, o[1], o[2]]);
  a.dispose();
  gizmo.pointerMove(...pixel(engine.camera, [o[0] + 1.5, o[1], o[2]]));
  closeVec(world(engine, b), [3, 0, 0], 1e-3, 'the others carry on');
  assert.deepEqual([...gizmo.objects], [b, c]);
  c.dispose();
  assert.deepEqual([...gizmo.objects], [b]);
  assert.equal(gizmo.object, b);
  assert.equal(gizmo.dragging, false);
  assert.ok(gizmo.frame(), 'still attached');
  gizmo.dispose();
  engine.dispose();
});
