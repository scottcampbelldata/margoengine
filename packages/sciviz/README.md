# @margoengine/sciviz

Install `npm i margoengine` and import `margoengine/sciviz` (or this package alone: `npm i @margoengine/sciviz`,
imported as `@margoengine/sciviz`; the two are the same module).

Scientific visualisation for Margo Engine, WebGPU:

- **Volume rendering:** transfer functions, gradient lighting, clip planes, slices, and isosurfaces extracted by
  marching cubes on the GPU.
- **Scatter plots:** millions of points with level of detail.
- **Surface and line plots:** with axes, nice-number ticks, labels and colour bars.
- **Colour maps:** perceptual maps computed from their published definitions.

Layers read `@margoengine/compute` GPU arrays in place, so data computed on the GPU is drawn without a trip to the
CPU. The package is optional and tree-shakable, and adds nothing to core. The points, lines, labels, controls and
compute packages load with `import()` only when a figure uses them.

```ts
import { Figure } from '@margoengine/sciviz';

const canvas = document.querySelector('canvas')!;
const fig = await Figure.create(canvas); // engine, camera, orbit controls and dark theme, running
const n = 100_000;
const x = Float32Array.from({ length: n }, () => Math.random() * 10);
const y = Float32Array.from({ length: n }, () => Math.random() * 10);
const z = x.map((v, i) => Math.sin(v) * Math.cos(y[i]));
await fig.scatter({ x, y, z, color: z }, { colormap: 'coolwarm' });
fig.colorbar('coolwarm', [-1, 1], { label: 'sin x cos y' });
```

## Figures

`Figure.create(canvas, options)` sets up everything with zero configuration:

- a WebGPU engine on the canvas;
- the theme's background;
- a camera framing the plot box;
- orbit controls (drag to orbit, scroll to zoom, right-drag to pan).

`Figure.attach(engine)` adds a figure to an engine you already have. Axes and tick labels load and draw in the
background; `await fig.ready()` waits for them and rejects if they failed. A figure maps data units into a box, with data
z pointing up. The box spans the union of its layers' bounds, or fixed `limits`. Axes draw the box outline, grid
lines at the ticks and HTML tick labels.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `'3d'` | `'3d'` box you orbit, or `'2d'` chart (see 2D charts) |
| `margin` | see 2D charts | space around a 2D chart's plot area, in CSS px |
| `theme` | `'dark'` | `'dark'` or `'light'` chrome and background |
| `axes` | `true` | box, grid and tick labels |
| `titles` | `{ x: 'x', y: 'y', z: 'z' }` | axis titles |
| `ticks` | `5` | about how many ticks per axis |
| `grid` | `true` | grid lines on the floor and back walls |
| `aspect` | `[1, 1, 0.75]` | relative size of the plot box |
| `limits` | data bounds | fixed `[xmin, xmax, ymin, ymax, zmin, zmax]` (`[xmin, xmax, ymin, ymax]` in 2D) |
| `pointBudget` | `2_000_000` | most scatter points drawn per frame |
| `scale` | linear | `{ x, y, z }`: `'linear'`, `'log'` or `'date'` per axis |
| `legend` | shown for 2+ named layers | `false`, `true`, or a corner such as `'top-left'` |
| `tooltips` | `true` | hover tooltips; `false`, or `(hit) => string \| null` for your own text |
| `controls` (create only) | `true` | orbit controls (3D) |

## Layers

| Call | Draws |
| --- | --- |
| `await fig.scatter({ x, y, z?, color?, size? }, { colormap, range, size, edl, shape })` | point cloud with level of detail; `color` values go through the colour map |
| `await fig.line({ x, y, z?, color? }, { width, colormap })` | fat line with round joins |
| `fig.surface(z, { nx, ny, x, y, colormap, range, contours, grid, opacity })` | height field coloured by height, contour lines, NaN holes |
| `fig.volume(data, { dims, bounds, colormap, range, opacity, density, mode, quality, shading, clip })` | ray-marched volume; `mode: 'mip'` for maximum intensity |
| `volume.slice('x' \| 'y' \| 'z', position)` | a plane through the volume, coloured by its map |
| `await fig.isosurface(data, level, { dims, bounds, color })` | GPU marching cubes; `layer.update(level)` re-extracts |
| `fig.colorbar(colormap, range, { label, ticks })` | HTML colour bar at the canvas edge |

Data may be TypedArrays, plain arrays, or `GpuArray`s from `@margoengine/compute`. Make GPU arrays on the
figure's engine with `createCompute({ engine: fig.engine })`. A surface, volume or isosurface reads a GPU array on
the GPU; give such layers a `range`, since their min and max are not read back for you.

