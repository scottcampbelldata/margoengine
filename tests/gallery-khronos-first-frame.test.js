import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression (amd-gpu-hunt row 16, 2026-11-11): the model cabinet imported @margoengine/gltf-pro statically, so its
// loader (about 74 KB gzip of the page's 129,989 B, grown with gltf-pro from 80,019 to 86,326 B) counted before the
// first frame and the page passed the gallery check's 120,000 B budget. The loader now comes with the first model.
test('the Khronos gallery page loads gltf-pro with its first model, not before the first frame', () => {
  const text = readFileSync(new URL('../examples/gallery/khronos.ts', import.meta.url), 'utf8');
  const statics = [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(@margoengine\/gltf-pro[^']*)'/gm)].map((m) => m[1]);
  assert.deepEqual(statics, [], 'no value import of gltf-pro at the top of khronos.ts');
  assert.match(text, /const pro = import\('@margoengine\/gltf-pro'\)/, 'the loader is a dynamic import');
  assert.match(text, /await pro;/, 'show() waits for it');
});
