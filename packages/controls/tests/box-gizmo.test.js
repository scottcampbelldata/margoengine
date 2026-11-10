import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine, TransformStore, engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { FakeElement, close, closeVec, pointer } from './control-fakes.js';
const { BoxGizmo } = await import(process.env.MARGO_BOX_DRAFT ?? '../dist/box-gizmo.js');
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
      { position: [5, 4, 8], target: [0, 0, 0] },
      null,
    );
  const mesh = engine.createMesh().setGeometry(box());
  const gizmo = new BoxGizmo(engine, options).attach(mesh);
  engine.render();
  return { el, engine, mesh, gizmo };
}
function pixel(cam, p) {
  const m = cam.matrix,
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [
    ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w + 1) * 400,
    (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) * 300,
  ];
}
const size = (mesh) => [mesh.scale.x, mesh.scale.y, mesh.scale.z];
const pos = (mesh) => [mesh.position.x, mesh.position.y, mesh.position.z];
const quaternion = (mesh) => {
  const { id, engine } = meshRuntime(mesh),
    t = engine.store.transforms;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
};
test('exact transformed bounds expose 8 scale corners and 12 edge rotation handles', async () => {
  const { gizmo, mesh, engine } = await rig();
  mesh.setScale([2, 3, 4]).setPosition([1, 2, 3]);
  engine.render();
  assert.equal(gizmo.handles().length, 20);
  assert.equal(gizmo.handles().filter((h) => h.kind === 'scale').length, 8);
  for (let i = 0; i < 3; i++) assert.equal(gizmo.handles().filter((h) => h.axis === i).length, 4);
  closeVec(gizmo.corners()[0], [0, 0.5, 1], 1e-6);
  closeVec(gizmo.corners()[7], [2, 3.5, 5], 1e-6);
  mesh.setQuaternion([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  engine.render();
  closeVec(gizmo.corners()[0], [-1, 0.5, 4], 1e-5);
  engine.dispose();
});
test('uniform corner scaling holds its opposite corner fixed, snaps, and restores exactly on cancel', async () => {
  const { gizmo, mesh, engine } = await rig({ scaleSnap: 0.25 });
  const corners = gizmo.corners(),
    p = pixel(engine.camera, corners[7]),
    anchor = corners[0];
  const a = pixel(engine.camera, anchor),
    dx = p[0] - a[0],
    dy = p[1] - a[1];
  assert.equal(gizmo.beginDrag(...p, 'corner-7'), true);
  gizmo.dragTo(p[0] + dx, p[1] + dy);
  engine.render();
  closeVec(size(mesh), [2, 2, 2], 1e-6);
  closeVec(gizmo.corners()[0], anchor, 1e-6);
  gizmo.dragTo(p[0] + dx * 0.1, p[1] + dy * 0.1);
  closeVec(size(mesh), [1, 1, 1], 1e-6);
  gizmo.cancelDrag();
  assert.equal(gizmo.dragging, false);
  closeVec(pos(mesh), [0, 0, 0], 0);
  closeVec(size(mesh), [1, 1, 1], 0);
  engine.dispose();
});
test('centre-pivot scaling preserves off-origin geometry centre and nonuniform scaling remains finite', async () => {
  const { gizmo, mesh, engine } = await rig({ scaleFromCenter: true, uniformScaling: false });
  for (let i = 0; i < mesh.geometry.vertices.length; i += 6) mesh.geometry.vertices[i] += 2;
  gizmo.refreshBounds();
  engine.render();
  const before = gizmo.corners(),
    center = before[0].map((v, i) => (v + before[7][i]) / 2);
  const p = pixel(engine.camera, before[7]);
  gizmo.beginDrag(...p, 'corner-7');
  gizmo.dragTo(p[0] + 30, p[1] - 20);
  engine.render();
  const after = gizmo.corners();
  closeVec(
    after[0].map((v, i) => (v + after[7][i]) / 2),
    center,
    2e-6,
  );
  assert.ok(size(mesh).every((v) => v > 0 && Number.isFinite(v)));
  assert.ok(new Set(size(mesh).map((v) => v.toFixed(3))).size > 1);
  gizmo.endDrag();
  engine.dispose();
});
test('parented meshes keep opposite corner through scale and centre through local edge rotation', async () => {
  const { gizmo, mesh, engine } = await rig();
  const parent = engine.createMesh().setScale([2, 3, 4]).setPosition([1, 2, 3]).setRotation([0, 0.5, 0]);
  mesh
    .setParent(parent)
    .setPosition([1, 0, 0])
    .setQuaternion([0, 0, Math.sin(0.2), Math.cos(0.2)]);
  engine.render();
  const points = gizmo.corners(),
    p = pixel(engine.camera, points[7]),
    a = pixel(engine.camera, points[0]);
  gizmo.beginDrag(...p, 'corner-7');
  gizmo.dragTo(p[0] + (p[0] - a[0]) * 0.2, p[1] + (p[1] - a[1]) * 0.2);
  engine.render();
  closeVec(gizmo.corners()[0], points[0], 1e-5);
  gizmo.endDrag();
  const corners = gizmo.corners(),
    center = corners[0].map((v, i) => (v + corners[7][i]) / 2),
    q = quaternion(mesh);
  const h = gizmo.handles().find((h) => h.kind === 'rotate'),
    hp = pixel(engine.camera, h.position);
  assert.ok(gizmo.beginDrag(...hp, h.id));
  gizmo.dragTo(hp[0] + 70, hp[1] - 40);
  engine.render();
  assert.notDeepEqual(quaternion(mesh), q);
  const now = gizmo.corners();
  closeVec(
    now[0].map((v, i) => (v + now[7][i]) / 2),
    center,
    2e-5,
  );
  engine.dispose();
});
test('all three edge axes rotate and snap, without accumulated rounding or scale drift', async () => {
  for (let axis = 0; axis < 3; axis++) {
    const { gizmo, mesh, engine } = await rig({ rotationSnap: Math.PI / 4 });
    const h = gizmo.handles().find((h) => h.axis === axis),
      p = pixel(engine.camera, h.position);
    assert.ok(gizmo.beginDrag(...p, h.id));
    gizmo.dragTo(p[0] + 200, p[1] + 30);
    const q = quaternion(mesh);
    close(Math.hypot(...q), 1, 1e-6);
    closeVec(size(mesh), [1, 1, 1], 0);
    assert.ok(Math.abs(q[axis]) > 0.1);
    assert.ok(q.filter((_, i) => i !== axis && i !== 3).every((v) => Math.abs(v) < 1e-6));
    const angle = 2 * Math.atan2(q[axis], q[3]);
    close(angle / (Math.PI / 4), Math.round(angle / (Math.PI / 4)), 1e-6);
    gizmo.dragTo(...p);
    closeVec(quaternion(mesh), [0, 0, 0, 1], 1e-6);
    engine.dispose();
  }
});
test('real pointer capture, escape and cancellation restore transforms and release listeners', async () => {
  const { gizmo, el, mesh, engine } = await rig(),
    handle = gizmo
      .handles()
      .filter((h) => h.kind === 'scale')
      .find((h) => gizmo.pick(...pixel(engine.camera, h.position))?.id === h.id);
  const p = pixel(engine.camera, handle.position),
    before = size(mesh),
    events = [];
  for (const event of ['start', 'objectChange', 'end', 'dragging-changed'])
    gizmo.addEventListener(event, (e) => events.push(e.type));
  pointer(el, 'pointerdown', ...p);
  assert.equal(gizmo.dragging, true);
  assert.equal(el.captured.size, 1);
  pointer(el, 'pointermove', p[0] + 40, p[1] - 40);
  assert.notDeepEqual(size(mesh), before);
  el.dispatch('keydown', { code: 'Escape' });
  closeVec(size(mesh), before, 0);
  assert.equal(el.captured.size, 0);
  assert.deepEqual(events, ['start', 'dragging-changed', 'objectChange', 'end', 'dragging-changed', 'objectChange']);
  engine.dispose();
  assert.equal(el.listenerCount, 0);
  assert.equal(el.style.touchAction, 'auto');
});
test('disposal, detach, disabled inputs and invalid options do not retain stale mesh or plugin state', async () => {
  const { gizmo, el, mesh, engine } = await rig();
  const count = engine.plugins.size;
  assert.throws(() => new BoxGizmo(engine, { handleSize: 0 }), RangeError);
  assert.equal(engine.plugins.size, count);
  gizmo.enabled = false;
  assert.equal(gizmo.beginDrag(0, 0, 'corner-7'), false);
  gizmo.enabled = true;
  gizmo.visible = false;
  assert.equal(gizmo.pick(0, 0), null);
  gizmo.visible = true;
  mesh.dispose();
  assert.deepEqual(gizmo.handles(), []);
  assert.equal(gizmo.object, null);
  gizmo.dispose();
  gizmo.dispose();
  assert.equal(el.listenerCount, 0);
  assert.equal(gizmo.update(), false);
  assert.throws(() => gizmo.attach(mesh), /disposed/);
  assert.equal(engineRuntime(engine).disposed, false);
  engine.dispose();
});
