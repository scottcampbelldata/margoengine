// The step through Wasm: what cargo test proves natively must hold in the shipped build, column views included.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, loadKernel } from '../dist/next.js';

/** A dynamic body of unit mass and unit moments. */
function ball(world) {
  const body = world.addBody('dynamic'),
    { inverseMass, inertiaX, inertiaY, inertiaZ, inverseInertiaX, inverseInertiaY, inverseInertiaZ } = world.columns;
  inverseMass[body] = 1;
  for (const column of [inertiaX, inertiaY, inertiaZ, inverseInertiaX, inverseInertiaY, inverseInertiaZ])
    column[body] = 1;
  return body;
}

test('free fall through Wasm follows the closed form with the method term', async () => {
  // Semi-implicit Euler gives y = y0 + v0 t - g t^2 / 2 - g h t / 2 exactly; f32 rounding adds at most n ulps of 256.
  await loadKernel();
  const world = new KernelWorld(4);
  world.substeps = 4;
  const body = ball(world),
    { positionY, linearY } = world.columns,
    steps = 240,
    g = Math.fround(9.81),
    t = steps / 60,
    h = 1 / 240;
  positionY[body] = 100;
  linearY[body] = 3;
  for (let i = 0; i < steps; i++) world.step(1 / 60);
  assert.equal(world.steps, steps);
  const rounding = steps * 4 * 2 ** -24 * 256;
  assert.ok(Math.abs(positionY[body] - (100 + 3 * t - 0.5 * g * t * t - 0.5 * g * h * t)) <= rounding);
  assert.ok(Math.abs(linearY[body] - (3 - g * t)) <= rounding);
});

test('a projectile keeps its horizontal speed and meets the parabola', async () => {
  await loadKernel();
  const world = new KernelWorld(2);
  const body = ball(world),
    { positionX, positionY, linearX, linearY } = world.columns;
  world.setGravity(0, -10, 0);
  world.substeps = 4;
  linearX[body] = 8;
  linearY[body] = 6;
  for (let i = 0; i < 60; i++) world.step(1 / 60);
  assert.equal(linearX[body], 8);
  const h = 1 / 240,
    rounding = 240 * 2 ** -24 * 16;
  assert.ok(Math.abs(positionX[body] - 8) <= rounding);
  assert.ok(Math.abs(positionY[body] - (6 - 5 - 5 * h)) <= rounding);
});

test('a force reaches every substep and an impulse lands once, however many substeps', async () => {
  await loadKernel();
  for (const substeps of [1, 2, 4, 8]) {
    const world = new KernelWorld(2);
    world.setGravity(0, 0, 0);
    world.substeps = substeps;
    const pushed = ball(world),
      kicked = ball(world),
      { forceX, impulseX, linearX } = world.columns;
    forceX[pushed] = 6;
    impulseX[kicked] = 3;
    world.step(0.5);
    assert.ok(Math.abs(linearX[pushed] - 3) <= substeps * 2 ** -22, `force, ${substeps} substeps`);
    assert.equal(linearX[kicked], 3, `impulse, ${substeps} substeps`);
    assert.equal(impulseX[kicked], 0, 'an impulse is spent');
    assert.equal(forceX[pushed], 6, 'a force stays until it is cleared');
    world.step(0.5);
    assert.equal(linearX[kicked], 3);
  }
});

test('the same calls give the same hash, in the same world or a grown one', async () => {
  await loadKernel();
  const run = (rows) => {
    const world = new KernelWorld(rows),
      hashes = [];
    for (let i = 0; i < 3; i++) {
      const body = ball(world);
      world.columns.linearX[body] = i + 0.5;
      world.columns.angularY[body] = 2 - i;
      world.columns.inertiaZ[body] = 1 + i;
      world.columns.inverseInertiaZ[body] = 1 / (1 + i);
    }
    for (let i = 0; i < 50; i++) {
      world.step(1 / 60);
      hashes.push(Array.from(world.columns.positionX.subarray(0, 3)).join());
    }
    return { hashes, hash: world.hash, last: world.columns.rotationZ[2] };
  };
  assert.deepEqual(run(3), run(3));
  assert.deepEqual(run(3).hashes, run(100).hashes);
});

test('addBody grows the world by itself and rows stay where they were', async () => {
  await loadKernel();
  const world = new KernelWorld(1),
    first = world.addBody('dynamic');
  world.columns.positionY[first] = 2;
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push(world.addBody('fixed'));
  assert.deepEqual(rows, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(world.capacity >= 10);
  assert.equal(world.columns.positionY[first], 2);
  assert.equal(world.columns.rotationW[9], 1, 'a new row holds the identity rotation');
});

test('kinds move as their names say', async () => {
  await loadKernel();
  const world = new KernelWorld(4),
    { positionX, positionY, linearX, targetX, rotationW, targetRotationW } = world.columns,
    fixed = world.addBody('fixed'),
    position = world.addBody('kinematicPosition'),
    velocity = world.addBody('kinematicVelocity');
  linearX[fixed] = 5;
  linearX[velocity] = 5;
  targetX[position] = 2;
  targetRotationW[position] = rotationW[position];
  world.step(0.5);
  assert.equal(positionX[fixed], 0);
  assert.equal(positionX[position], 2);
  assert.equal(linearX[position], 4, 'the velocity reported is the one that moved it');
  assert.equal(positionX[velocity], 2.5);
  assert.equal(positionY[velocity], 0, 'gravity moves only dynamic bodies');
});

test('settings read back, and values that would put a NaN in the state are refused', async () => {
  await loadKernel();
  const world = new KernelWorld(1);
  assert.deepEqual(world.gravity, [0, Math.fround(-9.81), 0]);
  world.setGravity(1, 2, 3);
  assert.deepEqual(world.gravity, [1, 2, 3]);
  assert.equal(world.substeps, 8);
  world.substeps = 2;
  assert.equal(world.substeps, 2);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => (world.substeps = bad), RangeError);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => world.step(bad), RangeError);
  assert.throws(() => world.setGravity(Number.NaN, 0, 0), RangeError);
  assert.throws(() => world.addBody('ghost'), RangeError);
  assert.equal(world.steps, 0);
});
