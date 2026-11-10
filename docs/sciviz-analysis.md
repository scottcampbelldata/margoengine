# Scientific analysis filters, batch 172

## Filter pipeline

The optional `@margoengine/sciviz/pipeline` entry exports `FilterPipeline`. It imports
no renderer and starts no work on construction. A registry maps stable operator
names to source, filter and layer implementations. Register lazy implementations
that import their owning optional filter entry inside `execute`. The graph can
therefore describe all analysis filters without importing their code up front.

Add nodes in dependency order with `add({id,type,inputs,params})`. Sources have no
inputs; filters and layers have at least one. Request a node with
`await graph.run(id,{time,signal})`. Time defaults to zero; operators opt into time
dependence with `timeDependent: true`, inherited by their descendants. The graph
executes only the requested ancestors, once each, and caches successful outputs.
Concurrent requests are serialized and reuse cache entries. Independent temporal
branches keep independent requested times. A diamond shares its upstream output.

`setParams(id,params)` replaces the complete parameter value and dirties that node
and its descendants. `invalidate(id)` notifies the graph of an external source
change. Neither executes anything until the next demand. Mutating an ancestor
cancels active or queued demands involving it; callers request the new result
explicitly. Failures are propagated unchanged and do not poison future requests.

Parameters are snapshotted, deeply frozen finite JSON. Typed arrays, non-finite
numbers, cycles, sparse arrays, functions and class instances reject. Large data
belongs in a source, with a URL or other persistent identifier in its params.
`toJSON()` emits version 1, node order, operator names, connections and params;
`FilterPipeline.fromJSON(description,registry)` restores it without execution.
The restoring application supplies trusted operators: JSON never contains code.

Inputs and returned outputs are borrowed until invalidation or disposal. Operators
must not mutate or dispose borrowed inputs, and must observe `signal` during
asynchronous work. JavaScript cannot preempt an operator that ignores cancellation;
requests await its settlement, reject with the exact abort reason, and release
its late result instead of caching it. Cancellation preserves successful upstream
outputs. `release(output)` frees only resources that operator owns. Consumers are
released before their dependencies on invalidation, time replacement and disposal.
`dispose()` and `Symbol.dispose` abort pending work and release cached resources;
the graph never disposes an external figure or device itself. Operator release
functions must be synchronous and nonthrowing.

The topology is append-only. To rewire or remove nodes, restore an edited JSON
description into a new graph and dispose the old one. No automatic animation clock,
unbounded history cache, persistence backend or speculative execution is implied.

## Evidence and data

`packages/sciviz/tests/pipeline.test.js` covers diamonds, downstream invalidation,
concurrent requests, separate temporal branches, JSON round trips and validation,
exact-reason cancellation, mutation during execution, resource ordering, failure
propagation and the real FUN3D samples. The browser test renders the NASA solution
on native WebGPU and WebGL2 compatibility, changes the subset, counts source/filter/
layer executions, checks coloured pixels and verifies removal of owned layers.

`examples/sciviz-pipeline.html` uses the published NASA TMR SA flat-plate solution
`cf_plate.dat`, FUN3D rev 32421 on the finest 545 by 385 grid. The original download
contains 447 CFL3D and 447 FUN3D surface samples; only the FUN3D zone is shown.
The cutoff selects published samples without interpolation. The full volume mesh
is not present and no temporal measurements are invented. The fixed chart limits
exclude the leading-edge skin-friction singularity from the visible range; the
source and pipeline retain it. Data source, hash and licence are recorded in
`examples/assets/sciviz/pipeline/source.json` and `THIRD-PARTY-NOTICES.md`.

Behavioural reference: Schroeder, Martin and Lorensen's published VTK pipeline
description separates sources, filters and sinks, uses demand-driven execution,
and reuses unchanged upstream results. These behaviors are demonstrated directly
by deterministic call counts, with time and cancellation additionally tested.
No runtime rival comparison or speed claim is made. Core and stage are unchanged.

## Grid contours (batch 172 job 2)

The optional `/contour` entry provides `contourGrid(grid, levels, {signal})` and
`contourGridGPU(compute, grid, levels, {signal})`. Both return owned triangle and
independent-line arrays, original cell IDs, level indices and an absolute coordinate
float bound. `contourOperator(compute?)` registers the same operation in a
`FilterPipeline`, with a grid input and JSON `{levels}` parameters. Multiple levels,
including repeated levels, retain their supplied order. Empty inputs return empty
sets with zero bounds. Nothing imports a renderer or creates a device on import.

