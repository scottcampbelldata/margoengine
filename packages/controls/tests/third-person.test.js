import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { ThirdPersonControls } from '../dist/third-person.js';
import { FakeElement, close, closeVec, pointer } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
const UNIT = box();
async function world(position = [0, 3, 8]) {
  const canvas = new Canvas(),
    engine = new Runtime(
      canvas,
      await TransformStore.create(64),
      { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
      { position, target: [0, 1, 0] },
      null,
    );
  return { engine, canvas, hero: engine.createMesh().setGeometry(UNIT) };
}
const block = (engine, min, max) =>
  engine
    .createMesh()
    .setGeometry(UNIT)
    .setPosition(min.map((v, i) => (v + max[i]) / 2))
    .setScale(min.map((v, i) => max[i] - v));
const frames = (engine, n, delta = 1 / 60, each) => {
  for (let i = 0; i < n; i++) {
    each?.(i);
    engine.render({ delta });
  }
};
const options = { lag: 0, returnTime: 0, pivotOffset: [0, 1, 0] };

test('arm: keeps the attached view direction, sits distance behind the pivot and looks along the arm', async () => {
  const { engine, hero } = await world([6, 1, 0]),
    follow = ThirdPersonControls.attach(engine, hero, { ...options, distance: 5 });
  close(follow.yaw, Math.PI / 2, 1e-9, 'yaw from the camera');
  close(follow.pitch, 0, 1e-9);
  frames(engine, 1);
  closeVec(engine.camera.position, [5, 1, 0], 1e-9);
  const view = engine.camera.target.map((v, i) => v - engine.camera.position[i]);
  close(view[0] / Math.hypot(...view), -1, 1e-9, 'facing the subject');
  closeVec(follow.heading, [-1, 0, 0], 1e-9);
  follow.yaw = 0;
  follow.pitch = Math.PI / 6;
  frames(engine, 1);
  closeVec(engine.camera.position, [0, 1 + 2.5, 5 * Math.cos(Math.PI / 6)], 1e-9);
  follow.dispose();
  engine.dispose();
});

test('wall: the arm shortens in the same frame and the camera stays on the subject side at every heading', async () => {
  const { engine, hero } = await world(),
    follow = ThirdPersonControls.attach(engine, hero, { ...options, distance: 6 });
  follow.pitch = 0;
  follow.yaw = 0;
  frames(engine, 1);
  close(follow.armLength, 6, 1e-9, 'clear');
  const wall = block(engine, [-4, -3, 3], [4, 4, 3.2]);
  frames(engine, 1);
  close(engine.camera.position[2], 3 - follow.probeRadius, 1e-6, 'pulled in within one frame');
  close(follow.armLength, 2.8, 1e-6);
  wall.dispose();
  // A room: four thin walls around the subject. The arm never leaves it, wherever it turns.
  block(engine, [-3, -3, 3], [3, 4, 3.1]);
  block(engine, [-3, -3, -3.1], [3, 4, -3]);
  block(engine, [3, -3, -3], [3.1, 4, 3]);
  block(engine, [-3.1, -3, -3], [-3, 4, 3]);
  for (let i = 0; i < 360; i++) {
    follow.yaw = (i / 360) * 2 * Math.PI;
    frames(engine, 1);
    const [x, , z] = engine.camera.position;
    assert.ok(Math.abs(x) < 3 && Math.abs(z) < 3, `inside the room at step ${i}: ${x}, ${z}`);
    assert.ok(Math.max(Math.abs(x), Math.abs(z)) <= 3 - 0.19, `probe clearance at step ${i}`);
  }
  follow.dispose();
  engine.dispose();
});

test('return: the arm eases back out once clear, alike at 30 and 60 fps, with no jump', async () => {
  const run = async (fps) => {
    const { engine, hero } = await world(),
      follow = new ThirdPersonControls(engine, hero, { ...options, distance: 6, returnTime: 0.25 });
    follow.pitch = follow.yaw = 0;
    const wall = block(engine, [-4, -3, 2], [4, 4, 2.2]);
    frames(engine, 1, 1 / fps);
    close(follow.armLength, 1.8, 1e-6, 'starts pulled in');
    wall.dispose();
    let previous = follow.armLength;
    frames(engine, fps / 4, 1 / fps, () => {
      assert.ok(follow.armLength - previous < 1.5, 'no jump');
      previous = follow.armLength;
    });
    const quarter = follow.armLength;
    frames(engine, fps * 4, 1 / fps);
    close(follow.armLength, 6, 1e-4, 'back at the wanted length');
    engine.dispose();
    return quarter;
  };
  const a = await run(60),
    b = await run(30);
  close(a, 6 - 4.2 * Math.exp(-1), 0.2, 'about one time constant');
  close(a, b, 0.12, 'same curve at both rates');
});

test('corridor: a wall beside the pivot does not collapse the arm', async () => {
  const { engine, hero } = await world(),
    follow = new ThirdPersonControls(engine, hero, { ...options, distance: 6 });
  follow.pitch = follow.yaw = 0;
  block(engine, [0.1, -3, -20], [0.3, 4, 20]);
  frames(engine, 1);
  close(follow.armLength, 6, 1e-9, 'running along the wall keeps the view');
  follow.dispose();
  engine.dispose();
});

test('shoulder: shifts the camera right, and a wall on that side stops it', async () => {
  const { engine, hero } = await world(),
    follow = new ThirdPersonControls(engine, hero, { ...options, distance: 4, shoulder: 1 });
  follow.pitch = follow.yaw = 0;
  frames(engine, 1);
  closeVec(engine.camera.position, [1, 1, 4], 1e-9);
  const view = engine.camera.target.map((v, i) => v - engine.camera.position[i]);
  closeVec([view[0], view[1]], [0, 0], 1e-9, 'the view stays straight');
  block(engine, [0.5, -3, 1], [0.7, 4, 6]);
  frames(engine, 1);
  assert.ok(engine.camera.position[0] < 0.5 - 0.1, `kept on the near side, x ${engine.camera.position[0]}`);
  follow.dispose();
  engine.dispose();
});

test('skips: the subject, its children and ignore; colliders narrows the list; collide off and filters', async () => {
  const { engine, hero } = await world(),
    child = engine.createMesh().setGeometry(UNIT).setParent(hero).setPosition([0, 1, 2]).setScale([4, 4, 0.2]),
    wall = block(engine, [-4, -3, 3], [4, 4, 3.2]),
    other = block(engine, [-4, -3, 1], [4, 4, 1.2]),
    follow = new ThirdPersonControls(engine, hero, { ...options, distance: 6, ignore: [other] });
  follow.pitch = follow.yaw = 0;
  frames(engine, 2);
  close(follow.armLength, 2.8, 1e-6, 'only the wall stops the arm');
  follow.ignore = [];
  frames(engine, 1);
  close(follow.armLength, 0.8, 1e-6, 'the nearer one now');
  follow.colliders = [wall];
  follow.returnTime = 0.25;
  frames(engine, 1);
  assert.ok(follow.armLength > 0.8 && follow.armLength < 1.2, 'eases out toward the farther wall');
  follow.returnTime = 0;
  frames(engine, 1);
  close(follow.armLength, 2.8, 1e-6, 'a listed collider only');
  follow.collide = false;
  frames(engine, 1);
  close(follow.armLength, 6, 1e-9, 'collide off');
  follow.collide = true;
  follow.colliders = null;
  follow.raycaster.filter = () => false;
  frames(engine, 1);
  close(follow.armLength, 6, 1e-9, 'your filter still counts');
  assert.equal(typeof follow.raycaster.filter, 'function');
  child.dispose();
  follow.dispose();
  engine.dispose();
});

test('spring: the pivot settles behind a moving subject alike at 30 and 60 fps; rigid at lag 0; snap jumps', async () => {
  const run = async (fps) => {
    const { engine, hero } = await world(),
      follow = new ThirdPersonControls(engine, hero, { distance: 4, pivotOffset: [0, 1, 0], lag: 0.2, collide: false });
    follow.pitch = follow.yaw = 0;
    frames(engine, 1, 1 / fps);
    hero.setPosition([3, 0, 0]);
    frames(engine, fps / 10, 1 / fps);
    const midway = engine.camera.position[0];
    frames(engine, fps * 2, 1 / fps);
    close(engine.camera.position[0], 3, 1e-4, 'settled');
    hero.setPosition([9, 0, 0]);
    follow.snap();
    frames(engine, 1, 1 / fps);
    close(engine.camera.position[0], 9, 1e-9, 'snap');
    engine.dispose();
    return midway;
  };
  const a = await run(60),
    b = await run(30);
  assert.ok(a > 0.3 && a < 2.7, `trailing at 0.1 s, x ${a}`);
  close(a, b, 1e-9, 'exact integration');

  const { engine, hero } = await world(),
    follow = new ThirdPersonControls(engine, hero, { ...options, collide: false });
  follow.pitch = follow.yaw = 0;
  hero.setPosition([3, 0, 0]);
  frames(engine, 1);
  close(engine.camera.position[0], 3, 1e-9, 'lag 0 is rigid');
  follow.dispose();
  engine.dispose();
});

test('subjects: a parented mesh, a position function and a disposed mesh', async () => {
  const { engine, hero } = await world(),
    parent = engine.createMesh().setPosition([5, 0, 0]);
  hero.setParent(parent).setPosition([1, 0, 0]);
  frames(engine, 1);
  const follow = new ThirdPersonControls(engine, hero, { ...options, collide: false, distance: 2 });
  follow.pitch = follow.yaw = 0;
  frames(engine, 1);
  closeVec(engine.camera.position, [6, 1, 2], 1e-6, 'world position under a parent');
  hero.dispose();
  assert.doesNotThrow(() => frames(engine, 2));
  closeVec(engine.camera.position, [6, 1, 2], 1e-6, 'stays where it last followed');
  follow.subject = () => [0, 0, -7];
  frames(engine, 1);
  closeVec(engine.camera.position, [0, 1, -5], 1e-9, 'a function');
  follow.dispose();
  assert.throws(() => new ThirdPersonControls(engine, null), TypeError);
  engine.dispose();
});

test('input: drag turns, pitch stops at its limits, wheel and pinch change the distance, rotate takes other input', async () => {
  const { engine, canvas, hero } = await world(),
    follow = new ThirdPersonControls(engine, hero, { ...options, collide: false }),
    events = [];
  for (const type of ['start', 'end']) follow.addEventListener(type, () => events.push(type));
  follow.pitch = follow.yaw = 0;
  pointer(canvas, 'pointerdown', 400, 300);
  pointer(canvas, 'pointermove', 500, 340);
  pointer(canvas, 'pointerup', 500, 340);
  close(follow.yaw, -0.5, 1e-9, 'drag right turns the camera left around the subject');
  close(follow.pitch, 0.2, 1e-9, 'drag down raises the camera');
  assert.deepEqual(events, ['start', 'end']);
  assert.equal(canvas.captured.size, 0);
  follow.rotate(0.5, 10);
  close(follow.yaw, 0, 1e-9);
  close(follow.pitch, follow.maxPitch, 0, 'pitch limit');
  follow.rotate(0, -10);
  close(follow.pitch, follow.minPitch, 0);

  const notch = canvas.dispatch('wheel', { deltaY: 500, deltaMode: 0 });
  assert.equal(notch.defaultPrevented, true);
  close(follow.distance, 8, 1e-9, 'one doubling');
  canvas.dispatch('wheel', { deltaY: 100000, deltaMode: 0 });
  close(follow.distance, follow.maxDistance, 0);
  canvas.dispatch('wheel', { deltaY: -100000, deltaMode: 0 });
  close(follow.distance, follow.minDistance, 0);
  follow.distance = 4;
  const touch = (type, id, x) => pointer(canvas, type, x, 300, { pointerId: id, pointerType: 'touch' });
  touch('pointerdown', 1, 380);
  touch('pointerdown', 2, 420);
  touch('pointermove', 1, 360);
  touch('pointermove', 2, 440);
  close(follow.distance, 2, 1e-9, 'spreading to twice the width halves the distance');
  touch('pointerup', 1, 360);
  touch('pointerup', 2, 440);

  follow.enabled = false;
  pointer(canvas, 'pointerdown', 400, 300);
  assert.equal(canvas.dispatch('wheel', { deltaY: 500, deltaMode: 0 }).defaultPrevented, false);
  assert.equal(canvas.dispatch('contextmenu').defaultPrevented, false);
  const before = [...engine.camera.position];
  frames(engine, 2);
  closeVec(engine.camera.position, before, 0, 'disabled: no update');
  follow.dispose();
  assert.equal(canvas.listenerCount, 0);
  assert.equal(canvas.style.touchAction, 'auto');
  engine.dispose();
});
