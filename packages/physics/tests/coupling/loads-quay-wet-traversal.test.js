import assert from 'node:assert/strict';
import test from 'node:test';
import { finiteQuayPointSource, FiniteQuayWake, QuayPotential } from '../../dist/loads.js';
import { SUBMERGED_WAKE_LAYOUT, WAKE_SOURCE_LAYOUT } from '../../dist/sea.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

test('wet-only quay traversals preserve dense projection, source work and byte-exact seek', (t) => {
  const cells = [32, 18],
    plane = cells[0] * cells[1],
    cellSize = 0.25,
    depths = [0, 0.05, 0.12, 0.29, 0.66, 1.05, 1.7];
  const wet = new Uint8Array(plane * (depths.length - 1));
  const openZ = new Float64Array(wet.length).fill(1);
  for (let layer = 0; layer + 1 < depths.length; layer++) {
    wet.fill(1, layer * plane, layer * plane + (layer < 4 ? 4 : 13) * cells[0]);
    for (let x = 7; x <= 20; x++) openZ[layer * plane + 3 * cells[0] + x] = x === 7 ? 0.2 : 0;
  }
  const grid = { cells, cellSize, depths, wet, openZ, horizontalOrder: 4 };
  assert.equal(new QuayPotential({ cells, cellSize, depths }).active, undefined);
  const dense = new QuayPotential(grid);
  const sparse = new QuayPotential(grid);
  // Force the production fallback on identical geometry, with the same coarse graph and sources.
  dense.active = undefined;
  const active = sparse.active;
  const wetIndices = Array.from(wet.keys()).filter((i) => wet[i]);
  assert.deepEqual(active, Uint32Array.from(wetIndices));
  let visits = 0;
  sparse.active = new Proxy(active, {
    get(target, key) {
      if (key !== 'length') visits++;
      return Reflect.get(target, key, target);
    },
  });
  const surface = Float64Array.from({ length: plane }, (_, i) => Math.sin(0.21 * i) * 0.04);
  const source = new Float64Array(wet.length);
  source[5 * plane + 6 * cells[0] + 8] = 0.00125;
  source[4 * plane + 8 * cells[0] + 22] = -0.00125;
  function solve(operator, values, forcing, robin) {
    const rise = new Float64Array(plane).fill(9);
    const bulk = new Float64Array(wet.length).fill(7);
    const iterations = operator.project(values, rise, forcing, robin, bulk);
    return { rise, bulk, iterations };
  }
  for (const [forcing, robin] of [
    [source, 0.001],
    [undefined, 0],
    [source, 0.002],
  ]) {
    visits = 0;
    const reference = solve(dense, surface, forcing, robin);
    const result = solve(sparse, surface, forcing, robin);
    assert.deepEqual(result, reference);
    assert.ok(result.iterations > 0 && result.bulk.some((value, i) => wet[i] && value !== 0));
    assert.ok(result.bulk.every((value, i) => wet[i] || Object.is(value, 0)));
    // Includes setup, the matrix and column sweeps, coarse transfers and the basin mean recovery.
    const sweeps = 18 + (forcing ? 1 : 0) + 18 * result.iterations;
    assert.equal(visits, sweeps * wetIndices.length);
    assert.ok(visits < (sweeps * wet.length) / 2);
    if (robin === 0.001)
      t.diagnostic(
        JSON.stringify({ iterations: result.iterations, wetVisits: visits, denseVisits: sweeps * wet.length }),
      );
  }
  const rejected = source.slice();
  rejected[plane - 1] = 1;
  for (const operator of [dense, sparse]) {
    const rise = new Float64Array(plane).fill(9);
    const bulk = new Float64Array(wet.length).fill(7);
    assert.throws(
      () => operator.project(surface, rise, rejected, 0, bulk),
      /put each finite volume source inside a wet cell/,
    );
    assert.ok(rise.every((value) => value === 9) && bulk.every((value) => value === 7));
  }

  const surfaceSource = {
    name: 'surface',
    quantity: 'seaSource',
    kind: 'surfaceSampleSet',
    centring: 'particle',
    unit: 'SI',
  };
  const points = finiteQuayPointSource('depth');
  function worldRun(denseTraversal) {
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
    const wake = new FiniteQuayWake('quay', { surface: surfaceSource, points });
    let host, top, bottom;
    const driver = {
      describe: () => ({
        id: 'driver',
        rate: 0,
        stableRate: () => 0,
        fields: [surfaceSource, points].map((field) => ({ field, access: 'write' })),
      }),
      init(allocated) {
        host = allocated;
        top = host.allocate('surface', 5 * 8, 'f64', WAKE_SOURCE_LAYOUT);
        bottom = host.allocate('depth', 5 * 8, 'f64', SUBMERGED_WAKE_LAYOUT);
      },
      step({ tick }) {
        regionWords(host.memory, top).set([1.875, 0.375, 0.22, tick < 5 ? 192 : 0, tick < 5 ? 0.001 : 0]);
        regionWords(host.memory, bottom).set([2.125, 1.625, 0.22, 1.2, tick < 5 ? 0.001 : 0]);
      },
      exportPorts: (tick) => [
        { field: surfaceSource.name, region: top, tick, cell: host.cell },
        { field: points.name, region: bottom, tick, cell: host.cell },
      ],
      stateRegions: () => [top, bottom],
      extraState: () => [],
      importPorts() {},
    };
    world.add(driver, undefined).add(wake, {
      ...grid,
      temporalOrder: 4,
      sponge: { cells: 2, rate: 3 },
      pressureAtDepth: true,
      initial: (x, z) => [0.04 * Math.exp(-((x - 2) ** 2 + (z - 0.6) ** 2)), 0.01 * Math.cos(x)],
    });
    if (denseTraversal) wake.operator.active = undefined;
    const start = world.takeSnapshot();
    world.advance(6);
    const intermediate = world.takeSnapshot();
    world.advance(12);
    const receipt = { hash: world.hash(), bytes: world.takeSnapshot().bytes, work: wake.work() };
    assert.ok(receipt.work.joules > 0 && receipt.work.absorbedJoules > 0 && receipt.work.displacedVolume > 0);
    for (const snapshot of [start, intermediate]) {
      world.restoreSnapshot(snapshot.bytes);
      world.advance(12);
      assert.equal(world.hash(), receipt.hash);
      assert.deepEqual(world.takeSnapshot().bytes, receipt.bytes);
    }
    return receipt;
  }
  const accepted = worldRun(true);
  assert.deepEqual(worldRun(false), accepted);
  t.diagnostic(JSON.stringify({ hash: accepted.hash, work: accepted.work }));
});
