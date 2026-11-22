// Owner/lifetime fixture for @margoengine/sciviz. A Figure is what an app attaches to an engine: its SciRenderer plugin,
// the axes and labels (lines, text), every layer it was given (GPU buffers, textures, pipelines on the device), the
// colour bars, legend and timeline, and the interaction listeners it puts on the canvas. `figure.dispose()` frees all of
// them, so each entry builds a figure, adds the layers of one family, waits for the figure to settle and returns the
// renderer as the registration. Families:
// - Figure 3D: scatter, line, colour bar, quiver, streamlines and the axes (the points, lines and labels plugins).
// - Figure 2D: bar, histogram, heatmap and the timeline (the chart layers and their DOM panels), and densityScatter.
// - surface, volume, isosurface, multiVolume, cinematicVolume, qualityVolume, amrVolume, meshLayer, graphLayer, glyphLayer.
// - Still to add: imageVolume, molecule, the tetrahedral and curvilinear volumes, flowParticles, lic, pointcloud, the
//   parallel-coordinates plot, the labels fusion layer, GPU picking and the geo layers (they need data or a tile source).
// - attachAccessibility is not an entry: it reads the page's canvas (layout, focus, parent), which the CPU leaf's canvas is
//   not, and the leaves are planned from the CPU leaf's entries; tests/a11y.test.js runs it on jsdom and
//   tests/a11y-browser.mjs on a page.
// Not entries: progressiveRendering (its :begin and :present passes bracket a frame by swapping `context.view` and putting it
// back, which the harness's per-pass `preserves view state` check cannot express; tests/progressive*.test.js and
// progressive-browser.mjs cover it), the readers and writers (formats, netcdf, hdf5, vtk, cgns, xdmf, exodus, openfoam, ensight, nrrd, fits,
// mrc, ometiff, omezarr, cf, table, pointcloud decoders, pdf and the export functions), the pure maths and data modules
// (maths, math, calc, stats, scales, colormaps, projections, probe, query, categorical data, pipeline, derive, transfer,
// bench, monitor sweeps), and the network or worker readers (geo tile fetches, stream, workers). They hold no engine or
// GPU resource, or only what the layer that uses them holds, which an entry above covers; tests/entries-browser.js and
// the per-feature *-browser.mjs checks draw them on a real device.
const bounds = [0, 1, 0, 1, 0, 1];
const ramp = (n) => Float32Array.from({ length: n }, (_, i) => i / Math.max(1, n - 1));
const grid = (nx, ny) =>
  Float32Array.from({ length: nx * ny }, (_, i) => Math.sin((i % nx) / 2) * Math.cos(Math.floor(i / nx) / 2));
const cube = (n) => Float32Array.from({ length: n ** 3 }, (_, i) => Math.sin(i / 7) * 0.5 + 0.5);
const field = (n) => ({
  u: Float32Array.from({ length: n * n }, (_, i) => Math.cos(i / 3)),
  v: Float32Array.from({ length: n * n }, (_, i) => Math.sin(i / 3)),
  dims: [n, n],
});

export const leafCases = 26;

