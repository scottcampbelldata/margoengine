import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { referenceOcean } from './fft-reference.js';
import { fileURLToPath } from 'node:url';

// The page and the results are paths of the repository root; test:gpu runs from packages/water.
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));

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
      path: `test-results/water-fft-${spectrum}-${browser.hardware?.compat ? 'compat' : 'webgpu'}.png`,
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
    calm.dispose();

    // Live setWind, synchronous CPU sample vs GPU readFrame & WaveQuery, and debug views.
    const { Water } = await import('/packages/water/dist/index.js');
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const live = FFTOcean.attach(engine, {
      ...base,
      spectrum: 'jonswap',
      amplitude: 1,
      choppiness: 0,
      windSpeed: 8,
      windDirection: [1, 0],
    });
    live.setTime(1.5);
    engine.render({ delta: 0 });
    const beforeWind = await live.readFrame();
    live.setWind({ speed: 18, fetch: 150000, direction: [0, 1] });
    engine.render({ delta: 0 });
    const afterWind = await live.readFrame();
    const windChanged = afterWind.data.some((v, i) => Math.abs(v - beforeWind.data[i]) > 0.01);
    // Device restore must preserve the live setWind state.
    live.onDeviceRestored(engine);
    engine.render({ delta: 0 });
    const afterWindRestored = await live.readFrame();
    const windRestoredSame = afterWind.data.every((v, i) => v === afterWindRestored.data[i]);
    // Sync sample() vs GPU readFrame() at choppiness 0.
    let syncMaxErr = 0;
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const x = (i * 128) / 16,
          z = (j * 128) / 16;
        const s = live.sample(x, z, 1.5);
        let gpuY = live.height;
        for (let c = 0; c < 2; c++) {
          const L = base.cascades[c].length;
          const gx = Math.round(((x / L) * 16) % 16);
          const gz = Math.round(((z / L) * 16) % 16);
          gpuY += afterWind.data[(c * 256 + gz * 16 + gx) * 12 + 1];
        }
        syncMaxErr = Math.max(syncMaxErr, Math.abs(s.height - gpuY));
      }
    }
    // Choppy sync sample() vs GPU WaveQuery.
    live.setChoppiness(0.8);
    engine.render({ delta: 0 });
    const oceanQuery = await WaveQuery.capture(live);
    const oqSample = oceanQuery.sample(4, -6);
    const ocSync = live.sample(4, -6, 1.5);
    const oceanQueryDiff = oqSample ? Math.abs(ocSync.height - oqSample.height) : Infinity;

    // Debug visualization modes render cleanly without validation errors.
    for (const cfg of [
      { enabled: true, mode: 'normals', lodRings: true, samplePoints: [[0, 0], [4, -6]] },
      { enabled: true, mode: 'foam', wireframe: true },
      { enabled: true, mode: 'jacobian', lodRings: true },
      { enabled: true, mode: 'wireframe' },
      false,
    ]) {
      live.setDebug(cfg);
      engine.render({ delta: 0 });
    }
    live.dispose();

    // Water synchronous CPU sample() vs GPU WaveQuery.
    const surface = Water.attach(engine, {
      size: [64, 64],
      segments: 64,
      height: 0.5,
      waves: [{ direction: [1, 0.25], amplitude: 0.35, wavelength: 24, steepness: 0.35, phase: 0.4 }],
    });
    surface.setTime(2.25);
    engine.render({ delta: 0 });
    const waterQuery = await WaveQuery.capture(surface);
    let waterSyncHeightErr = 0,
      waterSyncNormalErr = 0;
    for (const [qx, qz] of [[0, 0], [5.3, -4.1], [-8.7, 6.2]]) {
      const wq = waterQuery.sample(qx, qz);
      const ws = surface.sample(qx, qz);
      waterSyncHeightErr = Math.max(waterSyncHeightErr, Math.abs(ws.height - wq.height));
      waterSyncNormalErr = Math.max(
        waterSyncNormalErr,
        Math.hypot(ws.normal[0] - wq.normal[0], ws.normal[1] - wq.normal[1], ws.normal[2] - wq.normal[2]),
      );
    }
    surface.dispose();

    const validation = await engine.gpu.popErrorScope();
    engine.dispose();
    return {
      same,
      changed,
      restoredSame,
      flatExact,
      metadataExact,
      abortName,
      windChanged,
      windRestoredSame,
      afterWindData: Array.from(afterWind.data),
      syncMaxErr,
      oceanQueryDiff,
      waterSyncHeightErr,
      waterSyncNormalErr,
      validation: validation?.message,
    };
  }, base);
  const { afterWindData, syncMaxErr, oceanQueryDiff, waterSyncHeightErr, waterSyncNormalErr, ...lifeFlags } = lifecycle;
  assert.deepEqual(lifeFlags, {
    same: true,
    changed: true,
    restoredSame: true,
    flatExact: true,
    metadataExact: true,
    abortName: 'AbortError',
    windChanged: true,
    windRestoredSame: true,
    validation: undefined,
  });
  // Verify GPU post-setWind field against independent O(N^4) Fourier oracle.
  const windOracle = referenceOcean(
    { ...base, spectrum: 'jonswap', amplitude: 1, choppiness: 0, windSpeed: 18, fetch: 150000, windDirection: [0, 1] },
    1.5,
  );
  let windOracleErr = 0;
  for (let c = 0; c < 2; c++) {
    for (let p = 0; p < 256; p++) {
      windOracleErr = Math.max(windOracleErr, Math.abs(afterWindData[(c * 256 + p) * 12 + 1] - windOracle[c][p * 6 + 1]));
    }
  }
  assert.ok(windOracleErr < 0.001, `setWind GPU output differs from oracle: ${windOracleErr}`);
  assert.ok(syncMaxErr < 0.001, `FFTOcean.sample differs from GPU readFrame: ${syncMaxErr}`);
  assert.ok(oceanQueryDiff < 0.05, `FFTOcean.sample differs from WaveQuery: ${oceanQueryDiff}`);
  assert.ok(waterSyncHeightErr < 0.01, `Water.sample height differs from WaveQuery: ${waterSyncHeightErr}`);
  assert.ok(waterSyncNormalErr < 0.02, `Water.sample normal differs from WaveQuery: ${waterSyncNormalErr}`);
  assert.deepEqual(errors, []);
  report.lifecycle = { ...lifeFlags, windOracleErr, syncMaxErr, oceanQueryDiff, waterSyncHeightErr, waterSyncNormalErr };
  const backend = browser.hardware?.compat ? 'compat' : 'webgpu';
  await writeFile(`test-results/water-fft-${backend}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
