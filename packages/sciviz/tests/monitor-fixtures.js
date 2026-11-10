// Real-data correctness and speed-phase fixtures. Tiling/resampling is explicit in each source label.
import { Figure } from '../dist/index.js';
import { createFallbackFigure } from '../dist/fallback.js';
import { installFigureStats, sweepLimits } from '../dist/monitor.js';
import { loadNRRD } from '../dist/nrrd.js';
import { graphLayer } from '../dist/graph.js';
import { ColumnarTable, readCSV } from '../dist/table.js';

// sciviz never imports the compatibility layer; the caller supplies it.
const createFallback = async (canvas, options) =>
  createFallbackFigure(canvas, { ...options, compat: await import('../../webgl2-compat/dist/index.js') });

const asset = (name) => new URL(`/examples/assets/sciviz/${name}`, location.href);
async function bytes(name, signal) {
  const response = await fetch(asset(name), { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${name}`);
  return response.arrayBuffer();
}
const csvColumns = (text) => {
  const table = readCSV(text);
  return Object.values(table.columns).map((column) => column.values);
};
const tile = (source, count) => Float32Array.from({ length: count }, (_, i) => source[i % source.length]);
const floats = async (name, signal) =>
  new Float32Array(
    await new Response(
      new Blob([await bytes(name, signal)]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer(),
  );

export async function realDataSweeps({
  fallback = false,
  timing = false,
  metadata,
  sizes = {},
  kinds,
  signal = AbortSignal.timeout(120000),
} = {}) {
  const stars = await floats('stars.bin', signal),
    starCount = stars.length / 4;
  const wind = await floats('wind.bin', signal);
  const head = await loadNRRD(asset('head.nrrd'), { signal });
  const taxis = csvColumns(new TextDecoder().decode(await bytes('limits/taxi.csv', signal)));
  const defaults = {
    points: [256, 4096, 65536],
    voxels: [512, 4096, 13824],
    cells: [256, 1024, 4096],
    edges: [256, 4096, 32768],
    rows: [256, 1024, 4096],
  };
  const reports = [];
  for (const kind of kinds ?? Object.keys(defaults)) {
    reports.push(
      await sweepLimits({
        kind,
        timing,
        metadata,
        signal,
        sizes: sizes[kind] ?? defaults[kind],
        format: {
          points: '2MASS columnar f32 (tiled above 1M)',
          voxels: 'NRRD head (nearest resampled)',
          cells: 'NOAA wind (tiled heatmap)',
          edges: '2MASS positions, consecutive source-index edges',
          rows: 'NYC TLC CSV columns (tiled above 1024)',
        }[kind],
        prepare: async (size, currentSignal) => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          canvas.style.cssText = 'width:320px;height:240px';
          document.body.append(canvas);
          let fig;
          try {
            fig = installFigureStats(
              await (fallback ? createFallback : Figure.create)(canvas, {
                mode: kind === 'cells' ? '2d' : '3d',
                controls: false,
                axes: false,
                pointBudget: Number.MAX_SAFE_INTEGER,
                signal: currentSignal,
              }),
            );
            fig.engine.stop();
            if (kind === 'points')
              await fig.scatter({
                x: tile(stars.subarray(0, starCount), size),
                y: tile(stars.subarray(starCount, starCount * 2), size),
                z: tile(stars.subarray(starCount * 2, starCount * 3), size),
              });
            if (kind === 'voxels') {
              const n = Math.round(Math.cbrt(size));
              if (n ** 3 !== size) throw new Error('Voxel sweep size must be a cube');
              const data = Float32Array.from({ length: size }, (_, i) => {
                const x = Math.round(((i % n) / (n - 1)) * (head.dims[0] - 1));
                const y = Math.round(((Math.floor(i / n) % n) / (n - 1)) * (head.dims[1] - 1));
                const z = Math.round((Math.floor(i / (n * n)) / (n - 1)) * (head.dims[2] - 1));
                return head.data[(z * head.dims[1] + y) * head.dims[0] + x];
              });
              fig.volume(data, { dims: [n, n, n], range: [0, 600], shading: false });
            }
            if (kind === 'cells') {
              const n = Math.round(Math.sqrt(size));
              if (n * n !== size) throw new Error('Cell sweep size must be a square');
              await fig.heatmap(tile(wind, size), { nx: n, ny: n });
            }
            if (kind === 'edges') {
              const n = size + 1;
              const positions = Float32Array.from(
                { length: n * 3 },
                (_, i) => stars[(Math.floor(i / 3) % starCount) + (i % 3) * starCount],
              );
              graphLayer(
                fig,
                { nodes: n, edges: Uint32Array.from({ length: size * 2 }, (_, i) => Math.floor(i / 2) + (i % 2)) },
                positions,
              );
            }
            if (kind === 'rows') {
              const columns = taxis.map((column) => tile(column, size)),
                table = new ColumnarTable(Object.fromEntries(columns.map((values, i) => [`column${i}`, values])));
              fig.stats.trackTable(table, 'NYC TLC table');
              await fig.scatter({ x: columns[0], y: columns[1], color: columns[3] });
            }
            await fig.ready();
            return {
              frame: async (frameSignal) => {
                frameSignal.throwIfAborted();
                fig.render();
                await fig.renderer.device.queue.onSubmittedWorkDone();
              },
              stats: () => fig.stats.snapshot(),
              dispose: () => {
                fig.stats.dispose();
                fig.dispose();
                canvas.remove();
              },
            };
          } catch (error) {
            fig?.stats.dispose();
            fig?.dispose();
            canvas.remove();
            throw error;
          }
        },
      }),
    );
  }
  return reports;
}

/** Full format loads, not metadata-only opens. Independent rows preserve each source byte size. */
export async function realFormatLoads({ timing = false, metadata, signal = AbortSignal.timeout(120000) }) {
  const specs = [
    ['NRRD', ['head.nrrd'], async (input, s) => (await loadNRRD(input, { signal: s })).data],
    [
      'NetCDF',
      ['wind-classic.nc', 'wind-offset.nc'],
      async (input, s) => {
        const { openNetCDF } = await import('../dist/netcdf.js');
        const file = await openNetCDF(input, { signal: s });
        try {
          return await file.variables.uwnd.read({ signal: s });
        } finally {
          file.dispose();
        }
      },
    ],
    [
      'VTK XML',
      ['wind.vti', 'wind.vts', 'wind.vtu'],
      async (input, s) => {
        const { openVTK } = await import('../dist/vtk.js');
        const file = await openVTK(input, { signal: s });
        try {
          const arrays = file.dataset.pieces.flatMap((p) => [
            ...Object.values(p.pointData),
            ...Object.values(p.cellData),
            ...(p.points ? [p.points] : []),
            ...(p.cells ? Object.values(p.cells) : []),
          ]);
          return (await Promise.all(arrays.map((a) => a.read(s)))).map((a) => a.byteLength).reduce((a, b) => a + b, 0);
        } finally {
          file.dispose();
        }
      },
    ],
    [
      'legacy VTK',
      ['wind.vtk'],
      async (input) => {
        const { parseVtk } = await import('../dist/grids.js');
        return parseVtk(input).points;
      },
    ],
    ['CSV', ['limits/taxi.csv'], async (input) => csvColumns(new TextDecoder().decode(input))],
  ];
  const reports = [];
  for (const [format, paths, load] of specs)
    for (const path of paths) {
      // Download once to discover size; the measured case includes a fresh fetch and complete decode.
      const size = (await bytes(path, signal)).byteLength;
      reports.push(
        await sweepLimits({
          kind: 'load',
          format: `${format}: ${path}`,
          sizes: [size],
          timing,
          metadata,
          signal,
          prepare: async (_, s) => {
            const data = await load(await bytes(path, s), s);
            return {
              frame: async () => {},
              stats: () => ({
                gpuBytes: 0,
                jsDataBytes: ArrayBuffer.isView(data)
                  ? data.byteLength
                  : Array.isArray(data)
                    ? data.reduce((n, c) => n + c.byteLength, 0)
                    : data,
                jsArrayBytesEstimate: 0,
                counts: {},
                layers: [],
                unreportedLayers: 0,
              }),
              dispose() {},
            };
          },
        }),
      );
    }
  return reports;
}
