import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const reports = [];
for (const compat of [false, true]) {
  const context = await openBrowser({ startPath: '/examples/sciviz-workers.html', port: 'free', compat });
  const errors = [],
    requests = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  context.page.on('request', (request) => requests.push(request.url()));
  context.page.setDefaultTimeout(120000);
  try {
    await context.page.waitForFunction(() => document.querySelector('#viewport').dataset.ready === 'netcdf');
    const result = await context.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-workers.ts');
      const output = {};
      for (const format of ['netcdf', 'vtkxml', 'vtk', 'zarr', 'nrrd', 'nifti', 'dicom']) {
        await demo.show(format);
        const image = await demo.figure.toPNG();
        output[format] = {
          pngBytes: image.size,
          layers: demo.figure.layers.length,
          milestones: demo.milestones.length,
        };
      }
      const { readInWorker } = await import('/packages/sciviz/dist/workers.js');
      const buffer = new Uint8Array([1, 2, 3]).buffer;
      const controller = new AbortController();
      let entered = false,
        callbackAborted = false;
      const pending = readInWorker(
        'openZarr',
        [
          async (_key, signal) => {
            entered = true;
            const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            controller.abort(new Error('browser cancellation'));
            await aborted;
            callbackAborted = signal.aborted;
            return undefined;
          },
        ],
        { signal: controller.signal, timeout: 10000 },
      );
      let abortMessage;
      try {
        await pending;
      } catch (error) {
        abortMessage = error.message;
      }
      // Let the callback server's disposal deliver its worker-local AbortSignal.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pre = AbortSignal.abort('pre-abort');
      try {
        await readInWorker('parseNIfTI', [buffer], { signal: pre, transfer: [buffer] });
      } catch {
        /* asserted below */
      }
      demo.figure.dispose();
      return { output, entered, callbackAborted, abortMessage, attached: buffer.byteLength };
    });
    for (const proof of Object.values(result.output)) {
      assert.ok(proof.pngBytes > 1000);
      assert.equal(proof.layers, 1);
    }
    assert.equal(result.entered, true);
    assert.equal(result.callbackAborted, true);
    assert.equal(result.abortMessage, 'browser cancellation');
    assert.equal(result.attached, 3);
    assert.ok(requests.some((url) => url.includes('/workers/readers')));
    assert.deepEqual(errors, []);
    reports.push({ backend: compat ? 'webgl2' : 'webgpu', ...result });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/batch175-job6-browser.json', JSON.stringify(reports, null, 2) + '\n');
console.log(JSON.stringify(reports));
