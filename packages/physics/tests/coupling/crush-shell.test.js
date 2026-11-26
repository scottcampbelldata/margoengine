import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushShellSolver } from '../../dist/crush.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const material = {
  thickness: 0.015,
  density: 7800,
  youngModulus: 200e6,
  poissonRatio: 0.3,
  yieldStress: 350e3,
  hardeningModulus: 1.2e6,
};
const zero = [0, 0, 0];
const positions = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
];
const triangles = [[0, 1, 2]];

function near(got, want, bound) {
  assert.ok(Math.abs(got - want) <= bound, `expected ${want}, got ${got}, tolerance ${bound}`);
}

async function model(params = {}, gravity = zero, shared = false) {
  const shell = await CrushShellSolver.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity, memory: worldMemory(shared) });
  world.add(shell, { positions, triangles, material, ...params });
  return { shell, world };
}

test('free sheet follows analytic gravity motion without artificial strain or work in either arena', async () => {
  const gravity = [0, -9.81, 0];
  const velocity = [0.45, -1.5, 0.2];
  const run = async (shared) => {
    const { shell, world } = await model({ velocities: positions.map(() => velocity) }, gravity, shared);
    const cell = [11, -4, 8];
    world.setCell(shell.id, cell);
    world.advance(15);
    const { positions: current, velocities } = shell.readMesh();
    const port = world.fields.port(shell.positionField.name);
    assert.deepEqual(port.cell, cell);
    assert.deepEqual(regionWords(world.memory, port.region), current);
    const time = 15 / 60;
    for (const [i, point] of positions.entries()) {
      for (let axis = 0; axis < 3; axis++) {
        near(velocities[3 * i + axis], velocity[axis] + time * gravity[axis], 4e-10);
        near(current[3 * i + axis], point[axis] + time * velocity[axis] + 0.5 * time ** 2 * gravity[axis], 4e-10);
      }
    }
    assert.equal(shell.readFace(0).equivalentPlasticStrain, 0);
    near(shell.readBudget().membrane, 0, 1e-18);
    assert.equal(shell.readBudget().appliedWork, 0);
    const mass = (material.density * material.thickness) / 2;
    near(shell.readBudget().kinetic, 0.5 * mass * velocities.slice(0, 3).reduce((sum, v) => sum + v * v, 0), 1e-8);
    return shell.readMesh();
  };
  assert.deepEqual(await run(false), await run(true));
});

test('real vertex loads exercise J2 hardening, fixed reaction, irreversible work and exact replay', async () => {
  const { shell, world } = await model({ pinned: [0, 2] });
  const volume = material.thickness / 2;
  world.advance(1);
  const before = world.takeSnapshot();
  const measure = () => {
    shell.setForce(1, [5000, 0, 0]);
    world.advance(2);
    const mesh = shell.readMesh();
    const face = shell.readFace(0);
    const budget = shell.readBudget();
    assert.ok(mesh.positions[3] > 1.005);
    const [xx, yy, xy] = face.stress;
    near(xy, 0, 1e-9);
    assert.ok(face.equivalentPlasticStrain > 0.005);
    const mise = Math.sqrt(xx ** 2 - xx * yy + yy ** 2 + 3 * xy ** 2);
    near(mise, material.yieldStress + material.hardeningModulus * face.equivalentPlasticStrain, 1e-7);
    near(budget.plasticDissipation, volume * material.yieldStress * face.equivalentPlasticStrain, 1e-10);
    near(budget.hardening, 0.5 * volume * material.hardeningModulus * face.equivalentPlasticStrain ** 2, 1e-10);
    near(budget.appliedWork, 5000 * (mesh.positions[3] - 1), 1e-9);
    near(shell.supportReaction(0)[0] + shell.supportReaction(2)[0], -volume * xx * mesh.positions[3], 1e-8);
    const stored = budget.kinetic + budget.membrane + budget.hardening + budget.plasticDissipation;
    near(stored, budget.appliedWork, 0.035 * budget.appliedWork);
    shell.setForce(1, zero);
    world.advance(3);
    assert.ok(shell.readBudget().plasticDissipation >= budget.plasticDissipation);
    assert.equal(shell.readBudget().appliedWork, budget.appliedWork);
    return { mesh: shell.readMesh(), budget: shell.readBudget(), face: shell.readFace(0), hash: world.hash() };
  };
  const loaded = measure();
  world.restoreSnapshot(before.bytes);
  assert.equal(shell.readBudget().appliedWork, 0);
  assert.deepEqual(measure(), loaded);
});

