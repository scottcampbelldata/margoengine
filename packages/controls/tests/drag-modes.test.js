import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore, meshRuntime } from '@margoengine/core/extension';
import { DragControls } from '../dist/drag.js';
import { FakeElement, close, closeVec, pointer } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
async function world(position = [0, 0, 10]) {
  const canvas = new Canvas(),
    engine = new Runtime(
      canvas,
      await TransformStore.create(32),
      { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
      { position, target: [0, 0, 0] },
      null,
    );
  return { engine, canvas };
}
const add = (engine, position = [0, 0, 0]) => engine.createMesh().setGeometry(box()).setPosition(position);
function pixel(cam, p) {
  const m = cam.matrix,
    x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [((x / w + 1) / 2) * 800, ((1 - y / w) / 2) * 600];
}
const turnOf = (mesh) => {
  const runtime = meshRuntime(mesh),
    t = runtime.engine.store.transforms,
    id = runtime.id;
  return { x: t.qx[id], y: t.qy[id], z: t.qz[id], w: t.qw[id] };
};
const spin = (mesh, v) => {
  const { x, y, z, w } = turnOf(mesh),
    t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + y * t[2] - z * t[1],
    v[1] + w * t[1] + z * t[0] - x * t[2],
    v[2] + w * t[2] + x * t[1] - y * t[0],
  ];
};
const swipe = (canvas, from, dx, dy, steps = 4) => {
  pointer(canvas, 'pointerdown', ...from);
  for (let i = 1; i <= steps; i++)
    pointer(canvas, 'pointermove', from[0] + (dx * i) / steps, from[1] + (dy * i) / steps);
  pointer(canvas, 'pointerup', from[0] + dx, from[1] + dy);
};

test('rotate: a drag right turns the near side right about the screen up axis, in place', async () => {
  const { engine, canvas } = await world(),
    mesh = add(engine),
    drag = new DragControls(engine, [mesh], { mode: 'rotate' }),
    events = [];
  for (const type of ['dragstart', 'drag', 'dragend']) drag.addEventListener(type, (e) => events.push(e.type));
  engine.render();
  assert.equal(drag.rotateSpeed, 0.01);
  swipe(canvas, pixel(engine.camera, [0, 0, 0.5]), 100, 0);
  closeVec(spin(mesh, [0, 0, 1]), [Math.sin(1), 0, Math.cos(1)], 1e-5, '100 px at 0.01 is one radian');
  closeVec([mesh.position.x, mesh.position.y, mesh.position.z], [0, 0, 0], 0, 'stays in place');
  assert.deepEqual(events, ['dragstart', 'drag', 'drag', 'drag', 'drag', 'dragend']);
  drag.dispose();
  engine.dispose();
});

test('rotate: a drag down tips the top toward the viewer, and a diagonal is one turn in steps', async () => {
  const { engine, canvas } = await world(),
    mesh = add(engine),
    drag = new DragControls(engine, [mesh], { mode: 'rotate', rotateSpeed: 0.005 });
  engine.render();
  swipe(canvas, pixel(engine.camera, [0, 0, 0.5]), 0, 100);
  closeVec(spin(mesh, [0, 1, 0]), [0, Math.cos(0.5), Math.sin(0.5)], 1e-5);
  mesh.setQuaternion([0, 0, 0, 1]);
  engine.render();
  swipe(canvas, pixel(engine.camera, [0, 0, 0.5]), 60, 80);
  const axis = [80 / 100, 60 / 100, 0],
    [x, y, z] = [turnOf(mesh).x, turnOf(mesh).y, turnOf(mesh).z],
    length = Math.hypot(x, y, z);
  closeVec([x / length, y / length, z / length], axis, 1e-5, 'axis at right angles to the drag');
  close(2 * Math.asin(length), 0.5, 1e-5, 'angle is the path length');
  drag.dispose();
  engine.dispose();
});

test('rotate: about a world axis, whichever way the pointer goes, and under a rotated parent', async () => {
  const { engine, canvas } = await world([0, 6, 8]),
    parent = engine.createMesh().setQuaternion([0, Math.SQRT1_2, 0, Math.SQRT1_2]).setPosition([1, 0, 0]),
    mesh = add(engine).setParent(parent).setPosition([0, 0, 0]),
    drag = new DragControls(engine, [mesh], { mode: 'rotate', axis: [0, 1, 0] });
  engine.render();
  swipe(canvas, pixel(engine.camera, [1, 0.5, 0.5]), 50, 0);
  // Local turn is P^-1 R P; for a turn about the parent's own Y axis that is the same turn.
  close(turnOf(mesh).y, Math.sin(0.25), 1e-5, 'half a radian about Y');
  close(turnOf(mesh).x, 0, 1e-6);
  close(turnOf(mesh).z, 0, 1e-6);
  close(mesh.position.x, 0, 0);
  drag.dispose();
  engine.dispose();
});

