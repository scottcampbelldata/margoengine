// @margoengine/voxel-edit/collab: concurrent edits from several users merge to the same grid in any order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVoxelOp, encodeVoxelOp, VoxelReplica } from '../dist/collab.js';

const start = () => ({ size: [16, 8, 16], voxels: new Uint8Array(16 * 8 * 16).fill(1) });
let seed = 3;
const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const shuffle = (list) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

test('three users editing the same cells at once converge in any delivery order, with repeats', () => {
  const sites = ['ann', 'bo', 'cy'],
    replicas = sites.map((site) => new VoxelReplica(start(), { site })),
    ops = [];
  // Rounds of concurrent edits: each user edits overlapping boxes without seeing the others, then some ops arrive.
  for (let round = 0; round < 30; round++) {
    for (const r of replicas) {
      const cells = Array.from({ length: 40 }, () => Math.floor(next() * 300));
      ops.push(r.edit(cells, Math.floor(next() * 6)));
    }
    for (const r of replicas) for (const op of ops) if (next() < 0.3) r.apply(op);
  }
  // Everyone gets everything, shuffled, some twice.
  for (const r of replicas) for (const op of shuffle([...ops, ...ops.slice(0, 20)])) r.apply(op);
  const [a, b, c] = replicas.map((r) => r.grid.voxels);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  // The same ops applied to a fresh replica in reverse order give the same cells.
  const late = new VoxelReplica(start(), { site: 'dee' });
  for (const op of [...ops].reverse()) late.apply(op);
  assert.deepEqual(late.grid.voxels, a);
  assert.ok(a.some((v) => v !== 1));
});

test('the later edit of a cell wins; equal clocks go to the higher site name; a seen op is not applied twice', () => {
  const ann = new VoxelReplica(start(), { site: 'ann' }),
    bo = new VoxelReplica(start(), { site: 'bo' }),
    a1 = ann.edit([5], 2),
    b1 = bo.edit([5], 3); // concurrent: both clock 1, 'bo' > 'ann'
  assert.equal(ann.apply(b1), 1);
  assert.equal(bo.apply(a1), 0);
  assert.equal(ann.get(5), 3);
  assert.equal(bo.get(5), 3);
  const a2 = ann.edit([5], 4); // ann has seen clock 1, so this is clock 2 and wins
  assert.equal(a2.clock, 2);
  bo.apply(a2);
  assert.equal(bo.get(5), 4);
  assert.equal(bo.apply(a2), 0, 'repeat');
  assert.deepEqual(ann.version, { ann: 2, bo: 1 });
});

test('an edit naming a cell twice keeps its later value on every replica', () => {
  const ann = new VoxelReplica(start(), { site: 'ann' }),
    bo = new VoxelReplica(start(), { site: 'bo' }),
    op = ann.edit([9, 9, 9], [4, 5, 6]);
  bo.apply(op);
  assert.equal(ann.get(9), 6);
  assert.equal(bo.get(9), 6);
});

test('a replica past maxCells is refused before it allocates', () => {
  assert.throws(() => new VoxelReplica(start(), { site: 'ann', maxCells: 100 }), RangeError);
});

test('since gives a peer only what it lacks, and a snapshot starts a newcomer at the same cells', () => {
  const ann = new VoxelReplica(start(), { site: 'ann' }),
    bo = new VoxelReplica(start(), { site: 'bo' });
  for (let i = 0; i < 5; i++) ann.edit([i, i + 100], 7);
  for (const op of ann.since(bo.version)) bo.apply(op);
  bo.edit([3], 0);
  const missing = bo.since(ann.version);
  assert.deepEqual(
    missing.map((op) => [op.site, op.clock]),
    [['bo', 6]],
  );
  for (const op of missing) ann.apply(op);
  assert.deepEqual(ann.grid.voxels, bo.grid.voxels);
  const cy = VoxelReplica.fromSnapshot(ann.snapshot(), { site: 'cy' });
  assert.deepEqual(cy.grid.voxels, ann.grid.voxels);
  cy.edit([200], 9);
  assert.equal(cy.since(ann.version).length, 1);
  const seen = [];
  ann.onChange((op, changed) => seen.push([op.site, changed]));
  for (const op of cy.since(ann.version)) ann.apply(op);
  assert.deepEqual(seen, [['cy', 1]]);
});

test('ops that arrive out of order are not counted in version until the gap fills, so since resends the gap', () => {
  const ann = new VoxelReplica(start(), { site: 'ann' }),
    bo = new VoxelReplica(start(), { site: 'bo' }),
    ops = [ann.edit([1], 2), ann.edit([2], 3), ann.edit([1], 4)];
  assert.deepEqual(
    ops.map((op) => op.seq),
    [1, 2, 3],
  );
  bo.apply(ops[2]); // the third arrives first
  assert.deepEqual(bo.version, {});
  const resent = ann.since(bo.version);
  assert.deepEqual(
    resent.map((op) => op.seq),
    [1, 2, 3],
  );
  for (const op of resent) bo.apply(op);
  assert.deepEqual(bo.version, { ann: 3 });
  assert.deepEqual(bo.grid.voxels, ann.grid.voxels);
  assert.equal(bo.get(1), 4);
  // A replica that rejoins under its own site name continues its count instead of reusing a seq.
  const again = VoxelReplica.fromSnapshot(ann.snapshot(), { site: 'ann' });
  assert.equal(again.edit([3], 5).seq, 4);
});

test('operations round-trip through bytes and bad bytes or ops are refused with a fix', () => {
  const ann = new VoxelReplica(start(), { site: 'anne-é' }),
    op = ann.edit([1, 2, 2047], [3, 0, 255]),
    bytes = encodeVoxelOp(op),
    back = decodeVoxelOp(bytes);
  assert.deepEqual(back, op);
  const bad = [
    () => decodeVoxelOp(bytes.slice(0, 12)),
    () => decodeVoxelOp(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)),
    () => decodeVoxelOp(bytes.slice(0, bytes.length - 1)),
    () => ann.edit([4096], 1),
    () => ann.edit([1], 256),
    () => ann.edit([1, 2], [1]),
    () => ann.apply({ site: 'x', seq: 1, clock: 0, cells: new Uint32Array(0), values: new Uint8Array(0) }),
    () => ann.apply({ site: 'x', seq: 1, clock: 1, cells: Uint32Array.of(5000), values: Uint8Array.of(1) }),
    () => ann.apply({ site: 'x', seq: 0, clock: 1, cells: new Uint32Array(0), values: new Uint8Array(0) }),
    () => new VoxelReplica(start(), { site: '' }),
  ];
  for (const make of bad)
    assert.throws(make, (e) => (e instanceof TypeError || e instanceof RangeError) && /; \S/.test(e.message));
});
