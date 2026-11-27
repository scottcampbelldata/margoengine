import assert from 'node:assert/strict';
import test from 'node:test';
import { finiteQuayPointSource, FiniteQuayWake } from '../../dist/loads.js';
import { SUBMERGED_WAKE_LAYOUT } from '../../dist/sea.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const dt = 1 / 60;
const g = 9.81;
const cells = [10, 4];
const dx = 0.25;
const dy = 0.2;
const depths = [0, dy, 2 * dy, 3 * dy, 4 * dy];

function fixture(rows, shared, wet) {
  const points = finiteQuayPointSource('hull.points');
  const wake = new FiniteQuayWake('wake', { points });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -g, 0], memory: worldMemory(shared) });
  let host, region;
  const driver = {
    describe: () => ({
      id: 'hull',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: points, access: 'write' }],
    }),
    init(allocated) {
      host = allocated;
      region = host.allocate('points', rows.length * 8, 'f64', SUBMERGED_WAKE_LAYOUT);
    },
    step({ tick }) {
      const values = regionWords(host.memory, region);
      if (tick === 0) values.set(rows);
      else values.fill(0);
    },
    exportPorts: (tick) => [{ field: points.name, region, tick, cell: host.cell }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
  world.add(driver, undefined).add(wake, { cells, cellSize: dx, depths, wet });
  world.couple(['hull', 'wake'], 'staggered');
  return { world, wake };
}

test('point-depth hull displacement matches the normal-mode volume pairing and exact replay', () => {
  const [nx, nz] = cells;
  const bed = depths.at(-1);
  const k = (2 * Math.PI) / (nx * dx);
  const kh = (2 / dx) * Math.sin((k * dx) / 2);
  const alpha = (2 / dy) * Math.asinh((kh * dy) / 2);
  const conductance = (2 / dy) * Math.tanh(alpha * bed) * Math.tanh((alpha * dy) / 2);
  const vertical = (depth) => Math.cosh(alpha * (bed - depth)) / (Math.cosh(alpha * bed) * Math.cosh((alpha * dy) / 2));
  const robin = g * (dt / 2) ** 2 * conductance;
  const radius = dx / 4;
  const deepX = 3.5 * dx,
    deep = 0.34,
    deepVolume = 0.002;
  const topX = 6.5 * dx,
    top = 0.03,
    topVolume = -0.0006;
  const z = 1.5 * dx;
  const deepFraction = (deep - 0.3) / 0.2;
  const topFraction = top / (dy / 2);
  const depthPair =
    (deepVolume * Math.cos(k * deepX) * ((1 - deepFraction) * vertical(0.3) + deepFraction * vertical(0.5)) +
      topVolume * Math.cos(k * topX) * (1 - topFraction + topFraction * vertical(0.1))) *
    ((1 - robin) / (1 + robin));

  const hashes = [false, true].map((shared) => {
    const { world, wake } = fixture([deepX, z, radius, deep, deepVolume, topX, z, radius, top, topVolume], shared);
    const start = world.takeSnapshot();
    world.advance(1);
    const height = wake.heights();
    assert.equal(height.length, nx * nz);
    const paired = height.reduce((sum, value, i) => sum + value * Math.cos(k * ((i % nx) + 0.5) * dx), 0) * dx ** 2;
    assert.ok(Math.abs(paired - depthPair) < 1e-12, `${paired} differs from ${depthPair}`);
    assert.ok(Math.abs(wake.work().displacedVolume - deepVolume - topVolume) < 1e-12);
    assert.ok(Math.abs(wake.energy() - wake.work().joules) < 1e-10);
    world.advance(13);
    const hash = world.hash();
    world.restoreSnapshot(start.bytes);
    world.advance(13);
    assert.equal(world.hash(), hash);
    return hash;
  });
  assert.equal(hashes[0], hashes[1]);
});

test('point depth uses only wet connected layers and rejects volumes beyond the bed', () => {
  const plane = cells[0] * cells[1];
  const wet = new Uint8Array(4 * plane).fill(1);
  const x = 3.5 * dx,
    z = 1.5 * dx,
    inside = 3 + cells[0];
  wet[inside] = 0;
  const { world, wake } = fixture([x, z, dx, 0.21, 0.001], false, wet);
  world.advance(2);
  assert.equal(wake.heights()[inside], 0);
  assert.ok(Math.abs(wake.work().displacedVolume - 0.001) < 1e-12);
  assert.ok(Math.abs(wake.energy() - wake.work().joules) < 1e-10);
  const invalid = fixture([x, z, dx, 1, 0.001], false, wet);
  assert.throws(() => invalid.world.advance(1), /point depths between still water and the bed/);
  assert.equal(invalid.wake.energy(), 0);
  assert.equal(invalid.wake.work().joules, 0);
});