test('rotate under a parent: the world turn is what the pointer asked for', async () => {
  const { engine, canvas } = await world(),
    parent = engine.createMesh().setQuaternion([Math.SQRT1_2, 0, 0, Math.SQRT1_2]),
    mesh = add(engine).setParent(parent),
    drag = new DragControls(engine, [mesh], { mode: 'rotate' });
  engine.render();
  swipe(canvas, pixel(engine.camera, [0, 0, 0.5]), 100, 0);
  engine.render();
  // The parent's +90 degrees about X maps local Z to world -Y, and local Y to world Z, before the turn about world Y.
  const world_ = (v) => {
    const q = spin(mesh, v);
    return [q[0], -q[2], q[1]];
  };
  closeVec(world_([0, 1, 0]), [Math.sin(1), 0, Math.cos(1)], 1e-5, 'local Y through parent and turn');
  drag.dispose();
  engine.dispose();
});

test('groups: every member moves by the same world step under its own parent, and only a member starts it', async () => {
  const { engine, canvas } = await world(),
    a = add(engine, [-2, 0, 0]),
    b = add(engine, [2, 0, 0]),
    parent = engine.createMesh().setPosition([0, 3, 0]).setScale([2, 2, 2]),
    c = add(engine, [0, 0, 0]).setParent(parent),
    alone = add(engine, [0, -2.5, 0]),
    drag = new DragControls(engine, [a, b, alone], { group: [a, b, c] });
  engine.render();
  const from = pixel(engine.camera, [-2, 0, 0.5]),
    to = pixel(engine.camera, [-1, 1, 0.5]);
  swipe(canvas, from, to[0] - from[0], to[1] - from[1]);
  closeVec([a.position.x, a.position.y], [-1, 1], 1e-3);
  closeVec([b.position.x, b.position.y], [3, 1], 1e-3);
  closeVec([c.position.x, c.position.y], [0.5, 0.5], 1e-3, 'halved by the parent scale');
  closeVec([alone.position.x, alone.position.y], [0, -2.5], 0);
  engine.render();
  const grab = pixel(engine.camera, [0, -2.5, 0.5]);
  swipe(canvas, grab, 40, 0);
  assert.ok(alone.position.x > 0.1, 'an object outside the group drags alone');
  closeVec([a.position.x, a.position.y], [-1, 1], 1e-3, 'and the group stays');
  drag.dispose();
  engine.dispose();
});

test('groups: rotate swings members about the grabbed origin; a member disposed mid-drag is left behind', async () => {
  const { engine, canvas } = await world(),
    a = add(engine, [0, 0, 0]),
    b = add(engine, [3, 0, 0]),
    drag = new DragControls(engine, [a, b], { mode: 'rotate', group: [a, b], axis: [0, 0, 1], rotateSpeed: Math.PI / 200 });
  engine.render();
  const from = pixel(engine.camera, [0, 0, 0.5]);
  pointer(canvas, 'pointerdown', ...from);
  pointer(canvas, 'pointermove', from[0], from[1] - 100);
  closeVec([b.position.x, b.position.y], [0, 3], 1e-5, 'a quarter turn about the grabbed origin');
  closeVec([a.position.x, a.position.y], [0, 0], 0);
  close(Math.abs(turnOf(b).z), Math.SQRT1_2, 1e-5, 'the member turns with it');
  b.dispose();
  assert.doesNotThrow(() => pointer(canvas, 'pointermove', from[0], from[1] - 200));
  close(Math.abs(turnOf(a).z), 1, 1e-5, 'the rest carries on');
  pointer(canvas, 'pointerup', from[0], from[1] - 200);
  drag.dispose();
  engine.dispose();
});

test('hierarchy: recursive drags the child, transformGroup drags the listed parent, plain ignores children', async () => {
  const build = async (options) => {
    const { engine, canvas } = await world(),
      root = add(engine, [0, 0, 0]),
      child = add(engine, [3, 0, 0]).setParent(root),
      grand = add(engine, [0, 2, 0]).setParent(child),
      drag = new DragControls(engine, [root], options);
    engine.render();
    return { engine, canvas, root, child, grand, drag };
  };
  let w = await build({});
  const at = pixel(w.engine.camera, [3, 2, 0.5]);
  assert.equal(w.drag.intersect(...at), null, 'a child of a listed mesh is not grabbed by default');
  w.drag.dispose();
  w.engine.dispose();

  w = await build({ recursive: true });
  assert.equal(w.drag.intersect(...at).object, w.grand);
  swipe(w.canvas, at, 40, 0);
  assert.ok(w.grand.position.x > 0.1, 'the child itself moves');
  closeVec([w.root.position.x, w.child.position.x], [0, 3], 0);
  w.drag.dispose();
  w.engine.dispose();

  w = await build({ transformGroup: true, recursive: true });
  assert.equal(w.drag.intersect(...at).object, w.root);
  swipe(w.canvas, at, 40, 0);
  assert.ok(w.root.position.x > 0.1, 'the listed mesh moves');
  closeVec([w.child.position.x, w.grand.position.x], [3, 0], 0);
  w.drag.dispose();
  w.engine.dispose();
});
