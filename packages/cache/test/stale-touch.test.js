import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIndexedDB } from './support.js';
import { staleTouch } from './stale-touch.js';

for (const indexed of [false, true]) {
  test(`a delayed hit cannot recreate an evicted record (indexed=${indexed})`, async () => {
    globalThis.indexedDB = fakeIndexedDB();
    assert.deepEqual(await staleTouch('evict', indexed), {
      before: { bytes: 100, files: 1 },
      after: { bytes: 100, files: 1 },
      old: [100, 1],
      b: 'TypeError',
      restored: { bytes: 100, files: 1 },
    });
  });
  test(`a delayed hit cannot overwrite a replacement's metadata (indexed=${indexed})`, async () => {
    globalThis.indexedDB = fakeIndexedDB();
    assert.deepEqual(await staleTouch('replace', indexed), {
      before: { bytes: 80, files: 1 },
      after: { bytes: 80, files: 1 },
      old: [100, 1],
      current: [80, 9],
      etag: '"new"',
      type: 'application/new',
    });
  });
}
