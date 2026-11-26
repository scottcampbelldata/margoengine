import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { createLayeredTissue, TissueSolver } from '../../dist/tissue.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';

import { cells, createLayerFixture as specimen, length, materials, step, volume } from './tissue-layers-fixture.js';

const close = (actual, expected, quantity, scale) =>
  assert.ok(Math.abs(actual - expected) < 16 * 2 ** -23 * scale, quantity + ': ' + actual + ' versus ' + expected);

await Physics.load();

test('native tissue layers assemble independent stiffnesses and masses at shared interface nodes', async () => {
  const { physics, soft, desc } = await specimen();
  const tissue = createLayeredTissue(soft, desc, { cells, materials });
  const totalMass = volume * Object.values(materials).reduce((sum, material) => sum + material.density, 0);
  close(tissue.mass(), totalMass, 'whole mass', totalMass);
  const tipMass = totalMass / 4;
  const impulse = tipMass * 0.01;
  const stiffness =
    (volume / length ** 2) * Object.values(materials).reduce((sum, material) => sum + material.youngsModulus, 0);
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0] })
    .add(new RigidSolver(), { physics })
    .add(new TissueSolver(), { soft, bindings: [] });
  tissue.applyParticleImpulse(5, [0, 0, impulse]);
  world.advance(1);
  const expected = length + (step * impulse) / (tipMass + step ** 2 * stiffness);
  close(tissue.particlePosition(5)[2], expected, 'normal extension', length);
  physics.dispose();
});

test('a tissue cut carries density and elastic material of the parent cell', async () => {
  const { physics, soft, desc } = await specimen();
  const tissue = createLayeredTissue(soft, desc, { cells, materials });
  const originalMass = tissue.mass();
  const { pieces } = soft.cutPlane(tissue, [length / 4, 0, 0], [1, 0, 0]);
  assert.equal(pieces.length, 2);
  const piece = pieces.find((piece) => piece.particlePositions().every((value, at) => at % 3 || value >= length / 4));
  assert.ok(piece);
  const expectedMass = materials.muscle.density * volume * (3 / 4) ** 3;
  close(piece.mass(), expectedMass, 'cut fragment mass', originalMass);
  close(
    pieces.reduce((mass, piece) => mass + piece.mass(), 0),
    originalMass,
    'conserved mass',
    originalMass,
  );
  for (let cell = 0; cell < piece.numCells(); cell++)
    assert.equal(piece.cellMaterialAt(cell).youngsModulus, materials.muscle.youngsModulus);
  const inside = pieces.find((candidate) => candidate !== piece);
  const moduli = new Set(
    Array.from({ length: inside.numCells() }, (_, cell) => inside.cellMaterialAt(cell).youngsModulus),
  );
  assert.deepEqual(moduli, new Set(Object.values(materials).map((material) => material.youngsModulus)));
  physics.dispose();
});

test('tissue layer validation rejects a missing material, topology mismatch and nonelastic cell', async () => {
  const { physics, soft, desc } = await specimen();
  assert.throws(
    () => createLayeredTissue(soft, desc, { cells, materials: { ...materials, fat: undefined } }),
    /lacks a layer material/,
  );
  assert.throws(() => createLayeredTissue(soft, desc, { cells: ['skin'], materials }), /must match the tetrahedra/);
  const yielding = { ...materials, fat: Object.assign(materials.fat.clone(), { yieldStrain: 0.01 }) };
  assert.throws(
    () => createLayeredTissue(soft, desc, { cells, materials: yielding }),
    /need reversible Neo-Hookean materials/,
  );
  assert.ok(createLayeredTissue(soft, desc, { cells, materials }).valid);
  physics.dispose();
});
