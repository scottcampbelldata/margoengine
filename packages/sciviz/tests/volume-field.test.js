import assert from 'node:assert/strict';
import test from 'node:test';
import { N, fillVolume } from '../scripts/rival-data.js';

test('volume-64 radial field matches its locked sum', () => {
  const { data, sum } = fillVolume();
  assert.equal(data.length, N * N * N);
  const c = (N - 1) / 2;
  let again = 0;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const value = Math.max(0, 1 - Math.hypot(x - c, y - c, z - c) / c);
        assert.equal(data[x + N * (y + N * z)], Math.fround(value));
        again += value;
      }
    }
  }
  assert.equal(again, 32731.121874443877);
  assert.equal(sum, 32731.121874443877);
});
