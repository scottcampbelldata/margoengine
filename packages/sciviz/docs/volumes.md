# Scientific volumes

Use physical coordinates consistently across sources, clipping and opacity distances.
The optional entries here never alter core or stage. Create the source first, keep it
alive while a wrapper uses it, and dispose wrappers before the source/figure. Wrappers
share scalar data and classification rather than silently resampling a measurement.

## Editing transfer functions

`/transfer` uses physical scalar and gradient units, linear-light RGB and opacity at
a reference voxel distance. A `TransferFunction` snapshots serializable state and
emits `change` after atomic updates. One-dimensional points clamp outside their range;
2D rectangle, triangular tent and Gaussian widgets composite first-in-front.
`transferPreset` supplies ct-lung, ct-bone, ct-soft, mri and pet display starting points,
not tissue identification. Histogram derivatives divide by physical sample spacing;
missing derivative neighbours exclude that sample. Resolution defaults to 256.

```ts
import { Figure } from '@margoengine/sciviz';
import { TransferFunction, bindTransfer, transferHistogram, preintegrateTransfer } from '@margoengine/sciviz/transfer';

using figure = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const data = new Float32Array([0,1,1,0, 1,0,0,1]);
const volume = await figure.volume(data, { dims: [2,2,2], range: [0,1] });
const tf = new TransferFunction({ range: [0,1], gradientMax: 2, points: [
  { value: 0, rgba: [0,0,0,0] }, { value: 1, rgba: [1,0.5,0.2,0.2] },
] });
using binding = bindTransfer(volume, tf, { render: () => figure.engine.render() });
const histogram = await transferHistogram(data, { dims: [2,2,2], range: [0,1] });
const table = await preintegrateTransfer(tf, { resolution: 16, samples: 16 });
console.log(histogram.valid, table);
await figure.ready();
figure.engine.render();
```

`transferEditor(container,tf,options)` owns only its DOM/listeners. Binding updates an
existing volume LUT; binding disposal/abort restores prior custom gradient and
preintegrated tables, including after initialization failure. Restoration errors
are reported, aggregated when necessary. `getClassification()` returns an owned
snapshot. Preintegration defaults to resolution 128, 128 midpoint samples, step 1
reference voxel and density 1; match step/density to the consumer. It integrates a
linear scalar segment, not arbitrary within-segment gradients or changing density.

## Categorical and component fusion

`/labels` provides `fusionVolume` and `labelLegend`. Supply up to four registered
sources; each source's dims/bounds or affine transform defines physical registration.
Labels retain exact IDs with category palettes/outlines, never interpolation between
categories. `setLabels` changes the palette; call legend.update afterwards. RGB/RGBA
scale defaults to 255 for byte arrays and 1 otherwise. RGB opacity defaults to 0.1;
RGBA uses the fourth channel. Component sources have individual functions and weights.

Defaults: optical source/component mixing, quality 1.5, density 1, source/component
weight 1. `over` gives earlier sources priority; `maximum` is a separate maximum rule,
not optical fusion. Creation snapshots arrays; edit inputs by rebuilding the layer.
Texture dimensions and bounded ray steps still apply; registration is not automatic
medical alignment and these display operations are not a segmentation algorithm.

## Lighting and sampling wrappers

```ts
import { Figure } from '@margoengine/sciviz';
import { cinematicVolume } from '@margoengine/sciviz/cinematic';
import { qualityVolume } from '@margoengine/sciviz/volume-quality';

using figure = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const volume = await figure.volume(new Float32Array(27).fill(0.5), { dims: [3,3,3], range: [0,1] });
{
  using cinematic = cinematicVolume(figure, volume);
  await figure.ready();
  figure.engine.render();
  console.log(cinematic.samples, await cinematic.cost());
}
{
  using quality = qualityVolume(figure, volume, { jitter: false });
  await figure.ready();
  figure.engine.render();
  quality.invalidate();
}
```