VTK tetrahedra (10), convex planar-faced hexahedra (12), wedges (13) and pyramids
(14) use pulling tetrahedralization ordered by global point ID. Each quadrilateral
face is fanned from its smallest global vertex. Adjacent cells therefore restrict
to the same triangulation, regardless of local winding, including mixed cell
types. The field is piecewise linear on those tetrahedra, rather than trilinear in
a hexahedron. VTK triangles (5) and quads (9) produce isolines with the same face
rule. Flat normals are the normalized scalar field gradient in each tetrahedron.
The 16 sign cases produce zero, one or two triangles; the two-triangle case uses
a fixed diagonal. Equality belongs to the high side; symbolic vertex identities
remove collapsed and duplicate primitives. An entirely constant level cell has no
boundary surface. First cell order owns exact duplicate primitives.

The CPU snapshots coordinates, scalars and levels to f32. The GPU path prepares
topology and field gradients on the CPU, then performs every edge intersection in
an actual `@margoengine/compute` kernel, in bounded batches of approximately 4096
vertices. CPU compaction copies GPU positions and never recomputes intersections.
This deliberately avoids atomics and variable-length writes on both supported
backends. Topology uses identical comparisons, and normals use the same snapshot;
only coordinates differ. The reported absolute coordinate envelope is the maximum
over crossing edges of `32 * 2^-23 * max(1,maxAbsEdgeCoordinate) *
(1 + maxAbsEndpointScalarOrLevel / abs(endpointScalarDifference))`. It covers
subtraction, division and interpolation rounding, including cancellation, relative
to rounded input. It excludes input quantization, discretization and geometric
model error. Close scalar differences can produce a conservative large envelope;
this is reported rather than hidden behind a fixed tolerance. GPU tests also
retain the actual maximum observed difference.

Limits: 1000000 points, 256 levels and 10000000 output vertices per request.
Finite f32 inputs must be zero or have magnitude between 1e-18 and 1e18, avoiding
GPU subnormal behavior and interpolation overflow. Rescale physical units when
needed. Arrays must match their point/cell counts; repeated cell indices and
degenerate simplices reject with coded errors. Convexity and planar faces are the
input contract. Snapshot validation is synchronous; topology/intersection batches
yield for cancellation, including cells with no intersections. Cancellation during
readback releases temporary arrays and propagates the exact reason. The compute
context remains caller-owned; returned arrays need no disposal. Output and duplicate
tracking consume memory proportional to the requested output. No Rust/Wasm gain or
elapsed speed claim is made during the deferred speed phase.

The NASA demo uses the original 20449-node, 20166-quad FUN3D SA eddy-viscosity slice
at x=0.3, with levels 0.1, 1, 5, 10, 20 and 40. Narrow ribbons render its independent
isolines through the existing mesh layer. The source is genuinely a 2D slice of a
3D calculation; no extruded or invented volume data is presented. Original bytes,
hash, URL and public-domain attribution accompany the asset. Analytic volume cells
exercise isosurfaces separately. The CPU tests prove all sign cases, section areas,
field gradients, shared face intersections, equalities, pipeline integration,
validation and abort reasons. Browser tests dispatch on WebGPU and WebGL2, compare
all output coordinates and topology, and check visible NASA output.
The NASA Tecplot slice contains collapsed quads representing triangular boundary elements. The demo parser retains one original cell ID for each element while converting those rows to VTK triangle cells; the original data is never modified. The provenance test covers this format conversion. Both GPU backends produced 2352 segments and maximum position delta 5.960464477539063e-8; the documented envelope was 0.0037318677496081375. The render check counted 7407 visible pixels on each backend.

## Clip, threshold and structured subsets (batch 172 job 3)

The optional sciviz/clip entry exports clipGrid, thresholdGrid, isoVolume, imageGrid,
extractSubset and clipOperator. Inputs are AnalysisGrid (the existing unstructured
layout plus named arrays) or AnalysisImage (dims and sample bounds, optionally
explicit curvilinear xyz). The original volume cell types, triangles and quads
are supported. Images have two or three active axes and at most 1000000 samples.
Named arrays contain flat interleaved tuples; width is inferred from the associated
point or cell count. pointData/cellData are the default scalar arrays. All arrays
and original cell IDs survive filtering. Output arrays are owned Float64Array,
Uint32Array and Uint8Array values; callers must leave borrowed inputs unchanged
until the promise settles. sourceCells composes original cell IDs across filters.
Do not use an empty string as a named-array key; that key is reserved internally
for the default scalar association.

