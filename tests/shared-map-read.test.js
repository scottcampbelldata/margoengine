// shared/map-read: the readbacks' wait (terrain/query, scatter/read) resolves when the map does, rejects with the map's
// error or the signal's reason, and leaves no abort listener behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapRead } from '../packages/shared/map-read.js';

globalThis.GPUMapMode ??= { READ: 1, WRITE: 2 };
const buffer = (settle) => ({ mapAsync: (mode) => (assert.equal(mode, GPUMapMode.READ), settle()) });

test('mapRead resolves with the map and removes its abort listener', async () => {
  const controller = new AbortController(),
    signal = controller.signal,
    added = [],
    removed = [];
  const add = signal.addEventListener.bind(signal),
    remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (t, f, o) => (added.push(f), add(t, f, o));
  signal.removeEventListener = (t, f, o) => (removed.push(f), remove(t, f, o));
  await mapRead(
    buffer(() => Promise.resolve()),
    signal,
  );
  assert.equal(added.length, 1);
  assert.deepEqual(removed, added);
  await mapRead(buffer(() => Promise.resolve()));
});

test('mapRead rejects with the map error, or with the abort reason first', async () => {
  await assert.rejects(mapRead(buffer(() => Promise.reject(new Error('lost')))), /lost/);
  const controller = new AbortController(),
    reason = new Error('cut');
  const pending = mapRead(
    buffer(() => new Promise(() => {})),
    controller.signal,
  );
  controller.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
});
