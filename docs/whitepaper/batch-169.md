# Batch 169: deterministic work-count phase

No wall-clock benchmarks or budget changes. Timing pending the quiet rerun.

| Job | Package | State | Evidence |
| --- | --- | --- | --- |
| 1 | ui | DONE in `perf(ui): memoize intrinsic layout per call` | 24 to 2 leaf measurements; identical layout bytes; five Yoga oracle fixtures |
| 2 | text | DONE in `perf(text): reuse logical kerning and shaped prefix advances` | 1198 to 599 pair calls; 35 to 18 prefix calls; 35 byte-identical layouts; Canvas/Troika value oracle |
| 3 | mesh-edit | DONE in `perf(mesh-edit): index subdivision edges numerically` | 1260 to 0 edge-ID parses; 482650 identical bytes; Blender 5.3 vertices match within Float32 |
| 4 | splines | DONE in `perf(splines): rebuild intersection cubics once per curve` | 512 to 64 point evaluations; 1264 identical bytes; three.js Catmull-Rom values within 4.44e-16 |
| 5 | terrain | DONE in `perf(terrain): upload only changed ring uniforms` | 12 to 0 uniform writes on an unchanged frame; identical buffer bytes; source heights exact, clipmap error per level recorded |
| 6 | wfc | DONE in `perf(wfc): gather the full-domain union once` | 6656 to 4608 (heap) and 4608 to 512 (legacy) bit scans; identical solutions and stats; 0 violations |
| 7 | procedural | Pending | Published noise values, Poisson spacing and work count |

## Job 6: wfc full-domain propagation

Cause: each attempt starts with every cell holding every tile and queues every cell. The
TypeScript `HeapWFC` then walked all T tiles of each full cell to OR their allowed
neighbours, and the legacy `WFC` did the same for its unions and again for each full
cell's first entropy. These values are the same for every full cell. Both solvers now
gather the full domain's union (and the legacy full-domain entropy, with the same tile
order and arithmetic) once and copy it. Decisions, the random stream, heap updates and
`stats` are unchanged, so the TypeScript and SIMD solvers still report equal statistics.
The Rust SIMD artifact is not changed.

`packages/wfc/test/full-domain-workcount.test.js` counts bit scans (`Math.clz32`) on a
16 x 16 grid of 8 weighted tiles: heap 6656 to 4608, legacy 4608 to 512. Five tile sets
(open, banded, one with a tile that has no X neighbours, 40 banded tiles, 33 unit tiles),
three seeds, with and without pins, hash solutions, failures and statistics to
`227a189efccb94eeeae817d4681ec68a705aa058211dc6cd02a62ef31324c37e`, captured on the parent.

Constraint-satisfaction oracle (`scripts/bp-169-wfc-oracle.mjs`): banded 8-tile sets on
32 x 32 (weighted and unit weights) and a 40-tile set on 12 x 12 x 4, 20 seeds each, solve
on the TypeScript heap, SIMD heap and legacy solvers with 0 adjacency violations. Gumin's
bitmap samples exercise the overlapping model, which this job does not change; its tests
stay as they are. No rival timing was run.

Reproduce after `npm run build:packages`:
`node --test packages/wfc/test/full-domain-workcount.test.js` and
`node scripts/bp-169-wfc-oracle.mjs`. No time is measured.

Research: M. Gumin, *WaveFunctionCollapse* (2016), algorithm description in its README,
https://github.com/mxgmn/WaveFunctionCollapse (description only); I. Karth and A. M. Smith,
*WaveFunctionCollapse is Constraint Solving in the Wild*, FDG 2017,
https://doi.org/10.1145/3102071.3110566 (arc consistency); A. K. Mackworth, *Consistency in
Networks of Relations*, Artificial Intelligence 8(1), 1977,
https://doi.org/10.1016/0004-3702(77)90007-8. No rival code was read.

## Job 5: terrain uniform uploads

