import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/curvilinear.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    const report = await browser.page.evaluate(
      async () => {
        const { Figure } = await import('/packages/sciviz/dist/index.js'),
          { curvilinearVolume } = await import('/packages/sciviz/dist/curvilinear.js');
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 96;
        canvas.style.cssText = 'width:96px;height:96px';
        document.body.append(canvas);
        const f = await Figure.create(canvas, {
          axes: false,
          controls: false,
          aspect: [1, 1, 1],
          limits: [-1, 1, -1, 1, -1, 1],
        });
        f.engine.stop();
        f.engine.camera.position = [0, 0, 4];
        f.engine.camera.target = [0, 0, 0];
        f.engine.scene.background = '#000000';
        const gpuErrors = [];
        f.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        const pixels = async () => {
          await f.ready();
          const b = await createImageBitmap(await f.toPNG({ overlays: false })),
            c = new OffscreenCanvas(96, 96),
            g = c.getContext('2d');
          g.drawImage(b, 0, 0);
          b.close();
          return g.getImageData(0, 0, 96, 96).data;
        };
        const center = (p) => [...p.slice((48 * 96 + 48) * 4, (48 * 96 + 48) * 4 + 3)];
        const dims = [5, 5, 5],
          points = [];
        for (let z = 0; z < 5; z++)
          for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) points.push(x / 2 - 1, y / 2 - 1, z / 2 - 1);
        const opts = {
          range: [0, 1],
          colormap: ['#ff0000', '#ff0000'],
          opacity: () => 0.05,
          shading: false,
          quality: 4,
          referenceStep: 0.5,
        };
        let v = curvilinearVolume(f, { dims, points }, new Float32Array(125).fill(0.5), opts);
        const cube = center(await pixels()),
          expectedCube = Math.round(255 * (1 - (1 - Math.round(0.05 * 255) / 255) ** 4));
        const table = new Uint8Array(16);
        for (let i = 0; i < 4; i++) table.set([0, 255, 0, 13], i * 4);
        v.source.setClassification({ kind: 'gradient', size: [2, 2], rgba: table, gradientMax: 1 });
        const classified = center(await pixels());
        v.source.setClassification();
        const green = f.volume(new Float32Array(8).fill(0.5), {
          dims: [2, 2, 2],
          bounds: [-1, 1, -1, 1, -1, 1],
          range: [0, 1],
          colormap: ['#00ff00', '#00ff00'],
        });
        green.visible = false;
        const plane = green.slice('y', 0.5);
        const interior = center(await pixels());
        f.remove(green);
        const before = await pixels();
        await f.engine.rebootDevice();
        f.engine.stop();
        const after = await pixels();
        const rebootError = Math.max(...after.map((n, i) => Math.abs(n - before[i])));
        const section = v.slice(1, 2);
        v.visible = false;
        const slice = center(await pixels());
        section.index = 1.5;
        const moved = center(await pixels());
        section.visible = false;
        const outline = v.outline({ stride: 2 });
        const wire = await pixels();
        const outlinePixels = wire.filter((v, i) => i % 4 !== 3 && v > 30).length;
        outline.dispose();
        v.dispose();
        const radius = [0.5, 0.65, 1],
          longitude = Array.from({ length: 17 }, (_, i) => -Math.PI + (i * 2 * Math.PI) / 16),
          latitude = Array.from({ length: 9 }, (_, i) => -Math.PI / 2 + (i * Math.PI) / 8);
        v = curvilinearVolume(f, { radius, longitude, latitude }, new Float32Array(17 * 9 * 3).fill(0.5), {
          ...opts,
          referenceStep: 0.1,
          quality: 8,
        });
        const shell = center(await pixels()),
          expectedShell = Math.round(255 * (1 - (1 - Math.round(0.05 * 255) / 255) ** 10));
        const outer = v.slice(2, 2);
        v.visible = false;
        const sphericalSlice = center(await pixels());
        outer.dispose();
        v.visible = true;
        const pre = await pixels();
        await f.engine.rebootDevice();
        f.engine.stop();
        const post = await pixels();
        const shellReboot = Math.max(...post.map((n, i) => Math.abs(n - pre[i])));
        v.dispose();
        // A warped volume whose scalar is affine in physical coordinates must match its regular-grid image.
        const warped = points.map((p, i) => (i % 3 === 0 ? p + 0.15 * points[i + 1] * points[i + 2] : p));
        const values = Float32Array.from({ length: 125 }, (_, i) => (warped[i * 3 + 1] + 1) / 2);
        v = curvilinearVolume(f, { dims, points: warped }, values, {
          ...opts,
          colormap: ['#000000', '#ffffff'],
          opacity: () => 0.03,
          referenceStep: 0.25,
          quality: 8,
        });
        const warpedPixel = center(await pixels());
        v.dispose();
        const base = curvilinearVolume(f, { dims, points }, values, {
          ...opts,
          colormap: ['#000000', '#ffffff'],
          opacity: () => 0.03,
          referenceStep: 0.25,
          quality: 8,
        });
        const regularPixel = center(await pixels());
        base.dispose();
        // Missing scalar support must never be interpreted as valid zero-valued material.
        const missing = new Float32Array(125).fill(NaN);
        missing[0] = 0.5;
        v = curvilinearVolume(f, { dims, points }, missing, opts);
        const mask = center(await pixels());
        v.dispose();
        f.dispose();
        return {
          classified,
          interior,
          cube,
          expectedCube,
          rebootError,
          slice,
          moved,
          outlinePixels,
          shell,
          expectedShell,
          sphericalSlice,
          shellReboot,
          warpedPixel,
          regularPixel,
          mask,
          gpuErrors,
        };
      },
      undefined,
      { timeout: 120000 },
    );
    console.log(JSON.stringify({ compat, ...report }));
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.deepEqual(report.gpuErrors, []);
    assert.ok(Math.abs(report.cube[0] - report.expectedCube) <= 1, JSON.stringify(report));
    assert.ok(Math.abs(report.shell[0] - report.expectedShell) <= 2, JSON.stringify(report));
    assert.ok(report.classified[1] === report.expectedCube && report.classified[0] === 0);
    assert.ok(Math.abs(report.interior[0] - 25) <= 1 && Math.abs(report.interior[1] - 230) <= 1);
    assert.equal(report.rebootError, 0);
    assert.equal(report.shellReboot, 0);
    assert.deepEqual(report.slice, [255, 0, 0]);
    assert.deepEqual(report.moved, [255, 0, 0]);
    assert.deepEqual(report.sphericalSlice, [255, 0, 0]);
    assert.ok(report.outlinePixels > 100);
    assert.ok(Math.abs(report.warpedPixel[0] - report.regularPixel[0]) <= 1);
    assert.deepEqual(report.mask, [0, 0, 0]);
    await browser.page.goto(new URL('/examples/sciviz-curvilinear.html', browser.page.url()).href);
    await browser.page.waitForFunction(
      () => document.querySelector('#status').textContent.startsWith('Ready.'),
      undefined,
      { timeout: 120000 },
    );
    const demo = await browser.page.evaluate(async () => {
      const d = await import('/examples/sciviz-curvilinear.ts');
      d.radar.engine.stop();
      d.ocean.engine.stop();
      const lit = async (f) => {
        f.engine.scene.background = '#000000';
        const b = await createImageBitmap(await f.toPNG({ overlays: false })),
          c = new OffscreenCanvas(b.width, b.height),
          g = c.getContext('2d');
        g.drawImage(b, 0, 0);
        b.close();
        const p = g.getImageData(0, 0, c.width, c.height).data;
        let count = 0;
        for (let i = 0; i < p.length; i += 4) if (p[i] + p[i + 1] + p[i + 2] > 30) count++;
        return count;
      };
      const radar = await lit(d.radar),
        ocean = await lit(d.ocean);
      document.querySelector('#slice').click();
      document.querySelector('#outline').click();
      document.querySelector('#volume').click();
      const radarSlice = await lit(d.radar),
        oceanSlice = await lit(d.ocean);
      return { radar, ocean, radarSlice, oceanSlice };
    });
    assert.ok(
      demo.radar > 100 && demo.ocean > 100 && demo.radarSlice > 100 && demo.oceanSlice > 100,
      JSON.stringify(demo),
    );
    await browser.page.screenshot({ path: `test-results/batch173-mapped-demo-${compat ? 'compat' : 'webgpu'}.png` });
    assert.deepEqual(errors, []);
    reports.push({ compat, ...report, demo });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch173-curvilinear.json', JSON.stringify(reports, null, 2) + '\n');
console.log(JSON.stringify(reports));
