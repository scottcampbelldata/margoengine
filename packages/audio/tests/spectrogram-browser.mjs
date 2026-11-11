// The GPU path of audio/spectrogram on the real GPU, native WebGPU and the WebGL2 compatibility layer (one GPU job):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/audio/tests/spectrogram-browser.mjs
// A file over 2^20 samples is transformed in frame batches through compute/fft and compared with the CPU path.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free', compat: false });
try {
  for (const compat of [false, true]) {
    if (compat) await browser.page.reload();
    const result = await browser.page.evaluate(async (compat) => {
      if (compat) {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        await install({ force: true });
      }
      const { createCompute } = await import('/packages/compute/dist/index.js');
      const { stft, istft } = await import('/packages/audio/dist/spectrogram.js');
      using gpu = await createCompute({ backend: 'webgpu' });
      const rate = 48000,
        n = 2 ** 21 + 12345,
        x = new Float32Array(n);
      let a = 7;
      for (let i = 0; i < n; i++) {
        a = (a * 1664525 + 1013904223) >>> 0;
        x[i] = 0.3 * (a / 4294967296 - 0.5) + 0.5 * Math.sin((2 * Math.PI * (200 + (i / n) * 4000) * i) / rate);
      }
      const options = { sampleRate: rate, size: 2048, hop: 512 };
      const cpu = stft(x, options);
      const t0 = performance.now();
      const onGpu = await stft(x, { ...options, gpu });
      const wall = performance.now() - t0;
      let peak = 0,
        worst = 0;
      for (let i = 0; i < cpu.real.length; i++) peak = Math.max(peak, Math.hypot(cpu.real[i], cpu.imag[i]));
      for (let i = 0; i < cpu.real.length; i++)
        worst = Math.max(worst, Math.abs(cpu.real[i] - onGpu.real[i]), Math.abs(cpu.imag[i] - onGpu.imag[i]));
      // The GPU spectrum inverts back to the signal (f32 FFT error, so a looser bar than the CPU path's 1e-6).
      const y = istft(onGpu);
      let back = 0;
      for (let i = 0; i < n; i++) back = Math.max(back, Math.abs(y[i] - x[i]));
      let aborted = '';
      try {
        await stft(x, { ...options, gpu, signal: AbortSignal.abort(new Error('stop')) });
      } catch (e) {
        aborted = e.message;
      }
      return { frames: cpu.frames, relative: worst / peak, back, wall: +wall.toFixed(0), aborted };
    }, compat);
    assert.ok(result.relative < 1e-4, `GPU spectrum differs from the CPU path by ${result.relative} of the peak`);
    assert.ok(result.back < 1e-3, `GPU round trip ${result.back}`);
    assert.equal(result.aborted, 'stop');
    console.log(`spectrogram ${compat ? 'WebGL2' : 'WebGPU'}: ` + JSON.stringify(result));
  }
} finally {
  await browser.close();
}
