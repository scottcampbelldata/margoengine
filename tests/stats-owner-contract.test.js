import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { missing } from './support/plugin-owner-source.js';

test('every stats EnginePlugin detaches through its registered scene', () => {
  let checked = 0;
  for (const file of readdirSync('packages/stats/src').filter((name) => name.endsWith('.ts'))) {
    const result = missing(readFileSync(`packages/stats/src/${file}`, 'utf8'));
    checked += result.checked;
    assert.deepEqual(result.problems, [], file);
  }
  assert.equal(checked, 4);
});
