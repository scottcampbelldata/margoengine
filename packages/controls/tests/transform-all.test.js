import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { TransformControls } from '../dist/index.js';
import { FakeElement, close, closeVec, pointer } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
async function rig(given = {}) {
  const canvas = new Canvas(),
    store = await TransformStore.create(32),
    renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Runtime(canvas, store, renderer, { position: [6, 4, 6], target: [0, 0, 0] }, null),
    mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine, { mode: 'all', ...given });
  gizmo.attach(mesh);
  engine.render();
  return { canvas, engine, mesh, gizmo };
}
function pixel(cam, p) {
  const m = cam.matrix,
    x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [((x / w + 1) / 2) * 800, ((1 - y / w) / 2) * 600];
}
function drag(canvas, engine, from, to) {
  pointer(canvas, 'pointerdown', ...pixel(engine.camera, from));
  pointer(canvas, 'pointermove', ...pixel(engine.camera, to));
  pointer(canvas, 'pointerup', ...pixel(engine.camera, to));
}

test('all mode: move, rotate and scale handles are drawn together, each with its own name', async () => {
  const { engine, gizmo } = await rig();
  const names = gizmo.handles().map((h) => h.name);
  assert.deepEqual(
    [...names].sort(),
    ['RX', 'RY', 'RZ', 'SX', 'SY', 'SZ', 'X', 'XY', 'XYZ', 'XZ', 'Y', 'YZ', 'Z'].sort(),
  );
  assert.equal(new Set(names).size, names.length, 'no name is used twice');
  // Hovering a ring lights only that ring, not the arrow sharing its letter.
  gizmo.axis = 'RX';
  const arrow = gizmo.handles().find((h) => h.name === 'X').prims[0].colors[0];
  assert.notDeepEqual(arrow, [1, 1, 0, 1]);
  gizmo.dispose();
  engine.dispose();
});

test('all mode: the arrow moves, the ring turns and the cube scales', async () => {
  const { canvas, engine, mesh, gizmo } = await rig();
  const s = gizmo.frame().size;
  // Arrow X, halfway along.
  assert.equal(gizmo.pick(...pixel(engine.camera, [0.6 * s, 0, 0])), 'X');
  drag(canvas, engine, [0.6 * s, 0, 0], [0.6 * s + 1, 0, 0]);
  close(mesh.position.x, 1, 1e-4, 'moved along X');
  mesh.setPosition([0, 0, 0]);
  engine.render();
  // Ring about Y, grabbed at 45 degrees between +X and +Z and turned a further 30 degrees.
  const at = (deg) => [Math.cos((deg * Math.PI) / 180) * s, 0, Math.sin((deg * Math.PI) / 180) * s];
  assert.equal(gizmo.pick(...pixel(engine.camera, at(45))), 'RY');
  drag(canvas, engine, at(45), at(15));
  close(mesh.rotation.x, 0, 1e-6);
  close(mesh.rotation.z, 0, 1e-6);
  close(Math.abs(mesh.rotation.y), Math.PI / 6, 1e-4, 'turned 30 degrees about Y');
  assert.deepEqual([mesh.position.x, mesh.position.y, mesh.position.z], [0, 0, 0], 'a turn does not move the object');
  // Scale cube on Y, past the arrow tip, dragged out to twice its distance.
  const cube = gizmo.handles().find((h) => h.name === 'SY').prims[0].points,
    centre = cube.reduce((sum, p) => sum.map((v, i) => v + p[i] / cube.length), [0, 0, 0]);
  assert.ok(centre[1] > 1.15 * gizmo.frame().size, 'the cube sits past the arrow tip');
  assert.equal(gizmo.pick(...pixel(engine.camera, centre)), 'SY');
  const before = [mesh.scale.x, mesh.scale.y];
  drag(canvas, engine, centre, [centre[0], centre[1] * 1.5, centre[2]]);
  close(mesh.scale.y, before[1] * 1.5, 1e-3, 'Y grew by the drag ratio');
  close(mesh.scale.x, before[0], 1e-9);
  gizmo.dispose();
  engine.dispose();
});

test('all mode: in world space one object still scales along its own axes', async () => {
  const { canvas, engine, mesh, gizmo } = await rig();
  const h = Math.SQRT1_2;
  mesh.setQuaternion([0, h, 0, h]); // its X now points along world -Z
  engine.render();
  const s = gizmo.frame().size,
    arrow = gizmo.handles().find((x) => x.name === 'X').pick.b,
    cube = gizmo.handles().find((x) => x.name === 'SX').pick.b;
  assert.ok(Math.abs(arrow[0]) > 0.9 * s && Math.abs(arrow[2]) < 1e-9, 'the arrow follows world X');
  assert.ok(Math.abs(cube[2]) > 0.9 * s && Math.abs(cube[0]) < 1e-9, 'the cube follows the object X');
  const grab = gizmo.handles().find((x) => x.name === 'SX').pick,
    mid = grab.a.map((v, i) => (v + grab.b[i]) / 2);
  assert.equal(gizmo.pick(...pixel(engine.camera, mid)), 'SX');
  drag(
    canvas,
    engine,
    mid,
    mid.map((v) => v * 2),
  );
  close(mesh.scale.x, 2, 1e-3, 'its own X doubled');
  close(mesh.scale.z, 1, 1e-9, 'its own Z is untouched');
  gizmo.dispose();
  engine.dispose();
});

