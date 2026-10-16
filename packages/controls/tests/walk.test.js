// WalkControls: deterministic Node tests on real core engines (stub renderer) and generated geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry, box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { FloatingOrigin } from '../../cameras/dist/origin.js';
import { WalkControls } from '../dist/walk.js';
import { PATH, buildHouse, clearance } from './house.js';

class FakeElement {
  constructor(width = 800, height = 600) {
    this.clientWidth = this.width = width;
    this.clientHeight = this.height = height;
    this.style = { touchAction: 'auto' };
    this.captured = new Set();
    this.listeners = new Map();
    this.locks = 0;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  get listenerCount() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  dispatch(type, props = {}) {
    const event = {
      type,
      preventDefault() {
        this.prevented = true;
      },
      ...props,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
  hasPointerCapture(id) {
    return this.captured.has(id);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  requestPointerLock() {
    this.locks++;
  }
}
const UNIT = box(),
  R = 0.25,
  EYE = 1.65;
async function world(position = [0, EYE, 0], target = [0, EYE, 1]) {
  const canvas = new FakeElement();
  const engine = new Runtime(
    canvas,
    await TransformStore.create(1024),
    { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    { position, target },
    null,
  );
  return { engine, canvas };
}
const block = (engine, min, max) =>
  engine
    .createMesh()
    .setGeometry(UNIT)
    .setPosition([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2])
    .setScale([max[0] - min[0], max[1] - min[1], max[2] - min[2]]);
const quad = (engine, a, b, c, d) =>
  engine
    .createMesh()
    .setGeometry(new Geometry([...a, ...b, ...c, ...d], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2, 0, 2, 3]));
/** Renders `frames` frames; `each(i)` runs before each. Returns the camera position after every frame. */
function run(engine, frames, delta = 1 / 60, each) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    each?.(i);
    engine.render({ delta });
    out.push([...engine.camera.position]);
  }
  return out;
}
const near = (a, b, tolerance, label) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${label}: expected ${b} +/- ${tolerance}, got ${a}`);

test('climbs a staircase of steps up to stepHeight smoothly and refuses taller steps', async () => {
  const { engine } = await world(),
    steps = [];
  block(engine, [-2, -0.2, -2], [2, 0, 12]);
  for (let k = 0; k < 12; k++) steps.push(block(engine, [-1, 0, 2 + k * 0.3], [1, (k + 1) * 0.18, 2 + (k + 1) * 0.3]));
  block(engine, [-1, 0, 5.6], [1, 2.16, 9]);
  const walk = new WalkControls(engine);
  walk.axes.y = -1;
  const path = run(engine, 360);
  walk.axes.y = 0;
  run(engine, 60);
  near(engine.camera.position[1], 2.16 + EYE, 1e-6, 'eye on the landing');
  assert.ok(engine.camera.position[2] > 6, 'walked onto the landing');
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i][1] >= path[i - 1][1] - 1e-9, 'eye never drops on the way up');
    assert.ok(path[i][1] - path[i - 1][1] < 0.06, `no jumps: ${path[i][1] - path[i - 1][1]}`);
  }
  assert.equal(walk.stats.rays, 9 * walk.stats.substeps, 'nine ground rays per sub-step');
  walk.axes.y = 1; // back down, facing up the stairs
  const down = run(engine, 420);
  near(engine.camera.position[1], EYE, 1e-6, 'eye back on the ground floor');
  for (let i = 1; i < down.length; i++)
    assert.ok(down[i - 1][1] - down[i][1] < 0.06, `eases down each step: ${down[i - 1][1] - down[i][1]}`);
  walk.dispose();

  for (const [rise, climbed] of [
    [0.19, true],
    [0.25, false],
    [0.4, false],
  ]) {
    const w = await world();
    block(w.engine, [-2, -0.2, -2], [2, 0, 6]);
    block(w.engine, [-2, 0, 2], [2, rise, 6]);
    const controls = new WalkControls(w.engine);
    controls.axes.y = -1;
    run(w.engine, 240);
    if (climbed) near(w.engine.camera.position[1], rise + EYE, 1e-6, `${rise} m step climbed`);
    else {
      near(w.engine.camera.position[1], EYE, 1e-9, `${rise} m step refused`);
      assert.ok(w.engine.camera.position[2] < 2 - 0.05, 'stopped before the riser');
    }
  }
});

test('slides along walls and never passes a zero-thickness wall, even at 30 m/s and 10 fps', async () => {
  const { engine } = await world([0, EYE, 0], [1, EYE, 1]);
  block(engine, [-5, -0.2, -5], [8, 0, 5]);
  block(engine, [-5, 0, 2], [8, 3, 2.2]);
  const walk = new WalkControls(engine);
  walk.axes.y = -1;
  run(engine, 180);
  near(engine.camera.position[2], 2 - R, 1e-3, 'held one radius off the wall');
  assert.ok(engine.camera.position[0] > 2, `slid along the wall: x = ${engine.camera.position[0]}`);
  assert.ok(walk.velocity[0] > 0.9 && Math.abs(walk.velocity[2]) < 1e-6, `velocity follows the wall: ${walk.velocity}`);

  for (const delta of [0.1, 1 / 30, 1 / 60]) {
    const w = await world();
    block(w.engine, [-50, -0.2, -50], [50, 0, 50]);
    quad(w.engine, [-50, 0, 2], [50, 0, 2], [50, 3, 2], [-50, 3, 2]); // glass: one quad, no thickness
    quad(w.engine, [-1, 0, -50], [-1, 0, 50], [-1, 3, 50], [-1, 3, -50]); // a pane on the right (-x when facing +z): a corner
    const fast = new WalkControls(w.engine);
    fast.speed = 30;
    fast.axes.y = -1;
    fast.axes.x = 0.3;
    for (const p of run(w.engine, 40, delta)) {
      assert.ok(p[2] <= 2 - R + 1e-3, `crossed the glass at ${delta}: ${p}`);
      assert.ok(p[0] >= -1 + R - 1e-3, `crossed the corner pane: ${p}`);
    }
    assert.ok(fast.stats.substeps >= 1 && fast.stats.substeps <= 32);
  }
});

test('holds eye height over hardwood, a rug and a deck with gaps, and bridges gaps narrower than the capsule', async () => {
  const { engine } = await world();
  block(engine, [-2, -0.2, -2], [2, 0, 12]); // hardwood, top 0
  block(engine, [-1, 0, 2], [1, 0.012, 4]); // 12 mm rug
  for (let z = 4; z < 8; z += 0.15) block(engine, [-1, 0.07, z], [1, 0.1, z + 0.14]); // deck boards, 1 cm gaps, top 0.1
  const walk = new WalkControls(engine);
  walk.axes.y = -1;
  const path = run(engine, 330);
  const floor = (z) => (z < 2 ? 0 : z < 4 ? 0.012 : 0.1),
    settled = [
      [0.3, 1.5],
      [2.6, 3.7],
      [4.6, 7.6],
    ]; // the ring sees a new floor 0.225 m early, then the eye eases;
  let checked = 0;
  for (const p of path)
    for (const [a, b] of settled)
      if (p[2] > a && p[2] < b) {
        near(p[1], floor(p[2]) + EYE, 2e-3, `eye at z = ${p[2].toFixed(3)}`);
        checked++;
      }
  assert.ok(checked > 200, `checked ${checked} frames`);

  for (const [gap, falls] of [
    [0.35, false],
    [0.8, true],
  ]) {
    const w = await world();
    block(w.engine, [-2, -0.2, -2], [2, 0, 2]);
    block(w.engine, [-2, -0.2, 2 + gap], [2, 0, 8]);
    block(w.engine, [-2, -3.2, -2], [2, -3, 8]);
    const controls = new WalkControls(w.engine);
    controls.axes.y = -1;
    const lowest = Math.min(...run(w.engine, 240).map((p) => p[1]));
    if (falls) assert.ok(lowest < 0, `fell through the ${gap} m gap`);
    else near(lowest, EYE, 1e-9, `${gap} m gap bridged`);
  }
});

test('walks up ramps under maxSlope and is stopped by steeper ones', async () => {
  for (const [degrees, climbs] of [
    [20, true],
    [40, true],
    [60, false],
  ]) {
    const { engine } = await world(),
      t = Math.tan((degrees * Math.PI) / 180),
      length = 4;
    block(engine, [-3, -0.2, -2], [3, 0, 2]);
    quad(engine, [-3, 0, 2], [3, 0, 2], [3, length * t, 2 + length], [-3, length * t, 2 + length]);
    const walk = new WalkControls(engine);
    walk.axes.y = -1;
    run(engine, 240);
    const [, y, z] = engine.camera.position;
    if (climbs) {
      assert.ok(y > EYE + 1, `${degrees} deg: climbed to ${y}`);
      near(y - EYE, (z - 2) * t, R * 0.9 * t + 1e-3, `${degrees} deg: on the ramp`);
    } else {
      assert.ok(y < EYE + 0.2 && z < 2.2, `${degrees} deg: blocked at ${[y, z]}`);
    }
  }
});

test('jumps and falls with gravity, lands on the floor and stops at ceilings', async () => {
  const { engine } = await world();
  block(engine, [-3, -0.2, -3], [3, 0, 3]);
  block(engine, [-3, 1.8, 1], [3, 2, 3]);
  const walk = new WalkControls(engine);
  run(engine, 10);
  walk.pressed.add('Space');
  run(engine, 30);
  walk.pressed.delete('Space');
  run(engine, 1);
  near(engine.camera.position[1], EYE, 1e-9, 'jumpSpeed 0 (walkthrough default) does not jump');
  walk.jumpSpeed = 4;
  walk.pressed.add('Space');
  const heights = run(engine, 120).map((p) => p[1]);
  near(Math.max(...heights) - EYE, 16 / (2 * 9.81), 0.05, 'apex v^2 / 2g');
  near(heights.at(-1), EYE, 1e-9, 'landed');
  assert.ok(walk.grounded);
  assert.equal(
    heights.filter((h, i) => h > EYE + 1e-6 && (i ? heights[i - 1] : EYE) <= EYE + 1e-6).length,
    1,
    'holding Space jumps once',
  );
  walk.pressed.clear();
  run(engine, 2);
  engine.camera.position = [0, EYE, 2];
  engine.camera.target = [0, EYE, 3];
  run(engine, 5);
  walk.pressed.add('Space');
  const capped = Math.max(...run(engine, 90).map((p) => p[1]));
  assert.ok(capped <= 1.8 - 0.1 + 1e-6 && capped > EYE, `head stops at the 1.8 m ceiling: eye ${capped}`);
  walk.dispose();

  const fall = await world([0, 2 + EYE, 0]);
  block(fall.engine, [-2, 1.8, -2], [2, 2, 1]);
  block(fall.engine, [-2, -0.2, -2], [2, 0, 6]);
  const ledge = new WalkControls(fall.engine);
  ledge.axes.y = -1;
  const ys = run(fall.engine, 180).map((p) => p[1]);
  near(ys.at(-1), EYE, 1e-9, 'fell 2 m and landed');
  assert.ok(
    ys.some((y, i) => i && ys[i - 1] - y > 0.05),
    'a real fall, not a step',
  );
});

test('crouches under low obstacles and only stands up where there is headroom', async () => {
  const { engine } = await world();
  block(engine, [-2, -0.2, -2], [2, 0, 8]);
  block(engine, [-2, 1.3, 2], [2, 1.5, 4]);
  const walk = new WalkControls(engine);
  walk.axes.y = -1;
  run(engine, 120);
  assert.ok(engine.camera.position[2] < 2, 'standing walker is stopped by the 1.3 m overhang');
  walk.crouch = true;
  run(engine, 90);
  walk.axes.y = 0;
  walk.crouch = false;
  run(engine, 60);
  assert.ok(engine.camera.position[2] > 2 && engine.camera.position[2] < 4, 'under the overhang');
  assert.ok(
    engine.camera.position[1] <= 1.3 - 0.1 + 1e-6,
    `stays low until there is headroom: ${engine.camera.position[1]}`,
  );
  walk.axes.y = -1;
  run(engine, 150);
  walk.axes.y = 0;
  run(engine, 60);
  near(engine.camera.position[1], EYE, 1e-3, 'stands up past the overhang');
});

test('walks the generated two-storey house: deck, door, rug, doorway, 16 stairs, upper floor; never clips', async () => {
  const { engine } = await world([PATH[0][0], EYE, PATH[0][1]], [PATH[0][0], EYE, PATH[0][1] + 1]);
  const house = buildHouse(engine),
    walk = new WalkControls(engine);
  let target = 1,
    frames = 0,
    worst = Infinity,
    maxRise = 0,
    last = engine.camera.position[1];
  while (target < PATH.length && frames < 60 * 60) {
    const [x, , z] = engine.camera.position,
      [tx, tz] = PATH[target],
      dx = tx - x,
      dz = tz - z;
    if (Math.hypot(dx, dz) < 0.15) {
      target++;
      continue;
    }
    engine.camera.target = [x + dx, engine.camera.position[1], z + dz];
    walk.axes.y = -1;
    engine.render({ delta: 1 / 60 });
    frames++;
    const p = engine.camera.position,
      feet = p[1] - EYE;
    worst = Math.min(worst, clearance(house, p[0], feet + walk.stepHeight + R, p[1] + 0.1 - R, p[2]));
    maxRise = Math.max(maxRise, Math.abs(p[1] - last));
    last = p[1];
  }
  assert.equal(
    target,
    PATH.length,
    `reached every waypoint (stuck before ${PATH[target]} at ${engine.camera.position})`,
  );
  walk.axes.y = 0;
  run(engine, 60);
  near(engine.camera.position[1], 3 + EYE, 1e-6, 'eye height on the upper floor');
  assert.ok(worst >= R - 0.01, `capsule kept clear of walls, stairs and glass: ${worst}`);
  assert.ok(maxRise < 0.05, `smooth: largest per-frame eye change ${maxRise}`);
});

test('dollhouse view: eases out to an orbit view and back to the exact walk pose, perspective or orthographic, across a floating-origin rebase', async () => {
  const { engine, canvas } = await world([2.5, EYE, 1.5], [2.5, EYE, 2.5]);
  const house = buildHouse(engine),
    projection = CameraProjection.attach(engine, { mode: 'perspective' }),
    origin = FloatingOrigin.attach(engine);
  for (const mesh of house.meshes) origin.place(mesh, [mesh.position.x, mesh.position.y, mesh.position.z]); // roots the origin keeps in float64
  const walk = new WalkControls(engine, { projection, origin }),
    modes = [];
  walk.addEventListener('mode', (event) => modes.push(event.mode));
  run(engine, 5);
  const saved = [...engine.camera.position, ...engine.camera.target];
  walk.dollhouseBounds = [0, -0.2, 0, 10, 6, 8];
  walk.setMode('dollhouse');
  assert.equal(walk.mode, 'dollhouse');
  assert.ok(walk.transitioning);
  assert.equal(walk.orbit.enabled, false);
  const out = run(engine, 70, 1 / 60, () => {
    const c = engine.camera,
      f = [0, 1, 2].map((i) => c.target[i] - c.position[i]);
    assert.ok(Math.hypot(f[0], f[2]) > 1e-3 * Math.hypot(...f), 'never a vertical view');
  });
  assert.ok(!walk.transitioning && walk.orbit.enabled);
  assert.deepEqual(modes, ['dollhouse']);
  assert.equal(projection.mode, 'orthographic');
  assert.equal(engine.camera.matrix[11], 0, 'orthographic matrix');
  const c = engine.camera;
  [5, 2.9, 4].forEach((v, i) => near(c.target[i], v, 1e-9, 'framed on the bounds centre'));
  near(
    Math.asin((c.position[1] - c.target[1]) / Math.hypot(...[0, 1, 2].map((i) => c.position[i] - c.target[i]))),
    walk.dollhouseElevation,
    1e-9,
    'elevation',
  );
  assert.ok(
    out.every((p, i) => !i || Math.hypot(...[0, 1, 2].map((k) => p[k] - out[i - 1][k])) < 1.5),
    'smooth: no teleport',
  );
  // Orbit half way round (a 400 px drag), rebase the origin, then walk again.
  const drag = (type, x) =>
    canvas.dispatch(type, { clientX: x, clientY: 300, pointerId: 7, button: 0, pointerType: 'mouse', isPrimary: true });
  drag('pointerdown', 100);
  for (let x = 150; x <= 500; x += 50) drag('pointermove', x);
  drag('pointerup', 500);
  run(engine, 2);
  origin.rebase([100, 0, 50]);
  walk.setMode('walk');
  assert.equal(projection.mode, 'perspective');
  run(engine, 70, 1 / 60, () => {
    const f = [0, 1, 2].map((i) => engine.camera.target[i] - engine.camera.position[i]);
    assert.ok(Math.hypot(f[0], f[2]) > 1e-3 * Math.hypot(...f), 'never a vertical view on the way back');
  });
  assert.deepEqual(modes, ['dollhouse', 'walk']);
  assert.equal(walk.orbit.enabled, false);
  const shift = [100, 0, 50, 100, 0, 50];
  [...engine.camera.position, ...engine.camera.target].forEach((v, i) =>
    near(v, saved[i] - shift[i], 1e-6, 'back at the saved pose, in the rebased frame'),
  );
  run(engine, 30);
  near(engine.camera.position[1], EYE, 1e-6, 'still standing on the floor after the rebase');
  walk.toggleDollhouse();
  walk.toggleDollhouse();
  run(engine, 70);
  assert.equal(walk.mode, 'walk');
  near(engine.camera.position[1], EYE, 1e-6, 'a toggle cancelled half way returns to the walk pose');
});

test('collides with gltf-pro models (default colliders include attached models) and honours hidden meshes and explicit collider lists', async () => {
  const data = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    bytes = new Uint8Array(data.buffer.slice(0));
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 96 }, { byteLength: 24 }],
    bufferViews: [
      { buffer: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 1, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    nodes: [{ mesh: 0 }],
  };
  const { engine } = await world();
  const floor = block(engine, [-3, -0.2, -3], [3, 0, 6]);
  const model = new PBRModel(
    engine,
    new GLTFAsset(doc, [bytes, new Uint8Array(new Uint32Array([0, 1, 2, 0, 2, 3]).buffer)]),
  );
  model.root.setPosition([0, 1, 2]).setScale([3, 1, 1]); // a 6 x 2 m pane at z = 2
  engine.use({ name: 'model', setup() {}, root: model.root, primitives: model.primitives });
  const walk = new WalkControls(engine);
  walk.axes.y = -1;
  run(engine, 120);
  near(engine.camera.position[2], 2 - R, 1e-3, 'stopped by the model');
  model.root.visible = false;
  run(engine, 60);
  assert.ok(engine.camera.position[2] > 2.5, 'a hidden model does not collide');
  model.root.visible = true;
  walk.dispose();

  const w = await world();
  const ground = block(w.engine, [-3, -0.2, -3], [3, 0, 6]),
    wall = block(w.engine, [-3, 0, 2], [3, 3, 2.2]);
  const only = new WalkControls(w.engine, { colliders: [ground] });
  only.axes.y = -1;
  run(w.engine, 120);
  assert.ok(w.engine.camera.position[2] > 2.5, 'meshes outside `colliders` are ignored');
  only.colliders = [ground, wall];
  only.axes.y = 1;
  run(w.engine, 150);
  near(w.engine.camera.position[2], 2.2 + R, 1e-3, 'colliders can change at run time (the wall now stops a walk back)');
  assert.ok(floor && wall);
});

test('input: keys, pointer-lock and drag look, touch thumbstick and drag-look, gamepad; disposal removes listeners and the orbit controls', async () => {
  const { engine, canvas } = await world();
  block(engine, [-20, -0.2, -20], [20, 0, 20]);
  const keys = new FakeElement(),
    walk = new WalkControls(engine, { keyTarget: keys });
  assert.equal(canvas.style.touchAction, 'none');
  keys.dispatch('keydown', { code: 'KeyW' });
  run(engine, 60);
  keys.dispatch('keyup', { code: 'KeyW' });
  const z1 = engine.camera.position[2];
  assert.ok(z1 > 0.8 && z1 < 1.5, `W walks forward with easing: ${z1}`);
  run(engine, 60);
  const z2 = engine.camera.position[2];
  assert.ok(z2 > z1 && z2 - z1 < 0.3, 'decelerates smoothly, no instant stop');
  assert.equal(keys.dispatch('keydown', { code: 'Space' }).prevented, true, 'Space does not scroll the page');
  keys.dispatch('keyup', { code: 'Space' });
  // Mouse: a click requests pointer lock; drag look turns the view.
  const yaw = () =>
    Math.atan2(
      engine.camera.target[0] - engine.camera.position[0],
      engine.camera.target[2] - engine.camera.position[2],
    );
  const p = (type, x, y, extra = {}) =>
    canvas.dispatch(type, { clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse', ...extra });
  p('pointerdown', 400, 300);
  assert.equal(canvas.locks, 1);
  const y0 = yaw();
  p('pointermove', 300, 300);
  run(engine, 1);
  p('pointerup', 300, 300);
  near(yaw() - y0, 100 * 0.0022, 1e-9, 'drag 100 px left turns left');
  walk.isLocked = true;
  const y1 = yaw();
  p('pointermove', 300, 300, { movementX: -50, movementY: 0 });
  run(engine, 1);
  near(yaw() - y1, 50 * 0.0022, 1e-9, 'locked mouse movement turns');
  walk.isLocked = false;
  // Touch: left half is a floating stick, right half drag-looks; both at once.
  const t = (type, id, x, y) =>
    canvas.dispatch(type, { clientX: x, clientY: y, pointerId: id, button: 0, pointerType: 'touch' });
  const start = [...engine.camera.position],
    y2 = yaw();
  t('pointerdown', 11, 100, 400);
  t('pointermove', 11, 100, 340); // thumb pushed 60 px up: full forward
  t('pointerdown', 12, 600, 300);
  t('pointermove', 12, 560, 300); // look 40 px left
  run(engine, 60);
  near(yaw() - y2, 40 * 0.005, 1e-9, 'right-half drag turns');
  const moved = [0, 2].map((i) => engine.camera.position[i] - start[i]),
    heading = yaw();
  assert.ok(Math.hypot(...moved) > 0.8, 'left-half stick walks');
  near(Math.atan2(moved[0], moved[1]), heading, 0.1, 'walks where it looks');
  t('pointerup', 11, 100, 340);
  t('pointerup', 12, 560, 300);
  assert.equal(canvas.captured.size, 0);
  // Gamepad: left stick walks, right stick turns.
  const pad = { axes: [0, -1, 1, 0], buttons: [] },
    previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [null, pad] }, configurable: true });
  try {
    const before = [...engine.camera.position],
      y3 = yaw();
    run(engine, 30);
    near(yaw() - y3, ((-(1 - 0.15) / 0.85) * 2.2 * 30) / 60, 1e-9, 'right stick turns right at 2.2 rad/s');
    assert.ok(
      Math.hypot(engine.camera.position[0] - before[0], engine.camera.position[2] - before[2]) > 0.3,
      'left stick walks',
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
  // Orbit listeners stay off while walking; dispose removes everything.
  assert.ok(canvas.listenerCount > 0 && keys.listenerCount === 2);
  walk.dispose();
  assert.equal(canvas.listenerCount, 0);
  assert.equal(keys.listenerCount, 0);
  assert.equal(canvas.style.touchAction, 'auto');
  assert.equal(
    engine.hasPlugin('margoengine-controls:walk:1') ||
      [...engine.plugins.keys()].some((name) => name.includes('controls')),
    false,
    'plugins removed',
  );
  assert.throws(() => {
    const bad = new WalkControls(engine);
    bad.radius = -1;
    bad.update(1 / 60);
  }, /Invalid WalkControls settings/);
});
