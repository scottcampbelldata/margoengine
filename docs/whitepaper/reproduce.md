# Reproducing Margo's numbers

## Batch 187: global lightmap opaque visibility

Build packages; run node --test --test-timeout=120000 packages/lightmap/tests/global-path.test.js
packages/lightmap/tests/global.test.js (one command, paths separated by spaces). For pixels use
node scripts/gpu-lock.mjs run --owner=codex-batch187 --max=3 --wait-max=60 -- node packages/lightmap/tests/global-browser.mjs;
repeat with --compat on the browser script. The unblocked receiver must be lit; every blocked centre RGB channel is
zero, with no GPU validation errors and all meshes released. These are correctness runs, not speed measurements.
The existing Batch 168 Cornell reference remains unchanged outside the repository. Decode its cycles.json using the
independent calibrationIrradiance ratio documented by rival-bench.mjs; bake the same scene with physical radiometry,
texelsPerUnit 2, padding 1, aoRays 1, seed 1, areaSamples 16, bounceMode path, bounces 1, bounceRays 32, then compare
all 881 chart texels without cropping or fitting. MAE 0.04873001076918034, relative 0.14818416311660937,
maximum 0.3539794757772641. Do not run rival-bench.mjs during the deferred speed phase. No fresh rival capture is
required or claimed; cached reference correctness comparison only, no timings or speed assertions.


Batch 175 job 1: after build:packages, run `node --test --test-timeout=30000 packages/sciviz/tests/omezarr.test.js`; run `node scripts/gpu-lock.mjs run --owner=codex-batch175 --max=5 --wait-max=60 -- node packages/sciviz/tests/omezarr-browser.mjs` for both native and full WebGL2 in one leaf. The leaf draws all three recorded scientific regions and checks source replacement, lit pixels and errors, writing test-results/sciviz-omezarr-gpu.json. The example is examples/sciviz-cloud.html. Each fixture manifest retains original store URL, resolution/ROI, Range requests, hashes and licence. `node scripts/prepare-sciviz-cloud.mjs` refreshes only small public compressed regions, never entire volumes. For an independent numeric comparison, install binary Python numcodecs, numpy, lz4, xxhash and Pillow in an environment (the scripts also look in test-results/batch175-tools), then run `py -3.13 scripts/prepare-sciviz-cloud-codecs.py` and `py -3.13 scripts/audit-sciviz-cloud.py`. No implementation source is read by either generator. The audit retains exact lossless equality and records the existing one-value JPEG IDCT difference separately. Speed is deferred; counts and memory bytes are the evidence.

Batch 190 job 2: build packages, run `node --test --test-timeout=120000 packages/oit/test/*.test.js`, then `node scripts/gpu-lock.mjs run --owner=codex-batch190 --max=3 --wait-max=60 --gpu=float32-accumulation-pixel-correctness -- node packages/oit/test/gpu/precise-check.mjs` and append `--compat` for WebGL2. Eight emissive layers deliberately overflow the old weighted half-float sums, with numeric readback before display mapping; the expected result is emitted radiance times `1 - 0.5^8`. The harness compares both implementations on ordinary radiance and full images with sloped MSAA edges, checks opaque depth, reordered input and the existing CC0 Khronos GlassVaseFlowers PBR model. CPU recording checks all four R32F channels, no implicit hardware resolve, both sample counts, device restoration, disposal and capability refusal before allocation. No timing assertion.

Batch 190 job 1: after building packages, run `node --test --test-timeout=120000 packages/oit/test/*.test.js` and `node scripts/gpu-lock.mjs run --owner=codex-batch190 --max=3 --wait-max=60 --gpu=depth-peeling-pixel-correctness -- node packages/oit/test/gpu/peel-check.mjs`, then the same GPU command with `--compat` appended. The GPU checks compare against analytic alpha transport at 1x/4x scene MSAA, reorder meshes, cross sheets, limit layers, insert opaque occluders and check post/canvas alpha. They also load the existing CC0 Khronos GlassVaseFlowers sample with environment lighting and post processing. CPU recording covers private writable depth, immutable scene depth, resize between views, restoration, disposal and rejection of unsupported effect attachment. No benchmark or timing assertion is used.

Batch 256 job 4: build packages and run
`node --test --test-timeout=30000 packages/netcode/tests/migrate.test.js`.
Seeded virtual-clock mesh fixtures cover loss/jitter and precise interruptions
between prepare, commit and resume acknowledgements. They make no wall-clock
performance assertion and require no GPU or assets.

Batch 256 job 3: with rustc on PATH, build packages, then run
`node --test --test-timeout=120000 packages/netcode/tests/generate-rust.test.js`.
The test generates Rust and TypeScript into its own worktree test-results folder,
compiles two standalone native programs and compares their outputs. No downloaded
crate, GPU, benchmark or README execution is used.

Batch 256 job 2: after building packages, run
`node --test --test-timeout=30000 packages/netcode/tests/presence.test.js`.
It creates a temporary SQLite file and two Node processes within the worktree's
test-results directory, routes a reservation and joins the correct WebSocket.
No GPU or wall-clock speed assertion is involved.

Batch 256 job 1: build packages, then run
`node --test --test-timeout=120000 packages/netcode/tests/lobby.test.js`.
All lobby correctness evidence uses CPU fixtures and the existing room wire
protocol. No new GPU rendering path, benchmark or downloaded demo asset.

Batch 273 failure 18: build packages, then run
`node --test packages/webgl2-compat/test/compute-limits.test.js`.
Run `node packages/shader/test/readback-check.mjs` in a shared GPU slot, first
with `MARGO_COMPAT` unset, then with `MARGO_COMPAT=1`. Keep all original
assertions, the full 4,194,304-element workload and every lifecycle case.
Compatibility validation must return `failed`, then recover with `[5,6,7,8]`,
without uncaptured errors or retained job buffers.

For verify cache metadata counts and progress ordering, run
`node --experimental-test-module-mocks --test --test-timeout=120000 tests/result-cache.test.js tests/archive-metadata.test.js tests/verify-cache-progress.test.js`.
The 128-archive/12-output fixture compares stat and native enumeration paths:
1,614 versus zero per-file stats under cap and 1,548 versus zero at cap on
Windows, with zero eviction archive-content bytes read and identical retained
names/bytes. Other platforms retain the stat counts. Additional fixtures cover
metadata equality, shared changes, timestamp ties/backwards changes, per-write
capacity decisions, disappearing entries and native helper errors.

For the Bug 45 GPU idle-lease correction, run
`node --test --test-timeout=60000 tests/gpu-idle-window.test.js tests/gpu-activity.test.js tests/gpu-monitor-edges.test.js tests/gpu-lock.test.js`.
These CPU fixtures simulate the exact idle intervals and inspect real fake-lock
entries; no GPU work or timing benchmark is involved. For an actual instrumented
parity run, set `MARGO_GPU_IDLE_MIN=4` in that command's environment and retain
`--max=8 --wait-max=60`, one shared slot and the existing eight-minute leaf limit.
The idle window is 240 seconds, covering the measured 194.050-second reclamation
interval plus 45.950 seconds of margin. Test and wrapper deadlines remain intact.

## Batch 258 input entry

After `npm run build:packages`, run the deterministic state and draw-list
checks with `node --test --test-timeout=120000 packages/ui/tests/text-input.test.js`.
Run each browser command sequentially (one slot for this lane):

```sh
node scripts/gpu-lock.mjs run --owner=codex-batch258 --max=3 --wait-max=60 -- node packages/ui/tests/text-input-browser.mjs
node scripts/gpu-lock.mjs run --owner=codex-batch258 --max=3 --wait-max=60 -- node packages/ui/tests/text-input-browser.mjs --compat
```

Reports and captures are test-results/ui-text-input-{native,compat}.{json,png}.
They contain actual rendered text pixels and input-operation checks. The
drivers use real canvas pointer events, native clipboard shortcuts, native undo
and DevTools Input.imeSetComposition/Input.insertText. No timing bars or
performance numbers are collected. Read the package README for the runnable
integration example; run it through check:readme-run -- --packages=ui.

## Batch 213 job 1: legacy VRM reading

After `npm run build:packages`, run
`node --test --test-timeout=120000 packages/rigging/tests/vrm0.test.js`.
Then run `node scripts/gpu-lock.mjs run --owner=vrm0-review --max=3 --wait-max=60 -- node packages/rigging/tests/rigging-browser.mjs`
and repeat with `--compat` on the browser command. The harness checks the real
0.51 model's turned-original picture against the converted picture, expression
changes, neutral restoration, and the existing weight/IK/1.0 checks. Receipts:
`test-results/rigging-browser.json` and `rigging-browser-compat.json`.
`node scripts/measure-size.js` checks core + stage; bundle the optional entry
with `bundleBytes` from that script and gzip it to reproduce 6,488 B.
Original asset licence/source and conversion choices: [VRM 0.x](../rigging-vrm0.md).

Final batch 171 job 3 integration: genuine entry/network records both name da96932cb, packages clean.
The latest-main rebase preserves all concurrent work. Sciviz/geometry/compute/math/core source is identical
to the accepted source; the affected 203 CPU checks, root GPU checks, 16 entry parity comparisons, four
NOAA wind-path layouts/backends and all 25 README runtime examples pass on the combined build. API,
lint, hygiene and size gates pass. Sizes remain tubes 2533, grids 23735, maths 5703, root 50599, LIC
23461 and core/stage 23924 B gzip. The single full verify remains 14012 tests, 14010 passed, with both
metadata failures corrected and all seven affected checks passing; it was not repeated. The exact LIC
+13032 B required-colormap attribution is reproduced again on this source. Earlier checkpoints below
retain their historical scope. See the batch-171-tubes-validation.json receipt in whitepaper/results.

## Owned Zstd storage regression

From the repository root, run the example in
[the shared helper README](../../packages/shared/README.md), then:

```sh
node --test --test-timeout=120000 packages/decoders/tests/zstd-destination.test.js
```

The ordinary splats Zstd corpus tests additionally exercise existing allocating
behavior after a package build. The destination regression records allocation
sizes, not wall-clock speed. Keep the private Basis173-pair RSS campaign and
remaining-format source-quality losses separate from this helper's proof.


## Batch 134 corpus, upload and memory continuation

[Evidence](results/batch-134-corpus-uploads-memory.json) pins the same combined
Wasm as the scalar ruling. The author-retained measure folder holds
`whole-container-fuzz-report23-corpus.mjs` (51 seeds, each180s hard limit,
controller2400s), `report23-hostile.mjs` (240s), `report23-memory.mjs`
(173 fresh old/new process pairs, each180s, controller2400s), and
`report23-uploads.mjs` (real GPU copies/readback, max1minute). Only the last
runs through gpu-lock with owner codex-134, shared mode, wait-max60 and an
explicit compressed-texture upload/readback reason. CPU scripts never hold it.
Source pins, frozen control hashes and all image identities are retained.
The upload harness uses the existing installGPU lifetime owner. ETC2/EAC
absence on RTX A6000 WebGPU remains missing hardware evidence. No timing A/B.
Memory losses and the same-payload normalized control are separate from
acceptance: the runtime still receives the original source containers.

## Batch 171 job 3 final acceptance

One npm run verify (hard 40-minute process-tree limit): 14012 tests, 14010 passed,
two metadata failures subsequently corrected; all seven affected checks pass. Do not rerun the full suite.
Run the six sciviz *-browser.mjs leaves through scripts/gpu-lock.mjs in shared mode, one at a time,
--wait-max=60, with command limits from their measured duration plus margin. Do not hold a slot for
package builds, units, lint, hygiene or verify. check:readme-run -- --packages=sciviz runs 25 examples.
The [receipt](results/batch-171-tubes-validation.json) records exact counts, backend/restore evidence
and the coherent c333a7390 measurement pair. No benchmark, exclusive GPU run or time-only assertion.


## Batch 171 critical-point regression and LIC attribution

Build sciviz, then run under a 4-minute process-tree deadline:
node --test --test-timeout=120000 packages/sciviz/tests/streamline-stagnation.test.js
The five cases cover analytical sink, 3D/backward/minSpeed, real orbits/saddle, boundaries/controls and
all 96 unmodified NOAA day/seed combinations, including both mesh builders. The regular check:merge
unit glob runs the same file. Canonical entry method: scripts/measure-size.js, bundleBytes, bare imports
external, compactOutput, default gzip. The isolated attribution uses the current src/lic.ts twice, with only
src/colormaps.ts and src/tables.ts loaded from f33472ed6^ for the historical variant, through Vite's load
hook. No source checkout, timing run or GPU lease is needed. The durable JSON retains exact settings,
module inventory and byte counts; both variants return exactly the historical/current recorded LIC sizes.


## Batch 134 scalar payload bar (2026-11-09)

With the author-retained licensed corpus, control payloads, independent
quality readers and private combined draft in an evidence folder, run:

```sh
node scripts/measure/scalar-payload-bar.mjs <evidence-directory> scalar scalar.json
node scripts/measure/scalar-payload-bar.mjs <evidence-directory> eac eac.json
node scripts/measure/scalar-payload-bar.mjs <evidence-directory> etc2 etc2.json
node --test --test-timeout=60000 tests/scalar-payload-metrics.test.js
```

Each command is CPU-only and needs a hard process limit (600, 900, 600 and
120 seconds respectively). The evidence folder is the retained `measure`
folder with the matching sibling `transcoder`, not a downloaded implementation.
The script checks input/control pins, every candidate RGBA hash, every frozen
old source metric and complete pair/image counts; captures each new payload;
compares exact scalar numerator SSE, new <= old with zero tolerance; and
publishes original-source conventional and mapped numbers, including losses.
The [published evidence](results/batch-134-scalar-payload-bar.json) pins this
combined Wasm and its sources. EAC denominator is 2047 squared, not a rounded
byte decode. No GPU lock or timing A/B is involved in these commands.

Batch 171 job 3 CPU checkpoint: build the geometry and sciviz packages, then run
node --test --test-timeout=120000 packages/sciviz/tests/tubes.test.js packages/sciviz/tests/mesh-ownership.test.js.
The ignored own-worktree receipts under test-results/sciviz-fixes/lic-tubes-* retain the four failing old
ownership cases and the passing corrected build. This is not GPU/demo/full-verify acceptance.


The [remaining-target draft](results/batch-134-remaining-targets.json) uses
author-retained measurement scripts `remaining-quality-report21.mjs`
(UASTC EAC) and `remaining-quality-report21-etc2.mjs` (ETC1S ETC2).
Run with Node's type stripping after building the one candidate Wasm in the
retained decoder workspace. Each full campaign keeps a 900-second process-tree
limit, unchanged references, old hashes, per-channel source controls and the
frozen image summation order. A source-quality loss returns failure; it is not
turned into a passing status. `report21-publish.mjs` verifies 993 final payload
hashes, 292 retained EAC payloads and exact ETC2 color blocks from captures.
The native EAC test independently enumerates every header and verifies equal
cost/header ties, constants, clipping and padding; its work count includes
all seed palettes. Native hostile tests cover 4,096 random blocks and 24,580
calls, not final whole-container fuzz. The first EAC campaign was deliberately
interrupted for an exact work reduction before its cap; its partial results
are preserved. No timing A/B or completed replacement claim follows.

Batch 171 LIC checkpoint (analytical and demo GPU checks pass; full gates pending):

Batch 171 LIC (analytical, demo and package GPU checks pass; full verify's four affected failures corrected):
`npm run build --workspace @margoengine/sciviz`, then
`node --test --test-timeout=120000 packages/sciviz/tests/lic.test.js`. Analytical convolution, masks, slices,
animation and restored/backend pixels: `node scripts/gpu-lock.mjs run --owner=codex-batch171 --wait-max=60
--max=2 -- node packages/sciviz/tests/entries-browser.mjs --only=lic`. Use `--only=lic-curvature` for exact
circular-arc and phase-reversal checks. Run `packages/sciviz/tests/demos-browser.mjs --only=lic` under a
separate shared lease (max 3 minutes) for both layouts/backends and the NOAA controls. Full package GPU gates and README runs
use separate shared leases, one at a time per lane; CPU builds/lint/hygiene/verify do not hold a lease.
`examples/sciviz-lic.html` reuses hash-pinned `examples/assets/sciviz/wind.bin`; phase is a direction cue,
not atmospheric elapsed time. No new timing claim.
After the full package build, regenerate `node examples/package-benchmarks/entry-sizes.mjs` and
`node scripts/basic-scene-network.mjs` from the same clean package source; the latter self-locks only its GPU
step. Run `npm run api:update`, the size quality gate and paired-record tests for the refreshed artifacts.

The [rational scalar experiment](results/batch-134-scalar-rational.json) is an
unaccepted negative research checkpoint. Retained author-workspace identifiers:
`planner/scalar-research-report17.md` records the chosen method before code;
`transcoder/tests/scalar_latent.rs` independently enumerates all 65,536 pairs
for 128 rational cases; `measure/report17-campaign.mjs` pins sources, Wasm and
adapter and runs `measure/scalar-quality-report17.mjs` under a hard limit.
The quality command intentionally fails: 77/98 pairs pass, 21 fail.
All old controls and both bars are unchanged. During that same pass it retains
output/RGBA payloads and source-interaction sums; `measure/report17-analyze.mjs`
groups these by base/mip and full/partial extent without retranscoding.
These are separately retained development-workspace identifiers, not shipped
clone commands. No public integration or timing acceptance is claimed.

The [complete scalar search and extent checkpoint](results/batch-134-scalar-exact-edge.json)
records every image, original reference, old control and source/adapter/Wasm pin.
Retained author-workspace identifiers are `transcoder/tests/scalar_exact.rs`,
`transcoder/tests/scalar_edges.rs`, `measure/report16-final.mjs` and
`measure/scalar-quality-report16-final.mjs`. The controller pins all Rust sources
before/after building the one Wasm and running the unchanged quality policy.
The quality command intentionally exits nonzero: 84 pairs pass and 14 fail,
including two new MetalPartsMat BaseColor losses. Native 56 and scalar Node 4
tests pass. Earlier copy-based oracle attempts reused newer Cargo artifacts;
only the fresh-compilation red/green evidence is used for the regression claim.
These identifiers refer to a separately retained development workspace, not
shipped clone commands or a completed public decoder. No timing A/B was run.

The [scalar refinement](results/batch-134-scalar-refinement.json) lists retained
author-workspace file identifiers and exact input, source, adapter and Wasm pins.
Its native crate tests include `scalar_refinement.rs`; build that crate for
wasm32-unknown-unknown before running identifiers
`measure/scalar-quality-report15b.mjs` and `measure/scalar-diagnose-report15b.mjs`.
The first retains both original-source bars and exits nonzero for 12 failures.
The second measures reconstruction error only and cannot establish acceptance.
The research workspace is retained separately; these are not shipped clone
commands or a completed public decoder. Earlier prototype evidence stays intact.

Owned browser I/O regression: run
`node --test --test-timeout=90000 tests/browser-teardown.test.js tests/shutdown.test.js tests/page-ready.test.js`.
The pipe-dependent completion test fails before the ordering repair. Existing
deadlines and refusal tests remain intact. The page-ready test checks a held
module and browser cleanup; it is not a GPU rendering or speed benchmark.

The [unaccepted scalar prototype](results/batch-134-scalar-prototype.json)
retains its source/tests and corpus in the author research workspace, outside
clone contents. There, run native crate tests, the release Wasm build and
`measure/scalar.test.mjs` with the retained adapter suites, followed by
`measure/scalar-quality-order.test.mjs` and `measure/scalar-quality.mjs` under
hard CPU limits. The last command currently fails on 40 of 98 pairs; every old
payload/source control and frozen aggregate must remain exact. Keep conventional
RG and mapped R/alpha errors, original references and zero tolerance unchanged.
Do not treat this prototype as package integration or remove the prebuilt.

CPU pathline foundation (batch 171 job 1): run `npm run build:flow --workspace @margoengine/sciviz`,
`npm run test:flow-kernel --workspace @margoengine/sciviz`, build the package, then
`node --test --test-timeout=120000 packages/sciviz/tests/flow.test.js`. No device or GPU lock is requested.
The NOAA daily-mean asset is the existing hash-pinned `examples/assets/sciviz/wind.bin`; tests convert its
velocity components to projected km/s and trace two days in seconds. Analytic tests are the accuracy references;
halving the NOAA time step is a convergence check only.
After building packages, run `node scripts/gpu-lock.mjs run --owner=flow-reference-proof --wait-max=60 --max=1 -- node packages/sciviz/tests/entries-browser.mjs --only=flow-pathline` for real-browser Wasm loading,
analytic samples, existing-line pixels and device replacement on WebGPU and WebGL2 compatibility.

Moving-flow continuation: include `packages/sciviz/tests/flow-seeds.test.js` in the CPU command above.
After building sciviz, run `node scripts/gpu-lock.mjs run --owner=codex-batch171 --wait-max=60 --max=1 -- node packages/sciviz/tests/entries-browser.mjs --only=flow-motion` for GPU particle arithmetic,
CPU reference comparison, deterministic seeds, respawn/NaNs/abort, all-pixel parity and actual device replay.
Then run `node scripts/gpu-lock.mjs run --owner=codex-batch171 --wait-max=60 --max=2 -- node packages/sciviz/tests/demos-browser.mjs --only=moving-flow` for all four mobile/desktop/backend demo groups.
The latter writes screenshots under `test-results/sciviz-fixes/`. The real asset and its provenance are
unchanged `examples/assets/sciviz/wind.bin` and `wind.json`. No speed suite or exclusive hold is required.

CPU isosurface extraction (batch 181 job 1 foundation): run
`npm run build:fallback --workspace @margoengine/sciviz`,
`npm run test:fallback-kernel --workspace @margoengine/sciviz`, then
`npm run test --workspace @margoengine/sciviz`.
`fallback.test.js` compares every derived case, SIMD tails and chunk boundaries with a scalar oracle, and loads
`examples/assets/sciviz/head.nrrd` at intensity 300 to check 216,150 triangles and the pinned vertex hash in claims.md.
The Wasm is a lazy asset outside the root entry; no WebGPU device or browser is needed. These checks establish
extraction only. For the separate native surface/rectangle piece, build sciviz and webgl2-compat, then run
`node scripts/gpu-lock.mjs run --owner=sciviz-native-proof --wait-max=60 --max=1 -- node packages/sciviz/tests/webgl2-browser.mjs`.
This checks both real engine backends, strict all-pixel bounds, actual context loss, live reboots and GL state.
It does not establish axes, points/lines, volume/slice or integrated CPU-isosurface support.

Owned Chromium shutdown ordering: run `node --test --test-timeout=120000
tests/browser-teardown.test.js tests/browser-selection.test.js
tests/shutdown.test.js`. The asynchronous-session regression must fail before
the repair and pass afterward. Revalidate rendering with the voxel package's
`test:gpu` and README gates in shared GPU slots. The existing five known voxel
README failures remain recorded by that gate; 18 of 23 examples succeed.

The [active licensed corpus](results/batch-134-active-corpus.json)
replaces the AGI atlas, alpha3, Kodak03 and Memorial cube with CC0 assets of the
same dimensions, input formats, alpha/cube features and mip counts. All 699
served pairs and 9,491 images now have source metrics, with zero provisional
pairs. The four replacements account for 45 pairs and 250 images. Three .basis
files use real FlightHelmet image content; the HDR cube uses an analytic light
field. The historical baseline is retained, and its timings are not transplanted
onto new inputs. Replacement timing and the transcoder's acceptance gates remain.


## Batch 134 prebuilt Basis targets (partial)

The [record](results/batch-134-prebuilt-baseline.json) pins each input URL/hash,
both opaque wrapper hashes, the Wasm hash and per-file/per-target results.
Use the built static-embind wrapper and its unchanged Wasm from an outside
folder; never inspect either implementation. The retained vendor pass is a
control, not the shipped timing target. Decode every mip, layer and face.
For warm controls, create one module per file/target, record its first call,
then alternate A/B order for three rounds, taking each side's minimum of two
complete transcodes. For cold controls, use a fresh initialized module for
every trial with the same round/order/minimum design. Verify every output's
hash after its timer. A/B are identical prebuilts until a replacement exists.

Measure memory in a fresh process for each file/target, retaining only that
pair's complete output; record process peak RSS and Wasm high-water bytes.
Use seven more fresh processes for compile/instantiate/startup, keeping
instrumented phases separate from natural per-target startup. Gzip assets
at level 9. All current timing data is a loaded-machine diagnostic.
Original harnesses, complete trial arrays and per-image hashes are retained
in lane M's private `batch-134/measure` folder; a portable public runner and
final replacement source-quality/licensing evidence remain work for the later jobs.
The committed continuation now records 685 quality pairs across 21 readers.
Use original stored channels with exact-area source mip integration, retain
linear HDR values and explicit BC5/EAC R/alpha contracts. Fourteen AGI pairs
remain unmeasured and 12 alpha3 pairs provisional. The manager accepts this
snapshot to start implementation, requiring openly licensed asset replacements
with the same format/feature coverage before final acceptance.

## Real-data scientific demos (2026-11-10)

Pull Git LFS assets and build packages, then run the sciviz unit and browser tests:

```sh
git lfs pull
npm run build:packages
npm test --workspace @margoengine/sciviz
node scripts/gpu-lock.mjs run --owner=sciviz-real-data --max=12 --wait-max=5 -- node packages/sciviz/tests/demos-browser.mjs
```

The runner checks all three real-data demos and four retained synthetic test pages on WebGPU and forced WebGL2,
at 1440 x 900 and 390 x 844, exercises controls and exports, checks rendered structure and selected histogram
counts, and observes live frames during trace updates. Results and screenshots are under
`test-results/sciviz-demos/`. Source data, exact reduction, hashes, projection and subset biases are recorded in
`examples/assets/sciviz/README.md` and adjacent JSON manifests. This is functional evidence, not a speed measurement.
### Biome prefetch shared-generation proof (2026-11-09)

After building packages, run
`node scripts/gpu-lock.mjs run --exclusive --owner=codex-missing -- node packages/biomes/scripts/prefetch-proof.mjs`.
The five-minute child supervisor compares isolated Margo parent fc1ed452f sources with the
current build using the same dependencies, full default 4 km world, three workers and original
144-tile rectangle. It checks every result field and typed-array SHA-256 for 292 unique keys,
requires one current submission per key and fewer total submissions than the parent, and writes
test-results/biomes-prefetch-proof/result.json. Copy the successful record to
results/biomes-prefetch-20261109.json. This is deterministic work/output evidence, not timing.
Run `node --test packages/biomes/tests/view-prefetch.test.js` for independent aborts, edits,
cache capacity, failure and disposal. The unchanged size ceiling is checked by npm run quality.

### Biome I/O and runtime README continuation (2026-11-09)

After building packages, run `node packages/biomes/scripts/io-proof.mjs` from the repository.
Its outer supervisor kills the whole process tree after five minutes. It builds an isolated
copy of Margo's own biome sources at 349243b3d, including its optional entries, then executes
the complete default 4 km exports through that copy and the current build in one process.
Every byte is hashed, all metadata is compared, and both saved-world digests must agree.
The record is `test-results/biomes-io-proof/result.json`; the retained evidence is
`results/biomes-io-20261109.json`. This is an output/work proof, not a timing benchmark.

`node --test --test-timeout=120000 packages/biomes/tests/io.test.js packages/biomes/tests/gpu-field-integration.test.js`
checks exact worker/serial output, cropped edits, bounded outstanding jobs, one classification
per tile, failure cleanup and exact height-only cell requests. Run all biome package tests too.
The runtime gate is `node scripts/gpu-lock.mjs run --owner=codex-missing -- npm run check:readme-run -- --packages=biomes,loaders`.
Both loaders GPU suites and biome `test:gpu` remain required under the same GPU lock.

`node --test --test-timeout=120000 tests/gpu-lock-mutex.test.js tests/gpu-lock.test.js tests/gpu-lock-compat.test.js tests/gpu-lock-limits.test.js tests/run-readme-examples.test.js`
checks locking and complete-page scheduling. On Windows the native regression uses the OS's
PowerShell and a clean-room Win32 fixture to hold a directory delete-pending: the old name
fails with EPERM, while a retired name leaves the reusable mutex available. No fixture or
platform is silently skipped; the portable retirement/permission models run everywhere.
API basis: [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
and [directory deletion lifetime](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectoryw).

## Five executable README repairs (2026-11-09)

After `npm run build:packages`, run
`node scripts/gpu-lock.mjs run --owner=codex-readme5 --max=15 -- npm run check:readme-run -- --packages=react,stage,text,worker`.
The scoped result is 40/40, zero failures. React's standalone picking test receives the same selected browser/GPU
launch environment as the page harness. It serves its own scene on a free port, waits for frames, clicks the box
and waits for the React state update. A driver that cannot finish fails at its deadline.

Regenerate the atlas with
`node scripts/gpu-lock.mjs run --owner=codex-readme5 --max=3 -- node packages/text/scripts/make-readme-atlas.mjs`.
This uses the pinned Source Sans 3 TTF and Margo's SDF code, not an outside atlas generator. The generated
JSON and PNG live together under packages/text/tests/fixtures/fonts/readme. Run `npm test --workspace @margoengine/text`
for all ASCII glyphs and `npm run test:browser --workspace @margoengine/text` under the GPU lock for JSON/PNG fetch
and actual Hello rendering. The fixture notice records the source and OFL; no font implementation is copied.

## Poisson placement work count (batch 68, job 1)

Run `npm test --workspace @margoengine/procedural` for the seeded 3,000-candidate float64 all-pairs comparison:
3,329 hash distance tests versus 3,445,553 all-pairs tests, exactly the same accepted coordinates. This is a work
count, not a wall-clock speed claim. `npm run test:poisson-kernel --workspace @margoengine/procedural` runs the
native Rust tests; `npm run build:poisson --workspace @margoengine/procedural` rebuilds the committed Wasm.
Run `node scripts/gpu-lock.mjs run --owner=codex-68 --max=10 --wait-max=10 -- npm run test:gpu --workspace @margoengine/procedural`
for real production-browser WebGPU/WebGL2 value, lazy-asset, non-root-base and device/context-loss checks.
Only synthetic geometric inputs are proven; authored mesh placement and spectral/speed quality are unmeasured.

Every public number should come from one of the commands below. Run them from the repository root on the commit you
want to check. Status of each claim and which command backs it: [claims.md](claims.md).

## Engine size comparison

The rival engines are installed and measured in a folder outside this repository; no rival code or scene file is ever copied in.

1. Make a folder next to the repository (for example `engine-bench/size-compare`). Run `npm init -y` there and install the exact versions: `three@0.187.0`, `@babylonjs/core@9.35.0`, `playcanvas@2.24.0`, `claygl@1.3.0`, `hilo3d@1.19.1`, `@galacean/engine@1.6.13`, `filament@1.53.4`, `vite@8.3.4`, and pin `rolldown` to 1.2.13 with an npm `overrides` entry.
2. For each engine write two entries by hand from its public documentation: (a) a renderer, scene, perspective camera, one lit box, one directional light and a render loop; (b) a re-export of everything the package's main entry exports. Margo's entries are `import { createStage } from 'margoengine'; const stage = await createStage('#app'); stage.box({ color: '#84d6bd' });` and `export * from 'margoengine'`.
3. Bundle each entry with the same build call as `scripts/measure-size.js`: vite `build()` with `configFile: false`, `publicDir: false`, `write: false`, `build.minify: true`, `build.target: 'es2022'`, `build.lib: { entry, formats: ['es'] }`, and `rollupOptions.output` set to `{ minify: { compress: { dropDebugger: true }, mangle: true, codegen: true }, comments: { annotation: true } }`. Rival rows have no externals. Margo rows use the external list in `scripts/measure-size.js` with `@margoengine/core` and the stage bundled.
4. Join every emitted chunk (static and `import()` chunks) with a newline, gzip it with `zlib.gzipSync` at the default level, and add emitted assets (Wasm) gzipped. The startup figure is the chunks reachable without `import()`.
5. For Margo run `npm run build:packages` and `npm run measure:size` in the repository first; the comparison reads `packages/stage/dist/index.js` and `packages/margoengine/dist/index.js` from that checkout.
6. The WebGL2 fallback size comes from `bundleBytes` in `scripts/measure-size.js` on `packages/webgl2-compat/dist/index.js` and `dist/preview.js`, gzipped.

Results of 2026-11-10 and the sizes of every row are in `docs/whitepaper/claims.md`, "Smallest core".

## Setup (once)

```sh
git clone https://github.com/scottcampbelldata/margoengine.git && cd margoengine
npm ci                     # Node 24.18+; installs three@0.186.1, Vite, Playwright and the test tooling
npx playwright install msedge   # or set MARGO_BROWSER=chrome, or webkit on macOS; the real-GPU scripts default to Edge
npm run build:packages     # every package, size gates, catalog (no Rust toolchain needed; the Wasm is checked in)
```

## Everything in one command

```sh
npm run bench                  # every suite: size, startup, render, objects, scaling, math, glTF, loaders, assemblies,
                               # voxel, physics, memory, React (quiet-machine gate, GPU lock, 5 runs per case)
npm run bench -- features      # also every per-feature real-GPU script below (about an hour)
npm run bench -- --list        # the suites and cases
npm run proofs -- --current    # the recorded-GPU-call proofs
```

`npm run bench` is the one benchmark tool ([docs/benchmarking.md](../benchmarking.md)). Each run writes
`benchmarks/runs/<id>.json` with its Markdown and HTML report. The JSON records the commit, machine, GPU and driver,
browser and the gate's readings. `--record` keeps a committed copy in `benchmarks/records/`. The `features` suite
copies what each script writes to `benchmarks/runs/<id>/features/` and restores the committed results, so a run never
changes them.

## Whitepaper timing run (pending: needs a quiet PC)

No timing number is whitepaper data yet. The tool has only been smoke-tested (labelled "smoke", not for
publication). When the machine is quiet (no other apps, no builds, on AC power), run
this once on the release commit:

```sh
npm run build:packages
npm run bench -- --label=official --record
npm run bench -- features
```

The gate refuses battery power and waits for a quiet CPU and GPU. Any case whose runs spread more than 10% makes the
run invalid. An official label on an invalid run stays invalid. The head-to-head with three.js and other engines runs
the same scenes from `C:DevelopmentProjectsengine-bench` (`--engines=all`, see docs/benchmarking.md "Comparing
engines").

## The five-minute quickstart

The launch claim is that a developer builds a textured, lit scene with shadows and picking in under five minutes by
copy-pasting the README. `npm run check:quickstart` measures the machine part and asserts the result in a real browser:

```sh
npm run check:quickstart                                   # route 2: an own project from local tarballs
npm run publish:rehearsal                                  # the one-line install from a stand-in registry; publishes nothing
node scripts/quickstart-timing.mjs --route=1 --keep --dir=<folder>   # route 1 (the clone's page); keep the folder
```

It clones this checkout (uncommitted work laid over it) into a temp folder with a cold npm cache, then does what the
README says line by line: `npm ci`, `npm run pack:packages`, a new project, `npm install <tarballs> vite`,
`index.html` and `main.ts` extracted from the README text itself (never retyped), `npx vite`, and the page in headless
Edge under one shared GPU slot. The browser asserts, from pixels and handlers:

- a first frame with content, and sharp checker edges on the floor (none in the same scene without the texture);
- a shadow beside the ball, darker than the same scene without `shadows.add`, also on the shipped page;
- a click on the ball and on the crate fires the page's pick handler (waited for) and draws the outline, and an orbit
  drag changes the picture without picking;
- a console with no warning or error (one recorded Chrome-on-Windows warning is reported, see known-bugs.md);
- the messages shown with no `navigator.gpu` and with an adapter request that answers null.

It writes `test-results/quickstart-timing.json` (timeline, sizes, notes) and the pictures in
`test-results/quickstart-timing/`. The three reference pages open one at a time beside the shipped page, and each is
closed once its picture is taken: on an Intel Arc 140V the 4th WebGPU page alive at once in one browser process never
finished starting. A page that is not ready in time leaves `failed-<page>.png` and `failed-<page>.json` there
(visibility, canvas sizes, animation frames per second, what the page logged) before the check fails. It fails over
300 s from the first command to the verified interactive frame, and ends every process it started at a hard limit of
900 s. It is a step of `check:merge`, so the nightly full run has it too.
Not measured: reading the page and copying the two files, and anything after the first interactive frame. The install
route is a clone because 1.0.0 is not on npm yet.

## Rules for real-GPU numbers

- A quiet machine: on an integrated GPU the CPU and GPU share one power budget, so a build or test running at the same
  time changes the GPU numbers too.

- AC power before and after (`(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline`
  on Windows). The scripts check it and refuse or flag battery runs; on battery Windows throttles CPU and GPU.
- One GPU job at a time: the scripts take `test-results/gpu.lock` in the main checkout (they wait while another run
  holds it). Close other GPU apps; on an integrated GPU even a browser tab changes the result.
- Headless Edge/Chrome with `--disable-gpu-vsync --disable-frame-rate-limit`, so FPS is throughput, not the display.
- Medians of alternating rounds; compare A/B only within one run (clocks drift between runs).

## Commands by claim area

| Area | Command | GPU | Output | Notes |
| --- | --- | --- | --- | --- |
| Core + stage gzip (CI gate, < 25,000 B) | `npm run measure:size` | no | console | Also enforced by `npm run build:packages`. |
| meshopt, TypeScript against Wasm SIMD | `node packages/decoders/scripts/meshopt-simd-bench.mjs <file.glb>` (after `npm run build --workspace packages/decoders`) | no | console | Any glTF binary compressed by gltfpack; perf-history entry 75. |
| Own physics step profile and harness bars, native (Lane Q tuning) | `cargo run --locked --release --manifest-path packages/physics/kernel/Cargo.toml --example profile -- [pyramid\|cubes1000\|cubes5000\|cubes1000-awake\|cubes5000-awake\|chain\|grid\|all] [default\|equal]`; `... --example bars` | no | console | `profile` times each phase of `World::step` and counts awake bodies, pairs, solved pairs and points per step; a twin world stepped by `World::step` must end hash-equal, so the profile cannot time a different step. `bars` gives the bounce, pyramid and heavy-on-light numbers of `physics-refs/js/margo-next/margo3d.mjs` at both settings; native and Wasm agree bit for bit, so they are the harness's numbers. Timings are hints on a loaded machine (`docs/work-lists/busy-retests.md`). |
| Own physics separating axis test against every axis (LIM-369) | `npm run test:physics-kernel` | no | no | under a minute |
| Flock of 1,000 against Yuka (perf history entry 93) | `node packages/behavior/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/behavior` | no | console | Yuka 0.7.8 is installed outside the repository under engine-bench `batch-167` (`MARGO_ENGINE_BENCH` overrides the folder). Paired turns, per-round minimum. Busy-machine numbers are diagnostic. |
| Navmesh build and path length against recast-navigation (perf history entry 94) | `node packages/navmesh/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/navmesh` | no | console | recast-navigation 0.44.0 is installed outside the repository under engine-bench `batch-167`. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The open-floor length and the gapped hole check are `node --test packages/navmesh/test/path-length.test.js`. |
| 100,000 entities against bitECS (perf history entry 95) | `node packages/ecs/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/ecs` | no | console | bitECS 0.4.0 is installed outside the repository under engine-bench `batch-167`. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. Both checksums are `n = 100000`, `sum = 5000050000`. |
| 10,000 transitions against XState (perf history entry 96) | `node packages/fsm/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/fsm` | no | console | XState 5.33.4 is installed outside the repository under engine-bench `batch-167`. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. Both machines end in state `a`. |
| 10,000 tweens against tween.js (perf history entry 97) | `node packages/tween/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/tween` | no | console | tween.js 25.0.0 is installed outside the repository under engine-bench `batch-167`. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The linear halfway rule is `node --test packages/tween/test/linear-oracle.test.js`. |
| Rollback resimulation (perf history entry 98) | `node packages/netcode/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/netcode` | no | console | No JavaScript rival (GGPO is C++, Colyseus is not rollback). Paired turns, per-round minimum of 180 frames. Busy-machine numbers are diagnostic. |
| Save migration fuzz (perf history entry 99) | `node packages/save/scripts/fuzz-roundtrip.mjs` after `npm run build --workspace @margoengine/save` | no | console | No rival package. Seed 167, 200 documents. The regression test is `node --test packages/save/tests/migration-fuzz.test.js`. Busy-machine numbers are diagnostic. |
| matmul-256, fft-65536 and a sum of 1,048,576 against TensorFlow.js (perf history entry 100) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/compute/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/compute` | yes | console | TensorFlow.js 4.22.0 and tfjs-backend-webgpu 4.22.0 are installed outside the repository under engine-bench `batch-167`. Node 26.12 has no WebGPU, so both run in one headless page, taking turns. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The NumPy oracle is `node --test packages/compute/tests/numpy-oracle.test.js`. |
| volume-64 against VTK.js (perf history entry 102) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/sciviz/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/sciviz` | yes | console | VTK.js 38.0.5 is installed outside the repository under engine-bench `batch-167`. One headless page, taking turns. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The field is `node --test packages/sciviz/tests/volume-field.test.js`. |
| Truck 7k prefix against GaussianSplats3D (perf history entry 103) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/splats/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/splats` | yes | console | GaussianSplats3D 0.4.7 and three 0.170.0 are installed outside the repository under engine-bench `batch-168`. The truck ply, the `000001` JPEG and `cameras.json` stay in that folder's `data` (not in this repo). The bench writes `truck-7k-fit.ply` there, the first 699,050 vertices. One headless page, taking turns. Paired turns, per-round minimum. Busy-machine numbers are diagnostic. The fit count is `node --test packages/splats/test/storage-fit.test.js` and the pose maths are `node --test packages/splats/test/paper-camera.test.js`. |
| Quadtree screen-space error against 3DTilesRendererJS (perf history entry 104) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/tiles/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/tiles` | yes | console | 3DTilesRendererJS 0.4.21 and three 0.170.0 are installed outside the repository under engine-bench `batch-168`. The quadtree is built in the process (5,461 tiles, one shared GLB). One headless page. The rival's `errorTarget` is set to 16. Paired turns, per-round minimum, after loads settle. Busy-machine numbers are diagnostic. The Margo set is `node --test packages/tiles/tests/sse-scene.test.js`. |
| 10 million points against potree-core (perf history entry 105) | `node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/points/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/points` | yes | console | potree-core 2.0.17 and three 0.170.0 are installed outside the repository under engine-bench `batch-168`. The bench writes `data/points-10m` there (metadata.json, hierarchy.bin, octree.bin, 200,000,000 bytes of points) and does not commit it. One headless page. Both budgets are 10,000,000. Paired turns, per-round minimum, after the leaf has loaded. Busy-machine numbers are diagnostic. The grid is `node --test packages/points/tests/points-10m.test.js`. |
| Cornell box irradiance against Cycles (perf history entry 108) | `node packages/lightmap/scripts/rival-bench.mjs` after `npm run build --workspace @margoengine/lightmap` | no | console | Blender 5.3.0 Beta is `C:\blender\blender.exe` (`MARGO_BLENDER` overrides it). Cycles bakes on the CPU. The bench writes `data/cornell` under engine-bench `batch-168` (`MARGO_ENGINE_BENCH` overrides the folder) and does not commit it. 128 samples, `diffuse_bounces` 2. The snaps and the direct integral are `node --test packages/lightmap/tests/cornell-box.test.js`. |
| Own physics GJK and expanding polytope against brute force (LIM-372) | `npm run test:physics-kernel` | no | no | under a minute |
| Own physics replay, Node, native, Chromium and Firefox (LIM-366) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` and `npm run test:replay --workspace @margoengine/physics` | no | `packages/physics/test-results/replay-browsers.json` | Install Firefox once with `node node_modules/@playwright/test/cli.js install firefox`. `REPLAY_FIREFOX` names a `firefox.exe` where Playwright's own will not start. |
| Own 2D physics in Wasm: the pinned bits on WebGPU and WebGL2 pages, and the 100-row pyramid against Rapier 2D's Wasm and Box2D v3's Wasm (perf history entries 88 and 89) | `npm run check:rust-kernels -- --packages=physics2d` (Node), then `node scripts/physics2d-kernel-browsers.mjs` (`npm run test:physics2d-kernel-browsers` is its check:merge form: the default browser, bits only; `REPLAY_FIREFOX` names a Firefox copy on a PC that will not start Playwright's from the home folder). Box2D v3 joins when `BOX2D_WASM` names its build, made outside the repository as a black box: clone the official emsdk (`git clone https://github.com/emscripten-core/emsdk`, then `python emsdk.py install latest` and `python emsdk.py activate latest`; Emscripten 7.0.0 here), configure Box2D v3.2.0's own CMake project under `emcmake` with `-DCMAKE_BUILD_TYPE=Release -DBOX2D_SAMPLES=OFF -DBOX2D_UNIT_TESTS=OFF -DBOX2D_BENCHMARKS=OFF -DBOX2D_VALIDATE=OFF` (its Emscripten defaults add `-pthread -msimd128 -msse2 -ffp-contract=off`), build it, and link a harness on its public API that exports `bench_pyramid(rows)`, `bench_step()` and `bench_top_y()` with `emcc -O3 -pthread -msimd128 -msse2 -sMODULARIZE -sEXPORT_ES6 -sINITIAL_MEMORY=268435456` (physics-refs `wasm/box2d3/build.sh` and `pyramid.c`) | yes (WebGPU pages, takes the GPU lock) | `test-results/physics2d-kernel-browsers.json` | about a minute; timings are paired in one page, busy-machine numbers are diagnostic |
| Own 2D physics against Box2D v3 natively, eight lanes and four (perf history entry 91) | Margo: `cargo test --release --manifest-path packages/physics2d/kernel/Cargo.toml --test bits -- --ignored --nocapture step_time` (the four-lane solve, SSE2). Box2D v3.2.0, built outside the repository as a black box: physics-refs `native/box2d3/profile.cpp` (its own per-phase profile through the public API) built by `native/scripts/native-build.bat` (Box2D's defaults: its contact file at `/arch:AVX2`, eight lanes on an AVX2 CPU) and by `native/scripts/native-build-sse2.bat` (`-DREFS_BOX2D_SSE2=ON` into `native/build-sse2`: the harness file `box2d3/no_avx2.c` answers 4 to Box2D's SIMD width query and false to `b2IsAVX2Available`, so the four-lane SSE2 solve runs, and says so on stderr); run the builds in turns | no | printed | under a minute; busy-machine numbers are diagnostic |
| Own physics contact ids and warm start (LIM-376) | `npm run test:physics-kernel` | no | no | under a minute |
| Own physics manifold reduction and persistence (LIM-380) | `npm run test:physics-kernel` | no | no | under a minute |
| Own physics contact solver against mechanics (LIM-381) | `npm run test:physics-kernel` | no | no | under a minute |
| Own physics joints against mechanics (LIM-399) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics cone joints and limits (LIM-402) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics spherical motors (LIM-405) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics rope and spring joints (LIM-422) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics contact forces (LIM-423) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics events and filters (LIM-425) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics joint stability (LIM-416) | `npm run test:physics-kernel`, `npm test --workspace @margoengine/physics` | no | no | under a minute |
| Own physics convex decomposition against Rapier (LIM-514) | `npm run build --workspace @margoengine/physics`, then `node packages/physics/scripts/decomposition-vs-rapier.mjs` (add `--greedy` for the paper's one-step baseline, the like-for-like row); `node --test packages/physics/tests/next-decomposition.test.js` | no | console table | about a minute; times need a quiet PC |
| Margo vs other engines, bundle size | `npm run bench -- size --engines=all` | no | `benchmarks/runs/<id>.json` | Each engine's smallest lit-box app from engine-bench (`sizeEntry`) vs Margo's whole core + stage, all built with the size gate's output options. The last three.js measurement stays in `results/threejs-size.json`. |
| Potree reader on real folders | Fetch a folder (`git clone` or `curl`), then `node packages/points/tests/potree-check.mjs <folder URL or path>` (after `build:packages`). Folders used 2026-11-06: `pointclouds/lion_takanawa`, `lion_takanawa_normals`, `lion_takanawa_las`, `lion_takanawa_laz`, `vol_total` of github.com/potree/potree (branch develop), `pointclouds/potree2.0/lion` of github.com/iTowns/iTowns2-sample-data (BROTLI, CC BY-NC-SA, not in this repository), `example/data/pump` of github.com/tentone/potree-core | no | console, one JSON line | Exit 0 when every point lies in its node and counts match. Results: 272,768, 341,989, 341,989, 341,989, 498,868, 3,954,696 and 1,213,990 points, none outside. |
| Every package entry and worker, min+gzip | `node examples/package-benchmarks/entry-sizes.mjs` (after `build:packages`) | no | `results/entry-sizes.json` | build-modern's method, other packages external; also feeds the Gzip column of `docs/api-surface.md`. |
| Eager JS per demo | `npm run bench -- size --cases=demo-` | no | `benchmarks/runs/<id>.json` | Builds each demo with Vite. |
| Per-package min+gzip | `node examples/package-benchmarks/proofs/size.js` | no | `proofs/results/sizes.json` | |
| VFX entry sizes | `node examples/package-benchmarks/vfx-size.mjs` | no | `results/vfx-size.json` | |
| Package optimization proofs (same GPU calls / same output, faster) | `node examples/package-benchmarks/proofs/<name>.proof.js [ref]` | no (recording mock GPU) | `proofs/results/<name>.json` | Each builds a baseline ref; some default refs no longer build (see claims.md). |
| Kernel tick in Node | `npm run bench -- parts --cases=kernel` (or `node examples/package-benchmarks/parts/kernel-node.mjs`) | no | `benchmarks/runs/<id>.json` (`parts/results-kernel-node.json`) | |
| glTF export: validator errors and export time | `node examples/package-benchmarks/exporters-model.mjs` | no | `results/exporters-model.json` | Khronos glTF-Validator from node_modules; the timing needs the quiet PC. |
| Textured instancing, encoding CPU | `node examples/package-benchmarks/textured-instancing.mjs` | no (mock) | `results/textured-instancing.json` | Mock GPU: CPU encoding only, not frame rate. |
| Precise maths against the builtins, in the bench tool | `npm run bench -- compute --cases=compute-elementwise --runs=3` and `npm run bench -- tracer --runs=3` | yes | `benchmarks/runs/<id>.json` | perf-history entry 71. The record is the `precise-math-gpu.mjs` row. |
| **Margo vs other engines, same scenes** | `npm run bench -- render objects scaling --engines=all` | yes | `benchmarks/runs/<id>.json`, screenshots in `benchmarks/runs/<id>/` | Scenes in `bench/scenes/catalog.js`; other engines' implementations live in engine-bench. Earlier results: `results/vs-threejs-*.json`. |
| GPU culling | `node examples/package-benchmarks/parts/culling.mjs --check --label=<name>` | yes | `parts/results-<name>.json` | |
| Post stack per effect, SSAO + IBL | `node examples/package-benchmarks/gates/post-stack.mjs` | yes | `results/gates-post-stack.json` | |
| DOF before/after | `node examples/package-benchmarks/gates/dof.mjs --baseline=5b9dbbd` | yes | `results/gates-dof.json` | Builds the baseline. |
| Loaders + memory cycles | `node examples/package-benchmarks/gates/memory.mjs` | yes | `results/gates-memory.json` | |
| Native glass tint draw cost | `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/tint-pass-gpu.mjs` | yes | `results/tint-pass-gpu.json` | Patches the served gltf-pro build for its comparison arms; fails if an arm leaves the frame unchanged. About 10 minutes. |
| Precise maths against the WGSL builtins | `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/precise-math-gpu.mjs` | yes | `results/precise-math-gpu.json` | Compute functions and path tracer lenses. |
| Growable ECS worlds against fixed ones | `node examples/package-benchmarks/ecs-growable.mjs` | no | console | |
| Workgroup sizes of the compute package's own kernels | `node scripts/gpu-lock.mjs run --owner=<id> -- node packages/compute/tests/compute-browser.mjs`, line `tuneCompute, 16M elements` | no | console | perf-history entry 77 |
| Subgroup kernels against the default compute kernels | `node examples/package-benchmarks/compute-subgroups.mjs` | yes | `examples/package-benchmarks/results/compute-subgroups.json` | |
| Shadow shimmer | `node examples/package-benchmarks/shadow-shimmer.mjs` | yes | `results/shadow-shimmer.json` | |
| Textured instancing on GPU | `node examples/package-benchmarks/textured-instancing-gpu.mjs` | yes | `results/textured-instancing-gpu.json` | |
| Atlas + VAT | `node examples/package-benchmarks/atlas-vat/check.mjs` | yes | `test-results/atlas-vat-check.json` | Result is not committed today. |
| Workers / OffscreenCanvas | `node examples/package-benchmarks/workers/run.mjs` | yes | `results/workers.json` | Edge and Chrome. |
| VFX 100k/1M particles | `node examples/package-benchmarks/vfx-gpu.mjs --a=<dist> --b=packages/vfx/dist` | yes | `results/vfx-gpu-*.json` | A/B of two builds: snapshot a baseline dist first (header of the script). Not in the features suite. |
| Scatter cull, atomic against ordered (LIM-034) | `node examples/package-benchmarks/scatter-cull-gpu.mjs --a=test-results/scatter-base --b=packages/scatter/dist` | yes | `results/scatter-cull-gpu-*.json` | A/B of two builds: snapshot a baseline dist first (header of the script). Asserts both builds hold the same instances. |
| Island demo with VFX | `node examples/package-benchmarks/vfx-island.mjs --variants=...` | yes | `results/vfx-island-*.json` | Needs variant builds. Not in the features suite. |
| Pipeline toggles | `node examples/package-benchmarks/pipeline-toggles/toggle.mjs [stall|pixels|gpu|override]` | yes | `results/pipeline-toggles.json` | Not in the features suite (needs `old-gltf.mjs` first for `pixproof`). |
| Every real-browser test | `node examples/package-benchmarks/gates/run-browser-tests.mjs` | yes | `results/gates-browser-tests.json` | 41 scripts; `modern-hardware-gpu-tests.js` needs `GPU_VENDOR` and a discrete GPU. |
| Light-tier pace and GPU reading (LIM-077) | `npm test --workspace @margoengine/quality` | no | console | A physical 100 Hz display shows it live: the voxel sandbox's HUD with `?seed=1`. |
| Bulk transform writes against setters | `node packages/scene/scripts/bulk-bench.mjs 10000` | no | console | CPU only; build the package first. |
| Engine bridge sync, four cases (perf-history entry 74) | `npm run build --workspace packages/ecs`, then `node packages/ecs/scripts/bridge-bench.mjs` | no | console | CPU only. |
| Every three.js parity row (perf-vs-threejs) | `npm run build:packages`, then `npm run bench:parity` | yes | `docs/whitepaper/perf-vs-threejs.md`, `.json` | The ledger keeps every run. The numbers below are diagnostic until a quiet run. |
| One parity row (perf-history entries 56 to 60, 63, 65 to 69) | `node bench/cli.mjs parity --cases=<scene> --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` | yes for frame scenes | `benchmarks/runs/<id>.json` | Scenes: `p-morph`, `p-morph-compiled`, `p-stl`, `p-stl-normals`, `p-skeleton-clone`, `p-gpu-pick`, `p-gpu-pick-batch`, `helmet`, `p-motion-blur`, `p-motion-blur-velocity`, `p-custom-shader`, `p-rect-area`, `p-pmrem`, `p-pmrem-refresh`, `p-export-usdz`. Each entry names its own engines and runs. |
| Instanced and moving boxes against three.js (entries 50, 51, 53, 54) | `npm run bench -- instanced --engines=margo,three-webgl,three-webgpu --runs=3` and `npm run bench -- dynamic --engines=margo,three-webgpu --runs=3` | yes | `benchmarks/runs/<id>.json` | |
| Polygon offsets (entry 52) | `npm run build` in `packages/geometry`, then `node packages/geometry/scripts/polygon-bench.mjs` | no | console | |
| Not repeatable by a script yet | - | - | - | The `Spring` timing (entry 55), the WebGL2 CPU tier's interpreter (entry 72) and the path tracer on the layer (entry 73). Each is on the re-measure list. |
| WebP and DDS against outside decoders (LIM-285) | `npm run build:packages`, then `node packages/decoders/scripts/test-real-textures.mjs <empty folder>`: downloads the files of `packages/decoders/tests/real-files/manifest.json`, checks each SHA-256, and compares with the planes dwebp 1.4.0 wrote and with Pillow's PNGs | no | prints the counts, exit 1 on any difference |
| Held textures in Blender (LIM-285) | In Node serve a Khronos glTF-Sample-Assets model folder over HTTP, `loadGLTF(engine, url, {ktx2: nodeKTX2, maxDownloadBytes: 2 ** 29})`, `exportOBJ(engine, {materials: true, textures: true})`, `await writeTextures(result)`, write the files. In Blender `wm.obj_import`, then compare each material's image with the model's source image at `Non-Color`, per channel | no | largest and mean difference of 255 |
| OBJ, STL and PLY of loaded models in Blender (LIM-277) | On a real page `loadGLTF` a GLB, then `exportSTL(engine)`, `exportPLY(engine, { binary: true })` and `exportOBJ(engine, { materials: true, textures: true, mtlName: 'tex.mtl' })`. In `blender --background --factory-startup` read the source with `import_scene.gltf(guess_original_bind_pose=False)` and the others with `wm.stl_import`, `wm.ply_import` and `wm.obj_import(forward_axis='NEGATIVE_Z', up_axis='Y')`, leaving out the glTF importer's `glTF_not_exported` collection, and compare world bounds. Use models with no clips: a source with clips imports posed. For the OBJ, connect each material's base colour to an emission surface, multiply `map_Kd` by `Kd` decoded from sRGB, draw source and OBJ with Cycles from one orthographic camera and compare pixels | no | console | Blender is run by hand. |
| COLLADA in Godot and SceneKit (LIM-284) | On a real page `loadGLTF` a GLB and `exportDAE(engine)`. Put the file in an empty Godot 4.7 project, run `--headless --import`, then load it from a script and add up `surface_get_array_index_len`: robot-expressive gives 9,711 and no `Multiple instance_*` error. On a Mac open it with `SCNScene(url:)` and count `geometry.elements`: 19 groups in 14 geometries. | Godot 4.7.2, macOS 27 SceneKit |
| `decodePNG` on PngSuite (LIM-093) | `npm test --workspace packages/headless`: each file's pixels hash to what `packages/headless/tests/fixtures/pngsuite/chromium.json` holds. To remake that file, load each PNG in Chromium with `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })`, upload it to a WebGL2 texture and `readPixels` | no | console | Reading through WebGL keeps alpha unpremultiplied, which a 2D canvas does not. |
| Compressed GLB in Blender and Godot (LIM-243, LIM-250, LIM-258, LIM-262) | In Node run `compressDraco`, `compressMeshopt`, `optimizeGLB` and `compressTextures` on Fox, robot-expressive, RiggedFigure, MorphStressTest, flight-helmet, scifi-helmet, NegativeScaleTest, OrientationTest, ToyCar and Lantern. In `blender --background` import each with `bpy.ops.import_scene.gltf`, then compare meshes, triangles, materials, images, bones, clips and world bounds with the source. Put the files in an empty Godot 4.7 project, run `--headless --import`, then add up `surface_get_array_index_len` from a script and compare with the source | no | console | Godot has no Draco or meshopt support and refuses those files. Blender has no `KHR_texture_basisu`. Run by hand, 2026-11-06, Blender 5.3 and Godot 4.7.2. |
| Blender add-on in real Blender (LIM-287) | `MARGO_BLENDER=<path to blender> npm run modern:test:blender` after `npm run build:packages` | yes | console, `test-results/blender/` | Not in the checks: Scott has not cleared Blender for them. Run by hand, 2026-11-06, Blender 5.3 and an RTX A6000. |
| USDZ on real models against Apple's tools (LIM-253) | Export with `exportUSDZ`, then on a Mac `usdchecker --arkit model.usdz` and `usdcat --flatten model.usdz -o flat.usda`; take each `Mesh_<i>`'s points through its `xformOp:transform` and compare with the source nodes | no | console | By hand, on a Mac. |
| USDZ in Blender and Quick Look (LIM-095, LIM-253) | `exportUSDZ(bytes)` each GLB. `blender --background --factory-startup --python tools/real-proof/blender_report.py -- out.json a.glb a.usdz` for source and file, then `node tools/real-proof/glb_bounds.mjs a.glb` where the two disagree: Blender's rest pose drops bone scale (robot-expressive) and its GLB import leaves a model at a clip's first frame (CommercialRefrigerator, door ajar). On a Mac `usdcat --flatten` and count Mesh prims; `tools/real-proof/quicklook_thumbnails.swift`, one file at a time | no | console, PNG | By hand, 2026-11-06. Thumbnails are read by eye. |
| Cloud saves on Apache (LIM-418) | Run Apache with `mod_dav` and `mod_dav_fs`, `Dav On` on a folder, on a local port, then `node packages/save/tests/apache-check.mjs http://127.0.0.1:<port>/<folder>` after `npm run build --workspace @margoengine/save` | no | console | By hand, 2026-11-07, Apache 2.4.67 on macOS. |
| Safe writes on POSIX disks (LIM-414) | On macOS or Linux, `node --test packages/save/tests/file-storage.test.js packages/save/tests/safe.test.js` after a build | no | console | By hand, 2026-11-07, macOS APFS and Linux ext4; `npm test` holds the same tests on the machine it runs on. |
| Safari on a Mac (LIM-026, LIM-233) | `tools/real-proof/README.md`, `safari/`: the same `dist` in Safari and in Edge, then compare the pictures the page posts | no | `report.json` | By hand, 2026-11-06, Safari 27.2 on an Apple M6 and Edge 156 on an RTX A6000. |
| EXR in Blender (LIM-094) | In Node `encodeEXR` a 17 by 9 float image with values to 1,000 and alpha, `half` and `float`. In `blender --background` load each with `bpy.data.images.load`, set `alpha_mode = 'CHANNEL_PACKED'`, `reload()`, and compare `image.pixels`, whose rows run bottom up | no | console | Without `CHANNEL_PACKED` Blender multiplies colour by alpha. |
| Real files in Blender (LIM-208) | `REAL_FILES_ONLY=ply,stl,obj,usd npm run test:real-files -w @margoengine/loaders`, then `tools/real-proof/blender_report.py` on what it downloaded and compare bounds; OBJ and USD turn Y up to Z up | no | console | Spider_ascii.stl: Blender merges 56 of the file's 1,368 triangles, the reader keeps them. |
| State machines against Sismic (parallel regions and what follows) | `python -m venv <folder>`, `<folder>/Scripts/python -m pip install sismic==1.6.14`, `npm run build --workspace @margoengine/fsm`, then `MARGO_SISMIC_PYTHON=<folder>/Scripts/python npm run test:outside --workspace @margoengine/fsm` | no | prints charts, steps, moves and differences; rewrites `packages/fsm/test/outside/traces.json` | Exit 1 on any difference. `npm test` replays the recorded traces with no Python. |
| Meshopt export on real models against outside tools | `compressMeshopt` a GLB, then `gltfpack -i out.glb -o back.glb -noq` and `gltf-transform inspect out.glb`; decode each stream with the `meshoptimizer` package's `MeshoptDecoder.decodeGltfBuffer` and run the Khronos validator on the result | no | console | By hand; no script in the repository. |
| GLB optimize on real models against outside tools | `optimizeGLB` a GLB with its defaults and with `{ simplify: 0.5, lods: [0.5, 0.25] }`, run the Khronos validator on input and output, then `gltfpack -i out.glb -o back.glb -noq` and `gltf-transform inspect out.glb`; compare the triangles of each node, corner by corner, and each level's vertices with the source's | no | console | By hand; no script in the repository. |
| USDZ real size on real models (LIM-265) | `exportAnimatedUSDZ` each clip and read `size` and `bounds`; compare `bounds` with glTF maths at every frame, node transforms and skinning applied, weights normalized. On a Mac, load the file with RealityKit's `Entity(contentsOf:)` and read `visualBounds(relativeTo: nil)`, and render with `usdrecord --sessionLayer cam.usda --camera Cam -f <frame>` through one fixed camera to compare a file before and after a change. On an iPhone, open the file in AR Quick Look, place it on a floor and check it stands in view at about 2 m and moves with a drag | no | console | By hand; no script in the repository. RealityKit's bounds do not run the skeleton, so they read the rest points. Only the phone shows placement, clipping and moving. |
| USDZ animation on real models against Apple's tools | `exportAnimatedUSDZ` each clip of a rigged GLB, then on a Mac `usdchecker --arkit out.usdz` and `usdcat --flatten out.usdz -o flat.usda`; evaluate the flattened skeleton and Xforms by UsdSkel's rules at a few frames and compare the world bounds with glTF's skinning maths; load it in ModelIO, SceneKit and RealityKit | no | console | By hand; no script in the repository. |
| USD composition against OpenUSD (LIM-303) | Run `packages/usdz/tests/oracle/truth.py` inside Blender's Python on a list of files, for example `blender --background --factory-startup --python packages/usdz/tests/oracle/truth.py -- list.txt truth.json`, then open each file with `composition()` and compare meshes, world bounds, triangle counts and bound materials. `tests/oracle/generate-stages.py` writes stress stages. |
| UsdSkel against OpenUSD (LIM-310) | `packages/usdz/tests/oracle/skel-truth.py` inside Blender's Python on a list of files gives each mesh's points at five times through `UsdSkel.Cache`, `SkinningQuery` and `BlendShapeQuery`. Parse the same file with `skeletons()`, pose it by plain glTF rules (`packages/usdz/tests/pose.js`) and compare point by point. Apple's and Pixar's samples are read from a local download. | yes |
| Time samples against OpenUSD (LIM-315) | `packages/usdz/tests/oracle/anim-truth.py` inside Blender's Python on a list of files gives each moving prim's world matrix and visibility at several times through `UsdGeom.XformCache` and `ComputeVisibility`. Parse the same file with `animation()`, pose it by plain glTF rules (`packages/usdz/tests/pose.js`) and compare matrix by matrix. The usd-wg files are at commit 091bb5c6; Pixar's are read from a local download. | yes |
| Subdivision against Blender (LIM-319) | `packages/usdz/tests/oracle/subdiv-truth.py` (points) and `subdiv-uv-truth.py` (face-varying values, in the mode each mesh authors) run inside Blender 5.3 on a list of files and give refined points and corners through its Subdivision Surface modifier, with `use_limit_surface` off. `subdiv-faces.py` writes the stand-in stage and its truth in all six modes. Parse the same files with `subdivision({level:2})` and pair corners by nearest point, not by a rounded key. Real meshes of the Kitchen Set, OpenChessSet, usd-wg assets and HumanFemale are read locally; two usd-wg files are committed. |
| Lights and cameras against OpenUSD (LIM-320) | `packages/usdz/tests/oracle/lux-truth.py` inside Blender's Python gives each light's and camera's world matrix through `UsdGeom.XformCache`, each camera's frustum through `Gf.Camera`, and `UsdLux.BlackbodyTemperatureAsRgb`. Parse the same stages with `lights()` and compare node world matrices under the root node. The 55 real stages are the files of the usd-wg assets that hold lights or cameras, read locally. |
| Reset transform stacks against OpenUSD (LIM-324) | `packages/usdz/tests/oracle/reset-truth.py` inside Blender's Python writes the stand-in stage and what OpenUSD computes for it into `tests/fixtures/xform/`; `node --test packages/usdz/tests/reset.test.js` compares. |
| MaterialX in USD against OpenUSD (LIM-331) | `packages/usdz/tests/oracle/materialx-truth.py` inside Blender's Python writes what `UsdShade` reads from each material, with the shader registry's defaults, to `tests/fixtures/materialx/openusd.json`; `node --test packages/usdz/tests/materialx.test.js` compares. 53 of the 58 materials are in stored files; the two large stages, `StandardShaderBall/layers/shaderball.usda` and `MaterialXTest/basicTextured_flatten.usda` of the usd-wg assets, are read when copied beside them. `npm run modern:test:usdz:browser` compiles the networks on the GPU. |
| 3MF on real models against a slicer and Windows | `export3MF` a GLB, then `prusa-slicer-console --info out.3mf` and `prusa-slicer-console --support-material --export-gcode --merge --scale-to-fit 150,150,150 --center 100,100 --output out.gcode out.3mf` (without `--support-material` for the 22 of 26); for a print-ready model, read https://github.com/CreativeTools/3DBenchy `Single-part/3DBenchy.stl` with `parseSTL`, `export3MF` it with `upAxis: 'z'`, and slice both with `--export-gcode --center 100,100`, comparing layers and filament; load it with `Windows.Graphics.Printing3D.Printing3D3MFPackage` and compare unit, triangles, items and colours with the file written | no | console | By hand; no script in the repository. |
| FBX cameras and lights from Blender | `blender --background --factory-startup --python packages/fbx/test/fixtures/blender-shot.py -- <folder>` writes the two FBX files and Blender's own numbers as JSON; `node --test packages/fbx/test/scene-extras.test.js` compares them after `npm run build --workspace @margoengine/fbx` | no | console | Blender is run by hand; the fixtures and its numbers are checked in. |
| FBX UV sets and colour layers from Blender | `blender --background --factory-startup --python packages/fbx/test/fixtures/blender-layers.py -- <folder>` writes the FBX and Blender's own values as JSON; `node --test packages/fbx/test/layers-option.test.js` compares them after `npm run build --workspace @margoengine/fbx` | no | console | Blender is run by hand; the fixture and its values are checked in. |
| FBX inherit types against Maya | `node --test packages/fbx/test/inherit.test.js` after `npm run build --workspace @margoengine/fbx` compares a converted rig, posed by plain glTF rules with its skin, with the eight OBJ frames Maya wrote (`packages/fbx/test/fixtures/real/`) | no | console | Sources and sums in that folder's NOTICE.md. |
| FBX animation layers against Maya | `node --test packages/fbx/test/layers.test.js` after `npm run build --workspace @margoengine/fbx` compares a converted clip, posed by plain glTF rules, with the OBJ frame Maya wrote (`packages/fbx/test/fixtures/real/`) | no | console | Sources and sums in that folder's NOTICE.md. |
| FBX PBR materials from Max and Maya | `node --test packages/fbx/test/pbr.test.js` after `npm run build --workspace @margoengine/fbx` reads real 3ds Max and Maya files. |
| FBX curves and deformers against Max and Maya | `node --test packages/fbx/test/curves.test.js packages/fbx/test/deformers.test.js` after `npm run build --workspace @margoengine/fbx` reads real files and Maya's OBJ frames. |
| FBX camera and light export in Blender | Write a scene with `exportFBX`, then `blender --background --factory-startup --python packages/fbx/test/fixtures/blender-read-export.py -- /absolute/file.fbx /absolute/out.json` and compare the JSON with the scene, Blender's axes being x, -z, y. |
| WebTransport in a real browser against a real HTTP/3 server | `python -m venv <folder>`, `<folder>/Scripts/python -m pip install aioquic==1.7.2`, `npm run build --workspace @margoengine/netcode`, then `node packages/netcode/tests/webtransport-proof/proof.mjs <folder>/Scripts/python`. It starts `server.py`, opens the built `openWebTransport` in Playwright's Chromium, and prints each message and `proof passed` | no | console | By hand, 2026-11-07 |
| Unit tests, API snapshots, size gate | `npm run verify` | no | console | `npm run verify:full` adds packed-package and interop suites. |

## A second machine

On a discrete-GPU desktop or a Mac: the setup above, then `npm run bench` and `npm run bench -- features`, and
keep the `benchmarks/runs/` folder. On Linux or macOS the AC check returns `null` (recorded, not enforced). Set
`MARGO_BROWSER=chrome` where Edge is not installed. On macOS, `MARGO_BROWSER=webkit` runs the browser suites in Playwright's
WebKit build, which has WebGPU there (`npx playwright install webkit`). That is not Safari. Phones are not scripted yet.

## Own 2D four-pair narrow phase (perf history entry 92)

The Rust kernel's batch API has a runnable doctest in `kernel/src/manifold/four.rs`; the package's JavaScript
Rapier facade is unchanged. From the repository root, with cargo on PATH:

```sh
npm run test:physics2d-kernel
npm run check:rust-kernels -- --packages=physics2d
cargo test --locked --release --manifest-path packages/physics2d/kernel/Cargo.toml --test manifold_exact -- --ignored --nocapture narrow_ab
```

The ignored benchmark compares current scalar collision and four-pair collision on the identical 14,950-pair
pyramid snapshot, checks every output bit first, alternates first position per visit, and prints the minimum of
five visits per round for 30 rounds. The normal exactness tests still compare both paths with the untouched kept
reference. For a whole-step Wasm A/B, build the baseline and new `kernel/wasm-check/Cargo.toml` with `--locked
--release --target wasm32-unknown-unknown` and `RUSTFLAGS=-C target-feature=+simd128`, keeping the two modules.
Instantiate both in one Node process, require every `check(i)` to return zero, then in each of 24 rounds create a
100-row pyramid, settle 60 steps and take the minimum of the next 40; alternate which module goes first each round.
Lane P's local driver is `.lane/p/ab-wasm.mjs old.wasm new.wasm 24`. The committed
[record](results/physics2d-four-pairs-20261108.json) contains every round and the separate phase-probe rows.

For the browser comparison set `BOX2D_WASM` to the existing external `box2d3-pyramid.mjs` black box,
`REPLAY_FIREFOX` if needed, and `MARGO_GPU_EXCLUSIVE=1`; run
`node scripts/physics2d-kernel-browsers.mjs --browsers=default,firefox --rounds=12` before and after, preserving
the JSON report from each run. Edge WebGPU/WebGL2 and Firefox WebGL2 passed the pinned bits here; Firefox WebGPU
has no adapter and remains unrun. All timings are diagnostic on the loaded SCOTT-DEV machine; a quiet rerun is
required for release numbers. The target 0.35 ms narrow phase and the Box2D speed gap remain open.

## Own 2D certified faces and solver study (perf history entry 101)

The existing kernel doctest and package examples remain runnable. From the root, with cargo on PATH:

~~~sh
npm test --workspace @margoengine/physics2d
npm run test:physics2d-kernel
npm run check:rust-kernels
npm run check:readme-run -- --packages=physics,physics2d
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --lib -- --nocapture
~~~

The last command prints `FACE_INTERVAL_TOTAL` for frames 60–99; the ordinary parallel unit test asserts positive
whole-window work reduction. Interpret the bound as `32*hits - 2*attempts` squared-distance candidates, not saved
sqrt calls. `tests/manifold_exact.rs` compares all fields against the unchanged kept reference, including the
new nextafter thresholds and public mutations. `tests/common.rs` checks IEEE lane equality, including NaN and zeros.

Build `kernel/wasm-check/Cargo.toml` at baseline `7fd5a9547` and current using `--locked --release --target
wasm32-unknown-unknown` with `RUSTFLAGS=-C target-feature=+simd128`; retain each module in your own worktree.
Use the same one-process 24-round A/B procedure described for entry 92, require the original three hashes and
5,050 awake bodies, settle 60 and take the minimum of 40 steps in every round, alternating old/new first.
For three variants rotate all six permutations equally. Lane P's retained driver is `.lane/p/metadata-ab.mjs`.

For browsers set `BOX2D_WASM` to the existing external black box and `REPLAY_FIREFOX` if needed, then:

~~~sh
node scripts/physics2d-kernel-browsers.mjs --browsers=default,firefox --rounds=12
~~~

Set `MARGO_GPU_EXCLUSIVE=1` for that timing run. Preserve `test-results/physics2d-kernel-browsers.json` before and
after. Firefox WebGPU without an adapter remains unrun. All raw rounds and acceptance outcomes are in
[the record](results/physics2d-certified-faces-20261108.json); failed solver sources remain isolated in Lane P,
with paths and formulas in the [study](../architecture/physics2d-solver-study.md). They are not production options.
The 1:1000 contact extension is a new failing baseline diagnostic, not a passed bar. Existing 1:1000 joints and
3D CCD run in the full Rust gate. Loaded timings are diagnostic; no Box2D parity or release speed is claimed.

## Own 2D input validation

The public direct solver boundary is covered by
`cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test solver_input`.
On bf40, the count-three direct-call regression panics at `solver.rs:371`; current callers receive the
coded parameter error. Related tests cover handles, ownership, finite inputs, derived overflow, recovery
and valid direct-call results. `World::step` retains one preflight and its original output/sleep scans.

From the repository root, with cargo on PATH, run the checked raw Rust API regressions, complete retained-reference
collision comparisons, valid native hashes and the existing collision doctest:

```sh
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test input -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test rotation_input --test contact_metric_input -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test point_velocity_input -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test manifold
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test manifold_exact -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test bits -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --doc
npm run test:physics2d-kernel
npm run check:rust-kernels -- --packages=physics2d
npm run check:readme-run -- --packages=physics2d
```

Use the repository's hard process-tree timeout runner for these commands; a hang is a failure. The input suite
covers nonfinite definitions/current state, checked material domains, positive mass/inertia underflow, derived
overflow, invalid handles and transactional body/shape/whole-chain creation.
The directed input cases also reproduce the formerly panicking MAX-density effective reciprocal and finite
`1e20` friction-product overflow, check negative used normal caches and staged origin rollback, and exercise
both scalar and SIMD contact modes. The original closing-speed overflow already returned an error; its case
guards that behavior without claiming a newly reproduced panic.
`rotation_input` covers huge/subnormal finite pairs, large finite angular velocity at one substep, nonfinite
integration arithmetic and zero stored body rotation. `contact_metric_input` uses two fixed-rotation unit boxes
of density `4e-39`: each inverse mass is finite, but their sum overflows. The pre-edge input implementation
accepted that step without collision response. All five strengthened tests fail on the retained first input
implementation (`.lane/p/rotation-baseline`, archived from `f8d812a6330c4cf05fb1153e21246cccc670dd71`);
the final normalization/setup guards must pass them. Logs retain the initial four-substep rotation test's false
negative: zero and identity alternated, so the regression was strengthened to inspect a single substep.
An API-independent four-case behavioral extraction also compiles on verified `47f81f909`: all four fail at
runtime there and the identical extraction passes against current code. It checks finite-pair direction,
single-substep dynamic/kinematic rotation, refusal before a zero-rotation step advances, and pair-metric overflow
before interpenetration. Baseline/green logs and provenance are retained under `.lane/p/verified_main_rotation_metric_*`.
`point_velocity_input` covers the separate derived contact-velocity overflow. Checked circle construction,
finite individual inverse metrics and a real floor contact all succeed; `omega*radius` then overflows, so the
step must return `ArithmeticOverflow`. The pre-guard diagnostic returned success in all four scalar/SIMD/radius
cases (`.lane/p/point-velocity-probe`), despite NaN normal approach. The row builder now refuses it before a NaN
comparison can invent zero response.
`manifold_exact` includes scalar and four-pair nonfinite cutoff/pose refusal, missing-candidate and finite-overflow
cases alongside the unchanged
whole-field reference comparisons. The ordinary full kernel run also exercises the independent geometry cases
and current public-array/handle preflight. The three Wasm `check(i)` calls first run invalid-input checks and then
compare the unchanged production hashes:

```text
9ffefc83c3a99be4
95a47530df180011
9acb68471fbe6ba0
```

For the behavioral before/after proof, `nonfinite_body_creation_does_not_publish_a_body` and
`invalid_density_does_not_publish_a_shape_or_nonfinite_centre` in `kernel/tests/input.rs` deliberately use
assertions that also compile against the former infallible API. Copy these two tests into `tests/input_repro.rs`
of an isolated copy of `47f81f9090eb9cdec62247d2c315a2e33e9472bb`, retaining its own shared kernel-common package.
Lane P retained that copy under `.lane/p/input-baseline` and ran:

```sh
cargo test --locked --manifest-path .lane/p/input-baseline/packages/physics2d/kernel/Cargo.toml --test input_repro -- --nocapture
```

That baseline command is **expected red**: both `nonfinite_body_creation_does_not_publish_a_body` and
`invalid_density_does_not_publish_a_shape_or_nonfinite_centre` fail (0 passed, 2 failed, exit 101), with no timeout;
the retained log is `.lane/p/input-baseline.log`. The current checked API must pass them. Do not change the
baseline assertions to accommodate its unsafe publication behavior.

The actual collision panic reproduction on that commit combines a NaN pose and NaN speculative cutoff; the
literal review call with a finite cutoff returns empty here. Preserve this distinction when reproducing the
zero-hit-mask/absent-candidate bug. The fixed public call returns `PhysicsError::NotFinite`; internal guards also
refuse missing candidates or unrepresentable arithmetic before an index is used. These commands document the
checks, not a claim that final landing gates have already run. No speed comparison or hash re-pin accompanies
this input fix. The separate support correction below deliberately changes the mixed pin; CCD stays with T-11 / 127.y.

## Own 2D sustained support

The required native 1:1000 test in `kernel/tests/world.rs` is an exact extension of the 1:100 fixture: top mass 1000,
matching column loads/inverse mass, and name/output label change. The 3% sag, 1e-4 m top drift, 0.01 m final movement
from the one-second sample and sleep-by-end predicates are unchanged. It fails at runtime on verified 47f81f909 with
1.186208290 m sag versus 0.518550736 m and 92.105 mm creep; current sag is 0.518550681 m, creep 0, asleep at 0.8833334 s.
No named original physical test is removed or weakened.

Run each command with a hard process-tree deadline (the complete Rust gate supplies one):

~~~sh
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --lib -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test world --test chain --test joints -- --nocapture
cargo test --locked --manifest-path packages/physics2d/kernel/Cargo.toml --test support_domains --test support_joint_interaction --test support_numeric -- --nocapture
npm run test:physics2d-kernel
npm run check:rust-kernels
node scripts/physics2d-kernel-browsers.mjs --browsers=default,firefox --rounds=0
~~~

The private per-visit SIMD shadow additionally runs original fixtures and production pins, with no copied
ignored timing test. The ordinary ignored native timing test remains a separate paired benchmark.
Lane P's instrumented collector uses the same 67 assertion-body digests as the post-input control, with 29 cases
per mode and strict missing/duplicate/failure checks. It recognizes the shipped mandatory 1:1000 test instead
of adding a duplicate; CCD is explicitly outside its scope. Pre-input 7fd5a9547 differs only by the necessary
`world.angle(slider).unwrap()` API migration in one numeric assertion; the other 66 bodies are byte-identical.
Current final source must pass all 29; a per-point experiment is not accepted from a partial matrix.

Wasm `check(0)` additionally runs the same 1:100 and 1:1000 sag/x-drift/creep/sleep predicates in
`kernel/wasm-check/src/support_bars.rs`, including the native fixture's 599-step truncation and snapshot
before step 60. Failure returns code 4. `checks()` remains three; pinned scenes and benchmark workloads are
unchanged. Native diagnostics exercise actual scalar and SIMD paths; the shipped Wasm build always uses
SIMD, including when its stored `contact_lanes` setting is false. Native and Wasm stack metrics agree.
On the archived input-fixed main `147c6d33a`, adding only this new checker/helper makes the official Node
Wasm gate fail `check(0)` with code 4 while all three original scene hashes remain unchanged. Its 1:1000 sag
is 1.186208290 m and creep 92.105 mm. This independently isolates the previously missing accuracy bar from
the deliberate mixed-scene re-pin. Lane P retains source provenance and red/green modules in
`.lane/p/support-wasm-final/handoff.json`.

The deliberately accepted scene pins are:

~~~text
pyramid:   9ffefc83c3a99be4
joint grid: 95a47530df180011
mixed:     92db6847c4e919d4   (previous: 9acb68471fbe6ba0)
~~~

This is a result-changing correctness baseline. The commit names the mixed re-pin and its reason, and runs
scalar/SIMD, shipped simd128 Node Wasm and available browser-bit paths. Firefox WebGPU without an adapter is
unrun. No prior speed result is transplanted onto this baseline. Future timings must use paired A/B with the
same scene/work and disclose the cost of support planning/correction; no speed claim accompanies this fix.

For the separate constitutive bending analysis, run `kernel/examples/support_bending.rs` using the
[documented 180-second process-tree wrapper](../architecture/physics2d-support-bending.md). It never steps the
solver. Exit 0 confirms its contact/force domain and prints the directional derivative, not a passing solver
instability condition. The proof states the nonlinear/f32/discrete-trajectory limits. CCD remains T-11 / 127.y.

## Extruded text repair, LIM-587 (2026-11-08)

Run `npm test --workspace @margoengine/text`, then `npm run check:text-extrude`. These cover hostile/malformed
font inputs, every Type 2 curve family and shared subroutine state, quadratic midpoints, raw-point/scaled-offset
composites, nonzero overlaps, complete hole caps, outward volume, closed bevels, small text and the README example.
The Source Sans 3 assets and licence live in `packages/text/tests/fixtures/fonts/`. The all-glyph test checks all
2,478 glyph indices in each TTF/OTF, including nine empty glyphs. To regenerate the independent frozen cubic
controls on Windows, run `python packages/text/tests/generate-outline-reference.py`; its head-table assertion
rejects a substituted system face. Portable Node tests compare ten glyphs per format with independent de Casteljau
sampling and an analytic chord-error bound. No speed comparison is claimed.

For both WebGPU and the native WebGL2 mesh output assertion:

~~~sh
node scripts/gpu-lock.mjs run --owner=codex-extrude --max=10 --wait-max=5 -- node packages/text/scripts/test-browser.js
node scripts/gpu-lock.mjs run --owner=codex-extrude --max=10 --wait-max=5 -- npm run check:readme-run -- --packages=text
~~~

The browser report includes orange pixel count and hidden orange pixel count for WebGL2; calling render alone is
not a pass. CPU work has no benchmark here. Entry-size comparisons bundle the entry in isolation with Vite,
ES2022 minification and `compactOutput` from `scripts/measure-size.js`, then zlib default gzip. Include the shared
error helper on both sides; do not compare a standalone bundle to a split dist file.

## Own 2D retained planner buffers (perf history entry 106)

The [raw record](results/physics2d-planner-reuse-20261108.json) separates the cost of the preceding correctness
fix, the rejected nested-capacity trial, the accepted flat-buffer work reduction, and the rejected point-normal
replacement. Its browser rows are loaded-machine diagnostics. No benchmark source, scene, visit count, tolerance or
current pin is changed to obtain a speed result.

The committed native allocation probe includes the unchanged production `tests/support/bits_scenes.rs` scene.
Run it through the existing process-tree wrapper, with cargo on PATH:

~~~sh
node --input-type=module -e "import {runLimited} from './scripts/support/run-limited.mjs'; const r=await runLimited('cargo run --locked --release --manifest-path packages/physics2d/kernel/Cargo.toml --example planner_allocations',{cwd:process.cwd(),limitMs:180000,label:'2D planner allocations'}); if(!r.ok)throw new Error(JSON.stringify(r));"
~~~

For the allocation control, archive own commit `0b12da14aea0bc8a4c66f6ede58e8d3443f52259` into a new uniquely
named folder under this worktree's `.lane/`, preserving `packages/physics2d` and `packages/physics/kernel-common`.
Copy only the current `planner_allocations.rs` example into its kernel examples directory, then run the identical
bounded command with that archived manifest path. Both kernels retain their own opt-level 3, fat-LTO,
codegen-units 1 release profile. Lane P's retained controls are under `.lane/p/speed-plan-reuse/control`.

Only each single-threaded `World::step` is inside the enabled allocator interval. Frames 60 through 99 must each
print `WORK_FRAME <frame> 14950 119600 8 0 5050`, and both final rounded pose/velocity fingerprints must be
`a9134ec059727110`. Allocation/reallocation calls are 397,600 versus 200 across those 40 steps; requested bytes
are 77,114,920 versus 44,673,280. A reallocation counts its entire new requested size and old freed layout, not
copied bytes or peak/net resident memory. The allocation count is diagnostic, not a physical accuracy threshold.

The native unit suite also checks current topology rebuilds, fresh-versus-retained full-world results, multiple
component shrink/regrow, and fixed-V/E migrating hub/path storage. Run `npm run test:physics2d-kernel` and the
full `npm run check:rust-kernels`; the shipped Wasm still checks the mandatory contact-stack predicates and all
three current pins. No further pin changes accompany storage reuse.

For paired timing, build both own source snapshots with shipped `-C target-feature=+simd128`. Instantiate both
modules in one process, check each full explicit three-pin array, then alternate which runs first across 24
rounds. Recreate the unchanged 100-row world for every sample, settle 60 steps and take the minimum of 40 steps;
every settling/timed visit returns 5,050 awake bodies. Retain every round, order, difference, ratio, median, IQR
and spread. The exact local driver and immutable modules are under `.lane/p/speed-plan-reuse-flat-ab-v1`.
Do not overwrite the original evidence when reproducing it.

Use `BOX2D_WASM` with the existing external black-box build and `REPLAY_FIREFOX` as documented above, then run
`node scripts/physics2d-kernel-browsers.mjs --browsers=default,firefox --rounds=12` under the exclusive GPU lease
and a hard 600-second process-tree limit. Preserve original scene and engine order. The before/after browser
sessions have different load and do not establish a controlled speed gain. Firefox WebGPU without an adapter
is unrun; owned-2D CCD remains separate T-11 / 127.y. Quiet release reruns are still required.

## Own 2D finite certificates (perf history entry 107)

The [IEEE proof](../architecture/physics2d-finite-certificates.md) identifies the two removed predicates and
the precise private caller contract. All arithmetic, settings, scene/work counts, physical predicates and
three pins remain unchanged. The [raw record](results/physics2d-finite-certificates-20261108.json) includes
the complete compiler inventories, source/compiler identities, decoded static relocations and every round.

Run the native and shipped Wasm checks with their existing hard limits:

~~~sh
npm run test:physics2d-kernel
npm run check:rust-kernels
~~~

The new private controls in `solver/wide_certificate_tests.rs` compare old and reduced certificate masks
after evaluating the actual caller expressions. They include partial live masks, four block answer forms,
both biased states, signed zeros, subnormals, extreme values, infinity and NaN bit patterns. The separate
retained-guard case covers finite-operand sum overflow, an infinite raw diagonal, used invalid soft state
and unused invalid soft state. Current physical tests and pins are not rewritten for this comparison.

For compiler reproduction, archive main `119d55a9a` and the entry-107 implementation into separate new own
worktree subdirectories, preserving the physics2d kernel/checker and shared kernel-common paths. Use the
same rustc 1.99.0 / LLVM 23.1.1 and Cargo release profiles on both. Build shipped simd128 checker modules
with `-C target-feature=+simd128`; use separate target directories and hard 180-second process-tree limits.
Native assembly/IR is emitted by `cargo rustc --locked --release --lib --manifest-path <kernel>/Cargo.toml -- --emit=asm,llvm-ir`
under the same bounded wrapper described for the allocation probe. Decode Wasm with Binaryen 132
`readBinary`/`emitText` only: do not optimize or rewrite the module before counting. The recorded function
index $111 and exact SHA-256 identities identify this compiler output, not a stable public function number.
Static opcode totals across branches are not dynamic instructions or CPU micro-ops.

Compare embedded filename/panic records and static address changes as well as code when source paths differ.
The named frozen flat control and rebuilt control have text-identical hot function $111; two other changed
constants reference the same decoded panic Location and string. The shorter live source paths relocate data
and BSS throughout code. These observations establish the named provenance without asserting raw binary
identity or performance independence from layout.

For timing, use the entry-106 unchanged-scene protocol: explicit full three-pin arrays, 24 alternating one-process
rounds, 60 settling steps and minimum of 40 steps, checking 5,050 awake bodies on every visit. The retained
driver/modules are `.lane/p/speed-cert-trim-ab-v1`; browser/rival 12-round outputs and statistics are
`.lane/p/speed-cert-trim-browser-v1`. Use new output paths rather than overwriting those records. The paired
ratio median 1.0001 and 12/24 faster establish no timing gain. CCD remains T-11 / 127.y; quiet release reruns
remain necessary, while current work continues without waiting for a quiet machine.


### Batch 168 OIT (perf history 109)

`node scripts/gpu-lock.mjs run --exclusive --max=6 --wait-max=2 --owner=codex-168 -- node packages/oit/scripts/rival-bench.mjs`
after building packages. External `engine-bench/batch-168/node_modules/@babylonjs/core` is version 8.33.0.
If absent, install with `npm install --prefix C:\Development\Projects\engine-bench\batch-168 @babylonjs/core@8.33.0`.
`MARGO_ENGINE_BENCH` overrides the engine-bench parent. The rival stays external. Oracle:
`node --test packages/oit/test/oit-reference.test.js`. Seven alternating rounds, per-round minimum;
busy-machine frame-plus-completion timings, not GPU-only timings. [Raw result](results/batch-168-oit.json).


### Batch 168 sky (perf history 110)

Create an external Python 3.12 venv:
`py -3.12 -m venv C:\Development\Projects\engine-bench\batch-168\mitsuba-venv`, then
`C:\Development\Projects\engine-bench\batch-168\mitsuba-venv\Scripts\python.exe -m pip install mitsuba==3.9.1`.
After building packages run
`node scripts/gpu-lock.mjs run --max=3 --wait-max=1 --owner=codex-168 -- node packages/sky/scripts/rival-bench.mjs`.
`MARGO_ENGINE_BENCH` overrides engine-bench; `MARGO_MITSUBA_PYTHON` overrides the interpreter.
Inputs and outputs stay in external batch-168/data/sunsky. scalar_rgb needs no LLVM vectorization;
this install reports an LLVM initialization warning but evaluates the scalar model successfully.
No timing is measured. [Per-case result](results/batch-168-sky.json).


### Batch 168 staging (perf history 111)

After building packages run
`node scripts/gpu-lock.mjs run --max=3 --wait-max=1 --owner=codex-168 -- node packages/staging/scripts/rival-bench.mjs`.
No external renderer installation is needed: a clean-room cosine ray tracer has an independent analytic
projected-solid-angle oracle (`node --test packages/staging/test/contact-reference.test.js`).
The actual canvas goes to ignored `test-results/staging-ray-reference.png`; all defaults are retained.
15,472 exposed-ground pixels, 4096 rays per pixel; no timing comparison. [Result](results/batch-168-staging.json).


### Batch 168 independent OIT path tracer

`node scripts/gpu-lock.mjs run --exclusive --max=6 --wait-max=1 --owner=codex-168 -- node scripts/rival-oit-cycles.mjs`
uses Blender 5.3.0 Beta at `C:\blender\blender.exe` (`MARGO_BLENDER` overrides), CPU, four threads,
1024 samples and seed 168. External Babylon setup is the same as entry 109. Inputs/EXR/float RGB and
both engine images stay under external engine-bench/batch-168/data/oit-cycles; `MARGO_ENGINE_BENCH`
overrides the parent folder. Hard Blender limit 240 s. The page is used for pictures; its extra timing
values are not collected or published here. [Retained result](results/batch-168-oit-cycles.json).

## Own 2D frame preparation (perf history entry 112)

The [proof](../architecture/physics2d-frame-preparation.md) states the same-stack bounds and monotone
eligibility contracts. The [raw record](results/physics2d-frame-preparation-20261108.json) retains the
compiler inventories/CFG excerpts, constituent and combined source identities, full acceptance and
all paired/browser rounds. Archive own baseline fc88da420 and the implementation into new own worktree
subdirectories, preserving physics2d kernel/README and shared kernel-common paths. Do not overwrite the
original evidence. Build matched shipped Wasm with unchanged Cargo release profiles, rustc 1.99.0 /
LLVM 23.1.1 and -C target-feature=+simd128 in separate target directories, hard 180-second process-tree
limits. Native LLVM/assembly uses cargo rustc --locked --release --lib -- --emit=asm,llvm-ir with the
same bounded wrapper. Static callee inventories and release control flow are distinct from test counters.

Run the existing native/package/full Rust gates with their hard deadlines. The private world_bounds_tests
compares checked/helper/original bounds and preserves malformed public/mutable input plus derived overflow.
The private planner_laziness_tests compares a verbatim eager reference, full traversal/workspace/Plan bits,
disconnected and retained transitions, and the unchanged 100-row frames 60 through 99. The actual
382,554-to-zero calls retain 1,192,000 edge traversals; no dynamic instruction ratio is inferred.

The complete-step [portable profile bundle](results/physics2d-step-profile-20261108/README.md) needs no
existing ignored lane files or Git metadata. Its README gives stage-only, matched-build and bounded
exclusive-profile commands against a source archive of fc88da420. All 51 original inputs are checked
modulo EOL; exact instrumentation and own harness/diagnostic sources, original failure and raw real-step
vectors are included. It uses 17 non-overlapping phases, 39 verified clock calls, raw outer/inner
residuals and approximate calibration. Phase shares include adjacent setup and cannot be converted
into a sum of marginal minima; 99.29%-busy absolute profile times do not replace rival benchmark rows.

For performance use the entry-106 unchanged-scene protocol: one process, 24 alternating rounds, explicit
three-pin arrays, 60 settling steps and minima of 40 steps, checking 5,050 awake after every visit. The
frozen driver/modules are .lane/p/frame-preparation-v2-ab-v1; use a new output path when reproducing.
Browser/rival rows use the original scene and black-box engines under an exclusive lease, 12 rounds,
hard 600-second process-tree deadline, with current full hash and awake assertions outside each timer.
The copied harness/provenance is .lane/p/frame-preparation-v2-browser-v1. Separate browser sessions
have changing load; the paired advantage belongs to the combination. Quiet release reruns remain
required. Box2D parity is open and owned-2D CCD stays T-11 / 127.y.

### Pixel batch 102 review fixes

Retained native/compatibility hardware and readback evidence: [pixel-review102.json](results/pixel-review102.json).

After `npm run build:packages`, run `npm test --workspace @margoengine/pixel` for pipeline identity, scene/resource ownership, scissor intersections, huge cycle shifts, overflow errors and the architecture evidence check. Run `node scripts/gpu-lock.mjs run --owner=codex-pixel --max=12 --wait-max=2 -- npm run test:gpu --workspace @margoengine/pixel` for all five pixel GPU harnesses, including shared format/disposal/scissor regressions and the 154-size exact CRT/nearest sweep. Repeat with environment `MARGO_COMPAT=1` for the WebGL2 layer. Each CRT all-off sample is checked byte for byte against rational nearest and PixelScale, including exact boundaries; no sample is skipped. GPU result files are `test-results/pixel-browser.json`, `palette-browser.json`, `render3d-browser.json`, `pixel-scale-browser.json` and `pixel-crt-browser.json`; native and compatibility runs overwrite those local files, so retain copies between runs. No speed measurement is claimed.


## Batch 160 metallic-roughness

Build packages first. Set MARGO_ENGINE_BENCH to the outside engine-bench folder if it is not
C:/Development/Projects/engine-bench. No third-party renderer source is read or imported into Margo.

~~~sh
node scripts/reference-rendering/fetch-assets.mjs
node scripts/gpu-lock.mjs run --owner=codex-160 --max=5 --wait-max=5 -- node scripts/reference-rendering/run.mjs --capture-reference
node scripts/gpu-lock.mjs run --owner=codex-160 --max=5 --wait-max=5 -- node scripts/reference-rendering/run.mjs
node scripts/gpu-lock.mjs run --owner=codex-160 --max=5 --wait-max=5 -- node scripts/reference-rendering/run.mjs --compat
node --test --test-timeout=30000 tests/reference-rendering.test.js
~~~

The first GPU command operates the hosted Sample Viewer through its public controls, selects the embedded camera,
turns IBL and environment background off, keeps punctual lighting on and exposure 1, selects Khronos PBR Neutral,
sets black background, and downloads its PNG. This avoids including the UI toggle button in a canvas screenshot.
Reference images, original asset/legal notice, matched GLB and viewer metadata stay under
engine-bench/batch-160. The model is pinned at glTF-Sample-Assets commit
8f492390ddc7a2ae221a1369ef560589cf8c70fb; source, scene and PNG hashes are in the raw result.
The viewer's deployed JS resource identifier is recorded as provenance, never read as source. A changed viewer
picture fails the reference hash check; do not replace its baseline to pass. Recover the frozen PNG from the
recorded outside folder for the exact historical comparison. Remote deployment changes are not a Margo regression.

The scene preserves all materials/geometry and original roots, adding a 1000x root scale, a 35-degree camera
at [12,9,18] looking at [3,3,-1.5], and a white directional irradiance 3 from normalized [0.4,0.7,0.6].
Both renderers use 512 x 512, DPR 1 and 4x MSAA. Error counts every RGB channel of every pixel including
background, text and silhouettes, after the same display transform. No crop, registration, fitted exposure,
per-material exclusion or path-tracer claim is made. Foreground is the union of all nonblack pixels.
The compatibility run installs Margo's WebGL2 compatibility device; native WebGL2 is independently asserted
to reject PBR with code unsupported. This job does not rerun batch 168 OIT, sky, staging or lightmap.
--measure is for collecting a new scene before establishing its budget, not accepting a failed existing test.

### Batch 160 clearcoat

Use the job 1 commands with `--case=clearcoat`, including the asset downloader and both backend
runs. New camera/scale settings are in scripts/reference-rendering/cases.mjs. The complete original
scene, geometry, material factors and textures are preserved. All 27 primitives load; 19 draws are submitted. The camera is [-1.5, 0.3, 25] looking at
[-1.5, 0.3, 0], 35 degrees; scale 1, sun [0.4, 0.7, 0.6], intensity 3, IBL off, background black.
Frozen reference 49a82f5e1990209481b28f3bf64afc390e407e2eb9ab3571cb904a28ab4bdd09.
The recorded outside legal README credits Ed Mackey / Analytical Graphics, Inc. under CC-BY-4.0.
`--measure` now refuses an established result file, preventing accidental budget replacement.
See [the skip audit](../work-lists/batch-160-skips.md) for all 14 former missing-data skips and setup.

### Batch 160 sheen

Use the metallic-roughness commands with `--case=sheen`, including fetch, capture and both
backend comparisons. This is Khronos SheenTestGrid (the sample asset name, rather than the
plan's shorthand SheenTest), pinned at 8f492390ddc7a2ae221a1369ef560589cf8c70fb.
The legal README credits Eric Chadwick, 2023, CC0-1.0. Every source primitive and material
is preserved. Camera [-0.18, 0, 1.8] targets [-0.18, 0, 0], 35 degrees, near .01, far 100,
scale 1; the same sun as job 1. Frozen reference PNG SHA-256: 240715ff0a53416190448056a5aa7eeb767a0d7b2f52aa0a0a77e4ca17dc529a.
The default gltf-pro physical path is measured; shared/sheen.js is also used by materials.
No standalone material or IBL equivalence follows from this direct-light picture.

## Batch 99 emissive resampling accuracy

After `npm run build:packages`, run `node scripts/gpu-lock.mjs run --owner=restir-proof --max=10 --wait-max=10 -- npm run test:gpu:restir --workspace packages/voxel-pathtracer`.
The generated scene contains 1,024 contiguous emissive ceiling voxels, a white floor and a fixed orthographic camera.
The unchanged 16 x 16 image, seed 17, 32 samples and 8 candidates must have less than half the original tracer's
squared RGB error against its 8,192-sample seed-987 reference. The score sums all 768 channel errors; it is not MSE.
The driver also checks baseline identity at one candidate, finite values at 64, coloured and occluded emission,
absorbing half-block media, camera and delta emission, empty scenes, native WebGL2 refusal, compatibility rendering,
disposal and real device restoration. Output: `test-results/voxel-pathtracer-restir.json`.
The accuracy result is from generated geometry on one RTX A6000 and Edge 157. No quiet-machine speed result is claimed.

### Batch 77 painterly pixels

Build packages, then run `npm test --workspace @margoengine/creative` and
`node scripts/gpu-lock.mjs run --owner=codex-77 -- npm run test:gpu:paint --workspace @margoengine/creative`.
The GPU script reads every tested pixel against the independent CPU reference (double-precision squared
deviations), asserts exact alpha/bypass and one-code RGB error, tests BGRA/MSAA, separate views, real device
replacement and real Engine/PostStack integration. Generated stand-ins only; no timing or aesthetic judgement.

### Consolidated WebGL2 entries

After `npm run build:packages`, run
`node scripts/gpu-lock.mjs run --owner=webgl-merge --max=20 --wait-max=20 -- node packages/webgl2-compat/test/preview-browser-check.mjs`.
The result is `test-results/webgl2-preview-browser.json`: picks, context recovery,
native WebGPU isolation and preview-to-full-device escalation.
### Browser shutdown control-flow regressions

Run `node --experimental-test-module-mocks --test --test-timeout=120000 tests/browser-teardown.test.js tests/browser-selection.test.js tests/gltf-pro-materials-lifecycle.test.js tests/shutdown.test.js`. The Windows ownership fixtures are injected on every platform; a separate control retains the POSIX driver route. `node --test --test-timeout=180000 tests/catalog.test.js` checks the actual catalog lifecycle after the package build. Material GPU validation uses the usual GPU lock and `node scripts/gltf-pro-materials-gpu-check.js`. Production shutdown stays at 30,000 ms; the larger command limits cover the complete tests, not a longer teardown.

### Audio review regressions (2026-11-09)

Run npm test --workspace @margoengine/audio for suspended/resumed live-context stand-ins, quantized audio clocks with monotonic frame time, source-kind detachment, pooled/event authored pitch, disposed occlusion, missing engines and evidence wording. Run node scripts/gpu-lock.mjs run --owner=audio-review --max=12 --wait-max=2 -- npm run test:browser --workspace @margoengine/audio for native WebGPU and both WebGL2 routes. The browser harness also uses a real AudioContext with controlled 60 Hz frame and 10.667 ms audio clocks, and OfflineAudioContext fractional-loop markers at 130 bpm: one hour at 8 kHz, 300 s each at 44.1/48 kHz. Every loop is checked against its original fractional-sample grid; the allowed crossing interpolation error is 1.5 frames, not a per-loop allowance. Result: results/audio-review-20261109.json. No speed measurement or device-output proof.

## Batch 99 caustic guiding accuracy

After `npm run build:packages`, run `node scripts/gpu-lock.mjs run --owner=guiding-proof --max=10 --wait-max=10 -- npm run test:gpu:guiding --workspace packages/voxel-pathtracer`.
The fixed generated scene has a one-voxel smooth glass block above a white ground plane and a one-voxel emissive lamp
above the glass. The orthographic camera is below the block. At 16 x 16, seed 17 and 64 samples, the default guide
must have less than half the original tracer's squared RGB error against its 16,384-sample seed-987 guided reference.
The score sums 768 channel errors; it is not MSE. Separate 4,096-sample original-tracer images check converged energy,
coloured absorption and overlapping bounds. A unit environment furnace supplies an independent analytic value.
The driver also checks zero-strength and empty-table identity, finite inside/huge bounds, empty black scenes,
native WebGL2 refusal, WebGL2 compatibility values, disposal and real device restoration.
Output: `test-results/voxel-pathtracer-guiding.json`. Generated stand-ins, one GPU/browser; no timing claim.
The initial cone proposal scored 304.785742 against 345.995718, the tighter cone 224.264648 against 350.006292,
and the box proposal with unmodified roulette 241.098699 against 350.533552. All failed the unchanged 2x bar.
The default throughput heuristic was terminating successful guided paths at the glass exit; correcting its
survival heuristic removes that cause without changing the scene, sample count or threshold.

## Scatter tile capacity boundaries (batch 77 review)

After `npm run build:packages`, run `node --test --test-timeout=60000 packages/scatter/test/tiles-budget.test.js`
and `node scripts/gpu-lock.mjs run --owner=codex-77fix --max=5 -- node packages/scatter/test/grass-tiles.browser.mjs`.
The latter already runs in check:merge through scatter's `test:browser:grass-tiles` script. Each boundary fixture
starts with fresh one-instance rings and 64 generated packed records; compare counts and capacities with
[the recorded before/after result](results/scatter-tile-budget-20261109.json). The parent loses records in all five
allocation regressions; controls, hard transitions, fades, outside rejection and the explicit cap remain checked.
This is correctness evidence on one GPU, not a performance benchmark.

### Batch 69 WFC heap and chunks

Run npm test --workspace @margoengine/wfc for exhaustive local relations, linear validation work, 192x192 heap updates, 256x256 chunk coverage and all-axis seams. Run node packages/wfc/test/heap-bench.mjs --record with a hard timeout to reproduce paired/interleaved CPU measurements and output hashes; --record replaces only this machine-specific batch file. Current results are loaded-machine diagnostics, with no release speed promise. Rebuild the feature artifact with node packages/wfc/scripts/build-wasm.mjs (Rust wasm32-unknown-unknown, SIMD enabled by the script), then run both library builds and the WFC browser test for module-relative asset loading.

### Batch 69 WFC worker solving

Build packages, then npm test --workspace @margoengine/wfc. Actual shipped classic scripts run on worker threads for TS/SIMD parity, pins, weighted/wide fallback and solver errors, beside transport lifecycle tests. Run node scripts/gpu-lock.mjs run --owner=codex-69 --max=8 -- node packages/wfc/test/browser-check.mjs --record for the device record. It solves 512x512 with both implementations beside real WebGPU and WebGL2 render loops, requires positive in-flight work plus rendered frames, compares synchronous seeded output and aborts a second active solve. npm run check:readme-run -- --packages=wfc executes the browser example. Generated rules are stand-ins; frame counts demonstrate scheduling, not a speed or frame-time claim.

### Batch 76 custom transitions

Build packages, run npm test --workspace @margoengine/transitions, then node scripts/gpu-lock.mjs run --owner=codex-76 --max=10 --wait-max=30 -- npm run test:gpu --workspace @margoengine/transitions. The browser harness uses generated solid-color stand-ins and reads every tested output pixel. Expected values come from exact endpoints and the supplied p*p weight, within one UNORM code. Both 1x and 4x captures include resize and replacement-device redraw; actual WebGL2 must give coded linked unsupported. Invalid WGSL is deliberately labelled for the compile guard; incompatible bindings reject before attachment. npm run check:readme-run -- --packages=transitions runs both examples. No timing comparison was made.

## Missing format proofs

After npm run build:packages, run in PowerShell:

```powershell
$env:REAL_FILES_ONLY='pts-pdal,xyz-openbabel,mpd-robotic-arm,amf-zipped-slic3r,amf-rook'
npm run test:real-files -w @margoengine/loaders
```

The script fetches pinned standard assets with SHA-256 checks; REAL_FILES_DIR chooses an external cache if desired.
The MPD needs the 146,853,687-byte library archive plus four CC-BY-4.0 sticker parts. All sources/licences are in
packages/loaders/tests/real-files/manifest.json. The result record is missing-format-proofs-20261109.json.
These rows need no outside implementation runtime or GPU. Coordinate checks retain 1e-6 for AMF; XYZ compares float32
values exactly. Re-run packages/loaders/tests/amf-reference.test.js for translated/nested-build oracle regressions.

For the Windows README tool proof, run node scripts/fetch-readme-assets.mjs --ffmpeg after the build. Set
MARGO_README_FFMPEG to the emitted cache/ffmpeg/bin/ffmpeg.exe, then run npm run check:readme-run -- --packages=headless.
Only that example child receives the tool directory in PATH. The optional build is FFmpeg 8.1.2 GPL-3.0 from Gyan,
publisher archive SHA-256 db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec. No tool binary ships.

## Batch 99 multiple-scattering tracer sky

Build packages, then run `node scripts/gpu-lock.mjs run --owner=codex-99 -- node packages/voxel-pathtracer/tests/sky-browser.mjs`
with a 10-minute hard limit. It runs native WebGPU and WebGL2 compatibility and writes
`test-results/voxel-pathtracer-sky.json`; the committed record is `results/batch-99-sky-20261109.json`.
Generated 32x16 maps compare higher orders on/off, Earth/no ozone, low sun and vacuum with Lambert ground;
128x64 maps check stable integrated procedural stars. Independent constants are zero in vacuum and
sun illuminance times albedo divided by pi on the planet. Empty-scene tracing reproduces RGB [0.1, 0.2, 0.3] within
1e-5, and sky plus sun illuminate a diffuse receiver. Lifecycle runs the normal traced scene with a baked map,
destroys/restores the real native device and requires an identical converged image and raster restoration on
disposal. Unit tests in `packages/voxel-pathtracer/tests/sky-environment.test.js` inject pipeline/readback failures
and cancellation while each waits. No wall-time performance result or outside-renderer radiometric parity is claimed.

### WFC batch 69 review regressions

Run npm test --workspace @margoengine/wfc after building. The overlapping extraction subprocess has a 128 MiB heap,
a 30-second hard timeout and a finite 512x512 sample; it must throw RangeError instead of exhausting the process.
inputs.test.js, loading.test.js, sockets.test.js and worker.test.js exercise the other review findings and their
related input/error classes. All run in verify/check:merge. Run node scripts/gpu-lock.mjs run --owner=codex-69fix
--max=8 --wait-max=8 -- npm run test:gpu --workspace @margoengine/wfc for both real browser backends, and the same
lock wrapper around npm run check:readme-run -- --packages=wfc. No measured-speed rerun is needed: output algorithms,
work counts, benchmark scenes and the Rust artifact are unchanged.

### Scatter LOD representation cross-check

Run npm test --workspace @margoengine/scatter; tiles-budget.test.js covers float64-to-f32 collapse and the existing
inclusive capacity fixtures. After the package build, run the scatter browser scripts through
node scripts/gpu-lock.mjs run --owner=codex-69fix --max=15 --wait-max=8 --
node scripts/gpu-package-tests.mjs --no-build --only=scatter --serial.
The ordered compaction, per-ring caps and conservative tile-distance arithmetic are unchanged.

### Batch 76 mask wipes

Run the same transitions unit, GPU-lock and README commands as job 1. The GPU suite also creates a 2x2 four-grey ImageData and ImageBitmap, checks 1344 pixels across hard/soft thresholds at 1x/4x, resizes through odd 5x7 and 7x3 captures and replaces a real device. A double-precision threshold oracle is independent of the integer WGSL addressing. Endpoints are byte-exact; blended channels allow one UNORM code. The fixtures are stand-ins. Native WebGL2 must refuse with linked unsupported. No performance comparison was made.

### BSP dungeon layouts (batch 68 job 3)

Run `npm run test:dungeon-kernel --workspace @margoengine/procedural` for native Rust tests,
`npm run build:dungeon --workspace @margoengine/procedural` to reproduce the checked-in Wasm,
then `npm test --workspace @margoengine/procedural`. The dungeon tests independently flood-fill generated
grids, verify rooms and tree links, cover 256 seeded thin/small layouts plus the maximum grid, and compare
direct raster writes against a full-grid membership oracle with exactly matching cells. The emitted
`dungeonWork` counts are diagnostic work counts, not wall-time speed results.
Run `node scripts/gpu-lock.mjs run --owner=codex-68 --max=10 --wait-max=10 -- npm run test:gpu --workspace @margoengine/procedural`
for a production consumer under /sampling/: both independent lazy Wasm assets, no asset fetch on import,
native WebGPU and WebGL2 values, real loss events and disposal. Generated maps only (STAND-IN, LIM-628).

### Material KTX2 and E57 README inputs

Run node scripts/fetch-readme-assets.mjs, then npm run check:readme-run -- --packages=materials,points
after npm run build:packages. The two KTX2 aliases use the existing 2D and cube KTX-Software
fixtures; /scans/plant-room.e57 serves the complete outside CC0 two-station room, not a
plant survey. Source/hash/size live in scripts/fetch-readme-assets.mjs; bytes stay in the
shared README cache. The recorded result is 45/47, two retained other-cause failures.

### Batch 56 job 1: projected HDR floor and contact composition

After building packages, run
`node scripts/gpu-lock.mjs run --owner=codex-56 --max=5 --wait-max=4 -- node packages/staging/test/ground-browser.mjs`
and the same command with `--compat` appended. Both read the existing licensed BrightRings EXR,
compare shadow-on/off pixels, assert unchanged product/outside pixels, destroy and replace an actual
device, remove the caster and dispose the scene. The product geometry is a stand-in. The README's
order 0.25 is essential: a backdrop at its default order 1 covers a depth-read-only contact plane at 0.5.
No new projection or shadow algorithm, physical HDR-shadow claim or timing measurement is added.

### Batch 76 two live scenes

Run transitions unit tests and the package GPU suite through gpu-lock as for jobs 1 and 2. live-browser.js uses two real Engine scenes, whose update plugins change generated backgrounds. It changes both colors at fixed progress and reads every output pixel, 374 total across 1x/4x, with exact endpoints and at most one UNORM code for blends. It resizes 8x4 to 7x3 and 5x7, destroys a real device, awaits engine recovery and proves progress continues. It also renders to canvas, disposes twice and renders a borrowed scene afterward. Native WebGL2 must give linked unsupported. Results are in results/batch-76-live.json, stand-in correctness, not performance.

### Real AVC B-frame edited timestamps

Run node scripts/reference-rendering/fetch-skip-assets.mjs, build the packages, then run
npm test --workspace @margoengine/video for the complete independent packet/timestamp
oracle and rounding regressions. Run node scripts/gpu-lock.mjs run --owner=codex-missing
--max=10 -- npm run test:gpu --workspace @margoengine/video for all five browser checks,
including every real frame. The CC0 MDN flower clip stays in the shared outside cache.
Its URL/SHA-256/size are in scripts/support/external-test-assets.json. The committed
packages/video/test/flower-ffprobe.json comes only from FFprobe 8.1.2 JSON output:
node packages/video/scripts/flower-reference.mjs <path-to-ffprobe-8.1.2> regenerates it.
This FFprobe binary was extracted from the already publisher-hash-checked outside GPL
FFmpeg 8.1.2 archive. Neither movie nor tools ship. The reference feeds independent
packet offsets/config/PTS to the same browser WebCodecs decoder; hashes are exact,
not a perceptual tolerance or an independent decoder comparison.

### Batch 160 anisotropy and iridescence, job 6

Run fetch-assets.mjs and the existing viewer capture/run commands with --case=anisotropy and --case=iridescence, including --compat. Pinned original sources are SHA-256 checked; iridescence has no source GLB, so pack.mjs embeds its original buffer and guides.png in an aligned GLB. It preserves all authored nodes, materials, accessors, indices and bytes; no remeshing or baked material changes. Tests exercise multiple buffers/images and nonmutation. cases.mjs documents cameras, source/packed hashes and CC0 authors. All pixels at 512 x 512, same white sun as job 1, no IBL/exposure fitting. Frozen references cannot be replaced with --measure. Batch 168 sky/OIT/staging/lightmap results are reused, not repeated.

## Batch 99 heterogeneous RGB media

Build packages, then run `node scripts/gpu-lock.mjs run --owner=media-proof -- node packages/voxel-pathtracer/tests/media-browser.mjs`.
Run `node --test --test-timeout=180000 packages/voxel-pathtracer/tests/media.test.js` for hostile coefficients,
atomic replacement, input ownership, optionality and fake-device restoration. The browser driver first
checks root physical path length, then RGB absorption/emission/shadows, clear and extreme channels and
conservative scattering on native WebGPU and compatibility. It finally destroys and restores a real
native device and checks the converged frame and disabled/disposed raster exactly. Generated fixtures
are stand-ins for analytic optical media, not outside production assets or rival renders.

### Batch 160 environment IBL, job 7

Fetch the pinned job 1 asset with node scripts/reference-rendering/fetch-assets.mjs. References and binaries stay under engine-bench. In an outside Python venv install mitsuba==3.9.1 and numpy==2.5.4; set MARGO_MITSUBA_PYTHON to its python executable (default is engine-bench/batch-168/mitsuba-venv/Scripts/python.exe). Run node scripts/gpu-lock.mjs run --owner=codex-160 --max=25 -- node scripts/reference-rendering/environment.mjs --capture-reference, then the same harness without --capture-reference and with --compat. The public Python adapter renders fixed-seed scalar_rgb direct/full images into a candidate directory; both raw and display hashes must match before any frozen artifact changes. Unchanged copies are retained outside, never committed. --measure refuses any existing budget. Root tests: node --test --test-timeout=120000 tests/reference-environment.test.js. All pixels, no crop, denoise, fitted exposure or new tone curve. Constant furnace only; use the existing batch 168 harness for sky/OIT/staging/lightmap evidence.

### Batch 160 Cornell lights, job 8

Use the outside Mitsuba venv documented for job 7. Run node scripts/gpu-lock.mjs run --owner=codex-160 --max=25 -- node scripts/reference-rendering/cornell.mjs --capture-reference and add --point for the independent point-light scene. Then run both cases without --capture-reference, each with and without --compat. Native WebGL2 is explicitly refused before the measured compatibility path. Raw RGB/EXR/PNG artifacts remain in engine-bench/batch-160/clustered and clustered-point; raw/display hashes protect recapture. --measure cannot replace any established budget. Tests: node --test --test-timeout=120000 tests/reference-cornell.test.js. cornell-scene.mjs reuses packages/lightmap/scripts/cornell-box.mjs directly; all 15 quads, reflectance, winding and Float32 snap match batch 168. Only direct-light pictures are new; the existing lightmap-bake result is reused. Both unshadowed controls and default LocalShadows are compared with the same hard-visibility reference, with no fitted exposure or crop. Point finite-range attenuation is an explicit model difference, not fitted into the reference.

### Space colonisation trees (batch 68 job 4)

Run `npm run test:trees-kernel --workspace @margoengine/procedural`,
`npm run build:trees --workspace @margoengine/procedural`, then
`npm test --workspace @margoengine/procedural`. The trees tests check generated and custom clouds,
graph and length invariants, extreme bounds, owned output, abort/dispose and an exhaustive assignment
oracle. Work counts compare distance tests, not elapsed time or language speed. Run
`node scripts/gpu-lock.mjs run --owner=codex-68 --max=10 --wait-max=10 -- npm run test:gpu --workspace @margoengine/procedural`
for the production consumer under /sampling/, independent lazy assets, exact backend values and real
device/context loss. All inputs are generated stand-ins (LIM-631).

`node --test packages/procedural/test/loading.test.js` checks the shared loading failure and abort
contract, including missing TEMP paths, malformed modules, simulated transport/CSP failures and exact
caller cancellation reasons. Four cases fail without the owning loader correction.

### Batch 56 job 2: accumulated shadows

Build packages, then run `node --test --test-timeout=240000 packages/staging/test/*.test.js`.
Run `node scripts/gpu-lock.mjs run --owner=codex-56 --max=10 --wait-max=40 -- node packages/staging/test/accumulate-browser.mjs`
and append `--compat` for the WebGL2 compatibility layer. Both runs compare all texels against an
independent ray-plane rectangle oracle on the Direct3D raster grid, test sharp contact and increasing
penumbrae, exact maximum integer sums, stable completed history, empty scenes, resize/removal,
actual device loss/replacement, linked native fallback refusal, scene-owned disposal, PBR casters and
coexistence with the contact receiver.
The first draft oracle omitted the mandated eight-bit vertex snapping and failed boundary sums;
the corrected oracle retains exact equality at every texel and has independent snapping/tie regressions.
The fallback fixture initially omitted its preview renderer, then imported it from the wrong entry;
both setup errors were corrected before the successful complete runs. No failed step was ignored.
No benchmark or physical-lighting comparison was performed.

### Batch 56 job 3: studio rig reuse

Build packages. Run `node --test --test-timeout=120000 packages/environment/tests/studio.test.js`.
Under the GPU lock with owner codex-56, max 20 minutes and wait-max 40 minutes, run
`node packages/environment/scripts/test-browser.js --page=studio` and again with `--compat`.
Run `node packages/staging/test/ground-browser.mjs --studio` on both paths too. The studio value
oracle checks all four softboxes' source directions, SH and irradiance ordering; staging checks off/on
contact pixels, unchanged product/outside pixels, removal, disposal and real replacement-device
recovery. [Frozen evidence](results/batch-56-rigs.json). No external assets or speed comparison.

### Batch 68 job 5: sharp SDF models

`npm run test:sdf-kernel --workspace @margoengine/procedural` runs the native QEF
rank, rotated-plane, anisotropic and shared-root controls. `npm test --workspace
@margoengine/procedural` reads the actual Khronos Box.glb position accessor and
asserts every reference corner, planar surface, outward winding, closed edges and
volume. The committed small standard fixture has a pinned SHA-256 and attribution
in test/fixtures/sdf/NOTICE.md. Other controls are generated stand-ins.
`npm run test:gpu --workspace @margoengine/procedural` checks identical geometry
values on real WebGPU and WebGL2 before and after loss, disposal and independent
lazy loading. `cellEdgeUses == 4 * edgeSolves` proves shared-root work reduction;
there is no elapsed-time or SIMD speed claim (LIM-632).

### Outside-tool supplied mip chains

After `git lfs pull` and `npm run build:packages`, run:

```sh
node scripts/gpu-lock.mjs run --owner=mips-proof -- node packages/materials/test/features-browser.mjs mips
```

The required unmodified KTX-Software-CTS file fails on missing/LFS/changed bytes. Its
notice pins the public URL revision, size, licence and hash. The test splits seven
layers into 2D chains, uploads through materials/mips, and hashes every texel from
a compute textureLoad/pack4x8unorm read using a linear view. Expected hashes come
from independent `ktx extract --raw --all`, not Margo's decoded data. All 35 images
(9,548 texel bytes) must match. Solid-colour conformance only; no quality or timing
claim. Durable record: `results/mips-real-tool-20261109.json`.

### Batch 76 independent review corrections

Run npm test --workspace @margoengine/transitions, then node scripts/gpu-lock.mjs run --owner=codex-76fix --max=8 --wait-max=10 -- node packages/transitions/scripts/test-gpu.mjs. The runner includes viewport-browser.js: compare patterned 8x4 captures with a no-transition baseline inside the right-half viewport and throughout a stacked inset/scissor target, for four built-in kinds/custom/mask at idle/0/0.5/1, 1x/4x. Original code fails at wipe idle 1x pixel 4,0 red (0 versus 127). The live integer-format regression fails against the original code because rgba8uint does not throw. Live real-device tests check integer/depth/non-resolvable float refusal with unchanged source updates/progress and accept baseline float/normalized formats. Additional resource-interface probes compile only; the costly-loop shader is never dispatched. Run node --test --test-timeout=60000 packages/scatter/test/*.test.js for the ring/f32/capacity audit's existing regression suite. Evidence is correctness on generated inputs, not throughput or hostile-shader execution safety.

### Static USDZ README input

Run `node scripts/fetch-readme-assets.mjs` (or the required external downloader),
then `npm run check:readme-run -- --packages=usdz` and
`node --test --test-timeout=120000 tests/readme-assets.test.js`. The /model.usdz
alias requires the published Blender BoxTextured conversion, including its PNG.
Its 8,080-byte SHA-256 and licence are in scripts/support/external-test-assets.json.
Missing/LFS/changed bytes fail with the external fetch command. The regression
asserts 36 expanded vertices and 12 triangles, not a visual-quality metric. The
composition example's separate known exception remains.

### Splat README inputs

After building/restoring fixtures, run:

```sh
node --test --test-timeout=120000 tests/readme-assets.test.js
npm run check:readme-run -- --packages=splats
```

All 14 examples must execute. Regenerate the local
real-excerpt .splat with `node packages/splats/scripts/make-readme-splat.mjs`;
its 268,320 bytes and SHA-256 are in the fixture notice. This is not an outside
.splat oracle. Full SPZ capture proofs retain their separate required shared inputs.

### Batch 56 viewer numeric safety

Build packages, run the stage package tests, then run scripts/stage-viewer-gpu-check.js through
the GPU lock (owner codex-56). Append --compat for the compatibility path. Extreme periods are
Number.MIN_VALUE, -1e-309 and Number.MAX_VALUE, with a visible real helmet and no GPU errors.
The CPU test includes both signs and huge finite deltas; old code produces nonfinite coordinates.

### Batch 56 audit: physical sampler pressure

After building packages, run the gltf-pro tests and scripts/stage-viewer-gpu-check.js through the
GPU lock, on native WebGPU and with --compat. The same real FlightHelmet file, including its
transmission-factor lens, uses IBL plus a floor shadow. Before the repair ANGLE reported fragment
texture image units exceeding MAX_TEXTURE_IMAGE_UNITS(16), the frame loop stopped and the
turntable assertion failed. The same unchanged assertions pass after unused physical maps are
replaced by exact fallback constants and omitted from the bind group.

### Batch 56 audit: mandatory direct glTF GPU inputs

Run node scripts/support/external-test-assets.mjs, then run the gltf-pro test:extensions:browser
script through the GPU lock. No environment override is required for the normal shared cache.
For a missing or changed input, use the named fetch-skip-assets recovery command. The four cases
now actually consume their validated files. Run tests/external-test-assets.test.js for the cache
failure regressions and the direct-harness contract checked by verify/check:merge.

### Batch 56 job 4: existing product viewer

Build packages; run npm test --workspace @margoengine/stage and the staging package tests. Through
the GPU lock with owner codex-56, run scripts/stage-viewer-gpu-check.js and append --compat for
the compatibility layer, or run gltf-pro's test:gpu:viewer script for both. The licensed real
FlightHelmet is the existing mobile GLB fixture. The tests assert product coverage, ground pixels,
orbit radius/height/target, rollback, extreme finite periods, disposal and actual device replacement
restoring the whole frame exactly. Raw reports are test-results/stage-viewer.json and
stage-viewer-compat.json; the committed batch-56-frame.json preserves both devices and values.

### Batch 99 mixed triangle geometry

Build with npm run build:mesh --workspace @margoengine/voxel-pathtracer, then npm run build:packages. Run npm run test:mesh-kernel --workspace @margoengine/voxel-pathtracer and the voxel-pathtracer package tests. Run node scripts/gpu-lock.mjs run --owner=codex-99 --max=10 --wait-max=5 -- npm run test:gpu:mesh --workspace @margoengine/voxel-pathtracer for native and compatibility analytic paths, predicate arithmetic, device replacement and raster restoration. The generated-scene record is results/batch-99-mesh-20261109.json. No downloaded reference asset is involved.

node packages/voxel-pathtracer/tests/mesh-build-ab.mjs runs the CPU-only scalar/Rust paired diagnostic and writes test-results/voxel-pathtracer-mesh-build-ab.json. Both builders emit the same 524,284 words for 16,384 triangles; every timed output is compared byte for byte. Alternating rounds use per-round minima. This is a loaded-machine implementation diagnostic, not a quiet release or rival benchmark.

### Batch 68 job 6: tileable GPU textures

`npm test --workspace @margoengine/procedural` runs hostile settings and the
allocation, shader-error, queue-failure, cancellation/disposal/loss controls on
stand-ins. `npm run test:gpu --workspace @margoengine/procedural` compiles the
actual shader and asserts 44,415 numerical channel values, full-period identity,
one-texel phase shifts across both edges, real loss, in-flight cancellation and
disposal, fresh-device baking and linked native WebGL2 refusal. One RGBA8 step is
the comparison bound; no time budget or numerical tolerance was loosened.
For the external structural reference, download the PDF identified and hashed in
packages/procedural/test/fixtures/textures/structural-reference.json. The fourth
embedded raster on PDF page2 is Figure1(d), 256-square. At y38 joint centres are
34.5,122.5,210.5; at y68 they are83.5,172.5. The pitch88 and nearest offset39 are
our measurements with two source pixels uncertainty. The GPU repeats this supplied
stagger and compares measured output joints within source and raster quantization.
This proves calibrated structure only, not image reconstruction or colour/wood/rust
quality. Other controls remain generated stand-ins (LIM-639). No speed measured.

### Batch 160: independent raw blend repeat regression

From this checkout, after npm ci, run through the shared GPU lock:

```sh
node scripts/gpu-lock.mjs run --owner=codex-160 --max=8 --wait-max=8 -- node scripts/reference-rendering/blend-repeat.mjs --api=webgpu
node scripts/gpu-lock.mjs run --owner=codex-160 --max=8 --wait-max=8 -- node scripts/reference-rendering/blend-repeat.mjs --api=webgl2
node scripts/gpu-lock.mjs run --owner=codex-160 --max=8 --wait-max=8 -- node scripts/reference-rendering/blend-repeat-node.mjs --backend=d3d12
node scripts/gpu-lock.mjs run --owner=codex-160 --max=8 --wait-max=8 -- node scripts/reference-rendering/blend-repeat-node.mjs --backend=d3d11
```

The browser commands render 200 frames per process, in two fresh processes. Each
command requires one unique full RGBA byte hash, records all hashes and every
changed pixel per distinct image, and exits nonzero on variation. Browser work
has a 120-second deadline per process. Node uses the existing webgpu 0.6.2 development
dependency and the exact same checked-in draw program, with a 120-second deadline.
The commands currently fail on NVIDIA 617.42. This is preserved failing evidence.

For controls, pass --samples=1 to each browser command, or set MARGO_GPU=amd in
the child environment and retain four samples. The Node control uses --vendor=amd
with --backend=d3d12. Vendor controls compare repeats within one adapter, not bytes
between adapters. --frames=2..4096 and browser --processes=1..16 control the capture
counts without changing the exact assertion.

The pinned CC0 IORTestGrid GLB is reused from the outside batch-160 cache, or fetched
from its pinned standard-asset URL if missing. Changed bytes fail SHA-256 validation;
concurrent downloads publish atomically. Source/legal details are in
scripts/reference-rendering/NOTICE.md. Reports stay outside under
engine-bench/batch-160/determinism; the committed summary is
results/batch-160-determinism.json. No renderer or driver implementation is read.

Full-scene reproductions still live on batch-160-job5-parked:
GPU-locked scripts/reference-rendering/repeat.mjs --case=ior, and
--case=volume --compat. Both compare 24 complete-scene frames with unchanged inputs
and budgets. Volume full-Cycles absolute error still spans 13,792,000..13,792,003
against 13,792,000; native IOR spans 2,423,418..2,423,421 against 2,423,418. AMD repeats
are stable but its IOR absolute error is 2,424,918, so changing adapter does not
satisfy the original gate. Both jobs remain parked until repaired.

## Batch 65 roads

Generated stand-in geometry and networks; no external asset is needed. In a built checkout run:

```sh
npm run build:packages
node --test --test-timeout=180000 packages/road/test/*.test.js
node scripts/gpu-lock.mjs run --owner=road-proof --max=8 --wait-max=10 -- npm run test:gpu --workspace @margoengine/road
npm run check:readme-run -- --packages=road
npm run measure:size
```

The browser proof uses native WebGPU and forced real WebGL2 compatibility. It checks pixels and navigation values, exact rendered geometry after reboot, explicit graph/context reconstruction and disposal. CPU graph tests force createCompute({backend:'cpu'}). All generated outputs are stand-ins. No surveyed-road, traffic-model, highway compliance, other-hardware or speed claim follows from these checks.

### Batch 99 spectral and lens effects

After npm run build:packages, run the voxel-pathtracer package tests. Through scripts/gpu-lock.mjs
with owner codex-99 and a ten-minute limit, run npm run test:gpu:spectral --workspace
@margoengine/voxel-pathtracer. This runs native WebGPU and WebGL2 compatibility analytic values:
equal-energy colour, one glass interface, a closed slab, glass and lens furnaces, finite-slab disk
coverage at three wavelengths, and extreme finite lens settings. All scenes are generated stand-ins.
Run node packages/voxel-pathtracer/tests/browser-check.mjs --spectral --report=spectral-snell dispersion
viewport through the same GPU lock for the unchanged analytic Snell and actual device-replacement
and raster-restoration assertions. No external spectral asset, reference renderer or speed claim.
The committed reports are results/batch-99-spectral-20261109.json and the matching Snell/lifecycle record.

### Batch 68 job 7: building shape grammar

Run procedural test, test:buildings-kernel and GPU-locked test:gpu. The JS test
compares floor/bay coverage, material areas, normals and shell volume with analytic
oracles; a per-vertex sine/cosine transform is coordinate-identical to the shared
scope while doing2 trig calls per vertex instead of2 per model. This is a work count,
not elapsed time. Download the CityJSON tutorial sample linked and SHA-256 pinned
in packages/procedural/test/fixtures/buildings/reference.json. Dequantize referenced
vertices by scale/translate, take min/max on each axis and build envelope rectangles
with those dimensions and one floor of the measured height. This proves envelopes
only: source polygon/facade reconstruction is not asserted. Generated controls are
STAND-IN. Browser harness serves a nonroot base, checks lazy assets and exact values
on real WebGPU/WebGL2 contexts before/after loss and idempotent disposal (LIM-640).

For the limited real facade check, download the CMP base archive in
packages/procedural/test/fixtures/buildings/facade-reference.json, verify all three
SHA-256 values and select window annotation ordinals0,6,1,7 from cmp_b0001.xml.
Multiply normalized X by543 and Y by1024. Average horizontal centre differences,
window widths and each row's window heights; use the measured vertical centre
pitch to derive a common window-height ratio and the two floor heights. Apply
those recorded rules and compare all16 bounds, fixed2-source-pixel bar. The model
agrees within1.88928 pixels. The first equal-floor calibration missed at2.12608;
using the measured unequal floors resolves its cause without changing the bar.
This is calibrated layout reproduction of four windows, not inference/reconstruction
of the whole facade. No original CMP photo or XML ships.


### Complete Node Basis glTF README (2026-11-09)

Build packages, then run node scripts/reference-rendering/fetch-skip-assets.mjs.
The existing required manifest includes the complete CC0 FlightHelmet Basis model
under helmet/ in the external cache. Run node --test tests/readme-assets.test.js
tests/run-readme-examples.test.js packages/decoders/tests/readme-node.test.js.
Through node scripts/gpu-lock.mjs run --owner=codex-missing --max=5 --, run
node packages/decoders/scripts/test-node-gltf.mjs. It executes the README's original
Node setup/load, checks texture/mip/geometry totals and GPU validation, then reads
the rendered model. Raw result: packages/decoders/test-results/node-gltf/result.json.
Run npm run check:readme-run -- --packages=decoders to execute all 17 examples.
Use MARGO_RESULT_CACHE=off for the verification run. No browser substitute or
independent Basis decoder is involved; the proof is complete-asset integration.


### P20 complete VTK big-endian horse (2026-11-09)

Build packages; fetch with node scripts/reference-rendering/fetch-skip-assets.mjs, then run node --test packages/loaders/tests/ply-outside.test.js. The complete unmodified horse and both licence files are under ply-horse/ in the shared external cache. Source URLs, sizes and SHA-256 values are in scripts/support/external-test-assets.json.

The independent oracle uses Python 3.13, python-plyfile 1.1.3 and NumPy 2.3.4 installed in an outside environment. Run python packages/loaders/scripts/ply-reference.py <external-cache>/ply-horse/horse.ply <output.json>, then compare it with packages/loaders/tests/fixtures/horse-oracle.json. It reads the original file without re-encoding it and records every position/color/index hash. Python is needed to regenerate that oracle, not to run the required Node regression.

For the existing outside-file harness, select REAL_FILES_ONLY=ply-big-endian-vtk and set REAL_FILES_DIR to an outside directory before node packages/loaders/scripts/test-real-files.mjs. REAL_FILES_RENDER=1 adds the real-GPU blank-frame check; run it through the shared GPU lock. The horse contains white RGB and confidence, with no authored normals/UVs. No visual-quality or speed comparison is implied.

### Batch 56 job 5: idle triangle product still

Build packages, then run staging's package tests. Under the codex-56 GPU lock run
node packages/staging/test/pathtrace-browser.mjs. It runs native and compatibility (ANGLE Vulkan
on Windows), the existing licensed examples/assets/flight-helmet-mobile.glb, 20,734 triangles.
Palette material intentionally replaces the authored material. It measures 8/64-sample image error
against a 512-sample reference and asserts each emission hit against [2,1,0.5], plus camera/idle
pixel identity, empty/invalid/cancelled updates, capture, disposal and a real replacement device.
Compositor screenshots establish displayed pixels. Raw report: test-results/staging-pathtrace.json;
committed scope/device/value evidence: results/batch-56-pathtrace.json. No speed result.

## Sciviz asynchronous update and replacement regression checks (2026-11-10)

From a built checkout, run:

```sh
npm test --workspace @margoengine/sciviz
node scripts/gpu-lock.mjs run --owner=sciviz-updates --max=15 --wait-max=10 -- npm run test:browser --workspace @margoengine/sciviz
npm run check:readme-run -- --packages=sciviz
npm run measure:size
```

The unit suite holds extraction and frame completions to check atomic publication, request ordering, aborts,
failures and disposal. It also distinguishes single-slice dimensions from mismatched value counts.
The browser suite checks actual overlapping isosurfaces, bricked time steps and trace replacement on native
WebGPU and forced WebGL2. Results are written to `test-results/sciviz-browser.json`,
`test-results/bricks-browser.json` and `test-results/sciviz-entries.json`. No speed claim follows.

## Batch 56 job 6: oriented staging receivers

After build:packages, run node scripts/gpu-lock.mjs run --owner=codex-56 -- node packages/staging/test/orientation-browser.mjs, then the same command with --compat. --record writes the two committed evidence records under examples/package-benchmarks/results. npm test --workspace @margoengine/staging runs the independent CPU projection/fit/extreme-direction regressions. The real-product case loads the already licensed examples/assets/flight-helmet-mobile.glb; no generated model substitutes for it. Screenshots are compositor screenshots. Native preview refusal is also asserted on a real WebGL2 context.

### Batch 65 review corrections

After a package build, run the exact four review inputs and shared periodic consumers:

```sh
npm run check:road-invariants
node --test --test-timeout=120000 packages/road/test/*.test.js packages/splines/test/*.test.js packages/geometry/tests/*.test.js
node scripts/gpu-lock.mjs run --owner=codex-65fix --max=10 --wait-max=5 -- npm run test:gpu --workspace @margoengine/road
node scripts/gpu-lock.mjs run --owner=codex-65fix --max=10 --wait-max=5 -- npm run test:gpu --workspace @margoengine/geometry
node scripts/gpu-lock.mjs run --owner=codex-65fix --max=10 --wait-max=5 -- npm run check:readme-run -- --packages=road,splines,geometry
npm run lint
npm run hygiene
npm run verify
```

The review and corrective logs are local worktree evidence under test-results/review65 and test-results/fixes65. The committed result record is results/batch-65-review-fixes-20261109.json. The original repair implementation succeeds with area 80 and all Y values zero for the hill input; the regression now requires coded unsupported. All six new regression tests fail on the original implementation (the repair baseline was also probed directly). No performance measurement is claimed.

### Batch 68 caves

Build: npm run build:caves --workspace @margoengine/procedural (Rust wasm32 target).
Run npm run test:caves-kernel --workspace @margoengine/procedural, then npm test
--workspace @margoengine/procedural. GPU values/loss: use the required GPU lock
around npm run test:gpu --workspace @margoengine/procedural. The caves browser
test checks a seeded 2D cave, a seeded 3D island volume and real Natural Earth
Madagascar land. reference.json pins the source URL, public-domain terms, original
length/hash, extent and cell-centre resolution. caves-reference.js independently
parses/rasterizes that data and applies scalar synchronous rules. Every output
cell must match, including before/after loss and fresh instances on both APIs.
Native tests compare every threshold on asymmetric grids and prove the exact
read-count formulas in perf-history.md; tiny grids choose direct reads. No fixed
runtime/speed threshold, connectivity or real 3D geology is claimed.

## Batch 56 reflective-floor audit regressions

Run npm test --workspace @margoengine/environment, then under the GPU lock run node packages/staging/test/floor-browser.mjs and the same command with --compat. --record writes batch-56-floor.json and batch-56-floor-compat.json in examples/package-benchmarks/results. The licensed FlightHelmet mobile GLB is an existing required fixture. The test verifies every component of all eight power-of-two mips against independent 2x2 means, exact half-rounding probes, displayed reflected pixels, actual replacement-device frame equality, resize and a uniform cleared product capture. Existing scripts/env-mirror-gpu-check.js exercises independent mirror, glass and cube-camera references.

## Batch 99 parity gamma regression (2026-11-09)

Run `npm run build:packages`, then
`node scripts/gpu-lock.mjs run --owner=parity-gamma --max=6 -- node packages/voxel-pathtracer/tests/magicavoxel-gamma-browser.mjs`.
The test requires exact reference bytes on native WebGPU and WebGL2 compatibility and writes
`test-results/voxel-pathtracer-magicavoxel-gamma.json`.

For the external black-box value measurements, generate standard own fixtures with
`node packages/voxel-pathtracer/tests/magicavoxel/parity-fixtures.cjs <temporary-directory>`.
Use the official 0.99.7.2 win64 archive and executable with the digests in
`results/batch-99-parity-gamma-20261109.json`; keep the tool and PNGs outside Margo.
Open each `gamma-*.vox`, enter Render, load camera slot 1, wait for all 1,024 samples,
and save the raw 960 x 800 snapshot without denoising. Read RGB at (480,400): gamma
1/1.8/5 gives 20/46/89. For `colored-sky.vox` the gamma-1 value is 64. These interior
zero-variance measurements do not establish whole-image repeatability. A camera-slot
reload glides to its target, and model/render mode toggling can retain accumulation.
The independent full zero-error parity corpus remains unfinished.


### Test-page contracts

Build with `npm run build:packages`, then run `npm run check:testpage-contracts`
and `npm run check:road-invariants`. Run native SDF tests with
`npm run test:sdf-kernel --workspace=@margoengine/procedural`.
GPU proof: `node scripts/gpu-lock.mjs run --owner=codex-testpage --max=10 --wait-max=10 -- node packages/procedural/test/textures-browser.mjs`.
The shader oracle, both native backends, repeat seams, GL state restoration,
context/device loss, cancellation and disposal use the same tolerances.
Actual character-asset contracts: `node --test --test-timeout=120000 packages/animation/tests/testpage.test.js`.
All generated controls are stand-ins except the existing Khronos/Cesium Box,
RobotExpressive, RiggedFigure and calibrated brick reference noted in their
existing source notices. No test-page source files are imported or committed.


API snapshot-query and README ownership regressions (2026-11-09): after the normal
package build, run node --test tests/api-report-globals.test.js
tests/api-report-short-path.test.js tests/api-report-scope-full.test.js
tests/api-report-scope.test.js tests/readme-effect-ownership.test.js. The short-path
test executes the entire real CLI and checks one file-list query without changing
its 280 s deadline; the API reports must match byte for byte. Run the real examples
with npm run check:readme-run -- --packages=shadows,quality,post. The retained paired
slow-send record uses the existing unmodified flythrough fixture, three rounds of
two flights per version, alternating version order, slowSends(2, 0.02). It is
diagnostic evidence under load, not a published speed ratio or a passing timing gate.

Test-page 36: after `npm run build:packages`, run
`node --test --test-timeout=120000 packages/core/tests/transform-refs.test.js`
and `npm run measure:size`. The parent fails replacement rejection; the repaired
build preserves mutation and inspector restoration. Package GPU and README checks
use `npm run test:gpu --workspace=@margoengine/core` and
`npm run check:readme-run -- --packages=core` under the shared GPU lock.

For test-page 44, build packages then run
`node --test --test-timeout=120000 packages/mesh-edit/tests/testpage-bevel.test.js`.
The parent fails eight planar-face cases; the fix passes all twelve including
closed winding, provenance and subsequent edits. The package browser script and
`npm run check:readme-run -- --packages=mesh-edit` exercise its rendering and docs.


Batch 160 isolated mip correction: build packages, then run node --test
packages/webgl2-compat/test/*.test.js. Under the shared GPU lock run both
webgl2-compat/test:browser and webgl2-compat/test:gpu through
scripts/gpu-package-tests.mjs --no-build --select=webgl2-compat/test:browser,webgl2-compat/test:gpu.
features-browser.mjs compares all original cases plus unfiltered native mip
interpolation and exact private argument counts, including short-circuit and
discard cases. A negative control replacing the emitted fractional weight with
zero must fail the unchanged exact mip assertions. No tolerance is raised.


### Batch 160 job 4: complete transmission and volume scenes

Source/license and reference hashes are in scripts/reference-rendering/NOTICE.md
and the frozen results/batch-160-{transmission,volume} JSONs. Source GLBs and
Sample Viewer/Cycles PNGs remain outside this repository in engine-bench/batch-160.
Use fetch-assets.mjs and cycles-gltf.py for public licensed data and black-box
Blender Cycles; never inspect reference-renderer source. The full/direct controls
retain all authored primitives, pixels, samples and budgets.

Build packages, set MARGO_GPU=amd and GPU_POWER=low-power, then run each command
in its own shared GPU slot with owner codex-160, wait-max at least 60 and max
at measured runtime plus a small margin:

~~~powershell
node scripts/reference-rendering/proof.mjs --case=transmission
node scripts/reference-rendering/proof.mjs --case=transmission --compat
node scripts/reference-rendering/proof.mjs --case=volume
node scripts/reference-rendering/proof.mjs --case=volume --compat
~~~

Each command preserves 72 PNGs and proof.json in a unique external directory,
validates every original budget, actual AMD adapter and identical decoded RGBA
bytes. The full volume ceiling remains 13,792,000. Native WebGL2 refusal is
covered by run.mjs. Run gltf-pro's native-volume GPU test for twenty exact slab
readbacks on each backend, and its unit tests for transformed/instanced shader
math and exact absent normal-map fallbacks. No benchmark is part of this proof.

### Batch 99 media README initialization

Build voxel-pathtracer, then run node --test --test-timeout=30000
packages/voxel-pathtracer/tests/media-readme.test.js. With the original media
example, the controlled unresolved-trace promise fails the initialization assertion.
The replacement also checks the real renderImage API with its original dimensions,
sample count and cancellation signal, capture error propagation and disposal.
Run check:readme-run with --packages=voxel-pathtracer --only=heterogeneous in one
shared GPU slot (wait-max at least 60, max measured duration plus a small margin).
The 20-second module deadline is unchanged. Click Render 32 x 32 image to request
the awaited float capture; leaving the page disposes both owners. Forced WebGL2
uses the existing compatibility shim. Proof:
results/batch-99-media-readme-startup-20261109.json.

### Batch 99 viewport history mask

Build packages, then run
`node scripts/gpu-lock.mjs run --owner=codex-99 --wait-max=60 --max=0.75 -- node packages/voxel-pathtracer/tests/history-taps-browser.mjs`.
The suite captures the DENOISE shader from the built root entry, dispatches its
combine kernel on controlled finite-ray inputs, and checks all 16 masks, live
and exhausted/zero history, HDR 32768, native WebGPU and WebGL2 compatibility,
and a real replacement device. It writes
`test-results/voxel-pathtracer-history-taps.json`. The declared package GPU
gate enforces its six minute tree limit. Removing only the per-tap mask guard
reproduces 112 failures among 448 cases; the full repair evidence is in
`results/batch-99-history-taps-20261109.json`. The unchanged denoisehistory
case remains an additional camera-motion quality check, without a noise-free
claim. No baseline test or tolerance was weakened.

Batch 99 history/artifact landing: build the current workspace, run voxel-pathtracer package tests and test:gpu:history-taps, then check:readme-run -- --packages=voxel-pathtracer. GPU commands use one shared slot per lane, wait-max at least 60 and measured holds plus a small margin. Preserve successful equivalent-source checks and rerun failed steps only, as the coordinator directs. Commit package inputs, regenerate examples/package-benchmarks/entry-sizes.mjs and scripts/basic-scene-network.mjs from that same clean revision, api:update after entries, api:check, and scripts/build-llms.mjs after final docs. Do not edit provenance metadata. Current scoped receipts and retained historical verify evidence are in results/batch-99-history-landing-20261109.json.

### Preview attachment contract

For the compatibility continuation, build packages and run
`node --test --test-timeout=120000 packages/webgl2-compat/test/private-inference.test.js packages/webgl2-compat/test/device.test.js packages/dof/tests/temporal-compat.test.js`.
Under one shared GPU slot run `node scripts/light-render-gpu-check.js`,
`node packages/culling/test/gpu/dynamic-check.mjs`, and both
`node packages/dof/tests/gpu/lens-check.mjs` and
`node packages/dof/tests/gpu/compat-check.mjs`. Repeat the applicable native and
`MARGO_COMPAT=1` checks; the comparison fixture controls its two tiers itself.
Keep the original exact pixel and lens bounds. No timing suite is authorized.

After `npm run build:packages`, run `npm run check:preview-contract` and `node --test --test-timeout=120000 tests/preview-contract.test.js tests/preview-refusal.test.js packages/lod/test/preview.test.js`. Run browser evidence under `node scripts/gpu-lock.mjs run --owner=preview-contract --max=15 -- node packages/webgl2-compat/test/package-tiers-browser.mjs`; add `--compat` to exercise the first scene on the full layer too. Results: `test-results/preview-package-tiers.json`. The fixture is a clean-room triangle embedded in an HTTP glTF, with selected magenta edges. No external asset or rival source is needed.

The package-tier browser gate also covers Gemini entries 21, 22, 26, 29, 30, 31, 33 and the missing-fallback diagnostic (28). Run webgl2-compat/test/device.test.js after the package build for the native-retained install warning (27). The procedural preview route must finish without loading the compatibility layer.

Research basis and source comparison: [preview contract review](preview-contract-research.md). Under the 2026-11-10 restart use the shared GPU phase only; the three cutout-caster timing scripts are deferred in [the speed-phase record](../work-lists/speed-phase.md).

Recording example activation: run `node --test --test-timeout=30000 packages/video/test/readme-record.test.js` and `npm run check:readme-run -- --packages=video` under the shared GPU lock. Click the README example's Record button to capture its generated picture and tone. [Research and the regression's scope](recording-example-research.md).

Batched picking work counts: after building packages, run
`node --test --test-timeout=120000 packages/selection/test/picking.test.js`.
GPU equivalence and command counts: `node scripts/gpu-lock.mjs run
--owner=codex-skipgaps -- node packages/selection/test/pick-many.browser.mjs`.
This retains the same points, IDs, clipping and neighbor priority. For elapsed
time, only after Scott ends the build phase, rerun the parity command in
perf-history entry 60 under the speed-phase policy.

### Batch 134 packed LDR checkpoint

The private batch-134 draft uses `transcoder/Cargo.toml`; run its native tests and
release wasm32-unknown-unknown build before `measure/packed-ldr-compare.mjs`.
The comparison reads frozen prebuilt hashes and the existing CC0 source records;
it does not run a new timing A/B. `measure/packed-ldr.test.mjs` checks all eight
frozen conversion-probe payloads and synthetic two-frame/two-mip video through
the Wasm ABI. `measure/draft-size.mjs` first reproduces the pinned prebuilt
527,333 raw / 247,535 gzip sizes with Node gzip9, then measures the draft.
Results: [packed LDR](results/batch-134-packed-ldr.json). Private scripts/assets
are not a public package or a claim that full replacement acceptance is complete.

`measure/private-basis-adapter-compare.mjs` checks six .basis inputs and all
180 implemented frozen payloads through the private queued TypeScript API.
The private Node suite combines `private-ktx-container.test.mjs`,
`private-basis-adapter.test.mjs`, `packed-ldr.test.mjs` and
`comparison-corpus.test.mjs`; it includes the failing-before damaged-frame
regression and synthetic video/cancellation/disposal controls.

`measure/whole-container-fuzz.mjs` runs every primary seed in a separate process
with a 180-second hard limit and a 512 MiB Node host-heap ceiling; the outer
`report11-run.mjs` bounds the campaign at 1,800 seconds. Metadata mutations,
CRC-repaired .basis mutations, payload flips and truncations are deterministic.
Unmodified controls run before and after mutations; target 26 is compared to
the independent strict specification reader, all other implemented targets to
frozen prebuilt payloads. Seed records pin the input, adapter and Wasm hashes.
[Campaign result](results/batch-134-whole-container-fuzz.json): 51 seeds, 2,856
mutations and 13,507 decode calls, with no trap, uncoded refusal or hard timeout.
No timing A/B or fuzzer-speed comparison runs in this campaign.

For the private [UASTC BC7 checkpoint](results/batch-134-uastc-bc7.json), run
`measure/bc7-solid-probe.mjs` then `measure/bc7-solid-contract.mjs` against the
pinned outside opaque prebuilt. The published-format inputs sweep 3,072 solids
in both transfer modes; the contract was documented before implementation.
`measure/extract-bc7-tables.py` reads only the pinned format specification and
uses explicit anchor tables 129-131. Build the same private Rust crate and Wasm,
then run `measure/bc7-compare.mjs`, `measure/bc7-crafted.mjs` and
`measure/bc7.test.mjs` with the bounded CPU runner. The crafted comparison has
5,504 cases, every mode/partition/CSEL and two transfer modes. The native anchor
regression fails with the earlier typography-derived table and passes using
the explicit table. All primary BC7 mip/layer/face payloads compare strictly.
`measure/report12-bc7-evidence.mjs` records source hashes, the exact corpus and
crafted outputs, and the baseline-compatible raw/gzip draft size. Remaining
encoders/public integration and full job 2/3 acceptance remain pending.

`measure/whole-container-fuzz-report12.mjs` preserves the prior deterministic
campaign and adds UASTC BC7 target 6. Run it through `report12-cpu.mjs` with a
1,800-second outer hard limit; it spawns each seed with a 180-second limit and
512 MiB Node heap. It retains separate report12 seed logs/results and preserves
the report11 evidence. `measure/report12-fuzz-evidence.mjs` verifies unchanged
decoder sources and aggregate Wasm/adapter hashes against the BC7 checkpoint.
[Result](results/batch-134-bc7-fuzz.json): 51 seeds, 2,856 mutations and 14,974
decode calls, with no uncoded error, trap or hard timeout. Per-seed input and
adapter hashes are logged; the Wasm hash is aggregate. The same caveats about
mixed call counts, implemented subsets and end-instance memory still apply.

For the [private UASTC ETC checkpoint](results/batch-134-uastc-etc.json), use
the same pinned private crate and Node gzip9 baseline. Research extent and
pre-use SOLID-ETC-1 convention are recorded in [clean-room review](../clean-room.md).
The detailed planner record remains in the retained author workspace, outside
clone contents. With the bounded CPU
runner, execute `measure/etc-solid-contract.mjs`, native crate tests, release
Wasm build, `measure/etc.test.mjs` and the retained adapter/packed/BC7 tests.
`measure/etc-compare.mjs` is a strict byte-identity diagnostic: it reports498
differences among690 images for these permitted selector choices; its result
must not be presented as a passing strict identity check. The actual
quality gate `measure/etc-quality.mjs` rechecks old payload hashes and old
source SSE/sample/per-channel metrics, then requires no worse aggregate
source SSE for each of52 file/target pairs, with no tolerance. All52 improve.
The same original pixels and direct exact-area mip references are preserved.
`measure/report13-etc-evidence.mjs` freezes source/tests and records the work
count, selected checks and draft size. This does not complete jobs2/3.

`measure/prepare-report13-fuzz.mjs` preserves prior campaigns and freezes the
quality-validated ETC outputs. Run the distinct
`measure/whole-container-fuzz-report13.mjs` with the1800s bounded runner; each
seed retains180s/512MiB limits. Older controls stay strict old/spec hashes;
new ETC controls check recovery against the independently validated replacement
payloads. `measure/report13-fuzz-evidence.mjs` verifies every source manifest pin
and aggregate/per-seed Wasm/adapter pins. [Result](results/batch-134-etc-fuzz.json):
51 seeds/2856 mutations/17908 calls, no uncoded error/trap/hard timeout. Do not
sum mixed call/refusal axes or treat end-instance pages as peak memory.

## Ordered erosion CPU proof

Build `@margoengine/biomes`, then run
`node --test --test-timeout=120000 packages/biomes/tests/erosion-wasm.test.js`
and `node packages/biomes/tests/erosion-dem.mjs` under a 20-minute process-tree
timeout. The latter downloads only missing pinned standard terrain tiles, checks
every source hash, joins without resampling, converts Terrarium metres to rounded
integer millimetres, and checks every output hash at the default 32 iterations.
The SHA-256 references came from Margo's original ordered JS algorithm with only
its cell/key stride raised to 2^22, verified byte-for-byte against the draft and
now against the integrated entry. No foreign erosion code is used. The linear
memory report counts Wasm pages, input and owned output separately. No timings
or GPU work are run. Source manifest: packages/biomes/tests/fixtures/erosion-dem.json.

For the production browser proof, first run the package CPU bundle regression:
`node --test --test-timeout=120000 packages/biomes/tests/erosion-bundle.test.js`.
Then run `node packages/biomes/tests/erosion-browser.mjs` in one shared GPU slot
with wait-max 60 and a one-minute hold. It validates separate emission, lazy
fetch, exact served Wasm and all real-crop fields on WebGPU/WebGL2 pages.
### Review 99 deferred spectral regression

Run `node scripts/gpu-lock.mjs run --owner=review-99 --wait-max=60 --max=7 -- node
packages/voxel-pathtracer/tests/spectral-browser.mjs` with `MARGO_GPU_SLOTS=1` after building packages.
The native and real WebGL2 compatibility reports require exactly zero white-scene RGB spread at
1 and 64 spp, and exact root equality for achromatic/inactive lens paths. Analytic interface/slab,
dispersive furnace, finite-slab lens disk-edge, alpha and restoration checks retain their bounds.
This is deterministic work removal, without a measured speed claim.
The committed native/compatibility transport and lifecycle report is
`results/review-99-spectral-20261109.json`.

## RT cutout CPU preparation

After `node scripts/build-modern.js --precompiled --only=bvh,shadows`, run
`node --test --test-timeout=120000 packages/bvh/tests/*.test.js packages/shadows/test/*.test.js tests/modern-game.test.js tests/modern-shadow-texture-transform.test.js`
under an eight-minute process-tree limit. All 379 tests run, with no skip or
timing-only assertion. The new real-model test decodes the actual MASK PNG from
the standard AlphaBlendModeTest GLB; unrelated opaque RGB JPEGs need no alpha
decode. It packs the unchanged complete model and compares candidate results
with AlphaRaycaster, counting rays through clear nearest candidates even when
a farther opaque surface is present. The CPU oracle caches decoded masks by
identity; it does not decode the same million pixels again for each ray. Mock
GPU resources prove ownership/restore/fallback/cleanup without acquiring a GPU.
Then run these registered real-GPU steps, each in its own shared slot with
`--owner=codex-skipgaps --wait-max=60 --max=1`:
`node packages/shadows/test/rt-alpha-browser.mjs` and
`node packages/shadows/test/rt-alpha-attach-browser.mjs`.
The first checks actual standard-model closest/any/fragment coverage and repeated
setup. The second renders public Shadows.attach with the complete model and
opaque/alpha/restored/fallback controls. Its RT far=7.1 ends before the opaque
backboard; the fallback oracle reaches the full model. Independent five-point CPU
rays select unmixed pixel coverage before rendering; visibility bars are 0.05/0.95.
JSON and PNG evidence is in test-results/shadows-rt-alpha*. No timing gate runs.

For the independent texture-rotation reference, prepare the pinned assets on CPU
with scripts/support/gltf-production-assets.js cachedProductionAssets(), then run
`node scripts/gltf-production-assets-tests.js` in one shared slot. This generic
filename needs an explicit `--gpu=Renders production models and texture pixels`
classification when invoking gpu-lock directly. No companion implementation is used.

### Batch 273 tier device checkpoint

For the full-tier materials vertex-input fixture regression, build packages and run
`node scripts/gpu-lock.mjs run --owner=codex-batch273 --wait-max=60 --max=2 -- node packages/materials/test/vertex-inputs-browser.mjs`.
The leaf explicitly selects native then compatibility even when MARGO_COMPAT is
set. It requires 2/3/5 fetched inputs, five when trimming is disabled, more than
5,000 lit pixels and exact RGBA equality. Before repair, forced compatibility
fails `inputs fetched`; after repair both report 47,234 lit pixels and no
differences. Receipts: test-results/batch-273-vertex-inputs-before.log and
batch-273-vertex-inputs-after.log. No timing assertion or benchmark was run.

The inherited compute scheduling repair is reproduced by
`node --test tests/modern-extension-suite.test.js tests/check-fixed-waits.test.js`
and the GPU-locked `node packages/compute/tests/scene-owner-browser.mjs` leaf.
The manifest previously omitted this browser file, making plan() throw; the
fixed-work scanner also required the exact four-dispatch oracle to state its
reason. All 133 tests in the nine originally failing planner/scanner files
pass after registering the leaf, including the new planner regression. The
real leaf passes both backends with all 1,024 values equal to four. Receipts:
test-results/batch-273-vertex-failed-units-repaired.log and
batch-273-compute-scene-owner.log. This does not relabel the failed full verify.

Build with npm run build --workspace @margoengine/webgl2-compat. Run the CPU tests
with npm test --workspace @margoengine/webgl2-compat (hard limit 5 minutes). Run
node scripts/gpu-lock.mjs run --owner=codex-batch273 --wait-max=60 --max=3 -- node
packages/webgl2-compat/test/tiers-browser.mjs for all three extension-masked tiers.
For the retained native comparison, run the same shared lock command with --max=5
and packages/webgl2-compat/test/compat-browser-check.mjs. Each command renders
under one shared slot and releases on completion. The tier test compares exact
logical copy bytes and uses an independently compiled raw-GL physical-format
oracle for blending. No timings are asserted or published. The complete package
GPU/browser suites and full lower-tier package refusal/image matrix remain required
before landing. Scoped README execution passes 16/16 examples and API checks pass.
The first verify stops at a stale global API aggregate; regeneration repairs it.
The resumed full unit run passes 13,669/13,671 with no skips: its strict lazy-edge
inventory needs the two new optional edges, and the generated llms files need
refreshing after the new API/docs. Targeted repair checks are recorded separately;
no canceled or failed full run is presented as an unconditional verification pass.

Additional completed browser steps: adapter, destroy-frame, compute, package
routes, XR, preview, capability probe, GLSL corpus (558 linked pipelines / 1,238
entry points) and corpus draws (733 render pipelines / 478 compute pipelines).
The canonical corpus continues to exclude the 20 independently owned tracer
pipelines exactly as before; this batch does not claim their check. Receipts:
test-results/batch-273-remaining-gpu.json and its per-step logs.

For the ten scoped tier package scenes, use the same shared lock with --max=2
and packages/webgl2-compat/test/tier-packages-browser.mjs. Failed-only selections
use --only=<URI-encoded scene name>, comma separated. The three original LDR
misses are retained in results/batch-273-tier-packages*-initial.json; repaired
setup refusals and the retained passing rows are combined with explicit scope
in results/batch-273-tier-package-summary.json. PostStack, Bloom and SSAO CPU
regressions check allocation/refusal/restore ownership and supported tiers.
The native post GPU suite and all 25 post README examples pass. Full optional
package/tier coverage remains outstanding; no package-wide completion is claimed.

Landing scope (coordinator direction): ship the device entry and these ten scenes;
T273-COVERAGE in the package README and limits tracks the remaining package work.
On current-main integration, all three device tiers and all 20 scoped package rows
pass again, as does the upstream preview/auto package browser proof. All eleven
post GPU commands also pass with MARGO_COMPAT=1 in a single shared slot. CPU
validation passes 283/284 initially; the only failure was the explicit isolation
alias list missing the now-tracked tiers umbrella file. Adding that registered
alias passes all six isolation checks, including exact generated alias contents.
Lint, hygiene and all five quality gates pass. The initial full verify invocation
failed at stale generated API; its resumed unit run had two failures repaired by
targeted runs. API, llms, size-page and lazy-boundary checks pass afterward. This
is composed step evidence, not a claim that an unconditional full verify passed.
The retained README evidence is 16 compat/umbrella and 25 post examples, unchanged.
No passed step was rerun without an affected input; no tolerance or workload changed.
Final integration inherits fc20cdca6's named TRS repair and migrated consumers.
It changes no compat, post, shared, core or stage source. Those consumers are
rebuilt and API/llms regenerated. The paired entry/network records retain their
actual pre-TRS measured revision 4e441cc88 and clean package state; they are
historical measurements, not relabeled as the final integration revision.

### Batch 56 review regressions

From this checkout after `npm run build:packages`, run the package unit suites
(environment, staging and TAA), then these bounded real-GPU cases:

```sh
node scripts/gpu-lock.mjs run --owner=codex-56fix --max=10 -- node packages/staging/test/pathtrace-browser.mjs
node scripts/gpu-lock.mjs run --owner=codex-56fix --max=10 -- node packages/environment/tests/review56-browser.mjs
node scripts/gpu-lock.mjs run --owner=codex-56fix --max=10 -- node packages/environment/tests/review56-browser.mjs --compat
node scripts/gpu-lock.mjs run --owner=codex-56fix --max=10 -- node packages/staging/test/hdr-shadow-browser.mjs
node scripts/gpu-lock.mjs run --owner=codex-56fix --max=10 -- node packages/staging/test/hdr-shadow-browser.mjs --compat
```

Pathtrace includes both backends and sixteen stationary TAA frames for each
idleDelay 0.25 and 0 (four-sample cap). View isolation compares every RGB component
outside the half-canvas viewport or independent scissor. HDR rotation compares
shadow-pixel centroids at 0 and PI with the actual radiance first moment, returns
to exactly the original mask statistics, and checks the photographed floor darkens.
Inputs are the pinned CC0 Poly Haven Small Empty Room 1 HDR and the existing
licensed FlightHelmet model, plus a raised-box geometry control. No foreign
implementation is required. Full package GPU suites and README runtime examples
remain required, along with lint, hygiene, verify and the unchanged size ceilings.

### Batch 56 PostStack ownership audit (CPU)

After `npm run build:packages`, run these inert-GPU regressions; they create real
engine registries without requesting a physical adapter or GPU lock:

```sh
node --test --test-timeout=120000 packages/post/test/scene-owner.test.js packages/post/test/effect-owners.test.js packages/dof/tests/scene-owner.test.js packages/tonemap/tests/scene-owner.test.js packages/creative/tests/post-owner.test.js packages/cameras/test/scene-owner.test.js packages/shader/test/post-owner.test.js tests/post-stack-owner-contract.test.js
```

They check owner removal, direct disposal, other-scene identity, replacement and
restoration. The shader test additionally checks actionable setup diagnostics.
Run `npm run proofs -- --current` for all 20 CPU recorder proofs; it compares
stored GPU call sequences without rendering on hardware. These are CPU evidence,
not substitutes for the package GPU and README-runtime gates. Do not run physical
GPU gates before the coordinator's browser-teardown restriction is lifted, or
timing tests while the speed phase is deferred.

Batch 56 continuation: review56-browser.mjs also reads the linear capture texture
for Reflector, Refractor and CubeCamera attached to a secondary scene: the red
owner background and green owner mesh must appear, and no blue default-scene
pixel may appear. Explicit disposal must preserve an unrelated same-name plugin
and allow replacement. It also compares every GPU studio cube texel for
[1, 1, 0], [MAX_VALUE, MAX_VALUE, 0] and [MIN_VALUE, MIN_VALUE, 0].
Run the same entry with --compat for the independent compatibility proof.
These checks require successful execution; their presence alone is not acceptance.

### Batch 56 remaining terrain owner regressions

After building packages, run
`node --test --test-timeout=30000 packages/terrain/test/scene-owner-extra.test.js`
and `node --test --test-timeout=30000 tests/terrain-provider-owner-contract.test.js`.
Run `node examples/package-benchmarks/proofs/terrain-ssr.proof.js --current`
only after the build finishes; its 6,458-call proof is deterministic and does
not run timings. The first attempted proof overlapped the core rebuild and
failed module resolution; the ordered run passes without a source change.
Then run each of terrain's 15 package GPU commands in one shared slot per
command, with `--owner=codex-56fix --wait-max=60 --max=1.5`, followed by
`node scripts/run-readme-examples.mjs --packages=terrain` with `--max=2`.
The inherited sequence's original successful commands and reset-interrupted
README are retained under test-results/56fix/owed-terrain-*.

## Batch 134 scalar ideal-fidelity evidence

From the repository root, after building `@margoengine/decoders`, run
`node scripts/measure/scalar-ideal-bound.mjs <retained-evidence-directory>`. Positional arguments
select the retained evidence directory and optional output JSON path. The inputs
are the author-retained measurement directory; default output is
`docs/whitepaper/results/batch-134-scalar-ideal-bound.json`.
The private directory must contain the frozen report17 control JSON, the
comparison-corpus and quality-pixels readers with their dependencies, baseline
metadata, licensed source PNG/RGBA files and old target13/4/5 payloads.
The committed rational report must equal the frozen control JSON. Every
payload/source hash and all 1,296 old SSE controls must match. No old decoder,
candidate Wasm, transcode, optimizer or GPU command runs. The script asserts
17/98 all-pair failures and 3/82 untouched-pair failures and prints the table.
Input hashes and per-image/pair results are written to the JSON evidence.
Use an external hard process-tree timeout, 240 seconds for the retained corpus.
This is a zero-added-reconstruction-error diagnostic, not BC bitstream output
or a universal source-error lower bound. Both current bars stay unchanged.

## Review 99 optional tracer composition

Build voxel-pathtracer and the generated umbrella entries, then run
`node --test packages/voxel-pathtracer/tests/compose.test.js`.
Real-GPU command: `node scripts/gpu-lock.mjs run --owner=review-99-compose
--wait-max=60 --max=12 -- node packages/voxel-pathtracer/tests/compose-browser.mjs --backend=native`
(join the command onto one line), then the same command with --backend=compat.
Each backend runs under its own bounded lease, one at a time. Reports are
test-results/voxel-pathtracer-compose-{native,compat}-all.json. The --phase=ids
option reruns only the AOV checks after a fixture correction, preserving transport evidence.
The page checks all 32 subsets against analytic Beer attenuation, triangle ids,
atomic scene replacement and RGB RIS shadows against the non-RIS composition.
The existing standalone GPU suites retain their independent numeric bars.
No timings or speed experiments run.

## Batch 234 FFT ocean reproduction

Follow [water-fft.md](../water-fft.md) for the research equations, real NOAA
wind fixture, oracle tolerances and separate shared-lock WebGPU/compat commands.
Package unit tests: `npm test --workspace @margoengine/water`. Results are
correctness-only; no speed experiment is part of this claim.

Batch 273 vertex-input landing checkpoint: materials unit 402/402, compute unit
111/111, materials base GPU native/full compatibility and the two-backend
vertex-input regression pass. README runtime checks pass materials 29/29 and
compute 21/21. Full verify ran once and failed its unit chain (13,856/13,873);
all other chains passed. The original failures are repaired by the targeted
planner/scanner evidence above. After rebase, 132/133 targeted tests passed;
the remaining inherited feature-enumeration annotation is repaired and the
complete affected fixed-wait file plus llms check pass. Final API, lint,
hygiene, all five quality gates, 20 inherited affected source tests and size
check pass. Core plus stage remains 23,924 B gzip; this fixture change adds no
runtime entry bytes. Logs use test-results/batch-273-vertex-*, materials-main-*,
compute-* and materials-unit. Bug 45 compilation tests remain with lane-U.
This closes only materials/test:gpu:vertex-inputs from the 26-failure index;
culling, KTX2 image reproducibility, sampler pressure and LOD remain open.

### Stats owner regression

Build @margoengine/stats, then run node --test --test-timeout=120000
packages/stats/test/*.test.js tests/stats-owner-contract.test.js with a five-minute
process-tree limit. The focused scene-owner test has four direct failures on the
parent with four passing owner-removal controls. Run scripts/test-stats-browser.mjs
in one shared GPU slot, --owner=codex-56fix --wait-max=60 --max=1.5, then
scripts/run-readme-examples.mjs --packages=stats with --max=1.5. Both commands
render on a real GPU; never hold a slot for the CPU suite or closing checks.
The browser adds eight scene-owner cases to all existing profiling checks.

### ComputeFrame owner package command

Build packages first, then run the compute package's test:browser:scene-owner
script under gpu-lock run --owner=codex-56fix --wait-max=60 --max=1.5. It changes
to the repository root itself and checks both backends. Run the complete compute
browser driver and --packages=compute runtime README command in separate shared
slots. The CPU regression tests/compute-owner-gate.test.js asserts the real
planner command and shared mode; it fails before the missing script is added.
Collected results: test-results/56fix/owed-results-compute-owner-gate-gate-repair-rooted.json.

### Recorded colour-map decimal fidelity

After building sciviz, run
`node --test --test-timeout=300000 packages/sciviz/tests/colormaps.test.js`.
The normalized source hashes cover every published row; numerical checks
cover interpolation, reversal and sRGB/linear float32 tables. Research and
original data container hashes: [size restoration](../size-restore.md), finding 8.
No timing or new display perceptual claim is made.

Batch 273 failure 9: after building packages, run the complete native and compat
grids in separate shared holds:
`node scripts/gpu-lock.mjs run --owner=codex-batch273 --wait-max=60 --max=1.5 -- node scripts/material-dispersion-gpu-check.js --backend=native`
and
`node scripts/gpu-lock.mjs run --owner=codex-batch273 --wait-max=60 --max=3 -- node scripts/material-dispersion-gpu-check.js --backend=compat`.
Omitting --backend runs both; --focus=caller isolates the original circular
resource regression. The default canonical leaf retains both complete grids.
The native full grid passes; full compatibility reaches 278 checks/254 captures
and fails the unchanged exact 4x live-reset assertion by 0.000244140625 maximum
over 10 channels. All caller references pass. The initial combined three-minute
run was killed during compat 1x and is not a pass; the separate complete compat
receipt is an assertion failure, not a timeout or busy exemption. Research,
original error, detailed remaining defect and sizes are in clean-room.md,
known-bugs.md and results/batch-273-dispersion-checkpoint.json. Total remains
2/26 suites closed; continue from failure 10 after this checkpoint lands.
Job 2's exact acquisition checklist and local browser receipts are in
../work-lists/batch-273-browser-matrix.md. No speed run or Bug 45 work was done.

Batch 273 failure 6: after building packages, run
`node scripts/gpu-lock.mjs run --owner=codex-batch273 --wait-max=60 --max=2 -- node packages/materials/test/features-browser.mjs`.
The canonical leaf explicitly opens native then full compatibility, even under
MARGO_COMPAT=1. Every one of the 15 groups runs on both devices. Add `clip` to
isolate the plane/depth/shadow/instancing/live-switch regression. Original
forced-compatibility fixture fails its clip-distances expectation; corrected
complete leaf passes in 66.4 s including orchestration, a duration receipt only.
Logs: test-results/batch-273-features-before.log and -features-after.log.
Materials units pass 402/402. No pixel bound, shader, runtime entry or ceiling
changed. Core plus stage remains 23,924 B; the size gate is recorded with the
landing checks. This closes features separately from vertex-inputs (2/26 total).

Failure 6 landing gates: materials units 402/402, full features native/compat
15/15 groups each, base materials GPU on both backends and README 29/29 pass.
The one full verify ran 13,939/13,940 units; all other chains passed. Its sole
failure was generated llms documentation freshness after the README edit.
Regenerated those files rather than repeating full verify. Rebased onto current
main, rebuilt inherited stats/sciviz, and passed all 184 affected source tests
(including llms), API, lint, hygiene and size. The inherited compute owner GPU
leaf passes both backends with all four intermediate readbacks. Core plus stage
remains 23,924 B gzip; runtime entries and size ceilings are unchanged by this
fixture fix. Receipts: test-results/batch-273-features-{verify,rebase-*,final-size}.
No whole-verify pass is claimed for the original failed invocation.


### Save factory scene-owner regression

Run `npm run test --workspace @margoengine/save` for all 112 units, including
`tests/scene-owner.test.js`. Its 16 cases fail 13 times against parent
0ba1d4f94; the original nine-case fixture fails six times. Run the package's
`test:gpu` under one shared GPU lock (owner set, wait-max 60, bounded per-command
max), then `npm run check:readme-run -- --packages=save`. The engine browser gate
renders the secondary factory mesh and verifies target-only pass execution and
failure cleanup alongside the existing real-model exact frame comparison.

## Batch 234 wave-query reproduction

Follow [water-query.md](../water-query.md). Run water unit tests and
`node packages/water/test/query.browser.mjs` on native WebGPU and with
`--compat`, using separate shared GPU leases, `--wait-max=60 --max=3`.
The retained NOAA wind observation drives the FFT cases. Actual GPU raster
positions/normals, finite-difference displacement velocity, an independent
coastal face-flux oracle and lifecycle/edit invalidation are correctness
checks. The detailed results are `batch234-water-query-*.json` in `results/`.


### Quality redraw helper acceptance

Run the complete Quality package units and tests/speed-phase.test.js with a
120-second per-test limit. Its ten scene-owner cases fail on the pre-fix parent.
After building packages, run each of the five leaves in the package test:gpu
script separately through scripts/gpu-lock.mjs run --owner=codex-56fix, shared,
--wait-max=60 and measured duration plus margin. scene-owner-browser.mjs proves
two real redraws and red canvas pixels for default/secondary scenes, cancellation
before and between frames, detachment and same-name isolation. Run
npm run check:readme-run -- --packages=quality through a shared slot. The
acceptance receipt records results and limits. The inherited single full verify
is retained; this continuation reruns affected gates only.

The original 640x360 triangle overdrawn 400 times and its exact 7 ms p90 budget
remain in scripts/speed/suites.json. Do not run that speed assertion or the
old submit-to-done wall-clock diagnostic until Scott ends the build phase.
Timestamp validity, tier storage/next-load and wrapper cleanup stay live.


### Cinematic registration reproduction

Build Cinematic, then run packages/cinematic/test/*.test.js and
tests/cinematic-owner-contract.test.js with a 120-second per-test limit. Four of
sixteen scene-owner cases fail on parent a1831da68. Run the complete package
browser leaf through one shared GPU slot with wait-max60 and measured hold plus
margin; it now includes eight actual owner/pixel cases. Run the runtime README
examples separately through that same slot. Builds stay outside the GPU lock.
All 108 units, the class guard, complete browser and ten runtime examples pass.
The eight GPU owner cases each draw 484 red pixels. The [receipt](results/batch-56-cinematic-owner-20261109.json)
records affected gates. No second full verify or speed suite was run.

### Controls wrapper owner reproduction

Build Controls, then run packages/controls/tests/*.test.js and
tests/controls-owner-contract.test.js with --test-timeout=120000. The expanded
scene-owner suite has 81 cases; eleven direct-secondary cases fail on parent
40a1548cc. The two constructor-failure cases per scene are passing controls.
The original 12-case probe independently has three failures and nine controls.

The accepted GPU proof extends the complete package browser leaf with twelve
real-GPU owner cases and rendered pixels. Run that and the walk browser leaf
separately, using the shared GPU lock, wait-max60 and measured time plus margin.
Builds stay outside the GPU lock. All fourteen Controls runtime README examples
pass, as do seventeen browser checks and three walk checks. Two additional CAD
replacement controls bring the fixed owner suite to 83 and package/guard total
to 304. No second full verify was run.

### Animator owner continuation

After building Animator, run node --test --test-timeout=120000
packages/animator/test/*.test.js tests/modern-animator*.test.js
tests/modern-game.test.js tests/animator-owner-contract.test.js. The owner file
has fourteen cases; the full command has 198 passing checks. The unchanged parent
fails five owner cases. Run packages/animator/test/scene-owner-browser.mjs and
scripts/run-readme-examples.mjs --packages=animator in separate shared GPU lock
commands with --wait-max=60, one lane slot, and a measured hold plus margin.
Builds, units and other CPU checks stay outside the lock.

Animator final acceptance: the same unit command now includes the fifteen
readme-assets.test.js contracts and passes 213 checks. The owner browser passes
eight cases, each with 242 model pixels and zero GPU errors. The complete
scripts/modern-game-tests.js browser passes; all fifteen README examples execute
in a page. The nine entry APIs and unchanged size ceilings pass. See the
[receipt](results/batch-56-animator-owner-20261109.json). The first custom GPU
fixture missed its required viewport and was corrected; no product assertion
was weakened. Retained diagnostics include the large failed-assertion formatting
stall, old README failures and the subsequently corrected sync-marker table.

### Batch 273 clamp checkpoint

Build webgl2-compat, then run node --test packages/webgl2-compat/test/device.test.js.
Run node scripts/material-render-state-gpu-check.js once natively and once with
MARGO_COMPAT=1, each under one shared scripts/gpu-lock.mjs run slot with
--owner=codex-batch273 --wait-max=60 --max=2. Full assertions remain unchanged;
negative native-bias clamp cases extend the grid. The clamp checkpoint retains
the two independently known stencil failures and does not count that suite closed.
Never invoke the canonical compatibility GPU chain containing tracer compilation.

### Video overlay owner/view continuation

Build Video outside the GPU lock, then run node --test --test-timeout=120000
packages/video/test/*.test.js tests/video-owner-contract.test.js
tests/environment-staging-view-state.test.js. Run each of the six package GPU
leaves and scripts/run-readme-examples.mjs --packages=video in separate shared
GPU lock commands, one lane slot and --wait-max=60, with a measured hold plus
margin. The new scene-owner-browser.mjs tests default/secondary direct/owner
removal, actual VideoFrame pixels, scissor exact-zero preservation, replacement,
source ownership and redraw after removal.

Video final acceptance passes all 34 units/guards, six GPU leaves and seven
runtime README examples. The owner browser draws a background scene and the
overlay view in one frame, rather than expecting a swapchain image to retain a
previous task's undrawn pixels. It waits on actual pipeline readiness. In the
same controlled fixture the actual 234f94fdb Video source bundle fails exact-zero
preservation with 4608 changed outside components; the repair passes all four
cases with exactly 512 red pixels and zero outside changes. Retained earlier
fixture diagnostics are not used as the final parent proof. All six APIs match.
[Receipt](results/batch-56-video-owner-20261109.json). The optional root size
2144 -> 2211 B and ceiling 2199 -> 2467 B are documented with the split cost.

## Batch 133 development regressions

This is unshipped decoder evidence, not a release performance result. From the
repository root, with Rust's `wasm32-unknown-unknown` target installed:

```sh
cargo test --offline --locked --manifest-path packages/decoders/native/draco/Cargo.toml
cargo build --offline --locked --release --target wasm32-unknown-unknown --manifest-path packages/decoders/native/draco/Cargo.toml
node packages/decoders/native/draco/tests/wasm-kd.mjs
node packages/decoders/native/draco/tests/wasm-memory.mjs
node packages/decoders/native/draco/tests/wasm-prediction.mjs
node packages/decoders/native/draco/tests/wasm-metadata.mjs
node --test --test-timeout=300000 packages/decoders/tests/draco-native.test.js
```

Use a 120-second hard process-tree limit for native/build/memory commands and
180 seconds for the KD campaign. The KD fixture retains 369 public-API oracle
outputs; selected full-file prefix, mutation and free-cycle checks are included.
Memory checks use the two pinned full ABeautifulGame streams credited in the
fixture notice, compare every output byte's oracle-derived hash, and enforce the
unchanged 20,185,088-byte prebuilt ceiling. The saved pre-fix artifact fails at
23,789,568 bytes; current output remains exact at an 18,874,368-byte peak.

The original 454-payload corpus additionally requires the private pinned input
and grant cache and the maintainer-only `wasm-external-check.mjs`; its manifest and
proof hashes are public in [the checkpoint](results/batch-133-resume.json).
True cold-process start-up, paired per-file cold/warm timing, process RSS, the
full feature inventory and final entry/transfer sizes remain required before
removing either prebuilt. No speed or SIMD gain is claimed here.

### Batch 133 dual-output and bit-cursor regressions

Run the native cargo test/build commands above, then
`node packages/decoders/native/draco/tests/wasm-flavor.mjs`. The native suite
includes the independent bit reference and both full/glTF outputs on 214 pinned
inputs. The Wasm suite also covers selected strict prefixes, invalid flavor
errors, deterministic mutations and repeated free. The existing package gate
runs it automatically, with the same hard child/outer limits. Whole-corpus
paired drivers and the licensed input/grant cache are maintainer-only at this
development checkpoint; the public record contains hashes and scope rather
than clone-inaccessible filesystem pointers. No final speed claim is made.

### Batch 133 predictive traversal and redundant fan search

The native Cargo tests above include the 2,160-case predictive fixture and the
independent tetrahedron work regression. After the Wasm build, run
`node packages/decoders/native/draco/tests/wasm-predictive.mjs`. It compares every
complete output in both Rust flavors, checks strict prefixes, mutates inputs and
repeats decode/free. The package's required native gate invokes it automatically.
The public fixture contains all expected bytes and needs no opaque runtime to
rerun. Maintainer-only probe/profile/paired inputs are hash-pinned in
[the continuation evidence](results/batch-133-resume8.json), with the exact
seven-round paired method and open loss scope. No quiet speed result is claimed.

## Batch 133 optional entry integration

Build with `npm run build --workspace @margoengine/decoders` (Cargo and its
wasm32-unknown-unknown target required for source builds). Run
`node --test packages/decoders/tests/draco-native-entry.test.js` for the optional
bridge's frozen point records, normalized accessor, subset/output budget and
corrupt-input recovery checks. The regular decoder browser gate now also covers
its dedicated worker, concurrent jobs, transfer, abort, disposal and production
Vite-emitted worker/Wasm assets. Run it through the shared GPU lock with owner
codex-133. Neither default entry nor either prebuilt is replaced.

Batch 133 E21: build packages, then run node --test --test-timeout=60000
packages/decoders/tests/draco-native-entry.test.js. The metadata-strings fixture
contains 1,445 Margo-crafted streams and frozen full-oracle names. The receipt
results/batch-133-metadata-strings.json retains discovery/held input/output
hashes and complete22 failed streams. No timing or GPU is involved.

### Batch 273 stencil reference repair

Build outside the GPU lock with npm run build:packages. Run node --test
packages/webgl2-compat/test/*.test.js and packages/materials/test/*.test.js in
separate bounded commands. The new device.test.js regression fails before the
one-line effective-reference mask and passes after it. Run the full canonical
node scripts/material-render-state-gpu-check.js through node scripts/gpu-lock.mjs
run --owner=codex-batch273 --wait-max=60 --max=3 --, once normally and once with
MARGO_COMPAT=1. One shared slot per lane; outer bound 64 minutes includes queue.
The prior measured leaf cost is 84 seconds including queue; no build runs during
GPU reads. Retain both reports because the canonical output path is reused.
The expanded grid retains every existing case and adds unsigned bit-31/MAX
comparison, replacement and change/reset at both sample counts. Research and
numeric translation rationale: ../clean-room.md, stencil reference repair.

### Batch 134 report25 allocation checkpoint

This is private-draft evidence, not a shipped replacement or final acceptance.
Use the lane's frozen report25 crate/adapter/artifact pins from
results/batch-134-allocation-checkpoint.json. The candidate source snapshot is
the lane-local report25-frozen snapshot; keep it and all failed evidence.
The published prebuilt remains in use until every format and gate passes.

Run the private Cargo release tests, including the thread-local live allocator
regression and raw-level layout boundaries. Build the same release Wasm, then
run Node with --experimental-strip-types --test --test-timeout=120000 on
the lane-local owned-zstd-report24.test.mjs and raw-level-report25.test.mjs.
The latter decodes every image of a2049layer array above the compressed-input
byte cap; it does not reduce the work to one image or raise that cap.

report25-memory.mjs runs all173 original old/new pairs in fresh child processes,
checks input pins and2289 output hashes and retains every image buffer. The
full-process peak RSS bar and Wasm high-water bar are both new<=old per pair,
zero tolerance. No forced GC, altered imports, discard, source normalization,
timing comparisons or repeat-until-pass measurement. Keep prior report24 misses
beside the new table; a later machine run does not erase them.
report25-bc-identity.mjs checks all1296 BC images against the saved report24 hashes;
original-source metrics/readers remain unchanged. The receipt includes all11
BC1 RGB/BC3 RGBA source-bar losses, payload diagnostics and7 zero-added-payload
source losses. Neither diagnostic changes a bar or proves an arbitrary-encoder
source-error lower bound.

Run whole-container-fuzz-report25-corpus.mjs for the unchanged51seeds and
report25-hostile.mjs for bounded actual-Wasm random-block/range/video probes.
Pin both the adapter and Wasm before any seed. These campaigns remain bounded,
with final missing-target/public-API fuzz acceptance still owed.
For ETC2/EAC, prepare normative samples with report25-prepare-etc-uploads.mjs
outside the GPU lock; report25-etc-webgl-uploads.mjs takes the real hardware
compressed-upload/render/integer-readback path only when the ETC extension is
exposed. Software is refused. A6000 D3D11 has no extension, so its exact red
render control is useful hardware-selection evidence and is not ETC proof.
The GPU leaf uses one shared slot, --wait-max=60, a bounded command maximum;
never wrap preparation, build, CPU tests or waits in that lock.
Timing, cold/warm/startup and paired A/B debt stay in the deferred speed phase.

Batch133 non-timed resources: freeze packages/decoders/dist/draco-native.wasm
under your own test-results folder and set MARGO_DRACO_ORACLE_ROOT to the
verified opaque copies outside the repository. Run node
scripts/acceptance/draco-resources.mjs draco-full <paired-inputs.json>
<own-output-prefix> <frozen.wasm>, then draco with a different prefix. The
maintainer corpus manifest is `<maintainer-cache>/batch-133/paired-inputs.json`; source
identities/licences are in results/batch-133-corpus-manifest.json. Each child
has a30-second hard deadline; wrap the whole command in a40-minute process-tree
deadline. --resume validates manifest/artifact identity and retained rows.
No timing metric, GC, minima or repeat-to-pass is performed. The final record
retains every RSS row and hashes the original raw campaign/harness.
Generate the historical generic inputs with node
scripts/acceptance/draco-generic-inputs.mjs <own-output.json>; --wide generates
the550 wide controls. Complete predictor3 repro streams are embedded in
results/batch-133-resources-inventory.json. Re-run the regression with node
--test --test-timeout=60000 tests/draco-resource-harness.test.js.

The resource command returns nonzero when RSS or linear-memory parity fails.
A completed --resume checkpoint rechecks that result without new samples.
Run dedicated package/README readers only after verify completes its build.

### Batch 273 round 9: independent native references

After building, run node --experimental-test-module-mocks --test
--test-timeout=60000 tests/compat-baselines.test.js. It executes all seven
canonical drivers through their real openBrowser setup under MARGO_COMPAT=1.
Removing their compat:false options makes all seven fail; restore them before
GPU validation. The same regression runs in verify and check:merge.

With MARGO_COMPAT=1, run the six changed webgl2-compat comparison leaves:
adapter-browser.mjs, compat-browser-check.mjs, features-browser.mjs,
compute-browser.mjs, routes-browser.mjs and xr-browser.mjs under
packages/webgl2-compat/test/. Run npm run test:gpu --workspace
@margoengine/terrain once with MARGO_COMPAT=1 and once without it. Every GPU
leaf takes one shared lock with --wait-max=60 and a bounded --max; no CPU
preparation holds the GPU. The native feature-level fixture is deliberately
not the WebGL2 layer. No test assertion or image bound changes.
Do not invoke the unrelated tracer compilation or teardown investigations.
[Receipt](results/batch-273-native-baselines.json).

## Batch 265 native React binding proof

After building packages, run node --experimental-test-module-mocks --test packages/react/tests/package-bindings.test.js
and npm run modern:test:react. For actual rendering, run node scripts/gpu-lock.mjs run --owner=codex-batch265 --max=4
--wait-max=60 -- node packages/react/scripts/test-bindings-browser.mjs, then the same command with --compat appended.
Reports and paired PNGs are written to test-results/react-bindings*.json and test-results/react-binding-*.png.
The source page is packages/react/tests/bindings-browser.html. Real-capture licence/source is in
packages/splats/test/fixtures/NOTICE.md. Run npm run check:readme-run -- --packages=react for all copy-paste examples.

### Batch 268 XR pointer checks

Build with npm run build:packages. Run the XR, selection and React package tests.
Run node scripts/gpu-lock.mjs run --owner=codex-batch268 --wait-max=60 --max=3 --
node packages/xr/tests/pointer.browser.mjs, then the same command with --compat
at the end. Each run emits test-results/batch268-pointer-<mode>.json. The browser
fixture loads Cesium's Khronos Box (CC BY 4.0) from the already-noticed exporter
fixture folder. It tests the real selection readback, not a simulated picker.
Run npm run check:readme-run -- --packages=xr,selection,react for runtime examples.

XR stereo compat validation uses packages/webgl2-compat/test/xr-browser.mjs,
which installs the real compatibility XR route and compares both eyes with
native output. scripts/modern-xr-tests.js is the native XRGPUBinding fixture;
forcing that fixture through compat without installXR correctly refuses setup.
React's scene-browser suite is run normally and with --compat; its fixture now
prepares the corresponding binding before its XR-only modes.

### Batch 273 round 9: texture array negotiation

Build webgl2-compat and run node --test --test-timeout=120000
packages/webgl2-compat/test/device.test.js. The array-layer regression fails on
the prior owner at adapter capacity 2048 (256 advertised). It tests physical
capacities 256/2048/4096, default and explicit requests, immutable state,
refusal and recovery. api:update records the constructor's optional descriptor.

Under MARGO_COMPAT=1 run the complete voxel test:gpu, test:gpu:slow-compile
and test:gpu:slow-mesh scripts, preserving both sample counts. Run the bevel
leaf natively too, plus the optional layer's render/pick/restore, feature,
compute, package-route and XR comparison leaves. GPU leaves use shared locks,
one per lane, --wait-max=60 and command-specific hard bounds. The whole voxel
suite includes GI and debris; no test is removed. The separate native-only
delay injection gap is not treated as compatibility slow-compiler evidence.
[Receipt](results/batch-273-array-layer-limits.json).

## Batch 265 job 2: Instances

Build packages, then run npm test --workspace=@margoengine/react. For real rendering run node scripts/gpu-lock.mjs run
--owner=codex-batch265 --wait-max=60 --max=2 -- node packages/react/scripts/test-instances-browser.mjs,
then append --compat for the WebGL2 compatibility device. Each leaf has a three-minute outer process-tree deadline.
Reports: test-results/react-instances.json and react-instances-compat.json. The page uses the unmodified Cesium
Box.glb standard fixture and its linked licence notice. README: npm run check:readme-run -- --packages=react,margoengine.

### Batch 197 camera transitions

Run `npm test --workspace packages/controls` for transition maths/lifecycle and
existing controls. Then run
`node scripts/gpu-lock.mjs run --owner=codex-batch197 --max=3 --wait-max=60 -- npm run test:browser --workspace packages/controls`.
The controls-browser.json report contains eight transition rows: four controls
times WebGPU/WebGL2, fitted foreground pixels, completion and wheel cancellation,
and no GPU errors. These are generated correctness fixtures, not asset demos.
Run `npm run check:readme-run -- --packages=controls` for the copy-paste sample.
The build phase adds no benchmark or timing assertion.

### Batch 197 globe controls

Build controls, run `node --test --test-timeout=30000 packages/controls/tests/globe.test.js`,
then `node scripts/gpu-lock.mjs run --owner=codex-batch197 --max=2 --wait-max=60 -- node packages/controls/scripts/test-optional-browser.js globe`.
The browser script checks both real backends and writes
`packages/controls/test-results/globe-browser.json`. Run the controls README
examples through `npm run check:readme-run -- --packages=controls`. No speed
measurement, benchmark or exclusive GPU lease is required.

FSM payload proof: build fsm, then node --test --test-timeout=120000 packages/fsm/test/events.test.js. No GPU or timing measurement is involved.

FSM final/always proof: node --test --test-timeout=120000 packages/fsm/test/final.test.js after building packages. Includes delay split equivalence and cycle rejection without wall-clock assertions.
### Batch 239 job 1: tile property styling

Build packages, then run `node --test --test-timeout=120000 packages/tiles/tests/*.test.js`. Run `node scripts/gpu-lock.mjs run --owner=tiles-style --wait-max=60 --max=5 -- node packages/tiles/tests/tiles-browser.mjs`, then the same command with `--compat` on the browser script. The style case colours the first two features red and hides the other two based on the sample's structural metadata values. Input provenance is in examples/assets/3d-tiles/NOTICE.md. No benchmark or timing assertion is required.

FSM invocation proof: node --test --test-timeout=120000 packages/fsm/test/invoke.test.js after building packages. All races use explicitly resolved promises, with no time-based assertions.

### Batch 273 XR canvas regression

After build:packages, run node --test
packages/webgl2-compat/test/canvas-present.test.js. Under a shared GPU lock run
node scripts/modern-xr-tests.js, then the same command with --compat, and
node packages/webgl2-compat/test/xr-browser.mjs. Keep every stereo, package pass,
depth, AR alpha, controller and lifecycle assertion unchanged.
Batch 251 subtrees: build behavior and run
`node --test --test-timeout=120000 packages/behavior/tests/subtrees.test.js`.
All fixtures are generated locally; no renderer, GPU, external assets or timings.


Batch 252 job 1: build packages, then run `node --test --test-timeout=120000 packages/navmesh/test/queries.test.js`. The clean-room record cites the clipping paper, triangulation paper and rival query contracts. Fixtures are generated analytically in the test and require no GPU or external assets.

### Batch 171 climate and solver format correctness

After building loaders and sciviz, run `node --test --test-timeout=120000 packages/sciviz/tests/climate-formats.test.js
packages/loaders/tests/vtk-xml-dataset.test.js` (one shell line). Real-file hashes and all 200 measured values
are checked against the same NOAA input converted by public netCDF4 and VTK writer APIs. Recreate with
`python scripts/prepare-sciviz-formats.py`, after prepare-sciviz-data.py populates this worktree's cache.
`node scripts/gpu-lock.mjs run --owner=codex-batch171 --wait-max=60 --max=3 -- node packages/sciviz/tests/formats-browser.mjs`
checks six format variants on WebGPU and the WebGL2 compatibility backend. Its JSON stays in
`test-results/sciviz-fixes/formats-gpu.json`. No benchmark or timing-only assertion is run during the build phase.
Batch 251 inspector: after building behavior, run
`node --test --test-timeout=120000 packages/behavior/tests/inspect.test.js`.
The CPU DOM fixtures verify hierarchy, live updates and scheduling cleanup.
FSM view proof: build packages, run node --test --test-timeout=120000 packages/fsm/test/inspect.test.js, then node scripts/gpu-lock.mjs run --owner=fsm-inspect --max=2 --wait-max=60 -- node packages/fsm/test/inspect-browser.mjs; repeat the browser command with --compat. Screenshots go to test-results/batch250. The overlay itself uses DOM rendering and has no GPU math or backend-specific shaders.


### Save OPFS (batch 255 job 3)

After building packages, run node --test --test-timeout=120000 packages/save/tests/opfs.test.js. The existing save test:gpu command includes safe-check.mjs, which checks real OPFS close/abort and persistence across a page reload; run once normally and once with MARGO_COMPAT=1 using a shared GPU lock. The fixture consists of generated binary test values, not a public asset demo. No timing suite is needed for this storage feature.
### Batch 197 orbit collision

After build:packages, run node --test --test-timeout=30000 packages/controls/tests/collide.test.js, then node scripts/gpu-lock.mjs run --owner=codex-batch197 --max=2 --wait-max=60 -- node packages/controls/scripts/test-optional-browser.js collide. The browser report is packages/controls/test-results/collide-browser.json and covers both backends. No timing benchmark.


Batch 252 job 2: after building, run `node --test --test-timeout=120000 packages/navmesh/test/partial.test.js`. All fixtures are analytic CPU tests; Crowd walks through partial arrival and a subsequent surface revision.


### Batch 171 derived flow

Build sciviz; run node --test packages/sciviz/tests/derive.test.js. Its synthetic integer Jacobian
fixture was generated locally with NumPy default_rng(171), integers(-8,9,(3,3)) and eigvalsh(sym(J^2)),
24 matrices; no foreign source or data copied. CPU test stencils also have direct analytic oracles.
For actual GPU dispatch/readback and volume/isosurface integration on BOTH backends, run through one
shared slot: node scripts/gpu-lock.mjs run --owner=codex-batch171 --wait-max=60 --max=3 -- node
packages/sciviz/tests/derive-browser.mjs. Results: test-results/sciviz-fixes/derive-gpu.json.
Run demos-browser.mjs --only=derive through the same shared lock for both NOAA layouts/backends,
all diagnostic/day controls and PNG export. Original wind.json pins source URLs/hashes/licence;
wind.bin hash is e6ab31d5a3816b68f1c22e9c3563230bcb7e574aaaa90bb6513e34280ee93edd.
CPU/GPU bounds are absolute, scale-aware envelopes on a rounded input, not truncation-error estimates.
No benchmarks or timing-only assertions; build phase remains in effect.

Batch 171 derived-field source evidence: results/batch-171-derive-entries.json and results/batch-171-derive-network.json preserve the complete original 461e82a93 pair (both dirty=false), together with the retained source audit branch. Shared current benchmark records retain the other lanes' updates. This is historical byte/network evidence, not a new speed run.
### Sprite slices (batch 245 job 1)
After build:packages, run node --test --test-timeout=120000 packages/sprites/tests/slice.test.js.
Pixel proof: node scripts/gpu-lock.mjs run --owner=slice-proof --gpu="Slice pixel readback" --max=3 --wait-max=60 -- node packages/sprites/tests/slice-check.mjs.
Repeat that command with --compat appended to the leaf for WebGL2 compatibility.
Fixtures are generated RGBA gradients; nearest pixels are compared to independent
source-cell indices for fixed corners, repeat edges, flips and scrolled fills.


### Authenticated saves (batch 255 job 4)

Build packages, then run node --test --test-timeout=120000 packages/save/tests/signed.test.js. The save package test:gpu command also exercises signedStorage with native WebCrypto and IndexedDB across page reload in safe-check.mjs. Run that changed-package suite normally and with MARGO_COMPAT=1, each through the shared GPU lock. Its generated binary fixtures and deterministic test keys are tests, not production secrets or a public asset demo. No speed or timing-only assertion is used.
### Batch 197 BoxGizmo

After build:packages, run node --test --test-timeout=30000 packages/controls/tests/box-gizmo.test.js, then node scripts/gpu-lock.mjs run --owner=codex-batch197 --max=2 --wait-max=60 -- node packages/controls/scripts/test-optional-browser.js box-gizmo. Read packages/controls/test-results/box-gizmo-browser.json for both backend pixel and transform checks.

Batch 252 job 3: build, then `node --test --test-timeout=120000 packages/navmesh/test/sampling.test.js`. The fixed seeded samples test analytic surface areas, triangle centroids and E[r^2]=R^2/2 for a uniform disk. The tiled test uses exact segment and corner distances before and after a rebuild. No GPU or downloaded model is needed.
Batch 251 fuzzy decisions: build behavior, then run
`node --test --test-timeout=120000 packages/behavior/tests/fuzzy.test.js`.
Fixtures use analytical membership values and output moments, not timing budgets.
SCXML proof: build packages, then node --test --test-timeout=120000 packages/fsm/test/scxml.test.js. packages/fsm/test/inspect-browser.mjs additionally round-trips a delayed machine with the browser native DOMParser, in normal and --compat runs under the shared GPU lock. No timed assertions or performance measurements.

Batch 251 text trees: build behavior, then run
`node --test --test-timeout=120000 packages/behavior/tests/text.test.js`.
The generated round trips compare exact JSON fields and canonical printed text.

### 2D rigging (batch 245 job 2)
CPU proof: node --test --test-timeout=120000 packages/sprites/tests/rigging.test.js.
Rendered proof: node scripts/gpu-lock.mjs run --owner=rigging-proof --gpu="Skeletal attachment and IK pixel readback" --max=3 --wait-max=60 -- node packages/sprites/tests/rigging-check.mjs (append --compat for WebGL2).
No speed measurement is asserted. Rigging fixtures are synthetic overlapping atlas
regions and bone chains with known targets, not externally sourced demo data.


Batch 252 job 4: build with npm run build:packages, then run node --test --test-timeout=120000 packages/navmesh/test/wasm.test.js and cargo test --locked --manifest-path packages/navmesh/native/raster/Cargo.toml. Rebuild the kernel with node packages/navmesh/scripts/build-raster.mjs; its source/binary hashes must match before distribution. The work-count test bundles only Margo's own reference pipeline, compares its counters to the real worker, and compares checked encoded polygons byte for byte. No rival source or external model is used.
### Batch 197 presentation controls

After build:packages, run node --test --test-timeout=30000 packages/controls/tests/presentation.test.js and node scripts/gpu-lock.mjs run --owner=codex-batch197 --max=2 --wait-max=60 -- node packages/controls/scripts/test-optional-browser.js presentation. The report packages/controls/test-results/presentation-browser.json checks real WebGPU and WebGL2 product/scroll/path behavior. No wall-clock speed assertions.
Batch 251 trigger regions: build behavior, then run
`node --test --test-timeout=120000 packages/behavior/tests/triggers.test.js`.
The namespace collision regression was run red before tuple encoding and green
after it. All region and lifecycle fixtures are generated and need no GPU.
### Tween async (batch 215)

Run npm test --workspace @margoengine/tween. async.test.js uses deterministic caller-supplied deltas, never timing assertions. Measure the optional entry with scripts/measure-size.js bundleBytes over packages/tween/dist/async.js, gzipSync length, bare imports external. No speed measurement is claimed.

### Tween property sampling (batch 215 job 2)

Build packages and run node --test --test-timeout=120000 packages/tween/test/props.test.js. Samples use explicit deltas and analytic expected values, not wall-clock timing. Measure packages/tween/dist/props.js with bundleBytes and gzipSync from scripts/measure-size.js, leaving bare imports external.

### Mixed/nested timeline samples (batch 215 job 3)

Build packages; run node --test --test-timeout=120000 packages/tween/test/full-timeline.test.js. Entry bytes use bundleBytes on packages/tween/dist/full-timeline.js and gzipSync. Tests use analytic deltas and values without real-time assertions.

### Tween control reproduction (batch 215 job 4)

Build packages, then node --test --test-timeout=120000 packages/tween/test/control.test.js. All clocks are caller-driven. Measure packages/tween/dist/control.js with bundleBytes and gzipSync.

### Pin and snap fixture (batch 215 job 5)

Build packages; run node --test --test-timeout=120000 packages/tween/test/scroll-pin.test.js. Browser: node scripts/gpu-lock.mjs run --owner=codex-batch215 --max=4 --wait-max=60 -- node packages/tween/test/scroll-pin-browser.mjs, then add --compat for the second backend. The assertions check scroll/layout results, not a speed budget.

### Inertia correctness samples (batch 215 job 6)

Build packages; run node --test --test-timeout=120000 packages/tween/test/inertia.test.js. All time is explicitly supplied. Measure packages/tween/dist/inertia.js using bundleBytes and gzipSync, bare imports external. Tests include exact endpoint and two-sample velocity assertions plus analytic exponential samples.
Batch 253 vector input correctness: build packages/input, then node --test --test-timeout=30000 packages/input/test/vector.test.js. Fixtures cover real Input events, gamepad polls and InputRecorder/InputReplay; no model assets or GPU are involved.

## Batch 262 tweak panel

Run npm run test --workspace @margoengine/inspector, then after build:packages run
node scripts/gpu-lock.mjs run --owner=inspector-parity --max=3 --wait-max=60 -- node
packages/inspector/test/parity-browser.mjs (one command line). It drives native
controls and undo over real WebGPU and WebGL2 preview draws; repeat that command
with --compat appended for the WebGL2 compatibility layer. README coverage is tracked in docs/work-lists/readme-owed.md. Entry bytes use bundleBytes
from scripts/measure-size.js and gzipSync, with bare imports external.


Batch 252 job 5: after building, run node --test --test-timeout=120000 packages/navmesh/test/obstacles.test.js. The independent reference classifies all 64x64 cell centers using circle/inverse-rotation equations and builds ordinary box masks; encoded tile polygons must match exactly without tolerances.
Batch 253 XR binding correctness: build packages/input then node --test --test-timeout=30000 packages/input/test/xr.test.js. Structural session/frame fixtures inject source changes, select/squeeze taps, controller samples and joint poses, then replay the resulting ordinary Input recording without XR. Physical headset acceptance remains a hardware follow-up.


## Batch 262 viewport gizmo

Run npm run test --workspace @margoengine/inspector. After building, run node
scripts/gpu-lock.mjs run --owner=inspector-gizmo --max=2 --wait-max=60 -- node
packages/inspector/test/gizmo-browser.mjs as one command; repeat with --compat
appended. All three modes use real pointer drags, rendered colour checks and
exact local pose comparisons after undo/redo. Package test:browser:gizmo and
test:browser:gizmo:compat expose both routes to check:gpu-packages.

Batch 254 pan: build packages, run node --test --test-timeout=60000 packages/audio/tests/pan.test.js, then node scripts/gpu-lock.mjs run --owner=audio-pan --max=4 --wait-max=60 -- node packages/audio/scripts/test-browser.js. pan-browser.js compares PCM to W3C mono/stereo equations; test-results/audio-browser.json stores the browser report.

### Batch 197 device orientation

After build:packages, run node --test --test-timeout=30000 packages/controls/tests/device-orientation.test.js and node scripts/gpu-lock.mjs run --owner=codex-batch197 --max=2 --wait-max=60 -- node packages/controls/scripts/test-optional-browser.js device-orientation. Read packages/controls/test-results/device-orientation-browser.json for both backends' replay pixel and cleanup checks. Permission abort/timeout tests cover clock correctness, not a speed assertion.



### Batch 171 job 6: geographic atmosphere

Build sky and sciviz, then run node --test --test-timeout=120000 packages/sciviz/tests/atmosphere.test.js packages/sky/test/planet.test.js. Run node scripts/gpu-lock.mjs run --owner=codex-batch171 --wait-max=60 --max=4 -- node packages/sciviz/tests/atmosphere-browser.mjs for both GPU backends. It uses the official sciviz-atmosphere NOAA demo and writes test-results/sciviz-atmosphere/gpu.json. Existing sciviz GPU suites check unchanged flat/Cartesian paths. No speed suite, full verify or README example command is part of the lane gate.


### Batch 258 image correctness
After build:packages, run node --test --test-timeout=120000 packages/ui/tests/image.test.js. Under one shared GPU slot run node packages/ui/tests/image-browser.mjs, then the same command with --compat. Each mode also runs the preview GL page. The tracked Poly Haven JPG and its CC0 provenance are in examples/assets/source/skinning_ik/textures/polyhaven and examples/assets/skinning-ik-LICENSE.md. The tests assert actual nine-slice/cell/fit pixels, photograph decoding, tint and unchanged uploads. No timing comparison is performed.


Batch 252 job 6: after building, run node --test --test-timeout=120000 packages/navmesh/test/border.test.js packages/navmesh/test/wasm.test.js. A 32x32-cell floor with borderSize=3 must allocate 38x38 columns with empty outer padding, retain byte-identical walkable polygons and match the Rust worker. Tile tests inspect bounds and all interior cell centers, not timings.
Batch 253 pointer lock: build packages, run node --test --test-timeout=30000 packages/input/test/lock.test.js. Under a shared GPU lock, run node packages/input/test/input-browser.mjs and the same command with --compat. The browser fixture uses a click to acquire native lock, feeds vector/locked counts into a mesh transform and compares red-pixel centroids before movement, after movement and after release. It uses generated primitive geometry as a test fixture, no public demo asset.
Batch 255 scene-state: build packages, then run node --test packages/animator/test/playback-state.test.js packages/save/tests/scene-state.test.js. Run the save engine browser check through the shared GPU lock on native WebGPU and MARGO_COMPAT=1. Use the existing Knight.glb fixture (source/licence already in THIRD-PARTY-NOTICES.md). No benchmarks.


## Batch 262 scene editing

Run npm run test --workspace @margoengine/inspector. After build:packages, run
node scripts/gpu-lock.mjs run --owner=codex-batch262 --wait-max=60 --max=4 -- node
packages/inspector/test/edit-browser.mjs, then the same command with --compat appended.
The browser tests use real HTML tree dragging and form input, plus rendered native
point/spot/directional lights and preview ambient. All assertions are correctness
checks, never time budgets. README coverage is tracked in docs/work-lists/readme-owed.md.

Batch 254 binaural: after build:packages, node --test --test-timeout=60000 packages/audio/tests/binaural.test.js proves modal reconstruction and lifecycle. Shared-lock node packages/audio/scripts/test-browser.js runs binaural-browser.js, comparing 32 native HRTFs driven by the gain graph against independent polynomial speaker PCM. Test-results report records max error/energy, channels and rotation; tolerance 1e-6 is for float32 summation, not listening quality.
Batch 257 job 1: after npm run build:packages, run node --test --test-timeout=20000 packages/worker/tests/rpc.test.js; node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target esnext --module nodenext packages/worker/tests/rpc-types.ts; and node scripts/gpu-lock.mjs run --owner=codex-batch257 --max=4 --wait-max=60 -- node packages/worker/tests/browser-check.mjs. The browser check covers WebGPU and WebGL2 worker canvases and the browser RPC pool. Build phase defers only the existing timing budgets; correctness assertions remain enabled.
### Batch 239 job 3: terrain and imagery protocols

Build packages and run `node --test --test-timeout=120000 packages/tiles/tests/*.test.js`. Run packages/tiles/tests/tiles-browser.mjs under the shared GPU lock on WebGPU and with --compat. The imagery case checks ordered WMS/WMTS alpha composition and a Mercator terrain draw using the Apache-2.0 sample in examples/assets/terrain/NOTICE.md. The CPU tests append an extension-4 availability control to the real tile and prove unavailable children are never emitted/requested. No speed-phase benchmark is needed.

Batch 253 keyboard labels: build packages/input, then node --test --test-timeout=30000 packages/input/test/layout.test.js. For native browser integration, run the package input-browser.mjs GPU fixture and --compat variant under a shared lock; the prompt matches the native Keyboard Map when exposed/allowed and the standard code label otherwise. Layout mocks assert AZERTY and QWERTZ independently of the development machine's layout.
Batch 255 materials: after build:packages, run node --test packages/save/tests/materials.test.js packages/materials/test/serialization.test.js packages/shader/test/serialization.test.js. Through the shared GPU lock run node packages/save/tests/browser/materials-check.mjs, then the same with MARGO_COMPAT=1. Browser material fixtures are deterministic own texels/shader expressions; the separate scene-state proof uses the existing licensed Khronos Fox.glb. No timing suite.
### Batch 260 HTML preview texture
Build packages, then run `node scripts/gpu-lock.mjs run --owner=html-check --max=5 --wait-max=60 -- node packages/html/scripts/test-browser.js`, followed by the same command with `--compat` after test-browser.js. Reports: packages/html/test-results/html-browser.json and html-browser-compat.json. CPU: `node --test --test-timeout=120000 packages/html/test/*.test.js`. No benchmark or timing-only assertion.

### XR smooth movement and comfort

Build packages, run `node --test packages/xr/tests/locomotion.test.js packages/xr/tests/xr.test.js`, then run `node scripts/gpu-lock.mjs run --owner=lane-P-xr --wait-max=60 --max=3 -- node packages/xr/tests/locomotion.browser.mjs`. The stereo check uses the existing licensed Khronos/Cesium Box fixture and writes test-results/xr-locomotion-browser.json. It covers native/compat, engine/separate routes and both eye textures. Quest/Android evidence is still required separately.

Batch 267 job 1: after build:packages, run node --test --test-timeout=90000 packages/mcp/tests/live.test.js; GPU proof: node scripts/gpu-lock.mjs run --owner=live-proof --max=4 --wait-max=60 -- node packages/mcp/tests/live-browser.mjs. Both backends list the scene, hide its mesh through inspector setters, assert the PNG changes, read a diagnostic and receive native MCP image content.

Batch 257 job 2: build packages, then node --test --test-timeout=20000 packages/worker/tests/auto.test.js and node scripts/gpu-lock.mjs run --owner=codex-batch257 --max=4 --wait-max=60 -- node packages/worker/tests/browser-check.mjs. The browser test renders the same scene URL through worker, page and a capability-denied fallback for each backend; it checks transfer ownership, original canvas identity, pixels and disposal.


Batch 254 voices: after build:packages run node --test --test-timeout=60000 packages/audio/tests/voice-manager.test.js. Shared-lock node packages/audio/scripts/test-browser.js runs voice-manager-browser.js and records cap=1, handoff times, virtual detune and PCM error in the voices report. The reference schedules native source segments without using manager code; the stimulus is the existing CC BY 4.0 rain fixture.

### Sprite hit testing (batch 245 job 3)
CPU: node --test --test-timeout=120000 packages/sprites/tests/pick.test.js.
GPU: node scripts/gpu-lock.mjs run --owner=pick-proof --max=3 --wait-max=60 -- node packages/sprites/tests/pick-check.mjs (append --compat for WebGL2).
The generated white atlas has asymmetric transparent texels so independent
texture flips affect the proof. Three overlapping tinted sprites use rotated
and reflected transforms, nonzero camera and zoom; every picked identity is
compared with the actual canvas pixel, with and without y sorting and a circle
mask. Unit tests cover fractional alpha and dimension-only box picking as well.
### Batch 260 CSS3D blending
The existing HTML browser commands above also run blendScenario on WebGPU and native preview, and on the full layer with --compat. Inspect report measurements.blend for zero-alpha apertures and opaque foreground/off-panel pixels. CPU tests include blend.test.js. Preview setup uses fallback: canvas => webglRenderer(canvas, {transparent: true}); an already opaque preview is refused with a coded error.




## Batch 262 texture explorer

Run the inspector unit suite and build:packages. README work is tracked in
docs/work-lists/readme-owed.md.
Run node scripts/gpu-lock.mjs run --owner=codex-batch262 --wait-max=60 --max=4 --
node packages/inspector/test/textures-browser.mjs; repeat with --compat appended.
The source textures precede panel attachment and exact byte assertions check mip,
channel, aspect, integer range, array/depth slices, 1D, sRGB and MSAA. The CC0 real
image is the existing terrain fixture, not a downloaded engine implementation.
GPU format support follows requested device features; no timing assertion is used.

The backend aspect regression runs with node --test --test-timeout=120000
packages/webgl2-compat/test/device.test.js. Run the owning backend features-browser.mjs
and compat-browser-check.mjs under the shared GPU lock for sampling and renderer
coverage. No timing assertions or benchmark measurements are involved.

- Stats geometry: build packages, then `node --test packages/stats/test/geometry.test.js`. Hardware correctness on both backends: `node scripts/gpu-lock.mjs run --owner=stats-parity --wait-max=60 --max=3 --gpu=stats-native-render-counters -- node scripts/test-stats-parity.mjs`. The script renders two repository-owned boxes, checks submitted totals and frame reset, and releases the shared lock on exit. No timing benchmark.
Batch 253 trigger rumble: build packages/input, then node --test --test-timeout=30000 packages/input/test/haptics.test.js. Injected actuator fixtures assert exact native effect type/parameters/results, capability absence and denial, preemption, parameter checks, bounded abort/timeout, zero-stop fallback, overlapping-call ownership and reset failure. On a physical supported controller, check supportsTriggerRumble(nativeGamepad), then verify independent trigger and handle channels; hardware acceptance remains owed. Run the input package GPU fixture on WebGPU and --compat as its renderer integration check; it does not claim tactile proof.
### XR skinned hands

After build:packages run `node --test packages/xr/tests/hands.test.js` and the registered xr test:gpu:hands leaf through the shared GPU lock. The standard left/right GLBs and licence are in packages/xr/tests/fixtures/hands. The browser records pose-driven skin-buffer changes and stereo pixel changes for both XR routes and backends. Real Quest/Android runs remain required separately.

Batch 254 sprites: after build:packages run node --test --test-timeout=60000 packages/audio/tests/sprites.test.js. Shared-lock node packages/audio/scripts/test-browser.js runs sprites-browser.js, using native canPlayType and a controlled 503 response followed by tests/fixtures/rain-foa.wav (CC BY 4.0, existing NOTICE). The report records exact candidate order, PCM error and energy for one-shot and loop bounds.
Batch 257 job 3: build packages, run node --test --test-timeout=10000 packages/worker/tests/pointer-lock.test.js, then node scripts/gpu-lock.mjs run --owner=codex-batch257 --max=4 --wait-max=60 -- node packages/worker/tests/browser-check.mjs. The GPU check must observe both native page lock and worker controls lock state, a changed camera target after mouse movement, and a worker-requested native unlock.
Batch 249 job 1: build packages then node --test --test-timeout=120000 packages/ecs/test/objects.test.js. Synthetic identity/lifecycle fixtures, no asset downloads required.

- Stats WebGL2: `node --test packages/stats/test/gl.test.js`; then the shared-lock scripts/test-stats-parity.mjs command in the geometry proof above. The hardware proof requires EXT_disjoint_timer_query_webgl2, polls across requestAnimationFrame tasks, checks completed named intervals and frame accounting, and uses no timing threshold. Existing native Stats pass and browser suites remain applicable to the package.
### XR AR extras

After build:packages run `node --test packages/xr/tests/ar-extra.test.js`, then the registered xr test:gpu:ar-extra through the shared GPU lock. It injects native module stand-ins into Margo's stereo fixture, displays a detected mesh derived from the licensed Khronos/Cesium Box, verifies DOM selection suppression, image scores/observations and anchor save/restore/delete, and writes test-results/xr-ar-extra-browser.json. Native device tracking and storage proof remain job 1's hardware gap.



Batch 249 job 2: node --test --test-timeout=120000 packages/ecs/test/relation-query.test.js after building packages; original synthetic tuple/lifecycle fixtures.

Batch 225 job 1: npm run build --workspace @margoengine/splines, then node --test --test-timeout=120000 packages/splines/test/kinds.test.js. Mathematical references and combined design are in docs/clean-room.md. Pure CPU evaluation has no backend-specific GPU test.

### Batch 273 scatter shadow-culling observation

After build:packages, run node --test packages/scatter/test/shadow-cull-fixture.test.js.
Under a shared GPU lock run node packages/scatter/test/shadow-cull.browser.mjs,
then the same driver with MARGO_COMPAT=1. Do not forward a Firefox executable
override into these Chromium runs. All original assertions and scene work stay.
### Batch 260 foreignObject resources
The HTML browser commands above now also start a local CORS-only resource fixture server, serve the existing Noto Emoji donut and Source Sans 3 font with their recorded licences, and exercise an imported stylesheet. Inspect measurements.resources: matchedImagePixels = 1893, fontWidth = referenceWidth = 92. Both native and --compat invocations run it. CPU coverage is inline.test.js; the texture hook accepts prepare: resourceInliner() from @margoengine/html/inline. No README example or benchmark runs in this build-phase change.
## Batch 237 assembly
Build packages, then run node --test --test-timeout=60000 packages/wfc/test/assemble.test.js. GPU: node scripts/gpu-lock.mjs run --owner=codex-batch237 --max=5 --wait-max=60 -- node packages/wfc/test/assemble-browser.mjs. Run the existing wfc test:gpu suite as well. Both commands use authored test fixtures. No benchmarks in the build phase.
### XR performance controls

Build packages, run packages/xr/tests/performance.test.js and packages/webgl2-compat/test/xr.test.js with node --test, then run the registered xr test:gpu:performance and the existing compatibility test/xr-browser.mjs through the shared GPU lock. The performance leaf uses the existing stereo fixture and licensed Khronos/Cesium Box, writes test-results/xr-performance-browser.json, checks scale forwarding and foveation restoration, and reads known pixels from a browser-owned stand-in camera texture on the actual compatibility context. Real camera/headset proof remains separate.

Core version guard: build packages, then run `node --test --test-timeout=120000 packages/core/tests/version-guard.test.js tests/core-requirements.test.js`.
The packed test extracts the same npm tarball to two real installation paths and also supplies a
stale build requirement; it needs npm and tar, uses no network, and cleans its own worktree scratch.
Run `npm run measure:size` for the unchanged 25000 B core/stage limit.

- Stats panels: build packages; run `node --test packages/stats/test/panels.test.js packages/stats/test/panel-gpu.test.js packages/stats/test/scene-owner.test.js`. Run the shared-lock Stats parity script above on the native GPU. It requests timestamp-query, renders 48 frames per backend, checks four histories and named compute/post pass samples, and saves test-results/stats-panels-hardware.png for visual inspection. Durations are observations only; there are no speed thresholds.


## Batch 237 assembly
Build packages, then run node --test --test-timeout=60000 packages/wfc/test/assemble.test.js. GPU: node scripts/gpu-lock.mjs run --owner=codex-batch237 --max=5 --wait-max=60 -- node packages/wfc/test/assemble-browser.mjs. Run the existing wfc test:gpu suite as well. Both commands use authored test fixtures. No benchmarks in the build phase.






Batch 249 job 2: node --test --test-timeout=120000 packages/ecs/test/relation-query.test.js after building packages; original synthetic tuple/lifecycle fixtures.


## Batch 234 caustics acceptance

Build water, then run `packages/water/test/caustics.browser.mjs` and
`packages/water/test/caustics-energy.browser.mjs` using Node through the shared
GPU lock, with and without `--compat`. Details: [record](../water-caustics.md).

Also run `packages/water/test/caustics-project.browser.mjs` on each backend for
the independent receiver planes. `caustics-preview.browser.mjs` retains NOAA
NDBC station 46042's observation as wind input and renders enabled/disabled
and animated frames without importing Underwater. The black-box comparison
executes Evan Wallace's remote WebGL Water demo without reading source; see
the work record for its URL, what was observed and remaining acceptance.
Rebase onto browser-host repair 919fdc09e before the water gates. The original
flow gate now completes on both backends at its unchanged bound. Run the fast
gate and affected tests; full verify belongs to local CI and README work waits.
See results/batch234-caustics-landing.json for all outcomes and runner corrections.

Batch 257 job 4 branch-only reproduction: install browsers with node node_modules/playwright/cli.js install firefox webkit (optionally set PLAYWRIGHT_BROWSERS_PATH to a folder inside this worktree). Run node scripts/gpu-lock.mjs run --owner=codex-batch257 --max=4 --wait-max=60 -- node packages/worker/tests/browser-matrix.mjs --browser=firefox, then the same with --browser=webkit. Run the original strict suite with browser-check.mjs --browser=<name> to expose missing WebGPU/worker capabilities without weakening assertions. Windows WebKit receipts are supplementary; a native Safari run on Apple hardware remains owed.
- Batch 263 animation: build packages, run `node --test --test-timeout=30000 packages/inspector/test/animation.test.js`, then run `node packages/inspector/test/animation-browser.mjs` and the same command with `--compat` under a shared GPU lock. The real CC0 Fox test checks clip changes, weighted transforms, a populated skeleton path and disposed-model cleanup.

## Batch 237 tilesets
Run node --test --test-timeout=60000 packages/wfc/test/tileset.test.js after building packages. The wfc test:gpu script runs the existing solver browser suite and assemble-browser.mjs, which also parses XML, expands F symmetry and solves on both native WebGPU and WebGL2 compatibility routes. Use the shared GPU lock as for batch 237 assembly.

Batch 245 blending: after build:packages, run node --test packages/sprites/tests/blend.test.js. Under the shared GPU lock, run node packages/sprites/tests/blend-check.mjs, then the same command with --compat. The browser returns cases=146, maximumError<=1, validation=null and empty error arrays. Synthetic atlas texels are regression fixtures, not downloaded art or a demo.

SNORM storage repair: build packages, then run node packages/webgl2-compat/test/snorm-storage-browser.mjs and node packages/webgl2-compat/test/compute-browser.mjs in an owned GPU slot. The latter compares native WebGPU with compatibility under normal and strict CSP. Reproduce the original dependent failure with MARGO_COMPAT=1 node packages/shader/test/compute-texture-check.mjs. All numeric assertions and tolerances remain unchanged.

Size reproduction: on 2873b6acb and the repair, build packages and evaluate bundleSplit from scripts/measure-size.js on packages/webgl2-compat/dist/index.js with /^(runtime|readback)-/, then gzipSync its lazy and base byte arrays. The recorded parent-source substitution uses the same current package dependency graph for both emissions; no timing comparison is involved. See results/snorm-storage-sizes.json.

Batch 225 job 2: npm run build --workspace @margoengine/splines, then node --test --test-timeout=120000 packages/splines/test/query.test.js. CPU polynomial fixtures are independent of arc lookup resolution and rendering backend; references are in docs/clean-room.md.

Batch 249 job 3: build then node --test --test-timeout=120000 packages/ecs/test/reactive.test.js. Work counts assert no rescan with no timing assertion or GPU requirement.

### Batch 273 Firefox
After build:packages, supply the shipped Firefox executable through BROWSER_EXECUTABLE in the process environment; never commit the value. Run node packages/webgl2-compat/test/firefox-matrix.mjs for the eleven-driver sweep, which preserves failures and returns nonzero if any remain. Under a shared correctness GPU lock run node packages/webgl2-compat/test/firefox-compat-cases.mjs for the46 cross-browser cases. To isolate a changed cell, use --fixtures=compute.html?strict and retain the selected receipt alongside the original. Run firefox-matrix.mjs --leaf=corpus-draw-browser.mjs under a shared lock for all recorded corpus work. The corpus separately checks the intended over-limit negative pipeline; all legal pipelines must dispatch. Run node --test packages/webgl2-compat/test/firefox-bidi.test.js packages/webgl2-compat/test/corpus-validation.test.js tests/integration-json.test.js. Forced tiers never replace physical lower-tier evidence.
## Batch 237 3D overlapping
Build packages, then node --test --test-timeout=60000 packages/wfc/test/overlapping3d.test.js. Run the changed wfc package test:gpu through the shared GPU lock; assemble-browser.mjs checks all 64 pinned checkerboard values on native WebGPU and WebGL2 compatibility. Tests use authored numerical volumes and independent window extraction, not third-party implementations.


### Batch 258 forms correctness
After build:packages, run node --test --test-timeout=120000 packages/ui/tests/forms.test.js packages/ui/tests/mirror.test.js. Under a shared GPU slot run node packages/ui/tests/forms-browser.mjs, then the same command with --compat. The driver uses actual canvas pointer and keyboard actions, shared gamepad commands, native hex input and exact ARIA state checks after mirror reconciliation. No timing assertion or benchmark is included.
- Batch 263 WebGL2 inspector: build packages, run `node --test --test-timeout=30000 packages/inspector/test/gl.test.js`; under the shared GPU lock run `node packages/inspector/test/gl-browser.mjs` and the same command with `--compat`. The fixture uses CC0 BoxVertexColors geometry and checks all overlays, returned draw/shader state, pass costs and pixel restoration.

Batch 220 job 1: build packages, then node --test --test-timeout=120000 packages/math/test/*.test.js. methods.test.js imports math/compat and checks analytic independent results; math.test.js retains unchanged small-import assertions. CPU-only mathematics; this package defines no GPU test. Sources and API contract comparison are in docs/clean-room.md.
# Batch 204 exporter optimization

Accessor layouts: after building, run
`node --test --test-timeout=90000 packages/exporters/tests/sparse-entry.test.js`.
Every source/output accessor is compared exactly, with validator checks on the
real Box and sparse morph outputs; this is a correctness and byte-count proof.

Gaussian export: run `node --test --test-timeout=90000 packages/exporters/tests/splats-entry.test.js`
after building. It reads the licensed existing raccoon fixture and exercises
both formats, every SH degree, covariance reconstruction, metadata and limits.

Material extension evidence: after building, run
`node --test --test-timeout=90000 packages/exporters/tests/materials-entry.test.js`.
It reads the existing Khronos BoxTextured fixture and validates the written GLBs.

After building packages, run `node --test --test-timeout=90000 packages/exporters/tests/optimize-extra.test.js` for deterministic key, resource and instance counts, geometry from the existing Khronos Box fixture, and Khronos validator checks. The exporters browser suite runs through the shared GPU lock; `MARGO_COMPAT=1` selects its WebGL2 compatibility path. `packages/exporters/tests/capture-browser.mjs` accepts the same compatibility flag. No wall-clock benchmark is part of this evidence.

Batch 267 job 2: run node --test --test-timeout=90000 packages/mcp/tests/assets.test.js. Run node packages/mcp/tests/assets-prepare.mjs outside any GPU lock (downloads real CC0 metadata and data, stores licence manifests). Then node scripts/gpu-lock.mjs run --owner=assets-proof --max=5 --wait-max=60 -- node packages/mcp/tests/assets-browser.mjs. Fixtures cover Khronos Triangle, Poly Haven WoodenTable_02, venice_sunset HDRI and aerial_rocks_04 texture, plus the current ambientCG bricks result/zip. The saved fixtures.json records exact selected ids/variants and hashes; files are served locally for GPU checks.

## Batch 237 hex layouts
After building, run node --test --test-timeout=60000 packages/wfc/test/hex.test.js. Run wfc test:gpu through the shared lock for native WebGPU and WebGL2 compatibility evidence: assemble-browser.mjs solves a 6x6x2 periodic odd-r prism and checks each edge while retaining the assembly draw-count assertion. No benchmark required or run.

### Batch273 scenery capture
Run node --test packages/scenery/test/presented-frame.test.js and npm test --workspace @margoengine/scenery after build:packages. Under a shared correctness lock run node packages/scenery/test/scenery-check.mjs, then the same complete driver with MARGO_COMPAT=1. The scenes selector isolates displayed capture after changing its scheduling; keep all other existing assertions and both sample counts.

### Batch 239 job 5: property reads
After npm run build:packages, run node --test --test-timeout=120000 packages/tiles/tests/properties.test.js. The licensed CC0 samples and SHA-256 values are in examples/assets/3d-tiles/NOTICE.md. For rendered evidence run node scripts/gpu-lock.mjs run --owner=properties-proof --wait-max=60 --max=5 -- node packages/tiles/tests/tiles-browser.mjs, then the same command with --compat appended. The properties result contains point count/classification, green pixels, and exact texture rows: (13,9,40/255) and (20,13,50/255). These are correctness checks, not timing budgets.

Batch 225 job 3: npm run build --workspace @margoengine/splines, then node --test --test-timeout=120000 packages/splines/test/offset.test.js. Every approximation piece includes a source t range; tests compare dense points in that range to the exact offset evaluator, including points between fitter samples. Work counts are deterministic interval nodes, not timing assertions.

### Batch 221 BVH parallel and existing indirect behavior

After npm run build:packages, run node --test --test-timeout=120000 packages/bvh/tests/parallel.test.js packages/bvh/tests/index-order.test.js. The test adapter uses real Node worker threads, including a coordinator and nested leaf workers; it also disables SharedArrayBuffer inside workers to exercise cloning. For production browser assets and both graphics backends run node scripts/gpu-lock.mjs run --owner=bvh-parallel-repro --wait-max=60 --max=5 -- node packages/bvh/scripts/test-browser.js. The production consumer builds one mesh with three workers and compares all packed buffers to serial construction; the existing suite exercises WebGPU and WebGL2. No timing threshold or benchmark is required in the build phase. Reproduce initial entry/worker sizes with bundleBytes from scripts/measure-size.js and gzipSync from node:zlib for packages/bvh/dist/parallel.js, parallel.worker.js and parallel-leaf.worker.js. npm run measure:size measures the unchanged core plus stage budget.

Batch 249 job 4: build packages and run node --test --test-timeout=120000 packages/ecs/test/serialize.test.js. Synthetic identity, lifecycle, corruption and deterministic byte-count fixtures. Requires native CompressionStream/DecompressionStream, Uint8Array base64 and Web Crypto; no GPU or assets.

Batch 267 job 3: after build:packages, run node --test --test-timeout=90000 packages/mcp/tests/http*.test.js. The suites start OS-assigned loopback listeners and drives real HTTP requests with the same docs tools/resources/prompts, and image content. All network waits are bounded; idle expiry uses a controlled clock. This transport-only test needs no GPU slot.

Final batch 267 CI wiring: test:browser:live, test:browser:live:compat and test:browser:assets are discoverable package GPU leaves. assets-browser uses committed CC0 fixtures with exact hash tests, so it performs no downloads while holding a GPU slot. assets-prepare.mjs remains the separate CPU/network reproduction of full catalogue downloads.
Batch 208 job 1: build cache with npm run build --workspace=@margoengine/cache, run node --test --test-timeout=120000 packages/cache/test/stream.test.js, then node packages/cache/scripts/test-browser.js under a 300 s process-tree limit. Browser checks use real IndexedDB and the attributed SheenChair GLB; packages/cache/test-results/cache-browser.json records browser version, hashes and the prefix received before EOF. Cache checks do not render or compute on a GPU and do not occupy a GPU slot.
## Batch 172 job 1

Build packages, then run node --test --test-timeout=120000 packages/sciviz/tests/pipeline.test.js. Run node scripts/gpu-lock.mjs run --owner=sciviz-pipeline --wait-max=60 --max=3 -- node packages/sciviz/tests/pipeline-browser.mjs for the real NASA solution on both backends. Serve examples/sciviz-pipeline.html to change the cutoff and save the graph JSON. No benchmarks or README checks are required.

- Batch 263 tools: build packages; run `node --test --test-timeout=30000 packages/inspector/test/tools.test.js`. Under the shared GPU lock run `node packages/inspector/test/tools-browser.mjs` and the same command with `--compat`. Tests use the existing CC0 BoxVertexColors geometry, check camera state, real downloads, encoded image signatures, glTF scene contents and decoded video dimensions.
### Animation scene registration and terminal disposal

After `npm run build:packages`, run
`node --test --test-timeout=120000 packages/animation/tests/scene-owner.test.js packages/animation/tests/disposed-owner.test.js tests/animation-owner-contract.test.js`.
The same-name sentinel implements EnginePlugin.setup, so registration succeeds
before the identity assertions. The scene fixtures also suspend the first cache
read and dispose its originating scene, and count external abort listeners.
The dependent React browser working-directory regression runs without a GPU:
`node --test --test-timeout=30000 packages/react/tests/browser-working-directory.test.js`.

Batch 220 job 2: build packages and run node --test --test-timeout=120000 packages/math/test/*.test.js. curve.test.js imports the public optional entry, compares independent polynomial/table values and boundary derivatives, and checks editing, ownership, output reuse, channel sampling and invalid inputs. This is CPU mathematics and has no GPU test. Research and public-contract comparison are in docs/clean-room.md.

Batch 220 inspector repair: build inspector, run node --test --test-timeout=120000 packages/inspector/test/gl.test.js packages/webgl2-compat/test/isolation.test.js; run packages/inspector/test/gl-browser.mjs with and without --compat under a shared GPU lock. No isolation assertion is weakened.
Batch 230 tree meshing: build packages, then `node --test packages/procedural/test/tree-mesh.test.js`; render with `node scripts/gpu-lock.mjs run --owner=tree-mesh-proof --max=3 --wait-max=60 -- node packages/procedural/test/tree-mesh-browser.mjs`. Synthetic analytical and seeded fixtures, no timing assertions, no external model needed. Package GPU gate additionally retains all previous procedural backend checks.



### Batch 258 preview GL world panels
After build:packages run node --test --test-timeout=120000 packages/ui/tests/world-gl.test.js. Under a shared GPU slot run node packages/ui/tests/world-gl-browser.mjs, then the same command with --compat. Each invocation runs preview GL and the native WebGPU API path; the preview adds the foreign-state probe. The driver also sends real canvas clicks through the camera ray. Existing world tests stay unchanged. No benchmark is involved.
### Batch 226 graph
Build packages, then run node --test --test-timeout=120000 packages/scene/tests/graph.test.js. Rendering: node scripts/gpu-lock.mjs run --owner=scene-graph --max=4 --wait-max=60 -- node packages/scene/tests/graph-browser.mjs; repeat with --compat appended. Results go to test-results/batch226/graph-*.json. No benchmark or README execution.
Batch 208 job 2: npm run build:packages, node --test --test-timeout=120000 packages/cache/test/decoded.test.js and node packages/cache/scripts/test-browser.js under a 300 s process-tree deadline. test-results/cache-browser.json under the package records real source hashes, per-array digests, 24 Draco vertices, six KTX2 mip levels and two persistent hits across reload. The decoders transcode on CPU workers with an explicit rgba8 target, without GPU rendering or a GPU slot.

### Mesh-edit plane sections
Build with npm run build:packages, then run node --test --test-timeout=120000 packages/mesh-edit/tests/section.test.js. For GPU presentation use node scripts/gpu-lock.mjs run --owner=codex-batch224 --max=3 --wait-max=60 -- node packages/mesh-edit/scripts/test-browser.js; repeat with --compat on the browser script for the WebGL2 layer. The section fixtures are analytic synthetic solids, not imported demonstration assets. Assertions include cap closure and signed volume, annular section area 0.75, two disconnected regions, and rendered capped output. No benchmark is run.
### Batch 226 clone
After building packages: node --test --test-timeout=120000 packages/scene/tests/clone.test.js. Run node scripts/gpu-lock.mjs run --owner=scene-clone --max=4 --wait-max=60 -- node packages/scene/tests/graph-browser.mjs --clone, then the same command with --compat appended. Results: test-results/batch226/clone-*.json. No benchmark or README execution.

Batch 239 job 2: after build:packages, run node --test --test-timeout=120000 packages/tiles/tests/*.test.js packages/gltf-pro/tests/interpolated-directions.test.js, then run packages/tiles/tests/tiles-browser.mjs under the shared GPU lock, once normally and once with --compat. The feature case uses the pinned real CC0 metadata sample, checks restored pixels, smooth white highlight and exact transformed UINT32 shader IDs.
Batch 230 PBR: after build, `node --test packages/procedural/test/textures-pbr.test.js`; render/read back with `node scripts/gpu-lock.mjs run --owner=pbr-textures-proof --max=5 --wait-max=60 -- node packages/procedural/test/textures-pbr-browser.mjs`. This checks native WebGPU and a createCompatGPU WebGL2 device in the same run, 11 seeded motifs, every mip including NPOT edge footprints, explicit time and resource lifecycle. Inputs are synthetic mathematical controls, not real material scans; no timing budget is run.

### Batch273 bitmap orientation
After build:packages, run node --test packages/webgl2-compat/test/external-image.test.js packages/inspector/test/gl.test.js packages/webgl2-compat/test/isolation.test.js. Under a shared GPU lock run node scripts/normal-map-orientation-gpu-check.js, then repeat with MARGO_COMPAT=1, retaining the complete canonical case list. Counterfactual swaps only the owning upload source to the parent, builds them, runs the regressions, and restores/builds the repair in finally. It changes no baseline, numeric assertion or runtime setting. Existing tests/umbrella.test.js checks the regenerated alias.

Batch 249 job 5: build packages, then node --test --test-timeout=150000 packages/ecs/test/parallel.test.js packages/ecs/test/parallel-browser.test.js. Fixtures use original numeric worlds, no external assets. Node verifies real worker overlap without a timing assertion; the isolated browser runs the shipped worker with GPU disabled. No GPU lock is acquired for CPU work.
Final batch 249 size check: npm run measure:size reports current rebased main core plus stage at 24209 B; source in those packages is unchanged by this batch.
### Batch 199 hit details
After `npm run build:packages`, run `node scripts/gpu-lock.mjs run --owner=selection-details --wait-max=60 --max=4 -- node packages/selection/test/hit-details.browser.mjs`, then the same leaf with `--compat`. It loads the existing attributed Khronos Box fixture, tests raster depth against known planes, interpolated UV0, normal length/direction, world distance, mirrors/nonuniform scale and orthographic projection. The package browser script includes this leaf; CPU checks use `node --test --test-timeout=120000 packages/selection/test/*.test.js`.
Batch 208 job 3: npm run test:browser --workspace=@margoengine/cache under a 300 s process-tree deadline (build cache first when calling node packages/cache/scripts/test-browser.js directly). The proof report is packages/cache/test-results/cache-browser.json. Inspect prefetchWindow, throttleWindow, prefetchWorker, throttleWorker and serviceWorker for queue outcomes, hashes, timer debt and exact offline range results. The worker uses respondWith plus waitUntil(flush), then is unregistered and replaced for persistent-cache proof. No GPU work is submitted and no GPU slot is taken.
### UI curved panels (batch 259)
After `npm run build:packages`, run `node --test --test-timeout=60000 packages/ui/tests/curved.test.js packages/ui/tests/world.test.js` and `node scripts/gpu-lock.mjs run --owner=ui-curved --max=4 --wait-max=60 -- node packages/ui/tests/world-gl-browser.mjs`. The latter exercises flat, cylinder and sphere UI pixels and real pointer clicks on native WebGPU and preview WebGL2, including scene depth and sidedness. Data: public-domain NASA planetary names, https://nssdc.gsfc.nasa.gov/planetary/factsheet/ .

## Batch 210 job 1: action mixer
Build packages; run node --test --test-timeout=30000 packages/animation/tests/mixer.test.js tests/animation-owner-contract.test.js. Under the shared GPU lock run node packages/animation/tests/mixer-browser.mjs, then the same command with --compat. The driver checks every strip vertex against independent trigonometry at five times, and two live Fox actions; Fox is the existing licensed Khronos asset. No benchmark, timing assertion or README execution is involved.

### Batch 224 batch booleans
After npm run build:packages, run node --test --test-timeout=120000 packages/mesh-edit/tests/boolean-batch.test.js packages/mesh-edit/tests/boolean-exact.test.js. The 200-solid fixture checks space/materialization/tree-build counts, closure, provenance and analytic volume; no benchmark or timing assertion runs. The existing mesh-edit browser command (and --compat variant) additionally draws the final batch output. No downloaded demo is introduced.
### Batch 226 tags and lifecycle
Build packages, then node --test --test-timeout=120000 packages/scene/tests/tags.test.js. Run node scripts/gpu-lock.mjs run --owner=scene-tags --max=4 --wait-max=60 -- node packages/scene/tests/graph-browser.mjs --tags, then append --compat for real WebGL2 compatibility. Outputs: test-results/batch226/tags-*.json. Default and --clone variants retain earlier graph/clone rendering regressions. No benchmark or README execution.
### Batch 202 face metadata
Build loaders, then run `node --test --test-timeout=60000 packages/loaders/tests/face-properties.test.js`. The existing loader browser and render browser scripts run under the shared GPU lock in native and `--compat` modes. The face-group browser case passes PLY/OFF face colors to `createMeshes`; the existing 3MF color classification and render analytic reference cover rendering. No speed run is needed in the build phase.

- Batch 245 skeletal JSON: after npm run build:packages, run node --test --test-timeout=120000 packages/sprites/tests/spine.test.js, then node scripts/gpu-lock.mjs run --owner=skeletal-json --gpu=skeletal-json-pixel-readbacks -- node packages/sprites/tests/spine-check.mjs and repeat with --compat after the .mjs path. Fixtures/provenance: packages/sprites/tests/fixtures/trees and THIRD-PARTY-NOTICES.md. These are correctness checks, not timing measurements.

### Batch 199 pulse outlines
After a package build, run `node scripts/gpu-lock.mjs run --owner=selection-pulse --wait-max=60 --max=2 -- node packages/selection/test/pulse.browser.mjs`, then the same leaf with `--compat`. The test loads the existing attributed Khronos Box, compares peak/trough magenta energy, and requires hidden edges to add actual pixels over visible-only outlines, in JFA and morphological modes. CPU time/validation proof: packages/selection/test/pulse.test.js.


### Batch 265 frame priorities

After building packages, run `node --test --test-timeout=120000 packages/react/tests/frame-priority.test.js packages/xr/tests/xr.test.js`. Run `node scripts/gpu-lock.mjs run --owner=react-priority --wait-max=60 --max=4 -- node packages/react/scripts/test-priority-browser.mjs` and the same command with `--compat` appended. The fixture checks actual render-pass counts and exact manual/automatic output from the real Cesium Box. No timing assertion or benchmark is used.
### Batch 204 job 2: texture processing
Build packages, then run node --test --test-timeout=60000 packages/exporters/tests/textures.test.js. Under a shared GPU lock run node packages/exporters/scripts/test-browser.js, then repeat with --compat. textures-browser.js checks actual native WebP, decoded dimensions, PNG fallbacks, required-extension metadata, DOM toBlob and AVIF capability/error reporting. AVIF success-path extension wiring also has an explicitly labelled platform double in the CPU suite. Existing package PNG/capture checks remain in the package GPU gate. Results are in packages/exporters/test-results/exporters-browser.json. No timing or README execution. See docs/exporter-textures.md for sources and format/runtime limits.
### UI virtual keyboard (batch 259)
After building packages, run `node --test --test-timeout=60000 packages/ui/tests/keyboard.test.js` and `node scripts/gpu-lock.mjs run --owner=ui-keyboard --max=3 --wait-max=60 -- node packages/ui/tests/keyboard-browser.mjs`; repeat the latter with `--compat`. The browser edits the public-domain NASA planet name Mars (https://nssdc.gsfc.nasa.gov/planetary/factsheet/) with real pointer clicks and gamepad commands.





### Review 99 mesh builder checkpoint

From the repository root, run node packages/voxel-pathtracer/scripts/build-mesh.mjs
--test, then the same command without --test and npm test --workspace
@margoengine/voxel-pathtracer. Every command needs an outer hard tree limit
(5 minutes for Rust, 4 for the package). The independent exact-classification
case is in tests/mesh-build-regression.test.js. Run the registered mesh browser
suite under gpu-lock with --owner=review-99-mesh-build --wait-max=60 --max=6;
it retains all previous assertions and adds skipped-count/original-ID checks
on native and WebGL2/Vulkan. No benchmark or timing assertion is needed.

The review-99 checkpoint mesh suite and exact README example now pass on the
rebased checkpoint build. The additional composed native run uses --max=12 and
--backend=native; it fails at subset 31 readiness. Preserve that lease, all 32
subsets and the reflected/update cases when investigating. Per-pipeline markers
are already flushed by compose.html. The failed command has not been retried.

### Review 99 local normal and UV transport

Build the mesh Wasm and package, then run mesh-attributes.test.js with an outer
hard limit. The registered test:gpu:mesh-attributes runs both backends with
independent per-pixel barycentric-normal and UV sun/texture oracles, standalone
and composed, under one shared slot (--wait-max=60 --max=4). It never polls for
a visual match, changes a bound, or uses a timing assertion. The full existing
mesh suite must also run after these shader changes. Full composed native
validation remains blocked by the separate recorded timeout; it was not retried.

### Review 99 bounded composition diagnosis

Run `node --test packages/voxel-pathtracer/tests/compose-diagnostic.test.js` under
a one-minute process-tree deadline. Its clock is simulated; it tests timeouts,
not execution speed, and needs no GPU lock. The full browser command remains
`node packages/voxel-pathtracer/tests/compose-browser.mjs --backend=native`
under one shared slot with `--wait-max=60 --max=12`; compatibility uses
`--backend=compat`. It executes all 32 subsets and the reflected/update checks.
The host records `test-results/voxel-pathtracer-compose-native-all-diagnostic.json`
(or compat), and emits `compose-diagnostic` before terminating a stuck child tree.
The original timeout snapshot is preserved through cleanup. A 30-second cleanup
reserve is included in the same twelve-minute budget. Do not rerun a failed
native acceptance to green without a repair; retained phase and process evidence
is in results/review-99-compose-timeout-20261109.json. Neither timeout is waived.

### Review 99 shared mesh instances

Build packages, then run the voxel-pathtracer package units and
`npm run test:mesh-kernel --workspace=@margoengine/voxel-pathtracer`.
With MARGO_GPU_SLOTS=1, run
`node scripts/gpu-lock.mjs run --owner=review-99-instances --wait-max=60 --max=7 -- node packages/voxel-pathtracer/tests/mesh-instances-browser.mjs`.
The generated scene compares explicit instances against independently baked
geometry on native WebGPU and WebGL2/Vulkan with the original 1e-5 color/depth
bounds, exact ids and atomic-failure checks. The CPU test mutates every SIMD
comparison lane and scalar tail. Also retain the existing mesh, mesh-attributes
and composed compatibility GPU suites. Do not rerun the known native full-
composition failure or full-package README deadline to green; lane-U owns both.
No timing/benchmark command is needed for these correctness proofs.
Batch 172 contours: build packages, run node --test packages/sciviz/tests/contour.test.js; run node scripts/gpu-lock.mjs run --owner=codex-batch172 --max=6 --wait-max=60 -- node packages/sciviz/tests/contour-browser.mjs. Serve examples/sciviz-contour.html to switch CPU/GPU intersections and level multiplier on the original NASA quad slice. The browser report includes maximum coordinate difference, the computed bound, primitive counts and visible pixel counts for each backend. No timing benchmark is involved.


### Batch 265 adaptive performance

After build:packages, run node --test --test-timeout=120000 packages/react/tests/performance.test.js packages/react/tests/performance-react.test.js. Run node scripts/gpu-lock.mjs run --owner=react-performance --wait-max=60 --max=4 -- node packages/react/scripts/test-performance-browser.mjs, then the same command with --compat appended. The fixture injects fixed measured durations into the production controller to prove reduction and restoration independent of machine load. It does not benchmark elapsed execution. The default controller's monotonic clock and explicit sample input share the same arithmetic.
Batch 219 job 1: after building packages, run `node --test --test-timeout=120000 packages/geometry/tests/nurbs-edit.test.js`. Run geometry/tests/gpu-check.mjs through the shared GPU lock, once normally and once with --compat. The trimmed panel must render red with background visible at its central UV hole; existing geometry GPU readbacks remain in the same suite. No benchmark is needed for these correctness claims.


### Batch 224 mesh repair
Run npm run build:packages, then node --test --test-timeout=120000 packages/mesh-edit/tests/repair.test.js. The nine fixtures cover dirty soups through exact boolean consumption, hole defaults/limits, invalid/duplicate/non-manifold pieces, disconnected vertex fans, cavity nesting, non-chaining welds, concave polygons and nonorientable strips. The package browser runner and its --compat variant draw a repaired cube after one missing face and one winding reversal. Synthetic correctness fixtures introduce no asset licence or demo claim.
### Batch 202 legacy VTK
Run the built loaders' `vtk-legacy.test.js`, existing `vtk-xml*.test.js` and loader suite with Node's test timeout. `test-browser.js` also verifies mixed legacy cells and their cell data before rendering the extracted surface with createMeshes, on WebGPU and `--compat`. No external rival implementation is imported.
### Batch 199 exact area selection
Build packages, then run `node scripts/gpu-lock.mjs run --owner=selection-area --wait-max=60 --max=2 -- node packages/selection/test/area.browser.mjs` and repeat with `--compat`. It requires two actually visible mesh IDs, one lasso ID, no fully occluded mesh, zero hits in an adjacent one-pixel marquee and one submission/map for the whole canvas. The real glTF is the existing attributed Khronos Box. CPU validation is packages/selection/test/area.test.js; package point/model GPU suites also run after changing the region rendering hook.
## Batch 210 job 2: playback
Build packages, then run node --test --test-timeout=30000 packages/animation/tests/playback.test.js. Under the shared GPU lock run node packages/animation/tests/playback-browser.mjs, then repeat with --compat. The authored strip visits 0, 0.5, 1, 0.5, 0 and checks every deformed position component; the credited Fox is driven to exact forward and reverse endpoints. No timing assertions or README execution.



## Batch 207 job 1
Build packages, then node --test --test-timeout=120000 packages/blender/tests/objects.test.js. Regenerate the CC0 Blender oracle with C:/blender/blender.exe --background --factory-startup --python-exit-code 1 --python tools/blender-addon/tests/blender_objects.py -- test-results/blender-objects. Run node scripts/gpu-lock.mjs run --owner=objects --max=2 --wait-max=60 -- node packages/blender/tests/objects-browser.mjs, then the same command with --compat on the browser script. Each browser run renders and compares actual Animation.seek/model node matrices, checks validation and disposal. No timing measurement.


### Batch 209 tiled still correctness
After build:packages, run node --test --test-timeout=120000 packages/headless/tests/tiles.test.js. Run node scripts/gpu-lock.mjs run --owner=tiles-proof --gpu=tiles-render-and-readback --wait-max=1200 --max=240 -- node packages/headless/tests/tiles-gpu.mjs for exact single/tiled comparison, four samples and streamed output past the real texture limit. No benchmark or README runner is involved.
### UI localization (batch 259)
After building, run `node --test --test-timeout=60000 packages/ui/tests/i18n.test.js`; run `node scripts/gpu-lock.mjs run --owner=ui-i18n --max=3 --wait-max=60 -- node packages/ui/tests/i18n-browser.mjs` natively and with --compat. Data: Wikidata Q111 labels (CC0), https://www.wikidata.org/wiki/Q111 . Tests verify fallback, plural selection, parameter refresh, direction metadata, automatic relayout and aborted bindings.



### Batch 243 mesh PBR channels
Build packages, then run node --test --test-timeout=120000 packages/voxel-pathtracer/tests/mesh-pbr.test.js. GPU correctness uses node scripts/gpu-lock.mjs run --owner=codex-batch243 --wait-max=60 --max=5 -- node packages/voxel-pathtracer/tests/mesh-pbr-browser.mjs. The latter tests native and WebGL2/Vulkan, compares maps with independent equivalent scalar/vertex scenes and snapshots the existing licensed Khronos Box before disposing its loaded model. Results: test-results/voxel-pathtracer-mesh-pbr.json. README work remains deferred in docs/work-lists/readme-owed.md.
### Batch 233 job 1: road intersections
After building packages: node --test --test-timeout=120000 packages/road/test/intersections.test.js. Rendering: node scripts/gpu-lock.mjs run --owner=codex-batch233 --max=8 --wait-max=60 -- node packages/road/test/browser-check.mjs. Both backends check separate layer pixels, restoration and disposal. Analytic fixtures use independent equations, no timing assertions. See [road-design.md](../road-design.md).
Batch 219 job 2: after building packages run `node --test --test-timeout=120000 packages/geometry/tests/parity-extras.test.js`; geometry/tests/gpu-check.mjs through the shared GPU lock normally and with --compat covers all five uploads and a Goldberg picture. No timed performance comparison is claimed.

Batch 223 software occlusion: build packages, then hold a shared GPU slot for
`node packages/culling/test/gpu/webgl2-check.mjs`, and again with `--compat`.
The six fixed edits compare both canvases byte for byte and assert hidden-row
reduction, immediate reveal after moving a wall and disabling culling. Data is
Cesium Box (2017), CC BY 4.0, recorded in THIRD-PARTY-NOTICES.md. CPU contracts:
`node --test --test-timeout=120000 packages/culling/test/webgl2.test.js`.
No timing assertions or benchmarks run during the build phase.
### FBX texture bridge (batch 205)

After `npm run build:packages`, run `node --test --test-timeout=60000 packages/fbx/test/textures.test.js packages/decoders/tests/bmp.test.js`.
Each bridge test independently decodes the produced GLB's PNG and compares every RGBA byte.





### Batch 243 learned denoising
With Python and NumPy 2.5.4, run python packages/voxel-pathtracer/scripts/train-denoise.py --output=test-results/denoise-ml-training. The authored seeds, 800 steps, generated weights and validation metrics are recorded; no network access or foreign weights are used. Limit BLAS threads for a busy machine. Compare generated Float32 weights against tests/fixtures/denoise-ml-training.json's SHA-256. Build the package and run node --test packages/voxel-pathtracer/tests/denoise-ml.test.js.
Under a named shared GPU lease, run node packages/voxel-pathtracer/tests/denoise-ml-browser.mjs. Native rendering produces the independent 4-spp Box raw image and 512-spp reference; both native and WebGL2/Vulkan denoising use those same raw guide arrays. The fixture's licence/source is already recorded under gltf-pro/tests/fixtures/metadata. The script also compares actual GPU output to the same WGSL CPU evaluation, preserves HDR constants/coverage, and replaces the actual device. It writes test-results/voxel-pathtracer-denoise-ml.json and raw diagnostic inputs before assertions. No timing budget or assertion is relaxed.


### Batch 209 null stage correctness
After build:packages run node --test --test-timeout=120000 packages/headless/tests/null.test.js. No GPU slot is needed: the proof forbids GPU access and uses the real CPU transform kernel and animation samplers.
Batch 172 clipping: after build:packages, run node --test packages/sciviz/tests/clip.test.js; run node scripts/gpu-lock.mjs run --owner=codex-batch172 --max=4 --wait-max=60 -- node packages/sciviz/tests/clip-browser.mjs. Serve examples/sciviz-clip.html and change the calibrated CT lower threshold. Asset source.json pins the CT-ORG mirror revision, original downloaded gzip hash, NIfTI calibration, stride sampling, dimensions and derived sample hash. The NASA slice is shared with the contour demo. Deterministic tetra volume fractions and complementary cuts are CPU correctness checks; no timing is asserted.
Batch 206 PointInstancer: build packages, run node --test --test-timeout=120000 packages/usdz/tests/*.test.js. Regenerate oracle with OpenUSD 26.11 installed: python packages/usdz/tests/oracle/instancer-truth.py packages/usdz/tests/fixtures/instancer.usda packages/usdz/tests/fixtures/instancer-openusd.json. Run scripts/modern-usdz-tests.js through the shared GPU lock once normally and once with --compat; the CPU suite prepares usdz-textured.usdz first.

### Batch 199 glow and fill
After building packages, run `node scripts/gpu-lock.mjs run --owner=selection-highlight --wait-max=60 --max=2 -- node packages/selection/test/highlight.browser.mjs`, then repeat with `--compat`. The existing attributed Khronos Box provides the selected mesh. Checks require a magenta interior fill, unchanged centre for outer-only glow, no outside contribution for inner-only glow, exact finite radius support and byte-identical beauty output when fully occluded. Run highlight.test.js for no JFA dispatch, default-algorithm mask-only support, bind/view reuse, style failures and restore/disposal. The ordinary picking/model/xray package suite also runs after the Selection mask hook change.

### Batch 202 geospatial vectors
Build loaders and run `node --test --test-timeout=120000 packages/loaders/tests/geo.test.js`. Natural Earth is the already-noticed public-domain fixture; spec-derived binary writers independently construct Shapefile, dBASE and MVT records. Shared-lock loader browser tests run native and --compat, including a polygon with a hole and its feature group. Source-double comparisons use result.positions; result.mesh is the existing float32 render contract.
### Batch 233 job 2: lane paint
After package build run node --test --test-timeout=120000 packages/road/test/lanes.test.js; rendering uses the shared-lock road browser command above. The lanes fixture checks curved paint pixels and exact reboot/disposal on both backends. No benchmark or timing assertion.
### UI layout editor (batch 259)
Build packages and serve the repository through its Vite dev server; open `/examples/ui-editor/`. Run `node --test --test-timeout=60000 packages/ui/tests/editor.test.js` and `node scripts/gpu-lock.mjs run --owner=ui-editor --max=3 --wait-max=60 -- node packages/ui/tests/editor-browser.mjs`, repeated with --compat. The browser edits text/styles, rejects a broken draft, downloads JSON through the browser, opens it through the file input and checks responsive geometry. Demo facts: Wikidata Q111, CC0, https://www.wikidata.org/wiki/Q111 .

## Batch 210 job 3: categorical tracks
Build packages, then node --test --test-timeout=30000 packages/animation/tests/discrete.test.js packages/animation/tests/mixer.test.js packages/animation/tests/playback.test.js. Under a shared GPU lock run node packages/animation/tests/discrete-browser.mjs, then with --compat; also run mixer-browser.mjs on each backend because the mixer scheduler changed. The discrete driver uses the existing credited Khronos Fox, samples 0/0.49/0.5/0.99/1, checks real drawn/background pixels plus DOM text, and restores originals. Read discrete unit/lifetime before logs for regression failures. No benchmark or README execution.
Batch 239 job 4: build:packages, then node --test --test-timeout=120000 packages/tiles/tests/*.test.js packages/points/tests/*.test.js packages/splats/test/*.test.js. Run packages/tiles/tests/tiles-browser.mjs under a shared GPU lock, normally and with --compat; its fade case checks real-model replacement pixels, outgoing retention/eviction, exact half/zero point coverage, the real Gaussian cube and original-ID synthetic sorted masks. Owners also run packages/points/scripts/test-browser.js and packages/splats/test/gpu/check.mjs on both backends. No speed measurement is run during the build phase.





### Batch 243 mesh light sampling
Build the package with npm run build --workspace=@margoengine/voxel-pathtracer, then run node --test packages/voxel-pathtracer/tests/mesh-lights.test.js. The browser fixture is node packages/voxel-pathtracer/tests/mesh-lights-browser.mjs under the named shared GPU lock with a six-minute lease; it renders WebGPU and WebGL2/Vulkan, retaining errors, finite output and unchanged analytic bounds in test-results/voxel-pathtracer-mesh-lights.json. The area reference integrates the square using independent 160x160 midpoint quadrature; the emitter has zero reflecting albedo so the reference includes exactly its emitted direct transport. Spot and IES references use Lambert cosine, inverse square, cone and finite-range terms. Both package and dependent CPU tests remain required.

Batch 243 continuation: mesh-lights-browser.mjs now prints numbered create, ready-wait, image, complete and dispose phases while retaining all original assertions, samples and deadlines. The canonical two-backend receipt is batch243-mesh-lights-20261109.json. Historical timeout attribution remains open; a passing continuation is not proof of a specific repair.

## Batch 207 job 2
Build packages; run node --test --test-timeout=120000 packages/blender/tests/lightmap.test.js packages/lightmap/tests/imported.test.js. Regenerate fixtures in a separate factory-startup Blender process: C:/blender/blender.exe --background --factory-startup --python-exit-code 1 --python tools/blender-addon/tests/blender_lightmap.py -- test-results/blender-lightmap. GPU: node scripts/gpu-lock.mjs run --owner=lightmap --max=2 --wait-max=60 -- node packages/blender/tests/lightmap-browser.mjs; repeat with --compat on the browser script. The imported irradiance, default display and no-double-lighting checks are deterministic, with no timing assertions.
Batch 219 job 3: build packages and run `node --test --test-timeout=120000 packages/geometry/tests/teapot.test.js`. Run geometry/tests/gpu-check.mjs through the shared GPU lock normally and with --compat; the teapot case expects 9120 triangles at 12 segments, outward analytic normals and visible red pixels. The unchanged model fixture and its SHA-256/source/terms are recorded in THIRD-PARTY-NOTICES.md. No benchmark is used.



### Batch 246 job 1
After build:packages, run `node --test --test-timeout=60000 packages/tilemap/test/objects.test.js`. Run `node scripts/gpu-lock.mjs run --owner=tilemap-proof --gpu=ordered-map-pixel-readback --max=4 --wait-max=60 -- node packages/tilemap/test/objects-check.mjs`, then append `--compat` for WebGL2. Readback artifacts: test-results/tilemap-objects.json and tilemap-objects-compat.json. Diagnostic texels are generated by the tests.


### Batch 209 GIF correctness
After build:packages, run node --test --test-timeout=120000 packages/headless/tests/gif.test.js packages/exporters/tests/palette.test.js packages/exporters/tests/capture.test.js. Render/decode proof on both GPU paths: node scripts/gpu-lock.mjs run --owner=gif-proof --gpu=rendered-gif-native-and-full-compat --wait-max=1200 --max=180 -- node packages/headless/tests/gif-gpu.mjs. The exporter capture-browser.mjs gate also passes natively and with --compat. It includes image transparency and the existing capture/codec checks. No README runner or benchmark used.

### Batch 224 mesh hull/Minkowski
After npm run build:packages run node --test --test-timeout=120000 packages/geometry/tests/hull-indices.test.js packages/geometry/tests/convex.test.js packages/mesh-edit/tests/hull.test.js. Analytic volumes (27,16,26,32.256 and disconnected volume16), large-offset source precision, cavity retention, zero plane triples for convex inputs, budget failure and cancellation are asserted independently. For rendering run the mesh-edit browser script natively and with --compat, plus packages/geometry/tests/gpu-check.mjs on each backend, under the shared GPU lock. Fixtures are synthetic correctness solids, not external demonstrations or measured speed scenes.


### Batch 265 texture hooks

Build packages, then run `node --experimental-test-module-mocks --test --test-timeout=120000 packages/react/tests/textures.test.js packages/materials/tests/shared-pass.test.js`. For pixel comparisons run `node scripts/gpu-lock.mjs run --owner=react-textures --wait-max=60 --max=6 -- node packages/react/scripts/test-textures-browser.mjs`, then the same command with `--compat` appended. The test compares unmodified native and React material output for each supported native shading class and named/default Scenes, plus image, KTX2 and video fixtures, with exact pixels.
Batch 206 shapes: node --test --test-timeout=120000 packages/usdz/tests/shapes.test.js after building. Regenerate: python packages/usdz/tests/oracle/shapes-truth.py packages/usdz/tests/fixtures/shapes.usda packages/usdz/tests/fixtures/shapes-openusd.json with OpenUSD 26.11. The USD browser suite renders all five types normally and with --compat through the shared GPU lock.
### Large FBX correctness (batch 205)

After building, run `node --test --test-timeout=240000 packages/fbx/test/large.test.js`.
The test generates its own independent standard-layout input. For GPU/worker proof run the
package test:gpu command, then with `--compat`, through the shared GPU lock. No speed suite runs.

### Batch 233 job 3: road import
After build: node --test --test-timeout=120000 packages/road/test/geojson.test.js, then the shared-lock road browser gate above. Real data source/license is packages/road/test/fixtures/osm-source.json. Both backends render a source road in local WGS84 metres, restore identical pixels and dispose it. No timing assertion.

Batch 172 probes: build packages, run node --test packages/sciviz/tests/probe.test.js; run node scripts/gpu-lock.mjs run --owner=codex-batch172 --max=5 --wait-max=60 -- node packages/sciviz/tests/probe-browser.mjs. Serve examples/sciviz-probe.html; hover either chart. The test reports four data-view pixel counts, 32768 MRI target points, 101 valid NASA profile samples and zero difference between profile and dataset resampling. CPU oracles include the warped trilinear cell with volume 1.25 and field integral 1/6, rather than a triangulation-derived expectation. No timing run.

Batch 223 box bounds: after building packages, hold a shared GPU slot for
`node packages/culling/test/gpu/bounds-extended-check.mjs` and repeat with
`--compat`. Each of the three routes compares all pixels across camera and wall
edits; native mesh/model Hi-Z also asserts reduction behind the wall. CPU layout
and transformed-corner checks: `node --test --test-timeout=120000
packages/culling/test/bounds-extended.test.js`. Cesium Box data and licence are
shared with job 1. No timing test or benchmark is needed for these claims.


## Batch 207 job 3
After build: node --test --test-timeout=120000 packages/blender/tests/meshopt.test.js. GPU: node scripts/gpu-lock.mjs run --owner=meshopt --max=3 --wait-max=60 -- node packages/blender/tests/meshopt-browser.mjs, then the same script with --compat. It compresses the own fixtures at runtime and compares every decoded RGBA pixel with the original static/animated load. The CPU suite compares every original binary section and manifest, validates unchanged triangle order and checks decoder corruption/size/abort rejection. No wall-clock assertions.

### Batch 246 job 2
After build:packages run `node --test --test-timeout=60000 packages/tilemap/test/tiled*.test.js packages/tilemap/test/autotile.test.js`. The job 1 objects-check.mjs command on both backends now also reads imported XML template and image-layer pixels. Documents and texels are deterministic in-test fixtures.
### Batch 211 job 1

Build packages; run node --test packages/animator/test/layers.test.js. GPU: node scripts/gpu-lock.mjs run --owner=codex-batch211 --wait-max=60 --max=4 -- npm.cmd run test:gpu --workspace @margoengine/animator; repeat with MARGO_COMPAT=1. Layers use the existing Khronos Fox CC0 file, and synthetic CPU poses supply exact independent numerical oracles.
### Batch 233 job 4: road structures
After build: node --test --test-timeout=120000 packages/road/test/structures.test.js; run the changed-package shared-lock road browser command above. Oblique fixtures check bridge decks/green piers and tunnel shell/green portal pixels on native WebGPU and WebGL2 compatibility, then exact reboot/disposal. CPU volume and clearance equations are independent oracles; no benchmark or timing assertion.

### Batch 261 GPU label layer
Build packages, then run node --test --test-timeout=120000 packages/labels/tests/*.test.js. Run node scripts/gpu-lock.mjs run --owner=labels-gpu --wait-max=60 --max=3 -- node packages/labels/scripts/test-browser.js. The labels-browser.json report contains three rendering paths, near/far pixel extents, 100,000 glyphs/one draw and coincident grid work counts. No timing assertions or benchmarks.

API-index aggregate regression (batch 206): node --test --test-timeout=60000 tests/api-report-scope.test.js checks that all table rows, including margoengine, agree with the committed package/entry/export totals. npm run api:check validates the full compiled declarations and every row. A summary merge omitting the umbrella reports 97 packages and fails the regression; canonical generation reports 98 for this tree. This is a records-consistency check, not a compatibility certification.



Scenery moon: build packages, then run
`node --test --test-timeout=120000 packages/scenery/test/moon.test.js` and
`node scripts/gpu-lock.mjs run --owner=moon-proof --max=4 --wait-max=60 -- node packages/scenery/test/moon-gpu.mjs`.
Repeat the GPU command with `--compat` after `moon-gpu.mjs` for full WebGL2.
The fixture checks 1x/4x MSAA, real map variation, synthetic north/east landmarks,
full/quarter/new phases, earthshine, deterministic frames and mesh occlusion.

### Batch 202 native 3MF
Build loaders and run the threemf-lattice and threemf-materials Node tests with --test-timeout=120000, followed by the affected package/dependent suite. `threemf-native-fixture.js` defines original XML data; the test verifies the committed lattice-slices.3mf browser ZIP against writeZip(nativeFixtureXML()). Shared-lock loader browser checks exercise the new entry, native resources and existing createMeshes fallback on native WebGPU and --compat. Material expectations use explicit standard color-transfer equations and unchanged tolerances. No speed measurement is claimed.

## Batch 213 job 2 MToon
Build packages, then run the rigging and gltf-pro CPU tests and their dependents. The new `packages/rigging/tests/mtoon-browser.mjs` runs each independent scene with its own 120-second hard limit and process-tree termination. Run it through the shared GPU lock, with and without `--compat`, alongside the existing rigging and gltf-pro GPU commands. It writes test-results/mtoon/oracle-*.json and avatar PNGs. Public reference observations use the exact CDN URL and controlled input values in results/batch213-mtoon-provenance.json; execute that reference only in external engine-bench and inspect documented material properties, never source. [Sources, assertions and limits](../rigging-mtoon.md). README work is deferred and local CI alone runs full verify.

Batch 213 existing extension driver compatibility command: set MARGO_COMPAT=1 in the command environment, then run node packages/gltf-pro/scripts/test-extensions-browser.js with no positional filter. Passing --compat as argv[2] selects zero names in that existing driver. The separate physical-material worst-case compatibility failure and unchanged parent shader inputs are recorded in results/batch213-physical-compat-existing-failure.json; it is not a MToon feature refusal or a speed result.

### Batch 211 job 2

After build: node --test packages/animator/test/blend-trees.test.js. Run the animator package GPU command through the shared lock on WebGPU and again with MARGO_COMPAT=1 for WebGL2 compatibility. Fox remains the existing Khronos CC0 model. Exact synthetic weight and pose oracles are CPU conformance tests, not demo content.


### Batch 246 job 3
After build:packages run `node --test --test-timeout=60000 packages/tilemap/test/plane.test.js`. Run `node scripts/gpu-lock.mjs run --owner=tilemap-plane-proof --gpu=perspective-depth-pixel-readback --max=1 --wait-max=60 -- node packages/tilemap/test/plane-check.mjs`, then append `--compat`. Artifacts: test-results/tilemap-plane.json and tilemap-plane-compat.json. All 4096 pixels per scene are compared exactly; source transforms keep projected boundaries off sample centres so the independent oracle does not depend on rasterizer edge tie-breaking.

### Batch 261 distance labels
After build: node --test --test-timeout=120000 packages/labels/tests/*.test.js. The changed DOM-layout path is rendered by node scripts/gpu-lock.mjs run --owner=labels-distance --wait-max=60 --max=3 -- node packages/labels/scripts/test-browser.js --dom-only. The optional GPU label shader is unchanged; job 1 retains its separate full GPU test page.

### Batch 238 progressive splats
After build:packages, run node --test --test-timeout=60000 packages/splats/test/progressive.test.js. Run packages/splats/test/gpu/check.mjs through gpu-lock with owner codex-batch238, --gpu=splats-render-readback, --max=8 and --wait-max=60, once normally and once with --compat. The GPU check loads the existing MIT raccoon splat fixture in two delayed pieces, draws while the source is suspended, and checks all 8,385 records are visible at completion. No benchmark required.

Compatibility upload regression: node --test --test-timeout=120000 packages/webgl2-compat/test/bitmap-straight.test.js packages/webgl2-compat/test/external-image.test.js, plus the unchanged exact WebP channel assertions in the two splats GPU runs above. No timing bar.
Batch 172 calculator correctness: build packages, then node --test --test-timeout=60000 packages/sciviz/tests/calc.test.js. With a shared GPU lock run node packages/sciviz/tests/calc-browser.mjs (native and compatibility in one command). Demo: /examples/sciviz-calc.html. All expression groups, transfers, centres, connectivity, elevation, quality and least-squares gradients use analytic cases and original NASA FUN3D data. No benchmark or timing assertion.


Batch 223 sorting: build packages, then hold a shared GPU slot for
`node packages/culling/test/gpu/sort-check.mjs` and again with `--compat`.
Direct readbacks verify all record fields, stable order, source ranges and
argument words; every route also compares sorted and original canvas pixels.
CPU contracts run in `packages/culling/test/sort.test.js`. No wall-clock A/B,
benchmark or timing-only assertion runs during the build phase.
### Batch 266 input helpers
After build:packages, run node --test --test-timeout=60000 packages/react/tests/controls-extra.test.js. For actual pixels run node scripts/gpu-lock.mjs run --owner=codex-batch266 --wait-max=60 --max=3 -- node packages/react/scripts/test-controls-extra-browser.mjs, then the same command with --compat appended to the inner script. The existing CC-BY-4.0 Cesium Box fixture exercises keyboard, native scroll, product drag, spring snap-back and unmount disposal.
Batch 205 job 3: build packages, then run `node --test --test-timeout=120000 packages/fbx/test/legacy.test.js`. Render with shared GPU admission: `node scripts/gpu-lock.mjs run --owner=fbx-legacy-proof --max=3 --wait-max=60 -- node packages/fbx/test/legacy-browser.mjs`, then the same with `--compat`. `npm run measure:size` reports the base/core+stage gzip; do not use build summary's particlesOnly field for that number. Standard data hashes/licences are in the real-fixture NOTICE.
### Batch 231 textured scatter

Build packages, then run node --test --test-timeout=120000 packages/scatter/test/textured.test.js. In a shared GPU slot run node packages/scatter/test/textured.browser.mjs, then the same command with --compat. The fixture uses the checked-in licensed Khronos DiffuseTransmissionPlant and compares the whole scene against separately loaded plant copies at 1x and 4x MSAA, plus normal, mask, shadow and reboot controls. GPU lock owner codex-batch231, no exclusive hold. No benchmark or timing assertion.

### Lines stroke correctness (batch 227 job 1)
Build packages, then run node --test --test-timeout=120000 packages/lines/tests/stroke.test.js. Under the shared GPU lock run node packages/lines/scripts/test-browser.js, then the same command with --compat. The stroke check verifies taper pixels, a cutoff inside an unequal-length path, zero/full visibility, visible/hidden picks, dashes with depth writing and restoration. Existing package checks still run in full. No external asset is required for these synthetic correctness fixtures.


### Batch 229 imagery
Build with npm run build:packages. Run node --test --test-timeout=120000 packages/terrain/test/imagery.test.js. Render with node scripts/gpu-lock.mjs run --owner=imagery-repro --wait-max=60 --max=4 -- node packages/terrain/test/imagery.browser.mjs; repeat with --compat appended to the browser command. The existing terrain GPU script covers the whole changed package. Reports are written to test-results/terrain-imagery.json. No full verify or README checks are lane gates.
### Batch 211 job 3

Build packages, then node --test packages/animator/test/transitions.test.js tests/modern-animator-graph.test.js. The animator GPU package suite runs through the shared GPU lock; run again with MARGO_COMPAT=1. The real Fox graph transitions to Run at normalized offset 0.25.

### Batch 261 label clustering
Build packages, then node --test --test-timeout=120000 packages/labels/tests/cluster.test.js. The normal labels CPU suite covers composition. Render node scripts/gpu-lock.mjs run --owner=labels-cluster --wait-max=60 --max=3 -- node packages/labels/scripts/test-browser.js --dom-only for real centroid/count/zoom checks. Generated numeric clouds are correctness controls; no geographic demo is introduced.

### Batch 266 scene portals
Build packages, then node --test --test-timeout=60000 packages/react/tests/portals.test.js. GPU: node scripts/gpu-lock.mjs run --owner=codex-batch266 --wait-max=60 --max=3 -- node packages/react/scripts/test-portals-browser.mjs ; repeat with --compat appended. Texture, isolated overlay and stacked overlays must match direct native rendering pixel for pixel, with no errors and complete disposal.

### Repeated line textures (batch 227 job 2)
After build: node --test --test-timeout=120000 packages/lines/tests/texture.test.js. Under the shared GPU lock run node packages/lines/scripts/test-browser.js and repeat with --compat. Build before starting the browser so served dist changes cannot trigger a reload. The textured check exercises unequal segment lengths, image transparency and picks, UV edits, progress, mip/device restoration, and promise image decoding. Authored red/transparent pixels and a generated 1x1 image are synthetic correctness fixtures, not third-party demo assets.
### Batch 231 surface placements

After building packages, run node --test --test-timeout=120000 packages/scatter/test/surface.test.js. In a shared GPU slot run node packages/scatter/test/surface.browser.mjs and repeat with --compat. The real-data fixture samples the checked-in standard Teapot and places the licensed Khronos plant through TexturedScatter, comparing it to independently decomposed root transforms. Test PNGs are saved under test-results/batch231-surface-*.png. No wall-clock assertion or benchmark.
Batch 172 glyph/warp correctness: build packages, then node --test --test-timeout=60000 packages/sciviz/tests/glyph.test.js packages/sciviz/tests/glyph-data.test.js. With a shared GPU lock run node packages/sciviz/tests/glyph-browser.mjs for native and compatibility. Interactive demo /examples/sciviz-glyph.html uses the original SEACAS displacement file, source/hash/licence in examples/assets/sciviz/glyph/source.json, and the existing NOAA wind.bin provenance. One draw per glyph source is a deterministic work count, not a speed measurement.

Batch 205 job 4: after build:packages run `node --test --test-timeout=90000 packages/fbx/test/surfaces.test.js`. Render the real Maya plane with `node scripts/gpu-lock.mjs run --owner=fbx-surfaces-proof --max=3 --wait-max=60 -- node packages/fbx/test/surfaces-browser.mjs`, then the same with `--compat`. Both page and parser-worker paths must show lit pixels without GPU validation errors. Standard model hashes and licences are in the real-fixture NOTICE. `npm run measure:size` after build:packages reports core+stage.
### Batch 206 curves
Build packages, then `node --test packages/usdz/tests/curves.test.js`. GPU: `node scripts/gpu-lock.mjs run --owner=batch206 --wait-max=60 --max=3 -- node scripts/modern-usdz-tests.js`, repeat with `--compat`. Lines own GPU checks: `node packages/lines/scripts/test-browser.js`, likewise with `--compat`, under the same shared lock. Inputs are original analytical fixtures; no licensed external demo asset was needed.
### Batch 211 job 4

Build packages, then node --test packages/animator/test/masks.test.js. Run the animator GPU suite through the shared GPU lock on WebGPU and with MARGO_COMPAT=1. The Fox fixture combines the completed layer graph, nested tree, transition offset and fractional mask. Synthetic CPU tracks are exact mathematical conformance inputs, not demo replacements.
### Batch 247 job 1
After build:packages, run node --test --test-timeout=90000 packages/lighting2d/tests/*.test.js. For actual GPU work use node scripts/gpu-lock.mjs run --owner=lighting2d-sdf --wait-max=60 --max=3 -- node packages/lighting2d/tests/browser-check.mjs, then the same command with --compat after the browser driver. The SDF checks are named SDF in test-results/lighting2d-browser.json. Generated tiny RGBA fixtures have independent distance and analytic opaque-rectangle oracles; no downloads or external art are required. Size measurement uses bundleBytes in scripts/measure-size.js with bare imports external; no benchmark runs during build phase.


### Batch 218 job 1

Build packages, then run `node --test --test-timeout=60000 packages/transitions/test/*.test.js`. Run `node scripts/gpu-lock.mjs run --owner=codex-batch218 --max=5 --wait-max=60 -- node packages/transitions/scripts/test-gpu.mjs`, then the same command with `--compat` after the test script. The full-live fixture checks eight modes over two sample counts with independently computed pixel expectations.
Batch 213 job 3: build packages, run packages/rigging/tests/vrm-constraints.test.js and packages/gltf-pro/tests/vrm-constraints-data.test.js with node --test --test-timeout=60000, then run packages/rigging/tests/vrm-constraints.browser.mjs under the shared GPU lock, once native and once with --compat. Both real avatars run each time. Numeric public-runtime inputs and outputs are in results/batch213-constraint-public-values.json; the independent reference ran only in external engine-bench. Research and API details are in ../rigging-vrm-constraints.md.
### Cluster LOD and imposter readback (batch 222)
After building packages, run `node --test --test-timeout=120000 packages/lod/test/clusters.test.js packages/mesh-edit/tests/simplify.test.js packages/webgl2-compat/test/task-polling.test.js`. Run `node packages/lod/test/clusters-check.mjs` and the same command with `--compat`, under the shared GPU lock. FlightHelmet source/licence: examples/assets/ATTRIBUTION.md. Run the unchanged full picking grid and atlas sweeps using `node packages/lod/test/imposter-check.mjs batch222 --compat`; its existing pixel assertions remain intact. These are correctness checks, with no speed assertion or wall-clock A/B.



Batch 216 physical lens: after build:packages, run node --test packages/cinematic/test/physical-lens.test.js; run node packages/cinematic/test/physical-lens-browser.mjs and the same with --compat under the shared GPU lock. It checks numerical FOV and rendered f/1 versus f/16 blur; the fixture disposes its engine. No external asset or benchmark required.



## Batch 207 job 4
Build packages, then node --test --test-timeout=120000 packages/blender/tests/nodes.test.js. Regenerate the own CC0 fixture/oracle: C:/blender/blender.exe --background --factory-startup --python-exit-code 1 --python tools/blender-addon/tests/blender_nodes.py -- packages/blender/tests/fixtures. The script exports with live_nodes=True and bake_size at its default (asserting no images created), bakes a separate Cycles emission oracle and rejects an unsupported reachable node by name. Run node scripts/gpu-lock.mjs run --owner=codex-batch207 --max=2 --wait-max=60 -- node packages/blender/tests/nodes-browser.mjs and repeat with --compat. No timing assertion or exclusive GPU hold.

### Batch 261 elbow routing
After build, run node --test --test-timeout=120000 packages/labels/tests/callouts-route.test.js for pure planar matching, independent exact reference predicates, box placement, removal and unchanged-frame caching. Run node scripts/gpu-lock.mjs run --owner=labels-routes --wait-max=60 --max=3 -- node packages/labels/scripts/test-browser.js --dom-only for actual SVG endpoint-to-label checks within 1 px on native WebGPU/WebGL2. Synthetic numeric fixtures are correctness controls, not an asset-backed demo.

### Immediate debug and arc correctness (batch 227 job 3)
After building, run node --test --test-timeout=120000 packages/lines/tests/debug.test.js. Under a shared GPU lock run node packages/lines/scripts/test-browser.js and then the same command with --compat. The debug check verifies one-frame pixels, zero-delta clearing, depthTest behavior, pick-safe queues, immediate/persistent arc apex pixels, persistent picking, multi-view retention and restoration. CPU checks include buffer reuse, style draw counts, queue overflow, tilted/vertical planar arcs, spherical radii, coincident directions and exact/near antipodes. Fixtures are authored synthetic correctness data, with no downloaded demo assets.

### Batch 238 formats
Build packages, then node --test --test-timeout=120000 packages/splats/test/formats.test.js. The KSplat fixture source and exact regeneration arguments are in packages/splats/test/fixtures/NOTICE.md; rivals run in their external benchmark folder only. GPU: use gpu-lock run --owner=codex-batch238 --gpu=splats-format-render --max=2 --wait-max=60 -- node packages/splats/test/gpu/formats-check.mjs, normally and with --compat. All four render inputs derive from the existing MIT raccoon capture. No timed suite.


### Batch 218 job 2

The transitions package GPU command documented for job 1 now also runs presets-browser.js: 27,648 gradient pixel comparisons cover eight treatments, four directions, three progress values and both sample counts per backend. CPU: node --test --test-timeout=60000 packages/transitions/test/*.test.js. No benchmarks or timing assertions are part of this evidence.

### Batch 229 vector overlays
Build with npm run build:packages. Run node --test --test-timeout=300000 packages/terrain/test/overlays.test.js and the terrain package CPU suite. Render with node scripts/gpu-lock.mjs run --owner=overlays-repro --wait-max=60 --max=4 -- node packages/terrain/test/overlays.browser.mjs; append --compat to repeat on the compatibility layer. test-results/terrain-overlays.json contains coverage probes, exact baseline/restored values, display references and bake work counts. The package test:gpu script includes both imagery and overlay regressions; run it separately on each backend in a shared slot. No wall-clock benchmark, full verify or README gate is used.
### Batch 247 job 2
Use the lighting2d CPU and shared-lock native/--compat browser commands listed for job 1. GI history checks appear as GI temporal, GI resetHistory, GI painted diffuse order and invalidation checks in test-results/lighting2d-browser.json. The test wraps only its own GPU allocations with COPY_SRC to observe cached intervals, then forces fresh computation for comparison. Painted-reflection oracles are independent analytic boundary segments of a generated seven-pixel U-shaped enclosure, not rival source or imported assets. Existing opaque-energy, wall and finite-order fixtures retain their bounds. No speed suite is run during the build phase.

Batch 216 orthographic: after build:packages, run node --test packages/cinematic/test/ortho.test.js; run node packages/cinematic/test/ortho-browser.mjs under the shared GPU lock, then with --compat. The diagnostic checks the subject at quarter-width/three-quarter-height before and after a depth move, interpolated world height 15 between 10 and 20, and a two-sphere group at height 5.625. No external data or timing run.
### Batch 266 effect helpers
After build:packages, run node --experimental-test-module-mocks --test --test-timeout=60000 packages/react/tests/effects-extra.test.js. GPU: node scripts/gpu-lock.mjs run --owner=codex-batch266 --wait-max=60 --max=3 -- node packages/react/scripts/test-effects-extra-browser.mjs, then repeat with --compat appended. All five native pixel oracles must be exact.

## Batch 212 job 1: stereo controls
Build mixer, then node --test --test-timeout=120000 packages/mixer/tests/stereo.test.js. Run node scripts/gpu-lock.mjs run --owner=codex-batch212 --wait-max=60 --max=3 -- node packages/mixer/scripts/test-browser.js. The report lists stereo checks for both backends.



### Batch 217 job 1: graph authoring

Build packages, then run node --test --test-timeout=120000 packages/cutscene/tests/curve-editor.test.js. For actual mouse/keyboard interactions run node scripts/gpu-lock.mjs run --owner=cutscene-curve --wait-max=60 --max=2 -- node packages/cutscene/tests/curve-browser.mjs. The cutscene package test:gpu also runs this suite; MARGO_COMPAT=1 selects the compatibility backend for rendering suites. No timing assertion or benchmark is used.

### Batch 200 light glTF scenes
After npm run build:packages, run npm test --workspace @margoengine/gltf. The two meshless tests in packages/gltf/test/scene-data.test.js fail with the old no-renderable guard and pass with sceneExtras opting into allowEmptyScene. They create JSON and a JSON-only GLB locally and verify every loader and rollback with a headless engine. For the existing texture path run node scripts/gpu-lock.mjs run --owner=codex-batch200 --max=4 --wait-max=60 -- node scripts/test-gltf-browser.mjs, then the same command with --compat. Both exercise actual GPU rendering. Size reproduction: import bundleBytes from scripts/measure-size.js, gzipSync each packages/gltf/dist/{index,scene-data,textured}.js bundle; npm run measure:size checks the combined core/stage limit. These are correctness and byte-count checks, not speed benchmarks.
Batch 248 job 1: build packages, then `node --test --test-timeout=240000 packages/text/tests/fit.test.js`; run `node scripts/gpu-lock.mjs run --owner=codex-batch248 --max=8 --wait-max=60 -- node packages/text/scripts/test-browser.js`, then the same with `--compat` after test-browser.js. Existing Source Sans 3 font data is SIL OFL 1.1 (packages/text/tests/fixtures/fonts/NOTICE.md). No benchmark or timing assertion.
### Batch 231 scatter Hi-Z
After build:packages, run `node packages/scatter/test/occlusion.browser.mjs` and the same with `--compat`, each in a shared GPU slot. It renders the licensed Utah Teapot geometry behind building/terrain occluders, compares exact pixels against disabled culling, reads colour/shadow indirect counts and exercises camera/projection changes, near-plane, odd sizes, restore and multiple views. CPU: `node --test packages/culling/test/depth.test.js packages/scatter/test/occlusion.test.js`. No timing assertion or benchmark.

Batch 244 camera rig: build packages, run `node --test --test-timeout=60000 packages/pixel/tests/follow.test.js`, then `node scripts/gpu-lock.mjs run --owner=pixel-follow --max=2 --wait-max=60 -- node packages/pixel/tests/follow-check.mjs` and the same command with `--compat` after the script path. Original analytic fixtures need no downloaded data.

## Imported weather (batch 236 job 1)
After build: `node --test --test-timeout=60000 packages/weather/tests/gltf.test.js`. GPU: `node scripts/gpu-lock.mjs run --owner=weather-proof --wait-max=60 --max=2 -- node packages/weather/tests/parity-browser.mjs gltf`, then the same with `--compat`. Fixture is original procedural test geometry, not an imported third-party demo. The gate requires wetness, puddles, animated rings and snow to change pixels; zero weather and disposal must match the baseline exactly.
## Batch 212 job 2: live meters
Build packages, run node --test --test-timeout=120000 packages/mixer/tests/*.test.js packages/audio/tests/*.test.js. Run the existing shared GPU-locked mixer/scripts/test-browser.js on both backends; its live-analysis check includes FFT, waveform, audio-clock reports and exact output samples.
### Batch 274 job 1 shape correctness
After npm run build:packages, run node --test --test-timeout=40000 packages/compute/tests/shape.test.js. Run node scripts/gpu-lock.mjs run --owner=shape-repro --wait-max=60 --max=3 -- node packages/compute/tests/shape-browser.mjs for the same 30 exact cases on native WebGPU and WebGL2 compatibility. Fixtures are explicit standard examples and independent logical-index references. No benchmark or timing-only assertions.

Compute landing-gate regressions: node --test --test-timeout=120000 tests/gpu-browser-registration.test.js tests/parallel-check.test.js packages/compute/tests/maths.test.js ; the full compute browser runner also runs with --compat and retains all precise-error, invalid-shader and supported workgroup-size assertions. Unsupported workgroup sizes must reject against the real device limit. Build output must remain stable for a browser run because optional CPU chunks load lazily.

### Batch 228 job 1
Build packages, then `node --test packages/points/tests/clip.test.js`. The existing Stanford scan fixture and independent scalar predicates prove profile/box membership. Run `node packages/points/scripts/test-browser.js` and the same command with `--compat`, through the shared GPU lock, for retained/excluded pixel and budget checks. No timing result is claimed.



### Batch 217 job 2: viewport keying

After build:packages, run node --test --test-timeout=120000 packages/cutscene/tests/viewport.test.js. Run node scripts/gpu-lock.mjs run --owner=cutscene-viewport --wait-max=60 --max=2 -- node packages/cutscene/tests/viewport-browser.mjs. Repeat with MARGO_COMPAT=1 for the WebGL2 compatibility layer. This proof picks a real mesh, drags all three gizmo modes, verifies authored transform keys, replaces at one time and disposes the tool.
### MSFT material LOD (batch 222 job 2)
After build:packages, run `node --test --test-timeout=120000 packages/lod/test/msft.test.js`. Under the shared GPU lock run `node packages/lod/test/msft-check.mjs`, then with `--compat`. FlightHelmet must switch six primitives from level 0 to 2, change red to blue, retain vertex buffers, prepare lower-level UV2 and restore material objects. Source/licence: examples/assets/ATTRIBUTION.md.
- Batch 213 VRMA: build packages, then `node --test --test-timeout=60000 packages/rigging/tests/vrma.test.js`. Under one shared GPU slot run `node packages/rigging/tests/vrma.browser.mjs`, then the same command with `--compat`. Outputs are in `test-results/vrma/`; both real avatars must change and restore exactly. No timing assertions.
Batch 248 job 2: `node --test --test-timeout=240000 packages/text/tests/selection.test.js`; existing text browser commands in job 1 cover real-font measurements on native and full compatibility backends. No timing proof required.

Batch 244 xBR-style modes: after building packages, run `node --test --test-timeout=60000 packages/pixel/tests/xbr.test.js`, then `node scripts/gpu-lock.mjs run --owner=pixel-scale --max=2 --wait-max=60 -- node packages/pixel/tests/scale-check.mjs` and repeat with `--compat`. The original diagonal, colored-block and half-alpha fixture is reused, with integer 3x/4x, noninteger, stretch and below-room cases. All output pixels are checked; smoothing may differ from other xBR variants.

### Batch 196 panorama

Build packages, run node --test packages/cameras/test/*.test.js, then under the shared GPU lock run node packages/cameras/test/panorama-browser.mjs and the same command with --compat. The analytic primary-colour scene verifies full-sphere orientation, unaligned output rows, PNG dimensions, exact HDR/sRGB, abort and camera/canvas preservation. Existing cameras/test/browser-check.mjs also runs on both backends. No benchmark is required during build phase.

### Batch 231 instance attributes
After build:packages run `node --test packages/scatter/test/attributes.test.js`, then in separate shared GPU runs `node packages/scatter/test/attributes.browser.mjs` and the same with `--compat`. The GPU matrix covers default colour, custom tint/translation, live edits, device restoration, multiple batches and 1x/4x MSAA against independent instances. Existing edges.browser.mjs covers the default fixed-instance renderer. No wall-clock assertion is used.
### Batch 206 PreviewSurface
Build packages, then node --test packages/usdz/tests/preview-surface.test.js packages/gltf-pro/tests/upload-image.test.js. Run scripts/modern-usdz-tests.js under the shared GPU lock, then --compat. The original generated PNG/USDZ fixture in packages/usdz/tests/preview-fixture.js checks 128/255 channel opacity, independent UV1, numeric storage interpolation, identical direct/worker renders and lifetime. gltf-pro texture checks run via scripts/gltf-texture-tests.js on both backends. No external demo asset.

Job 0 conflict-marker reproduction: `node --test --test-timeout=120000 tests/hygiene-conflict-markers.test.js`, then `npm run hygiene`. The regression builds a worktree-local Git fixture containing tracked markers, safe near-matches, binary and LFS content; removing the scanner or hygiene invocation makes it fail. No GPU is used.
Batch 248 job 3: `node --test --test-timeout=120000 packages/text/tests/msdf.test.js`; run the existing text browser suite under the shared GPU lock, once natively and once with --compat. The center of the RGB interpolation diagnostic must be white, while both exterior probes stay dark. No performance benchmark.
## Batch 212 job 3: modulation and colour
Build packages; node --test --test-timeout=120000 packages/mixer/tests/*.test.js packages/audio/tests/*.test.js tests/umbrella.test.js. Run the shared GPU-locked mixer/scripts/test-browser.js as in job 1. Its JSON-effects check renders every algorithm and all native oversampling choices on both backends.


### Batch 218 job 3

Use the transitions CPU and locked GPU commands recorded above. glsl-browser.js runs 23 original fixtures over three progress values on 16 by 16 gradients: 17664 pixel comparisons per backend against a separate native GLSL compiler. The same fixtures also compile and render via both frozen and live factory APIs. No downloaded shader library is part of this test or package.

Batch 244 composite look: build packages and run `node --test --test-timeout=60000 packages/pixel/tests/crt.test.js`; then `node scripts/gpu-lock.mjs run --owner=pixel-crt --max=2 --wait-max=60 -- node packages/pixel/tests/crt-check.mjs` and the same with `--compat`. All 23 cases compare readback to the float64 tube oracle plus an independently inverted SMPTE matrix and normalized chroma kernels in crt-signal-reference.js. The original 7x5 colored diagnostic includes a half-alpha sample; default/all-off exact-boundary sweeps remain enabled.



### Batch 238 streamed SOG
Build packages; node --test --test-timeout=120000 packages/splats/test/lod-sog.test.js. Fixtures derive from existing MIT raccoon.sog and Margo's own WebP encoder. GPU under shared lock: node scripts/gpu-lock.mjs run --owner=codex-batch238 --gpu=splats-lod-sog --max=3 --wait-max=60 -- node packages/splats/test/gpu/lod-sog-check.mjs, then with --compat. Full changed-package suite: packages/splats/test/gpu/check.mjs on both backends. No benchmarks.

### Batch 196 stereo

Build packages, run node --test packages/cameras/test/*.test.js, then under a shared GPU lock run node packages/cameras/test/stereo-browser.mjs and the same command with --compat. stereo-check.html is the analytic fixture. It checks all four layouts against separately rendered eye images at constant-colour interior pixels, including a CPU Dubois reference, both swaps, row/column phase, one plugin update, resize and device restoration.

Batch 248 job 4: `node --test --test-timeout=120000 packages/text/tests/curve.test.js`; run the text browser suite under the shared GPU lock on native and --compat. It compares flat and cylindrical pixel fields and checks a sinusoidal baseline with analytic tangent/normal frames. No elapsed-time assertion.
## Batch 212 job 4: extended dynamics
Build packages, run node --test --test-timeout=120000 packages/mixer/tests/dynamics.test.js; the normal changed-package/dependent CPU test scope also runs it. Use the existing shared GPU-locked mixer browser runner for both backends; its extended-dynamics check renders all three factories.
## Batch 173 transfer classification
After building packages: `node --test --test-timeout=120000 packages/sciviz/tests/transfer.test.js`. Render correctness: `node scripts/gpu-lock.mjs run --owner=transfer-review --wait-max=60 --max=7 -- node packages/sciviz/tests/transfer-browser.mjs`. It runs both GPU backends and writes test-results/batch173-transfer.json. Open examples/sciviz-transfer.html with dev:examples to inspect the 1D pre-integrated view and live value/gradient histogram/editor. The source record is examples/assets/sciviz/clip/source.json; all original attribution and hashes are reused. No speed benchmark is required or claimed.



### Batch 243 traced extension lobes
Build voxel-pathtracer and gltf-pro, run node --test packages/voxel-pathtracer/tests/mesh-pbr-lobes.test.js and npm test --workspace=@margoengine/gltf-pro. Under a named shared GPU lease, run node packages/voxel-pathtracer/tests/mesh-pbr-lobes-browser.mjs for both backend variants. It compares independently decoded extension factors, coat emission attenuation and a real Box glTF snapshot, writing test-results/voxel-pathtracer-mesh-pbr-lobes.json. Console create/ready/image phase records localize any readiness or render deadline failure. The thin-film random reference comparison remains packages/gltf-pro/tests/thin-film.test.js; its shader text is shared unchanged.

Batch 243 final regression: run cargo test --manifest-path packages/voxel-pathtracer/mesh-kernel/Cargo.toml, npm run build:mesh --workspace=@margoengine/voxel-pathtracer, then build:packages. CPU: mesh-pbr-lobes.test.js, mesh-lights.test.js and materials/tests/thin-film.test.js, plus changed/dependent package CPU suites. The final native/compatibility GPU leaves are mesh-browser.mjs, mesh-instances-browser.mjs, mesh-attributes-browser.mjs, mesh-pbr-browser.mjs, mesh-pbr-lobes-browser.mjs and mesh-lights-browser.mjs, each in packages/voxel-pathtracer/tests and admitted under a named shared GPU lease. No dependent GPU suite gates this push. To reproduce the unresolved extra cold-cache diagnostic, add --disable-gpu-shader-disk-cache to the compatibility Chromium launch arguments and retain the original image signal; do not alter canonical defaults or bounds. The receipt distinguishes canonical success from this defect.


## Lens drops (batch 236 job 3)
Build packages. CPU: node --test --test-timeout=60000 packages/weather/tests/lens.test.js. GPU: node scripts/gpu-lock.mjs run --owner=weather-lens-proof --wait-max=60 --max=2 -- node packages/weather/tests/parity-browser.mjs lens, then the same command with --compat. The original checkerboard scene is captured by PostStack; a probe reads the HDR result after LensDrops. Both the procedural field and image behavior are checked. No third-party fixture or benchmark is needed.
## Batch 212 job 5: time-domain pitch shift
Build packages, run node --test --test-timeout=120000 packages/mixer/tests/pitch.test.js; changed-package/dependent CPU scope includes all mixer/audio tests and umbrella tests. Run the existing shared GPU-locked mixer/scripts/test-browser.js. Its final check measures pitch ratio and constant duration, exact unison samples, linked stereo and changes at audio time 0.5 s on both backends.


### Voxel generation (batch 241 job 1)
After building packages, run `node --test --test-timeout=120000 packages/voxel-edit/tests/generate.test.js`; native font proof: `node packages/voxel-edit/tests/generate-browser-check.mjs`. Package GPU correctness uses `node scripts/gpu-lock.mjs run --owner=codex-batch241 --wait-max=60 --max=5 -- npm run test:gpu --workspace=@margoengine/voxel-edit`, then the same command with MARGO_COMPAT=1. No benchmark is required. No external fixture download.


### Batch 266 job 3: React component and offscreen proof

After build:packages, run node --test --test-timeout=30000 packages/react/tests/test-renderer.test.js packages/react/tests/offscreen.test.js. For rendering, run node scripts/gpu-lock.mjs run --owner=react-test-offscreen --wait-max=60 --max=3 -- node packages/react/scripts/test-test-offscreen-browser.mjs, and again with --compat on the browser script. The generated cube is a mathematical control; no imported demo asset. Both paths use margoLow=1, 128 by 128 backing pixels and the same camera/material. The fixture asserts exact pixels, scene/frame/click counts, all thread selection paths, React page state and cleanup, with bounded waits and no timing or speed assertion.

### Batch 214 chain correctness
After build:packages, run node --test --test-timeout=120000 packages/kinematics-constraints/tests/chain.test.js tests/modern-animator-fbik.test.js. Both CCD and FABRIK must find clear length-preserving N-link poses; independent per-link volume readings verify acceptance. The full-body tests place an obstacle at a solved elbow, solve again and check both links, then reject a late limb and compare all joints with the original frame. Existing GPU scripts for the changed animator and kinematics-constraints packages run under the shared GPU lock.

### Batch 238 modifiers
Build packages, then node --test --test-timeout=120000 packages/splats/test/modify.test.js. Shared GPU gate: node scripts/gpu-lock.mjs run --owner=codex-batch238 --gpu=splats --max=2 --wait-max=60 -- node packages/splats/test/gpu/check.mjs, normally and with --compat. The full suite includes modify-check.mjs and the earlier streamed-SOG checks. A focused diagnostic can run modify-check.mjs with the same shared lock. CPU tests for dependents run only after api:update, which can rebuild dependent dist trees; overlapping them produces transient missing chunks rather than a source defect. No benchmarks or paired timings.


### Batch 217 job 4: nested authoring

After build:packages, run node --test --test-timeout=120000 packages/cutscene/tests/nested-editor.test.js. Run node scripts/gpu-lock.mjs run --owner=cutscene-nested --wait-max=60 --max=2 -- node packages/cutscene/tests/nested-browser.mjs, and repeat with MARGO_COMPAT=1 for compatibility browser behavior. The package test:gpu includes this proof and existing render/editor suites. No benchmark, timing assertion, README check or example execution is required during build phase.

### Screen-space voxel selections (batch 241 job 2)
Build packages, then `node --test --test-timeout=120000 packages/voxel-edit/tests/select.test.js`. These independent grid/camera oracles are deterministic and need no external assets or GPU. Changed-package GPU suites run under the shared lock with MARGO_COMPAT=0 and 1; no dependent GPU suite or timing benchmark is part of this job.

Batch 248 job 5: run `node --test --test-timeout=240000 packages/text/tests/extrude*.test.js` after the package build. The committed oracle JSON is generated by `generate-variable-reference.py` and `generate-shaping-reference.py` in packages/text/tests using FontTools 4.68 and uharfbuzz installed outside the shipped package. No oracle dependency is needed to run the frozen tests. Font hashes, source URLs and OFL licences live beside the fixtures. The existing shared-lock text browser commands cover shaped CFF2 rendering on native and --compat. No speed suite or timing assertion.
### Batch 240 job 1

After npm run build:packages, run node --test --test-timeout=120000 packages/voxel/tests/models.test.js. For rendered proof, run node scripts/gpu-lock.mjs run --owner=codex-batch240 --max=3 --wait-max=60 -- node packages/voxel/tests/models-browser-check.mjs, then the same command with --compat after the script path. The original test geometry is a unit panel: compare red coverage before/after rotation, exact restoration after reload, zero coverage after removal/disposal, and empty GPU/page error arrays. Tests use mathematical fixtures and contain no third-party art or code.
- Batch 213 pose tracking: build packages, run `node --test --test-timeout=60000 packages/rigging/tests/pose-tracking.test.js`; under one shared GPU slot run `node packages/rigging/tests/pose-tracking.browser.mjs`, then with `--compat`. Both standard licensed VRM files must have 50 solved outputs, nonzero changed pixels, zero neutral/restoration difference and no GPU validation errors. Public comparison uses opaque Kalidokit 1.1.5 UMD at https://unpkg.com/kalidokit@1.1.5/dist/kalidokit.umd.js in external engine-bench; analytic inputs are `bodyPoints` and `handPoints`, curl offsets 0, 0.025 and 0.05. No speed tests.
### Batch 235 job 1: ripple correctness

Build packages, then run node --test --test-timeout=60000 packages/water/test/ripples.test.js. Run node scripts/gpu-lock.mjs run --owner=water-ripples --wait-max=60 --max=4 -- node packages/water/test/ripples.browser.mjs and repeat with --compat after the script path. Independent stencil and impulse errors must be below 1e-6; scroll overlap must be exact. Reports: test-results/water-ripples-webgpu.json and water-ripples-compat.json. NOAA source/licence: packages/water/test/data/README.md.
### Batch 222 job 3: imposter dissolve
After build:packages, run node --test packages/lod/test/imposter-fade.test.js and run node packages/lod/test/imposter-fade-check.mjs with the shared GPU lock, then the same command with --compat. The package test:gpu registers it. The pinned CC0 FlightHelmet geometry supplies the mesh and baked atlas. Both backends produced 2140 initial red pixels, quarter/late mesh-to-imposter counts 1613/537 red and 420/1272 green, and 1696 final green pixels. Reverse animation-to-mesh restores 2140 red pixels; null finishes at zero. Shared-image 2/7 fps playback produced 1801 green left pixels and 2002 blue right pixels, with no opposite color or validation error. These are image counts, not performance results. Existing LOD suites retain their own assertions and deadlines.


## Batch 198 job 1: configurable view cube
Build packages, then run node --test packages/viewcube/test/*.test.js. Run packages/viewcube/test/browser-check.mjs through scripts/gpu-lock.mjs with owner codex-batch198, shared mode, --max=3 and --wait-max=60; repeat with --compat for WebGL2. The browser verifies existing cube controls plus Z-up face/edge hit testing and a rendered exact pole. Measure entry gzip using bundleBytes from scripts/measure-size.js with bare peer imports external; core-stage uses npm run measure:size. No timing benchmark.

Batch 201 spec/gloss: after build:packages, run `node --test --test-timeout=120000 packages/gltf-pro/tests/spec-gloss.test.js`. Render with `node scripts/gpu-lock.mjs run --owner=spec-gloss --wait-max=60 --max=5 -- node packages/gltf-pro/scripts/test-spec-gloss-browser.mjs`, then the same command with `--compat` after the script. The fixture compares independently authored metal/rough endpoints and draws examples/assets/khronos-samples/SpecGlossVsMetalRough.glb. Reports: test-results/batch201-spec-gloss.json and batch201-spec-gloss-compat.json. The exact data source, hash and licensing are in THIRD-PARTY-NOTICES.md. `npm run measure:size` verifies the unchanged core/stage gate. No timed speed experiment is required.


- Batch 242 rooms: build packages, then node --test --test-timeout=30000 packages/voxel-net/tests/rooms.test.js. Uses real loopback WebSockets and authored flat-world fixtures; no GPU or downloaded demo asset.

### Batch 214 joint-limit correctness
After build:packages, run node --test --test-timeout=120000 packages/kinematics-constraints/tests/limits.test.js. Run node scripts/gpu-lock.mjs run --owner=codex-batch214 --max=3 --wait-max=60 -- node packages/kinematics-constraints/tests/limits-browser.mjs for rendered native/compat checks. Test quaternions are independently composed from axis rotations; box acceptance covers 300 deterministic poses and exact singular branches. No speed measurement.
### Batch 269 dome correctness
After build:packages, run `node --test --test-timeout=60000 packages/video/test/dome.test.js`. Render with `node scripts/gpu-lock.mjs run --owner=video-dome --gpu=dome-render-pixels --max=3 --wait-max=60 -- node packages/video/test/dome-check.mjs`, then the same command with `--compat` after the test filename. The independent colour-sector oracle checks 12 combinations, six view directions, stereo separation and black rear. The usual video package GPU suite includes this check. Texture-existing proof: `node --test --test-timeout=60000 packages/materials/test/materials.test.js packages/materials/test/material-usage.test.js`. No benchmark or external download is needed for these analytic tests.

## Batch 173 label and multi-component fusion
After `npm run build:packages`, run `node --test --test-timeout=120000 packages/sciviz/tests/labels.test.js`. For rendered references run `node scripts/gpu-lock.mjs run --owner=labels-repro --wait-max=60 --max=5 -- node packages/sciviz/tests/labels-browser.mjs`. The one shared slot is released after the command; it exercises native WebGPU and WebGL2 compatibility sequentially. Report: test-results/batch173-labels.json. Screenshots: batch173-labels-native.png and batch173-labels-compat.png. The constant reference has seven voxel intervals, two alpha=0.06 components, opacity 1-(1-0.06)^14 and equal red/blue optical weights. The rotated ramp uses a 90-degree unit-box affine and is compared pixelwise against the equivalent aligned y ramp. No wall-clock benchmark runs.
View examples/sciviz-labels.html through the example server. The MSD archive source, original hashes and reduction are in examples/assets/sciviz/msd-brain.json. To reproduce the bytes, supply the original BRATS_457.nii.gz, label-BRATS_457.nii.gz and Task01 dataset.json to `node scripts/prepare-sciviz-labels.mjs <directory>`; it validates pinned original hashes, uses Margo's NIfTI reader and retains original samples at strides 4,4,4. Dataset category IDs and intensity values are unchanged. OpenNeuro uses the existing head.nrrd/head.json, CC0. No foreign implementation files or engines are needed.


## Batch 203 JPEG (2026-11-10)

After npm run build:packages, run node --test --test-timeout=120000 packages/decoders/tests/jpeg.test.js packages/decoders/tests/image.test.js packages/exporters/tests/jpeg-read.test.js. Fixtures and their independent reference PNGs are already in exporters/tests/fixtures/jpeg; source is recorded in its parent NOTICE.md. No benchmark or README execution is involved.

The additional worker/GPU round trip runs with node scripts/gpu-lock.mjs run --owner=codex-batch203 --wait-max=60 --max=2 -- node packages/decoders/tests/jpeg-browser.mjs. It checks the same 15,688 stored RGBA8 channels exactly on both WebGPU and WebGL2 compatibility.

### Batch 240 job 2

Build packages, then node --test --test-timeout=120000 packages/voxel/tests/objects.test.js. Run node scripts/gpu-lock.mjs run --owner=codex-batch240 --max=3 --wait-max=60 -- node packages/voxel/tests/objects-browser-check.mjs, and again with --compat after the script. Two visible red placements share one core draw; a third loaded object at x=10000 is culled. Edits lower coverage, unload removes it, reload restores it bit for bit and disposal leaves zero coverage.

- Batch 242 replay: build packages then node --test --test-timeout=30000 packages/voxel-net/tests/replay.test.js. Real loopback server, authored flat-world fixture, temporary recording file and exact reconstructed chunk snapshots. No GPU or external demo asset.
### Batch 206 value clips
After building packages, node --test packages/usdz/tests/clips.test.js runs the 78 scalar plus 4 topology OpenUSD oracles and ownership/discovery checks. Regenerate with Python 3.12 + usd-core 26.11: python packages/usdz/tests/oracle/clips-truth.py packages/usdz/tests/fixtures/clips. All authored layers are original analytical data. Run node scripts/modern-usdz-tests.js and then --compat under the shared GPU lock for direct/worker sampling and managed topology-changing cache playback.
Batch 270 job 1: build packages, run node --test --test-timeout=120000 packages/vfx/test/space.test.js, then under shared scripts/gpu-lock.mjs run packages/vfx/test/parity.mjs and the same with --compat (GPU classification reason: VFX particle simulation and readback). These compare buffer coordinates/velocities with analytic values. Existing VFX GPU suite also remains required.
### Batch 235 job 2: flow maps

After building packages, run node --test --test-timeout=60000 packages/water/test/flow-map.test.js. Run node scripts/gpu-lock.mjs run --owner=water-flow --wait-max=60 --max=4 -- node packages/water/test/flow-map.browser.mjs, then repeat with --compat after the script path. Vector/slope error must be below 2e-6; fixed-time screenshots must match and advancing time must change the image. Reports and PNGs: test-results/water-flow-webgpu and water-flow-compat. The real NOAA observation and licence are attributed in packages/water/test/data/README.md.



### Batch 194 job 2
See [toon parity](../toon-parity.md) for the CPU and shared-lock GPU commands, repeat GPU with MARGO_COMPAT=1. The screen-outline browser checks measure physical-pixel silhouette bands at two distances for perspective/orthographic core and materials meshes and draw the real animated Fox. Existing model and hatch suites remain in test:gpu.

# Batch 185 volume storage

After build:packages, run `node --test packages/shader/test/compute-volume.test.js`. Under a shared GPU lock, run `node packages/shader/test/compute-volume-check.mjs`, then the same command with `--compat`. Both compare all voxels for 16 storage formats in 3D and arrays, feedback steps and volume sampling; no benchmark or timing assertion runs. Job 1's pre-existing GLSL backend proof is `node packages/shader/test/browser-check.mjs --compat` under the same shared lock.


- Batch 242 WebRTC: after building, node --test --test-timeout=30000 packages/voxel-net/tests/webrtc.test.js and node packages/voxel-net/tests/webrtc-browser.mjs. The latter uses two real peers in a GPU-disabled browser, a 60-second suite limit and the existing bounded shutdown helper. No GPU lock or external asset.

Batch 270 job 2: build packages, node --test --test-timeout=120000 packages/vfx/test/over-life.test.js; under the shared GPU lock run node packages/vfx/test/parity.mjs --over-life and add --compat for WebGL2. The runner compares every sampled step with analytic speed, size and angle, including reset replay and local-frame rotation.

- Batch 193 hue: build packages, then node --test --test-timeout=120000 packages/tonemap/tests/hue.test.js; node scripts/gpu-lock.mjs run --owner=codex-batch193 --max=3 --wait-max=60 -- node packages/tonemap/tests/hue-browser.mjs. Both native WebGPU and forced full WebGL2 compatibility run in the browser suite.

Batch 271 job 2: build packages, then `node --test --test-timeout=30000 packages/creative/tests/planet-atmosphere.test.js`. Under a shared GPU lock run `node packages/creative/scripts/test-orbit-atmosphere.js` and the same command with `--compat` (3-minute hold limit, 60-minute queue limit). The original analytic fixtures need no third-party dataset. No benchmark, timing assertion or dependent GPU suite.
### Batch 269 demux correctness
Fetch required CC0 flower MP4 and WebM with `node scripts/reference-rendering/fetch-skip-assets.mjs`. `node --test --test-timeout=60000 packages/video/test/demux*.test.js` covers structural fixtures and every real packet. Regenerate the WebM oracle with `node packages/video/scripts/webm-reference.mjs <FFprobe-8.1.2-path>`. The original AVC oracle remains flower-ffprobe.json. Run `node scripts/gpu-lock.mjs run --owner=video-demux --gpu=demux-decoder-frame-proof --max=4 --wait-max=60 -- node packages/video/test/demux-check.mjs`, then add `--compat` after the test filename. The browser repacks original AVC packets into two ISO fragments, decodes each reference directly from FFprobe offsets, compares selected frame bytes and timestamps, and checks generated VP9/AV1 colours. No benchmark, fixed timing assertion, third-party code or new demo.



## Batch 203 standalone compression
After npm run build:packages run node --test --test-timeout=120000 packages/decoders/tests/streams.test.js packages/decoders/tests/zstd-destination.test.js. The checked-in LZ4 manifest and NOTICE record the native producer and CC0 source; tests reconstruct expected data from Avocado.bin. No native codec is needed to run them. Zstandard references use Node zlib. Existing decoder GPU tests continue to cover decoded texture upload on both backends.

## Batch 198 job 2: bounds fitting
After building packages, run node --test packages/viewcube/test/*.test.js. fit.test.js independently projects AABB corners through Camera.matrix throughout transitions. Run packages/viewcube/test/browser-check.mjs and the same with --compat, each under the shared GPU lock with owner codex-batch198, --max=3 and --wait-max=60. The added fixture switches to a FitViewCube, clicks an edge, toggles projection and clicks Top; both resulting rendered camera matrices must contain all bounds corners. No external data or benchmark.
Batch 270 job 3: build packages, run node --test --test-timeout=120000 packages/vfx/test/shapes.test.js, then under the shared GPU lock run node packages/vfx/test/parity.mjs --shapes, with --compat for WebGL2. Expected radial volume moments are 1/2 (shell 1), hemisphere mean normalized height 1/2, cylinder mean y squared over height squared 1/12, torus-shell mean cos(beta) tube/(2*radius), rectangle side shares proportional to length and all 24 test grid cells occupied near equally.

## Batch 185 pass authoring
After build:packages run node --test packages/shader/test/editor-pass.test.js. Under the shared GPU lock run node packages/shader/test/editor-pass-check.mjs, then the same command with --compat. Expected post centre pixels: [128,94,69], [255,188,137], [64,47,34], then restored full colour. Compute output is [i*scale,2*scale,4*scale,0.5] for i 0..23 and scales 0.5 and 0.25. Existing editor-check.mjs covers the shared canvas's gesture/keyboard path; run on both backends for presentation changes.
Batch 191 job 1: build packages, then node --test --test-timeout=120000 packages/post/test/selective-bloom.test.js. GPU: node scripts/gpu-lock.mjs run --owner=codex-batch191 --max=3 --wait-max=60 -- node packages/post/test/selective-bloom-browser.mjs (repeat with --compat). Original analytic fixtures need no external data.


- Batch 193 grade export: build packages; node --test --test-timeout=120000 packages/tonemap/tests/export-cube.test.js; node scripts/gpu-lock.mjs run --owner=codex-batch193 --max=2 --wait-max=60 -- node packages/tonemap/tests/export-cube-browser.mjs. Tests compare parsed exports with live Grade/HueGrade WGSL float targets on both backends; no screenshot quantization or timing assertion.

### Batch 194 job 3
Run node --test --test-timeout=60000 packages/toon/test/*.test.js packages/gltf-pro/tests/material-draw-run.test.js after build:packages. Run toon test:gpu through gpu-lock in shared mode, repeat with MARGO_COMPAT=1, as described in toon-parity.md. hatch-models.browser.mjs checks independent stripe/dot interior positions and restored real-avatar pixels. The owner-package fix also runs gltf-pro shader, extension, materials, viewer, volume and spec/gloss GPU suites on both backends; dependents receive CPU tests only. No speed-phase commands.


### Batch 173 cinematic volume lighting
Build packages, then run `node --test --test-timeout=120000 packages/sciviz/tests/cinematic.test.js` and `node scripts/gpu-lock.mjs run --owner=cinematic-proof --wait-max=60 --max=6 -- node packages/sciviz/tests/cinematic-browser.mjs`. The browser check runs native WebGPU and WebGL2 compatibility, emits test-results/batch173-cinematic.json and screenshots, and records exact work counts rather than timings. In the constant field sigma=-7*log(1-20/255), A=1-exp(-sigma), RGB=128/255. Plain radiance is RGB*A; the coaxial light's single-scattering radiance is RGB*(1-exp(-2*sigma))/2. Convert unpremultiplied radiance to sRGB then blend over black with A. The conservative white environment has expected intensity 255*A. The stochastic image checks a central 12x12 patch with a fixed seed and the same explicit classifier; RMSE must fall from 16 to 256 samples. Positive HG g reduces backscattering. Cost() reads counters for actual shader execution. No speed suite or README example runner is invoked.
To reproduce demo assets, download the EMD-8117 original from its source JSON, then `node scripts/prepare-sciviz-emdb.mjs <original.map.gz>`; the original hash is checked before extracting stride-3 mode-2 density samples. CT assets and provenance are reused without republishing the original dataset archive. Open examples/sciviz-cinematic.html for separate local-occlusion, shadow, plain and progressive modes.

The cinematic AO reference integrates sigma*exp(-sigma*t) times the six-direction average exp(-sigma*min(radius,boxExitDistance)), using exact homogeneous ray transmittance and 4096 axial quadrature points. Engine reboot is separately checked from lighting-only restore.

- Batch 242 runtimes: build packages, install Bun and Deno outside the repository or set MARGO_BUN_BIN and MARGO_DENO_BIN to their executables, then npm run test:runtimes --workspace @margoengine/voxel-net. One shared Node assertion body launches native fixtures with per-child 40-second hard limits. Deno uses run --allow-all --node-modules-dir=manual for the local workspace. Node-only unsupported-runtime behavior is server-runtimes.test.js. The native contract fails on Deno worker stderr before the worker close-capability adapter.


Batch 271 job 3: build packages, run `node --test --test-timeout=30000 packages/creative/tests/grass-terrain.test.js`; under the shared GPU lock run `node packages/creative/scripts/test-grass-terrain.js` and again with `--compat` (3-minute hold, 60-minute queue). Fixtures are original analytic maps, not a demo dataset. No dependent GPU run or timing suite.
### Batch 269 playback correctness
`node --test --test-timeout=60000 packages/video/test/playback.test.js` runs deterministic lifecycle tests (mock clock for ready timeout). With the required CC0 WebM asset fetched, run `node scripts/gpu-lock.mjs run --owner=video-playback --gpu=playback-video-render-and-policy --max=3 --wait-max=60 -- node packages/video/test/playback-check.mjs`, and repeat with `--compat` after the filename. A real video starts muted, reaches frame readiness and feeds base/emissive textures with repeat/mips, compared with a frozen VideoFrame through the same material. A second audible video is refused by the browser's native policy, exposes the owned button, and starts on a trusted Playwright click. This is browser-policy and rendering correctness, not a timing or universal autoplay claim.


## Batch 198 job 3: compass/menu reproduction
Build packages and run node --test packages/viewcube/test/*.test.js. The compass tests exercise actual delegated DOM input and lifecycle in JSDOM. Under the shared GPU lock, owner codex-batch198, --max=3 --wait-max=60, run packages/viewcube/test/browser-check.mjs then repeat with --compat. The new section clicks East/South, saves/returns Home through the context menu, toggles projection, clamps an edge menu and drags a cardinal with pointer capture. It writes one screenshot per backend for layout review. No new asset download or speed benchmark.
### Batch 235 job 3: planar reflection input

Build packages. CPU: node --test --test-timeout=120000 packages/water/test/reflector.test.js packages/environment/tests/mirror.test.js. GPU: node scripts/gpu-lock.mjs run --owner=water-reflector --wait-max=60 --max=4 -- node packages/water/test/reflector.browser.mjs, then repeat with --compat after the script path. The main-camera marker centre must be offscreen, its independently mirrored image gains red, unready capture pixels equal baseline and GPU validation stays clean. Reports/PNGs: test-results/water-reflector-webgpu and water-reflector-compat. The observational bearing is NOAA public-domain data attributed in water/test/data.
Batch 270 job 4: build packages, node --test --test-timeout=120000 packages/vfx/test/schedule.test.js, then under the shared GPU lock run node packages/vfx/test/parity.mjs --schedule, and add --compat for WebGL2. A 0.5-second warmup at 0.125-second steps plus a visible step must match five ordinary steps, including seeded bursts and the full particle buffer.

Batch 241 job 3: after npm run build:packages, run node --test packages/decoders/tests/lzfse.test.js packages/voxel-edit/tests/formats-extra.test.js. Committed codec fixtures were compressed through the prebuilt lzfse 0.4.2.post1 public API; original byte expectations and the entropy fixture SHA-256 are asserted without an oracle dependency. v1 and reused-table fixtures derive from the same original fse payload and were separately decoded through that black box. Format fixtures combine original asymmetric probes, standard Python plistlib/zipfile encodings and the CC0 DeathByDenim Arm (source in THIRD-PARTY-NOTICES.md). CUB oracle: vengi-voxconvert.exe --input <original 2x3x4 probe.cub> --output <probe.qef> --force, external tool directory, 30-second process-tree hard limit. Reference QEF sizes and colour positions are pinned in formats-extra.test.js. GPU correctness: only decoders and voxel-edit own browser/GPU scripts, separately on native WebGPU and MARGO_COMPAT=1 under the shared GPU lock. No speed suite is part of this build-phase proof.

## Batch 185 array texture sampling
After build:packages run node --test packages/shader/test/texture-array.test.js. Under a shared GPU lock run node packages/shader/test/texture-array-check.mjs, then the same command with --compat. The fixture has 32 distinct RGBA8 layers; each material pixel matches its encoded source, all computed RGBA values exactly equal sampling an independent 32x1 2D sRGB texture, and -1/4294967295u select the first/last layer. Post samples and the missing-source white array are checked too. No benchmark runs.
Batch 191 job 2: node --test --test-timeout=120000 packages/post/test/mask.test.js after build. Pixel check: node scripts/gpu-lock.mjs run --owner=codex-batch191 --max=3 --wait-max=60 -- node packages/post/test/mask-browser.mjs, then repeat with --compat. Original analytic two-tone scene and binary mask need no downloaded assets.
### Batch 184 transmission backgrounds
After npm run build:packages, run node --test --test-timeout=60000 packages/materials/tests/transmission-background.test.js, then node scripts/gpu-lock.mjs run --owner=batch184-proof --max=6 --wait-max=60 -- node packages/materials/test/transmission-background-browser.mjs. The GPU script runs all eight native/compat, sorted/weighted, 1x/4x grids and writes captures and numeric comparisons under test-results/batch184. All checks are correctness checks; no timing suite is run.

For the compressed-upload regression, run node --test --test-timeout=60000 packages/materials/test/texture-formats.test.js and the shared-lock scripts/mat-more-gpu-check.js --compat command. The repaired complete compatibility run passes all 50 checks, including the real Dot_C.ktx2 asset already pinned and licensed in the decoder fixtures. The full dispersion leaf passes both 278-check backend grids in this continuation; unchanged historical wireframe compatibility failures remain documented.

## Batch 214 job 3: multi-goal and closed-chain IK
After building packages, run node --test --test-timeout=120000 packages/kinematics-constraints/tests/multi-goal.test.js. All fixtures are original analytic mechanisms, including independent trigonometric five-bar endpoint checks and a weighted compromise with known minimizer. Under the shared GPU lock run node packages/kinematics-constraints/tests/multi-goal-browser.mjs; it renders a solved mixed-joint loop on both WebGPU and WebGL2 compatibility. The normal package browser and limits-browser suites remain required. No benchmark or external asset is used.

Batch 271 job 4: build packages, then `node --test --test-timeout=30000 packages/creative/tests/paint-aniso.test.js`; under a shared GPU lock run `node packages/creative/scripts/test-paint-aniso.js` and again with `--compat`, with a 3-minute hold and 60-minute queue limit. The independent scalar reference is packages/creative/tests/paint-aniso-reference.js. The circular fixture fails the original hard-support implementation without changing the one-code comparison bar. No dependent GPU suite or timing run.

### Batch 240 job 3

Build packages; run node --test --test-timeout=120000 packages/voxel/tests/wind.test.js packages/voxel/tests/mesher.test.js packages/voxel/tests/render.test.js. Render with node scripts/gpu-lock.mjs run --owner=codex-batch240 --max=5 --wait-max=60 -- node packages/voxel/tests/wind-browser-check.mjs, then add --compat after the script. Both plain and chamfer scenes must change at time 1, reproduce time 0 exactly, remain unchanged between times 0 and 2 at zero wind, and remove the adapter without a GPU error. The chamfer scene also selects GpuVoxelMesher and checks the detailed-shape path, with custom-model/object types in the same registry.
### Batch 192: velocity upscaling
After npm run build:packages, run npm run test --workspace @margoengine/taa. GPU: node scripts/gpu-lock.mjs run --owner=taa-upscale-velocity --max=4 --wait-max=60 -- node packages/taa/test/upscale-velocity-browser.mjs, then the same command with --compat after the script. The original analytic fixture covers 200x160 output, scale 0.5, 4x MSAA, stereo target isolation, shared offset viewports, translating thin geometry and stopped-surface jitter. Expected: zero byte differences versus each isolated eye/viewport, nonzero parallax/coverage and object motion, stationary error below 2e-5 UV, no GPU errors. No downloaded model, rival source, benchmark or exclusive GPU hold is required.

Batch 191 job 3: build packages, node --test --test-timeout=120000 packages/post/test/pixelate.test.js; node scripts/gpu-lock.mjs run --owner=codex-batch191 --max=3 --wait-max=60 -- node packages/post/test/pixelate-browser.mjs, repeated with --compat. Original analytic cube fixture; no external assets.
Batch 270 job 5: build packages, node --test --test-timeout=120000 packages/vfx/test/json.test.js, then under the shared GPU lock run node packages/vfx/test/parity.mjs --json and add --compat. The fixture combines the four preceding optional features, typed texture and fog, then requires exact saved/reloaded state and nonempty rendered images with identical pixels.

## Batch 272 job 1, textured stills
After build:packages, run node --test --test-timeout=120000 packages/staging/test/*.test.js, then node scripts/gpu-lock.mjs run --owner=staging-materials --max=5 --wait-max=60 -- node packages/staging/test/pathtrace-materials-browser.mjs. It runs WebGPU and compatibility and writes test-results/staging-pathtrace-materials.json. FlightHelmet is the existing openly licensed fixture; no network dependency. Checks include independently decoded factor/channel/normal/cutout images, idle convergence, real mapped product conversion after source disposal, cancellation, PNG capture and actual device replacement. No benchmark.


## Batch 189: clouds and weather through WebGL2 compatibility
After npm run build:packages, run node --test --test-timeout=60000 packages/sky/test/compat-clouds.test.js. Run node scripts/gpu-lock.mjs run --owner=batch189 --gpu=sky-pixel-correctness --max=4 --wait-max=60 -- node packages/sky/test/features-check.mjs volumetric weather weather-fx sleet for native WebGPU. Set MARGO_COMPAT=1 and repeat for full WebGL2 compatibility. The browser log records the adapter, both 1x/4x sample counts, validation errors, changed pixels, weather depth/cover results and lightning reset. The full sky GPU gate additionally runs browser-check.mjs, dither-check.mjs and all features-check.mjs cases on each backend. These are correctness checks; frame times printed by old pages are diagnostics, not benchmarks. No external demo data is required.
Batch 274 decomposition: node packages/compute/scripts/build-decomp.mjs reproduces the checked-in optional Wasm asset (Rust wasm32-unknown-unknown, simd128). cargo test --locked --manifest-path packages/compute/decomp-kernel/Cargo.toml checks scalar native algorithms. After npm run build:packages, node --test --test-timeout=60000 packages/compute/tests/decomp.test.js runs CPU references, failures and SIMD conformance. node scripts/gpu-lock.mjs run --owner=codex-batch274 --wait-max=60 --max=3 -- node packages/compute/tests/decomp-browser.mjs runs the same cases on native WebGPU and WebGL2 compatibility. Tests use analytic synthetic matrices with no external data or licence requirement.
Batch 270 recurring suite: under the shared GPU lock run npm run test:gpu --workspace @margoengine/vfx. The command includes native and WebGL2 parity.mjs --all. The CPU registration regression is node --test --test-timeout=120000 packages/vfx/test/gpu-registration.test.js.



Batch 188 baked IBL: build packages, then node --test --test-timeout=120000 packages/environment/tests/prefiltered.test.js. GPU under a shared lock: node scripts/gpu-lock.mjs run --owner=codex-batch188 --max=4 --wait-max=60 -- node packages/environment/scripts/test-browser.js --page=prefiltered ; repeat with --compat. The CC0 real panorama provenance is packages/environment/tests/fixtures/NOTICE.md. CPU tests cover exact encode/decode, every truncated prefix, corrupt dimensions and overlapping levels, cancellation, upload-only creation, disposal and restoration. GPU tests compare all source/specular mips, SH and LUT values and identical saved bytes after device replacement.
### Batch 184 fur
After npm run build:packages, run node --test --test-timeout=60000 packages/materials/tests/fur.test.js. Under the shared GPU lock run node packages/materials/test/fur-browser.mjs with a three-minute hold limit and a 60-minute queue limit. It renders all native/compat 1x/4x grids and stores captures and quantitative control differences at test-results/batch184/fur/gpu.json. The CC0 Wood Table Worn image is already in examples/assets/source/skinning_ik/textures/polyhaven/wood_table_worn. No network fetch or timing assertion is part of the gate.
Batch 191 job 4: node --test --test-timeout=120000 packages/post/test/halftone.test.js after build; node scripts/gpu-lock.mjs run --owner=codex-batch191 --max=3 --wait-max=60 -- node packages/post/test/halftone-browser.mjs, repeated with --compat. Uses an original constant-colour scene, with no external assets.

## Batch 272 job 2: sky and multiple lights
After build:packages run node --test --test-timeout=120000 packages/staging/test/*.test.js and node scripts/gpu-lock.mjs run --owner=staging-ambient --max=4 --wait-max=60 -- node packages/staging/test/accumulate-ambient-browser.mjs. The latter runs both backends and writes test-results/staging-accumulate-ambient.json. Its original contact-reference sphere fixture has a closed-form cosine visibility integral. No external data or timing assertion.


### Batch 173 volume quality and opaque termination
Build packages, run `node --test --test-timeout=120000 packages/sciviz/tests/volume-quality.test.js`, then run volume-depth-browser.mjs and volume-quality-browser.mjs under `node scripts/gpu-lock.mjs run --owner=volume-quality-proof --wait-max=60 --max=5 -- node packages/sciviz/tests/<script>`. Each browser script covers native WebGPU and WebGL2 compatibility. Reports: test-results/batch173-volume-depth.json and batch173-volume-quality.json; screenshots: batch173-volume-quality-native.png / compat.png.
For the half-volume fixture, a=20/255 and a green opaque slice halves the path. Ordinary extinction spans four voxels, so A=1-(1-a)^4; cinematic/fusion span 3.5 centre-to-centre voxel intervals, so A=1-(1-a)^3.5. Blend red with the measured green slice using A. For constant quality integration, a=5/255 over 32 intervals gives round(255*(1-(1-a)^32))=120. The affine ramp has 33 samples exactly representable in binary16, y=i/32; threshold 0.37 is bracketed against independently placed opaque planes, including a two-millionth interval after 24 explicit-interpolation bisections. No tolerance was relaxed when hardware texture-filter fraction quantization was found; refined samples now interpolate corner loads in float32.
The static 32x32 rank tile is generated clean room by `python scripts/prepare-sciviz-blue-noise.py` (NumPy 2.5.4, PCG64 seed 17304, Gaussian sigma 1.5, 75 relaxation swaps). CPU checks require ranks 0..1023 exactly once and mean low-frequency power below a tenth of the high-frequency comparison modes. The source scan and its CC0 provenance are unchanged; open examples/sciviz-volume-quality.html and select iso/composite/MIP. Timing suites remain deferred.

### Batch 195 job 1
Build packages; run node --test --test-timeout=120000 packages/quality/test/demand.test.js and node scripts/gpu-lock.mjs run --owner=codex-batch195 --max=3 --wait-max=60 -- node packages/quality/test/demand-browser.mjs. The browser fixture compares draw counters across idle frames, damped control activity and load completion on both backends. Fixtures are original analytic geometry, no external data.
Batch 270 recurring suite: under the shared GPU lock run npm run test:gpu --workspace @margoengine/vfx, then npm run test:gpu:parity --workspace @margoengine/vfx. The dedicated command includes native and WebGL2 parity.mjs --all. The CPU registration regression is node --test --test-timeout=120000 packages/vfx/test/gpu-registration.test.js.
### Batch 186 job 1: disk and sphere shadows

Build packages, run the clustered CPU tests, then run `node scripts/gpu-lock.mjs run --owner=codex-batch186 --max=4 --wait-max=60 -- node scripts/clustered-area-shapes-gpu.mjs` and the same command with `--compat` after the script. The procedural scene has an emitter at y=3, a block from y=1 to 1.5, and floor probes at x=0 and x=3. Blocked visibility must be below 0.05, clear visibility within 0.02 of 1, and core/probe shaders must compile without errors or warnings. No benchmarks are run in the build phase.
Batch 191 job 5: node --test --test-timeout=120000 packages/post/test/stylize.test.js after build; node scripts/gpu-lock.mjs run --owner=codex-batch191 --max=3 --wait-max=60 -- node packages/post/test/stylize-browser.mjs, repeated with --compat. All visual fixtures are original analytic bars.


### Batch 195 job 3
Build packages, run node --test --test-timeout=120000 packages/quality/test/events.test.js, then node scripts/gpu-lock.mjs run --owner=codex-batch195 --max=3 --wait-max=60 -- node packages/quality/test/events-browser.mjs. The fixture uses original box geometry, a control-like change event and real engine.pick on native WebGPU then full WebGL2 compatibility. The 200-to-1 assertion counts work and has no timing budget.

### Batch 201 job 2
After build:packages, run `node --test --test-timeout=120000 packages/gltf-pro/tests/dds.test.js packages/decoders/tests/bc-float.test.js`. Under the shared GPU lock run `node packages/gltf-pro/scripts/test-dds-browser.mjs`, then the same script with `--compat`. The fixture compares native and forced software BC paths and records maximum channel error in test-results/batch201-dds[-compat].json; it also asserts a visible red mip-chain material and no GPU validation errors.

### Assigned batch-273 sampler overflow
Build packages, then run gltf-pro CPU tests. Under the shared GPU lock run `node scripts/gltf-pro-materials-gpu-check.js` and again with `--compat`; all composed and transmissive permutations must still report null pipeline errors. Run `node packages/gltf-pro/scripts/test-base-textures-browser.mjs` and again with `--compat` for 360 continuous-filter reference cases per backend; test-results/batch201-base-textures[-compat].json records analytic and native filtering errors separately. No original pipeline assertion is relaxed.

### Batch 203 HDR6

Build packages, then run node --test packages/decoders/tests/ktx2-hdr6.test.js and cargo test --offline --locked --manifest-path packages/decoders/native/hdr6/Cargo.toml, with a hard process-tree timeout. Golden records and fixture attribution are in packages/decoders/tests/fixtures/ktx2-hdr6. The clean-room crate has no dependencies. Run node scripts/gpu-lock.mjs run --owner=hdr6-correctness --wait-max=60 --max=3 -- node packages/decoders/tests/hdr6-browser.mjs for both backends. Production asset emission is covered by packages/decoders/scripts/test-browser.js. No README run or full verify is a lane gate.

## Batch 177 job 1

Build packages, then `node --test --test-timeout=30000 packages/sciviz/tests/contour2d.test.js`. Render with `node scripts/gpu-lock.mjs run --owner=codex-batch177 --wait-max=60 --max=3 -- node packages/sciviz/tests/contour2d-browser.mjs`. Open `/examples/sciviz-contour2d.html` using the examples server and switch both fields/modes; the download stays SVG paths/text with polygon holes. Frozen data hashes and reductions are in `examples/assets/sciviz/contour2d/source.json`. Regenerate with `packages/sciviz/scripts/prepare-contour2d.py` using the dependencies listed in its header. No rival source, benchmarks or timing-only tests are needed.


Batch 188 Fresnel floor: build packages, node --test --test-timeout=120000 packages/environment/tests/reflector-pbr.test.js packages/vfx/test/manifest.test.js. Native GPU: node scripts/gpu-lock.mjs run --owner=codex-batch188 --max=4 --wait-max=60 -- node packages/environment/scripts/test-browser.js --page=reflector-pbr ; repeat with --compat. Tests check independent Schlick HDR values over view angles, real oblique capture depth at contact and distance, no shader compilation for live uniform changes, exact pixels after device replacement, and the CC0 panorama already attributed in environment fixtures/NOTICE.md. No speed measurement.

## Precipitation cover (batch 236 job 2)
Build packages. CPU: node --test --test-timeout=60000 packages/weather/tests/cover.test.js. GPU: node scripts/gpu-lock.mjs run --owner=weather-cover-proof --wait-max=60 --max=8 -- node packages/weather/tests/parity-browser.mjs cover, then the same command with --compat (or npm run test:browser:parity --workspace=@margoengine/weather for gltf, cover and lens on both backends). Original procedural fixture: imported floor and wall, core strip, capture-only roof with 0.5 m eaves and a small canopy probe. No third-party fixture or benchmark.

## Batch 272 job 3: product caustics
After build:packages run node --test --test-timeout=120000 packages/staging/test/*.test.js and node scripts/gpu-lock.mjs run --owner=staging-caustics --max=4 --wait-max=60 -- node packages/staging/test/caustics-browser.mjs. Both backends use original plane, slab and sphere oracles; report: test-results/staging-caustics.json. Compare water against 1-((ior-1)/(ior+1)) squared and the slab against two such Fresnel transmission factors. Require focused irradiance above one, integrated flux below one, nonblack floor pixels, exact retained/restored maps and rejection followed by successful replacement. No network assets or timing assertions.
### Batch 174 job 1: shared selections
Build packages; run node --test --test-timeout=120000 packages/sciviz/tests/link.test.js. Under a shared GPU lock run node packages/sciviz/tests/link-browser.mjs (the script covers native WebGPU and WebGL2 compatibility). The public-domain 2MASS asset's hashes and query are pinned in examples/assets/sciviz/stars.json. The real-data predicate selects J-Ks strictly between 0.8 and 1.1: 242,931 of the sample's million sources. Both backends must change all three linked view images, preserve exact histogram counts, undo all memberships, upload one mask for two million plotted marks, and return exactly 485,862 selected entries on GPU readback. Two copies of the observed rows supply the stress layer. No timings are asserted.

### Batch 186 job 2: shared shadow atlas
After build:packages, run clustered CPU tests. Run node scripts/gpu-lock.mjs run --owner=codex-batch186 --max=4 --wait-max=60 -- node scripts/clustered-shadow-atlas-gpu.mjs, and append --compat for the full WebGL2 check. Point/spot blocked visibility must be below 0.05; clear visibility must stay within 0.02 of 1; combined rectangle/sphere probes must remain blocked below 0.05 of clear. No shader warnings or errors. CPU shadow-atlas.test.js independently pins face count, disjoint tiles, allocation and rasterized-texel counts. Benchmarks remain deferred.



## Batch 136: clean-room Draco encoder

Rebuild the single optional SIMD artifact with node packages/exporters/scripts/build-draco.mjs, then npm run build:packages. CPU correctness: cargo test --locked --manifest-path packages/exporters/draco-kernel/Cargo.toml and node --test --test-timeout=120000 packages/exporters/tests/draco.test.js packages/exporters/tests/draco-native.test.js. The normal test records opaque Draco 1.5.7 maximum errors for an original xorshift-seeded 3,000-direction input and compares six bit depths; no encoder oracle dependency ships in that test. The boundary-call test counts actual exported Wasm calls through a forwarding object at two output sizes. The output is decoded independently, so reducing the count cannot omit geometry.

Own-package browser correctness: node packages/exporters/scripts/test-browser.js, tests/png-browser.mjs and tests/capture-browser.mjs, with and without --compat, each under node scripts/gpu-lock.mjs run --owner=codex-batch136 --max=1 --wait-max=60 -- . Use the complete repository-relative paths for the two tests. These are shared correctness slots. Never run a timing benchmark during the deferred build phase. Entry bytes use scripts/measure-size.js bundleBytes followed by gzipSync; raw/gzip Wasm bytes use the committed artifact. The pre-change entry was measured from origin-main source against the same supporting modules before implementation changes. The complete external-corpus ratio/settings harness is the following proof job; no universal ratio or speed guarantee is asserted here.
Batch 191 job 6: node --test --test-timeout=120000 packages/post/test/curvature.test.js after build; node scripts/gpu-lock.mjs run --owner=codex-batch191 --max=3 --wait-max=60 -- node packages/post/test/curvature-browser.mjs, repeated with --compat. Original signed half-float normal fields and a flat/cube scene require no external assets.



## Batch 178 vector publication
After build:packages, run node --test --test-timeout=90000 packages/sciviz/tests/export-vector.test.js, then node scripts/gpu-lock.mjs run --owner=vector-publication --wait-max=60 --max=5 -- node packages/sciviz/tests/export-vector-browser.mjs. The latter runs native WebGPU and WebGL2 compatibility and records test-results/sciviz-export-vector.json. Open examples/sciviz-export-vector.html to inspect/download paths for the OpenNeuro threshold surface and the full NASA TMR scalar surface; source/licence/hashes remain in the existing asset JSON records. No timing measurement is part of these checks.

## Batch 272 job 4: backdrop and preset studio lighting
After build:packages run node --test --test-timeout=120000 packages/staging/test/*.test.js and node scripts/gpu-lock.mjs run --owner=staging-backdrop --max=4 --wait-max=60 -- node packages/staging/test/backdrop-browser.mjs. Both backends reuse FlightHelmet mobile from the existing licensed fixtures. Compare four named rig pictures, require >1000 changed backdrop pixel components after removal, exact restored output and detached owned mesh/environment. Report: test-results/staging-backdrop.json. No timing assertions or new data download.
## Batch 176 job 1: datasets
After npm run build:packages, run node --test packages/sciviz/tests/datasets.test.js packages/sciviz/tests/datasets-elements.test.js packages/loaders/tests/vtk-datasets.test.js. Run node scripts/gpu-lock.mjs run --owner=dataset-repro --max=4 --wait-max=60 -- node packages/sciviz/tests/datasets-browser.mjs for both GPU backends. The page is examples/sciviz-datasets.html. Original NASA grids and SHA-256 values are in examples/assets/sciviz/datasets/source.json. To regenerate the independent writer outputs and interpolation oracle, install the external VTK 9.7.2 and NumPy tools outside package runtime dependencies, then run python packages/sciviz/scripts/datasets-fixtures.py from the repository root. It invokes public runtime APIs only. No benchmark or speed assertion is part of this proof; all timing work remains deferred by the build phase.
### Batch 217 job 3: scroll and ranges

After build:packages, run node --test --test-timeout=120000 packages/cutscene/tests/scroll.test.js. Run node scripts/gpu-lock.mjs run --owner=cutscene-scroll --wait-max=60 --max=2 -- node packages/cutscene/tests/scroll-browser.mjs for browser interactions. The package test:gpu includes all cutscene proofs; repeat with MARGO_COMPAT=1 for compatibility rendering. Scroll/range logic is DOM/CPU only and identical on both backends. All comparisons are correctness assertions; no benchmark or timing budget runs.

## Batch 177 job 2

Build packages, then `node --test --test-timeout=30000 packages/sciviz/tests/stats.test.js`. Browser proof: `node scripts/gpu-lock.mjs run --owner=codex-batch177 --wait-max=60 --max=3 -- node packages/sciviz/tests/stats-browser.mjs`. Open `/examples/sciviz-stats.html` for thirteen vector charts and SVG downloads; the page shows units, data dates and missing-error policy. `node packages/sciviz/scripts/prepare-stats.mjs` reproduces the frozen reductions from NOAA GHCN and a commit-pinned public NASA-table mirror. No rival source is used. Timing benchmarks are deferred during the build phase.

### Batch 274 job 3: CPU SIMD correctness

Build with node packages/compute/scripts/build-cpu.mjs, then npm run build:packages. Run node --test --test-timeout=120000 packages/compute/tests/cpu.test.js packages/compute/tests/cpu-wasm.test.js. Run cargo test --locked --manifest-path packages/compute/cpu-kernel/Cargo.toml with a 120 s process-tree limit. GPU correctness: node scripts/gpu-lock.mjs run --owner=cpu-wasm-proof --wait-max=60 --max=3 -- node packages/compute/tests/cpu-wasm-browser.mjs. This driver compares the new CPU factory with WebGPU and then WebGL2, with 59 checks each. It makes no elapsed-time assertion. The SIMD counter comes from actual Rust loop execution; the odd-sized exact A/B test also covers the scalar tail.

### Batch 195 job 2
Build packages, then run `node --test --test-timeout=60000 packages/quality/test/knobs.test.js`. Run `node scripts/gpu-lock.mjs run --owner=quality-knobs --max=4 --wait-max=60 -- node packages/quality/test/knobs-browser.mjs` for both native and compatibility backends. The fixture uses original analytic stripes/clear colour and fixed particle deltas; no external downloads or timing assertion. Observe 4/4/1 pipeline samples across selection and engine re-create, actual reduced dimensions, restored source pixels and birth counts 10/15/15/25.

Batch 188 EXR codecs: build packages, then node --test --test-timeout=120000 packages/environment/tests/exr-codecs.test.js. GPU-locked node packages/environment/scripts/test-browser.js --page=exr-codecs, and node packages/environment/tests/exr-codecs-bundled-browser.mjs; run each with --compat too. The lock owner is codex-batch188, shared, max 4 and wait-max 60 minutes. The native oracle records are packages/environment/tests/fixtures/codecs/reference.json; run source.mjs there from the repo root after building, then generate.py with native OpenEXR 3.5.3 and NumPy installed (the script also accepts test-results/exr-oracledeps). The source.mjs step writes the intermediate photographic crop into this worktree's ignored test-results. Expected .f32 bytes are native decoder output, never Margo's. Native SDK and prebuilt Wasm versions are intentionally independent.

### Batch 201 job 3
After build:packages run `node --test --test-timeout=120000 packages/gltf-pro/tests/audio.test.js`. Under the shared GPU lock run `node packages/gltf-pro/scripts/test-audio-browser.mjs`, then repeat with `--compat`. A generated 48-kHz mono PCM tone is decoded by real Web Audio and rendered into 4,800 stereo frames. Both dialects follow the model node from +X to -X, retain their opposite forward axes, and produce the expected right-channel equal-power output at +X. Receipts: test-results/batch201-audio[-compat].json. No external model/audio asset or timing benchmark is needed.



Batch 136 ratio/error proof: after building packages, run node packages/exporters/tests/draco-parity.mjs --oracle=<outside-folder> --matrix packages/exporters/tests/fixtures/Box.glb examples/assets/khronos/Fox/Fox.glb examples/assets/khronos/MetalRoughSpheres/MetalRoughSpheres.glb examples/assets/khronos/CommercialRefrigerator/CommercialRefrigerator.glb examples/assets/khronos/Lantern/Lantern.glb examples/assets/khronos/RiggedFigure/RiggedFigure.glb under a hard process-tree timeout. The outside folder contains opaque draco_encoder_wrapper.cjs, draco_encoder.wasm, draco_decoder.cjs and draco_decoder.wasm; the harness rejects a folder inside the repository. Existing asset notices supply source/licence. Output is test-results/batch-136/draco-parity.json. The committed results/batch-136-draco-parity.json captures all 76 rows and exact hashes. No GPU lock or timing benchmark is involved. Permanent regressions run with cargo test for exporters/draco-kernel and node --test packages/exporters/tests/draco-native.test.js.
### Batch 173 job 5 mapped volumes
Run node --test --test-timeout=60000 packages/sciviz/tests/curvilinear.test.js after building packages. Run node scripts/gpu-lock.mjs run --owner=mapped-repro --max=9 --wait-max=60 -- node packages/sciviz/tests/curvilinear-browser.mjs for both backends; report test-results/batch173-curvilinear.json and mapped-demo PNGs. Cube analytical opacity: 1-(1-13/255)^4. Hollow spherical-shell ray length is twice (1-.5), reference distance .1, giving 1-(1-13/255)^10. Camera/physical ray offset changes this by less than one display byte. Rebuild public-domain NOAA subsets with python scripts/prepare-sciviz-mapped.py, bounded network requests, output hashes in examples/assets/sciviz/*curvilinear.json and woa23-shell.json. Open examples/sciviz-curvilinear.html to switch ray march, coordinate slices and boundary grid.
### Batch 186 job 3: cube-cookie projection
After build:packages, run clustered CPU tests. Run node scripts/gpu-lock.mjs run --owner=codex-batch186 --max=4 --wait-max=60 -- node scripts/clustered-cube-projector-gpu.mjs, then the same command with --compat. The script compares production clusterLighting output to the same untextured lights: six axis colours, a one-third three-face corner, a half-red/half-green edge, continuity across that edge, quaternion rotation, an oriented 2x2 pattern, sRGB grey times alpha and independent mixed spot/cube cookies. Tolerance is 0.0002 on normalized radiance; no shader warnings/errors. Diagnostic images are generated locally from the constants in the script.




Batch 180 job 1: build packages, then node --test packages/sciviz/tests/geo-lod.test.js; for rendering use node scripts/gpu-lock.mjs run --owner=geo-lod-repro --wait-max=60 --max=4 -- node packages/sciviz/tests/geo-lod-browser.mjs. The browser suite tests both WebGPU and webgl2-compat and writes test-results/sciviz-geo-lod.json. Demo: examples/sciviz-geo-lod.html, pinned levels 0..2 by default; optional live AWS detailed tiles. No benchmark or exclusive lock.
Batch 181 job 1: build packages, then run node --test --test-timeout=120000
packages/sciviz/tests/*.test.js. Run node scripts/gpu-lock.mjs run
--owner=codex-batch181 --max=6 --wait-max=60 -- node packages/sciviz/tests/fallback-browser.mjs
for native/shared-WebGL2 pixels, CPU extraction, replacement, cancellation and all three
real-data demos. Result: test-results/sciviz-fallback.json. Open examples/sciviz-head.html,
sciviz-stars.html and sciviz-wind.html with ?backend=webgl2 to force the complete route.
Data sources and licences remain in examples/assets/sciviz/README.md; no new dataset or
performance measurement is introduced. The scripts test correctness under a hard outer
process-tree deadline and shared GPU admission, with no exclusive speed reservation.

Batch 136 removal: build packages, then run exporters/draco-native.test.js and tests/supply-chain.test.js with a hard timeout. They require the owned Wasm, no old encoder vendor/dist directories, successful default compression, current generated notices, retained asset addenda and valid package file lists. scripts/lazy-files.js lists only the owned Draco encoder asset. Run the exporter browser script for native and --compat under separate shared GPU slots. The external-oracle parity command above remains available without bundling its opaque modules.
Batch 177 job 3: build packages, run node --test --test-timeout=60000 packages/sciviz/tests/charts-extra.test.js, then node scripts/gpu-lock.mjs run --owner=sciviz-charts-extra --wait-max=60 --max=3 -- node packages/sciviz/tests/charts-extra-browser.mjs. Open examples/sciviz-charts-extra.html for the 13 charts and downloads. Data provenance is examples/assets/sciviz/charts-extra/source.json; prepare.py re-downloads government data with bounded network waits. EIA revisions can change source hashes, so committed JSON is the proof fixture.

### Batch 274 job 4: NN-extra reproduction

After npm run build:packages, run node --test --test-timeout=120000 packages/compute/tests/nn.test.js packages/compute/tests/nn-extra.test.js. This covers JavaScript and Rust SIMD CPU contexts, independent finite differences and allocation accounting. Run node scripts/gpu-lock.mjs run --owner=nn-extra-proof --wait-max=60 --max=3 -- node packages/compute/tests/nn-extra-browser.mjs for 38 cases each on WebGPU and compatibility. The transpose oracle scatters input taps, independently of the implementation's output gather. All tests are correctness-only.

The NN-extra landing detector regression runs with node --test --test-timeout=120000 tests/quality-gate.test.js; retain both positive GGX and negative convolution-geometry cases.
Batch 271 job 1: build packages, then `node --test --test-timeout=30000 packages/creative/tests/targets-depth.test.js`; under a shared GPU lock run `node packages/creative/scripts/test-targets-depth.js` and again with `--compat` (164 surfaces each). The layer regression is `node packages/webgl2-compat/test/features-browser.mjs` (case volumeSliceDepth; it reads red on the layer without the stand-in). No timing run.
### Batch 1 job 2: umbrella test discovery

Run node --test --test-timeout=90000 tests/package-test-scripts.test.js and npm test --workspace packages/margoengine -- --test-timeout=90000. Removing scripts.test from packages/margoengine/package.json reproduces the missing tests/export-order.test.js report. No GPU or timing test is required for this manifest-only change.




## Batch 174 job 2: tables

After building packages, run `node --test --test-timeout=120000 packages/sciviz/tests/table.test.js packages/decoders/tests/snappy.test.js`. Then run `node scripts/gpu-lock.mjs run --owner=table-proof --max=10 --wait-max=60 -- node packages/sciviz/tests/table-browser.mjs` shared. It tests both backends and prints counts, work and all sums; it has no timing threshold. Open `/examples/sciviz-tlc.html` through the normal Vite server to inspect distance-filtered charts. Standard fixtures regenerate with PyArrow 26.0.1 via `python packages/sciviz/scripts/generate-table-fixtures.py`; the downloaded original stays in this lane's ignored test-results/batch174 folder. No foreign implementation is copied.
## Batch 178 PDF and math
Run node --test --test-timeout=120000 packages/sciviz/tests/math.test.js packages/sciviz/tests/pdf.test.js after building packages. Run node scripts/gpu-lock.mjs run --owner=publication --wait-max=60 --max=6 -- node packages/sciviz/tests/pdf-browser.mjs for native WebGPU and WebGL2; artifacts are test-results/sciviz-publication/. Open examples/sciviz-publication.html for all 3441 LIGO samples and PDF/SVG downloads. For independent decoding, PyMuPDF opens each generated PDF; assert one page, is_repaired false, zero images/12 paths for LIGO and the mixed fixture pixel expectations recorded in ../sciviz-publication.md. No timing assertions.

## Batch 176 job 2 engineering formats
After building packages and fetching Git LFS data, run node --test --test-timeout=60000 packages/sciviz/tests/hdf5.test.js packages/sciviz/tests/engineering.test.js packages/sciviz/tests/engineering-selections.test.js. Run node scripts/gpu-lock.mjs run --owner=engineering-reproduce --max=3 --wait-max=60 -- node packages/sciviz/tests/engineering-browser.mjs for both rendering routes. The demo is examples/sciviz-engineering.html. Native fixture writer scripts are under packages/sciviz/scripts/*fixtures.py and use public APIs of externally installed tools only; test execution itself needs no native format library. Fixture provenance records the exact writer versions and transformations. Correctness tests contain no timing budgets or performance claims.
Batch 183 job 1: after build:packages, run the stage CPU suite and `node scripts/gpu-lock.mjs run --owner=codex-batch183 --wait-max=60 --max=5 --gpu=stage-gltf-pixel-comparison -- node packages/stage/test/gpu/gltf-check.mjs`. Both backends load BoxTextured, RiggedFigure and MorphStressTest side by side through the facade and direct PBR + Animation. Every RGBA byte must match and more than 100 pixels must contain visible model geometry; no driver or page errors are accepted. Existing fixture licence records are cited in docs/clean-room.md.
Review 4: after build:packages, run packages/clustered/test/stochastic.test.js and ltc-edge.test.js with node --test; run scripts/clustered-cube-projector-gpu.mjs and scripts/shape-lights-gpu-check.js under the repository GPU lock, both normally and with --compat. The latter retains the 54 float64 mirror cases and their original limits.


Review 2 VTK wedge orientation: after building packages, run node --test --test-timeout=120000 packages/loaders/tests/vtk-wedge.test.js packages/loaders/tests/vtk-legacy.test.js packages/loaders/tests/vtk-xml.test.js. The unit prism must have signed volume +0.5, the positive affine transform +12, with every triangle facing away from the interior in both parsers and surface policies.

Review 2 canvas ray coordinates: after build:packages, run node --test --test-timeout=120000 packages/selection/test/spatial.test.js. The layout-free ray regression checks zero/absent client dimensions, mixed axes and scaled CSS dimensions. Run the selection package GPU suites on both backends for the existing raster contracts.

Review 2 off-scene animation dependencies: after building packages, run `node --test --test-timeout=120000 packages/exporters/tests/optimize-extra.test.js`. The pruning regression covers a directly animated skinned mesh and an animation target below a skinned ancestor outside scene roots. It validates both GLBs and the retained transform/joint references.


Batch 175 job 2: build packages; run `node --experimental-test-module-mocks --test --test-timeout=30000 packages/sciviz/tests/pointcloud.test.js packages/sciviz/tests/pointcloud-data.test.js packages/sciviz/tests/link.test.js packages/points/tests/octree-attributes.test.js packages/points/tests/copc.test.js`. Run `node scripts/gpu-lock.mjs run --owner=pointcloud --wait-max=60 --max=3 -- node packages/sciviz/tests/pointcloud-browser.mjs` for native and compatibility pixels and work counts. Open examples/sciviz-pointcloud.html for original archived USGS EPT tiles. Their manifest pins compressed and decoded hashes; the independent oracle was laspy 2.7.0 with lazrs 0.8.2, comparing SHA-256 of complete little-endian point records, including extras. No download is required by tests.
Batch 177 job 4: node --test --test-timeout=60000 packages/sciviz/tests/chart-polish.test.js; node scripts/gpu-lock.mjs run --owner=chart-polish --wait-max=60 --max=3 -- node packages/sciviz/tests/chart-polish-browser.mjs. Open examples/sciviz-chart-polish.html. It reuses the frozen public-domain GHCN Central Park table and attribution in examples/assets/sciviz/stats/source.json. Browser reports/snapshots live under ignored test-results/chart-polish. Existing line/scatter, rectangle and native WebGL2 drawing suites also exercise the Figure integration.
### Batch 173 job 6 tetrahedral volumes
Build packages, then run node --test --test-timeout=60000 packages/sciviz/tests/tetvolume.test.js. Run node scripts/gpu-lock.mjs run --owner=tet-repro --max=9 --wait-max=60 -- node packages/sciviz/tests/tetvolume-browser.mjs. The script tests both backends and writes test-results/batch173-tetvolume.json plus demo PNGs. Cube reference: alpha=13/255 per physical distance 0.25 through length 1, so displayed red is round(255*(1-(1-alpha)^4))=48. A half-length disconnected domain gives 25. Normalize the regular-image alpha to its physical voxel spacing before comparing it with the direct mesh; otherwise the two integrators have different optical depth. For a density d, voxel distance h and reference distance r, a_h=1-(1-min(alpha*d,1))^(h/r), with regular-source density a_h/alpha. This conversion is tested at densities 1 and 4.
Run python scripts/prepare-sciviz-tetvolume.py to rebuild the attributed NASA subset; the original zip stays under ignored private/batch173/job6, every network request has a 60-second limit. Open examples/sciviz-tetvolume.html for identical fixed views of direct cells and their CellLocator resampling. Source samples are a two-dimensional CFL3D SA field, extended unchanged along display span; geometry transformations are declared in the UI and metadata.




## Batch 174 job 3: multivariate plots

After building packages, run node --test --test-timeout=60000 packages/sciviz/tests/parcoords.test.js. Run the shared GPU proof with node scripts/gpu-lock.mjs run --owner=parcoords-proof --max=3 --wait-max=60 -- node packages/sciviz/tests/parcoords-browser.mjs. It tests native and compatibility devices, counts actual submitted line instances, compares every density pixel against the repeated-observation reference, checks linked selection/undo, reorder/flip writes and resource restoration. Open /examples/sciviz-parcoords.html through the normal Vite server for the real-observation demo. Snapshot source, query reduction, licence and hashes remain in examples/assets/sciviz/stats/source.json. No timing-only check runs.

## Batch 181 job 2: allocation reporting

Build packages, then run packages/sciviz/tests/monitor.test.js with Node's test runner
and --test-timeout=120000. Under the shared GPU lock, run monitor-browser.mjs, then
packages/sciviz/tests/limits-browser.mjs once normally and once with --backend=webgl2 and a
separate --output path. Each render command has a three-minute active hard limit and
--wait-max=60; an outer process-tree limit covers teardown. The suite JSON is documented
in ../sciviz-monitor.md. It includes source commit and source digest, raw per-layer counts
and bytes, browser, GPU and CPU utilization. Original asset hashes/provenance stay beside
the assets; NYC TLC source.json includes its exact query and terms. Default scene ceilings
are censored correctness observations. Timed mode is refused until speed-phase.json ends
deferral; the exact outstanding scale and format matrix is in work-lists/speed-phase.md.
Batch 180 job 2 vector geography: build packages, then node --test --test-timeout=120000 packages/sciviz/tests/geo-vector.test.js. Render correctness: node scripts/gpu-lock.mjs run --owner=<lane> --wait-max=60 --max=1 -- node packages/sciviz/scripts/browser-root.mjs tests/geo-vector-browser.mjs. Both backends write test-results/sciviz-geo-vector.json and use examples/sciviz-geo-vector.html. Asset reconstruction commands, original/derived hashes and fields are in examples/assets/sciviz/geo-vector/source.json and prepare.mjs. No benchmark or timing claim.
Batch 183 job 2: after build:packages run the stage and clustered CPU suites, then `node scripts/gpu-lock.mjs run --owner=codex-batch183 --wait-max=60 --max=4 --gpu=stage-lights-pixel-comparison -- node packages/stage/test/gpu/lights-check.mjs`. Each backend renders point, spot, rectangular area, extra directional and all four together. The facade must equal direct setup byte for byte, visibly change at least 100 pixels from the unlit-by-those-lights baseline and report no page/device error. The BoxTextured source/licence record is cited in docs/clean-room.md.

### Batch 179 scientific figure state
Build with `npm run build:packages`. CPU: `node --test --test-timeout=120000 packages/sciviz/tests/spec.test.js`. GPU: `node scripts/gpu-lock.mjs run --owner=spec-proof --max=8 --wait-max=60 -- node packages/sciviz/tests/spec-demos-browser.mjs` and the same command with `spec-browser.mjs` and `--max=6`. The tests run WebGPU and WebGL2 compatibility, retain all numerical data and exact equality assertions, and report compared canvas lengths and resource kinds. The demo suite uses EngineOptions.exactSize for deterministic byte capture; real data and existing analytic fixtures keep their original licences and values. No timing assertion or benchmark is run.

Batch 179 GPU state mutation regression: after GpuArray.write followed by isosurface.update, saving waits for the mutation and snapshots the consumed field again. Both native WebGPU and compatibility exact captures reproduce the updated field with zero differing bytes. Async mutations are included in the figure's pending state set.
## Batch 178 job 3: media
After build:packages, run the shared-slot command in [sciviz-media.md](../sciviz-media.md#evidence-and-reproduction). The NOAA wind page exercises image/video/ZIP controls. The test writes test-results/sciviz-media/report.json, checks bit-exact tiled/full wind pixels on both backends, streams beyond the texture limit, and uses browser video playback/seek as an independent container oracle. CPU tests cover PNG chunks, ZIP loading, lifetime, timeline restoration and metadata; no benchmark or speed assertion is run.


Review 2 Blender Ping-Pong: run Blender --background --factory-startup --python packages/blender/tests/pingpong-reference.py to reproduce the public-API oracle. Run the blender/test:browser:nodes GPU package leaf on native WebGPU and MARGO_COMPAT=1. packages/blender/tests/nodes-browser.mjs retains the same one-byte tolerance for every frozen value and also checks all previous graph variants.
Batch 183 job 3: build packages; run the stage CPU suite (including tests/viewer-extras.test.js) and its cutscene/headless/react/margoengine CPU dependents. Render correctness: node scripts/gpu-lock.mjs run --owner=codex-batch183 --wait-max=60 --max=5 --gpu=stage-viewer-extras-render-and-pick-on-both-backends -- node packages/stage/test/gpu/viewer-extras-check.mjs . It loads the existing four licensed models, compares against direct setup, checks all named variants, real picks, projected/node anchors, poster and declarative lifecycle, with no page/device errors. Existing stage viewer/scene/features GPU regressions also pass. Physical AR needs a compatible device and HTTPS; the desktop proof checks the disabled immersive-ar button and reason. No benchmark or timing assertion is run.
Batch 177 job 5: node --test --test-timeout=60000 packages/sciviz/tests/stream.test.js; node scripts/gpu-lock.mjs run --owner=sciviz-stream --wait-max=60 --max=3 -- node packages/sciviz/tests/stream-browser.mjs. Open examples/sciviz-stream.html for replay and live USGS polling. Its committed GeoJSON is unmodified; source.json pins its hash and prepare.mjs can record a fresh official response. Replay supports deterministic direct advance calls; tests do not depend on external feed availability or timing budgets. chart-polish-browser.mjs also checks existing controller lifecycle/inset behavior after the shared optional mapping handshake.

### Batch 107 job 2
Build packages, run `node --test packages/inspector/test/shaders.test.js`, then under the shared GPU lock `node scripts/gpu-package-tests.mjs --no-build --select=inspector/test:browser:shaders` (native WebGPU only).

### List 3 batch 66 job 5: underwater view

Build packages. CPU: node --test packages/water/test/underwater.test.js. GPU: node packages/water/test/underwater.browser.mjs, then again with --compat after the script path; results land in test-results/water-underwater-<mode>.json.

Batch 234.3: after build:packages, run water's test:gpu leaves through node scripts/gpu-lock.mjs run --owner=codex-batch234 --wait-max=60 --max=3 -- node packages/water/test/underwater.browser.mjs, again with --single, and node packages/water/test/underwater-optics.browser.mjs. Repeat each with --compat after the script path. Both renderer modes record local water-underwater[-optics]-<mode>[-single].json evidence. The optics test builds synthetic sloped depth planes, independently intersects 1,026 rays in world space and compares exact hit availability, distance and texel colour. The scene test records HDR around the production stage and independently computes dielectric reflection/transmission for every fully covered flat and FFT surface pixel; the existing absorption/waterline/shaft checks remain unchanged. Run underwater-preview.browser.mjs with the same shared lock on each backend for NOAA wind-driven below/split/animated screenshots under test-results/batch234. Real wind data source and licence are in packages/water/test/data/README.md. No timing step or exclusive lock.
### Batch 107 job 3
Build packages, run `node --test packages/inspector/test/remote.test.js` (starts the relay on 127.0.0.1 and talks to it with Node fetch), then under the shared GPU lock `node scripts/gpu-package-tests.mjs --no-build --select=inspector/test:browser:remote`.

### List 3 batch 66 job 8: steep-bed rivers

Build packages. CPU: node --test packages/water/test/rivers.test.js. GPU: node packages/water/test/rivers.browser.mjs, then again with --compat after the script path; results land in test-results/water-rivers-<mode>.json (summary with GPU against model error, chute depth and the 256 x 256 cost).

## Batch 176 job 3 astronomy and microscopy
After npm run build:packages, run node --test --test-timeout=90000 packages/sciviz/tests/astronomy.test.js packages/decoders/tests/tiff.test.js packages/decoders/tests/tiff-scientific.test.js. Run the actual rendering check shared: node scripts/gpu-lock.mjs run --owner=astronomy-proof --max=4 --wait-max=60 -- node packages/sciviz/tests/astronomy-browser.mjs. Open examples/sciviz-astronomy.html for the original SDSS frame, full EMDB map and IDR crop. The browser check covers both backends; native/compatibility image heatmaps agree exactly, volume compositing uses backend-specific raster floating point.
Regenerate owner outputs with packages/sciviz/scripts/write-astronomy-fixtures.py in an environment containing the versions pinned in expected.json. Original SDSS/EMDB compressed downloads go under ignored test-results/batch176/astronomy; the writer retains their exact bytes and independently computes expectations. packages/sciviz/scripts/fetch-idr-crop.py requests only original header and intersecting native tile byte ranges, decodes with installed tifffile/imagecodecs and writes the lossless crop plus original-range provenance; wrap it in a 180-second process-tree limit. Crop origin is (row 4958, column 5311), 256x256 RGB, source 146114920 bytes. File hashes/licences and independent decoder versions are pinned in tests/fixtures/astronomy/source.json and expected.json. No external implementation is shipped or read.

- Batch 174 job 4: build packages, then run node --test packages/sciviz/tests/query.test.js and node scripts/gpu-lock.mjs run --owner=query-proof --max=5 --wait-max=60 -- node packages/sciviz/tests/query-browser.mjs. The browser suite runs native WebGPU and WebGL2, checks 20 selected GHCN days, real NASA TMR selection, sorted physical keys, undo, typed extraction, time-plot PNG changes, and a 100k x 80 virtual spreadsheet. Open examples/sciviz-query.html for both public datasets; provenance is in stats/source.json and tmr-tet.json. No benchmarks or speed assertions.
Batch 178 job 4: build packages, then run the sciviz CPU suite with --experimental-test-module-mocks and node scripts/gpu-lock.mjs run --owner=colors --wait-max=60 --max=5 -- node packages/sciviz/tests/colors-browser.mjs. The public-data demo is examples/sciviz-colors.html. Captures in test-results/sciviz-colors include OISST/2MASS PNG/SVG and binned PDF on both devices. Primary definitions, fixed comparison bounds and broader renderer suite are in ../sciviz-colors.md; compact evidence in results/batch178-colors.json. No timing gate.

Review 2 caustics and ripples: build packages, then run packages/water/test/caustics.browser.mjs through the shared GPU slot, once native and once with MARGO_COMPAT=1. The existing caustics checks now also attach Ripples before construction, remove it, and reattach with a 0.4 m impulse; all maps must remain finite, flux must change, and validation must be empty. Existing numerical bars remain unchanged.

### Batch 203 job 4 AVIF

Run cargo test --offline --locked --manifest-path packages/decoders/native/avif/Cargo.toml; node packages/decoders/native/avif/tests/pixels.mjs; node packages/decoders/native/avif/tests/wasm-pixels.mjs; node packages/decoders/native/avif/tests/wasm-transform.mjs. The frozen pixel references require no installed external codec. After the package build, node --test packages/decoders/tests/avif.test.js checks workers and container RGB references. Every command needs the lane's hard timeout wrapper. Run packages/decoders/tests/avif-browser.mjs through the shared GPU lock; it checks both backends. Package test:browser checks the production consumer emits and loads the AVIF worker/Wasm assets separately. No README check or full verify is a lane gate.

Independent reference capture used Chromium 157.0.4341.42 software VideoDecoder/ImageDecoder and FFmpeg/libdav1d through PyAV 19.0.2. The browser cannot expose raw 12-bit monochrome; its BGRX was rejected, and libdav1d supplies that full-precision reference instead. Container references pin Pillow 13.0.0/libavif 1.4.2, with explicit crop/orientation; kimono uses full-precision centered BT.2020 swscale instead of the approximating fast RGB path. Source revisions, input/output hashes, tool coverage and licenses are committed alongside the fixtures. Software reference tooling is development-only and not a runtime dependency.


### Batch 181 GPU picking

Build packages. CPU: node --test --test-timeout=120000 packages/sciviz/tests/pick-gpu*.test.js. GPU, one shared slot: node scripts/gpu-lock.mjs run --owner=codex-batch181 --max=4 --wait-max=60 -- node packages/sciviz/scripts/browser-root.mjs tests/pick-gpu-browser.mjs. This opens both backends, compares against CPU points/cells and an independent binary16/trilinear CT ray, tests IDs above 24 bits, async hover and restore, then opens examples/sciviz-pick-gpu.html and its backend=webgl2 variant. Source/licence records are examples/assets/sciviz/stars.json and clip/source.json. Results: test-results/batch181-j3-picking.json and batch181-j3-demo-*.png. No benchmark or timing-only assertion runs.
