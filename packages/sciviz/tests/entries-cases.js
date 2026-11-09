// The drawing cases of entries-browser.js, one per entry feature. Each places the camera, adds its layer and returns
// the facts it checked.
import { gridLayer, sliceGrid, CELL_TYPES } from '@margoengine/sciviz/grids';
import { ForceLayout, graphLayer } from '@margoengine/sciviz/graph';
import { tileLayer } from '@margoengine/sciviz/geo';
import { tracePathline } from '@margoengine/sciviz/flow';

/** The cases entries-browser.js runs, in order. */
export const cases = [];
const addCase = (name, run, mode = '3d') => cases.push({ name, run, mode });

addCase('flow-pathline', async (figure, { assert }) => {
  figure.engine.stop();
  const frames = [0, 1].map((time) => ({
    time, u: new Float32Array(4).fill(2 * time), v: new Float32Array(4).fill(1),
  }));
  const path = await tracePathline({ dims: [2, 2, 1], bounds: [-1, 2, -1, 2, 0, 0], frames },
    [0, 0, 0], { from: 0, to: 1, step: 1 / 32 });
  assert(path.stop === 'end' && path.samples.length === 33 * 4, 'browser Wasm load and complete path');
  const x = [], y = [];
  for (let i = 0; i < path.samples.length; i += 4) {
    const t = path.samples[i + 3];
    assert(Math.abs(path.samples[i] - t * t) < 1e-12 && Math.abs(path.samples[i + 1] - t) < 1e-12,
      'every browser pathline sample matches the physical-time analytic trajectory');
    x.push(path.samples[i]);
    y.push(path.samples[i + 1]);
  }
  figure.setLimits([-0.2, 1.2, -0.2, 1.2]);
  await figure.line({ x, y }, { width: 6, color: '#ffffff' });
  return { checked: 'feature-local Wasm fetch, all analytic xyzt samples, GPU line and device replacement' };
}, '2d');

for (const kind of ['scatter', 'quiver', 'streamlines', 'histogram']) {
  addCase(
    `replace-${kind}`,
    async (figure, { pixels, lit, assert }) => {
      figure.engine.stop?.();
      figure.setLimits([0, 4, 0, 4]);
      const x = [],
        y = [];
      for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) x.push(0.5 + i / 10), y.push(0.5 + j / 10);
      const make = (offset) => {
        const shifted = x.map((v) => v + offset);
        const style = { color: '#ffffff', name: `Frame ${offset}` };
        if (kind === 'scatter') return figure.scatter({ x: shifted, y }, { ...style, size: 10 });
        if (kind === 'quiver')
          return figure.quiver(
            { x: shifted, y, u: x.map(() => 1), v: x.map(() => 0) },
            { ...style, scale: 0.3, width: 3 },
          );
        if (kind === 'histogram') return figure.histogram(shifted, { ...style, bins: 4, density: true });
        return figure.streamlines(
          { u: [1, 1, 1, 1], v: [0, 0, 0, 0], dims: [2, 2], bounds: [0, 4, 0, 4] },
          {
            ...style,
            width: 3,
            seeds: y.slice(0, 10).map((v, i) => [0.5 + offset, v + i / 5, 0]),
            maxSteps: 12,
            step: 0.03,
            direction: 'forward',
          },
        );
      };
      let trace = await make(0);
      const timeline = figure.timeline(
        [0, 1, 2],
        async (index) => {
          // Data preparation can span rendered frames. The previous trace stays drawn throughout.
          assert(lit(await pixels()) > 500, `${kind}: old trace vanished while preparing data`);
          await new Promise(requestAnimationFrame);
          const old = trace;
          trace = figure.replace(trace, await make(index));
          assert(
            figure.layers.length === 1 && figure.layers[0] === trace && !figure.layers.includes(old),
            `${kind}: duplicate or stale trace`,
          );
          assert(lit(await pixels()) > 500, `${kind}: replacement is empty`);
        },
        { controls: false },
      );
      await Promise.all([timeline.seek(1), timeline.seek(2)]);
      assert(timeline.index === 2 && trace.name === 'Frame 2', 'latest seek committed');
      assert(figure.replace(trace, trace) === trace, 'self replacement is a no-op');
      let refused = false;
      try {
        figure.replace({}, trace);
      } catch (error) {
        refused = error instanceof TypeError;
      }
      assert(refused && figure.layers.length === 1, 'foreign layer rejected without mutation');
      const svg = await figure.toSVG();
      assert(svg.includes('<svg'), 'replacement exports');
      const image = await pixels();
      const plugin = [...figure.engine.plugins.values()].find(
        (p) => p.name === (kind === 'scatter' ? 'points' : 'lines'),
      );
      if (kind === 'scatter') assert(plugin.pointClouds.size === 1, 'only the replacement cloud is registered');
      else if (kind !== 'histogram') assert(plugin.lines.size === 1, 'only the replacement line is registered');
      figure.remove(trace);
      assert(lit(await pixels()) === 0, 'removing the replacement leaves no stale drawn layers');
      trace = await make(2);
      const reference = await pixels();
      assert(
        image.data.every((v, i) => v === reference.data[i]),
        'replacement matches the same data drawn alone',
      );
      return { lit: lit(image), layers: figure.layers.length };
    },
    '2d',
  );
}

