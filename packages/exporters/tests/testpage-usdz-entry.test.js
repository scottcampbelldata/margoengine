import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as root from '@margoengine/exporters';
import { exportUSDZ } from '@margoengine/exporters/usdz';

test('test-page 43: the documented optional USDZ entry writes an archive without a root export', () => {
  assert.equal(root.exportUSDZ, undefined);
  assert.equal(typeof exportUSDZ, 'function');
  const archive = exportUSDZ({ nodes: [{ geometry: {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  } }] });
  assert.ok(archive instanceof Uint8Array);
  assert.deepEqual([...archive.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('Import `exportUSDZ` from `@margoengine/exporters/usdz`'));
  assert.ok(readme.includes('The package root does not export it'));
});