Cause: every frame `Terrain` wrote each ring's 176-byte uniform with `queue.writeBuffer`,
and every shadow cascade and local shadow layer wrote its copy too, even when the camera,
light and shadow matrix had not changed. With three rings, two cascades and one local layer
that is 12 writes (2112 bytes) per frame for a still view. The change keeps the bits each
uniform buffer last received and skips a write whose 44 floats are identical bit for bit
(so -0 and NaN patterns count as changes). Buffers made after a device restore start
empty and always get their first write. Writes that do happen keep their order.

`packages/terrain/test/uniform-workcount.test.js` replays eight frames on the recording
mock GPU: still, moved camera, changed light, changed shadow matrix. Writes per frame are
12, 0, 0, 12, 0, 12, 9, 0 (parent: 12 every frame, 96 in all). The contents of all 12
uniform buffers after every frame hash to
`653e78b09281c96ea35d464ddb70c6a50d61b98c0ba937ef307e3a6ee10a3982`, captured on the parent,
so every draw reads the same bytes. The package's real-GPU suites pass unchanged.

Value oracle (`scripts/bp-169-terrain-oracle.mjs`): `TerrainQuery.height` on a 257 x 257
fbm simplex heightmap equals every source sample times heightScale plus offset exactly
(66049 samples, error 0). The geometry-clipmap triangulation error against the bilinear
surface (Losasso and Hoppe 2004), heights spanning 100 units, per ring spacing of 1, 2,
4, 8 and 16 cells: max 2.27, 8.14, 15.97, 27.17, 62.39; RMS 0.22, 1.24, 3.08, 6.63, 12.89.
The fixture's finest octave repeats every two cells, so these are high-frequency upper
values; smoother terrain gives less. No rival was run for this job.

Reproduce after `npm run build:packages`:
`node --test packages/terrain/test/uniform-workcount.test.js` and
`node scripts/bp-169-terrain-oracle.mjs`. No time is measured.

Research: F. Losasso and H. Hoppe, *Geometry Clipmaps: Terrain Rendering Using Nested
Regular Grids*, SIGGRAPH 2004, https://doi.org/10.1145/1015706.1015799; A. Asirvatham and
H. Hoppe, *Terrain Rendering Using GPU-Based Geometry Clipmaps*, GPU Gems 2 chapter 2
(2005), which updates per-level constants as the view moves; W3C *WebGPU*,
`GPUQueue.writeBuffer` (2026), https://www.w3.org/TR/webgpu/#dom-gpuqueue-writebuffer.

## Job 4: splines curve intersection

Cause: `intersectSplines` rebuilt both segments' exact cubics inside the segment-pair loop.
For non-Bezier kinds each rebuild samples four points with `at`, so two 8-segment curves
ran 512 evaluations: 4 x (8 x 8) per side. The change builds each curve's segment cubics
once per call and reuses the same arrays for every pair; nothing downstream mutates them.
Subdivision, Newton polish, overlap tests, ordering and `maxWork` accounting are unchanged.
No export, option, core/stage byte or optional import changes.

`packages/splines/test/intersect-workcount.test.js` requires 64 `at` calls (parent 512)
and hashes six curve pairs: Catmull-Rom, B-spline against Kochanek-Bartels, two closed
curves, Bezier against Catmull-Rom, identical curves and Hermite against Catmull-Rom.
All 26 points and 7 overlaps (parameters and positions as Float64) retain 1264 bytes,
SHA-256 `769dc0b4158961ab3161e435586b94d1f5dee85cb8aa33fae79536390a6bff0b`, captured on
the parent.

Black-box value oracle: three.js 0.186.1 `CatmullRomCurve3` (type `catmullrom`, tension
0.5), installed outside the repository, against Margo's uniform Catmull-Rom on the same
points at 401 parameters each. Largest coordinate differences: open 9 points 2.50e-16,
shifted 2.22e-16, closed 6 points 4.44e-16, at the floating-point rounding level. three.js
has no curve-curve intersection, so the intersection work has no like-for-like rival row.

