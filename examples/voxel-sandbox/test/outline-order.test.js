// 8b461567e: translucent surfaces write depth after their colour, and lines at the default order 20 test against it: an
// outlined block under water disappeared. The sandbox outline draws before the translucent pass (order 4.5).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the block outline draws at an order before the translucent pass', async () => {
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /new Lines\(\{ order: 4 \}\)/);
});
