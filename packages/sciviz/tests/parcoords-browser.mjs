import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-parcoords.html', port: 'free', compat });
  const errors = []; browser.page.on('pageerror', (e) => errors.push(e.message)); browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').dataset.ready === 'true');
    const result = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-parcoords.ts');
      const { parallelCoordinates, parallelDensity, MultivariateData } = await import('/packages/sciviz/dist/parcoords.js');
      const { ColumnarTable } = await import('/packages/sciviz/dist/table.js');
      const { SelectionStore } = await import('/packages/sciviz/dist/link.js');
      const check = (v, text) => { if (!v) throw new Error(text); };
      const pixels = async (plot) => { const bitmap = await createImageBitmap(await plot.figure.toPNG()); const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close(); const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let hash = 0, ink = 0; for (let i = 0; i < bytes.length; i += 4) { hash = Math.imul(hash, 31) + bytes[i] + 256 * bytes[i + 1] | 0; if (bytes[i + 2] > 100) ink++; } return { hash, ink }; };
      demo.parallel.figure.engine.stop(); demo.matrix.figure.engine.stop();
      for (const dimensions of [undefined, 'invalid']) {
        let rejected = false;
        try { demo.parallel.figure.addLayer({ dimensions, bounds: [0, 1, 0, 1, 0, 0], setModel() {}, dispose() {} }); } catch { rejected = true; }
        check(rejected, 'custom layers preserve the default 3d restriction and validate explicit dimensions');
      }
      const before = await Promise.all([pixels(demo.parallel), pixels(demo.matrix)]);
      check(before.every((v) => v.ink > 100), 'both GPU plots draw real observations');
      demo.parallel.brush('period', [1, 20]); demo.parallel.brush('radius', [1, 3]);
      const expected = demo.parallel.data.rowIds.filter((_, i) => { const p = demo.table.value('period', i), r = demo.table.value('radius', i); return p >= 1 && p <= 20 && r >= 1 && r <= 3; });
      check(JSON.stringify(demo.selection.rowIds) === JSON.stringify(expected), 'axis brushes intersect by keyed rows');
      const brushed = await Promise.all([pixels(demo.parallel), pixels(demo.matrix)]);
      check(before.every((v, i) => v.hash !== brushed[i].hash), 'shared brushing changes both rendered plots');
      demo.selection.undo(); check(demo.selection.rowIds.length > expected.length, 'shared undo restores the prior brush');
      // KB5700c: the undone radius range must not come back with the next period gesture.
      demo.parallel.brush('period', [1, 25]);
      const periodOnly = demo.parallel.data.rowIds.filter((_, i) => { const p = demo.table.value('period', i); return p >= 1 && p <= 25; });
      check(JSON.stringify(demo.selection.rowIds) === JSON.stringify(periodOnly), 'undo restores the axis ranges with the rows');
      demo.selection.undo(); demo.selection.redo();
      check(JSON.stringify(demo.selection.rowIds) === JSON.stringify(periodOnly), 'redo keeps the period-only ranges');
      demo.matrix.brushCell('period', 'radius', [2, 10], [2, 5]);
      check(demo.selection.rowIds.every((key) => { const i = demo.parallel.data.rowIds.indexOf(key); return demo.table.value('period', i) >= 2 && demo.table.value('period', i) <= 10 && demo.table.value('radius', i) >= 2 && demo.table.value('radius', i) <= 5; }), 'matrix brush uses physical shared scales');
      demo.selection.clear();
      demo.parallel.brush('period', [1, 20]);
      check(JSON.stringify(demo.selection.rowIds) === JSON.stringify(demo.parallel.data.rowIds.filter((_, i) => demo.table.value('period', i) >= 1 && demo.table.value('period', i) <= 20)), 'clearing selection also clears stale other-axis predicates');
      demo.selection.clear();
      const device = demo.gpu.device, write = device.queue.writeBuffer.bind(device.queue), writes = [];
      device.queue.writeBuffer = (...args) => { writes.push(args[2].byteLength ?? args[2].length); return write(...args); };
      demo.parallel.reorder(['uncertainty', 'radius', 'period']);
      check(writes.length === 1 && writes[0] === 24, 'reorder writes only 24 bytes'); writes.length = 0;
      demo.parallel.flip('period'); check(writes.length === 1 && writes[0] === 24, 'flip writes only the axis order buffer'); device.queue.writeBuffer = write;
      const reordered = await pixels(demo.parallel); check(reordered.hash !== before[0].hash, 'reorder and flip change pixels');
      const cpu = await parallelDensity(demo.parallel.data, demo.selection, { width: 33, height: 24 });
      const gpu = await demo.parallel.density({ width: 33, height: 24, gpu: demo.gpu });
      check(cpu.length === gpu.length && cpu.every((v, i) => v === gpu[i]), 'every density pixel matches the independent CPU integer model');
      check(gpu.reduce((a, b) => a + b, 0) > 0, 'real-observation density has votes');
      const density = await pixels(demo.parallel); check(density.hash !== reordered.hash && density.ink > 100, 'density mode draws counts');
      demo.parallel.lines(); const restoredLines = await pixels(demo.parallel); check(restoredLines.hash === reordered.hash, 'line mode restores original geometry');
      demo.parallel.figure.layers[0].restore(); check((await pixels(demo.parallel)).hash === reordered.hash, 'resource restoration preserves row geometry');
      // Two million physical rows, repeating the public observations; no sampling or expanded line-endpoint arrays.
      const rows = 2000000, columns = {};
      for (const name of ['period', 'radius', 'uncertainty']) columns[name] = Float32Array.from({ length: rows }, (_, i) => Number(demo.table.value(name, i % demo.table.length)));
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:256px;height:160px'; document.body.append(canvas);
      using stress = await parallelCoordinates(canvas, new ColumnarTable(columns), { axes: ['period', 'radius', 'uncertainty'] }); stress.figure.engine.stop();
      let drawInstances = 0;
      const stressDevice = stress.figure.renderer.device, encoder = stressDevice.createCommandEncoder.bind(stressDevice);
      stressDevice.createCommandEncoder = (...args) => { const command = encoder(...args), begin = command.beginRenderPass.bind(command); command.beginRenderPass = (...passArgs) => { const pass = begin(...passArgs), draw = pass.draw.bind(pass); pass.draw = (v, n, ...rest) => { if (v === 2) drawInstances = Math.max(drawInstances, n); return draw(v, n, ...rest); }; return pass; }; return command; };
      const stressImage = await pixels(stress); stressDevice.createCommandEncoder = encoder;
      check(drawInstances === rows * 2 + 3 && stress.data.values.byteLength === rows * 3 * 4 && stressImage.ink > 10, 'two million rows are drawn as all instanced segments');
      const smallColumns = Object.fromEntries(Object.entries(columns).map(([key, values]) => [key, values.slice(0, demo.table.length)]));
      const small = new MultivariateData(new ColumnarTable(smallColumns), { axes: ['period', 'radius', 'uncertainty'] }); using smallSelection = new SelectionStore(small.rowIds);
      const reference = await parallelDensity(small, smallSelection, { width: 3, height: 8 });
      const densityRoutesBefore = device.dispatches ? { ...device.dispatches } : undefined;
      const largeDensity = await parallelDensity(stress.data, stress.selection, { width: 3, height: 8, gpu: demo.gpu });
      const densityRoutes = densityRoutesBefore ? Object.fromEntries(Object.entries(device.dispatches).map(([key, value]) => [key, value - densityRoutesBefore[key]])) : undefined;
      check(largeDensity.every((v, i) => v === reference[i] * (rows / demo.table.length)), 'every 2M-row density pixel matches the independent repeated-observation reference');
      const result = { before, selected: expected.length, densityVotes: gpu.reduce((a, b) => a + b, 0), rows, drawInstances, columnBytes: stress.data.values.byteLength, largeVotes: largeDensity.reduce((a, b) => a + b, 0), densityRoutes, matrixCells: demo.matrix.data.axes.length ** 2 };
      canvas.remove(); demo.controls.dispose(); demo.parallel.dispose(); demo.matrix.dispose(); demo.gpu.dispose(); demo.selection.dispose(); return result;
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ compat, ...result }));
  } finally { await browser.close(); }
}
