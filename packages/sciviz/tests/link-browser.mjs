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
      const area = demo.figure.engine.canvas.getBoundingClientRect();
      const brushed = demo.figure.select({
        rect: [area.width * 0.42, area.height * 0.42, area.width * 0.52, area.height * 0.58],
      });
      check(
        brushed.points.some(
          (p) => p.layer === demo.cloud && p.indices.length > 0 && p.indices.length < demo.cloud.count,
        ),
        'bound source layers remain brushable through their visible proxy',
      );
      demo.cloudBinding.visible = false;
      check(
        demo.figure.select({ rect: [0, 0, area.width, area.height] }).points.length === 0,
        'hidden proxies do not select their source geometry',
      );
      demo.cloudBinding.visible = true;
      demo.selection.clear();
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
      // KB5588c: a bound scatter keeps its own drawing (eye-dome lighting, per-point sizes, square shape) and a bound
      // line its own styling (dashes); the SVG export applies the selection as drawn.
      const styledCanvas = document.createElement('canvas');
      styledCanvas.width = 256;
      styledCanvas.height = 192;
      document.body.append(styledCanvas);
      const styled = await Figure.create(styledCanvas, { mode: '2d', controls: false });
      styled.engine.stop();
      const n = 64,
        x = Float32Array.from({ length: n }, (_, i) => i % 8),
        y = Float32Array.from({ length: n }, (_, i) => Math.floor(i / 8)),
        sizes = Float32Array.from({ length: n }, (_, i) => 1 + (i % 3));
      const dots = await styled.scatter(
        { x, y, size: sizes },
        { size: 6, shape: 'square', edl: true, color: '#3080ff' },
      );
      const trace = await styled.line({ x: [0, 2, 4, 6, 7], y: [0, 7, 1, 6, 2] }, { width: 4, color: '#ff8020' });
      trace.line.material.set({ dashed: true, dashSize: 6, gapSize: 3 });
      const rows = new SelectionStore(Array.from({ length: n + 5 }, (_, i) => i));
      const plain = await pixels(styled);
      const dotBinding = bindSelection(styled, dots, rows, { mode: 'fade' });
      const lineBinding = bindSelection(styled, trace, rows, {
        rowIds: [n, n + 1, n + 2, n + 3, n + 4],
        mode: 'filter',
      });
      const unselected = await pixels(styled);
      check(
        unselected.hash === plain.hash,
        'with nothing selected a bound EDL scatter and dashed line draw exactly as unbound',
      );
      const chosen = Array.from({ length: n }, (_, i) => i).filter((i) => i % 2 === 0);
      rows.select([...chosen, n, n + 1]);
      const brushedPixels = await pixels(styled);
      check(
        brushedPixels.hash !== plain.hash && brushedPixels.lit < plain.lit,
        'the selection fades and filters marks',
      );
      const svg = await styled.toSVG();
      const circles = [...svg.matchAll(/<circle [^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
      check(circles.length === n, 'fade keeps every point in the SVG');
      const faded = circles.filter((c) => c !== '#3080ff').length;
      check(faded === n - chosen.length, 'the SVG fades exactly the unselected points');
      const segments = [...svg.matchAll(/<path d="M[^"]*" stroke="(#[0-9a-f]{6})" stroke-width="4"/g)];
      check(segments.length === 1 && segments[0][1] === '#ff8020', 'the SVG keeps only the selected line segment');
      dotBinding.dispose();
      lineBinding.dispose();
      const restored = await pixels(styled);
      check(restored.hash === plain.hash, 'disposing the bindings restores the unbound drawing');
      styled.dispose();
      styledCanvas.remove();
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
      fig.render();
      uploads.length = 0;
      demo.selection.select(subset);
      fig.render();
      queue.writeBuffer = write;
      const maskBytes = layer.cloud.mask.byteLength;
      check(maskBytes === 16 + (keys.length / 32) * 4, 'one bit a point after the style header');
      check(
        uploads.filter((u) => u.bytes === maskBytes).length === 1 && uploads.every((u) => u.bytes <= maskBytes),
        'actual queue: exactly one mask write and no geometry upload',
      );
      check(linked.maskWrites === startWrites + 1, '2M-point selection is one buffer write');
      check(linked.weights.reduce((a, b) => a + b, 0) === subset.length * 2, '2M rows retain repeated-key identity');
      let selectedBits = 0;
      for (let i = 0; i < keys.length; i++) selectedBits += +layer.cloud.isSelected(i);
      check(selectedBits === subset.length * 2, 'the cloud mask exactly matches keyed selection');
      check(layer.cloud.visible && layer.cloud.maskStyle.mode === 'filter', 'the cloud draws itself, filtered');
      // Restoration must re-upload the current selection, never default to all rows.
      linked.restore();
      check(linked.weights.reduce((a, b) => a + b, 0) === subset.length * 2, 'restore retains selection');
      linked.dispose();
      linked.dispose();
      check(layer.cloud.visible && layer.cloud.mask === null, 'disposing binding removes the mask');
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
      // A binding hides its source and draws the marks itself; box and lasso selection must still reach the layer.
      const region = fig.select({ rect: [0, 0, canvas.clientWidth, canvas.clientHeight] });
      check(
        region.points.some((p) => p.layer === first) && region.points.some((p) => p.layer === second),
        'bound layers stay selectable',
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