Reproduce after `npm run build:packages`:
`node --test packages/splines/test/intersect-workcount.test.js` and
`node scripts/bp-169-splines-oracle.mjs --three=<absolute external three directory>`.
No time is measured.

Research: E. Catmull and R. Rom, *A Class of Local Interpolating Splines*, Computer Aided
Geometric Design (Academic Press), 1974, https://doi.org/10.1016/B978-0-12-079050-0.50020-5;
T. W. Sederberg and T. Nishita, *Curve intersection using Bezier clipping*, Computer-Aided
Design 22(9), 1990, https://doi.org/10.1016/0010-4485(90)90039-F (subdivision by control
hulls, which this solver uses with boxes); W. Wang et al., *Computation of Rotation
Minimizing Frames*, ACM TOG 27(1), 2008, https://doi.org/10.1145/1330511.1330513 (frames
unchanged here). No rival source was read.

## Job 3: mesh-edit subdivision edges

Cause: each Catmull-Clark level keyed edges by canonical string IDs (`"a:b"`), then parsed
those strings back into numbers for every edge point, every vertex-edge incidence, every
UV seam test and every neighbor lookup, and rebuilt two IDs per corner to find the new
quad's edge points. Three cube levels parsed 1260 IDs. The change indexes each edge once
per level by numeric endpoints (lower index first, the same canonical order), keeps the
edge leaving each corner and uses edge indices for seams and edge points. Edge, vertex
and incidence orders are unchanged, so every sum runs in the original order. No export,
option, core/stage byte or optional import changes.

`packages/mesh-edit/tests/subdivide-workcount.test.js` requires zero `":"` parses (parent
1260) and hashes 20 subdivisions (cube, plane, cylinder, wedge and a folded strip with a
UV seam; levels 1 to 3; smooth/linear UVs; smooth/pinned borders). Positions, UVs, face
IDs, loops, face maps and created vertices retain 482650 bytes, SHA-256
`ce11636eb6f157726d6ec7155b57c1d390d10f9563b38ba7c30bc73d7d2433b1`, captured on the parent.

Black-box oracle: Blender 5.3.0 Beta (`C:/blender`, driven through its documented Python
API) applies the Subdivision Surface modifier, Catmull-Clark, limit surface off, creases
off, boundary smooth `PRESERVE_CORNERS`. All vertices of cube, cylinder, wedge and an
open 2x2 grid at levels 1 and 2 match one to one: 26/98, 50/194, 20/74, 25/81 vertices.
Largest coordinate differences are 1.66e-8, 6.29e-8, 5.10e-8, 1.52e-7, 3.20e-8, 6.73e-8,
0 and 0, within Blender's Float32 storage. Face counts differ by design: Margo keeps
faces planar and splits each curved quad into two triangles (cube L1: 48 against 24),
so a curved result holds twice Blender's faces; flat results (open grid: 16 and 64) are
equal. This is an accepted work difference recorded in limits.md, not a speed claim.

Reproduce after `npm run build:packages`:
`node --test packages/mesh-edit/tests/subdivide-workcount.test.js` and
`node scripts/bp-169-mesh-oracle.mjs --blender=<path to blender.exe>`. The runner writes
its Python script and data to a temporary folder outside the repository and measures
no time.

Research: E. Catmull and J. Clark, *Recursively generated B-spline surfaces on arbitrary
topological meshes*, Computer-Aided Design 10(6), 1978,
https://doi.org/10.1016/0010-4485(78)90110-0; T. DeRose, M. Kass and T. Truong,
*Subdivision Surfaces in Character Animation*, SIGGRAPH 1998,
https://doi.org/10.1145/280814.280826 (boundary and face-varying rules); Blender Manual,
*Subdivision Surface Modifier* (accessed 2026-11-10),
https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/subdivision_surface.html.
The rules are unchanged; only the edge bookkeeping changed. No Blender source was read.

