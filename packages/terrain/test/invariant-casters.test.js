// Every shadow and depth caster position of this package is @invariant (WGSL 12.10): two programs that draw one
// surface into the same depth target write the same depth only when both declare it (WGSL 15.7.5 lets each program
// reassociate and fuse float operations). The casters: the one vertex entry that draws colour, occluder, cascade and local shadows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { casters } from '../../../tests/invariant-positions.mjs';

test('terrain caster positions are @invariant', () => {
  const { all, missing } = casters('terrain');
  assert.equal(all.length, 1, 'the rule still finds every caster of this package');
  assert.deepEqual(missing, []);
});
