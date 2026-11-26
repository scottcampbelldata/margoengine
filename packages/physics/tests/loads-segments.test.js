// The water's loads on a moving structure's segments (src/loads/segments.ts `segmentLoads`) and the drag of a cylinder below
// the drag crisis (morison.ts `reynoldsDrag`), against their closed forms. The rods these loads move are checked against
// the cantilever, the catenary, the taut cable and strumming in tests/rod.test.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { reynoldsDrag, SEA_WATER_VISCOSITY, segmentLoads, steadyDrag, wakeStep } from '../dist/loads.js';

/** Water of density 1000 under the surface y = `surface`, moving at `velocity` everywhere. */
function water(velocity, surface = 0) {
  return {
    density: 1000,
    elevation: () => surface,
    water: {
      medium: 'water',
      cell: { x: 0, y: 0, z: 0 },
      sample(x, y, z, t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
        out.velocity[0] = velocity[0];
        out.velocity[1] = velocity[1];
        out.velocity[2] = velocity[2];
        out.density = 1000;
        out.temperature = 288.15;
        return out;
      },
    },
  };
}
const blank = () => ({
  force: [0, 0, 0],
  moment: [0, 0, 0],
  drag: { across: 0, along: 0, flow: [0, 0, 0], at: [0, 0, 0] },
  addedMass: 0,
  addedInertia: 0,
});
const segment = (position, tangent, velocity = [0, 0, 0]) => ({
  position,
  tangent,
  velocity,
  angularVelocity: [0, 0, 0],
  diameter: 0.1,
  length: 1,
});
const context = { time: 0, dt: 1 / 60, gravity: [0, -9.81, 0] };

test("a cylinder's drag follows White's fit below the drag crisis and DNV's steady drag above it", () => {
  assert.equal(reynoldsDrag(1000), 1 + 10 / 100);
  assert.equal(reynoldsDrag(0.5), reynoldsDrag(1), 'held at its Re 1 value below 1');
  assert.equal(reynoldsDrag(1e6), steadyDrag(0));
  assert.equal(reynoldsDrag(1e6, 0.02), steadyDrag(0.02));
  // Continuous at the ends of the crisis, falling across it.
  assert.ok(Math.abs(reynoldsDrag(2e5 + 1) - reynoldsDrag(2e5)) < 1e-5);
  assert.ok(Math.abs(reynoldsDrag(5e5 - 1) - steadyDrag(0)) < 1e-5);
  assert.ok(reynoldsDrag(3e5) < reynoldsDrag(2e5) && reynoldsDrag(3e5) > steadyDrag(0));
  assert.throws(() => reynoldsDrag(-1), {
    name: 'MargoError',
    code: 'unsupported',
    message: /pass one.+#hydrodynamic-loads/,
  });
});

test('a submerged segment floats by its volume, carries its added mass, and is dragged as a damping toward the flow', () => {
  // A horizontal segment 1 m long, 0.1 m across, 2 m down in still water: buoyancy rho g V up, added mass rho V (C_A 1 in a
  // steady current), no drag; in a cross flow of 0.4 m/s, c_n = 1/2 rho C_D D L U.
  const V = (Math.PI * 0.01) / 4,
    still = segmentLoads(water([0, 0, 0]), { period: Infinity, vortex: false }),
    out = [blank()];
  still.apply([segment([0, -2, 0], [1, 0, 0])], context, out);
  assert.ok(Math.abs(out[0].force[1] - 1000 * 9.81 * V) < 1e-9 * 1000 * 9.81 * V, `buoyancy ${out[0].force[1]}`);
  assert.equal(out[0].addedMass, 1000 * V);
  assert.equal(out[0].drag.across, 0);
  const flowing = segmentLoads(water([0, 0, 0.4]), { period: Infinity, vortex: false });
  flowing.apply([segment([0, -2, 0], [1, 0, 0])], context, out);
  const cd = reynoldsDrag((0.4 * 0.1) / SEA_WATER_VISCOSITY, 5e-5 / 0.1);
  assert.ok(Math.abs(out[0].drag.across - 0.5 * 1000 * cd * 0.1 * 0.4) < 1e-9, `c_n ${out[0].drag.across}`);
  assert.deepEqual(out[0].drag.flow, [0, 0, 0.4]);
});

test('a segment through the surface is loaded on its wetted length, and one out of the water not at all', () => {
  // Upright, its middle at the surface: half its length is wet, its buoyancy and added mass are half, and they act at the
  // middle of the wetted half, a quarter of its length below its centre.
  const V = (Math.PI * 0.01) / 4,
    loads = segmentLoads(water([0, 0, 0]), { period: Infinity, vortex: false }),
    out = [blank()];
  loads.apply([segment([0, 0, 0], [0, 1, 0])], context, out);
  assert.ok(Math.abs(out[0].force[1] - (1000 * 9.81 * V) / 2) < 1e-9);
  assert.ok(Math.abs(out[0].addedMass - (1000 * V) / 2) < 1e-12);
  assert.deepEqual(out[0].drag.at, [0, -0.25, 0]);
  loads.apply([segment([0, 2, 0], [0, 1, 0])], context, out);
  assert.deepEqual(out[0].force, [0, 0, 0]);
  assert.equal(out[0].addedMass, 0);
});

test("a segment's wake oscillator is driven by its own motion, and its state goes back as it was taken", () => {
  // Held still in a cross flow, the wake settles to the free van der Pol cycle (q about 2); the same wake driven by a
  // segment that moves across the flow is pushed off it. The provider's state restores to the same bits.
  const flow = water([0, 0, 0.3]),
    held = segmentLoads(flow, { period: Infinity }),
    shaken = segmentLoads(flow, { period: Infinity }),
    a = [blank()],
    b = [blank()];
  const qs = [];
  for (let i = 0; i < 600; i++) {
    held.apply([segment([0, -2, 0], [1, 0, 0])], context, a);
    shaken.apply([segment([0, -2, 0], [1, 0, 0], [0, 0.05 * Math.sin(i / 3), 0])], context, b);
    qs.push(Math.abs(a[0].force[1] - b[0].force[1]));
  }
  assert.ok(Math.max(...qs) > 0, 'the moving segment sheds differently');
  const state = shaken.takeState(),
    first = [];
  for (let i = 0; i < 30; i++) {
    shaken.apply([segment([0, -2, 0], [1, 0, 0], [0, 0.05 * Math.sin(i / 3), 0])], context, b);
    first.push([...b[0].force]);
  }
  shaken.restoreState(state);
  for (let i = 0; i < 30; i++) {
    shaken.apply([segment([0, -2, 0], [1, 0, 0], [0, 0.05 * Math.sin(i / 3), 0])], context, b);
    assert.deepEqual([...b[0].force], first[i], `step ${i}`);
  }
  assert.throws(() => shaken.restoreState(new Float64Array(10)), {
    name: 'MargoError',
    code: 'unsupported',
    message: /pass that one.+#hydrodynamic-loads/,
  });
  // The shared step: a wake held still (no forcing) keeps the free cycle's amplitude near 2.
  const wake = Float64Array.of(0.1, 0);
  let top = 0;
  for (let i = 0; i < 2000; i++) top = Math.max(top, Math.abs(wakeStep(wake, 0, 10, 0, 0.01)));
  assert.ok(Math.abs(top - 2) < 0.05, `the free wake's amplitude ${top}`);
});
