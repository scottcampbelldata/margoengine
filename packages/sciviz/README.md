# @margoengine/sciviz

Real-data examples: [MRI head volume](../../examples/sciviz-head.html) (OpenNeuro, CC0),
[Star catalogue](../../examples/sciviz-stars.html) (one million public-domain 2MASS sources in observed sky position
and colour space, selection linked to a histogram), and [Wind field](../../examples/sciviz-wind.html)
(eight NOAA daily fields, streamlines and arrows replaced through `Figure.replace`) and
[Moving wind](../../examples/sciviz-moving-flow.html) (GPU particles/trails through the same NOAA daily means).
[Data preparation and licences](../../examples/assets/sciviz/README.md) record the exact reductions and limitations.
Run them from the repository root with `npm run dev:examples` after building packages and pulling Git LFS assets.

## Optional workflows

Import only the entry you need. Every `@margoengine/sciviz/<entry>` below also has a
`margoengine/sciviz/<entry>` forwarding entry; neither the figure root nor core/stage
loads these features for you. Install matching private-repository builds as described
in the root installation guide, rather than the unrelated registry package.

- [Analysis and scientific datasets](docs/analysis.md): pipeline, contour, clip, probe,
  calculator, glyphs, normalized datasets and scientific file readers.
- [Scientific volumes](docs/volumes.md): transfer functions, MIP and MinIP, multi-volume and multi-component
  mixing (`/multivolume`), categorical fusion,
  cinematic and quality wrappers, mapped/tetrahedral/AMR volumes and atmosphere.
- [Charts and linked data](docs/charts.md): selections, tables, queries, statistics,
  formatting, streaming and publication.
- [Large data and geography](docs/large-data.md): cloud volumes, point clouds,
  aggregation, density, graph layout, time series, climate and map layers.
- [State and application integration](docs/applications.md): portable state,
  provenance, sharing, notebooks, accessibility, layouts, monitoring and workers.

Works with the [scientific dashboard composition](../../docs/integration-sciviz.md):
optional entries share a Figure, compute device, selection and publication lifecycle.
The record gives the exact reproduction command and measured integration scope.

## Contributor checks

From the repository root run `npm run test --workspace @margoengine/sciviz` for CPU
contracts and `npm run check:readme-run -- --packages=sciviz` for the examples here
and in the package guides. Browser workspace commands use `scripts/browser-root.mjs`
to establish the repository root; keep that launcher when invoking fallback, table,
engineering and pointcloud suites. For example,
`npm run test:browser:table --workspace @margoengine/sciviz`.
Each browser suite declares its backend coverage. Full compatibility requires the
full WebGL2 tier, not merely a WebGL2 context. Readiness checks use cinematic sample
counts, progressive refinement state and submitted GPU work, rather than sleeps.
CPU-load sampling starts after setup. Timing results remain deferred during the
build phase and these correctness checks make no speed claim.

## Climate and solver files

`@margoengine/sciviz/netcdf` opens CDF-1 classic and CDF-2 64-bit-offset files without eagerly decoding variables.
All six external types, fixed and interleaved record variables, UTF-8 text attributes, strided hyperslabs and the sole-record
padding exception are supported. `read()` returns owned float64 samples, last dimension fastest. By default it
maps `_FillValue`, `missing_value` and invalid packed values to NaN before applying CF `scale_factor` and
`add_offset`; `unpack: false` returns external numeric values (char values are byte codes). Selection `start`,
`count` and `stride` default to the whole variable. `volume()` reverses the selected non-singleton dimensions
into x,y,z. Give physical bounds explicitly; the default is sample-index bounds, with singleton axes one unit wide.

```ts
import { Figure } from '@margoengine/sciviz';
import { openNetCDF } from '@margoengine/sciviz/netcdf';

using file = await openNetCDF(new URL('/examples/assets/sciviz/wind-classic.nc', location.href));
const grid = await file.variables.uwnd.volume({ bounds: [0, 4, 0, 4, 0, 7] });
using fig = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!);
await fig.volume(grid.data, { dims: grid.dims, bounds: grid.bounds, range: [-11, 7] });
await fig.ready();
```

`@margoengine/sciviz/vtk` adapts the existing `@margoengine/loaders/vtk-xml` reader, retaining topology and every
numeric point/cell array lazily. `.vtu`, `.vti` and `.vts` support ASCII, inline binary and raw/base64 appended
arrays, both byte orders, UInt32/64 headers and the owner's zlib, LZ4 and LZMA decoders. `dataset.pieces` exposes
metadata and individually readable arrays, including components not selected for drawing. `grid(name)` returns
the selected piece's unstructured volume cells or structured hexahedra; `volume(name)` returns ImageData,
including nonzero extents and descending axes. Options default to `piece: 0`, `association: 'point'`,
`component: 0`. Pieces remain separate, including overlapping/ghost boundaries. `parseVtk` is the existing
legacy unstructured reader extended through 5.1, ASCII and big-endian binary, with OFFSETS/CONNECTIVITY,
metadata and attached FIELD scalar arrays. Its existing scalar-first-component and supported-cell policy remains.

```ts
import { Figure } from '@margoengine/sciviz';
import { openVTK } from '@margoengine/sciviz/vtk';
import { gridLayer } from '@margoengine/sciviz/grids';

using file = await openVTK(new URL('/examples/assets/sciviz/wind.vtu', location.href));
const grid = await file.grid('uwnd');
using fig = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!);
gridLayer(fig, grid, { range: [-11, 7], colormap: 'viridis' });
await fig.ready();
```

Both openers accept URL/string, bytes (snapshotted), or a `FileSource` with async `read(offset, length, signal)`.
The source must remain immutable. HTTP Range is used for NetCDF hyperslabs and raw appended VTK arrays.
Inline/base64 VTK needs its bounded file in memory. Servers ignoring Range are accepted only when their whole
response fits `maxBytes`. The default 64 MiB bounds headers, single reads, decoded arrays and selections, not the
remote file's total size. `signal` cancels the file lifetime; per-read `signal` cancels that read. `dispose()` and
`Symbol.dispose` abort pending/future reads and are idempotent. Nothing loads on import beyond this entry's code.

NetCDF-4/HDF5 is explicitly unsupported by `/netcdf`: object headers, B-trees, chunk indexes
and filter semantics belong to the optional `/hdf5` engineering readers. Convert to classic with the format owner's
tools. CDF-5, non-UTF-8 text metadata and indeterminate streaming record counts also reject. CF coordinate systems/calendars are retained
as metadata, not guessed or reprojected. StructuredGrid drawing needs three non-singleton axes; oriented
ImageData needs resampling before an axis-aligned volume. Other raw VTK cell types remain accessible but must
match the existing grid renderer's supported types to draw. Integers outside exact JavaScript number precision
reject. No HDF5, resampling, calendar or general VTK-renderer parity claim is made.

The [NOAA wind files example](../../examples/sciviz-formats.html) compares all six writer-produced variants.
Its third axis is daily time, never physical height. Hashes and writer versions are pinned in
[formats.json](../../examples/assets/sciviz/formats.json). Tests cover analytical layouts plus exact cross-format
agreement of all 200 NOAA samples. No speed claim or Rust/Wasm gain is asserted.

Import `margoengine/sciviz` from the `margoengine` package, or `@margoengine/sciviz` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Scientific visualisation for Margo Engine, WebGPU:

- **Volume rendering:** transfer functions, gradient lighting, clip planes, slices, and isosurfaces extracted by
  marching cubes on the GPU.
- **Scatter plots:** millions of points with level of detail.
- **Surface and line plots:** with axes, nice-number ticks, labels and colour bars.
- **Colour maps:** perceptual maps computed from their published definitions.

Layers read `@margoengine/compute` GPU arrays in place, so data computed on the GPU is drawn without a trip to the
CPU. The package is optional and tree-shakable, and adds nothing to core. The points, lines, labels, controls and
compute packages load with `import()` only when a figure uses them.


## Derived flow fields (optional /derive)

Import `@margoengine/sciviz/derive` (or `margoengine/sciviz/derive`) for the velocity gradient,
divergence, curl, vorticity magnitude, Q rotation dominance and lambda-2 on a regular Cartesian grid.
No import of this entry occurs through the root. CPU and GPU compute the same second-order stencils;
GPU scalar arrays feed the existing volume and isosurface layers directly on the same device.
[North Atlantic wind derivatives](../../examples/sciviz-derive.html) shows the hash-pinned NOAA daily
winds with an explicit planar approximation, without inventing vertical measurements.

