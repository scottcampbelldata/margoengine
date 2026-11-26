import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../../dist/world.js';
import { calibration, withheld } from './treloar-measurements.js';

const unit = 98_066.5;
const links = 20.45;
const chainScale = 2.440171515140431 * unit;
const transverseScale = 0.5522319865067356 * unit;
const spread = 6;
const chainDerivative = (i1) => {
  const r = i1 / links;
  return 0.5 + r * (0.1 + r * (33 / 1050 + r * (76 / 7050 + (2595 / 673750) * r)));
};
const mu = 2 * (chainScale * chainDerivative(3) + transverseScale);
const material = Object.assign(new CellMaterial(), {
  youngsModulus: 2 * 1.45 * mu,
  poissonRatio: 0.45,
  deformationDamping: 0,
  rubber: { lockingStretch: Math.sqrt(links), transverseFraction: (2 * transverseScale) / mu, invariantSpread: spread },
});
const rest = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const mass = 20;
const modeStretches = (mode, strain) => {
  const axial = 1 + strain;
  if (mode === 'uniaxial') return [axial, 1 / Math.sqrt(axial), 1 / Math.sqrt(axial)];
  if (mode === 'biaxial') return [axial, axial, 1 / (axial * axial)];
  return [axial, 1, 1 / axial];
};
const nominal = ([a, b, c]) => {
  const i1 = a * a + b * b + c * c;
  const i2 = (a * b) ** 2 + (b * c) ** 2 + (a * c) ** 2;
  return (
    2 * (a - (c * c) / a) * (chainScale * chainDerivative(i1) + (b * b * transverseScale) / (1 + (i2 - 3) / spread))
  );
};

await Physics.load();

async function makeSampler(rate) {
  const step = 1 / rate;
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: step });
  const soft = await SoftBodies.attach(physics, { substeps: 1, iterations: 4 });
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, 0, 0] })
    .add(new RigidSolver(), { physics })
    .add(new SoftSolver(), { soft })
    .couple(['soft', 'rigid'], 'staggered');
  let frame = 0;

  const sample = (stretch, axis) => {
    const free = axis + 1;
    const body = soft.create(
      new SoftBodyDesc(rest)
        .setCells([0, 1, 2, 3], material)
        .setSolver('vertex-block')
        .setParticleMass(mass)
        .setParticleRadius(0)
        .setLinearDamping(0)
        .setPinnedParticles([0, 1, 2, 3].filter((particle) => particle !== free)),
    );
    rest.forEach((point, p) =>
      body.setParticlePosition(
        p,
        point.map((value, j) => value * stretch[j]),
      ),
    );
    world.advance(++frame);
    // One unit tetrahedron has rest volume 1/6. The isolated corner's reaction is the axial nominal stress times that volume.
    const stress = (-6 * mass * body.particleVelocity(free)[axis]) / step;
    soft.remove(body);
    return stress;
  };
  // Remove the arbitrary incompressible pressure by imposing zero stress on the last principal direction.
  const pressure = (stretch) => sample(stretch, 0) - (stretch[2] / stretch[0]) * sample(stretch, 2);
  return { pressure, physics, world, soft };
}

test('the native finite-chain law predicts held-out Treloar rubber loading', async () => {
  const measuredFloor =
    Math.min(
      ...Object.values(calibration)
        .flat()
        .map(([, stress]) => stress),
    ) * unit;
  const error = Object.entries(calibration).flatMap(([mode, data]) =>
    data.map(([strain, measured]) => {
      const reading = measured * unit;
      return (nominal(modeStretches(mode, strain)) - reading) / (measuredFloor + reading);
    }),
  );
  // 25 calibration observations and four fitted values leave 21 degrees of freedom, t(0.975, 21) = 2.080.
  const deviation = Math.sqrt(error.reduce((sum, value) => sum + value * value, 0) / (error.length - 4));
  const coarse = await makeSampler(3840);
  const fine = await makeSampler(7680);
  let count = 0;
  for (const [mode, data] of Object.entries(withheld)) {
    for (const [strain, observed] of data) {
      if (strain < 0.2) continue; // This material check concerns finite extension. The low biaxial points are reported separately.
      const stretch = modeStretches(mode, strain);
      const whole = coarse.pressure(stretch);
      const half = fine.pressure(stretch);
      // The error of a finite-step inertial stress probe starts at O(h²), since the starting velocity is zero.
      const estimated = (4 * half - whole) / 3;
      const roundoff = 6 * mass * 7680 ** 2 * 2 ** -23 * (stretch[0] + stretch[2] ** 2 / stretch[0]);
      const numerical = Math.abs(half - whole) / 3 + roundoff;
      const exact = nominal(stretch);
      assert.ok(
        Math.abs(estimated - exact) < numerical,
        `${mode} numerical traction at ${strain}: ${estimated} vs ${exact}`,
      );
      const reading = observed * unit;
      const allowance = 2.08 * deviation * (measuredFloor + reading) + numerical;
      assert.ok(
        Math.abs(estimated - reading) < allowance,
        `${mode} held-out point at ${strain}: ${estimated} Pa vs ${reading} Pa, allowance ${allowance} Pa`,
      );
      count++;
    }
  }
  assert.equal(count, 23);
  coarse.physics.dispose();
  fine.physics.dispose();
});

test('finite-chain vertex blocks recover an inverted cell and replay the exact state', async () => {
  async function inverted() {
    const { soft, world, physics } = await makeSampler(60);
    const body = soft.create(
      new SoftBodyDesc(rest)
        .setCells([0, 1, 2, 3], material)
        .setSolver('vertex-block')
        .setPinnedParticles([0, 1, 2])
        .setParticleRadius(0)
        .setParticleMass(mass)
        .setLinearDamping(2),
    );
    body.setParticlePosition(3, [0.2, 0.08, -0.5]);
    return { world, physics, body };
  }
  const first = await inverted();
  const snapshot = first.world.takeSnapshot();
  first.world.advance(60);
  assert.ok(first.body.particlePosition(3).every(Number.isFinite));
  assert.ok(first.body.particlePosition(3)[2] > 0);
  const second = await inverted();
  second.world.restoreSnapshot(snapshot.bytes);
  second.world.advance(60);
  assert.equal(second.world.hash(), first.world.hash());
  first.physics.dispose();
  second.physics.dispose();
});

test('finite-chain material rejects incompatible solvers and invalid coefficients', async () => {
  const invalid = Object.assign(material.clone(), { rubber: { lockingStretch: 1 } });
  assert.throws(() => new SoftBodyDesc(rest).setCells([0, 1, 2, 3], invalid), { code: 'state' });
  const { soft, physics } = await makeSampler(60);
  const description = new SoftBodyDesc(rest).setCells([0, 1, 2, 3], material);
  assert.throws(() => soft.create(description), { code: 'state' });
  const body = soft.create(description.setSolver('vertex-block'));
  assert.throws(() => body.setSolver('projective'), { code: 'state' });
  assert.equal(body.solver, 'vertex-block');
  physics.dispose();
});
