import assert from 'node:assert/strict';
import test from 'node:test';
import { packFrames, unpackFrames } from '../dist/animation.js';
import { ByteLedger, ownedBuffers, retainedBytes, wrapGrid } from '../dist/index.js';
import { SparseGrid } from '../dist/sparse.js';

const grid = (n, fill = 1) => ({ size: [n, 1, 1], voxels: new Uint8Array(n).fill(fill) });

test('dense grids, cels and images charge their buffers; views of one pool count once', () => {
  const a = grid(10),
    { grid: b } = wrapGrid(a, { offset: [3, 0, 0] });
  assert.deepEqual(ownedBuffers(a), [{ token: a.voxels.buffer, bytes: 10 }]);
  assert.equal(retainedBytes(a, b), 20);
  assert.equal(retainedBytes(a, a, [a, { voxels: a.voxels }]), 10, 'the same grid held twice counts once');
  const pool = new Uint8Array(64),
    left = { size: [8, 1, 1], voxels: pool.subarray(0, 8) },
    right = { size: [8, 1, 1], voxels: pool.subarray(8, 16) };
  assert.equal(retainedBytes(left, right), 64, 'views keep their whole buffer alive, once');
  const hdr = { width: 2, height: 2, data: new Float32Array(16) },
    rgba = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  assert.equal(retainedBytes(hdr, rgba, hdr.data), 80);
  assert.equal(retainedBytes(new ArrayBuffer(5), { token: hdr, bytes: 7 }), 12);
  assert.throws(() => ownedBuffers({ size: [1, 1, 1] }), TypeError);
  assert.throws(() => ownedBuffers(3), TypeError);
  assert.throws(() => ownedBuffers({ token: {}, bytes: -1 }), RangeError);
});

test("packed frames count each distinct bank once; unpacked cels own copies (Studio's frame fixture)", () => {
  // Margo Voxel Studio's saved fixture (src/editor/current-main-formats.test.ts): two one-cell banks, three keys.
  const cels = [
      { frame: 0, size: [1, 1, 1], voxels: Uint8Array.of(7), pivot: [0, 0, 0] },
      { frame: 4, size: [1, 1, 1], voxels: Uint8Array.of(255), pivot: [0.5, 0, 1] },
      { frame: 8, size: [1, 1, 1], voxels: Uint8Array.of(7), pivot: [0, 0, 0] },
    ],
    packed = packFrames(cels);
  assert.equal(packed.banks.length, 2);
  assert.equal(retainedBytes(packed), 2);
  assert.equal(retainedBytes(unpackFrames(packed)), 3);
  assert.equal(retainedBytes(cels, cels[0]), 3);
});

test('sparse snapshots share untouched chunks, and so their tokens', () => {
  const a = SparseGrid.empty([96, 32, 32]).edit([
      [1, 1, 1, 4],
      [40, 1, 1, 5],
      [80, 1, 1, 6],
    ]).grid,
    { grid: b, delta } = a.edit([[41, 2, 2, 9]]),
    sum = (list) => list.reduce((n, item) => n + item.bytes, 0);
  assert.equal(sum(a.ownedBuffers()), a.stats.bytes);
  assert.equal(a.ownedBuffers().length, 3);
  const changed = b.ownedBuffers().filter((o) => !a.ownedBuffers().some((p) => p.token === o.token));
  assert.equal(changed.length, 1);
  assert.equal(retainedBytes(a, b), a.stats.bytes + changed[0].bytes);
  assert.ok(retainedBytes(a, b) < a.stats.bytes + b.stats.bytes, 'per-snapshot stats double count shared chunks');
  const own = SparseGrid.deltaBuffers(delta);
  assert.equal(own.length, 2, 'the replaced chunk on each side');
  assert.equal(sum(own), delta.bytes);
  assert.throws(
    () => SparseGrid.deltaBuffers({ changed: 0, bytes: 0 }),
    (e) => e.code === 'state',
  );
});

test('a ByteLedger keeps an undo history at the exact bytes of everything it holds', () => {
  const ledger = new ByteLedger(),
    history = [];
  let current = SparseGrid.empty([256, 64, 64]).edit([[0, 0, 0, 1]]).grid;
  ledger.retain(current);
  for (let step = 0; step < 12; step++) {
    const { grid, delta } = current.edit([[step * 20, step * 5, step * 4, 1 + step]]);
    history.push({ snapshot: grid, delta });
    ledger.retain(grid);
    current = grid;
  }
  assert.equal(
    ledger.bytes,
    retainedBytes(
      history.map((h) => h.snapshot),
      history[0].snapshot.restore(history[0].delta, 'before'),
    ),
  );
  // Drop the oldest entries as a 100-entry / byte budget history would; shared chunks stay charged.
  const dropped = history.shift();
  const before = ledger.bytes,
    freed = ledger.release(dropped.snapshot);
  assert.equal(before - freed, ledger.bytes);
  assert.ok(freed < dropped.snapshot.stats.bytes);
  assert.throws(() => ledger.release(new Uint8Array(3)), /does not hold/);
  assert.equal(ledger.bytes, before - freed, 'a refused release changes nothing');
  const once = new ByteLedger(),
    a = grid(100);
  assert.equal(once.retain(a), 100);
  assert.equal(once.retain([a, a]), 0);
  assert.equal(once.release(a), 0, 'still held once');
  assert.equal(once.has(a.voxels.buffer), true);
  assert.equal(once.release(a), 100);
  assert.deepEqual([once.bytes, once.buffers], [0, 0]);
});