```ts
import { Figure } from '@margoengine/sciviz';
import { deriveFlow, deriveFlowGPU } from '@margoengine/sciviz/derive';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
using fig = await Figure.create(canvas, { axes: false, controls: false });
const dims = [9, 9, 9] as const;
const u = new Float32Array(9 ** 3), v = new Float32Array(u.length);
for (let z = 0; z < 9; z++) for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
  const a = (x - 4) / 4, b = (y - 4) / 4, amplitude = Math.exp(-2 * (a * a + b * b));
  const i = (z * 9 + y) * 9 + x;
  u[i] = -b * amplitude; v[i] = a * amplitude;
}
const grid = { dims, bounds: [-1, 1, -1, 1, -1, 1] as const, u, v };
const signal = AbortSignal.timeout(30000);
const cpu = await deriveFlow(grid, { signal }); // Owned f32 arrays, float64 arithmetic.
const gpu = await fig.renderer.compute(); // Figure owns this context; do not dispose it yourself.
using fields = await deriveFlowGPU(gpu, grid, { signal });
fig.volume(fields.vorticity, { bounds: [...grid.bounds], range: [0, 2], opacity: [[0, 0], [1, 0.15]] });
await fig.isosurface(fields.lambda2, -0.12, { bounds: [...grid.bounds], color: '#ffb640', signal });
await fig.ready(); fig.engine.render();
console.log(cpu.gradient.length, cpu.q.length); // 6561, 729.
```

Input: `{ dims:[nx,ny,nz], bounds:[x0,x1,y0,y1,z0,z1], u,v,w?,mask? }`, x fastest.
Every dimension is at least one; descending bounds work. A singleton axis needs equal bounds and
has derivative zero (constant extension). `w` defaults to zero; `mask` defaults to all valid, zero
means missing, every other finite value valid. NaN in any velocity component also marks missing.
Inputs are copied, rounded to float32 and never mutated; keep them stable until the call settles.
Only option: `signal`, default absent, with exact-reason cancellation during copying/CPU work/readback.
There are no fetches, callback APIs, device creation or retained resources on import.

The gradient is nine row-major values per point, `J[3*i+j]=du_i/dx_j`. Curl is xyz per point,
not angular velocity (which is half the curl). Divergence is trace(J), magnitude is the norm of curl.
Let S=(J+J^T)/2 and Omega=(J-J^T)/2. `q` is (||Omega||_F^2-||S||_F^2)/2, including for
nonzero divergence; the general second invariant differs by divergence^2/2. `lambda2` is the middle
real eigenvalue of S^2+Omega^2, computed with scaled largest-pivot Jacobi rotations. A negative
lambda-2 or positive Q is a local indicator under the incompressible model, without a pressure
condition, global coherence, compressible-flow validity or a universal vortex threshold.

Interior derivatives use (next-prev)/(2h). Endpoints use second-order one-sided stencils,
2*(next-current)/h - (nextNext-current)/(2h), with reversed direction at the far end. A two-point
axis uses its first-order secant. A missing centre or any required stencil neighbour makes all six
outputs at that point NaN: no interpolation, bridging or lower-order fallback across missing samples.
Units are velocity/distance for gradient/divergence/curl/magnitude and its square for Q/lambda-2.
These are Cartesian derivatives; convert spherical or curvilinear fields before calling.

CPU results are independent Float32Arrays with no disposal needed. GPU scalar shapes are [nz,ny,nx],
gradient [...,3,3], curl [...,3]. Each is contiguous with offset zero. GPU results support `dispose()`
and `using`; disposal is idempotent and does not dispose the caller context. Keep fields alive until
consumers finish; remove GPU-sourced layers and derive them again after device replacement. CPU
sources can also feed volume/isosurface with explicit dims/bounds. A nonconverged GPU solve rejects
with coded `failed`, releasing all partial resources, rather than publishing incorrect eigenvalues.
Volume/isosurface consumers require at least two samples per axis and ascending bounds. Reorder
descending-axis scalar samples before drawing them in those consumers; planar results feed a heatmap.

Float32 domain: at most 1000000 points, finite representable velocities (NaN missing), active inverse
spacing finite normal f32, and D=8*max(maxAbsVelocity,2^-126)*maxAbsInverseSpacing <=1e18. Rescale units outside
this conservative overflow envelope. Each call returns `floatBound`, an absolute CPU/GPU difference
bound on the rounded snapshot: e=2^-23, t=2^-126, I=maxAbsInverseSpacing,
L=32eD+32t*max(1,I); gradient <=L, divergence/curl <=4L, magnitude <=8L,
Q <=256eD^2+128t and lambda-2 <=1024eD^2+128t. These include flush-to-zero and the checked Jacobi
residual (GPU 1e-6 of scaled tensor max element; at most 48 rotations), not finite-difference
truncation or measurement uncertainty. A sign within its absolute bound is unresolved. GPU needs
eight storage bindings and 36 bytes per point within each buffer limit; total temporary plus output
storage is 84 bytes/point, excluding readback/driver overhead. CPU work yields every 8192 points.
Both native WebGPU and the WebGL2 compute route are supported; neither changes core/stage.


## Line integral convolution

`@margoengine/sciviz/lic` creates a dense GPU LIC image from a regular 2D vector field or a planar slice
through a 3D field. Noise and image resolution are independent of the input grid. Bidirectional midpoint
streamline integration convolves deterministic bilinear noise, renormalizing at boundaries and missing data.
The GPU retains the image between changes; orbiting the camera does not regenerate it. WebGPU and the real
WebGL2 compatibility backend work; the native `sciviz/webgl2` driver does not yet support this entry.

```ts
import { Figure } from '@margoengine/sciviz';
import { lic } from '@margoengine/sciviz/lic';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
using fig = await Figure.create(canvas, { axes: false, controls: false });
const layer = await lic(fig, {
  dims: [2, 2, 1], bounds: [-2, 2, -1, 1, 0, 0],
  u: new Float32Array([1, 1, 1, 1]), v: new Float32Array([0, 0, 0, 0]),
}, { seed: 171, animated: true, resolution: [128, 64] });
layer.setPhase(1); // Radians, explicit: drawing never advances the animation.
await fig.ready();
fig.engine.render();
const luminance = await layer.readIntensity({ signal: AbortSignal.timeout(30000) });
console.log(luminance.length); // 8192, x fastest; NaN marks missing texels.
```

Options and defaults: `resolution: [256,256]` (each dimension 8..2048), `steps: 20` (1..128 each way),
`step: 0.5` (0.1..1 image texels), `seed: 0` (uint32), `contrast: 3` (0..10 about luminance 0.5),
`coloured: true`, `colormap: 'aurora'`, `opacity: 1` (0..1), `animated: false`, `phase: 0` radians and no `signal`.
`scalar` defaults to the magnitude of the interpolated full vector, with `range` spanning finite node speeds;
provide one scalar per field node to colour another quantity. `range` defaults to its finite extent, expanded
by max(1, abs(value)*1e-6) for a constant field, or [0,1] for an entirely missing field. The image luminance and
scalar colour multiply in linear light. Static grayscale LIC is orientation-free; animation uses a Hann window
with three phase-shifted ripples over its support to show direction. Phase is a visual cue, not physical time.

`slice: { origin, axisU, axisV }` describes a parallelogram in field data units. Default: the full x/y plane at
the lowest z. Its edges may be oblique or non-orthogonal; the inverse Gram matrix projects the interpolated
3D velocity into slice coordinates. Only tangential motion is convolved; the default colour still gives full
3D speed. Outside-field and weighted NaN nodes mask texels rather than bridging holes; zero flow retains noise.
This entry does not claim arbitrary triangle-surface LIC, volume LIC, or physical unsteady texture advection.

Inputs are copied before the promise resolves and retained for exact device restoration. Field copying has a
128 MiB working budget; the image uses 16 bytes per texel (at most 64 MiB), further bounded by device limits.
Samples must be finite within +/-1e30 or NaN. After common velocity scaling, each nonzero node must have a
component of magnitude at least 8*2^-126 (headroom for eight trilinear weights without relying on subnormals);
split fields with a larger dynamic range. Local rescaling after interpolation preserves tangents across
24 orders of magnitude, without a nonzero speed cutoff. Slice coordinates/mapping ratios are within +/-1e15 and
sin(angle)^2 between edges must exceed 1e-8; use local coordinates for extreme scales. `dispose()` and `using`
free the image and field; the figure also owns the layer. `readIntensity` has a 30000 ms timeout by default
(positive, at most 2147483647), supports exact-reason cancellation and always frees its staging buffer.

