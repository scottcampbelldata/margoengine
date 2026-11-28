import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Physics } from '@margoengine/physics';
import { TerrainBed } from '@margoengine/physics/earth';
import {
  LEGGED_CONTACT_FIELD,
  LEGGED_GAIT_FIELD,
  LEGGED_INTENT_FIELD,
  LEGGED_LAYOUT,
  LEGGED_LOAD_FIELD,
  LeggedLocomotion,
} from '@margoengine/physics/legged';
import { BODIES_FIELD, BODY_IMPULSES_FIELD, PhysicsWorld, RigidSolver, worldMemory } from '@margoengine/physics/world';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const size = { width: 20, depth: 20, rows: 8, columns: 8, centre: [0, 0] };
const rate = { num: 60, den: 1 };
const zero = [0, 0, 0];
const close = (actual, expected, e) => assert.ok(Math.abs(actual - expected) <= e, actual + ' vs ' + expected);

function constantPort(field, values) {
  let region;
  return {
    describe: () => ({ id: field.name, rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] }),
    init(host) {
      region = host.allocate(field.name, values.length * 8, 'f64', LEGGED_LAYOUT);
      new Float64Array(host.memory.buffer, region.byteOffset, values.length).set(values);
    },
    step() {},
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: zero }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

test('live terrain controls foot height and the published biped pose', async () => {
  const solver = await LeggedLocomotion.load({ bedShape: size });
  const world = new PhysicsWorld({ rate })
    .add(new TerrainBed(), { ...size, elevations: (_x, z) => 2 + 0.125 * z })
    .add(solver, { bodies: [{ kind: 'biped', target: { speed: 1.0, heading: 0 } }] });
  world.advance(180);
  const motion = solver.read(0);
  const balancingSpeed = 1 - 0.125 * Math.sqrt(9.80665 * 0.9 * 0.87);
  close(motion.velocity[2], balancingSpeed, 0.1);
  assert.ok(motion.position[2] > 1);
  assert.ok(motion.position[1] > 2 + 0.125 * motion.position[2]);
  for (const index of [0, 1]) {
    const foot = solver.readContact(0, index);
    if (foot.stance) close(foot.position[1], 2 + 0.125 * foot.position[2], 2e-12);
  }
  assert.equal(world.fields.port(LEGGED_GAIT_FIELD.name).region.layout, LEGGED_LAYOUT);
  assert.equal(world.fields.port(LEGGED_CONTACT_FIELD.name).region.byteLength, 3 * 13 * 8);
});

test('the intent field overrides a local command and external force retains SI mass response', async () => {
  const driven = await LeggedLocomotion.load({ readIntent: true });
  const world = new PhysicsWorld({ rate })
    .add(constantPort(LEGGED_INTENT_FIELD, [1.2, Math.PI / 2]), {})
    .add(driven, { bodies: [{ kind: 'biped', target: { speed: 1.2, heading: 0 } }] });
  world.advance(180);
  assert.ok(driven.read(0).position[0] > 2 * Math.abs(driven.read(0).position[2]));
  const solver = await LeggedLocomotion.load({ readLoad: true });
  const mass = 75;
  const force = 150;
  const flight = new PhysicsWorld({ rate, gravity: zero })
    .add(constantPort(LEGGED_LOAD_FIELD, [force, 0, 0]), {})
    .add(solver, { bodies: [{ kind: 'biped', mass, position: [0, 10, 0] }] });
  flight.advance(60);
  close(solver.read(0).velocity[0], force / mass, 2e-12);
  assert.equal(solver.read(0).position[1], 10);
});

test('the TerrainBed clock and dynamically selected phases replay after seeking', async () => {
  const solvers = await Promise.all(Array.from({ length: 5 }, () => LeggedLocomotion.load({ bedShape: size })));
  let makeCount = 0;
  const make = (rate = { num: 24, den: 1 }) =>
    new PhysicsWorld({ rate })
      .add(new TerrainBed(), { ...size, elevations: (x, z) => 0.03 * x + 0.015 * z })
      .add(solvers[makeCount++], {
        bodies: [
          { kind: 'quadruped', target: { speed: 3.2, heading: 0.1 } },
          { kind: 'biped', target: { speed: 1.3, heading: 0 } },
        ],
      });
  frameRateIndependent(make);
  seekEqualsContinuous(make);
});