export async function fixtures(load = (entry) => import(entry)) {
  const { Figure } = await load('../dist/index.js');
  const { multiVolume } = await load('../dist/multivolume.js');
  const { cinematicVolume } = await load('../dist/cinematic.js');
  const { qualityVolume } = await load('../dist/volume-quality.js');
  const { meshLayer } = await load('../dist/grids.js');
  const { graphLayer } = await load('../dist/graph.js');
  const { densityScatter } = await load('../dist/density.js');
  const { amrVolume, createAMR } = await load('../dist/amr.js');
  const { glyphLayer } = await load('../dist/glyph.js');
  // The figure's panels (colour bar, legend, timeline, labels) mount DOM: the page's own in a browser, jsdom's in Node
  // (its window lent to the globals the figure reads, for the entry's life). The figure is attached before the first
  // await, inside the owner's scope, so what it adds later is made in that scene too.
  const name = 'jsdom';
  const JSDOM = globalThis.document?.body ? undefined : (await import(name)).JSDOM;
  const lend = [
    'window',
    'document',
    'getComputedStyle',
    'HTMLElement',
    'HTMLCanvasElement',
    'Element',
    'Node',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ];
  const figure = (title, options, build) => ({
    name: title,
    detachedNodes:
      'the timeline, colour bar and legend panels take their own elements out of the page, with the listeners on them',
    create({ engine }) {
      const dom = JSDOM && new JSDOM('<main></main>', { pretendToBeVisual: true });
      const view = dom ? dom.window : window;
      const lent = [];
      if (dom) {
        for (const key of lend) {
          if (key in globalThis || view[key] === undefined) continue;
          globalThis[key] =
            key === 'window'
              ? view
              : typeof view[key] === 'function' && !/^[A-Z]/.test(key)
                ? view[key].bind(view)
                : view[key];
          lent.push(key);
        }
        if (!('reportError' in globalThis)) {
          globalThis.reportError = (error) => console.error(error);
          lent.push('reportError');
        }
        engine.canvas.ownerDocument = view.document;
      }
      const fig = Figure.attach(engine, options);
      return (async () => {
        await build(fig);
        await fig.ready();
        return {
          plugin: fig.renderer,
          dispose: () => fig.dispose(),
          cleanup() {
            for (const key of lent) delete globalThis[key];
            dom?.window.close();
          },
        };
      })();
    },
  });
  const points = (n) => ({ x: ramp(n), y: ramp(n).map((v) => v * v), z: ramp(n) });
  return [
    figure('Figure.3d', { mode: '3d' }, async (fig) => {
      await fig.scatter({ ...points(64), color: ramp(64) }, { name: 'dots' });
      await fig.line({ x: ramp(32), y: ramp(32), z: ramp(32) }, { name: 'curve' });
      fig.colorbar('viridis', [0, 1]);
    }),
    figure('Figure.3d.vectors', { mode: '3d' }, async (fig) => {
      await fig.quiver({ x: [0, 1], y: [0, 1], z: [0, 1], u: [1, 0], v: [0, 1], w: [0, 0] });
      await fig.streamlines(field(8));
    }),
    figure('Figure.2d', { mode: '2d', axes: false, margin: { left: 0, right: 0, top: 0, bottom: 0 } }, async (fig) => {
      await fig.bar({ x: [1, 2, 3], y: [3, 1, 2] });
      await fig.histogram(grid(8, 8));
      await fig.heatmap(grid(8, 8), { nx: 8 });
      fig.timeline([0, 1, 2], () => {});
    }),
    figure('surface', { mode: '3d' }, async (fig) => {
      fig.surface(grid(16, 16), { nx: 16 });
    }),
    figure('volume', { mode: '3d' }, async (fig) => {
      fig.volume(cube(8), { dims: [8, 8, 8], bounds });
    }),
    figure('isosurface', { mode: '3d' }, async (fig) => {
      await fig.isosurface(cube(8), 0.5, { dims: [8, 8, 8], bounds });
    }),
    figure('multiVolume', { mode: '3d' }, async (fig) => {
      multiVolume(fig, [
        { data: cube(8), dims: [8, 8, 8], colormap: 'gray' },
        { data: cube(6), dims: [6, 6, 6], bounds: [0, 7, 0, 7, 0, 7], colormap: 'inferno' },
      ]);
    }),
    figure('cinematicVolume', { mode: '3d' }, async (fig) => {
      cinematicVolume(fig, fig.volume(cube(8), { dims: [8, 8, 8], bounds }), { shadows: { steps: 8 } });
    }),
    figure('qualityVolume', { mode: '3d' }, async (fig) => {
      qualityVolume(fig, fig.volume(cube(8), { dims: [8, 8, 8], bounds }), { blockSize: 4 });
    }),
    figure('meshLayer', { mode: '3d' }, async (fig) => {
      meshLayer(fig, {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        values: new Float32Array([0, 0.5, 1]),
        cells: new Uint32Array([0]),
        bounds: [0, 1, 0, 1, 0, 0],
      });
    }),
    figure(
      'densityScatter',
      { mode: '2d', axes: false, margin: { left: 0, right: 0, top: 0, bottom: 0 } },
      async (fig) => {
        densityScatter(fig, new Float32Array(Array.from({ length: 32 }, (_, i) => [i / 31, (i * i) / 961, 0]).flat()));
      },
    ),
    figure('amrVolume', { mode: '3d' }, async (fig) => {
      amrVolume(
        fig,
        createAMR([
          { level: 0, dims: [4, 4, 4], bounds, values: cube(4) },
          { level: 1, dims: [4, 4, 4], bounds: [0, 0.5, 0, 0.5, 0, 0.5], values: cube(4) },
        ]),
      );
    }),
    figure('glyphLayer', { mode: '3d' }, async (fig) => {
      await glyphLayer(
        fig,
        {
          points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 2, 0],
          pointArrays: { v: [1, 0, 0, 0, 2, 0, -1, 0, 0, 0, 0, 0], s: [2, 3, 4, 0] },
        },
        { shape: 'cone', vectors: 'v' },
      );
    }),
    figure('graphLayer', { mode: '3d' }, async (fig) => {
      graphLayer(
        fig,
        { nodes: 4, edges: [0, 1, 1, 2, 2, 3, 3, 0] },
        new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      );
    }),
  ];
}
