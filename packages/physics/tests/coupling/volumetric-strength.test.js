import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../../dist/world.js';

await Physics.load();
const axes = [0, 1, 2];
const positions = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const rate = { num: 60, den: 1 };
const dt = 1 / rate.num;
const MPa = 1e6;
const epsilon32 = 2 ** -23;

// Seeber et al. (2024), European beech. Table 1 elastic and shear properties,
// Table 2 measured axial strengths and standard deviations.
const beech = {
  youngsModuli: [12500 * MPa, 2050 * MPa, 810 * MPa],
  shearModuli: [1640 * MPa, 1080 * MPa, 470 * MPa],
  poissonRatios: [0.43, 0.58, 0.61],
  strength: {
    tensile: [139.4 * MPa, 18.2 * MPa, 8 * MPa],
    compressive: [61.9 * MPa, 15.5 * MPa, 6.7 * MPa],
    shear: [14 * MPa, 18 * MPa, 15 * MPa],
  },
};
const deviation = { tensile: [38.5 * MPa, 1 * MPa, 0.5 * MPa], compressive: [4.3 * MPa, 0.9 * MPa, 0.4 * MPa] };

async function specimen({ smooth = 0, leadingBody = false, twoCells = false } = {}) {
  const physics = new Physics(null, { fixedTimestep: dt, gravity: [0, 0, 0] });
  const soft = await SoftBodies.attach(physics, { substeps: 1, iterations: 4 });
  const world = new PhysicsWorld({ rate })
    .add(new RigidSolver(), { physics })
    .add(new SoftSolver(), { soft })
    .couple(['soft', 'rigid'], 'staggered');
  const first = leadingBody
    ? soft.create(new SoftBodyDesc(positions.map(([x, y, z]) => [x + 2, y, z])).setCells([0, 1, 2, 3]))
    : null;
  const material = new CellMaterial();
  material.tearSmoothing = smooth;
  const body = soft.create(
    new SoftBodyDesc(twoCells ? [...positions, [0, 0, -1]] : positions)
      .setCells(twoCells ? [0, 1, 2, 3, 0, 2, 1, 4] : [0, 1, 2, 3], material)
      .setSurface()
      .setPinnedParticles(twoCells ? [0, 1, 2, 3, 4] : [0, 1, 2, 3])
      .setOrthotropicStiffness(beech)
      .setSolver('vertex-block'),
  );
  return { world, soft, body, first };
}

function axial(body, axis, stress, rotated = false) {
  const [ex, ey, ez] = beech.youngsModuli;
  const [nxy, nxz, nyz] = beech.poissonRatios;
  // Independent forward compliance maps a single authored stress to its Green strains.
  const compliance = [
    [1 / ex, -nxy / ex, -nxz / ex],
    [-nxy / ex, 1 / ey, -nyz / ey],
    [-nxz / ex, -nyz / ey, 1 / ez],
  ];
  const lambda = compliance[axis].map((entry) => Math.sqrt(1 + 2 * entry * stress));
  positions.forEach(([x, y, z], vertex) => {
    const p = [x * lambda[0], y * lambda[1], z * lambda[2]];
    body.setParticlePosition(vertex, rotated ? [-p[1], p[0], p[2]] : p);
  });
}

test('published beech tensile and compressive strength windows distinguish all three material axes', async () => {
  for (const [sense, kind] of [
    [1, 'tensile'],
    [-1, 'compressive'],
  ]) {
    for (const axis of axes) {
      const mean = beech.strength[kind][axis];
      const spread = deviation[kind][axis];
      const { world, body } = await specimen();
      axial(body, axis, sense * (mean - spread), true);
      world.advance(1);
      assert.equal(body.isCellTorn(0), false, `${kind} axis ${axis} below measured mean`);
      axial(body, axis, sense * (mean + spread));
      world.advance(2);
      assert.equal(body.isCellTorn(0), true, `${kind} axis ${axis} above measured mean`);
    }
  }
});

