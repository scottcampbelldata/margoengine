import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exportUSDZ } from '@margoengine/exporters';

test('USDZ subpath preserves root identity and loads only its serializer', async () => {
  const isolated = await import('@margoengine/exporters/usdz');
  assert.deepEqual(Object.keys(isolated), ['exportUSDZ']);
  assert.equal(isolated.exportUSDZ, exportUSDZ);
  const entry = await readFile(new URL('../dist/usdz.js', import.meta.url), 'utf8');
  assert.match(entry, /from ['"]\.\/scene\.js['"]/);
  assert.doesNotMatch(entry, /from ['"]\.\/(?:index|gltf|stl|obj|ply)\.js['"]/);
});
