import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver, SURFACE_WATER_FORCING_FIELD } from '../../dist/hydro.js';
import { Physics } from '../../dist/index.js';
import { FloodBodyDragSolver } from '../../dist/loads.js';
import { BODY_IMPULSES_FIELD, IMPULSE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../../dist/world.js';
import { seekEqualsContinuous } from './harness.js';

const ZERO = [0, 0, 0];
const SIDES = { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' };
const RATE = { num: 60, den: 1 };
const DT = 1 / RATE.num;
const DENSITY = 1000;
const AREA = 2;
const MASS = 32;
const DEPTH = 0.75;
const SPEED = 1.25;
const CENTRE = [0.1875, 0.375, -0.25];
const PROFILE = { centre: [0, 0.25, 0], halfHeight: [0.25, 0.375, 0.5], dragCoefficient: 1.1, projection: 'box' };

function near(actual, expected, limit = 128 * Number.EPSILON * Math.max(1, Math.abs(expected))) {
  assert.ok(Math.abs(actual - expected) <= limit, `${actual} != ${expected} within ${limit}`);
}

function fixture(physics, area, depth = DEPTH, rate = RATE) {
  const body = physics.addBody(null, {
    position: CENTRE,
    rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    colliders: { shape: 'sphere', radius: 0.25, mass: MASS },
    angularDamping: 0,
    linearDamping: 0,
    canSleep: false,
  });
  const bed = bedSurface({ columns: 1, rows: 1, width: 2, depth: 1, centre: [0, 0] }, new Float64Array(4));
  const drag = new FloodBodyDragSolver();
  const water = new ShallowWaterSolver();
  const world = new PhysicsWorld({ rate, gravity: ZERO })
    .add(new RigidSolver(), { physics })
    .add(water, { bed, depth, velocity: () => [SPEED, 0], density: DENSITY, roughness: 0, sides: SIDES })
    .add(drag, { bed, density: DENSITY, bodies: [{ ...PROFILE, area, row: body.row }] })
    .couple([drag.id, 'water', 'rigid'], 'staggered');
  return { body, drag, water, world };
}

function portValues(f, tick) {
  const ports = f.drag.exportPorts(tick);
  const words = (name) => regionWords(f.world.memory, ports.find(({ field }) => name === field).region);
  return {
    body: Array.from(
      words(BODY_IMPULSES_FIELD.name).subarray(f.body.row * IMPULSE_WORDS, (f.body.row + 1) * IMPULSE_WORDS),
    ),
    forcing: Array.from(words(SURFACE_WATER_FORCING_FIELD.name)),
  };
}

test('FloodBodyDragSolver returns eccentric form drag to live water with the matched rigid torque', async () => {
  await Physics.load();
  using physics = new Physics(null, { fixedTimestep: DT, gravity: ZERO });
  const f = fixture(physics, [0.18, 0.7, 0.4]);
  const initialVolume = f.water.volume();
  const fluidMass = initialVolume * DENSITY;
  let previousEnergy = 0.5 * fluidMass * SPEED * SPEED;
  let snapshot;
  const f32 = 2 ** -24;
  const spinInertia = f.body.principalInertia[0];
  for (let tick = 1; tick <= 16; tick++) {
    f.world.advance(tick);
    const { body: impulse, forcing } = portValues(f, tick);
    const [jx, jy, jz, tx, ty, tz] = impulse;
    near(forcing[0] * DENSITY * AREA * DT, -jx);
    near(forcing[1] * DENSITY * AREA * DT, -jz);
    assert.deepEqual(forcing.slice(2), [0, 0, 0]);
    assert.equal(jy, 0);
    if (tick === 1) {
      assert.ok(jx > 0);
      // A 0.625 m profile centre and 0.375 m half-height clip to
      // [0.25, 0.75] m. The one water cell is centred at x=z=0.
      const arm = [-CENTRE[0], 0.5 - CENTRE[1], -CENTRE[2]];
      near(tx, arm[1] * jz);
      near(ty, arm[2] * jx - arm[0] * jz);
      near(tz, -arm[1] * jx);
      assert.ok(Math.abs(ty) > 0 && Math.abs(tz) > 0);
      for (const [axis, value] of [tx, ty, tz].entries())
        near(spinInertia * f.body.angularVelocity[axis], value, 16 * f32 * Math.max(Math.abs(value), 1));
      snapshot = f.world.takeSnapshot();
    }
    const [waterX, waterZ] = f.water.sample(0, 0).velocity;
    const [vx, , vz] = f.body.linearVelocity;
    near(fluidMass * waterX + MASS * vx, fluidMass * SPEED, 2 * tick * f32 * MASS);
    near(fluidMass * waterZ + MASS * vz, 0, 2 * tick * f32 * MASS);
    assert.equal(f.water.volume(), initialVolume);
    const energy = 0.5 * fluidMass * (waterX * waterX + waterZ * waterZ) + f.body.kineticEnergy;
    assert.ok(energy < previousEnergy);
    previousEnergy = energy;
  }
  const hash = f.world.hash();
  f.world.restoreSnapshot(snapshot.bytes);
  f.world.advance(16);
  assert.equal(f.world.hash(), hash);
});

test('principal area follows rigid yaw and the dry grid emits no drag impulse', async () => {
  await Physics.load();
  using axesPhysics = new Physics(null, { gravity: ZERO, fixedTimestep: DT });
  using measuredPhysics = new Physics(null, { gravity: ZERO, fixedTimestep: DT });
  using dryPhysics = new Physics(null, { gravity: ZERO, fixedTimestep: DT });
  const axes = fixture(axesPhysics, [0.18, 0.7, 0.4]);
  const measured = fixture(measuredPhysics, 0.4);
  const dry = fixture(dryPhysics, 0.4, 0);
  for (const f of [axes, measured, dry]) f.world.advance(1);
  const expected = portValues(measured, 1);
  const actual = portValues(axes, 1);
  // The body is turned 90 degrees about Y. Initially the water flows along
  // world X, so its 0.4 m² local-Z face presents the measured frontal area.
  for (const [i, value] of actual.body.entries()) near(value, expected.body[i]);
  for (const [i, value] of actual.forcing.entries()) near(value, expected.forcing[i]);
  assert.deepEqual(portValues(dry, 1), { body: [0, 0, 0, 0, 0, 0], forcing: [0, 0, 0, 0, 0] });
  assert.deepEqual(dry.body.linearVelocity, ZERO);
  assert.equal(dry.water.volume(), 0);
});

test('FloodBodyDragSolver is invariant under capped seek through the framework harness', async () => {
  await Physics.load();
  using first = new Physics(null, { gravity: ZERO, fixedTimestep: DT });
  using second = new Physics(null, { gravity: ZERO, fixedTimestep: DT });
  const solvers = [first, second];
  seekEqualsContinuous(() => fixture(solvers.shift(), [0.18, 0.7, 0.4], DEPTH, { num: 24, den: 1 }).world, {
    frames: 12,
    at: 3,
  });
});
