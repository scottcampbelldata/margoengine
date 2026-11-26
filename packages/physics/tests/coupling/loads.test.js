// The load solver's coupling checks (SEA-12): `LoadSolver` holding a floating crate, a sinking ball and a hose segment with
// a vortex-shedding member in a current with waves, held to the harness: the same state at 24, 30 and 60 frames a second, and
// a seek equal to a continuous run.
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { LoadSolver } from '../../dist/loads.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

const k = (2 * Math.PI) / 20,
  w = Math.sqrt(9.81 * k),
  sea = {
    cell: [0, 0, 0],
    density: 1025,
    elevation: (x, _z, t) => 0.3 * Math.cos(k * x - w * t),
    water: {
      medium: 'water',
      cell: [0, 0, 0],
      sample: (x, y, _z, t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
        const e = Math.exp(k * Math.min(y, 0));
        out.velocity[0] = 0.5 + 0.3 * w * e * Math.cos(k * x - w * t);
        out.velocity[1] = 0.3 * w * e * Math.sin(k * x - w * t);
        out.velocity[2] = 0;
        out.density = 1025;
        out.temperature = 288;
        return out;
      },
    },
  };

const make = (rate = { num: 24, den: 1 }) => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    crate = physics.addBody(null, {
      position: [0, 0, 0],
      colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 600 },
    }),
    ball = physics.addBody(null, { position: [5, -3, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 20 } }),
    hose = physics.addBody(null, {
      position: [-5, -2, 0],
      colliders: { shape: 'box', halfExtents: [0.05, 1, 0.05], mass: 4 },
    });
  return new PhysicsWorld({ rate })
    .add(new RigidSolver(), { physics })
    .add(new LoadSolver(), {
      sea,
      bodies: [
        { row: crate.row, shape: { box: [1, 0.5, 0.5] } },
        { row: ball.row, shape: { sphere: 0.1 } },
      ],
      members: [
        { row: hose.row, from: [0, -1, 0], to: [0, 1, 0], diameter: 0.1, vortex: {} },
        { from: [3, -6, 0], to: [3, 0, 0], diameter: 0.5, vortex: {} },
      ],
    })
    .couple(['loads', 'rigid'], 'staggered');
};

test('LoadSolver: the same state at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('LoadSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
