import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { sectionArea } from '../../dist/entry.js';
import { worldMemory } from '../../dist/world.js';
import { entryMesh, entryProfileRun } from '../fixtures/entry-profile-workers.mjs';

for (const [sides, rings] of [
  [23, 7],
  [41, 13],
]) {
  test(`native water-entry clipping matches scalar in a signed-cell rigid world on the ${sides}×${rings} mesh`, async () => {
    const ref = await entryProfileRun(sides, rings, 0);
    assert.ok(
      ref.accepted.splashes.some(({ kind }) => kind === 'entry'),
      'the measured step is a real entry',
    );
    assert.ok(ref.accepted.velocity[1] > -4.3 - (9.81 * 8) / 240, 'the rigid body descends slower than in free fall');
    let one;
    for (const threads of [1, 2, 4]) {
      const run = await entryProfileRun(sides, rings, threads);
      const { accepted, replay } = run;
      assert.deepEqual(run.start.bytes, ref.start.bytes);
      assert.deepEqual(accepted.snapshot.bytes, ref.accepted.snapshot.bytes);
      assert.deepEqual(accepted.fields, ref.accepted.fields);
      assert.deepEqual(accepted.splashes, ref.accepted.splashes);
      assert.deepEqual(accepted.sources, ref.accepted.sources);
      assert.deepEqual(accepted.velocity, ref.accepted.velocity);
      assert.deepEqual(replay, accepted);
      assert.deepEqual(run.restoredCell, run.initialCell);
      assert.equal(accepted.cell[0], run.initialCell[0] - 1);
      const work = accepted.work;
      assert.equal(work.threads, threads);
      assert.ok(work.profiles > 0);
      assert.equal(work.projectedVertices, work.profiles * (sides * rings + 2));
      assert.equal(work.planes, work.profiles * 40);
      assert.equal(work.triangleVisits, work.planes * (2 * sides * rings));
      assert.equal(work.trianglePairs, work.triangleVisits / 2);
      assert.ok(work.intersectionPairs > 0 && work.fanPairs > 0);
      assert.equal(work.workers.length, threads);
      for (const [part, worker] of work.workers.entries()) {
        assert.equal(worker.planes, work.planes / threads);
        assert.equal(worker.trianglePairs, work.trianglePairs / threads);
        assert.ok(worker.intersectionPairs > 0 && worker.fanPairs > 0);
        assert.equal(worker.projectedVertices, part === 0 ? work.projectedVertices : 0);
      }
      const { workers: _workers, threads: _threads, ...total } = work;
      one ??= total;
      assert.deepEqual(total, one);
    }
  });
}

test('native signed oblique plane areas match the ordered scalar triangles, including an odd plane and vertex tail', async () => {
  const bytes = await readFile(new URL('../../dist/entry-profile-kernel.wasm', import.meta.url));
  const memory = worldMemory(false);
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  instance.exports.__stack_pointer.value = memory.buffer.byteLength;
  const mesh = entryMesh(1, 23, 7);
  const normal = [2 / 7, 6 / 7, -3 / 7];
  const points = mesh.vertices.map((x, i) => x + [3.75, -1.4, 6.25][i % 3]);
  const heights = Array.from({ length: 41 }, (_, i) => -3.4 + 0.063 * i);
  const vertexCount = points.length / 3;
  const triangleCount = mesh.indices.length / 3;
  const positions = 128;
  const projected = positions + points.byteLength;
  const planes = projected + 8 * vertexCount;
  const areas = planes + 8 * heights.length;
  const work = areas + 8 * heights.length;
  const indices = work + 6 * 8;
  new Uint32Array(memory.buffer, 0, 10).set([
    positions,
    indices,
    projected,
    planes,
    areas,
    work,
    vertexCount,
    triangleCount,
    heights.length,
    0,
  ]);
  new Float64Array(memory.buffer, 40, 3).set(normal);
  new Float64Array(memory.buffer, positions, points.length).set(points);
  new Float64Array(memory.buffer, planes, heights.length).set(heights);
  new Uint32Array(memory.buffer, indices, mesh.indices.length).set(mesh.indices);
  assert.equal(instance.exports.entry_profile_project(0), 0);
  assert.equal(instance.exports.entry_profile_thread_phase(0, 0, 0, 1), 0);
  const calculated = [...new Float64Array(memory.buffer, areas, heights.length)];
  assert.deepEqual(
    calculated,
    heights.map((level) => sectionArea(points, mesh.indices, normal, level)),
  );
  assert.ok(calculated.some((area) => area > 1));
  const receipt = new Float64Array(memory.buffer, work, 6);
  assert.deepEqual([...receipt.slice(0, 4)], [vertexCount, 41, 41 * triangleCount, 20 * triangleCount]);
  assert.ok(receipt[4] > 0 && receipt[5] > 0);
});
