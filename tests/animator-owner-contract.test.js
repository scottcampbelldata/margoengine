import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { missing } from './support/plugin-owner-source.js';

test('every Animator EnginePlugin disposes through its actual scene', () => {
  let checked = 0;
  for (const file of readdirSync('packages/animator/src').filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(`packages/animator/src/${file}`, 'utf8');
    const result = missing(source);
    checked += result.checked;
    assert.deepEqual(result.problems, [], file);
    assert.doesNotMatch(source, /\bengine\.use\([^,;]+\);/, `${file}: attach factories must select a scene`);
  }
  assert.equal(checked, 1);
});