test('a live loaded crease converts its measured angle to hinge energy and transmits support force', async () => {
  const { shell, world } = await model({
    positions: [...positions, [0, -1, 0]],
    triangles: [
      [0, 1, 2],
      [1, 0, 3],
    ],
    pinned: [0, 1, 3],
  });
  const force = 5;
  shell.setForce(2, [0, 0, force]);
  world.advance(5);
  const { positions: mesh, triangles: faces } = shell.readMesh();
  assert.deepEqual(faces, new Uint32Array([0, 1, 2, 1, 0, 3]));
  assert.ok(mesh[8] > 1e-4);
  const angle = Math.atan2(mesh[8], mesh[7]);
  const flexural = (material.youngModulus * material.thickness ** 3) / (12 * (1 - material.poissonRatio ** 2));
  near(shell.readBudget().bending, 0.5 * 3 * flexural * angle ** 2, 1e-10);
  assert.ok(shell.supportReaction(3)[2] > 0);
  assert.equal(shell.supportReaction(2)[2], 0);
  near(mesh[11], 0, 0);
});

test('invalid mesh rejects precisely and degenerate drift publishes no partial shell state', async () => {
  await assert.rejects(
    model({
      positions: [...positions, [1, 1, 0]],
      triangles: [
        [0, 1, 2],
        [0, 1, 3],
      ],
    }),
    {
      code: 'state',
      message: /Use consistently wound shell faces/,
    },
  );
  await assert.rejects(model({ positions: [...positions, [1, 1, 0]], triangles }), {
    code: 'state',
    message: /Give every shell vertex incident area/,
  });
  const { world, shell } = await model({ pinned: [0, 1, 2] });
  const before = shell.readMesh();
  shell.setForce(2, [0, 0, 1e200]);
  assert.throws(() => world.advance(1), {
    code: 'failed',
    message: /Reduce the load/,
  });
  assert.deepEqual(shell.readMesh(), before);
  assert.deepEqual(shell.supportReaction(2), zero);
});

async function sphereModel({
  rateLevel,
  fixed,
  position,
  speed = zero,
  pinned,
  sphereCell = zero,
  shared = false,
  substeps = 4,
}) {
  await Physics.load({ threads: shared });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: zero, memory: worldMemory(shared) });
  const physics = new Physics(null, {
    arena: world.arena,
    gravity: zero,
    fixedTimestep: 1 / (60 << rateLevel),
    substeps,
  });
  const radius = 0.125;
  const contactModulus = 7e6;
  const mass = 14;
  const sphere = physics.addBody(null, {
    ...(fixed ? { type: 'fixed' } : {}),
    position,
    linearVelocity: speed,
    colliders: { shape: 'sphere', radius, mass, sensor: true },
  });
  const shell = await CrushShellSolver.loadRigid({ rate: rateLevel });
  world.add(new RigidSolver(), { physics, capacity: physics.kernel.capacity });
  world.add(shell, {
    positions,
    triangles,
    material,
    pinned,
    cellSize: 2,
    spheres: [{ body: sphere.row, radius, contactModulus }],
  });
  world.setCell('rigid', sphereCell);
  world.couple([shell.id, 'rigid'], 'staggered');
  return { world, physics, sphere, shell, radius, contactModulus, mass };
}

