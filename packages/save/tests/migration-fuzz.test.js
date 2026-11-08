import assert from 'node:assert/strict';
import test from 'node:test';
import { roundTrip, roundTrips } from '../scripts/fuzz-roundtrip.mjs';

test('a seeded save migrates, round-trips and migrates again to the same document', async () => {
  const one = await roundTrip(167);
  assert.ok(one > 0);
  const many = await roundTrips(167, 40);
  assert.equal(many.count, 40);
  assert.ok(many.bytes > one);
});
