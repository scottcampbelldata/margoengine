import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { missing } from './support/plugin-owner-source.js';

test('shader EnginePlugin cleanup removes actual scene ownership', () => {
  let checked = 0;
  for (const file of readdirSync('packages/shader/src').filter((f) => f.endsWith('.ts'))) {
    const result = missing(readFileSync(`packages/shader/src/${file}`, 'utf8'));
    checked += result.checked;
    assert.deepEqual(result.problems, [], file);
  }
  assert.equal(checked, 4);
});
test('shader owner guard rejects absent and active-scene detachment', () => {
  const source = (body) => `class Pass implements EnginePlugin {dispose(){${body}}}`;
  for (const body of ['', 'engine.removePlugin(this.name)', 'this.engine=undefined'])
    assert.deepEqual(missing(source(body)).problems, ['Pass']);
  assert.deepEqual(missing(source('engine?.sceneOf(this)?.removePlugin(this.name)')).problems, []);
});

test('compute frame cleanup removes actual scene ownership', () => {
  const result = missing(readFileSync('packages/compute/src/frame.ts', 'utf8'));
  assert.equal(result.checked, 1);
  assert.deepEqual(result.problems, []);
});