test('fixed sphere contact distributes independent Hertz load and work to all three shell supports', async () => {
  const loaded = await sphereModel({
    rateLevel: 2,
    fixed: true,
    position: [-3.75, 4.25, 0.125],
    pinned: [0, 1, 2],
    sphereCell: [2, -2, 0],
  });
  using _physics = loaded.physics;
  const { world, shell, radius, contactModulus } = loaded;
  world.advance(1);
  const compression = 0.5 * material.thickness;
  const force = (4 / 3) * contactModulus * Math.sqrt(radius) * compression ** 1.5;
  const hit = shell.readSphereContact(0);
  near(hit.compression, compression, 4e-16);
  near(hit.energy, 0.4 * force * compression, 1e-12);
  near(hit.impulse[2], force / 240, 1e-10);
  near(shell.supportReaction(0)[2], force / 2, 1e-9);
  near(shell.supportReaction(1)[2], force / 4, 1e-9);
  near(shell.supportReaction(2)[2], force / 4, 1e-9);
  assert.deepEqual(shell.readMesh().positions, Float64Array.from(positions.flat()));
});

test('moving rigid sphere transfers reciprocal linear and angular momentum to a deforming shell and replays', async (t) => {
  const loaded = await sphereModel({ rateLevel: 3, fixed: false, position: [0.3, 0.2, 0.17], speed: [0, 0, -0.8] });
  using _physics = loaded.physics;
  const { world, shell, sphere, mass } = loaded;
  // Start from the first completed world tick, with the accumulator allocated and the sphere still clear.
  world.advance(1);
  assert.equal(shell.readSphereContact(0).compression, 0);
  const saved = world.takeSnapshot();
  const nodeMass = (material.density * material.thickness) / 6;
  const initialMomentum = mass * sphere.linearVelocity[2];
  const initialCenter = sphere.position;
  const initialAngular = [initialCenter[1] * initialMomentum, -initialCenter[0] * initialMomentum];
  const measure = () => {
    let peak = 0;
    for (let frame = 2; frame <= 9; frame++) {
      world.advance(frame);
      peak = Math.max(peak, shell.readSphereContact(0).compression);
    }
    assert.ok(peak > 0.002);
    assert.ok(sphere.linearVelocity[2] > 0.1);
    assert.deepEqual(sphere.angularVelocity, zero);
    const mesh = shell.readMesh();
    const v = sphere.linearVelocity;
    near(
      mass * v[2] + nodeMass * (mesh.velocities[2] + mesh.velocities[5] + mesh.velocities[8]),
      initialMomentum,
      2e-5,
    );
    const center = sphere.position;
    let lx = mass * (center[1] * v[2] - center[2] * v[1]);
    let ly = mass * (center[2] * v[0] - center[0] * v[2]);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      lx +=
        nodeMass * (mesh.positions[i + 1] * mesh.velocities[i + 2] - mesh.positions[i + 2] * mesh.velocities[i + 1]);
      ly += nodeMass * (mesh.positions[i + 2] * mesh.velocities[i] - mesh.positions[i] * mesh.velocities[i + 2]);
    }
    near(lx, initialAngular[0], 0.008);
    near(ly, initialAngular[1], 0.008);
    assert.ok(mesh.positions[2] < -0.005);
    assert.ok(Math.abs(mesh.positions[2] - mesh.positions[5]) > 0.002);
    return { mesh, reaction: shell.readSphereContact(0), p: sphere.position, v, hash: world.hash() };
  };
  const first = measure();
  const budget = shell.readBudget();
  const startEnergy = (0.5 * initialMomentum ** 2) / mass;
  const endEnergy =
    0.5 * mass * first.v.reduce((sum, value) => sum + value * value, 0) +
    budget.kinetic +
    budget.membrane +
    budget.bending +
    budget.hardening +
    budget.plasticDissipation +
    first.reaction.energy;
  t.diagnostic(`Mechanical energy and plastic work ${startEnergy.toFixed(6)} → ${endEnergy.toFixed(6)} J`);
  near(endEnergy, startEnergy, 2e-4);
  world.restoreSnapshot(saved.bytes);
  assert.deepEqual(measure(), first);
});

test('a one-substep moving rigid integrator cannot realize both contact moments', async () => {
  const loaded = await sphereModel({ rateLevel: 1, fixed: false, position: [0.3, 0.2, 0.16], substeps: 1 });
  using _physics = loaded.physics;
  assert.throws(() => loaded.world.advance(1), {
    code: 'state',
    message: /Use at least two rigid substeps/,
  });
});
