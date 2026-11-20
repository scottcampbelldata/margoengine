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
One invocation owns each bin and slice of at most 512 rows of the chunk, tests those
rows in order, and computes all statistics without float atomics or competing writers;
a second pass folds each bin's slice records in slice order (sums and counts add,
min and max compare, first comes from the first slice with a value and last from the
last), which gives the same record as one invocation testing every row of the chunk.
Slices keep each invocation short: Chrome on ANGLE's Metal back end drops a draw whose
single invocation runs too long, with no error and no context loss, so on the WebGL2
layer an 8 x 8 raster's default 32768-row chunk tested by one invocation per bin read
back all zeros (with the earlier hardware-float coverage too). On an Apple M6 the
dropped invocations were about 3,500 rows of segment coverage; a slice is 512. The slice
records take bins * slices * (280 + categories) * 4 B of GPU storage, where slices is
ceil(rows in the chunk / 512); when they would not fit one storage binding the chunk is
shortened instead. Positive and negative base-65536 integer
superaccumulators each have 134 words. A chunk has at most 65536 rows, so each word
holds at most 65536 * 65535 = 4294901760, below uint32 overflow. Partial integer
accumulators merge on the host using BigInt; sum and rational mean round once to
binary64 nearest-even. Cancellation, subnormals, intermediate overflow and large
integer counts do not lose information. Geometry uses projected f32 pixel coordinates;
point projection preserves the f64 bin owner at a neighbouring f32 boundary. Segment and
polygon coverage is IEEE 754 binary32 arithmetic rounded to nearest even. The GPU does
that arithmetic in u32 integer operations, because WGSL lets f32 hardware choose its
rounding direction, fuse a multiply and an add, reassociate, flush subnormals and divide
within 2.5 ULP; one ULP decides a pixel centre that lies exactly on an edge, and an Apple
GPU's divide counted such a centre inside a quad that the reference left out. Numeric
values never convert to f32. The CPU reference uses the same raster coverage rules, with
each step rounded by Math.fround from float64 (equal to direct binary32 rounding for add,
subtract, multiply and divide), and the exact integer sum. A CPU compute context also selects that reference.

`bindRasterAggregate` attaches a 2D figure trace. Wheel/pan completion and crossfilter
changes revisit the original rows. Programmatic limit changes use `refresh()`, which
is also the explicit error/completion boundary. The latest refresh supersedes older
work; disposal and AbortSignal release the trace, tooltip and listeners. Hover shows
all original bin statistics. Display transformations are empirical histogram
equalisation with equal-valued ties, normalised log1p, cube root and linear. Circular
spreading fills empty display pixels and leaves the numerical bins untouched.

### Review L2: density-controlled spreading (2026-11-10)

With `density`, inspect the unspread image first, then circular radii 1 through `spread`.
Stop at the first image where the requested fraction of occupied pixels has at least
one occupied neighbour among the eight surrounding pixels, or at the maximum radius.
Each candidate dilates the original pixels, so growth never compounds beyond the cap.
An isolated interior mark with `spread: 4, density: 0.5` produces the five-pixel
radius-1 footprint instead of the 49-pixel radius-4 disc. Empty images remain empty;
edges clip the disc and a one-pixel image terminates at the cap. Statistics and hover
retain their original bins. Without `density`, fixed-radius behaviour is unchanged.

Clean-room sources compared: HoloViz contributors, Datashader Pipeline and API
(2026 retrieval), https://datashader.org/getting_started/Pipeline.html and
https://datashader.org/api.html (occupied pixels with neighbours and bounded dynamic
spreading); Henk J. A. M. Heijmans, Mathematical Morphology: A Modern Approach in Image
Processing Based on Algebra and Geometry (1995), https://doi.org/10.1137/1037001
(dilation and iteration); Florian Heimerl, Chih-Ching Chang, Alper Sarikaya and Michael
Gleicher, Visual Designs for Binned Aggregation of Multi-Class Scatterplots (2018,
revised 2020), https://arxiv.org/abs/1810.02445 (separating aggregation from display).
Combine bounded circular dilation with the neighbour-presence fraction, keeping the
original aggregate immutable. No companion or rival implementation source was read.
The two density regressions in aggregate.test.js fail before the repair and cover
isolated, dense, empty, edge and one-pixel images afterward. aggregate-browser.mjs
checks shading and retained statistics with native WebGPU and WebGL2.

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
typed statistic on both backends, checks rendered changes and real-data zoom,
asserts zero CPU compute dispatches on WebGL2, and runs one default chunk (32768 rows)
of lines, triangles and quads through pixel-centre ties on an 8 x 8 raster.

The WebGPU scale check processes 100000000 physical rows, repeating the 4096 original
taxi coordinates with integer-cent fares. This is explicitly not 100 million distinct
trips. The independent original-coordinate/integer-cent oracle matches every bin's
count, valid, sum, mean, min, max, first and last. Retained run:
`docs/whitepaper/results/batch175-aggregate-webgpu.json`. Input arrays total 2400000000 B;
the logical live buffer bound is 10736160 B; slice records 2293760 B; partial output 17920 B; 3052 dispatches (row slices and a merge per chunk); 1600000000 row/bin
tests; all 100000000 rows contribute. Both-backend small results are retained alongside
it. These are deterministic correctness/work measurements, not speed measurements.
The buffer bound includes host records, uploaded records, slice records, GPU output, mapped readback,
returned copy, uniforms and an optional filter bitmap. It excludes compiler/driver memory
and transient JavaScript garbage; it is not physical VRAM or total process memory.

Reproduce with package build, CPU `aggregate.test.js`, then
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
  Governs bitcasts, u32 operations, local arrays and storage layout; sections 15.7.4 (floating
  point accuracy) and 15.7.5 (reassociation and fusion) are why coverage avoids hardware f32. No companion code read.
- IEEE Computer Society (2019), [IEEE Standard for Floating-Point Arithmetic, IEEE 754-2019](https://doi.org/10.1109/IEEESTD.2019.8766229).
  Defines the binary32 format and round-to-nearest-even results the integer operations reproduce. Not read in
  full (paywalled); the definitions used are those WGSL 15.7.4 restates.
- Samuel A. Figueroa (1995), [When is double rounding innocuous?](https://doi.org/10.1145/221332.221334), ACM SIGNUM
  Newsletter 30(3). States that rounding a float64 sum, difference, product or quotient of binary32 inputs to
  binary32 equals direct binary32 rounding, which the CPU reference relies on. Not read; the property was checked by
  3,000,000 random and edge-case operand pairs (zeros, subnormals, infinities, NaN, ties) of the integer operations
  against Math.fround, with no mismatch.

Measured optional entry: 0 -> 28201 B min+gzip, ceiling 29019 B. It includes the complete CPU/GPU accumulation and figure/shading lifecycle. A split would fragment coverage and trace ownership; core/stage remain 24209 B unchanged.

Integer binary32 coverage and row slices (2026-11-15): 28228 -> 29742 B min+gzip (+1514 B), ceiling 29019 -> 30635 B. 1081 B are the WGSL integer add, multiply, divide, rounding and ordering functions that make GPU coverage equal the CPU reference on every GPU; 433 B are the slice plan and the merge kernel that keep each invocation to 512 rows. Both run inside the aggregation itself, so a separate entry would only move them; core + stage is unchanged.
