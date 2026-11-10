import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-cinematic.html', port: 'free', compat }),
    errors = [];
  browser.page.setDefaultTimeout(120000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const report = await browser.page.evaluate(async () => {
      const { figures } = await import('/examples/sciviz-cinematic.ts');
      figures.forEach((f) => {
        f.engine.stop();
        f.engine.scene.background = '#000000';
      });
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { cinematicVolume } = await import('/packages/sciviz/dist/cinematic.js');
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      canvas.style.cssText = 'width:64px;height:64px';
      document.body.append(canvas);
      const f = await Figure.create(canvas, {
        axes: false,
        controls: false,
        aspect: [1, 1, 1],
        limits: [0, 1, 0, 1, 0, 1],
      });
      f.engine.stop();
      f.engine.camera.position = [0, 0, 4];
      f.engine.camera.target = [0, 0, 0];
      f.engine.scene.background = '#000000';
      const gpuErrors = [];
      f.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const volume = f.volume(new Float32Array(8 ** 3).fill(0.5), {
        dims: [8, 8, 8],
        bounds: [0, 1, 0, 1, 0, 1],
        range: [0, 1],
        colormap: 'gray',
        opacity: () => 0.08,
        shading: false,
        quality: 4,
      });
      volume.setClassification({
        kind: 'gradient',
        gradientMax: 1,
        size: [2, 2],
        rgba: new Uint8Array(Array.from({ length: 4 }, () => [128, 128, 128, 20]).flat()),
      });
      const c = cinematicVolume(f, volume, { ambient: [1, 1, 1], light: [0, 0, 0] });
      await f.ready();
      async function accumulate(samples) {
        const deadline = performance.now() + 20000;
        while (c.samples < samples) {
          if (performance.now() >= deadline) throw Error('Cinematic accumulation timed out');
          f.engine.render();
          await f.renderer.device.queue.onSubmittedWorkDone();
        }
      }
      async function pixels() {
        const bmp = await createImageBitmap(await f.toPNG({ overlays: false }));
        const canvas = new OffscreenCanvas(64, 64),
          g = canvas.getContext('2d');
        g.drawImage(bmp, 0, 0);
        bmp.close();
        return g.getImageData(0, 0, 64, 64).data;
      }
      const centre = (p) => p[(32 * 64 + 32) * 4],
        srgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
      // Classifier alpha is RGBA8, not the requested unquantised 0.08.
      const sigma = -Math.log(1 - Math.round(255 * 0.08) / 255) * 7,
        alpha = 1 - Math.exp(-sigma);
      const plain = centre(await pixels()),
        plainCost = await c.cost({ signal: AbortSignal.timeout(20000) });
      const expected = Math.round(srgb(128 / 255) * alpha * 255);
      c.configure({ ambientOcclusion: { directions: 6, radius: 1, steps: 4 }, ambient: [1, 1, 1], light: [0, 0, 0] });
      const ao = centre(await pixels()),
        aoCost = await c.cost();
      c.configure({ shadows: { steps: 32 }, lightDirection: [0, 0, 1], ambient: [0, 0, 0], light: [1, 1, 1] });
      const shadow = centre(await pixels()),
        shadowCost = await c.cost();
      let aoIntegral = 0;
      for (let i = 0; i < 4096; i++) {
        const t = (i + 0.5) / 4096,
          p = [0.5, 0.5, 1 - t];
        let visibility = 0;
        for (let k = 0; k < 6; k++) {
          const z = 1 - (2 * (k + 0.5)) / 6,
            r = Math.sqrt(1 - z * z),
            angle = k * 2.39996323,
            d = [r * Math.cos(angle), r * Math.sin(angle), z];
          const distance = Math.min(1 / 7, ...d.map((n, a) => (n === 0 ? Infinity : (n > 0 ? 1 - p[a] : -p[a]) / n)));
          visibility += Math.exp(-sigma * distance) / 6;
        }
        aoIntegral += (Math.exp(-sigma * t) * sigma * visibility) / 4096;
      }
      const expectedAO = Math.round(srgb(((128 / 255) * aoIntegral) / alpha) * alpha * 255);
      const shadowEnergy = (1 - Math.exp(-2 * sigma)) / 2;
      const expectedShadow = Math.round(srgb(((128 / 255) * shadowEnergy) / alpha) * alpha * 255);
      const pathOptions = {
        shadows: { steps: 16 },
        pathTracing: { bounces: 1, anisotropy: 0, albedo: 1, samples: 256 },
        lightDirection: [0, 0, 1],
        ambient: [0, 0, 0],
        light: [1, 1, 1],
      };
      c.configure(pathOptions);
      await accumulate(16);
      const early = await pixels();
      await accumulate(256);
      const pathCost = await c.cost(),
        pathPixels = await pixels(),
        samples = c.samples;
      let error = 0,
        earlyError = 0,
        mean = 0,
        count = 0;
      for (let y = 26; y < 38; y++)
        for (let x = 26; x < 38; x++) {
          const value = pathPixels[(y * 64 + x) * 4];
          mean += value;
          error += (value - expectedShadow) ** 2;
          earlyError += (early[(y * 64 + x) * 4] - expectedShadow) ** 2;
          count++;
        }
      mean /= count;
      c.configure({ ...pathOptions, pathTracing: { ...pathOptions.pathTracing, anisotropy: 0.6 } });
      await accumulate(256);
      const forward = centre(await pixels());
      volume.setClassification({
        kind: 'gradient',
        gradientMax: 1,
        size: [2, 2],
        rgba: new Uint8Array(Array.from({ length: 4 }, () => [255, 255, 255, 20]).flat()),
      });
      c.configure({ pathTracing: { bounces: 32, albedo: 1, samples: 128 }, ambient: [1, 1, 1], light: [0, 0, 0] });
      await accumulate(128);
      const multipleCost = await c.cost(),
        multiplePixels = await pixels();
      let multipleMean = 0;
      for (let y = 26; y < 38; y++)
        for (let x = 26; x < 38; x++) multipleMean += multiplePixels[(y * 64 + x) * 4] / 144;
      const expectedMultiple = Math.round(alpha * 255);
      volume.setClassification({
        kind: 'gradient',
        gradientMax: 1,
        size: [2, 2],
        rgba: new Uint8Array(Array.from({ length: 4 }, () => [128, 128, 128, 20]).flat()),
      });
      f.engine.camera.position = [0.1, 0, 4];
      f.engine.render();
      const cameraReset = c.samples;
      c.configure({ ambient: [1, 1, 1], light: [0, 0, 0] });
      f.engine.camera.position = [0, 0, 4];
      const before = await pixels();
      c.restore();
      const after = await pixels();
      const restoreError = Math.max(...before.map((n, i) => Math.abs(n - after[i])));
      await f.engine.rebootDevice();
      f.engine.stop();
      await f.ready();
      f.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const reboot = await pixels(),
        rebootError = Math.max(...before.map((n, i) => Math.abs(n - reboot[i])));
      c.dispose();
      const sourceVisible = volume.visible;
      const demoLit = [];
      for (const fig of figures) {
        const bmp = await createImageBitmap(await fig.toPNG({ overlays: false }));
        const cv = new OffscreenCanvas(bmp.width, bmp.height),
          g = cv.getContext('2d');
        g.drawImage(bmp, 0, 0);
        bmp.close();
        const p = g.getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        for (let i = 0; i < p.length; i += 4) if (p[i] + p[i + 1] + p[i + 2] > 60) n++;
        demoLit.push(n);
      }
      f.dispose();
      return {
        plain,
        expected,
        plainCost,
        ao,
        aoCost,
        expectedAO,
        shadow,
        expectedShadow,
        shadowCost,
        pathMean: mean,
        pathRMSE: Math.sqrt(error / count),
        earlyRMSE: Math.sqrt(earlyError / count),
        multipleMean,
        expectedMultiple,
        multipleCost,
        pathCost,
        samples,
        forward,
        cameraReset,
        restoreError,
        rebootError,
        sourceVisible,
        demoLit,
        gpuErrors,
      };
    });
    console.log(JSON.stringify({ compat, ...report }));
    assert.deepEqual(errors, []);
    assert.deepEqual(report.gpuErrors, []);
    assert.ok(Math.abs(report.plain - report.expected) <= 2, JSON.stringify(report));
    assert.ok(Math.abs(report.ao - report.expectedAO) <= 2, JSON.stringify(report));
    assert.ok(
      report.ao < report.plain &&
        report.aoCost.ambientRays > 0 &&
        report.aoCost.scalarSamples > report.plainCost.scalarSamples,
    );
    assert.ok(Math.abs(report.shadow - report.expectedShadow) <= 2, JSON.stringify(report));
    assert.ok(Math.abs(report.pathMean - report.expectedShadow) <= 4 && report.pathRMSE < 9, JSON.stringify(report));
    assert.ok(
      report.pathRMSE < report.earlyRMSE &&
        Math.abs(report.multipleMean - report.expectedMultiple) <= 4 &&
        report.multipleCost.collisions > 0,
    );
    assert.ok(
      report.forward < report.pathMean * 0.5 && report.pathCost.collisions > 0 && report.shadowCost.shadowRays > 0,
    );
    assert.equal(report.samples, 256);
    assert.equal(report.cameraReset, 1);
    assert.equal(report.restoreError, 0);
    assert.equal(report.rebootError, 0);
    assert.equal(report.sourceVisible, true);
    assert.ok(report.demoLit.every((n) => n > 500));
    reports.push({ compat, ...report });
    await browser.page.screenshot({ path: `test-results/batch173-cinematic-${compat ? 'compat' : 'native'}.png` });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch173-cinematic.json', JSON.stringify(reports, null, 2) + '\n');