// The figure puts data x along scene x, data y along scene -z and data z up, so a flat (z = 0) layer is seen from
// above: TOP looks down with data y up the screen.
const TOP = [
  [0, 2.8, 0],
  [0, 0, -1],
];
function look(figure, position = [1.9, 1.3, 2.1], up = [0, 1, 0]) {
  figure.engine.stop?.();
  figure.engine.camera.position = position;
  figure.engine.camera.target = [0, 0, 0];
  figure.engine.camera.up = up;
}

// n x n x n unit hexahedra with point data x + y + z, as in tests/grids.test.js.
function block(n) {
  const points = [],
    id = (i, j, k) => (k * (n + 1) + j) * (n + 1) + i;
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) points.push(i, j, k);
  const connectivity = [],
    offsets = [],
    types = [];
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        connectivity.push(id(i, j, k), id(i + 1, j, k), id(i + 1, j + 1, k), id(i, j + 1, k));
        connectivity.push(id(i, j, k + 1), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i, j + 1, k + 1));
        offsets.push(connectivity.length);
        types.push(CELL_TYPES.hexahedron);
      }
  const pointData = [];
  for (let p = 0; p < points.length; p += 3) pointData.push(points[p] + points[p + 1] + points[p + 2]);
  return { points, connectivity, offsets, types, pointData };
}

addCase('grid-surface', async (figure, { pixels, lit, assert }) => {
  look(figure);
  const layer = gridLayer(figure, block(4), { colormap: 'aurora' });
  await figure.ready();
  const image = await pixels(),
    count = lit(image);
  assert(layer.triangles === 6 * 16 * 2, `surface has ${layer.triangles} triangles`);
  assert(count > 5000, `the grid surface lit ${count} pixels`);
  return { triangles: layer.triangles, lit: count };
});

addCase('grid-slice', async (figure, { pixels, lit, assert }) => {
  look(figure);
  const layer = gridLayer(figure, block(4), { slice: { normal: [1, 1, 1], offset: 6 }, colormap: 'aurora' });
  await figure.ready();
  const image = await pixels(),
    count = lit(image);
  assert(layer.triangles > 0, 'the slice cut no cells');
  assert(count > 2000, `the slice lit ${count} pixels`);
  const updated = sliceGrid(block(4), { normal: [1, 1, 1], offset: 5 });
  layer.update(updated);
  const moved = await pixels();
  assert(
    image.data.some((v, i) => v !== moved.data[i]),
    'updated mesh differs from its initial data before restore',
  );
  return { triangles: layer.triangles, lit: count };
});

// A ring of 120 nodes with chords, laid out for 150 steps; edges as lines and nodes as discs.
function ringGraph(nodes) {
  const edges = [];
  for (let i = 0; i < nodes; i++) edges.push(i, (i + 1) % nodes);
  for (let i = 0; i < nodes; i += 15) edges.push(i, (i + nodes / 2) % nodes);
  return { nodes, edges };
}

