# Analysis and scientific datasets

The optional entries below operate on physical data coordinates. Arrays named
`pointArrays` and `cellArrays` are flat interleaved tuples; their widths follow the
associated count. Empty array names select the default scalar. Inputs stay borrowed
until asynchronous work settles; returned arrays are owned unless stated otherwise.
Pass `signal` for exact-reason cooperative cancellation. Synchronous validation and
individual cell solves cannot be preempted. These entries create no device on import.

## Demand-driven pipelines

`/pipeline` exports `FilterPipeline`. Add sources before consumers. A registry owns
implementations, with optional imports inside `execute`; serialized `run` requests
compute only requested ancestors and cache successful outputs. `setParams` replaces
the full finite JSON value, while `invalidate` marks external changes. Both dirty
descendants and cancel affected demands. `time` defaults to zero; only operators
marked `timeDependent` and their descendants rerun for changed time.

```ts
import { FilterPipeline } from '@margoengine/sciviz/pipeline';

const registry = {
  source: { kind: 'source' as const, execute: () => [2, 4, 8] },
  sum: { kind: 'filter' as const, execute: ({ inputs }: { inputs: readonly unknown[] }) =>
    (inputs[0] as number[]).reduce((a, b) => a + b, 0) },
};
using graph = new FilterPipeline(registry);
graph.add({ id: 'samples', type: 'source' });
graph.add({ id: 'total', type: 'sum', inputs: ['samples'] });
console.log(await graph.run<number>('total', { signal: AbortSignal.timeout(30000) }));
using restored = FilterPipeline.fromJSON(graph.toJSON(), registry);
console.log(await restored.run<number>('total'));
```

JSON contains operator names, connections and parameters, never closures or code.
Restore with a trusted application registry. Outputs are borrowed until invalidation;
`release` frees only operator-owned resources, consumers before dependencies, and must
be synchronous/nonthrowing. Disposal aborts queued work and releases cached outputs,
leaving external figures/devices alive. Topology is append-only; restore edited JSON
to rewire. [Pipeline/filter contracts and NASA FUN3D evidence](../../../docs/sciviz-analysis.md)
include the source licence and exactly what the demonstration measures.

## Datasets, cuts, contours and probes

`/datasets` normalizes structured, rectilinear, polydata, unstructured, multiblock and
partitioned inputs into the filter contract. Singleton structured dimensions are valid.
Composite boundaries are not welded; only common compatible arrays survive flattening,
and block/source-cell IDs retain provenance. Higher-order elements use deterministic
parametric subdivision (default 2, maximum 64), not exact curved-cell integration.
Polyhedron faces use the global-ID outward face stream `nfaces,npoints,ids,...`.
`openDataSet` reads supported VTK dataset families; `parsePLOT3D` reads the documented
structured PLOT3D forms. File and expansion budgets reject oversized data before
publishing a partial dataset; increasing subdivisions increases both cells and memory.

```ts
import { createDataSet } from '@margoengine/sciviz/datasets';
import { clipGrid, thresholdGrid } from '@margoengine/sciviz/clip';
import { contourGrid } from '@margoengine/sciviz/contour';
import { CellLocator, plotOverLine, integrateGrid } from '@margoengine/sciviz/probe';
import { calcGrid } from '@margoengine/sciviz/calc';
import { prepareGlyphs, warpByVector } from '@margoengine/sciviz/glyph';

const signal = AbortSignal.timeout(30000);
const grid = await createDataSet({
  kind: 'unstructured', points: [0,0,0, 1,0,0, 0,1,0, 0,0,1],
  cells: [{ type: 10, ids: [0,1,2,3] }], pointData: [0,1,1,1],
  pointArrays: { velocity: [1,0,0, 1,0,0, 1,0,0, 1,0,0] },
}, { signal });
const cut = await clipGrid(grid, { kind: 'plane', normal: [1,0,0], offset: -0.2 }, { signal });
const selected = await thresholdGrid(grid, [0,1], { mode: 'all', signal });
const contours = await contourGrid(grid, [0.5], { signal });
using locator = await CellLocator.create(grid, { signal });
const profile = await plotOverLine(locator, [0,0,0, 0.5,0,0], { samples: 11, signal });
const integral = await integrateGrid(grid, { signal });
const gradient = await calcGrid(grid, { kind: 'gradient' }, { name: 'gradient', signal });
const glyphs = await prepareGlyphs(grid, { vectors: 'velocity', stride: 1, signal });
const warped = await warpByVector(grid, 'velocity', { scaleFactor: 0.1, signal });
console.log(cut.sourceCells, selected.types, contours.floatBound, profile.distance,
  integral.volume.measure, gradient.width, glyphs.ids, warped.points);
```

