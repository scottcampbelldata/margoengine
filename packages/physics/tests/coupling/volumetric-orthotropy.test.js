import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { ladder } from './volumetric-ladder.js';

await Physics.load();

// USDA Wood Handbook (2021), Tables 5–1 and 5–2, Douglas-fir. Units are rescaled together.
const longitudinal = 12000;
const wood = {
  youngsModuli: [longitudinal, 0.068 * longitudinal, 0.05 * longitudinal],
  shearModuli: [0.064 * longitudinal, 0.078 * longitudinal, 0.007 * longitudinal],
  poissonRatios: [0.292, 0.449, 0.39],
};
const rest = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const dt = 1 / 30;
const mass = 2;
const timeScale = (dt * dt) / 6;
const epsilon32 = 2 ** -23;

function constrainedModuli() {
  const [ex, ey, ez] = wood.youngsModuli;
  const [nxy, nxz, nyz] = wood.poissonRatios;
  const a = 1 / ex,
    b = 1 / ey,
    c = 1 / ez,
    d = -nxy / ex,
    e = -nxz / ex,
    f = -nyz / ey;
  const determinant = a * b * c + 2 * d * e * f - a * f * f - b * e * e - c * d * d;
  return [(b * c - f * f) / determinant, (a * c - e * e) / determinant, (a * b - d * d) / determinant];
}

async function specimen(axes) {
  const physics = new Physics(null, { fixedTimestep: dt, gravity: [0, 0, 0] });
  const soft = await SoftBodies.attach(physics, { substeps: 1, iterations: 16 });
  soft.cellDamping = 0;
  const material = new CellMaterial();
  const desc = new SoftBodyDesc(rest)
    .setCells([0, 1, 2, 3], material)
    .setParticleMass(mass)
    .setPinnedParticles([0, 1, 2])
    .setOrthotropicStiffness({ ...wood, axes })
    .setSolver('vertex-block');
  return { physics, body: soft.create(desc) };
}

test('all three constrained axial responses match the independent orthotropic compliance calculation', async () => {
  const axes = [
    [
      [0, 0, 1],
      [1, 0, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [1, 0, 0],
      [0, 1, 0],
    ],
  ];
  const displacement = 1.13;
  for (const [axis, modulus] of constrainedModuli().entries()) {
    const { physics, body } = await specimen(axes[axis]);
    body.setParticlePosition(3, [0, 0, displacement]);
    physics.step();
    // The free vertex sees true Green strain (z²-1)/2 and a cubic implicit equation.
    let low = 1;
    let high = displacement;
    for (let i = 0; i < 54; i++) {
      const z = (low + high) / 2;
      const gradient = mass * (z - displacement) + timeScale * modulus * z * ((z * z - 1) / 2);
      if (gradient < 0) low = z;
      else high = z;
    }
    const expected = (low + high) / 2;
    assert.ok(Math.abs(body.particlePosition(3)[2] - expected) < 8 * epsilon32, `axis ${axis}`);
  }
});

test('the three shear moduli move the tip by their distinct implicit responses', async () => {
  const axes = [
    [
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
    ],
  ];
  const constrained = constrainedModuli();
  const amount = 0.04;
  for (const [index, shear] of wood.shearModuli.entries()) {
    const { physics, body } = await specimen(axes[index]);
    body.setParticlePosition(3, [amount, 0, 1]);
    physics.step();
    const linear = (amount * mass) / (mass + timeScale * shear);
    // The free tip's normal coordinate lies in [sqrt(1-x²),1], so the omitted axial strain is at most x²/2.
    const normal = constrained[index === 0 ? 1 : 2];
    const error = (timeScale * normal * amount * amount * amount) / (2 * mass);
    assert.ok(Math.abs(body.particlePosition(3)[0] - linear) <= error + 8 * epsilon32 * amount);
  }
});

test('the tensor has no rigid-rotation stress and the volume term recovers from a flipped cell', async () => {
  const { physics, body } = await specimen();
  for (const [index, [x, y, z]] of rest.entries()) body.setParticlePosition(index, [-y, x, z]);
  physics.step();
  assert.deepEqual(body.particlePosition(3), [0, 0, 1]);
  const inverted = -0.24;
  body.setParticlePosition(3, [0, 0, inverted]);
  physics.step();
  const z = body.particlePosition(3)[2];
  assert.ok(z > 0 && z < 1);
  const [cx, cy, cz] = constrainedModuli();
  // The signed determinant of the rotated cell is z. Differentiate the two energies independently.
  const gradient =
    mass * (z - inverted) + timeScale * ((cz * z * (z * z - 1)) / 2 - ((cx + cy + cz) * (1 - z) ** 3) / 3);
  assert.ok(Math.abs(gradient) < 8 * epsilon32 * mass);
});

test('authored axes and moduli must define a positive elastic energy', () => {
  const desc = new SoftBodyDesc(rest);
  assert.throws(() => desc.setOrthotropicStiffness({ ...wood, shearModuli: [1, 1, 0] }), /positive moduli/);
  assert.throws(() => desc.setOrthotropicStiffness({ ...wood, poissonRatios: [10, 10, 10] }), /positive definite/);
  assert.throws(
    () =>
      desc.setOrthotropicStiffness({
        ...wood,
        axes: [
          [1, 0, 0],
          [-1, 0, 0],
        ],
      }),
    /nonzero/,
  );
});

test('snapshots and cuts retain the complete tensor and its authored material frame', async () => {
  const rungMaterial = {
    ...wood,
    youngsModuli: wood.youngsModuli.map((modulus) => modulus * 1000),
    shearModuli: wood.shearModuli.map((modulus) => modulus * 1000),
  };
  const a = await ladder(undefined, { orthotropy: rungMaterial });
  const b = await ladder(undefined, {
    orthotropy: {
      ...rungMaterial,
      axes: [
        [0, 0, 1],
        [1, 0, 0],
      ],
    },
  });
  assert.notEqual(a.world.hash(), b.world.hash());
  a.world.advance(12);
  b.world.advance(12);
  b.world.restoreSnapshot(a.world.takeSnapshot().bytes);
  assert.deepEqual(b.rung.orthotropy, a.rung.orthotropy);
  a.world.advance(24);
  b.world.advance(24);
  assert.equal(a.world.hash(), b.world.hash());
  const { pieces } = b.soft.cut(b.rung, [
    [0, 0, -2],
    [0, 4, -2],
    [0, 0, 4],
  ]);
  assert.equal(pieces.length, 2);
  for (const piece of pieces) assert.deepEqual(piece.orthotropy, a.rung.orthotropy);
});
