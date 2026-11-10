import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-stars.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#viewport').dataset.ready === 'true');
    const result = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-stars.ts');
      const { SelectionStore, bindSelection } = await import('/packages/sciviz/dist/link.js');
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const check = (value, message) => {
        if (!value) throw new Error(message);
      };
      for (const figure of [demo.figure, demo.histogram, demo.heatmap]) figure.engine.stop();
      const pixels = async (figure) => {
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 2166136261,
          lit = 0;
        for (let i = 0; i < data.length; i += 4) {
          hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619);
          if (Math.max(data[i], data[i + 1], data[i + 2]) > 80) lit++;
        }
        return { hash, lit };
      };
      const before = await Promise.all([demo.figure, demo.histogram, demo.heatmap].map(pixels));
      const subset = [];
      for (let i = 0; i < demo.cloud.count; i++)
        if (demo.cloud.values[i] > 0.8 && demo.cloud.values[i] < 1.1) subset.push(i);
      const writes = demo.cloudBinding.maskWrites;
      demo.selection.select(subset, { source: 'test' });
      check(demo.cloudBinding.maskWrites === writes + 1, 'one mask upload for one update');
      check(demo.selected === subset.length, 'shared event row count');
      const after = await Promise.all([demo.figure, demo.histogram, demo.heatmap].map(pixels));
      check(
        before.every((p, i) => p.lit > 100 && after[i].lit > 100 && p.hash !== after[i].hash),
        'all three rendered views change',
      );
      check(demo.bars.values.reduce((a, b) => a + b, 0) === subset.length, 'histogram uses selected rows');
      demo.selection.undo();
      check(demo.selected === demo.cloud.count, 'undo restores all views');
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      document.body.append(canvas);
      const fig = await Figure.create(canvas, { axes: false, controls: false });
      fig.engine.stop();
      // Two plotted copies of actual observed rows stress two million marks, without inventing observations.
      const positions = new Float32Array(demo.cloud.positions.length * 2);
      positions.set(demo.cloud.positions);
      positions.set(demo.cloud.positions, demo.cloud.positions.length);
      const keys = Uint32Array.from({ length: demo.cloud.count * 2 }, (_, i) => i % demo.cloud.count);
      const layer = await fig.scatter({ positions }, { size: 2 });
      const linked = bindSelection(fig, layer, demo.selection, { rowIds: keys, mode: 'filter', source: 'two-million' });
      await fig.ready();
      const startWrites = linked.maskWrites;
      const queue = fig.engine.gpu.queue,
        write = queue.writeBuffer.bind(queue),
        uploads = [];
      queue.writeBuffer = (buffer, ...args) => {
        uploads.push({ buffer, bytes: args[1].byteLength });
        return write(buffer, ...args);
      };
      demo.selection.select(subset);
      queue.writeBuffer = write;
      check(
        uploads.length === 1 && uploads[0].buffer === linked.buffer && uploads[0].bytes === 8_000_000,
        'actual queue: exactly one mask write and no geometry upload',
      );
      check(linked.maskWrites === startWrites + 1, '2M-point selection is one buffer write');
      check(linked.weights.reduce((a, b) => a + b, 0) === subset.length * 2, '2M rows retain repeated-key identity');
      fig.render();
      await fig.engine.gpu.queue.onSubmittedWorkDone();
      const read = fig.engine.gpu.createBuffer({ size: linked.buffer.size, usage: 9 });
      const encoder = fig.engine.gpu.createCommandEncoder();
      encoder.copyBufferToBuffer(linked.buffer, 0, read, 0, read.size);
      fig.engine.gpu.queue.submit([encoder.finish()]);
      await read.mapAsync(1);
      const values = new Float32Array(read.getMappedRange());
      check(
        values.slice(0, keys.length).reduce((a, b) => a + b, 0) === subset.length * 2,
        'GPU mask readback exactly matches keyed selection',
      );
      read.unmap();
      read.destroy();
      const maskBytes = linked.buffer.size;
      // Restoration must re-upload the current selection, never default to all rows.
      linked.restore();
      check(linked.weights.reduce((a, b) => a + b, 0) === subset.length * 2, 'restore retains selection');
      linked.dispose();
      linked.dispose();
      check(layer.cloud.visible, 'disposing binding restores source visibility');
      const first = await fig.scatter({ positions: demo.cloud.positions.slice(0, 12) });
      const second = await fig.scatter({ positions: demo.cloud.positions.slice(12, 24) });
      const a = bindSelection(fig, first, demo.selection, { rowIds: [0, 1, 2, 3] });
      const b = bindSelection(fig, second, demo.selection, { rowIds: [4, 5, 6, 7] });
      check(a.source === b.source, 'one default brush identity per figure/store');
      fig.dispatchEvent(
        new CustomEvent('selection', {
          detail: {
            points: [
              { layer: first, indices: new Uint32Array([0]) },
              { layer: second, indices: new Uint32Array([0]) },
            ],
          },
        }),
      );
      check(
        demo.selection.rowIds.length === 2 && demo.selection.has(0) && demo.selection.has(4),
        'multiple layers publish a single merged selection',
      );
      a.dispose();
      b.dispose();
      fig.dispose();
      canvas.remove();
      for (const figure of [demo.figure, demo.histogram, demo.heatmap]) figure.dispose();
      return { views: after, selected: subset.length, marks: keys.length, maskBytes, selectionWrites: 1 };
    });
    assert.deepEqual(errors, []);
    console.log(`link ${compat ? 'WebGL2' : 'WebGPU'} ${JSON.stringify(result)}`);
  } finally {
    await browser.close();
  }
}
