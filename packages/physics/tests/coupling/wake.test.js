// The wake's coupling checks (SEA-04): `WakeSolver` held to the harness. A pressure patch moving through it leaves the
// same wake at 24, 30 and 60 frames a second, and a seek equals a continuous run; a hull's pressure reaches the wake
// and the wake reaches the sea a hull floats on (`SpectralSea` with the wake as a patch).
import test from 'node:test';
import { SpectralSea, WakeSolver } from '../../dist/sea.js';
import { PhysicsWorld } from '../../dist/world.js';
import { effectBothWays, frameRateIndependent, seekEqualsContinuous } from './harness.js';

const calm = {
  frequencies: Float64Array.from([0.1, 0.2]),
  directions: Float64Array.from([0, Math.PI]),
  energy: new Float64Array(4),
  depth: Infinity,
  density: 1025,
};
const make = (rate = { num: 24, den: 1 }, pressure = 1025 * 9.81 * 0.2, bump = 0) => {
  const wake = new WakeSolver(),
    world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] }).add(wake, {
      cells: [64, 32],
      cellSize: 1,
      sponge: 6,
      sources: (t) => [{ x: -20 + 4 * t, z: 0, radius: 4, pressure, volume: 0 }],
      initial: (x, z) => [bump * Math.exp(-((x + 14) ** 2 + z * z) / 8), 0],
    });
  world.probe = wake;
  return world;
};

test('WakeSolver: the same wake at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('WakeSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test("WakeSolver: a hull's pressure reaches the wake, and the wake reaches the sea a hull floats on", () => {
  // Side 0 pushes the water from the hull (a heavier hull); side 1 pushes the wake (a bump in it), which the sea the hull
  // reads (SpectralSea with the wake as a patch) must carry.
  effectBothWays(
    (side) => make({ num: 24, den: 1 }, side === 0 ? 1025 * 9.81 * 0.5 : 1025 * 9.81 * 0.2, side === 1 ? 0.3 : 0),
    (world, side) =>
      side === 0
        ? world.probe.sample(-14, 0).height
        : new SpectralSea({ waves: calm, patches: [world.probe] }).elevation(-14, 0, 0),
  );
});
