import test from 'node:test';
import assert from 'node:assert/strict';
import { CulledInstances, CulledMeshes } from '../dist/index.js';

// A thrown message names the subject, the problem and the fix after a '; ' clause.
const throwsWithFix = (run, type, message) =>
  assert.throws(run, (error) => error instanceof type && message.test(error.message) && /; \w/.test(error.message));

test('an unknown culling mode lists the valid modes', () => {
  throwsWithFix(
    () => new CulledInstances([{}], { culling: 'sphere' }),
    TypeError,
    /use "none", "frustum" or "occlusion"$/,
  );
});

test('an invalid batch says what a batch needs', () => {
  throwsWithFix(() => new CulledInstances([{}]), TypeError, /^Invalid culled batch; give each batch a geometry/);
});

test('CulledMeshes rejects a bad minRadius with the valid range', () => {
  throwsWithFix(() => new CulledMeshes({ minRadius: -1 }), RangeError, /set minRadius to a number from 0 up to 1e6$/);
});
