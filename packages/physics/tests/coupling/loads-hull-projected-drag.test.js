import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { Physics } from '../../dist/index.js';
import { FloodBodyDragSolver, LoadSolver } from '../../dist/loads.js';
import { HullSolver } from '../../dist/seakeeping.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../../dist/world.js';

const DT = 1 / 60;
const DENSITY = 1000;
const SIDE = 2;
const DEPTH = 0.5;
const WATER_MASS = DENSITY * SIDE * SIDE * DEPTH;
const HULL_MASS = 8;
const DEBRIS_MASS = 4;
const HULL_SPEED = 0.75;
const DEBRIS_SPEED = 0.5;
const AREA = 0.04;
const HULL_CD = 0.8;
const DEBRIS_CD = 0.6;
const F32_EPSILON = 2 ** -24;

const hullMesh = {
  vertices: new Float64Array([
    -0.1, -0.1, -0.1, 0.1, -0.1, -0.1, 0.1, 0.1, -0.1, -0.1, 0.1, -0.1, -0.1, -0.1, 0.1, 0.1, -0.1, 0.1, 0.1, 0.1, 0.1,
    -0.1, 0.1, 0.1,
  ]),
  indices: new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ]),
};

function momentum(velocity, mass) {
  return [mass * velocity[0], mass * velocity[2]];
}

function snapshot(water, vessel, debris) {
  // The f64 water state is read through its actual public query; the field port is an f32 mirror.
  const { depth, velocity } = water.sample(0, 0);
  assert.equal(depth, DEPTH);
  assert.equal(water.volume() * DENSITY, WATER_MASS);
  const waterMomentum = velocity.map((value) => WATER_MASS * value);
  const hullMomentum = momentum(vessel.linearVelocity, HULL_MASS);
  const debrisMomentum = momentum(debris.linearVelocity, DEBRIS_MASS);
  const total = waterMomentum.map((value, axis) => value + hullMomentum[axis] + debrisMomentum[axis]);
  return { water: waterMomentum, hull: hullMomentum, debris: debrisMomentum, total };
}

async function run({ useHull = true, useDebris = true, shared = false } = {}) {
  await Physics.load({ threads: shared });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) });
  using physics = new Physics(null, { fixedTimestep: DT, arena: world.arena });
  const body = (position, velocity, mass) =>
    physics.addBody(null, {
      position,
      linearVelocity: velocity,
      enabledTranslations: [true, false, true],
      lockRotations: true,
      colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], mass },
    });
  // Each isolated control starts on a radial heading through the cell centre.
  // Its drag line then passes through the body's centre of mass.
  const vessel = body([-0.68, -0.2, 0], [HULL_SPEED, 0, 0], HULL_MASS);
  const debris = body([0, -0.2, 0.36], [0, 0, DEBRIS_SPEED], DEBRIS_MASS);
  const bed = bedSurface(
    { columns: 1, rows: 1, width: SIDE, depth: SIDE, centre: [0, 0] },
    new Float64Array(4).fill(-DEPTH),
  );
  const water = new ShallowWaterSolver();
  world.add(water, {
    bed,
    depth: DEPTH,
    density: DENSITY,
    roughness: 0,
    sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
  });
  const sea = { elevation: (x, z) => water.sample(x, z).surface, water: water.flow, density: DENSITY, cell: [0, 0, 0] };
  world.add(new RigidSolver(), { physics });
  world.add(new HullSolver(), {
    hulls: [{ row: vessel.row, mesh: hullMesh }],
    sea,
    addedMass: false,
    radiation: false,
    drag: false,
    drift: false,
    diffraction: false,
    rollDamping: false,
    greenWater: false,
    slamming: false,
  });
  world.add(new LoadSolver(), {
    sea,
    bodies: [{ row: debris.row, shape: { box: [0.1, 0.1, 0.1] }, drag: 0, addedMass: [0, 0, 0] }],
  });
  const profiles = [
    ...(useHull ? [{ row: vessel.row, halfHeight: 0.1, area: AREA, dragCoefficient: HULL_CD }] : []),
    ...(useDebris ? [{ row: debris.row, halfHeight: 0.1, area: AREA, dragCoefficient: DEBRIS_CD }] : []),
  ];
  const drag = new FloodBodyDragSolver();
  if (profiles.length) world.add(drag, { bed, density: DENSITY, bodies: profiles });
  // Each body delegates the only horizontal drag to the same public depth-averaged receiver.
  world.couple([...(profiles.length ? [drag.id] : []), 'water', 'hull', 'loads', 'rigid'], 'staggered');

  const initial = snapshot(water, vessel, debris);
  let previous = initial,
    maxStepResidual = 0,
    maxDrift = 0;
  const stepTo = (frame) => {
    world.advance(frame);
    const current = snapshot(water, vessel, debris);
    for (let axis = 0; axis < 2; axis++) {
      maxStepResidual = Math.max(maxStepResidual, Math.abs(current.total[axis] - previous.total[axis]));
      maxDrift = Math.max(maxDrift, Math.abs(current.total[axis] - initial.total[axis]));
    }
    previous = current;
    return current;
  };
  const first = stepTo(1);
  for (let frame = 2; frame <= 19; frame++) stepTo(frame);
  const saved = world.takeSnapshot();
  for (let frame = 20; frame <= 48; frame++) stepTo(frame);
  const hash = world.hash();
  const end = previous;
  world.restoreSnapshot(saved.bytes);
  world.advance(48);
  assert.equal(world.hash(), hash, 'the reciprocal rigid and water state survives restore');
  return { first, end, hash, maxStepResidual, maxDrift };
}

