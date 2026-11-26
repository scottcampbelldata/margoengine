import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushShellSolver } from '../../dist/crush.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

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
