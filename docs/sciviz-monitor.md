# Figure allocation reporting and limit sweeps

The optional `@margoengine/sciviz/monitor` entry provides `installFigureStats(figure)`.
The returned figure has a typed `stats: FigureStats` property. Installation is explicit,
idempotent and adds no frame hook. `stats.snapshot()` returns JSON-safe live per-layer
counts and memory. Disposing a monitor is supported through `dispose()` or `Symbol.dispose`.
The existing `/stats` entry continues to provide statistical charts.

Standard scatter, line, surface, volume, slice, isosurface, rectangle and graph layers
provide inventories. A volume's slices are discovered through their parent. Point and
line GPU resources are absent before first rendering, appear after allocation, disappear
on release and are read from the replacement device after restoration. Shared engine
frame buffers, targets, pipelines, shader modules and driver allocations are excluded.
Isosurface extraction scratch buffers are temporary and excluded from retained inventory.
The resource getters in points and lines are internal hooks for the optional monitor.

`gpuBytes` sums live buffer descriptor sizes and uncompressed texture texels, including
mips and multisampling. It is a payload count, not physical GPU memory. `jsDataBytes`
counts complete retained ArrayBuffer backing stores, deduplicated by identity, including
overlapping views. This includes the full backing store of a small view. Ordinary numeric
arrays have an eight-byte-per-element estimate in `jsArrayBytesEstimate`, kept separate.
Neither value claims to measure GC heap overhead, objects, DOM, driver copies or process
RSS. Per-layer values may overlap; figure totals deduplicate across all layers.

An external table or custom optional layer uses `stats.track(key, adapter)`, with live
`resources()` and optional `counts()` and `name`. `stats.trackTable(table, name)` adapts the shared ColumnarTable API, including int64 columns and validity bitmaps. Dictionary strings and object overhead are excluded. The returned function unregisters it.
Known counts are points, voxels, cells, edges and rows. A custom layer without an inventory
is explicitly marked `inventoryAvailable: false`, and `unreportedLayers` counts it.
Unknown storage is never silently treated as a complete zero-byte inventory. Adapters
must enumerate extension resources and any storage they retain outside the standard layer.

`sweepLimits(options)` accepts an increasing positive `sizes` array, a cancellable
`prepare(size, signal)` returning a frame/stats/dispose case, environment metadata and a
per-size hard limit (120000 ms by default). It renders each allocation-mode size once,
captures counts/memory, preserves coded failures, and stops at the first failure or the
plan's size ceiling. A reached ceiling is a censored observation, never a hardware limit.
Outer process-tree deadlines also cover browser/driver or cleanup hangs. Callers honor
the supplied signal; a late preparation result is disposed after cancellation.

Timed mode is opt-in: `timing: true`, `frameBudgetMs: 16.7`, `warmupFrames: 3` and
`sampleFrames: 9` by default. Load includes preparation and the first completed frame.
The frame samples include queue completion in the supplied browser fixtures, so they
measure CPU/driver/GPU latency rather than GPU timer-query execution time. The report
retains every sample, its minimum and median, the first median above budget, and continues
until failure or the size ceiling. It never drops a slow or failed row. Correctness tests
prove this state machine using an injected deterministic clock through the test runner.
No timed sweeps are run during the deferred build phase.

Run allocation observations from the repository root after building packages:
`node scripts/gpu-lock.mjs run --owner=sciviz-limits --gpu=sciviz-allocation-renders --max=3 --wait-max=60 -- node packages/sciviz/tests/limits-browser.mjs`.
`--backend=webgl2` selects the complete shared fallback. `--kind=points --sizes=1000,10000,100000`
selects a custom increasing scale plan. `--output=path.json` selects the JSON destination.
`--timed` refuses while `scripts/speed-phase.json` says `deferred`; it is for the later
quiet speed phase. These are tool commands, not README examples.

The two versioned schemas are `margo-sciviz-limits/1` (one sweep) and
`margo-sciviz-limit-suite/1` (scene and format collections). Metadata records source
commit, implementation/fixture source digest, working-tree state, GPU adapter information,
browser, host, CPU utilization fraction and diagnostic status. Browser APIs do not expose
the driver version here; the JSON says so. The records in
`docs/whitepaper/sciviz-limits-allocations.json` are readable by the batch 182 page.
They contain allocation evidence with `timingOwed: true`, never invented speed limits.
The stored evidence wrapper is `margo-sciviz-limit-evidence/1`; its `observations` array
holds the native and compatibility suite records without changing their schema.

The fixed fixtures use real 2MASS stars, the OpenNeuro head, NOAA wind and NYC TLC rows.
Larger scales explicitly repeat rows/points or resample voxels. Graph connectivity joins
consecutive source indices and is a storage/draw fixture, not an astronomical relationship.
Format loads fully read NRRD, CDF-1, CDF-2, three VTK XML geometries, legacy VTK and CSV.
Every record preserves the actual file byte size. Additional format/size plans use the
same public sweep API; absent real assets do not produce a fabricated observation.
Existing sources retain their provenance in `examples/assets/sciviz`; the new table's
query, original bytes, hash and public-use terms are in `limits/source.json`.
