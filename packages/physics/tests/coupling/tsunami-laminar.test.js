import assert from 'node:assert/strict';
import test from 'node:test';
import { TsunamiSolver } from '../../dist/tsunami.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const dt = rate.den / rate.num;
const viscosity = 1e-6;
const period = 20;
const frequency = (2 * Math.PI) / period;
const bed = { kinematicViscosity: viscosity, period };

// Solve the no-slip bed and shear-free surface diffusion equation by its
// orthogonal sine modes, independently of the native tanh expression.
function columnDrag(depth) {
  const eigenmodes = 4096;
  const chi = (frequency * depth * depth) / viscosity;
  let real = 0;
  let quadrature = 0;
  for (let n = 0; n < eigenmodes; n++) {
    const alpha = (n + 0.5) * Math.PI;
    const eigenvalue = alpha * alpha;
    const weight = 2 / eigenvalue;
    const denominator = eigenvalue * eigenvalue + chi * chi;
    real += (weight * eigenvalue) / denominator;
    quadrature += (weight * chi) / denominator;
  }
  const magnitude = Math.hypot(real, quadrature);
  const scale = viscosity / (depth * depth);
  // The tail of the dimensionless mobility is bounded by the integral of
  // 2 / ((n + 1/2) * pi)^4. Both component sums have terms of one sign.
  const tail = 2 / (3 * Math.PI ** 4 * (eigenmodes - 0.5) ** 3);
  const mobilityError = tail + 4 * eigenmodes * Number.EPSILON * magnitude;
  return {
    rate: (scale * real) / (magnitude * magnitude),
    error: (scale * mobilityError) / (magnitude * (magnitude - mobilityError)),
    chi,
  };
}

function options(depth) {
  return { cells: [1, 1], spacing: 1, bathymetry: -depth, dischargeX: 0.025 * depth, dischargeZ: -0.01 * depth };
}

async function column(settings, shared = false) {
  const tsunami = await TsunamiSolver.load();
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared) }).add(tsunami, settings);
  return { tsunami, world };
}

test('TsunamiSolver: laminar discharge loses the independently derived amount across finite-depth regimes', async () => {
  const delta = Math.sqrt((2 * viscosity) / frequency);
  const depths = [0.0001, delta * 0.999999, delta * 1.000001, 0.02, 0.3];
  for (const shared of [false, true]) {
    for (const depth of depths) {
      const settings = options(depth);
      const { tsunami: inviscid, world: reference } = await column(settings, shared);
      const { tsunami, world } = await column({ ...settings, laminarBed: bed }, shared);
      reference.advance(1);
      world.advance(1);
      assert.equal(tsunami.budget.substeps, 1);
      const control = inviscid.sample(0, 0);
      const observed = tsunami.sample(0, 0);
      assert.equal(observed.depth, control.depth);
      assert.equal(tsunami.budget.storedVolume, inviscid.budget.storedVolume);
      assert.ok(control.discharge.every((q) => q !== 0));

      const drag = columnDrag(depth);
      const minimum = Math.exp(-dt * (drag.rate + drag.error));
      const maximum = Math.exp(-dt * (drag.rate - drag.error));
      for (let axis = 0; axis < 2; axis++) {
        const ratio = observed.discharge[axis] / control.discharge[axis];
        assert.ok(ratio >= minimum - 32 * Number.EPSILON && ratio <= maximum + 32 * Number.EPSILON);
      }
      if (depth === depths[0]) {
        // Rayleigh/Cauchy bound for the zero-frequency parabolic limit.
        const steady = (3 * viscosity) / (depth * depth);
        const firstEigenvalue = (Math.PI / 2) ** 2;
        assert.ok(drag.rate + drag.error >= steady);
        assert.ok(drag.rate - drag.error <= steady * (1 + (drag.chi / firstEigenvalue) ** 2));
        assert.ok(Math.abs(observed.discharge[0]) < 0.01 * Math.abs(control.discharge[0]));
      }
    }
  }
});

test('TsunamiSolver: laminar film damping keeps water volume and replays exactly', async () => {
  const { tsunami, world } = await column({ ...options(0.0004), laminarBed: bed });
  const volume = tsunami.budget.storedVolume;
  world.advance(5);
  const before = tsunami.sample(0, 0).discharge;
  const snapshot = world.takeSnapshot();
  world.advance(120);
  const after = tsunami.sample(0, 0).discharge;
  assert.ok(Math.hypot(...after) < Math.hypot(...before));
  assert.equal(tsunami.budget.storedVolume, volume);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(120);
  assert.equal(world.hash(), hash);
  assert.deepEqual(tsunami.sample(0, 0).discharge, after);
});

test('TsunamiSolver: laminar bed settings refuse invalid scales and simultaneous Manning drag', async () => {
  const tsunami = await TsunamiSolver.load();
  for (const settings of [
    { laminarBed: { ...bed, kinematicViscosity: 0 } },
    { laminarBed: { ...bed, period: Infinity } },
    { laminarBed: { ...bed, period: Number.MIN_VALUE } },
    { laminarBed: bed, manning: 0.018 },
  ]) {
    assert.throws(() => new PhysicsWorld({ rate }).add(tsunami, { ...options(0.001), ...settings }), {
      name: 'MargoError',
      code: 'state',
      message: /Use|Choose/,
    });
  }
});
