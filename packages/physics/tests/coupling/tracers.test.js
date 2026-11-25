// The tracers' coupling checks (SEA-15): `TracerSolver` held to the harness, the same plume at 24, 30 and 60 frames a second
// and a seek equal to a continuous run, with a breach leaking ore and a slick drifting in a current.
import test from 'node:test';
import { TracerSolver } from '../../dist/tracers.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const water = {
  medium: 'water',
  cell: [0, 0, 0],
  sample(_x, y, _z, t, out = { velocity: [0, 0, 0], density: 1025, temperature: 285 }) {
    out.velocity[0] = 0.3 + 0.1 * Math.sin(t);
    out.velocity[1] = 0;
    out.velocity[2] = 0.05 * y;
    return out;
  },
};

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate }).add(new TracerSolver(), {
    water,
    capacity: 2000,
    sources: [
      { material: 'ironOre', position: (t) => [2 * t, -4, 0], rate: 30 },
      { material: 'oil', position: [0, 0, 3], rate: 20, stop: 0.5 },
    ],
  });

test('TracerSolver: the same plume at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('TracerSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