## Job 1: UI intrinsic measurements

Cause: intrinsic sizing, flex basis, wrapped-line height and placement recursively asked
for the same node's content at the same available width. An eight-parent row chain
called its leaf 24 times, although only widths 200 and 20 were requested.
`contentOf` now memoizes by node identity and inner width for one `arrange` call.
Every placement, scroll extent, hidden rectangle and offset still runs. The cache
is local to the call, discarded after success or exception and separate for reentrant
layouts. Direct edits between calls remain visible. No core/stage bytes or imports
change. No new public export or optional dependency is added.

`packages/ui/tests/layout-workcount.test.js` requires exactly two measurements,
and hashes 64 deterministic mixed trees (rows, columns, grids, stacks, hidden nodes,
scrolling, wrapping, percentages, margins and offsets). All 40 nodes' rectangles,
content extents and scroll offsets per tree retain the original Float64 bytes:
SHA-256 `b0dffbf009a22ce56f39ccaf646440f7b52f30c0a86a27dcf2c0e96a8871c9e8`.
The hash and the 24-call baseline were captured before changing production code.
Fresh-content, failed-measurer and reentrant-call tests protect cache lifetime.

The black-box Yoga 3.2.1 harness compares the identical trees, without reading its
source: nesting depths 1/4/8 and clamped grow/shrink, 22 rectangles equal exactly.
Margo performs two leaf measurements; Yoga performs one. This is an accepted work
difference on these fixtures: Margo's arbitrary width-only measurer is asked at both
intrinsic and assigned widths; it cannot infer that a callback returns the same
height at a smaller width. Yoga's width/height constraint modes allow compatible
measurement reuse. Like for like with fully explicit leaf dimensions, both make
zero measure calls and give identical grow/shrink rectangles. This does not claim
full Yoga conformance or a speed win. Cross-call dirty-subtree reuse remains future
quality work; Margo's plain mutable LayoutNode has no dirty notification contract.

## Job 2: text layout measurements

Cause: logical layout measured each eligible adjacent pair, then visual placement
measured the same pair again. Shaped-run growth also remeasured the previous prefix
for its caret, after measuring it to create the run. The change reuses the logical
kerning only for the same contiguous source neighbors, in logical direction;
new visual neighbors still call the measurer. It retains the previous raw prefix
advance and applies font scaling and spacing in exactly the original order.
No persistent cache, new export, GPU work reduction or optional import is added.

The 600-character pair fixture falls from 1198 kerning callbacks to 599; the
18-character shaping fixture falls from 35 advance callbacks to 18. The 35-layout
corpus covers fractional spacing/size, wrapping, justification, RTL/numbers,
Arabic, Indic, CJK, combining marks, emoji ZWJ and CRLF. Every glyph, line, bound,
UTF-16 range and caret retains its bytes. The 387896-byte canonical JSON stream
(preserving negative zero with a sentinel) has SHA-256
`b671ae6317ed56c5fc4a7dfc9681af9327008300d9e28b2844bd90e8f9c99dcf`, captured
before the source change. A separate test edits a measurer between calls.

The external Troika 0.52.4 comparison uses the same pinned Source Sans 3 Regular
3.052R TTF as Canvas and Margo, with Latin ligatures enabled. Four unwrapped advance
widths match Canvas exactly: AVATAR 3.128999710083008 em; office affine waffle
7.606998443603516 em; Hello world 4.813998222351074 em; AVATAR repeated 20 times
62.50399271647135 em. Margo minus Troika selection widths are respectively
-2.384185791015625e-7, -1.430511474609375e-6, -1.9073486328125e-6 and
-8.900960288826809e-6 em. These small numeric differences are retained, not treated
as exact equality. Canvas uses browser font metrics and Troika returns Float32
selection rectangles; the per-font numerical causes have not been isolated further.
The oracle covers advance widths only, not glyph pixels, line-break equivalence,
all scripts or competitive speed. No timing was run.

