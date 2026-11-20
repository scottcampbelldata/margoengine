// Every shadow and depth caster position of this package is @invariant (WGSL 12.10): two programs that draw one
// surface into the same depth target write the same depth only when both declare it (WGSL 15.7.5 lets each program
// reassociate and fuse float operations). The casters: MargoVelocity, which TAA's velocity pass draws with depthCompare 'equal' against the material's vertex entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { casters } from '../../../tests/invariant-positions.mjs';

test('shader caster positions are @invariant', () => {
  const { all, missing } = casters('shader');
  assert.equal(all.length, 1, 'the rule still finds every caster of this package');
  assert.deepEqual(missing, []);
});
