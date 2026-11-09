import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { referenceOcean } from './fft-reference.js';

await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const observation = (await readFile(new URL('./data/46042-20230101.txt', import.meta.url), 'utf8'))
  .trim()
  .split('\n')[2]
  .trim()
  .split(/\s+/)
  .map(Number);
const windAngle = (observation[5] * Math.PI) / 180;
const base = {
  resolution: 16,
  segments: 32,
  size: 128,
  followCamera: false,
  windDirection: [-Math.sin(windAngle), -Math.cos(windAngle)],
  windSpeed: observation[6],
  fetch: 100000,
  peakEnhancement: 3.3,
  seed: 234,
  choppiness: 1,
  cascades: [
    { length: 128, minWavelength: 16 },
    { length: 16, minWavelength: 2, maxWavelength: 16 },
  ],
};
const report = {
  hardware,
  observation: { station: '46042', utc: '2023-01-01T00:00:00Z', windFrom: observation[5], windSpeed: observation[6] },
  spectra: [],
};
try {
  await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:512px;height:320px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 16,
      camera: { position: [0, 7, 30], target: [0, 0, 0], near: 0.1, far: 1000 },
    });
    engine.gpu.pushErrorScope('validation');
    window.fftTest = { engine };
  });
  for (const spectrum of ['phillips', 'jonswap']) {
    const options = { ...base, spectrum, amplitude: spectrum === 'phillips' ? 0.0005 : 1 };
    for (const time of [0, 1.25]) {
      const frame = await page.evaluate(
        async ({ options, time }) => {
          const { FFTOcean } = await import('/packages/water/dist/fft.js');
          const state = window.fftTest;
          state.ocean?.dispose();
          state.ocean = FFTOcean.attach(state.engine, options);
          state.ocean.setTime(time);
          state.engine.render({ delta: 0 });
          const frame = await state.ocean.readFrame();
          return { ...frame, data: Array.from(frame.data) };
        },
        { options, time },
      );
      const oracle = referenceOcean(options, time);
      let maxError = 0,
        maxMagnitude = 0,
        minJacobian = Infinity,
        maxFoam = 0;
      for (let c = 0; c < oracle.length; c++)
        for (let p = 0; p < base.resolution ** 2; p++) {
          const index = (c * base.resolution ** 2 + p) * 12;
          for (let field = 0; field < 6; field++) {
            const actual = frame.data[index + (field < 3 ? field : field + 1)];
            assert.ok(Number.isFinite(actual), 'GPU output must be finite');
            maxError = Math.max(maxError, Math.abs(actual - oracle[c][p * 6 + field]));
            maxMagnitude = Math.max(maxMagnitude, Math.abs(oracle[c][p * 6 + field]));
          }
          minJacobian = Math.min(minJacobian, frame.data[index + 7]);
          maxFoam = Math.max(maxFoam, frame.data[index + 3]);
          const normalLength = Math.hypot(...frame.data.slice(index + 8, index + 11));
          assert.ok(Math.abs(normalLength - 1) < 0.00001, 'surface normals are unit length');
          const n = base.resolution,
            x = p % n,
            z = Math.floor(p / n),
            spacing = base.cascades[c].length / n;
          const at = (i, j, field) => oracle[c][(((j + n) % n) * n + ((i + n) % n)) * 6 + field];
          const dx = [0, 1, 2].map((field) => (at(x + 1, z, field) - at(x - 1, z, field)) / (2 * spacing));
          const dz = [0, 1, 2].map((field) => (at(x, z + 1, field) - at(x, z - 1, field)) / (2 * spacing));
          dx[0] += 1;
          dz[2] += 1;
          const determinant = dx[0] * dz[2] - dx[2] * dz[0];
          assert.ok(
            Math.abs(frame.data[index + 7] - determinant) < 0.00001,
            'Jacobian matches the independent displacement derivatives',
          );
          const normal = [dz[1] * dx[2] - dz[2] * dx[1], dz[2] * dx[0] - dz[0] * dx[2], dz[0] * dx[1] - dz[1] * dx[0]];
          const length = Math.hypot(...normal);
          for (let axis = 0; axis < 3; axis++)
            assert.ok(
              Math.abs(frame.data[index + 8 + axis] - normal[axis] / length) < 0.00001,
              'normal includes the choppy tangent derivatives',
            );
          const expectedFoam = Math.max(0, Math.min(1, (Math.fround(0.7) - determinant) * 2));
          assert.ok(
            Math.abs(frame.data[index + 3] - expectedFoam) < 0.00001,
            'fresh foam is exactly the compressed Jacobian mask',
          );
        }
      report.spectra.push({ spectrum, time, maxError, maxMagnitude, minJacobian, maxFoam });
      assert.ok(maxError < 0.001, `GPU ${spectrum} differs from the independent Fourier sum: ${maxError}`);
      assert.ok(maxMagnitude > 0.001, 'ocean cannot be a flat placeholder');
    }
    await page.locator('canvas').screenshot({
      path: `test-results/water-fft-${spectrum}-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}.png`,
    });
  }
  const folding = await page.evaluate(async (base) => {
    const { engine, ocean } = window.fftTest;
    const { FFTOcean } = await import('/packages/water/dist/fft.js');
    ocean.dispose();
    const storm = FFTOcean.attach(engine, { ...base, amplitude: 10, choppiness: 5, foamLifetime: 4 });
    window.fftTest.ocean = storm;
    engine.render({ delta: 0 });
    const first = await storm.readFrame();
    storm.setTime(0.05);
    engine.render({ delta: 0 });
    const next = await storm.readFrame();
    let negative = 0,
      persistent = 0,
      maxError = 0;
    for (let i = 0; i < first.data.length; i += 12) {
      if (first.data[i + 7] < 0) negative++;
      const fresh = Math.max(0, Math.min(1, (Math.fround(0.7) - next.data[i + 7]) * 2));
      const expected = Math.max(first.data[i + 3] * Math.exp(-Math.fround(0.05) / 4), fresh);
      maxError = Math.max(maxError, Math.abs(next.data[i + 3] - expected));
      if (next.data[i + 3] > fresh + 0.001) persistent++;
    }
    return { negative, persistent, maxError };
  }, base);
  assert.ok(folding.negative > 0, 'choppy displacement must produce actual negative folding determinants');
  assert.ok(folding.persistent > 0, 'foam must survive after compression has moved away');
  assert.ok(folding.maxError < 0.00001, 'foam history uses the specified exponential lifetime');
  report.folding = folding;
  const lifecycle = await page.evaluate(async (base) => {
    const { engine, ocean } = window.fftTest;
    const first = await ocean.readFrame();
    engine.render({ delta: 0 });
    const repeated = await ocean.readFrame();
    const same = first.data.every((v, i) => v === repeated.data[i]);
    ocean.setTime(2);
    engine.render({ delta: 0 });
    const moving = await ocean.readFrame();
    const changed = moving.data.some((v, i) => Math.abs(v - first.data[i]) > 0.001);
    ocean.setTime(0);
    engine.render({ delta: 0 });
    const reset = await ocean.readFrame();
    ocean.onDeviceRestored(engine);
    engine.render({ delta: 0 });
    const restored = await ocean.readFrame();
    const restoredSame = reset.data.every((v, i) => v === restored.data[i]);
    const { FFTOcean } = await import('/packages/water/dist/fft.js');
    ocean.dispose();
    const calm = FFTOcean.attach(engine, { ...base, amplitude: 0, height: 100000.1, cascades: [{ length: 100.1 }] });
    calm.setTime(0.1);
    engine.render({ delta: 0 });
    const flat = await calm.readFrame();
    const flatExact = flat.data.every((v, i) => v === ([7, 9].includes(i % 12) ? 1 : 0));
    const metadataExact =
      flat.time === Math.fround(0.1) && flat.height === Math.fround(100000.1) && flat.lengths[0] === Math.fround(100.1);
    const aborted = new AbortController();
    aborted.abort();
    let abortName;
    try {
      await calm.readFrame({ signal: aborted.signal });
    } catch (error) {
      abortName = error.name;
    }
    const validation = await engine.gpu.popErrorScope();
    engine.dispose();
    return { same, changed, restoredSame, flatExact, metadataExact, abortName, validation: validation?.message };
  }, base);
  assert.deepEqual(lifecycle, {
    same: true,
    changed: true,
    restoredSame: true,
    flatExact: true,
    metadataExact: true,
    abortName: 'AbortError',
    validation: undefined,
  });
  assert.deepEqual(errors, []);
  report.lifecycle = lifecycle;
  const backend = process.argv.includes('--compat') ? 'compat' : 'webgpu';
  await writeFile(`test-results/water-fft-${backend}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
