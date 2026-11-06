import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { CulledParts, groupParts } from '../dist/parts.js';

const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const batches = () => [
  {
    geometry: box(),
    material: new PbrMaterial({ color: [1, 0, 0] }),
    transforms: new Float32Array([...translate(0, 0, 0), ...translate(4, 0, 0)]),
  },
  {
    geometry: box(0.5),
    material: new PbrMaterial({ color: [0, 1, 0], doubleSided: false }),
    transforms: new Float32Array(translate(0, 3, 0)),
  },
];
const record = (parts, i) => [...parts.records.subarray(i * 24 + 16, i * 24 + 24)];

test('a batch holds a material per part: records carry them, a wrong list is refused', () => {
  const red = new PbrMaterial({ color: [1, 0, 0], roughness: 0.25, metalness: 0.75 }),
    blue = new PbrMaterial({ color: [0, 0, 1] }),
    base = {
      geometry: box(),
      material: blue,
      transforms: new Float32Array([...translate(0, 0, 0), ...translate(2, 0, 0)]),
    };
  const parts = new CulledParts([{ ...base, materials: [red, blue] }]);
  assert.deepEqual(record(parts, 0), [1, 0, 0, 1, 0.25, 0.75, 1, -1]);
  assert.deepEqual(record(parts, 1).slice(0, 3), [0, 0, 1]);
  assert.throws(() => new CulledParts([{ ...base, materials: [red] }]), /one PbrMaterial per part/);
  assert.throws(() => new CulledParts([{ ...base, materials: [red, {}] }]), /one PbrMaterial per part/);
});

test('setColor and setMaterial write one record, leave what they do not name, and mark only that part', () => {
  const parts = new CulledParts(batches());
  parts.low = Infinity;
  parts.high = 0;
  parts.setColor(0, 1, [0.25, 0.5, 0.75]);
  parts.setMaterial(0, 1, { roughness: 0.5, metalness: 0.25 });
  assert.deepEqual(parts.getMaterial(0, 1), {
    color: [0.25, 0.5, 0.75],
    roughness: 0.5,
    metalness: 0.25,
    doubleSided: true,
  });
  assert.equal(record(parts, 1)[7], -1, 'the part still names no core mesh');
  assert.deepEqual(record(parts, 0).slice(0, 3), [1, 0, 0]);
  assert.deepEqual([parts.low, parts.high], [1, 2], 'the next upload covers that part alone');
  parts.setColor(0, 0, '#ffffff');
  assert.deepEqual(parts.getMaterial(0, 0).color, [1, 1, 1]);
  assert.throws(() => parts.setMaterial(0, 0, { roughness: 2 }), /Invalid material/);
  assert.throws(() => parts.setColor(5, 0, '#ffffff'), RangeError);
});

test('a later material.set does not reach a part', () => {
  const own = new PbrMaterial({ color: [1, 0, 0] }),
    parts = new CulledParts(batches());
  parts.setMaterial(0, 0, own);
  own.set({ color: [0, 1, 0] });
  assert.deepEqual(parts.getMaterial(0, 0).color, [1, 0, 0]);
});

test('a part that differs in sidedness moves its batch off the back-culled pipeline and onto the sided prepass', () => {
  const parts = new CulledParts(batches()),
    back = (batch) => parts.backFaces(batch),
    sided = (batch) => parts.singleSided(batch);
  // Batch 0 is double-sided and batch 1 single-sided.
  assert.deepEqual([back(0), back(1), sided(0), sided(1)], [true, false, false, true]);
  parts.setMaterial(1, 0, { doubleSided: true });
  assert.equal(back(1), true);
  parts.setMaterial(0, 1, { doubleSided: false });
  assert.equal(sided(0), true, 'a double-sided batch must not write the back faces of its single-sided part');
  parts.setMaterial(1, 0, { doubleSided: false });
  parts.setMaterial(0, 1, { doubleSided: true });
  assert.deepEqual([back(1), sided(0)], [false, false]);
});

test('a freed slot goes back to the batch material, and addParts can colour its parts', () => {
  const b = batches()[1],
    parts = new CulledParts([{ ...b, capacity: 3 }]);
  parts.setMaterial(0, 0, { color: [0, 0, 1], doubleSided: true });
  assert.equal(parts.backFaces(0), true);
  parts.removeParts(0, [0]);
  assert.equal(parts.backFaces(0), false, 'a removed part no longer counts');
  const [plain] = parts.addParts(0, new Float32Array(translate(1, 1, 1)));
  assert.deepEqual(parts.getMaterial(0, plain).color, [0, 1, 0]);
  const [painted] = parts.addParts(0, new Float32Array(translate(2, 2, 2)), [new PbrMaterial({ color: [1, 1, 0] })]);
  assert.deepEqual(parts.getMaterial(0, painted).color, [1, 1, 0]);
  assert.throws(() => parts.addParts(0, new Float32Array(translate(3, 3, 3)), []), /one PbrMaterial per new part/);
  assert.equal(parts.count, 2, 'a refused add adds nothing');
});

test('groupParts makes one batch per geometry and says where each item went', () => {
  const a = box(),
    b = box(0.5),
    paint = (color) => new PbrMaterial({ color });
  const { batches: list, places } = groupParts([
    { geometry: a, material: paint([1, 0, 0]), matrix: translate(0, 0, 0) },
    { geometry: b, material: paint([0, 1, 0]), matrix: translate(1, 0, 0) },
    { geometry: a, material: paint([0, 0, 1]), matrix: translate(2, 0, 0) },
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(places, [
    { batch: 0, index: 0 },
    { batch: 1, index: 0 },
    { batch: 0, index: 1 },
  ]);
  const parts = new CulledParts(list);
  assert.deepEqual(parts.getMaterial(0, 1).color, [0, 0, 1]);
  assert.equal(parts.getWorldMatrix(0, 1)[12], 2);
  assert.throws(() => groupParts([{ geometry: a, material: paint([1, 0, 0]), matrix: [] }]), /16 matrix values/);
});
