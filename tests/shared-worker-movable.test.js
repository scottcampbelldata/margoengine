// movable() moves only a plain ArrayBuffer; a typed array is copied, so posting it never empties the caller's view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { movable } from '../packages/shared/worker.js';

test('a typed array that covers its whole buffer is copied, not moved', () => {
  const bytes = new Uint8Array(64).fill(7),
    out = movable(bytes);
  assert.notEqual(out, bytes.buffer);
  structuredClone(out, { transfer: [out] });
  assert.equal(bytes.byteLength, 64);
  assert.equal(bytes[63], 7);
});

test('a whole ArrayBuffer still moves, and a partial view is copied', () => {
  const buffer = new ArrayBuffer(8);
  assert.equal(movable(buffer), buffer);
  const view = new Uint8Array(buffer, 2, 4);
  assert.equal(movable(view).byteLength, 4);
});
