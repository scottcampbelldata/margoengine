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

async function specimen({
  smooth = 0,
  leadingBody = false,
  twoCells = false,
  length = 1,
  materialProfile = beech,
} = {}) {
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
  const rest = (twoCells ? [...positions, [0, 0, -1]] : positions).map((p) => p.map((x) => x * length));
  const body = soft.create(
    new SoftBodyDesc(rest)
      .setCells(twoCells ? [0, 1, 2, 3, 0, 2, 1, 4] : [0, 1, 2, 3], material)
      .setSurface()
      .setPinnedParticles(twoCells ? [0, 1, 2, 3, 4] : [0, 1, 2, 3])
      .setOrthotropicStiffness(materialProfile)
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

// Seeber et al. (2024), Table 1. 1 N/mm equals 1000 J/m².
const calibrated = {
  ...beech,
  strength: { ...beech.strength, fractureEnergy: { tensile: [10000, 710, 710], shear: [1200, 1200, 600] } },
};
const bendRollingShear = (body, length, utilization) => {
  const shear = (utilization * beech.strength.shear[2]) / beech.shearModuli[2];
  body.setParticlePosition(3, [0, length * shear, length * Math.sqrt(1 - shear * shear)]);
};

test('beech rolling shear softens progressively and tears only after its fracture-energy displacement', async () => {
  const length = 0.001;
  const { body, soft, world } = await specimen({ twoCells: true, length, materialProfile: calibrated });
  const strength = beech.strength.shear[2];
  const beta =
    (2 * beech.shearModuli[2] * calibrated.strength.fractureEnergy.shear[2]) / (length * strength * strength);
  const k = 1.6;
  bendRollingShear(body, length, k);
  world.advance(1);
  assert.equal(body.isCellTorn(0), false);
  const first = soft.copyCrackBand(body);
  const expected = 1 - (beta - k) / ((beta - 1) * k);
  assert.ok(Math.abs(first[14] - expected) < 64 * epsilon32);
  bendRollingShear(body, length, 0.2);
  world.advance(2);
  assert.equal(soft.copyCrackBand(body)[14], first[14], 'unloading preserves irreversible damage');
  const events = [];
  const stop = soft.onTear((event) => events.push(event));
  bendRollingShear(body, length, beta * 1.02);
  world.advance(6);
  stop();
  assert.equal(events.length, 1);
  const [cut] = events;
  assert.deepEqual(cut.cells, [0]);
  assert.equal(cut.pieces.length, 2);
  assert.equal(soft.copyCrackBand(cut.destination(3)[0].body)[14], 1);
  assert.equal(soft.copyCrackBand(cut.destination(3)[0].body)[16], 1);
});

test('cutting a partially damaged cell preserves its damage and snapshot replay', async () => {
  const length = 0.0005;
  const make = async () => {
    const { body, soft, world } = await specimen({ length, materialProfile: calibrated });
    bendRollingShear(body, length, 1.8);
    world.advance(1);
    const history = soft.copyCrackBand(body);
    assert.ok(history[14] > 0 && history[14] < 1);
    const { pieces } = soft.cutPlane(body, [length * 0.43, 0, 0], [1, 0, 0]);
    for (const piece of pieces) {
      const state = soft.copyCrackBand(piece);
      for (let i = 0; i < state.length; i += history.length)
        assert.deepEqual(state.subarray(i, i + history.length), history);
    }
    return world;
  };
  const a = await make();
  const b = await make();
  a.advance(5);
  b.advance(3);
  b.restoreSnapshot(a.takeSnapshot().bytes);
  a.advance(8);
  b.advance(8);
  assert.equal(a.hash(), b.hash());
});

test('physically too coarse cells are refused before a fracture-energy material enters the world', async () => {
  const { soft, world } = await specimen({ length: 0.001, materialProfile: calibrated });
  const before = world.hash();
  const coarse = new SoftBodyDesc(positions)
    .setCells([0, 1, 2, 3])
    .setOrthotropicStiffness(calibrated)
    .setSolver('vertex-block');
  assert.throws(() => soft.create(coarse), /Refine the tetrahedra/);
  assert.equal(world.hash(), before);
});
