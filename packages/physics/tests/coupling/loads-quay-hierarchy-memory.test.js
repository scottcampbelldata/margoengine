import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { FiniteQuayWake, QuayPotential } from '../../dist/loads.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

function apertureGrid() {
  const cells = [39, 19],
    plane = cells[0] * cells[1],
    depths = [0, 0.035, 0.13, 0.3, 0.65, 1.25, 1.9];
  const count = plane * (depths.length - 1);
  const wet = new Uint8Array(count);
  const openX = new Float64Array(count).fill(1),
    openZ = new Float64Array(count).fill(1);
  for (let layer = 0; layer + 1 < depths.length; layer++) {
    const offset = layer * plane;
    wet.fill(1, offset, offset + (layer < 4 ? 4 : 13) * cells[0]);
    for (let z = 0; z < 4; z++) openX[offset + z * cells[0] + 22] = 0;
    for (let x = 6; x <= 18; x++) openZ[offset + 3 * cells[0] + x] = x === 6 ? 0.15 : 0;
  }
  return { cells, cellSize: 0.25, depths, wet, openX, openZ, horizontalOrder: 4 };
}

test('bounded Galerkin hierarchy assembly preserves the dense-parent edge order and accepted state', (t) => {
  const grid = apertureGrid();
  const potential = new QuayPotential(grid);
  const digest = createHash('sha256');
  const face = Buffer.alloc(17);
  const levels = [];
  const pages = [];
  for (let coarse = potential.coarse; coarse; coarse = coarse.child) {
    const { graph, labels } = coarse;
    digest.update(labels).update(graph.coordinates).update(graph.ground);
    let edges = 0;
    let closed = 0;
    graph.faces((a, b, weight, protectedFace) => {
      face.writeInt32LE(a, 0);
      face.writeInt32LE(b, 4);
      face.writeDoubleLE(weight, 8);
      face[16] = Number(protectedFace);
      digest.update(face);
      edges++;
      if (protectedFace && weight === 0) closed++;
    });
    levels.push({ size: graph.size, edges, closed });
    let edgeBytes = 0;
    for (const { from, to, weights, barriers } of graph.edgePages) {
      assert.ok(from.length <= 8192);
      edgeBytes += from.byteLength + to.byteLength + weights.byteLength + barriers.byteLength;
    }
    pages.push(graph.edgePages.length);
    assert.equal(edgeBytes, 17 * edges);
  }
  const hierarchyHash = digest.digest('hex');
  // Captured from the unmodified 6119b80d6d hierarchy on this integral mask and aperture.
  assert.equal(hierarchyHash, '090ad32e90312d66f06406e97ddd1f582ce5bec258435261ba6698d62e77e864');
  assert.deepEqual(levels, [
    { size: 504, edges: 1194, closed: 24 },
    { size: 176, edges: 380, closed: 12 },
    { size: 112, edges: 236, closed: 10 },
  ]);
  assert.ok(pages[0] > 1);
  const { surfaceCells: plane, volumeCells: n } = potential;
  const source = new Float64Array(n);
  source[4 * plane + 6 * grid.cells[0] + 2] = 0.003;
  source[5 * plane + 9 * grid.cells[0] + 30] = -0.003;
  const surface = Float64Array.from({ length: plane }, (_, i) => ((31 * i) % 97) / 500);
  const rise = new Float64Array(plane),
    bulk = new Float64Array(n);
  const iterations = potential.project(surface, rise, source, 0.003, bulk);
  const projectionHash = createHash('sha256').update(rise).update(bulk).digest('hex');
  assert.equal(iterations, 25);
  assert.equal(projectionHash, 'c4fe39959f13f5407692d1ff7de6086d44e8ce80f17d8ac94266d35ea58ef1c2');

  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  const wake = new FiniteQuayWake();
  world.add(wake, {
    ...grid,
    temporalOrder: 4,
    pressureAtDepth: true,
    sponge: { cells: 2, rate: 3 },
    initial: (x, z) => [0.04 / (1 + (x - 2) ** 2 + (z - 0.6) ** 2), (x - 4) / 128],
  });
  const zero = world.takeSnapshot();
  world.advance(6);
  const hash = world.hash(),
    work = wake.work();
  assert.equal(hash, '20412f6dbd7b4482');
  assert.equal(work.absorbedJoules, 1.4300215078989025);
  world.restoreSnapshot(zero.bytes);
  world.advance(6);
  assert.equal(world.hash(), hash);
  assert.deepEqual(wake.work(), work);
  t.diagnostic(JSON.stringify({ levels, pages, hierarchyHash, iterations, projectionHash, hash, work }));
});