## Reproduce

Build with `npm run build:packages`, then:

```sh
node --test --test-timeout=120000 packages/ui/tests/layout-workcount.test.js
```

Install `yoga-layout@3.2.1` in a separate external test directory, outside the Margo
repository, with `npm install --prefix <external-dir> --ignore-scripts --no-audit --no-fund yoga-layout@3.2.1`.
Then run the value-only harness once:

```sh
node scripts/bp-169-ui-oracle.mjs --yoga=<absolute-external-dir>/node_modules/yoga-layout
```

The runner verifies the external package name/version and prints all five results,
measurement counts and exact rectangle comparisons. It measures no time. Tonight's
quiet campaign must time the same full layout work on each side, including applying
rectangles, and separate initial layouts from unchanged or edited trees.

## Research and clean-room boundary

Compared the sizing/placement phases in Tab Atkins Jr., Elika J. Etemad and Rossen
Atanassov (editors), *CSS Flexible Box Layout Module Level 1* (W3C, 2025), sections
9.2, 9.4 and 9.7, https://www.w3.org/TR/css-flexbox-1/#layout-algorithm, with Meta's
*Incremental layout* (Yoga documentation, accessed 2026-11-10),
https://www.yogalayout.dev/docs/advanced/incremental-layout, and Thibaud Hottelier
and Ras Bodik, *Synthesis of Layout Engines from Relational Constraints* (2014),
UCB/EECS-2014-181, https://www2.eecs.berkeley.edu/Pubs/TechRpts/2014/EECS-2014-181.html.
The specification defines the repeated constraint contexts; the research motivates
functional value propagation. Yoga's persistent dirty flags need an API Margo does
not expose, so this change uses call-scoped memoization instead. Only papers,
specification and documentation were consulted; no external implementation or
companion code was read, copied or adapted.

## Job 2 reproduction and research

After `npm run build:packages`, run
`node --test --test-timeout=120000 packages/text/tests/layout-workcount.test.js`.
Install `troika-three-text@0.52.4` only in an external test directory with
`npm install --prefix <external-dir> --ignore-scripts --no-audit --no-fund troika-three-text@0.52.4`.
The rival and its dependencies stay outside this repository and are used only as
black boxes. In PowerShell, set `$env:MARGO_GPU_SLOTS='3'`, then run
`node scripts/bp-169-text-oracle.mjs --rival=<absolute-external-dir>`.
The harness holds the shared GPU lock, bounds each sync at 60 seconds and its hold
at five minutes, and prints every width and difference. Its worker is disabled
and CPU SDF is selected; it is not a rendering-speed comparison. No font is newly
copied: existing fixture provenance is in packages/text/tests/fixtures/fonts/NOTICE.md.

Compared Robin Leroy (editor), *Unicode Line Breaking Algorithm*, UAX 14 revision
57 (2026), https://www.unicode.org/reports/tr14/, and Josh Hadley (editor),
*Unicode Text Segmentation*, UAX 29 revision 49 (2026),
https://www.unicode.org/reports/tr29/, with Donald E. Knuth and Michael F. Plass,
*Breaking Paragraphs into Lines* (1981), https://doi.org/10.1002/spe.4380111102,
and WHATWG, *HTML Living Standard*, Canvas text preparation/measureText (2026),
https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-measuretext.
The text standards distinguish source segmentation, measured runs and final
placement; reuse is confined to unchanged measurement inputs, retaining Margo's
current line-breaking algorithm. Knuth/Plass paragraph optimization was compared
but not substituted for that algorithm. The rival's documented sync and selection
APIs, https://protectwise.github.io/troika/troika-three-text/, are used only for the
external value oracle. No rival implementation or companion code was read or copied.