`/cinematic` adds independent default-off lighting modes around a scalar volume.
Options use Henyey-Greenstein scattering and scene-distance optical transport, not
an arbitrary data-coordinate metric. Progressive accumulation defaults to 4096
samples and seed 1; configure/reset and camera changes restart histories. HG anisotropy
defaults to 0, bounces to 8 and albedo to 0.9. Enabled ambient occlusion defaults to
radius 8 smallest scene voxels, 8 directions and 8 steps; shadows use 32 steps. Ambient
radiance defaults to [0.3,0.3,0.3], light radiance [0.7,0.7,0.7], direction
[0.4,0.6,1]. `cost()` reads exact last-pass scalar samples, shadow/ambient rays,
collisions and dispatched pixels; it is a work count, not elapsed GPU timing.
Saturated frames do no new transport work. Retained depth/count history costs 56
bytes/pixel. Scene depth changes reset per-pixel histories. Dispose restores source
visibility and retains its data; do not stack wrappers over one source concurrently.

`/volume-quality` defaults: emptySpaceSkipping true, blockSize 8 cells, periodic
32x32 void-and-cluster jitter true, adaptive tolerance 0.01/maxStep 4, no isovalue,
12 first-hit bisections. Empty skipping uses conservative scalar/opacity bounds;
adaptive integration is an appearance approximation, not an error bound on physical
radiance. First-hit bisection cannot recover crossings missed by the base sampling.
`invalidate()` rebuilds bounds after externally owned GPU data changes. Wrappers and
cinematic rendering terminate against exact current opaque scene depth, including
opaque geometry inside the volume. Blue-noise generation/provenance and the exact
accepted sampling limits are recorded in `docs/clean-room.md` and `docs/limits.md`.

## Mapped, tetrahedral and AMR fields

`/curvilinear` directly marches structured physical xyz nodes or exact spherical
shells. Values use i/longitude fastest. Spherical axes use increasing radii and
unwrapped radians, longitude at most 2*pi and latitude within +/-pi/2; include both
seam endpoints. Physical referenceStep defaults to the smallest nonzero grid edge.
The hidden `.source` owns shared classifier/density/mode/clips, not a second visible
Cartesian box. `slice(axis,index)` uses logical node indices, including fractional
indices; `outline` defaults to stride 8 and retains all boundary curves. NaNs mask
missing nodes. Folded/singular mappings are outside the inverse-cell model; no
extrapolation or arbitrary-grid accuracy claim is made. Dispose the parent to remove
its sections and source. The NOAA mapped-volume demo records the actual grid units.

`/tetvolume` accepts conforming VTK tetrahedra, snapshots geometry/scalars and builds
opposite-vertex face adjacency. `association:'point'` is barycentric by default;
cell values are constant. `referenceStep` defaults to the smallest edge in physical
units: scale it when scaling units to retain the same opacity. The `.source`
controls classification/clipping; opaque depth terminates rays. Nonconforming,
degenerate or overlapping cells are outside the direct traversal contract. Masks
are retained snapshots. The NASA illustration is explicitly a 2D-data extension,
not an independently measured 3D NASA field.

```ts
import { createAMR, sampleAMR, amrOutlines } from '@margoengine/sciviz/amr';
import { tensorEigen } from '@margoengine/sciviz/tensor';

const hierarchy = createAMR([{ level: 0, dims: [2,2,2], bounds: [0,2,0,2,0,2],
  values: new Float32Array(8).fill(4) }]);
console.log(sampleAMR(hierarchy, [1,1,1]), amrOutlines(hierarchy).levels);
const eigen = tensorEigen([3,2,1,0,0,0]);
console.log(eigen.values, eigen.fa, eigen.residual);
```

`/amr` snapshots cell-centred blocks with physical outer-face bounds. Refined faces
must align to covered coarse cells; masks suppress covered cells and the k-d
partition selects the finest owner. `createAMR` defaults to one million index nodes.
`readAMReX`, `readEnzo`, `readFLASH` retain explicit reader/resource limits.
`amrVolume` marches the hierarchy directly, default linear interpolation and smallest
cell spacing as referenceStep. `sliceAMR` retains exact visible cell values;
`amrLevelOutlines` colours blocks by level. `contourAMR` instead samples a shared
finest-spacing covering lattice, capped by default at two million points. That
contouring allocation is separate from direct volume rendering. Signals cancel
bounded work, with no partial layer publication.

## Tensor and molecular data

