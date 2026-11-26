import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePlateBuckling } from '../dist/crush.js';

const plate = { length: 0.6, width: 0.3, thickness: 0.003, young: 200e9, poisson: 0.3 };
const close = (got, want, bound = 64 * Number.EPSILON * Math.max(1, Math.abs(want))) =>
  assert.ok(Math.abs(got - want) <= bound, `${got} differs from ${want} by more than ${bound}`);

function rigidity({ thickness, poisson, young }) {
  return (young * thickness ** 3) / (12 * (1 - poisson ** 2));
}

test('a pinned rectangular plate selects the lowest mode, buckles and keeps positive tangent load', () => {
  const critical = (4 * Math.PI ** 2 * rigidity(plate)) / plate.width;
  const compression = critical / (plate.young * plate.width * plate.thickness);
  const at = (fraction) => resolvePlateBuckling(plate, fraction * compression * plate.length);
  assert.equal(at(0.5).halfWaves, 2);
  close(at(0.5).criticalForce, critical);
  close(at(0.5).force, critical / 2);
  assert.equal(at(0.5).crest, 0);
  close(at(1.5).force, 1.25 * critical);
  close(at(2).force, 1.5 * critical);
  assert.ok(at(2).crest > at(1.5).crest && at(1.5).crest > 0);
});

test('surface samples preserve support edges and reproduce the signed crest and unit normals', () => {
  const { length, width } = plate;
  const x = length / 4;
  const y = width / 2;
  const dx = 1e-6;
  const response = resolvePlateBuckling(plate, 0.0014, [0, y, length, y, x, 0, x, y, 3 * x, y, x + dx, y]);
  const { positions, normals } = response.surface;
  assert.equal(positions[2], 0);
  assert.equal(positions[5], 0);
  assert.equal(positions[8], 0);
  close(positions[3], length - 0.0014);
  close(positions[11], response.crest);
  close(positions[14], -response.crest);
  close(normals[9], 0);
  close(normals[10], 0);
  close(normals[11], 1);
  for (let i = 0; i < normals.length; i += 3) close(Math.hypot(normals[i], normals[i + 1], normals[i + 2]), 1);
  const slope = (positions[17] - positions[11]) / (positions[15] - positions[9]);
  const normalSlope = -normals[15] / normals[17];
  // A one-sided finite difference brackets the exact slope from zero at the crest to the next sample.
  assert.ok(slope < 0 && slope > normalSlope);
});

test('a measured initial crest is stress-free and selects the stable signed branch under compression', () => {
  const initialCrest = -0.0005;
  const crooked = { ...plate, initialCrest };
  const flat = resolvePlateBuckling(plate, 0.0002);
  const initial = resolvePlateBuckling(crooked, 0);
  assert.equal(initial.crest, initialCrest);
  assert.equal(initial.force, 0);
  const loaded = resolvePlateBuckling(crooked, 0.0002);
  assert.ok(loaded.crest < initialCrest);
  assert.ok(loaded.force > 0 && loaded.force < flat.force);
  const k = Math.PI / plate.width;
  const geometric = (k * k * (loaded.crest ** 2 - initialCrest ** 2)) / 8;
  const axialStrain = loaded.force / (plate.young * plate.width * plate.thickness);
  close(axialStrain + geometric, 0.0002 / plate.length);
  const critical = loaded.criticalForce / (plate.young * plate.width * plate.thickness);
  close(axialStrain, critical * (1 - initialCrest / loaded.crest) + geometric);
});

test('the first plate mode predicts early measured compression of Stein’s unstiffened bay', () => {
  // NASA R-40 (1959), Appendix and Fig. 3. Dimensionless experimental trace read from the printed axes.
  const inches = 0.0254;
  const bay = { length: 25.36 * inches, width: 4.71 * inches, thickness: 0.072 * inches, young: 73e9, poisson: 1 / 3 };
  const scale = (3 * (1 - bay.poisson ** 2) * (bay.width / bay.thickness) ** 2) / Math.PI ** 2;
  const measured = [
    [1.25, 1.13],
    [1.5, 1.27],
    [1.75, 1.42],
  ];
  for (const [shortening, load] of measured) {
    const result = resolvePlateBuckling(bay, (shortening * bay.length) / scale);
    assert.equal(result.halfWaves, 5);
    const normalizedForce = (result.force * bay.width) / (4 * Math.PI ** 2 * rigidity(bay));
    // About 4.5 vertical pixels at 340 dpi for the line thickness and rounding at the printed grid.
    close(normalizedForce, load, 0.02);
  }
});

test('plate surface data and physical inputs fail with an actionable error', () => {
  assert.throws(() => resolvePlateBuckling(plate, plate.length), {
    code: 'state',
    message: /below its undeformed length/,
  });
  assert.throws(() => resolvePlateBuckling(plate, 0, [0]), { code: 'state', message: /as pairs/ });
  assert.throws(() => resolvePlateBuckling(plate, 0, [-1, 0]), {
    code: 'state',
    message: /inside the authored length/,
  });
  assert.throws(() => resolvePlateBuckling({ ...plate, poisson: 0.5 }, 0), { code: 'state', message: /Poisson/ });
});