clipGrid retains the positive side of a plane dot(normal,p)+offset, the interior
of a box or sphere, or scalar values at least the selected value. invert defaults
to false. Plane normals need not be unit length. Box bounds are finite and ordered;
sphere radius must be positive. Scalar clips require a finite scalar point array.
A sphere evaluates radius squared minus distance squared at sample vertices and
clips the piecewise-linear interpolant on each tetrahedron; a sphere entirely
inside one coarse cell can be missed when all its vertices evaluate outside.
This is the sampled-implicit convention used by marching-cell scientific filters,
not an analytic curved boundary reconstruction. Refine the input grid for curved
boundaries. Boxes instead apply six halfspaces sequentially, so an interior box
is retained even when none of the original cell vertices lies in it. Inverted
boxes generate disjoint complement pieces, not overlapping independent clips.

Volume cells use job 2's globally ordered pulling simplices. Each retained convex
simplex polytope clips its faces and adds a cap, then uses a global-ID pulling fan
without adding interior points. Canonical shared-edge intersections merge by source
point IDs; exact level vertices reuse their original identities. Zero-volume cut
pieces are omitted. Every new point interpolates all point tuple components with
the same parameter, and every new cell retains all source cell tuples. Float64
arithmetic is used throughout. Surface cells similarly produce exact clipped
triangles. Equalities are included in both closed halfspaces; shared zero-measure
boundaries do not duplicate positive volume. isoVolume applies two scalar clips,
retaining the inclusive interval of the piecewise-linear field, rather than
retaining complete cells whose scalar samples merely fall within the interval.

crinkle defaults to false. When true, clipGrid retains entire original cells
intersecting the retained region rather than introducing cut points. Plane and
sampled-sphere crinkle use the node sign convention. Box crinkle obtains original
cell IDs from the exact six-halfspace cut, including boxes inside a cell.
thresholdGrid retains complete original cells in a finite inclusive scalar range.
association defaults to point; point mode defaults to all vertices in range, with
any available explicitly. Cell mode uses one selected scalar per cell. invert
negates the complete selection. Nonfinite threshold samples fail the range test;
nonfinite scalar clip values reject rather than generate undefined intersections.

extractSubset uses inclusive index ranges and positive integer strides. Defaults
are the full extent and unit strides. The last output sample is the final stride
position within the range, not necessarily the supplied upper index. Cartesian
bounds retain signed physical spacing; explicit curvilinear coordinates are copied
exactly and their physical bounds recomputed. Point tuples follow sampled indices.
Each output cell tuple comes from the source cell at that output cell's lower
logical sample, clamped at a singleton boundary; it is not an average across a
stride-sized region. A planar subset remains drawable as quads via imageGrid.
Single-axis subsets may be returned as data, but imageGrid requires two active
axes for surface/volume cell materialization.

All async operations accept AbortSignal; bounded loops yield and preserve the exact
abort reason. Validation, image materialization and final compaction are synchronous.
There is no hidden device, GPU compute path or persistent resource to dispose.
clipOperator registers clip, threshold, isoVolume or subset as a pipeline filter;
params contain operation and shape/range/options as finite JSON. Inputs remain
borrowed and output arrays can be retained until normal graph invalidation.

The demo renders real NASA cut triangles and a calibrated CT-ORG scalar threshold
on both WebGPU and WebGL2. The CT-ORG case 0 mirror is pinned by revision and SHA256;
the committed 64x64x19 int16 sample array takes every eighth x/y and fourth z sample
from the downloaded 512x512x75 NIfTI. Its original slope/intercept map to HU. No
averaging or invented samples are added. This sampling can omit thin structures;
the threshold is not an anatomical segmentation. The mirror's int16 encoding is
not claimed bit-identical to the publisher's float32 encoding. CC BY 3.0 citation,
transformation, orientation, physical bounds and hashes are in source.json.

Job 3 rendered evidence: both backends retain 3349 CT cells at 300 HU and 106 at 1000 HU; the before/after renders contain 35385 and 3833 non-background pixels. The lower NASA slice cut contains 27594 triangles and 51982 non-background pixels. CT display colour is the maximum vertex HU in each selected cell; this is derived display data and leaves the retained point arrays unchanged. The NASA data plane is viewed along scene +y because figure data x/y maps to scene x/-z.

