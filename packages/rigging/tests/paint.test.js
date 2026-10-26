import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeightMap, WeightPainter, boneHeatWeights } from '../dist/index.js';
import { chain, rowSums, split, tube } from './fixtures.js';

const sumsToOne = (map) => rowSums(map).every((sum) => Math.abs(sum - 1) < 1e-5);

test('add, subtract and replace keep every vertex normalised and undo restores it', async () => {
  const mesh = tube(),
    weights = await boneHeatWeights(mesh, chain),
    before = weights.values.slice(),
    painter = new WeightPainter(weights, mesh, { parents: [-1, 0, 1] }),
    center = [0.2, 0.5, 0], // on the surface, a quarter of the way up: base-owned
    v = 4 * 12; // ring 4's first vertex, at (0.2, 0.5, 0)
  assert.ok(weights.get(v, 1) < 0.1);
  const added = painter.stroke({ mode: 'add', bone: 1, center, radius: 0.3, strength: 0.6 });
  assert.ok(Math.abs(weights.get(v, 1) - (before[v * 3 + 1] + 0.6)) < 1e-5, 'full strength at the centre');
  assert.ok(sumsToOne(weights));
  assert.ok(added.vertices.length > 1 && added.vertices.length < weights.vertexCount);
  // The brush fades out: a vertex near the rim gains less than the centre.
  const rim = 4 * 12 + 2; // same ring, 60 degrees round: 0.2 away
  assert.ok(weights.get(rim, 1) - before[rim * 3 + 1] < 0.6 * 0.3);
  const subtracted = painter.stroke({ mode: 'subtract', bone: 1, center, radius: 0.3, strength: 1 });
  assert.equal(weights.get(v, 1), 0);
  assert.ok(sumsToOne(weights));
  const replaced = painter.stroke({ mode: 'replace', bone: 2, center, radius: 0.3, strength: 1, value: 0.25 });
  assert.ok(Math.abs(weights.get(v, 2) - 0.25) < 1e-6);
  assert.ok(sumsToOne(weights));
  for (const edit of [replaced, subtracted, added]) edit.undo();
  assert.deepEqual(weights.values, before);
});

test('locked bones keep their weights; a locked bone cannot be painted', async () => {
  const mesh = tube(),
    weights = await boneHeatWeights(mesh, chain),
    painter = new WeightPainter(weights, mesh, { locked: [0] }),
    v = 8 * 12,
    base = weights.get(v, 0);
  painter.stroke({ mode: 'add', bone: 1, center: [0.2, 1, 0], radius: 0.4, strength: 1 });
  assert.equal(weights.get(v, 0), base);
  assert.ok(Math.abs(weights.get(v, 1) - (1 - base)) < 1e-6, 'the free share all goes to the painted bone');
  assert.ok(sumsToOne(weights));
  assert.throws(() => painter.stroke({ mode: 'add', bone: 0, center: [0, 1, 0], radius: 1 }), /locked/);
});

test('subtracting from a single-bone vertex passes the weight to the parent', () => {
  const mesh = tube(),
    weights = new WeightMap(mesh.positions.length / 3, 3);
  for (let v = 0; v < weights.vertexCount; v++) weights.set(v, 1, 1);
  const painter = new WeightPainter(weights, mesh, { parents: [-1, 0, 1] });
  painter.stroke({ mode: 'subtract', bone: 1, center: [0.2, 1, 0], radius: 0.2, strength: 0.4, falloff: 'constant' });
  assert.ok(Math.abs(weights.get(8 * 12, 1) - 0.6) < 1e-6);
  assert.ok(Math.abs(weights.get(8 * 12, 0) - 0.4) < 1e-6);
  // Without parents nothing can take the weight, so the vertex keeps it (it never drops below a sum of 1).
  const alone = new WeightMap(weights.vertexCount, 3);
  for (let v = 0; v < alone.vertexCount; v++) alone.set(v, 1, 1);
  new WeightPainter(alone, mesh).stroke({ mode: 'subtract', bone: 1, center: [0.2, 1, 0], radius: 0.2, strength: 1 });
  assert.equal(alone.get(8 * 12, 1), 1);
});

test('smoothing blurs a hard edge and duplicates stay together', async () => {
  const mesh = split(tube({ rings: 8, sides: 8 })),
    weights = new WeightMap(mesh.positions.length / 3, 2);
  for (let v = 0; v < weights.vertexCount; v++) weights.set(v, mesh.positions[v * 3 + 1] < 1 ? 0 : 1, 1);
  for (let v = 0; v < weights.vertexCount; v++) weights.set(v, 1 - weights.get(v, 1), 0);
  const painter = new WeightPainter(weights, mesh),
    edit = painter.smoothAll({ iterations: 3, strength: 0.5 });
  assert.ok(sumsToOne(weights));
  // A vertex just below y = 1 now carries some of bone 1.
  let below = -1;
  for (let v = 0; v < weights.vertexCount; v++) if (Math.abs(mesh.positions[v * 3 + 1] - 0.75) < 1e-6) below = v;
  assert.ok(weights.get(below, 1) > 0.05 && weights.get(below, 1) < 0.5);
  // Every split copy of one point has the same weights.
  const byPoint = new Map();
  for (let v = 0; v < weights.vertexCount; v++) {
    const key = Array.from(mesh.positions.slice(v * 3, v * 3 + 3)).join(),
      w = weights.get(v, 1);
    if (byPoint.has(key)) assert.equal(byPoint.get(key), w);
    else byPoint.set(key, w);
  }
  edit.undo();
  assert.equal(weights.get(below, 1), 0);
  const dab = painter.stroke({ mode: 'smooth', center: [0.2, 1, 0], radius: 0.5, strength: 1 });
  assert.ok(dab.vertices.length > 0);
  assert.ok(sumsToOne(weights));
});

test('painter input checks', () => {
  const mesh = tube(),
    weights = new WeightMap(mesh.positions.length / 3, 2);
  assert.throws(() => new WeightPainter(new WeightMap(3, 2), mesh), RangeError);
  assert.throws(() => new WeightPainter(weights, mesh, { parents: [-1] }), RangeError);
  assert.throws(() => new WeightPainter(weights, mesh, { locked: [5] }), RangeError);
  const painter = new WeightPainter(weights, mesh);
  assert.throws(() => painter.stroke({ mode: 'blur', bone: 0, center: [0, 0, 0], radius: 1 }), RangeError);
  assert.throws(() => painter.stroke({ mode: 'add', bone: 4, center: [0, 0, 0], radius: 1 }), RangeError);
  assert.throws(() => painter.stroke({ mode: 'add', bone: 0, center: [0, 0, 0], radius: 0 }), RangeError);
  assert.throws(() => painter.stroke({ mode: 'add', bone: 0, center: [0, 0], radius: 1 }), RangeError);
  assert.throws(() => painter.stroke({ mode: 'add', bone: 0, center: [0, 0, 0], radius: 1, strength: 2 }), RangeError);
  assert.throws(() => painter.smoothAll({ iterations: 0 }), RangeError);
});
