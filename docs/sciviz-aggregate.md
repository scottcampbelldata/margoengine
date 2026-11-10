# Exact spatial aggregation

Batch 175 job 3 adds the optional `@margoengine/sciviz/aggregate` entry. `aggregateRaster`
accepts a `ColumnarTable` or `CrossFilter`, physical bounds, dimensions and coordinate
columns. It returns count, finite-value count, sum, mean, min, max, first, last,
first/last source row and dictionary category counts together. `bin` and `at` inspect
the original statistics. `shadeAggregate` transforms only display colours.

Each row describes one point, segment, area trapezoid, triangle or quad cell. Segment
endpoints use x1/y1; triangles also use x2/y2; quads also use x3/y3. Area lower
boundaries default to zero and can have separate baseline columns at both endpoints.
Mesh values are cell values. Polygon bins use the pixel centre and the even/odd rule;
segments use pixel-box intersection. A primitive contributes once per covered bin.
Point coordinates include the final upper domain edge. Missing coordinates exclude
the primitive. Missing or nonfinite values exclude only numeric statistics, so count
can exceed valid. Category nulls do not enter categorical counts. Empty numeric bins
have NaN statistics, except the additive identity sum = 0. First/last follow source
row order among finite values, independently of chunking and filtering.

The GPU receives every row's projected geometry and original binary64 value words.
One invocation owns each bin, tests every row in the chunk, and computes all statistics
without float atomics or competing writers. Positive and negative base-65536 integer
superaccumulators each have 134 words. A chunk has at most 65536 rows, so each word
holds at most 65536 * 65535 = 4294901760, below uint32 overflow. Partial integer
accumulators merge on the host using BigInt; sum and rational mean round once to
binary64 nearest-even. Cancellation, subnormals, intermediate overflow and large
integer counts do not lose information. Geometry uses projected f32 pixel coordinates;
point projection preserves the f64 bin owner at a neighbouring f32 boundary. Numeric
values never convert to f32. The CPU reference uses the same raster coverage rules and
exact integer sum. A CPU compute context also selects that reference.

`bindRasterAggregate` attaches a 2D figure trace. Wheel/pan completion and crossfilter
changes revisit the original rows. Programmatic limit changes use `refresh()`, which
is also the explicit error/completion boundary. The latest refresh supersedes older
work; disposal and AbortSignal release the trace, tooltip and listeners. Hover shows
all original bin statistics. Display transformations are empirical histogram
equalisation with equal-valued ties, normalised log1p, cube root and linear. Circular
spreading fills empty display pixels and leaves the numerical bins untouched.

## Bounds and evidence

Dimensions default to 256 by 256; each edge is 1..4096 and at most 1048576 bins are
accepted. Category storage is limited to 16777216 bin/category cells. GPU partial
storage is `bins * (280 + categories) * 4` bytes and must fit the device's storage
binding limit. Staging defaults to 32768 rows, with at most 8388608 row/bin tests in
one dispatch. Input table arrays are borrowed. Unfiltered staging is bounded independently
of row count; a CrossFilter adds its stable selection bitmap snapshot, ceil(rows/32)*4 B,
included in peakStagingBytes. Nonexact int64-to-number numeric conversions reject and require rescaling.
This is an exhaustive row/bin algorithm, O(rows * bins), not an indexed spatial query.
Antialiased fractional coverage and interpolated vertex values are outside this
cell-value aggregation contract. No wall-clock speed or billion-row interactivity
claim is made.

The demo `examples/sciviz-aggregate.html` uses 4096 original NYC TLC 2015 pick-ups and
600 original GBIF occurrences, split equally between CC0 and CC BY 4.0. Source queries,
SHA-256 hashes and row attribution are in `packages/sciviz/tests/fixtures/aggregate/manifest.json`
and the retained records. These are standard data, not software from another repository.

`packages/sciviz/tests/aggregate.test.js` covers cancellation, validation, cancellation
through extreme binary64 values, all glyphs, ordered/missing/category semantics,
filtering, zoom, hover and nonmutating shading. `aggregate-browser.mjs` compares every
typed statistic on both backends, checks rendered changes and real-data zoom, and
asserts zero CPU compute dispatches on WebGL2.

The WebGPU scale check processes 100000000 physical rows, repeating the 4096 original
taxi coordinates with integer-cent fares. This is explicitly not 100 million distinct
trips. The independent original-coordinate/integer-cent oracle matches every bin's
count, valid, sum, mean, min, max, first and last. Retained run:
`docs/whitepaper/results/batch175-aggregate-webgpu.json`. Input arrays total 2400000000 B;
the logical live buffer bound is 8442384 B; partial output 17920 B; 1526 dispatches; 1600000000 row/bin
tests; all 100000000 rows contribute. Both-backend small results are retained alongside
it. These are deterministic correctness/work measurements, not speed measurements.
The buffer bound includes host records, uploaded records, GPU output, mapped readback,
returned copy, uniforms and an optional filter bitmap. It excludes compiler/driver memory
and transient JavaScript garbage; it is not physical VRAM or total process memory.

Reproduce with package build, CPU `aggregate.test.js`, then the shared GPU lock around
`node packages/sciviz/tests/aggregate-browser.mjs`. `--small` omits only the separate
100M stress case during development. The landing run includes it. Quiet-machine
wall-clock evidence remains in the deferred speed phase.

## Clean-room sources and choices

- Eleni Tzirita Zacharatou, Harish Doraiswamy, Anastasia Ailamaki, Claudio T. Silva and
  Juliana Freire (2017), [GPU Rasterization for Real-Time Spatial Aggregation over
  Arbitrary Polygons](https://www.vldb.org/pvldb/vol11/p352-zacharatou.pdf). Supplies
  the spatial-to-raster query model. We use exhaustive bin ownership rather than its
  approximate polygon-index tradeoff.
- Radford M. Neal (2015), [Fast Exact Summation Using Small and Large Superaccumulators](https://arxiv.org/abs/1505.05571).
  Supplies the exact fixed-point representation and delayed carry principle; this
  implementation uses separate unsigned 16-bit limbs to fit WGSL u32 operations.
- James Demmel and Hong Diep Nguyen (2013), [Fast Reproducible Floating-Point Summation](https://www.acsel-lab.com/arithmetic/arith21/papers/p54.pdf).
  Compared reproducible bounded floating accumulators; chose exact integers because
  arbitrary cancellation and full binary64 range are required here.
- HoloViz contributors (2026), [Datashader Pipeline](https://datashader.org/getting_started/Pipeline.html),
  [Inspection Reductions](https://datashader.org/user_guide/Inspection_Reductions.html),
  [Grids](https://datashader.org/user_guide/Grids.html) and [Trimesh](https://datashader.org/user_guide/Trimesh.html).
  Public behaviour descriptions establish independent numerical bins, ordered
  selection reductions, mesh cells and separate shading. No implementation source read.
- Alan Baker, Mehmet Oguz Derin and David Neto, editors (2026), [WebGPU Shading Language](https://www.w3.org/TR/WGSL/).
  Governs bitcasts, u32 operations, local arrays and storage layout. No companion code read.

Measured optional entry: 0 -> 28201 B min+gzip, ceiling 29019 B. It includes the complete CPU/GPU accumulation and figure/shading lifecycle. A split would fragment coverage and trace ownership; core/stage remain 24209 B unchanged.