test('SEA-08 hull and SEA-12 compact body exchange horizontal impulse through public flood drag', async (context) => {
  const coupled = await run();
  const shared = await run({ shared: true });
  const hullOnly = await run({ useDebris: false });
  const debrisOnly = await run({ useHull: false });
  const uncoupled = await run({ useHull: false, useDebris: false });
  assert.deepEqual(coupled, shared);
  // Symmetric pressure panels sum at f64 round-off even with horizontal drag off.
  const zeroBound = 128 * Number.EPSILON * (HULL_MASS * HULL_SPEED + DEBRIS_MASS * DEBRIS_SPEED);
  const closeToZero = (...values) =>
    assert.ok(
      values.every((value) => Math.abs(value) < zeroBound),
      JSON.stringify(values),
    );
  assert.equal(uncoupled.end.hull[0], HULL_MASS * HULL_SPEED);
  assert.equal(uncoupled.end.debris[1], DEBRIS_MASS * DEBRIS_SPEED);
  closeToZero(uncoupled.end.hull[1], uncoupled.end.debris[0]);
  assert.deepEqual(uncoupled.end.water, [0, 0]);

  // For one body in the periodic wet cell, J=μ(U0−U1) and U1+c U1²=U0. Derive the
  // implicit impulse from the two measured masses and the supplied projected drag area.
  const closedForm = (mass, speed, coefficient) => {
    const reducedMass = 1 / (1 / mass + 1 / WATER_MASS);
    const c = (0.5 * DENSITY * coefficient * AREA * DT) / reducedMass;
    const endSlip = (Math.sqrt(1 + 4 * c * speed) - 1) / (2 * c);
    return reducedMass * (speed - endSlip);
  };
  const hullImpulse = closedForm(HULL_MASS, HULL_SPEED, HULL_CD);
  const debrisImpulse = closedForm(DEBRIS_MASS, DEBRIS_SPEED, DEBRIS_CD);
  assert.ok(Math.abs(hullOnly.first.water[0] - hullImpulse) < 1e-12);
  assert.ok(Math.abs(debrisOnly.first.water[1] - debrisImpulse) < 1e-12);
  assert.ok(Math.abs(hullOnly.first.hull[0] - HULL_MASS * HULL_SPEED + hullImpulse) < HULL_MASS * F32_EPSILON);
  assert.ok(
    Math.abs(debrisOnly.first.debris[1] - DEBRIS_MASS * DEBRIS_SPEED + debrisImpulse) < DEBRIS_MASS * F32_EPSILON,
  );

  closeToZero(debrisOnly.end.water[0], debrisOnly.end.debris[0]);
  assert.ok(
    coupled.end.water[0] > 0.1 && coupled.end.debris[0] > 1e-4,
    'the hull changes the debris through the water x momentum',
  );
  closeToZero(hullOnly.end.water[1], hullOnly.end.hull[1]);
  assert.ok(
    coupled.end.water[1] > 0.1 && coupled.end.hull[1] > 1e-4,
    'the debris changes the hull through the water z momentum',
  );
  // Saint-Venant momentum is ρ h u times cell area (Kurganov and Petrova 2007, Eq. 1.1).
  // Only rigid velocity is rounded to f32. Track every receipt and the whole run independently.
  const perStepBound = 4 * F32_EPSILON * (HULL_MASS + DEBRIS_MASS);
  for (const result of [coupled, hullOnly, debrisOnly]) {
    assert.ok(result.maxStepResidual < perStepBound);
    assert.ok(result.maxDrift < 48 * perStepBound);
  }
  context.diagnostic(JSON.stringify(coupled));
});
