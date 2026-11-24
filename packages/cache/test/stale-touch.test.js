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

// WebKit refuses Blobs in ephemeral sessions and stalls a transaction whose refused Blob put is not its first request.
// The caches ask once at open (storesBlobs), so no real write meets the refusal: before that, recreating a with b's
// eviction in front stalled every later transaction, and staleTouch never finished in Playwright WebKit.
for (const indexed of [false, true])
  for (const mode of ['evict', 'replace'])
    test(`staleTouch ${mode} finishes when the database refuses Blobs as WebKit does (indexed=${indexed})`, { timeout: 30_000 }, async () => {
      globalThis.indexedDB = fakeIndexedDB({ refuseBlobs: 'webkit' });
      const result = await staleTouch(mode, indexed);
      assert.deepEqual(result.after, result.before);
      assert.deepEqual(result.old, [100, 1]);
      if (mode === 'evict') assert.equal(result.b, 'TypeError');
      else assert.deepEqual([result.current, result.etag], [[80, 9], '"new"']);
    });