`/tensor` uses symmetric xx,yy,zz,xy,xz,yz tuples in a declared common coordinate basis.
`tensorEigen` returns descending algebraic eigenvalues, right-handed column-major
eigenvectors, FA and measured residual. `tensorEigenGPU` owns GPU outputs on a
borrowed compute context. Repeated eigenvalues do not define a unique direction;
residuals and f32 GPU bounds do not imply anatomical correctness. `tensorGlyphs`
supports ellipsoids/superquadrics and FA/direction colour. Tracking supplies Euler
and FACT paths plus hyperstreamlines, with explicit step/length/FA/angle stopping
criteria. Defaults are FACT, Euler step 0.25 smallest voxel spacing, minFA 0.15,
maxAngle 45 degrees, maxLength 1000 per direction, maxSteps 4096, bidirectional true
and maxPoints one million. Hyperstreamlines default to radius half the smallest
spacing, 12 sides and one million triangles. Glyphs default to superquadric,
normalize true, size 0.4 smallest spacing (0.4 for scattered data), gamma 3,
direction-fa colour, stride 1, resolution 16 and opacity 1.
Field coordinates and tensor bases must agree; no registration is guessed.
`fitDiffusionTensor` is ordinary linear least squares on log signals, not weighted,
constrained or nonlinear fitting. Default positive signal floor is 1 input unit;
b-values s/mm^2 give mm^2/s tensors. Negative eigenvalues remain, flagged for callers.
Excluded voxels contain NaNs. CPU results are owned arrays; dispose GPU/glyph owners.

`/molecule` draws analytic sphere/cylinder representations from a parsed structure.
Use the supported PDB/mmCIF loader, then `molecule(figure, structure, options)`;
defaults are ball-and-stick, atomScale 0.3 of van der Waals radius and bondRadius
0.2 angstrom. Space-filling uses full radii; licorice uses equal bond/atom radii.
Picking returns residue/atom identity, not only a primitive number. The layer owns
its snapshot and GPU resources; disposal removes them without disposing the Figure.
Unknown elements use a 2 angstrom van der Waals fallback rather than inferred chemistry.

```ts
import { Figure } from '@margoengine/sciviz';
import { parsePDB } from '@margoengine/loaders/pdb';
import { molecule } from '@margoengine/sciviz/molecule';
import { fusionVolume } from '@margoengine/sciviz/labels';
import { tetrahedralVolume } from '@margoengine/sciviz/tetvolume';
import { curvilinearVolume } from '@margoengine/sciviz/curvilinear';

using figure = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const structure = parsePDB('ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 20.00           C  \n');
using atoms = molecule(figure, structure);
using labels = fusionVolume(figure, [{ kind: 'labels', dims: [2,2,2],
  data: new Uint32Array(8).fill(1), labels: [{ id: 1, name: 'region', rgba: [1,0,0,0.1] }] }]);
using tetra = tetrahedralVolume(figure, { points: [0,0,0, 1,0,0, 0,1,0, 0,0,1],
  connectivity: [0,1,2,3], offsets: [4], types: [10], pointData: [0,1,1,1] }, { range: [0,1] });
using shell = curvilinearVolume(figure, { radius: [1,2], longitude: [0,0.5],
  latitude: [0,0.5] }, new Float32Array(8).fill(0.5), { range: [0,1] });
await figure.ready();
figure.engine.render();
console.log(atoms.residues, tetra.cellCount, shell.bounds, labels.labels());
```

## Globe atmosphere and fallback

`/atmosphere` creates a WGS84 globe with sky-owned Hillaire transport. Longitude and
latitude are degrees, heights metres above the ellipsoid, winds east/north/up m/s,
and flow time seconds. Solar date is UTC (default 2024-01-01T12:00:00Z) and does not
advance measurement time. Defaults: neutral globe at zoom 2, illuminance 20, exposure
0, 100 km atmosphere. `setDate`, `flow`, `mesh`, `points` and `clouds` retain these
units; points default to radius 10000 metres and clouds require supplied density
shell triangles. No procedural weather or multiple-scattering cloud model is implied.
Disposal owns tiles/data/sky resources. The NOAA globe demo records approximations.

```ts
import { Figure } from '@margoengine/sciviz';
import { globeAtmosphere, globeSunDirection } from '@margoengine/sciviz/atmosphere';

using figure = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!, { axes: false });
using globe = await globeAtmosphere(figure, { date: new Date('2024-01-01T12:00:00Z') });
globe.setDate(new Date('2024-06-01T12:00:00Z'));
console.log(globeSunDirection(globe.date));
await figure.ready();
figure.engine.render();
```

