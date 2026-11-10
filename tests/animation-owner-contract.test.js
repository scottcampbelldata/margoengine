import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { missing } from './support/plugin-owner-source.js';
test('every explicit Animation plugin disposes by registered identity', () => {
  const dir = new URL('../packages/animation/src/', import.meta.url);
  let count = 0;
  for (const name of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const result = missing(readFileSync(new URL(name, dir), 'utf8'));
    assert.deepEqual(result.problems, [], name);
    count += result.checked;
  }
  assert.equal(count, 8);
});