`/contour` supports multi-level isosurfaces and surface isolines; line/vertex cells
produce points. CPU `contourGrid` and `contourGridGPU(compute,...)` share f32 snapshots,
global-ID pulling tetrahedra and level order. Hex fields are pulling-linear here,
not trilinear. Inputs must be convex with planar faces. Limits: one million points,
256 levels, ten million output vertices; finite nonzero f32 magnitudes 1e-18..1e18.
`floatBound` bounds arithmetic CPU/GPU coordinate differences on that snapshot, not
measurement error or discretization. `contourOperator(compute?)` accepts `{levels}`.

`/clip` supports planes, boxes, sampled spheres and scalar halfspaces; positive is
retained, `invert:false`, `crinkle:false`. Crinkle keeps whole cells. Spheres are
vertex-sampled implicit fields and can miss a sphere wholly inside a coarse cell;
boxes apply six exact halfspaces. `isoVolume` cuts an inclusive scalar interval.
`thresholdGrid` keeps whole cells (`association:'point'`, `mode:'all'`; cell/any and
inversion are explicit). All tuples and `sourceCells` survive. `extractSubset` uses
inclusive logical ranges and positive strides, default full extent/unit strides;
strided cell tuples come from the lower source cell, not an average. `imageGrid`
materializes regular/curvilinear images with at least two active dimensions.

`/probe` owns locator snapshots; rebuild after input edits. Barycentric simplex and
pulling-linear mixed cells differ deliberately from true trilinear hex interpolation.
Outside points return null, shared boundaries choose lowest current cell ID. Profiles
default to 101 equal arc-length samples with masks/NaNs outside; `resampleDataset` and
`resampleToImage` retain masks and separate sampled cell arrays. Integrals separate
length, area and volume; nonfolded trilinear hexes use 3x3x3 Gaussian quadrature.
Ill-conditioned/folded geometry is outside the model; reference-coordinate epsilon
envelopes are arithmetic allowances, not extrapolation distances. `linkProbePlot`
owns chart/path/marker layers and supports `moveTo(index)`; it borrows two figures
and the immutable profile. `probeOperator` exposes probe/line/integrate/image/resample.

## Calculator and glyph contracts

`/calc` exports CPU/GPU `calcGrid`/`calcGridGPU` and `calcOperator`. Expression grammar
is inert arithmetic over coordinates and named tuples, not JavaScript evaluation.
Supported operations include expression, gradient, pointToCell, cellToPoint, centers,
connectivity, elevation and quality. Defaults: point expression association, unnamed
result, elevation range [0,1]. Results own f32 values and per-value `floatBound`, while
`result.grid` borrows original topology/arrays. Gradient is least-squares on the local
neighbourhood; transfers use equal incidence weights; centers are vertex averages.
Connectivity joins through any shared point. Quality explicitly means edge aspect,
corner skew and corner Jacobian, not an unqualified mesh-validity certificate.
The [analysis contract](../../../docs/sciviz-analysis.md) specifies every grammar
function, forward-error bound and conditioning limit with the NASA calculator demo.

`/glyph` selects point/cell tuples, then stride and mask, retaining original IDs.
Defaults: arrow, point association, no orientation/scalar array, scaleMode 'none',
scaleFactor 1, stride 1, cyan roughness 0.65. Six sources are arrow, cone, sphere,
cube, line and borrowed custom Geometry. Built-ins orient +X along vectors; zero
vectors keep +X, zero scale omits samples, signed scales reflect. `glyphLayer` owns
its meshes and built-in geometry, never a caller custom geometry or Figure.
`warpByVector` adds scaleFactor times xyz; `warpByScalar` uses supplied normals,
surface normals or direction [0,0,1], without normalization. Warped topology/attributes
remain borrowed; coordinate arrays are new. No inverted-cell repair or tensor
transport is implied. `glyphOperator` and `warpOperator` adapt these to the pipeline.
The NOAA/SEACAS glyph demo labels the exaggerated displacement explicitly.