test('moving rigid support carries a standing body and receives the opposing contact impulse', async () => {
  await Physics.load();
  const world = new PhysicsWorld({ rate, gravity: zero, memory: worldMemory(false) });
  const mass = 400;
  const physics = new Physics(null, { arena: world.arena, gravity: zero, fixedTimestep: 1 / 60 });
  const plate = physics.addBody(null, {
    position: [0, 2, 0],
    linearVelocity: [0.5, 0, 0],
    colliders: { shape: 'box', halfExtents: [4, 0.2, 4], mass },
  });
  using locomotion = await LeggedLocomotion.load({ deck: { body: plate.row, width: 8, depth: 8, top: 0.2 } });
  const cell = [-8, 5, -9];
  const rigid = new RigidSolver();
  world.add(rigid, { physics }, cell);
  world.add(locomotion, { bodies: [{ kind: 'biped', position: [0, 2.95, 0], mass: 75 }], groundHeight: -10 }, cell);
  world.couple(['rigid', 'legged-locomotion'], 'staggered');
  const start = locomotion.readContact(0, 0).position;
  world.advance(15);
  assert.ok(plate.position[1] < 2, 'the compressed legs push the real rigid plate down');
  assert.ok(locomotion.read(0).position[1] > 2.95, 'the plate supports the body above the static floor');
  assert.ok(locomotion.readContact(0, 0).position[0] > start[0], 'the stance anchor has deck velocity');
  const saved = world.takeSnapshot();
  assert.deepEqual(locomotion.exportPorts(0).find((port) => port.field === BODY_IMPULSES_FIELD.name).cell, cell);
  const bodies = rigid.exportPorts(0).find((port) => port.field === BODIES_FIELD.name);
  const bad = { ...bodies, region: { ...bodies.region, byteOffset: 2 } };
  assert.throws(
    () => locomotion.step({ tick: 0, level: 0, seed: 0, cell, inputs: new Map([[BODIES_FIELD.name, bad]]) }, 1 / 60),
    { code: 'state', message: /aligned rigid deck rows.*#legged/ },
  );
  assert.deepEqual(world.takeSnapshot().bytes, saved.bytes);
  world.advance(90);
  const released = locomotion.read(0);
  close(75 * released.velocity[1] + mass * plate.linearVelocity[1], 0, 2e-4);
  const finished = world.hash();
  world.restoreSnapshot(saved.bytes);
  world.advance(90);
  assert.equal(world.hash(), finished);
  physics.dispose();
});

test('late support rejection retains accepted legged controls, phases, contacts and work', async () => {
  let reject = false;
  let reenter;
  const cell = [-20, 3, -4];
  const bed = {
    ...size,
    cell,
    elevations: new Float64Array(size.rows * size.columns),
    sample(x) {
      if (x > 2) reenter?.();
      return { elevation: reject && x > 2 ? NaN : 0, normal: [0, 1, 0] };
    },
  };
  using solver = await LeggedLocomotion.load({ readIntent: true, readLoad: true });
  const world = new PhysicsWorld({ rate })
    .add(constantPort(LEGGED_INTENT_FIELD, [0.8, 0, 1.5, 0]), {})
    .add(constantPort(LEGGED_LOAD_FIELD, [0, 0, 0, 0, 0, 0]), {})
    .add(
      solver,
      {
        bed,
        bodies: [
          { kind: 'biped', position: [0, 0.8, 0], target: { speed: 0.8, heading: 0 } },
          { kind: 'quadruped', position: [4, 0.9, 0], target: { speed: 1.5, heading: 0 } },
        ],
      },
      cell,
    );
  world.advance(15);
  const snapshot = world.takeSnapshot().bytes.slice();
  const receipt = solver.readNativeWork();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const intent = (field, byteOffset, values) => {
    new Float64Array(memory.buffer, byteOffset, values.length).set(values);
    return {
      field: field.name,
      tick: 0,
      cell: [-11, -9, 6],
      region: {
        name: field.name,
        byteOffset,
        byteLength: 8 * values.length,
        layout: LEGGED_LAYOUT,
        type: 'f64',
        memory,
      },
    };
  };
  const controls = intent(LEGGED_INTENT_FIELD, 8, [1.1, 0, 1.5, 0.15]);
  const loads = intent(LEGGED_LOAD_FIELD, 56, [9, 0, 0, 0, 0, 0]);
  const inputs = new Map([
    [controls.field, controls],
    [loads.field, loads],
  ]);
  const context = { tick: 0, level: 0, seed: 0, cell, inputs };
  const dt = 1 / 240;
  reject = true;
  assert.throws(() => solver.step(context, dt), {
    code: 'state',
    message: /finite bed elevations.*#locomotion/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, snapshot);
  assert.deepEqual(solver.readNativeWork(), receipt);
  reject = false;
  reenter = () => solver.setTarget(0, { speed: 3, heading: 1 });
  assert.throws(() => solver.step(context, dt), {
    code: 'state',
    message: /after the current step finishes.*#legged/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, snapshot);
  reenter = undefined;
  controls.region.byteOffset++;
  assert.throws(() => solver.step(context, dt), {
    code: 'state',
    message: /aligned offsets.*#legged/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, snapshot);
  controls.region.byteOffset--;
  solver.step(context, dt);
  const advanced = world.takeSnapshot().bytes.slice();
  assert.notDeepEqual(advanced, snapshot);
  world.restoreSnapshot(snapshot);
  solver.step(context, dt);
  assert.deepEqual(world.takeSnapshot().bytes, advanced);
  world.shiftOrigin([1, -3, 9]);
  for (const port of solver.exportPorts(0)) assert.deepEqual(port.cell, [-21, 6, -13]);
});
