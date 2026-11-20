// Every shadow and depth caster position of this package is @invariant (WGSL 12.10): two programs that draw one
// surface into the same depth target write the same depth only when both declare it (WGSL 15.7.5 lets each program
// reassociate and fuse float operations). The casters: the contact shadow occluders, the studio's own and the core-mesh occluder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { casters } from '../../../tests/invariant-positions.mjs';

test('studio caster positions are @invariant', () => {
  const { all, missing } = casters('studio');
  assert.equal(all.length, 2, 'the rule still finds every caster of this package');
  assert.deepEqual(missing, []);
});