## Scientific file readers

Openers accept their declared URL/byte/FileSource forms and preserve explicit format
limits. Keep immutable sources alive for lazy reads. Abort/dispose closes the reader
lifetime; read options can cancel one request. Do not reinterpret stored coordinates
as a Cartesian volume without checking physical axes.

| Entry | Selection and supported model | Boundaries |
|---|---|---|
| `/hdf5` | `openHDF5`, lazy datasets and hyperslabs | Supported object/chunk/filter forms only; unknown filters reject, no arbitrary plugin execution |
| `/cgns`, `/xdmf` | Resource/base/zone or grid and solution selection over supported HDF5/XML forms | Explicit external-resource resolution and physical topology; no guessed mesh merging |
| `/exodus` | Mesh, time/result variables and entity sets | Select solution time explicitly; format metadata is not a simulation |
| `/openfoam`, `/ensight` | Mesh/field/patch and part/time loading | Supported ASCII/binary forms only; preserve parts and declared byte order |
| `/fits` | Images/cubes, binary table cells, scaling and WCS | Exact supported numeric types; nonlinear/oriented WCS remains a world transform, not axis-aligned volume data |
| `/mrc` | Cell geometry, complex modes, packed mode 101 | Mode 101 is low-nibble-first with ceil(nx/2) bytes per row; truncated padded payloads reject |
| `/ometiff` | Series/ZCT and multifile plane selection | Explicit resources and supported compression/sample types; no invented missing planes |

FITS/MRC/OME-TIFF grid bounds follow storage order, including descending axes.
Rotation, shear, permutation and nonuniform grids reject in Cartesian helpers;
resample physically before drawing. `world()` remains available independently.
See [physical-grid and packed-row corrections](../../../docs/sciviz-review-fixes.md)
and the engineering/astronomy demos and their asset manifests for supported concrete
files. The NetCDF/VTK and derived-field examples in the main README remain runnable;
their numerical bounds exclude discretization and measurement uncertainty.

```ts
import { readFileSync } from 'node:fs';
import { readCGNS } from '@margoengine/sciviz/cgns';
import { readExodus } from '@margoengine/sciviz/exodus';
import { readFITS } from '@margoengine/sciviz/fits';
import { readMRC } from '@margoengine/sciviz/mrc';
import { readOMETIFF } from '@margoengine/sciviz/ometiff';

const signal = AbortSignal.timeout(30000);
const cgns = await readCGNS(readFileSync('packages/sciviz/tests/fixtures/engineering/nasa-struct-hdf.cgns'), { signal });
const exodus = await readExodus(readFileSync('packages/sciviz/tests/fixtures/engineering/exodus-classic.exo'), { timeIndex: 1, signal });
const fits = await readFITS(readFileSync('packages/sciviz/tests/fixtures/astronomy/owner.fits'), { signal });
const mrc = await readMRC(readFileSync('packages/sciviz/tests/fixtures/astronomy/owner-float32.mrc'), { signal });
const ome = await readOMETIFF(readFileSync('packages/sciviz/tests/fixtures/astronomy/owner-False-deflate.ome.tiff'), { signal });
console.log(cgns.types.length, exodus.times, fits.hdus.length, mrc.data.length, await ome.plane(0,0,0));
```

Run this Node example from the repository root. These fixtures include owner-writer
outputs and pinned real files. Browser applications can pass immutable URL sources
instead of these bytes. Defaults are all CGNS bases/zones with first solution, first
Exodus/EnSight/XDMF time step, OME series 0 and primary FITS WCS. EnSight binary is
little endian by default; companion-resource resolution is explicit through files,
resolve or baseURL. The common FileOptions read/decoded bound is 64 MiB by default.
