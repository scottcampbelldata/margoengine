import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tetrahedralAdjacency, tetrahedralVolume, TetrahedralVolume } from '../dist/tetvolume.js';
const points = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, i >> 2]).flat();
const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
const indices = permutations.flatMap((p) => {
  let bits = 0;
  return [0, ...p.map((a) => (bits |= 1 << a))];
});
const grid = {
  points,
  connectivity: indices,
  offsets: [4, 8, 12, 16, 20, 24],
  types: [10, 10, 10, 10, 10, 10],
  pointData: new Float32Array(8).fill(0.5),
};
test('tetvolume entry exposes direct ray casting and opposite-vertex adjacency', () => {
  assert.equal(typeof tetrahedralVolume, 'function');
  assert.equal(typeof TetrahedralVolume.prototype.dispose, 'function');
  const adj = tetrahedralAdjacency(grid);
  assert.equal(adj.length, 24);
  assert.equal(adj.filter((v) => v < 0).length, 12);
  for (let cell = 0; cell < 6; cell++)
    for (let face = 0; face < 4; face++) {
      const neighbour = adj[cell * 4 + face];
      if (neighbour < 0) continue;
      const shared = indices
        .slice(cell * 4, cell * 4 + 4)
        .filter((_, i) => i !== face)
        .sort()
        .join(',');
      const opposite = indices.slice(neighbour * 4, neighbour * 4 + 4).findIndex(
        (_, i) =>
          indices
            .slice(neighbour * 4, neighbour * 4 + 4)
            .filter((_, j) => j !== i)
            .sort()
            .join(',') === shared,
      );
      assert.ok(opposite >= 0);
      assert.equal(adj[neighbour * 4 + opposite], cell);
    }
});
test('adjacency accepts reflected coordinates and either node orientation without mutating inputs', () => {
  const original = structuredClone(grid),
    reflected = { ...grid, points: points.map((v, i) => (i % 3 === 0 ? -v : v)) };
  assert.deepEqual(tetrahedralAdjacency(reflected), tetrahedralAdjacency(grid));
  assert.deepEqual(grid, original);
  const reverse = {
    ...grid,
    connectivity: indices.map((v, i) => indices[(i & ~3) + (i % 4 === 0 ? 1 : i % 4 === 1 ? 0 : i % 4)]),
  };
  assert.equal(tetrahedralAdjacency(reverse).filter((v) => v < 0).length, 12);
});
test('topology rejects malformed, singular, overlapping and nonmanifold tetrahedra with help links', () => {
  const check = (g) =>
    assert.throws(
      () => tetrahedralAdjacency(g),
      (e) => e instanceof RangeError && e.message.includes('https://margoengine.com/errors#sciviz'),
    );
  check({ ...grid, types: [12, 10, 10, 10, 10, 10] });
  check({ ...grid, offsets: [3, 8, 12, 16, 20, 24] });
  check({ ...grid, connectivity: indices.map((v, i) => (i === 0 ? 99 : v)) });
  check({ ...grid, connectivity: indices.map((v, i) => (i === 1 ? 0 : v)) });
  check({ ...grid, points: points.map((v, i) => (i % 3 === 2 ? 0 : v)) });
  check({ ...grid, connectivity: [...indices.slice(0, 4), ...indices.slice(0, 4)], offsets: [4, 8], types: [10, 10] });
  const nonmanifold = {
    points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0.2, 0.2, 2],
    connectivity: [0, 1, 2, 3, 0, 1, 2, 4, 0, 1, 2, 5],
    offsets: [4, 8, 12],
    types: [10, 10, 10],
  };
  check(nonmanifold);
});
test('cancellation and invalid scalar/reference options reject before publishing a source or GPU resources', () => {
  const f = {
    renderer: { device: { limits: { maxTextureDimension2D: 16384 } } },
    volume: () => assert.fail('source allocated'),
  };
  const c = new AbortController(),
    reason = { why: 'cancelled' };
  c.abort(reason);
  assert.throws(
    () => tetrahedralVolume(f, grid, { signal: c.signal }),
    (e) => e === reason,
  );
  assert.throws(() => tetrahedralVolume(f, grid, { referenceStep: 0 }), RangeError);
  assert.throws(() => tetrahedralVolume(f, { ...grid, pointData: new Float32Array(8).fill(NaN) }), RangeError);
  assert.throws(() => tetrahedralVolume(f, grid, { association: 'cell' }), RangeError);
  assert.throws(() => tetrahedralVolume(f, grid, { association: 'edge' }), RangeError);
});
test('NASA TMR demo retains attributed hashed point/scalar samples and conforming tetrahedral connectivity', () => {
  const root = new URL('../../../examples/assets/sciviz/', import.meta.url),
    metadata = JSON.parse(readFileSync(new URL('tmr-tet.json', root), 'utf8'));
  for (const [name, info] of Object.entries(metadata.hashes)) {
    const data = readFileSync(new URL(`tmr-tet-${name}.bin`, root));
    assert.equal(data.byteLength, info.bytes);
    assert.equal(createHash('sha256').update(data).digest('hex'), info.sha256);
  }
  const values = readFileSync(new URL('tmr-tet-values.bin', root)),
    cells = readFileSync(new URL('tmr-tet-cells.bin', root)),
    p = readFileSync(new URL('tmr-tet-points.bin', root));
  const copied = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    g = {
      points: new Float32Array(copied(p)),
      connectivity: new Uint32Array(copied(cells)),
      types: new Uint8Array(metadata.cells).fill(10),
      offsets: Uint32Array.from({ length: metadata.cells }, (_, i) => (i + 1) * 4),
      pointData: new Float32Array(copied(values)),
    };
  assert.equal(g.pointData.length, 2146);
  assert.equal(g.types.length, 6048);
  assert.ok(g.pointData.every(Number.isFinite));
  assert.ok(Math.max(...g.pointData) > 200);
  const adjacency = tetrahedralAdjacency(g);
  assert.ok(adjacency.some((v) => v < 0) && adjacency.some((v) => v >= 0));
});
