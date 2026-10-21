import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockTypes, VoxelWorld } from '@margoengine/voxel';
import { restoreSnapshots, SparseGrid, snapshotBuffers } from '../dist/sparse.js';

const isState = (e) => e.name === 'MargoError' && e.code === 'state';
const cells = (grid) => [...grid.filled()];

// Margo Voxel Studio's saved fixture (src/editor/current-main-formats.test.ts): plain version 1 data with two legacy
// palette-packed chunks, written before the wide envelope existed.
function legacySparse() {
  const near = Array(1024).fill(0),
    far = Array(1024).fill(0);
  near[100] = 4; // chunk cell (2, 3, 4)
  far[448] = 4; // chunk cell (2, 14, 0)
  return {
    format: 'margo-sparse-volume',
    version: 1,
    size: [1_000_003, 47, 900_001],
    origin: [0, 0, 0],
    chunks: [
      { position: [0, 0, 0], palette: [0, 7], bits: 1, words: near },
      { position: [31_250, 1, 28_125], palette: [0, 255], bits: 1, words: far },
    ],
  };
}

function sample() {
  const edits = [];
  for (let i = 0; i < 40; i++) edits.push([i * 3, i % 7, (i * 5) % 90, 1 + (i % 20)]);
  edits.push([200, 60, 40, 255], [0, 0, 0, 9]);
  return SparseGrid.empty([256, 64, 96], { origin: [-5, -1000, 7] }).edit(edits).grid;
}

test('saved version 1 sparse data loads unchanged, keeps its palette slots and saves the same fields', () => {
  const data = legacySparse(),
    grid = SparseGrid.deserialize(data);
  assert.equal(grid.get(2, 3, 4), 7);
  assert.equal(grid.get(1_000_002, 46, 900_000), 255);
  assert.deepEqual(grid.serialize(), data);
  const edit = grid.edit([[2, 3, 4, 9]]);
  assert.equal(edit.grid.restore(edit.delta, 'before'), grid);
  assert.equal(grid.get(2, 3, 4), 7);
  // The same data survives a snapshot transfer (structured clone with its buffers moved).
  const snapshot = grid.snapshot(),
    moved = structuredClone(snapshot, { transfer: snapshotBuffers(snapshot) });
  assert.equal(snapshot.chunks.words.byteLength, 0, 'the sender gave its buffers away');
  assert.deepEqual(SparseGrid.fromSnapshot(moved).serialize(), data);
});

test("the 'wide' envelope reaches past Y -32768..32767 and saves as version 2; version 1 stays the world range", () => {
  const tall = SparseGrid.empty([4, 200_000, 4], { origin: [0, -100_000, 0], envelope: 'wide' });
  assert.throws(() => SparseGrid.empty([4, 200_000, 4], { origin: [0, -100_000, 0] }), /Y extent.*'wide'/);
  const { grid } = tall.edit([
    [1, 0, 2, 3],
    [3, 199_999, 3, 200],
  ]);
  const data = grid.serialize();
  assert.equal(data.version, 2);
  assert.deepEqual(cells(SparseGrid.deserialize(JSON.parse(JSON.stringify(data)))), cells(grid));
  assert.throws(() => SparseGrid.deserialize({ ...data, version: 1 }), /Y extent/, 'version 1 keeps the world range');
  // A wide grid inside the world range is the same grid: version 1, field for field.
  const inside = SparseGrid.empty([8, 8, 8], { origin: [1, 2, 3], envelope: 'wide' }).edit([[1, 1, 1, 5]]).grid;
  const plain = SparseGrid.empty([8, 8, 8], { origin: [1, 2, 3] }).edit([[1, 1, 1, 5]]).grid;
  assert.deepEqual(inside.serialize(), plain.serialize());
  assert.equal(inside.serialize().version, 1);
  assert.throws(() => SparseGrid.deserialize({ ...inside.serialize(), version: 2 }), /format/);
  assert.throws(() => SparseGrid.empty([2, 2, 2], { envelope: 'huge' }), TypeError);
});

