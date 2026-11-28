import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFloodVolumeKernel, volumeBelow } from '../../dist/seakeeping.js';
import {
  equalFloodWords,
  floodBox,
  followFlood,
  refineFloodMesh,
  standaloneFlood,
} from '../fixtures/flood-volume-workers.mjs';

test('flood volume clips odd tilted cut tables bit-identically through 1, 2 and 4 native participants', async () => {
  const up = [2 / 7, 3 / 7, 6 / 7];
  const cube = floodBox([-1, -1, -1], [1, 1, 1]);
  for (const [passes, planes] of [
    [2, 47],
    [3, 55],
  ]) {
    const mesh = refineFloodMesh(cube, passes);
    const heights = Float64Array.from({ length: planes }, (_, i) => -1.7 + (3.4 * i) / (planes - 1));
    const ordered = heights.map((s) => volumeBelow(mesh, up, s));
    assert.ok(Math.abs(ordered[(planes - 1) / 2] - 4) < 1e-13);
    assert.ok(Math.abs(ordered.at(-1) - 8) < 1e-13);
    let single;
    for (const threads of [1, 2, 4]) {
      using kernel = await loadFloodVolumeKernel({ threads });
      const native = new Float64Array(planes);
      kernel.volumes(mesh, up, heights, native);
      assert.ok(equalFloodWords(native, ordered));
      const { workers, threads: actual, ...work } = kernel.workCounts();
      assert.equal(actual, threads);
      const pairs = Math.floor(planes / 2);
      assert.equal(work.projectedVertices, mesh.vertices.length / 3);
      assert.equal(work.triangleVisits, (planes * mesh.indices.length) / 3);
      assert.equal(work.trianglePairs, (pairs * mesh.indices.length) / 3);
      assert.ok(work.intersectionPairs > 0 && work.fanPairs > 0);
      assert.deepEqual(
        workers.map((row) => row.planes),
        Array.from(
          { length: threads },
          (_, i) =>
            2 * (Math.floor(((i + 1) * pairs) / threads) - Math.floor((i * pairs) / threads)) +
            Number(i === threads - 1),
        ),
      );
      if (single) assert.deepEqual(work, single);
      single = work;
    }
  }
});

test('tilted flood balances and signed HullSolver breach publication restore bit-exactly with worker volume tables', async () => {
  const reference = standaloneFlood();
  const scalar = await followFlood();
  assert.ok(scalar.exact && scalar.breaches[10] < 0, JSON.stringify(Array.from(scalar.breaches)));
  for (const threads of [1, 2, 4]) {
    using kernel = await loadFloodVolumeKernel({ threads });
    assert.deepEqual(standaloneFlood(kernel), reference);
    const observed = await followFlood(threads);
    assert.ok(observed.exact);
    assert.deepEqual(observed.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
    assert.deepEqual(observed.accepted.bytes, scalar.accepted.bytes);
    assert.deepEqual(observed.breaches, scalar.breaches);
    assert.deepEqual(observed.compartments, scalar.compartments);
    assert.deepEqual(observed.work, observed.replay.work);
    assert.ok(observed.work.batches > 2 && observed.work.fanPairs > 0 && observed.work.intersectionPairs > 0);
    assert.equal(observed.work.planes, observed.work.batches * 47);
  }
});

test('failed native clipping preserves the accepted destination and work', async () => {
  using kernel = await loadFloodVolumeKernel({ threads: 2 });
  const cube = floodBox([-1, -1, -1], [1, 1, 1]);
  const out = Float64Array.of(7, 8);
  const extreme = { ...cube, vertices: cube.vertices.map((x) => x * 1e140) };
  assert.throws(() => kernel.volumes(extreme, [0, 1, 0], Float64Array.of(0, 1), out), {
    code: 'state',
    message: /Rescale the body-local compartment mesh.+#hull-flooding/,
  });
  assert.deepEqual(out, Float64Array.of(7, 8));
  assert.equal(kernel.workCounts().batches, 0);
  const heights = Float64Array.of(0, 1);
  kernel.volumes(cube, [0, 1, 0], heights, out);
  assert.deepEqual(
    out,
    heights.map((s) => volumeBelow(cube, [0, 1, 0], s)),
  );
});
