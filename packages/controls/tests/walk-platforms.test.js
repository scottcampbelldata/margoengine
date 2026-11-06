// WalkControls on moving and rotating floors: deterministic Node tests on a real core engine with a stub renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { WalkControls } from '../dist/walk.js';
import { FakeElement, close, closeVec } from './control-fakes.js';

const UNIT = box(),
  EYE = 1.65,
  DT = 1 / 60;
class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
async function world(position = [0, EYE, 0], target = [0, EYE, 1]) {
  return new Runtime(
    new Canvas(),
    await TransformStore.create(64),
    { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    { position, target },
    null,
  );
}
const slab = (engine, at, size) => engine.createMesh().setGeometry(UNIT).setPosition(at).setScale(size);
/** Runs `frames` frames, moving things by `each(i)` before each. */
function run(engine, frames, each) {
  for (let i = 0; i < frames; i++) {
    each?.(i);
    engine.render({ delta: DT });
  }
}
const heading = (engine) => {
  const c = engine.camera;
  return Math.atan2(c.target[0] - c.position[0], c.target[2] - c.position[2]);
};

test('a platform sliding sideways carries the walker with no lag, and a stopped one leaves it where it stopped', async () => {
  const engine = await world(),
    deck = slab(engine, [0, -0.1, 0], [4, 0.2, 4]),
    walk = new WalkControls(engine);
  assert.equal(walk.carry, true);
  run(engine, 3);
  let x = 0;
  run(engine, 120, () => {
    x += 0.02;
    deck.setPosition([x, -0.1, 0]);
  });
  closeVec(engine.camera.position, [x, EYE, 0], 1e-6, 'moved with the deck, this frame');
  assert.ok(walk.grounded);
  const still = [...engine.camera.position];
  run(engine, 30);
  closeVec(engine.camera.position, still, 1e-12, 'no creep on a stopped deck');
  walk.dispose();
});

test('a lift carries the walker up and down without leaving the floor, and walking on it adds up', async () => {
  const engine = await world(),
    lift = slab(engine, [0, -0.1, 0], [8, 0.2, 8]),
    walk = new WalkControls(engine);
  run(engine, 3);
  let y = -0.1;
  run(engine, 120, () => {
    y += 0.05; // 3 m/s, far past what the step snap alone would follow
    lift.setPosition([0, y, 0]);
  });
  close(engine.camera.position[1], y + 0.1 + EYE, 1e-6, 'up');
  assert.ok(walk.grounded);
  run(engine, 60, () => {
    y -= 0.05;
    lift.setPosition([0, y, 0]);
  });
  close(engine.camera.position[1], y + 0.1 + EYE, 1e-6, 'down, with no falling');
  assert.ok(walk.grounded);
  walk.axes.y = -1;
  let x = 0;
  run(engine, 60, () => {
    x += 0.02;
    lift.setPosition([x, y, 0]);
  });
  walk.axes.y = 0;
  assert.ok(engine.camera.position[2] > 1, 'walked forward');
  close(engine.camera.position[0], x, 1e-6, 'and rode sideways at the same time');
  walk.dispose();
});

test('a turntable swings the walker around its axis and turns the heading with it', async () => {
  const engine = await world([2, EYE, 0], [2, EYE, 1]),
    table = slab(engine, [0, -0.1, 0], [8, 0.2, 8]),
    walk = new WalkControls(engine);
  run(engine, 3);
  const start = heading(engine);
  let angle = 0;
  run(engine, 90, () => {
    angle += Math.PI / 180;
    table.setQuaternion([0, Math.sin(angle / 2), 0, Math.cos(angle / 2)]);
  });
  // A turn about +Y takes +X toward -Z.
  closeVec(engine.camera.position, [2 * Math.cos(angle), EYE, -2 * Math.sin(angle)], 1e-6);
  close(heading(engine) - start, angle, 1e-6, 'the view turned with the table');
  assert.ok(walk.grounded);
  walk.dispose();
});

test('a child of a moving parent, a scaled floor and a model-free world all carry through world matrices', async () => {
  const engine = await world(),
    root = engine.createMesh().setPosition([0, 0, 0]).setScale([2, 1, 2]),
    deck = slab(engine, [0, -0.1, 0], [3, 0.2, 3]);
  deck.setParent(root);
  const walk = new WalkControls(engine);
  run(engine, 3);
  let x = 0;
  run(engine, 60, () => {
    x += 0.01;
    root.setPosition([x, 0, 0]);
  });
  closeVec(engine.camera.position, [x, EYE, 0], 1e-6);
  walk.dispose();
});

test('jumping off keeps the platform speed in the air, and landing on still ground drops it', async () => {
  const engine = await world(),
    deck = slab(engine, [0, -0.1, 0], [6, 0.2, 6]);
  slab(engine, [0, -1.1, 0], [80, 0.2, 80]);
  const walk = new WalkControls(engine);
  walk.jumpSpeed = 4;
  run(engine, 3);
  let x = 0;
  run(engine, 30, () => {
    x += 0.05; // 3 m/s
    deck.setPosition([x, -0.1, 0]);
  });
  walk.pressed.add('Space');
  run(engine, 1, () => {
    x += 0.05;
    deck.setPosition([x, -0.1, 0]);
  });
  walk.pressed.delete('Space');
  assert.equal(walk.grounded, false);
  const leave = engine.camera.position[0];
  deck.setPosition([40, -0.1, 0]); // out from under the walker
  run(engine, 20);
  close(engine.camera.position[0] - leave, 3 * DT * 20, 0.06, 'keeps going at the deck speed');
  run(engine, 240);
  assert.ok(walk.grounded, 'landed on the ground');
  const rest = engine.camera.position[0];
  run(engine, 30);
  close(engine.camera.position[0], rest, 1e-9, 'and stops there');
  walk.dispose();
});

test('carry false keeps a sliding platform from moving the walker; a disposed platform just stops carrying', async () => {
  const engine = await world(),
    deck = slab(engine, [0, -0.1, 0], [20, 0.2, 20]),
    walk = new WalkControls(engine, { carry: false });
  run(engine, 3);
  run(engine, 30, (i) => deck.setPosition([(i + 1) * 0.02, -0.1, 0]));
  closeVec(engine.camera.position, [0, EYE, 0], 1e-9, 'stayed put');
  walk.carry = true;
  run(engine, 2);
  slab(engine, [0, -0.3, 0], [20, 0.2, 20]);
  run(engine, 2, (i) => deck.setPosition([0.6 + (i + 1) * 0.02, -0.1, 0]));
  const x = engine.camera.position[0];
  deck.dispose();
  run(engine, 2);
  close(engine.camera.position[0], x, 1e-9, 'no jump when the floor goes away');
  walk.dispose();
});

test('a static level is untouched: the camera holds bit for bit and the dollhouse clears the ride', async () => {
  const engine = await world(),
    deck = slab(engine, [0, -0.1, 0], [8, 0.2, 8]),
    walk = new WalkControls(engine);
  run(engine, 3);
  const still = [...engine.camera.position];
  run(engine, 60);
  assert.deepEqual([...engine.camera.position], still);
  walk.transitionTime = 0;
  walk.setMode('dollhouse');
  run(engine, 2);
  deck.setPosition([1, -0.1, 0]);
  walk.setMode('walk');
  run(engine, 3);
  closeVec(engine.camera.position, still, 1e-9, 'a floor moved while away is not a ride');
  walk.dispose();
});
