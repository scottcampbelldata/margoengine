import test from 'node:test';
import assert from 'node:assert/strict';
import { FFTOcean, MAX_OCEAN_DEBUG_POINTS } from '../dist/fft.js';
import { referenceOcean } from './fft-reference.js';
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
    assert.throws(() => new FFTOcean(options), { name: 'MargoError', code: 'unsupported', message: /errors#ocean/ });
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

test('FFTOcean.setWind validates atomically with coded errors, retunes in place without leaking buffers, and survives restore', () => {
  const h = optionalGPU();
  // The draw reads the engine's sun and the view's camera; the harness carries neither by default.
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 1]) };
  h.context.camera = { ...h.context.camera, matrix: new Float32Array(16), position: [0, 5, 0] };
  const ocean = new FFTOcean({ resolution: 16, segments: 4, windSpeed: 8, fetch: 50000, windDirection: [1, 0] });
  h.engine.use(ocean);
  h.frame();
  const buffersAfterSetup = h.counts.buffers;

  // Reject invalid inputs atomically with coded errors.
  for (const bad of [null, undefined, 'fast', 0, -5, 101, NaN, { speed: 0 }, { speed: 12, fetch: 0 }, { speed: 12, direction: [0, 0] }, { speed: 12, direction: [1, NaN] }]) {
    assert.throws(
      () => ocean.setWind(bad),
      (err) => err.name === 'MargoError' && err.code === 'unsupported' && /errors#ocean/.test(err.message),
    );
  }
  assert.equal(ocean.wind.speed, 8);
  assert.equal(ocean.wind.fetch, 50000);
  assert.deepEqual([...ocean.wind.direction], [1, 0]);

  // Number form keeps fetch & direction; object form updates only specified fields.
  ocean.setWind(18);
  assert.equal(ocean.wind.speed, 18);
  assert.equal(ocean.wind.fetch, 50000);
  assert.deepEqual([...ocean.wind.direction], [1, 0]);
  h.frame();
  assert.equal(h.counts.buffers, buffersAfterSetup, 'setWind allocates zero new GPU buffers');

  ocean.setWind({ speed: 24, fetch: 200000, direction: [0, 2] });
  assert.equal(ocean.wind.speed, 24);
  assert.equal(ocean.wind.fetch, 200000);
  assert.ok(Math.abs(ocean.wind.direction[0]) < 1e-6 && Math.abs(ocean.wind.direction[1] - 1) < 1e-6);
  h.frame();
  assert.equal(h.counts.buffers, buffersAfterSetup, 'repeated setWind leaks zero GPU buffers');

  // Device restore preserves the live wind settings.
  ocean.onDeviceRestored(h.engine);
  assert.equal(ocean.wind.speed, 24);
  assert.equal(ocean.wind.fetch, 200000);
  assert.ok(Math.abs(ocean.wind.direction[1] - 1) < 1e-6);
  h.frame();

  // Live setters for choppiness, foam threshold, color and debug view.
  ocean.setChoppiness(1.8).setFoamThreshold(0.55).setColor([0.02, 0.2, 0.3]);
  assert.equal(ocean.choppiness, Math.fround(1.8));
  assert.equal(ocean.foamThreshold, Math.fround(0.55));
  ocean.setDebug({ enabled: true, mode: 'jacobian', wireframe: true, lodRings: true, samplePoints: [[0, 0], [5, -3]] });
  assert.equal(ocean.debug.enabled, true);
  assert.equal(ocean.debug.mode, 'jacobian');
  assert.equal(ocean.debug.wireframe, true);
  assert.equal(ocean.debug.lodRings, true);
  assert.equal(ocean.debug.samplePoints.length, 2);
  assert.throws(
    () => ocean.setDebug({ samplePoints: Array.from({ length: MAX_OCEAN_DEBUG_POINTS + 1 }, () => [0, 0]) }),
    (err) => err.code === 'unsupported',
  );
  ocean.setDebug(false);
  assert.equal(ocean.debug.enabled, false);
  assert.equal(ocean.debug.mode, 'off');

  ocean.dispose();
  assert.throws(() => ocean.setWind(10), { code: 'disposed' });
  assert.throws(() => ocean.sample(0, 0), { code: 'disposed' });
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('FFTOcean.sample matches the independent O(N^4) Fourier oracle synchronously on CPU before and after setWind', () => {
  for (const spectrum of ['jonswap', 'phillips']) {
    const base = {
      resolution: 16,
      segments: 16,
      size: 128,
      height: 1.5,
      spectrum,
      amplitude: spectrum === 'phillips' ? 0.0005 : 1,
      windDirection: [1, 0.3],
      windSpeed: 10,
      fetch: 100000,
      peakEnhancement: 3.3,
      seed: 234,
      choppiness: 0,
      cascades: [
        { length: 128, minWavelength: 16 },
        { length: 16, minWavelength: 2, maxWavelength: 16 },
      ],
    };
    const ocean = new FFTOcean(base);
    const oracle0 = referenceOcean(base, 1.25);
    // At choppiness 0, grid points map directly without horizontal shift.
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const x = (i * 128) / 16,
          z = (j * 128) / 16;
        const s = ocean.sample(x, z, 1.25);
        assert.equal(s.height, ocean.sampleHeight(x, z, 1.25));
        // Sum both cascades at (x, z) from oracle.
        let expectedY = base.height,
          expectedVy = 0;
        for (let c = 0; c < 2; c++) {
          const L = base.cascades[c].length;
          const gx = Math.round(((x / L) * 16) % 16);
          const gz = Math.round(((z / L) * 16) % 16);
          expectedY += oracle0[c][(gz * 16 + gx) * 6 + 1];
          expectedVy += oracle0[c][(gz * 16 + gx) * 6 + 4];
        }
        // Bound: the CPU grid is stored in binary32 like the GPU frame, 2^-24 of values under 3 m or m/s (about 2e-7)
        // summed over two cascades; the spectrum and its band edges are the shader's binary32 values.
        assert.ok(Math.abs(s.height - expectedY) < 1e-6, `${spectrum} height diff ${Math.abs(s.height - expectedY)}`);
        assert.ok(Math.abs(s.velocity[1] - expectedVy) < 1e-6, `${spectrum} vy diff ${Math.abs(s.velocity[1] - expectedVy)}`);
        const nLen = Math.hypot(...s.normal);
        assert.ok(Math.abs(nLen - 1) < 1e-6 && s.normal[1] > 0, 'unit upward normal');
      }
    }
    // Now retune wind live and confirm synchronous CPU sample immediately matches the new oracle!
    ocean.setWind({ speed: 20, fetch: 150000, direction: [0, 1] });
    const updated = { ...base, windSpeed: 20, fetch: 150000, windDirection: [0, 1] };
    const oracle1 = referenceOcean(updated, 2.0);
    const s1 = ocean.sample(0, 0, 2.0);
    const expectedY1 = base.height + oracle1[0][1] + oracle1[1][1];
    assert.ok(Math.abs(s1.height - expectedY1) < 1e-6, `${spectrum} post-setWind height diff ${Math.abs(s1.height - expectedY1)}`);
    ocean.dispose();
  }
});
