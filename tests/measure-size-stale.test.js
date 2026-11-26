// Bug (2026-11-26): a lane rebased past a core change without rebuilding core, measured its old dist at 22,202 B and
// read the published 22,225 B as wrong. Measuring refuses a dist whose package stamp does not match the sources.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFreshDist, measureCore, measureCoreStage } from '../scripts/measure-size.js';

test('measuring core refuses a stale core dist', () => {
  assert.throws(() => measureCore({ stale: ['core'] }), {
    code: 'MEASURE_SIZE_STALE_DIST',
    message: /packages\/core\/dist/,
  });
});

test('measuring core + stage refuses a stale stage dist and a stale core dist', async () => {
  await assert.rejects(measureCoreStage({ stale: ['stage'] }), {
    code: 'MEASURE_SIZE_STALE_DIST',
    message: /stage\/dist/,
  });
  await assert.rejects(measureCoreStage({ stale: ['core', 'gltf'] }), {
    code: 'MEASURE_SIZE_STALE_DIST',
    message: /core\/dist/,
  });
});

test('a stale package the measurement does not read is no reason to refuse', () => {
  assert.doesNotThrow(() => checkFreshDist(['core', 'stage'], ['gltf', 'usdz']));
});