[North Atlantic wind texture](../../examples/sciviz-lic.html) shows hash-pinned, public-domain NOAA daily means,
colour by measured speed, static LIC and optional direction animation. Research and method choices are in
[the clean-room record](../../docs/clean-room.md#batch-171-job-2-line-integral-convolution).

## Moving flow, pathlines and streaklines

The optional `@margoengine/sciviz/flow` entry provides `tracePathline`: physical velocity on a regular 2D/3D grid,
bilinear/trilinear spatial interpolation, linear interpolation between frames and classical RK4. Steps shorten
at frame boundaries and the requested end. `flowParticles` carries particles on the GPU with fading trails,
uniform/random/rake/region seeds and respawn. `traceStreakline` observes successive releases at one time.

```ts
import { tracePathline } from '@margoengine/sciviz/flow';

const path = await tracePathline({
  dims: [2, 2, 1], bounds: [-2, 2, -2, 2, 0, 0],
  frames: [{ time: 0, u: new Float32Array(4).fill(1), v: new Float32Array(4) }],
}, [0, 0, 0], { from: 0, to: 1, step: 0.25 });
console.log(path.stop); // end
console.log(Array.from(path.samples.slice(-4))); // [1, 0, 0, 1], packed x,y,z,time
```

Components are `Float32Array`s, x fastest; omitted `w` is zero. Output xyzt is float64 and owns its memory.
Use consistent distance/time units. Frames share dimensions/bounds; one frame is steady at any finite time,
while multiple frame times must strictly increase and cover the interval. A 2D seed lies on the grid's z plane.
`from > to` traces backwards; `step` is always positive. Speed is never normalised. This fixed-step method has
no adaptive error guarantee; reduce the step and check convergence for your field.

`maxSteps` defaults to 10,000 (range 1 to 1,000,000), counting shortened steps. `stop` is `end`, `steps`, or
`invalid` when a stage/endpoint leaves the grid or touches NaN data. Only accepted samples are returned, with
no extrapolation or invented boundary point. Invalid seeds give no samples. Exact frame times ignore inactive
frame NaNs; zero-weight spatial neighbours are ignored. Infinity is rejected. Input copies, output including
the final copy, and scratch must together fit 128 MiB; caller input and module overhead are additional.
There may be 1 to 4,096 frames; x/y dimensions are at least two, z at least one. Bounds ascend on sampled axes,
with equal z bounds for 2D. Keep input unchanged until the call settles.

An optional `signal` cancels loading/copying/tracing with its exact reason. Copies yield every 16,384 samples
and integration every 128 steps. Each call owns a fresh, lazily loaded feature-local Wasm instance; it retains
nothing after settling and needs no explicit disposal. Import requests no GPU. The root never loads this entry.
Build the committed binary with `npm run build:flow --workspace @margoengine/sciviz`; normal builds need no Rust.
Tests cover analytic solutions and two days of the frozen NOAA wind converted to projected km/s. These trajectories
through daily means are numerical illustrations, not observed parcel tracks or forecasts. No speed claim is made.

```ts
import { Figure } from '@margoengine/sciviz';
import { flowParticles } from '@margoengine/sciviz/flow';

const figure = await Figure.create(document.querySelector('canvas')!);
const particles = await flowParticles(figure, {
  dims: [2, 2, 1], bounds: [-2, 2, -2, 2, 0, 0],
  frames: [{ time: 0, u: new Float32Array(4).fill(1), v: new Float32Array(4).fill(0.25) }],
}, { count: 256, seeding: { kind: 'random', seed: 171 }, lifetime: 2 });
await particles.advance(1, { step: 0.125 }); // physical time; drawing never advances it
await figure.ready();
figure.render();
// particles.dispose(), figure.remove(particles), or figure.dispose() frees GPU resources.
// Both figure and particles also support `using` / Symbol.dispose.
```

Create this custom layer in a 3D figure, including for planar fields. It participates in axes, bounds,
visibility, `Figure.remove` and disposal. WebGPU and WebGL2 compatibility run the same GPU code; native
WebGL2 flow awaits the remaining native backend work. Creation copies inputs in tasks of 16,384 samples
with `signal` cancellation. Later caller mutation has no effect. Importing the entry allocates no GPU resources.

Defaults: `count: 1024` (1..1,000,000), `seeding: { kind: 'uniform' }`, `from: firstFrame.time`,
`trails: 32` (2..256), `lifetime: 10` positive time units, `respawn: true`, `width: 2` device pixels
(positive, at most 64), `opacity: 0.8` (0..1), `color: '#7ddcff'` (sRGB hex, optional hex alpha multiplies opacity),
`maxSteps: 10000` (1..1,000,000 total accepted steps). Rendering includes square particle heads and
screen-width trail segments with quadratic age fade. History is bounded, on the GPU, and cut at respawn
generations so no segment bridges two releases. Lifetime expires at a step endpoint. On invalid RK4 stages,
missing data, domain exit or expiry, respawn reuses that particle's fixed seed at the endpoint, or marks it dead
when disabled. It does not integrate a partial invalid step or invent a boundary point.

`advance(to, { step, signal? })` is forward only, shortens at frame boundaries/end and yields after each
substep. Only one advance/recovery operation may run at a time. Cancellation throws its exact reason and
retains completed submissions; `time` and `steps` report them. Device replacement replays that exact partition
from retained seeds/field copies with no network load or position readback. Await `figure.ready()` before
advancing after replacement. The replay budget is `maxSteps`; create a new layer when it is exhausted.
GPU storage/uniform buffers together must fit 128 MiB and the device's buffer/binding limits. CPU copies
and the caller's arrays require additional memory. GPU bounds/widths and normalised velocities must fit
float32; normalised velocities and step-times-velocity are capped at float32 max / 16 for RK/interpolation
arithmetic headroom. Use local coordinates and consistent units. Float32 GPU results match the float64 CPU reference
within 0.0002 distance units in the bounded analytic test fields, not a universal error guarantee. Refine the
time step for your field. `readPositions({ signal?, timeoutMs? })` explicitly reads packed xyz/age to the CPU,
with age -1 for dead particles; timeout defaults to 30000 ms (positive, at most 2147483647).

`flowSeeds(grid, count = 1024, seeding = { kind: 'uniform' })` returns float64 xyz independent of velocities.
Uniform and region layouts use cell centres on an axis-balanced lattice; non-factorable counts cover the
whole lattice. Random uses an unsigned 32-bit `seed` (default 0). A rake's `start`/`end` include endpoints
(one seed uses the midpoint). A region's six `bounds` and a rake's endpoints must lie inside the grid.
The same seed/layout and step partition are deterministic on the same backend; cross-device bit identity
is not claimed. The official moving-wind demo exposes all four layouts on the hash-pinned NOAA fixture.

```ts
import { traceStreakline } from '@margoengine/sciviz/flow';

const streak = await traceStreakline({
  dims: [2, 2, 1], bounds: [-3, 3, -3, 3, 0, 0],
  frames: [0, 2].map(time => ({ time, u: new Float32Array(4).fill(time), v: new Float32Array(4) })),
}, [0, 0, 0], [0, 1, 2], { to: 2, step: 0.125 });
console.log(Array.from(streak.samples)); // [2,0,0,0, 1.5,0,0,1, 0,0,0,2]
```

Streaklines accept 1..4096 finite, strictly increasing release times, at or before observation `to`.
Their xyzt samples store **release** time; `time` stores observation time. `stops` reports each trace's
outcome. Unfinished/invalid releases have NaN xyz, preserving gaps rather than joining across missing data.
They reuse one lazily loaded Wasm instance and one field copy per call, with pathline cancellation and
per-release `maxSteps`. They retain nothing after settling. The `/flow` Wasm binary stays separate from
all other feature kernels. GPU transport itself uses no Wasm and reads back only when explicitly requested.

## CPU isosurface extraction

The optional `@margoengine/sciviz/fallback` entry provides `marchingCubes`, the CPU extraction part of
the WebGL2 work, and `createFallbackFigure(canvas, { compat, ...figureOptions })`, which creates a complete figure on
the shared WebGL2 compatibility layer. Sciviz never imports or depends on that layer: pass it as
`compat: await import('@margoengine/webgl2-compat')`, and the call installs it page-wide with `force: true`. Without
`compat` the call rejects with a TypeError naming that option. Extraction is separate from drawing and requests no device. The new `webgl2` entry below
attaches the first native drawing paths; the complete WebGL2 job is still in progress.

```ts
import { marchingCubes } from '@margoengine/sciviz/fallback';

const field = new Float32Array([1, -1, -1, -1, -1, -1, -1, -1]);
const result = await marchingCubes(field, 0, { dims: [2, 2, 2] });
console.log(result.triangles); // 1
console.log(result.vertices.length); // 24 floats: three position/gradient pairs
```

This entry loads one feature-local Rust/Wasm asset on extraction, without requesting a GPU or installing globals.
It uses the same derived case table, strict `value > level` rule, triangle order and winding as the GPU extractor.
Positions are in the grid's unit box. Each vertex is eight float32 words: position xyz and 1, then the outward,
unnormalised gradient xyz and 0. Transform positions by the data bounds and gradients by the inverse transpose,
including voxel counts, as the GPU layer does. The returned array owns its memory.

Pass `signal` to cancel loading or extraction. Both passes yield after each chunk of at most 16,384 cells, and
concurrent calls own separate Wasm instances. `maxTriangles` defaults to floor(128 MiB / 96) and rejects before
allocating output that exceeds it. Input, case and vertex allocations together are capped at 2 GiB; the returned
copy and Wasm allocator overhead are additional. Dimensions must be integers of at least two, their product must
match the input length, and the level must be finite in float32. Scalar samples are converted to float32 as in the
GPU path. NaN samples retain its comparison and interpolation behaviour.

Build the committed Wasm with `npm run build:fallback --workspace @margoengine/sciviz`. The normal package build
ships the committed asset and needs no Rust toolchain. Tests compare every case, SIMD row tails and chunk
boundaries with an independent scalar reference and pin the real MRI's 216,150 triangles at intensity 300.
No end-to-end rendering or public speed claim is made for this entry yet.

## Native WebGL2 drawing (batch 181, first drawing piece)

`attachWebGL2(engine, options)` from `@margoengine/sciviz/webgl2` attaches the existing surface, bar,
histogram and heatmap APIs to an engine with `backend: 'webgl2'`. It returns an ordinary `Figure`;
the caller owns the engine, camera, controls and rendering loop. It installs no WebGPU compatibility shim.
An optional `signal` cancels waiting for the Figure module and prevents attachment with the exact abort reason;
module fetching itself may continue. The default is no signal.
Pass `axes: false` explicitly. Axes, scatter, lines, volumes, slices and integrated CPU isosurfaces are
still pending, and their Figure calls reject with a help-linked `unsupported` error before publishing a layer.
The three real-data demos still need those paths. This is a committed piece of job 1, not its completion.

```ts
import { Engine } from '@margoengine/core';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { webglRestore } from '@margoengine/webgl2-compat/restore';
import { attachWebGL2 } from '@margoengine/sciviz/webgl2';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { backend: 'webgl2', fallback: webglRenderer });
engine.use(webglRestore());
const fig = await attachWebGL2(engine, { axes: false, mode: '2d' });
await fig.heatmap([0, 1, 2, 3, 4, 5], { nx: 3, ny: 2 });
await fig.ready();
fig.render();
// Dispose fig and engine separately when finished. Call engine.start() for a running view.
```

Surface heights must be CPU arrays (read a `GpuArray` first). They use an R32F 2D texture and integer vertex
fetches, retaining every grid cell, central-difference normals, contours, grid styling, opacity and
`setHeights` updates. No float render-target extension is needed. Each grid dimension must fit
`MAX_TEXTURE_SIZE`. Rectangles use one instanced draw with packed colours. The optional driver preserves
the caller's GL state, uses the engine view's viewport/scissor and shares its depth buffer with core meshes.
`webglRestore()` rebuilds layer resources from retained data, including the latest height update.
The preview renderer releases its own current program before live rebuild/disposal, allowing a layer's
GL state scope to restore a valid binding. CPU and real-context regressions cover this. Missing samples reject their whole triangles; normals beside them use available one-sided differences.
Root `Figure.create` continues to select WebGPU. Importing the root or CPU extractor never loads this driver.

`npm run test:webgl2 --workspace @margoengine/sciviz` checks the two real engine backends, restoration,
updates, NaN holes and caller GL state. Its fixed parity bound counts every pixel: at most 0.1% with any
RGB channel difference above 2/255, mean per-pixel maximum-channel difference at most 0.25/255.
Run it under the shared GPU lock. The strict eight-image gate now passes on both backends, including actual
context loss and restoration. The first-view canvas clear includes pixels outside its scissor.
No speed or other-browser/hardware claim is made.
The corrected driver measures 4,476 B min+gzip (previously 4,288 B; ceiling 4,442 to 4,476 B); the shared root
measures 36,916 B (previously 36,802 B; ceiling 36,802 to 36,916 B). These optional ceilings follow Scott's
2026-11-10 ruling. The bytes retain complete missing-triangle rejection, finite boundary normals and safe GL
resource disposal. Another split would add an artificial shader loader and divide resource ownership. The
existing optional driver boundary stays intact; the CPU extractor does not load it. Core + stage is 24,743 B
under its unchanged 25,000 B limit. Pixel bounds and timeouts are unchanged.

## A first WebGPU figure

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
| `brickedVolume(fig, source, options)` from `/bricks` | a volume larger than one texture or the memory budget, loaded by view ([below](#bricked-volumes)) |
| `await fig.isosurface(data, level, { dims, bounds, color })` | GPU marching cubes; `layer.update(level)` re-extracts |
| `fig.colorbar(colormap, range, { label, ticks })` | HTML colour bar at the canvas edge |

Data may be TypedArrays, plain arrays, or `GpuArray`s from `@margoengine/compute`. Make GPU arrays on the
figure's engine with `createCompute({ engine: fig.engine })`. A surface, volume or isosurface reads a GPU array on
the GPU; give such layers a `range`, since their min and max are not read back for you.

Volumes and isosurfaces need an integer of at least two samples on every axis. A single slice is a 2D image:
use `fig.heatmap(values, { nx, ny })` on a `mode: '2d'` figure. Invalid axes and a mismatched value count report
different `RangeError` messages.

Overlapping `isosurface.update(level, { signal })` calls run in request order. Each resolves its own triangle
count, and the displayed vertices, count and level change together after extraction completes. An abort or failure
keeps the previous surface. Disposal aborts active and queued extractions. During extraction, GPU memory holds
the displayed surface and one new surface (96 bytes per triangle each); no extraction speed improvement is claimed.
Disposing the figure while `fig.isosurface` is pending rejects creation and frees the unfinished layer.

After device replacement, CPU-backed isosurfaces rebuild their field, compute context, tables and draw bindings,
then extract the last committed level again. `await fig.ready()` waits for this reconstruction. Active and queued
extractions from the old device reject with code `state`; updates requested after replacement run on the new
device. The Figure drops its old compute context, so new isosurfaces also use the replacement device.
CPU-backed surfaces (including the latest `setHeights`), volumes and slices, rectangles, meshes, graphs and map
tiles rebuild too. Graphs retain the latest positions; meshes retain the latest triangles; tiles retain decoded RGBA
pixels and do not fetch again. Bricked volumes read their bricks again as frames render.
Caller-owned GPU arrays have no CPU mirror: their surface, volume, slice and isosurface layers become hidden after
replacement. Recreate the arrays and layers on the new engine device. Setting `visible` cannot revive lost data.
Custom layers passed to `fig.addLayer` implement `restore(): void | Promise<void>` to rebuild their device state.

```ts
import { Figure } from '@margoengine/sciviz';
const fig = await Figure.create(document.querySelector('canvas')!);
const values = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]);
const shell = await fig.isosurface(values, 0.5, { dims: [2, 2, 2] });
await fig.engine.rebootDevice();
await fig.ready();
fig.render(); // the same CPU-backed surface on the new device
await shell.update(0.6);
```

3D axes place titles and ticks using measured CSS-pixel sizes, with 8 px clearance. At smaller sizes or after a
camera change, crowded tick labels are omitted; the titles keep their spacing outside the tick row. Data ticks and
grid lines are unchanged. This is recomputed every rendered frame, including resize and orbit.

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
Runge-Kutta on trilinearly interpolated velocities, coloured by speed. Step doubling controls local error:

- `seeds`: points `[x, y, z]`, or a count per axis on an even grid (default 8 in 2D, 4 in 3D);
- `step`: maximum arc step (default a fifth of the grid spacing); shortened for error or unresolved turns;
- `maxSteps`: steps each way (default 2000);
- `direction`: `'forward'`, `'backward'` or `'both'` (default).

Each accepted step has RK4 step-doubling error estimate |two half steps - full step| / 15 <= 1e-6 times
its arc step. Every stage and endpoint must remain in the starting tangent's forward half-space. Rejected
steps halve before any point is published. A line stops at the grid's edge, a NaN sample, speed below
`minSpeed` (default 1e-9), or when progress cannot be resolved at max(1e-6 min(step, grid spacing),
32 epsilon max(|position components|, step)). This is a local estimate, not a global topology/error guarantee.
True closed orbits continue to maxSteps; no visited-point filter or path trimming is used. Both layers also take `colormap`, `range`,
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

## Replacing trace data

`fig.replace(old, next)` swaps in a ready layer from the same figure and frees the old layer. For scatter,
quiver, streamlines and histograms, build the replacement before removing anything:
`trace = fig.replace(trace, await fig.scatter(newData, options))`. The previous trace stays visible while data
is read and the new layer is built. Call `replace` immediately after `await`, without another wait or render in
between, so there is no rendered frame with both traces. A failed build leaves the old trace in place.

The new layer keeps its own options, name and style and takes the old layer's place in `fig.layers` and the legend.
Bounds, picking and exports follow the new data. Both layers must belong to this figure; replacing a layer with
itself is a no-op. This builds a new layer and briefly holds both layers' resources.

`fig.remove(layer)` detaches its resources synchronously, so a render immediately afterward cannot draw the
removed points or lines. Disposing an attached figure also detaches its traces from the engine's shared plugins.

Use a timeline to serialize asynchronous control changes and playback:

```ts
import { Figure } from '@margoengine/sciviz';

const canvas = document.querySelector('canvas')!;
const fig = await Figure.create(canvas, { mode: '2d', limits: [0, 3, 0, 3] });
let trace = await fig.scatter({ x: [0, 1, 2], y: [0, 1, 2] }, { size: 8 });
const timeline = fig.timeline([0, 1, 2], async (index) => {
  trace = fig.replace(trace, await fig.scatter(
    { x: [0, 1, 2], y: [index, 1, 2] }, { size: 8 },
  ));
}, { controls: false });
await timeline.seek(2);
```

## Time series

`fig.timeline(times, frame, options)` gives a figure a time series: `frame(index, time)` updates your layers for one
frame and may return a promise. Controls over the canvas's bottom edge show a play button, a slider and the current
time (`controls: false` hides them; `format` sets the time text). A 2D chart makes room for them below its axes.

`await fig.play({ fps, loop, signal })` steps through the frames (default 10 per second, once). It waits for each
frame's update before the next, so slow updates never overlap. It resolves at the last frame or on `fig.pause()`,
and rejects with the signal's reason when `signal` aborts. The timeline's `seek(index)`, `index`, `time` and `time`
event follow the current frame.
Concurrent `seek` calls also run in request order. Disposing a timeline prevents a pending callback from
publishing another index or `time` event; it does not cancel work inside your callback.

```ts
import { Figure } from '@margoengine/sciviz';

const canvas = document.querySelector('canvas')!;
const fig = await Figure.create(canvas);
const nx = 64;
const heights = new Float32Array(nx * nx);
const surface = fig.surface(heights, { nx, range: [-1, 1] });
const times = Array.from({ length: 60 }, (_, k) => k / 10);
const timeline = fig.timeline(times, (_, t) => {
  for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = Math.sin(i / 6 + t) * Math.cos(j / 8);
  surface.setHeights(heights);
}, { format: (t) => `${t.toFixed(1)} s` });
timeline.addEventListener('time', () => console.log(timeline.index));
await fig.play({ fps: 30, signal: AbortSignal.timeout(10_000) });
```

## Bricked volumes

`layer.setFrame(index, { signal })` requests on bricked volumes run in order, including overlapping calls. Each
promise resolves for its own time step. An aborted queued request never selects a step. Aborting an active request
also aborts its source reads and cancels publication: the displayed step stays put even if a source finishes late.
`ready({ signal })` alone cancels only that readiness wait. Ordinary `VolumeLayer`
has no asynchronous `setFrame` method.

`brickedVolume(fig, source, options)` from `@margoengine/sciviz/bricks` draws a grid larger than one 3D texture or
than you want in GPU memory. Bricks of a level-of-detail pyramid load by view into one atlas texture: the coarsest
brick covers the box first, then finer ones replace it where their voxels would look largest. A separate entry, so a
figure that does not import it pays nothing. It looks like `fig.volume()` and takes the same `colormap`, `range`,
`opacity`, `density`, `mode`, `quality`, `shading`, `clip` and `bounds`; `layer.slice(axis, position)` works too.

| Option | Default | Meaning |
| --- | --- | --- |
| `memoryBudget` | 536,870,912 (512 MiB) | Bytes of GPU memory for the atlas and page table; the least recently used bricks are replaced past it |
| `brickSize` | 64 | Voxels per brick side |
| `border` | 1 | Voxels a brick repeats from each neighbour, so filtering is exact across brick edges; 0 shows seams |
| `detail` | 1 | Pixels a voxel may cover before finer bricks are wanted; 0 asks for full resolution everywhere in view |
| `concurrency` | 4 | Most brick reads started per frame and running at once |

A source is `{ dims, range, frames, read(request) }`. `read` gets `{ level, frame, origin, size, signal }` and returns
those voxels (x fastest), or a promise of them: slice a file with `fetch` and a `Range` header, and pass `signal` on.
Level 0 is full resolution; each level above averages 2 x 2 x 2 voxels of the one below. `arraySource(data, dims)`
makes a source from arrays in memory (one array, or one per time step). A `GpuArray` is not a source: read it back
first.

`await layer.ready({ signal })` resolves once the view's bricks are loaded, and rejects with a `failed` MargoError if a
read failed (coarser bricks keep drawing, an `error` event also fires, and calling `ready()` again reads it again).
`await layer.setFrame(index, { signal })` moves to a time step: the old step stays on screen until the new one's bricks
for the view are in, so a timeline's playback waits for it. `layer.stats` reports the bricks and bytes in use. Bricks
are chosen and started as frames draw, so the engine's loop must be running (it is, unless you stopped it).
Voxel encoding reuses its bit-cast storage, keeping temporary memory constant instead of allocating typed arrays
for every voxel. The atlas budget, selected bricks, border samples and encoded values are unchanged.

```ts
import { Figure } from '@margoengine/sciviz';
import { brickedVolume, type BrickRequest } from '@margoengine/sciviz/bricks';

const canvas = document.querySelector('canvas')!;
const fig = await Figure.create(canvas);
// 4096 x 1024 x 1024 voxels: 8.6 GiB as half floats, past a 2048 texture. Here a function fills each block; a real
// source would fetch it. Two time steps.
const dims = [4096, 1024, 1024] as const;
const read = ({ level, frame, origin, size }: BrickRequest) => {
  const scale = 2 ** level,
    out = new Float32Array(size[0] * size[1] * size[2]);
  for (let z = 0, i = 0; z < size[2]; z++)
    for (let y = 0; y < size[1]; y++)
      for (let x = 0; x < size[0]; x++, i++) {
        const u = ((origin[0] + x) * scale) / dims[0] - 0.5 - frame * 0.1,
          v = ((origin[1] + y) * scale) / dims[1] - 0.5,
          w = ((origin[2] + z) * scale) / dims[2] - 0.5;
        out[i] = Math.exp(-(u * u + v * v + w * w) * 14);
      }
  return out;
};
const volume = brickedVolume(fig, { dims, range: [0, 1], frames: 2, read }, {
  colormap: 'ember',
  opacity: (t) => t * t,
  memoryBudget: 256 * 1024 * 1024,
});
await volume.ready({ signal: AbortSignal.timeout(60_000) });
console.log(volume.stats.resident, volume.stats.memoryBytes);
const timeline = fig.timeline([0, 1], (index) => volume.setFrame(index));
await timeline.seek(1);
```

## NRRD volumes

`volumeFromNRRD(fig, source, options)` from `@margoengine/sciviz/nrrd` reads a NRRD file, the format CT, MRI and
microscopy tools such as 3D Slicer write, and draws it with `fig.volume()` in the file's true proportions. `source` is
a URL to fetch or the file's bytes; a detached `.nhdr` header fetches its data file next to it. The reading is
`parseNRRD` of [`@margoengine/loaders/nrrd`](../loaders/README.md#nrrd-volumes), so every encoding it reads works here
(raw, ascii, hex, gzip, and bzip2 with `@margoengine/decoders`). It takes every `fig.volume()` option plus:

| Option | Default | Meaning |
| --- | --- | --- |
| `frame` | `0` | volume of a time series (axes after the spatial ones) |
| `component` | `0` | sample of a multi-component voxel (an RGB or vector axis), or `'magnitude'` |
| `resolve` | fetch next to the URL | reads a detached data file by the path the header writes; needed for `.nhdr` bytes |
| `maxSamples` | `536_870_912` | stops a huge declared size before anything is allocated |
| `init` | none | request options for every fetch, such as headers |
| `signal` | none | abandons the fetches and the read |

```ts
import { Figure } from '@margoengine/sciviz';
import { volumeFromNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';

const fig = await Figure.create(document.querySelector('canvas')!);
const { volume, grid } = await volumeFromNRRD(fig, '/scans/volume-raw.nrrd', { colormap: 'magma' });
console.log(volume.dims, volume.spacing, grid.range);
// The same grid also feeds an isosurface or a slice.
await fig.isosurface(grid.data, (grid.range[0] + grid.range[1]) / 2, { dims: grid.dims, bounds: grid.bounds });
console.log(nrrdGrid(volume, { frame: 0 }).dims);
```

`loadNRRD(source, options)` reads without drawing, and `nrrdGrid(volume, { frame, component })` picks one scalar grid:
a single scalar volume keeps the file's sample type, a frame of a series is a view of the file's array, and a chosen
component or the magnitude is a new `Float32Array`. The colour range spans the grid's samples unless you pass `range`.
The file's orientation (`volume.matrix`) is not applied to the box: the volume draws axis-aligned in index order.

## Medical and array formats

`@margoengine/sciviz/formats` reads NIfTI, DICOM and Zarr into the grid `fig.volume()` takes, with no other
dependency: gzip (every member of the file), zlib and deflate are inflated in the package, so a reader knows where each
stream ends. Every reader returns `data`, `dims`, `bounds` (the true proportions, from 0) and `range` (the smallest and
largest finite sample), and `volumeFromGrid(fig, grid, options)` draws any of them.

Compressed single-file NIfTI and deflated DICOM data that exceed the decompressed-byte limit report a
linked `MargoError` with code `failed`, the minimum required byte count, the byte
limit, and instructions to increase `maxSamples` (default `536_870_912`). The byte
allowance is `8 * maxSamples + 1_048_576`. These policy failures do not call the
file damaged or ask you to re-export it. For a gzip member after the first, the
byte count and limit refer to that member and the remaining allowance. A paired
NIfTI `.img` instead uses its header's exact image size and names those fields.
Zarr chunk byte limits come from shape and dtype metadata; their errors name that metadata.

- **NIfTI** (`parseNIfTI(bytes)`, `loadNIfTI(url)`): NIfTI-1 and NIfTI-2, `.nii`, `.nii.gz`, and a `.hdr` with its
  `.img` (through `resolve`), in either byte order. Scaled data (`scl_slope`, `scl_inter`) comes back as
  `Float32Array`; RGB24 and RGBA32 are never scaled. `matrix` is the sform when set, else the qform (with `qfac`), else
  the voxel sizes; `transform` says which. `all` holds every frame and component; `data` is the first. A `vox_offset`
  below 352 (544 for NIfTI-2) in a `.nii` means 352 (544). A magic that does not match the header size or lacks its
  NUL, a NIfTI-2 file without the `0D 0A 1A 0A` signature, a `bitpix` that does not match the datatype and a
  non-finite `vox_offset` are refused with a `RangeError`.
- **DICOM** (`parseDICOM(bytes)`, `dicomSeries(images)`, `loadDICOMSeries(urls)`): Part 10 files (with the preamble,
  with `DICM` only, or starting at the file meta group) in implicit or explicit VR little endian, explicit VR big
  endian and deflated explicit VR little endian, with uncompressed pixel data: 8, 16 or 32 bit integers masked to Bits
  Stored and sign-extended from High Bit, Float and Double Float Pixel Data, and YBR_FULL_422 expanded to three samples
  a pixel. The Modality LUT Sequence or `RescaleSlope` and `RescaleIntercept` is applied. Elements sent as UN read with
  their dictionary VR. `dicomSeries` orders the slices of one series by position along the slice normal (instance
  number when positions are missing), takes the slice step from the positions (else `SpacingBetweenSlices`, else
  `SliceThickness`) and builds the voxel to patient matrix. A multi-frame image whose Frame Increment Pointer names
  Frame Time or Frame Time Vector gives the volume's time steps (`frames`); any other multi-frame image is refused with
  code `unsupported`, since its frames are not known to lie in space. Compressed transfer syntaxes (JPEG, JPEG-LS,
  JPEG 2000, RLE), 32-bit OW pixel data in big endian files and YBR_PARTIAL_422 or 420 are refused with code
  `unsupported`, naming what. A bare data set (no preamble, no `DICM`, no meta group) has no transfer syntax and is
  read as explicit VR little endian when a VR follows its first tag, else as implicit VR little endian.
- **Zarr** (`openZarr(store, path)`, `array.read({ start, stop })`, `zarrGrid(read, spacing)`): v2 (`.zarray`) and v3
  (`zarr.json`, with the v3.1 short-hand names) arrays with regular chunks, over HTTP (a base URL), an object of keys,
  or your own `(key, signal) => bytes` function. Codecs: bytes in either order, gzip, zlib, crc32c (checked),
  transpose (chained ones compose), Zstandard (v2 compressor `zstd`, v3 codec `zstd`) and Blosc 1 (v2 compressor and v3
  codec `blosc`: blosclz, LZ4, LZ4HC, zlib and Zstandard inside, byte or bit shuffle, split or whole blocks); C and F
  order. Zstandard follows [RFC 8878](https://www.rfc-editor.org/rfc/rfc8878) and Blosc the
  [Blosc 1 format description](https://www.blosc.org/docs/blosc-format.html); both decoders are Margo's own, loaded
  only when a chunk needs one. Snappy inside Blosc, Blosc 2 frames and Zstandard dictionaries are refused with code
  `unsupported`. Only an absent key (HTTP 404) is a missing chunk, read as the fill value; any other HTTP error fails
  with code `failed`. `read` fetches only the chunks the box touches, at once. Sharding, storage transformers, other
  chunk key encodings and metadata fields this reader does not know (unless marked `must_understand: false`) are
  refused with code `unsupported`, naming them. Metadata the specification does
  not allow (a codec chain without one bytes codec, a fill value outside its data type, a `.` or `..` path segment,
  `dimension_names` of the wrong length) and a chunk that ends with fewer bytes than its shape needs are refused
  with a `RangeError`. A compressor that exceeds the chunk byte allowance reports linked `MargoError` code `failed`.

```ts
import { Figure } from '@margoengine/sciviz';
import { loadNIfTI, parseDICOM, dicomSeries, openZarr, zarrGrid, volumeFromGrid } from '@margoengine/sciviz/formats';

const fig = await Figure.create(document.querySelector('canvas')!);

const brain = await loadNIfTI('/data/zstat1.nii.gz');
console.log(brain.dims, brain.spacing, brain.transform, brain.units.space);
volumeFromGrid(fig, brain, { colormap: 'coolwarm' });

// DICOM slices of one series, in any order.
const files = await Promise.all(['/data/CT_small.dcm'].map(async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer())));
const ct = dicomSeries(await Promise.all(files.map((bytes) => parseDICOM(bytes))));
console.log(ct.dims, ct.range);

// A Zarr array in memory (any URL of a Zarr store works the same way).
const store = {
  '.zarray': JSON.stringify({ zarr_format: 2, shape: [2, 2, 2], chunks: [2, 2, 2], dtype: '<f4', compressor: null, fill_value: 0, order: 'C', filters: null }),
  '0.0.0': new Uint8Array(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer),
};
const array = await openZarr(store);
const grid = zarrGrid(await array.read(), [1, 1, 2]);
console.log(array.shape, grid.dims, grid.range);
```

## Geographic layers

`@margoengine/sciviz/geo` puts raster map tiles under a figure's data layers, flat or on a globe, and maps longitude,
latitude and height into the same data units so scatter, line and other layers sit on the map.

- Projections: `'mercator'` (Web Mercator on the sphere, the world in [-1, 1] by [-1, 1], ending at
  `MERCATOR_MAX_LAT`, about 85.05 degrees), `'plate'` (plate carrée, x = lon / 180, y = lat / 180) and `'globe'` (the
  WGS 84 ellipsoid, Earth-centred, equatorial radius 1, z toward the north pole, heights along the ellipsoid normal).
  Formulas from Snyder's "Map Projections: A Working Manual" (USGS, 1987), chapters 7 and 12.
- `project(lon, lat, height, projection)` and `unproject(x, y, projection)` convert points; longitudes outside
  ±180 degrees wrap by 360. `tileAt`, `tileBounds` and `tilesIn` work in the slippy-map scheme (z/x/y, y from the
  north); a box whose west edge lies east of its east edge crosses the 180th meridian.
- `tileLayer(fig, { tiles, projection, zoom, area, maxTiles, attribution, init, signal })` loads every tile of `area`
  at `zoom` (default 2) from a URL template with `{z}`, `{x}` and `{y}` or from your own function, then draws them.
  Each tile is a 16 by 16 grid whose vertices the shader projects, so the globe is round and seams close. A 404 counts
  in `layer.missing`; other HTTP errors reject. Credit the tile provider with `attribution`; it shows in the figure's
  corner.

```ts
import { Figure } from '@margoengine/sciviz';
import { tileLayer, project } from '@margoengine/sciviz/geo';

const fig = await Figure.create(document.querySelector('canvas')!);

// Your own tile server, or a provider whose terms allow it (with its credit line).
const map = await tileLayer(fig, {
  tiles: '/tiles/{z}/{x}/{y}.png',
  zoom: 2,
  attribution: 'Map tiles: your provider',
});

// Three cities as points on the map, in the map's data units.
const cities = [
  [-0.13, 51.51],
  [139.69, 35.69],
  [-74.01, 40.71],
].map(([lon, lat]) => project(lon, lat, 0, map.projection));
await fig.scatter({ x: cities.map((p) => p[0]), y: cities.map((p) => p[1]), z: cities.map((p) => p[2]) });
```

## Graph layouts

`@margoengine/sciviz/graph` lays out networks with forces and draws them on the GPU. `ForceLayout` follows Fruchterman
and Reingold (1991): every edge pulls its ends together with d² / k, every pair of nodes pushes apart with k² / d, and
each node moves at most a temperature that cools quickly and then simmers at a low constant. The all-pairs push runs
through a Barnes and Hut tree (quadtree in 2D, octree in 3D), so one iteration costs about E + N log N: a cell acts as
one body at its centre of mass when the node is farther from that centre than the cell's side over `theta` plus the
centre's offset from the cell's middle, and is not inside the cell. That is Barnes's 1994 form of the test: the plain
side-over-distance test of 1986 takes a cell whose mass sits on its far side as one far body for a node right beside
its near side, and at `theta` 0.9 that kept a ring's crossed edges crossed. `theta: 0` gives the exact all-pairs push. A weak pull toward the origin (`gravity`) keeps parts that are not
connected in view.

- `new ForceLayout(graph, options)`: `graph` is `{ nodes, edges, weights? }` with two node indices per edge. Options:
  `dimensions` (2 or 3, default 2), `theta` (default 0.9), `length` (the ideal edge length k, default 1),
  `temperature` (first step limit, default a tenth of the start square's side, at least k), `cooling` (default 0.97),
  `simmer` (lowest step limit in units of k, default 0.05), `gravity` (default 0.01), `seed` or `positions` (xyz per
  node; a 2D layout sets z to 0).
- `layout.step()` runs one iteration; `for await (const step of layout.run({ iterations, tolerance, signal }))` runs
  them and yields to the page between iterations, stopping at the limit (default 300), once no node moves more than
  `tolerance` times k, or when the signal aborts.
- `graphLayer(fig, graph, positions, options)` draws edges as lines and nodes as discs `nodeSize` CSS pixels across,
  coloured by `values` (default each node's degree) through a colour map; `layer.setPositions(layout.positions)` after
  a step moves it. The figure frames `bounds` (default the positions' box when the layer is made).

```ts
import { Figure } from '@margoengine/sciviz';
import { ForceLayout, graphLayer } from '@margoengine/sciviz/graph';

const fig = await Figure.create(document.querySelector('canvas')!);

// A ring of 200 nodes with a few chords.
const nodes = 200;
const edges: number[] = [];
for (let i = 0; i < nodes; i++) edges.push(i, (i + 1) % nodes);
for (let i = 0; i < nodes; i += 25) edges.push(i, (i + 100) % nodes);
const graph = { nodes, edges };

const layout = new ForceLayout(graph, { seed: 1 });
for await (const step of layout.run({ iterations: 200 })) console.log(step.iteration, step.moved);
const layer = graphLayer(fig, graph, layout.positions, { nodeSize: 5, colormap: 'magma' });

// Later steps move the drawing; the figure keeps the frame it was given at creation (`bounds`).
layout.step();
layer.setPositions(layout.positions);
```

## Unstructured grids

`@margoengine/sciviz/grids` draws finite-element style meshes: tetrahedra, hexahedra, wedges and pyramids with a value
per point or per cell, in VTK's UnstructuredGrid layout (`points`, `connectivity`, `offsets` as the end of each cell,
`types` as VTK cell type numbers) and VTK's point order for each cell.

- `gridSurface(grid, { values })` is the outer surface: every face exactly one cell owns, facing out, as triangles.
- `sliceGrid(grid, { normal, offset }, { values })` cuts the grid by the plane `dot(normal, p) = offset`: one convex
  polygon per cell the plane crosses, with point values interpolated along the cut edges, so neighbouring cells meet
  without cracks. Cell values stay constant per cell.
- `gridLayer(fig, grid, { slice, values, colormap, range, opacity, missing })` draws either one, coloured through a
  colour map; `layer.update(sliceGrid(grid, plane))` moves the slice. `meshLayer(fig, set)` draws any triangle set.
- `parseVtk(text or bytes)` reads a legacy `.vtk` file (versions up to 4.2, ASCII or BINARY) holding an
  UNSTRUCTURED_GRID. Voxels become hexahedra; vertices, lines, surface and quadratic cells are skipped and counted in
  `skipped`. Every SCALARS array is kept by name (`pointArrays`, `cellArrays`); the first of each kind is `pointData` and
  `cellData`. Version 5.1 files and XML `.vtu` are refused with a `RangeError` naming the version.

Wedges follow VTK's corrected order: points 0, 1, 2 run counter-clockwise seen from 3, 4, 5, as in a hexahedron.

```ts
import { Figure } from '@margoengine/sciviz';
import { gridLayer, sliceGrid, parseVtk, CELL_TYPES } from '@margoengine/sciviz/grids';

const fig = await Figure.create(document.querySelector('canvas')!);

// One hexahedron and one wedge on its +x side, with a value per point.
const grid = {
  points: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 2, 0, 0, 2, 0, 1],
  connectivity: [0, 1, 2, 3, 4, 5, 6, 7, 1, 8, 2, 5, 9, 6],
  offsets: [8, 14],
  types: [CELL_TYPES.hexahedron, CELL_TYPES.wedge],
  pointData: [0, 1, 2, 1, 1, 2, 3, 2, 2, 3],
};
const layer = gridLayer(fig, grid, { colormap: 'viridis' });

// Show a slice instead of the surface.
layer.update(sliceGrid(grid, { normal: [1, 0, 0], offset: 0.5 }));

// A legacy VTK file from a solver.
const text = '# vtk DataFile Version 3.0\none tetrahedron\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 4 float\n0 0 0 1 0 0 0 1 0 0 0 1\nCELLS 1 5\n4 0 1 2 3\nCELL_TYPES 1\n10\nCELL_DATA 1\nSCALARS stress float\nLOOKUP_TABLE default\n7.5\n';
const mesh = parseVtk(text);
console.log(mesh.title, mesh.cellArrays.stress, mesh.skipped);
gridLayer(fig, mesh, { values: 'cell' });
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
- `cividis`: Nuñez, Anderton and Renslow, PLOS ONE 2018 (CC0), made for red-green colour vision deficiency.

Each recorded map keeps all 256 published decimal RGB rows: six decimal places for the viridis family and four for
cividis. Sampling interpolates those values as JavaScript numbers, without an 8-bit round trip. Tables are plain
numeric rows bundled with the existing synchronous API; there is no runtime data download. GPU tables convert to
float32 only after interpolation (and after sRGB decoding with `linear: true`); CSS gradients still use 8-bit RGB.

`colormap(['#000004', '#b63679', '#fcfdbf'])` builds a map from your own stops, interpolated in OKLab.
`map.table(n, { linear })` gives RGBA floats for your own shaders, and `map.css()` a gradient string.

```ts
import { colormap, colormapNames } from '@margoengine/sciviz';
import { ticks } from '@margoengine/sciviz/maths';

const map = colormap('viridis');
console.log(map.sample(0)); // [0.267004, 0.004874, 0.329415], the published first row
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
- **Bricked volumes.** A page table with one entry per full-resolution brick names the finest loaded brick over that
  place; each ray sample looks it up and reads the atlas with hardware filtering. Coarser bricks step, and take
  gradients, by their own voxel. Between loaded levels values can step by what averaging removed: there is no gap, and
  no seam between bricks of one level.
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

LIC is a separate optional entry: 23,461 B minified gzip in the integrated build (24,165 B ceiling).
This includes the same full-precision published colormap data as the other colour-bearing entries; the
normalized pre-restoration measurement was 10,429 B. Core + stage remains 24,743 B combined gzip.

## Stream tubes and ribbons

The optional `@margoengine/sciviz/tubes` entry turns packed xyz polylines into owned CPU mesh arrays.
`streamTubeGeometry(path, options)` takes `radius` (default 1, or absolute scalar radius per input point),
`sides` (12), `caps` (true), `steps` (max(64, point count - 1)) and `closed` (false).
`streamRibbonGeometry` takes full `width` (1 or values per point), initial `angle` (0 radians), and optional
`streamwiseVorticity` plus positive physical `speeds`: angle changes by the integral of half streamwise curl
per speed over distance. Rates interpolate linearly with an exact partial-interval integral. Spin is not
geometric torsion or a material surface with strain. The ordinary 2D horizontal wind has zero streamwise curl.

The existing geometry sweep supplies transported frames, smooth taper normals, seam joining, cap normals
and UVs. Output rows sample the input polyline at equal arc length. Set `steps` high enough to resolve bends
and radius/scalar features; self-intersections are retained. Consecutive duplicate points and reversing cusps
reject with linked errors. Closed input repeats its first point, scalar and size; a closed physical ribbon
needs a whole number of full turns. Positions/scalars are finite within +/-1e15; steps 1..16384, sides 3..128,
input 2..16385 points, wall vertices at most one million. Float32 output has normal coordinate precision limits.

`path.scalar` (default zero) gives colour values per input point; `streamMeshTriangles(mesh)` preserves
smooth normals and values for the existing `meshLayer`. Output triangle arrays are capped at 128 MiB and
owned independently. Pure builders retain no resources, load nothing and need no disposal. An optional
`signal` checks cancellation before synchronous work. The rendered layer supports `dispose()`/`using`
and existing device recovery. Rendering requires WebGPU or real WebGL2 compatibility.

```ts
import { Figure } from '@margoengine/sciviz';
import { streamTubeGeometry, streamRibbonGeometry, streamMeshTriangles } from '@margoengine/sciviz/tubes';
import { meshLayer } from '@margoengine/sciviz/grids';

const figure = await Figure.create(document.querySelector('canvas')!);
const path = { positions: [0, 0, 0, 1, 0.5, 0, 2, 1, 0.5], scalar: [2, 4, 8] };
const tube = streamTubeGeometry(path, { radius: [0.05, 0.12, 0.08], sides: 16, steps: 96 });
const layer = meshLayer(figure, streamMeshTriangles(tube), { range: [2, 8] });
const ribbon = streamRibbonGeometry(path, {
  width: 0.15, streamwiseVorticity: [0, 0.5, 1], speeds: [1, 1, 1], steps: 96,
});
console.log(tube.positions.length / 3, ribbon.indices.length / 3, layer.triangles);
```

[North Atlantic wind paths](../../examples/sciviz-tubes.html) shows tubes and ribbons on the same frozen
public-domain NOAA daily mean winds as the wind and LIC pages. Radius and colour encode measured speed;
the horizontal field has zero streamwise curl. Width is explicitly exaggerated and is not a measured diameter.

## Comparison with web rivals

`npm run sciviz:compare` (repository root) draws eight scenes on real data (MRI volume and
isosurface, NYC taxi scatter, line and heatmap, NOAA wind streamlines, an OpenAlex citation
graph and map tiles) next to VTK.js, Plotly.js, deck.gl, ECharts-GL, regl-scatterplot and
Cosmograph. The rivals are installed outside this repository and called only through their
public APIs. `--runs=1` is a clock-free smoke: every image must be non-empty and repeat byte
for byte. Features, accuracy against closed-form answers and losses are in
[the comparison](../../docs/whitepaper/sciviz-vs-rivals.md). No speed claim is made until the
quiet-machine run.

## Reproducible volume comparison

The [clean-room rival harness](../../docs/sciviz-rivals.md) keeps the historical shaded
volume-64 scene and adds isotropic unshaded 64-cube and 128-cube controls. A one-run
smoke checks complete, nonempty images, exact repeated frame bytes and public GPU
call counts without collecting elapsed times. VTK.js is installed outside this repository.
The comparison documents differences in storage, interpolation and scene-depth work;
it makes no equal-pixel or speed claim.

Volume preparation reuses matrix storage inside its existing uniform array. The
work-count regression checks exact uniform bytes across shears, reflections, singular
transforms, clip/mode changes and device restoration. This removes two temporary
16-float allocations per volume per frame; the uploads and ray marcher are unchanged.

```ts
import { Figure } from '@margoengine/sciviz';

const figure = await Figure.create(document.querySelector('canvas')!, {
  axes: false, controls: false, aspect: [1, 1, 1],
});
figure.engine.stop();
const data = Float32Array.from({ length: 64 ** 3 }, (_, i) => {
  const x = i % 64 - 31.5;
  const y = Math.floor(i / 64) % 64 - 31.5;
  const z = Math.floor(i / 4096) - 31.5;
  return Math.max(0, 1 - Math.hypot(x, y, z) / 31.5);
});
figure.volume(data, { dims: [64, 64, 64], range: [0, 1], shading: false });
await figure.ready();
figure.render();
figure.dispose();
```

### Optional frame comparison helpers

`@margoengine/sciviz/bench` imports no renderer or rival and reads no clock on
import. `pairedFrames` takes caller-owned asynchronous render/read adapters; defaults
are one pair, two warmup pairs and `timing: false`. Pairs alternate order and retain
copied images. Explicit `timing: true` collects every frame/read sample and both
minima. The command harness keeps speed-phase and GPU admission policy outside the
portable helper. `imageDifference` compares complete equal-sized RGBA8 frames:
RGB MAE, maximum channel error, fraction over eight mean RGB levels, and exact
RGBA equality. It applies no image masks, resampling or pass/fail tolerance.

```ts
import { pairedFrames } from '@margoengine/sciviz/bench';

const renderer = {
  async frame(signal?: AbortSignal) {
    signal?.throwIfAborted();
    return { width: 1, height: 1, rgba: new Uint8Array([34, 203, 238, 255]) };
  },
};
const comparison = await pairedFrames(renderer, renderer, { runs: 1 });
console.log(comparison.difference.identical); // true; no timing samples collected
```

The adapters own their renderers and disposal. A frame method must finish GPU work
and return copied pixels before resolving. Pass an `AbortSignal` to stop before or
after each awaited frame; failures propagate without retries. Runs are 1..100 and
warmup pairs 0..20. Aborting also rejects a pending frame wait if the adapter ignores its signal;
underlying work and disposal remain the adapter owner's responsibility. The
command harness supplies browser and process limits.
