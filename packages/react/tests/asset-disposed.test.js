import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetCache, entry } from '../dist/assets.js';

// KB-C34c / KB-ERRPAGE-REACT1: a load that finished after its Canvas was disposed rejected with a plain
// Error('Canvas disposed'). It is a cancellation, so it rejects as an AbortError, the same as useTexture's
// disposed path (texture-cache.ts) and as an aborted signal; callers that ignore aborts then ignore it too.
test('a load that finishes after the Canvas is disposed rejects as an AbortError and frees its value', async () => {
  const cache = createAssetCache({});
  cache.disposed = true;
  const freed = [];
  const asset = entry(cache, new Map(), 'model.glb', async () => 'value', (value) => freed.push(value));
  await asset.promise;
  assert.equal(asset.status, 'rejected');
  assert.ok(asset.error instanceof DOMException);
  assert.equal(asset.error.name, 'AbortError');
  assert.equal(asset.error.message, 'Canvas disposed');
  assert.deepEqual(freed, ['value']);
});
