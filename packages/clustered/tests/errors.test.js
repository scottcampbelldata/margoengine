import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { parseIES } from '../dist/ies.js';
import { lightSolidAngle } from '../dist/units.js';

// A thrown message names the subject, the problem and the fix after a '; ' clause.
const throwsWithFix = (run, type, message) =>
  assert.throws(run, (error) => error instanceof type && message.test(error.message) && /; \w/.test(error.message));

test('an invalid cluster grid says which grids are valid', () => {
  throwsWithFix(() => new Clustered({ grid: [0, 9, 24] }), RangeError, /^Invalid cluster grid; pass \[x, y, z\]/);
  throwsWithFix(() => new Clustered({ grid: [128, 128, 128] }), RangeError, /product is at most 32768/);
});

test('parseIES and lightSolidAngle errors say what to pass', () => {
  throwsWithFix(() => parseIES(42), TypeError, /^parseIES takes the text of an \.ies file; read the file as a string/);
  throwsWithFix(() => parseIES('not an ies file'), RangeError, /^Invalid IES file: .*; pass the text of a valid IES/);
  throwsWithFix(() => lightSolidAngle(5), TypeError, /pass one of those$/);
});