test('the wide envelope stops at 2^53 - 1 and a safe-integer cell count, so cell indexes stay exact', () => {
  const top = Number.MAX_SAFE_INTEGER;
  const edge = SparseGrid.empty([10, 1, 1], { origin: [top - 9, 0, 0], envelope: 'wide' });
  assert.equal(edge.edit([[9, 0, 0, 4]]).grid.get(9, 0, 0), 4);
  assert.throws(() => SparseGrid.empty([11, 1, 1], { origin: [top - 9, 0, 0], envelope: 'wide' }), /2\^53/);
  assert.throws(() => SparseGrid.empty([-top, 1, 1], { envelope: 'wide' }), RangeError);
  assert.throws(() => SparseGrid.empty([2 ** 27, 2 ** 27, 2 ** 2], { envelope: 'wide' }), /safe-integer cell count/);
  const big = SparseGrid.empty([2 ** 26, 2 ** 24, 4], { envelope: 'wide' }),
    last = [2 ** 26 - 1, 2 ** 24 - 1, 3];
  assert.ok(Number.isSafeInteger(last[0] + big.size[0] * (last[2] + big.size[2] * last[1])));
  assert.equal(big.edit([[...last, 8]]).grid.get(...last), 8);
});

test('toWorld refuses cells a VoxelWorld cannot hold, before writing any', () => {
  const blocks = new BlockTypes();
  for (let id = 1; id <= 255; id++) blocks.define(`palette-${id}`);
  const world = new VoxelWorld({ blocks }),
    far = SparseGrid.empty([4, 4, 4], { origin: [2 ** 31 - 2, 0, 0], envelope: 'wide' }).edit([
      [0, 0, 0, 1],
      [3, 0, 0, 1],
    ]).grid;
  assert.throws(() => far.toWorld(world), /32-bit X or Z/);
  assert.equal(world.getBlock(2 ** 31 - 2, 0, 0), 0);
  const deep = SparseGrid.empty([1, 4, 1], { origin: [0, -32770, 0], envelope: 'wide' }).edit([[0, 3, 0, 2]]).grid;
  deep.toWorld(world);
  assert.equal(world.getBlock(0, -32767, 0), 2);
});

test('snapshots move typed arrays only; the receiver rebuilds an equal grid that owns copies', () => {
  const grid = sample(),
    snapshot = grid.snapshot(),
    buffers = snapshotBuffers(snapshot);
  assert.equal(buffers.length, 5);
  assert.equal(new Set(buffers).size, 5);
  assert.equal(snapshot.chunks.bits.length, grid.stats.chunks);
  const moved = structuredClone(snapshot, { transfer: buffers }),
    copy = SparseGrid.fromSnapshot(moved);
  assert.deepEqual(cells(copy), cells(grid));
  assert.deepEqual(copy.origin, grid.origin);
  assert.deepEqual(copy.serialize(), grid.serialize());
  moved.chunks.words.fill(0xffffffff);
  moved.chunks.palettes.fill(1);
  assert.deepEqual(cells(copy), cells(grid), 'the rebuilt grid kept copies');
  assert.deepEqual(cells(grid), cells(SparseGrid.fromSnapshot(grid.snapshot())), 'the sender grid is untouched');
  const wide = SparseGrid.empty([3, 3, 3], { origin: [0, 10 ** 12, 0], envelope: 'wide' }).edit([[1, 2, 0, 66]]).grid;
  assert.deepEqual(cells(SparseGrid.fromSnapshot(wide.snapshot())), [[1, 2, 0, 66]]);
});

