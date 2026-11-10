import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-labels.html', port: 'free', compat }),
    errors = [];
  browser.page.setDefaultTimeout(120000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const report = await browser.page.evaluate(async () => {
      const { Figure } = await import('/packages/sciviz/dist/index.js'),
        { fusionVolume, labelLegend } = await import('/packages/sciviz/dist/labels.js'),
        demo = await import('/examples/sciviz-labels.ts');
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      canvas.style.cssText = 'width:128px;height:128px';
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
      async function pixels(fig = f) {
        await fig.ready();
        const bitmap = await createImageBitmap(await fig.toPNG({ overlays: false })),
          c = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = c.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        return g.getImageData(0, 0, c.width, c.height).data;
      }
      const centre = (p) => [...p.slice((64 * 128 + 64) * 4, (64 * 128 + 64) * 4 + 3)];
      const difference = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
      const channels = new Float32Array(8 ** 3 * 2);
      channels.fill(0.5);
      const common = { dims: [8, 8, 8], bounds: [0, 1, 0, 1, 0, 1] },
        alpha = 0.06;
      let layer = fusionVolume(
        f,
        [
          {
            ...common,
            kind: 'components',
            data: channels,
            components: [
              { range: [0, 1], transfer: () => [1, 0, 0, alpha] },
              { range: [0, 1], transfer: () => [0, 0, 1, alpha] },
            ],
          },
        ],
        { quality: 4 },
      );
      const optical = centre(await pixels());
      // Seven voxel intervals. Canvas blends encoded volume RGB over black using corrected alpha.
      const a = 1 - (1 - alpha) ** 14,
        expected = Math.round(255 * (1.055 * 0.5 ** (1 / 2.4) - 0.055) * a);
      const analyticalError = difference(optical, [expected, 0, expected]);
      f.remove(layer);
      layer = fusionVolume(
        f,
        [0, 1].map((c) => ({
          ...common,
          kind: 'components',
          data: new Float32Array(8 ** 3).fill(0.5),
          components: [{ range: [0, 1], transfer: () => (c ? [0, 0, 1, alpha] : [1, 0, 0, alpha]) }],
        })),
        { quality: 4 },
      );
      const fused = centre(await pixels()),
        fusionError = difference(optical, fused);
      f.remove(layer);
      const rgb = new Uint8Array(8 ** 3 * 3);
      for (let i = 0; i < rgb.length; i += 3) rgb.set([255, 0, 0], i);
      layer = fusionVolume(f, [{ ...common, kind: 'rgb', data: rgb, opacity: 0.1 }]);
      const rgbPixel = centre(await pixels());
      f.remove(layer);
      const rgba = new Float32Array(8 ** 3 * 4);
      for (let i = 0; i < rgba.length; i += 4) rgba.set([0, 1, 0, 0.1], i);
      layer = fusionVolume(f, [{ ...common, kind: 'rgba', data: rgba }]);
      const rgbaPixel = centre(await pixels());
      f.remove(layer);
      // Adjacent exact labels differ by one above float32's integer precision; the absent middle ID is never invented.
      const data = new Uint32Array(16 ** 3);
      for (let i = 0; i < data.length; i++) data[i] = i % 16 < 8 ? 16777217 : 16777218;
      const labelInput = {
        kind: 'labels',
        dims: [16, 16, 16],
        bounds: common.bounds,
        data,
        labels: [
          { id: 16777217, name: 'Left', rgba: [1, 0, 0, 0.15] },
          { id: 16777218, name: 'Right', rgba: [0, 0, 1, 0.15] },
          { id: 16777216, name: 'Absent', rgba: [0, 1, 0, 1] },
        ],
      };
      layer = fusionVolume(f, [labelInput]);
      const categories = await pixels();
      let red = 0,
        blue = 0,
        green = 0;
      for (let i = 0; i < categories.length; i += 4) {
        if (categories[i] > 80 && categories[i + 2] < 10) red++;
        if (categories[i + 2] > 80 && categories[i] < 10) blue++;
        if (categories[i + 1] > 20) green++;
      }
      const holder = document.createElement('div');
      document.body.append(holder);
      const legend = labelLegend(holder, layer),
        legendCount = holder.querySelectorAll('li').length;
      legend.dispose();
      holder.remove();
      layer.setLabels(
        0,
        labelInput.labels
          .slice(0, 2)
          .map((l) => ({ ...l, rgba: [0, 0, 0, 0], outline: { rgba: [0, 1, 0, 0.5], width: 1 } })),
      );
      const outlined = await pixels();
      let edges = 0;
      for (let i = 0; i < outlined.length; i += 4) if (outlined[i + 1] > 100) edges++;
      layer.restore();
      const restored = await pixels();
      let restorationError = 0;
      for (let i = 0; i < restored.length; i++)
        restorationError = Math.max(restorationError, Math.abs(restored[i] - outlined[i]));
      await f.engine.rebootDevice();
      const rebooted = await pixels();
      let rebootError = 0;
      for (let i = 0; i < rebooted.length; i++)
        rebootError = Math.max(rebootError, Math.abs(rebooted[i] - outlined[i]));
      f.remove(layer);
      // Rotated/translated registered source must match an equivalent aligned scalar source, without resampling.
      const transform = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1];
      layer = fusionVolume(f, [{ ...common, kind: 'rgb', data: rgb, opacity: 0.1, transform }]);
      const transformed = centre(await pixels()),
        transformError = difference(rgbPixel, transformed);
      f.remove(layer);
      const rampX = new Float32Array(8 ** 3 * 4),
        rampY = new Float32Array(8 ** 3 * 4);
      for (let i = 0; i < 8 ** 3; i++) {
        rampX.set([(i % 8) / 7, 0, 0, 0.1], i * 4);
        rampY.set([(Math.floor(i / 8) % 8) / 7, 0, 0, 0.1], i * 4);
      }
      layer = fusionVolume(f, [{ ...common, kind: 'rgba', data: rampX, transform }]);
      const rotatedRamp = await pixels();
      f.remove(layer);
      layer = fusionVolume(f, [{ ...common, kind: 'rgba', data: rampY }]);
      const alignedRamp = await pixels();
      f.remove(layer);
      let registeredRampError = 0;
      for (let i = 0; i < rotatedRamp.length; i++)
        registeredRampError = Math.max(registeredRampError, Math.abs(rotatedRamp[i] - alignedRamp[i]));
      layer = fusionVolume(
        f,
        [
          { ...common, kind: 'rgb', data: rgb, opacity: 1 },
          { ...common, kind: 'rgba', data: rgba },
        ],
        { mix: 'over' },
      );
      const over = centre(await pixels());
      f.remove(layer);
      layer = fusionVolume(
        f,
        [
          { ...common, kind: 'rgb', data: rgb, opacity: 0.03 },
          { ...common, kind: 'rgba', data: rgba },
        ],
        { mix: 'maximum' },
      );
      const maximum = centre(await pixels());
      f.remove(layer);
      // Distinct depth intervals must composite in ray order regardless of array order.
      const front = { kind: 'rgb', dims: [8, 8, 8], data: rgb, opacity: 0.12, bounds: [0, 1, 0, 1, 0.55, 1] },
        back = { kind: 'rgba', dims: [8, 8, 8], data: rgba, bounds: [0, 1, 0, 1, 0, 0.45] };
      layer = fusionVolume(f, [front, back]);
      const order1 = centre(await pixels());
      f.remove(layer);
      layer = fusionVolume(f, [back, front]);
      const order2 = centre(await pixels()),
        orderError = difference(order1, order2);
      f.remove(layer);
      let demoLit = 0;
      const real = await pixels(demo.figure);
      for (let i = 0; i < real.length; i += 4)
        if (Math.abs(real[i] - real[0]) + Math.abs(real[i + 1] - real[1]) + Math.abs(real[i + 2] - real[2]) > 40)
          demoLit++;
      f.dispose();
      canvas.remove();
      return {
        optical,
        fused,
        expected,
        analyticalError,
        fusionError,
        rgbPixel,
        rgbaPixel,
        red,
        blue,
        green,
        edges,
        legendCount,
        restorationError,
        rebootError,
        transformError,
        orderError,
        registeredRampError,
        over,
        maximum,
        demoLit,
        gpuErrors,
      };
    });
    assert.deepEqual(report.gpuErrors, []);
    assert.deepEqual(errors, []);
    assert.ok(report.analyticalError <= 3, JSON.stringify(report));
    assert.ok(report.fusionError <= 1, JSON.stringify(report));
    assert.ok(
      report.rgbPixel[0] > 80 && report.rgbPixel[1] === 0 && report.rgbaPixel[1] > 80 && report.rgbaPixel[0] === 0,
      JSON.stringify(report),
    );
    assert.ok(report.red > 500 && report.blue > 500 && report.green === 0, JSON.stringify(report));
    assert.ok(
      report.edges > 100 &&
        report.edges < report.red + report.blue &&
        report.legendCount === 3 &&
        report.restorationError === 0 &&
        report.rebootError === 0,
      JSON.stringify(report),
    );
    assert.ok(report.transformError <= 1 && report.orderError <= 1 && report.demoLit > 500, JSON.stringify(report));
    assert.ok(report.registeredRampError <= 1, JSON.stringify(report));
    assert.deepEqual(report.over, [255, 0, 0]);
    assert.ok(report.maximum[1] > 80 && report.maximum[0] === 0, JSON.stringify(report));
    await browser.page.screenshot({ path: `test-results/batch173-labels-${compat ? 'compat' : 'native'}.png` });
    reports.push({ compat, ...report });
    console.log(JSON.stringify(reports.at(-1)));
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch173-labels.json', JSON.stringify(reports, null, 2) + '\n');