```ts
import { Figure } from '@margoengine/sciviz';
import { createCompute } from '@margoengine/compute';

const canvas = document.querySelector('canvas')!;
const fig = await Figure.create(canvas, { titles: { x: 'x (mm)', y: 'y (mm)', z: 'z (mm)' } });
const gpu = await createCompute({ engine: fig.engine });
const N = 96;
const i = gpu.arange(0, N ** 3, 1, 'f32');
const r = i.mod(N).sub(N / 2).hypot(i.floorDiv(N).mod(N).sub(N / 2)).hypot(i.floorDiv(N * N).sub(N / 2));
const field = r.mul(-1 / 12).exp().eval().reshape(N, N, N); // computed on the GPU, never read back
const volume = fig.volume(field, { range: [0, 1], colormap: 'ember', opacity: [[0, 0], [0.3, 0.05], [1, 0.9]] });
volume.slice('z', 0.5);
volume.clip = [{ normal: [-1, 0, 0], offset: 0.5 }]; // cut away x > half
const shell = await fig.isosurface(field, 0.5, { color: '#9cc9ff' });
console.log(shell.triangles);
```

```ts
import { Figure } from '@margoengine/sciviz';

const canvas = document.querySelector('canvas')!;
const fig = await Figure.create(canvas, { aspect: [1, 1, 0.4] });
const nx = 200,
  ny = 150;
const heights = new Float32Array(nx * ny);
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = Math.sin(i / 15) * Math.cos(j / 12);
fig.surface(heights, { nx, x: [0, 20], y: [0, 15], colormap: 'aurora', contours: 12 });
fig.colorbar('aurora', [-1, 1], { label: 'height' });
await fig.line({ x: [0, 10, 20], y: [0, 15, 0], z: [1.2, 1.2, 1.2] }, { width: 3, color: '#ffd885' });
```

## 2D charts

`Figure.create(canvas, { mode: '2d' })` makes a chart: a flat plot area inside `margin` (default top 16, right 24,
bottom 48, left 64 CSS px; right 96 once there is a colour bar), axes with tick labels on the left and bottom, and
data fitted with 4% padding. Drag to pan, scroll to zoom about the pointer, double-click to reset. `fig.setLimits([x0,
x1, y0, y1])` sets the window in code, and `fig.setLimits()` goes back to the data. Drawing is clipped to the plot area.

| Call | Draws |
| --- | --- |
| `await fig.line({ x, y })`, `await fig.scatter({ x, y })` | as in 3D, flat |
| `await fig.bar({ x, y, color? }, { width, base, color, colormap, range, name })` | bars from `base` (0) to y, 0.8 of the smallest x gap wide |
| `await fig.histogram(values, { bins, range, density, color, name })` | equal bins; `bins: 'auto'` (default) uses Freedman-Diaconis, Sturges when the spread is 0 |
| `await fig.heatmap(z, { nx, ny, x, y, colormap, range, name })` | a grid of cells; `x` and `y` are the first and last cells' centres; NaN cells are empty |

Surfaces, volumes and isosurfaces need a 3D figure. `histogram(values, options)` from `@margoengine/sciviz/maths`
gives the bins without drawing. `fig.render()` draws a frame now, for example before reading the canvas.

```ts
import { Figure } from '@margoengine/sciviz';

const canvas = document.querySelector('canvas')!;
const chart = await Figure.create(canvas, { mode: '2d', titles: { x: 'Month', y: 'Sales' } });
await chart.bar({ x: [1, 2, 3, 4, 5, 6], y: [12, 18, 9, 22, 30, 26] }, { color: '#6aa9ff', name: 'Sales' });
await chart.line({ x: [1, 2, 3, 4, 5, 6], y: [10, 14, 15, 19, 24, 28] }, { color: '#ffd885', name: 'Trend' });

const samples = Float64Array.from({ length: 10_000 }, () => Math.random() + Math.random() + Math.random());
const histogramChart = await Figure.create(document.createElement('canvas'), { mode: '2d' });
const bins = await histogramChart.histogram(samples, { density: true });
console.log(bins.values.length, bins.rects.slice(0, 4));

const heat = await Figure.create(document.createElement('canvas'), { mode: '2d' });
const z = Float32Array.from({ length: 64 * 48 }, (_, k) => Math.sin((k % 64) / 8) * Math.cos(Math.floor(k / 64) / 6));
await heat.heatmap(z, { nx: 64, colormap: 'coolwarm' });
heat.colorbar('coolwarm', [-1, 1]);
```

## Log and date axes, legends

`scale: { x, y, z }` maps an axis `'linear'` (default), `'log'` (base 10) or `'date'`:

