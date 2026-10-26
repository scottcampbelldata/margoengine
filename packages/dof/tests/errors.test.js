// DOF option errors are RangeErrors whose message names the valid ranges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOF } from '../dist/index.js';

test('invalid DOF options throw a RangeError that names the fix', () => {
  assert.throws(
    () => new DOF({ aperture: 0 }),
    (error) => error instanceof RangeError && /; use focalLength > 0, focalDistance > focalLength/.test(error.message),
  );
});
