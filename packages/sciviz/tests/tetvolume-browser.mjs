import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/tetvolume.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    const report = await browser.page.evaluate(
      async () => {
        const { Figure } = await import('/packages/sciviz/dist/index.js'),
          { tetrahedralVolume } = await import('/packages/sciviz/dist/tetvolume.js'),
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
        const pixels = async () => {
            await f.ready();
            const b = await createImageBitmap(await f.toPNG({ overlays: false })),
              c = new OffscreenCanvas(96, 96),
              g = c.getContext('2d');
            g.drawImage(b, 0, 0);
            b.close();
            return g.getImageData(0, 0, 96, 96).data;
          },
          center = (p) => [...p.slice((48 * 96 + 48) * 4, (48 * 96 + 48) * 4 + 3)];
        const points = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, i >> 2]).flat(),
          perms = [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
          ],
          ids = perms.flatMap((p) => {
            let v = 0;
            return [0, ...p.map((a) => (v |= 1 << a))];
          });
        const grid = {
          points,
          connectivity: ids,
          offsets: [4, 8, 12, 16, 20, 24],
          types: new Uint8Array(6).fill(10),
          pointData: new Float32Array(8).fill(0.5),
        };
        const opts = {
          range: [0, 1],
          colormap: ['#ff0000', '#ff0000'],
          opacity: () => 0.05,
          referenceStep: 0.25,
          quality: 8,
          shading: false,
        };
        let v = tetrahedralVolume(f, grid, opts);
        const cube = center(await pixels()),
          expected = Math.round(255 * (1 - (1 - 13 / 255) ** 4));
        const table = new Uint8Array(16);
        for (let i = 0; i < 4; i++) table.set([0, 255, 0, 13], i * 4);
        v.source.setClassification({ kind: 'gradient', size: [2, 2], rgba: table, gradientMax: 1 });
        const gradient = center(await pixels());
        for (let i = 0; i < 4; i++) table.set([0, 0, 255, 13], i * 4);
        v.source.setClassification({ kind: 'preintegrated', size: [2, 2], rgba: table, step: 1, density: 1 });
        const preintegrated = center(await pixels());
        v.source.setClassification();
        const green = f.volume(new Float32Array(8).fill(0.5), {
          dims: [2, 2, 2],
          bounds: [0, 1, 0, 1, 0, 1],
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
        const after = await pixels(),
          rebootError = Math.max(...after.map((x, i) => Math.abs(x - before[i])));
        v.dispose();
        v = tetrahedralVolume(
          f,
          { ...grid, pointData: undefined, cellData: new Float32Array(6).fill(0.5) },
          { ...opts, association: 'cell' },
        );
        const cell = center(await pixels());
        v.dispose();
        v = tetrahedralVolume(f, grid, { ...opts, referenceStep: 1000, opacity: () => 1 });
        const opaque = center(await pixels());
        v.dispose();
        const scaled = [];
        for (const scale of [1e-20, 1e20]) {
          f.setLimits([0, scale, 0, scale, 0, scale]);
          v = tetrahedralVolume(
            f,
            { ...grid, points: points.map((p) => p * scale) },
            { ...opts, referenceStep: 0.25 * scale },
          );
          scaled.push(center(await pixels()));
          v.dispose();
        }
        f.setLimits([0, 1, 0, 1, 0, 1]);
        const disjointPoints = [
            ...points.map((x, i) => (i % 3 === 1 ? x * 0.25 : x)),
            ...points.map((x, i) => (i % 3 === 1 ? 0.75 + x * 0.25 : x)),
          ],
          disjoint = {
            points: disjointPoints,
            connectivity: [...ids, ...ids.map((i) => i + 8)],
            offsets: Array.from({ length: 12 }, (_, i) => (i + 1) * 4),
            types: new Uint8Array(12).fill(10),
            pointData: new Float32Array(16).fill(0.5),
          };
        v = tetrahedralVolume(f, disjoint, opts);
        const gap = center(await pixels());
        v.dispose();
        const ramp = points.filter((_, i) => i % 3 === 1),
          rampOpts = { ...opts, colormap: ['#000000', '#ffffff'], quality: 24 };
        v = tetrahedralVolume(f, { ...grid, pointData: ramp }, rampOpts);
        const direct = await pixels();
        v.dispose();
        const n = 65,
          resampled = Float32Array.from({ length: n ** 3 }, (_, i) => (Math.floor(i / n) % n) / (n - 1));
        const source = f.volume(resampled, { ...rampOpts, dims: [n, n, n], bounds: [0, 1, 0, 1, 0, 1], quality: 6 });
        source.density = (1 - (1 - 13 / 255) ** (4 / (n - 1))) / (13 / 255);
        const reference = qualityVolume(f, source, { jitter: false, adaptive: false, emptySpaceSkipping: false });
        const image = await pixels();
        reference.dispose();
        f.remove(source);
        let squared = 0,
          max = 0,
          count = 0;
        // Interior rays exclude the different MSAA silhouette contracts of a box and a full-screen cell cast.
        for (let y = 30; y < 66; y++)
          for (let x = 30; x < 66; x++)
            for (let c = 0; c < 3; c++) {
              const i = (y * 96 + x) * 4 + c,
                d = Math.abs(direct[i] - image[i]);
              squared += d * d;
              max = Math.max(max, d);
              count++;
            }
        const missing = new Float32Array(8).fill(NaN);
        missing[0] = 0.5;
        v = tetrahedralVolume(f, { ...grid, pointData: missing }, opts);
        const mask = center(await pixels());
        v.dispose();
        f.dispose();
        return {
          scaled,
          opaque,
          cube,
          expected,
          gradient,
          preintegrated,
          interior,
          rebootError,
          cell,
          gap,
          rmse: Math.sqrt(squared / count),
          max,
          mask,
          gpuErrors,
        };
      },
      undefined,
      { timeout: 120000 },
    );
    console.log(JSON.stringify({ compat, ...report }));
    assert.deepEqual(errors, []);
    assert.deepEqual(report.gpuErrors, []);
    assert.ok(Math.abs(report.cube[0] - report.expected) <= 1);
    assert.deepEqual(report.gradient, [0, report.cube[0], 0]);
    assert.deepEqual(report.preintegrated, [0, 0, report.cube[0]]);
    assert.ok(Math.abs(report.interior[0] - 25) <= 1 && Math.abs(report.interior[1] - 230) <= 1);
    assert.deepEqual(report.opaque, [255, 0, 0]);
    assert.deepEqual(report.scaled, [report.cube, report.cube]);
    assert.equal(report.rebootError, 0);
    assert.deepEqual(report.cell, report.cube);
    assert.ok(Math.abs(report.gap[0] - 25) <= 1);
    assert.deepEqual(report.mask, [0, 0, 0]);
    assert.ok(report.rmse <= 1 && report.max <= 2, JSON.stringify(report));

    await browser.page.goto(new URL('/examples/sciviz-tetvolume.html', browser.page.url()).href);
    await browser.page.waitForFunction(
      () => document.querySelector('#status').textContent.startsWith('Ready.'),
      undefined,
      { timeout: 120000 },
    );
    const demo = await browser.page.evaluate(async () => {
      const d = await import('/examples/sciviz-tetvolume.ts');
      d.direct.engine.stop();
      d.reference.engine.stop();
      const capture = async (f) => {
        f.engine.scene.background = '#000000';
        const b = await createImageBitmap(await f.toPNG({ overlays: false })),
          c = new OffscreenCanvas(b.width, b.height),
          g = c.getContext('2d');
        g.drawImage(b, 0, 0);
        b.close();
        return { p: g.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
      };
      const a = await capture(d.direct),
        b = await capture(d.reference);
      if (a.width !== b.width || a.height !== b.height) throw new Error('Comparison canvas sizes differ');
      let square = 0,
        count = 0,
        lit = 0,
        referenceLit = 0;
      for (let i = 0; i < a.p.length; i += 4) {
        if (a.p[i] + a.p[i + 1] + a.p[i + 2] > 30) lit++;
        if (b.p[i] + b.p[i + 1] + b.p[i + 2] > 30) referenceLit++;
        for (let c = 0; c < 3; c++) {
          square += (a.p[i + c] - b.p[i + c]) ** 2;
          count++;
        }
      }
      const slider = document.querySelector('#density');
      slider.value = '4';
      slider.dispatchEvent(new Event('input'));
      const denseA = await capture(d.direct),
        denseB = await capture(d.reference);
      let denseSquare = 0;
      for (let i = 0; i < denseA.p.length; i++) if (i % 4 !== 3) denseSquare += (denseA.p[i] - denseB.p[i]) ** 2;
      const denseRmse = Math.sqrt(denseSquare / ((denseA.p.length * 3) / 4));
      slider.value = '1';
      slider.dispatchEvent(new Event('input'));
      const select = document.querySelector('#mode');
      select.value = 'mip';
      select.dispatchEvent(new Event('input'));
      const mip = await capture(d.direct);
      let mipLit = 0;
      for (let i = 0; i < mip.p.length; i += 4) if (mip.p[i] + mip.p[i + 1] + mip.p[i + 2] > 30) mipLit++;
      select.value = 'composite';
      select.dispatchEvent(new Event('input'));
      d.direct.engine.render();
      d.reference.engine.render();
      return {
        denseRmse,
        cells: d.volume.cellCount,
        nodes: d.grid.points.length / 3,
        valid: d.resampled.valid.reduce((a, b) => a + b, 0),
        lit,
        referenceLit,
        mipLit,
        rmse: Math.sqrt(square / count),
      };
    });
    console.log('NASA', compat, JSON.stringify(demo));
    assert.ok(demo.cells === 6048 && demo.nodes === 2146);
    assert.ok(demo.lit > 1000 && demo.referenceLit > 1000 && demo.mipLit > 1000);
    assert.ok(demo.rmse <= 3 && demo.denseRmse <= 3, JSON.stringify(demo));
    await browser.page.screenshot({ path: `test-results/batch173-tetvolume-demo-${compat ? 'compat' : 'webgpu'}.png` });
    assert.deepEqual(errors, []);
    reports.push({ compat, ...report, demo });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch173-tetvolume.json', JSON.stringify(reports, null, 2) + '\n');
