// The expected numbers were recorded from the capsule code before the allocation fix (see capsule-golden-inputs.js).
// Every result must match bit for bit, including the sign of zero.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CapsuleVolume, closestPointsBetweenSegments } from '../dist/index.js';
import { capsuleCases } from './capsule-golden-inputs.js';

const expected = JSON.parse(
  readFileSync(new URL('./fixtures/capsule-golden.json', import.meta.url), 'utf8'),
  (_k, v) => (v === '-0' ? -0 : v),
);

test('capsule distances, normals and segment points match the recorded results exactly', () => {
  const cases = capsuleCases();
  assert.equal(cases.length, expected.length);
  cases.forEach(({ a, b, c, d, p, radius }, i) => {
    const cap = new CapsuleVolume({ start: a, end: b, radius });
    const surface = [0, 0, 0],
      normal = [0, 0, 0];
    const distance = cap.evaluate(p, surface, normal);
    const clearance = cap.segmentClearance(c, d, 0.125 * radius);
    const r = closestPointsBetweenSegments(a, b, c, d);
    const actual = {
      distance,
      surface,
      normal,
      clearance,
      pointA: [...r.pointA],
      pointB: [...r.pointB],
      d: r.distance,
      pa: r.parameterA,
      pb: r.parameterB,
    };
    assert.deepStrictEqual(actual, expected[i], `case ${i}`);
  });
});
