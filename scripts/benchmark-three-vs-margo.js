import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build, createServer } from 'vite';
import { chromium } from '@playwright/test';

export function summarize(timestamps) {
  assert.ok(timestamps.length > 1);
  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    const value = timestamps[i] - timestamps[i - 1];
    assert.ok(Number.isFinite(value) && value >= 0, 'Invalid frame timestamp');
    intervals.push(value);
  }
  intervals.sort((a, b) => a - b);
  return {
    mean: intervals.reduce((sum, value) => sum + value, 0) / intervals.length,
    p95: intervals[Math.ceil(intervals.length * 0.95) - 1],
    p99: intervals[Math.ceil(intervals.length * 0.99) - 1],
    duration: timestamps.at(-1) - timestamps[0],
  };
}
export async function runBenchmark() {
  const output = resolve('test-results/benchmark-three-vs-margo');
  await mkdir(output, { recursive: true });
  const version = JSON.parse(await readFile('node_modules/three/package.json', 'utf8')).version;
  assert.equal(version, '0.186.1');
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: output,
      emptyOutDir: true,
      target: 'es2022',
      rollupOptions: {
        input: {
          margo: resolve('examples/conveyor-margo.html'),
          three: resolve('examples/conveyor-three.html'),
        },
      },
    },
  });
  const server = await createServer({
    configFile: false,
    publicDir: false,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, entries: [] },
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'benchmark-gzip',
        configureServer(server) {
          server.middlewares.use(async (req, res) => {
            try {
              const file = resolve(output, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
              if (!file.startsWith(output + sep)) {
                res.statusCode = 403;
                res.end();
                return;
              }
              const data = gzipSync(await readFile(file));
              res.setHeader(
                'Content-Type',
                {
                  '.html': 'text/html',
                  '.js': 'text/javascript',
                  '.css': 'text/css',
                }[extname(file)] ?? 'application/octet-stream',
              );
              res.setHeader('Content-Encoding', 'gzip');
              res.setHeader('Content-Length', data.length);
              res.setHeader('Cache-Control', 'no-store');
              res.end(data);
            } catch {
              res.statusCode = 404;
              res.end();
            }
          });
        },
      },
    ],
  });
  let browser;
  const results = [];
  try {
    await server.listen();
    const address = server.httpServer.address(),
      args = ['--enable-unsafe-webgpu', ...JSON.parse(process.env.BROWSER_ARGS ?? '[]')];
    browser = await chromium.launch({
      headless: true,
      channel: process.env.BROWSER_CHANNEL === 'chromium' ? undefined : process.env.BROWSER_CHANNEL,
      args,
    });
    for (const name of ['margo', 'three']) {
      const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          deviceScaleFactor: 1,
        }),
        page = await context.newPage(),
        cdp = await context.newCDPSession(page),
        errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await cdp.send('Performance.enable');
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      // Count actual API calls independently of the engines' own statistics.
      await page.addInitScript(() => {
        const counts = new Uint32Array(4);
        window.gpuCounts = counts;
        function wrap(proto, names, index) {
          if (!proto) return;
          for (const name of names) {
            const original = proto[name];
            if (!original) continue;
            proto[name] = function (a, b, c, d, e) {
              counts[index]++;
              return original.call(this, a, b, c, d, e);
            };
          }
        }
        wrap(globalThis.GPURenderPassEncoder?.prototype, ['draw', 'drawIndexed'], 0);
        wrap(globalThis.GPURenderPassEncoder?.prototype, ['drawIndirect', 'drawIndexedIndirect'], 1);
        wrap(globalThis.GPUComputePassEncoder?.prototype, ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect'], 2);
        wrap(
          globalThis.WebGL2RenderingContext?.prototype,
          ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'],
          3,
        );
      });
      await page.goto(`http://127.0.0.1:${address.port}/examples/conveyor-${name}.html`);
      await page.waitForFunction(() => window.benchmark?.ready || window.benchmark?.error, {}, { timeout: 60000 });
      assert.equal(await page.evaluate(() => window.benchmark.error), undefined, errors.join('\n'));
      const hardware = await page.evaluate(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        return {
          gpu: adapter?.info
            ? {
                vendor: adapter.info.vendor,
                device: adapter.info.device,
                description: adapter.info.description,
                isFallbackAdapter: adapter.info.isFallbackAdapter ?? null,
              }
            : null,
          userAgent: navigator.userAgent,
        };
      });
      const running = page.evaluate(() => window.benchmark.run());
      running.catch(() => {});
      await page.waitForFunction(() => window.benchmark.warmReady, {}, { timeout: 180000 });
      await cdp.send('HeapProfiler.collectGarbage');
      const start = await cdp.send('Performance.getMetrics'),
        startHeap = start.metrics.find((metric) => metric.name === 'JSHeapUsedSize').value;
      const gcEvents = [];
      cdp.on('Tracing.dataCollected', (event) => {
        for (const item of event.value) if (item.name === 'MinorGC' || item.name === 'MajorGC') gcEvents.push(item);
      });
      await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,v8',
        options: 'record-as-much-as-possible',
        transferMode: 'ReportEvents',
      });
      await page.evaluate(() => {
        window.gpuCounts.fill(0);
        window.benchmark.measure();
      });
      await page.waitForFunction(() => window.benchmark.complete || window.benchmark.error, {}, { timeout: 180000 });
      await running;
      const end = await cdp.send('Performance.getMetrics'),
        endHeap = end.metrics.find((metric) => metric.name === 'JSHeapUsedSize').value,
        traceFinished = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');
      await traceFinished;
      const result = await page.evaluate(() => ({
        ...window.benchmark.result(),
        actualCalls: Array.from(window.gpuCounts),
        resources: performance
          .getEntriesByType('resource')
          .filter((resource) => resource.name.endsWith('.js'))
          .map((resource) => ({
            name: resource.name,
            transferSize: resource.transferSize,
            encodedBodySize: resource.encodedBodySize,
            decodedBodySize: resource.decodedBodySize,
          })),
      }));
      assert.equal(result.frames, 1200);
      assert.equal(result.entities, 12014);
      assert.deepEqual(errors, []);
      const cadence = summarize(result.timestamps.slice(200)),
        perFrame = [];
      for (let i = 200; i < 1200; i++) perFrame.push(result.counts[i * 4]);
      const drawMean = perFrame.reduce((sum, value) => sum + value, 0) / 1000;
      const entry = {
        ...result,
        cadence,
        drawMean,
        heapDelta: endHeap - startHeap,
        minorGCs: gcEvents.filter((event) => event.name === 'MinorGC' && event.ph === 'X').length,
        majorGCs: gcEvents.filter((event) => event.name === 'MajorGC' && event.ph === 'X').length,
        gzipBytes: result.resources.reduce((sum, resource) => sum + resource.encodedBodySize, 0),
        transferBytes: result.resources.reduce((sum, resource) => sum + resource.transferSize, 0),
        hardware,
        browserVersion: browser.version(),
      };
      delete entry.timestamps;
      delete entry.counts;
      results.push(entry);
      await context.close();
    }
    const lines = [
      '# Three.js vs Margo conveyor benchmark',
      '',
      `Captured ${new Date().toISOString()}; Chromium ${browser.version()}.`,
      '',
      'Each scene renders exactly 1,200 frames: 200 warmup frames and 1,000 measured frames. Frame cadence uses the 999 intervals within the measured window. Actual duration depends on frame rate; 1,200 frames take 20 seconds only at 60 FPS.',
      '',
      '| Scene | Entities | JS gzip payload (bytes) | JS transfer incl. headers (bytes) | Heap delta (bytes) | Minor / major GC | Mean ms | P95 ms | P99 ms | Draws/frame | GPU direct / indirect / dispatch / GL calls (1,000 frames) | Measured duration (s) |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|',
      ...results.map(
        (r) =>
          `| ${r.engine} (${r.backend}) | ${r.entities} | ${r.gzipBytes} | ${r.transferBytes} | ${r.heapDelta} | ${r.minorGCs} / ${r.majorGCs} | ${r.cadence.mean.toFixed(2)} | ${r.cadence.p95.toFixed(2)} | ${r.cadence.p99.toFixed(2)} | ${r.drawMean.toFixed(0)} | ${r.actualCalls.join(' / ')} | ${(r.cadence.duration / 1000).toFixed(2)} |`,
      ),
      '',
      'Both consume the same 12,014-node hierarchy and cylinder buffers, camera, animation and uncullled geometry. Three uses shared geometry/materials with ordinary Mesh objects; Margo performs its native batching. Three InstancedMesh is a separate optimization and is not evaluated. Both rasterize scene geometry with 4x MSAA; Three resolves through an OutputPass. Lighting and tone mapping differ. This compares WebGPU Margo with WebGL2 Three, not identical render backends.',
      '',
      'Gzip payload and actual transfer come from Resource Timing with cache disabled and gzipped production bundles served by Vite. Heap delta is retained/temporary heap change after a forced baseline GC, not total allocated bytes. GC counts are completed MinorGC/MajorGC trace events. Tracing and draw-call instrumentation add overhead. Software GPU results are validation data, not hardware performance claims.',
      '',
      ...results.map((r) => `${r.engine} adapter: \`${JSON.stringify(r.hardware)}\``),
      '',
    ];
    await mkdir('benchmarks', { recursive: true });
    await writeFile('benchmarks/results.md', lines.join('\n'));
    await writeFile('test-results/benchmark-three-vs-margo.json', JSON.stringify(results, null, 2));
    console.table(
      results.map((r) => ({
        scene: r.engine,
        gzip: r.gzipBytes,
        heapDelta: r.heapDelta,
        meanMs: r.cadence.mean.toFixed(2),
        p95Ms: r.cadence.p95.toFixed(2),
        p99Ms: r.cadence.p99.toFixed(2),
        draws: r.drawMean,
        minorGCs: r.minorGCs,
      })),
    );
    return results;
  } finally {
    await browser?.close();
    await server.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runBenchmark();
