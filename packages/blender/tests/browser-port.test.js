import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Blender browser suite cannot reserve the shared fixed port or navigate to another suite', async () => {
  const source = await readFile(new URL('../../../scripts/modern-blender-tests.js', import.meta.url), 'utf8');
  assert.match(source, /openBrowser\(\{\s*port:\s*['"]free['"]/);
  assert.doesNotMatch(source, /127\.0\.0\.1:5193/);
  assert.match(source, /new URL\(['"]\/examples\/blender-loader\/index\.html['"], page\.url\(\)\)/);
});
