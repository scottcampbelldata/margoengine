import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { missing } from './support/plugin-owner-source.js';

test('every Cinematic EnginePlugin disposes through its actual scene', () => {
  let checked = 0;
  for (const file of readdirSync('packages/cinematic/src').filter((name) => name.endsWith('.ts'))) {
    const result = missing(readFileSync(`packages/cinematic/src/${file}`, 'utf8'));
    checked += result.checked;
    assert.deepEqual(result.problems, [], file);
  }
  assert.equal(checked, 2);
});
