import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { missing } from './support/plugin-owner-source.js';
test('every terrain EnginePlugin detaches through actual plugin ownership', () => {
  let checked = 0;
  for (const file of readdirSync('packages/terrain/src').filter((f) => f.endsWith('.ts'))) {
    const result = missing(readFileSync(`packages/terrain/src/${file}`, 'utf8'));
    checked += result.checked;
    assert.deepEqual(result.problems, [], file);
  }
  // Every class in packages/terrain/src that implements EnginePlugin: 13, then GroundChange (a231d47072), WetGround
  // (b0d0892ae7) the rock surface (b350f844d0) and the relief lighting (caf466b4cc), each passing the ownership check above.
  assert.equal(checked, 17);
});
test('terrain guard rejects misleading Engine fields named owner', () => {
  const source =
    'class Provider implements EnginePlugin, TerrainLighting {dispose(){this.owner?.removePlugin(this.name)}}';
  assert.deepEqual(missing(source).problems, ['Provider']);
});