- **Log.** Ticks at decades, with 2 and 5 between them over short ranges. Values at or below 0 are not drawn. Bars
  start at 1 instead of 0. Histogram bins are equal ratios.
- **Date.** Values are milliseconds since 1970, as from `Date.now()` or `date.getTime()`. Ticks fall on whole UTC
  seconds, minutes, hours, days, weeks, months or years, and tooltips show UTC dates.

Picks, tooltips and selections report data values. Surfaces, volumes and isosurfaces need linear axes.
`axisScale(type)`, `logTicks` and `dateTicks` from `@margoengine/sciviz/maths` give the same mappings and ticks.

Series without colour data or a `color` take the next colour of the Okabe-Ito palette, which stays distinct under
colour vision deficiency. Once two layers have a `name`, a legend lists them in the plot's top-right corner. The
`legend` option picks another corner, `true` shows it for a single named layer and `false` hides it. Exports include
it.

```ts
import { Figure } from '@margoengine/sciviz';

const canvas = document.querySelector('canvas')!;
const chart = await Figure.create(canvas, { mode: '2d', scale: { x: 'date', y: 'log' }, titles: { y: 'Requests' } });
const start = Date.UTC(2026, 9, 1);
const days = Array.from({ length: 30 }, (_, i) => start + i * 86_400_000);
await chart.line({ x: days, y: days.map((_, i) => 10 * 1.25 ** i) }, { name: 'api' });
await chart.line({ x: days, y: days.map((_, i) => 40 * 1.1 ** i) }, { name: 'web' });
console.log(chart.legend?.element.textContent); // 'apiweb'
```

## Vector fields

`await fig.quiver({ x, y, z?, u, v, w? }, options)` draws an arrow at each point along its vector, coloured by
speed. By default the longest arrow is 6% of the data's extent; `scale` sets the arrow length per unit of vector
length instead, and `head` sets the head size as a fraction of the arrow (default 0.3).

`await fig.streamlines({ u, v, w?, dims, bounds? }, options)` traces a gridded field (x fastest) with fourth-order
Runge-Kutta steps of even length on trilinearly interpolated velocities, coloured by speed:

- `seeds`: points `[x, y, z]`, or a count per axis on an even grid (default 8 in 2D, 4 in 3D);
- `step`: step length (default a fifth of the grid spacing);
- `maxSteps`: steps each way (default 2000);
- `direction`: `'forward'`, `'backward'` or `'both'` (default).

A line stops at the grid's edge, where the flow stops, or at a NaN sample. Both layers also take `colormap`, `range`,
`color`, `width` and `name`, and need linear axes. `streamline`, `sampleField` and `arrowSegments` from
`@margoengine/sciviz/maths` do the same work without drawing.

```ts
import { Figure } from '@margoengine/sciviz';

const canvas = document.querySelector('canvas')!;
const fig = await Figure.create(canvas, { mode: '2d' });
const n = 32,
  u = new Float32Array(n * n),
  v = new Float32Array(n * n);
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) - 0.5,
      y = j / (n - 1) - 0.5;
    u[j * n + i] = -y + 0.3 * x; // a spiral
    v[j * n + i] = x + 0.3 * y;
  }
await fig.streamlines({ u, v, dims: [n, n], bounds: [-0.5, 0.5, -0.5, 0.5] }, { colormap: 'viridis' });
const x: number[] = [],
  y: number[] = [];
for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) x.push(i / 7 - 0.5), y.push(j / 7 - 0.5);
await fig.quiver({ x, y, u: x.map((xi, k) => -y[k] + 0.3 * xi), v: x.map((xi, k) => xi + 0.3 * y[k]) }, { color: '#ffffff' });
```

## Picking, tooltips and selection

Hovering shows a tooltip for the scatter point, line vertex, surface point, bar or heatmap cell under the pointer, with its x, y, z, its
`color` value and the layer's `name`. Each change sends a `hover` event. `fig.pick(x, y, { radius })` returns the same
hit for any canvas position, in CSS pixels from the canvas's top-left (`event.offsetX`, `event.offsetY`). Points and
vertices within `radius` (default 8 px) come before surfaces. Surfaces that read a GpuArray are not picked, since their
heights stay on the GPU.

Set `fig.dragMode` to `'box'` or `'lasso'` to select with a left-button drag; `'orbit'` (the default) gives the drag
back to the camera. When a drag ends, the figure stores the result in `fig.selection` and sends a `selection` event with
the indices of the points inside the region, per scatter and line layer. `fig.select(region)` does the same in code.
`fig.controls` are the orbit controls `Figure.create` attached (undefined with `controls: false`); listen for their
`change` event to follow the camera.

