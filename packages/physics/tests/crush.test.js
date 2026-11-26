import assert from 'node:assert/strict';
import test from 'node:test';
import { CrushSolver, resolveCrush, resolveCrushStroke, squareTubeCrushMaterial } from '../dist/crush.js';

const close = (got, want, bound = 32 * Number.EPSILON * Math.max(1, Math.abs(want))) =>
  assert.ok(Math.abs(got - want) <= bound, `${got} differs from ${want} by more than ${bound}`);

test('the elastic barrier returns all strain energy and matches the quarter-period peak deformation', () => {
  const material = { stiffness: 400, yieldForce: 40, stroke: 0.4 };
  const m = 4;
  const speed = 0.5;
  const result = resolveCrush(material, m, speed);
  const turning = speed / Math.sqrt(material.stiffness / m);
  close(result.peakStroke, turning);
  close(result.peakForce, turning * material.stiffness);
  assert.equal(result.permanentStroke, 0);
  assert.equal(result.absorbedEnergy, 0);
  assert.equal(result.elasticEnergy, result.incidentEnergy);
  close(result.reboundSpeed, speed);
  close(result.impulse, 2 * m * speed);
});

test('perfectly plastic resistance absorbs force times crush, then unloads elastically', () => {
  const material = { stiffness: 400, yieldForce: 40, stroke: 0.4 };
  const result = resolveCrush(material, 4, 2);
  close(result.peakStroke, 0.25);
  close(result.peakForce, 40);
  close(result.permanentStroke, 0.15);
  close(result.absorbedEnergy, 40 * 0.15);
  close(result.elasticEnergy, 0.5 * 40 * 0.1);
  close(result.reboundSpeed, 1);
  close(result.impulse, 12);
});

test('linear hardening and compacted backing split work at the measured stroke', () => {
  const material = { stiffness: 200, yieldForce: 40, hardening: 100, stroke: 0.2, backingStiffness: 800 };
  const yielded = resolveCrush({ ...material, stroke: 0.5 }, 2, Math.sqrt(28.75));
  close(yielded.permanentStroke, 0.3);
  close(yielded.peakStroke, 0.65);
  close(yielded.peakForce, 70);
  close(yielded.absorbedEnergy, 16.5);
  const compacted = resolveCrush(material, 2, Math.sqrt(29));
  close(compacted.permanentStroke, 0.2);
  close(compacted.peakStroke, 0.6);
  close(compacted.peakForce, 140);
  close(compacted.absorbedEnergy, 10);
  close(compacted.elasticEnergy, 19);
  const reload = resolveCrush(material, 2, Math.sqrt(29), compacted.permanentStroke);
  assert.equal(reload.permanentStroke, compacted.permanentStroke);
  close(reload.absorbedEnergy, 0);
  close(reload.elasticEnergy, reload.incidentEnergy);
});

test('a smaller subsequent load unloads without creating additional permanent deformation', () => {
  const material = { stiffness: 200, yieldForce: 40, hardening: 100, stroke: 0.4 };
  const small = resolveCrush(material, 2, 1, 0.1);
  assert.equal(small.permanentStroke, 0.1);
  assert.equal(small.absorbedEnergy, 0);
  assert.equal(small.reboundSpeed, 1);
  close(small.peakStroke, 0.2);
});

test('imposed crush partitions hardening, unloading and backing work at their physical strokes', () => {
  const material = { stiffness: 200, yieldForce: 40, hardening: 100, stroke: 0.4, backingStiffness: 800 };
  const first = resolveCrushStroke(material, 0.5);
  close(first.force, 60);
  close(first.permanentStroke, 0.2);
  close(first.absorbedEnergy, 10);
  close(first.elasticEnergy, 9);
  const unload = resolveCrushStroke(material, 0.3, first.permanentStroke);
  close(unload.force, 20);
  close(unload.elasticEnergy, 1);
  assert.equal(unload.permanentStroke, first.permanentStroke);
  assert.equal(unload.absorbedEnergy, 0);
  close(resolveCrushStroke(material, 0.1, first.permanentStroke).force, 0);
  const compacted = resolveCrushStroke(material, 0.9, first.permanentStroke);
  close(compacted.force, 160);
  close(compacted.permanentStroke, 0.4);
  close(compacted.absorbedEnergy, 14);
  close(compacted.elasticEnergy, 28);
});

test('square tube work falls within five independent measured compression replicates', () => {
  // Yob et al. 2016, Tables 1 and 3 give dimensions and independent tensile inputs. Table 4 is hold-out.
  const material = squareTubeCrushMaterial({
    width: 0.0381,
    thickness: 0.00159,
    length: 0.2032,
    young: 69e9,
    yieldStress: 118e6,
    tensileStrength: 152e6,
  });
  const compression = resolveCrushStroke(material, 0.1);
  const observedJoules = [966.76, 897.4, 1048.77, 995.3, 948.25];
  const predictedJoules = compression.absorbedEnergy + compression.elasticEnergy;
  assert.ok(predictedJoules >= Math.min(...observedJoules) && predictedJoules <= Math.max(...observedJoules));
  const observedMean = observedJoules.reduce((sum, joules) => sum + joules, 0) / observedJoules.length;
  const observedSpread = Math.sqrt(
    observedJoules.reduce((sum, joules) => sum + (joules - observedMean) ** 2, 0) / (observedJoules.length - 1),
  );
  close(predictedJoules, observedMean, observedSpread);
  assert.ok(compression.permanentStroke > 0 && compression.permanentStroke < 0.1);
});

test('invalid curves, approaches and state reads give an actionable error', () => {
  const material = { stiffness: 100, yieldForce: 20, stroke: 0.4 };
  assert.throws(() => resolveCrush({ ...material, stiffness: 0 }, 1, 1), /Choose crush stiffness/);
  assert.throws(() => resolveCrush(material, 1, -1), /Choose crush closing speed/);
  assert.throws(() => resolveCrush(material, 1, 1, 0.5), /Choose crush prior permanent stroke/);
  assert.throws(() => resolveCrushStroke(material, -1), /Choose crush total stroke/);
  assert.throws(() => squareTubeCrushMaterial({ width: 0.02, thickness: 0.01 }), /Choose a wall thickness below half/);
  assert.throws(() => new CrushSolver().read(0), /Add CrushSolver to a PhysicsWorld/);
});
