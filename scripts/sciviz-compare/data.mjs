// Frozen repository data, copied to each black box after one shared decode.
import { colormap } from '@margoengine/sciviz/colormaps';
import { readCSV } from '@margoengine/sciviz/table';

const ROOT = '/examples/assets/sciviz/';
async function fetchData(path, signal, binary = false) {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`Dataset ${path}: HTTP ${response.status}`);
  return binary ? response.arrayBuffer() : response.text();
}

export async function comparisonData(id, scale, signal) {
  if (['scatter', 'line', 'heatmap'].includes(id)) {
    const path = ROOT + 'limits/taxi.csv';
    const bytes = await fetchData(path, signal);
    const table = readCSV(bytes, { signal });
    const xSource = table.columns.trip_distance.values;
    const ySource = table.columns.total_amount.values;
    const minmax = (a) => {
      let lo = Infinity,
        hi = -Infinity;
      for (const x of a) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      return [lo, hi];
    };
    const [x0, x1] = minmax(xSource),
      [y0, y1] = minmax(ySource);
    const count = id === 'heatmap' ? table.length : scale;
    const points = Array.from({ length: count }, (_, i) => [
      (2 * (xSource[i % table.length] - x0)) / (x1 - x0) - 1,
      (2 * (ySource[i % table.length] - y0)) / (y1 - y0) - 1,
    ]);
    const values = new Float32Array(id === 'heatmap' ? scale * scale : 0);
    if (id === 'heatmap')
      for (const [x, y] of points)
        values[
          Math.min(scale - 1, Math.floor(((y + 1) * scale) / 2)) * scale +
            Math.min(scale - 1, Math.floor(((x + 1) * scale) / 2))
        ]++;
    let maximum = 0;
    for (const value of values) maximum = Math.max(maximum, value);
    const map = colormap('aurora');
    const colorscale = Array.from({ length: 256 }, (_, i) => {
      const rgb = map.sample(i / 255).map((v) => Math.round(v * 255));
      return [i / 255, `rgb(${rgb.join(',')})`];
    });
    return {
      id,
      scale,
      points,
      values,
      maximum,
      colorscale,
      source: path,
      sourceRows: table.length,
      replicated: count > table.length,
      coordinates: { x: [x0, x1], y: [y0, y1], normalized: [-1, 1] },
    };
  }
  if (id === 'graph') {
    const source = '/packages/sciviz/tests/fixtures/graph-gpu/openalex.json';
    const graph = JSON.parse(await fetchData(source, signal));
    const ids = new Map(graph.map((work, i) => [work.id, i]));
    const baseEdges = [];
    for (let i = 0; i < graph.length; i++)
      for (const ref of graph[i].references) if (ids.has(ref)) baseEdges.push(i, ids.get(ref));
    const edges = new Uint32Array(baseEdges.length * scale);
    const positions = new Float32Array(graph.length * scale * 3);
    const columns = Math.ceil(Math.sqrt(scale));
    for (let copy = 0; copy < scale; copy++) {
      for (let e = 0; e < baseEdges.length; e++)
        edges[copy * baseEdges.length + e] = baseEdges[e] + copy * graph.length;
      for (let i = 0; i < graph.length; i++) {
        const angle = (2 * Math.PI * i) / graph.length,
          at = (copy * graph.length + i) * 3;
        positions[at] = -1 + (2 * (copy % columns) + 1 + 0.9 * Math.cos(angle)) / columns;
        positions[at + 1] = -1 + (2 * Math.floor(copy / columns) + 1 + 0.9 * Math.sin(angle)) / columns;
      }
    }
    return { id, scale, source, positions, edges, sourceNodes: graph.length, copies: scale };
  }
  if (id === 'tiles') return { id, scale, source: ROOT + 'geo-lod/{z}-{x}-{y}.png' };
  if (id === 'streamlines') {
    const compressed = await fetchData(ROOT + 'wind.bin', signal, true);
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    const data = new Float32Array(await new Response(stream).arrayBuffer());
    if (data.length !== 8 * 2 * 49 * 19) throw new Error('NOAA wind has an unexpected sample count');
    return {
      id,
      scale,
      source: ROOT + 'wind.bin',
      field: {
        dims: [49, 19, 1],
        bounds: [-1, 1, -1, 1, 0, 0],
        u: data.slice(0, 49 * 19),
        v: data.slice(49 * 19, 2 * 49 * 19),
      },
    };
  }
  if (id === 'volume' || id === 'isosurface') {
    const { loadNRRD, nrrdGrid } = await import('@margoengine/sciviz/nrrd');
    const source = ROOT + 'head.nrrd';
    const grid = nrrdGrid(await loadNRRD(source, { signal }));
    const values = new Float32Array(scale ** 3);
    // Explicit nearest-neighbor resampling is shared by both engines and recorded, not hidden LOD.
    for (let z = 0; z < scale; z++)
      for (let y = 0; y < scale; y++)
        for (let x = 0; x < scale; x++) {
          const i = Math.round((x * (grid.dims[0] - 1)) / (scale - 1));
          const j = Math.round((y * (grid.dims[1] - 1)) / (scale - 1));
          const k = Math.round((z * (grid.dims[2] - 1)) / (scale - 1));
          values[x + scale * (y + scale * z)] =
            (grid.data[i + grid.dims[0] * (j + grid.dims[1] * k)] - grid.range[0]) / (grid.range[1] - grid.range[0]);
        }
    return {
      id,
      scale,
      source,
      sourceDims: grid.dims,
      values,
      resampling: 'shared nearest-neighbor cube',
      range: [0, 1],
    };
  }
  throw new RangeError(`Unknown dataset ${id}`);
}
