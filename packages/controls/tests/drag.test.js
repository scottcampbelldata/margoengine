import test from 'node:test';
import assert from 'node:assert/strict';
import {box} from '@margoengine/core';
import {Engine as Runtime, TransformStore} from '@margoengine/core/extension';
import {GLTFAsset, PBRModel} from '../../gltf-pro/dist/index.js';
import {CameraProjection} from '../../cameras/dist/index.js';
import {Raycaster} from '@margoengine/bvh';
import {DragControls} from '../dist/index.js';

class FakeElement {
  constructor(width = 800, height = 600) {this.clientWidth = this.width = width; this.clientHeight = this.height = height; this.style = {touchAction: 'auto'}; this.captured = new Set(); this.listeners = new Map();}
  addEventListener(type, listener) {if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener);}
  removeEventListener(type, listener) {this.listeners.get(type)?.delete(listener);}
  get listenerCount() {let n = 0; for (const set of this.listeners.values()) n += set.size; return n;}
  dispatch(type, props = {}) {
    const event = {type, stopped: false, stopImmediatePropagation() {this.stopped = true;}, ...props};
    for (const listener of [...(this.listeners.get(type) ?? [])]) {listener(event); if (event.stopped) break;}
    return event;
  }
  setPointerCapture(id) {this.captured.add(id);} releasePointerCapture(id) {this.captured.delete(id);} hasPointerCapture(id) {return this.captured.has(id);}
  getBoundingClientRect() {return {left: 0, top: 0};}
}
const pointer = (el, type, x, y, extra = {}) => el.dispatch(type, {clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse', isPrimary: true, ...extra});
async function world(camera = {position: [0, 0, 10], target: [0, 0, 0]}) {
  const canvas = new FakeElement(), engine = new Runtime(canvas, await TransformStore.create(64), {backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {}}, camera, null);
  return {engine, canvas};
}
function project(engine, p) {
  engine.camera.update(800 / 600, true); const m = engine.camera.matrix;
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [(x / w * 0.5 + 0.5) * 800, (0.5 - y / w * 0.5) * 600];
}
/** Where the pointer ray at (x, y) meets the plane through `point` with `normal`, via an independent Raycaster. */
function onPlane(engine, x, y, point, normal) {
  const r = new Raycaster().setFromEngine(engine, x, y), o = r.origin, d = r.direction, t = normal.reduce((s, n, i) => s + n * (point[i] - o[i]), 0) / normal.reduce((s, n, i) => s + n * d[i], 0);
  return [0, 1, 2].map(i => o[i] + d[i] * t);
}
const close = (a, b, tolerance = 1e-4, label = '') => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tolerance, `${label} ${[...a]} vs ${b}`));
const position = (engine, mesh) => {engine.store.tick(false); const m = mesh.matrix; return [m[12], m[13], m[14]];};
function quad(engine) {
  const data = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), bytes = new Uint8Array(data.buffer.slice(0));
  const doc = {asset: {version: '2.0'}, buffers: [{byteLength: 96}, {byteLength: 24}], bufferViews: [{buffer: 0, byteLength: 48}, {buffer: 0, byteOffset: 48, byteLength: 48}, {buffer: 1, byteLength: 24}],
    accessors: [{bufferView: 0, componentType: 5126, count: 4, type: 'VEC3'}, {bufferView: 1, componentType: 5126, count: 4, type: 'VEC3'}, {bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR'}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1}, indices: 2}]}], nodes: [{mesh: 0}]};
  return new PBRModel(engine, new GLTFAsset(doc, [bytes, new Uint8Array(new Uint32Array([0, 1, 2, 0, 2, 3]).buffer)]));
}

test('DragControls drags a core mesh on the view plane, along an axis and on a ground plane, with parents and events', async () => {
  const {engine, canvas} = await world(), parent = engine.createMesh().setPosition([1, 0, 0]).setScale([2, 2, 2]);
  const mesh = engine.createMesh().setGeometry(box()).setParent(parent).setScale([0.25, 0.25, 0.25]), events = [];
  const controls = new DragControls(engine, [mesh]);
  for (const type of ['dragstart', 'drag', 'dragend', 'hoveron', 'hoveroff']) controls.addEventListener(type, event => events.push([type, event.object]));
  assert.equal(canvas.style.touchAction, 'none');
  const [x, y] = project(engine, [1, 0, 0.25]);
  assert.equal(pointer(canvas, 'pointermove', x, y).stopped, false); assert.equal(controls.hovered, mesh);
  const down = pointer(canvas, 'pointerdown', x, y);
  assert.ok(down.stopped, 'a grab stops later listeners such as OrbitControls'); assert.equal(controls.dragging, mesh); assert.ok(canvas.captured.has(1));
  pointer(canvas, 'pointermove', x + 80, y - 40);
  const expected = onPlane(engine, x + 80, y - 40, [1, 0, 0.25], [0, 0, -1]);
  close(position(engine, mesh), [expected[0], expected[1], 0], 1e-4, 'view plane');
  close(['x', 'y', 'z'].map(k => engine.store.transforms[k][mesh.id]), [(expected[0] - 1) / 2, expected[1] / 2, 0], 1e-4, 'local position under the scaled parent');
  pointer(canvas, 'pointerup', x + 80, y - 40);
  assert.equal(controls.dragging, null); assert.ok(!canvas.captured.has(1));
  assert.deepEqual(events.map(e => e[0]), ['hoveron', 'dragstart', 'drag', 'dragend']); assert.ok(events.every(e => e[1] === mesh));
  // Axis: only X changes. Ground plane: Y stays.
  controls.axis = [1, 0, 0]; let start = position(engine, mesh), [sx, sy] = project(engine, start);
  pointer(canvas, 'pointerdown', sx, sy); pointer(canvas, 'pointermove', sx - 60, sy + 70); pointer(canvas, 'pointerup', sx - 60, sy + 70);
  let now = position(engine, mesh); assert.ok(now[0] < start[0] - 0.1); close(now.slice(1), start.slice(1), 1e-5, 'axis');
  controls.axis = null; controls.plane = [0, 1, 0]; start = position(engine, mesh); [sx, sy] = project(engine, start);
  pointer(canvas, 'pointerdown', sx, sy); pointer(canvas, 'pointermove', sx + 50, sy + 5); pointer(canvas, 'pointerup', sx + 50, sy + 5);
  now = position(engine, mesh); close([now[1]], [start[1]], 1e-5, 'ground plane'); assert.ok(now[0] > start[0] + 0.1);
  // Misses fall through; secondary buttons and disabled controls do nothing; a disposed mesh ends the drag.
  assert.equal(pointer(canvas, 'pointerdown', 5, 5).stopped, false); assert.equal(controls.dragging, null);
  [sx, sy] = project(engine, position(engine, mesh));
  assert.equal(pointer(canvas, 'pointerdown', sx, sy, {button: 2}).stopped, false);
  controls.enabled = false; assert.equal(pointer(canvas, 'pointerdown', sx, sy).stopped, false); controls.enabled = true;
  pointer(canvas, 'pointerdown', sx, sy); events.length = 0; mesh.dispose(); pointer(canvas, 'pointermove', sx + 10, sy);
  assert.equal(controls.dragging, null); assert.deepEqual(events.map(e => e[0]), ['dragend']);
  controls.dispose(); assert.equal(canvas.listenerCount, 0); assert.equal(canvas.style.touchAction, 'auto');
});

test('DragControls moves gltf-pro models by their root, with touch and an orthographic camera', async () => {
  const {engine, canvas} = await world({position: [0, 0, 10], target: [0, 0, 0]}), model = quad(engine), core = engine.createMesh().setGeometry(box()).setPosition([3, 0, 0]);
  engine.use(new CameraProjection({mode: 'orthographic', height: 6}));
  model.root.setPosition([-2, 0, 0]);
  const controls = new DragControls(engine, [model, core]), starts = [];
  controls.addEventListener('dragstart', event => starts.push(event));
  const [x, y] = project(engine, [-2, 0.3, 0]);
  pointer(canvas, 'pointerdown', x, y, {pointerType: 'touch', pointerId: 7});
  assert.equal(controls.dragging, model); assert.equal(starts[0].object, model); assert.equal(starts[0].hit.model, model);
  assert.equal(controls.hovered, model);
  pointer(canvas, 'pointermove', x + 100, y, {pointerType: 'touch', pointerId: 8}); close(position(engine, model.root), [-2, 0, 0], 1e-6, 'other pointers are ignored');
  pointer(canvas, 'pointermove', x + 100, y + 50, {pointerType: 'touch', pointerId: 7});
  // Orthographic: 600 CSS pixels span 6 world units.
  close(position(engine, model.root), [-1, -0.5, 0], 1e-4, 'orthographic touch drag');
  pointer(canvas, 'pointerup', x + 100, y + 50, {pointerType: 'touch', pointerId: 7});
  assert.equal(controls.dragging, null); assert.equal(controls.hovered, null, 'touch clears hover');
  const [cx, cy] = project(engine, [3, 0, 0.5]); pointer(canvas, 'pointerdown', cx, cy); assert.equal(controls.dragging, core); pointer(canvas, 'pointerup', cx, cy);
  model.dispose(); assert.equal(pointer(canvas, 'pointerdown', x + 100, y + 50).stopped, false, 'disposed models are not grabbed');
  controls.dispose();
});