```ts
import { createFallbackFigure } from '@margoengine/sciviz/fallback';

using figure = await createFallbackFigure(document.querySelector<HTMLCanvasElement>('canvas')!, {
  compat: await import('@margoengine/webgl2-compat'),
});
await figure.scatter({ x: [0,1], y: [0,1], z: [0,1] });
await figure.ready();
figure.engine.render();
```

`createFallbackFigure` explicitly installs the caller-supplied compatibility layer
page-wide, forced even if native WebGPU exists. It requires full tier and rejects
unsupported hardware. CPU marching cubes uses the same cases as GPU extraction,
loading its Wasm lazily; abort/dispose preserves normal ownership and restoration.
Dispose figures before uninstalling the shared layer. The real-data demos support
`?backend=webgl2`. Importing `/fallback` alone installs nothing. This full compatibility
route is distinct from the limited native `/webgl2` drawing entry in the main README.

## Projection modes

`fig.volume(data, { mode })` and `brickedVolume` take `'composite'` (default), `'mip'` (maximum intensity) or
`'minip'` (minimum intensity, the projection used to show airways in CT; Wallis et al., Radiology 181(1), 1991).
MinIP colours each ray by the transfer function at the smallest finite sample and takes its opacity from the transfer
function alone; MIP also keeps the value as opacity, as before. Mapped, curvilinear, tetrahedral, AMR and quality
volumes follow their source volume's mode. `tests/volume-modes-browser.mjs` checks MinIP and MIP against the exact
grey of a hidden block on both backends, `tests/minip-kinds-browser.mjs` does the same for AMR (low region in a
refined level), curvilinear, tetrahedral and quality volumes, and `tests/bricks-browser.js` checks bricked MinIP
against the whole volume.

```ts
import { Figure } from '@margoengine/sciviz';

const fig = await Figure.create(document.querySelector('canvas')!);
const n = 24, data = new Float32Array(n * n * n).fill(0.8);
for (let z = 6; z < 18; z++) for (let y = 6; y < 18; y++) for (let x = 6; x < 18; x++) data[(z * n + y) * n + x] = 0.2;
const volume = fig.volume(data, { dims: [n, n, n], colormap: 'gray', range: [0, 1], opacity: [[0, 1], [1, 1]], mode: 'minip' });
volume.mode = 'mip'; // switch at any time
```

## Several volumes and multi-component data

`@margoengine/sciviz/multivolume` ray marches up to four scalar channels in one pass over the union of their boxes.
Each channel keeps its own grid, bounds, colour map, range and opacity; where boxes overlap, the samples of one step
mix as independent absorbers (opacity `1 - prod(1 - a_i)`, colour `sum(a_i c_i) / sum(a_i)`, after Cai and Sakas,
Computer Graphics Forum 18(3), 1999) and the steps composite front to back. `componentChannels(data, k, dims)` splits
interleaved k-component tuples into channels sharing one box. Defaults: grey map, the channel's finite min and max,
opacity `t * t`, density 1, quality 1.5 samples per finest voxel. `tests/multivolume-browser.mjs` checks the mixed
grey, a half-box channel and the component split against closed forms on both backends.

```ts
import { Figure } from '@margoengine/sciviz';
import { multiVolume, componentChannels } from '@margoengine/sciviz/multivolume';

const fig = await Figure.create(document.querySelector('canvas')!);
const n = 8, dims: [number, number, number] = [n, n, n];
const ct = new Float32Array(n * n * n).map((_, i) => (i % n) / (n - 1));
const pet = new Float32Array(n * n * n).fill(1);
const fused = multiVolume(fig, [
  { data: ct, dims, bounds: [0, 1, 0, 1, 0, 1], colormap: 'gray' },
  { data: pet, dims, bounds: [0, 0.5, 0, 1, 0, 1], colormap: 'inferno', range: [0, 2] },
]);
const rg = new Float32Array(n * n * n * 2).map((_, i) => (i % 2 ? 0.8 : 0.2));
const components = multiVolume(fig, componentChannels(rg, 2, dims, [{ colormap: 'viridis' }, { colormap: 'magma' }]));
console.log(fused.bounds, components.bounds);
```

