// The glTF PBR loader folded into @margoengine/gltf (2026-11-16) and its uniform arena's GPU label moved from
// 'gltf-pro uniform arena' to 'gltf/pbr uniform arena'. Proof baselines captured before the fold hold the old label, so
// materials-uv-transform, gltf-pbr-lighting-hooks and oit-detached failed with "GPU calls differ" on that one string.
// compare.js golden() renames labels a pre-fold ref wrote (foldedLabels); every other value is compared as stored.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldedLabels } from '../examples/package-benchmarks/proofs/compare.js';

test('a pre-fold baseline label reads as the label the same GPU object has since the fold', () => {
  const stored = [['buffer', { label: 'gltf-pro uniform arena', size: 65536 }], ['module', { code: 'gltf-pro' }]];
  assert.deepEqual(foldedLabels(stored), [
    ['buffer', { label: 'gltf/pbr uniform arena', size: 65536 }],
    ['module', { code: 'gltf-pro' }],
  ]);
});

test('only label keys with a recorded fold change; other labels, strings and typed data stay as stored', () => {
  const bytes = new Uint8Array([1, 2, 3]),
    stored = { label: 'gltf-pro other', note: 'gltf-pro uniform arena', data: bytes };
  const out = foldedLabels(stored);
  assert.deepEqual(out, { label: 'gltf-pro other', note: 'gltf-pro uniform arena', data: bytes });
  assert.equal(out.data, bytes);
});
