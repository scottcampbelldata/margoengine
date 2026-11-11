import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    const report = await browser.page.evaluate(async () => {
      const { Figure } = await import('/packages/sciviz/dist/index.js'),
        { qualityVolume } = await import('/packages/sciviz/dist/volume-quality.js');
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      canvas.style.cssText = 'width:96px;height:96px';
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
      async function pixels() {
        await f.ready();
        const b = await createImageBitmap(await f.toPNG({ overlays: false })),
          c = new OffscreenCanvas(96, 96),
          g = c.getContext('2d');
        g.drawImage(b, 0, 0);
        b.close();
        return g.getImageData(0, 0, 96, 96).data;
      }
      const centre = (p) => [...p.slice((48 * 96 + 48) * 4, (48 * 96 + 48) * 4 + 3)],
        difference = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      const opts = {
        dims: [33, 33, 33],
        bounds: [0, 1, 0, 1, 0, 1],
        range: [0, 1],
        colormap: ['#ff0000', '#ff0000'],
        opacity: () => 0.02,
        shading: false,
        quality: 4,
      };
      let base = f.volume(new Float32Array(33 ** 3).fill(0.5), opts),
        q = qualityVolume(f, base, { emptySpaceSkipping: false, adaptive: false, jitter: false });
      const fixed = await pixels(),
        expected = Math.round(255 * (1 - (1 - Math.round(0.02 * 255) / 255) ** 32));
      q.configure({ emptySpaceSkipping: true, adaptive: { maxStep: 8, tolerance: 0.01 }, jitter: true });
      const accelerated = await pixels();
      const constantError = difference(fixed, accelerated),
        constant = centre(accelerated);
      q.dispose();
      f.remove(base);
      const sparse = new Float32Array(33 ** 3);
      for (let z = 0; z < 33; z++)
        for (let y = 0; y < 33; y++)
          for (let x = 0; x < 33; x++)
            if ((x - 16) ** 2 + (y - 16) ** 2 + (z - 16) ** 2 < 36) sparse[x + 33 * (y + 33 * z)] = 1;
      base = f.volume(sparse, { ...opts, opacity: (t) => (t > 0.5 ? 0.03 : 0) });
      q = qualityVolume(f, base, { emptySpaceSkipping: false, adaptive: false, jitter: false });
      const full = await pixels();
      q.configure({ emptySpaceSkipping: true, adaptive: false, jitter: false });
      const skipped = await pixels(),
        skippingError = difference(full, skipped);
      q.dispose();
      f.remove(base);
      const ramp = Float32Array.from({ length: 33 ** 3 }, (_, i) => (Math.floor(i / 33) % 33) / 32);
      base = f.volume(ramp, opts);
      q = qualityVolume(f, base, { isovalue: 0.37, refinement: 12, jitter: false, adaptive: false, color: [1, 0, 0] });
      base.quality = 0.25;
      const green = f.volume(new Float32Array(8).fill(0.5), {
        dims: [2, 2, 2],
        bounds: opts.bounds,
        range: [0, 1],
        colormap: ['#00ff00', '#00ff00'],
      });
      green.visible = false;
      const plane = green.slice('y', 0.3701);
      const behind = centre(await pixels());
      plane.position = 0.3699;
      const before = centre(await pixels());
      q.configure({ isovalue: 0.37, refinement: 24, color: [1, 0, 0] });
      plane.position = 0.370001;
      const fineBehind = centre(await pixels());
      plane.position = 0.369999;
      const fineBefore = centre(await pixels());
      plane.visible = false;
      const preRestore = await pixels();
      await f.engine.rebootDevice();
      f.engine.stop();
      await f.ready();
      const reboot = await pixels();
      const rebootError = difference(preRestore, reboot);
      const sourceVisible = base.visible;
      q.dispose();
      const restoredVisibility = base.visible;
      f.remove(base);
      f.remove(green);
      // KB0507f: a preintegrated segment spans [sample, sample + step], the length its opacity is applied over, so
      // the segments tile the ray whatever the jitter. A ramp along the view axis through an opacity spike narrower
      // than one step: every ray crosses the spike once, in one segment or split across two, and draws it whole. With
      // segments ending at t + step (the old code) the jittered start left gaps that missed the spike.
      const { TransferFunction, preintegrateTransfer } = await import('/packages/sciviz/dist/transfer.js');
      const spikeTf = new TransferFunction({
        range: [0, 1],
        gradientMax: 1,
        points: [
          { value: 0, rgba: [1, 0, 0, 0] },
          { value: 0.4975, rgba: [1, 0, 0, 0] },
          { value: 0.5, rgba: [1, 0, 0, 0.9] },
          { value: 0.5025, rgba: [1, 0, 0, 0] },
          { value: 1, rgba: [1, 0, 0, 0] },
        ],
      });
      // Data y runs along this camera's view axis (as the isosurface check above).
      const depthRamp = Float32Array.from({ length: 33 ** 3 }, (_, i) => (Math.floor(i / 33) % 33) / 32);
      base = f.volume(depthRamp, { ...opts, quality: 1 });
      base.setClassification(await preintegrateTransfer(spikeTf, { resolution: 256, samples: 256, range: base.range }));
      const region = (p) => {
        const reds = [];
        for (let y = 40; y < 56; y++) for (let x = 40; x < 56; x++) reds.push(p[(y * 96 + x) * 4]);
        return { min: Math.min(...reds), max: Math.max(...reds), mean: reds.reduce((a, b) => a + b, 0) / reds.length };
      };
      q = qualityVolume(f, base, { emptySpaceSkipping: false, adaptive: false, jitter: false });
      const spikeFixed = region(await pixels());
      q.configure({ emptySpaceSkipping: false, adaptive: false, jitter: true });
      const spikeJittered = region(await pixels());
      q.dispose();
      // The spike's optical depth along the ramp (32 voxels per unit value, opacity per voxel): one crossing.
      let depth = 0;
      for (let k = 0; k < 10000; k++) {
        const v = 0.4975 + ((k + 0.5) / 10000) * 0.005,
          a = 0.9 * (1 - Math.abs(v - 0.5) / 0.0025);
        depth += Math.log1p(-a) * (0.005 / 10000) * 32;
      }
      const spikeExpected = 255 * -Math.expm1(depth);
      f.dispose();
      return {
        constant,
        expected,
        constantError,
        skippingError,
        behind,
        before,
        fineBehind,
        fineBefore,
        rebootError,
        sourceVisible,
        restoredVisibility,
        spikeFixed,
        spikeJittered,
        spikeExpected,
        gpuErrors,
      };
    });
    await browser.page.goto(new URL('/examples/sciviz-volume-quality.html', browser.page.url()).href);
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const demo = await browser.page.evaluate(async () => {
      const d = await import('/examples/sciviz-volume-quality.ts');
      d.figure.engine.stop();
      d.chart.engine.stop();
      d.figure.engine.scene.background = '#000000';
      const image = async () => {
        const b = await createImageBitmap(await d.figure.toPNG({ overlays: false })),
          c = new OffscreenCanvas(b.width, b.height),
          g = c.getContext('2d');
        g.drawImage(b, 0, 0);
        b.close();
        const p = g.getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < p.length; i += 4) if (p[i] + p[i + 1] + p[i + 2] > 60) lit++;
        return lit;
      };
      const iso = await image();
      d.link.moveTo(75);
      const select = document.querySelector('#mode');
      select.value = 'composite';
      select.dispatchEvent(new Event('input'));
      const composite = await image();
      select.value = 'mip';
      select.dispatchEvent(new Event('input'));
      const mip = await image();
      select.value = 'iso';
      select.dispatchEvent(new Event('input'));
      d.figure.engine.render();
      return { iso, composite, mip, valid: d.profile.valid.reduce((a, b) => a + b, 0) };
    });
    assert.ok(demo.iso > 500 && demo.composite > 500 && demo.mip > 500 && demo.valid === 151, JSON.stringify(demo));
    report.demo = demo;
    await browser.page.screenshot({ path: `test-results/batch173-volume-quality-${compat ? 'compat' : 'native'}.png` });
    console.log(JSON.stringify({ compat, ...report }));
    assert.deepEqual(errors, []);
    assert.deepEqual(report.gpuErrors, []);
    assert.ok(Math.abs(report.constant[0] - report.expected) <= 2 && report.constantError <= 1, JSON.stringify(report));
    assert.ok(report.skippingError <= 1, JSON.stringify(report));
    assert.deepEqual(report.behind, [255, 0, 0]);
    assert.deepEqual(report.before, [0, 255, 0]);
    assert.deepEqual(report.fineBehind, [255, 0, 0]);
    assert.deepEqual(report.fineBefore, [0, 255, 0]);
    assert.equal(report.rebootError, 0);
    assert.equal(report.sourceVisible, false);
    assert.equal(report.restoredVisibility, true);
    // KB0507f: the spike draws whole on every ray, jittered or not: the mean within 4.5 of one crossing's opacity (the
    // 256 x 256 table stores 8-bit opacity, which is 28 levels here, and is read bilinearly), and no ray below 60% of it.
    for (const spike of [report.spikeFixed, report.spikeJittered]) {
      assert.ok(Math.abs(spike.mean - report.spikeExpected) <= 4.5, JSON.stringify(report));
      assert.ok(spike.min >= 0.6 * report.spikeExpected, JSON.stringify(report));
    }
    reports.push({ compat, ...report });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch173-volume-quality.json', JSON.stringify(reports, null, 2) + '\n');