test('hide: a listed handle is neither drawn nor picked', async () => {
  const { engine, gizmo } = await rig({ hide: ['RX', 'RY', 'RZ'] });
  const names = gizmo.handles().map((h) => h.name);
  assert.ok(!names.some((n) => n[0] === 'R'), 'no rings');
  assert.ok(names.includes('X') && names.includes('SX'));
  const s = gizmo.frame().size,
    ring = [Math.SQRT1_2 * s, 0, Math.SQRT1_2 * s];
  assert.notEqual(gizmo.pick(...pixel(engine.camera, ring)), 'RY');
  gizmo.hide = [];
  assert.equal(gizmo.pick(...pixel(engine.camera, ring)), 'RY');
  gizmo.dispose();
  engine.dispose();
});

test('offset: the gizmo sits at a point of the object, and turns and scales go about it', async () => {
  const { canvas, engine, mesh, gizmo } = await rig({ space: 'local', offset: [1, 0, 0] });
  engine.render();
  closeVec([...gizmo.frame().origin], [1, 0, 0], 1e-9);
  // A quarter turn about Y at the offset point carries the object's origin from (0, 0, 0) to (1, 0, 1).
  const s = gizmo.frame().size;
  gizmo.setRotationSnap(Math.PI / 2);
  const start = [1 + s * Math.cos(0.3), 0, s * Math.sin(0.3)],
    end = [1 + s * Math.cos(0.3 - 1.2), 0, s * Math.sin(0.3 - 1.2)];
  assert.equal(gizmo.pick(...pixel(engine.camera, start)), 'RY');
  drag(canvas, engine, start, end);
  const p = mesh.position;
  closeVec([p.x, p.y, Math.abs(p.z)], [1, 0, 1], 1e-9);
  engine.render();
  closeVec([...gizmo.frame().origin], [1, 0, 0], 1e-9);
  gizmo.dispose();
  engine.dispose();
});

test('offset: a uniform drag of one scale cube spreads the object away from the offset point', async () => {
  const { canvas, engine, mesh, gizmo } = await rig({ space: 'local', offset: [-1, 0, 0] });
  const s = gizmo.frame().size,
    at = [-1 + 1.32 * s, 0, 0];
  assert.equal(gizmo.pick(...pixel(engine.camera, at)), 'SX');
  drag(canvas, engine, at, [-1 + 2.64 * s, 0, 0]);
  const factor = mesh.scale.x;
  assert.ok(factor > 1.5, `scaled up: ${factor}`);
  // Along X the object's origin, 1 from the offset point, moves to `factor` from it.
  closeVec([mesh.position.x, mesh.position.y, mesh.position.z], [-1 + factor, 0, 0], 1e-9);
  gizmo.dispose();
  engine.dispose();
});

test('fixed false: size is the gizmo length in world units at any distance', async () => {
  const { engine, gizmo } = await rig({ fixed: false, size: 0.75 });
  assert.equal(gizmo.frame().size, 0.75);
  engine.camera.position = [60, 40, 60];
  engine.render();
  assert.equal(gizmo.frame().size, 0.75);
  gizmo.fixed = true;
  assert.notEqual(gizmo.frame().size, 0.75);
  gizmo.dispose();
  engine.dispose();
});

test('axisColors, hoveredColor and lineWidth reach the drawn handles; bad values throw', async () => {
  const { engine, gizmo } = await rig({ axisColors: ['#f80', [0, 1, 1], [0.5, 0.5, 0.5, 0.25]], hoveredColor: '#fff', lineWidth: 6 });
  const prim = (name) => gizmo.handles().find((h) => h.name === name).prims[0];
  closeVec([...prim('X').colors[0]], [1, 0x88 / 255, 0, 1], 1e-9);
  closeVec([...prim('Y').colors[0]], [0, 1, 1, 1], 1e-9);
  closeVec([...prim('Z').colors[0]], [0.5, 0.5, 0.5, 0.25], 1e-9);
  assert.equal(prim('X').width, 6);
  assert.equal(prim('RX').width, 6);
  gizmo.axis = 'Y';
  closeVec([...prim('Y').colors[0]], [1, 1, 1, 1], 1e-9);
  // Each names its fix and links to its entry on the error help page.
  const linked = (kind, field) => (error) =>
    error instanceof kind && error.message.includes(field) && error.message.endsWith('; see https://margoengine.com/errors#controls-transform');
  assert.throws(() => (gizmo.axisColors = ['red', '#000', '#000']), linked(TypeError, 'axisColors'));
  assert.throws(() => (gizmo.axisColors = ['#000']), linked(TypeError, 'axisColors'));
  assert.throws(() => (gizmo.hoveredColor = [2, 0, 0]), linked(TypeError, 'hoveredColor'));
  assert.throws(() => (gizmo.lineWidth = 0), linked(RangeError, 'lineWidth'));
  assert.throws(() => (gizmo.lineWidth = Infinity), linked(RangeError, 'lineWidth'));
  assert.throws(() => (gizmo.offset = [0, Number.NaN, 0]), linked(TypeError, 'offset'));
  assert.throws(() => gizmo.setSize(Infinity), linked(RangeError, 'size'));
  assert.throws(() => gizmo.setSize(0), linked(RangeError, 'size'));
  gizmo.axisColors = null;
  gizmo.axis = null;
  closeVec([...prim('X').colors[0]], [1, 0.25, 0.25, 1], 1e-9);
  gizmo.dispose();
  engine.dispose();
});
