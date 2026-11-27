import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver, SURFACE_WATER_FIELD } from '../../dist/hydro.js';
import { Physics } from '../../dist/index.js';
import { SWIM_PASSIVE_REACTION_FIELD, SWIM_WAKE_FIELD, SWIM_WAKE_LAYOUT, SwimSolver } from '../../dist/life.js';
import { FloodBodyDragSolver, LoadSolver, SwimDragToWater } from '../../dist/loads.js';
import {
  BODY_IMPULSES_FIELD,
  IMPULSE_WORDS,
  PhysicsWorld,
  RigidSolver,
  regionWords,
  worldMemory,
} from '../../dist/world.js';

const RATE = { num: 60, den: 1 };
const DT = 1 / RATE.num;
const RHO = 1000;
const SIDE = 2;
const DEPTH = 0.5;
const WATER_MASS = RHO * SIDE * SIDE * DEPTH;
const SWIM_MASS = 8;
const PROBE_MASS = 6;
const SWIM_START = 0.15;
const PROBE_START = 0.5;
const FINAL_FRAME = 40;

function waterMomentum(water) {
  const point = water.sample(0, 0);
  assert.equal(point.depth, DEPTH);
  assert.equal(water.volume() * RHO, WATER_MASS);
  return WATER_MASS * point.velocity[1];
}

async function run({ actuatorReturn = true, probeReturn = true, shared = false, originShift = false } = {}) {
  await Physics.load({ threads: shared });
  const world = new PhysicsWorld({ rate: RATE, memory: worldMemory(shared) });
  const bed = bedSurface(
    { columns: 1, rows: 1, width: SIDE, depth: SIDE, centre: [0, 0] },
    new Float64Array(4).fill(-DEPTH),
  );
  const water = new ShallowWaterSolver();
  const flow = water.flow;
  world.add(water, {
    bed,
    depth: DEPTH,
    density: RHO,
    roughness: 0,
    sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
  });
  const sea = {
    water: flow,
    density: RHO,
    elevation: (x, z) => water.sample(x, z).surface,
  };
  using physics = new Physics(null, { fixedTimestep: DT, arena: world.arena });
  const probe = physics.addBody(null, {
    position: [0, -0.25, 0.25],
    linearVelocity: [0, 0, PROBE_START],
    enabledTranslations: [false, false, true],
    lockRotations: true,
    colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], mass: PROBE_MASS },
  });
  const swimmer = await SwimSolver.load();
  const actuator = SwimDragToWater.actuators();
  const bodyDrag = new FloodBodyDragSolver();
  world.add(new RigidSolver(), { physics });
  world.add(new LoadSolver(), {
    sea,
    bodies: [{ row: probe.row, shape: { box: [0.1, 0.1, 0.1] }, drag: 0, addedMass: [0, 0, 0] }],
  });
  world.add(swimmer, {
    flow: sea.water,
    bodies: [
      {
        position: [-0.5, -0.25, -0.3],
        velocity: [0, 0, SWIM_START],
        mass: SWIM_MASS,
        volume: SWIM_MASS / RHO,
        length: 0.5,
        width: 0.12,
        height: 0.12,
        tail: { amplitude: 0.13, span: 0.22, wavelength: 0.75 },
        frequency: 1.6,
        wettedArea: 0,
        formDragArea: 0,
        crossflowDrag: [0, 0],
        axialAddedMassRatio: 0,
        steering: [0, 0, 1],
        fins: { area: 0.018, strokeFrequency: 1.2, strokeAmplitude: 0.1, liftCoefficient: 0 },
      },
    ],
  });
  world.add(bodyDrag, {
    bed,
    density: RHO,
    bodies: [{ row: probe.row, halfHeight: 0.1, area: 0.04, dragCoefficient: probeReturn ? 1 : 0 }],
  });
  if (actuatorReturn) world.add(actuator, { bed, density: RHO });
  world.couple(['swim', 'loads', bodyDrag.id, ...(actuatorReturn ? [actuator.id] : []), 'water', 'rigid'], 'staggered');

  let tailImpulse = 0,
    finImpulse = 0,
    stepError = 0;
  const final = () => ({
    swimmer: swimmer.read(0).velocity[2] * SWIM_MASS,
    probe: probe.linearVelocity[2] * PROBE_MASS,
    water: waterMomentum(water),
  });
  const advance = (frame) => {
    const before = final();
    world.advance(frame);
    const after = final();
    const wake = swimmer.exportPorts(frame - 1).find((port) => port.field === SWIM_WAKE_FIELD.name);
    assert.equal(wake.region.layout, SWIM_WAKE_LAYOUT);
    const rows = regionWords(world.memory, wake.region);
    assert.equal(rows.length, 16);
    assert.equal(rows[7], 1);
    assert.equal(rows[15], 1);
    assert.ok(rows[3] === 0 && rows[4] === 0 && rows[11] === 0 && rows[12] === 0);
    assert.ok(Math.abs(rows[5] + rows[13] + after.swimmer - before.swimmer) < 32 * Number.EPSILON * SWIM_MASS);
    tailImpulse += rows[5];
    finImpulse += rows[13];
    const rigid = bodyDrag.exportPorts(frame - 1).find((port) => port.field === BODY_IMPULSES_FIELD.name);
    const rigidImpulse = regionWords(world.memory, rigid.region)[IMPULSE_WORDS * probe.row + 2];
    const activeImpulse = actuatorReturn ? rows[5] + rows[13] : 0;
    stepError = Math.max(stepError, Math.abs(after.water - before.water + rigidImpulse - activeImpulse));
  };
  for (let frame = 1; frame <= 16; frame++) advance(frame);
  const snapshot = world.takeSnapshot();
  if (originShift) {
    assert.deepEqual(flow.cell, [0, 0, 0]);
    world.shiftOrigin([1, 0, 0]);
    const waterField = world.fields.field(SURFACE_WATER_FIELD.name);
    assert.equal(waterField.current.port.tick, 15);
    assert.equal(waterField.previous.port.tick, 14);
    assert.deepEqual(waterField.current.port.cell, [-1, 0, 0]);
    assert.deepEqual(waterField.previous.port.cell, [-1, 0, 0]);
    assert.deepEqual(flow.cell, [-1, 0, 0], 'a retained flow sees the new origin before Hydro steps');
  }
  for (let frame = 17; frame <= FINAL_FRAME; frame++) advance(frame);
  const hash = world.hash();
  const sample = final();
  world.restoreSnapshot(snapshot.bytes);
  if (originShift) {
    assert.deepEqual(flow.cell, [0, 0, 0], 'the retained flow follows snapshot restore before a step');
    world.shiftOrigin([1, 0, 0]);
  }
  world.advance(FINAL_FRAME);
  assert.equal(world.hash(), hash);
  return { ...sample, stepError, tailImpulse, finImpulse, hash };
}

