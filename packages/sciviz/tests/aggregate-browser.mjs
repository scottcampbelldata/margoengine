import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const scale = !process.argv.includes('--small');
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-aggregate.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').dataset.ready === 'true');
    const proof = await browser.page.evaluate(
      async ({ compat, scale }) => {
        const demo = await import('/examples/sciviz-aggregate.ts');
        const { aggregateRaster, shadeAggregate } = await import('/packages/sciviz/dist/aggregate.js');
        const { ColumnarTable } = await import('/packages/sciviz/dist/table.js');
        const check = (ok, why) => {
          if (!ok) throw new Error(why);
        };
        const equal = (a, b) =>
          Object.keys(a)
            .filter((key) => ArrayBuffer.isView(a[key]))
            .every((key) => [...a[key]].every((value, i) => Object.is(value, b[key][i])));
        const hash = async () => {
          const blob = await demo.figure.toPNG();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let result = 0;
          for (const byte of bytes) result = (Math.imul(result, 31) + byte) | 0;
          return result;
        };
        demo.figure.engine.stop();
        const before = await hash(),
          original = demo.binding.result,
          count = original.count.reduce((a, b) => a + b, 0);
        check(count === demo.tables.tlc.length, 'all original TLC pick-ups enter the figure bins');
        demo.binding.shade({ transform: 'log', spread: 1 });
        check((await hash()) !== before, 'shading and spreading change rendered pixels');
        check(
          original === demo.binding.result && original.count.reduce((a, b) => a + b, 0) === count,
          'colour changes do not revisit rows or alter statistics',
        );
        demo.figure.setLimits([-74.01, -73.97, 40.73, 40.77]);
        await demo.binding.refresh();
        check(demo.binding.result.count.reduce((a, b) => a + b, 0) < count, 'zoom re-aggregates original rows');
        await demo.show('gbif');
        await demo.figure.ready();
        check(
          demo.binding.result.count.reduce((a, b) => a + b, 0) === demo.tables.gbif.length,
          'all GBIF CC0 and CC BY original records enter bins',
        );
        const gpu = demo.gpu,
          startRoutes = gpu.device.dispatches ? { ...gpu.device.dispatches } : undefined;
        const edgeTable = new ColumnarTable({
          x: Float64Array.of(-Number.MIN_VALUE, 0, 2, 2 + 2 ** -51, 1 - 2 ** -53, 1, 1 + 2 ** -52),
          y: new Float64Array(7).fill(0.5),
        });
        const edge = await aggregateRaster(edgeTable, {
          columns: { x: 'x', y: 'y' },
          bounds: [0, 2, 0, 2],
          width: 2,
          height: 2,
          gpu,
        });
        check(
          JSON.stringify([...edge.count]) === '[2,3,0,0]',
          'GPU point bounds retain exact original-coordinate ownership at and just outside edges',
        );
        const options = {
          columns: { x: 'x', y: 'y', x1: 'x1', y1: 'y1', x2: 'x2', y2: 'y2', x3: 'x3', y3: 'y3' },
          width: 4,
          height: 4,
          bounds: [0, 2, 0, 2],
          value: 'value',
          category: 'category',
          chunkRows: 3,
        };
        const values = [
          1e16,
          1,
          -1e16,
          Number.MIN_VALUE,
          -Number.MIN_VALUE,
          Number.MAX_VALUE,
          -Number.MAX_VALUE,
          1 + 2 ** -52,
          NaN,
        ];
        const n = values.length,
          column = (v) => new Float64Array(n).fill(v);
        const t = new ColumnarTable({
          x: column(0.1),
          y: column(0.1),
          x1: column(1.9),
          y1: column(1.9),
          x2: column(1.9),
          y2: column(0.1),
          x3: column(0.1),
          y3: column(1.9),
          value: Float64Array.from(values),
          category: { values: Uint32Array.from(values, (_, i) => i % 2), categories: ['a', 'b'] },
        });
        let dispatches = 0;
        const bufferInventory = [];
        for (const glyph of ['points', 'lines', 'areas', 'triangles', 'quads']) {
          const cpu = await aggregateRaster(t, { ...options, glyph });
          const createBuffer = gpu.device.createBuffer.bind(gpu.device);
          let live = 0,
            peak = 0;
          gpu.device.createBuffer = (descriptor) => {
            const buffer = createBuffer(descriptor),
              destroy = buffer.destroy.bind(buffer);
            let disposed = false;
            live += descriptor.size;
            peak = Math.max(peak, live);
            buffer.destroy = () => {
              if (!disposed) {
                disposed = true;
                live -= descriptor.size;
              }
              destroy();
            };
            return buffer;
          };
          let actual;
          try {
            actual = await aggregateRaster(t, { ...options, glyph, gpu });
          } finally {
            gpu.device.createBuffer = createBuffer;
          }
          check(equal(cpu, actual), `GPU ${glyph}: every exact statistic, category and row identity matches CPU`);
          check(
            actual.work.peakStagingBytes >= peak + options.chunkRows * 64,
            'staging inventory includes host records and every live GPU input/result/readback buffer',
          );
          bufferInventory.push({ glyph, gpuBufferPeak: peak, logicalStagingBound: actual.work.peakStagingBytes });
          dispatches += actual.work.dispatches;
        }
        const routes = startRoutes
          ? Object.fromEntries(
              Object.entries(gpu.device.dispatches).map(([key, value]) => [key, value - startRoutes[key]]),
            )
          : undefined;
        if (routes)
          check(
            routes.cpu === 0 && routes.fragment + routes.scatter >= dispatches,
            'all compatibility raster reductions execute on the GPU',
          );
        let large;
        if (scale && !compat) {
          const rows = 100000000,
            seed = demo.tables.tlc,
            length = seed.length;
          const x = new Float64Array(rows),
            y = new Float64Array(rows),
            v = new Float64Array(rows);
          for (let i = 0; i < rows; i++) {
            const r = i % length;
            x[i] = Number(seed.column('x').values[r]);
            y[i] = Number(seed.column('y').values[r]);
            v[i] = Math.round(Number(seed.column('value').values[r]) * 100);
          }
          const table = new ColumnarTable({ x, y, v }),
            options = {
              columns: { x: 'x', y: 'y' },
              width: 4,
              height: 4,
              bounds: [-74.1, -73.7, 40.6, 40.9],
              value: 'v',
              gpu,
              chunkRows: 65536,
            };
          const actual = await aggregateRaster(table, options),
            counts = new Uint32Array(16),
            sums = new Float64Array(16),
            first = new Float64Array(16).fill(NaN),
            last = new Float64Array(16).fill(NaN),
            min = new Float64Array(16).fill(Infinity),
            max = new Float64Array(16).fill(-Infinity);
          const repeats = Math.floor(rows / length),
            remainder = rows % length;
          // Independent original-coordinate row ownership and integer-cent oracle, including the incomplete final repeat.
          for (let i = 0; i < length; i++) {
            const xx = Number(seed.column('x').values[i]),
              yy = Number(seed.column('y').values[i]),
              value = Math.round(Number(seed.column('value').values[i]) * 100);
            const b =
                Math.min(3, Math.floor(((yy - 40.6) / (40.9 - 40.6)) * 4)) * 4 +
                Math.min(3, Math.floor(((xx + 74.1) / (-73.7 + 74.1)) * 4)),
              copies = repeats + Number(i < remainder);
            counts[b] += copies;
            sums[b] += value * copies;
            min[b] = Math.min(min[b], value);
            max[b] = Math.max(max[b], value);
            if (!Number.isFinite(first[b])) first[b] = value;
          }
          for (let i = Math.max(0, rows - length); i < rows; i++) {
            const r = i % length,
              xx = Number(seed.column('x').values[r]),
              yy = Number(seed.column('y').values[r]),
              b =
                Math.min(3, Math.floor(((yy - 40.6) / (40.9 - 40.6)) * 4)) * 4 +
                Math.min(3, Math.floor(((xx + 74.1) / (-73.7 + 74.1)) * 4));
            last[b] = Math.round(Number(seed.column('value').values[r]) * 100);
          }
          for (let b = 0; b < 16; b++) {
            check(
              actual.count[b] === counts[b] && actual.valid[b] === counts[b] && actual.sum[b] === sums[b],
              `100M bin ${b} exact counts and sum`,
            );
            if (counts[b])
              check(
                actual.mean[b] === sums[b] / counts[b] &&
                  actual.min[b] === min[b] &&
                  actual.max[b] === max[b] &&
                  actual.first[b] === first[b] &&
                  actual.last[b] === last[b],
                `100M bin ${b} numeric/order reductions`,
              );
          }
          check(
            actual.count.reduce((a, b) => a + b, 0) === rows && actual.work.rows === rows && actual.work.dispatches > 0,
            'one hundred million physical rows, no sampling',
          );
          large = {
            rows,
            uniqueObservations: length,
            inputBytes: x.byteLength + y.byteLength + v.byteLength,
            work: actual.work,
            counts: [...actual.count],
            sums: [...actual.sum],
          };
        }
        const proof = {
          originalTaxiRows: count,
          originalGBIFRows: demo.tables.gbif.length,
          dispatches,
          bufferInventory,
          routes,
          large,
        };
        demo.binding.dispose();
        demo.gpu.dispose();
        demo.figure.dispose();
        return proof;
      },
      { compat, scale },
    );
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ compat, ...proof }));
    await writeFile(
      `test-results/batch175-aggregate-${compat ? 'webgl2' : 'webgpu'}.json`,
      JSON.stringify({ compat, ...proof }, null, 2) + '\n',
    );
  } finally {
    await browser.close();
  }
}
