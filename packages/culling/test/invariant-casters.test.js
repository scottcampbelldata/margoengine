// Every shadow and depth caster position of this package is @invariant (WGSL 12.10): two programs that draw one
// surface into the same depth target write the same depth only when both declare it (WGSL 15.7.5 lets each program
// reassociate and fuse float operations). The casters: the dynamic and parts casters, the per-cascade lists, the occluder shader drawn by two entries and the pyramid depth prepass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { casters } from '../../../tests/invariant-positions.mjs';

test('culling caster positions are @invariant', () => {
  const { all, missing } = casters('culling');
  assert.equal(all.length, 5, 'the rule still finds every caster of this package');
  assert.deepEqual(missing, []);
});