```ts
import { Figure } from '@margoengine/sciviz';

const canvas = document.querySelector('canvas')!;
const fig = await Figure.create(canvas);
const x = Float32Array.from({ length: 5000 }, () => Math.random());
const y = x.map((v) => v * v + Math.random() * 0.1);
await fig.scatter({ x, y, color: y }, { name: 'samples' });
fig.addEventListener('hover', (event) => {
  if (event.detail) console.log(event.detail.index, event.detail.x, event.detail.y);
});
fig.dragMode = 'lasso';
fig.addEventListener('selection', (event) => {
  for (const { layer, indices } of event.detail.points) console.log(layer.name, indices.length);
});
const left = fig.select({ rect: [0, 0, canvas.clientWidth / 2, canvas.clientHeight] });
console.log(left.points[0].indices.length);
```

## Export

`await fig.toPNG()` returns a PNG `Blob` at the canvas's resolution: a fresh frame with the tick labels, titles and
colour bars painted over it (`{ overlays: false }` leaves them out). `await fig.toSVG()` returns SVG text in CSS
pixels. A 2D chart whose layers are bars, histograms, heatmaps, lines and scatters of up to 50,000 points is written
as vector shapes throughout. Any other figure is a fresh frame embedded as a PNG, with the text and colour bars as
vector elements over it; `{ vector: false }` forces that for a chart too.

```ts
import { Figure } from '@margoengine/sciviz';

const canvas = document.querySelector('canvas')!;
const chart = await Figure.create(canvas, { mode: '2d', titles: { x: 'Day', y: 'Visits' } });
await chart.bar({ x: [1, 2, 3, 4, 5], y: [120, 98, 143, 160, 151] });
const png = await chart.toPNG();
const svg = await chart.toSVG();
const link = document.createElement('a');
link.href = URL.createObjectURL(png);
link.download = 'visits.png';
console.log(png.size, svg.length);
```

## Colour maps

Margo's own maps are computed from their published definitions:

- `cubehelix`: Green 2011;
- `coolwarm`: Moreland's Msh diverging map, 2009;
- `aurora` (the default), `ember`, `glacier` and `gray`: lightness rising linearly through OKLab (Ottosson 2020);
- `phase`: cyclic, constant lightness.

The standard maps people already know are the authors' published tables, recorded as data:

- `viridis`, `magma`, `inferno` and `plasma`: Smith and van der Walt (CC0);
- `cividis`: Nuñez, Anderton and Renslow, PLOS ONE 2018 (CC BY 4.0), made for red-green colour vision deficiency.

`colormap(['#000004', '#b63679', '#fcfdbf'])` builds a map from your own stops, interpolated in OKLab.
`map.table(n, { linear })` gives RGBA floats for your own shaders, and `map.css()` a gradient string.

```ts
import { colormap, colormapNames } from '@margoengine/sciviz';
import { ticks } from '@margoengine/sciviz/maths';

const map = colormap('cubehelix');
console.log(colormapNames, map.sample(0.5), map.reversed().css(8));
console.log(ticks(0, 97).labels); // ['0', '20', '40', '60', '80']
```

## How it works

- **Data frame.** A figure maps data (x, y, z) to scene (x, z, -y), scaled so the data bounds fill the box.
  Scatter and line layers take this as their model matrix; sciviz's own layers take it as a uniform.
- **Surfaces.** The vertex shader builds the grid from the vertex index, reads heights from a storage buffer and
  takes normals from central differences. The fragment shader colours by height and draws contours with
  screen-space widths (`fwidth`).
- **Volumes.** Data goes into a normalised half-float 3D texture; a GPU array is packed and copied on the GPU.
  Rays are marched front to back from a jittered start, with opacity corrected for the step length, gradient
  lighting and early termination. With the camera outside the box, front faces are tested against scene depth;
  inside it, back faces are drawn. Opaque geometry inside the box does not cut rays short.
- **Isosurfaces.** Each cell is classified, the triangle counts are scanned (`@margoengine/compute`), and every
  cell writes its triangles at its offset, with normals from the field's gradient. The vertices are drawn from the
  GPU buffer; only the triangle total is read back. The case table is derived from the cube's geometry with one
  face-consistent rule, so surfaces are closed (the Node tests check every case and random fields).
- **Picking.** Points and vertices are projected with the last frame's camera, and the nearest within the radius
  wins (the one nearer the eye on a tie). For surfaces, the pointer's ray is stepped across the grid at half a cell
  and bisected to where it crosses the bilinear surface. Box and lasso selections test projected points (even-odd rule
  for the lasso). All of this runs on the CPU and is exported from `@margoengine/sciviz/maths`.
- **Errors.** Argument errors throw `TypeError` or `RangeError` naming the fix; every message links to
  [margoengine.com/errors](https://margoengine.com/errors#sciviz).