test('engineering shear in either direction uses the strength of its own material plane', async () => {
  for (const [index, [a, b]] of [
    [0, 1],
    [0, 2],
    [1, 2],
  ].entries()) {
    const { world, body } = await specimen();
    const atLimit = beech.strength.shear[index] / beech.shearModuli[index];
    // Both columns retain unit length, so the Green normal strains are zero.
    const apply = (t) => {
      const point = [0, 0, 0];
      point[a] = t;
      point[b] = Math.sqrt(1 - t * t);
      body.setParticlePosition(b + 1, point);
    };
    apply(atLimit * 0.99);
    world.advance(1);
    assert.equal(body.isCellTorn(0), false);
    apply(-atLimit * 1.01);
    world.advance(2);
    assert.equal(body.isCellTorn(0), true, `shear plane ${index}`);
  }
});

test('independent signed loads survive unrelated body compaction, a plane cut and replay', async () => {
  const make = async () => {
    const { world, soft, body, first } = await specimen({ smooth: 0.125, leadingBody: true });
    axial(body, 0, beech.strength.tensile[0] * 0.75);
    world.advance(1);
    axial(body, 1, -beech.strength.compressive[1] * 0.75);
    world.advance(2);
    const row = soft.copyOrthotropicFailure(body);
    const relax = dt / 0.125;
    assert.ok(Math.abs(row[9] - 0.75 * relax * (1 - relax)) < 64 * epsilon32);
    assert.ok(Math.abs(row[13] - 0.75 * relax) < 64 * epsilon32);
    soft.remove(first);
    assert.deepEqual(soft.copyOrthotropicFailure(body), row);
    const { pieces } = soft.cutPlane(body, [0.43, 0, 0], [1, 0, 0]);
    assert.equal(pieces.length, 2);
    for (const piece of pieces) {
      const saved = soft.copyOrthotropicFailure(piece);
      for (let i = 0; i < saved.length; i += row.length) assert.deepEqual(saved.subarray(i, i + row.length), row);
    }
    return world;
  };
  const a = await make();
  const b = await make();
  a.advance(5);
  b.advance(3);
  b.restoreSnapshot(a.takeSnapshot().bytes);
  a.advance(9);
  b.advance(9);
  assert.equal(a.hash(), b.hash());
});

test('one overloaded shear plane splits the damaged cell from its intact neighbor', async () => {
  const { world, soft, body } = await specimen({ twoCells: true });
  const mass = body.mass();
  const restVolume = body.restVolume();
  const strengths = body.orthotropicStrength;
  const gamma = (1.05 * beech.strength.shear[1]) / beech.shearModuli[1];
  body.setParticlePosition(3, [gamma, 0, Math.sqrt(1 - gamma * gamma)]);
  const events = [];
  const stop = soft.onTear((event) => events.push(event));
  world.advance(1);
  stop();
  assert.equal(events.length, 1);
  const [{ cells, pieces, destination }] = events;
  assert.deepEqual(cells, [0]);
  assert.equal(pieces.length, 2);
  assert.equal(destination(1).length, 2);
  for (const piece of pieces) assert.deepEqual(piece.orthotropicStrength, strengths);
  assert.ok(Math.abs(pieces[0].mass() + pieces[1].mass() - mass) <= 4 * epsilon32 * mass);
  assert.ok(Math.abs(pieces[0].restVolume() + pieces[1].restVolume() - restVolume) <= 4 * epsilon32 * restVolume);
});

test('authored strength requires positive stresses and keeps scalar tear criteria out of the same body', async () => {
  const { soft, body } = await specimen();
  const material = new CellMaterial();
  material.tearStrain = 0.1;
  assert.throws(() => body.setCellMaterial(material), /Set CellMaterial.tearStrain to zero/);
  assert.throws(
    () =>
      soft.create(
        new SoftBodyDesc(positions).setOrthotropicStiffness({
          ...beech,
          strength: { ...beech.strength, shear: [1, 0, 1] },
        }),
      ),
    /positive finite float32/,
  );
});
