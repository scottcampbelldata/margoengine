import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeHullSlamming, hullSections, SEA_WATER, slamStations } from '../../dist/seakeeping.js';
import { equalProfiles, followSlamming, slammingMesh } from '../fixtures/hull-slamming-workers.mjs';

test('native Wagner tables preserve scalar coefficients through actual 1, 2 and 4 Node participants', async () => {
  for (const [stations, levels, sheer] of [
    [25, 48, false],
    [57, 37, true],
  ]) {
    const mesh = slammingMesh(sheer);
    const scalar = slamStations(mesh, SEA_WATER, stations, levels);
    // The sheer hull has no breadth at its global top in any interior station, but a lower cut still enters.
    if (sheer) {
      const top = Math.max(...mesh.vertices.filter((_, i) => i % 3 === 1));
      assert.ok(hullSections(mesh, top, stations).every(({ breadth }) => breadth === 0));
    }
    assert.equal(scalar.length, stations);
    assert.ok(scalar.every(({ slope }) => slope.some((s) => s > 0)));
    let totals;
    for (const threads of [1, 2, 4]) {
      const table = await bakeHullSlamming(mesh, { stations, levels, threads });
      assert.ok(equalProfiles(table.profiles, scalar));
      assert.equal(table.stations, stations);
      assert.equal(table.levels, levels);
      const { workers, threads: actual, ...work } = table.work;
      assert.equal(actual, threads);
      assert.equal(work.stations, stations);
      assert.deepEqual(
        workers.map((row) => row.stations),
        Array.from(
          { length: threads },
          (_, i) => Math.floor(((i + 1) * stations) / threads) - Math.floor((i * stations) / threads),
        ),
      );
      assert.ok(workers.every((row) => row.samples > 0 && row.bisections > 0 && row.profileComparisons > 0));
      assert.ok(workers.every((row) => row.quadraturePairs === 16 * (row.stations + row.bisections)));
      assert.equal(work.quadraturePairs, 16 * (stations + work.bisections));
      assert.ok(2 * work.quadraturePairs < 32 * (work.samples + work.bisections));
      assert.equal(
        work.samples,
        scalar.reduce((count, row) => count + row.heights.length - 1, 0),
      );
      if (totals) assert.deepEqual(work, totals);
      totals = work;
    }
  }
});

test('HullSolver uses the native Wagner table and replays the signed body and pressure load exactly', async () => {
  const mesh = slammingMesh();
  const table = await bakeHullSlamming(mesh, { stations: 25, threads: 4 });
  const scalar = await followSlamming(mesh);
  const parallel = await followSlamming(mesh, table);
  const disabled = await followSlamming(mesh, undefined, false);
  assert.ok(scalar.exact && parallel.exact);
  assert.deepEqual(parallel.cell, [1_165_900_000, -1_048_500_000, 1_982_700_000]);
  assert.deepEqual(parallel.accepted.bytes, scalar.accepted.bytes);
  assert.equal(parallel.load, scalar.load);
  assert.ok(parallel.load > disabled.load && Number.isFinite(parallel.load));
});

test('native slamming gives corrective errors for unsupported inputs and preservation metadata', async () => {
  const mesh = slammingMesh();
  await assert.rejects(bakeHullSlamming(mesh, { threads: 3 }), {
    code: 'state',
    message: /Choose 1, 2 or 4.+#ship-seakeeping/,
  });
  const table = await bakeHullSlamming(mesh, { stations: 25 });
  const shifted = { ...mesh, vertices: mesh.vertices.map((value, i) => (i % 3 === 0 ? value + 1 : value)) };
  const shiftedTable = await bakeHullSlamming(shifted, { stations: 25 });
  assert.notEqual(shiftedTable.meshHash, table.meshHash);
  await assert.rejects(followSlamming(shifted, table), {
    code: 'unsupported',
    message: /same body-local mesh.+#ship-seakeeping/,
  });
});
