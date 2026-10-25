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
| `theme` | `'dark'` | `'dark'` or `'light'` chrome and background |
| `axes` | `true` | box, grid and tick labels |
| `titles` | `{ x: 'x', y: 'y', z: 'z' }` | axis titles |
| `ticks` | `5` | about how many ticks per axis |
| `grid` | `true` | grid lines on the floor and back walls |
| `aspect` | `[1, 1, 0.75]` | relative size of the plot box |
| `limits` | data bounds | fixed `[xmin, xmax, ymin, ymax, zmin, zmax]` |
| `pointBudget` | `2_000_000` | most scatter points drawn per frame |
| `controls` (create only) | `true` | orbit controls |

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
- **Errors.** Argument errors throw `TypeError` or `RangeError` naming the fix; every message links to
  [margoengine.com/errors](https://margoengine.com/errors#sciviz).
