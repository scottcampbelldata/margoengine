import test from 'node:test';
import assert from 'node:assert/strict';
import { FFTOcean } from '../dist/fft.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('FFT snapshot dimensions use the exact binary32 values uploaded to the GPU', () => {
  const ocean = new FFTOcean({ height: 100000.1, cascades: [{ length: 100.1 }] });
  assert.equal(ocean.height, Math.fround(100000.1));
  assert.equal(ocean.lengths[0], Math.fround(100.1));
  ocean.dispose();
});

test('FFT settings reject invalid grids, energy duplication and nonfinite parameters', () => {
  for (const options of [
    { resolution: 20 },
    { resolution: 1024 },
    { windDirection: [0, 0] },
    { spectrum: 'other' },
    { windSpeed: Infinity },
    { amplitude: -1 },
    { seed: 0.5 },
    { cascades: [] },
    { segments: 1.5 },
    { color: [1, NaN, 0] },
    { cascades: [{ length: 64 }, { length: 32 }] },
    { cascades: [{ length: 64, minWavelength: 0.5 }] },
  ])
    assert.throws(() => new FFTOcean(options), /ocean/);
  assert.doesNotThrow(() => new FFTOcean({ resolution: 16, amplitude: 0, choppiness: 0 }));
});

test('FFT absolute time, disposal and preview refusal have explicit lifecycle contracts', async () => {
  const ocean = new FFTOcean({ segments: 1 });
  ocean.setTime(4).onPreUpdate(0.25);
  assert.equal(ocean.time, 4.25);
  assert.throws(() => ocean.setTime(NaN));
  await assert.rejects(ocean.readFrame(), { code: 'state' });
  assert.throws(() => ocean.setup({}), { code: 'unsupported' });
  ocean.dispose();
  ocean.dispose();
  assert.throws(() => ocean.setTime(0), { code: 'disposed' });
  await assert.rejects(ocean.readFrame(), { code: 'disposed' });
});

test('FFT frame allocations are retained; restoration destroys owned buffers', () => {
  const h = optionalGPU();
  // The harness records resource ownership without pretending to execute a numerical transform.
  const ocean = new FFTOcean({ resolution: 16, segments: 4 });
  h.engine.use(ocean);
  const first = [...h.resources];
  assert.throws(
    () => ocean.setup(h.engine),
    (error) => error.code === 'attached' && error.message.includes('https://margoengine.com/errors#state'),
  );
  ocean.onDeviceRestored(h.engine);
  assert.ok(first.every((resource) => resource.destroyed));
  ocean.dispose();
  assert.ok(h.resources.every((resource) => resource.destroyed));
});