test('fromSnapshot checks types, lengths, palettes and budgets before keeping anything', () => {
  const grid = sample(),
    fresh = () => grid.snapshot();
  assert.throws(() => SparseGrid.fromSnapshot(null), TypeError);
  assert.throws(() => SparseGrid.fromSnapshot({ ...fresh(), version: 2 }), /format/);
  const words = fresh();
  words.chunks.words = Array.from(words.chunks.words);
  assert.throws(() => SparseGrid.fromSnapshot(words), TypeError);
  const short = fresh();
  short.chunks.words = short.chunks.words.subarray(1);
  assert.throws(() => SparseGrid.fromSnapshot(short), /lengths disagree/);
  const bits = fresh();
  bits.chunks.bits[0] = 3;
  assert.throws(() => SparseGrid.fromSnapshot(bits), /palette or word length/);
  const outside = fresh();
  outside.chunks.positions[0] = 100;
  assert.throws(() => SparseGrid.fromSnapshot(outside), /outside the grid bounds/);
  const twice = fresh();
  twice.chunks.positions.set(twice.chunks.positions.subarray(0, 3), 3);
  assert.throws(() => SparseGrid.fromSnapshot(twice), /duplicate/);
  const air = SparseGrid.empty([32, 32, 32])
    .edit([[0, 0, 0, 1]])
    .grid.snapshot();
  air.chunks.palettes[1] = 0;
  assert.throws(() => SparseGrid.fromSnapshot(air), /empty/);
  assert.throws(() => SparseGrid.fromSnapshot(fresh(), { maxChunks: 1 }), /maxChunks/);
  assert.throws(() => SparseGrid.fromSnapshot(fresh(), { maxBytes: 1000 }), /maxBytes/);
});

test('restoreSnapshots spends one byte budget across a document', () => {
  const a = sample(),
    b = SparseGrid.empty([64, 64, 64]).edit([
      [0, 0, 0, 3],
      [40, 40, 40, 4],
    ]).grid,
    bytes = a.stats.bytes + b.stats.bytes;
  const [x, y] = restoreSnapshots([a.snapshot(), b.snapshot()], { maxBytes: bytes });
  assert.deepEqual(cells(x), cells(a));
  assert.deepEqual(cells(y), cells(b));
  assert.throws(() => restoreSnapshots([a.snapshot(), b.snapshot()], { maxBytes: bytes - 1 }), /maxBytes/);
  assert.throws(() => restoreSnapshots([a.snapshot(), b.snapshot()], { maxBytes: a.stats.bytes }), /maxBytes/);
  assert.throws(() => restoreSnapshots('a'), TypeError);
});

test('a delta snapshot replays one edit on a worker copy and undoes it there', () => {
  const base = sample(),
    worker = SparseGrid.fromSnapshot(structuredClone(base.snapshot())),
    { grid: after, delta } = base.edit([
      [0, 0, 0, 0], // erases the only cell of its chunk: the chunk goes away
      [3, 1, 5, 77], // recolours a cell
      [250, 63, 95, 12], // fills a new chunk
    ]),
    data = SparseGrid.deltaSnapshot(delta);
  assert.equal(data.changed, 3);
  assert.equal(data.before.bits.length, data.after.bits.length);
  const moved = structuredClone(data, { transfer: snapshotBuffers(data) }),
    replay = worker.applyDeltaSnapshot(moved);
  assert.deepEqual(cells(replay.grid), cells(after));
  assert.equal(replay.delta.changed, 3);
  assert.equal(replay.grid.restore(replay.delta, 'before'), worker);
  assert.deepEqual(cells(worker), cells(base), 'the worker copy itself is unchanged');
  const undo = replay.grid.applyDeltaSnapshot(moved, 'before');
  assert.deepEqual(cells(undo.grid), cells(base));
  assert.throws(() => replay.grid.applyDeltaSnapshot(moved), isState, 'replaying twice is out of order');
  assert.throws(() => SparseGrid.empty([8, 8, 8]).applyDeltaSnapshot(moved), isState);
  assert.throws(() => worker.applyDeltaSnapshot(moved, 'sideways'), TypeError);
  const nothing = base.edit([[3, 1, 5, base.get(3, 1, 5)]]);
  assert.equal(SparseGrid.deltaSnapshot(nothing.delta).before.bits.length, 0);
  assert.equal(worker.applyDeltaSnapshot(SparseGrid.deltaSnapshot(nothing.delta)).grid, worker);
  assert.throws(() => SparseGrid.deltaSnapshot({ changed: 0, bytes: 0 }), isState);
  const lopsided = SparseGrid.deltaSnapshot(delta);
  lopsided.after.positions[0] += 1;
  assert.throws(() => worker.applyDeltaSnapshot(lopsided), /different chunks/);
});