## Probe, integrate and resample (batch 172 job 4)

The optional sciviz/probe entry provides an owned CellLocator snapshot with using /
Symbol.dispose, probeGrid for a one-off query, plotOverLine, integrateGrid,
resampleDataset, resampleToImage, linkProbePlot and probeOperator. All building or
batch work accepts AbortSignal; exact reasons propagate and partially created plot
layers are removed on failure. Figures and caller arrays remain caller-owned.
Snapshot copying, image materialization and individual cell solves are synchronous;
index construction and sample/integration batches yield between bounded groups.
Inputs are limited to 8000000 points, line profiles to 1000000 samples.

Regular images keep implicit topology and sample by direct index arithmetic,
including signed bounds, bilinear planes and singleton axes. Unstructured and
curvilinear grids use uniform spatial buckets (up to 32 per axis). A cell spanning
more than 128 buckets stays in a separate candidate list. Only that bucket's cells
and spanning cells are tested, in ascending current cell order. Shared boundaries
choose the lowest current cell ID; sourceCell retains original provenance. Outside
queries return null, with no extrapolation. Rebuild a locator after changing input;
its arrays and topology are snapshots, so later caller mutations have no effect.

Tetrahedra, triangles and line cells use barycentric/affine coordinates. Quads,
wedges and pyramids use the same globally ordered piecewise-linear simplices as
contours/clipping. Hexahedra use genuine trilinear shape functions in a unit cube,
with a 24-step bounded Newton inversion of the physical isoparametric mapping.
Regular image samples use tensor-product interpolation directly. Named vector
and scalar point tuples are interpolated component by component; cell tuples are
copied from the containing cell. Missing values propagate only from nonzero-weight
vertices. Geometry is finite, convex and nonfolded; exact predicates and arbitrary
ill-conditioned inverse maps are not claimed. Barycentric membership allows 64 f64
machine epsilons in reference coordinates. Surface/line residual and hexa convergence
use 128 epsilons times max(1, maximum absolute coordinate). This is an arithmetic
membership envelope, not a physical extrapolation distance or discretization bound.

plotOverLine samples the entire polyline at equal arc-length positions, including
both endpoints (default 101). It returns physical distance, xyz, containing cell
IDs, valid masks, all named tuples and default scalar arrays. Missing tuples are
NaN and their cells -1. linkProbePlot renders valid contiguous runs as separate
2D chart lines, avoiding artificial connections across holes, plus a 3D path and
marker. Chart pointer hover moves that marker; moveTo(index) also supports keyboard
or external controls. dispose removes its own layers and listener, leaving both
figures alive. The profile and its arrays must remain unchanged while linked.

integrateGrid returns separate length, area and volume records, each with measure
and point/cell field integrals. Different physical dimensions are never added.
Line lengths, triangle areas and tetra volumes use analytical geometric measures;
linear simplex field integrals use their exact barycentric means. A hexahedron
uses 3x3x3 Gauss-Legendre quadrature of trilinear shape functions times the physical
Jacobian determinant. This exactly integrates the polynomial field/Jacobian product
for a nonfolded trilinear cell, to f64 arithmetic precision. Jacobian signs must
agree at quadrature points; degenerate or inconsistent samples reject. Quads,
wedges and pyramids integrate their pulling-linear fields. Point cells contribute
no length, area or volume. Empty named arrays infer width one and integrate to zero.
All other tuple widths are inferred from associated counts.

resampleDataset copies target geometry, provenance and target cell arrays, replacing
its point fields with source fields sampled at each target point. valid/cells mark
coverage. sampledCellData and sampledCellArrays separately retain source cell fields
at those target points, preventing collisions with identically named point arrays.
resampleToImage supplies regular target geometry from dims/bounds; its dimensions
span first/last samples and preserve signed spacing. No conservative remapping of
cell averages, extrapolation outside coverage or interpolated categorical labels
is implied. probeOperator adapts probe, line, integrate, image and resample to lazy
pipeline operations; a locator is created and disposed inside each execution.

The real-data demo probes the NASA bump slice along a 101-sample path, integrates
its original surface and resamples onto a line dataset. It also loads the existing
CC0 OpenNeuro T1, resamples to a 32x32x32 image for the volume view, and plots the
original T1 along its physical-mm centre line. Both profiles link chart hover to
3D markers. Source data/attribution are shared with the preceding entries and the
existing head.nrrd/head.json assets; no new downloaded implementation is used.
The browser checks actual pointer events, marker positions, dataset/profile sample
identity, resampled coverage, visible data and owned-layer disposal on both backends.

