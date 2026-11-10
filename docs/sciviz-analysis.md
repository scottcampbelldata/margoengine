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
