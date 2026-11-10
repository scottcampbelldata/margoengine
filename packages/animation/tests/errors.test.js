import test from 'node:test';
import assert from 'node:assert/strict';
import { MargoError } from '@margoengine/math/errors';
import { sampleTrack } from '../dist/sampling.js';
import { animationPath, animationInterpolation, animationIndex, skinDefinition } from '../src/gltf.ts';

const times = new Float32Array([0, 1]);

/** Asserts the throw's class and that its message carries a fix clause. */
function names(fn, Class, pattern) {
  assert.throws(
    fn,
    (e) => e instanceof Class && pattern.test(e.message) && /;|\b(use|pass|give|must|needs)\b/.test(e.message),
  );
}

test('sampling errors name their fix', () => {
  names(
    () => sampleTrack(times, new Float32Array(3), 3, 0.5, 'LINEAR'),
    RangeError,
    /output count mismatch; values needs/,
  );
  names(() => sampleTrack(times, new Float32Array(6), 0, 0.5, 'LINEAR'), TypeError, /Invalid animation track; pass/);
  names(
    () => sampleTrack(times, new Float32Array(8), 4, 0.5, 'LINEAR', true),
    RangeError,
    /Zero animation quaternion; rotation/,
  );
  names(
    () => sampleTrack(times, new Float32Array(6), 3, 0.5, 'LINEAR', false, new Float32Array(2)),
    TypeError,
    /sample target; pass/,
  );
});

test('glTF animation reads name their fix', () => {
  names(() => animationPath('pointer'), TypeError, /path must be translation/);
  names(() => animationInterpolation('SPLINE'), RangeError, /interpolation must be STEP/);
  names(() => animationIndex(9, 2, 'sampler'), TypeError, /Invalid animation sampler; use an integer index/);
  names(() => skinDefinition({ joints: [99] }, 2), TypeError, /Invalid skin joints; use/);
});

test('Error throws became coded errors', async () => {
  // Source-level check: the converted throws carry MargoError codes or Range/TypeErrors, never a bare Error.
  const { readFile } = await import('node:fs/promises');
  for (const file of ['index', 'vat']) {
    const text = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /throw new Error\(/, file);
  }
  assert.ok(new MargoError('disposed', 'x') instanceof Error);
});
