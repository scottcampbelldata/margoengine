import test from 'node:test';
import assert from 'node:assert/strict';
import { WFC } from '../dist/index.js';

const tiles = [{ neighbors: Array.from({ length: 6 }, () => [0]) }];
test('3D solve accepts the fourth signal argument and preserves its exact pre-abort reason', () => {
  const wfc = new WFC([4, 4, 4], tiles),
    reason = new Error('cancel tile editor solve');
  const signal = AbortSignal.abort(reason);
  const before = wfc.cells.slice();
  assert.throws(
    () => wfc.solve(1, [], 16, { signal }),
    (e) => e === reason,
  );
  assert.deepEqual(wfc.cells, before);
  assert.deepEqual(wfc.solve(1, [], 16, { signal: new AbortController().signal }), new Uint8Array(64));
});