## Calculator and derived arrays
The optional @margoengine/sciviz/calc entry exports calcGrid, calcGridGPU and calcOperator. Inputs are AnalysisGrid snapshots with convex linear VTK vertex, line, triangle, quad, tetrahedron, hex, wedge and pyramid cells. CalcOperation selects expression, gradient, pointToCell, cellToPoint, centers, connectivity, elevation or quality. Results contain flat owned values, tuple width, association, per-value absolute floatBound and grid. With options.name the grid borrows the original topology/arrays and attaches the new named tuple array. Existing default scalars stay selected. Cancellation preserves the exact AbortSignal reason.
Expressions default to point association; cell association uses vertex-average cell coordinates. Named arrays use identifiers or backtick-quoted names. value selects the default scalar; coords and x/y/z select coordinates. pi, e and iHat/jHat/kHat are constants. +, -, *, / and % broadcast scalars over tuples; ^ is right associative and binds tighter than unary minus. % is floor remainder. Functions: vec(x,y,z), dot, cross, mag, normalize, abs, sqrt, sin, cos, tan, asin, acos, atan, atan2, exp, log, log2, floor, ceil, sign, min, max, pow and clamp. [integer] selects a component. Coordinate/default/constant names are reserved and override a same-named input array. There are no assignments, properties, JavaScript execution or caller functions. Nonfinite results and unbounded f32 conditioning reject; zero-vector normalization rejects. GPU sqrt clamps a rounded negative intermediate to zero only after the CPU domain check, with its error in the bound. At most 4096 expression characters, 512 parsed expressions, 64 nesting levels, 64 input components and 1000000 points/cells.
Point gradients are least-squares fits across each cell's vertices, output per cell and ordered [d(component0)/dx,dy,dz, component1...]. Cell gradients use the current cell and all cells sharing one of its vertices. An orthonormal geometric basis determines rank (relative cutoff 1e-12); unresolved normal directions have zero derivative. The shared f32 point/array snapshot and f32 fit weights define parity; this bound excludes input quantisation, weight construction error and spatial discretisation. Surface gradients are minimum-norm tangential gradients. Affine fields are tested on tetrahedra, tilted triangles and lines. Point/cell transfers use equal incidence weights and retain every component; isolated target points yield zero. centers are vertex averages (parametric centres), not volume centroids. connectivity labels cells connected through any shared point, with components numbered by their lowest current cell ID. Labels/topology are CPU union-find on both paths; the GPU path does the numeric materialisation, not GPU graph discovery.
Elevation is clamped projection from low to high, mapped to range (default [0,1]); coincident endpoints reject. quality returns [edge aspect, corner skew, corner Jacobian]. Aspect is longest/shortest incident edge; skew is the largest absolute difference between incident-edge cosines and the reference cosine (0.5 for triangles/tetrahedra, zero for other cells); Jacobian is the minimum consistently ordered corner triple determinant. Surface Jacobians are unsigned parallelogram areas. Vertex/line convention is [1,0,0]. These explicit algebraic metrics are not VTK/Verdict metric names or a proof that a curved/interior hex is unfolded. Singular edge conditioning rejects. Highly stretched NASA elements retain finite bounds using per-edge intervals rather than a largest-edge absolute error for every denominator.
GPU numerical work is executed by @margoengine/compute: expression nodes become scalar WGSL DAGs; transfers, centres and gradients become bounded sparse reductions. The CPU prepares topology, fit coefficients and quality corner edges/extrema and evaluates the forward-error reference. Returned GPU values come from GPU readback, never substituted CPU output. All resources are disposed in finally blocks; the caller's context stays borrowed. Error propagation includes local WGSL rounding/elementary-function allowance, conditioning, reduction absolute sums and subnormal flushing. No speed claim or Wasm gain is made. calcOperator params are the same operation plus optional name; its result can feed another calculator by selecting result.grid.
Real-data demo: examples/sciviz-calc.html computes the NASA FUN3D eddy-viscosity least-squares gradient and a user-editable cell expression, rendered as a coloured surface. calc-browser.mjs compares every requested filter and all grammar function groups on WebGPU and WebGL2, including the original NASA cells.
