// The foam's coupling checks (SEA-13): `FoamSolver` held to the harness, the same breakers, wake and windrows at 24, 30 and 60
// frames a second, and a seek equal to a continuous run.
import test from 'node:test';
import { FoamSolver } from '../../dist/foam.js';
import { jonswap } from '../../dist/waves.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const frequencies = new Float64Array(24).map((_, i) => 0.06 * 1.12 ** i),
  directions = new Float64Array(16).map((_, j) => (2 * Math.PI * j) / 16),
  spectrum = jonswap(
    { height: 2.5, period: 7, direction: 0 },
    { frequencies, directions, energy: new Float64Array(24 * 16), depth: Infinity, density: 1025 },
  ),
  waves = {
    cell: [0, 0, 0],
    sample(_x, _z, out) {
      const s = out ?? { ...spectrum, energy: new Float64Array(spectrum.energy.length) };
      s.energy.set(spectrum.energy);
      return s;
    },
  },
  wind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample(_x, _y, _z, t, out = { velocity: [0, 0, 0], density: 1.225, temperature: 288 }) {
      out.velocity[0] = 11 + Math.sin(t / 7);
      out.velocity[1] = 0;
      out.velocity[2] = 2;
      return out;
    },
  };

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate }).add(new FoamSolver(), {
    waves,
    wind,
    cells: [24, 24],
    cellSize: 2,
    statistics: 24,
    ships: [{ track: (t) => ({ position: [-20 + 3 * t, 1], velocity: [3, 0] }), length: 12, beam: 4 }],
  });

test('FoamSolver: the same foam at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('FoamSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