test('SEA-12 production receivers exchange the swimmer tail and fin impulses through live HYDRO', async (context) => {
  const both = await run();
  const shared = await run({ shared: true });
  const moved = await run({ originShift: true });
  const noActuator = await run({ actuatorReturn: false });
  const noProbe = await run({ probeReturn: false });
  assert.deepEqual(shared, both);
  assert.notEqual(moved.hash, both.hash, 'the snapshots record different cells');
  assert.deepEqual({ ...moved, hash: both.hash }, both, 'both frames give the same forces and water momentum');
  const initial = SWIM_MASS * SWIM_START + PROBE_MASS * PROBE_START;
  const end = both.swimmer + both.probe + both.water;
  assert.ok(Math.abs(end - initial) < 128 * 2 ** -24 * PROBE_MASS);
  assert.ok(both.tailImpulse < -1 && both.finImpulse < -0.1);
  assert.ok(both.stepError < 1024 * Number.EPSILON);
  assert.ok(both.probe < noActuator.probe - 1e-4, 'the deposited tail/fin impulses retard the rigid load');
  assert.ok(both.swimmer > noProbe.swimmer + 1e-5, 'the rigid water return changes the swimmer thrust');
  context.diagnostic(JSON.stringify({ ...both, initial, end }));
});

test('the default drag constructor and actuator factory accept only their own impulse fields', () => {
  assert.equal(new SwimDragToWater().describe().fields[0].field, SWIM_PASSIVE_REACTION_FIELD);
  assert.equal(SwimDragToWater.actuators().describe().fields[0].field, SWIM_WAKE_FIELD);
  assert.throws(() => new SwimDragToWater('passive', SWIM_WAKE_FIELD), /passive linear drag field/);
  assert.throws(() => SwimDragToWater.actuators('active', SWIM_PASSIVE_REACTION_FIELD), /actuator wake field/);
});
