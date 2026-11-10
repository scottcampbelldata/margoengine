import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const fallback of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free' }),
    errors = [];
  browser.page.setDefaultTimeout(180000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    const report = await browser.page.evaluate(async (fallback) => {
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { createFallbackFigure } = await import('/packages/sciviz/dist/fallback.js');
      const { densityScatter } = await import('/packages/sciviz/dist/density.js');
      const compat = fallback ? await import('/packages/webgl2-compat/dist/index.js') : undefined;
      const create = fallback ? (c, o) => createFallbackFigure(c, { ...o, compat }) : Figure.create;
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      canvas.style.cssText = 'width:256px;height:128px';
      document.body.append(canvas);
      const check = (v, m) => {
        if (!v) throw new Error(m);
      };
      const results = [];
      const stars = new Float32Array(
        await new Response(
          (await fetch('/examples/assets/sciviz/stars.bin')).body.pipeThrough(new DecompressionStream('gzip')),
        ).arrayBuffer(),
      );
      const csv = (await (await fetch('/examples/assets/sciviz/limits/taxi.csv')).text())
        .trim()
        .split(/\r?\n/)
        .slice(1)
        .map((row) => row.split(',').map((value) => Number(value.replaceAll('"', ''))));
      for (const [name, n, base, limits] of [
        [
          '2MASS',
          20000000,
          Float32Array.from({ length: (stars.length / 4) * 3 }, (_, i) =>
            i % 3 === 0 ? stars[Math.floor(i / 3)] : i % 3 === 1 ? stars[stars.length / 4 + Math.floor(i / 3)] : 0,
          ),
          [0, 360, -90, 90],
        ],
        [
          'NYC TLC',
          10000000,
          Float32Array.from({ length: csv.length * 3 }, (_, i) => (i % 3 < 2 ? csv[Math.floor(i / 3)][i % 3] : 0)),
          [-75, -72, 40, 42],
        ],
      ]) {
        const fig = await create(canvas, {
          mode: '2d',
          axes: false,
          controls: false,
          pointBudget: 1,
          margin: { top: 0, bottom: 0, left: 0, right: 0 },
          limits,
        });
        fig.engine.stop();
        const gpuErrors = [];
        fig.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        try {
          const positions = new Float32Array(n * 3);
          for (let i = 0; i < positions.length; i += base.length)
            positions.set(base.subarray(0, Math.min(base.length, positions.length - i)), i);
          const countBase = base.length / 3,
            repetitions = Math.floor(n / countBase),
            remainder = n % countBase;
          const reference = densityScatter(fig, base);
          await fig.ready();
          fig.render();
          const small = await reference.readCounts();
          fig.remove(reference);
          const tail = densityScatter(fig, base.subarray(0, remainder * 3));
          await fig.ready();
          fig.render();
          const tailCounts = await tail.readCounts();
          fig.remove(tail);
          const layer = densityScatter(fig, positions, { opacity: 0.001 });
          await fig.ready();
          let pointProjectionCalls = 0;
          const original = fig.pick;
          fig.pick = () => {
            pointProjectionCalls++;
            throw new Error('CPU picking/projection should not run');
          };
          fig.render();
          const actual = await layer.readCounts({ timeout: 180000 });
          fig.pick = original;
          check(
            actual.every((v, i) => v === small[i] * repetitions + tailCounts[i]),
            `${name}: every large raster pixel matches repeated real data`,
          );
          const votes = actual.reduce((a, b) => a + b, 0);
          check(votes === n, `${name}: every point contributes`);
          const inputBuffers = layer.memoryResources.gpu.filter(
            (b) => b.size >= 12 && b.size !== 128 && b.size !== 256 * 128 * 4,
          );
          const sourceBytes = positions.byteLength;
          check(
            inputBuffers.every((b) => b.size <= fig.renderer.device.limits.maxStorageBufferBindingSize),
            'device storage binding limit',
          );
          check(pointProjectionCalls === 0, 'density does not invoke CPU point picking');
          layer.setStyle({ mode: 'kernel', bandwidth: 2 });
          fig.render();
          await fig.renderer.device.queue.onSubmittedWorkDone();
          check(
            (await layer.readCounts()).every((v, i) => v === actual[i]),
            'large KDE retains the integer histogram',
          );
          check(gpuErrors.length === 0, gpuErrors.join('\n'));
          results.push({
            name,
            points: n,
            votes,
            sourceBytes,
            chunks: inputBuffers.length,
            maxCount: actual.reduce((a, b) => Math.max(a, b), 0),
            computeRoutes: fig.renderer.device.dispatches ?? null,
          });
        } finally {
          fig.dispose();
        }
      }
      // Above float32's consecutive-integer range, not just above float16 saturation.
      const fig = await create(canvas, {
        mode: '2d',
        axes: false,
        controls: false,
        limits: [-1, 1, -1, 1],
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      fig.engine.stop();
      try {
        const n = 16777217,
          layer = densityScatter(fig, new Float32Array(n * 3));
        await fig.ready();
        fig.render();
        const counts = await layer.readCounts({ timeout: 180000 });
        check(counts.reduce((a, b) => Math.max(a, b), 0) === n, 'u32 count beyond float32 consecutive-integer range');
        results.push({ name: 'coincident', points: n, votes: counts.reduce((a, b) => a + b, 0) });
      } finally {
        fig.dispose();
        canvas.remove();
      }
      return { fallback, results };
    }, fallback);
    assert.deepEqual(errors, []);
    reports.push({ ...report, hardware: browser.hardware });
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch181-j4-scale.json', JSON.stringify(reports, null, 2) + '\n');
