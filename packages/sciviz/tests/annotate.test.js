import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationMeasure, annotationContains, firstVolumeHit, firstGridHit } from '../dist/annotate.js';
const a = (kind, points) => ({ id: kind, kind, points });
test('physical ruler, polyline, scale and angle measurements and closed ROIs', () => {
  assert.equal(
    annotationMeasure(
      a('ruler', [
        [0, 0, 0],
        [3, 4, 0],
      ]),
    ),
    5,
  );
  assert.equal(
    annotationMeasure(
      a('scale', [
        [0, 0, 0],
        [0, 0, 2],
      ]),
    ),
    2,
  );
  assert.equal(
    annotationMeasure(
      a('angle', [
        [1, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
      ]),
    ),
    90,
  );
  assert.equal(
    annotationMeasure(
      a('angle', [
        [0, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
      ]),
    ),
    null,
  );
  assert.equal(
    annotationMeasure(
      a('polyline', [
        [0, 0, 0],
        [3, 0, 0],
        [3, 4, 0],
      ]),
    ),
    7,
  );
  assert.equal(
    annotationContains(
      a('box', [
        [3, 4, 5],
        [-1, -2, -3],
      ]),
      [3, 0, 0],
    ),
    true,
  );
  assert.equal(
    annotationContains(
      a('sphere', [
        [0, 0, 0],
        [2, 0, 0],
      ]),
      [0, 0, 2],
    ),
    true,
  );
  assert.equal(
    annotationContains(
      a('sphere', [
        [0, 0, 0],
        [2, 0, 0],
      ]),
      [0, 0, 2.00001],
    ),
    false,
  );
  assert.throws(() => annotationMeasure(a('ruler', [[0, 0, 0]])));
});
test('DDA finds the first occupied voxel exactly, from outside, inside, negative and descending axes', () => {
  const data = new Float64Array(5 * 3 * 2);
  data[2 + 5 * (1 + 3 * 1)] = 7;
  data[4 + 5 * (1 + 3 * 1)] = 9;
  const volume = { data, dims: [5, 3, 2], bounds: [0, 4, 0, 4, 0, 3] };
  const hit = firstVolumeHit(volume, [-5, 2, 3], [1, 0, 0]);
  assert.equal(hit.index, 22);
  assert.equal(hit.t, 6.5);
  assert.deepEqual(hit.position, [1.5, 2, 3]);
  assert.equal(firstVolumeHit(volume, [8, 2, 3], [-1, 0, 0]).index, 24);
  assert.equal(firstVolumeHit(volume, [2, 2, 3], [1, 0, 0]).t, 0);
  assert.equal(firstVolumeHit(volume, [-5, 9, 3], [1, 0, 0]), null);
  assert.equal(firstVolumeHit(volume, [-5, 2, 3], [1, 0, 0], (v) => v > 8).value, 9);
  assert.equal(firstVolumeHit({ ...volume, bounds: [4, 0, 0, 4, 0, 3] }, [-5, 2, 3], [1, 0, 0]).value, 9);
  assert.throws(() => firstVolumeHit(volume, [0, 0, 0], [0, 0, 0]));
});
test('DDA has no stride or 2048-step cap and handles simultaneous corner crossings', () => {
  const data = new Float32Array(4096 * 2 * 2);
  data[4095] = 3;
  assert.equal(firstVolumeHit({ data, dims: [4096, 2, 2] }, [-1, 0, 0], [1, 0, 0]).index, 4095);
  const corner = new Float32Array(8);
  corner[7] = 1;
  assert.equal(firstVolumeHit({ data: corner, dims: [2, 2, 2] }, [-1, -1, -1], [1, 1, 1]).index, 7);
});
test('first grid boundary hit retains owning cell ID and picks two-sided triangles', () => {
  const grid = {
    points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    connectivity: new Uint32Array([0, 1, 2, 3]),
    offsets: new Uint32Array([4]),
    types: new Uint8Array([10]),
  };
  const hit = firstGridHit(grid, [0.1, 0.1, -1], [0, 0, 1]);
  assert.equal(hit.cell, 0);
  assert.equal(hit.t, 1);
  assert.deepEqual(hit.position, [0.1, 0.1, 0]);
  assert.equal(firstGridHit(grid, [5, 5, -1], [0, 0, 1]), null);
  const back = firstGridHit(grid, [0.1, 0.1, 5], [0, 0, -1]);
  assert.ok(back && back.t > 0);
});