for (const dimensions of [2, 3])
  addCase(`graph-${dimensions}d`, async (figure, { pixels, lit, assert }) => {
    if (dimensions === 2) look(figure, ...TOP);
    else look(figure);
    const graph = ringGraph(120),
      layout = new ForceLayout(graph, { dimensions, seed: 3 });
    for (let i = 0; i < 150; i++) layout.step();
    assert(layout.positions.every(Number.isFinite), 'the layout gave a position that is not finite');
    // Colour by index so no node takes a colour map end that could match the background.
    const values = Array.from({ length: graph.nodes }, (_, i) => i),
      layer = graphLayer(figure, graph, layout.positions, {
        nodeSize: 6,
        values,
        range: [-20, 140],
        colormap: 'aurora',
      });
    await figure.ready();
    const image = await pixels(),
      count = lit(image);
    assert(layer.edges === graph.edges.length / 2, `the layer holds ${layer.edges} edges`);
    // 120 discs of 6 pixels across cover about 120 x 28 = 3,400 pixels; at least half must show past overlaps.
    assert(count > 1700, `the graph lit ${count} pixels`);
    layer.setPositions(layout.positions.map((v) => v * 0.8));
    const moved = await pixels();
    assert(
      image.data.some((v, i) => v !== moved.data[i]),
      'updated graph positions differ before restore',
    );
    return { edges: layer.edges, lit: count };
  });

// The nine Terrarium PNG tiles of the terrain fixtures, reused as the 16 tiles of zoom 2, so the whole map lights.
const FIXTURES = '/packages/terrain/test/fixtures/terrarium-10/';
const fixtureTile = async (z, x, y, signal) => {
  const response = await fetch(`${FIXTURES}${164 + (x % 3)}-${359 + (y % 3)}.png`, { signal });
  return response.blob();
};

// The map's area on screen in pixels: the convex hull of its outline (the plane) or of points all over it (the
// globe, whose silhouette is convex) projected by the figure's data-to-clip transform.
function mapArea(figure, map, image) {
  const m = figure.engine.camera.matrix,
    d = figure.model,
    at = (p) => {
      const s = [0, 1, 2].map((r) => d[r] * p[0] + d[4 + r] * p[1] + d[8 + r] * p[2] + d[12 + r]);
      const c = [0, 1, 2, 3].map((r) => m[r] * s[0] + m[4 + r] * s[1] + m[8 + r] * s[2] + m[12 + r]);
      return [((c[0] / c[3] + 1) / 2) * image.width, ((1 - c[1] / c[3]) / 2) * image.height];
    };
  const points = [];
  if (map.projection === 'globe')
    for (let lat = -90; lat <= 90; lat += 3)
      for (let lon = -180; lon < 180; lon += 3) points.push(at(map.project(lon, lat)));
  else
    for (const [lon, lat] of [
      [-180, -85.0511],
      [180, -85.0511],
      [180, 85.0511],
      [-180, 85.0511],
    ])
      points.push(at(map.project(lon, lat)));
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]),
    hull = [];
  for (const pass of [points, [...points].reverse()]) {
    const start = hull.length;
    for (const p of pass) {
      while (hull.length >= start + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
  }
  const width = image.width,
    height = image.height;
  if (!hull.every(([x, y]) => x >= 0 && x <= width && y >= 0 && y <= height))
    throw new Error(`the ${map.projection} map runs off the ${width} x ${height} canvas`);
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i],
      [x1, y1] = hull[(i + 1) % hull.length];
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2;
}

for (const projection of ['mercator', 'globe'])
  addCase(`geo-${projection}`, async (figure, { pixels, lit, assert }) => {
    if (projection === 'globe') look(figure, [1.6, 0.9, 2.2]);
    else look(figure, ...TOP);
    const map = await tileLayer(figure, { tiles: fixtureTile, projection, zoom: 2, attribution: 'Test tiles' });
    assert(map.loaded === 16 && map.missing === 0, `loaded ${map.loaded}, missing ${map.missing}`);
    // A URL template whose tile does not exist counts it as missing rather than failing.
    if (projection === 'mercator') {
      (window.expectedMissing ??= []).push(`${FIXTURES}0-0.png`);
      const none = await tileLayer(figure, { tiles: `${FIXTURES}{x}-{y}.png`, zoom: 0 });
      assert(none.loaded === 0 && none.missing === 1, `404 tile: loaded ${none.loaded}, missing ${none.missing}`);
      figure.remove(none);
    }
    await figure.ready();
    const image = await pixels(),
      count = lit(image),
      area = mapArea(figure, map, image);
    // Every pixel the map covers differs from the background (Terrarium tiles are mid red and green); its edge
    // pixels are partly covered, so at least 90 % of the projected area, and nothing outside it plus its rim.
    assert(area > 5000, `the ${projection} map covers only ${area} pixels on screen`);
    assert(count >= 0.9 * area && count <= area * 1.05 + 400, `the ${projection} map lit ${count} pixels of ${area}`);
    return { tiles: map.loaded, lit: count, area: Math.round(area) };
  });
