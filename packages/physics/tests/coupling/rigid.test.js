// The rigid solver's coupling checks (docs/physics-framework.md, section 10): `RigidSolver` with a solver that pushes a body
// through `bodyImpulses`, held to the harness: the same state at 24, 30 and 60 frames a second, a seek equal to a
// continuous run, and the push reaching the body it names.
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { BODY_IMPULSES_FIELD, IMPULSE_WORDS, PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { effectBothWays, frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

/** A solver that pushes body row `row` sideways by `impulse` N s each of its steps (none for a negative row). */
function pusher(row, impulse) {
  let region, host;
  return {
    describe: () => ({
      id: 'pusher',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: BODY_IMPULSES_FIELD, access: 'accumulate' }],
    }),
    init(h) {
      host = h;
      region = h.allocate('push', 4 * IMPULSE_WORDS * 8, 'f64', 1);
    },
    step() {
      const words = new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / 8);
      words.fill(0);
      if (row >= 0) words[row * IMPULSE_WORDS] = impulse;
    },
    exportPorts: (tick) => [{ field: 'bodyImpulses', region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

/** A floor and two boxes, a pusher on box `which` (1 or 2; none for -1), at `rate` frames a second. */
function make(rate = { num: 24, den: 1 }, which = 1) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 });
  const bodies = [
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
    }),
    physics.addBody(null, { position: [0, 1, 0], colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3] } }),
    physics.addBody(null, {
      position: [2, 2, 0],
      angularVelocity: [0, 1, 2],
      colliders: { shape: 'box', halfExtents: [0.2, 0.4, 0.2] },
    }),
  ];
  const world = new PhysicsWorld({ rate })
    .add(new RigidSolver(), { physics })
    .add(pusher(which < 0 ? -1 : bodies[which].row, 0.05), {});
  return Object.assign(world, { bodies });
}

test('RigidSolver: the same state at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('RigidSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test('RigidSolver: a push through bodyImpulses reaches the body it names', () => {
  // Side 0 pushes box row 1, side 1 box row 2; the response is that box's x position against an unpushed world.
  effectBothWays(
    (side) => make({ num: 24, den: 1 }, side < 0 ? -1 : side + 1),
    (world, side) => world.bodies[side + 1].position[0],
  );
});
