import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { DRY, ShallowWaterSolver } from '../../dist/hydro.js';
import { Physics } from '../../dist/index.js';
import { BODY_WORDS, IMPULSE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../../dist/world.js';
import { seekEqualsContinuous } from './harness.js';

const CELL = [0, 0, 0];
const RATE = { num: 60, den: 1 };
const DT = 1 / RATE.num;
const DENSITY = 1000;
const PERIODIC = { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' };

function near(actual, expected, limit) {
  assert.ok(Math.abs(actual - expected) <= limit, `${actual} != ${expected} within ${limit}`);
}

function bedOf(columns) {
  return bedSurface(
    { columns, rows: 1, width: columns, depth: 1, centre: [0, 0] },
    new Float64Array(2 * (columns + 1)),
  );
}

function bodyOf(physics, { x = 0, y = 0.375, velocity = [0, 0, 0], mass = 20 } = {}) {
  return physics.addBody(null, {
    position: [x, y, 0],
    colliders: { shape: 'sphere', radius: 0.25, mass },
    linearVelocity: velocity,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 0,
    canSleep: false,
  });
}

function makeWorld(coupling, physics, params, gravity = CELL, rate = RATE) {
  const { water, request, relay, order } = coupling;
  return new PhysicsWorld({ rate, gravity })
    .add(new RigidSolver(), { physics })
    .add(request, {})
    .add(water, params)
    .add(relay, {})
    .couple(order, 'staggered');
}

function portWords(world, field, tick) {
  const port = world.fields.port(field.name);
  assert.equal(port.tick, tick);
  return regionWords(world.memory, port.region);
}

function receipt(world, coupling, body, tick) {
  const all = portWords(world, coupling.fields.receipt, tick);
  return all.subarray(body.row * IMPULSE_WORDS, (body.row + 1) * IMPULSE_WORDS);
}

test('post-water drag matches the closed quadratic impulse and eccentric moment', async () => {
  await Physics.load();
  using physics = new Physics(null, { fixedTimestep: DT, gravity: CELL });
  const body = bodyOf(physics, { x: 0.25 });
  const speed = 1.25;
  const depth = 0.75;
  const centre = [0, 0.125, 0];
  const area = 0.2;
  const dragCoefficient = 0.8;
  const coupling = await ShallowWaterSolver.withProjectedBodyDrag([
    { row: body.row, centre, halfHeight: 0.1, area, dragCoefficient },
  ]);
  const world = makeWorld(coupling, physics, {
    bed: bedOf(1),
    depth,
    velocity: () => [speed, 0],
    density: DENSITY,
    roughness: 0,
    sides: PERIODIC,
  });
  world.advance(1);
  const fluidMass = DENSITY * depth;
  const spinInertia = (2 * 20 * 0.25 ** 2) / 5;
  const mobility = 1 / fluidMass + Math.fround(1 / 20) + centre[1] ** 2 / spinInertia;
  const gain = 0.5 * DENSITY * dragCoefficient * area * DT;
  const finalSlip = (2 * speed) / (1 + Math.sqrt(1 + 4 * mobility * gain * speed));
  const impulse = gain * finalSlip ** 2;
  const expectedTorque = -centre[1] * impulse;
  const [jx, jy, jz, tx, ty, tz] = receipt(world, coupling, body, 0);
  near(jx, impulse, 256 * Number.EPSILON * fluidMass);
  near(tz, expectedTorque, 256 * Number.EPSILON * fluidMass);
  assert.deepEqual([jy, jz, tx, ty], [0, 0, 0, 0]);
  const sample = coupling.water.sample(0, 0);
  assert.equal(sample.depth, depth);
  near(fluidMass * (speed - sample.velocity[0]), jx, 256 * Number.EPSILON * fluidMass);
  near(20 * body.linearVelocity[0], jx, 16 * 2 ** -24 * jx);
  near(spinInertia * body.angularVelocity[2], tz, 16 * 2 ** -24 * Math.abs(tz));
  const initialEnergy = 0.5 * fluidMass * speed ** 2;
  const finalEnergy = 0.5 * fluidMass * sample.velocity[0] ** 2 + body.kineticEnergy;
  const energyRoundoff = 64 * 2 ** -24 * body.kineticEnergy + 256 * Number.EPSILON * initialEnergy;
  near(initialEnergy - finalEnergy, impulse * (speed - 0.5 * mobility * impulse), energyRoundoff);
});

test('post-water drag uses the f64 wet state when the published f32 rounds below the threshold', async () => {
  await Physics.load();
  using physics = new Physics(null, { fixedTimestep: DT, gravity: CELL });
  const body = bodyOf(physics, { y: 0.5 * DRY, velocity: [0.75, 0, 0] });
  const depth = DRY + 2e-15;
  assert.ok(Math.fround(depth) <= DRY);
  const coupling = await ShallowWaterSolver.withProjectedBodyDrag([
    { row: body.row, halfHeight: DRY, area: 0.1, dragCoefficient: 1 },
  ]);
  const world = makeWorld(coupling, physics, { bed: bedOf(1), depth, roughness: 0, sides: PERIODIC });
  world.advance(1);
  const sample = coupling.water.sample(0, 0);
  const [jx] = receipt(world, coupling, body, 0);
  assert.equal(sample.depth, depth);
  assert.ok(jx < 0);
  near(sample.depth * sample.velocity[0] * DENSITY, -jx, 16 * Number.EPSILON * Math.abs(jx));
});

test('post-water drag rejects an active request when a prescribed drain crosses the wet threshold', async () => {
  await Physics.load();
  using physics = new Physics(null, { fixedTimestep: DT, gravity: CELL });
  const body = bodyOf(physics, { y: 0.5 * DRY, velocity: [0.75, 0, 0] });
  const depth = 1.125 * DRY;
  const outflow = (0.25 * DRY) / DT;
  const coupling = await ShallowWaterSolver.withProjectedBodyDrag([
    { row: body.row, halfHeight: DRY, area: 0.1, dragCoefficient: 1 },
  ]);
  const world = makeWorld(coupling, physics, {
    bed: bedOf(1),
    depth,
    roughness: 0,
    sides: PERIODIC,
    inflows: [{ position: [0, 0], discharge: -outflow }],
  });
  assert.equal(coupling.water.sample(0, 0).depth, depth);
  world.advance(1);
  const request = portWords(world, coupling.fields.request, 0);
  assert.equal(request.length, BODY_WORDS);
  assert.equal(request[10], 0.75);
  assert.equal(request[23], 1, 'the configured dynamic body submitted a request');
  near(coupling.water.sample(0, 0).depth, depth - DT * outflow, 8 * Number.EPSILON * depth);
  assert.ok(coupling.water.sample(0, 0).depth <= DRY);
  assert.deepEqual([...receipt(world, coupling, body, 0)], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(body.linearVelocity, [0.75, 0, 0]);
});

test('pressure flux wets one dry cell before drag settles, with the finite-volume control and replay', async () => {
  await Physics.load();
  const gravity = [0, -9.81, 0];
  using physics = new Physics(null, { fixedTimestep: DT, gravity });
  const wetting = bodyOf(physics, { x: -1, y: 0.00025, velocity: [-0.375, 0, 0] });
  const dry = bodyOf(physics, { x: 2, y: 0.00025, velocity: [-0.375, 0, 0] });
  const profiles = [dry, wetting].map(({ row }) => ({ row, halfHeight: 0.001, area: 0.015, dragCoefficient: 0.9 }));
  const coupling = await ShallowWaterSolver.withProjectedBodyDrag(profiles);
  const params = { bed: bedOf(5), depth: (x) => (x < -1.5 ? 0.125 : 0), roughness: 0 };
  const world = makeWorld(coupling, physics, params, gravity);
  const control = new ShallowWaterSolver();
  const baseline = new PhysicsWorld({ rate: RATE, gravity }).add(control, params);
  assert.equal(coupling.water.sample(-1, 0).depth, 0);
  assert.equal(coupling.water.sample(2, 0).depth, 0);
  baseline.advance(1);
  world.advance(1);
  assert.ok(control.sample(-1, 0).depth > DRY);
  assert.ok(control.sample(-1, 0).velocity[0] > 0, 'transport carries momentum into the formerly dry cell');
  assert.equal(control.sample(2, 0).depth, 0);
  let momentumChange = 0;
  for (const x of [-2, -1, 0, 1, 2]) {
    const a = control.sample(x, 0);
    const b = coupling.water.sample(x, 0);
    assert.equal(a.depth, b.depth);
    momentumChange += DENSITY * b.depth * (b.velocity[0] - a.velocity[0]);
    if (x !== -1) assert.deepEqual(b, a, 'the post-flux impulse leaves other cells and their flux result untouched');
  }
  const [wetImpulse] = receipt(world, coupling, wetting, 0);
  assert.ok(wetImpulse > 0);
  near(momentumChange, -wetImpulse, 128 * Number.EPSILON * DENSITY * control.volume());
  near(20 * (wetting.linearVelocity[0] + 0.375), wetImpulse, 32 * 2 ** -24 * 20);
  assert.deepEqual([...receipt(world, coupling, dry, 0)], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(dry.linearVelocity, [-0.375, 0, 0]);
  assert.equal(control.volume(), coupling.water.volume());
  const wettingSnapshot = world.takeSnapshot();
  world.advance(3);
  const hash = world.hash();
  world.restoreSnapshot(wettingSnapshot.bytes);
  world.advance(3);
  assert.equal(world.hash(), hash);
});

test('the accepted-drag route reproduces capped seek', async () => {
  await Physics.load();
  using first = new Physics(null, { fixedTimestep: DT, gravity: CELL });
  using second = new Physics(null, { fixedTimestep: DT, gravity: CELL });
  const fixtures = [];
  for (const physics of [first, second]) {
    const body = bodyOf(physics, { velocity: [0.25, 0, 0] });
    const coupling = await ShallowWaterSolver.withProjectedBodyDrag([
      { row: body.row, halfHeight: 0.1, area: 0.2, dragCoefficient: 0.8 },
    ]);
    const params = { bed: bedOf(1), depth: 0.75, velocity: () => [1.25, 0], roughness: 0, sides: PERIODIC };
    fixtures.push(makeWorld(coupling, physics, params, CELL, { num: 24, den: 1 }));
  }
  seekEqualsContinuous(() => fixtures.shift(), { frames: 12, at: 3 });
});

test('overlapping drag stencils settle in rigid row order for either supplied profile order', async () => {
  await Physics.load();
  using first = new Physics(null, { fixedTimestep: DT, gravity: CELL });
  using second = new Physics(null, { fixedTimestep: DT, gravity: CELL });
  const hashes = [];
  for (const [index, physics] of [first, second].entries()) {
    const left = bodyOf(physics, { x: -0.3, velocity: [0.75, 0, 0] });
    const right = bodyOf(physics, { x: 0.3, velocity: [-0.5, 0, 0] });
    const rows = index === 0 ? [left.row, right.row] : [right.row, left.row];
    const coupling = await ShallowWaterSolver.withProjectedBodyDrag(
      rows.map((row) => ({ row, halfHeight: 0.125, area: 0.06, dragCoefficient: 1 })),
    );
    const depth = 0.75;
    const world = makeWorld(coupling, physics, { bed: bedOf(1), depth, roughness: 0, sides: PERIODIC });
    world.advance(1);
    const [leftImpulse] = receipt(world, coupling, left, 0);
    const [rightImpulse] = receipt(world, coupling, right, 0);
    assert.ok(leftImpulse < 0 && rightImpulse > 0);
    const waterImpulse = DENSITY * depth * coupling.water.sample(0, 0).velocity[0];
    near(waterImpulse + leftImpulse + rightImpulse, 0, 16 * Number.EPSILON * Math.abs(waterImpulse));
    hashes.push(world.hash());
  }
  assert.equal(hashes[0], hashes[1]);
});

test('periodic seam drag force and rigid velocity converge from both sides', async () => {
  await Physics.load();
  const depth = 0.75;
  const area = 0.2;
  const dragCoefficient = 1;
  const fluidMass = DENSITY * depth;
  const gain = 0.5 * DENSITY * dragCoefficient * area * DT;
  let previousForce = Infinity;
  for (const distance of [1 / 8, 1 / 64, 1 / 512]) {
    const nearShare = 0.5 + distance;
    const mobility = Math.fround(1 / 20) + (nearShare ** 2 + (1 - nearShare) ** 2) / fluidMass;
    const slip = 2 * distance;
    const finalSlip = (2 * slip) / (1 + Math.sqrt(1 + 4 * mobility * gain * slip));
    const force = (gain * finalSlip ** 2) / DT;
    let largestForce = 0;
    for (const [x, sign] of [
      [-1 + distance, 1],
      [1 - distance, -1],
      [1 + distance, 1],
    ]) {
      using physics = new Physics(null, { fixedTimestep: DT, gravity: CELL });
      const body = bodyOf(physics, { x });
      const coupling = await ShallowWaterSolver.withProjectedBodyDrag([
        { row: body.row, halfHeight: 0.1, area, dragCoefficient },
      ]);
      const world = makeWorld(coupling, physics, {
        bed: bedOf(2),
        depth,
        velocity: (x) => [0, x < 0 ? 1 : -1],
        roughness: 0,
        sides: PERIODIC,
      });
      world.advance(1);
      const [, , jz, , yaw] = receipt(world, coupling, body, 0);
      near(jz / DT, sign * force, (128 * Number.EPSILON * fluidMass) / DT);
      near(body.linearVelocity[2], Math.fround(Math.fround(jz) * Math.fround(1 / 20)), 2 ** -23 * Math.abs(jz / 20));
      near(yaw, 0, 128 * Number.EPSILON * fluidMass);
      const fluidMomentum =
        fluidMass * (coupling.water.sample(-0.5, 0).velocity[1] + coupling.water.sample(0.5, 0).velocity[1]);
      near(fluidMomentum, -jz, 128 * Number.EPSILON * fluidMass);
      largestForce = Math.max(largestForce, Math.abs(jz / DT));
    }
    assert.ok(largestForce < previousForce);
    previousForce = largestForce;
  }
});

test('shoreline yaw uses the wet cell image nearest the body and replays across the seam', async () => {
  await Physics.load();
  for (const side of ['periodic', 'wall', 'open']) {
    using physics = new Physics(null, { fixedTimestep: DT, gravity: CELL });
    const x = 0.875;
    const body = bodyOf(physics, { x, velocity: [1.25, 0, 0] });
    const coupling = await ShallowWaterSolver.withProjectedBodyDrag([
      { row: body.row, halfHeight: 0.125, area: 0.05, dragCoefficient: 1 },
    ]);
    const world = makeWorld(coupling, physics, {
      bed: bedOf(2),
      depth: (x) => (x < 0 ? 0.75 : 0),
      velocity: () => [0, 1],
      roughness: 0,
      sides: { ...PERIODIC, minX: side, maxX: side },
    });
    world.advance(1);
    const [, , jz, , yaw] = receipt(world, coupling, body, 0);
    if (side !== 'periodic') {
      assert.deepEqual([...receipt(world, coupling, body, 0)], [0, 0, 0, 0, 0, 0]);
      continue;
    }
    assert.ok(jz > 0);
    near(yaw, -(1.5 - x) * jz, 16 * Number.EPSILON * Math.abs(yaw));
    near(0.5 * body.angularVelocity[1], yaw, 16 * 2 ** -24 * Math.abs(yaw));
    assert.equal(coupling.water.sample(0.5, 0).depth, 0);
    const snapshot = world.takeSnapshot();
    world.advance(12);
    assert.ok(body.position[0] > 1);
    assert.notEqual(receipt(world, coupling, body, 11)[2], 0);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(12);
    assert.equal(world.hash(), hash);
  }
});
