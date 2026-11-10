import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { missing } from '../../../tests/support/plugin-owner-source.js';

test('XR manager detaches from its registered scene', () => {
  const result = missing(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));
  assert.equal(result.checked, 1);
  assert.deepEqual(result.problems, []);
});
