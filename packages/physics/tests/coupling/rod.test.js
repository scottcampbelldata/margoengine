// The rod's coupling checks (docs/physics-framework.md, section 10). A `Rod` is a multibody of the rigid world, stepped by
// `RigidSolver` with the Physics it hangs in; its water loads keep wake oscillators of their own, outside the kernel, which
// the solver carries as state (`Physics.statefulAttachments`). A riser in a current that sheds vortices, so the oscillators
// matter: the same shot at 24, 30 and 60 frames a second, and a seek that equals the continuous run, bit for bit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { segmentLoads } from '../../dist/loads.js';
import { Rod } from '../../dist/rod.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

/** Still water with a sheared current along x, 1 kg/L. */
const sea = {
  density: 1000,
  elevation: () => 0,
  water: {
    medium: 'water',
    cell: { x: 0, y: 0, z: 0 },
    sample(_x, y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
      out.velocity[0] = 0.4 + 0.1 * y;
      out.velocity[1] = out.velocity[2] = 0;
      out.density = 1000;
      out.temperature = 288.15;
      return out;
    },
  },
};

function riser() {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 });
  const rod = new Rod(physics, {
    start: [0, -4, 0],
    end: [0, -0.5, 0],
    segments: 12,
    radius: 0.02,
    density: 1500,
    attachStart: 'fixed',
    loads: segmentLoads(sea, { period: Number.POSITIVE_INFINITY }),
  });
  return { physics, rod };
}

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate }).add(new RigidSolver(), { physics: riser().physics });

test('Rod: a riser shedding vortices in a current is the same at 24, 30 and 60 frames a second', () =>
  frameRateIndependent(make));

test("Rod: a seek equals a continuous run, the wake oscillators' state included", () => seekEqualsContinuous(make));

test("Rod: the rigid solver carries the rod's wake state, and refuses a stateful rod attached after the world began", () => {
  const { physics, rod } = riser();
  const world = new PhysicsWorld({ rate: { num: 24, den: 1 } }).add(new RigidSolver(), { physics });
  world.advance(6);
  const words = rod.takeState();
  assert.ok(words.length > 0 && words.some((v) => v !== 0), 'the rod has wake state to carry');
  // A second rod with loads, attached to the Physics after it joined the world, has no room in the world's state.
  new Rod(physics, { start: [1, -4, 0], end: [1, -1, 0], segments: 4, attachStart: 'fixed', loads: segmentLoads(sea) });
  assert.throws(() => world.advance(7), { name: 'MargoError', code: 'state', message: /attach them first/ });
});
