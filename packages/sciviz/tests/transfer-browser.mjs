import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { writeFile } from 'node:fs/promises';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-transfer.html', port: 'free', compat }),
    errors = [];
  browser.page.setDefaultTimeout(120000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    await browser.page.screenshot({ path: `test-results/batch173-transfer-${compat ? 'compat' : 'native'}.png` });
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-transfer.ts'),
        { Figure } = await import('/packages/sciviz/dist/index.js'),
        { TransferFunction, bindTransfer, preintegrateTransfer } = await import('/packages/sciviz/dist/transfer.js');
      const pixels = async (f) => {
        await f.ready();
        f.engine.render();
        const bitmap = await createImageBitmap(await f.toPNG({ overlays: false })),
          c = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = c.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const hash = (p) => {
        let h = 0,
          n = 0;
        for (let i = 0; i < p.length; i += 4) {
          h = Math.imul(h ^ p[i] ^ (p[i + 1] << 8) ^ (p[i + 2] << 16), 16777619);
          if (Math.abs(p[i] - p[0]) + Math.abs(p[i + 1] - p[1]) + Math.abs(p[i + 2] - p[2]) > 40) n++;
        }
        return { hash: h, lit: n };
      };
      const before = hash(await pixels(demo.figure)),
        reference = hash(await pixels(demo.reference));
      demo.transfer.update({
        ...demo.transfer.state,
        widgets: [
          { kind: 'rectangle', bounds: [-1000, 1500, 0, demo.histogram.gradientMax], rgba: [0.05, 0.5, 1, 0.1] },
        ],
      });
      const after = hash(await pixels(demo.figure));
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 160;
      canvas.style.cssText = 'width:160px;height:160px';
      document.body.append(canvas);
      const fig = await Figure.create(canvas, { axes: false, controls: false, aspect: [1, 1, 1] });
      fig.engine.stop();
      fig.engine.camera.position = [0, 0, 4];
      fig.engine.camera.target = [0, 0, 0];
      const n = 16,
        data = new Float32Array(n ** 3); // linear in data x, including values outside the colour range.
      for (let z = 0; z < n; z++)
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[(z * n + y) * n + x] = x / (n - 1);
      const layer = fig.volume(data, {
        dims: [n, n, n],
        bounds: [0, 1, 0, 1, 0, 1],
        range: [0.25, 0.75],
        shading: false,
      });
      const tf = new TransferFunction({
        mode: '2d',
        range: [0.25, 0.75],
        gradientMax: 2,
        points: [
          { value: 0.25, rgba: [1, 1, 1, 0.1] },
          { value: 0.75, rgba: [1, 1, 1, 0.1] },
        ],
        widgets: [{ kind: 'rectangle', bounds: [-1, 2, 0.9, 1.1], rgba: [1, 0, 0, 0.2] }],
      });
      const binding = bindTransfer(layer, tf, { resolution: 256 });
      const linear = await pixels(fig);
      tf.update({ ...tf.state, widgets: [{ kind: 'rectangle', bounds: [-1, 2, 1.5, 1.9], rgba: [1, 0, 0, 0.2] }] });
      const excluded = await pixels(fig);
      let selected = 0,
        rejected = 0;
      for (let i = 0; i < linear.length; i += 4) {
        if (linear[i] > linear[i + 1] + 80) selected++;
        if (excluded[i] > excluded[i + 1] + 80) rejected++;
      }
      // Constant field: independent optical-depth reference at the centre ray.
      binding.dispose();
      data.fill(0.5);
      layer.dispose();
      const constant = fig.volume(data, {
        dims: [n, n, n],
        bounds: [0, 1, 0, 1, 0, 1],
        range: [0, 1],
        shading: false,
        quality: 2,
      });
      const one = new TransferFunction({
        range: [0, 1],
        gradientMax: 1,
        points: [
          { value: 0, rgba: [1, 0, 0, 0.04] },
          { value: 1, rgba: [1, 0, 0, 0.04] },
        ],
      });
      constant.setClassification(await preintegrateTransfer(one, { step: 0.5, resolution: 32, samples: 32 }));
      const pre = await pixels(fig);
      constant.setClassification(one.table(32));
      const post = await pixels(fig);
      const centre = (80 * 160 + 80) * 4,
        difference = Math.max(...[0, 1, 2].map((k) => Math.abs(pre[centre + k] - post[centre + k])));
      const slice = constant.slice('z', 0.5);
      constant.setClassification(one.table(16));
      await pixels(fig);
      slice.dispose();
      // Queue a blue frame behind deferred backend work. PNG must not capture the previous red frame.
      const queue = fig.engine.gpu.queue,
        submit = queue.submit.bind(queue),
        done = queue.onSubmittedWorkDone.bind(queue),
        deferred = [];
      let submissions = 0;
      queue.submit = (buffers) => {
        const commands = [...buffers];
        if (++submissions === 1) deferred.push(commands);
        else {
          for (const pending of deferred.splice(0)) submit(pending);
          submit(commands);
        }
      };
      queue.onSubmittedWorkDone = () => {
        for (const buffers of deferred.splice(0)) submit(buffers);
        return done();
      };
      let queuedExport;
      try {
        one.update({
          ...one.state,
          points: [
            { value: 0, rgba: [0, 0, 1, 0.04] },
            { value: 1, rgba: [0, 0, 1, 0.04] },
          ],
        });
        constant.setClassification(one.table(16));
        const bitmap = await createImageBitmap(await fig.toPNG({ overlays: false })),
          image = new OffscreenCanvas(160, 160),
          context = image.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        queuedExport = context.getImageData(0, 0, 160, 160).data;
      } finally {
        for (const buffers of deferred.splice(0)) submit(buffers);
        queue.submit = submit;
        queue.onSubmittedWorkDone = done;
      }
      const queuedBlue = queuedExport[centre + 2] > queuedExport[centre] + 50;

      constant.dispose();
      let disposedReject = false;
      try {
        constant.setClassification(one.table(16));
      } catch {
        disposedReject = true;
      }
      fig.dispose();
      canvas.remove();
      demo.editor.dispose();
      demo.figure.dispose();
      demo.reference.dispose();
      return {
        before,
        after,
        reference,
        valid: demo.histogram.valid,
        selected,
        rejected,
        difference,
        disposedReject,
        queuedBlue,
      };
    });
    assert.ok(report.before.lit > 500 && report.after.lit > 500 && report.reference.lit > 500, JSON.stringify(report));
    assert.notEqual(report.before.hash, report.after.hash);
    assert.ok(report.selected > 500 && report.rejected === 0, JSON.stringify(report));
    assert.ok(report.difference <= 3, JSON.stringify(report));
    assert.ok(report.disposedReject);
    assert.ok(report.queuedBlue, 'PNG must await submitted work before reading the canvas');
    assert.deepEqual(errors, []);
    reports.push({ backend: compat ? 'WebGL2' : 'WebGPU', ...report });
    console.log(JSON.stringify(reports.at(-1)));
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch173-transfer.json', JSON.stringify(reports, null, 2) + '\n');
