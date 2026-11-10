# Engine architecture and quality reference

## Batch 258 preview GL world panels (section 5 supplement)

The optional ui/world-gl entry draws flat world panels on core's preview GL backend, using GlUiPainter into a framebuffer and an owned quad pass. It retains ordinary WorldPanel objects, existing ray/controller behavior and the original WebGPU implementation. Textures are repainted only when the UI draw-list version changes, with a complete mip chain. The pass restores program/VAO/buffer, framebuffer, viewport/scissor, colour/depth/blend state, texture/sampler bindings and pixel-unpack state. A foreign-state browser probe preserves real pixels and exact restoration, with no GL or GPU validation errors. Removal/re-addition releases and rebuilds panel resources. Native and complete compatibility each exercise both backend choices. Hardware XR, context-loss stress and oblique-filter polish remain unclaimed follow-ups. No benchmark was run; core and stage source is untouched.

## Batch 258 forms evidence (section 5 supplement)

The forms entry composes existing UI widgets, native text input and the normal GPU draw list. It adds no core or stage code. CPU regressions cover disabled choices, one tab stop per choice strip, content ownership, exact colour values, native hex editing, modal reconciliation and native versus div key activation. The browser gate exercises pointer, keyboard, gamepad commands and actual accessibility-tree attributes on native WebGPU and complete compatibility. The shared mirror now defers native DOM focus until a canvas pointer press ends. Existing UI, input, image, world and dependent React GPU suites remain the compatibility gate; no benchmark is run.

## Batch 258 image evidence (section 5 supplement)

Optional ui/image adds pixel textures, atlas cells, nine-slice borders and fit geometry. UI's shared batch maps image commands to existing colour quad instances, with premultiplied gutters and the original command order and clip stack. No core or stage change. Browser correctness checks read corner/cell/fit pixels, a real CC0 photographic texture, tint and exact zero uploads on an unchanged image-only second frame. They run under native WebGPU and complete compatibility, each also checking preview GL. CPU tests cover geometry, small targets, gutter bounds and immutable snapshots. Both GPU and preview caches record placeholder generations after binding, preventing an unnecessary image-only reupload. No wall-clock benchmark was run.

### Section 5 evidence: compatibility compute validation

Batch 273 failure 18 belongs to compatibility pipeline creation. Count resources
across compute-visible layouts before planning or executing a CPU or GPU route.
The five compute-limits regressions cover boundary and overflow cases and async
render/compute error identity. The unchanged shader readback GPU leaf passes
natively and on full compat: 4,194,304 exact u32 values, recovery, abort, disposal
and device loss. This does not close other package parity or hardware-tier gaps.
Core and stage stay unchanged at 23,950 B combined gzip. Research and reproduction
are in `docs/clean-room.md` and `docs/whitepaper/reproduce.md`.

### Section 5 evidence: verify cache settlement

After the build prints sizes and the catalog, verify settles the shadow result
cache before launching its parallel checks. It merges recorded inputs, hashes
and packs package outputs, publishes passes and enforces the archive cap. This
is parent-process work, so an empty child-process list does not imply a hang.
Verify now names that work before it begins. Previously every newly packed
package synchronously statted and sorted the entire archive directory.

Windows directory enumeration already returns sizes and timestamps, which
Node's Dirent omits. `scripts/support/archive-metadata.ps1` reads those fields
through the system .NET runtime, avoiding a separate native metadata lookup per
archive. Every insertion still takes a fresh inventory and enforces the same
cap. Node's listing supplies tie order; links/directories and disappeared
entries retain the stat path, and other platforms use the original stat scan.
The helper has a hard 60-second limit and propagates errors. Sorting happens
only when deletion is necessary; archive writes, compression, keys, poisoning,
comparisons, retirement and checks are unchanged. No timestamps are memoized.

`tests/result-cache.test.js` compares the former full-stat path with enumeration:
128 existing archives plus 12 outputs require 1,614 versus zero per-archive
stats under cap, and 1,548 versus zero at cap, with identical retained names
and bytes and zero archive-content bytes read by eviction. Both paths perform
12 Node listings; Windows also performs 12 native metadata enumerations.
Further fixtures cover shared touches/additions/removals, backwards timestamps,
per-write eviction, ties and recreated keys. `tests/archive-metadata.test.js`
matches stat metadata, fractional/pre-epoch times, Unicode paths, directories,
disappearances and helper failures.
`tests/verify-cache-progress.test.js` requires the progress line before work.
These deterministic regressions run in verify, hence check:merge. No elapsed
speed result is claimed; every inventory still scales with archive count and
uses a short system helper process on Windows. Sources are in `docs/clean-room.md`.

Validation: the single full verify passes 14,233 tests with zero failures/skips
and no cache disagreements. The final expanded focused suite passes 42/42.
Lint and hygiene pass (the initial standalone hygiene required rebuilding stale
worktree declarations). A read-only inventory of the live shared store reports
59,914 archives and zero per-file stat calls on the native path. Cache counts
can change as other lanes write; deterministic fixtures supply the comparison.

## Batch 258 input evidence (section 5 supplement)

TextInput and TextArea use the existing Ui draw commands for background,
selection, text and caret. They introduce no GPU pipeline, math, core or stage
change. Their optional DOM bridge keeps native editing controls and only
mirrors state into those draw commands; imports of the UI root do not load it.
The registered ui/test:browser:input gate exercises actual rendered pixels,
canvas pointer focus, selection/undo, clipboard, Tab, multiline and browser
IME through DevTools Input. Run it natively and with --compat under one shared
GPU slot. CPU tests cover deterministic state, password masking, composition
and cleanup. Pixel evidence is correctness evidence, not a speed measurement;
human screen-reader and mobile OS input-method testing remains unmeasured.

### Batch 133 land-only validation

The optional native decoder retains the default prebuilts and its existing
Rust/Wasm output. Lint and hygiene pass. One full verify stopped at a missing
upstream animator receipt; the mainline receipt repair unblocks documentation.
Its interrupted parallel chains were resumed, with all non-unit chains passing.
The unit run completed 14,140 tests: 14,136 pass, four fail, zero skips. Three
viewcube stand-in ownership failures are repaired by main d15e46fd2; the fourth
is the lazy table registration order repaired here. Current-base focused checks
pass 33 viewcube/browser-source cases and all nine size-page cases.

Decoder, glTF and glTF-pro CPU checks pass. The decoder browser/production
consumer, actual Node glTF rendering, glTF browser and glTF-pro material GPU
checks pass. All 21 decoder/umbrella runtime README examples pass, including
the final rebased build. Every GPU step uses one shared slot and wait-max 60;
no speed campaign or exclusive hold runs. Genuine entry/network records share
the same clean package revision; core plus stage is 23,950 B after the inherited
mainline unit-light repair. The native
Wasm remains 122,685 raw / 47,360 gzip bytes. Full/default replacement, warm
losses and remaining feature inventory remain open. Evidence and log hashes:
[landing receipt](../whitepaper/results/batch-133-landing.json).

The final rebase inherits main's uniform-only light normalization repair, with
no owned core/stage edits. Its 22 core/viewcube cases and the complete glTF-pro
CPU suite pass. The glTF-pro material GPU and README checks are refreshed for
that shader change; the native decoder source and artifact remain unchanged.

Final batch 171 job 3 integration: genuine entry/network records both name da96932cb, packages clean.
The latest-main rebase preserves all concurrent work. Sciviz/geometry/compute/math/core source is identical
to the accepted source; the affected 203 CPU checks, root GPU checks, 16 entry parity comparisons, four
NOAA wind-path layouts/backends and all 25 README runtime examples pass on the combined build. API,
lint, hygiene and size gates pass. Sizes remain tubes 2533, grids 23735, maths 5703, root 50599, LIC
23461 and core/stage 23924 B gzip. The single full verify remains 14012 tests, 14010 passed, with both
metadata failures corrected and all seven affected checks passing; it was not repeated. The exact LIC
+13032 B required-colormap attribution is reproduced again on this source. Earlier checkpoints below
retain their historical scope. See the batch-171-tubes-validation.json receipt in whitepaper/results.

## Report24 verification and residual evidence

The full verify ran once:14,081/14,084 unit tests passed, with only3 failures
from viewcube's stale engine fixture missing sceneOf. Its fixture now follows
plugin identity, retaining all assertions and adding a disposal regression;
all19 affected tests, viewcube GPU and README examples pass. Other verify
steps passed and were retained. The full verify was not duplicated.
The173-pair memory campaign preserves64 pairs before a build/dist race, then
resumes only missing pairs after the build dependency. All scalar hashes and
Wasm bars pass;2 RSS losses remain. This is not final replacement acceptance.


## Owned decompression storage evidence (section 5 continuation)

The shared Zstd decoder supports bounded caller-owned output. The destination
identity, allocation-size and canary regression plus malformed/abort/detached
cases run in the ordinary decoders test glob, hence in verify and check:merge.
Existing allocating Zstd tests remain unchanged. A private Basis range ABI
checks offsets against its owned input Vec; no unchecked caller pointer is
accepted. It retains the allocation through yielded inflation and disposal.
These private changes are not public loader/worker or all-format acceptance.
The original173 retained-output memory pairs have been remeasured;2 RSS
losses remain. Further storage changes need the same proof before closing
those losses. GPU ETC2/EAC proof remains absent on RTX A6000.


### Section 5 evidence: batch 133 lazy catalog ordering

The native worker and Wasm registrations now remain in the decoder row group.
The new contiguity regression and unchanged exact table identities fail before
repair; all nine size-page tests pass. verify and check:merge include the guard.
No runtime asset, table behavior, measurement or tolerance changes.

### Section 5 evidence: batch 133 browser source parsing

The package CPU gate parses every non-test JavaScript fixture/support module
before GPU execution. Its regression rejects the duplicate optional Draco/HDR
lexical binding and passes after a Draco-only rename. verify includes it, so
check:merge covers this class without a GPU hold. No engine source, rendering
math, deadline or tolerance changes. Research is recorded in clean-room.md.

The same parser gate enforces literal fixture asset URLs for Vite. It rejects
the nested dynamic path that produced tests/undefined and sixteen empty jobs;
the explicit fixture root preserves the real inputs. Both regression bars fail before
their respective repairs. Production decoder and worker sources are unchanged.

### Section 5 evidence: batch 134 current-Wasm bounded campaigns

[Corpus, hostile input, uploads and memory](../whitepaper/results/batch-134-corpus-uploads-memory.json)
pin the scalar-approved combined Wasm. All 51 primary seeds retain their
historical target controls through 17,908 decode calls / 2,856 mutations;
new scalar-target probes add 32,784 direct ABI and 628 authored-container
calls. Real RTX A6000 WebGPU round-trips all 1,296 BC4/BC5 image payloads
exactly with no validation errors. It lacks ETC2/EAC capability; those 993
images still need hardware proof. Transport is not sampled-pixel acceptance.

The native harness retains the GPU via the existing installGPU lifetime
owner through completion; an earlier harness lost that native context during
collection and terminated mid-corpus. One shared GPU slot, only actual copy/
readback commands, wait-max60; no CPU memory or fuzz command holds the lock.
Memory's 173 fresh-process pairs retain identical image/byte work counts:
all Wasm high-water bars pass but 25 process-RSS bars fail. The TS adapter's
materialized Zstd level plus Wasm copy is extra storage. The same-payload
normalization control supports this diagnosis without modifying runtime
policy. Final public API, other targets, full fuzz/GPU/memory/entry remain open.

### Section 5 evidence: completed scientific tube/ribbon acceptance

Batch 171 job 3 acceptance: 14,012 tests in the single full verify, 14,010 passed;
two metadata failures repaired (help catalogue and generated notices); all seven affected checks pass.
190 sciviz/site CPU tests, all six sciviz GPU suites and all 25 README runtime examples pass.
The 16 entry parity cases include zero pixel differences and exact actual-device restoration for tubes
and ribbons (3793/3890 lit pixels). All 40 demo/layout/backend cases pass, including the four NOAA
wind-path layouts/backends. Fresh genuine entry/network records both identify c333a7390, packages
clean. /tubes 2533 B, /grids 23735 B, /maths 5703 B, root 50599 B, LIC 23461 B; core/stage 23924 B.
The analytical sink and real NOAA regressions fail old fields.ts and pass the root repair. Numerical
termination/geometry/native-backend limits stay explicit; no speed claim. Earlier job 3 checkpoint
paragraphs and their then-open repros below are historical, superseded by this acceptance.
[Full receipt](../whitepaper/results/batch-171-tubes-validation.json).

### Section 5 evidence: critical-point tracer and LIC dependency audit

The new analytical sink and unchanged NOAA tests fail old fields.ts and pass the adaptive RK4 repair;
all 190 current sciviz/site CPU cases pass. Independent circle/saddle invariants retain true orbits and
near-critical passages. Existing check:merge unit discovery includes the regression. This is CPU numerical
correctness, without changed GPU maths or new renderer. Numerical policies/limits: sciviz README and
limits.md; research: clean-room.md. LIC dependency attribution proves exactly +13,032 B from required
shared published-precision colour data/lookup, with identical bundler/gzip; no unrelated renderers retained.


### Section 5 evidence: batch 134 scalar reference ruling

Scoped scalar quality now passes 98/98 BC4/BC5 pairs (1,296 images),
52/52 EAC R11/RG11 pairs (690 images), and 23/23 ETC2-alpha pairs (303 images).
All 2,289 old source controls, 1,296 normative RGBA controls and 2,289 new
payload rehashes pass. BC4/BC5 output/source numbers equal report16 exactly;
all 993 ETC2/EAC output hashes and source numbers equal report21 exactly.
The original-source losses remain 14 BC4/BC5, 26 RG11 and one ETC2 pair.

Scott's written 2026-11-09 "Do recommend" ruling requires per-file SSE against
the spec-defined ETC1S/UASTC payload RGBA8 decode, new <= prebuilt on every
one of 98 BC4/BC5 pairs, zero tolerance and exact old controls. EAC R11/RG11
and ETC2 scalar alpha use the same rule and existing output channels. EAC
keeps 11-bit reconstruction: integer numerator SSE / 2047 squared, aggregated
with BigInt, never byte-rounded. Original-source floating arithmetic, image
order and all original losses remain published in the
[full evidence](../whitepaper/results/batch-134-scalar-payload-bar.json).

The report-16 byte objective is restored; the rejected latent model is
archived. Two wiring regressions fail on preserved report-21 source and pass
on the candidate. Existing exhaustive byte/header oracles remain unchanged.
New public metric regressions cover channel mapping, a one-unit loss and
exact EAC totals beyond Number's safe integer range. This scoped quality
proof does not close remaining-target/API/fuzz/GPU/memory/entry acceptance.
No timing A/B, benchmark or timing assertion; speed-phase debt stays open.
Earlier experiment descriptions retain their historical scope.

### Section 5 evidence: scientific tube/ribbon CPU foundation

The /tubes adapter uses existing optional geometry sweeps and transported frames; core/stage and shaders
are untouched. Analytical cone normals/scalar radius, exact nodal and partial vorticity integrals, unequal
arc intervals, cap scalar ownership, inflection continuity, periodic seam normals and failure/cancellation
checks pass in Node. Existing meshLayer constructor/publication ownership failures are independently
reproduced before repair and pass afterward. No GPU, real-data demo or complete job 3 acceptance is claimed
at this checkpoint. Sources and integration choice: clean-room.md, batch 171 job 3.


### Section 5 evidence: batch 134 rejected rational-source hypothesis

The private scalar experiment completely optimizes rational source estimates
while enforcing the original visible-byte bound. Native 59 and scalar Node 4
tests pass, including 128 independent rational endpoint oracles alongside the
unchanged 4,096 byte-objective oracles. The corpus rejects the source model:
77/98 pairs pass, 21 fail. All 1,296 old controls and both bars remain
unchanged. New payloads, unchanged RGBA reconstructions and per-channel
source-interaction terms are retained in the same campaign so follow-up
diagnostics need no repeated transcode. [Evidence](../whitepaper/results/batch-134-scalar-rational.json).
This is a negative research checkpoint, not a shipped quality improvement.
Public integration, all-target/fuzz/new-Wasm GPU/peak-memory/entry acceptance
and deferred timing remain open.

## README live-link lifecycle (section 5 evidence, 2026-11-10)

The runner supplies Blender's documented continuing example with native SSE
and a real exported model through its own HTTP service. It drives pagehide
only after model attachment and framing, then requires module completion and
observed model/node/event-source cleanup within the unchanged 20 s deadline.
Observers preserve real calls, returns and exceptions, including idempotent
re-entry during plugin disposal. No package or renderer changed. CPU regression
and the real WebGPU README run are described in `docs/readme-live.md`.

## Shared codec diagnostic restoration (section 5 evidence, 2026-11-10)

Shared inflate and GLB validation retain complete, linked failure details in
their owning optional entries. Caller byte limits are policy failures with
counts and repair hints, not proof of damage. The RFC fixed distance alphabet
includes the two reserved symbols solely to diagnose their rejection correctly.
Core plus stage stays 23924 B; optional ceiling increases, measurements and their
tradeoff are recorded together in `docs/limits.md`. No timing runs, quality
reductions or artificial diagnostic entry split. Numeric and container fixtures,
retained node:zlib parity tests and sciviz policy tests are described and sourced
in `docs/size-restore.md`.

### Section 5 evidence: batch 134 complete scalar search and valid extents

The private scalar draft now checks every potentially improving legal endpoint
pair using integer interval rejection and fits partial image blocks only to
their visible texels. A complete independent byte-pair oracle and a padding
invariance regression expose both previous defects. Native 56 and scalar Node
4 tests pass. Complete endpoint fitting is a reconstruction-objective result,
not original-source quality acceptance. Both original-source bars still apply
to all 98 pairs and 1,296 images; their full results and source/Wasm pins are in
the [checkpoint](../whitepaper/results/batch-134-scalar-exact-edge.json).
Remaining encoders, public integration, full fuzz, peak-memory/final-entry
acceptance and job 4 timing remain open. No prebuilt removal or completed job 2.

### Section 5 evidence: batch 134 scalar refinement

Private BC4/BC5 both-mode endpoint fitting and extrema-slot seeds pass the new
failing-before six-value and unused-endpoint regressions. A deterministic
512-block property preserves the original min/max reconstruction SSE and
per-texel quantization bound. All 1,296 old payload/source controls and frozen
totals reproduce exactly; 86/98 original-source pairs pass and 12 still fail.
Every remaining failure has lower reconstructed-input SSE than old, which is
diagnostic only. Full source-quality acceptance, remaining encoders, public
integration, complete fuzz, GPU/peak-memory/final-entry gates remain open.
Timing stays deferred. No prebuilt removal or job 2/3 completion.
[Scoped result](../whitepaper/results/batch-134-scalar-refinement.json).

### Section 5 evidence: owned termination and pipe release

The browser owner now releases stdio/CDP pipes after requesting termination and
before awaiting completion, removing a circular dependency on pending I/O.
`tests/browser-teardown.test.js` includes a controlled stop promise that cannot
complete until those pipes are released; it fails before the repair. All 42
teardown, shutdown and page-ready tests pass afterward. The initial full verify
passed 13,665 tests and failed only page-ready cleanup. Successful checks are
retained; the failed test is revalidated after the repair. Its original native
phase was not observed, so the controlled wait defect is the precise claim.
Process listing still precedes client disconnect and driver cleanup still waits
for process close. Every existing shutdown bound remains unchanged.
## Batch 56 continuation evidence (section 5, 2026-11-09)

On current main plus the local batch repairs, review56 passes both backends:
six exact viewport/scissor comparisons, two deliberate unscoped leak controls,
three owning-scene captures and every finite studio cube component. Fog-all
passes 87 checks; all 16 environment README programs execute. Fog's historical
unfogged-image baselines are absent, so no old-build identity is claimed.
The HDR gate initially rejected a vertical camera because its fixture supplied
up as a constructor option. The fixture now assigns camera.up and retains the
real HDR/model, radiance alignment, rotated centroid and exact-return assertions.
Research and the fixture/owner repairs are recorded in clean-room.md.

ComputePass, ScenePass and RawShaders have additional owning-scene regressions.
Their package/GPU/README gates and the wider lifecycle audit must finish before
acceptance. Capture stability is assigned to the separate capture-msaa-hunt
branch; this continuation neither changes nor clears that regression. No push.

The source inventory is retained in
[the wider owner audit](../work-lists/batch-56-scene-owners.md): 181 actual calls,
including 118 registration-review candidates in 46 packages. It also scans
explicit EnginePlugin disposal methods to catch missing calls. This remains
open; syntactic inventory is not a substitute for per-owner runtime proof.

Optional TAA upscale now measures 7,112 B against a 7,093 B ceiling (previous
recorded size 7,079 B). Scott's optional-package exception permits a 19 B ceiling
increase while retaining source-camera, scene-identity and preview diagnostics.
The root budget stays 23,924 B under 25,000 B; shader entry ceilings are unchanged.
The quality rerun is scoped to the failed size gate after this recorded change.

The reset-interrupted DOF comparison subsequently passes after confirmed driver
recovery, retaining all original pixel/extent bounds; the reset/OOM log remains.
Staging and TAA GPU suites pass, including native/compatibility HDR shadows and
idle convergence. Their 20 runtime README examples pass. Post, DOF, tonemap,
creative, cameras and shader GPU suites pass; their 84 runtime README examples
pass. Creative's paint resource host now supplies the unregistered sceneOf
contract and keeps all 20,528 comparisons and real device replacement. The new
shader owner GPU proof passes native and compatibility dispatch/target/pixel
checks. Terrain's four provider repairs pass 93 units and the shared class guard;
their full GPU/README command sequence is queued, not accepted.

## Optional labels diagnostic restoration (section 5 evidence, 2026-11-10)

The duplicate-attachment state diagnostic keeps full repair guidance and MargoError
identity. The optional root measured 5450 to 5550 B gzip; its ceiling increases
5546 to 5806 B with the normal 256 B headroom. No split of the synchronous attach
path is needed. Core plus stage remains 23924 B below 25000 B. Evidence: the
default/custom-name regression in `packages/labels/tests/testpage-attach.test.js`,
all 49 package tests, both browser backends and six runnable README examples.
Sources and rationale: `docs/size-restore.md`. No speed claim or changed quality bar.

## Owned Chromium process-list ordering (section 5 supplement, 2026-11-09)

Client close must follow the owned browser's bounded CDP process-list read.
Previously those operations raced, so a healthy session could be disconnected
before its reply and cleanup entered the helper fallback. The retained process
list is now passed to native termination; client cleanup and termination still
run concurrently after that read. Deterministic coverage in
`tests/browser-teardown.test.js` fails on the parent and checks one list request,
list-before-disconnect and native-end-before-driver-kill. All 56 scoped browser
selection, teardown and shutdown tests pass. All nine voxel GPU suites and the
decoder browser, decoder Node/glTF and glTF GPU gates pass after the repair.
The voxel README gate passes with its unchanged five known failures (18 of 23
examples successful). No shutdown deadline, rendering assertion or performance
budget was relaxed. The full verify run found only an excluded-workspace link
in the GPU coordination report; its existing regression guards that repair.

## Build-phase speed deferral (section 5 supplement)

Scott's 2026-11-10 ruling defers benchmarks, paired wall-clock A/B measurements
and timing-only assertions until everything is built. `scripts/speed-phase.json`
is the single checked-in default (`deferred`). No gate enables speed work.
Verify, check:merge, check:readme-run and the GPU package runner print the phase.
The three shared GPU slots remain available for correctness. Classified timing
CLI requests are refused and logged before creating a child, holder or ticket;
direct exclusive GPU APIs refuse with `ERR_SPEED_PHASE_DEFERRED`. The only build-
phase exception is an exact, unexpired entry in `scripts/gpu-exclusive-allow.json`
(command, reason, approvedBy, expiry). Only the coordinator adds entries, with
Scott's OK; this change adds none. Approved uses are logged and retain the hold
cap. Incorrect
exclusive requests still fail the independent timing-purpose check.

The named `npm run test:speed` suite retains the budgets in
`scripts/speed/budgets.mjs`, speed test registrations and standalone drivers,
listed in [the release inventory](../work-lists/speed-phase.md). Mixed CPU files
still check values, geometry, errors, allocations and work counts. Pure speed
callbacks are registered only in the active speed phase, with explicit deferral
output rather than skipped tests or passing substitute numbers. Repeated EXR,
USDZ and polygon comparisons do no timing work in the build phase. The million-
voxel paste scene keeps its equality checks in correctness without best-of rounds.

Biome flythrough and object-camera correctness use shared holds. Separate
`flythrough-speed.mjs` and `objects-frame-speed.mjs` retain the original speed
scenes, sampling, baselines and assertions under short exclusive holds. The
flythrough's worker scheduling, send/copy counts, clock monotonicity and GPU
validation stay in correctness. Visual compatibility's 50 ms timing-only step
defers while the pixel comparison still runs. Quickstart keeps all pixel and
interaction checks and moves its unchanged 300 s default speed assertion to the
named budget suite. Clock behavior, readiness deadlines, timeout/teardown safety,
deterministic byte/allocation/draw/triangle/pass counts, and local CI per-commit
duration history with its 1.5x jump flag are retained.

After Scott ends the build phase, set `MARGO_SPEED_PHASE=active` on a quiet
machine and run `npm run test:speed`. Commands run one at a time with hard
process-tree limits; direct benchmark and `--timing` entries read the same phase.
Every listed scene and budget must pass before release, as must busy-retests.
The phase is not permission to weaken a budget, change a scene or publish busy-
machine speed numbers. External rival fixtures remain outside this repository.

Evidence: `tests/speed-phase.test.js` uses fabricated readings and fake lock
folders to prove unchanged boundary failures, deferred comparison callbacks,
and no child/holder/ticket creation. GPU planning tests pin separate shared and
exclusive drivers; the lock/queue tests use CPU-only fixtures. No GPU speed run
or new speed claim is part of this change. The queue uses the common process
limiter, so affected-step closure now selects views/depth when that limiter changes;
the regression checks both the dependency and the selected checks.

## Moving-flow transport (batch 171, section 5 supplement)

The gate also exposed a CPU scheduler junction-observation race. The backing target is now read once before
PID/token validation; an absent/non-link name is not reclaimable. Live-owner and permission failures retain
their previous semantics. [Mutex target evidence](../quality/gpu-mutex-target.md) records the regression.

The optional flow entry now also holds GPU-resident RK4 particles and a fixed-size per-particle history ring.
Velocities/positions are normalised by domain widths, never by speed. Missing samples use a separate validity
component, with zero-weight spatial and temporal neighbours ignored. A dispatch owns one particle; four RK stages
and the accepted endpoint sample share linear space/time interpolation. CPU partitions time at frame kinks/end.
There is no position readback in advance/draw. Generation tags cut trail segments at respawn. Age fades
quadratically over the retained ring; square heads remain visible in zero flow. Buffer limits are checked before
allocation (128 MiB/device limits), replay is bounded by maxSteps, and cancellation retains submitted substeps.
Device replacement reuploads immutable copies and replays exactly those partitions. Scoped ownership rejects
overlapping advances and invalidates an in-flight caller on replacement/disposal.

CPU streaklines reuse one feature-local Wasm instance and copied field for all releases, retaining only endpoints
at the common observation time. Invalid/unfinished releases are NaN gaps with explicit stop reasons.
Transparent flow sorting transforms the data-bound midpoint, including offset grids; returning only the model
translation sorts the transformed data origin instead. The offset-grid browser regression checks all three
world coordinates against an independent matrix calculation before removing the temporary layer's bounds.
`flow-seeds.test.js` checks layout semantics, release-time analytics and one-instantiation work counts.
The `flow-motion` browser case checks 2D/3D steady/unsteady GPU arithmetic against the float64 reference within
0.0002 distance units on its analytic fields, respawn, missing data, cancellation and exact replay pixels.
WebGPU/WebGL2 compatibility all-pixel parity passes with unchanged thresholds. The official NOAA moving-wind
demo passes at 390/1440 pixels on both backends, including all seed layouts, playback and export. Native
WebGL2 flow is still pending with batch 181. No universal float bound, speed or observational-accuracy claim.

Optional `/flow` loads its own `flow.wasm` from `sciviz/flow-kernel`. Spatial/temporal interpolation feeds
classical RK4 with physical velocity and steps shortened at frame kinks. One reservation holds component copies,
metadata and 128-step scratch; no kernel allocator or shared mutable instance. TypeScript owns validation, task
yields, cancellation and output copies. Analytic constant/temporal/3D rotation tests, missing samples, backwards
tracing, chunk boundaries and the existing NOAA daily means supply CPU evidence. No speed or adaptive-error
claim. Core/stage are untouched.
The merge gate now discovers every immediate `kernel`/`*-kernel` crate in a workspace, rather than only the first
conventional manifest. `tests/rust-kernel-tests.test.js` checks both sciviz feature crates and package deduplication.
The focused `flow-pathline` entry case fetches the feature-local Wasm in a real browser, checks every xyzt sample
against x(t)=t^2, y(t)=t, draws the path and preserves every pixel after device replacement, on WebGPU and
WebGL2 compatibility. The existing all-pixel parity bounds pass with 1,517 lit pixels. This proves the CPU
reference's browser/line integration, not GPU particle advection or the pending native WebGL2 line path.
The new README example passes in Node. Both feature crates and 19 focused CPU/kernel-runner tests pass;
lint, hygiene and all five quality gates pass. Only the failed size-page prerequisite is rerun, with both
size/network records regenerated together after registering flow.wasm. No prior successful gate is retried
without a changed dependency, and no core/stage implementation or assertion bound changes.

## Native WebGL2 current-program lifetime (batch 181, section 5 supplement)

The native sciviz reboot diagnostic found a preview renderer ownership defect: deleting the current program
kept a flagged binding alive until a plugin switched programs, at which point its saved binding became invalid.
Preview restore and disposal now unbind their own current program before deletion, preserving foreign programs.
`packages/webgl2-compat/test/preview-webgl.test.js` fails before the repair and checks both paths and foreign
state preservation. `packages/sciviz/tests/webgl2-browser.js` checks NO_ERROR immediately after every reboot,
upload and draw. The real-context gate passes after main's teardown repair; the optional ceilings now follow
Scott's ruling, and the native piece is on main through 6a09f480f.
The CPU test models the specification's marked-object rebinding error and checks owned, foreign and null
bindings after both operations. No core or stage implementation changes are needed.

## Browser shutdown evidence (batch 160, section 5 supplement)

The Windows browser owner distinguishes native process exit from ChildProcess
close. After native termination succeeds, it releases stdout, stderr and both
CDP pipes and awaits a close event latched at launch before driver cleanup. The
four-pipe regression fails under the previous ordering. Native handle waits
check process creation time before polling, with a live replacement-process
regression for PID reuse. These repairs retain the 30,000 ms shutdown budget.
The root catalog and browser launcher tests exercise the shared owner; this
change adds no rendering capability and does not change core or stage.

### Owned Chromium ended without helper programs (section 5, 2026-11-09)

Symptom: GPU suites in five lanes passed every check, then failed with
`SHUTDOWN_TIMEOUT`, "still open: browser", at the unchanged 30,000 ms budget
(for example sciviz: 30 checks, then 46.5 s in all). The pipe repair above did
not stop it.

Cause: the owned browser was ended by two programs started at close time.
`taskkill.exe` builds the tree from WMI (its binary holds the `Win32_Process`
and `ParentProcessId` queries; it takes 0.65 to 1.6 s per call on this PC when
idle), then a Windows PowerShell waits for the handles. Its result was read
from its output lines only, so a taskkill that did not start, ran out of time
or failed in WMI reported "no process ended", which read as "nothing left".
Nothing then ended the browser, and the close waited for an exit that only
Chromium's own starved shutdown could give (68 to 146 s under load, above).
The helper wait also had the whole 30 s budget, so its own "Chromium processes
did not exit" error could never be reported first. The failures clustered in
windows when helper programs were failing on this PC: Windows Error Reporting
holds powershell.exe console-host crashes (`ConsoleControl` static
constructor) in groups of four at the same seconds as GPU driver resets
(LiveKernelEvent 141, eight groups on 2026-11-09), and the WMI log holds
failed `Win32_Process` enumerations (0x80041032, 0x800706BE). No failing run
was traced phase by phase: eight traced sciviz runs and the CPU loops passed
(close 1.1 to 1.9 s), so the chain above is shown by these records and by the
deterministic regressions, not by a captured hang.

Fix (`scripts/lib/browser.mjs`, `stopOwned`): the browser process is ended
through the handle Node holds (`ChildProcess.kill`, TerminateProcess), and
each process Chromium lists for itself over CDP (`SystemInfo.getProcessInfo`)
by its pid, then the close waits for the listed processes to exit and for the
browser's `close` event. Process termination uses no helper program; the
Windows child-exit wait now uses the existing creation-time-aware native waiter. Measured on this PC: killing
only the browser process left two Edge utility processes
(`entity_extraction_service`, `edge_collections`) running past 10 s, so the
listed children are ended explicitly; with them, the whole tree, crashpad
included, was gone in 50 to 285 ms (with a live WebGPU device). Only a browser
that does not list its processes within 5,000 ms (`LIST_PROCESSES_MS`) takes
the old taskkill route, and its browser process is still ended through its
handle afterwards. `taskkillTree` now returns the root pid when taskkill could
not run, so `endTree` waits for and reports it instead of returning success.

Regressions (`tests/browser-teardown.test.js`): with the helper route reporting
nothing, as it did, a fake owned browser and a real child process with five
pipes both reach `SHUTDOWN_TIMEOUT` "still open: browser" on the parent commit
and close at once with the fix; `stopOwned` ends listed children without a
helper and falls back only when the list never comes; the taskkill failure
modes return the root pid; the existing real-browser test checks every listed
process has exited after the close. The 30,000 ms budget is unchanged. Not
measured: a capture of the original hang, other Windows PCs, and GPU resets
during a close (a process held in the kernel by a reset still has to exit).

Sources: Microsoft, [TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)
(asynchronous; a process exits once pending I/O completes; wait on its handle);
Raymond Chen, [Why do some processes stay in Task Manager after they have been killed?](https://devblogs.microsoft.com/oldnewthing/?p=102303)
and [Why can't I delete a file immediately after terminating the process?](https://devblogs.microsoft.com/oldnewthing/20120329-00/?p=7973);
Node.js [child_process](https://nodejs.org/api/child_process.html) (`close`
after stdio ends, `exit` before it; `subprocess.kill`); Playwright
[BrowserServer](https://playwright.dev/docs/api/class-browserserver) and
[Browser.close](https://playwright.dev/docs/api/class-browser) for a connected
client; issue reports of taskkill.exe exhausting WMI on Windows desktops
([openai/codex 34260](https://upd.dev/openai/codex/issues/34260)); libuv's
Windows grandchild pipe inheritance discussion ([libuv PR 343](https://github.com/joyent/libuv/pull/343)).
Only documentation and issue text were read, no other project's source.

## GPU exclusive class check (section 5 supplement)

Verify runs `node scripts/check-gpu-policy.mjs` before the package build. It checks
tracked production JavaScript/TypeScript launchers and package scripts for
exclusive CLI flags, enabled `MARGO_GPU_EXCLUSIVE` settings and calls through
imported `acquire` aliases. Requests must be benchmark-classified or belong to
the checked-in speed inventory; CLI callers may state a logged `--timing` reason.
Only the lock/queue implementation, synthetic unit fixtures and historical
whitepaper result files are outside this production syntax check. Runtime
policy still applies to every caller, including historical reproduction scripts.
This is a syntax check, not whole-program evaluation of computed command strings;
runtime refusal remains the final check before any holder or ticket is created.

`tests/docs-encoding.test.js` rejects common UTF-8-as-single-byte artifacts in
the limits guide and generated LLM copy. Conflict resolution reads/writes UTF-8
explicitly; a valid UTF-8 round trip alone cannot catch already corrupted text.
Encoding reference: Unicode Consortium, *The Unicode Standard 17.0*, 2025,
[chapter 3, conformance and encoding forms](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-3/).

Evidence: `tests/gpu-policy-check.test.js` plants CLI, environment and aliased API
regressions and exercises regex/interpolated-template scanning. The whole tracked
repository is checked without a GPU. `tests/check-merge-affected.test.js` pins the
new verify step. Research: Murugiah Souppaya, Karen Scarfone and Donna Dodson,
*Secure Software Development Framework (SSDF) Version 1.1*, NIST SP 800-218,
2022, [PW.7, source review and analysis](https://csrc.nist.gov/pubs/sp/800/218/final).
We combine an early static policy check with the reader/writer runtime admission
rules cited below; no companion implementation was read.

## GPU mutex ownership and scheduling research (section 5 supplement)

The GPU lock publishes its mutex as a directory junction on Windows (a directory
symlink elsewhere) to a unique, already populated owner directory. Publication
cannot replace an anonymous mutex held by a legacy client. A live PID is never
reclaimed just because its mutex aged. An independent worker refreshes that
directory every second while the owning JavaScript thread is paused, so older
reader/writer clients still see a fresh mutex. Anonymous legacy mutexes have no
proof of a dead owner and must be released by their owner; a bounded wait names
this condition with `ERR_GPU_MUTEX_WAIT_TIMEOUT`.

Dead-owner reclamation pins the unique backing path before claiming its owner
metadata. A delayed reclaimer therefore cannot rename a later live owner's
metadata through the reusable mutex name. Release still retires the mutex name
before deleting it, preserving the Windows delete-pending repair. Only the
claimed dead owner's backing directory is removed. No GPU holder/waiter format
changes and no engine package changes are involved.

Evidence: `tests/gpu-lock-owner.test.js` pauses a live requester at publication,
ages the mutex past the old ten-second cutoff, checks identity and exclusion,
then resumes it successfully. It also proves heartbeat renewal independently of
the blocked owning thread and safe waiting for an anonymous legacy mutex.
`tests/gpu-lock-integration.test.js` covers dead-owner recovery and a delayed
reclaimer racing a replacement live owner. The complete seven-file lock group
passes 50 CPU-only tests on isolated folders; no real GPU run is used. Dead
reclaimer recovery is included: a crashed metadata claimant does not strand the
mutex, and a live claimant is allowed to finish without interference.

Research guiding the remaining queue and phase work, read before implementation:

- [Mellor-Crummey and Scott, reader/writer synchronization (1991)](https://www.cs.rochester.edu/u/scott/papers/1991_PPoPP_read_write.pdf)
  distinguishes preference from fairness. Writer preference blocks incoming
  readers, explaining why an unnecessary exclusive waiter stalls free slots.
- [Their scalable synchronization paper (1991)](https://www.cs.rochester.edu/u/scott/papers/1991_TOCS_synch.pdf)
  motivates explicit ordered request state and reduced contention. Margo uses
  sleeping filesystem clients, not the paper's shared-memory spin algorithms.
- [Slurm GRES scheduling](https://slurm.schedmd.com/gres.html) separates counted
  GPU sharing from exclusive allocation; a slot is scheduling capacity rather
  than performance isolation. Margo's three correctness slots provide no speed
  measurement guarantee.
- [Bazel test execution and sharding](https://bazel.build/reference/test-encyclopedia)
  emphasizes hermetic resources and explicit shard support. Correctness and
  speed work need explicit suite ownership, with every deferred budget retained.

## Queue GPU gates early, keep working (section 5 supplement)

Push gates default to a 60-minute admission wait, including direct `acquire()`
and `run`. Correctness uses a shared slot. To reserve a place without blocking
the agent's CPU work, submit the actual bounded command early:

```powershell
node scripts/gpu-lock.mjs enqueue --owner=lane-G --wait-max=60 --max=20 -- node scripts/run-readme-examples.mjs
# Copy the ticket field from the JSON result. Continue independent CPU work.
node scripts/gpu-lock.mjs wait <ticket>
```

The detached owner queues and runs the command when a slot becomes available;
`wait` observes its result and prints its log. The command retains the submitter's
working directory, and logs stay in that worktree's `test-results/gpu-queue/`.
Waiting as an observer never surrenders a ticket. Its optional wait limit can
expire while the queued command continues; the same ticket can be observed
again. A default observer bound covers the command's admission wait plus hold
limit and one minute of shutdown allowance. The command itself retains its
independent hard limit and process-tree termination.

Section 5 evidence, queue observer exit ordering (2026-11-10): `wait` samples
owner liveness before reading the current immutable status revision. A running
snapshot taken before an owner publishes completion and exits cannot establish
`ERR_GPU_QUEUE_OWNER_GONE`. The ordered observation retains terminal command
output and exit status, still drains the owner, and still rejects an owner that
exits without publishing completion. `tests/gpu-queue-publication.test.js`
forces all three outcomes without sleeps or retries; its passed and failed
cases fail on the former reader. These CPU tests are included in verify and
therefore check:merge. The existing detached-failure test now includes stderr
in its output assertion diagnostic. The lane-S failure retained 17 command-log
bytes but did not retain wait stderr, so its exact exception is unavailable;
the deterministic regression proves the stale-status defect on current main.
Standalone current-main runs passed both normally and with verify's recorder.
No lock policy, deadline, assertion tolerance or engine package changes.
See [the research comparison](../clean-room.md#gpu-queue-observer-exit-ordering-2026-11-10).

Detached owner stdout and stderr persist in `<command log>.owner.log`, separately
from the command log. An owner exiting before admission reports
`ERR_GPU_QUEUE_OWNER_EXIT`, its exit/signal, log path and original stderr; only an
owner still running after the unchanged 30-second startup deadline is a startup
timeout. Initial ticket-read errors retain their original exception rather than
attempting to replace an unreadable ticket. Lane-C's 707.6 ms failure was on
7289abf3b, before the immutable publication repair b7af6646a: a Windows observer
could pin the status name and make replacement fail with EPERM. That root repair
and the retained bootstrap diagnostics are CPU-only regressions in
`tests/gpu-queue-publication.test.js`. The failed queue step passes with verify's
read recorder enabled; no second full verify or GPU run is needed for this repair.
Research: Microsoft, [Creating a Child Process with Redirected Input and Output](https://learn.microsoft.com/en-us/windows/win32/procthread/creating-a-child-process-with-redirected-input-and-output)
(2025 documentation), informs persistent inherited output handles. Gray and
Cheriton, [Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency](https://www.cs.cmu.edu/afs/cs.cmu.edu/academic/class/15712-s12/www/papers/gray89.pdf)
(1989), separates lease expiry from owner failure; our startup deadline does not
stand in for a child exit. No external implementation source was used.

Queue status is published as immutable numbered JSON revisions beside the initial
ticket record. An observer reads the newest published revision; old single-file
records still read as revision zero. A Windows reader can pin a published name,
so replacing that name with `rename` is unsafe: under verify's read recorder,
the fast failing-command test reproduced `EPERM` at replacement, and a second
failed replacement could end the owner before acknowledgement. New revisions
are renamed only to unused names, leaving every reader's previous record valid.
`tests/gpu-queue-publication.test.js` deterministically pins all published names
and fails on the former writer. The real detached-failure regression remains.
An owner that exits without publishing admission reports `ERR_GPU_QUEUE_OWNER_EXIT`,
including exit/signal details, separately from the unchanged 30-second deadline.
Research: Microsoft, [MoveFileExW function](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
and [CreateFileW function, sharing modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
(2026 documentation); immutable version publication avoids the sharing conflict
rather than retrying or hiding a refused replacement. Only status metadata
changes; shared/exclusive holder and FIFO lock entry formats stay unchanged.

Job 6 admission applies to `run` and `enqueue` before any ticket or holder is
created: CPU aggregators (verify, lint, hygiene, unit tests, builds, tsc and
shell wrappers) fail with `ERR_GPU_COMMAND_NOT_GPU`. GPU npm leaves
`test:gpu`, `test:browser`, `test:xr`, `check:readme-run`, and named GPU/browser/
pixel/capture/render/XR scripts are recognized. An unclassified GPU leaf needs
`--gpu=<reason>`, recorded in `gpu-lock-reasons.log`; that flag cannot override
a known CPU command. Imported GPU suites keep calling `acquire` themselves.

New holders and tickets record their canonical worktree and owner lane prefix.
At most one slot is held for either identity. Requests from an occupied lane
queue while unrelated eligible lanes fill the other two slots. FIFO applies
among eligible requests and within a lane; a blocked same-lane ticket does not
block unrelated work. Legacy entries still participate using their owner
prefix when present; an old client with no worktree metadata cannot enforce the
new rule itself. Nested acquisition in the same held lock remains a no-op.

An independent heartbeat samples the complete Windows WDDM GPU Engine raw
counter set and Win32_Process identities every 30 seconds, outside the mutex.
RunningTime and Timestamp_Sys100NS remain uint64 strings and are compared with
BigInt over the holder's process tree, retaining known descendants after an
intermediate exits. The provider has a 45-second hard limit and a 5-second
tree-kill bound. Missing providers, errors, empty/incomplete samples, counter
resets, PID reuse and gaps beyond 90 seconds reset the idle window to unknown.
By default, three minutes of stable complete samples with no increasing GPU counter trigger
an identity-confirming second observation, process-tree termination and an
`ERR_GPU_IDLE_RECLAIM` record in `gpu-lock-idle.log`. Only that lease token is
released after successful termination. Birth times use CIM's microsecond
representation, including the native termination check; handles stay open during
taskkill and the bounded exit wait so PIDs cannot be reused during termination.
CPU shader compilation can leave those GPU counters unchanged. A command may set
`MARGO_GPU_IDLE_MIN` from its measured runtime plus margin; acquisition validates
and records that window for the independent heartbeat, capped by the existing
hard hold limit. Both the wrapper and heartbeat still enforce `--max`. For Bug 45,
the earlier full D3D11 render took 143.698 s, but a later CPU-active run lost its
readback to idle reclamation after 194.050 s. Use an eight-minute hold and a
four-minute idle window for the instrumented full parity leaf, with its existing
eight-minute test limit unchanged. The first-hit diagnostic completed in 73.376 s
with 448 exact albedo, normal and depth words; that is not full transport proof.
`tests/gpu-idle-window.test.js` simulates the old reclaim interval and checks
eventual reclaim, unchanged defaults, invalid values and the hard-limit cap;
`tests/gpu-lock.test.js` checks the actual published lease. This implements the
distinction between pipeline-creation work and queue execution described by the
W3C GPU for the Web Working Group, [WebGPU](https://www.w3.org/TR/webgpu/#dom-gpudevice-createcomputepipelineasync)
(2026). It does not change Windows' watchdog or any correctness deadline.
The detached heartbeat uses the checkout cwd, and ticket completion waits for
the owner to close its Windows handles before returning, so a command's temporary
directory can be removed after completion (30-second owner drain bound).
Withdrawal removes its ticket and closes wait accounting under the mutex, with
a separate 30-second cleanup bound. An incomplete first append is unpublished;
the next writer discards only the unfinished tail under the mutex before appending.
failed confirmation telemetry is observed/published as unknown and resets idle.

`status` reports holder lane, command, heldMinutes, and GPU busy/idle/unknown,
plus slotsUsed/slots (default 3). Activity logs are append-only sidecars and do
not rewrite a released holder. `usage.freeSlotWaitMs` is elapsed time with at
least one free slot while requests wait; `freeSlotWaitSlotMs` sums free slots
over that time. Both integrate scheduler-observed transitions, including
same-lane ineligibility, rather than continuous GPU occupancy or legacy events.
A 3/3 count means admitted leases, not hardware saturation. Sampled counters
can miss GPU children born and exited between snapshots; this is not continuous
tracing. Other platforms report unknown and retain the existing hold timeout.

Evidence: CPU fake-lock tests in `tests/gpu-admission.test.js` and
`tests/gpu-activity.test.js` and `tests/gpu-monitor-edges.test.js`, plus existing mixed-client, queue, timeout and
nested regressions. The native Windows terminator test uses owned CPU sleepers,
including a deliberately mismatched birth identity. No benchmark or second
GPU-heavy proof run was started. Research compared Mellor-Crummey and Scott's
reader/writer fairness with Mahajan et al., [Themis: Fair and Efficient GPU Cluster Scheduling](https://arxiv.org/abs/1907.01484)
(2019), and Yu and Chowdhury, [Salus: Fine-Grained GPU Sharing Primitives for Deep Learning Applications](https://arxiv.org/abs/1902.04610)
(2019): eligible CI lanes use shared capacity; their ML allocation algorithms
are not imported. Telemetry follows Steve Pronovost, posted by Bryan Langley,
[GPUs in the Task Manager](https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/)
(2017), and Microsoft, [Collecting Performance Data](https://learn.microsoft.com/en-us/windows/win32/perfctrs/collecting-performance-data)
(2021). NVIDIA, [nvidia-smi documentation](https://docs.nvidia.com/deploy/nvidia-smi/index.html)
(2026), limits pmon to Linux; unsupported Windows metrics are never zero.
Microsoft, [PROCESS_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information)
(2024) and [CIM_DATETIME](https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime)
(2021), specify process-object lifetime and six-digit fractional timestamps.
No companion code or other repository source was read.

All new shared and exclusive requests keep FIFO tickets in the existing
`gpu.lock-waiting/` format. Shared admission requires a free slot and the head
eligible ticket; it does not wait for other shared holders to finish. Old reader/writer
clients conservatively treat these tickets as exclusive waiters, preserving
exclusion but not providing FIFO guarantees for old clients. Old one-holder
clients also retain their own ordering. Worktrees must rebase to get the new
admission policy. Never remove another owner's entry to advance a queue.

CPU-only proof: `tests/gpu-queue.test.js` fills three fake slots, queues two
detached commands, times out an observer, then checks exact FIFO admission ahead
of a later ordinary request while two original holders stay live. Completed
results and logs survive the submitting process, and malformed tickets are
rejected before filesystem access. Existing mutex/legacy/limit tests remain
required; this adds no GPU performance claim.

## Purpose and authority

### GPU exclusive request policy

`scripts/gpu-lock.mjs` refuses correctness requests for exclusive GPU access,
including `MARGO_GPU_EXCLUSIVE` requests. Existing benchmark classification
(`bench*` npm scripts and benchmark paths) authorizes measurement; other speed
commands must give `--timing=<reason>` (API `timing`), logged in
`test-results/gpu-lock-timing.log`. Refusals append structured coded records to
`test-results/gpu-lock-refusals.log` before any lock wait or nested admission.
Exclusive holds default to and cannot exceed 20 minutes; oversize requests fail
with `ERR_GPU_EXCLUSIVE_LIMIT`. Other explicitly named locks retain their
30-minute default. Correctness requests use the three shared GPU slots.

Cap evidence is existing run history, not a new loaded-machine measurement:
the three JSON records under `benchmarks/records/` took 88.4, 113.3 and 184.4
seconds total. The valid official compute/viz run took 184.4 seconds, with
74.3/74.9-second suites. Twenty minutes leaves more than six times that longest
recorded total while bounding interference. This sample does not establish a
limit for every future benchmark; longer matrices must select bounded suites
and release between them rather than increase the exclusive hold. The previous
130-minute benchmark wrapper is capped too. No performance number is newly
published. `tests/gpu-lock-policy.test.js` proves refusal, recorded reasons,
benchmark admission and the cap on isolated CPU-only lock folders.

The biome prefetch correctness proof now uses shared access with a 60-minute
wait. Mixed biome timing suites, the visual frame budget and dynamically
scheduled GPU timing steps identify their measurement reasons explicitly;
their correctness/speed split and build-phase deferral remain separate work.

Sciviz fallback foundation (2026-11-10, section 5 evidence supplement): the optional `/fallback` entry owns one
lazy Rust/Wasm marching-cubes module. It receives the existing clean-room derived case table; core and stage
import none of it. Classification handles four contiguous x cells per SIMD comparison group and scalar tails;
generation preserves GPU cell/table order, interpolation and gradient conventions. The TypeScript boundary checks
dimensions and memory/output limits, owns each invocation's memory, and yields between bounded chunks so aborts
can settle. Native Rust tests and the package's `fallback.test.js` cover every case, an independent rounded scalar
oracle, row tails, chunk boundaries, cancellation and the real head MRI. A local alternating scalar/SIMD Wasm probe
used the same 1,403,223 MRI cells and identical full vertex hashes, establishing a classification gain under load;
no public speed ratio or end-to-end rendering claim follows. The 21,851-byte Wasm has a 24,000-byte test ceiling.
Direct WebGL2 Figure integration and native/compatibility/preview pixel comparisons are still missing.

This document preserves the engine-specific technical design, validation model, measured limits, and known gaps that
were previously mixed with repository coordination instructions. It does not define task assignment, branches,
integration, publishing, or source-control operations. Those are external workspace responsibilities.

The implementation and focused tests are authoritative when this document disagrees with current code. Most detailed
measurements below were audited at commit `67ca53a5` on 2026-10-29. Later committed records supersede those snapshot
values. Status words mean:

- **Enforced**: executable code or a test rejects a violation.
- **Verified**: the cited implementation or test was inspected.
- **Measured**: a committed result records the value and conditions.
- **Documented**: the contract exists, but this document does not claim a live run.
- **Unverified**: a known evidence gap.

## 1. Deterministic transform kernel

### 1.1 Components and build

| Path | Responsibility |
| --- | --- |
| `packages/kernel/Cargo.toml`, `Cargo.lock` | Rust crate `margoengine-kernel`, built as `cdylib` and `rlib`; release uses `opt-level = 3`, fat LTO, one codegen unit, aborting panics, no overflow checks, stripped symbols. |
| `rust-toolchain.toml` | Pinned minimal Rust toolchain and `wasm32-unknown-unknown` target. |
| `packages/kernel/src/lib.rs` | Layout, transform evaluation, constraints, bounds, culling, exports, and native unit tests. |
| `scripts/build-modern.js` | Cargo build, Binaryen optimization, validation, compression, and generated embedding. |
| `packages/core/src/wasm.ts` | Generated raw-deflate payload encoded as base64. Consumers need no Rust toolchain. |
| `packages/core/src/kernel.ts` | `TransformStore`: instantiate, bind typed-array views, grow, tick, and report errors. |
| `packages/core/src/engine.ts` | Slot allocation, public transform setters, per-frame tick, and instance updates. |
| `scripts/kernel-opt-experiment.js` | Historical optimization experiment. It is currently stale; see known gaps. |

The source build runs Cargo for `wasm32-unknown-unknown` with SIMD enabled, then `wasm-opt` with `-Oz`,
`-ocimfs 300`, SIMD, bulk memory, non-trapping float-to-int support, stripped metadata, and convergence. The normal
package build can instead decode the checked-in payload. Both paths validate the module, enforce raw Wasm under
30 KiB, compress with raw deflate at level 9, and verify a lossless round trip. At the audit snapshot the payload was
9,011 bytes raw and 3,435 bytes before base64 after deflate.

`npm run modern:build` rebuilds from Rust. `npm run build:packages` uses the checked-in payload. `npm run test:kernel`
runs `cargo test --locked`. The `rlib` target lets native tests execute the same algorithms with owned vector storage.

### 1.2 Linear-memory contract

One Wasm instance owns one fixed-capacity kernel. The kernel allocates a float region followed by a byte region at an
aligned `__heap_base`; tick performs no allocation. Capacity is limited to `2^23` so the layout remains below the
wasm32 4 GiB address space.

Constants at the audited layout:

- `TAIL = 24`, `DATA_LANES = 86`, `FLAG_LANES = 7`.
- Float lanes: translation 0-2, quaternion 3-6, scale 7-9, parent 10, world matrix 11-26, local sphere 27-30,
  world-sphere structure-of-arrays 31-34, planes and Euler storage 35-37, limits 38-49, scratch matrix 50-65,
  scratch sphere 66-69, and snapshot 70-85.
- Flag lanes: active 0, visible 1, constrained 2, hidden 3, hierarchy depth and inherited-hidden bit 4, tick state 5,
  changed 6.
- The constraint mask uses bits 0-2 for translation and bits 3-5 for Euler rotation (`ROTATION = 56`).

| Region | Indexing and shape | Producer |
| --- | --- | --- |
| Translation, quaternion, scale | `lane * capacity + id`, one structure-of-arrays lane each | JS setters; rotation sync may rewrite quaternion |
| Parents | `10 * capacity + id`, parent id stored as f32, `-1` for none | JS hierarchy setter |
| World matrices | `11 * capacity + id * 16 + element`, column-major | Kernel publish pass |
| Local spheres | `27 * capacity + id * 4 + component` | Geometry-bound setup |
| World spheres | Four structure-of-arrays lanes at 31-34 | Kernel publish pass; suited to four-wide SIMD culling |
| Frustum planes | First 24 values of the lane-35 region | Camera update |
| Euler XYZ | After the 24 plane values, `id * 3 + axis` | JS rotation setter; constraints |
| Limits | After the same tail, 12 values per entity: min/max for translation and Euler axes | JS constraints |
| Scratch matrix and sphere | Per-entity blocks | Kernel staging only |
| Snapshots | 16 values per entity | Kernel bitwise change detection |

The layout costs 351 bytes per slot: 86 f32 lanes plus 7 flag bytes. A committed measurement recorded 352.1 bytes
per slot at 1,048,576 slots. Core adds approximately 5 bytes per slot for the host-side seen and slot arrays. The
mixed layout is deliberate: streamed values and culling spheres are structure-of-arrays, while records copied whole
are per-entity blocks.

`kernel_new` is the only allocator. On wasm32 it owns one static kernel per instance, grows linear memory by pages,
zeros storage, initializes parents to `-1`, and returns null on invalid capacity or allocation failure. `kernel_data`
and `kernel_flags` expose byte offsets; JS constructs all typed views from those offsets. Bounds checks are omitted
only where the layout proves safety. Value, hierarchy, capacity, and finiteness checks remain.

The numeric layout constants are duplicated in Rust and TypeScript. There is no direct generated or compile-time
comparison between those lists; behavioral tests are the current drift detector.

### 1.3 Slot allocation and growth

Removed ids enter a LIFO free list and are reused before the monotonic `next` id advances. A new slot resets
translation to zero, quaternion and scale to identity, parent to `-1`, constraints and hidden state to zero, and Euler
values to zero. Geometry later supplies bounds.

When an id reaches capacity, the store doubles up to `2^23`:

1. Copy every current view out of Wasm memory.
2. Drop the static kernel instance.
3. Bind a larger kernel at the same base address, growing linear memory if required.
4. Recreate every typed view and restore each old view as a prefix.
5. Rebind every live mesh matrix subarray.
6. If the larger bind fails, rebind the old capacity, restore all copies, and rethrow.
7. Mark the new kernel for one full recomputation.

Old views must never be retained across growth. A memory grow detaches their buffer; without a memory grow they still
alias a layout whose column offsets changed. Growth copies about 351 bytes per existing slot and has no isolated
committed timing.

### 1.4 Change detection, hierarchy, and atomic publication

There are no descendant dirty lists. Each entity has a 16-lane bit snapshot containing translation, quaternion,
scale, parent, local sphere, and hidden state. Comparing bits means signed zero and NaN payload changes are visible.
All four four-lane groups are visited even if an earlier group changed.

A tick proceeds as follows:

1. With culling enabled, validate all 24 frustum-plane floats.
2. Validate every constrained value and min/max pair; all must be finite and `min <= max`.
3. Clamp constrained axes. If an Euler axis changed, synchronize its quaternion through the kernel's one XYZ
   expansion.
4. Clear per-tick state.
5. Visit active ids in order. Resolve a parent recursively before its child, memoize completed work, reject cycles,
   reject invalid or inactive parents, and enforce depth at most 64.
6. Recompute when the snapshot changed, the full flag is set, or the parent was recomputed. Write only to scratch.
7. If every active hierarchy succeeds, copy changed scratch matrices and spheres to published regions and set sticky
   changed bytes. A failure publishes nothing and sets the next tick to full.
8. Set initial visibility from local and inherited hidden state, then optionally cull.

Parent composition uses the parent's scratch matrix, which always contains its last computed value. Local TRS is
validated for finite values, nonzero scale, and nonzero quaternion. Quaternion normalization and affine composition
accumulate in f64 and publish f32. The final matrix and transformed sphere must be finite.

World-sphere centers are transformed normally. Radius uses `r * sqrt(norm1 * normInfinity)` of the world matrix's
3x3 part, a conservative spectral-norm bound under non-uniform scale and shear. Culling tests six planes and keeps a
sphere that touches a plane. SIMD handles groups of four, with a scalar remainder. The implementation remains linear
in active entity count; no spatial index is present.

Euler XYZ radians share the tail region after the planes. The kernel owns the single `qX * qY * qZ` expansion and a
deterministic sine approximation: range reduction by tau plus an 11-term f64 Taylor series. A direct Euler write and
a constraint clamp therefore produce the same quaternion bits. One unverified edge remains: native `f64::round`
and Wasm `nearest` differ at exact half-way turn reductions.

`kernel_tick` returns 0 on success, `id + 1` for an invalid entity, and `capacity + 1` for an invalid frustum. The
host converts these to coded range errors. Scratch-first publication and the full-after-failure flag make updates
atomic.

### 1.5 Host bridge and frame loop

Public transform setters validate before writing directly into Wasm-backed arrays. Translation, scale, quaternion,
parent, and visibility setters make no per-entity tick calls. Euler writes call `kernel_sync_rotation`; a multi-axis
`.set` synchronizes once. Quaternion writes normalize without array iteration or `map`, then update Euler lanes in JS.
`Engine.writePoses(ids, poses, count)` (extension surface) is the bulk form of `setPosition` plus `setQuaternion`: it
checks every row (a live slot by the `active` column, values finite as float32, a nonzero quaternion) before writing any,
then writes the same bits, as both go through one `storeQuaternion`. It looks no mesh up, so its callers drop ids of
disposed meshes. `@margoengine/physics/next` writes its awake root bodies through it, one call a sync.

Each rendered frame:

1. Runs plugin pre-update, resize, and camera update.
2. Copies 24 camera-plane floats into the store.
3. Calls `kernel_tick` once per drawn view, plus the main camera after a multi-view frame where required.
4. Performs a full instance collection after structural, scene, layer, or material changes (every row then counts as
   changed).
5. Otherwise scans one visibility byte per slot against the last frame's: a mesh shown takes its batch's next row, a mesh
   hidden gives its row to the batch's last row (24 floats moved, the moved mesh's slot updated from row float 23); then
   finds sticky changed bytes, clears them and copies only those matrices into their rows. Each changed row sets its bit
   in the batch's `rows` bitset and counts in `dirty`. The batch's `mask` counts its drawn rows that need back faces
   (double-sided or mirrored, read from the row itself), so hiding or unmirroring the last such row puts the batch back on
   the back-culled pipeline (`tests/core-material-setters.test.js`).
6. Uploads each batch's changed rows once (`uploadRows`: one `writeBuffer` for each run of neighbouring set bits, clamped
   to `count`, no sort and no allocation).

There is no per-entity Wasm call during a normal tick and no kernel allocation in tick. Host work still scans one
visibility byte per slot and copies each changed row. A culling flip costs 2 map lookups, 24 floats and 96 uploaded bytes;
at 50,000 boxes with 500 flips a frame that is 1,000 lookups and 48 KB instead of a full collection's 100,000 lookups and
4.8 MB (counted in `tests/core-instance-cache.test.js`, which also proves on 200 random frames of flips and moves that the
uploaded rows equal the instance rows and the drawn set is exact). Row order inside a batch therefore depends on the order
of flips, which changes draw order among one geometry's instances: identical opaque pixels except an exact depth tie. Several
cameras on one scene flip most rows and then cost what a full collection costs. The WebGL2 renderer still uploads
`[0, count * 24)` every frame. The cost of `kernel_sync_rotation` has not been isolated.

`@margoengine/stats/phases` times these steps from outside core: step 3 is its `tick`, steps 4 and 5 are its `cull`,
and it reads the frustum test as part of `tick`, because the test runs inside `kernel_tick`. It wraps `store.tick`,
`createCommandEncoder` and `queue.submit` and adds two frame graph passes, so a change to this frame order must keep
`packages/stats/test/phases.test.js` and `scripts/test-stats-browser.mjs` in step.

`@margoengine/scene` adds no kernel entry and no core bytes. `TransformWriter` (`/bulk`) writes the columns the setters write, from
typed arrays, with validation and column lookups once per call; Euler rows still go through the mesh's own `syncRotation`, so
`kernel_sync_rotation` runs once per row. A bad value or a disposed mesh changes nothing. The scene helpers read the store and
its parents, so a world value is right before any frame. A change to these columns or to the setters must keep the package in
step. Evidence: `packages/scene/tests/bulk.test.js` (bit for bit what the setters give, world matrices included) and
`packages/scene/tests/scene.test.js` (against the Wasm kernel's matrix, mirrors and uneven parents included). Measured,
diagnostic, Node, 10,000 meshes: positions 0.12 ms against 0.59 with setters (perf-history entry 70). Missing: a quiet run, and
the whole frame with thousands of moving meshes.

### 1.6 Kernel evidence and limits

The native and host suites cover:

- TRS, atomic failed updates, culling at plane contact, inactive slots, hierarchy composition, cycle rejection,
  depth, constraints, inherited hiding, exact changed sets, rotation synchronization, layout edges, signed zero, NaN
  payloads, all snapshot groups, and failed-tick recovery.
- An oracle in `tests/core-dirty-transforms.test.js`: incremental results match a fresh full recomputation bit for
  bit, including growth, 1% moving entities, 63-deep chains, removal, reuse, and one million entities.
- Growth preserves every value and replaces views; invalid capacities and failed growth leave state unchanged.
- `setQuaternion` creates no arrays across 1,000 calls.
- Build-time Wasm validation, compression round-trip, 30 KiB raw limit, and the combined core-stage size gate.

Recorded snapshot values: unchanged tick about 3.3 ms at 100,006 entities, 20.2 ms at 499,992, and 41.5 ms at
1,000,012, roughly 41 ns per entity per frame at the largest point. Above 1,048,576 slots was not measured. Initial
capacity is 1,024 and the enforced cap is 8,388,608.

Bit-for-bit claims are scoped. Incremental versus full recomputation is verified on the same Wasm. Cross-machine
kernel equality is expected by design but unverified. JavaScript's approximated `sin`, `cos`, `pow`, `hypot`, and
related functions are not promised to have the same final bits across JS engines.

Known kernel gaps:

- No gate proves that checked-in `wasm.ts` was rebuilt from current Rust source.
- Native Cargo tests do not execute the Wasm SIMD paths; JS tests execute the checked-in Wasm.
- No direct cross-machine kernel-bit test and no focused kernel fuzz target.
- `scripts/kernel-opt-experiment.js` expects the old compression and 70-float/5-flag layout; it must not be treated as
  runnable evidence until updated.
- The native/Wasm half-way turn-reduction rounding difference is untested.
- Growth and one rotation-sync bridge call lack isolated cost measurements.

### 1.7 Physics kernel

A second Rust kernel, the own rigid-body solver, is being built behind `@margoengine/physics/next`. Rapier stays the default until the switch. It shares the transform kernel's pattern, not its code. Its narrow phase runs once a step, before islands, over pairs with an awake body: manifolds of up to four points live in rows of the world, so a snapshot carries them, and hulls are rows too, held for the world's life. Boxes and hulls go by the separating axis test; anything with a ball or capsule goes by GJK distance and an expanding polytope. Two bodies count as touching, for islands and sleep, when their pair holds points, no longer when their fat boxes overlap. Evidence: both paths against brute force in doubles on random poses, native; Wasm through the replay. Each point keeps a normal impulse, a tangent impulse as a world vector and a friction drift from step to step, by feature id and then by place, in rows of the world, so a snapshot carries them. A clipped face of more than four points reduces to the four of largest area with the deepest always kept; last step's ids and feature win ties, so a resting pile does not swap points on noise. The solver is soft step: per substep, velocities, warm start, 2 biased passes, poses, the friction drift tallied from the speeds the poses moved with, as many relax passes as biased ones, restitution. Within a pair the normal rows of the manifold sweep to convergence each pass and friction takes one sweep; the relax pass solves the normal before friction, so friction's cone is the normal the relaxed contact holds (2026-11-07: a drift tallied inside the relax pass saw speeds the points before it had changed and left a resting block's anchors twisted, creeping 2.1e-6 m in 5 s; one relax pass left the anchors' push in a 14-row pyramid, which rocked; one normal sweep let the first point take a whole strike, so a cube dropped flat spun and slid; evidence `a_block_slides_at_its_rate_from_release`, `a_cube_dropped_flat_lands_flat`, the pyramid and dominance tests, native, Wasm through the replay). A four-point manifold ends each sweep with the exact step along the one impulse pattern that moves no body (its points' shares of one load), which Gauss-Seidel settled only by the leak, about 3 percent a sweep, so soft passes used to run out at 16 sweeps; they now settle in about 4 (2026-11-08, perf-history 80, counted with `--features counts`). A ball's or capsule's gap within a step is read from its core plus its radius along the normal, so a rolling ball's point stays on the floor (2026-11-08: fixed to the ball it rose r (1 - cos a) and the ball ran 0.33 percent fast; evidence `a_ball_rolls_from_rest_at_five_sevenths_of_g_sin_t_on_thirty_degrees`, native, Wasm through the replay), and a strike seen across an open gap notes gravity's gain over the gap (`a_ball_bounces_to_e_squared_at_four_substeps_of_one_pass`). Inside the slop a biased pass closes a point rigidly to the slop's depth, a speculative row of (gap + slop) / h as in Catto's Solver2D soft step, so a loaded point no longer sinks faster than a light one and a cube on a slope below tan t = mu holds from release (2026-11-08, `a_cube_released_on_a_slope_below_tan_t_equal_to_mu_holds_from_its_first_second`, native, Wasm through the replay). One pass a substep does not settle a deep pile at a quarter of the substep rate, so at one pass a contact between two dynamic bodies that neither dominates takes an eighth of the rate (Catto's Solver2D advice to keep the stiffness well below the step rate) while it carries under 50 times the lighter body's weight (`CHAIN_LOAD` in `solver.rs`); the ground, kinematic and dominant bodies and heavier loads keep the quarter, so a 1:1000 stack sags as before. The 20-row pyramid at 4 substeps of one pass sleeps at 2.28 s, 30 rows at 2.03 s; at two passes or more the code path is the old one, bit for bit (2026-11-08, `a_pyramid_settles_at_one_pass_a_substep`, native, and the harness in Node). Before that change: 8 substeps by default, one pass more than the plan and twice its substeps, because 4 substeps and 1 pass let a 20-row pyramid creep 20 cm and throw a 1:100 stack (build record, batch 124). Evidence: every proof native with sleeping on and off; Wasm through the replay. Missing: speed against Rapier, which batch 129 measures.

Joints are one six-axis row class: each axis along or about frame A is locked, limited, driven or free. A substep runs rows, warm start, settling passes, one pushing pass, poses, rows again, a relaxing pass. Locks along a path of joints are solved exactly by a Cholesky factor in doubles, from Householder QR of M^-1/2 J^T joint by joint; a path nothing leans on closes its whole error and relaxes on rows from the new pose, the two stages of RATTLE. Where a branch or a ring ends a path, paths meet by block Gauss-Seidel at a share of 0.2. Only the pushing pass carries a position bias, and the warm start does not remember it: remembering it makes every mode the passes have not settled a triple integrator with the error as its only feedback, which grew an 8 by 8 grid to 1.5 m of gap and 100 m/s (`docs/clean-room.md`, PK24). This is a rule of the step: a row with a rigid position bias keeps its bias out of its memory, or it has a gamma term of its own, as motors and contacts do. Evidence: closed forms for a swung bob and a parallelogram, energy of a double pendulum, a 50-link 1000:1 chain, grids to 30 by 30, native; Wasm through the replay, whose scene now holds joints of every locked kind. Missing: a lock's turning arm is read at the start of a substep, so a light link under a large pull is an explicit spring and a 50-link chain laid level under a 1000:1 end mass stretches 2 times its length by step 60 (`docs/known-bugs.md`; the fix needs the turning read implicitly), exact loops and branches (a 1000:1 load on a grid opens 7 cm), exact limits (one row at a time: twelve hinges on their stops droop 0.91 m), and speed against Rapier.

Rows that depend on each other are the solve's singular case, and four rules cover it (`docs/limits.md`, Own physics joints, gives what each costs). K = J M^-1 J^T is never formed: Householder QR with column pivoting of A = F^T J^T (F F^T = M^-1 per body) gives its Cholesky factor with complete pivoting (Higham 1990, section 5.2), one front of at most 12 rows a joint along the path, with a stop at n u of a row's size, n the path's rows and u f32's epsilon (his test 4.3). Eliminating K joint by joint carried W^T E W into each Schur complement (his Lemma 2.1) with no bound on W, and a 13-row path on 12 freedoms read 4e-7 where rationals give 0 (2026-11-08, `a_path_with_more_locks_than_freedoms_drops_the_row_that_depends`); a reflection rounds each row only by its own length, and that row reads 1e-32. A lock's bias is capped at `joint_max_push` plus what the turning carries its anchors. A pushing pass is cut when a body's turn would rise by more than 0.2 rad times N / M in a substep (Buss and Kim 2005, section 4), on the rise only, as a push that takes back a limit's kick slows its body. Only its position bias is cut: the pass first solves the speeds along a path's locks whole, then the bias on the same factors, capped from the speeds those leave (2026-11-08; one cut solve of both left a limit's kick of 7,500 rad/s in a joint web and handed a neighbour 457,390 rad/s, `a_cut_push_still_takes_back_the_speed_along_the_locks`). Cost: one more forward and back sweep of each path in the pushing pass. A warm start worth more than one push's energy is taken only to the minimum of the dual along it, our own rule. A body past 1e15 stops the world: `world_lost` names it and `KernelWorld.step` throws, as the state may hold no NaN. Before this the replay's own scene reached NaN on 27 of 40 seeds, and that was also the one mismatch between native and Wasm: every differing word of 652,560 bytes at step 174 was a NaN against a NaN of the other sign. Evidence: `kernel/tests/stability.rs`, each rule with a test seen failing without it; the rule counts on `kernel/tests/joints.rs` show the cut and the cap leave every figure there as it was. Missing: the rules are tuned on Windows x86-64 native and Wasm in Node only, and the search has no paper. Evidence for the factor: kernel pivots against exact rational elimination agree to 1e-13 on every path of two web seeds at their fastest steps, native only (a one-off check, not a test); Wasm through the replay. Open: near a toggle a path's row that does not yet depend is answered in full, so web seed 49 reaches 10,991 m/s and a joint 165.8 m open and the 60 webs have no gap bar (`docs/known-bugs.md`); the joint gap of a chain laid out level is not yet held by any test (1:1 opens 7.0 mm).

A limit is rigid up to its edge and soft past it. Up to the edge its row closes any gap within the substep and no more, and it reads and moves through the Schur complement of the joint's own locks. Past the edge it pushes with the contact's soft constraint, so a limit and a floor that cannot both hold rest instead of trading rigid pushes, and being soft it remembers all it gives. A cone joint is two such rows: the twist about frame X, read as 2 atan2(q.x, q.w) of the swing and twist split (Dobrowolski 2015) with its rate along the bisector of the two X axes, and the first-order distance past an ellipse of the swing's rotation vector, along that ellipse's gradient. Evidence: a thrown rod stops at a cone of 0.5 rad and stays at 0.5000, ellipses of 0.3 and 0.8 hold each limit, a tilted twist stops at 0.3993 of 0.4, a limb a floor holds past its cones sleeps, a link of a hundredth of the mass carries a full one 0.008 rad past its cone, all native, and Wasm through the replay. Missing: the push past an edge scales with the mass the row sees, so a hand of a hundredth of the density rests 0.49 rad past its cone under its arm.

What a pair may do is settled in the narrow phase, the only place that looks at it each step: a pair of a disabled body or collider, groups that do not meet, a joint or a refusing filter has no contact; a sensor pair or one whose solver groups do not meet only finds out whether it overlaps, and takes no part in islands; every other pair gets its manifold. A step's last act compares what each active pair found with what it remembers and lists the changes, two words an event, for the entry to read and clear; a pair of sleepers, which no step looks at, keeps what it had. Dominance is a bit on the pair for the step, read where a pair's two bodies are fetched, and only between dynamic bodies, so it costs a solve nothing when unused. The contact filter is the kernel's one import, called only when set. Evidence: `packages/physics/kernel/tests/events.rs`, `packages/physics/tests/next-events.test.js`, each behaviour in `packages/physics/README.md`, native and through the entry; Wasm through the replay, whose scene holds sensors, groups, a filter, dominance and a disabled body. Missing: a sensor reads the pose a step starts from, so it reports up to a step late.

A pair tallies the normal impulse of a whole step: what each point holds after the relaxing pass is all it gave in that substep, its warm start included, and a bounce adds its own. `contactforce` reads the tally from the solve list, so it costs a listener only. Evidence: a resting stack reads its weights to 1e-5, the impulses of a landing add up to m g t to 1e-5, native; Wasm through the replay.

A rope and a spring are joints with no lock: their first axis is the line between the anchors, and what it reads is their distance. A rope is a limit on that row and a spring a motor in the force model, so both use the rows above and neither joins a path. Evidence: a slack rope lets a weight fall as free fall, a taut one swings with the elliptic period to 0.01 percent at 60 degrees and stretches 0.00007 m at the jolt; a spring keeps its period to 0.003 percent and the decay of implicit Euler to 0.2 percent, and settles at its static stretch to 1e-5 m, native; Wasm through the replay, whose scene holds both. Missing: a rope is one row at a time, so two ropes under a 1000:1 end mass rest 35 mm long; `Rope` on the own solver (batch 128) is spherical joints on a path, which do not have this limit.

A convex hull from points is built in the entry's TypeScript, on the add path, by Quickhull with fat planes, then merged into the large faces the clipper needs; the kernel only checks and stores it. A face holds up to 256 edges, so the clipper's buffers are left unwritten until used, rather than cleared on every face contact. The kernel refuses two neighbouring faces as one plane split in two only when they meet under 0.8 degrees and every corner of each lies within half of FLAT of the other's plane, as an angle alone refused real creases of random clouds. Evidence: 85 point sets hold every point within 2.0e-5 of their size and the kernel takes each, and a 256-sided cylinder stands on its cap, in Node; the replay holds four hull bodies bit-equal across Node, Chromium and Firefox. Missing: build cost against Rapier (batch 129).

A body's kind can change between steps. Two fixed bodies have no pair, so a body that stops being fixed walks the sorted ends once for the fixed colliders its boxes overlap, and one that becomes fixed drops its pairs with fixed bodies, which ends their touches; the body wakes and is listed again. A body's own solid (mass at a point, principal moments along a frame of its own) joins its colliders by the parallel axis theorem, and with no collider mass it is the body's figures exactly. An island may ask for extra solver passes: a substep runs `iterations` plus the most any awake island asks for, and a pair or joint path joins a pass only when its island's extra reaches it, so each island runs the last `iterations + e` passes and the pushing pass stays the last for all; `tests/next-bodies.test.js` holds such an island bit-equal to a world of that many passes and the others bit-equal to the plain world (LIM-433). With no island asking, the passes take no lookup.

A spherical motor is three motor rows, one a frame axis, on the rotation vector left between the joint's frame on body A and body B. Its target is that frame, moved onto the rotation asked for, so what is measured stays small and tells rotations apart near half a turn. The rows read the free body and not the Schur complement a limit uses: a motor is soft, the passes converge on its own fixed point, and a ball rod lands within 0.0006 rad of the implicit Euler closed form at every step measured. Tan, Liu and Turk 2011 is the same stable step in generalized coordinates; here it comes from the implicit form of the row (`docs/clean-room.md`, PK24). Evidence: critically damped closed form to 0.0006 rad, a slanted target to 1e-6 rad in a second, a target near half a turn, a spinning target, a cap of 12 N m holds 9.81 N m and 7 N m does not, all native or through the entry; Wasm through the replay.

| File | Role |
| --- | --- |
| `packages/physics/kernel/Cargo.toml`, `Cargo.lock` | Rust crate `margoengine-physics-kernel`, no dependencies, `cdylib` and `rlib`, the same release profile as section 1.1. |
| `packages/physics/kernel/src/layout.rs` | The column table. `packages/physics/scripts/build-kernel.mjs` parses it, so JS and Rust read one list. |
| `packages/physics/kernel/src/world.rs` | The world: header and columns in one block, addressed by offset. |
| `packages/physics/kernel/src/integrate.rs` | The step: impulses once, then per substep the velocity update and the pose update. |
| `packages/physics/kernel/src/math.rs` | Scalar, vector and quaternion maths, correctly rounded on both targets. |
| `packages/physics/kernel/src/mass.rs` | Mass, centre and inertia of a body from its colliders; principal axes by Jacobi rotations. |
| `packages/physics/kernel/src/broad.rs` | Sweep and prune over fat boxes, the pair rows and their table. |
| `packages/physics/kernel/src/island.rs` | The awake and active-pair lists, union-find islands, sleep timers and sleeping rings. |
| `packages/physics/kernel/src/joints.rs` | Joint rows, paths of joints solved exactly, motors and limits. |
| `packages/physics/src/wasm.ts` | Generated: raw-deflate blueprint, source hash, column table. |
| `packages/physics/src/kernel.ts` | `KernelWorld`: instantiate, bind views, grow, snapshot, restore. |
| `packages/physics/src/next/` | `Physics`, `PhysicsBody` and `PhysicsCollider` on the kernel, with the root entry's names; what is still to come throws `unsupported`. |
| `packages/physics/src/mesh-fit.ts` | Reading a mesh for physics, shared by both entries. |

`npm run build:physics-kernel` rebuilds it (cargo, wasm-opt -O3, deflate); `npm run modern:build` does too. `npm run build:packages` uses the committed blueprint. `npm run test:physics-kernel` runs the native tests.

The 2D kernel (batch 127) is its own crate, `packages/physics2d/kernel`, under the same determinism rule (rotation as a cos and sin pair, no trigonometry on the step path). It holds so far shapes (`shape.rs`: circle, capsule, segment, polygon of up to 8 corners by gift wrapping, each a core and a radius), exact mass of rounded shapes (`mass.rs`) and contact manifolds of up to two points (`manifold.rs`: separating axis and reference face clipping when cores overlap, the exact core distance when apart). It also holds the world (`world.rs`: static, kinematic and dynamic bodies, positions moved in doubles and contacts worked out relative to a pair's first body, so a pile 10 km out steps as one at the origin; islands that wake and sleep as one) and the contact solver (`solver.rs`, over its own compact 32-byte bodies, each half loaded whole and transposed into lanes: the soft step at 4 substeps of one biased and one relaxing pass, the two-point block solve with a row-by-row fall-back, the 3D kernel's chain rule for unloaded dynamic pairs at one pass). Sweep and prune, a dynamic box tree with pairs kept from step to step (`tree.rs`, the 2D default: on the 100-row pyramid 15,133 box tests a step where the sweep made 497,402, the bodies bit for bit the same), islands and sleep timers live in `packages/physics/kernel-common`, a crate generic over the dimension that the 2D kernel uses first; the 3D kernel moves onto it in its own job with a replay bit-equality proof. `check:rust-kernels` runs a kernel when a package its crate reaches by a path dependency changes, so a kernel-common change runs the 2D suite. `npm run test:physics2d-kernel` runs its native tests. Its Wasm build (wasm32 with simd128, no_std, the size-class heap of `kernel-common/src/heap.rs` as its allocator) is built by `check:rust-kernels`, and `kernel/wasm-check` steps the pinned-bits scenes of `tests/bits.rs` (the 100-row pyramid, the joint grid, the mixed scene, 120 steps) inside that build in Node: the four-lane simd128 solve gives the native hashes bit for bit (2026-11-08). `node scripts/physics2d-kernel-browsers.mjs` loads the same module into a page drawing with WebGPU and one drawing with the WebGL2 fallback (Edge 157 both ways, Firefox 157 on WebGL2; Playwright's Firefox has no WebGPU) and gets the native hashes in each, then times the 100-row pyramid against Rapier 2D's Wasm in the page (perf history entry 88), and against Box2D v3's Wasm when `BOX2D_WASM` names a build of it made outside the repository (entry 89); `npm run test:physics2d-kernel-browsers`, a GPU suite check:merge runs, is its bits part in the default browser. Before that the crate built natively only (an f64 square root no_std lacks, no allocator) and no check built it for Wasm. There are no Wasm exports or browser run yet; the other evidence is native: the 20-row pyramid's top drops 28.26 mm and the pile sleeps at 0.73 s, against Box2D v3's 29.11 mm and 1.02 s and Rapier 2D's 29.56 mm and 0.92 s on the same scene (LIM-527). Polylines are chains of segment shapes with ghost vertices (`smooth.rs`, `World::create_chain`): a box and a ball slide across 50 joins at 5 m/s keeping vx within 1e-4, as Box2D v3's chain does and Rapier 2D's polyline does not (LIM-529). Joints (`joint.rs`: revolute, prismatic, fixed, rope, spring, with limits and motors) solve their locks exactly along paths (Baraff 1996, block elimination of the block tridiagonal K) and one joint at a time at branches and rings, and stiffen each body's turning by its taut joints' pull (geometric stiffness, Andrews, Teichmann and Kry 2017): a 50-link chain under a 1000:1 end mass stretches 0.55 percent where Box2D v3 and Rapier 2D fly to 30 and 22 times its length, and the 30 by 30 grid holds within 3.96 mm (LIM-534). The solver visits the contacts colour by colour (`kernel-common/src/colour.rs`, greedy first fit in 16 colours, no two contacts of a colour writing one body), coloured from the top of the scene down along gravity, so a pile rests the same whatever order it was built in (the 20-row pyramid built top down drops 28.35 mm, where it dropped 29.41 mm before). The colours are solved four contacts at a time in SIMD lanes (`kernel-common/src/lanes.rs`, Wasm simd128 and SSE2 with only exact IEEE operations; `solver/wide.rs`), every bit as one at a time (`Settings::contact_lanes` off, native only); two blocks of a colour are visited together so their chains overlap (perf history entry 90), and a step that covers every live lane writes without the selects that keep the others, each point's gap is worked out once after the poses move, and the contacts are read through the colouring's order instead of copied into it (entry 91). Two four-cornered polygons collide down a lane path (`manifold.rs`: placing, both best faces, `closest`'s 32 distances and the incident face four lanes at a time, with `pmin` and `pmax`, defined as the compare and select they replace), every bit as the scalar code kept in `tests/support/manifold_ref.rs` over 11.4 million compared manifolds (`tests/manifold_exact.rs`). In the browser the 100-row pyramid steps in 2.9 to 3.2 ms in Margo's Wasm against Box2D v3's Wasm 1.4 and Rapier 2D's 7.6 to 8.1 (entry 91); in Wasm the solver takes 1.9 ms of it (setup 0.58, passes 1.17) and the narrow phase 0.80 (open in known-bugs). Natively, like for like at four lanes, Box2D v3 steps it in 1.24 ms (its default eight AVX2 lanes 0.98) and Margo in 2.87 (entry 91; physics-refs `native/scripts/native-build-sse2.bat`). Evidence missing: a quiet-machine run of those numbers. Its top drops 684 mm by 10 s against the references' 726 to 735: a pair keeps last step's reference face while the two faces' separations lie within one slop, and a clipped point keeps its end's id, so resting points keep their warm start (before, 1,100 to 1,800 points a step restarted from zero and the top fell 906 mm; `Counts::cold_points` counts them, at most 8 a step after 1 s now). Missing: queries, events and filters, the Wasm layout.

Memory contract: one Wasm instance per world, from `__heap_base`. Every column holds 4-byte rows and starts on 16 bytes; a row keeps its index for life. Growth moves each column up to its larger place, last column first, in the same block, so offsets stay relative, no second copy is needed, and a copy of the block is a whole world. A step can grow the world, as new pairs need rows; `world_layout` counts layouts and JS binds its views again when it moves. Growth changes no later result, since nothing iterates a column by capacity.

Row classes: body, collider, endpoint (two a collider), pair, table, and body list. A body list column is indexed by place in a list, not by body, so freeing a body row leaves it alone; putting a list in the body class zeroed a list slot on every reused row, and the churn test in `tests/sleep.rs` caught it.

Determinism contract: same inputs, same call order and same kernel build give bit-equal state on every machine, browser and Node. Wasm floats round to nearest, ties to even, and only NaN payloads may differ, so the state may hold no NaN. The kernel uses `+ - * /`, `sqrt`, compares and integers; no trigonometry, no fused or relaxed operations.

Step contract: `world_step(dt)` lands impulses once, before the first substep; forces stay in their columns and reach every substep, until the caller clears them. Each substep is semi-implicit Euler (velocity, then pose with the new velocity), so a body's reported velocity is the one that moved it. The gyroscopic term is one implicit-midpoint step in the principal frame, two Newton steps, and may not raise the energy. Rotation uses the exact exponential from a series, with no trigonometry. The contact and joint passes will go between the two halves of a substep.

Broad phase contract: after impulses land and before the first substep, sweep and prune updates the pairs. A pair is two fat boxes that overlap. A fat box holds the shape, what the step can reach from its velocity, acceleration and spin, and a 0.04 m margin. Detection runs once a step and serves every substep. A removed collider stays in the lists until the next step and goes in one pass; new colliders join in one sort, merge and sweep. Nothing that decides an order reads the pair table, so results do not depend on capacity.

Island contract: a step walks the awake list and the active-pair list only, so a sleeper costs nothing. After the broad phase, an awake dynamic body or a moving kinematic one wakes whatever it touches, union-find groups the awake dynamic bodies, and an island whose bodies are all ready becomes a ring. Islands are numbered by their first body on the awake list, a pure function of the calls made; islands are independent, so that order cannot change a result. Fixed and kinematic bodies are insulators. Until P2 touching means fat boxes overlap. A pair that loses its contacts, because the narrow phase found none, the pair became one nothing solves or it left the broad phase, starts both bodies' sleep timers again: a body that cannot sleep keeps its island awake, so what rests on it can be long past its window, and with its support gone it would sleep in mid air at the next look (`kernel/tests/sleep.rs`).

Evidence so far: native tests of layout, growth and hash; Node tests of the views. `packages/physics/kernel/tests/integrate.rs` holds free fall and a projectile against the closed form with the method's own term, a free top against the closed precession rate, a heavy top against the Lagrange rate, energy on a tumbling box and at extreme spin, damping, locks, kinematic targets and an off-origin centre of mass, each bound derived from the method's error term plus f32 rounding. `packages/physics/tests/kernel-step.test.js` repeats the closed forms and the force and impulse contract through the shipped Wasm. `packages/physics/kernel/tests/bodies.rs` checks each solid's mass and moments against a numeric integral of its shape, a dumbbell against the parallel axis theorem, a tilted collider's principal frame, and that freed rows come back last in, first out. `packages/physics/kernel/tests/broad.rs` compares the pairs with brute force on every step of random scenes in which bodies move, teleport, join in batches and leave, and asserts the sorted lists, ranks, pair table and pair lists each time; two runs at different capacities must match, and overlapping balls must always be a pair. `packages/physics/kernel/tests/sleep.rs` compares islands with a plain graph search on random scenes, checks every list and ring through a churn of adds, removals, wakes and sleep requests at two capacities, and proves each rule of the sleep policy. Every row access in the native test build is bounds-checked. `packages/physics/tests/kernel-blueprint.test.js` fails when the committed blueprint's source hash is not the hash of the sources, which closes for this kernel the gap section 1.6 lists for the transform kernel. The gate also rebuilds the blueprint and requires identical bytes.

Replay: `packages/physics/tests/replay-scene.js` runs two 10,000-step scenes, one on `KernelWorld` and one through `Physics`, and hashes the world every 100 steps. `tests/fixtures/replay-hash.json` holds the hashes and the hash of the kernel sources, so a stale file fails. Node (`tests/replay.test.js`), native code (`kernel/tests/replay.rs`, a twin of the kernel scene) and Chromium and Firefox (`npm run test:replay`, in `.github/workflows/browser.yml`) must all give them; `npm run test:browser`, which the full check runs, holds them in that machine's default browser. The scene must reach 8 sleepers, 8 pairs, 8 islands and a growth, and moving one position by 2^-20 must change the hash, so the proof can fail. `tests/step-path.test.js` holds the entry's step path free of `Math`, clocks and `**`, which are the ways TypeScript could part from the kernel.

Missing: everything beyond free motion. Bit equality is proved on one Windows x86-64 PC, in Node, native code, Chromium 156 and Firefox 157 (LIM-366); Safari, ARM and a second machine are not (section 5). Nothing is timed yet: the kernel's speed against Rapier waits for the quiet pass.

## 2. Precise GPU mathematics

WGSL permits large builtin errors and floating-point reassociation. `packages/shared/precise-math.js` provides 19 f32
functions for code that compares CPU and GPU results or results across vendors:

`preciseDiv`, `preciseSqrt`, `preciseSin`, `preciseCos`, `preciseTan`, `preciseAtan`, `preciseAtan2`, `preciseAsin`,
`preciseAcos`, `preciseExp`, `preciseExp2`, `preciseExpm1`, `preciseSinh`, `preciseCosh`, `preciseTanh`, `preciseLog`,
`preciseLog2`, `preciseLog1p`, and `precisePow`.

The implementation uses public numerical methods: integer Payne-Hanek reduction with a 2/pi table, Cody-Waite
reduction for ln 2, Dekker products from 12-bit halves, and minimax coefficients derived by
`scripts/precise-math-coefficients.mjs` at high precision. WGSL is emitted only for requested functions, with shared
helpers emitted once. The derivation solves each Lawson step by Householder QR on unit-scaled columns and stops
reweighting at 2^-44 relative error (f64 noise): the normal equations it used before amplified a 1 ulp difference in the
host's `Math.atan` or `Math.cos` past an f32 rounding midpoint, so macOS arm64 derived other atan constants than Windows,
and tanh's stored set had come from that noise. `tests/precise-math.test.js` re-fits atan and tanh with the host maths
nudged by 1 ulp and needs the same f32 values. The regenerated tanh holds 1.45 ulp (bound 2) on the M6 Mac mini (Metal)
(`npm run test:browser --workspace packages/compute`, 2026-11-07); other GPUs still need a run with it.

Important primitives:

- `pmSplit` extracts a stable high part by masking mantissa bits.
- `pmProductError` returns the exact product residual for the rounded product.
- `pmFastTwoSum` implements the magnitude-ordered Dekker two-sum. A general Knuth two-sum and FMA emulation are not
  present.
- `preciseDiv` and `preciseSqrt` correct one rounded builtin result using an exact residual.
- `pmHide` reconstructs a float from integer sign, exponent, and mantissa bits through `ldexp`. It preserves the value
  but prevents a compiler from proving and cancelling the expression that produced it.

`pmHide` was required because real compilers legally rewrote error-free transforms: AMD D3D12 folded
`(1 + x) - 1`, and Mesa also regrouped and factored sums. Before the fix a Radeon 680M produced a `preciseLog1p`
result 8,383,741 ulp outside the bound; Mesa had 14 of 17 functions outside bounds. Apple's compiler (M6, Chrome and
Playwright WebKit) lost the last product of `pmProductError` while it was unhidden, so the result was the sum without
it: `precisePow` went 97 ulp out, and `preciseTan` over its bound through `preciseDiv`. Every product there is hidden now.
The same compiler spread an unhidden tail over the large part of `preciseLog2`, regrouped `(0.5 t) t` as `0.5 (t t)` in sinh
and cosh, and lost `f - sd` in pow's log pair. Hides there are named in `tests/precise-math.test.js`. The fixes are guarded by:

- A browser shader rewriter that simulates cancellation and factoring on any GPU.
- A spec-error rewriter that perturbs builtin results by WGSL's allowed error.
- Host text tests that reject self-cancelling and factorable forms.
- Dense host reference tests under fused, unfused, and worst-allowed division/sqrt behavior.
- Browser checks against a step-for-step host mirror and a broad exponent sweep.

The documented bounds are function-specific: most are within 1-2 ulp, tan about 2.5 ulp, and pow 2 ulp while
`|y log2(x)| < 16` and 5 ulp beyond. GPU checks require the bound and no more than 2 ulp from the host mirror; exact
mirror share is reported, not generally required.

At the audited fixes, dense checks and the sweep passed on NVIDIA RTX A6000/D3D12, AMD Radeon 680M/D3D12, and Intel
UHD/Mesa Vulkan. The Intel Arc 140V had not been rerun after the fix. The committed sweep reported 573,720 trig inputs
and 298,646 pow inputs with zero over bound on A6000 and Intel UHD. Bit equality across vendors is not claimed; the
per-function ulp bound is.

`pmLog2Pair` carries `s R` as a pair since 2026-11-05. In one float it left `precisePow` over its bound near the top of the
range on every GPU tried (5.66 ulp on the A6000), and the sweep never drew those inputs. The sweep now has that class,
which fails on the old maths: 318,575 pow inputs, 0 over bound on the A6000 and on an Apple M6 in Chrome 157 and
Playwright WebKit. Worst in a 262,144 input scan of that class: 1.23 ulp on the A6000, 1.03 on the M6. The AMD, Intel UHD
and Arc results above predate this change.

Node 22 and Node 26 once produced different pinned proof digests because V8 implementations of `pow` differed. The
proof inputs now use exact operations, approximated host math is replaced by deterministic stand-ins during the
proof, and the suite runs under both pow modes. NaN payloads are canonicalized only where a proof explicitly defines
that comparison; signed zero otherwise remains significant.

Measured on the RTX A6000 only (`docs/whitepaper/perf-history.md` entry 48): one precise call per element costs 1.0 to
1.8 times the builtin, `tan` 2.3, `pow` 3.0, and the path tracer's panorama and fisheye rays 1% to 7% of a traced sample.
The `pow` figure predates the pair for `s R`, which adds work, and has not been measured again.
`npm run bench` repeats the pairs (`compute-elementwise`, the `tracer` suite; entry 71), diagnostic so far.
Unmeasured: that cost on other GPUs, one kernel rotation-sync call, and cross-machine kernel bit equality.

`@margoengine/compute/subgroups` is opt-in for the same reason: its float sums follow the GPU's subgroup size, so they
do not repeat across GPUs, while integers, orders and sorts equal the default kernels. WGSL promises no subgroup size or
layout, so kernels order work by seats taken with one workgroup atomic, never by `local_invocation_index`. Checked at
sizes 32 (RTX A6000) and 4 (SwiftShader, `BROWSER_ARGS` with `--enable-unsafe-swiftshader` and
`--use-webgpu-adapter=swiftshader`).

Skinning has one optional second path: `@margoengine/animation/dqs` blends dual quaternions in the batched deformation
shader, a pipeline of its own beside the linear one, reading the same 64-byte bone slots (rotation, dual part, symmetric
stretch). The CPU splits each bone matrix by polar decomposition in double precision (Jacobi on the Gram matrix, so a
rank-deficient bone still gives a rotation). Quaternion signs follow the heaviest influence, because glTF fills spare
influences with joint 0 and an idle joint must not choose them. Checked on the RTX A6000 only: 28,512 values against the
double-precision twin, worst 8.8e-7 in position and 2.1e-7 in normal; the narrowest ring of a 170 degree twist stays at
radius 1.000 where the linear path gives 0.087 (`npm run test:gpu:dqs -w @margoengine/animation`). Unmeasured: its frame cost.

`SkinnedCrowd` (`@margoengine/animation/instanced-skin`) skins in the vertex stage from a baked rgba32float bone texture,
drawing through `VATCrowd`'s pipeline code. Its proof runs the stage's own `skinned` function from a compute shader, since a
vertex stage cannot write out. Checked on the RTX A6000 only. Unmeasured: its frame cost.

### Uniform-only inexact operations

A shader result must not depend on how the driver evaluates an expression of uniforms only. On ANGLE D3D11 with
an NVIDIA RTX A6000, core's `normalize(frame.light.xyz)` returned one of two values an ulp apart depending on GPU
load, while per-pixel expressions with the same bytes stayed exact; captures then differed in 24 binary16
components. Core now uploads the unit light direction (float64 normalize, one float32 rounding) and every shader
reads `.light.xyz` without `normalize` or `length`; every package uniform that copies the light is
written through `shared/unit-light.js`, and sun options are normalized on the CPU the same way. `packages/core/tests/unit-light.test.js` checks the upload and scans every package source for
both patterns (a normalized light uniform, a raw `lighting.direction` write); `capture-stability-browser.mjs --compat --gpu-load=3000` reproduces the old failure. Evidence exists
for this one GPU and driver; other vendors, and other uniform-only inexact builtins (division, sqrt, pow on uniforms
alone), have no scan or GPU evidence yet.

### Particle shadow depth and node vectors

`@margoengine/vfx/shadows` draws each live particle as a sphere impostor. WebGPU clips a primitive whose clip z is outside [0, w] (WebGPU specification, primitive clipping) before the fragment stage. The quad's clip z stays inside that interval when the sphere's depth interval meets [0, 1], so a centre past the cascade far plane still draws a front that is in range. The fragment writes the geometric depth, `centerZ - sqrt(max(0, 1 - x^2 - y^2)) * depthRadius`, clamped to [0, 1]. A sphere whose whole depth interval is past the far plane still clips.

`@margoengine/vfx/nodes` normalizes with one scaled length on the CPU and in WGSL, function `nodeNorm`: divide by the largest absolute component, then by the length of that vector (Blue, James L., "A Portable Fortran Program to Find the Euclidean Norm of a Vector", ACM TOMS 4(1), 1978). A zero vector stays zero. WebGL2 translates that same function. Finite values 1e-21 and 1e20 both become a unit vector on the CPU, on WebGPU and on WebGL2. A finite double that is not a finite f32 is rejected for a node literal and for shadow range and intensity (`vfx-float`) before it is stored in a uniform.

### PixelScale, CRT and PaletteQuantize

`@margoengine/pixel/scale` fits a whole-pixel rectangle into each view (contain rounds down the unconstrained side and
centres the result). Nearest selects `floor((2 o + 1) n / (2 w))` by integer arithmetic, so an exact source boundary
selects the texel to its right or below. Sharp-bilinear integrates the last two texels on each axis: at the right edge
`r = (o + 1) n / w`, it mixes texels `floor(r)-1` and `floor(r)` with weight
`clamp(fract(r) w / n, 0, 1)`, then the two rows the same way. Edge first applies the public Scale2x corner rule
(matching adjacent neighbours and differing opposite neighbours), only when at least 2x fits. Below 1x this two-texel
filter is not full box integration; colours mix in their stored encoding, not linear light.

`@margoengine/pixel/crt` maps the output centre to `c = 2 (o + 0.5) / w - 1`, bends it with
`b = c (1 + curvature * c.yx^2)`, rejects points outside the glass and maps back to source coordinates. Flat glass
avoids that normalized round trip: it uses the same integer nearest quotient as PixelScale. Scanlines multiply by
`1 - scanlines * (1 - sin(pi * fract(t.y))^2)`. The three-column grille passes one RGB channel and multiplies the other
two by `1-mask`. Glow adds a clamped-edge 3x3 binomial `[1,2,1] x [1,2,1] / 16` blur. The beam is multiplied by
brightness, glow alpha is added and clamped, and RGB is capped at alpha before premultiplied compositing. This is a
designed look, not a measured physical tube. All-off must equal rational nearest exactly; it has no excluded samples.

Both screen passes intersect the fitted rectangle with canvas bounds and RenderView.scissor, preserving the original
mapping. Explicit output textures cover their own rectangle, independent of the canvas view. Per-view uniforms
prevent queue writes for a later view overwriting an earlier one. Bind groups retain both source texture and selected
pipeline identity because WebGPU auto layouts belong to their creating pipeline, even when shapes match. Disposal
queries `engine.sceneOf(this)` before unregistering, so equal names in other scenes are untouched; buffers are destroyed
and pipeline/bind-group references released. The same ownership rule holds for PaletteQuantize and LayerCompositor.

`@margoengine/pixel/palette` unpremultiplies nonzero-alpha source texels (unless straight input is requested), adds
`spread * (threshold - 0.5)` in encoded sRGB, clamps to [0,1], then minimizes squared distance in sRGB or Oklab. Oklab
decodes sRGB with its standard piecewise transfer function, applies Ottosson's LMS matrix, cube roots and Lab matrix.
Ties keep the first palette entry. The chosen swap colour is premultiplied by the original alpha. Bayer ranks use
`(rank + 0.5) / side^2`; blue noise is Margo's deterministic 64x64 tile. CPU cycling reduces the finite `rate * seconds`
modulo the run length before subtracting small indices, floors the reduced shift, and optionally interpolates its
fraction in Oklab. Product overflow is rejected with coded `state` and a help link. GPU palette disposal destroys its
palette/dither textures and uniform buffer as well as removing the owning scene's pass.

Evidence: `packages/pixel/tests/screen-pass.test.js` checks auto-layout identity on repeated format changes, scissor
intersection and exactly-once resource destruction; `palette-cycle.test.js` checks huge signed shifts and overflow in
both blend modes. These run in verify, hence check:merge. Both scale/crt GPU harnesses import `screen-regressions.js`
for real-device format round trips, clipped and empty scissors, and same-name plugins in different scenes. The CRT
harness additionally compares 154 source/output size pairs against both rational nearest and PixelScale with exact
bytes and zero exclusions. Existing scale/palette/CRT GPU checks retain CPU maths comparisons and device restore.
Backend evidence and its remaining scope are recorded in section 5.

## 3. Rendering backends and hardware tiers

`@margoengine/vfx/shadows` and `@margoengine/vfx/nodes` run on WebGPU and on the WebGL2 compatibility layer from the same shaders. WebGL2 has no compute stage; the particle simulation uses the existing GPU point-draw route in `vfx/src/compat.ts`, and the shadow depth pass is a fragment shader. Disposal removes the point lights that effect published into its clustered list, and a dispose or device restore during the light read-back settles the cancelled map.

**Area light integrals (2026-11-05).** `@margoengine/clustered/area` returns early from a quad with nothing to clip; the clip's own result, by the same operations. Evidence: `packages/clustered/test/ltc-edge.test.js` (bit for bit in float32) and `examples/package-benchmarks/area-lights-gpu.mjs` as the package's `test:gpu:area` (11 frames byte-equal, RTX A6000 only).

gltf-pro trims each pipeline to the vertex inputs its finished shader reads (`packages/gltf-pro/src/vertex-inputs.ts`), after
every shader patch. Evidence: `packages/materials/test/vertex-inputs-browser.mjs` (no pixel differs, RTX A6000 only).

A frame is one colour render pass when only a package draws. The main pass with nothing to draw leaves its clear to a next
pass that declares `joins`; that pass opens its render passes through `context.attach`, and the last one resolves. A clear
nobody took runs before the following pass. Core resolves in a pass of its own only when the graph's last pass did not.
Evidence: `packages/culling/test/gpu/last-pass-check.mjs` (pass counts, frames unchanged) and `tests/modern-msaa.test.js`, RTX
A6000 only; the gain on tile-based GPUs is unmeasured.

**Rendering in a worker (2026-11-05).** Core runs on a transferred `OffscreenCanvas` with no change: it reads no DOM it does not
guard. `@margoengine/worker` gives the canvas `clientWidth` and `clientHeight` and copies `devicePixelRatio` and `margoLow`, so
`resize`, `sceneSamples` and `pick` take the same paths as on the page. Evidence: `packages/worker/tests/browser-check.mjs`
(WebGPU and the WebGL2 fallback in a real worker), RTX A6000 on Chromium only.

**Per-device sharing (2026-11-05).** Three caches hold GPU objects by count and free them with their last holder: `Environment`'s BRDF LUT
per device, size and sample count (a failed create drops its count, and nothing joins that LUT again); gltf-pro's textures per
device, image and format (100 `cloneModel` copies of `p-morph` hold 7 textures, not 700); `@margoengine/shader/raw` buffers per
set of equal bytes, with copy on write. Evidence: `packages/environment/tests/brdf-share.test.js`,
`packages/gltf-pro/tests/model-runs.test.js`, `packages/shader/test/raw.test.js`, and the two browser checks they pair with, RTX
A6000 only.

**Textured meshes on the light path (2026-11-06).** `@margoengine/gltf/textured` keeps a mesh a core mesh, claims its batch and draws it
with core's shader plus a UV input and a texture read, in one extra render pass per frame for all textured meshes of a scene.
WebGPU only. A cut-out picks and casts shadows as solid, and `engine.stats.drawCalls` leaves these draws out. Evidence:
`packages/gltf/test/textured.test.js` and `scripts/test-gltf-browser.mjs`.

**Lighting in a node graph (2026-11-06).** `Material` gains one internal step, `relight`, that runs after the effects composed; it returns
the code unchanged for every other material. `@margoengine/shader/lighting` reads the sun, its shadow visibility, the clustered
lights, the ambient light and the environment as the attached effects worked them out. Rectangle and disc area lights are not
covered. Evidence: `packages/shader/test/lighting.test.js` and `packages/shader/test/lighting-check.mjs` on a real GPU, a graph
Lambert equal to the Lambert shading.

**Motion vectors without the resolve (2026-11-05).** TAA's `velocityOnly` leaves out jitter, capture, history and resolve, so `MotionBlur`
no longer pays for them, and the blur runs inside the `PostStack`. It reads the depth and scene target another plugin made, so a
4x MSAA frame with no `PostStack` throws `state`. Evidence: `packages/taa/test/velocity-only-browser.mjs`, RTX A6000 only.
Plain TAA is unchanged.

**Dithered level changes (2026-11-05).** `LODFade` draws both levels for the fade, each pixel from one by a fixed noise threshold, so
depth stays right with no sorting. Core meshes read the value from a buffer by mesh id, one storage read per core-mesh pixel while
attached; models read a lighting effect's uniform. WebGPU only, instant on WebGL2. Evidence: `packages/lod/test/fade-check.mjs`.
Missing: a measured cost.

### 3.1 Fallback ladder

| Tier | Behavior | Loading and cost |
| --- | --- | --- |
| Native WebGPU | Core `GPURenderer` and all packages | Always attempted first for `backend: 'auto'` or `'webgpu'`. |
| `@margoengine/webgl2-compat/preview` preview | Core meshes, constant-color PBR, one directional plus ambient light; no textures or effects. `/pick` (which also exports `webglRenderer`, so one `loadFallback` import serves a React Canvas) adds a read-pixels `engine.pick`, the route of `Picking` and React pointer handlers on the preview: evidence `packages/webgl2-compat/test/preview-browser-check.mjs`, `packages/react/scripts/test-scene-browser.js`. The pick uses an R32UI 1x1 target and core's projection narrowing; core's refusal stands without it. `/restore` rebuilds programs and buffers after a lost context and makes `rebootDevice` work, with `onDeviceRestored` in each scene; core's refusal stands without it. Evidence: real-browser `packages/webgl2-compat/test/preview-browser-check.mjs` on Chromium, including a real `WEBGL_lose_context` loss; Firefox and Safari not run. `/auto` chooses between WebGPU, the preview and the layer, moving to the layer when a package refuses the preview during `setup`. | App-provided fallback, normally dynamically imported. Separate chunk; 3,407 bytes gzip in the audited size record. |
| `@margoengine/webgl2-compat` | WebGPU-shaped API over WebGL2 so core and feature packages run unchanged | App installs only when native WebGPU is unavailable. Device, translator, and compute entries are lazy. |
| Unsupported message | Page explains that WebGPU is required and does not download demo code | Used below the supported fallback floor. |

Core requests an adapter without a power preference on Windows and with `high-performance` elsewhere. Requested
features are filtered against adapter support. Desktop scenes default to 4x MSAA; phones, the light tier, and exact
size use 1x. `Engine.create` records the native failure before invoking an app-supplied fallback. `exactSize` fixes the
canvas dimensions, disables resizing, and forces one sample.

**Device destroy (2026-11-06).** A frame on the page is an ImageBitmap of the device's own WebGL2 context, so `destroy()` copies it
into a 2D context of the page before it loses the context. Chrome 157 on macOS crashed the tab otherwise. Evidence:
`packages/webgl2-compat/test/destroy-frame-browser.mjs` in `test:gpu`, run on the Apple M6 in Chrome and WebKit and on the RTX A6000 in Edge.

**Native compatibility level (2026-11-05).** `allowCompatibilityAdapters` in `@margoengine/webgl2-compat/adapter` adds a
rung between native WebGPU and the layers: `navigator.gpu.requestAdapter` retries with `featureLevel: 'compatibility'`
when the full level finds nothing. Core changes by 0 bytes: it calls `requestAdapter` at creation and in `rebootDevice`,
so answering there covers both. Compatibility devices take the adapter's limits and rewrite `@interpolate(flat)` to
`either`, which core's pick needs. Evidence: `packages/webgl2-compat/test/adapter-browser.mjs` on a forced device on the
RTX A6000 (D3D12, Chromium): same pixels as the full level, pick hits and misses, restore keeps the level. Missing: a run
on a real OpenGL ES or Direct3D 11 class device, so forced runs prove the validation, not the older GPU's limits.
Packages on the level (2026-11-06): the adapter's `createShaderModule` turns a depth texture that is only loaded into its
float type with `.x` on each load, and default layouts then bind it `unfilterable-float`, so culling's pyramid and
Shadows' nearest depth run unchanged. `compatibilityLevel` in `packages/shared/compat.js` names the rest: Shadows binds
its map a second time as float for the blocker search (a depth texture takes no plain sampler there), `SceneTarget`
copies 4x depth with one masked draw per sample (no `sample_index`), points' eye-dome lighting does the same and draws its depth in a second pass, as bytes in rgba8unorm (r32float does not multisample at the level, and it has no blend to match the colour target's), the frame equal to the full level's on the forced device, Bloom keeps each level in its own texture (no two
views of one texture in a dispatch) and `PostStack` captures 4x in `rg11b10ufloat`. Evidence in the same check: Shadows
0 bytes apart from the full level with a real shadow on the floor, four depth samples read back as written, the post
frame within 2 of 255. Missing: fog, volumetrics, points, water spray and soft `VirtualShadows` (known-bugs.md).

`@margoengine/headless` is outside this ladder: it takes a WebGPU implementation through `installGPU` and a stand-in canvas, so a stage
runs with no page. Stages alive at once share one `gpu`, because `installGPU` changes globals, and `engine.start()` needs
`requestAnimationFrame`, so time moves with `step(delta)`. Evidence: `packages/headless/tests/browser-check.mjs`, on a browser's
WebGPU through the stand-in canvas, and `packages/headless/tests/node-check.mjs`, which runs the README examples in Node on the `webgpu` binding (Dawn), a dev dependency. The stage scene drawn in Node matches the page at changed 0 on the RTX A6000 (D3D12), and the examples run on WARP. Missing: a textured glTF in Node (docs/known-bugs.md); Linux and macOS runs of the binding.

App-side detection must test both presence of `navigator.gpu` and a non-null adapter. The compatibility layer does not
silently install itself and changes no globals at import time.

### 3.2 WebGL2 compatibility architecture

**XR route (2026-11-06).** `installXR()` in `@margoengine/webgl2-compat/xr` replaces `XRGPUBinding` with a binding on an
`XRWebGLLayer`, so `@margoengine/xr` keeps one renderer: each eye resolves into its own texture and `present` draws it
into the opaque framebuffer after the submit, and the view's projection is remapped to z in [0, 1]. Evidence:
`packages/webgl2-compat/test/xr-browser.mjs` in `test:gpu`, 0 differing pixels in both eyes on the RTX A6000 with stand-in
XR objects. Missing: a real headset.

**XR through the engine (2026-11-07).** An engine made by `createXREngine` (`@margoengine/xr`) asks for its adapter with
`xrCompatible: true`, so `XR.create` shares its device and draws each eye as one view of `engine.render({views})`: every
package pass and post effect runs per eye as it runs per view on the desktop. Each eye renders into a texture, a blit copies
it into the layer's sub-image, and a second blit writes the layer's forward depth24plus depth as 1 minus the scene's reversed
depth (the nearest sample). In AR the alpha is the share of samples that wrote depth, or the brightest channel where none
did. Evidence: `tests/modern-xr-passes.ts` in `modern:test:xr:browser`, both eyes byte-equal to a desktop render of the same
camera with a line, a point cloud, terrain and bloom, on the RTX A6000 with a stand-in session. On the WebGL2 layer
(`installXR()`), `packages/webgl2-compat/test/xr-browser.mjs` (in the layer's `test:gpu`) runs the same route with a line
into a stand-in XRWebGLLayer over a real WebGL framebuffer: `xr.route` is 'engine' and both eyes match the native route
with no pixel over 2 (2026-11-07, RTX A6000, Chromium). Missing: a real headset.

**Terrain on the layer (2026-11-08).** The clipmap terrain (`@margoengine/terrain`) and its runtime virtual texture run
on the layer with no route of their own: their passes are draws, which the layer translates unchanged. Evidence:
`packages/terrain/test/compat.browser.mjs` in terrain's `test:gpu` draws rules only, painted weights with a hole, and the
virtual texture natively and on the layer in exact-pixel mode; no pixel differs by more than 1 of 255, and a frame of six
clipmap levels is 6 GL draws and 48 GL calls (Radeon 680M, ANGLE on Direct3D 11, Edge 157). Missing: frame time on the
layer, other GPUs and back ends, and the terrain entries with compute passes (`sculpt`, `deform`, `displace`).

`install()` returns without changes when real WebGPU has an adapter, unless forced. Otherwise it probes WebGL2,
requires highp fragment floats/ints and `EXT_color_buffer_float`, defines a `CompatGPU` at `navigator.gpu`, patches
only `getContext('webgpu')`, and installs missing WebGPU flag constants. `uninstall()` reverses those changes. Lower
half-float and LDR capability tiers are detected but not accepted because the engine depends on HDR and float-data
targets.

Each compatibility device owns a separate WebGL2 context with antialias, depth, and stencil disabled. WebGPU-style
attachments are explicit. Four-sample pipelines use multisample renderbuffers and resolve by blit; exact-pixel mode
stays unsmoothed. The canvas texture is offscreen and is y-flipped only at presentation, which occurs at the end of
each submit so same-task canvas reads see the current frame.

Translation pipeline:

1. Tokenize complete WGSL, including nested comments, Unicode identifiers, numeric forms, and template discovery.
2. Parse the full grammar and its operator restrictions.
3. Resolve and type-check declarations, pointers, abstract numbers, overloads, constants, layouts, stages, and entry
   interfaces; detect declaration cycles.
4. Produce typed IR carrying folded values, spans, and entry-point reachability.
5. Report coded syntax, type, or limit errors with Unicode-aware line/column and help links. Limits include 4 MiB
   source, 255 nesting levels, and 65,536 values in one constant.
6. Emit GLSL ES 3.00 with WebGPU layout semantics, integer operations, conversions, clamped indexes, combined
   samplers, storage reads through data textures, and helpers for missing GLSL builtins.
7. Build resources, render pipelines, a state cache, canvas presentation, and command replay.
8. Analyze compute IR and choose a GPU or CPU execution tier.

Uniformity analysis is intentionally omitted because the recorded corpus already passes the browsers' compilers.

Mapping details:

- `EXT_clip_control` supplies WebGPU depth range. Rendering flips y so textures keep a top-left origin; presentation
  flips back.
- Bind-group entries map to uniform blocks and texture units per pipeline.
- Storage-buffer render reads use RGBA32UI data textures with 16-byte texels and clamped accesses. Bindings in one
  group share a texture, reducing texture-unit pressure.
- Base vertex and base instance use uniforms because measured WebGL2 targets lacked the extension.
- Without indexed draw-buffer state, outputs with matching blend state are grouped; depth/stencil-writing cases that
  cannot be preserved are refused.
- Render shaders that write storage resources are refused.

### 3.3 Compute tiers

| Tier | Selection | Execution | Important limit |
| --- | --- | --- | --- |
| Fragment | Stores map each invocation to its own renderable texture texel and no buffer is written | Full-target draw, scissored per target/slice | Target must be renderable. |
| Scatter | Bounded stores with no same-invocation read-after-write hazard | Instanced point draw per target; buffer words use R32UI textures | At most 1,024 stores per invocation per target. |
| CPU | Atomics, workgroup memory, barriers, unbounded store loops, hazards, unsupported formats, or f16 uniform cases | Typed IR emitted as JavaScript; one invocation at a time, generators across barriers, f32 rounded with `Math.fround` | Under a CSP without `unsafe-eval` the same JavaScript runs on an interpreter (`compute/interpret.ts`), 13 to 41 times slower; cannot read cube, multisampled, or external textures; GPU-written inputs can cause synchronous stalls. |
| Package alternate path | Planned for large atomic, sorting, or GPU-driven workloads | Feature-specific implementation | No recorded shader required it at the snapshot. |

Package routes now cover VFX, scatter (not `ScatterTiles`) and the sky's light projection as well as DOF, splats,
culling and shadows. A CPU-tier kernel that reads a GPU-written resource waits for all GPU work before it, so one small
kernel can cost a whole frame: the sky projection cost 57 ms that way. Evidence: `routes.test.js` and the frame budget of
`visual:compat:budget`; the integrated-GPU budget run is still missing.

A route that reads a resolved multisampled depth must allow for the layer reading it as one sample (WebGL2 cannot
read one sample of a multisampled texture). DOF's route takes the nearest depth of each pixel and its four neighbours
when the capture is multisampled; without it silhouette pixels kept the background's depth under the object's colour
and every far gather drew a faint ring (2026-11-08). Evidence: `packages/dof/tests/gpu/compat-check.mjs`.

Texture read-back left the layer's base on 2026-11-06 (`device/readback.ts`, 70,274 B base): the queue holds a submit
with a `copyTextureToBuffer` until the chunk has loaded, as it does for compute, and the sizes gate measures the chunk in
the split's lazy number. Evidence: `tests/lazy-boundary.test.js` and `readbackOrder` in `compute-browser.mjs`.

The voxel path tracer has a route too (`packages/voxel-pathtracer/src/compat.ts`): `trace` runs as a fragment shader
cut from the WebGPU kernel's own text, writing four `rgba32float` targets, and a scatter kernel adds them to the image
buffers. Evidence: `packages/voxel-pathtracer/tests/browser-check.mjs --compat` on ANGLE Vulkan. Still missing: a run on
ANGLE Metal and on an integrated GPU. ANGLE on Direct3D 11, the default on Windows, does not finish `trace`: Microsoft's shader compiler was still running at the 50 minute limit, three times (its smaller kernels take 27 to 86 s each), while the page kept drawing at full rate. So that route shows the raster image and never a traced frame (`docs/known-bugs.md`).

The CPU tier's `new Function` applies only to this opt-in compatibility path, and a strict policy sends it to the
interpreter instead of refusing it. General claims that nothing builds code at run time must stay scoped to the native
engine. Evidence: `packages/webgl2-compat/test/interpret.test.js` compares the two paths over the corpus, and
`compute-browser.mjs` reruns every case under a real policy; there is no quiet speed record of the interpreter yet.
The two paths compare bytes, so a NaN must have one encoding: JavaScript lets an engine write any NaN bits, and V8
wrote different signs on the two paths (2026-11-08). The CPU tier writes every stored, bitcast or packed NaN as
0x7fc00000 (f16 0x7e00), which WGSL 15.7.2 allows; `test/nan-encoding.test.js` holds it on both paths.
Recorded A6000/Edge measurements for CPU clustered binning
over 3,456 clusters were 1.5 ms with 16 lights, 2.8 ms with 64, and 9.4 ms with 256; a 64-wide reduction with seven
barriers reached 4.4 million invocations per second.

`@margoengine/geometry/gpu` has no route through these tiers: `GeometryGenerator` writes core's vertex buffers from a
frame pass at order -1000 and refuses the WebGL2 backend with `unsupported`. Evidence: `npm run test:gpu` in
`packages/geometry` on the RTX A6000, reading vertices back and rebuilding after `rebootDevice`.

`@margoengine/bvh/gpu` has no route through these tiers either: `GPUMeshBVH` takes a `GPUDevice` and refuses anything
else with `unsupported`; WebGL2 keeps the CPU tree. Its ray test is float32 and watertight, with a four-step slack on
each node's exit distance, so rounding never loses a hit. Evidence: `npm run test:browser` in `packages/bvh` on the
RTX A6000 compares 100,000 rays with the float64 CPU tree and fires 123,200 rays at vertices and shared edges from
inside a closed mesh.

`@margoengine/bvh/gpu-build` follows a vertex buffer the GPU writes, on the same WebGPU-only terms. A build is Morton codes, a
bitonic sort and the Karras hierarchy, then bounds climb one level a dispatch: a node's stamp names the dispatch that
finished it, and a parent reads only children stamped by an earlier dispatch, because threads of one dispatch have no
order. Evidence: trees read back and walked node by node, and rays through a pose only the GPU wrote, against a float64
CPU tree, in `packages/bvh/tests/gpu-build-browser.js`.

`CulledMeshes` with `occlusion` runs before core's main pass, so it cannot read core's depth, which has no texture binding
anyway: it redraws last frame's large kept instances depth-only with this frame's camera, at the scene's sample count,
and shares the Hi-Z pyramid of `packages/culling/src/pyramid.ts` with `CulledInstances`. An instance is hidden only
strictly behind the farthest occluder depth in its footprint, so the image is core's. On the WebGL2 layer it stays
frustum and screen size. Evidence: `packages/culling/test/gpu/meshes-occlusion-check.mjs`, 0 differing pixels against
core through camera and occluder changes, 9 of 1,509 instances drawn behind a wall, RTX A6000.

`CulledModels` (`@margoengine/culling/models`) runs the same cull on `PBRInstances` rows, world = node matrix x row. gltf-pro
reads `primitive.redirect` as core reads `Batch.redirect`, so its colour and depth replays draw the kept rows; casters and
picking keep every row. Evidence: `packages/culling/test/gpu/models-cull-check.mjs`, 0 differing pixels with and without
shadows, RTX A6000. A primitive without instances gets one 20-byte indirect record from one dispatch and gltf-pro draws it
through `primitive.culled`, so a culled one still costs its draw call on the CPU (WebGPU has no multi-draw). With
`occlusion` both tests also read the shared pyramid, built each frame from `addOccluder` surfaces drawn with this frame's
camera, as for `CulledInstances`. Evidence: `packages/culling/test/gpu/models-plain-check.mjs`, 0 differing pixels on the
real NodePerformanceTest.glb (2,066 of 10,000 primitives drawn close up) and through a wall that moves in, 1 of 146 drawn
behind it, RTX A6000. Still missing: a timed run, skinned and morphed primitives, and members of an instanced batch.

`addOccluder` puts core meshes, models and Terrain into the occluder pass of `CulledInstances`, each with the maths of its
own draw (core's `camera*(model*p)`; Terrain's rings on its own uniforms). An occluder must be a surface the frame shows,
so only front faces draw, by the sign of the matrix, and cut-out, blended, displaced and clipped primitives are left out.
Evidence: `packages/culling/test/gpu/occluders-check.mjs`, 0 differing pixels against core, 0 of 576 parts drawn behind a
core wall, a materials wall and a terrain ridge, RTX A6000.

`bounds: 'box'` on `CulledInstances` adds each geometry's local box after the sphere tests: the box under the part's matrix
is an oriented box, its radius along a plane normal is exact, and its nearest depth is at a corner. It can only drop more than
the sphere, so a part it keeps is unchanged. Hi-Z still compares one nearest depth with the farthest occluder depth in a
screen rectangle, so a long part behind a slanted surface stays in. Evidence: `packages/culling/test/gpu/bounds-check.mjs`,
0 differing pixels against core, 0 of 900 rods drawn by box and 900 by sphere under a plate from above, RTX A6000.

`@margoengine/culling/shadows` culls casters per cascade: `prepareShadow` runs one thread per row, tests its sphere against the
six planes of each light matrix (Gribb and Hartmann rows, padded for float32) and appends the row to that cascade's list by
atomic add. List order is free, because a depth-only pass keeps the nearest depth in any order. A caster outside a light box
clips away in that pass, so the map is unchanged. The draw reads rows through an instance-rate u32 vertex buffer, so a batch's
list is a plain vertex buffer offset. Evidence: `packages/culling/test/gpu/shadows-cull-check.mjs`, 0 differing pixels against
every caster drawn in every cascade, RTX A6000. Still missing: a timed run.

Imposters (`@margoengine/lod`) draw 96 bytes an instance: world matrix, colour, emissive. As a shadow source a `LODSystem`
draws, per cascade, a card facing the light per object, reprojecting the ray along the light onto the nearest atlas view with
one parallax step, and stands the depth back by `r*(2/(frames-1)+4/frameSize)` so an imposter does not shadow itself. Evidence:
`packages/lod/test/imposter-full-check.mjs` on the RTX A6000. Missing: other GPUs, and a measure of the cost per cascade.
`@margoengine/selection` asks each engine plugin with `drawSelectionMask` to mark its own pixels; a `LODSystem` redraws the
selected imposters with the same fragment shader at the same depth. A pixel of alpha 0 is discarded whatever `fwidth` says:
it holds no depth, and once landed on the eye, in front of any wall. Evidence: `packages/lod/test/imposter-outline-check.mjs`
on the RTX A6000. Missing: other GPUs.

Shadow outlines have an outside reference: `packages/shadows/test/outside` compares a real glTF model's shadow on a white
ground with Blender Cycles, each side giving the ground's light with the model over its light without it, so no Margo
code decides the answer. Evidence: overlap 0.98 on DiffuseTransmissionPlant and 0.91 on AlphaBlendModeTest's masks, 0.31 with
the masks off. Missing: other GPUs.

`VirtualShadows` takes `drawShadow` sources: a source keeps one uniform per cascade slot and writes it with
`queue.writeBuffer`, which runs before the submit that follows it, so pages go four at a time, each batch in its own
encoder and submit, and the sources need no change. Feedback runs after the pages, because a custom receiver draws there
with slot 0 and the camera's matrix. Voxels read `shadowReach()` where the shadow pass defines it, as `VirtualShadows` does,
since `splits` is a field of the cascades' uniform alone; terrain reads its lighting group's layout from the WGSL the effects declared, since a table of
binding numbers fitted only `Shadows`. Evidence: `packages/shadows/test/virtual-custom-browser.mjs`, overlap 0.97, 0.95 and
0.95 with `Shadows` for culled parts, scatter and voxels; real Mount Rainier elevation against Blender Cycles, overlap 0.86
(`Shadows`) and 0.81 (`VirtualShadows`), 0 with the terrain not casting, RTX A6000. Missing: other GPUs.

Terrain layer materials (`@margoengine/terrain/layers-pbr`, 2026-11-07) are a lighting effect in the same group, at
bindings 90 to 92: they patch the layer loop (a height-blend factor on each weight, then the layer's normal and surface
samples) and wrap the fragment so the per-pixel roughness is written into the input before any later lighting code reads
it; the tilted normal is a surface gradient from the three projections' volume gradients (Mikkelsen 2020), so no tangents
exist and shadows and clustered lights see the same `n`. SSR's capture keeps the geometric normal and terrain roughness.
Evidence: `packages/terrain/test/layers-pbr.browser.mjs`, flat maps 0 of 255 from the terrain's own shading with rules,
painted weights and bump; tilts lit from the right side on both axes; real CC0 rock maps 1.6 times the luminance spread of
colour alone; Radeon 680M. Missing: other GPUs, cost timed.

Terrain near displacement (`@margoengine/terrain/displace`, 2026-11-08) sits after the layer materials at bindings 97 and
98: it wraps the materials' fragment so the view ray's hit (parallax occlusion) replaces the shading position, keeps the
surface's own derivatives for every texture read, and multiplies the sun's direct term by the relief's self-shadow. The
shadow ray walks a maximum mipmap (Tevs, Ihrke and Seidel 2008) built from the surface maps' alpha by a compute pass at
attachment, so it cannot step over a ridge; a fixed-count march did (0.08% of the rock shadowed where a CPU trace gives
2.85%). Evidence: `packages/terrain/test/displace.browser.mjs`, shadowed share 2.71% and 30.7% against a CPU trace's
2.76% and 30.85% at 10 and 30 cm of relief; parallax 3.07 of 255 from real geometry, flat 24.5; Radeon 680M. Missing:
other GPUs, cost timed.

Terrain deformation (`@margoengine/terrain/deform`, 2026-11-08) sits at bindings 99 and 100 and wraps the terrain's lit
fragment (whatever effects came before): each near fragment's view ray is marched through a camera-centred relief map
(parallax occlusion, offset limited), the hit's XZ on the undeformed tangent plane replaces the shading position (so
shadow lookups still see the surface the shadow map holds) and the relief's slope bends the normal. The map is written
by compute passes: an atomic maximum over float bits keeps the deepest print a texel, a fixed refill a second fades
them, and a moving window clears the texels it exposes. Evidence: `packages/terrain/test/deform.browser.mjs`, map to
0.06 mm of the CPU profile, picture 6.6 of 255 from real geometry (flat 33.3); Radeon 680M. Missing: other GPUs, cost
timed.

Mesh to terrain blending (`@margoengine/terrain/blend`, 2026-11-08) patches core's standard fragment through the same
mesh-ID varying and per-pixel block as `TerrainColors` (shared in `terrain/src/mesh-patch.ts`, so either runs first
and the shader holds one copy). At the top of the block, where control flow is uniform, it takes the pixel's footprint
from the position's screen derivatives; per blended mesh (a storage row by mesh id) it reads the ground height from the
heightmap, fades the colour toward the virtual texture's, roughness toward the terrain's and the normal toward the
heightmap's over `height`, so core's lighting shades the mesh's foot as the ground. Evidence:
`packages/terrain/test/blend.browser.mjs`, seam 126.6 to 6.8 of 255, nothing off the foot changes; Radeon 680M.
Missing: other GPUs, cost timed, sloped ground in a picture check.

World-space UI panels (`@margoengine/ui/world`, 2026-11-08) share the screen UI's drawing core (`ui/src/painter.ts`,
used by `UiRenderer` too, so one copy of the instanced rectangle and SDF glyph pipeline): each panel's draw list is
painted into an `rgba8unorm-srgb` texture in its own submission only when the list or the glyph atlases changed, then
mipmapped, and a quad pass at order 25 (inside the scene, before post-processing) samples it with depth test against the
scene, one camera uniform per view index so XR eyes never share a buffer written in the same frame. Evidence:
`packages/ui/tests/world-browser.mjs` on a Radeon 680M (colours, occlusion, back face, repaint counts, a real click by
camera ray). Missing: other GPUs, an XR headset, cost timed.

Screen UI on the WebGL2 preview backend (`@margoengine/ui`, 2026-11-08): `ui/src/painter.ts` builds one `UiBatch` of
rectangle and glyph instances (16 floats each) for either backend; `ui/src/gl.ts` draws it with instanced attributes and
two GLSL ES 3.00 programs that compute the same rounded box distance and SDF coverage as `ui/src/shader.ts`. WebGL2 has
no base instance, so each run moves its attribute offsets to its first instance; clip regions are scissors in GL's
bottom-up rows; the atlases are `TEXTURE_2D_ARRAY` (R8 for SDF, RGBA8 for colour glyphs) grown by reallocation and
re-upload. The code is a separate chunk loaded on the first WebGL2 frame. Evidence: `packages/ui/tests/webgl2.test.js`
(a recording WebGL2 context: draws, offsets, scissors, texture units, lost and restored contexts) and the WebGL2 check
in `packages/ui/tests/ui-browser.js` on a Radeon 680M (colours, rounded corner, text ink, clipped list, unchanged
frame). Missing: other GPUs, WebKit and Firefox, world panels on WebGL2.

Planet terrain (`@margoengine/terrain/planet`, 2026-11-08) draws a cube sphere quadtree with its own pass and shader.
Precision: each patch stores float32 vertices relative to its float64 centre; each frame the CPU subtracts the camera
position from each drawn centre in float64 (one instance attribute a patch) and builds a view-projection with no
translation from the camera's position, target, up and projection, so no float32 value holds a world coordinate; depth is
core's reversed z. Evidence: `packages/terrain/test/planet.browser.mjs`, the disc from orbit within 0.2% of a sphere's
projection, the horizon dip within a pixel, no sky through the ground and the same picture with a `FloatingOrigin` at
6,371 km from the world origin; Radeon 680M. Missing: frame cost, other GPUs, shadows and lighting effects on it.

Both shadow classes take `effects`: objects that declare WGSL at bindings 40 and up (four each), give a factor that
`shadowLit` multiplies the sun by, and update once a frame after the depth passes. With none the shader text is what it was,
which the golden GPU proofs pin. `cloudShadows` runs the sky's cloud remap and erosion along the ray to the sun, with the
sky's noise text, clock and height read from `sky.cloudLayer`, so there is one cloud field, not a copy. `check.mjs` in
`packages/shadows/test/outside` now reads partial light back through Khronos PBR Neutral's toe on a white ground below the
curve's shoulder: until then only full shadow was measured, and partial values on a dim blue ground read too dark. Evidence:
`packages/shadows/test/outside/check.mjs`, a real image as `lightPattern` against a real sheet of it across the sun in Cycles,
overlap 0.996, mean difference 0.0074, 0.71 and 0.26 for the same mask shifted; `packages/shadows/test/light-function-browser.mjs`,
ground and the sky's own render along the sun ray agree on all 256 points, before and after 2,400 m of drift, against 0.64 for
the old ground and the new sky, and core meshes, materials, gltf-pro, terrain and voxels go dark under a black pattern in both
classes. Missing: other GPUs; a real cloud photograph over real ground is not the claim, the claim is agreement with the sky.

`VolumetricClouds` (`@margoengine/sky/volumetric-clouds`) ray marches a layer between two shells around the planet in one
full-screen fragment pass at order 3, between the sky and its fog. f32 cannot form |o|^2 - (R + h)^2 at planet scale, so the
shell roots use the constant |e|^2 + 2R(e_y - h) - h^2 from the camera's own position and the stable quadratic form, and a
point's height is (|p|^2 + 2R p_y) / (|o| + R). Two tiling noise volumes are generated once by compute on the first frame and
after a device loss; the sky light is reduced from the sky's reflection map by one 64-thread workgroup each frame. Without a
depth texture the pass depth-tests against the cleared sky; with one it reads the first sample of multisampled depth.
Evidence: `packages/sky/test/features-check.mjs` (coverage 0 exact, coverage, depth occlusion in front of and inside the
layer, motion) at 4x and 1x on a Radeon 680M. Missing: other GPUs, a quiet timing, a comparison with a reference renderer.

`volumetricCloudShadows` (`@margoengine/sky/cloud-shadows`) is a shadow effect that renames the clouds' WGSL field with its
binding (`shadowFxCloud...N`) and marches it from each receiver to the light. It keeps its own noise volumes, filled by the
same deterministic generator on its first update, and writes the layer fields with the clouds' own `writeLayer`, so it
shares no GPU object with `VolumetricClouds` and survives either side's device loss alone. Evidence: `features-check.mjs`,
48 ground points against the clouds seen from each point toward the sun, mean 0.0018 before and 0.0021 after 1,500 m of
drift, 0.29 for stale shadows; Radeon 680M. Missing: other GPUs, any timing, a soft edge from the sun's size.

`AerialPerspective` (`@margoengine/sky/aerial`) is the first user of `atmosphere-luts.ts`, the sky's Hillaire 2020 model in
kilometres: a 256 x 64 transmittance table (Bruneton 2017 mapping) and a 32 x 32 multiple scattering table, recomputed only
when the medium changes, and a 32^3 camera volume each frame, one thread per column marching its slices in turn. Ray
and sphere constants use (|o| - r)(|o| + r), so a camera a metre up keeps its horizon in f32. The composite is two blended
draws in one pass (dst x T, then + L), exact per channel without dual-source blending, which core does not request.
Evidence: `features-check.mjs` aerial, transmittance within 0.006 of a CPU Beer-Lambert integral at 1, 10 and 40 km on a
Radeon 680M. Missing: other GPUs, any timing, an in-scattering reference.

`HillaireSky` (`@margoengine/sky/hillaire`) is the second user of `atmosphere-luts.ts`: the same transmittance and multiple
scattering tables, plus a 192 x 108 sky-view table each frame (azimuth from the sun over a half turn, zenith angle
squeezed toward the horizon) that every sky pixel reads. With the camera above the top radius the table is not made and
each pixel marches its own chord through the air, entry and exit from the top sphere's two roots. The draw is the root
Sky's: a fullscreen triangle at reversed-Z 0 with `greater-equal`, so only clear depth takes it. The disc's radiance is
held at 65,504 so an rgba16float capture never takes an infinity. Evidence: `features-check.mjs` hillaire on a Radeon 680M
at 4x and 1x: blue noon, orange sunset, ozone's bluer twilight zenith, the ground, limb and black space from 1,000 km, and
the table and the march within 0.05% on one ray across the top; the CPU sun transmittance against the closed-form vertical
optical depth to 1e-4. Missing: other GPUs, a reference image or radiance from another renderer, timing (4 to 6 ms per
frame at 128 x 96 with Bloom, diagnostic).

The Bruneton `Sky`'s `groundAlbedo` (`@margoengine/sky/bruneton`) adds the ground as a boundary to the four-order
precomputation, built the first time an albedo above 0 is set: per order a 64-texel irradiance pass (the direct sun,
then the order before over the upper hemisphere) and a density pass that adds albedo / pi times that light, through
the air between, for directions that end on the ground. At 0 the sky runs the passes and shaders it had before, so
the recorded traces stand; a change of albedo rebuilds the scattering once, not the transmittance. Evidence:
`features-check.mjs` albedo on a Radeon 680M at 4x and 1x (snow +113% at the horizon, sand +49%, albedo 0 bit for
bit). Missing: other GPUs, a reference sky, timing.

`@margoengine/sky/presets` holds other worlds for the Hillaire model (`EARTH`, `MARS`, `marsAtmosphere`). To colour
Martian dust the medium now reads Mie scattering and absorption per channel: two vec4s at the end of the `Atmosphere`
uniform (now 224 bytes), which the extinction, the in-scattering and the multiple scattering table read, and the CPU
sun transmittance per channel too; a number still means grey. The tables are keyed on them, so a new preset rebuilds
both once. Evidence: `features-check.mjs` presets on a Radeon 680M at 4x and 1x (Earth blue and bit-identical to the
default, Mars red over blue 1.17, a storm 1.82), and the hillaire, aerial and shafts checks unchanged. Missing: other
GPUs, a photograph or reference renderer of Mars, timing.

`LightShafts` (`@margoengine/sky/shafts`) is a screen-space pass after the aerial perspective (order 4.5): a half-size
r16float mask of open sky (2 x 2 depth taps) times the clouds' transmittance along each view ray, from its own copy of
the cloud noise volumes, then a fullscreen draw that walks the mask toward the sun's projected position and adds light
with one-one blending. The sun's screen place is the projection of its direction (w = 0); its clip w is the cosine to
the view axis and fades the effect, so a sun behind the camera adds nothing. Normalizing by the summed weights makes
the blur a share of lit air, so the added light is linear in `intensity` and exactly 0 where every sample is occluded.
Evidence: `features-check.mjs` shafts on a Radeon 680M at 4x and 1x. Missing: other GPUs, a reference renderer,
timing (about 12 ms per frame at 256 x 192 with Bloom, diagnostic), off-screen occluders.

`WeatherFX` (`@margoengine/sky/weather-fx`) draws its occluders each frame (order 5.9) into a depth32float map from above,
an orthographic view over the weather's box snapped to its texel grid; each occluder's world matrix sits in one storage
buffer read by `firstInstance`, so the draws share one bind group. `Weather` reads the map through a hook
(`weather.occlusion`, its `shader(code)` adding the cover read), so the weather entry carries no cover code; its
`ParticleOverlay` (packages/shared) now takes extra bind group entries and rebuilds its pipeline when the shader
changes. A one-thread compute step keeps the lens wetness on the GPU. Evidence: `features-check.mjs` weather-fx on a
Radeon 680M at 4x and 1x. Missing: other GPUs, timing, cover finer than a texel.

Sleet (`precipitation: 'sleet'`, 2026-11-07) is two `ParticleOverlay` draws in the weather's pass, rain then snow,
each with its own uniform buffer (one uploaded buffer holds one draw's values within a submit) and the snow on its own
hash seed, so the two never share spots. Evidence: `features-check.mjs` sleet on a Radeon 680M at 4x and 1x against
each kind drawn alone. Missing: other GPUs, timing.

Puddles (`@margoengine/weather/puddles`, 2026-11-07) is a hook into core's mesh shader at frame graph order -1, like
`ShaderEffect`: it renames the fragment input and works on a copy named `i`, setting its colour, roughness, metalness
and normal before core lights it, so every later hook (sky ambient, environment lighting, fog) reads the wet surface.
The shared `patchFragment` (packages/weather/src/scene-patch.ts) lets a second surface hook chain on the same copy. One
32-byte uniform at group 0 binding 160 a frame. Evidence: `browser-check.mjs` puddles on a Radeon 680M at 4x and 1x
(WGSL against JavaScript, dry untouched, water on ground not walls, rings only on water). Missing: other GPUs, timing.

Snow (`@margoengine/weather/snow`, 2026-11-07) is the second surface hook: besides the fragment change it rewrites
core's vertex line `let p=model*vec4f(i.position,1);` to lift the world position by the snow's thickness, from the
world normal it computes the same way core does, before the clip position. A vertex stage that another package
replaced has no such line, and the snow there is colour and grain only. One 48-byte uniform at group 0 binding 161.
Evidence: `browser-check.mjs` snow on a Radeon 680M at 4x and 1x (the plate's edge rises where the camera projects
it, snow with puddles on one shader). Missing: other GPUs, timing, the slit on split-normal meshes.

Hail lighting and splashes (2026-11-07): `Hail` reads `engine.lighting` each frame into its uniform (now 240 bytes) and
shades each stone in its fragment stage as a ball, its normal built from the place across the streak; splash chips are
extra instances of the same `ParticleOverlay` draw (stones times one plus `splashes`), each a closed-form ballistic path
from its stone's first landing. Evidence: `browser-check.mjs` hail on a Radeon 680M (lit 9.5 times brighter toward the
sun than away, flat unchanged by it, chips near the ground). Missing: other GPUs, timing, scene shadows on stones.

AstroSky (`@margoengine/sky/astro`, 2026-11-07) is a `ParticleOverlay` draw at frame graph order 2.5, after the sky's
pass and before fog: one storage buffer of three vec4 a point (the J2000 vector and magnitude, colour, proper motion a
Julian year; the seven planets the last points, rewritten each frame), the sky matrix (precession, nutation, sidereal
time, latitude) in its uniform, refraction and air-mass extinction in the vertex shader, and each point at the far plane
so only open sky shows it. It reads the sky's `nightFactor` in its pass, after the sky's own pass has set it, so day
and night switch on the same frame. Straight alpha subtracts the sky times the alpha, so on a float target the alpha is
the brightest channel over 64 and the star's light is added within 0.1%. The night shader's moon takes its lit limb
toward the sun when `moonLitBySun` puts 2 in the night's enabled slot. Evidence: Meeus' worked examples in
`astro.test.js`; `features-check.mjs` astro on a Radeon 680M at 4x and 1x for star places and light, the horizon, day
and the moon's limb. Missing: other GPUs, timing.

A `ShadowFilterEffect` replaces the named filters' last step in `shadowVisibility`, after the cascade pick and the receiver
plane. `varianceFilter` turns the depth map into two moments, blurs them by two separable passes when the map changes, and
bounds the lit share with Chebyshev's inequality. A filter's shader must keep `shadowSampler` read, in a branch never taken,
since 'auto' layouts drop what no code reads; `shadowSampling` adds that branch. Evidence:
`packages/shadows/test/vsm-browser.mjs`, on a straight edge 2.7 pixels wide at blur 2 and 11.1 at blur 16, and row-to-row
grain 0.00023 against 0.0033 for PCSS; `check.mjs`, the real plant under a soft Cycles sun, overlap 0.76 and mean difference
0.0088, PCSS 0.97 and 0.0010. RTX A6000. Missing: other GPUs, and any timing.

A surface lit from behind has to look up its shadow on the side facing the light: `shadowVisibility` offsets along the normal,
which on a leaf's far side lands behind the leaf. A shader that declares `margoLightSide` (gltf-pro with diffuse transmission)
gets that normal through the `direct` hook's second argument, and every other shader's text is unchanged. `transmission`
moves what `transmits` to the tint map, and its effect's `tint` expression scales the light by the disc form factor over the
gap to the caster, read from the tint depth. Evidence: `packages/shadows/test/transmission-browser.mjs`, from under the real
plant leaves keep 0.34 of the light through them, 0.06 without the fix; `check.mjs`, deep in the shadow 0.0001 and Cycles'
translucent BSDF 0.0023 on the plant, 0.05 for light going straight on, 0.04 and 0.004 on the Teacup. RTX A6000. Missing: other
GPUs, transmission textures, more than one scatter.

Past `shadowReach()` the depth maps end, and `distanceShadows` takes over from a height field. A compute pass marches each cell towards the sun and keeps the highest plane `height - d * tan(elevation)` and its distance `d`, so one `vec2f` per cell answers for that sun: a receiver below the plane is behind the ridge. The light is the segment of the sun's disc above that horizon, with `d * sunSize` as the disc's height. The storage buffer costs no sampled texture, and gltf-pro already uses all 16 per stage. The march reruns only after the sun moves `sunStep` degrees. Each step spans the shorter cell side, so the step count scales with the cell's aspect. Evidence: `check.mjs`, real Rainier elevation with `distance` 30, overlap 0.85 and mean difference 0.016 against Cycles on both shadow classes, overlap 0 without it; `packages/shadows/test/distance-browser.mjs`, the disc share within 0.003 of the formula at three distances. RTX A6000. Missing: other GPUs, and any timing.

An effect with `style` wraps the light's whole shadow in `shadowLit`: `direct*style(vec3f(1)*visibility*tint*calls)`, so it sees the map, tinted casters and the other effects as one. With no style the text of `shadowLit` is unchanged. `shadowStyle` is `mix(floor,1,shade)` with `floor` from `intensity` and `color` on the CPU. Evidence: `check.mjs`, the real plant against two Cycles suns, one casting and one not, whose colours sum to white: 0.283 against 0.287 in red, 0.684 against 0.684 in blue, 0.292 under `VirtualShadows`, 0.003 with no style. RTX A6000. Missing: other GPUs, and any timing.

`rayTracedFilter` is a filter effect whose body walks `bvhWGSL` in the fragment shader, with the tree's names prefixed `shadowFx` so `moveEffects` carries them. It takes six bindings, so each effect now has eight from `EFFECT_BINDING`. Rays leave `position` along the normal and spread over the sun's disc on a Vogel spiral turned per pixel, as the soft filter's taps are. `GPUMeshBVH.forShader` uploads without a pipeline, so `setup` can rebuild the tree synchronously after a device loss. WebGPU exposes no ray queries, so there is no hardware path yet; this is the place for one. Evidence: `check.mjs`, the real plant against Cycles, overlap 0.97 and mean difference 0.0016 with one ray, 0.97 and 0.0010 under a soft sun with 64 rays, 0 with an empty tree. RTX A6000. Missing: other GPUs, any timing, alpha masks in the tree.

`LodInstances` (`@margoengine/culling/lod`) tests each instance against the frustum and picks its level in one compute pass:
the level is the first whose limit the world sphere's radius in pixels reaches. Instances append to their level's list by
atomic add, and the counts are copied to each level's indirect arguments, so core draws each list through `Batch.redirect`. On
the WebGL2 layer every shown instance draws the first level. Evidence: `packages/culling/test/gpu/lod-check.mjs`, 0 differing
pixels against core meshes with levels worked out on the CPU, RTX A6000. Still missing: a timed run.

`MeshletMesh` (`@margoengine/culling/meshlets`) splits one mesh into clusters of up to 64 vertices and 124 triangles, grown
breadth first over shared vertices. One workgroup per cluster tests its sphere against the frustum and, on a single-sided
batch under a perspective camera with a positive determinant, its normal cone against the camera, then appends its indices
to the part's region of a kept index buffer that the main pass draws, one indirect draw per part. `'occlusion'` culling adds the
Hi-Z test between the two, and each shadow cascade runs the same kernel against its light box into lists of its own in
`prepareShadow`. Core's shader takes vertices as attributes, so no vertex pulling: a region per part is what keeps it one
draw each. The cone test is in the mesh's own space: which side of a plane a point is on
survives any affine map of positive determinant, so uneven scale needs no wider cone. It drops only triangles the back-face
discard would drop. Evidence: `packages/culling/test/gpu/meshlets-check.mjs`, 0 differing pixels against a core mesh, RTX
A6000, for one part, three parts, Hi-Z and a shadow cascade. Still missing: a timed run, and occluders from last frame's clusters
instead of whole parts.

`DynamicInstances` builds kept records from the rows in its scatter; a `fill` kernel writes `world` once per cull, only for what reads it,
`prepareShadow` and `pick`. A scene with shadows pays what it paid before and the compatibility route is unchanged. Evidence:
`packages/culling/test/gpu/dynamic-check.mjs`, frames equal to core meshes with shadows on and off, and picks that agree, RTX A6000.
The removed traffic was not the main cost (perf-history entry 54; known-bugs.md).

`@margoengine/shader` compute passes (`ComputePass` grids, `workgroup`, barriers, `indirect`, every atomic, `storageTexture`, `pingPong`) are
checked on WebGPU only: `packages/shader/test/compute-model-check.mjs` and `compute-texture-check.mjs`. The package emits no GLSL,
and no check runs them through these tiers; by the table above, atomics, workgroup memory and barriers select the CPU tier.
Invocation inputs reach the entry point only when a graph reads them, so 1D passes compile to the same text as before. Statement
nodes (`If`, `Loop`, `While`, `Switch`) leave graphs without statements byte for byte unchanged.

`@margoengine/compute` has two backends of its own, WebGPU and CPU. `/graph` runs rounds over all edges with an atomic minimum so one
code path serves both, and `/nn` gathers through an inverse table so it needs no atomics and its gradients repeat exactly. `/autotune`
times candidate workgroup sizes in interleaved rounds, keeps the median-fastest and caches per adapter, name, signature, source and
candidates; `createCompute` now asks for the adapter's workgroup limits so sizes above 256 can be tried. Evidence: `npm test` and
`compute-browser.mjs` in `packages/compute`, LIM-079, LIM-080 and LIM-082. `tuneCompute` runs the same timing on the context's own
reduce, scan and radix sort, whose kernels now take their thread count as a parameter (`createCompute({ tuned })`); a sort block is one
workgroup, so the block count follows the table, and another route's kernels keep 256. Speed is not measured for `/nn` or `/graph`.
Tuned sizes have diagnostic numbers on one Apple M6 and one RTX A6000 only (perf-history entry 77); no AMD or Intel GPU is measured.

Accepted compatibility differences include CPU transcendental last bits, exact CPU filtering versus typical GPU
fixed-point filtering, one signed-normal tie, canonical rgb9e5/snorm readback, unavailable per-sample shading and
timestamp queries, copied video frames, clamped allowed out-of-bounds reads, refused compressed attachment/readback
operations, and refused integer MSAA formats unsupported by the context.

### 3.4 Corpus, size, and compatibility evidence

The recorded corpus snapshot contains 786 modules with entry points, 3,405,543 WGSL bytes from 41 packages plus site
pages. It is stored as a Brotli corpus with a SHA-256 manifest. Tests require packages with WGSL source to contribute
a recorded module. At the snapshot all modules parsed and checked; 1,049 vertex/fragment entries compiled, 459 stage
pairs linked, 624 render pipelines drew, and 397 of 417 browser compute pipelines dispatched. Twenty path-tracer
kernels remained out of scope because ANGLE compilation could take tens of seconds to minutes.

Audited gzip sizes: root compatibility entry 92,467 bytes, device 92,286, GLSL 42,394, compute 41,489, WGSL 26,528.
The root exceeded its original 60 KiB target; that was recorded rather than hidden. Isolation tests assert no other
package reaches the layer, import changes no globals, and native core/stage bytes remain unchanged.

Evidence includes capability probing, parser/checker fuzzing and nesting bombs, complete corpus compile/link/draw,
forced native-versus-compat rendering, format/readback/query/bundle cases, compute-tier parity, package tests in
forced compatibility, no-WebGPU page behavior, exact-pixel rendering, multi-view, and device restore. Pixel parity
uses per-pixel maximum RGB difference with no more than 0.1% over 2 and mean no more than 0.25.

### 3.5 Runtime quality tiers and resolution

`@margoengine/quality` starts desktops in a light tier rather than guessing from a GPU name. Phones always use the
phone tier. URL overrides can force high or low on desktop; per-page storage records later choices.

| Tier | Main defaults |
| --- | --- |
| Phone | 1x MSAA, DPR 1, two cascades, SSAO and volumetrics off, light-tier base settings. |
| Light | 1x MSAA; shadows 1024 with PCF, SSAO 16 samples, SSR off, reduced volumetric grid/local shadows/VFX capacity. |
| High | Package defaults and desktop 4x MSAA. |

Explicit feature options override presets. Feature packages read one global preset at construction and do not import
the quality package.

Promotion and demotion rules:

- Phone or URL-forced tiers are not auto-changed.
- A light-tier page with timestamp-query support samples GPU passes after startup for 120 frames, reading the time a
  frame's passes cover, so passes that run side by side count once (2026-11-05: an Apple M6 ran 31.9 ms of passes in 8.5 ms
  of GPU time; an RTX A6000 reads the same either way, 4.33 ms, so limits set on such GPUs keep their meaning). A sufficiently low
  p90 stores high for the next page load; it never reloads immediately into a heavier tier.
- A high-tier page stores a held state and reloads once only after five consecutive one-second windows under 55 FPS;
  frame gaps above 250 ms restart a window.
- The measurement restores wrapped queue/encoder methods and destroys temporary GPU resources.
- The light tier's pace (`capFrameRate`) gives each frame the most whole refreshes that still reach 60 FPS, from a median of
  the last 16 callback gaps, so a 100 Hz display renders 100 FPS rather than 50. Evidence: unit tests from 50 to 240 Hz with
  jitter, and a real page on a simulated 100 Hz clock on an Apple M6. Missing: a run on a physical 100 Hz panel, Safari
  itself, and whether an M6 stays on the full tier at 100 Hz (it costs 13.4 ms a frame there, over the 10 ms refresh).

The source comments contain both an old 5 ms threshold and a later documented 8 ms threshold. Current code is the
authority; the discrepancy should be removed when that area changes.

`ResolutionScaler` defaults to a 12 ms budget, scale 0.5-1.0, a 30-sample window, 0.05 granularity, and eight ignored
samples after a change. Over-budget scale falls approximately with the square root of target/current cost, never by
more than 30% at once. A rise needs sustained cost below 70% of budget; an immediately reversed rise doubles holdoff
up to 32 decisions. Core sizes to the lower of device pixel ratio, quality cap, sample-count cap, and 4096 pixels per
side. Exact-size mode bypasses resizing.

`supersample` (`@margoengine/quality/ssaa`) makes stills: it renders whole frames into a view target with the camera's
clip-space x and y moved along a Halton (2, 3) sequence, keeps running sums in linear light in `rgba32float`, and encodes
once. The offset exists only inside each `engine.render` call and the frustum planes stay unmoved. Evidence:
`packages/quality/test/ssaa-browser.mjs` on a real GPU, single-sampled and at 4x MSAA. Missing: Safari, and stills at
the texture limit.

`FeatureScaler` (`@margoengine/quality/features`) lowers features rather than pixels. Each step is a trial: the frame
cost over one window after it, against the window before, is the step's measured saving. A saving under 3% of the frame
gives the step back and rests it for 120 decisions. Known savings choose later steps, least visible first among those
that cover the shortfall; a feature returns under 70% of budget if its saving leaves the frame under 90%. Evidence:
`packages/quality/test/features.test.js` on a modelled scene, and `features-browser.mjs` driving real `SSAO`,
`Shadows` (filter, distance, resolution, cascades) and `VolumetricFog` (grid, on and off) through every level. Missing: how good the savings are in a real scene under load, for the quiet pass.

`watchPower` (`@margoengine/quality/power`) adds a third input to tiers. Level 1 (on battery) and level 2 (hot, CPU
pressure or low battery) cap the frame rate and cut the `FeatureScaler` budget; on the full tier they set this tab's next
load to light through `sessionStorage`, and that load measures nothing. `FrameDrift` tells heat from a heavier scene by
shape: a gradual rise that stays, against a step. Evidence: `packages/quality/test/power.test.js` on modelled costs, and
`power-browser.mjs` on the real battery manager. Missing: a run on a laptop really throttling, on battery, which should
set `rise` and `readings`.

### 3.6 Warm-up and device loss

`warmUp(engine)` renders offscreen delta-zero frames until two complete frames run with all asynchronously compiled
pipelines available. It retries bounded rounds and can reboot the device before falling back to synchronous pipeline
creation. `redrawAfterRestore` schedules two animation-frame renders for on-demand apps.

`PBRModel.compile()` (2026-11-05) warms one model rather than a frame: it runs the draw's own derivation and compiles with
`createRenderPipelineAsync`, so the draw finds the same pipeline under the same key. Its key needs the target formats and sample
count, which live in the renderer's private descriptor, so core gained one read-only getter, `Engine.renderTarget` (44 B gzip, Scott's
exception of 2026-11-05, `docs/conventions.md`). It is opt-in: at every load it would compile twice in a scene that adds lights
or effects afterwards. The wait moves rather than disappears: first frame 100 to 17 ms, build 54 to 108-126 ms, 11 to 29 ms saved in
all, busy machine, diagnostic. Evidence: `packages/gltf-pro/tests/model-runs.test.js` and `tests/core-timestamp-feature.test.js`
(after a device restore too).

`PipelineCompiles` (`@margoengine/stats/compile`) records every shader and pipeline create call on a device, follows restored devices,
and links a slow frame to the compiles in it or the frame before, blocking calls first. Evidence:
`packages/stats/test/compile.test.js` and a real-device check in `scripts/test-stats-browser.mjs`.

Core treats `device.lost` and relevant frame-time DOM exceptions as loss. Recovery is deduplicated by one shared
promise, creates a new adapter/device/renderer with the same features and samples, re-adds every geometry batch from
CPU copies, configures the canvas for the new device, swaps renderers, rearms the watcher, and calls every plugin's restore hook in its scene. CPU-side Wasm
transforms and instance arrays survive. Frames skip rendering during recovery, and accessing geometry buffers reports
a restore-specific coded error. The WebGL2 compatibility device feeds its context loss through the same path.

Tests destroy devices and GPU processes during lifecycle checks, compare every visual demo before and after loss,
exercise scenes and multi-view water, restore compatibility devices, and include restore events in proof stories.

A step that can throw runs before any state changes (2026-11-07). `Engine.retain` makes the instance array and calls `Renderer.add`
first, then swaps the array, counts the reference and registers the batch; `Renderer.add` frees a held geometry's old buffers only after
the new ones exist. It always allocates on the renderer in use, so during a restore that is the lost one, whose buffers go with it (a
restore that fails leaves it in place with every geometry held), and inside `onDeviceRestored` the new one. Restore hooks and scene
disposal run to the end and rethrow the first error. A full instance collection clears `collected` first, so one that throws repeats.
Evidence: `tests/deep-core-allocation-failure.test.js` on a fake device; on a real one, the lifecycle scenario that sets geometry on a
destroyed device and in the hook. Missing: `createBuffer` does not throw on a real out-of-memory, it reports later through
`uncapturederror`, so no check exercises a true GPU out-of-memory and core does not roll one back. It surfaces as a `gpu-lost` error.

Configuring the canvas is the one step of a restore with no way back, so it is the last step that can fail (2026-11-07):
`GPURenderer.create` skips it for a restore, and `rebootDevice` calls `GPURenderer.configure` after every batch is rebuilt. A failed restore
leaves the canvas on the old device, and one that ends after `engine.dispose()` never touches the canvas. Evidence: the lifecycle scenario
"a restore that fails on a healthy device" compares the picture before and after and watches the old device for errors, on a real device
whose successor reports a lowered buffer limit; `tests/deep-core-allocation-failure.test.js` runs the real `GPURenderer.create` on a fake
device, including a `configure` that throws. Missing: a restore that fails on hardware that really has a smaller limit than the old device.

Known rendering gaps:

- WebGL preview size is stated inconsistently in older public files; current generated size records are authoritative.
- Intel Arc 140V precise-math evidence needs a post-fix rerun.
- Compatibility CPU compute compiled with `new Function` and was refused without `unsafe-eval`; it now falls to an interpreter, and older broad CSP wording still needs the CPU tier qualifier.
- Visual profiles do not cover every GPU/browser/OS combination.
- Compatibility path-tracer kernels remain outside the supported compilation budget.


**Dispersed rays (2026-11-05).** In the `Transmission` pass each of the red, green and blue rays reads the blur level of its own IOR. Evidence: `node scripts/material-dispersion-gpu-check.js` (278 checks at a 0.002 tolerance), whose references use f32 IORs and, on the caller path, a fixed Fresnel, since dispersion moves refraction only.

**Native glass tint (2026-11-05).** A loaded transmissive material's multiply draw reads the full surface (`surfaceTintPBR`): base colour, transmission, metal, specular, sheen, clearcoat and thin film, maps included; the tint lanes hold the volume attenuation alone. Evidence: `packages/materials/tests/transmission-layers.test.js` and `node scripts/material-dispersion-gpu-check.js` on the native path. Missing: a measured cost of the second textured pass.

**Transmission on display-encoded targets (2026-11-05).** `materialTransmissionAdd` decodes the lit colour and the light behind, adds them in linear light and encodes the sum (encoded 0.5 + 0.5 reads 0.69, no longer 1.0); with an HDR scene target both are linear and add directly. gltf-pro's native two-draw path still adds encoded (`docs/known-bugs.md`). Evidence: `packages/materials/tests/transmission-shader.test.js`.

**Native coat and sheen lobes in shadow (2026-11-05).** `layers()` multiplies its sun light by `margoDirectVisible`, so a `direct` hook reaches the clearcoat and sheen lobes of physical shaders. The hook is asked about `margoLit(s,l,direct)`, zero where neither the base nor a lobe has light, so `shadowLit` skips the same fragments on uncoated surfaces and adds lookups only where a coat or sheen faces the light and the base does not. Evidence: `scripts/materials-clearcoat-tests.js` on the GPU (full shadow reads exactly 0, half shadow half) and `packages/gltf-pro/tests/extensions.test.js`. Missing: a measured frame cost on a coated scene.

**Clearcoat over opaque materials through `install` (2026-11-05).** `MaterialExtension.coat` scales direct, local, ambient and emitted light by `1 - clearcoat * F(n.v)` and adds the coat's own light on top, so `install(model)` follows KHR_materials_clearcoat as gltf-pro's native `layers()` does. `lightPBR` then evaluates a `direct` hook once on `vec3f(1)` (`margoDirectVisible`), so such hooks must scale the light they wrap. Evidence: `scripts/materials-clearcoat-tests.js` on the GPU (clearcoat 1 keeps 0.96 of emission at normal incidence and 0.73 at n.v 0.25; ambient 0.0782 where the unfixed shader read 0.0674; SSAO's replay equals the beauty) and `packages/materials/tests/clearcoat.test.js`.

**Stochastic tiling (2026-11-06).** `stochasticTiling` (`@margoengine/materials/stochastic`) rewrites a material's `textureSample` reads into three `textureSampleGrad` reads at random per-corner offsets of a triangle grid, keeping the unshifted UV's derivatives so an edge never picks another mip, and scales the blend about the 1 x 1 mip by 1 / sqrt(sum w^2) (Heitz and Neyret 2018), held inside the three reads. It binds nothing, so steady batches keep their fast path. Evidence: real-texture correlation, contrast, register and solid-mip checks in `packages/materials/test/features-browser.mjs` on an RTX A6000; WebGL2 layer, tile-based GPUs and the cost are unmeasured.

**Hair, eye and skin models (2026-11-06).** `hair`, `eye` and `skin` (`@margoengine/materials/hair`, `/eye`, `/skin`) are `MaterialFeature`s built on one helper, `character-light.ts`: each is a WGSL function `light(n, v, l, base)`, the response to one light with its cosine included, put in place of the body of `direct_light` for the sun and of the `clusterBrdf` term in the clustered loops through the `lit` hook, so a mesh answers a directional or point light as it answers the sun; the `character` GPU job fails if the hook is removed. Area lights, ambient and environment reflections keep the plain model, and a material with `fn margoDirect(` (anisotropy, thin film) throws. Hair is Kajiya and Kay's fibre with Marschner's two shifted lobes as tangent-shifted lobes (Scheuermann 2004). Skin is d'Eon and Luebke's six Gaussians integrated around a circle into a 64 by 64 half-float table (Penner and Borshukov 2011), row the square root of curvature in 1 / mm, read with |dN| / |dP| from screen derivatives. The eye refracts view and light at the cornea by Snell's law onto an iris plane. Skin takes group bindings 130-131 and the eye 132-134, because clustered holds 141-143 and environment 144. Evidence: hair, skin against the table and the pupil against a Snell trace are measured on an RTX A6000, the last on a stand-in sphere; the only model in the repository with eyes has a shallow iris plate, so the real-mesh eye run proves position and opening, not refraction. Cost is not timed.

**Output dithering (2026-11-06).** Materials' `dithering` option (feature letter `q`) adds triangular noise (Gjol 2016) to the display-encoded colour just before it leaves the fragment shader, scaled by each channel's distance to 0 and 1 so black and white stay exact and nothing clips. The noise is the one `Bloom` and `Sky` already used, now shared from `packages/shared/dither.js`; it hashes the pixel, so a frame repeats exactly. A float scene target (`settings.w`) skips the step, as the presenting pass owns the 8-bit output there, and data shadings (`normal`, `depth`, `distance`) never get it. Evidence: an RTX A6000 run of the `dithering` GPU job in `packages/materials/test/features-browser.mjs`.

**Hardware clip distances (2026-11-06).** On a device with 'clip-distances' (asked for through core's existing `options.features`, so core is unchanged) `MaterialShading.shader` skips `clipShader` and marks the text; gltf-pro's one `createShaderModule` then runs `markedClipDistances` (`packages/shared/section.js`) after every other stage edit, because `vertexInputs` and the instanced stage still need `->Out {`. The vertex stage returns `MargoClipped`, a copy of `Out` with `@builtin(clip_distances)`, since a fragment stage cannot read them, and a plane past the count gets 1. `clipIntersection` stays on discard, as the maximum of the distances is not linear across a triangle. So does a material whose outputs reach location 13: six distances take two of `maxInterStageShaderVariables`, and instancing passes `margoK` at the next location. Cascaded casters take the same route through `clippedDepth(..., hardware)` and `clipHardware` on the primitive; TAA velocity, contact shadows, picking and local shadows stay on discard. Evidence: an RTX A6000 run of the `clip` GPU job, with and without the feature. No other device has run it, and its speed is not timed.

**Prefiltered cube maps (2026-11-06).** `prefilterCube` (`@margoengine/materials/prefilter`) resamples any `CubeTexture` to linear float faces in a compute pass, reads them back and hands them to `Environment.create`, so one GGX filter serves both; the CPU copy is what `restore` rebuilds from after a lost device. Evidence: `packages/materials/test/features-browser.mjs` (`prefilter`) reads the stored levels against a GGX integral worked out in the test, on an RTX A6000 only; `envMap` now refuses a 32-bit float cube on a device without `float32-filterable`, which used to fail WebGPU validation (`packages/materials/test/env-map.test.js`). Missing: a rough real sky compared with another renderer.

**Physical lobes under clustered lights (2026-11-06).** `lightPBR` takes a last `finish` hook that sees the composed text. `Clustered.lobes = physicalLobes` (`@margoengine/clustered/physical-lobes`) uses it to send each point, spot and extra directional light through the surface's own `margoDirect` and, after `layers()`, add the coat and sheen those lights earn; area lights reach the coat through its own Linearly Transformed Cosines. Text without `fn layers(` is returned as it is. `envMap` on a thin film or anisotropic surface now goes through `margoAmbientLayers`, as a scene IBL does. Evidence: `lobes` in `packages/materials/test/features-browser.mjs` compares each lobe under each light with the sun, and the area coat with a sum over the panel, on an RTX A6000 only; `packages/materials/test/env-map.test.js` holds the composed text. Missing: a curved surface, sheen, anisotropy and thin film under area lights, the `clearcoat()` model extension under local lights, and any timing.

**Sphere, disc and tube lights (2026-11-10).** `Clustered.shapes` (`@margoengine/clustered/shapes`, binding 150) adds `clusterShapeLighting` to the light loop's result beside `clusterAreaLighting`; with no shaped lights the composed text is unchanged. Every shape goes through the rectangle lights' LTC frame and table: a disc becomes an elliptic cone under the inverse LTC matrix, whose form factor comes in closed form from the smallest eigenvalue of its quadric (computed from the Gram matrix of the quadric's rows so it stays precise in float32 for far, small lights); a sphere is its silhouette disc; a tube is the convex hull of its end spheres' silhouette discs, integrated as a polygon with the rectangle lights' clipped edge sum (`ltc-wgsl.ts`, shared with `area.ts`, whose WGSL text is unchanged). Across the horizon, a disc's visible rim arc is integrated as polygons. The rim is parameterised without `atan2`: on Metal a signed zero in one rim axis turned `atan2` to the hidden side and made a clipped sliver 100 times too bright (found by `scripts/shape-lights-gpu-check.js`, which now covers it). Evidence: CPU quadrature of the real shapes and of the LTC distribution (`test/shapes.test.js`), GPU against the float64 mirror on the M6 Mac mini. Missing: shadows, GPU timing.

**Dielectric Fresnel ends in lighting hooks (2026-11-05).** Ambient and local-light hooks read `s.f0` and `s.sw` (F0 and F90 of `KHR_materials_ior` and `KHR_materials_specular`); `lightPBR` writes the glTF defaults into shaders whose `Surface` has no such fields, so plain materials keep their numbers. Evidence: `tests/specular-ambient.test.js` and the `environment` browser check (specular 0 on a black dielectric reflects exactly 0 under an IBL).
**UV sets 2 and 3 (2026-11-06).** The 80-byte vertex holds two UV sets and many packages read it, so TEXCOORD_2 and 3 ride in a second vertex buffer at slot 2, location 11, passed on as `Out.uvs`. Only a primitive whose material or variant reads them gets it. `laterUVShader` (`packages/gltf-pro/src/vertex-inputs.ts`) rewrites the two-way UV select into `margoUVSet`, so every map, transform and extended slot follows without a shader of its own, and the pipeline key and draw memo gain a flag. Depth passes keep two sets: a cut-out on a later set casts uncut (docs/limits.md). Evidence: `tests/texcoord-later.test.js` and the `uv:` checks of `scripts/test-extensions-browser.js` on a Blender 5.3 file, on an RTX A6000 only; no speed measurement.

**Texture mip streaming (2026-11-06).** `textures` of `@margoengine/gltf-pro/progressive` reuses `KTX2Streamer` of `@margoengine/decoders/ktx2-stream` and adds what a model needs from it: a `GLTFStreamedImage` in the model's image list, which hands `bindMaterial` the current view in the colour space of each map slot (the texture allows its sRGB or linear twin through `viewFormats`), and `rebindStreamed`, which binds a draw again the moment its texture is replaced, in the same turn as the old texture's `destroy`, so no frame can see it. A texture's level follows its size on screen: `packages/shared/texture-density.js` measures the local length one whole texture spans (square root of surface over UV area, up to 4,096 triangles), and that length times the pixels a world unit covers at the nearest point of the bounding sphere is what `want` receives. The range reader in `stream.ts` leaves a KTX2 view unfetched and marks it received, so a GLB's texture bytes stay on the server; those bytes stay zero in `asset.buffers`, and nothing else reads an image view. Evidence: the real FlightHelmet and a real 1,024 px KTX2 file on an RTX A6000, pixel equal to the plain loader close up. Missing: timing on a quiet machine and a real network, a skinned model's posed bounds.

**Behaviour graphs in glTF (2026-11-06).** `@margoengine/gltf-pro/interactivity` adds no shader and no render path: it compiles the ratified `KHR_interactivity` graph of a document and runs it on a clock moved by `tick`, with no engine. `@margoengine/animation/interactivity` binds it to a model: it ticks on `onPreUpdate`, writes through `pointerWriter`, the writers of `KHR_animation_pointer`, and picks through `Picking` of `@margoengine/selection`, attached on first use without per-frame capture. It lives in animation because gltf-pro cannot peer on animation (animation already peers on gltf-pro, and `scripts/package-order.js` refuses the cycle). Evidence: 1,155 of 1,156 conformance sub-tests and 187 of 187 invalid graphs, and a GPU check that a real click reaches the graph and the screen. Missing: no timing of a large graph, and no real file that drives skins and physics together on a GPU.

**Rigid bodies in glTF (2026-11-06).** `@margoengine/gltf-pro/physics` adds no shader and no render path: it reads `KHR_physics_rigid_bodies` and `KHR_implicit_shapes` (drafts) from the document and builds bodies in `@margoengine/physics`, which gained a `generic` joint for the draft's joints, built of limits and drives, with frames on each body. Evidence: five committed real samples held to their mechanics on real Rapier, seven unlicensed ones run by hand through `MARGO_SPLAT_SAMPLES`, one GPU check that a loaded node moves on the engine loop. Missing: no conformance suite exists for a draft, and the combine rule order, soft limits and multi-axis ranges differ from it by what Rapier offers (`docs/limits.md`).

**XMP metadata in glTF (2026-11-06).** `@margoengine/gltf-pro/metadata` adds no shader and no render work: it reads `KHR_xmp_json_ld` from the document after load, and a broken packet never stops a model loading. Launch gate 11a gains the `gltf-pro/metadata` fuzz target over the published files that carry the extension. Evidence: real files for author, licence and copyright; the Creative Commons and `xmpRights` licence order has built documents only, as no published file found uses them.

**Fixture and image lights in glTF (2026-11-06).** `@margoengine/gltf-pro/lights` adds no shader: an `EXT_lights_ies` fixture is a clustered point light whose profile is resampled for its node's aim, and an `EXT_lights_image_based` cube goes through `Environment`. `parseIES` gains type B, resampled to a type C grid, and stops reading the 2002 and 2019 field after the ballast factor as a photometric factor, which had raised the real 2019 sample's peak from 8,500 to 9,350 cd. Evidence: the real Example wall within 3 percent of Lambert's law on the RTX A6000. Type B axes are now held to a real report: its planes meet at H = 90 and it integrates to its stated lumens only with H as the latitude. Missing: the sign of V, which no file shows, and any reference for what `irradianceCoefficients` mean.

**Scattering in glTF volumes (2026-11-06).** `KHR_materials_volume_scatter` (draft) adds map slots 19 (multi-scatter colour, sRGB) and 20 (volume thickness) and two rows to the extended Frame, which grows from 284 to 308 floats (1,232 B), so UV rows reach 42 and physical rows start at 272. `packages/shared/volume-scatter.js` holds the one WGSL text, `margoScatterShares`, and its JavaScript reference. Sigma_t and the albedo mapping are the spec's; the rest is a Margo reading: scattering over the depth x is 1 - exp(-min(sigma_s (1 - g), sigma_t) x), and that share of the entering light leaves as a diffuse lobe of the multi-scatter colour (`s.sc` in the extended shader, `materialScatterLobe` in `@margoengine/materials`, added to direct light and to the ambient hooks). Specular transmission keeps Beer-Lambert, which already counts scattering, and diffuse transmission takes exp(-(sigma_a + s) x). The lobe plus either straight term never passes the light that entered (`packages/gltf-pro/tests/volume-scatter.test.js`). Evidence: real-GPU checks in `packages/gltf-pro/scripts/test-extensions-browser.js` on the RTX A6000 only, among them the whole Khronos ScatteringSkull. Missing: any comparison with a path tracer's picture of the same file, light spreading under the surface, any other GPU, and speed.

**Bump maps in glTF (2026-11-06).** `EXT_materials_bump` adds map slot 18 and a `bump` row to the extended Frame, which grows from 272 to 284 floats (1,136 B), so physical rows start at 256. The normal comes from `margoBumpGradient` in `packages/shared/bump.js`, the Mikkelsen surface gradient `@margoengine/materials` `bumpMap` also uses. gltf-pro feeds it forward differences of the map a pixel away, three reads, where materials takes `dpdx` of one read. A node-space height scales by |transpose(M) n|, the node's stretch along the surface normal: a point moved d along the mesh normal moves that far along the world normal. Evidence: real-GPU checks in `packages/gltf-pro/scripts/test-extensions-browser.js`, on the RTX A6000 only. Missing: a file from an art tool (none found) and any other GPU.

**Flat splats (2026-11-06).** `splatsFromAttributes` keeps an axis variance at 2^-20 of the largest. Float32 rounding of a covariance moves an eigenvalue by up to 3 x 2^-24 of the largest, so a flatter splat rounded to a matrix `validateSplats` refused and one such splat stopped a whole real capture (CesiumJS tower.glb). Evidence: `packages/splats/test/splat-edit.test.js`. Projection adds 0.3 px^2 to every ellipse, so the lifted axis does not show at any distance Margo tests; no render comparison against an unlifted cloud exists, as Float32 cannot hold one.

**Splat depth (2026-11-07).** `@margoengine/splats/depth` adds one depth-only render pass per cloud at frame-graph order 3.5, after the clouds draw: the cloud's sorted ellipses drawn as the colour pass draws them, no colour target, `depthCompare: greater` with writes on, and a fragment discard where the Gaussian opacity is under the threshold. Meshes drawn before the cloud keep their depth; passes after it (order above 3.5) test against the splats. The depth is alpha-tested, not accumulated. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M, a synthetic splat and a real capture at 1x and 4x MSAA; missing: other GPU families, and a pass that reads the depth (fog, DOF) drawn over a capture.

**Splat level of detail (2026-11-07).** `@margoengine/splats/lod` adds no shader: a pass at order -8 picks the cut on the CPU and writes changed nodes into a fixed pool of one `Splats` with `queue.writeBuffer` (`Splats.write`, `Splats.clear`), before the cloud projects at -7. Hidden pool splats (opacity 0) are culled by the projection and sort to the end. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M (real capture, full cut against a plain cloud of the pool; 16.7 M-splat procedural stand-in); missing: a real capture past 3,000,000 splats, trained hierarchy levels, frame time.

**One splat sort for many clouds (2026-11-08).** `@margoengine/splats/set` adds no shader: `SplatSet` writes each added cloud into a first-fit range of one pooled `Splats` (`Splats.write`, `Splats.clear`), so the one projection and stable radix sort order every member far to near, as a merged cloud would. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M (two overlapping copies of a real capture match the merged cloud pixel for pixel at 1x and 4x MSAA, and differ as two clouds); missing: frame time for a large mostly free pool.

**Splat lighting (2026-11-08).** `@margoengine/splats/lighting` adds two shaders: a compute pass at order -6.5 scales the projected colours by core's diffuse terms with a per-splat normal from the smallest covariance eigenvector, and a depth-only `drawShadow` for `@margoengine/shadows` that rasterises each splat's ellipse in the light's clip space (0.3 texel^2 dilation) with stochastic per-texel coverage. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M (relit colours against the CPU formula; a synthetic disc and a real capture shadow a ground box); missing: splats receiving shadows, a specular term, frame time.

**Splat brush (2026-11-08).** `@margoengine/splats/edit` adds one compute shader with every operation behind a uniform switch: select, erase and paint test each splat's projected centre against a pixel region, and a pick runs two submissions (atomic min of an order-preserving view-depth key, then of the indices at that key; one submission would see only the second pass's uniform, as queue writes land before the command buffer runs). `Splats.read` copies positions, colours and SH back for export and restoration, reading again when a `write` lands during the read. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M; missing: stroke cost on a 3,000,000-splat cloud.

**Animated splats (2026-11-08).** `@margoengine/splats/animate` adds two compute passes at order -7.5, before a cloud's projection at -7: a sequence mixes two packed frames into the cloud's positions, covariances and colours; a skin copies the rest pose once (copyBufferToBuffer, so the root's covariance buffer now has COPY_SRC) and writes the blended joint transform of each centre and A S A^T of each covariance. `Splats.read` now reads covariances back too, so a posed cloud exports as posed. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M; missing: pass cost on a 3,000,000-splat cloud.

**Anti-aliased splats (2026-11-08).** `Splats.antialias` sets `counts.z` of the projection uniform; the projection pass then scales the ellipse opacity (ellipse centre w, which the render, depth, lighting and brush passes read) by sqrt(det(S) / det(S + 0.3 I)) of the dilated screen covariance. No recompile and no extra pass. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M; missing: a real capture trained with the filter.

## 4. Quality architecture

### 4.0 How work lands during the build phase (Scott, 2026-11-09)

This section matches `AGENTS.md` "How work lands"; `AGENTS.md` wins where they differ.

- **Fast gate before a push:** lint, hygiene, check:banned-terms, build:packages, api:check, quality, and the tests of the changed packages and the packages that depend on them, with their GPU tests on WebGPU and the WebGL2 compatibility layer. Exports changed: commit the api:update output.
- **No full verify in any lane.** Local CI on the dev PC runs the one full `npm run verify` on the newest `main` (scheduled task "Margo CI (CPU)"). Running it in a lane doubles the work: eleven lanes doing so held the CPU at 94% and stretched verify from 12 to 40 minutes. A red `main` is fixed forward by the lane that caused it within about 2 hours, or that commit is reverted.
- **No README work until the features are built.** No `check:readme-run`, no README example writing or fixing. Each job adds one line per changed package to `docs/work-lists/readme-owed.md`; the README phase before release clears it.
- **Only complete jobs reach `main`,** squashed into one commit: no checkpoint, evidence-only or partial pushes.
- **Round caps:** a stuck job parks with a note after 3 rounds in the build phase (5 to 10 only for an obvious bug with measured gains each round); parked notes feed the fix phase. A blocker owned by another lane gets one line in the handoff, and the lane moves on to its next job.
- **This section stays short.** Evidence for a gate goes in its own row in 4.1 or a line in section 5, never a new essay at the top of this file.

### 4.1 Gate map

| Gate | Command or path | Contract |
| --- | --- | --- |
| Core and stage size | build and `npm run measure:size` | Combined minified ES2022 gzip must be strictly below 25,000 bytes. |
| Kernel payload | `scripts/build-modern.js` | Raw Wasm below 30 KiB, valid module, lossless raw-deflate round trip. |
| Quality ratchets | `npm run quality` | New or worse size, duplication, test, API, or clean-room item fails. |
| Formatting and lint | `scripts/hygiene.js --verify` plus normal lint/typecheck commands | Fast source checks; quality ratchets enforce selected non-regression classes. |
| API and parity | `npm run api:check`, `npm run check:parity` | Generated API and parity contracts remain current. |
| Unit tests | root and package tests | Functional and regression evidence. |
| Documentation | `npm run docs:links`, generated-site checks | Links and generated public material remain coherent. |
| README examples | `npm run check:readmes`, a step of `verify` | Every `ts`, `tsx` and `js` example of every package README and guide compiles against the built packages, each as its own module. An error off `scripts/support/readme-types-known.json` fails, and so does a fixed entry left on it; the list only shrinks and must be empty before release.. No example may `declare` a value: such a line passes the compiler and holds nothing at run time, so the check refuses it |
| Current proofs | `npm run proofs -- --current` | Ongoing golden-output guarantees match stored outputs. |
| Fresh checkout | `npm run check:fresh-clone` | Validation and current proofs do not depend on local history or artifacts. |
| Site and visual checks | site build, `visual:check`, compatibility visual budget | Built demos render against the correct per-hardware evidence. |
| GPU/package checks | `check:views`, `check:gpu-packages`, `check:depth`, `check:wgsl`, `check:no-webgpu` | Scoped rendering, shader, package, depth, fallback, and view behavior. `check:gpu-packages` refuses to plan while a `scripts/*-gpu-check.js` file is named by no command, unless `LOOSE_CHECKS` states why: on 2026-11-07 twenty-two such files ran by hand only and five had rotted. A check that compares with an earlier build (`--baseline`) says so and goes on when no baseline is on disk, since that proof belongs to one change. |
| README examples run | `npm run check:readme-run`, a step of `check:merge` after a build, GPU, 296 s on 2026-11-07 (about 25 minutes when first measured). Whole in the full check after a push; on a narrowed run, the examples of the affected packages, or all of them when a file the step runs changed. In no gate before the push and not in `verify`. Holds one shared GPU slot; the GPU lock ends its process tree at 60 minutes. An example's id is the heading above it and a hash of its code, never its place in the file, so the known list survives a new example above a listed one. A README edit renames the example it changes, so `tests/run-readme-examples.test.js`, in `verify`, fails while the known list names an example no README holds: 8 such entries went unseen until this step ran on 2026-11-07 | Runs every example of every package README and guide as a reader would paste it: in Node when it can, else in a real Chromium page with WebGPU, the elements it asks for and a real sample file of the format it fetches. Passes when nothing threw, no promise was left rejected and the GPU reported no validation error; a Node example still going at 30 s passes, as a server does. A failure off `scripts/support/readme-run-known.json` fails, and so does an entry left on it that passes or names an example that is gone. Examples that listen on one port take turns. 641 of 767 ran on 2026-11-07; the 126 left are in docs/known-bugs.md. |
| Consumer packaging | `modern:test:packages`, bundler matrix, quickstart | Packed declarations, docs examples (the same examples as `check:readmes`, against the tarballs, with no known list), browser packages, bundlers, licenses, and documented first use work. |
| Release rehearsal | `publish:rehearsal` (in `publish:dry-run` and the publish workflow) | Every tarball audited, then the one-line install, every entry imported and type-checked, and every template built, from a stand-in registry that refuses writes. |
| Public truth | `tests/public-truth.test.js` | Structured license and package-count statements match their canonical sources. |
| Timing-test hygiene | fixed-wait and wall-budget tests | Tests wait for readiness; code speed uses CPU time; justified real-time bounds are marked. Both read tracked files only (`git ls-files`), so git-ignored scratch builds cannot fail them. |
| Async hygiene | support async call test | Async helpers in tests/scripts are awaited or returned. |
| TypeScript checker transport | `tests/typescript-api-transport.test.js` | `scripts/hygiene.js` and `scripts/api-report.js` start tsgo through `typescript/unstable/async` (stdio, waits for the process); no tracked file uses `typescript/unstable/sync`, whose Windows client gives tsgo a fixed ~5 s to open a named pipe and failed `npm run quality` under verify's load on 2026-11-07. |
| Node compatibility | CI matrix and proof-golden tests | Minimum and supported Node APIs and proof results stay compatible. |
| Rust kernel | `npm run test:kernel`, in local CI's CPU set | Native kernel invariants. |
| Physics kernels | `npm run test:physics-kernel` and `npm run test:physics2d-kernel` (about 75 s and 3 s on the dev PC, 2026-11-08), each a step of local CI's CPU set on every `main` commit (hard limits 30 and 15 minutes); and `npm run check:rust-kernels` (`scripts/rust-kernel-tests.mjs`, CPU only, 20 minutes a crate), a step of `check:merge` that runs `cargo test` of each package with a Rust kernel whose own files changed (its `kernel/` folder counts as the package), every kernel when its script changed and in the full check; a kernel that ships as Wasm (a `cdylib` crate) is then built for wasm32 with the shipped flags, and a `wasm-check/` crate beside it, when there is one, is built the same way and run in Node (the 2D kernel's: the pinned-bits scenes against the native hashes). Not in `verify` | The 3D and 2D solvers' Rust tests that LIM-518 to LIM-522 and other claims cite. Until 2026-11-08 they ran in no check. `tests/rust-kernel-tests.test.js` holds the npm scripts and the step to the same cargo command. On the dev PC the npm scripts fail with "'cargo' is not recognized" from a shell that inherits the machine PATH: its entry `C:\Program Files\GitHub CLI"` carries a stray quote, and cmd.exe, npm's script shell, then reads every later entry (cargo's among them) as one quoted name. The PATH is 1,777 characters inside npm, far under cmd's 8,191, so length is not the cause. Local CI strips quotes from the PATH it hands its steps; `check:rust-kernels` starts cargo without a shell. The machine fix is to remove the quote from the system PATH. |
| Class fields | `tests/class-fields.test.js` | Packages on the shared tsconfig declare no bare class fields; `@margoengine/materials` is the one named exception. |
| Browser choice | `tests/browser-selection.test.js` | `MARGO_BROWSER` names edge, chrome, chromium, firefox or webkit, and each maps to its launcher. |

### 4.2 Size and ratchet contracts

The combined core-stage gate builds the stage entry with core bundled, every other bare package external, minifies for
ES2022, joins output chunks, gzips them, and enforces `bytes < 25_000`. The embedded kernel counts. There is no lower
bound. Core is frozen against features, not bug fixes; a core bug fix requires regression evidence and must remain
within the gate.

The detailed size record bundles public entries like consumers do and records raw/gzip size, commit, dirty state, and
lazy files. Generated records must identify their exact source revision. Current record-generation ownership is
external to this engine reference; the measuring scripts themselves remain authoritative.

Quality baselines have `{ gate, about, total, history, items }`. A new key or measured value above its limit fails.
Shrinking is free. Accepting growth requires a reason appended to history. Size headroom is the larger of 3% or 256
bytes; a static import that pulls a package entry of at least 10,000 bytes into another package is a leak item.

The five ratchets are:

- **sizes**: gzip budget for every public entry and worker, plus heavy-entry leaks.
- **duplicates**: normalized six-line windows of at least 200 characters, known algorithm families, and cross-package
  value re-exports.
- **tests**: each package has verification coverage and each public entry is imported by a test.
- **api**: public exports are documented and thrown errors follow the conventions.
- **clean-room**: engine source does not copy or depend on prohibited competing-engine implementation.

One stale comment says duplicate windows are eight lines; implementation and conventions use six.

Hygiene additionally scores format, lint, public/source `any`, strict TypeScript flags, duplicate type names, TSDoc,
bare errors, API rough edges, and dead files/exports. Not all scores are blocking by themselves; the quality ratchets
are the enforceable non-regression layer for the overlapping categories.

### 4.3 Verification and affected checks

`scripts/verify.mjs` runs fast hygiene and one package build in order, then independent chains in parallel: API,
quality, parity, sandbox build/tests, unit tests at bounded concurrency, documentation links, size measurement, and
current proofs. A chain failure terminates the other process trees. Serial mode remains available for diagnosis.
A killed tree counts as ended only when its processes have closed their handles (`endTree` in
`scripts/support/shutdown.mjs`): on Windows a process's exit code is set before its handles close, so the end waits on
each process object, and the folder, log and ports of a timed-out step are free when `runLimited` returns (fixed
2026-11-08 after an EPERM on a timed-out job's temp folder).
Three of those chains start a TypeScript checker (tsgo) at about the same time: API reports, quality (through hygiene
gate 6) and the API report tests in the unit step. Each starts it through the async API, whose start has no fixed time
limit, so a slow start under load waits instead of failing; the step's own timeout still bounds a hang. Evidence: a
repro that starves a new tsgo with high-priority busy loops on every core made the sync API fail after 11 s and the
async API connect once the load ended (Beelink, 2026-11-07).
The unit test step gives each test 300 s (`TEST_TIMEOUT_MS`, against 32 s for the longest measured), and
`scripts/support/test-watch.mjs` watches from the runner's process: a test file silent for 360 s, through a blocked event
loop or a process that stays alive after its tests, prints `HUNG TEST:` with the file and test and ends the run.
On Windows the runner ends last: it stops every process below it, waits on each one's handle, prints `HUNG RUN ENDED:`
and exits, so a caller may remove the run's folder as soon as the run ends. On other systems the run ends by SIGTERM,
and the test holds there that its children are gone; that path has not been run on the Mac or Linux yet.

`scripts/check-merge.mjs` classifies the actual changed files and runs only checks the change can affect. It expands
package dependents transitively and chooses full validation when shared/core/build/check infrastructure changes, a
file cannot be classified, more than the supported affected-package threshold is reached, or full mode is explicitly
requested. The plan and its reason are printed and written to a result file. Plan mode runs nothing and supports
synthetic file lists for testing the classifier.

Always-run steps include verification, fresh-checkout validation, site build, and quickstart. GPU, view, depth, WGSL,
package, no-WebGPU, visual, and bundler work is scoped by documented footprints. Tests require every configured step
to be assigned a class. A step may rerun automatically only after a Windows event-log GPU reset proves an external
driver failure; a second failure remains a failure and the result records that the first attempt reset.

Full validation is an explicit mode, not a default substitute for classification. Unknown or shared changes fail
closed to full coverage. This distinction is what prevents a local package edit from needlessly exercising unrelated
packages while preserving complete coverage when impact cannot be bounded.

### 4.4 Continuous integration

The audited CI matrix included:

- Lint/typecheck on the primary Node version.
- Build, API, quality, and unit tests on the repository minimum Node.
- Node compatibility on 22.12, current 22, and 26: build, engine checks, proof goldens, API availability, consumer
  package and bundler checks, with the broader test set on the newest entry.
- Node-22-specific tests.
- Locked native Rust kernel tests.
- An on-demand Windows browser workflow for broader browser/package coverage.

GPU proof, visual, and full local hardware checks are not assumed to run on a hosted CI GPU. Whether a remote workflow
actually ran is field evidence, not inferred from the YAML.

Since 2026-11-07 GitHub Actions is off while the repository is private (Scott: not paid for); local CI on the dev PC (Windows
11, RTX A6000) runs the same ground instead, see section 5, gap 34.

### 4.5 Golden-output proofs

A proof scripts a package story against a recording stand-in GPU and compares every call, descriptor, and buffer byte.
It must also exercise a feature-on path that differs, proving the comparison can see the feature. Stories cover
changes such as resize, format and sample changes, hidden state, empty state, model rescans, device restoration, and
dispose.

- **Current mode** compares the working implementation with committed lossless golden outputs and runs without old
  Git history. Missing output is a failure.
- **Pinned mode** reconstructs the baseline and claim revisions for historical claims. An unavailable historical
  revision is reported as historical, not silently presented as a live pass.
- Golden metadata records proof name, source ref, resolved revision, capture revision, facts, and SHA-256 per output;
  compressed values are stored separately.
- NaN payloads can be canonicalized only by the proof's declared comparison. Every other bit, including signed zero,
  counts. The sole standard shader normalization is the documented historical AgX-body case.

When an intentional feature-off output changes, audit the exact call-level difference, update the current reference,
capture only after the comparison passes, and update the whitepaper claim with the old/new evidence and reason. Pinned
baseline and claim revisions remain immutable.

### 4.6 Visual regression

Visual checks use real GPU rendering, a fresh browser context, reduced motion, deterministic view parameters, the
demo's readiness signal, and masking for dynamic telemetry. Images are box-downsampled. For each pixel, `d` is the
largest RGB-channel difference. Gated metrics are:

- `changed`: share with `d > 0`.
- `hot`: share with `d > 24`.
- Tolerance: measured worst pairwise noise times 3 plus fixed allowances (`0.0005` changed, `0.0002` hot).

Updates capture multiple independent launches and retake until consecutive captures agree, avoiding mid-raster frames
under load. Each baseline records view, dimensions, runs, noise, tolerance, browser/GPU/power state, date, revision,
and whether rendered inputs were dirty.

Profiles are keyed by GPU slug, browser family, and browser major. A run must never compare against a different
profile. Creating a profile requires the complete view set from clean rendered inputs. Missing hardware evidence is a
failure with an instruction to select the intended GPU or deliberately capture a new profile.

`MARGO_BROWSER=webkit` (2026-11-05) runs the browser suites in Playwright's WebKit build, which has WebGPU on macOS; the Mac sweep
needs it. It is not Safari, which needs safaridriver, and it is not a visual profile of its own.

At the audit snapshot, profiles existed for Intel Arc 140V/Edge 155 and RTX A6000/Edge 155 and 156. Intel on newer
Edge, Intel UHD, AMD, and Linux coverage remained absent. RTX A6000/Edge 157 was added on 2026-11-08 (4 runs per
view, 81 views, captured from `d9fa86e5b`) after Edge updated itself; against the 156 profile 16 of 81 views differ,
the largest per-pixel difference being 221 (FlightHelmet).

### 4.7 Public truth and benchmarking

`scripts/support/public-truth.mjs` validates structured license URLs against `package.json` and `LICENSE`, and package
count phrases against `docs/catalog.json`. It does not validate every size, timing, or test-count statement. Those must
cite generated records and retain evidence status. An older WebGL preview-size inconsistency demonstrates why this
scope matters. So does the audit of 2026-11-06: the 44 B of `Engine.renderTarget` reached `README.md`, `site/index.html` and
`docs/limits.md`, while 11 other files kept 22,815 B or older, `claims.md` among them, and a replace of the current figure had
rewritten the dated 22,189 B of the 2026-10-30 cleanup in `docs/limits.md`. Core alone read 21,134 B there; it is 21,285 B.

The benchmarking protocol uses AC power, a shared GPU-resource lock, a whole-machine idle gate, warmup, repeated
measurements, between-case load checks, fixed browser/canvas conditions, and a spread validity limit. Defaults at the
snapshot were one warmup, five measured runs, 300 frames after 60 warmup frames, at most 10% spread, and a 5%
regression threshold (1% for bytes). Report median; with five runs p95 is the slowest sample.

Timing regressions compare only matching machine identities and must exceed both the threshold and measured spread.
Bytes and counts are machine-independent. Engine comparisons use shared scene data, interleaved randomized order,
identical settings, harness timestamp queries, and an append-only ledger that keeps losses and records before/after,
cause, tradeoff, revision, and rerun command. Competing-engine code stays outside this clean-room repository.

Performance validation must include slower supported hardware before a conclusion is generalized. A pass caused by a
slower baseline is invalid; compare the run's baseline against the recorded baseline first.

### 4.8 Failure classes preserved by the gates

| Failure class | Guard |
| --- | --- |
| Current proofs depended on private local history | Committed golden outputs and fresh-checkout validation. |
| Historical proof used today's core on both sides | Claim-revision core pinning and dedicated tests. |
| Stand-in overhead erased a measured speedup | Shared recorder methods and focused regression test. |
| A timing comparison flipped under load because its two sides allocate differently | Compare work with the same allocation profile; a whole-job budget is a ratio to a control job that allocates alike (`packages/exporters/tests/exporters.test.js`: 10 of 10 with 32 processes allocating). |
| Proof digest differed by Node/V8 math | Exact proof inputs, deterministic stand-ins, and multiple pow modes. |
| Packed declarations referenced source outside the package | Every build creates declarations; consumer package check. |
| Visual profile mismatched browser or adapter | Exact profile key and explicit adapter selection. |
| Browser readiness assumed fixed time | Readiness-based waits plus fixed-wait gate. |
| Wall-time assertion failed only under CPU contention | CPU-time budget helper plus wall-budget gate. |
| GPU driver reset produced a misleading code failure | One evidence-backed retry with explicit result annotation. |
| Public generated records or prose drifted | Revision-stamped generation, public-truth checks, and whitepaper evidence. |
| A number field declared in a class started as `undefined`, so each write of a fraction allocated | `tests/class-fields.test.js`. |
| A GPU script nothing ran failed unseen (`area-lights-gpu.mjs` still mirrored a display curve core left on 2026-10-17) | The script runs in `test:gpu:area` of `packages/clustered`, and a correctness run no longer overwrites the bench record. |
| A pass other than the colour pass drew a material's whole surface | `packages/materials/test/cutout-passes-browser.mjs` (picking, contact shadows, TAA velocity) and `packages/shadows/test/cutout-casters-browser.mjs` (every shadow map pass, virtual included) read pixels and velocities through a cut-out, a displaced surface and a clipping plane. |
| A node graph's vertex offset and discards reached only the colour pass | `packages/shader/test/passes-check.mjs` compares a moved caster with a plain mesh placed there in `Shadows`, `VirtualShadows`, `LocalShadows` and integrated clustered shadows, and a cut caster with a half-sized one. Depth passes take the graph through the `displacement` record of a primitive (`CasterDisplacement` in `packages/shared/caster.d.ts`), so caster caches treat it as moving. Still missing: TAA velocity for such a surface (docs/limits.md). |
| Skinning and morphing written in a node graph could drift from the CPU maths or lose the normal | `packages/shader/test/deform-check.mjs` compares `@margoengine/shader/deform` with the same mesh deformed on the CPU, lit, so a stale normal changes the picture: a slanted bone turn, morph into skin, a stretched and mirrored mesh (`worldNormal` uses the model matrix's cofactors), a new pose and the shadow. `skinningFromModel` is checked on the real Fox.glb against `@margoengine/animation`'s compute deformer at two frames of its clip. |
| A scene pass runs before the colour pass, where uniforms upload ahead of the frame's commands and the canvas may be display-encoded | `packages/shader/test/pass-check.mjs` reads pixels back: `ScenePass` writes last frame's matrix before any draw of the frame (a write after its draws lands first in queue order and gives zero velocity), and shades into linear targets through a view block of its own (the sunlit and tone-mapped rows fail if the canvas encoding reaches the target). Multi-view frames have no such check yet. |
| A raw mesh draws through depth, G-buffer and pick pipelines of its own vertex stage, in passes that run before and after the colour pass | `packages/shader/test/raw-check.mjs` reads pixels, buffers, picks and counters back: the shadow of a caster moved by its vertex shader lands on the wall, `discard` opens it, a mesh's own ambient is darkened at a crease, and a pick lands where the shader put the mesh. |
| A graph using subgroups or f16 must give one answer on devices with and without the feature | `packages/shader/test/subgroups-check.mjs` runs one graph on two devices of an adapter and compares every operation with the lanes the hardware reported, then the one-lane form. No other GPU family has run it: subgroup sizes other than 32 are unproved here. |
| A hashed cut-out's coverage must equal its opacity, and TAA must average it | `packages/materials/test/features-browser.mjs` reads the pixels drawn at seven opacities, on plain and instanced meshes, and the grain with and without `stochastic` TAA. Only an RTX A6000 has run it. The default TAA resolve keeps a per-pixel depth rejection, which cannot average such a surface. |
| Exact transparency must blend as a per-pixel sort would, with hidden layers gone though its fragment shader runs ahead of the depth test | `packages/oit/test/gpu/exact-check.mjs` compares four layers, an opaque plane between them, crossing sheets, MSAA edges, a list that has to grow and a transparent canvas with blending worked out by hand, at 1x and 4x. Only an RTX A6000 has run it, on generated planes; no timing exists. |
| Moment transparency holds four power moments in half floats, where a rounding can break the moment matrix | `packages/oit/test/gpu/moments-check.mjs` holds the picture to blending worked out by hand and to weighted blending on the same scene at 1x and 4x, with one layer, dense layers and a moved model; the half and float cases were compared on a CPU model, not on the GPU. Only an RTX A6000 has run it, on generated planes; no timing exists. |
| Tints and light in OIT must equal the sorted path where order cannot matter, on encoded canvases too | `packages/oit/test/gpu/blending-check.mjs` compares each kind alone with the sorted path, and light with dimming against the formula, at 1x and 4x. Only an RTX A6000 has run it, on generated planes; no timing exists. |
| Effects in an order-independent pass must hand it the true view depth and blend in true order with models | `packages/oit/test/gpu/vfx-check.mjs` reads the depth each of particles, splats, points and sprites hands the pass, under perspective and orthographic cameras, and compares them with a 50% pane on both sides at 1x and 4x. Only an RTX A6000 has run it, on generated layers; no timing exists. |
| Splats must hide what later passes draw behind them, and nothing in front | `packages/splats/test/gpu/check.mjs` draws a quad from a later pass behind and in front of a splat and of a real capture, with and without `SplatDepth`, at 1x and 4x, perspective and orthographic, and compares the pixels with the cloud alone. Only a Radeon 680M has run it. |
| A streamed splat hierarchy must draw what the plain cloud draws when fully refined, and stay within its budget | `packages/splats/test/gpu/check.mjs` compares the streamed full cut of a real capture with a plain cloud of the same splats and streams a 16.7 M-splat stand-in in a 2 M budget. Only a Radeon 680M has run it. |
| The passes must hold on real models | `packages/oit/test/gpu/real-check.mjs` runs six Khronos files through every pass from eight sides. It asserts no GPU error, which parts each pass takes, depth that only comes nearer, and moments closer to exact than weighted on GlassVaseFlowers. No reference picture exists, so what it measures is gaps, not correctness. Only an RTX A6000 has run it; no timing exists. |
| Glass in the depth must match an opaque surface bit for bit, or TAA's equal test finds no vector | `packages/oit/test/gpu/depth-check.mjs` compares the depth value with an opaque plane at 1x and 4x, and reads a TAA vector and a DOF edge from it. Only an RTX A6000 has run it, on generated planes; no timing exists. |
| Hair, eye and skin must follow their published models under every light they claim | `packages/materials/test/features-browser.mjs` jobs `hair`, `skin`, `eye` and `character` compare the lobes with the formula, the skin with its table, the pupil with a Snell trace, and clustered lights with the sun. Only an RTX A6000 has run them. The eye's refraction has no real eyeball to measure on. |
| Clipping planes must cut the same in the rasterizer as by discard | `packages/materials/test/features-browser.mjs` job `clip` draws one scene on a device with the feature and on one without, reads the compiled shaders, classifies every pixel against the plane and compares the two pictures and shadows. Only an RTX A6000 has run it. |
| Graph-side normal, parallax and colour helpers could flip a handedness or drift from the maths they name | `packages/shader/test/utils-check.mjs` reads each `@margoengine/shader/utils` node back on a real GPU: the UV origin of a `Texture` against each normal map direction, a known slope through the Mikkelsen bump, the line of sight under a flat and a sloped height field, `matcapUV` against `MatcapMaterial`, and the maths and blend nodes against JavaScript formulas |

### Extruded text correctness gate (2026-11-08)

`@margoengine/text/extrude` remains an optional CPU font/mesh entry; core and stage are unchanged. All binary reads
are confined to their file/table/glyph/program span. Composite and Type 2 execution have bounded depth and work;
subdivision options reject nonfinite/fractional/excessive values with a coded error. Contours are filled by nonzero
winding before visible hole bridging and complete ear clipping; failed triangulations never return partial caps.
Both outward caps and the bevel walls share terminal ring coordinates. Invalid offset geometry is rejected.

`npm run check:text-extrude` is part of `check:merge:steps`, covering all extrusion tests, hostile font bytes,
curve/transform semantics, cap area, directed edge incidence, signed volume and unit normals. The package test
also discovers all extrusion test files. Independent reference and complete real-font runs cover Source Sans 3
Regular 3.052 in TTF and CFF1 (2,478 glyphs each; 2,469 nonempty solids per font); ten glyphs per font are compared
against frozen native unhinted cubic controls with a separate de Casteljau evaluator. The browser suite asserts
WebGPU orange pixels and native WebGL2 orange pixels, then zero orange pixels with the mesh hidden. The README
procedural font uses em coordinates and is executed as a regression case and by the README runtime gate.

Evidence limits: one family, two formats, one Windows GPU/browser, no speed claim or universal font guarantee.
CID CFF/CFF2, variations and shaping remain outside this entry; severe bevels throw instead of intersecting.
The all-glyph test covers unbeveled solids; synthetic cases cover rounded/chamfered bevels, holes and invalid offsets.

## 5. Current evidence gaps

Batch 231 surface placement adds CPU world-area and inverse-transpose normal preparation only; renderer and core/stage math are unchanged. Surface CPU tests prove deterministic/paint-weighted placement on nonuniform meshes and cliffs/undersides. The real Teapot/plant GPU comparison checks normal-aligned matrices against independent model roots on WebGPU and compatibility at 1x/4x MSAA, with mean channel error below 0.00005.
Batch 206 curves: CPU basis/cardinality/width tests plus direct and worker GPU creation on WebGPU and compatibility exercise optional Lines/Points ownership and teardown. Existing Lines Stroke supplies per-point widths. World diameters use maximum transform-axis length under anisotropic scale; no elliptical cross sections are claimed. See docs/limits.md.


Batch 232 lunar GPU maths: `scenery/moon` uses ray/sphere intersection at the far
plane with read-only reversed-Z depth, sRGB texture decoding, world-space lunar
north and a Lambert terminator plus complementary Earth phase. CPU and GPU
regressions cover lifecycle, orientation, phases and occlusion at 1x/4x sampling.
It uses the same optional backdrop on native WebGPU and full WebGL2 compatibility;
core and stage are unchanged. It makes no calibrated lunar photometry claim.

Batch 231 textured scatter reuses gltf-pro PBR instancing and its MASK depth casters rather than adding a renderer. Native WebGPU and full WebGL2 compatibility compare two real licensed Khronos plants to independent model copies, byte-identical at 1x/4x MSAA, with normal/mask/shadow controls and device restoration. CPU coverage includes affine conjugation with non-dyadic node scales, nested instances, tint/UV retention and disposal. Core/stage and their GPU math are unchanged.

Batch 246 job 3: tilemap/plane composes the active core camera with a map-pixel affine basis and loads/stores the existing reversed-Z scene depth. It adds no core or stage path. Independent all-pixel ray-plane proofs cover perspective, camera movement, ordinary mesh occlusion, alpha holes and distinct view cameras on WebGPU and WebGL2 compatibility. CPU tests validate matrix order, mutation and depth controls. No speed or picking evidence is claimed.

Batch 238 compatibility: whole straight-alpha ImageBitmaps with no crop or flip bypass Canvas2D to preserve transparent RGB. Native and compatibility exact WebP readbacks prove the no-transform path; existing transformed-copy handling remains covered by external-image.test.js.

Batch 238: progressive splat byte decoding uploads complete available records to the existing reserved Splats pool. No new projection, sorting or backend math. CPU proofs preserve final records across PLY, splat and SPZ 2/3/4; GPU coverage draws the partial MIT raccoon capture before its source supplies the remaining bytes, then reads the completed pool on native WebGPU and WebGL2 compatibility. Offline globally prioritised transmission and reduced total residency are not claimed.

Batch 209 GIF: shared exporter palette/codec CPU correctness includes LZW dictionary growth, transparent frames, async cancellation and centisecond rounding. gif-gpu.mjs renders through native WebGPU and full WebGL2 compatibility and independently decodes every frame; three-frame fixture error is zero. Existing exporter capture-browser checks pass on both paths. This changes no render math or core/stage code.

Batch 207 meshopt: section-exact round trips cover seven file variants, plus bounded corrupt-stream and expansion-bomb rejection. Both backends compare all pixels of original and compressed static/animated draws. Existing codecs and GPU layouts are unchanged; no throughput/latency proof is claimed during the speed deferral.

Batch 261 labels/gpu owns screen-space glyph expansion, SDF coverage and a single instanced draw, with priority-grid layout on CPU. Real WebGPU, native WebGL2 and compatibility WebGL2 evidence covers 100k labels, constant 87 by 30 pixel text at 5 and 50 units, behind-camera culling, cleanup and zero WebGPU validation errors. Atlas and buffer bounds are explicit; terrain occlusion and incremental upload are outside this entry. Core/stage stay unchanged.

Batch 209 headless/null uses the existing renderer injection API with a no-op renderer. Core/stage code and GPU math stay unchanged. CPU evidence proves real hierarchy matrices, multi-scene plugin isolation, animation sampling, disposal and no GPU request. No GPU rendering work is introduced or claimed, so this entry needs no GPU slot.
Batch 205 large: input/decoded/array/scene/geometry/texture/output budgets are per import and remain
cumulative before allocation. CPU proof covers 200 MiB input and 2,500,002 complete expanded vertices.
GPU/worker proof enforces a deliberately small vertex cap before a successful textured draw on both backends.
No core/stage change, rendering algorithm change or speed claim.

Batch 207 lightmaps: independent normal-incidence coloured-sun truth validates Cycles E/pi conversion and linear HDR export. Both backends render the expected neutral-display pixel and do not double-count engine lights. Source UV0/UV1 separation and generated UV1 are covered; CPU Cycles restoration is checked on success/failure. Broader scene, chart seam, instance-bake and full-film comparisons are not claimed. No core/GPU-math change.

Batch 246 job 1: optional tilemap/objects uses instanced vertex attributes and exact textureLoad reads on WebGPU and WebGL2 compatibility. Ordered texture runs preserve cross-tileset overlaps. CPU and real GPU tests cover collection size/animation, layer order, object flips/rotation, image repetition and empty frames. No kernel or stage change; no timing evidence claimed.

Batch 207 object actions: local hierarchy is checked against Blender evaluated world matrices for 1728 components, CPU plus native WebGPU and WebGL2 compatibility playback. Local shear is rejected, composed world shear retained, signed scale and constrained empty descendants covered. Procedural instance transforms and between-frame Bezier equivalence remain outside this evidence. Core/stage and GPU transform maths are unchanged.

Batch 209 headless/tiles: optional capture crops a copied view-projection in clip space and reads bounded WebGPU tiles. CPU coverage includes cancellation and alpha-aware linear accumulation. tiles-gpu.mjs checks exact full-frame equivalence, four-sample coverage, canvas restoration and output wider than the real GPU limit; WebGL2 refusal is explicit. Nonlocal or temporal effects remain outside tiled still correctness. No core or stage code changes.

Batch 208 cache browser evidence now includes prefetch and throttle in native window/service worker realms and exact offline RangeCache bytes from a replacement worker instance. Tests scope registration changes to their origin and use respondWith/waitUntil for lifetime. The existing test:browser command owns this storage-only proof; no GPU slot or rendering backend check is needed. Real throughput remains in the deferred speed-phase list.
Batch 205 textures: exact embedded/external TGA, DDS, TIFF and BMP pixels are checked in CPU conversion tests.
`packages/fbx/test/textures-browser.mjs` renders all four on the page and in the FBX worker through the real PBR pipeline and reads back red pixels
on WebGPU and the WebGL2 compatibility layer. Raw DDS pixel conversion has its own decoder entry to avoid
pulling unrelated Basis/KTX2/image decoders into the classic FBX worker. No core/stage or shader math changes.

Batch 208 cache/decoded adds a 4,540 B gzip ceiling (4,284 B measured, previously absent) for a coherent typed-result cache over the existing transactional storage. Browser proof uses real shipped Draco/KTX2 workers and the attributed Box/Rib_N assets, then verifies all array hashes and metadata across reload without a second decode. CPU tests cover key partitions, cancellation, storage failure and eviction; this path does not submit GPU work.

Batch 208 cache/stream: the optional entry has a 3,654 B gzip ceiling for pull-driven network bodies and complete-body IndexedDB commits. Node tests exercise cancellation, abort, failed bodies and storage budgets; the cache browser check holds the attributed SheenChair response open until its prefix is received, then checks exact SHA-256 storage equality. This storage-only browser proof needs no GPU slot; no rendering backend behavior or timing claim changes.

Batch 257 job 3: native Chromium pointer lock is proved across the canvas bridge with a trusted click, worker PointerLockControls rotation and worker-requested native exit. Six CPU cases cover state, exact deltas, permission/error paths, cancellation and ownership/disposal. This changes input forwarding only; rendering backends and core/stage remain unchanged.

Batch 257 job 2: automatic worker/page selection is proved with one shared scene module and six rendered worker/page/fallback cases across WebGPU and WebGL2. Capability/module preparation precedes irreversible canvas transfer. Worker runtime failures propagate; cleanup is acknowledged over RPC before termination. Native Firefox/Safari evidence is the separate batch job 4.

Batch 253 input evidence: `packages/input/test/input-browser.mjs` acquires native pointer lock from a click, drives a mesh transform through vector and locked mouse action channels, checks rendered pixel movement, then checks return after release. WebGPU and WebGL2 compatibility both pass. The package's `test:browser` registers this rendering proof in the GPU suite; changed-package GPU checks use a shared slot only. Physical XR controllers, hand tracking and raw mouse fidelity still need hardware acceptance; CPU fixtures cover their action/replay contracts and raw capability negotiation. No new rendering algorithm or speed claim.
Batch 257 job 1: worker RPC adds typed task dispatch and fixed FIFO pools without renderer changes. CPU proof covers actual worker transfer, cancellation, concurrency and transport errors; the worker GPU fixture also checks browser RPC. Existing thread-independence timing budgets are deferred by speedEnabled() during the build phase, with their original bars in docs/work-lists/speed-phase.md. Render, pick, sizing and input assertions still run on both backends.

Batch 273 array-layer repair separates adapter capacity from the unrequested
device default. The optional compatibility adapter reports GL's actual array
layer capacity; requestDevice negotiates it into a separate frozen device
limit object. Core's existing creation/restoration request already forwards
that capacity. The device regression distinguishes 256, 2048 and 4096 layer
adapters, lower requests, unsupported requests and recovery. No core, stage,
texture map, shader or scene grid change is part of this repair.
The full voxel compatibility suite, both slow-path commands, native bevel
reference and five layer comparison leaves pass with all assertions retained.
The forced-compat synthetic compiler delay still patches the native prototype;
that separate coverage gap remains in known-bugs. Full receipt:
`docs/whitepaper/results/batch-273-array-layer-limits.json`.

Batch 273 round 9 groups failures 11 through 26 in
`docs/work-lists/batch-273-compat-triage.md`. Native reference fixtures explicitly
disable the outer forced-compatibility shim while continuing to select the
layer inside their own comparison. `tests/compat-baselines.test.js` executes
all seven canonical setup calls under `MARGO_COMPAT=1` in verify and therefore
check:merge. Its assertions fail when those opt-outs are removed. This repairs
the reference-selection class, with original GPU assertions retained; it does
not prove the unresolved rendering, XR setup, limits, validation or wait cases.
Dispersion failure 9 is parked with its full-grid state-dependence in known-bugs.

Batch 171 job 4: /derive reuses compute.kernel and existing contiguous f32 scalar volume/isosurface
inputs. Scaled Jacobi operates on sym(J^2)=S^2+Omega^2; CPU/GPU absolute bounds, masks, one-sided
physical derivatives and FTZ limits are explicit in sciviz README/limits.md. Independent analytic and
NumPy black-box eigenvalue oracles guard against agreement on incorrect math; real GPU readbacks
cover both native WebGPU and the WebGL2 compute route. Synthetic vortex output feeds existing volume
and isosurface consumers; real NOAA demo remains an honest planar approximation. GPU results require
recomputation after device replacement. No core/stage/physics changes, no speed or native-WebGL2
volume claim. Final gate counts/limitations belong to the job acceptance receipt.

### Batch 234 caustics acceptance

The optional water/caustics entry refracts submitted surface triangles into
additive RGB flux-vector depth slices. Source-ready callbacks execute after
current wave preparation and before drawing water, without core/stage changes.
Independent projector, extinction, focused energy, shadow, resize and recovery
cases pass on WebGPU and full WebGL2 compatibility. The fast gate, 562 affected
unit/export/corpus checks and all 46 rendering commands pass; four caustic leaves
also pass against the final rebase's updated compatibility device. The fresh
NOAA preview shows opaque raised receivers and its explicit finite field edge.
Main's browser-host repair 919fdc09e closes the old teardown blocker; this job
changes no lifecycle files. README work is deferred. [Evidence and limits](../water-caustics.md).

Batch 213 job 1 adds VRM 0.x runtime normalization outside core/stage. The
existing rigging GPU harness now compares the real Alicia Solid 0.51 converted
skin/geometry picture with the original turned to +Z, with zero HDR component
error, and requires expression changes and neutral restoration on both
backends. Original binary buffers stay unchanged; separate synthetic checks
cover extension vector spaces and branch ownership. This does not claim MToon
shader parity. [Migration decisions and limits](../rigging-vrm0.md).

Batch 134's private ETC2/EAC draft has exact independent alpha and EAC
parameter oracles, edge-padding and coded-error checks. EAC interval masks
preserve error and header ties while reducing full palette constructions on
90 nonconstant oracle blocks from 5,898,240 to 79,844; 292 captured corpus
payloads also remain byte-identical. Native EAC hostile checks make 24,580
calls over 4,096 random blocks, prefixes and oversized dimensions. These
are not final expanded container fuzz or GPU upload evidence. All 993 old
source/payload controls hold: EAC R11 passes 26/26 quality pairs, RG11 fails
26/26 and ETC1S ETC2 fails 1/23. No bar changed, no fourth BC4/BC5 round,
no public integration or timing claim. Full record:
[remaining-target evidence](../whitepaper/results/batch-134-remaining-targets.json).

Batch 234 water `/query`: explicit GPU capture reuses the exact drawn surface
function/uniforms, derives particle velocity and builds projected bounds.
Synchronous CPU queries intersect the actual finite triangles, including folds
and signed dry masks. [Evidence and limits](../water-query.md) cover native
and full compatibility raster agreement, a separate coastal flux oracle,
derivative checks and lifecycle invalidation. No CPU FFT or geometry build,
implicit readback, core/stage change or speed claim. Other GPUs/browsers and
release throughput remain unmeasured.

Batch 234 water `/fft`: a separate GPU spectrum/evolution/2D-FFT/folding-foam
pass owns all of its buffers and writes surface colour and depth at order 4.
Core and stage are untouched. The [batch record](../water-fft.md) defines the
independent direct Fourier oracle, real NOAA wind data and required native/
compatibility evidence. Both backends pass the spectrum, derivative, folding
foam and lifecycle checks against an independent direct sum; the running
external ocean was visually inspected without reading its implementation.
All 12 existing water GPU runs and the full verify gate pass. The scope is
the FFT row's spectral behaviour, not a general hydrodynamics claim. No timing
proof is run in build phase.

Batch 171 LIC: the optional entry retains GPU image texels, generating on creation, phase change
or device replacement. Trilinear field sampling uses normalized coordinates; the inverse Gram basis projects
3D velocity onto affine slices; midpoint tracing uses image-texel arc length. Static box and Hann-windowed
periodic filters normalize accepted support. CPU validation/lifecycle tests pass. Independent analytical
convolution (maximum luminance error 1.4725853414443435e-7), exact circular arcs (1.1380660922433172e-5), NaN/domain
masks, oblique slices, phase loops/reversal and exact restored pixels pass on WebGPU and compatibility-backed
WebGL2, with zero backend pixel differences. Frozen `batch-171-lic*.json` evidence is in the whitepaper results.
NOAA demo controls/export and late updates after loader-deadline expiry pass on desktop/mobile on both backends.
One full verify ran 13,769 tests (13,765 passed); its four metadata/test-fixture failures were corrected and their
affected checks pass. All sciviz GPU suites, 24 README examples, lint, hygiene and all five quality gates pass.
Scaled norms after interpolation and projection preserve parallel flow across 24 orders, with zero difference
from unit-speed LIC on both backends. Nonzero nodes below 8*2^-126 after common scaling reject portably.
Native WebGL2 LIC rejects before GPU allocation. New optional entry 10,429 B gzip (+219 B within the existing
ceiling); core + stage stays 23,924 B.
No arbitrary curved-surface/unsteady-advection proof or timing claim.

Preview/compat continuation: the first interrupted compatibility run preserved 22
completed suites. The later run preserved 37 results before its process ended;
the restart confirmed it was gone and ran only the remaining 54, never a duplicate.
The repairs add inferred module-private WGSL types and give temporal DOF
independent half-image/tile kernels. Each has a regression that fails on its previous implementation. The
DOF comparison fixture explicitly chooses native startup before installing the
full layer, so a forced-compatibility outer runner cannot corrupt its baseline.
The culling discrepancy persists when dithering is disabled, so that speculative
change was removed. DOF passes its compatibility lens bounds. The complete
115-suite correctness selection has 89 passes and 26 failures, including culling.
The coordinator transferred those parity and forced-baseline failures to batch
273; known-bugs.md retains their repros and causes or remaining attribution gaps.
Prior completed suites are preserved. Research:
`docs/whitepaper/compat-continuation-research.md`.
No teardown work is included. Timing checks remain deferred, with the LOD
correction recorded below.

Correction: the inherited LOD GPU command also included a benchmark without a
timing assertion, and ran once before that was noticed. The default gate now
uses the same 140 frames per mode and all original assertions without reading
timing clocks. Its regression executes the actual fixture and checks every
render; the old fixture fails when it reads the forbidden clock. The optional
measurement path is explicitly deferred in `docs/work-lists/speed-phase.md`.

### Context loss during active D3D11 compilation (test-page 45)

The bounded test-page reproduction now reaches the actual synchronous hang:
tracer disposal returns, then engine disposal enters loseContext while the trace
render program is still compiling. Explicit shader/program deletion does not
resolve it. A raw WebGL2 OffscreenCanvas, using just the exact captured shader
pair and compile/link/context-loss calls, also hangs; its simple-shader control
links and loses context successfully. No texture, framebuffer, compute state or
Margo module is needed for the raw failure. All failing process trees are killed
at the unchanged 180 s limit, one shared slot at a time. The known monolithic
D3D11 compilation defect and this context-loss interaction remain open. There is
no runtime repair, native WebGPU failure claim or new speed measurement. A staged
route must retain identical tracing work and output; its correctness is unproved.

The continuation rules out large uniform indexing as a sufficient repair:
the existing data-texture path for two large blocks, then for every block,
still reaches the same hard limit. A uniform-dependent direct-light loop bound
does not repair the complete program. Engine ownership remains the submitted
trace representation in the optional tracer route, despite the raw-browser
repro. Parallel compilation offers completion polling, not cancellation or a
native compiler deadline. Core and browser teardown are not changed here.

Smaller dependency-tree diagnostics now link, including precise camera maths,
traversal, surface sampling, shadows, glass candidates and one direct-light
kind per invocation. The last fixture returns from context loss after all its
programs link. The complete lighting-loop diagnostic still hangs on loss while
pending. CPU f32 comparison of five ordered light steps preserves every saved
radiance/reservoir/RNG bit in 144 non-geometry cases. This is decomposition
evidence only; GPU output, full transport and state-texture correctness remain
missing. A conservative inventory finds 98 scalar words across path-loop
variables and private globals before phase scratch, liveness or bool packing;
the older approximate 18-vec4 state estimate must not become an allocation.

The smaller one-light raw program also returns from context loss requested
while its completion status is false, before the same process-tree deadline.
The supervised run still takes 92.2 s overall; this does not establish prompt
disposal. The initial fixture starts with an empty reservoir, so a carried-state
compile must retain every input field and its final BSDF evaluation before it
can support a real staged implementation. Shader splitting and safe lifecycle
coordination both remain work in the owning optional packages.

The carried-state compile check is not green: its 60,463-byte fragment remains
pending at the 120 s poll. Context loss returns before the 180 s tree limit,
but the command reports failed completion at 176.1 s overall. The initial
empty-reservoir success therefore does not prove that a complete transport
stage is bounded. Final reservoir/BSDF evaluation and shadow/candidate work need
finer separation with actual carried-state and GPU-output regression evidence.

Bug hunt, 2026-11-09: context loss waits for the pending compile, and the
trace program's compile does not end, so the hang is the compile. ANGLE's own
HLSL (from `WEBGL_debug_shaders`) compiled by the Windows SDK `fxc` reproduces
it on the CPU, with no browser or GPU, which gives the split work a cheap check.
Compile time grows 3.6 to 5.3 times per doubling of inlined code, `/Od` does
not help, and a program folded to 14 instructions still takes 119.5 s, so a
D3D11 route needs a size budget per compiled program (one traversal, one copy
of precise camera maths), not only a split. Evidence still missing: the split
itself, GPU output parity and a disposal-during-compilation regression.

### Batch 273: lower WebGL2 device tiers

The materials vertex-input GPU leaf now explicitly opens native and full compatibility
devices. Its instrumentation wraps the engine device's pipeline method, preserving
the receiver; instrumenting native GPUDevice.prototype observed no compatibility
calls. Both retain the original input-count, populated-frame and bit-exact image
assertions. The package GPU suite used by check:merge runs this two-backend leaf.
No renderer, shader or runtime API changed. Other indexed compatibility failures
remain separate obligations.

The materials features GPU leaf likewise explicitly selects native and full
compatibility, retaining all 15 feature groups on each. Native clip-distances
assertions still require hardware clipping; compatibility explicitly requires
the unavailable optional feature to use discard. Both retain every plane,
depth, shadow, instancing and live-switch pixel bound. The original forced
compatibility run fails its feature expectation; the corrected full leaf passes
both devices. No shader or backend behavior changed, and Bug 45 stays lane-U's.

The inherited compute scene-owner browser regression was missing from its package
GPU scripts. The planner correctly rejected that gap. A dedicated package script
and planner regression now keep it in check:merge. Its four render calls define
an exact four-dispatch oracle, explicitly documented as work rather than readiness.
The leaf starts with native browser APIs even under an outer compatibility shim,
then explicitly installs full compatibility for its second case. Both retain
all 1,024 values, ownership and disposal assertions. No runtime entry changes.

The optional tiers entry selects physical colour formats inside the existing
device: half-float or UNORM8 for render/storage targets, with logical WebGPU
formats and upload/copy layouts retained. Integer and depth/stencil targets and
sample-only float precision are unchanged. Float readback on a lower-tier device
uses integer framebuffer bit encoding, including the CPU compute readback path.
Unblended LDR stores use explicit nearest rounding; blending retains physical GL
conversion after the operation. Highp fragment precision is still required.

The device probes cover seven formats, exact bytes, mip/layer views, four-sample
resolve, blending and fragment/CPU compute on extension-masked real hardware.
The raw-GL blend control and existing native-WebGPU comparison are retained.
Physical-format cross-usage copies and sample-only cube views now pass, using
one counted synchronous readback per copied slice when GL cannot blit. Lower-tier
device creation loads that helper; full-tier loading stays lazy. Outstanding: every package's lower-tier
picture/refusal requirements, the requested real Safari/iOS/Firefox/Android
matrix, the brief's full-tier package failures, and all landing gates. No full
parity, speed or release-readiness claim follows from these scoped probes.
Research and scope are recorded in clean-room.md; core and stage are unchanged.

### Bevel polygon validity (test-page 44)

The mesh-edit whole-mesh bevel now uses its existing ear clipper for
nonplanar generated strips/caps, keeping UV corners and every face-map descendant.
Winding comes from input half edges and cap connectivity, rather than a centroid
normal estimate that inverted a twice-extruded cylinder strip. Twelve before/after
regressions prove planar faces, two opposite incidences per edge, unique IDs,
source ownership, face provenance and successful further editing. This is CPU
polygon modeling in its optional package; no core, GPU math, backend or speed claim.

### Retained core transform references (test-page 36)

Core Mesh defines non-configurable accessors for its position, rotation and scale
refs at construction. Replacement throws a coded TypeError before any transform
store write. No optional package can enforce this for every mesh. Camera tuples
remain assignable; core has no retained quaternion ref. The regression in
`packages/core/tests/transform-refs.test.js` fails on the writable-field parent
and covers array/object/self/null/number assignment, Reflect.set, store growth,
component/set/setAll mutation and inspector snapshot/restore with ref identity.
Core + stage measures 23,837 B before and 23,924 B after (+87 B); no speed claim.

Sciviz review validation closed (2026-11-10): after main's cf699846f and 20375ea56
teardown repairs, the review-only tree passes 143 scoped CPU tests, 30 base GPU,
13 bricks, 10 entry, 6 replacement/cancellation and 28 demo cases. All 18 README
examples finish inside the existing 20-second page budget and browser teardown
succeeds. One shared slot runs the browser and README commands serially; no
exclusive GPU hold or speed assertion ran. All eight head/star captures at both
required viewports/backends were visually reviewed, retaining 8 CSS-pixel spacing.

The prior full verify's only failure was a stale paired size/network record.
Regenerating both from the same built revision fixes the cause; only the unchanged
sizes-page step was rerun (8 passing), as requested. Both records truthfully name
the same commit and packages-dirty flag. Core + stage measures 23,924 B gzip under
25,000 B. The full verify was already run once; this continuation does not claim
a second full run. Later native drawing and temporal-flow pieces have separate
validation and are not included in these review-only counts.

Batch 181 native sciviz drawing (2026-11-10): optional `sciviz/webgl2` injects a typed driver into SciRenderer;
the root has no runtime import of it. Figure returns its existing surface and rectangle layer classes. R32F
vertex fetches and instanced integer-colour attributes retain all cells with no CPU tessellation. The driver
owns its programs/VAOs/buffers/textures, scopes caller GL state around uploads/draws, shares the engine depth
buffer and applies top-left view rectangles to GL's bottom-left viewport/scissor. Layer restore replaces those
resources from retained CPU data, including updated heights; use the existing optional webglRestore plugin.
All 346 scoped CPU tests and strict eight-image native parity now pass on Chromium/RTX A6000,
including real context restoration and resource disposal with NO_ERROR. The initial-frame clear must also cover
pixels outside the first view scissor; the preview now does this after rectangle validation and preserves later
views. NaN holes reject whole triangles, with finite one-sided normals at missing-data boundaries. The protocol
waits until the context-lost event has fully dispatched before requesting restoration, using one posted task.
Scott's optional-size ruling keeps the existing driver boundary and raises root/driver ceilings from
36,802/4,442 B to their measured 36,916/4,476 B. The root previously measured 36,802 B; driver 4,288 B.
The extra bytes preserve missing-data parity and generation-safe disposal. Splitting the shared shader adds
an artificial async loader/restore contract; splitting cleanup divides ownership of one resource generation.
Only the repeated GL receiver alias survives the stopped size work; byte-only shader/message changes and the
pipeline helper are dropped. Core + stage stays 23,924 B under 25,000. Final browser gates pass 30 base,
13 bricks, 10 entry, 6 restoration/cancellation and 28 demo cases; the separate preview suite passes too.
All 32 sciviz/webgl2-compat README examples run under their unchanged budgets. The existing strict native
eight-image parity pass and all 346 scoped CPU tests remain valid. Evidence: ruling-final-*.log/json and
resume-webgl-checkpoint-native.log in test-results/sciviz-fixes. Only the failed size prerequisites are rerun;
the earlier full verify, lint and hygiene results are retained as requested.
Axes, points/lines, volumes/slices, integrated CPU isosurfaces and real native demos remain pending.
No exclusive lock, benchmark, paired wall-clock measurement or timing assertion is part of this piece.


Half-float conversion retains the same source samples and output words while
removing two temporary views per voxel. tests/f16-allocation.test.js checks all
half words, signed ties and 574,992 fewer allocations for the default brick.
No wall-clock speed claim is made.

GPU coordination on Windows (2026-11-10): a real delete-pending directory handle reproduces `EPERM` on the
shared lock's parent or mutex name. `makeLockDirectory` handles this as bounded acquisition contention (10 seconds
per name), including older clients' in-place deletion; live ownership is never changed. Native Windows and
deterministic tests in `tests/gpu-lock-mutex.test.js` also require permanent permission failures to remain visible.

### Voxel streaming budget admission (2026-11-09)

The streamer reserves ready/loading jobs on every start and checks actual chunk bytes before admission,
with LRU eviction restricted to chunks outside the load range. Three deterministic regressions in
`packages/voxel/tests/streamer.test.js` fail on the previous implementation: stored chunk backlogs,
variable-size/oversized results and packed real-worker results. They also prove that increasing the budget
resumes retained chunks. The normal voxel package tests and full verify run them, including check:merge's
affected-package verification. This is loaded-data admission evidence; total process memory and subsequent
edits are outside that budget, and no rendering or speed claim follows from these tests.

Batch 56 review repairs add a constant-size SH radiance-moment directional receiver
in optional staging/ground; ray-plane projection retains caster-height clipping.
No core or stage change. Scene-target draws must call applyView; full local targets
must declare why their viewport is local. The verify unit suite's
`tests/environment-staging-view-state.test.js` checks every render-pass start in
environment/staging and tests the detector with missing-view and false-local inputs.
Temporary TAA/TAAUpscale wrappers retain their unjittered source across optional
bundle boundaries. The still controller supplies it at orders 19..21 and restores
raster jitter before TAA's order-40 resolve. Capture and disposal use sceneOf;
probe baking is audited for the same external-default-scene problem. Remaining
limits are single-moment lighting, spatial blur, native preview refusal and no
claim of authored photographic transport fidelity. Regression evidence is in
package review56/ground/pathtrace tests and the browser suites; final run results
are recorded with the repair commit's validation evidence.

### Sciviz asynchronous updates and trace replacement (2026-11-10)

Restore audit: every sciviz `Drawable` must implement `restore`; package type checks and the layer protocol
regression guard this class of missing hook. SciRenderer rebuilds frame uniforms/layouts and pipelines, observes
asynchronous restoration errors and exposes them through `Figure.ready()` and rendering. Figure invalidates its
cached compute context. Isosurfaces abort old-device work before clearing bindings, reconstruct CPU-backed
fields/tables/compute contexts, and queue re-extraction of the last committed level ahead of new updates. GPU-only
sources have no CPU mirror and require caller recreation; their old bindings can never be submitted again.
The audit also covers the latest CPU surface heights, mesh triangles, graph positions, decoded tile pixels,
volumes and both slice types, rectangles, point/line plugins and the renderer frame state. The renderer alone
restores registered slices; bricked parents do not allocate a duplicate slice uniform. `restoration-browser.mjs`
replaces actual devices and checks the exact MRI input, a held extraction, later update/creation, all root layers
and successful source completion after frame cancellation. `entries-browser.js` compares every entry's full pixels
before/after device replacement. These are in the package browser script, hence `check:merge`'s GPU closure.
`demos-browser.mjs` asserts measured label bounds and 8 px separation for all visible head/star axis labels at both
required sizes and backends. Evidence scope remains Chromium/native WebGPU and WebGL2 compatibility on this
machine; other hardware/browser families and performance remain unmeasured.

Real-data demo evidence: `packages/sciviz/tests/demos-browser.mjs` runs the OpenNeuro head MRI, million-source
2MASS catalogue and NOAA daily wind pages, plus the four retained synthetic API exercise pages. The package's
browser script includes it in the normal GPU quality gate. It covers native WebGPU and forced WebGL2 at
1440 x 900 and 390 x 844, actual box/lasso drags, exact selected histogram counts, exports, rapid control changes,
trace counts and structured pixels. Live wind frames must retain both traces and nonempty pixels during playback
and seeking. `demo-data.test.js` pins the real asset hashes and tests MRI interior structure, catalogue count and
wind temporal variation. The assets and source terms are documented under `examples/assets/sciviz/` and use Git LFS.
This adds Chromium correctness evidence; other browser families and new speed or hardware-tier claims remain unproven.

Isosurface extractions run in request order and build a separate vertex buffer. The vertices, bind group,
triangle count and level publish together after GPU completion; abort, failure and disposal cannot publish a
partial surface. Bricked `setFrame` requests serialize their own readiness instead of sharing whichever step
was selected last. Timeline seeks already serialize callbacks; disposal now suppresses a pending callback's
index and event publication. Ordinary volumes have no asynchronous frame setter.
Figure isosurface creation also checks disposal after compute loading and after extraction, freeing the unfinished
layer rather than leaving it registered after the figure has been disposed.
`packages/sciviz/tests/updates.test.js` deterministically holds completions to check overlap, buffer identity,
counts, cancellation, disposal and queue recovery, plus the distinct single-slice validation errors. These tests
join the existing package test closure in `check:merge`, guarding asynchronous publication as a class.
`sciviz-browser.js` checks overlapping levels against the original GPU surface and CPU triangle count;
`bricks-browser.js` checks overlapping frame promises and final pixels.

`Figure.replace(old, next)` keeps the existing layer until its replacement is built; callers replace immediately
after awaiting the builder. `entries-browser.mjs` exercises scatter, quiver, streamlines and histograms through
queued seeks with lit-pixel checks, one-layer checks and SVG export on native WebGPU and forced WebGL2, and
compares final pixels across backends. Replacement is resource rebuild rather than in-place buffer reuse;
the new image must also match a fresh draw of the same data, and removal must leave no stale pixels.
Point and line removal now calls the resource's owner-aware disposal synchronously rather than waiting on an
already-loaded plugin promise; attached figure disposal frees its traces through the same path.
Isosurfaces hold both the displayed and pending vertex buffer. No speed, other-hardware or official-demo
presentation claim is added by these checks.

### Biome I/O and executable README continuation (2026-11-09)

The complete default 4 km height/weight/mask/temperature exports and saved-world digest match
parent 349243b3d byte for byte (results/biomes-io-20261109.json). Height-only sampling omits
unrequested climate fields; paired classifier outputs reduce export tile requests from 1,536
to 1,024. Bounded worker batches have exact serial parity, including edits and cropped tiles,
and settle every started job on failure. These are deterministic work/output proofs, not speed results.

One runtime README GPU slot now owns one complete page lifecycle at a time; three concurrent
pages previously competed inside that slot and the terrain-view example hit its unchanged
20 s deadline. The gate still fails incomplete examples and preserves partial results. GPU mutex
cleanup retires its reusable directory name before deletion. The native Windows regression
holds a real delete-pending directory and reproduces the original EPERM, alongside portable
contention/permission models and the existing legacy lock tests. Cross-device timing and
headset/phone/input-device gaps remain open; held physics sources are unchanged.

BiomeView streaming and prefetch now share one raw generation per tile/revision, with independent
subscriber aborts and identity-guarded retirement. Edits detach old generations; disposal reaches
them through the view lifetime. The completion guard enforces the existing 1,024-result cache cap.
The full default-world proof compares every worker result field and typed-array hash with the
parent: view requests 204 to 144, placement 190 to 144, all 292 unique results identical.
The entry remains within the unchanged 10,454 B gzip ceiling. CPU regressions cover overlap,
cancellation, failure, actual edited/cache bytes, capacity, queued/started streaming and detached
revisions. The reproducible GPU proof is packages/biomes/scripts/prefetch-proof.mjs and its record
is whitepaper/results/biomes-prefetch-20261109.json. This proves work reduction, not a speed ratio.

### Draco clean-room replacement (batch 133, 2026-11-09)

The complete published specification and five figures were reviewed before code.
Required decoding paths are missing; [the source ledger](../clean-room.md#draco-replacement-specification-review-batch-133-2026-11-09)
records the evidence. The private specification-only plan preserves Rust/Wasm,
the existing TypeScript API, one lazy decoder asset, hostile-input bounds, full
external-corpus bit comparisons and paired A/B gates. Scott's 2026-11-10 ruling
allows crafted-input black-box inference for omitted rules, with experiments in
the source ledger and private plan; codec and wrapper source remain unread.
The development Rust crate matches all 454 original native and float payloads,
including all 323 unique external streams, with exact descriptors and ordered
indices. Separate native/Wasm fixtures cover 281 existing attribute cases,
369 KD cases and 730 topology cases, including all 31 former capped-fan failures
and 182 new held-out caps. Existing attribute strict-prefix/mutation/lifecycle
checks remain; KD adds 49,779 strict prefixes, 4,096 mutations and 2,000 frees.
The topology Wasm suite reaches its unchanged 16,384-mutation campaign again.
The [prebuilt targets](../whitepaper/perf-history.md#batch-133-prebuilt-decoder-targets-development)
were measured first on the whole corpus. Releasing prediction-only owners before
final attribute construction lowers the same-input Wasm linear-memory peak from
23,789,568 to 18,874,368 bytes, below the old 20,185,088-byte target. Two pinned
ABeautifulGame full streams and oracle output hashes make this a regression test
that fails on the prior artifact. Core and stage are untouched.

These are unshipped development proofs. Full predictor/version/point-cloud and
metadata/typed-conversion coverage, budget and loader/worker/lifecycle integration,
process RSS, cold-process start-up and paired cold/warm per-file timing remain
open. Both prebuilts remain until all five jobs pass; no speed, SIMD or shipped
replacement claim is made. The original-corpus measurement manifest is unchanged;
new discovery cases have not yet entered its timing targets.

### Basis clean-room replacement (batch 134, 2026-11-09)

Scott's ruling dated 2026-11-10 replaces the earlier byte-choice blocker with
bit identity for prescribed output and per-file quality no worse for free
encoding choices. The [source ledger](../clean-room.md#basis-replacement-specification-gate-batch-134-2026-11-09)
records the review. The [partial prebuilt baseline](../whitepaper/results/batch-134-prebuilt-baseline.json)
records 51 files, 699 successful file/target pairs, cold/warm paired controls,
per-image hashes, isolated per-target process/Wasm memory and startup phases.
Both vendor and shipped static-embind wrappers were measured separately;
their complete image signatures and existing source-quality measurements match.
Shipped targets use the built wrapper. All 21 served quality readers now
cover 685/699 pairs and 9,477/9,491 images; 186 original base metrics remain
unchanged. Fourteen AGI pairs lack source pixels and 12 alpha3 pairs are
provisional. Manager approval (2026-11-09) permits job 2 now and requires
openly licensed replacements for all four files with unproven image grants.
The 21 reader/source tests pass; ASTC/UASTC cross-target comparisons match
201,689,800 LDR and 409,444 HDR channel samples exactly, without codec inference.
A replacement, replacement identity, paired old/new speed, hostile input and
GPU uploads remain unverified. Runtime feature probes show this
prebuilt disables ATC, FXT1 and PVRTC2; these are not missing replacement paths.
Retain the prebuilt until all five job gates pass. Use one optional Rust/Wasm
asset and the unchanged TypeScript API, including the existing HDR entry.
Core, stage and physics are unchanged.

The [active licensed corpus](../whitepaper/results/batch-134-active-corpus.json)
replaces the AGI atlas, alpha3, Kodak03 and Memorial cube with CC0 assets of the
same dimensions, input formats, alpha/cube features and mip counts. All 699
served pairs and 9,491 images now have source metrics, with zero provisional
pairs. The four replacements account for 45 pairs and 250 images. Three .basis
files use real FlightHelmet image content; the HDR cube uses an analytic light
field. The historical baseline is retained, and its timings are not transplanted
onto new inputs. Replacement timing and the transcoder's acceptance gates remain.


### Procedural space colonisation (batch 68, job 4)

The optional trees entry owns its Rust crate and lazy Wasm asset. Attraction assignment and growth are
CPU operations with typed owned output and no core/stage imports. Tests compare accelerated neighbour
assignment with an exhaustive reference, validate connected finite parent graphs, segment lengths,
bounded hostile inputs, cancellation and disposal. Production consumer tests check lazy loading below
a non-root base and exact values on real WebGPU/WebGL2 before and after loss. These are stand-in
skeleton proofs; mesh appearance, biological fidelity, timing and cross-device coverage remain open
evidence boundaries (LIM-631).

The internal loader shared by Poisson, dungeon and trees now preserves exact abort reasons and
specific linked/CSP faults while coding file, fetch, body and ordinary compilation failures with
procedural help and the original cause. Seven regressions exercise real missing-file and malformed
Wasm errors plus simulated transport, CSP and cancellation cases; they do not claim a real CSP-policy
browser failure proof. Existing healthy backend values and independent feature assets are unchanged.

The lane-Q README repair (2026-11-09) executes all 40 examples of React, Stage, text and worker with zero
exceptions in that scope. The page runner prebundles React's CommonJS entries, compiles JSX automatically and writes
named page/worker companion sources into isolated program directories. Static glTF selection follows the imported
basic loader, including Stage's feature entry, rather than the owning package name. Browser automation stays in Node,
receives the selected browser/GPU launch environment and fails on unfinished assertions; it cannot pass as a server
that merely reaches its time limit. React's picking example owns its app/server and waits for real frames and the
click's asynchronous state update. Text's BMFont sample includes a generated, OFL-licensed ASCII SDF atlas and a
relative PNG page; its browser test fetches both and reads back rendered Hello pixels. These five exceptions are
removed from the known list. This evidence covers Chromium on this machine, not other browser engines or fonts.
The atlas writer is registered as a browser tool in the GPU planner; generation never replaces the planned text
rendering suite or rewrites a committed fixture during verification.

The lane-Q README repair (2026-11-09) executes all 40 examples of React, Stage, text and worker with zero
exceptions in that scope. The page runner prebundles React's CommonJS entries, compiles JSX automatically and writes
named page/worker companion sources into isolated program directories. Static glTF selection follows the imported
basic loader, including Stage's feature entry, rather than the owning package name. Browser automation stays in Node,
receives the selected browser/GPU launch environment and fails on unfinished assertions; it cannot pass as a server
that merely reaches its time limit. React's picking example owns its app/server and waits for real frames and the
click's asynchronous state update. Text's BMFont sample includes a generated, OFL-licensed ASCII SDF atlas and a
relative PNG page; its browser test fetches both and reads back rendered Hello pixels. These five exceptions are
removed from the known list. This evidence covers Chromium on this machine, not other browser engines or fonts.
The atlas writer is registered as a browser tool in the GPU planner; generation never replaces the planned text
rendering suite or rewrites a committed fixture during verification.

### Required S2 sample and IES README evidence (2026-11-09)

The pinned CesiumJS S2 standard-data sample expands 21 implicit cells; 45,738 points from
independent face-0 quadratic projection/WGS84 equations fit the loaded boxes at the file's
height ranges. Three exact data files join the required external manifest (352 inputs).
This is hierarchy/containment proof, without content meshes or production-world rendering.
Binary metadata heights do not tighten the inherited 0..10,000 m slab; other faces/octrees
retain generated controls. The IES README now runs its published CC-BY-4.0 profile, and all
10 clustered examples pass. These results establish no new image-quality or timing claim.


### Procedural BSP layouts (batch 68, job 3)

The optional dungeon entry owns one dungeon-kernel crate and one lazily loaded dungeon.wasm. Partitioning,
room generation and rasterization run in Rust compiled with SIMD enabled; no SIMD speed gain is claimed.
The shared internal byte loader preserves independent per-feature URLs and the existing Poisson entry's
abort/error behaviour. No core or stage source changes. Native Rust and TypeScript tests check bounded
inputs, owned outputs, seeded repeatability, wall borders, room margins, tree links, flood-fill connectivity
and an independent whole-grid raster oracle. Direct written-cell work excludes common grid initialization.
The production browser test covers both feature assets under a non-root base, no Wasm request on import,
WebGPU/WebGL2 exact values, real device/context loss, and idempotent disposal. All grids are STAND-IN;
gameplay, navigation clearance, 3D meshes, cross-device coverage and timing remain unmeasured (LIM-628).

### Procedural Poisson placement (batch 68, job 1)

`procedural/poisson` keeps rejection and area loops in one lazy feature-local Rust/Wasm module; core and stage
stay unchanged. Its hash matches a float64 all-pairs oracle on identical candidates: 3,329 versus 3,445,553
distance tests. This is deterministic work evidence, not language speed evidence. Synthetic rectangles and
sloped/disconnected triangles establish spacing, bounds, area weighting, hostile inputs and lifecycle behavior.
The browser test builds a production consumer under `/sampling/`, verifies no Wasm request on import, then
compares WebGPU/WebGL2 values after device/context loss. No renderer resources are owned. Rebuild with
`build:poisson`; native tests use `test:poisson-kernel`. SIMD is enabled without an acceleration claim.
Authored meshes, spectral quality, maximal covering and cross-platform bit identity remain unmeasured (LIM-621).

A pinned, required CC-BY-4.0 OpenVDB sphere now catches empty half-value node alignment: zero half values have no
compressed-size prefix. ZIP/Blosc synthetic cases and the outside sphere exercise the fix without changing values
or tolerances. Its 1,451 leaves, 270,638 active voxels and bounds match the file metadata; no new codec/version
coverage or renderer quality follows. The OFF parser uses explicitly LGPL-licensed standard samples; held physics
and benchmark knight workloads are unchanged. See the required-input inventory.

The required-input audit also exercised the newly landed SQL-store restart test. The unit watchdog caught a
Windows `EBUSY` folder hook before database closure, followed by a leaked server and generator workers. Its
test-body `AsyncDisposableStack` now closes resources before directory removal, including failed setup; the
unchanged watchdog remains the check for process leaks. Regression: `packages/voxel-net/tests/sql-store.test.js`.

### WebGL2 consolidation evidence

The optional compatibility package also owns `/preview`, `/pick`, `/restore` and
`/auto`. The real-context proof is `packages/webgl2-compat/test/preview-browser-check.mjs`,
covering selection, context loss and escalation, alongside the full compatibility
GPU suite. The preview remains necessary below the full device float-target tier.
See [the feature mapping and inventory](../webgl-consolidation.md).
The WFC browser test now tears down its browser and server together with bounded
`closeAll`, including failed startup. `tests/browser-teardown.test.js` caught its
previous unbounded shutdown while validating this consolidation.



The required-fixture audit is tracked in [missing-test-items](../work-lists/missing-test-items.md).
The verify root suite now runs `tests/fixture-skips.test.js`, which parses test/proof syntax with
`scripts/check-fixture-skips.mjs` and rejects the audited missing-file skip/early-success patterns.
Required reads also reject absent files and Git LFS pointers with an exact path and recovery command.
Download failures (HTTP, byte budget, digest) fail. Batch 160's four files and held physics packages
remain explicit ownership exclusions, not fresh proof. The initial existing-fixture run passed 561
tests with no skips; final strict CPU, GPU and gate results are recorded in the work list as they finish.
Missing real-file variants and reference renders remain pending there; no runtime quality or speed
claim follows from replacing a silent skip with a failure.

Batch 160 adds the first outside metallic-roughness picture budget: all 123 Khronos textureless sphere
primitives, matched embedded camera/sun, neutral display transform and every pixel, against Sample Viewer
PNG output. RTX A6000 RGB MAE 1.837511698404948 on WebGPU and 1.837506612141927 through WebGL2
compatibility; native WebGL2 explicitly rejects PBR. See whitepaper/results/batch-160-metallic-roughness.json
and scripts/reference-rendering/run.mjs. The remaining picture loss is open in known-bugs; other material
families and the independent path-traced IBL/Cornell controls are still unmeasured. No core change.

### Lighting2d batch 55 repair evidence (2026-11-08)

`packages/lighting2d/tests/frame-regressions.js` and `emission-regressions.js` extend the existing `test:gpu` suite,
already discovered by `check:gpu-packages` in `check:merge`; `frame-lifecycle.test.js` adds Node lifecycle coverage.
Every direct-light entry now runs the same
mask/layer, repeated-frame, format, name-reuse and device-loss scenarios. Independent arithmetic checks cover separate
height uniforms and isolated HDR threshold images; actual `Bloom.encodeImage` output is checked against a separately
encoded dispatch and must spread outside a zero-glow sprite. All six entries reject a native WebGL2 engine with a coded
error and help link. Direct-light storage ceilings are device limits rather than silent 64-item truncation.

Current evidence is one RTX A6000/Edge device. Cross-vendor rounding and adapter behaviour remain unproved. The spatial
GI replacement now has the independent energy, visibility and analytic-circle evidence described below. No speed claim
or benchmark is added. Scott approved the six exact measured optional ceilings on 2026-11-09; all gates remain mandatory.


The following remain technical gaps, not permission to weaken a check:

PixelScale, CRT and PaletteQuantize have CPU-reference/readback evidence on the RTX A6000 through native WebGPU and
the WebGL2 compatibility layer. The pixel regressions above cover format reuse, scene ownership, clipping and flat
nearest boundaries; the palette unit suite covers finite-cycle reduction and overflow. Curved CRT comparisons still
exclude samples within 0.001 texel of an edge (float32 versus float64 can choose different neighbours); flat/all-off
samples are never excluded, and all-off is exact. No other GPU/browser family, physical CRT fidelity or speed result
is established by these checks. Native WebGL2 preview remains unsupported for these optional GPU passes.

Extruded text has the scoped evidence above, not cross-font-family or multi-device certification; font hinting,
shaping and arbitrary bevel topology changes are not proved by those checks.

1. No gate directly proves that embedded Wasm matches current Rust source.
2. Native and Wasm turn reduction differ at an exact half-way case that lacks a regression test.
3. The kernel optimization experiment uses obsolete layout and compression assumptions.
4. Cross-machine bit equality of kernel output is not measured.
5. Precise-math GPU cost versus builtins is measured on the RTX A6000 only.
6. Intel Arc 140V precise-math bounds need a post-fix run; AMD and Intel UHD need one since the `pmLog2Pair` change of
   2026-11-05, and `precisePow`'s cost needs measuring again.
7. Compatibility CPU compute runs 13 to 41 times slower without `unsafe-eval` (interpreter); broad CSP prose must remain scoped to the native engine.
8. Compatibility path-tracer kernels remain outside the practical shader-compilation budget.
9. Visual baselines do not cover every supported GPU/browser/OS combination.
   A true GPU out-of-memory is not exercised either: failed allocations are proved on the throwing paths only (section 3.6).
10. The WebGL preview size was inconsistent across older public sources; current generated evidence should replace
    every stale statement.
11. One duplicate-window comment says eight lines while implementation and conventions use six.
12. GPU geometry generation has no speed measurement and no run on a GPU other than the RTX A6000.
13. Only the upper core-stage bound is enforced; there is intentionally no lower bound.
14. Public-truth checks cover license and package count, not every size or performance number, so a size figure in a guide or
    package README can go stale with no check failing (section 4.7).
    README examples are held by `check:readmes` in `verify` since 2026-11-06, but 328 known errors remain (docs/known-bugs.md), so
    those examples are not yet evidence that their package's types are right.
15. Remote workflow configuration is not proof that a workflow actually ran.
16. The quality classifier must keep a conservative full-mode fallback for genuinely unclassifiable or shared
    changes, while ordinary package changes remain affected-only.
17. Scatter's GPU cull keeps candidate order (2026-11-05; it used to append at `atomicAdd` slots, and an Apple M6 drew
    other 4x MSAA edge pixels every frame). The exact 4x MSAA repeat check (`packages/scatter/test/repeat.browser.mjs`)
    and `packages/biomes/tests/shadows-check.mjs --msaa` have passed on the RTX A6000 and the M6 only, run by hand;
    no gate runs either one on Apple GPUs, and other GPUs are not checked. Its shadow lists still append atomically
    (depth only, so the same depth in any order).
18. Subgroup kernels have run at subgroup sizes 32 and 4 only, and no gate runs size 4.
19. GPU BVH traversal and the GPU build have no quiet speed measurement and no run on a GPU other than the RTX A6000.
20. `CulledModels`, per-cascade caster culling, `LodInstances` and `MeshletMesh` have no timed run; each is proved by pixels on the RTX
    A6000 alone, as are occluders, oriented boxes and occlusion for core meshes.
21. Every timing since 2026-11-05 is diagnostic. The parity ledger's last run is 2026-10-27: after numbers sit in the row's cause text,
    and `p-morph-compiled`, `p-motion-blur-velocity` and `p-pmrem-refresh` have no ledger row yet.
22. The WebGL2 CPU tier's interpreter and the path tracer on the layer have no committed timing script.
23. `@margoengine/shader` compute passes have no check on the WebGL2 layer, and `@margoengine/compute/nn` and `/graph` no speed measurement.
24. The headless stage runs in Node on Windows only (Dawn on D3D12 and WARP), and a textured glTF does not load there.
25. Draw counts in LIM rows are printed by GPU checks and asserted only as bounds, and no result file holds them.
26. `ScenePass` (`@margoengine/shader/pass`) has no check in a multi-view frame, and its `velocity()` follows one camera.
27. Dual quaternion skinning has no frame-time measurement and no run on a GPU other than the RTX A6000.
28. Bone-texture crowds have no frame-time measurement and no run on a GPU other than the RTX A6000.
29. GPU Basis transcoding (`@margoengine/decoders/ktx2-gpu`) equals the Wasm transcoder byte for byte on the RTX A6000 only, and
    its load time against a cold Wasm transcoder is not measured.
30. The own physics kernel is proved bit-equal on one Windows x86-64 PC only: no run in Safari, on ARM or on a second machine, and it has no timing against Rapier yet. The range check runs once a step, so a run away of more than 23 orders of magnitude inside one step would reach a NaN: none seen in 200 random webs of 10,000 steps.
31. Voxel far levels (`@margoengine/voxel/lod`, a scaled `VoxelRenderer`) are proved on the M6 Mac mini (Metal) only: scale 2 against scale 1 drew the same image; frame cost at kilometre view distances is not measured on any GPU.
32. The own physics solver's body kinds, own mass and extra passes (LIM-438) are proved in Node and by the replay in Chromium and
    Firefox; nothing of it is timed against Rapier yet (batch 129). Sleep reads through `setType` and of still kinematic bodies
    (a RESTING flag: they stay on the awake list) are held to the root entry's measured reads in `next-bodies.test.js`; an island
    still wakes at the call rather than at the step, an accepted difference in `docs/limits.md`. A kinematicPosition body at its
    target is exactly still (`kernel/tests/sleep.rs`), so what rests on it sleeps.
33. Coloured voxel block light (`@margoengine/voxel/light-rgb`, a `VoxelRenderer` lighting effect sampling a wrapping 3D texture) is proved on the M6 Mac mini (Metal) only: a dark room is red by a red torch and blue by a blue lamp with it, black without; its frame cost and the upload cost when the camera crosses chunks are not measured.
34. Local CI replaces GitHub Actions while the repository is private (2026-11-07; the CI, Browser checks and Biomes
    digests workflows are disabled on GitHub). It runs in its own worktree, `C:\Development\Projects\margoengine-ci`, from
    a script in its git-excluded `.ci/` folder (`ci.mjs`, `quiet.mjs`, `register-tasks.ps1`), as Scott's user, not elevated,
    through Windows Task Scheduler (folder `\Margo\`):
    - CPU set at 08:00, 12:00, 14:00, 16:00, 18:00, 20:00 and 22:00 on the newest `origin/main` (skipped when that commit
      was already checked): `build:packages`, `lint`, `typecheck`, `hygiene`, `check-engines --run=repo`, every chain of
      `verify`'s stage 2 (API reports, quality, parity table, sandboxes, root unit tests, docs links, README checks, size,
      proofs), `test:kernel`, `test:physics-kernel` and `test:physics2d-kernel` (since 2026-11-08).
    - Full set at 10:00: the CPU set (reused from an earlier run on the same commit), then every `check:merge:steps` step
      after `verify` but `check:rust-kernels` (its kernels are in the CPU set), one at a time, each through the GPU lock as one shared slot (exclusive for its timing tests). No GPU
      step starts from 12:00 to 20:00 (benchmarks); one that would is recorded as deferred.
    - Weekly quiet hour, Sunday 06:00 to 07:00: waits up to 20 minutes for the whole machine under 10 percent CPU, else
      records "not quiet"; then, holding the GPU alone, Margo's two columns of the physics comparison harness (defaults
      and equal cost) and the three.js parity matrix (`bench/cli.mjs parity`, without the report that rewrites docs).
    Every step has a hard limit and a hang kills its process tree; nothing is retried, pushed or edited in tracked files.
    One run at a time (a lock with a heartbeat, reclaimed when dead). Results stay on the dev PC, in the main checkout's git-excluded
    folder for private notes. Status: `ci-status.json` (commit, times, each step's result, duration and CPU load, the failing tests by name, log paths; a time or
    speed failure under a mean load of 70 percent or more is listed apart as "time-only under load", unless it is more
    than 2x its budget). Timing trend: `ci-timings.jsonl`, each timed test and step per main commit with its load;
    a jump of 1.5x or more against the previous main commit at a load within 15 points is flagged in the status file.
    Quiet-hour results: `quiet-bench/<date>.json` with a diff against the last quiet run. Logs: the last 10 runs
    in `.ci/logs/`. Not covered locally: the Node 22.12, 22.x and Node 24.18 runs of `node-compat` and `node22-tests` (one
    Node, 26.12, is installed), the Linux and macOS biomes digests, and the on-demand Browser checks workflow's
    SwiftShader runs.
35. The own physics kernel's triangle meshes (batch 126 job 2, `kernel/src/mesh.rs`, `bvh.rs`): the tree is checked
    against brute force (`kernel/tests/bvh.rs`, and a box on a bumpy mesh gets the same parts and points as one mesh a
    triangle), the edge rule against closed cases and slides (`kernel/tests/mesh.rs`), the separating axis test of a flat
    triangle against every axis on 20,000 random poses (`kernel/tests/sat.rs`), and the physics-refs trimesh scenes pass
    in Node (flat slides, 1,000 boxes on St Helens, 11 broken meshes). Missing: rays and shape casts against a mesh (job
    6), a mesh against a mesh, any browser run of a mesh scene beyond the replay's hash, and speed parity: the build is
    65 ms against Rapier's 43 ms and a step of the box pile 1.52 ms median against 1.14 (`docs/limits.md`), for batch 129.

36. The own physics kernel's height fields (batch 126 job 3, `kernel/src/mesh.rs` `end_grid`): a field's triangles and
    neighbours are checked against the same cells held as triangle rows and joined by corner position, and its contacts
    against them bit for bit on 48 drops of boxes, balls and capsules with the edge rule on and off
    (`kernel/tests/mesh.rs`); its layout against Rapier 0.21 by 300 rays through the root entry
    (`tests/next-heightfield.test.js`); the physics-refs heightfield scenes pass in Node (flat slides, 1,000 balls on St
    Helens). Missing: rays and shape casts against a field (job 6), a field against a mesh, Rapier's per-cell status, any
    browser run beyond the replay's hash, and speed parity on the 499,849-cell build (16.3 ms against 8.6), batch 129.

37. The own physics kernel's compound colliders (batch 126 job 4, `kernel/src/compound.rs`): children are collider rows
    off the broad phase with fat boxes the broad phase writes, and a compound pair holds a part per touching child, child
    pair or child and triangle (PAIR_PART and the new PAIR_SUB column). Proved: mass the same bits as the parts as
    colliders, rest, one pair, mesh contact, stacking, empty gaps, sensors and row reuse (`kernel/tests/compound.rs`);
    mass, centre, inertia and rest against Rapier 0.21 (`tests/next-compound.test.js`). Fixed with it: removing a
    collider now wakes what touched it (`kernel/tests/sleep.rs`), as Rapier does. Missing: cylinder and cone parts, rays
    and casts, a tree over many children, and any browser run beyond the replay's hash.

38. Stable instance rows with changed-row uploads and `Engine.writePoses` (2026-11-07) are proved by deterministic counts
    (`tests/core-instance-cache.test.js`, `tests/core-write-poses.test.js`, `packages/physics/tests/next-sync.test.js`)
    and pixels: on Edge 157, which has no committed profile, `npm run visual:check` passed all 81 views against a local
    profile captured from the commit before them (4 runs, not committed), and `npm run visual:compat` failed only on
    `boulder` and `khronos-LightsPunctualLamp`, with the same numbers before them (`docs/known-bugs.md`). Missing: a timed run (the machines were busy; the
    plan is `bench parity boxes-10000` with culling on, and an orbit of 50,000 CAD parts), and the cost of a frame where
    several cameras view one scene.
39. Voxel GPU meshing (`@margoengine/voxel/gpu-mesher`, compute shaders writing `meshChunk`'s quad format) is proved on the M6 Mac
    mini (Metal) only: every chunk of a lit test terrain and five special chunks gives `meshChunk`'s words exactly, before
    and after a large edit, and a `VoxelRenderer` with it draws the worker mesher's picture pixel for pixel. The faces
    kernel finishes each slice's greedy merge in one invocation per workgroup (192 per chunk), so a dispatch is bounded by
    that serial scan; slabs and stairs stay on the CPU path. Timings in the check are diagnostic, one machine.
40. The own physics kernel's voxel grids (batch 126 job 5, `kernel/src/voxel.rs`): a mesh row flagged MESH_VOXELS, a new
    row class of VOXEL_WORD (four cells a word, a byte each: filled and six neighbour bits) and VOXEL_ columns on the mesh
    row, so ROW_CLASSES is 19 and the world's bytes, not its poses, changed. Contacts are cell boxes through the convex
    routines, a part per cell, with Catto's ghost rule on exposed faces. Proved: `kernel/tests/voxel.rs` (five tests
    fail with the rule switched off) and `tests/next-voxels.test.js` against Rapier 0.21. Missing: a tree
    or run-length walk for very large grids, and any browser run beyond the replay's hash.
41. `render_snippet` (`@margoengine/mcp/render`, `packages/mcp/tests/render-gpu-check.mjs`, in `test:gpu`) is proved on the
    RTX A6000 (Windows, D3D12 through `webgpu` 0.6.2) only: a box drawn and fitted shows green in the centre and an
    empty snippet one colour. Missing: Metal and Vulkan runs, a software adapter, and the cost of a render per call.
42. Smooth voxel terrain (`@margoengine/voxel/smooth`, Surface Nets over signed densities, drawn as core meshes) is proved on the M6 Mac
    mini (Metal) only: a ball meshes closed and wound outward, split over eight chunks it gives the same triangles with no
    seam, and sculpting re-meshes only the chunks that read the changed cells. Meshing runs on the page thread; speed and
    memory at large view distances, LOD, textures and collision with `@margoengine/voxel/physics` are not built or measured.
43. Voxel bounce light and soft sun shadows (`@margoengine/voxel/gi`, rays traced in WebGPU compute through the world's opaque blocks) are proved on
    the M6 Mac mini (Metal) only, in one scene: a white floor beside a sunlit red wall turns red and a one-block pole casts
    a soft shadow the renderer alone does not draw. Frame cost, other scenes, multi-bounce and sky light are not measured or built.
44. The own physics kernel's rays (batch 126, queries job, `kernel/src/query.rs`, exports `query_ray`, `query_ray_all`
    and `query_buffer`): no new columns, so the world's bytes and poses are as before; hits go through a static buffer
    of 256, paged by `raycastAll`. Convex shapes by intervals (ball and capsule side in the precise forms of Ray Tracing
    Gems ch. 7), meshes by their tree, height fields and voxel grids by cell walks. Proved: `kernel/tests/query.rs`
    (closed forms, each walk against brute force, f64 references for far and grazing rays; mutations of the walks fail
    it) and `tests/next-queries.test.js` against Rapier 0.21. Missing: a tree over colliders for the world ray (each
    collider is tested) and any browser run; shape casts and point queries are item 46.
45. Tonemap's grading, custom curves, metering modes and local exposure (`@margoengine/tonemap`, `/grade`, `/custom`,
    `/local`) are proved against CPU oracles of their maths on the M6 Mac mini (Metal) only, on synthetic sources and
    simple lit scenes; GPU time of the new passes, other GPUs and photographed HDR scenes are not measured.
46. The own physics kernel's shape casts, point projections and overlaps (batch 126, queries job, `kernel/src/cast.rs`,
    exports `query_shape_cast`, `query_shape_cast_all`, `query_project_point`, `query_project_point_all`,
    `query_point_all` and `query_shape_all`): no new columns, so the world's bytes and poses
    are as before; hits go through the static query buffer, paged. A cast is van den Bergen's GJK ray cast (2004,
    Algorithm 3), then his closest-point steps from a lower bound on the gap, so a hit is never stepped past; meshes,
    height fields and voxel grids share one walk (`each_part`) with overlaps and projections. Proved:
    `kernel/tests/cast.rs` (closed forms, bisected GJK distance, walks against brute force, the stop options) and
    `tests/next-shape-queries.test.js` against Rapier 0.21 and an exact f64 reference of the Minkowski difference.
    Missing: a tree over colliders (each collider is tested), mesh, height field, voxel and compound query shapes,
    and any browser run. Rapier faults found are in docs/rapier-parity.md Q-07 and Q-09.
47. The own physics kernel's continuous collision (batch 126, CCD job, `kernel/src/ccd.rs`, `World::ccd_pass`
    after the substeps and before the events): two bits of the body flags, `CCD` (1 << 13) and `CCD_ACTIVE`
    (1 << 14), no new columns, so the world's bytes and every pose without CCD are as before (replay hashes
    unchanged). A CCD body that moved further than it is thick is swept by conservative advancement (Mirtich
    1996; Catto 2013) on a lower bound of the gap, so the time found is never past a touch, and put back there
    with its velocity kept, or carried by the kinematic or non-CCD body it met for the rest of the step. A part
    touching at the step's start holds the body no deeper than half its thickness instead of reading as a touch
    at time 0: the drafted rule froze a fast ball sliding on a floor and let a wall that carried a bullet pass
    it, and both have regression tests. Proved: `kernel/tests/ccd.rs` and `tests/next-ccd.test.js` (1,000
    bullets and moving walls, with Rapier 0.21's counts for the record). Missing: a tree over colliders for the sweep (it tests every fat box),
    Rapier's CCD substeps, smallest CCD step, soft CCD and CCD sensor events (batch 140.5), and any browser run.
48. The own physics kernel's cylinders and cones (batch 126, job 5, `kernel/src/revolve.rs`, `kernel/src/smooth.rs`,
    `SHAPE_CYLINDER` 6 and `SHAPE_CONE` 7, size A radius, B half height, C border): no new columns. GJK numerics changed
    for every shape: a needle simplex's area vectors come from its two shorter edges (Kahan 2014) and its plane
    offsets and volumes from the vertex nearest the origin; the closest point is the projection point itself, not
    the lambda-weighted sum, whose error floor (van den Bergen 2004, sec. 4.3) stalled GJK on curved shapes; the
    distance keeps its search vector `v`, and contact and cast normals now use it (on_a minus on_b was up to 0.30 rad
    off near a touch). A sharp cone's ray is solved from the point of the line nearest its centre (Haines et al.
    2019): a far start had cancelled to 6.7e-3 m at 107 m. Replay hashes regenerated (native and Wasm agree).
    Proved: `kernel/tests/gjk.rs` (needle simplex, small gap between curved shapes), `kernel/tests/revolve.rs`,
    `kernel/tests/cast.rs` and `tests/next-revolved.test.js` against Rapier 0.21 and an exact f64 surface.
    Missing: round boxes, triangles and hulls (S-10b, batch 139.2), and any browser run.
49. The own physics kernel's eighth-rate spring for movable pairs at one pass a substep (2026-11-08, `CHAIN_LOAD` in
    `kernel/src/solver.rs`): proved natively (`kernel/tests/solver.rs`, both pyramids, sleeping on and off; `examples/bars.rs`)
    and in Node through the physics-refs harness at both settings, where every scene but the piles and the stacks' first
    steps reads bit for bit as before (the stacks' sag moves 0.003 mm). Missing: a browser run of a one-pass scene, as the
    replay keeps the default 2 passes, and a pile deeper than 30 rows, whose bottom pairs pass the 50 times bound.
50. Voxel-edit shader brushes (`@margoengine/voxel-edit/shaders`, batch 97): user WGSL `fn brush(p, value)` compiled
    after a fixed prelude into one compute pass per brush pass; a grid is packed four cells to a u32 word, one
    invocation per word, ping-pong buffers, an explicit bind group layout (a brush may leave the tool, table and
    selection bindings unused) and the shader module checked inside a validation error scope so a broken brush names
    its line instead of raising a device error. Proved on the M6 Mac mini (Metal) by `shaders-browser-check.mjs`: the
    grow and erode presets equal `dilateGrid` and `erodeGrid` cell for cell, over 1 and 3 passes and on a 256-cubed
    grid (16.7 million cells), and a tool grid through a lookup table equals `combineGrids` union. Missing: any other
    GPU; grids past one storage binding (the device limit) are refused, not split.
51. The 2D kernel's coherent contact ids (2026-11-08, `physics2d/kernel/src/manifold.rs` `collide_coherent`): proved
    natively only (`kernel/tests/manifold.rs`, a box rocking through level keeps every id; `kernel/tests/world.rs`, the
    100-row pyramid drops 731 mm by 5 s with at most 6 points a step losing their warm start after 1 s, against 1,441
    without the kept face). Missing: a Wasm or browser run (the 2D kernel has no Wasm build yet), and the references'
    per-row sag is compared by a probe outside the repository, not by a test.
52. The 2D kernel's compact solver bodies (2026-11-08, `physics2d/kernel/src/solver.rs`): proved bit for bit natively
    (`kernel/tests/bits.rs`, three scenes and their counts pinned before the change) and by sizes; the paired step time
    did not move beyond the spread. Missing: the colouring and four-lane solve that the layout is for, and a Wasm run.
53. The 2D kernel's colour order (2026-11-08, `physics/kernel-common/src/colour.rs`, `physics2d/kernel/src/solver.rs`):
    proved natively (`kernel/tests/common.rs`, random graphs: no colour holds two contacts that write one body, every
    contact once, key order inside a colour; `kernel/tests/world.rs`, the 20-row pyramid built top down rests as one
    built bottom up). The order (height top first, colours visited backward) was chosen by measurement over pyramids of
    10 to 40 rows, not derived. Missing: the four-lane solve, a Wasm run, and scenes other than piles for the order.
54. The 2D kernel's four-lane contact solve (2026-11-08, `physics/kernel-common/src/lanes.rs`,
    `physics2d/kernel/src/solver/wide.rs`): proved natively bit for bit against the one-at-a-time solve on three pinned
    scenes and their counts (`kernel/tests/bits.rs`), and lane by lane against scalar operations
    (`kernel/tests/common.rs`); paired time in perf history entry 87. The Wasm simd128 path type-checks but has not
    run: the 2D kernel has no Wasm build yet (no allocator). Missing: a Wasm run and a browser timing.
55. Voxel-edit GPU bulk edits (`@margoengine/voxel-edit/gpu`, batch 97): `GpuGrid` keeps a grid resident in the shader
    brushes' packed ping-pong buffers, so fills, booleans, morphology, smoothing, palette remaps and user brushes queue
    compute passes back to back and the grid is read back once. Fill, combine and remap are fixed brushes on the same
    prelude (box, sphere by whole-cell squared distance, tool lookup), so every operation is exact integer work.
    Proved on the M6 Mac mini (Metal) by `gpu-browser-check.mjs`: a chain of a box fill, a sphere erase, a union with
    a palette map, a subtract, two dilations, an erosion and a smoothing pass equals the same CPU chain cell for cell
    on 37 x 29 x 41 and on a 256-cubed grid (16.7 million cells), clipped counts included. Missing: any other GPU;
    grids past one storage binding are refused, not split; the tool grid is uploaded per combine.

### Four-pair 2D narrow phase evidence (2026-11-08, section 5 addendum)

`physics2d/kernel/src/manifold/four.rs` groups four independent quad pairs per SIMD evaluation, including relative
transforms, ordered SAT, history-aware reference and incident selection, clipping and world-space placement. It
retains the exact scalar Quad distance path for apart cores, reusing placed vertices and SAT results. Fixed lane
extraction and an out-of-line scalar branch avoid duplicating distance code inside the Wasm batch function.
`world.rs` queues only awake non-chain quad contacts; other shapes, chains and short tails keep their existing
paths. Refresh uses original IDs and impulse mapping. No core/stage or shared kernel-common changes are involved.

Evidence now present: pinned native and Wasm hashes; whole-field reference comparisons for scene/random pairs,
permutations, histories, signed zero and large coordinates; mixed world queues and every tail; Edge WebGPU/WebGL2
and Firefox WebGL2 browser hashes. Firefox WebGPU has no adapter and is not claimed. The paired Wasm narrow probe
is 0.795 to 0.752 ms; the uninstrumented step 2.885 to 2.852 ms (17/24 rounds). This is a modest loaded-machine
result, not the 0.35 ms target. [Entry 92](../whitepaper/perf-history.md) and its committed result include the
discarded variants, every A/B round and the browser before/after table. Missing: a quiet rerun and proof of a large
narrow-phase gain. Solver setup and the remaining Box2D loss stay open; no physics work or tolerance was reduced.

### External video material evidence (batch 112)

`@margoengine/video/material` uses the existing optional MaterialFeature hooks, with no core or stage changes. Its GPU test compiles standard, physical, unlit, Lambert, Phong, toon, normal, depth, distance and matcap surfaces on the RTX A6000 at 1x and 4x MSAA; generated VideoFrames and a real HTMLVideoElement backed by a generated MediaStream return the expected sRGB colours within 2 of 255. Each draw imports an external texture, including after a media task changes the video. The test observes zero material-path frame uploads, and a real WebGL2 engine gets `unsupported` with a help link. `packages/video/test/material-check.mjs` is the package's `test:gpu`, discovered by check:gpu-packages. No movie decoder, browser-internal copy, speed, other GPU/browser or auxiliary-pass video-alpha evidence is claimed. See the video material limit in docs/limits.md.

### Page recording evidence (batch 112, section 5 addendum)

`@margoengine/video/record` uses canvas captureStream and MediaRecorder independently of rendering backends. Core/stage and GPU maths are unchanged. Its package GPU suite also runs `packages/video/test/record-check.mjs`: Edge on the real RTX A6000 records WebM and MP4 with audio from each of WebGPU and WebGL2, then uses the browser demuxer/video and audio decoders to check dimensions, colour, audible tone and ownership of caller tracks. Generated canvas colour and tone are stand-ins. Unit tests cover final-chunk ordering, repeated stop, cancellation, disposal, startup/recorder errors, empty results, ended audio and unsupported containers. Missing evidence: other players/browsers, real microphones, long captures and an A/V synchronization bound. The compressed file stays in memory; this is real-time capture with browser-selected codecs, not deterministic offline encoding. No speed claim. LIM-571, result `docs/whitepaper/results/video-record-20261108.json`.

### 360 video evidence (batch 112, section 5 addendum)

`@margoengine/video/360` adds a sphere UV remap over the existing external material feature and delegates XR spheres to XRLayers, without core/stage changes. `packages/video/test/panorama-check.mjs`, included in video's GPU suite, compiles mono and both stereo-eye shader variants on RTX A6000/Edge and checks six directions within 2 of 255; WebGL2 refuses binding with code/help link. `panorama.test.js` integrates the XR adapter with real XRLayers and a stand-in XRMediaBinding/session, verifying equirect creation, source packing, radius and disposal. No headset or real movie was run; projection on a headset, other GPUs/browsers and speed remain unmeasured. See LIM-573 and the committed panorama result.

### Exact 2D rectangle and preferred-face certificates (2026-11-08, section 5 addendum)

The current-data rectangle certificate replaces four-vertex scans on each of the same eight SAT axes with exact
support projections. The distance certificate proves the old first preferred face succeeds for every original
rounded distance in a conservative interval. It never substitutes an estimated distance into output or fallback.
The private current SAT metadata omits repeated range scans; uncertified lanes and scalar calls keep complete
guards. [Proof](physics2d-manifold-proof.md) includes the 14uM coordinate /22uM norm bounds, absolute subnormal
error, public-array mutation, signed-zero comparisons and the three monotone acceptance checks.

Evidence: 20,384,784 scene, 2,400,000 randomized and 58,560 added boundary/mutation comparisons, zero differences;
unchanged scalar/SIMD/native/Wasm pins; Edge WebGPU/WebGL2 and Firefox WebGL2 bits. In 40 timed-window frames,
102,862 certificates avoid at least 3,030,990 squared-distance candidates after accounting for all attempted
upper bounds. A/B minima 3.0449â†’2.9581 ms, 11/24 wins, do not establish a stable speed gain. Firefox WebGPU and
quiet-machine timing remain missing. [Entry 101](../whitepaper/perf-history.md) includes browser losses and raw data.

The block solver remains unchanged. [Solver study](physics2d-solver-study.md) records failed setup and per-point
alternatives with all old bars retained and zero accepted hash re-pins. A new 1:1000 contact diagnostic exposes
the old recovery-bias support ceiling; it is distinct from the passing 1000:1 joint chain. Owned-2D CCD is missing,
not proved by speculation. Both acceptance gaps and the separate raw-density defect are tracked in known-bugs.

### Owned-2D input and absent-candidate checks (2026-11-08, section 5 addendum)

The raw `physics2d/kernel` World, collision, smooth-collision and bounds entry points return coded
`PhysicsError` results with a help link to [Own 2D input validation](../limits.md#own-2d-input-validation).
Body, shape and whole-chain creation validate before publication; chain proxies are staged until all segments
and mass updates succeed. The checked mass path retains the existing valid arithmetic and distinguishes
genuine zero mass/area from positive mass or inertia rounded to zero. Nonfinite derived centres, moments,
extents and required reciprocals are refused. Public `mass_of` remains a direct utility, not this checked boundary.
The reciprocal-metric check also prevents a finite rounded inverse from overflowing on reinversion. Both rounded
centre and origin are staged; shape ownership uses a linear visitation witness. Overflow-only friction mixing
uses a scale-safe mean with the ordinary finite-product bits retained. Dynamic scalar/SIMD clamp bounds propagate
invalid arithmetic to the checked step error instead of a Rust assertion; used negative normal caches are refused.

Before stepping, current public body/shape/contact/joint arrays and handles are checked, including used core
data, materials, chain ghosts and cached numerical state. Broad callbacks check stale shape IDs. Collision
also checks absent face/distance candidates before indexing. This matters on both native and aborting Wasm:
the reproduced `47f81f909` panic used a NaN pose together with a NaN cutoff; the literal finite-cutoff review
call returned empty here. It is now a coded refusal rather than a sentinel index or invented manifold.

The public Rust `solver::solve` entry shares the current-data preflight and final solver-output check.
The bf40 baseline let direct callers bypass `World::step` and panic by setting a manifold count to three;
`tests/solver_input.rs` covers that boundary and related handles, ownership, numeric domains and recovery.
`World::step` calls a private already-checked solver entry, preserving its single preflight, post-solve
check and separate post-sleep check. No physical equation, result pin or hot-step scan is changed.

Regression coverage is in `kernel/tests/input.rs`, `manifold_exact.rs`, `manifold.rs`, native unit checks and the
existing Wasm `check(i)` invalid-input checks. Two creation assertions copied unchanged into an isolated
`47f81f909` tree fail as expected (`.lane/p/input-baseline.log`); the current checked versions exercise rollback
and coded errors. Retained-reference tests and the three valid production hashes remain the compatibility
contract; the reference, scene, tolerance and hashes are not re-pinned. Final package/repository gate execution
is recorded separately at landing, not asserted by this addendum.

The final independent input audit also found squared-length rotation overflow/underflow, hidden nonfinite
integration and contact-metric sums overflowing despite finite individual inverse masses. Scale-safe exceptional
rotation normalization preserves the ordinary operation order, while zero stored rotations and unrepresentable
derived contact metrics are refused. `rotation_input.rs` and `contact_metric_input.rs` reproduce these failures
on the retained pre-edge input implementation; the same classes run in Wasm's existing checks. The rotation
regression uses one substep so zero/identity alternation cannot hide the failure.
`point_velocity_input.rs` additionally exercises overflow of `v + w cross r` with finite body velocities,
mass and contact metrics. The row builder checks relative point velocity, approach and base before publication,
so a NaN comparison cannot silently select a zero normal impulse. This class also runs in Wasm input checks.

The input correctness change does not alter solver formulation or prove a speed gain. The following separate
support correction establishes the required 1:1000 centered contact bar. Owned-2D CCD belongs to T-11 / 127.y; the existing 1000:1
joint-chain and separate 3D CCD tests do not establish it. An arithmetic error after simulation starts is
reported without claiming rollback of the complete step. The TypeScript Rapier facade is unchanged.

### Video frame decoding evidence (batch 112, section 5 addendum)

The optional `video/codecs` path owns MP4 demuxing and WebCodecs decode/flush lifecycle outside core/stage. Its unit tests cover decode versus presentation order, signed offsets, chunk runs, 64-bit offsets, edit timeline boundary regression, bounds, cancellation, exclusivity and caller-owned frames. The video GPU suite now includes `codecs-check.mjs`: real Edge/RTX A6000 decoding of a generated MP4, random frame access with exact timestamps, seek/step, cancellation and consumption on WebGPU/beside WebGL2. GOP decoding is renderer independent; external material binding still refuses WebGL2. Evidence is a stand-in; real B-frame files, third-party movies, other hardware/browsers and speed unmeasured. Supported container scope and memory limits are in LIM-575 and limits.md. No new open engine defect; known-bugs.md unchanged.

### Video alpha evidence (batch 112, section 5 addendum)

The optional `video/alpha` entry extends only the external material sample hook, before the colour-pass alpha test and lighting. No core/stage edit, extra texture upload or auxiliary-pass claim. `alpha-check.mjs` in video's GPU suite compiles both packing variants and keying, checks alpha 0/64/128/255 against source-over in the existing direct canvas output space, a fractional key edge, a cutout, and WebGL2 coded refusal. Generated sources are stand-ins on real RTX A6000/Edge. Unit regressions guard sparse colour tuples, float32-collapsed key intervals and packed dimensions, with unchanged numeric tolerances. Harness corrections read the final canvas in its render task (before presentation clears it), and use the direct material's documented encoding before blend. No real keyed movie, other GPU/browser, quality comparison or speed evidence. See LIM-578. No new open engine defect from this batch; other lanes' known-bugs entries remain intact.

### Mixer sidechain acceptance (batch 111, section 5 evidence)

The optional sidechain entry owns a two-input audio-thread detector, independent of the rendering
backend. Root mixer, core and stage remain unchanged. Generated OfflineAudioContext renders test
known attack, attenuation, recovery, key isolation and linked channels beside real WebGPU and WebGL2
contexts in Edge. Node processor stand-ins additionally prove hold across blocks, missing inputs,
zero times, shared registration, cancellation and idempotent disposal. Module loading is abortable
and CSP/unsupported failures are coded. Real speech, other browsers and timing remain unmeasured.
LIM-583 and the committed sidechain result identify the present evidence.

### Mixer snapshots (batch 111): section 5 evidence

Snapshots reuse existing bus ramps and native effect AudioParams, entirely in the optional entry.
Generated audio checks underwater filtering, fades and restoration beside both rendering backends;
Node tests check JSON silence, endpoint blending, matching layouts and atomic refusal of malformed
states, unsafe feedback and changed chains. No core/stage or GPU maths change. LIM-586.

### Mixer exact dynamics (batch 111): section 5 evidence

The optional entry owns compression and 11-sample lookahead, using a mathematical absolute-FIR
bound so changing gains cannot create an inter-sample overshoot in the specified ITU model.
[Proof](mixer-true-peak.md) states the conservative attenuation trade-off. Real Edge AudioWorklet
renders pass beside WebGPU/WebGL2; Node tests check independent convolution, static curves,
attack recurrence, linked channels, tails and adversarial ceilings across render quantum sizes.
The browser fixture now awaits rendering before leaving its using scope. No core/stage/GPU maths
change. Real recordings, other browsers, perceptual quality and timing remain unmeasured. LIM-589.
Both worklet factories also check cancellation at the post-registration allocation boundary.
Microtask-order regressions fail before the fix and confirm no node allocation after an abort.

### Mixer early reflections (batch 111): section 5 evidence

The optional entry combines first-order image-source geometry with the existing synthetic tail
and ConvolverNode; no core/stage or rendering maths change. Closed-form six-wall symmetry,
fractional tap placement, stereo paths, seed repeatability and malformed geometry have Node
coverage. A real Edge convolution matches the computed stereo IR beside WebGPU and WebGL2,
including early arrivals before the late tail. Geometry is static and first-order; no measured
room, binaural-head model, other-browser or performance evidence. LIM-591.

### Own 2D sustained support (batch 127, section 5 evidence)

The old 3 m/s penetration-bias clamp imposed a spring-force ceiling near 995 kg. The corrected monotone NCP
caps beta*s+C*lambda, preserving the original static spring root at every feasible representable load for P>0.
Scalar/f64 active-set fallbacks handle exceptional capped arithmetic; certified common lanes retain SIMD.
Per-visit shadow tests compare all live motion/cache/pushed/count results with the scalar reference.

The remaining mass-ratio settling mode is corrected on certified supported paths each substep before pose
integration, using current-J geometry and separate step-start-J physical projection. No mass freezing, cap
increase, fitted mass-ratio threshold, changed stiffness or loosened physical assertion. Immutable original
approach evidence prevents disconnected joint passes from changing domain decisions. Proposals stage all
body/contact/friction state, then commit atomically only after the domain and residual certificates hold.
Actual substep movement feeds the unchanged sleep policy.

Evidence includes the unchanged native 1:1000 regression red on 47f81f909, all 29 physical cases, cap/path numerical
units, full input/domain regressions, per-visit SIMD proof, creation/order/load/domain transitions, and the
disconnected-joint regression. The mixed hash is intentionally re-pinned 9acb68471fbe6ba0 -> 92db6847c4e919d4;
the other two pins and retained manifold reference remain. Final repository/Wasm/browser gates accompany
landing. Wasm `check(0)` also applies the identical two contact-stack bars; native scalar/SIMD and shipped
Wasm SIMD metrics agree. CCD remains separate T-11 / 127.y.

The [sourced derivation](physics2d-support-proof.md) states the method domain and work costs. The independently
verified negative bending tangent of the preserved soft law is a [constitutive limit](physics2d-support-bending.md),
not permission to relax centered axial bars or a claim of exact discrete collapse. Supported components still
allocate local buffers and compute two banded systems; no speed-success or allocation-free claim is made.

### Mixer loudness (batch 111): section 5 evidence

The optional CPU entry owns double-precision K filters, weighted 10 ms energies, 400 ms/3 s
window histories, two-stage integrated gating and copied PCM gain normalisation. No core/stage
or backend math change. Generated EBU cases 1/2 use the prescribed 20 s duration and 0.1 LU bars;
all twenty file offsets in cases 10/13 check window alignment. Node coverage includes rate
profiles, absolute/relative gates, gain covariance, 5.1 surround weight and LFE exclusion,
silence/short inputs, immutable PCM and true-peak-capped outcomes. Real Edge audio renders are
measured/normalised beside both renderers. No downloaded corpus, authentic programme, LRA,
live-meter, other-browser, certification or timing claim. LIM-596.
Mixer docs.test.js now measures every current mixer entry and compares its public bytes/budget
with the built entry and shared size baseline. It fails on stale public numbers after a size-ratchet
shrink, and runs in verify/check:merge through the package unit suite. No budget is raised.
The closing batch also fixes fail-atomic numeric scheduling in the existing mixer owner, not core:
validate audio times, durations and float32 values before state changes or cancellation, and retain
active ducks on invalid release. mixer.test.js proves target/flag/envelope and complete automation
trace preservation, plus unchanged valid/default fades. Root grows 6,670 to 6,901 B and snapshots
1,700 to 1,810 B, within their existing budgets; no budget or accuracy/time bar is raised.

### Own 2D planner storage (batch 127, section 5 evidence)

The frame planner keeps flat adjacency, traversal, path and gap scratch buffers in its owning solver Scratch.
It rebuilds current contents in the original contact/component order. Floating expressions, domain decisions,
physical bars and all three corrected-baseline hashes remain unchanged. Retained capacity depends on maximum
body/contact counts; it does not accumulate each component ordinal's or body slot's historical largest buffer.
Lifecycle tests cover growth/shrink, multiple components, joint/kind/sleep/topology changes and a fresh-workspace
full-world comparison. Fixed-V/E migrating-hub/path tests catch the rejected nested-capacity design.

The native whole-step allocator example and committed raw diagnostic record prove fewer allocation requests
on the unchanged pyramid, with identical work counts and final state. Paired/browser measurements accompany
perf history entry 106; they establish neither a stable timing gain nor Box2D parity. The existing point-normal
replacement is rejected again on the full corrected 29-case contract. Local accepted-component allocations and
two banded factorizations remain, and owned-2D CCD remains separate T-11 / 127.y.

### Own 2D exact SIMD certificates (batch 127, section 5 evidence)

The normal solver drops only finite predicates implied by its actual K-derived matrix and impulse/sum
expressions. No stored masks or layout fields are added. The [IEEE proof](physics2d-finite-certificates.md)
states the caller contract, including why unrelated helper arguments would invalidate the reduction.
Raw-row/used-soft domains, mutable RHS/answer overflow, cap membership, post-motion and exact fallback/error
behavior remain. Directed finite/nonfinite mask controls, retained-guard cases, the existing per-visit shadow,
all 29 physical bars and current native/Wasm/browser pins provide evidence. No physical assertion or pin changes.

Shipped Wasm emits 14 fewer each of abs, comparison and mask-AND operations in the identified hot function,
with unchanged solver add/subtract/multiply/divide counts. These are static branch-inclusive inventories.
Decoded source-path/panic-data relocations explain distinct artifact hashes; timing independence from layout
is not claimed. Entry 107 records paired/browser diagnostics without a demonstrated gain or Box2D parity.

### Audio occlusion evidence (batch 110, section 5)

The optional audio/occlusion entry reuses BVH CPU segment queries and owns gain/low-pass stages in the sound's existing filter chain. It registers after the sound with AudioListener, so normal frame updates supply world positions before tracing. Dynamic BVH import keeps the audio root unchanged. Real Edge OfflineAudioContext renders of generated tones beside WebGPU, native WebGL2 and the WebGL2 compatibility device prove spectral attenuation (2 kHz ratio 0.039128; 100 Hz 0.249970) and zero GPU validation errors. occlusion.test.js covers real engine transforms with stand-in renderer/audio, partial cover, visibility, endpoint/source exclusions, vertical rays, smoothing, cancellation and teardown. Stand-in content only; diffraction, deforming geometry, listening quality, other browsers and speed remain unmeasured. See LIM-602 and results/audio-occlusion-20261108.json in the whitepaper.

### VFX shadows and nodes (batch 79): section 5 evidence

Sphere impostor depth, including a centre at clip depth 1.02 whose front is still in range, is checked against the orthographic formula within 1e-4 on WebGPU (`packages/vfx/test/features-check.mjs`, `checkShadowFar`) and on the WebGL2 layer (`packages/vfx/test/shadows-nodes-webgl2.mjs`). The same pages check the light header 2, 5, 3, depths 0.45005, 0.48770 and 1.00000, and the node particle at (0.18781, 0.04877, 0.00000) with velocity (0.90369, 0.38525, 0.00000). `checkNodeNorm` requires normalize of (1e-21, 0, 0) and (1e20, 0, 0) to be (1, 0, 0) within 1e-4 on both backends; mixed-component tiny and huge vectors and a zero vector are also checked. `checkShadowRelease` requires both dispose and device restoration during the light read-back to leave no unhandled rejection, and the shadows check requires the published list to be empty after dispose. Finite doubles that are not finite f32 are rejected in `checkNodeF32` on both backends. The full WebGL2 suite also checks velocity stretch: the visibility kernel keeps the patched simulation declarations and feature bindings with its cull expression, instead of losing the stretch uniform. Lit particles check weighted OIT on WebGL2, and require ExactOIT to reject that device with `unsupported` before shader creation; native WebGPU retains the exact-pass pixel check. `packages/oit/test/oit.test.js` covers WebGL2, native compatibility and explicit insufficient fragment-storage limits. These GPU checks run on an RTX A6000. Still missing: time on any GPU, and any GPU other than the RTX A6000.


### Batch 168 lightmap: section 5 evidence

The Cornell reference keeps all 15 surfaces present throughout the black-box Cycles bake. A lifecycle
regression prevents isolated-face bakes. Independent solid-angle quadrature calibrates the light units;
Margo output does not set that scale. The direct-light test checks physical irradiance separately.
The 881-texel MAE is 0.069543, relative 0.211475; coarse per-quad radiosity, sampling and quantization
remain limitations. No core, stage or rendering implementation changes, and no convergence claim.


### Batch 168 OIT: section 5 evidence

An exact primary-ray coverage oracle now checks the external depth-peeling and own weighted pictures.
Background and single-layer error are zero. Default weighted blending has MAE 1.567519 (max 15 bytes),
versus depth peeling 0.048151. A binary palette isolates ordering from material display encoding;
the separate display-domain blending defect remains in known-bugs. No runtime/core/stage changes.
Seven alternating frame-plus-completion rounds are diagnostic only, with the readback asymmetry documented.


### Batch 168 sky: section 5 evidence

The shipped Preetham WGSL is evaluated directly before the display transform and compared with external
Mitsuba sunsky. Unit-direction, axis conversion, zenith normalization and error-metric tests accompany
297 samples over nine cases. Normalized RGB MAE 1.439228 remains an open loss. Separate physical units,
the sun disk and hemisphere integration are not covered. No rendering implementation/core/stage changes.

### Audio Doppler evidence (batch 110, section 5)

The optional audio/doppler controller registers after its positional sound and samples sound/listener world poses against context.currentTime. It owns the existing playback-rate control; no renderer or core change. Real browser generated-tone PCM frequency checks run beside native WebGPU, native WebGL2 and the compatibility device, with zero GPU validation errors. LIM-603 and whitepaper/results/audio-doppler-20261108.json record stand-in evidence. No recording, listening-quality, other-browser or performance proof. Reset explicitly for teleports; 0.95 radial Mach clamp is an approximation limit, not a supersonic claim.


### Batch 168 staging: section 5 evidence

The default contact cue now has a numerical comparison with cosine ray-traced ground occlusion.
The tracer agrees with the independent projected-solid-angle integral; blank renders fail explicit
caster/background/shadow checks. Across 15,472 exposed-ground pixels the darkness MAE is 0.048174.
The fixed-blur nearness field does not reproduce broad hemispherical occlusion; the loss remains open.
No runtime/core/stage changes and no speed or directional-light parity claim.


### Batch 168 closing path-tracer evidence

Cycles independently path-traces the same OIT emission/coverage scene. Its exact-oracle MAE is 0.094812
with identical centre RGB; Margo/Babylon MAE against it is 1.632960/0.132651. Residual path noise and
silhouette sampling limit full-frame PSNR. This is independent confirmation of the open weighted image
loss, with no runtime changes or added timing claim. Root scripts reproduce the comparison outside the repo.

### Audio event container evidence (batch 110, section 5)

Optional audio/events layers selection and variation over existing AudioVoicePool. Listener-owned teardown releases every pool; the container has no frame work or timers. LIM-605 and whitepaper/results/audio-events-20261108.json record real browser PCM generated-tone evidence beside WebGPU, native WebGL2 and compatibility WebGL2. Pitch, gain, sequence/random selection and silent cooldown gaps are measured with zero GPU errors. No renderer/core changes; recordings, listening quality, other browsers and speed remain unmeasured.

The event job also repairs AudioVoicePool input ordering: invalid per-play input is rejected before a free or stolen voice changes. Sparse position/range arrays are checked by explicit components, since Array.every skips holes. Focused before/after regressions in audio.test.js and events.test.js prove preserved sounding sources and rejected missing values.

### Own 2D frame preparation (batch 127, section 5 evidence)

Broad refits use a private derived-bounds helper only after complete current body/shape ownership and
numeric preflight in the same step. Public/creation bounds keep core-then-pose validation; transformed
or expanded bounds still refuse overflow. No validity certificate crosses a mutation or frame.
Support eligibility now uses lazy conjunctions after component invalidity, with every DFS/visited/member/
terminal operation retained. Eager-control traces and accepted Plan bits, malformed-input regressions,
all 29 physical bars and current native/Wasm/browser pins remain required.

The [proof](physics2d-frame-preparation.md) separates actual predicate-call counts, uninstrumented release
control flow and branch-inclusive compiler inventories. The matched 17-phase profile includes exact
per-step state/work fingerprints, 39-clock calibration/residuals, original harness failure and a portable
source-only reproducer. At 99.29% aggregate CPU busy its phase shares guide investigation; absolute times
are not substituted for the separate rival benchmark. Entry 112 records the combined bounded paired/browser
session; neither constituent receives an independently measured timing claim. No core/stage change or CCD.

### Creative texture targets (batch 77): section 5 evidence

The optional targets entry records color-only passes into cube faces, array layers, mips and volume slices.
It uses single-mip 2D attachment views for cube/array and a 3D view with depthSlice for volumes, per W3C WebGPU.
No core or stage changes. Unit checks reject invalid dimensions, memory, mips, layers and colors before recording.
Real WebGPU full texel readback covers 78 generated subresources across rgba8unorm/rgba16float, partial draws
with load, shrinking volume mips, explicit device loss and redraw on a replacement device. A real native WebGL2
engine gets unsupported with help link. Reproduce with packages/creative/scripts/test-targets.js under gpu-lock.
No scene capture, depth, MSAA, automatic mip generation, other-device or speed proof. Entry 4027 B gzip.

### Adaptive music evidence (batch 110, section 5)

Audio/music owns one source per stem and one mixer bus per source; mixer scheduling handles all state gain changes. Audio-clock grid and common starts/loopEnd preserve phase without frame timers. LIM-607 and whitepaper/results/audio-music-20261108.json record generated-stem sample-reference PCM beside WebGPU, native WebGL2 and compatibility WebGL2. Error below 5e-8 and zero GPU errors; Node tests cover restart, validation and listener teardown. No core/stage changes or speed claim; recordings and listening quality remain unmeasured.

### Reverb-zone evidence (batch 110, section 5)

Audio/zones routes additional wet sends to existing mixer/reflections effects and fades their inputs, so previous convolution tails remain intact while dry paths stay independent. Listener frame updates select copied AABBs; convolution topology is prepared once. LIM-608 and whitepaper/results/audio-zones-20261108.json record generated-impulse PCM against existing response sums beside WebGPU, native WebGL2 and compatibility WebGL2, within 1e-6 and zero GPU errors. No core/stage changes or speed claim. Real room recordings, listening quality and other browsers remain unmeasured.

### Ambisonic-bed evidence (batch 110, section 5)

Audio/ambisonics keeps four components discrete through a splitter and eight gain paths into two virtual cardioids, rotating decoder directions by listener pose and inverse field quaternion. No renderer/core/stage changes, worklet or convolution. LIM-610 and whitepaper/results/audio-ambisonics-20261108.json record real browser sample-reference PCM beside WebGPU, native WebGL2 and compatibility WebGL2, including generated looping components plus decoding/resampling of a licensed external rain stimulus. CPU tests additionally cover full orientation bases and lifecycle. Real headset tracking, HRTF localization, subjective quality and speed remain unmeasured.

### WFC unary output constraints (batch 69)

Overlapping pins/ground remove incompatible pattern domains at every covering origin before search. Initial bans are below all decision trail marks; retries rebuild them. Section 5 evidence: generated binary/maze Node tests and the wfc browser check on real WebGPU and WebGL2 contexts. No GPU maths, shaders or device capability requirement; no authored-level, cross-vendor or timing evidence yet.

### Scatter interaction input proof (batch 77 audit, section 5)

Interaction uploads now reject nonrepresentable GPU floats and sparse positions before modifying retained state.
Cell displacement is clamped at the field side before Int32 conversion: larger moves have no overlap and must clear
old pushes. All three interact-inputs.test.js regressions fail on the parent and pass with the fix. The existing
real-GPU interaction suite additionally asserts every field cell is zero after a 2^32-cell teleport. Its existing
stamp/recovery/pixel checks remain unchanged. The test is already part of the scatter GPU plan; the new unit file is
picked up by verify and check:merge. A scaled norm fixes squared-length overflow; two finite extreme GPU cases
(offset 1e30/radius 2e30 and nearby offset/radius 2e38) match the CPU reference for every cell within the existing 1e-5
bound. The usual 143 pressed cells match within 1.63e-7 on RTX A6000. Native WebGL2 is exercised and refused with a
coded unsupported error and help link. A CPU resource stand-in checks restoration and terminal disposal. Core/stage
are unchanged; no speed claim.

### Wasm policy diagnostics (2026-11-09)

The shared loader translates policy-blocked compilation through the shared error helper. Core transform compilation and instantiation, physics solver and Rust kernel loads, decoder initialization and encoder initialization preserve MargoError code `failed` and the CSP help link; decoder worker responses now carry their code back through the pool. The per-path `tests/csp.test.js` suites, `tests/deep-core-csp.test.js` and `tests/wasm-csp.test.js` run in verify and therefore check:merge. Evidence is simulated blocked compilation; browser-specific policy enforcement remains unproven by these tests. [CSP deployment requirements](../csp.md) include core transform-kernel compilation and worker response headers. No Rust ABI, GPU math or rendering behavior changes.

The approved core correction changes only `packages/core/src/kernel.ts`: core owns the transform-kernel compilation and instantiation, so an optional package cannot report its startup failure. Approval: Scott, "Yes approved", 2026-11-10. Core plus stage measures 23,797 B gzip with `npm run measure:size`, below 25,000 B.

Lighting2d height precision repair (2026-11-08): owned rgba16float accumulation precedes one target presentation. `frame-regressions.js` proves 100 individually sub-byte directional lights, in addition to format, resize, frame order and restoration checks. The historical height-repair checkpoint passed 148 pixel checks on RTX A6000 with no errors; the final suite evidence is below. Half-float blending retains its finite rounding precision; this is not a float32 accumulation claim.

Lighting2d spatial GI repair (2026-11-08): GPU compute builds each upper spatial/angular grid, retaining radiance and
transmittance. Per-child connectors implement Osborne/Sannikov appendix A before interpolation. Separate two-sided
surface fields ping-pong for each requested bounce, with current-frame resets. Explicit vec4-aligned light records
carry point/spot/directional and mask/layer/shadow data. New Node/GPU suites assert exact opaque darkness/energy,
all eight levels, distinct bounce orders, analytic circle angular measure (11 distances, <5% relative error),
and format/resize/removal/restore/dispose/reattach lifecycle. These suites extend lighting2d test:gpu, already a
check:merge GPU gate; there is no new bypass. Original GI fails 21 Node assertions and the GPU value checks.
Missing evidence: other GPUs, general scene convergence and performance. Surface patches/32-direction quadrature
are finite approximations, detailed in limits.md. The exact measured byte ceilings were approved by Scott on 2026-11-09 ("Approve new size"), with no headroom.

The GI angular merge additionally uses integer multiplication for direction counts, bilinear difference interpolation
and incremental angular means. This preserves a uniform unit field exactly for branching 2/3/5/7/8. Browser regressions
read every intermediate float32 cascade sample and assert the configured allocation sizes, not just the final pixels.
The first weighted-sum formulation failed these assertions (and the Node unit-field test at branching 7); no tolerance
was changed. The exported CPU class documentation omission caught by verify was corrected in source and its API quality
gate was checked again. Initial verification found the prior size ceilings and missing GI TSDoc; both were resolved,
with Scott approving the six exact measured ceilings on 2026-11-09. The first landing verify then found only the stale
generated `site/llms-full.txt` through the existing `tests/llms.test.js`. Canonical guide regeneration fixed the cause,
and the unchanged LLM, claims and umbrella regressions passed.

Full verification evidence (2026-11-09, main base `7bc32a1cb`): lint, hygiene and full verify passed. Full verify completed in 915.019 s under
its 2,400 s hard limit, including a 324.1 s global Node test chain. On that base the lighting2d package passed 99 Node tests,
236 RTX A6000/Edge GPU checks with zero wrong values or validation errors across 11 WGSL modules, and all 8 runnable
README examples. API reports were regenerated and checked. Cross-vendor rounding, general-scene convergence and speed
remain outside this evidence.

The subsequent rebase onto `571fb8d30` kept lighting2d source and tests identical; core/shared gained the CSP diagnostic
correction described above. Fresh integration checks passed the build, lint, hygiene, 165 Node tests with no skips
(including all 99 lighting2d tests, CSP and incoming regressions), and all 236 lighting2d GPU checks with zero wrong values
or validation errors across 11 WGSL modules. Full API update/check reports 99 packages, 856 entries and 8,525 exports;
all five quality gates pass, including 938 size items. All 8 README examples and generated LLM/claims/umbrella regressions pass;
the link check reports 208 documents with zero broken links. The full verify measurement above applies to the earlier `7bc32a1cb` base.

Batch 160 job 2 extends the outside picture evidence to all 27 ClearCoatTest primitives, including
factor/roughness textures and independent normal maps. All-pixel RGB error budgets are frozen on
WebGPU and actual compatibility WebGL2; native WebGL2 rejection is asserted. No core or GPU math
was changed. The full cause of the image loss remains unisolated in known-bugs. The 14 original
verify skips were missing assets, not hardware: docs/work-lists/batch-160-skips.md lists each;
external fixtures now run all 63 tests in the four affected files, with zero skips.

Job 2 verification also repairs the WFC browser harness's unbounded shutdown: closeAll now
covers startup and normal/failing assertions, with the existing repository-wide teardown
regression. The 14 missing-data skip conditions were all removed for the full verify run:
13,064 executed, zero skipped. A first-run stale-generated-doc failure is resolved by rebuilding
llms outputs from the authored source documentation.

### WFC global constraint evidence (batch 69)

The optional CPU constraints solver combines arc consistency, group lower/upper counts and possible-cell breadth-first reachability. Undo restores every ban from all propagators; a connected group is nonempty. Section 5 evidence: all 112 combinations of binary 3x2 count bounds, connectivity and corner paths agree with exhaustive 64-assignment truth; generated 3D and tile ID 256 cases, backtracking and browser WebGPU/WebGL2 parity also run. Logical authored traversability only, no physical-clearance or performance proof. Root WFC also rejects finite weights whose entropy arithmetic overflows, with a constructor regression.

Batch 160 job 3 extends outside evidence to all 20 SheenTestGrid primitives, at 512 x 512
with no IBL and a matched camera/sun. Both WebGPU and actual compatibility WebGL2 have frozen
all-pixel budgets; native WebGL2 rejects PBR. The sheen BRDF is shared by materials and
gltf-pro, but this picture measures default glTF import only. The unresolved image loss,
simplified visibility and albedo/roughness choices are recorded separately in known-bugs.
No core or shader math was changed and batch 168 measurements were not repeated.

### Scatter tile validation evidence (batch 77, section 5)

Tile rectangles are preflighted before replacing held pages; byte views need no word alignment. Node regressions
cover hostile conversion, collapsed bounds and atomic record/page storage. The generated grass clumps and records
in scatter/test/grass-tiles.browser.mjs are stand-ins on real RTX A6000 WebGPU: exactly one clump in each selected
near/middle/far ring, two after adding a tile, one after removal and restoration, zero after removing both. Ten
distinct shader modules compile without errors. Native WebGL2 refusal is exercised with a help link. Existing LOD
pixel/complementary fade tests remain the image proof; this new test asserts draw values, not artistic appearance.
No new core/stage API, shader algorithm or speed claim. Node tests enter check:merge via the package test glob.

Batch 77 review repairs: CPU ring needs now share the inclusive outer-limit rule with generated WGSL, retain the
uploaded f32 origin/side and convert the eye identically. A conservative distance bound covers placement and
distance rounding and squared-component flushing under the [WGSL accuracy rules](https://www.w3.org/TR/WGSL/#floating-point-accuracy).
`scatter/test/tiles-budget.test.js` enters verify and check:merge; the existing grass-tiles GPU step now covers
64 records at the exact far boundary, origin 16777217, the f32 control, camera conversion, rounded upper endpoints
and rounded distance, hard ring switches, fades, outside rejection and an explicit 32-instance cap. All five
allocation regressions fail on the parent. The recorded [before/after GPU counts](../whitepaper/results/scatter-tile-budget-20261109.json)
use generated records on RTX A6000 only. Ordinary Scatter and compatibility rings already reserve every candidate;
ordered compaction, shared rings, imposter and shadow capacities were also audited. No other allocation mismatch
was found. Optional tiles now measures 8,234 B minified / 3,401 B gzip within the unchanged 3,415 B budget.
Large-world throughput, other devices and artistic quality remain unmeasured.

### WFC rotation evidence (batch 69, section 5)

Optional CPU socket construction checks all 24 proper signed-axis transforms, independent face-normal mapping and a 48-ID 3D solve. Browser tests run the same seeded socket rules beside real WebGPU and WebGL2 contexts. No rendering/backend code changes. Labels are logical connectors, with no texture-orientation or imported-geometry proof.

### Audio camera orientation regression (section 5, 2026-11-09)

The listener copies camera.up as well as position/forward, so panner orientation follows camera roll and Top/Bottom views. Ambisonic beds retain their last independent orientation during a collinear manual pose, using -Z forward and +Y up initially. `packages/audio/tests/ambisonics.test.js` checks both exact poles, roll, finite initial/frozen decoder gains and continued updates of later sources. Browser offline PCM matrix proofs remain separate from live device evidence.

### Browser gate shutdown ownership (section 5, 2026-11-09)

Chromium checks use a loopback Playwright launchServer and a connected client. The owning server.kill API releases process and driver resources together; an external taskkill could end Chromium in 8 seconds while the launch client close promise stayed pending past the unchanged 30-second deadline. The WFC diagnostic now completes client disconnect and owned server termination. tests/browser-selection.test.js checks explicit ownership, loopback binding and bounded connection setup; existing browser-teardown/catalog tests retain process-death and teardown assertions. WFC resolves its server root from import.meta.url, disables unrelated optimizer discovery and watchers, unconfigures its test surface before destroying its device, and closes its browser/server together. The package GPU check exercises both backend routes from npm workspace execution.

### Batch 160 GPU teardown regression (section 5, 2026-11-09)

The material-suite shutdown uses the owned Chromium server repair in c1646e3ec. Native process termination alone did not settle the Playwright launch-client cleanup promise; it was driver ownership, rather than an outstanding BRDF readback or shader report. tests/browser-teardown.test.js now holds client cleanup pending until its owner kills the server, so the former external-termination path fails within a shortened test budget. The production shutdown limit remains 30,000 ms. The material GPU suite uses runSuite so teardown cannot replace a failed check; tests/gltf-pro-materials-lifecycle.test.js injects both failures and requires the original error plus a teardown diagnostic.

### Batch 99 emissive resampling: section 5 evidence

The optional `voxel-pathtracer/restir` subclass replaces only the emissive direct-light integral. Light proposals and cosine/phase directional proposals use balance weights in the same solid-angle measure. Visibility is in the reservoir target; continued non-delta paths do not count the same emitter integral again. Directional searches pass media, whose transmittance is then evaluated by the existing shadow walk. The endpoint is offset outside the source voxel to prevent self-occlusion. The root tracer now also retains the last scattering position for emissive and area-light MIS: transparent medium boundaries must not shorten the distance used to convert area PDFs to solid angle. Independent quadrature of a square light through an absorbing half-block slab guards this correction. Core and stage are unchanged.

`tests/restir.test.js` covers bounds, inherited identity, one-candidate source identity, disposal, replacement-device compilation and retention of helpers in the compatibility fragment route. `tests/restir-browser.mjs` retains the 2x squared-error bar against the fixed 8,192-sample reference, checks native WebGL2's coded refusal/help, and runs real device restoration. Native WebGPU and WebGL2 compatibility on RTX A6000 reduce the fixed ceiling scene's squared error from 2.884096 to 0.919089 at 32 samples, with zero shader compilation errors. This is independent RIS with full visibility per candidate, no spatial/temporal reuse and no measured wall-time benefit. Generated scenes are stand-ins, not outside reference images.

### Umbrella size drift check: section 5 evidence

The umbrella README now records the current core plus stage figure, 23,797 B gzip. `tests/umbrella-readme-size.test.js` compares its duplicate figure with the root README, so a future measurement update cannot leave the umbrella text stale. The existing `measure:size` gate supplies the actual measurement; this regression runs with the root tests in verify and check:merge. No runtime or size budget changes.

### Painterly post effects (batch 77): section 5 evidence

creative/paint is an optional LDR PostStack stage; no core/stage change. Single-pass WGSL implements classic
four-quadrant minimum RGB variance, a stylized quantized watercolour wash and a Sobel/hatching sketch. Neighbour
reads clamp to each viewport. Per-view uniforms prevent queue writes from overwriting earlier encoded views;
ViewStates prunes inactive resources. Pipeline keys include format and sample count; input changes rebuild bindings.
Real RTX A6000 WebGPU readbacks compare generated stand-in images to an independent double-precision CPU reference
using squared deviations, including radius endpoints, one-pixel images, hard edges, uneven split views, exact centre
alpha and bypass, BGRA and 4x MSAA. Real Engine/PostStack readbacks cover resize and replacement devices. Native
WebGL2 rejects with a code/help link. Shader compilation and uncaptured validation errors are checked. Node tests
cover hostile live edits before GPU writes, lifecycle, pruning and terminal restoration. No artistic quality,
temporal stability, speed, mobile or other-browser evidence. Entry 3073 B gzip, size class S.
### Asynchronous owned Chromium termination (section 5, 2026-11-09)

A later catalog after-hook hit the unchanged 30,000 ms shutdown bound with the owned launch server. Public Node child-process instrumentation then showed that BrowserServer.kill synchronously invokes Windows taskkill. That blocks the same event loop responsible for the deadline. The shared launcher now asynchronously ends the owned ChildProcess tree, observes its exit, then calls the driver kill API for server/profile cleanup while the client disconnects concurrently. No browser or process-handle wait is omitted. tests/browser-teardown.test.js adds failing-before controls for ordering and a never-settling termination while the deadline remains runnable. The trace of the original uninstrumented catalog timeout cannot identify which substep was pending; later zero-context traces showed prompt client disconnect and variable native exit. The demonstrated repair removes synchronous termination from the bounded path; it does not claim that every OS process exit can finish within 30 seconds.

### Audio review timing and lifecycle evidence (section 5, 2026-11-09)

Live Doppler uses monotonic frame time, resets on context state changes and treats gaps over 0.25 s or speeds over 0.95c as cuts. Offline derivative proofs retain the exact audio clock. Authored rate interception composes pool/event rates, including writes equal to the previous effective rate; controlled pools preflight invalid rates before stealing. Sound kind changes detach locally. Audio.isDisposed makes lifecycle explicit; occlusion detaches before BVH work and defers when its engine is absent/disposed. Node regressions are part of verify, and the existing package test:browser discovery puts live timing and long fractional-loop marker checks in check:merge. Retained audio-review-20261109.json separates live controlled clocks from offline PCM and unmeasured device output. The suspected music drift is not reproduced: every loop marker stays within 0.424 sample frames, including one virtual hour. No tempo or loop-period code was changed.

### Heartbeat gate startup evidence (section 5, 2026-11-09)

The slow-start heartbeat test now observes a marker from its injected worker preload, then a subsequent heartbeat. A file metadata change alone was not a startup acknowledgement: the failing 5.5-second run could not include both the Windows two-process injected startup and the unchanged four-second lease observation. A deterministic regression changes metadata before readiness and requires the helper to keep waiting. The production lock, two-second test lease, four-second observation and thirty-second readiness bound are unchanged. This strengthens the existing check:merge/verify gate rather than granting a timing waiver.

### Quiet crowd resume gate (section 5, 2026-11-09)

The 100-client zero-resend fixture now sends stationary controls and asserts the spawn column before cutting. VoxelBot.update always steers forward; using it made the supposedly quiet fixture stream new views, and a cut correctly resent 21 in-flight chunks. The new position guard fails with that original input driver. Client count, update cadence, 10-second resume bound and all zero-resend/identity assertions remain unchanged. Moving/in-flight recovery remains covered by the existing resume tests. No network implementation or throughput scene changed.

The voxel-net quickstart previously put Node server imports and browser Engine code in one executable block, so the runtime README gate externalized node:http. It now runs a complete Node server/client example on a free loopback port, with explicit shutdown; the obsolete known-failure entry is removed. All 19 audio/voxel-net examples execute successfully.

### SQL-store test ownership (section 5, 2026-11-09)

The voxel-net SQL restart fixture owns resources through a single reverse-order cleanup hook. A focused parent reproduction identified Windows EBUSY at directory removal: Node after hooks ran in registration order and the failing first hook prevented the server/database cleanup. The repaired integration test and five bounded subprocess failure-injection regressions cover cleanup during setup as well as normal restart, require process exit without forced termination, and are part of verify/check:merge. This changes test ownership only, with no SQL, transport or runtime API change.

### Batch 99 caustic guiding: section 5 evidence

The optional `voxel-pathtracer/guiding` subclass changes pure diffuse continuation sampling only. A uniform choice from the existing glass/mirror deflector table selects a box; visible faces are area-sampled and converted to solid angle. A cosine/box mixture divides the BSDF contribution by its complete density. All overlapping boxes contribute to both continuation and next-event MIS PDFs. Actual voxel traversal, dielectric events, light visibility, bounce limits and scene uploads remain in use. Inside a bound, enclosing faces are sampled; below-surface proposals contribute zero. No CPU-heavy loop, new buffer, core or stage change is involved.

Unit checks cover strength bounds, zero-strength kernel identity, compatibility helper retention, disposal and replacement-device compilation. `packages/voxel-pathtracer/tests/guiding-browser.mjs` checks a fixed 2x caustic squared-error bar, independent baseline energy, overlapping bounds, an analytic unit furnace including an origin exactly on a sparse bound, coloured absorption, mirrors, empty/huge bounds, native WebGL2 coded help, compatibility execution and real device restoration. Initial enclosing-cone and box proposals preserved energy but missed the unchanged 2x bar: ordinary throughput roulette terminated most successful guided rays at the glass exit. The entry now removes accumulated cosine/mixture factors from its survival heuristic, with the actual survival probability still dividing throughput. Faces containing the origin are excluded because they project to singular directional mass. These are generated stand-in scenes; no general variance, speed or outside-scene quality claim is made.

Native and compatibility evidence is committed in `docs/whitepaper/results/batch-99-guiding-20261109.json`: squared RGB error 9.984675 versus 350.318022 at 64 samples, zero shader errors, exact zero-strength/empty-table identity, and unit-furnace means within the unchanged 0.02 bound. Native device restoration and disposal pass.

### WFC large-world evidence (batch 69, section 5)

Optional CPU heap solver uses bit domains and an indexed heap; generated 192x192 open-grid checks show exactly two entropy updates per cell rather than scanning every cell per choice. Chunk halos pin retained neighbours on all axes, with atomic commits and copied outputs. Exhaustive symmetric binary relations, multiword IDs through 4095 and seeded Rust SIMD/TypeScript parity are tested. Reciprocal validation now does constant membership work per adjacency edge; a bounded-read regression guards the old cubic scan. Library asset URLs are relative for both build paths. Real browser WebGPU/WebGL2 tests load the actual SIMD artifact. Paired/interleaved loaded-machine measurements select the backend; quiet release numbers and real authored-world evidence remain absent.

### WFC worker responsiveness evidence

Optional wfc/worker runs the same local heap solver in a one-shot dedicated worker. TypeScript and the single Rust SIMD artifact emit bounded actual work counters without consuming randomness. shared/worker.js serves/transfers results and revives errors. Abort/dispose/watchdog end the worker and close listeners/progress. Package lifecycle tests cover clone/startup, crashes, malformed messages, timeout and seed/rule parity; real browser records show rendered frames during positive in-flight work on both WebGPU and WebGL2, then abort active TS and SIMD solves. Evidence: docs/whitepaper/results/batch-69-worker.json. No measured frame-time or general responsiveness budget; main-thread cloning still costs time. Core/stage and rendering backends are unchanged.

### README required assets (section 5, 2026-11-09)

Run `node scripts/fetch-readme-assets.mjs` before `npm run check:readme-run`. External standard files live in
`engine-bench/readme-samples` beside the worktrees, overridden by `MARGO_README_SAMPLES`; source, licence and SHA-256
are retained through the loader corpus and the fetcher. Explicit tracked aliases reject absent files and LFS pointers.
OBJ/MTL/PNG, TMX/TSX and LAZ/WDP companions keep their relative paths, and the sample server implements HTTP byte
ranges, including suffix/open ranges, HEAD and 416. `tests/readme-assets.test.js` checks those contracts; verify
also runs the existing README harness regressions. Scoped executions preserve their own report.json.

The loader/decoder/FBX/environment/points run passed 73/88 examples, 15 existing failures, zero fresh failures.
Thirty proved entries were removed from the runtime known list. This does not prove fictional asset identities or
close the remaining input, clip, cubic-curve, NURBS-only or MTL-as-OBJ errors. Physics remains held.

### Optional-peer declaration packaging: section 5 evidence

Typed declaration parameter patterns are emitted as named parameters in files
with optional-peer guards. Their annotations and optionality are unchanged, so
installed peers retain full checking and absent peers cannot make binding names
fail strict library checking. The declaration fixture runs the real strict
compiler without and with a peer, rejects wrong installed option types and checks
idempotency/name collisions. The packed bundler proof retains skipLibCheck false.
This changes declaration text only, without physics or renderer implementation.


### React camera-control tree shaking: section 5 evidence

All four camera-control forwardRef factories carry pure annotations. The Vite
module-graph regression proves orbit-only and arcball-only apps emit only their
requested lazy peer, while existing event/ref and real-browser checks exercise
both controls. The full packed-consumer matrix keeps its 100,000 B initial and
115,000 B emitted budgets and its original cube scene. This removes unused code
without reducing scene work or changing rendering output.

### Custom WGSL transitions: section 5 evidence (batch 76, job 1)

The optional transitions/custom factory compiles a function interface before attaching, with a fixed layout preventing extra caller bindings. Root transitions supplies a protected source hook; core and stage are unchanged. CPU lifecycle tests cover rejected source, cancellation, disposal and replacement during compilation. Real GPU value assertions cover 402 generated solid-color pixels, 1x/4x MSAA, exact endpoints, a nonlinear progress curve, resize and a replacement-device redraw. Native WebGL2 is refused with linked unsupported. Device restoration previously retained active progress after destroying its outgoing image, blending cleared history; it now cancels that missing history. The regression is in transitions/test/custom.test.js. This is single-device stand-in correctness evidence, not speed, artistic quality or cross-device proof.

### Missing standard format evidence (section 5, 2026-11-09)

The real-file runner now proves an outside MPD with all library/sticker dependencies, zipped AMF, PTS intensity/RGB,
and chemistry XYZ. PTS/XYZ compare all values with source text; the AMF reference applies independent elementary
point rotations/translations, including constellations, then compares every vertex/index. The Slic3r file caught the
old oracle's unplaced-bounds error; amf-reference.test.js covers it without changing the 1e-6 bar. The MPD has
13 embedded submodels, 526,895 triangles and zero missing parts/warnings. These are parse/geometry results,
not outside image or speed comparisons. A plain AMF control also passes.

The pinned optional Windows FFmpeg installer preserves the GPL archive outside the repository. MARGO_README_FFMPEG
enters only the relevant README child PATH; tests/readme-assets.test.js verifies the parent environment is unchanged.

### Single WebGL2 package: section 5 evidence

The preview's renderer, picking, restoration and automatic escalation live in
webgl2-compat feature entries. The former workspace and umbrella paths are gone.
Core implementation, hardware tiers and the strict 25,000 B combined core/stage
gate are unchanged. Real-browser preview tests retain picking, loss/recovery,
retained geometry, canvas replacement and native-WebGPU download isolation bars.
The full compat GPU suite remains the proof for the translated device. Source
and built-root isolation now inspect AST import edges; a regression distinguishes
actual imports/exports from comments and loader advice. The duplicate-gate TEMP
fixture detects cross-package exports when package names share a prefix.

### Batch 99 sky: section 5 evidence

The optional voxel-pathtracer sky entry reuses sky's atmosphere tables and integration through the public
`bakeHillaireEnvironment` in the existing Hillaire feature entry. It creates no root/core/stage capability. Compute
produces owned RGBA floats, plus the separate sun's transmittance; every temporary buffer and texture is released
before success, abort or failure settles. The tracer's existing map sampling and device restoration consume those
floats unchanged. Native WebGPU and WebGL2 compatibility pass value assertions, including added multiple-scattering
energy, ozone's twilight shift, stable night, moon phase, vacuum black, analytic Lambert ground and constant-radiance
tracing; native restoration reproduces the converged image exactly. Unit failure injection covers compilation,
mapping and cancellation. Evidence: `docs/whitepaper/results/batch-99-sky-20261109.json`. Proof uses generated
maps and scenes, not an outside radiometric oracle. Isotropic higher orders, finite angular maps and stylized night
remain accepted approximations; MagicaVoxel parity and moving-camera denoising remain separate unfinished jobs.

### WFC review regressions: section 5 evidence

Batch 69 review fixes enforce the overlapping 4096-pattern cap during extraction and dense validation across
legacy, heap, constrained, overlapping, socket and chunk inputs. A 128 MiB heap subprocess reproduced native OOM
on the parent; it now exits normally with RangeError. Input tests exercise every missing coordinate/dimension and
adjacency direction, tile groups and sparse collections. Socket tests reject rotation-weight division that rounds
to zero while retaining representable subnormals. Loading tests cover network/body/local-file/instantiation failures,
exact abort reasons and unsupported SIMD; actual shipped worker tests preserve coded missing-asset failures.
All regressions are in verify's package-test glob and therefore check:merge. No new gate or reduced budget.
Core/stage, Rust SIMD artifact, solver algorithms and benchmark workloads are unchanged.

### Scatter LOD representation audit: section 5 evidence

The batch 69 cross-package audit checked ordered ring compaction, inclusive far rejection, page/ring capacity and
CPU versus GPU float arithmetic. Existing tile-distance bounds already cover uploaded origins, sides, camera and
rounding/flush allowances. Another cause remained in Scatter's input validator: distinct positive float64 LOD
boundaries could upload as zero or equal f32 values. The constructor now validates the uploaded representation,
including sparse lists, before any GPU setup. packages/scatter/test/tiles-budget.test.js regresses zero/subnormal
and collapsed near/middle/far boundaries and accepts the smallest normal f32 boundary. Existing exact-endpoint,
conservative-distance and explicit-cap tests remain in verify/check:merge and grass-tiles.browser.mjs.

### Required outside assets in every worktree (section 5, 2026-11-09)

Four batch-160 test files previously selected data only through a shell-local environment
variable. That explained the differing 14-skip and zero-skip reports on identical main code;
result-cache shadow mode never served tests. Verify now preflights all 348 pinned outside
assets before build, and direct tests validate their complete input family. Missing, partial,
LFS-only and changed caches fail with the file path and fetch command. The syntax gate
no longer exempts those four files. Regression evidence includes empty-cache verify in a
subprocess, digest corruption, a missing companion and override/default path resolution.
Existing glTF importer mechanics tests remain unchanged apart from input enforcement;
physics and physics2d packages remain held. No hardware or performance claim is added.

### Texture mask transitions: section 5 evidence (batch 76, job 2)

The optional mask entry appends one owned RGBA8 texture binding through the transitions capture's protected binding seam. Capture and composite orders remain -80/50. ImageData is snapshotted; bitmap uploads retain a borrowed open image for restoration. Texture upload includes WebGPU's required render-attachment usage. 1344 generated-mask pixel assertions cover both upload paths, hard/soft thresholds, black/mid-grey/white, exact endpoints, odd-size resize, replacement-device reupload and native WebGL2 refusal at 1x/4x. An interpolated-UV nearest tie initially selected the wrong row after a 7x3 resize; integer centre addressing fixes the cause, with no tolerance change. Unit checks cover overflow rejection, closed images, upload rollback and disposal. Evidence is single-device correctness, not measured speed or branded-image aesthetics.

### Transitions scene disposal: section 5 evidence (batch 76 continuation)

Owner lookup through the existing extension sceneOf API removes the owning registration before releasing GPU resources. Unit regression preserves a default-scene effect while disposing a second scene; real WebGPU proof renders both afterward. The shared GPU test engine now models sceneOf identity lookup, so default-scene lifecycle tests exercise this contract too. No core or stage change.

### Ground backdrop composition: section 5 evidence (batch 56, job 1)

No renderer or optional entry is rebuilt: environment/ground already supplies the projected HDR floor,
and staging already supplies the contact catcher. Their composition needs background order 0.25 before
contact order 0.5. staging/test/ground-browser.mjs uses the licensed OpenEXR BrightRings image and a
generated box: on/off contact pixels, unchanged product/outside pixels, caster removal, disposal and
actual device replacement pass on WebGPU and the WebGL2 compatibility layer. Native WebGL2 remains
unsupported. The photo's lighting is not reconstructed by the contact cue; the existing physical-picture
loss remains open. No new core, stage, CPU geometry loop or shader is introduced.

### Live transitions: section 5 evidence (batch 76 job 3)

The optional entry uses existing core scenes and render views: two full-frame RGBA8 texture targets followed by a private composite scene's order-50 pass. No recursive render, core or stage modification. Scenes update once each, shared cameras once, with independent depths. Progress survives resize and replacement because no historical image is required. Owned images and the composite scene are removed on disposal; borrowed scenes/cameras survive. Actual WebGPU tests check 374 generated-background pixels at 1x/4x, both scenes changing at fixed progress, resize, destroyed-device recovery, canvas output and subsequent borrowed-scene rendering. Native WebGL2 refuses with a help link. Unit checks cover hostile values, foreign/same/disposed scenes, partial allocation cleanup and disposal. No performance, HDR or artistic-quality evidence is claimed.

### Real B-frame edited timestamps (section 5, 2026-11-09)

The video/codecs reader keeps exact rational native ticks through edit filtering and
movie-time conversion, then rounds once to microseconds. An outside MDN CC0 AVC clip
exposed the prior double rounding (one microsecond early). CPU regressions cover both
sub-microsecond edit boundaries, seek selection and unsafe raw timestamp collisions.
All 150 real frames match an independent FFprobe sample demux plus WebCodecs reference,
byte for byte, with every edited timestamp exact. This shares the browser decoder; it
is not independent H.264 decoder accuracy or other-device proof. The new required clip
uses the existing digest/fetch/preflight mechanism, now 349 outside inputs. The optional
entry is 3,458 B gzip within its unchanged 3,593 B gate; core/stage are unchanged.

Batch 160 section 5 job 6 extends external picture evidence to anisotropic GGX and thin film, on all 50/346 original primitives respectively. Exact separate WebGPU and WebGL2 compatibility budgets include silhouettes and all RGB channels. Native WebGL2 refuses PBR. GLB packing only relocates bytes, with hash-checked originals and invariant tests; this is not a geometry-build performance change. Full image residual causes stay open. No core/stage or shader code changed.

### Batch 99 RGB media and physical medium boundaries

The optional voxel tracer media entry converts palette extinction into the existing scalar density
plus three normalized coefficients in media's unused metal-reflectance row. Scene and model palettes
are copied and validated before replacement. Root/stage dependencies and GPU resource layouts are unchanged.
The existing hierarchy integrates RGB shadow depth. Chromatic free-flight sampling uses a three-channel
mixture with explicit collision/survival PDFs and cancels a common exponential before division. Pure
absorption and chromatic emission are analytic. Scalar media keep their established sampler.

The root tracer formerly moved its physical origin by 0.002 local units at media boundaries, losing
absorption and emitted path length. It now advances only the intersection query by a representable
forward amount and restores that distance before transport. Both path and refracted shadow walks carry
the boundary flag. A generated three-cell vacuum-emission regression requires radiance 3 within 1e-5.

Section 5 evidence: native WebGPU and compatibility value tests, zero-extinction channels, extreme RGB
coefficients, model palettes, conservative scattering, chromatic shadows, emission, real native device
replacement and raster restoration are exercised by media-browser.mjs. Evidence is scoped to generated
scenes on one workstation; continuous fields, overlapping medium composition, external density files,
cross-vendor accuracy and speed remain unmeasured. The existing finite boundary-iteration guard remains.

The medium-boundary regression also covers negative grazing directions at voxel and brick planes.
A floor-only start can select the cell behind the ray when the forward query displacement is below
one coordinate step, repeatedly switching media at zero distance. Forward half-open cell selection
uses ceil minus one for negative directions in the existing two-level walk. No retry or epsilon
attenuation correction is used. The grazing test failed at radiance about 0.997 before this repair,
against a physical path value about 3.5.

Batch 160 section 5 job 7 adds external constant-furnace IBL evidence for the full 123-primitive glTF scene, with Mitsuba direct/full transport references, unchanged display mapping and exact independent backend budgets. Raw/display hashes protect reference recapture; unit contracts cover ordering, finite radiance, source preservation and frozen counts/budgets. Native WebGL2 refuses the path; real compatibility renders it. Geometric IBL visibility/reflections and principled/glTF differences remain open. Constant radiance does not establish directional prefilter or nonuniform-sky accuracy; batch 168 evidence remains in force. No production renderer code changed.

Batch 160 section 5 job 8 adds independent direct-light picture evidence on the existing Cornell fixture: directional bounded orthographic shadows and point compute selection/six-face shadows, each with unshadowed control, on WebGPU and real compatibility. All pixels, default PCF/bias and exact first budgets are retained. Tests preserve every fixture quad/reflectance and frozen reference count/hash/budget; native WebGL2 explicitly refuses. Contact/visibility residuals stay open, and point finite-range attenuation differs from the ray-traced emitter. This does not repeat the batch 168 bake or prove GI, many-light stress or all shadow types. No core, package renderer or speed result changed.

### Accumulated planar shadows: section 5 evidence (batch 56, job 2)

staging/accumulate reuses the contact receiver, caster variants and lifecycle through protected projection,
coverage, update and cache seams. One binary point-light projection and one ping-pong sum pass run per
sample frame; converged frames draw only the receiver. R16F integer sums up to 1024 are divided once
when composing. The constant-size matrix and bounded 11-bit disk sampler add no CPU geometry/image
loop; GPU work holds visibility. Core and stage remain unchanged at 23,797 B gzip. The root receiver
is 8,129 B, within its unchanged 8,259 B ceiling; the new entry is 9,314 B including the receiver, with
the standard 9,593 B ceiling. No runtime speed was measured.

Native WebGPU and the WebGL2 compatibility layer each match 16,384 exact stand-in texel sums,
including Direct3D's specified subpixel snapping. Tests cover three heights, 1024-frame empty/opaque
sums, a PBR caster, convergence, resize, removal, actual device replacement and native WebGL2 linked refusal.
Ownership coverage found that ContactShadows.dispose removed by name from the default scene;
it now removes its owning scene's registration by identity. CPU and actual-device owner regressions
keep a same-name default-scene effect alive. This is single-machine raster evidence, not photographic
quality, arbitrary-axis or full radiometric light integration evidence.

The inherited receiver also registers its pass under the effect's own name, allowing contact and
accumulated effects in one scene. CPU and real-GPU coexistence regressions cover both registrations.

### Studio rig reuse: section 5 evidence (batch 56, job 3)

SKIPPED implementation: environment/studio already generates overhead, key, fill and rim softboxes.
The staging recipe composes its FloatImage with EnvironmentLighting, projected ground at order 0.25
and the contact receiver at 0.5. No new shader, CPU pixel loop, Wasm, runtime entry or core/stage change.
The existing studio GPU oracle verifies source-cube values and projected SH, with key irradiance above
1.5 times the fill, on WebGPU and WebGL2 compatibility. The new studio variant of staging's ground
oracle gives identical off/on contact RGB [80,80,80]/[70,70,70] on both paths, preserves product/outside
pixels, clears removed casters and restores after actual device destruction. Stand-in box and generated
image only; no photographic-product, local-light falloff, physical soft shadow or speed claim.

### Procedural dual contouring (batch 68, job 5)

The optional procedural/sdf factory loads its own Rust/Wasm asset. Uniform-grid
Hermite edge roots are shared among adjacent cells; analytic box/sphere normals
feed a mass-point QEF solved with symmetric Jacobi eigenvectors and all 27 bounded
constraint sets. World-space unit normals preserve rank in anisotropic cells.
The renderer receives owned geometry data and does not own the modeler. No core,
stage, CAD kernel or physics source changes. Real WebGPU and WebGL2 tests assert
sharp corner values, lazy loading, disposal and generation after device/context
loss. Native QEF rank/constraint tests and a required downloaded Khronos Box fixture
prove corner, plane, volume and closed-edge values. CSG and scale controls remain
generated stand-ins; arbitrary topology and render quality are unproven (LIM-632).

### Supplied mip chains: section 5 evidence (2026-11-09)

Materials/mips now uploads seven outside toktx v4.0 conformance chains, five levels
each, on a real WebGPU device. All 35 images (9,548 texel bytes) read through the
allowed linear view match independent ktx-extract hashes exactly. Missing, LFS and
changed fixture bytes fail before browser startup. GPU readback uses textureLoad
and pack4x8unorm into storage, since supplied textures promise sampling rather than
COPY_SRC. No rendering or core/stage code changes. The solid-colour density controls
remain; these outside solid-colour patterns add upload conformance, not production
texture quality, nonuniform authored-image evidence or speed measurements.

### Batch 65 job 1: at-grade road junctions

The optional road/junctions entry lazily loads existing polygon strokes, polygon union, shape triangulation and geometry transforms. Union precedes triangulation, so crossings and T junctions have one surface, including holes. Core and stage are unchanged. Section 5 evidence: road/test/junction-precision.test.js rejects float32 face collapse and UV overflow; road/test/junctions.test.js checks analytic area, half-open triangle coverage, winding, normals, UVs, ownership, extremes and abort boundaries. road/test/browser-check.mjs draws the result on native WebGPU and real WebGL2 compatibility, checks five interior pixels and a clear exterior, then exact reboot pixels and double disposal. Generated roads are stand-ins; no surveyed-road, graded-junction, curb, performance or other-hardware claim is made.

### Batch 76 review fixes: section 5 evidence

Root/custom capture reads now derive full-target UVs from fragment positions rather than viewport-local interpolants. The unchanged mask path already uses absolute pixels; live creates only full-frame views. viewport-browser.js adds 2304 exact spatial-color pixel comparisons across all four built-ins/custom/mask, idle/start/midpoint/completion, offset viewport, stacked scissor and 1x/4x. This suite is part of transitions test:gpu, automatically reached by check:merge's affected-package GPU selection; unit format/abort checks run in verify. This catches the partial-view class missed by solid full-frame fixtures.

A shared package-local format-domain check rejects integer/depth outputs and non-resolvable 32-bit float MSAA before live source updates, allocation or progress changes, and before frozen-frame capture allocation. Real-device tests accept baseline normalized/float output formats at 1x/4x, and reject invalid domains without a GPU validation error. Custom WGSL interface tests reject reachable extra textures/samplers/uniforms/storage, accept unused declarations and wrapper-global access, and compile/dispose a high-work loop without dispatch. This validates a resource interface, not execution safety. Trusted source remains mandatory; no timeout or hostile-dispatch safety claim.

The requested scatter audit inspected inclusive far rejection, near/middle selection, fade bands, tileDistance's conservative f32/flush bounds, uploaded LOD representation and ordered compaction/page/ring capacities. Existing fixes/tests cover these cases; no additional defect was found. All 72 scatter unit cases pass, including tiles-budget.test.js. No scatter code or budget changed. Generated fixtures and one RTX A6000 only, no new throughput claim. Review fixes fit existing entry budgets; core and stage remain unchanged.

### Static USDZ sample: section 5 evidence (2026-11-09)

The original introduction now runs on the complete outside Blender 5.1 BoxTextured
USDZ with its archived PNG. Required external inputs total 353; README aliases
share that cache and validate the pinned SHA-256 before serving. The regression
checks one mesh, 36 expanded vertices, 12 triangles, UVs, texture and zero issues.
No parser, rendering, core or stage code changed. This closes the introduction's
missing-file execution gap only; composition, reset-stack data, physical Quick
Look and production image quality remain separate gaps.

### Batch 65 job 2: banking

Optional road/banking rotates the existing road sweep about its forward tangent and lazily reuses geometry/utils normals after deformation. Core and stage stay unchanged. Section 5 evidence: banking.test.js proves analytic signed tilt, width, normal direction, equal-distance transitions, grades, curved and closed inputs, finite normals, hostile bounds, float32 collapse, ownership and abort boundaries. browser-check.mjs proves road/clear pixels, exact device reboot and double mesh/engine disposal on native WebGPU and real WebGL2 compatibility. Generated geometry is stand-in proof; no survey, civil design, other-hardware or speed claim.

### Splat README inputs: section 5 evidence (2026-11-09)

Four explicit format aliases close four splats example failures; all 14 original
blocks execute. The regression hashes four real-excerpt fixtures, validates 8,385
splats each and compares every locally serialized .splat position with independent
PLY. No codec/render, core or stage source changed. This is example-execution
evidence; independent encoder accuracy, full-capture quality and throughput remain
separate. Full SPZ tests keep their required shared fixtures.

### Batch 65 job 3: Terrain fit

A world-space snapshot of the road is projected into XZ. Vertical BVH ray containment establishes the footprint, including shoulder zero. The lowest barycentric height across projected faces establishes a bed below banked curb/driving overlaps. Existing BVH closest-point queries supply distance outside the footprint; a cubic smoothstep shoulder blends that bed with the original ground. BVH loads on invocation. Biomes carvePaths already shapes a ground-following bed but cannot take authored road triangle elevations, so it is not duplicated. Core and stage are unchanged. Section 5 evidence: Analytic cut/fill, shoulder/end distance, banked grades, curbs, ownership, hostile inputs and aborts; actual fitted heightfield pixels and value oracles, exact device reboot and double disposal on native WebGPU and real WebGL2 compatibility. No speed claim. See packages/road/test/terrain.test.js and browser-check.mjs. Generated stand-ins only; no surveyed-data, other-hardware or speed claim.

### Batch 65 job 4: Self intersection repair

The new optional repair entry samples the existing spline and lazily calls road/junctions. The owning road precision adapter now rounds polygon boundaries before triangulation, instead of rounding an already chosen float64 triangulation. This prevents two inverted ears in the local hairpin regression without filtering faces or weakening the output checks. Geometry's existing polygon union and triangulation do the heavy work. Core and stage are unchanged. Section 5 evidence: A generated hairpin demonstrably folds and double-covers in the root sweep; repaired faces all have positive area and single coverage, with polygon/mesh area agreement. Closed courtyard, hostile inputs, grade rejection, ownership and aborts; real WebGPU/WebGL2 road pixels, exact reboot and disposal. No speed claim. See packages/road/test/junction-bends.test.js and browser-check.mjs. Generated stand-ins only; no surveyed-data, other-hardware or speed claim.

### Decoder README inputs: section 5 evidence (2026-11-09)

Exact CC0 compressed views now accompany the Draco introduction and meshopt SIMD
example; both snippets document file-specific metadata. Required alias reads refuse
absence and LFS pointers. Root regressions compare every compressed byte to its
outside source and SIMD output to an existing independent hash. The real Wasm
regression checks Draco output channel/count/index bounds. No codec, backend,
core or stage source changed. This is example execution, with no new performance
or production-model quality claim. Sources/hashes live in the decoder fixture notice.

### Viewer period safety: section 5 evidence (batch 56)

The optional stage/viewer turntable reduces elapsed time before dividing by seconds per turn.
Finite subnormal periods no longer overflow and poison the camera; infinite resume delays now
reject before loading. CPU regressions cover signed minimum/maximum finite periods and huge
deltas, and the real-device viewer harness asserts a visible helmet at three extreme periods.
Core and the stage root are unchanged. No new rendering or framing feature.

### Physical-map resource pressure: section 5 evidence (batch 56 audit)

An actual FlightHelmet viewer on WebGL2 compatibility exposed gltf-pro's eager eight missing-map
fallback bindings. Native physical shader variants now key on the eight authored-map bits and
substitute absent extension-map samples with their exact one-texel constants. Binding generation
omits those same slots. The five core slots and material-hook paths keep their resource contracts.
The variant cache has at most 256 masks, with a constant eight-slot construction loop; no CPU-heavy
geometry or image loop is introduced. CPU renderer regressions check bindings and all eight
authored slots independently. The full actual-device viewer assertions now pass on compatibility.
Core, stage root and physics are untouched. No measured speed or whole-material-conformance claim.

### Direct glTF GPU input evidence: section 5 (batch 56 audit)

The extension harness now requires its four external sample families through verify's hash-checked
resolver. An unset environment override no longer bypasses those cases. The root contract test
checks helmet, IBL, skull and tower validation and bans optional-presence branches in this harness.
The existing resolver tests exercise missing, partial, changed and LFS-only content. Real GPU
assertions use the existing outside files; no new reference image or tolerance is substituted.

### Product framing: section 5 reuse evidence (batch 56, job 4)

Implementation SKIPPED: stage/viewer already frames a glTF's bounds with near/far scaling, adds a
plain background and turns the camera around its target. No staging/frame alias or new stage feature.
The actual FlightHelmet harness passes on native WebGPU and WebGL2 compatibility: product frame
coverage, contact and cascaded floor pixels, orbit radius/height/target, failure rollback, disposal
and actual device replacement with an identical whole frame. CPU tests cover reduced motion,
drag/wheel pause, zero/nonfinite/empty/huge bounds and extreme finite/nonfinite turntable settings.
The audit's period arithmetic, absent physical-map binding and silent external-input defects are
resolved in separate fix commits. Raw device/value evidence: whitepaper/results/batch-56-frame.json.
Root staging is 8,129 B gzip, accumulate 9,314 B, viewer 2,386 B and core plus stage 23,797 B.
No CPU-heavy loop, photographic quality claim, performance measurement or core change.

### Batch 99 triangle geometry and section 5 evidence

The optional voxel-pathtracer/mesh entry builds a balanced world-space triangle BVH in one lazy Rust/Wasm feature. The root tracer provides protected scene-storage reservation, append and AOV-decoding hooks. Defaults reserve zero words and retain the original layout and shader. Optional triangles use the existing scene binding and its capture copies, byte accounting, atomic replacement and restoration; no core or stage source changes.

The scene storage gate counts added triangle/node words only against the scene binding, without shrinking the independent voxel/material/environment bindings. Flat double-sided surfaces reuse the BSDF integrator, including mutual triangle/voxel shadows and secondary paths. Closed, consistently outward-wound, uniform-material glass shells use the existing medium state; overlapping/nested mesh media, camera-inside initialization and mesh textures/deformation are outside the contract. Triangle emitters are path sampled, without next-event sampling or deflector guides.

Section 5 evidence: mesh.test.js covers hostile data, atomic failed/cancelled updates, call order, copied caller arrays, storage bounds and lifecycle. mesh-browser.mjs asserts analytic radiance and shadows, mirror paths, a glass furnace, shared-edge signs, many-leaf nearest traversal, huge/zero/empty geometry, unchanged empty-entry voxel output, real device replacement and exact raster restoration on native WebGPU and WebGL2 compatibility. The arithmetic probe compares uncertain edge determinants with exact Float64 products. Float32 coordinate transformation still bounds accuracy; cross-vendor and arbitrary production assets remain unmeasured.

mesh-build-ab.mjs compares every output word with an independent scalar median builder, in alternating paired rounds. SIMD validation groups four coordinate predicates per instruction group. Loaded-machine timings are diagnostic and carry no release or rival speed claim.

Mixed-tracer creation builds the voxel snapshot once. Device setup checks the geometry reserve against the actual binding limit before allocating. The packing-stat regression prevents an internal second setScene from hiding initial work as reuse.

Review 99: the triangle sentinel is not a voxel instance. The mesh specialization excludes interior triangle glass from box-based inverse Snell candidates and marks new surface/scattering chains there as outside that sampler's support. Exterior straight-through walks remain paired with their path MIS share. Section 5 evidence adds a white diffuse voxel inside and behind a closed outward-wound glass cube at IOR 1 and 1.5 on both backends; mesh-browser.mjs keeps the root glass-furnace bound of 0.02. The prior kernel fails the new IOR-1 interior case at 0.979917. Core and stage are untouched.

The independent root-glass correction removes repeated inverse Snell directions at interior diffuse vertices. The reservoir estimates a sum, so giving identical candidates small selection weights still counts their entire estimates repeatedly. The canonical box-exit face now offers an unchanged direction once; all distinct refraction and mirror candidates retain their previous weights. Section 5 evidence: the root test:gpu script includes glassfurnace (four IORs, including exact and near identity), with the existing 0.02 bound. The split-suite/check:merge invariant test requires this case explicitly, so it cannot live only in an optional entry suite. The old kernel returns 1.038261 at IOR 1 and fails this regression. No core or stage change and no speed claim.

### Complete Potree README folder: section 5 evidence (2026-11-09)

The required outside manifest grows to 457 files, adding all 80 files of the
BSD-2-Clause lion_takanawa_normals dataset. Both downloaders share one cache and
source/hash record. Direct points tests validate the entire family before traversal;
verify preflights it too. Root regressions require every alias and fail on a missing
node. The full package proof visits all 77 nodes and independently compares all
341,989 coordinates and RGB values exactly. Both original examples and the whole
18-example points README pass; 1x/4x GPU package suites remain required. No runtime,
core, stage or held physics source changed. No surveyed/normal-decoding/quality/speed claim.

### Batch 65 job 5: Lane markings

The road entry only builds small placement descriptions. The existing post/decals renderer projects them from scene depth, handles angle/depth fades, backend shaders, device restoration and disposal; its built-in white texel removes image-asset requirements. Solid/dashed lines and three-stroke arrows share this renderer. No shader or new geometry solver is introduced. Core and stage are unchanged. Section 5 evidence: Authored extents, dash end trimming, arrow symmetry, headings, ownership and hostile/extreme validation; white line and arrow pixels on a road, exact device reboot and double disposal on native WebGPU and real WebGL2 compatibility. No speed claim. See packages/road/test/markings.test.js and browser-check.mjs. Generated stand-ins only; no surveyed-data, other-hardware or speed claim.

### GPU periodic textures (batch 68, job 6)

The procedural/textures entry owns a device-bound compute pipeline and RGBA8
outputs. A fixed 8x8 dispatch uses integer seeded hashes, wrapped lattice corners,
quintic interpolation, and periodic material functions. Brick alternation requires
even rows. CPU code only validates settings and submits work. No engine/core/stage
or physics source changed. Native WebGL2 explicitly refuses with a coded help link.
Real GPU tests compare 44,415 channels with an independent CPU numerical oracle,
exact full-period phases and one-pixel seam shifts. Real cancellation, disposal,
lost-device waits and a fresh adapter/device are exercised. Partial allocations and
queue failures have stand-in regressions. Compilation diagnostics include the WGSL
source line. A downloaded published brick raster supplies a calibrated structural
row offset only; other proofs are stand-ins, not material realism (LIM-639).

### Additive shader corpus provenance repair (batch 68)

The corpus writer previously kept only the first record for a source hash. Adding
an already recorded bundled shader after giving it a package label lost the new
owner and pipelines, so the existing source-coverage gate still refused the package.
writeCorpus now unions creating packages, labels, pages and distinct renamed
pipelines, and resolves bundled ownership when a real package label arrives. It
keeps one source body per hash. corpus.test.js reproduces the initial unlabelled
record followed by two labeled/package recordings, shared and distinct pipelines,
and checks exact metadata after a write/read/add cycle. The existing root corpus
coverage test remains unchanged and guards every package that gains shaders.
Runtime renderer, core and stage code are unchanged. The procedural compute shader
was recorded from the actual GPU run; original published-reference images are not
included in the corpus. This is quality-gate metadata, not a new renderer claim.

### GPU cancellation rejection observation (batch 68)

An already resolved device-loss promise could race a successful compilation-info
promise, start a pipeline on the lost device, and then reject early without
observing that pipeline promise. The returned error was coded, but the later GPU
rejection was unhandled. The same class affected a queue promise rejected after
early cancellation. Texture waits now observe success/failure before prechecks and
check cancellation/loss again after completion. Ordinary GPU failures still propagate
with their original cause, and explicit cancellation retains the caller's reason.
The CPU regression covers both races and partial cleanup; the real GPU test invokes
the factory on an already lost device. No core or stage source changed.

### Batch 65 job 6: Road network graph

road/graph adapts authored junction IDs, spline arc lengths, direction and static travel costs to compute/graph, which keeps the existing CSR ownership, solvers and WebGPU/CPU backends. The root road entry does not import compute. Its synchronous bounded pass builds at most two arcs per road; it adds no shader or solver. Both native device and real WebGL2 compatibility use the existing device-backed compute route, and CPU is available explicitly with createCompute({backend:"cpu"}). Graph/context recreation after reboot is explicit, not automatic restoration. Core and stage are unchanged. Section 5 evidence: Generated stand-in networks: arc-length/default costs, one-way/reverse links, minimum parallel edges, traffic rerouting, isolation, ownership, empty/maximum topology, hostile/extreme values and aborts. Native WebGPU and real WebGL2 compatibility verify route distances/predecessors, reachability, extreme normal f32 weights, solver abort, double disposal, and reconstruction after engine device reboot. No speed or real traffic-data claim. See packages/road/test/graph.test.js and browser-check.mjs. Generated stand-ins only; no surveyed-data, other-hardware or speed claim.

### Batch 160 raw API determinism: section 5 evidence (2026-11-09)

The static-render defect is reproduced below the Margo renderers: two fixed blend
draws, a fully cleared RGBA8 target, finite flat tints and no texture/material/time
inputs. Both native WebGPU and raw WebGL2 vary on NVIDIA 617.42 at four samples;
standalone Dawn reproduces it independently through D3D11 and D3D12. All report
and input hashes are retained in whitepaper/results/batch-160-determinism.json.
AMD four-sample and NVIDIA one-sample controls are exact across fresh processes.
These controls isolate the affected platform path, while its internal mechanism
remains unknown. No core, stage, package renderer, hardware default, size gate,
error budget or merge gate is changed. The exact assertions remain failing
regressions on the affected platform; batch 160 jobs 4/5 cannot land as passing
and the list row stays open. tests/reference-blend-repeat.test.js verifies the
fixture's uint32 indices, all retained triangles and atomic concurrent downloads.

### Batch 99 spectral transport and section 5 evidence

The optional voxel-pathtracer/spectral subclass generates its own tracing kernel through the existing
protected shader hook. It uses one RGB path with importance-sampled hero selection only at the first dispersive glass
event or active chromatic lens, squared index-ratio scaling in dielectric samples and refracted shadow
walks, and optional Cauchy/Abbe thin-lens power. It adds no buffer, texture, CPU-heavy loop, Wasm,
core or stage source dependency. Device restoration regenerates the same feature kernel.

Section 5 evidence: generated native WebGPU and WebGL2 compatibility value tests cover empty and extreme
inputs, equal-energy colour weights, a single interface, a closed slab, dispersive furnaces, and lens
coverage at 450, 587.6 and 650 nm. The original analytic Snell and viewport lifecycle fixtures can also
select the spectral subclass with --spectral. Albedo/normal/depth use hero samples; instance/palette IDs
retain the centre ray. Transparent coverage initializes its own fixed or uniform wavelength before
the chromatic lens, with exact opaque-alpha regressions on both backends. The root API is unchanged.
There is no measured production spectral-colour, multi-element lens, diffraction or speed claim;
RGB coefficients and independent optional subclasses remain explicit limits.

### Rectangular building rule evidence (batch 68 job 7)

Optional buildings entry loads one independent Rust/Wasm asset lazily. Typed rules
split absolute floors, component facades, repeated equal bays, centred panes and a
flat/gable roof; one oriented scope shares sine/cosine. No core/stage change. Tests
check all surface areas, enclosed volume, normals/winding, bay coverage and owned
arrays on hostile/tiny/large rules. Real WebGPU/WebGL2 compare values through actual
loss/disposal; no device resource belongs to the generator. Source geometry from
Montreal supplies envelope measurements only; facades remain stand-ins. T junctions
are a documented shell limit, not a manifold-solid claim. Deterministic trig count
proves reduced transform work with exact coordinates; no timing/SIMD gain claimed.
Evidence missing: arbitrary footprints, recursive grammars, real facade recovery
and production-city quality/performance. Bounds and sizes are in LIM-642.

The additional CMP facade reference checks four real annotation rectangles against
a calibrated2x2 bay/floor region within1.88928 source pixels, below the unchanged
2-pixel bound. Measured unequal floor splits correct the initial equal-row fixture
assumption; this was a proof-calibration error, not a generator bug. Original photo
and XML stay outside shipped files. Full facade/ornament/material recovery remains
unproven and is not claimed.

The exact-byte CityJSON fixture is marked -text in .gitattributes. Git line-ending
conversion initially changed its SHA-256 after checkout; publisher bytes were
restored. tests/procedural-standard-assets.test.js guards both the Git attribute
and exact length/hash in the root verification and check:merge test suite. No hash
assertion was loosened, and the full verification is rerun after the correction.


### Node README completion and Basis integration: section 5 evidence (2026-11-09)

The Node README child now serves exact pinned external source URLs from the shared
required cache, validating their digests and refusing missing/changed/LFS bytes.
Root tests cover complete FlightHelmet dependency closure and explicit failure.
The decoder's test:gpu:node-gltf script is discovered by the existing GPU gate and
runs the actual README setup/load in Node on webgpu 0.6.2. All 15 textures/177 mips,
complete geometry and visible readback pass with zero validation errors. There is
no independent Basis pixel-accuracy, quality or speed claim. Both Node and browser
README deadlines now fail unfinished examples; verify regressions cover each.
No deadlines were raised; no core, stage or held physics source changed.
Record: whitepaper/results/readme-node-basis-20261109.json.


### P20 required input and independent oracle: section 5 evidence (2026-11-09)

The required external manifest adds the complete VTK big-endian horse and both original licence texts (460 inputs total). Missing, changed or LFS-only bytes fail verify/direct tests. A checked-in python-plyfile output record proves every position, white color and index; the optional real-file count oracle now walks every declared scalar/list width, with regressions for the previous float-only assumption. No production parser, rendering backend, core, stage or held physics source changes. Surveyed/visual/speed and authored normal/UV accuracy remain unproved. Record: whitepaper/results/ply-big-endian-horse-20261109.json.


README lifecycle gate (2026-11-09): the same 20-second page deadline now covers creation, navigation, module completion, settling, error queries and page closure. A hung lifecycle fails, closes the owned browser tree, stops later scheduling and preserves completed partial results. Three deterministic non-answering-call regressions run in verify. An extra full audit was killed after a genuine lifecycle hang; its focused biome files-in/out example now reports an unfinished module. No full-audit pass or accepted slowdown is claimed.

### Idle product stills: section 5 evidence (batch 56, job 5)

Optional staging/pathtrace supplies ProgressiveStill, a camera-idle controller around the existing
voxel-pathtracer/mesh integrator. The renderer, Rust/Wasm BVH and transport stay in that package;
attach dynamically loads them. Core and stage are unchanged. Camera and image-size changes reset
progress and restore raster before the still pass. Device replacement resets the idle timer.

The real 20,734-triangle licensed FlightHelmet neutral material study passes on native WebGPU and
WebGL2 compatibility with ANGLE Vulkan. Tests assert every restored raster/traced pixel, convergence
at 8 and 64 samples against 512, per-hit analytic emission, empty geometry, cancellation, PNG capture,
invalid replacement, owning-plugin disposal and actual device replacement. CPU tests cover hostile
idle/delta values, zero, huge finite delta, all camera-key parts and registration rollback. Browser
canvas assertions use compositor screenshots: 2D copies of a WebGPU canvas are cleared or stale
around presentation and cannot establish the displayed frame. Raw evidence: whitepaper/results/
batch-56-pathtrace.json. Flat-shaded triangle/material and inherited backend limits remain explicit.
No new CPU-heavy loop, outside-renderer equality, general photo-quality or speed claim.

The lazy attach boundary snapshots caller arrays before its first await, retaining content-key
identity; the regression fails before repair (9 rather than 1). The optional peer legitimately
adds staging/stage downstream GPU coverage. Planner tests retain standalone/runner narrowing
with WFC and additionally assert every affected tracer/staging/stage suite, lifecycle, and the
exact full plan for combined voxel/tracer changes above the unchanged 12-package safety threshold.
No GPU scope, test tolerance or safety threshold was reduced.

### Batch 133 predictor and metadata continuation: section 5 evidence

The unshipped decoder adds 289 exact prediction/traversal cases and 41 metadata
cases. Prediction-degree seed vertices are visited before the face-visited check,
as specified; long metadata lengths use observed varUI32 framing. A flat arena
preserves roots, raw bytes and children without recursive parsing/destruction or
a fixed depth limit. Native and private Wasm regressions pass, including strict
prefixes, corruption and repeated frees. Both exposed original metadata streams
and all 454 original native/float payloads remain exact at an 18,874,368-byte peak.

`packages/decoders/tests/draco-native.test.js` makes these regressions part of
`verify`, hence `check:merge`, including native tests, Wasm build, KD, memory,
prediction and metadata checks. Each subprocess has a hard process-tree limit,
and missing Cargo is a failure. The CPU gate changes no GPU footprint. Full
predictive EdgeBreaker/predictor/type/version coverage, public text conversion,
worker/loader/lifecycle, requested-byte budgets and per-file paired timing,
start-up and RSS remain required; public entry, prebuilts, core and stage stay
unchanged. The scoped evidence is `whitepaper/results/batch-133-resume.json`.

### Oriented staging receivers: section 5 evidence (batch 56, job 6)

The orientation oracle completes accumulated coverage by observing `samples` against the configured
`frames`, including after device replacement, with a 30-second failure deadline. Contact coverage
requires one render and submitted GPU completion. The fixed-wait gate rejects unconditional frame
delays; the GPU driver asserts the restored sample count and the original whole-texture equality.

ContactShadows and AccumulatedShadows share one normalized receiver frame. Projection, plane corners, normal lift, camera-side rejection, fit and accumulation disk sampling all use it. The up option belongs to optional staging; core and stage are untouched. The root and accumulated entries measure 8520/9655 B gzip; ceilings 8776/9945 include normal headroom.

The real-GPU orientation suite checks every texel of contact and accumulated histories under six cardinal and two sloped orientations, with translation, visible receiver pixels, backside rejection, live history reset, empty scenes, double disposal and real device replacement. Native WebGPU and WebGL2 compatibility both pass. A real FlightHelmet rotated to Z-up casts a fitted contact shadow; analytic rectangles separately prove the orientation invariant. CPU tests cover world ray-plane projection, AABB support extents and extreme direction magnitudes. The unsupported native preview now links its coded error; its regression failed before repair. Records: batch-56-axis.json and batch-56-axis-compat.json under examples/package-benchmarks/results. No HDR backdrop orientation or continuous tangent-frame transport is claimed.

### Batch 65 review fixes: section 5 evidence (2026-11-09)

Review 65 exposed four P2 defects absent from the original evidence: an exact-zero projected-distance gate lost interior terrain samples, banked curb/driving overlaps chose an arbitrary face, chord-only planarity checks missed grades, and clamped closed endpoints plus split normal accumulation left road seams. The fixes use barycentric footprint containment and a lower bed envelope; four raw samples determining each cubic span; periodic road and spline tangents; and shared end-row corner-angle normal indices. Existing BVH ray queries supply footprint containment and barycentric weights; closest-point queries are used only for shoulder distance. No duplicate predicate or public API change is needed. Core, stage and physics remain untouched.

packages/road/test/review65.test.js uses all four exact review inputs, checks all 343 strictly interior grid points (including the review's 342 points away from edges), banked curbs in both face orders and bank signs, all cubic bases with coarse arc lookups, exact road seam positions/normals, and the independently accumulated seam normal. packages/splines/test/periodic.test.js covers frames and placement/deformation consumers; packages/geometry/tests/periodic-sweep.test.js covers the shared sweep on a custom nonplanar loop. The original probes are retained under test-results/review65; corrective logs are in test-results/fixes65. The package suites pass 335 tests with no failures or skips; real road WebGPU/WebGL2 and geometry GPU checks pass, including reboot/disposal.

The new check:road-invariants is an unconditional CPU step of check:merge after verify. It executes the three regression files against the built packages, so footprint, undersampled-planarity and periodic-frame classes remain checked even when an affected-package plan would narrow later GPU work. Generated stand-ins only; no surveyed-data, civil-design, speed or other-hardware claim. Updated LIM-634/635/636 evidence replaces the original unsupported no-defect assertions.

Final validation caught terrain-entry growth past its existing 1143 B quality budget. Reusing the existing BVH ray containment primitive removed the duplicate predicate implementation and reduced the corrected entry to 1000 B without changing any size budget or regression assertion. An additional custom-sweep probe with up parallel to the seam tangent exposed a separate history-dependent fallback; the terminal row now uses the initial up frame, and periodic-sweep.test.js covers that case too.

### Section 5 evidence: batch 68 cellular automata

Optional procedural/caves loads one feature-local Rust/Wasm instance with no
core/stage imports or renderer dependency. 2D/3D synchronous Moore updates use
exact separable box sums, choosing a direct stencil on grids where it costs
fewer reads. Native tests compare every threshold against the direct algorithm;
JS tests use independent scalar loops, hostile values, all volume/work bounds,
owned data and lifecycle checks. Real Natural Earth Madagascar data is a pinned
public-domain fixture with root checkout-byte protection. The browser test checks
every output cell on actual WebGPU and native WebGL2, before and after genuine
loss and with a replacement generator. No shader is introduced. Seeded/3D
controls are stand-ins, and geological realism, connectivity, renderer pixels,
wall-clock/SIMD gains and other hardware remain unmeasured. Bounds: LIM-643.

### Product-floor capture repairs: section 5 evidence (batch 56 audit)

The owning environment capture now saves the outer view, sets its own viewport before SceneTarget.begin caches the MSAA depth-copy view, then restores the outer view after resolving. A scene background and a quarter-size capture previously threw Draw rectangle exceeds target; the unit regression failed before repair. The real first-frame resized product capture additionally caught the cached MSAA scissor and passes after the ordering repair. Core is unchanged.

The floor's independent mip oracle caught hardware filter/storage rounding beyond half a binary16 ULP. Explicit clamped 2x2 loads and nearest-half quantization before attachment storage meet the unchanged bound at every real-product mip texel. Boundary probes independently expect ties to even, a subnormal tie, 65504 and an odd tie; all match exactly. WebGPU and WebGL2 compatibility pass actual replacement-device frame equality, resize, a uniform empty capture and disposal. Native preview refusal now includes its unsupported help link. No speed claim or full physical roughness claim. Gzip reflector11104, refractor11065, cube-camera5680 B; only planar ceilings rise for these repairs.

### Glossy staging floor reuse: section 5 evidence (batch 56, job 7)

Job 7 is SKIPPED as a new implementation: environment/reflector already captures and blurs a transformed planar surface. The staging README composes it as a product floor. Real FlightHelmet evidence shows 4,078 reflected pixels below the entire product silhouette and 4,077 pixels changed by roughness on each tested backend. Its existing image blur is not a physical GGX floor BRDF. The owning capture and precision defects were repaired in the separate preceding environment fix with failing regressions; no core/stage or held physics edits.

The environment mirror GPU gate now runs its unchanged 65 assertions on both WebGPU and WebGL2 compatibility, at 1x and 4x MSAA. Its fixture queues a canvas-texture copy before expiration and maps after GPU completion. This repairs a premature first-compute read without reading an expired native canvas. The earlier compatibility TAA mismatch and the intermediate native blank-frame failure are retained in the canvas-readiness evidence; neither is excused by changing pixels, thresholds or frame counts.

### Batch 99 parity colour decoding: section 5 evidence (2026-11-09)

Palette and light/surface colour conversion now uses the file's film gamma, default 2.2.
The former fixed exponent produced a 9-level sunlight value where the external black-box
reference measures 20 at gamma 1. Unit regressions fail on the old build. The dedicated
`voxel-pathtracer test:gpu:parity-gamma` requires exact bytes 20/46/89 at gamma 1/1.8/5
on native WebGPU and WebGL2 compatibility, plus the gamma-1 coloured sky value. Both
backends compile without shader diagnostics or GPU errors. The outside binary, its licence,
input/output digests and numeric results are recorded in
`whitepaper/results/batch-99-parity-gamma-20261109.json`; no outside implementation or PNG ships.
This evidence covers colour decoding. Exact subsurface, glass and atmosphere pixel parity
and camera-move disocclusion denoising remain open. An independently restarted complete
zero-error image corpus remains missing. No core/stage source or physics source changed.


### Test-page follow-up: built export evidence (2026-11-09)

verify's post-build unit suite now checks every package.json export target,
including declaration and nested conditional outputs, in package-exports.test.js.
Missing-output negative controls exercise all three branches; direct imports
cover native preview, tilemap iso/hex, viewcube axes and dynamic theme/roll APIs.
Those test-page reports came from stale dist and do not reproduce after a fresh
build. Tile relative/root-relative inputs also pass the existing loader fix.

### Test-page follow-up: transition composition evidence (2026-11-09)

Optional mask/custom transitions own distinct plugin/pass names and nested capture
layers. Capture orders -80/-79/-78 reverse at composite orders 48/49/50, restoring
the frame target in either attachment order. CPU tests use real Engine ownership;
the spatial viewport oracle adds paired and three-kind compositions at 1x/4x.
The expanded GPU gate passes 3,456 spatial pixels at 1x/4x with zero shader errors;
all 13 environment/transitions browser/GPU scripts and 470 changed-package unit
tests pass. Remaining landing gates are still required. Core is unchanged. The
separate mesh-vector assignment defect requires Scott's approval and remains open.

### Test-page follow-up: environment lifetime evidence (2026-11-09)

Environment direct disposal now removes its owning scene registration before
freeing its GPU resources. Real-Engine default/secondary-scene replacement tests
in environment/tests/brdf-share.test.js fail without the fix; shared LUT counts
still reach exactly one destruction. Other identically named scene plugins stay
attached. The renderer and core are unchanged; no new hardware or speed claim.

### Test-page contracts: section 5 evidence (2026-11-09)

The test-page review is recorded in docs/testpage-bugs.md. Analytic SDF bounds
replace a fixed default cube, and the same feature-local Rust contourer now emits
per-vertex gradients. Its primitive field/CSG branch rules are unchanged. The
procedural texture entry adds a lazy native WebGL2 fragment pass, sharing option
validation with the compute path. Outputs discriminate their native handle type;
GL state is restored before any asynchronous publication. Backend pixel and
lifecycle proof belongs to procedural/test/textures-browser.mjs, including context
loss and actual restoration; both native backends pass 88,830 oracle channel checks at maximum error one.

Road row frames follow chord bisectors. Affine determinant constraints on each
sample pair compress inside offsets to retain 5% of the pre-fold signed area;
this prevents local inversions while preserving the outside offsets and section
heights. Periodic endpoint scales are joined. This does not resolve nonlocal
footprint overlaps; planar union remains in optional repair/junction entries.
The regression covers the exact three-point seam, mirrored hairpins and grades,
all triangle/normal signs, and steep versus vertical tangents. No speed claim. Core empty geometry never enters renderer batches or allocates geometry buffers; zero bounds and partial-input rejection are covered by core/tests/empty.test.js and real native/compatibility/preview rendering in empty.browser.mjs.

check:merge now unconditionally runs check:testpage-contracts and the expanded
check:road-invariants. They cover inferred bounds, normals, iterable cabin parts,
complete tree placement/disposal, folding diagnostics, cancellation, empty-node
updates and history return types. GPU shader parity remains in the GPU package
suite. Actual RobotExpressive and RiggedFigure contracts cover disconnected IK,
precise morph diagnostics and name lookup, unnamed clips and native-preview rejection. RiggedFigure proves an intermediate leg joint is carried without local rewrites. Culling instance batches skip empty vertex/index uploads and all geometry draw commands, keeping finite zero box bounds. Core accepts empty Geometry under Scott's 2026-11-10 exception;
stage and physics remain untouched; hardware breadth beyond the tested machine
and a quiet-machine speed study are not claimed.

Test-page contract checks depend on verify's built declarations and runtime
entries in the parallel merge schedule (`STEP_AFTER`). The scheduler regression
checks this dependency. The core empty-Geometry GPU proof also covers device
replacement while empty; all changed-package GPU scripts passed on 2026-11-09.
The required README gate found a repeated whole-grid shader-brush reference
inside a per-cell predicate; its work-count regression now requires one CPU
reference with identical output. No timeout or size threshold was relaxed.


### Missing-items API and README gate follow-up (2026-11-09)

The actual short-path API CLI now asserts one snapshot file-list request for all
entries; a package's global declarations are walked once and shared by its entries.
The regression failed at 886 before repair; full/scoped unchanged-report checks
pass after repair. Strict execution tests also enforce release before replacement
in the shadows, quality and SMAA README examples. Real README/GPU gates are pending.
The slow-send paired record has no minimum-time regression beyond its spread, but
a 7.4 ms current diagnostic outlier exceeds twice the unchanged 3.5 ms budget and
remains unclassified. Browser teardown is owned by batch 160; dependent pushes wait
for its mainline repair and the catalog/prefetch confirmations.


The full follow-up verify passes 13,497/13,498 tests, zero skips, including both
API gates and all README ownership regressions. Its sole failure exposed prefetch
registration outside the standard biome test-entry contract. The proof now lives
in tests/prefetch-check.mjs and keeps runSuite/watchExit, an exclusive GPU hold and
a 300 s subprocess deadline; the documented script forwards to it. Existing
chain/plan/exclusive-refusal checks catch the original gap and pass after repair.
The earlier catalog teardown failure remains pending batch 160 despite this run's
passing catalog test. Real README validation is queued, not claimed passed.


The prefetch-plan follow-up also exposed an eval-import guard defect in the GPU
planner: pathToFileURL(undefined) threw before exported plan() was usable. Its CLI
guard now checks for argv[1], just as the llms guard does. The actual eval-process
regression fails before repair and passes afterwards; all 12 chain/plan/lock/import
tests pass. No scheduling or GPU logic changes. The full biomes CPU suite passes
476 tests, zero failures/skips. The initial package-GPU request also expired in
the queue without starting any test; it is rescheduled with a 20-minute queue
allowance and separate shared/exclusive groups, preserving each registered test's
budget. The stale ownership-gpu-package-results.json from the unsuccessful request
is not evidence for this group; use the rescheduled logs/results only.


### Latest continuation validation (2026-11-09)

Source checkpoint 257af82e7: full verify passes 13,499 tests with zero failures
and zero skips in 396.1 s (396 s supervisor). The full API check matches all 886
reports / 8,631 exports; the actual 8.3 CLI passes in 38.8 s with exactly one
snapshot list query. The new prefetch-entry and GPU planner import regressions
are included and pass. Lint/hygiene pass after the package rebuild; the earlier
missing environment declaration was a scheduling overlap with that rebuild, not
a package defect. All 476 biome and 311 effect-package CPU tests pass. The final
verify disables only shadow-cache bookkeeping (MARGO_RESULT_CACHE=off); every
normal build/check/test runs and no result is served or test omitted.

Real README and registered package-GPU validation remain queued, each supervised
with hard limits and unchanged per-test/page budgets. The initial two queue
expirations ran zero tests. These CPU results alone do not satisfy landing requirements:
batch 160's browser repair must arrive on main, then catalog/prefetch must be
confirmed, and the over-2x 7.4 ms diagnostic frame still needs attribution. No
quiet-machine speed number, busy exemption or new accepted limit is claimed.


GPU follow-up: the registered shadows/test:gpu:cutout-casters test passes in
22.5 s under its exclusive hold (302.4 s supervisor including queue), with no
driver-reset rerun. Its rescheduled result file is current and contains exactly
that selected test. The remaining 15 shared package scripts and the two README
requests are still supervised and queued; none is claimed passed.


### Missing-items landing confirmation (2026-11-09)

Rebased source aa3b0dfc4 includes batch 160's browser pipe-lifecycle
repair 6ebbd1aa4. Catalog passes in 24.6 s and the full default-world
prefetch proof passes in 51.8 s, including bounded browser teardown. Every
field/typed-array hash for 292 unique results matches the parent; view/placement
work remains 204/190 before and 144/144 after. No workload or budget changed.

Full verify passes 13,534 tests with zero failures/skips (472.8 s supervisor),
all 887 API reports / 8,638 exports, and all 1,117 README type examples. Lint and
hygiene pass. The explicit changed-package CPU run passes 775 tests, zero
failures/skips. All 16 registered shadows/quality/post GPU scripts pass without
driver-reset retries; those completed results were collected before the rebase.
All 46 shadows/quality/post and 35 biome original README examples now execute
with zero failures or exceptions. The required outside-input manifest remains
460 files; no assets, exports, core/stage or held physics source changed here.
Core plus stage is 23,837 B gzip, below 25,000.

Durable checks and per-example/script results: whitepaper/results/missing-items-landing-20261109.json
(use results/ from this whitepaper directory). Per the newest coordinator note,
land these validated repairs before diagnosing the separate 7.4 ms slow-send
outlier. That frame remains open, above twice the 3.5 ms gate, without a busy
exemption or speed claim. The remaining 42 README exceptions and P01-P29 proof
boundaries remain unchanged.

### Test-page local follow-ups: section 5 landing evidence (2026-11-09)

The built-export target gate, environment disposal, nested transition captures,
burst-join capacity, inspector initial ranges and duplicate-label diagnostics
pass full verify: 13,517 unit tests, zero failures/skips, all 20 proof scenarios,
887 API entries and 970 quality size entries. Core plus stage remains 23,837 B
gzip. A diagnostic size failure was repaired within the existing labels budget
(5,546 B); no ratchet or test threshold changed. Lint and hygiene pass.

Retained package evidence is 470 unit tests and all 13 environment/transition
browser scripts. The remaining labels/netcode/tiles browser scripts now pass,
including the tiles spatial and lifecycle oracles, with zero shader errors.
All 56 six-package README programs execute without failures/exceptions. These
are current-host correctness results, with no new timing claim. The approved
core reference guard for 32/36 and new reports 42-45 remain outside this landing.

### Batch 160 mip interpolation and argument evaluation

The optional WebGL2 emitter interpolates integer-level hardware samples for
isotropic linear mip filters with matching min/mag filters and integer LOD
clamps. Other sampler states retain hardware filtering. No extra texture unit
is used, and core/stage are unchanged. The helper accepts argument values once;
derivatives and LOD calculation use its parameters, preserving private effects,
discard hoists and short-circuit evaluation. The CPU regression fails before
repair. GPU validation is pending; no reference-picture budget changed.


Batch 160 mip landing evidence after rebase onto teardown fixes cf699846f and
20375ea56: lint and hygiene pass; full verify passes 13,570 tests, zero failures
or skips (418.2 s). The package passes 140 unit tests, the complete browser
corpus (558 pipelines, 1,238 entries, 733 draws), the full GPU suite (327.1 s),
and all 12 runtime README examples. Removing fractional weights fails the
unchanged native/compatibility comparison (0.875 versus 1), with its mutation
marker retained. Core plus stage remains 23,924 B; compatibility entry remains
within its unchanged 102,814 B ceiling. No benchmark or exclusive hold ran.


Batch 160 job 4 restores the optional gltf-pro native volume absorption repair.
Shipped shader math now crosses the mesh-space slab along a refracted world
ray, retaining transforms and instancing. CPU analytic regressions and twenty
exact GPU slab pixels per backend cover it; no core/stage code or export change.
Frozen full-scene viewer/Cycles budgets remain independent gates. Actual AMD
three-process repeat proofs are required after the main teardown repair, with
one shared GPU slot per lane. Unresolved transport and numerical limits remain
listed in known-bugs.md/limits.md; no new speed measurement is claimed.


Fresh job 4 AMD proof (driver 32.0.21042.62): all four commands passed with
normal teardown. Each backend/model retains 72 identical decoded RGBA captures
across three fresh processes, four devices and six frames. Transmission
viewer/full/direct absolute errors: native 1,749,897 / 4,120,866 / 2,622,899;
compatibility 1,738,453 / 4,122,216 / 2,616,547. Volume viewer/full/direct:
native 1,512,739 / 13,741,199 / 1,746,854; compatibility 1,512,128 / 13,741,752 /
1,747,921. Every unchanged square/max/foreground gate also passes.
Durable proof paths, report hashes, decoded RGBA hashes and all metrics are in
results/batch-160-amd-transmission.json and batch-160-amd-volume.json (relative
to docs/whitepaper). The full volume ceiling remains 13,792,000.
The analytic GPU test passes twenty exact slab pixels on each backend; all 47
gltf-pro/materials runtime README examples pass with zero exceptions.
The complete changed-package CPU run passes 783 tests with zero failures/skips.
Earlier completed package browser/GPU steps are retained, not blindly rerun:
gltf-pro shader/extensions/materials/viewer/native-volume, all materials steps
with dispersion/cutout-casters completed by job4-material-remaining12.
The unrelated voxel denoise-materials AMD watchdog remains an open investigation;
these proofs do not classify it as a driver fault or close the batch.


Job 4 final merge gates: lint and hygiene pass; full verify passes all 13,585
tests with zero failures/skips (449.7 s). API reports match 887 entries and
8,638 exports; core plus stage remains 23,924 B. The four frozen viewer/transport
JSONs are byte-identical to the parked originals after line-ending normalization.
Every fresh AMD proof, native-volume regression and runtime README gate passes.
No benchmark, exclusive hold, tolerance increase or skipped test is included.

### Guiding README initialization evidence (Batch 99)

The caustic-guiding example starts the existing progressive viewport instead of
blocking module initialization on full tracing-pipeline compilation and a capture.
Its pagehide handler disposes the tracer and engine. The existing preview covers
the compilation interval; full guided transport is unchanged.

The controlled-promise regression guiding-readme.test.js rejects the old example
while the tracing pipeline is deliberately unresolved, then verifies initialization,
preview dispatch, full tracing after release, and disposal. This tests ordering,
not a speed budget. A real native-WebGPU cache-disabled probe reproduced the old
20-second module-completion failure at pipeline readiness and completes the revised
example with the same limit. All 9 runtime README examples and 134 package tests pass on the rebased tree. The earlier verify stopped at stale API size rows caused by API generation preceding entry measurement. Regeneration in input order and the scoped API recheck pass; the coordinator directed no second full verify on this code. Pipeline
compilation itself has no new latency guarantee and no gate tolerance was raised.

### Media README lifecycle evidence (Batch 99)

The media module no longer depends on full tracing compilation and a capture
before starting its viewport. The controlled-promise regression in
media-readme.test.js fails the original startup, then verifies preview, requested
capture waiting, the original capture dimensions and samples, full tracing, error
propagation and disposal. The button awaits the real renderImage API. Native and
forced WebGL2 checks inspect its float result and resumed viewport. This is
lifecycle correctness evidence; the two baseline diagnostics did not reproduce
the original timeout and do not establish a driver/compiler failure. The deadline,
shaders and transport stay unchanged. Scope and receipts are in the media startup
proof; the earlier verify API-generation failure and successful scoped recheck
remain recorded in the guiding proof. The coordinator directs failed steps only.

### 5. Batch 99 viewport history tap repair

The combine kernel now consumes the prepare kernel's valid-tap mask per tap.
Rejected geometry contributes neither color nor sample weight. The mandatory
voxel-pathtracer test:gpu:history-taps is discovered by check:merge, has a six
minute process-tree limit, and tests all 16 masks with HDR 32768, samples
1/8/65536, zero history, native WebGPU and WebGL2 compatibility, and actual
device replacement. The original shader fails 112 partial-mask cases; all
448 pass after repair. Device and tracer disposal remain exercised. Evidence:
whitepaper/results/batch-99-history-taps-20261109.json. The existing moving
camera oracle and its thresholds are unchanged. This proves tap rejection,
not noise-free disocclusions or the requested optional /denoise entry.

History landing evidence (Batch 99): all 448 history cases pass again on native WebGPU and WebGL2/Vulkan with actual replacement devices; all 137 package tests and all 9 runtime README examples pass. The tracer, core, stage and math sources match the successful r6 base/denoise GPU checks, which are retained without repetition. The changed compatibility preview ownership and browser teardown are covered by the fresh history and media lifecycle checks. Genuine paired entry/network records were generated from one clean package revision, API rows afterward, and the documentation corpus after final docs. The earlier 13,545-test verify is historical; no fresh full verify is claimed. Evidence: whitepaper/results/batch-99-history-landing-20261109.json. Jobs 1 and 2 remain open.

### Preview attachment contract (2026-11-09)

GPU-only optional packages refuse the small `webgl2` preview during setup with linked `unsupported`; the shared `requireWebGPU` helper runs before ownership and allocation. The full compatibility device uses the `webgpu` backend and passes this requirement. Existing preview routes stay available, including CPU mesh LOD; imposter registration refuses before mutation. XR preview refusal uses `unsupported`, while invalid attachment state remains `state`.

Quality gate: `check:preview-contract` parses package sources, including shared helpers, and runs in verify and therefore check:merge. It catches backend-gated pass owners without an attach refusal; explicit real preview routes name their regression tests. Unit regressions exercise direct refusal, no retained plugins/passes, helper tier discrimination and CPU LOD. Browser evidence is `packages/webgl2-compat/test/package-tiers-browser.mjs`, with `test-results/preview-package-tiers.json`: direct refusals, loadCompat escalation, model and outline pixels, and procedural bake readback on native and full compatibility devices. The selection/glTF silent-blank premise did not reproduce; both already refused on main.

Section 5 evidence limit: these checks prove attachment and the named fixture rendering, not new feature parity, speed, or support for devices below the full compatibility layer minimum. Core and stage source are unchanged.

The same validation exposed a duplicate-detector defect: multiline import continuations counted as implementation.
The detector now removes complete import/re-export declarations from the parsed syntax while preserving code and
original line numbers (`tests/quality-gate.test.js`). The UI widgets README also awaited a dialog before initialization
could finish; the example now requests the dialog from a button handler, with the exact snippet imported by
`packages/ui/tests/readme-widgets.test.js`. Gate budgets and timeouts are unchanged.

The added Gemini cases 21, 22, 26, 29, 30, 31 and 33 are explicit attachment/escalation cases in the same browser gate. Native WebGPU retained by install() emits a linked state warning (device.test.js); force installs without it. Backend webgl2 without a supplied preview fallback already produces linked unsupported, now checked in the real browser. No core change is needed. Procedural main gained a native fragment preview route during integration: it must remain on preview without invoking loadCompat.

Preview continuation research review: [module boundaries, conservative setup and graphics standards](../whitepaper/preview-contract-research.md). The 2026-11-10 restart keeps teardown with lane-T and defers timing suites; it does not relax correctness assertions.

The required README gate exposed a video example awaiting gesture-gated AudioContext.resume during module setup. The example now starts from a Record button; packages/video/test/readme-record.test.js executes the exact snippet with held audio permission and checks initialization, activation and cleanup. The old snippet fails its state assertion. Recorder code, browser teardown and gate deadlines are unchanged. See the [recording example research review](../whitepaper/recording-example-research.md).


Preview integration size gate: the unchanged optional compatibility ceilings
rejected root/device entries at 102,906/103,008 B. Concise installer diagnostics
retain the same code, help link, unavailable API names and all missing capabilities;
rebuilt entries are 102,799/102,914 B, below 102,814/102,935 B. The installer
control flow is unchanged. All 144 compatibility unit tests pass, including
preflight refusal and retained-native warning contracts. This is a byte proof,
not a timing claim; research is in compat-continuation-research.md.


Preview landing evidence: the fresh canonical compatibility GPU command passes
with its real native oracles and compatibility draws (314.1 s); the forced-shim
failure remains separately indexed for batch 273. The updated LOD default browser
check passes, and all 30 DOF/LOD/compatibility README programs execute with zero
failures. The same default cutout-caster command covers the clustered, materials
and shadows aliases: it passes once on each backend, shared, without --cost.
Those three correctness aliases are additional to the 115-suite continuation
count above; their cost path stays deferred. Native 118/118 prior package gates
remain preserved. The 26 other parity/fixture/cleanup failures remain open.

The integration verify exposed stale generated entry-size inputs in api-surface;
regenerating entries also exposed the coupled network record's older commit in
sizes-page.test.js. Both real measurements were regenerated, preserving the
unchanged assertions: the basic scene fetches five files, 36,353 transferred
bytes, and no unused built file. Its gate retains the real renderer and network
assertions; a lane-local acquisition wrapper only tightens its shared GPU hold
to one minute. API reports retain 887 entries and 8,638 exports. No exports,
core/stage source, benchmark scene, error tolerance or size ceiling changed.


Final rebased integration: lint and hygiene pass. Full verify runs without an
outer GPU lock, with speed deferred, and passes all non-unit stages including
GPU policy, API, size, quality, docs and examples. Of 13,633 unit tests, 13,632
pass with zero skips; the sole failure is the upstream GPU report's untracked
coordination-path pointer. The pointer is reworded in its owning report, retaining
the existing no-private-paths regression unchanged. The final focused regression
and metadata run validates that repair; no full-verify pass is substituted for
this recorded result. Package/browser/README proofs above remain unchanged.


The final mainline rebase adds a real native sciviz backend. The preview contract
gate now records SciRenderer's existing single backend branch and its native
rendering regressions. Without that review the conservative source gate rejects
it; an additional backend guard invalidates the review count. Default GPU-only
attachment still refuses without the explicit fallback. This is source-gate
integration for the existing route, not a new renderer feature or relaxed test.


The final source-gate integration passes 380 focused tests with zero failures or
skips, including all compatibility, DOF and LOD unit tests, native sciviz route
checks, paired size/network records and the unchanged clone-path regression.
The actual sciviz native-WebGPU/native-WebGL2 pixel and recovery command passes
with its original all-pixel bounds. Fresh preview-contract runs pass in both
outer modes, and the additional compatibility README gate passes all 12 examples.
Lint, hygiene, quality, API (890 entries/8,648 exports), documentation, README types,
preview source contract and size gates pass. The full verify's earlier one-doc
failure and its precise repair remain recorded above. Durable summary:
whitepaper/results/preview-contract-landing-20261109.json (relative to docs).

Final documentation rebase onto 44f75880e preserves both additive limits notes
and regenerates the documentation corpus. All 19 affected creative, pixel and
tonemap README programs pass. Reconciled coverage is 545 current examples:
534 pass, 11 known failures, zero new failures or missing examples. The focused
README, corpus, encoding, preview, size and private-path regressions pass 93 tests
with zero failures or skips; API, links, README types, preview and size checks pass.
The completed integration validation belongs to base 17e876ee3/head 30e16454f;
the evidence no longer attributes it to the mutable origin/main ref. Paired
entry/network measurements are retained from c3f5f4d18. Full verify and completed
GPU/parity suites were not repeated for this documentation rebase.

### Section 5 evidence: batched picking repeated work

Selection's micro sphere rejection lazily evaluates matrix rows without changing
summation order, plane order, conservative bounds or queried neighborhoods.
The parent reads 6,400 model components across 100 horizontal misses; the repair
reads 3,200. Captured batch scene comparisons fall from 100 to one and its
submissions from 100 to one. Both regressions fail on the parent. Package CPU
checks pass; real-GPU point equivalence now passes. Desktop MSAA keeps micro
passes because integer IDs cannot be resolved; no core/stage change or new
elapsed-time comparison is claimed. See perf-history's batch 108 follow-up.

### Batched picking pre-rebase validation (2026-11-09)

Lint, hygiene, API, quality, proofs and full verify pass: 13,669 tests, zero
failures or skips (440.5 s supervisor). All 83 selection CPU cases pass. One
shared GPU slot passes picking, all three captured/MSAA/micro batch comparisons,
real-model perspective/orthographic checks and x-ray, plus all six executable
README examples (36.9 s combined). No --time loop or benchmark was run.
The historical 83 vs 67 ms remains an open loss for the deferred speed phase.
Fresh genuine entry/network records share commit 1d7571281 and dirty=false;
the actual basic scene fetches five requests and no extra file. API generation
follows measurement. Selection is 20,808 B gzip, previously 20,745 B (+63),
below its unchanged ceiling; core + stage stays 23,924 B under 25,000 B.
The short network capture now explicitly limits its shared hold to one minute
and waits at least 60 minutes, with the existing regression expanded.
Evidence: test-results/skip-gaps/item3-*.log; research in skip-gaps-research.md.

Final main rebase: inherited preview error-link and compatibility changes. Rebuilt
all packages and regenerated genuine entry/network records together from
375b56d0b, dirty=false, then API and llms. Lint, hygiene, API, all 83 selection
cases and 21 record/document regressions pass. The fresh shared-slot selection
GPU suite and all six README examples pass (20.2 s combined); the GPU suite
includes captured/MSAA/micro counts and real-model perspective/orthographic
equivalence. Earlier full verify remains the 13,669-test pre-rebase result; no
second full verify or timing benchmark is claimed. Current selection: 20,833 B
gzip under unchanged 21,142 B ceiling; upstream before our change: 20,772 B.
Core + stage remains 23,924 B. Logs: item3-rebased-*.log.

### Section 5 evidence: batch 134 private whole-file adapter

The private queued .basis TypeScript adapter passes 180 frozen payload hashes
across three primary and three outside-authored CC0 files, including all
implemented targets/mips. Metadata, video mip history, cancellation and
disposal have direct tests. A damaged Zstandard-frame regression found a
missing error boundary in the private KTX2 adapter; it now preserves the
underlying cause in a coded failure. No shared decoder or package API changed.
Native Rust tests: 34. Private Node adapter/corpus/packed tests: 15.
Full worker integration, remaining target encoders, full hostile-input proof,
GPU and final memory/size acceptance remain pending; timing proof is deferred.

The [bounded whole-container campaign](../whitepaper/results/batch-134-whole-container-fuzz.json)
covers all 51 primary seeds and 2,856 deterministic mutations, with broken and
CRC/framing-preserving cases. All 13,507 decode calls returned valid output or
coded refusals; there were no uncoded exceptions, traps or hard-limit failures.
The two prebuilt-unserved 3D seeds are checked for coded rejection. Each process
is bounded at 180 seconds, with a 1,800-second campaign limit. The pinned
adapter/Wasm hashes are in every seed record. This remains implemented-subset
validation, not complete fuzz acceptance while target encoders are missing.

### Section 5 evidence: batch 134 private UASTC BC7

The private target-6 path converts UASTC endpoints/weights/partitions directly
to BC7, preserving the checked KTX2 and .basis adapters. [Evidence](../whitepaper/results/batch-134-uastc-bc7.json)
records 345/345 primary payload hashes, all 19 modes/every partition/CSEL in
5,504 crafted blocks, and 3,072 solid cases, both transfer modes. A failing-before
regression protects the explicit BC7 anchor table against ambiguous figure
emphasis. Native tests: 39; private Node tests: 17; TypeScript and Wasm build pass.
Current incomplete Wasm: 141,859 raw / 50,955 gzip bytes. Each block is visited
once, emits 16 bytes, and uses fixed stack scratch without RGBA image staging.
These facts do not establish old/new timing or isolated per-pair peak memory.
No new GPU requests are allowed before the pending teardown repair reaches
origin/main. Other target encoders, public integration and job 2/3 closure
remain open; job 4 timing stays in the deferred speed phase.

The [BC7-expanded full-container campaign](../whitepaper/results/batch-134-bc7-fuzz.json)
passed all 51 seeds, 2,856 mutations and 14,974 decode calls under 180-second
per-seed and 1,800-second whole-campaign limits, with no uncoded error, Wasm
trap or hard timeout. Decoder source and compiled Wasm stayed unchanged during
the campaign; the evidence writer verifies the final source manifest and
aggregate hashes against the BC7 checkpoint. Per-seed records log input and
adapter hashes. Controls retain strict RGB9E5 specification output; other
implemented outputs retain frozen prebuilt hashes. Counts mix ABI image/target
and whole-file/target jobs. Remaining encoders, full job 3 and isolated peak
memory acceptance remain open.

### Section 5 evidence: batch 134 private UASTC ETC

The private [ETC1/ETC2 target0/1 checkpoint](../whitepaper/results/batch-134-uastc-etc.json)
covers26 primary files/52 pairs/690 mip/layer/face outputs. Published hint,
packing and alpha-center rules are retained; the independently chosen full
RGB selector metric improves every pair's unchanged original-source SSE.
192 images are old-byte-exact;498 permitted selector differences are quality
checked, with old payload/source controls revalidated. Native43 and selected
Node18 tests pass. The crafted queued-adapter test uses an independent
specification-derived ETC reader to verify palette-optimal RGB indices over
every mode/partition/CSEL; native vectors verify solid fields and alpha
center/index orientation. Wasm155605raw/56363gzip bytes is an incomplete
private build. Public integration, remaining encoders, peak memory, final
size, GPU and deferred speed proofs stay open. No new GPU request was made.

The [ETC-expanded full-container campaign](../whitepaper/results/batch-134-etc-fuzz.json)
passes all51 primary seeds/2856 mutations with17908 decode calls, zero uncoded
errors/traps/hard timeouts. New ETC state-recovery controls use frozen,
independently source-quality-validated replacement outputs; other targets retain
their strict old/spec controls. Source and compiled Wasm stay unchanged, and
each seed pins input/adapter/Wasm. Its388s diagnostic duration is not a timing
proof. Remaining encoders, public integration and all final acceptance bars stay
open. Browser repair cf699846f is now rebased from origin/main; fresh shared
correctness gates and voxel-first landing remain pending.

### Section 5 evidence: height-aware scatter interaction

The owning scatter package supplies its already validated height texture to the
interaction hook before distribution. Interaction bilinearly samples the same
rectangle and adds the same centre Y, then tests a 3D sphere with scaled norms
and overflow guards. Direction and the retained recovery field remain horizontal.
CPU upload/rebinding regressions pass and fail on the parent. GPU tests compare
all cells on a synthetic sloped heightfield, with both texture coordinate modes,
plus flat-field recovery, shadow pose and finite-extreme checks; all ten scatter
browser suites pass on the real GPU. Additional cost: four texture reads per field cell and 32 bytes per
interactor. No core/stage change. Copy-paste terrain chunks and LOD guidance is
in scatter's README, linked from creative. No huge-area or frame-rate claim.

Item 4 final proof: all ten registered scatter GPU suites and all 14 README
examples pass in one shared slot (70.2 s combined). The package CPU regressions,
lint and hygiene pass. Entry and basic-scene records genuinely measure
419b34508 with dirty=true, the same source state; five network requests, no extra
files. API generation follows measurement. Completed full verify evidence is
retained from the earlier continuation; no extra full verify or timing loop ran.
Logs: test-results/skip-gaps/item4-*.log; sources: skip-gaps-research.md.

Final rebase inherited only the independent voxel-pathtracer glass correction.
Scatter sources and passing proof inputs are unchanged. Its changed package was
rebuilt and the paired entry/network records regenerated from 21ff80d28,
dirty=false; scatter/interact stays 3345 B and core + stage 23924 B.
The pre-rebase GPU/README proof above remains the scatter execution evidence.

### Section 5 evidence: optional lighting diagnostics restoration

Size-restoration finding 3 restores field and range guidance in lighting2d's
shared, emissive, soft and cookie validators. RangeError identity and help links
remain; scalar boundaries and rendering equations do not change. The package's
diagnostics regression fails on the shortened implementation and covers rejected
fields plus valid zero, positive and inclusive upper boundaries. Optional
ceilings retain the full diagnostics; core plus stage stays at 23924 B. Research
and before/after measurements are in size-restore.md and limits.md. The real GPU
suite passes 236 pixel checks with zero wrong pixels or validation errors, and
11 shader modules compile. All nine README examples run as written. Execution
uses one shared GPU slot per worktree and wait-max 60.

### Section 5 evidence: optional ordered erosion

The feature-local Rust SIMD Wasm keeps Margo's ordered erosion and shared option
quantization, outside core/stage. Earlier native tests (2), 258 JS parity cases
and the pinned unresampled 2048x2048 DEM at 32 rounds match every independent JS
hash and outflow. Fresh linear memory is 156,827,648 B; caller input and owned
output bring backing storage to 244,908,032 B, excluding objects. Array reuse
saves 10n bytes while copies cost 21n; no total-memory or elapsed-speed win.
A new production-consumer regression failed because the saved manifest omitted
the optional export and Wasm copy build step. Both registrations are restored.
Vite emits erosion-YNFeqg0-.wasm; the browser confirms exact served bytes, lazy
loading and every real-crop field on WebGPU and WebGL2 pages. All eight existing
biomes GPU suites pass, plus that production browser proof, all 36 biomes
README examples and all three umbrella examples.

Item 1 final proof: 477 package CPU tests, lint, hygiene and focused metadata
checks pass. All eight existing biomes GPU suites, the new production erosion
browser proof, all 36 biomes README examples and all three umbrella examples
pass. A combined five-minute lease interrupted flythrough after three completed
suites; the orchestration was split, completed suites preserved, and only the
interrupted/pending steps ran. Flythrough passes in 243.2 s; no assertion or
package deadline was changed. This is gate duration, not a speed claim.
Earlier complete verify passed 13,585 tests with zero failures/skips
(repair-api-fullverify.log). No extra full verify ran in this continuation.
Final main rebase inherits unrelated diagnostics and documentation; erosion
source/Wasm and proof inputs stay unchanged. Packages are rebuilt, with genuine
paired entry/network records from 604f09866, dirty=false, then generated API.
Logs: test-results/skip-gaps/item1-*.log; no benchmark or timing-only run.
### Review 99 deferred spectral transport and section 5 evidence

The spectral entry retains the root integrator's deferred importance sampler instead of replaying
four identical paths with random colour weights. The active chromatic camera lens selects a wavelength
once before ray construction, hands its density-corrected weight to path throughput, and reuses the
same wavelength at glass. Fixed-wavelength captures retain unit RGB weights. The squared index-ratio
radiance factors and the independent uniform-wavelength alpha coverage are preserved.
The spectral GPU suite now requires exact zero channel spread and exact root image equality for a
white diffuse scene at 1 and 64 spp, with an inactive dispersive lens and an achromatic open aperture.
The existing interface, slab, lens disk-edge, furnace and lifecycle bounds remain unchanged.
No timing, spectral upsampling or production-lens fidelity claim follows.

### Section 5 evidence: readable palette WGSL

Size-restoration finding 4 restores descriptive identifiers and layout in pixel's
palette shader. Normalization against the prior Margo shader proves that only
identifiers and whitespace changed; constants, operations, ordering and binding
positions are identical. The owner rejects infinite spread before shader
creation/writes and names each failing argument and allowed range. CPU regression
and research are in size-restore.md. All five pixel GPU suites pass; the palette
suite has 20 exact checks with zero wrong pixels or validation errors and two
shader modules compile. No build-time shader transformation or speed claim is
introduced. All seven README examples run in the browser with zero failures.

### Section 5 evidence: RT cutout coverage

Optional bvh/alpha-triangles preserves source-face UV/material/instance provenance;
ordinary worldTriangles gains no UV/range allocation. modelAlphaMasks supplies an
owning primitive lookup. bvhWGSL's named candidate predicate runs before closest
or any-hit acceptance, retaining farther and coplanar candidates after a hole.
Optional shadows/rt-alpha owns one packed storage image alongside its RT tree.
Core and stage are unchanged. Five fragment storage buffers are required; lower
tiers use the named map fallback. Repack after topology, UV or mask edits.

All 379 bvh/shadows and included integration CPU tests pass, including malformed
input, independent wrap/factor/cutoff/UV results, affine overflow, real-model leaf
permutation, restore/fallback/limits and partial resource cleanup. The new real-GPU
proof compares closest/any and rendered fragment visibility against AlphaRaycaster
for 1,020 rays in each of two UV configurations, with resources set up twice.
The public Shadows.attach proof retains the complete 61-face standard model and
checks actual receiver pixels: 968 default and 1,448 rotated holes are lit where
the opaque control shadows them. Both resource restoration and map fallback pass.
Fifteen attached-scene shader modules and four direct-test modules compile without
errors. The first attached test's infinite reach correctly hit the opaque backboard;
its revised finite reach and separate full-distance fallback oracle measure the
intended foreground shadow, without changing geometry or acceptance thresholds.
Research and reproduction are in skip-gaps-research.md and whitepaper/reproduce.md.

The production TextureTransformMultiTest GPU gate also passes its independent
baked-UV and rendered-pixel comparisons. Khronos issue 1563/PR 1624 resolve the
overview-matrix discrepancy; the earlier sign allegation is withdrawn without
changing implementation signs. Source pins and actual production results are
retained in whitepaper/results/rt-alpha-texture-reference-20261109.json.

Item 2 landing checks: all 15 registered shadows GPU scripts and the bvh browser
suite pass, including the new two RT-alpha scripts. All 13 bvh, 15 shadows and
3 umbrella README examples pass across the preserved run and failed-only rerun.
The shadows gate is explicitly a pass after a driver reset: 14 examples passed,
ordinary RT requestDevice hit nvlddmkm event 153 at 16:05:40 EST, and only that
one example ran again and passed. Its event evidence is retained in
whitepaper/results/rt-alpha-readme-reset-20261109.json. No traversal/shader
assertion failed, no known-failure exemption was added and no tolerance changed.
Lint, hygiene, quality and CPU package tests pass. The earlier complete verify
passes 13,585 tests with zero failures/skips (repair-api-fullverify.log); it is
preserved rather than replayed, as requested. No benchmark or timing gate ran.
The final main rebase inherits only unrelated pixel, tracer and sciviz work;
own bvh/shadows/umbrella source and passing GPU inputs are byte-identical.
Inherited packages were rebuilt, then genuine paired entry/network records
measure 0986b11d2, dirty=false, followed by API generation. Core plus stage stays
23,924 B; alpha-triangles is 1,125 B and rt-alpha 8,739 B, without raising any
existing ceiling. Logs: test-results/skip-gaps/item2-*.log.

### Section 5 evidence: named TRS results

Size-restoration finding 6 restores the math/quat ok-discriminated named result
and migrates exporters, gltf, gltf-pro, loaders, rigging and scene together.
The finite TRS calculations and caller shear tolerances are unchanged. Infinite
column lengths/determinants now produce the documented singular result before
normalization. Named-shape, rotated/reflected recomposition, shear, singularity
and non-finite regressions are in packages/math/test/split-trs.test.js. This is
CPU matrix evidence; no core, rendering algorithm or speed change is claimed.

The narrowed-build scheduler also retains transitive dependency paths through
prebuilt unselected packages; it cannot start a selected consumer while a
selected provider replaces declarations. tests/package-order.test.js covers this
at one and three jobs without time assertions. Research and the real partial
build reproduction are in size-restore.md. Runtime package bytes are unaffected.

Finding 6 validation retains all 13764 unit results (the sole stale generated
llms artifact was regenerated and only its failed case rerun), all consumer GPU
suites, and 112 of 121 README examples with nine prior known failures. The
confirmed driver-reset interruption and failed/remaining-only GPU completion
are recorded in size-restore.md. Fresh combined entry/network records preserve
current-main sciviz/BVH/shadow work; merged size, API/record and documentation
checks pass. Core plus stage remains 23924 B, with no timing claim.

### Lower-tier package precision evidence (Batch 273)

The layer's seven package scenes compare full, half-float and LDR under masked
extensions on the same real GPU. Core, shadows, virtual shadows, material meshes
and instances, and culling are identical on both lower tiers. Bloom/Tonemap is
identical on half-float; LDR's clamped HDR scene capture exceeds the unchanged
pixel rule (5.322265625 percent over 2, mean 2.09423828125, maximum 6). PostStack
requires half-float for HDR/display stages before attaching effects or allocating
resources, and rechecks after releasing resources on device restore. LDR-only
stacks remain usable. The layer and package share one structural requirement
helper; post imports no compatibility-layer runtime. CPU tests cover refusal,
resource ownership and continued supported tiers. Other package entries, standalone
HDR effects and physical lower-tier/browser measurements remain outstanding.

Standalone Bloom and SSAO were then measured on the same fixture. Both miss the
LDR rule (Bloom mean 1.685546875, maximum 7; SSAO mean 8.579345703125, maximum
108), while half-float passes and LDR-only FXAA remains identical. Their resource
initializers use the shared requirement before allocation, with restoration
cleanup tested, including SSAO's GTAO subclass. Bloom's image encoding path is
covered by the same initializer. Only the measured scope is claimed; other
standalone effects and package features still need equivalent evidence.

Batch 56 reflection-shapes fixture follow-up: the complete environment GPU gate
exposed TypeError (sceneOf missing) in the shader-only fixture, after its GPU
comparisons had passed. That fixture now uses the real engine already created
by the page and asserts registration plus detachment in both blend modes. The
unchanged sphere/box comparisons and real room bake pass under the shared GPU
lock. The red and green logs are test-results/56fix/resume-gpu-environment-test-
reflection-shapes-browser-10.log and resume-reflection-shapes-green.log.
The complete environment acceptance still requires the remaining package GPU
and runtime README gates; this fixture repair changes no rendering algorithm.

Batch 56 ownership audit also applies sceneOf-based detachment to TAA and TAAUpscale. The real engine/scene unit regression keeps GPU calls inert and proves owner registry cleanup and same-name isolation.

Batch 56 post audit: FXAA and PostStack resolve scene ownership by identity during
cleanup. PostStack also excludes a removed child's stage when its name is reused.
The real-engine scene-owner regression covers explicit disposal, scene removal,
replacement and failed setup. Package GPU/README acceptance remains pending;
this adds no rendering pass, shader change, speed claim or core change.

The post audit extends the same regression to 22 other classes, and verify now
rejects direct engine.removePlugin cleanup in post sources. DepthTexture removes
its registered wrapper before releasing its unregistered SceneTargets helper.
Proof hosts reflect the actual ownership API and registration-before-setup order;
GPU-call parity and all original assertions remain required.
CPU audit evidence: 167 post tests pass with zero skips, including both explicit
disposal and owner removal for all 22 classes; all 20 current GPU-recorder proofs
pass without changing stored call sequences or tolerances. Lint, hygiene, README
type checks and size measurement pass. These recorder proofs use no physical GPU.
Browser package gates remain pending under the coordinator's CPU-only restriction.

PostStack peers DOF, Autofocus and Tonemap now resolve sceneOf for explicit
disposal. Their package scene-owner regressions use real registries with inert
GPU resources and check direct disposal, owner removal, same-name isolation and
replacement. Per-package source guards run in verify/check:merge. Their physical
GPU and new README-runtime acceptance are pending the browser teardown repair.

Creative's PostProcessing and Painterly now detach by owning-scene identity.
PostProcessing restoration calls resource release without removing the plugin;
explicit disposal removes registration and passes before releasing resources.
packages/creative/tests/post-owner.test.js covers restoration and secondary-scene
disposal, owner removal and replacement. GPU/README acceptance remains pending.

The PostStack peer audit includes WideAngle, WideAngleCube and NodePass. Their
per-package ownership regressions prove default/secondary isolation, restoration,
replacement and borrowed cube lifetime. tests/post-stack-owner-contract.test.js
scans optional source files implementing joinStack and rejects direct active-scene
plugin removal; verify/check:merge runs it. GPU/README acceptance remains pending.

Post-audit CPU evidence after rebasing onto origin/main 99b7dafec: 784 scoped
tests pass, zero failures/skips, including every post/dof/tonemap/creative/cameras/
shader package test and the original repair regressions. All 20 current recorder
proofs pass. Lint/hygiene, 888 API reports (8,641 exports), 1,125 README type
examples and all quality gates pass; 971 size ceilings stay unchanged. NodePass's
backend and kind diagnostics retain their remedies within the effects entry's
existing ceiling. Core plus stage is 23,924 B from main's approved reference fix;
this lane changes neither core nor stage. The CPU-only hold has ended: main includes teardown repairs cf699846f and
20375ea56. Full verify passed on dfd006c47 over f13245ca3: 13,675 tests, no
failures/skips, 308.8 seconds, without an outer GPU lock. Main now separates
speed assertions from correctness. Lint/hygiene pass; physical GPU/README
acceptance is still pending as detailed below.

Batch 56 resumed GPU evidence: ground-browser --studio --compat passes its
seven assertions and browser teardown. All eleven environment entry-browser
proofs pass after correcting the reflection-shapes fixture to use the real
engine; the native mirror suite passes all 65 checks. The compatibility mirror
suite stops on a 4x-MSAA refractor exact-value mismatch of 0.000244140625. Its
root cause remains open in known-bugs.md; fresh and full-prefix diagnostics that
produce exact equality do not clear that failure. Later mirror/review-pixel,
fog and runtime README steps were not executed. No repair is accepted or pushed.

Batch 56 coordinator follow-up: rebuilt plain origin/main 7289abf3b passes all
65 compatibility mirror checks. The first three repairs also pass the full
65-check suite; the scene-ownership and all-five checkpoints pass the unchanged
exact 4x glass assertion with its complete prefix. An instrumented capture on
the full local branch passes and retains 97 GL calls/readback diagnostics.
These passing diagnostic checkpoints do not clear the earlier 2^-12 failure:
no differing texel or causal commit has yet been reproduced. After autosquashing
the reflection-shapes fixture repair and rebasing onto 9b62132bb, a new 64-pair
diagnostic reached its 105-second shared-lock limit, was killed and released
the slot. It has no completed result and cannot support acceptance. The limit
is not a speed budget; no existing assertion, tolerance or gate was changed.
Fresh post-rebase CPU checks and remaining package GPU/README gates are still
required. No core/stage edit, exclusive hold or push is included.


The bounded follow-up now reproduces the wrong value in 1/12 pairs, with raw
coordinates retained. A second experiment also sees the same 24 components in
1/12 pairs: identical camera/mesh uploads, identical repeated downloads of each
image, and differing raw GPU FLOAT values before CPU half conversion. A reduced
glass-only sequence reproduces it without the earlier mirror/TAA prefix; its
comparison report survives, but cleanup hit its separate run limit. GL-call
instrumentation suppressing the mismatch is diagnostic evidence, not a pass.
The inherited verify has one excluded-path documentation failure, already fixed
on main and checked by its original regression after rebase. Its other 13,704
tests and prior chain results are reused; full green acceptance is not claimed.

### Section 5 evidence: remaining terrain registration owners

The remaining seven terrain plugins now resolve their registered scene by
identity on explicit disposal. TerrainStream also disposes its owned terrain;
TerrainBlend and TerrainSculpt keep borrowed registrations intact. All 11 terrain
EnginePlugin classes have a source guard in verify/check:merge. The new real
engine test has seven failing direct cases before repair, seven passing owner
removal controls, and 14 passing cases after repair. The package passes all 107
units; terrain/SSR keeps the same 6,458 recorded calls. GPU/README acceptance
is pending. Core, stage and rendering algorithms are untouched. Research and
retained fixture/infrastructure failures are documented in clean-room.md.

### Section 5 evidence: ComputeFrame disposal

The frame entry's disposal now resolves its actual scene registration before
removal. Its real-engine regression covers direct and owner removal, restoration,
same-name default preservation, replacement and context/array release. Both
cases and all 111 compute units pass. The shader/compute source guard covers
this EnginePlugin in verify/check:merge. No shader arithmetic, core or stage
change. Focused and complete GPU/README results are recorded separately.

### Section 5 evidence: compute mixed speed gate

The compute browser driver now forwards the central build/release phase into
its page, records it in its receipt and defers embedded throughput and hardware
calibration blocks. Original speed scenes and assertions remain in the named
release suite. All value/error checks stay active, including exact direct
SAXPY/grid outputs at every original candidate and unchanged 300,001-element
integer kernels. Clock/cache semantics retain scripted-device unit coverage.
The AST regression protects every timing call and the explicit set of deferred
callbacks. It fails against the parent. Research, scope and retained measurements
are in clean-room.md and work-lists/speed-phase.md. No speed work ran here.

### Batch 56 continuation acceptance snapshot (2026-11-09)

All 11 terrain owner repairs pass 107 units, all 15 package GPU commands and
16 runtime README examples. ComputeFrame passes 111 compute units, the focused
native/compatibility dispatch/owner proof and the complete 132-check browser
suite (413 shader modules, no errors). All 21 compute README examples run.
Throughput/calibration measurements are deferred; correctness candidates remain
live. The 24 focused metadata/source/policy tests pass, as do lint (120 existing
warnings), hygiene, all five quality gates/974 entry ceilings, 1,134 README type
examples and API update (891 entries/8,651 exports). Core plus stage remains
23,924 B; no new ceiling is raised. These are local results, not landing or
combined hunter acceptance. Full verify remains the inherited result recorded
in the [gate receipt](../whitepaper/results/batch-56-owner-gates-20261109.json); no second full verify ran.

### Section 5 evidence: readable Unity support delivery

Size-restoration finding 7 removes the C# compactor from exporter packaging.
Canonical, generated and delivered UTF-8/LF bytes match exactly, including
comments and layout; their manifest lengths and SHA-256 hashes match each file.
An isolated generator fixture preserves directives and interpolated, verbatim
and raw strings without imposing a partial C# grammar. Native source is unchanged;
this is source-delivery evidence, not a new native Unity execution claim. The
existing Unity optional entry embeds the payload; only its ceiling grows.
Research, tests and bytes are in size-restore.md and limits.md.

Finding 7 validation passes all 13778 repository unit tests after the indexed
deletion is staged and only failed/unrun verify steps are resumed. The exporters
GPU suite passes, as do 33 of 35 README examples (two prior known failures,
including the previous asset-profile example, remain unchanged). The new source
example passes. Combined-build entry/network evidence measures the retained
8b5c04aab implementation commit, followed by API/llms generation; merged size,
record/API and documentation checks pass. No native Unity or speed claim is added.

### Review 99 composition and section 5 evidence

Optional tracer entries now export validated feature factories. /compose owns
the root lifecycle and applies transforms in a fixed resampling/mesh/media/
guiding/spectral order. Feature interfaces carry scene conversion and optional
geometry preparation as well as WGSL specialization, so RGB media and mesh
storage survive scene updates, captures and device replacement together.
The root imports no feature. Media vectorizes the already-installed RIS and
mesh shadow code; triangle markers never enter RIS voxel-frame lookup.

CPU evidence covers all 32 subsets, input-order invariance, exact standalone
shader equivalence, atomic replacement, caller-array isolation, disposal and
replacement-device specialization. The registered test:gpu:compose-native and test:gpu:compose-compat suites add
analytic camera attenuation for all 32 subsets and interacting RGB RIS shadow
sampling. The failed-only WebGL2/Vulkan continuation now passes all 32 subsets,
IDs, RGB RIS shadows and atomic replacement within the unchanged 12-minute lease.
Native transport/AOV proofs are retained without repetition. The old timeout has
no phase record; it cannot be attributed to ANGLE D3D11. An isolated resampled
README diagnostic runs on Dawn and passes its unchanged 20-second deadline;
its trace compile takes 15.5 seconds and its capture 0.13 seconds. The actual
README runner selection also passes 1/1 at its unchanged deadline. These are startup diagnostics on a busy
machine, not speed claims. Triangle emitter NEE and expanded mesh guide tables
remain open. Evidence: whitepaper/results/review-99-compose-20261109.json.

### ComputeFrame GPU registration repair (review 99 integration)

The inherited scene-owner-browser.mjs was tracked but absent from the compute
manifest, so the whole GPU planner rejected every package. Register test:gpu:owners
in compute; its existing test passes native and compatibility exact four-step
values and disposal/scene isolation. The new package regression pins the planned
command. The original metadata run had 28/30 passes; its two planner failures are
repaired by the failed-file-only 5/5 continuation. All five quality gates pass.
No rendering source, limit or assertion changed. The earlier full verify and
its repaired scheduler files are retained; no new full verify success is claimed.

### Section 5 evidence: stats registration owners

Stats, FramePhases, PipelineCompiles and FrameBeacon now resolve their registered
scene before direct disposal. Their engine/device observations retain their
existing scope; this does not add scene-isolated profiling. The real-engine CPU
regression has four failing direct cases and four passing scene-removal controls
before repair, then eight passing cases. It covers restoration, same-name default
isolation, store/DOM release and stale disposal after replacement. A source guard
covers all four EnginePlugin classes. Package and guard checks pass 95/95.
An incomplete-double run was killed at its five-minute hard limit; cleanup had
stopped at missing sceneOf methods. Explicit fixture registration contracts fix
that cause without weakening assertions. GPU/README and closing gates remain
pending until their receipts are recorded. No core/stage or timing claim.

### Section 5 evidence: reachable ComputeFrame owner gate

The real GPU plan includes compute/test:browser:scene-owner in a shared slot.
Its package command establishes the repository server root. All 1,024 values
are checked after each of four exact dispatches on native and compatibility
backends. Complete compute browser acceptance remains 132 checks / 413 shader
modules / zero errors; 21 runtime README examples pass. The first package-context
attempt's HTTP failure is retained, then its root cause is corrected. The fixed
wait baseline and numerical assertions are unchanged.

### Section 5 evidence: planner regression initialization

The real-plan regression now registers after its awaited planContext is
initialized, so Node cannot execute it in ctx's temporal dead zone. Its complete
export-only affected-set and umbrella full-set assertions remain unchanged.
The complete failed gate files plus compute units pass 244 checks after the
planner and ComputeFrame gate repairs. The once-run verify failure is retained;
this is corrected-step evidence, not a second full-green verify claim.

### Section 5 evidence: completed stats owner gates

Stats closing acceptance: the collected verify on the current-main stats rebase completes with 13,864 of 13,881 repository tests passing, 17 failures and zero skips. Missing ComputeFrame GPU-script wiring, a fixed-frame workload classification and a pre-initialization planner test reference cause those failures. The repairs pass all 244 checks in the complete failed test files plus compute units and the new gate regression. The complete compute GPU suite, strengthened owner proof on both backends and all 21 compute README examples also pass. Every other verify step passed; no second full verify or fresh all-green full-run claim is made. The original process disappeared without a result, so its incomplete log is retained without a pass claim. The single replacement finished within its 40-minute bound. The real-GPU stats script passes, including eight owner cases, two shader modules and zero compilation errors; all eight runtime README examples pass. Stats source is unchanged by the exporter/documentation-only rebase. Lint and hygiene pass with 120 existing lint warnings; entry ceilings are unchanged. [Durable receipt](../whitepaper/results/batch-56-stats-owner-20261109.json). The wider owner audit remains open.

Stats integration onto main 1aa76ee38 preserves the upstream compute/test:gpu:owners
registration from 39fb88cf9. The overlapping local manifest command is removed;
its shared/rooted-command guard now pins the upstream command. Both regressions
and the stronger intermediate dispatch assertions are retained. Intervening main
changes do not alter stats or core source.

### Section 5 evidence: subset-enumeration gate repair

The latest-main affected run passes 339/340 checks, with only the newly inherited
32-subset composition fixture misclassified by the fixed-wait heuristic. A
regression reproduces the classifier error and rejects five actual/non-input
wait forms. All ten fixed-wait tests and the complete repository scan pass after
the correction. Browser fixtures, numerical checks, wait baseline and timeouts
remain unchanged. This corrects the sole failed affected step; it is not a new
full verify run or a GPU execution claim.

Final stats integration onto main 449dd9676 preserves its materials and other
owner checkpoints, compute native opt-out and subset-enumeration explanation.
The queued compute/test:gpu:owners command passes both backends and releases its
shared slot; elapsed time includes its FIFO wait. The earlier proof ran without
an outer compatibility shim, so the explicit native opt-out retains its setup.
No runtime stats/core/compute source changes in this last rebase.

### Section 5 evidence: batch 273 dispersion fixture

The canonical dispersion GPU leaf explicitly selects native and full compat,
with distinct captures/reports and an optional backend diagnostic selector.
Caller Fresnel reference editing compares shallow values/resource identities;
it no longer serializes the device graph. Full native: 278 checks/254 captures,
all passing. Full compat: same complete grid, one exact 4x live-reset failure
(10 HDR channels, max 0.000244140625); original scalar-IOR, allocation, binding,
restore and 1x/4x bars remain unchanged. Failure 9 is still open, total closed
2/26. A killed combined run is retained separately from the completed assertion
failure. No runtime/core/stage change or size-ceiling change; root gzip 23,924 B.
Research, defect, reproduction and durable summary: clean-room.md,
known-bugs.md, whitepaper/reproduce.md and
whitepaper/results/batch-273-dispersion-checkpoint.json. The job 2 checklist in
work-lists/batch-273-browser-matrix.md records real Windows browser availability,
the Firefox spawn refusal and the exact external device/access needs.

### Section 5 evidence: recorded colour-map precision

Size restoration finding 8 preserves all published decimal RGB rows for the
five recorded sciviz maps. Independent digests pin every table; tests cover
all 1280 samples, adjacent interpolation, reversal and sRGB/linear float32
output. Sampling stays synchronous; only documented GPU/CSS boundaries
quantize. Optional entry ceilings grow instead of adding a data loader for
size. This is numeric precision evidence, without a new perceptual display or
speed claim. Research and measured bytes: size-restore.md and limits.md.

### Section 5 evidence: affected-plan setup and combined restoration build

The affected-plan regression now completes its asynchronous context setup
before registering tests that read it. A named planner regression also pins
the inherited compute ownership GPU leaf; the concurrent main registration
and exact four-step/native-compatibility oracle are preserved. The initial
full verify's successful steps and 13842 unit passes are retained; failed and
unrun unit cases pass scoped continuation. Details and standards:
[verification repairs](../verification-repairs.md). No scheduler assertion,
production slot policy or timeout is loosened. A combined post-rebase build
passes, followed by genuine paired measurements and generated API/llms records;
sciviz sizes and the 23924 B core plus stage remain unchanged.

### Section 5 evidence: batch 171 LIC after published colour precision

The integrated optional LIC entry uses main's full published colour-map decimals. The unchanged convolution
shaders retain analytical box/circular, missing-data, anisotropic slice, mixed-magnitude and exact restored
image assertions on WebGPU and real WebGL2 compatibility. Current source c1a799e75 has clean, genuinely
regenerated entry/network records: LIC 23,461 B (previously 10,429), optional ceiling 24,165 B (previously
10,517). Keeping complete shared data avoids a loading contract solely for optional size. Root 50,303 B,
flow 8,665 B, native driver 4,476 B and core/stage 23,924 B. No core/stage source or timing claim changes.
Prior full verification and unaffected package checks are retained; closure records distinguish affected reruns.


### Section 5 evidence: Save factory scene ownership

Save's 16-case real-engine regression is part of its normal package tests and
therefore check:merge/verify. The parent produces 13 failures (the original six
secondary failures plus partial factory, helper, collision and identity cases);
the repaired package passes all 112 units. Setup and rollback use a temporary
public scene scope, never a proxy or private active-state mutation. Exact-instance
compensation preserves replacements; nested factory passes keep their own graph
owner when the temporary scope leaves. Core and stage are untouched. The Save
browser engine gate additionally renders a factory-owned secondary-scene box,
checks its pass survives scope removal and checks failed state removes both mesh
and pass while retaining the default scene's sentinel. GPU acceptance is recorded
separately from these CPU assertions; the wider owner audit remains open.

Save GPU acceptance: all four package browser commands pass. The original real
Knight/shoe/clone comparison remains exact (zero differing components); the added
secondary factory proof yields 484 red pixels, one pass and zero leaked meshes
or registrations after failure. Twelve runtime README examples pass; no GPU
validation errors. Engine entry 8182 to 8285 B; core plus stage remains 23924 B.

The required single full verify passes in 443.5 s: 13967/13967 units, zero failures
and skips; API, quality, sizes, parity, XR records, preview contracts, both
sandboxes, README type checks, documentation links and all historical proofs pass.
Lint passes with 120 existing warnings; hygiene passes. The [Save receipt](../whitepaper/results/batch-56-save-owner-20261109.json)
retains the full acceptance scope.

### Section 5 evidence: shared points projection

Size restoration finding 9 routes CPU point projection and picking through
math/mat4 projectPoint. The owning regression compares exact x/y/depth outputs
for perspective, transformed and orthographic matrices, retains offscreen x/y,
and rejects NaN depth without overwriting caller output. The NaN case fails the
old implementation. No core, GPU math or reversed-Z convention changes.
Research and size evidence: [size restoration](../size-restore.md).


### Section 5 evidence: Quality redraw helper

The owner inventory now covers factory-created setup objects as well as explicit
plugin classes. Ten real-engine Quality regressions fail on the parent and all
91 package units pass with the local registration-identity and cancellation fix.
The normal package suite brings this class check into check:merge/verify. No
core change. The five GPU leaves now pass, including eight real helper lifetime
cases with two successful redraws and 484 red pixels in each live scene. Seven
runtime README examples pass. The exact 7 ms assertion and old-rule diagnostic
are retained in the deferred named suite while timestamp validity, tier decisions
and wrapper cleanup remain live. Affected checks pass (102 tests, lint, hygiene,
documentation, types, API and size); the single earlier full verify is retained
without repeating unaffected code, per Scott's instruction. No capture fix changed.

### Section 5 evidence: optional stage diagnostic restoration

Finding 10 preserves the stage root while restoring boolean fit guidance and
exact npm commands in optional entries. Regressions cover glTF/viewer/scene
validation and four missing viewer peers, with error type/code/help and camera
rollback. The old viewer and missing-peer diagnostics fail the strengthened
checks. Sources and measured optional ceilings: [size restoration](../size-restore.md).


### Section 5 evidence: Cinematic ownership

Two optional camera plugins now resolve their actual scene during disposal.
The real-engine suite covers default/secondary scenes, direct/plugin/scene/engine
disposal, same-name replacement and reattachment. Four parent failures become
green; all 108 package units and a class guard pass. The guard scans all sources
implementing EnginePlugin and runs in the check:merge unit inventory. The
complete GPU browser proof passes, with eight actual owner cases each drawing
484 red pixels and no validation errors. All ten runtime README examples pass,
as do lint, hygiene, API, README types, docs links and quality/size gates. Only
affected checks were rerun; the inherited single full verify is retained.

### Section 5 evidence: Controls wrappers

The shared controls base and the two GPU gizmos now retain their actual wrapper
objects. Direct cleanup resolves sceneOf(wrapper) rather than the active scene.
The expanded 81-case real-engine suite has 11 direct-secondary failures on its
parent and passes after repair. Two CAD replacement controls bring package/guard
checks to 304. The class guard
scans every Controls source and is part of the normal test/check:merge inventory.
All ten entry sizes remain within their unchanged ceilings. Public API reports
match all ten entries. The complete browser passes 17 checks, including twelve
owner cases with at least 476 red pixels, exact detachment and listener cleanup.
Three walk checks and fourteen runtime README examples pass. Only affected
gates were rerun; the inherited single full verify is retained without repetition.

### Section 5 evidence: Animator registration ownership

Five parent failures in fourteen real-engine cases cover secondary direct/model
disposal, both factories and direct dependency lookup. The optional repair passes
198 package/guard checks. A source-wide EnginePlugin disposal and factory guard
runs in the check:merge unit inventory. Final units plus asset-contract checks
pass 213 cases; all eight real-GPU owner cases pass (242 model pixels each),
the complete game browser passes and all fifteen runtime README examples pass.
The asset-contract regression checks real authored clip, marker and bone names.
The inherited full verify is retained; only affected gates are rerun.


### Section 5 evidence: batch 273 polygon offset clamp

The optional compatibility device now loads EXT_polygon_offset_clamp and replays
slope, units and the signed depthBiasClamp together. Positive clamp is a minimum
with the computed offset, negative a maximum; zero disables clamping. The cache
includes clamp and replays reset to zero. Without the extension, nonzero clamp
refuses synchronous and asynchronous pipeline creation with code unsupported and
a help link before shader compilation. Zero-clamp offset remains supported.
No core or stage source or export changed; their gzip remains 23,924 B.
Device CPU regressions fail on the parent and pass after repair (13/13 device
tests). The complete compat render-state grid now finishes 596 checks and 278
captures: all positive and negative clamp pixels pass at 4x and 1x, including
material mapping. The two high-bit stencil failures remain open for the next
checkpoint; this is not a pass of failure 10 or a suite closure.
Receipts: whitepaper/results/batch-273-clamp-checkpoint.json and local
batch-273-clamp-{before,after,render-state} logs under test-results.

### Section 5 evidence: Video overlay ownership

Video has one EnginePlugin; other entries own material-feature or media handles
and install no scene plugin. The active-name removal and missing pass view state
are repaired in its optional root. A class-wide owner guard and the extended
environment/staging/video pass-state guard run in check:merge's unit inventory.
Corrected same-frame parent GPU proof changes 4608 out-of-scissor components.
The repair passes four owner GPU cases, each with zero outside changes and
512 red pixels. All 34 units/guards, six GPU leaves and seven runtime README
examples pass. Only affected checks rerun; inherited full verify is
retained. No hunter capture, core or stage source is changed.

### Section 5 evidence: headless callback diagnostic

Finding 10 rejects invalid onError types before touching GPU globals or
creating the engine, with explicit function/undefined and recovery guidance.
The regression checks six wrong values and unchanged installation state; it
fails the old generic message. Sources and sizes: [size restoration](../size-restore.md).

Headless README closure also corrects the browser video canvas and shares the
native checker's reference preparation with the generic runner. A wrong-size
sample regression fails the old runner. Original examples execute separately
from fixture preparation; each child keeps its existing timeout/tree cleanup.
This proves executable examples, not an independent visual golden.


Size restoration shutdown follow-up: stopOwned must not poll recycled Windows
child PIDs indefinitely. It reuses the identity-aware native waiter after
native termination; a failed helper response retains unresolved PIDs. Nested
close phases name process listing/termination, process/stdio close, server kill
and client close at the unchanged hard limit. Deterministic parent failures and
59 affected cases plus the four-case failed page-ready continuation prove the
repair class. The old generic timeout cannot establish which substep stalled
in that original run; retain that evidence limit. See size-restore.md and
known-bugs.md. No full verification replay or speed measurement is claimed.

### Section 5 evidence: batch 273 checkpoint fixture acceptance

The full repository units completed 14,099 tests: 14,095 passed and four failed.
Three ViewCube integration tests failed because their single-scene EngineKernel
stand-in lacked sceneOf after Controls began resolving exact wrapper ownership.
The fixture now implements that required identity-based method, matching the
real engine; all 18 ViewCube tests pass without altered camera assertions.
The fourth failure was stale generated site/llms-full.txt after the README edit;
regeneration and tests/llms.test.js resolve it. No failed result is discarded.
ViewCube's full compat browser check also clicked a corner instead of an edge:
front() changed the camera but read CSS hit coordinates before the frame graph
published the new orientation. The fixture now renders that requested frame
synchronously before the next coordinate query. The full original browser
assertions pass afterward. No ViewCube or Controls runtime bytes changed.
Receipts: test-results/batch-273-clamp-resume-units.log,
batch-273-clamp-viewcube-{diagnose,owner-after,compat,compat-after}.log.
### Batch 133 expanded decoder evidence: section 5

The unshipped single Rust/Wasm decoder now preserves both opaque entry flavors.
All 1,937 expanded unique inputs match full output; all 1,003 accepted by glTF
match that build's output, including its method-2 difference fallback. The
214-case dual-output regression, strict prefixes, mutations and decode/free
checks run in the existing decoder package gate. The bit reader loads each
source byte once per value, with an independent alignment/cursor test. Neither
change touches core/stage, the public entry or either shipped prebuilt.

The first full verify reached 13,475 tests: 13,473 passed, two failed on stale
generated site text and inaccessible cache pointers in public records. Both
causes were repaired and the unchanged focused regressions pass. GPU attempts
failed before executing tests: bounded queue expiry and Windows mutex mkdir
EPERM under cross-session contention. Those are unresolved gates, not passing
GPU evidence. Full final verify, GPU/README, paired per-file performance, true
cold-process startup/RSS and all feature/lifecycle integration remain required.

The final full verify closes the two documentation defects: 13,476 of 13,477
tests pass, zero skipped. A separate real-browser teardown exceeds its unchanged
30-second hard budget and blocks full verify; its cause is localized to the
owned Chromium close sequence but its stalled phase is not yet isolated.
Hygiene passes after the package build; a concurrent hygiene attempt had read a
dist directory during rebuild, so that attempt is retained as a harness-order
failure. The complete warm campaign retains full/glTF losses, and the 715-input
cold checkpoint retains RSS losses. Neither is accepted away or release proof.

### Batch 133 predictive traversal: section 5 evidence

The unshipped crate adds traversal 1 from recorded black-box rules, retaining
2,160 complete full-build exact cases across six versions, split merges,
components and vertex/corner canaries. Wasm also checks 362,250 strict prefixes,
8,192 mutations and 2,000 decode/free operations. The glTF prebuilt rejects this
path; no unsupported-output comparison is claimed. The required native package
gate runs these tests, so verify and check:merge hold them. All original inputs
remain in the expanded 3,881-input manifest.

An independent work regression proves fewer seam-free mapping walks and fails
with the old scan. The paired diagnostic has no overall speed gain and retains
two small timing losses. The coordinator assigns browser pipe teardown to batch
160 and permits the optional decoder entry after non-warm gates pass, keeping
the prebuilt default while warm losses remain. Public integration, historical
predictor 3, other feature/conversion/lifecycle checks and complete cold/RSS
targets are still open. No shipping or full performance gate is closed here.

The final owned exclusive GPU session passes decoder browser and Node/glTF checks, glTF browser, glTF-pro materials, and all 17 decoder README examples (3 Node, 14 page). These still exercise the unchanged public prebuilt paths; they do not prove pending Rust public integration. The prior queued/EPERM attempts remain diagnostic evidence. The paired cold process tree was intentionally ended at the context handoff, with no surviving owned measurement processes; its code 1 records interruption, not a completed gate.

### Batch 133 optional landing evidence: section 5

Coordinator note 2 authorizes only the optional decoder landing. One Rust crate
builds one lazy Wasm for `@margoengine/decoders/draco-native`; dedicated workers
reuse the existing pool's cancellation, timeout, transfer and disposal behavior.
No core or stage change is involved. Defaults and both prebuilts remain. Native
and Wasm hostile-input regressions stay in verify; the public bridge adds frozen
point records, accessor conversion and budget checks, plus worker/production
consumer coverage in the decoder browser gate. Warm losses remain open; current
cold/RSS/startup and full historical feature inventory are not claimed complete.

The landing gate caught two omitted registrations: the new entry's transfer
budget and its two lazy runtime assets. The existing ratchet now registers only
the new 65,504 B measured entry at 67,470 B; all old limits stay unchanged. A
new regression fails before registration and passes after, also checking the
smaller Wasm and absence from the default entry. The full unit run is 13,539
passes / one missing-lazy-catalog failure / zero skips. Both assets are now
registered and sizes regenerated; its matching network record and focused rerun
remain blocked on GPU acquisition. The 20-minute exclusive queue expired before
test startup. Lint, hygiene, quality, 888 API entries / 8,646 exports and explicit
decoders/glTF/glTF-pro CPU suites pass. No GPU, README runtime or push is claimed.
Evidence: whitepaper/results/batch-133-landing.json.

Batch 133 E21 correctness evidence: decoders entry tests add 1,445 frozen opaque
metadata string cases and exact raw key lookup. All 1,613 observations are retained
in whitepaper/results/batch-133-metadata-strings.json, including 22 incomplete
trailing-group losses. No GPU, timing, core or stage changes; full metadata and
replacement acceptance remain open.

The batch 133 glTF GPU gate also found the textured pass copying a destructured
raw direction into a shader that now expects a unit light. Its package-owned
writer uses shared/unit-light.js; textured.test.js exercises the real frame
upload with ordinary, huge and tiny vectors, unchanged intensity and caller
input. This closes an alias form missed by the upstream textual writer scan.


### Section 5 evidence: batch 273 stencil reference repair

The optional compatibility replayer masks a dynamic uint32 stencil reference to
its eight-bit target before GL clamps its signed input. Both faces retain the
existing operation/mask cache and use the effective reference as the cache key.
The new recording regression fails on unmasked replay and passes after repair;
all 160 compatibility and 199 materials unit tests pass. The canonical expanded
full-compat render-state grid passes 616 checks/288 captures on physical RTX A6000,
at 4x and 1x. No assertion or tolerance changed. Native evidence and remaining
gates are recorded in whitepaper/results/batch-273-stencil-checkpoint.json.
This closes only failure 10 once the checkpoint gates land; other failures remain
open. No speed claim, core/stage runtime or public export change.

Stencil checkpoint acceptance: the one complete verify invocation passes all
14,170 repository unit tests, zero failures or skips, and every chain. Lint,
hygiene, all 160 compat units, 199 materials units, both full 616-check GPU grids
and 14 executable README examples pass. Historical failed README setup and
negative regression receipts remain retained. Core/stage is 23,950 B after the
upstream unit-light repair; no core/stage runtime edit belongs to this fix.

The latest-main stencil integration rebuilds on 70f726965 (optional Draco and
the package-owned textured-light writer), preserving both shared-doc additions.
API matches 901 entries/8718 exports; core/stage remains 23950 B. The combined
713-test affected run passes 712 and finds only a stale generated llms-full.txt.
Regenerating after the combined build passes all nine guide checks. Optional
entry sizes are unchanged from the stencil measurement. The original full
verify passed 14170/14170; it was invoked once, not replayed after this rebase.
Final compat device GPU acceptance is retained in the stencil receipt.

### Batch 134 consumed-output lifetime and raw-level capacity (report25)

The private draft frees a consumed output before allocating its replacement.
A thread-local allocator regression fails before repair at589824 live bytes
and passes at327680 for the same three complete256x256 RGBA decodes. This
proves one removed overlapping output allocation, not a timing result or a
complete explanation of process RSS. A separate checked raw-level reservation
accepts the valid1x16384x2049 layout (134283264bytes) without lifting the128MiB
compressed-input cap. Actual Wasm decodes all2049layers exactly; malformed
layouts, invalid counts and pixel-limit violations refuse before allocation.

The original173 fresh-process pairs now record0 RSS and0 Wasm high-water
losses, with all2289 scalar image hashes unchanged and every output retained.
Previous failed pairs and every current pair remain in the receipt. No forced
GC, normalization, timingAB or measurement repeated for a better number.
BC outputs remain identical across98pairs/1296images; the11 original-source
losses remain open under BC1 RGB / BC3 RGBA per-file SSE, new<=old, zero
tolerance. All11 improve payload SSE; zero added payload error still loses
7/98 source pairs. That is diagnostic evidence, not authority to extend
Scott's scalar ruling to color and not a lower bound for arbitrary encoders.

Current private draft204197raw/73198gzip9B (previous203110/73104), not the
final optional entry. ETC2/EAC still lacks hardware upload proof: OpenGL
selected software and was refused; real A6000 D3D11 rendered its exact
control but has no ETC extension, so0/993 uploaded. Prior Vulkan loading
failure remains unresolved. Remaining formats/public integration/prebuilt
removal and speed-phase timing debt remain open.
[Full receipt](../whitepaper/results/batch-134-allocation-checkpoint.json).

Batch133 resource evidence separates lifetime process peak RSS, linear-memory
capacity and public work counts. The child harness uses an explicit frozen
Wasm so builds cannot remove its input; draco-resource-harness.test.js proves
working-directory/dist isolation in verify. RSS116/113 losses and historical
width/predictor gaps remain open in the resource inventory; this gate work
adds no core/stage or default decoder change.

Resource acceptance also rejects a changed opaque variant on resume and
returns a failing status for every retained RSS loss without taking another
sample. Both paths have before/after regressions. Dedicated dist readers
must start after verify finishes its build; the repaired own driver enforces
that barrier after transient gltf-pro/README import failures.

### Section 5 evidence: Chromium teardown phase tracing, recurrence open

`MARGO_TRACE_SHUTDOWN=1` logs separate start/completion/error timestamps for
native termination, process/stdio close, Playwright server kill and client close,
WGSL report settlement, README page closes and server closes. Owned Chromium
also logs launch, exit and each pipe's close with current process/stream state.
Tracing is disabled by default and does not replace or shorten any wait.
The single README, 25-example sciviz README run and native/compatibility 30-check
sciviz cases passed on the hunt branch. These controls do not establish the
cause of the historical process/stdio close recurrence. Keep that defect open;
the trace value/error and scheduling tests validate diagnostics only.
The final rebuilt control under concurrent verify load recorded closed pipes
before the browser's delayed exit; process/stdio close took 7,974 ms and complete
cleanup 9,691 ms. These are diagnostic phase observations, not benchmark results.

### 5. Batch 265 optional React package bindings

Native line, point, selection, LOD, splat, viewcube and camera APIs now have independent React entries. No core/stage
change or new GPU maths. The binding gate compares paired native/React pixels on the existing real capture excerpt and
checks LOD selection, outline pixels, viewcube navigation and lifetime cleanup on WebGPU and the compatibility device.
StrictMode unit coverage checks per-Scene plugin ownership and nested camera restoration. Independent rival pixel
comparisons are not supplied; the public behavioural contract comparison is recorded in clean-room.md.

### Section 5 evidence addition: batch 268 XR pointers

World rays use the existing GPU selection route with a camera owned by each
query. Proximity transforms triangles to world space before nearest-contact
queries, preserving distances under nonuniform scaling and instancing; deformed
models supply explicit GPU geometry snapshots. No core, stage or shader math
changes. Unit cases exercise delayed reads, short native presses, capture,
tracking loss, input removal, session end, abort and React parent bubbling. The
new real GPU leaf runs on WebGPU and WebGL2 compat and uses a licensed standard
model. Physical Quest and Android evidence remains missing (docs/xr-device-runs).

The React browser fixture now installs the compat XR binding before ordinary
XR preparation and labels its simulated projection-image binding for the active
device. Its existing stereo/callback/teardown assertions stay intact on both
backends. The dedicated webgl2-compat/test/xr-browser.mjs separately checks
installXR's actual XRWebGLLayer bridge against native images. The native-only
modern-xr fixture deliberately cannot stand in for that compat bridge.

### 5. Batch 265 Instances evidence

React Instances reuses core's existing same-geometry batching and native entity IDs. No engine, kernel, backend or GPU
maths changes. Real-engine CPU tests inspect per-instance matrices, materials, draw batches and Scene membership.
The paired browser gate uses the existing CC-BY-4.0 Cesium Box fixture to compare native and React pixels and draw
counts, plus exact-instance GPU pointer delivery, range suppression and named Scenes on WebGPU and compatibility.
No wall-clock benchmark or custom-shader instancing parity claim is made.

### Batch 197 transition evidence (section 5)

Camera maths for controls/transitions is outside core and stage. Quaternion frame
interpolation, angular world-up interpolation, logarithmic distance/zoom and
analytic frustum fits are covered by 324 controls unit cases. Eight actual GPU
cases render fits and interrupt them on both WebGPU and the WebGL2 compatibility
renderer, without validation errors. Existing gizmo, input and scene ownership
GPU checks also pass. No new shader or hardware tier requirement is introduced.
The evidence is correctness only; no wall-clock benchmark or speed claim was run.

### Section 5 evidence: Chromium teardown moved to a browser host (2026-11-10)

The process/stdio close recurrence is explained and worked around, not fixed in
Margo: after `TerminateProcess` the browser's exit code is set within 65 ms and every
owned pipe closes within 1 ms of its release, but Windows signals the process object
only once the kernel has torn the process down: 65 ms to 1.2 s beside the batches,
8.7 s beside verify, over 30 s in the failures (docs/known-bugs.md, "Open, outside
Margo"). The suite's event loop was never blocked and Playwright started no helper
program. `scripts/support/browser-host.mjs` now owns Playwright's browser server in
a process of its own; a suite ends the browser through it, is acknowledged in
milliseconds, disconnects and moves on, waiting for the proof of teardown only up to
2,000 ms. Survivors past 120 s are recorded in
`test-results/browser-host-survivors.log`. Evidence: the 40-cycle loop under load in
docs/known-bugs.md, `tests/browser-host.test.js`, `tests/browser-teardown.test.js`.
Missing: a run on the laptop and the Mac mini, and the cause of the kernel's delay.

#### Batch 197 globe control evidence

Reference ellipsoid rays, geodetic-normal transport, local-horizon tilt and radial
altitude clipping live in the optional controls/globe entry. CPU fixtures cover
WGS84 and triaxial radii and a live floating-origin rebase. The optional-controls
browser gate checks anchor projection, actual foreground rendering and zero
validation errors on WebGPU and WebGL2. It does not establish terrain collision
or full rival navigation parity beyond the batch row. No core/stage code changes.
### Section 5 evidence: optional tile styling (batch 239 job 1)

The streaming renderer now exposes a content decorator without importing its implementation. `tiles/style` evaluates property expressions on the CPU and writes existing optional-package PBR vertex colours, instance tint/matrix rows and point colour/size buffers. Show=false discards mesh surface fragments, degenerates hidden instance transforms and assigns hidden points zero size; alpha uses the native PBR blend path. Bindings retain authored arrays for restoration and declare added GPU buffer bytes to tile eviction accounting. The interpreter never executes supplied JavaScript. Evidence: packages/tiles/tests/style.test.js covers language evaluation, binding updates, invalid styles and restoration; the tiles browser fixture checks two visible red and two hidden features of the real CC0 structural metadata sample. Both rendering backends use the same binding path. No new rendering backend, core maths or speed claim.


#### 5. Batch 273 XR canvas mode persistence

Compatibility presentation preserves a canvas's first output mode across XR
and desktop device configurations. Both transition directions have an owning
unit regression in canvas-present.test.js, which fails on the old code. The
root XR fixtures surface engine/GPU errors while waiting for frames, rather
than waiting forever after XR ends on an error. Simulated stereo sessions are
rendering/lifecycle evidence, not headset evidence; the dedicated compatibility
XR test owns the XRWebGLLayer framebuffer comparison.

### Batch 171 climate input evidence

The optional formats layer reads CDF-1/2 hyperslabs and adapts the existing VTK XML decoder. Numeric data and
intact volume topology feed the existing volume and grid renderers; core/stage, GPU maths and backend shaders
are unchanged. Analytical byte-layout tests plus 200 pinned NOAA samples cover six owner-written files.
The formats-browser leaf exercises both backends and compares identical-source image hashes by renderer kind.
HDF5, oriented-image resampling and general solver rendering remain outside the claim; see docs/limits.md.
No GPU lock is taken for parsing/building or CPU tests. Runtime rendering uses the lane's single shared slot.

Batch 171 integration evidence remains incomplete: all 30 root GPU assertions pass, but the shared
Chromium launcher waits past its unchanged 30 s deadline for process/stdio close after native
termination. PID 84700 was absent afterward; exact event/handle cause remains unproved. The owning
shared-launcher repair belongs to batch 160, not sciviz. This is a failing hang and blocks landing
job 4; metadata repairs and pre-rebase GPU acceptance do not supersede it. No failed check is
weakened, retried unchanged, marked busy, or reported as a passing suite. See known-bugs.md.
### 5. Sprite slices and repeat fills (batch 245 job 1)
The optional sprites/slice entry reuses the existing sprite pipeline and frame
hook. Each image occupies up to nine stable instance slots with a common parent
pivot and sort keys. Repeat counts and phase map UVs within each source cell,
using integer loads or explicit-gradient linear sampling. Core and stage have
no changes. CPU layout and real pixel readback fixtures are in sprites/tests/
slice.test.js and slice-check.mjs; both GPU backends are required before landing.
### Section 5 evidence: batch 197 BoxGizmo

The optional controls/box-gizmo reuses controls' OverlayRenderer and tessellate paths for WebGPU and WebGL2. Exact local mesh bounds feed transformed wireframe edges and fixed CSS-size handle triangles; no core or stage change. Its optional-browser fixture checks both backend colors, triangle counts and edited transforms. Original-pose CPU tests cover parent-frame pivot preservation, three rotation axes, snapping and cancellation. Device restoration releases overlay GPU resources through the package plugin. Bounds do not include child meshes, skinning or morph deformation.
### Section 5 evidence: optional FSM views and SCXML (batch 250)
FSM optional entries retain CPU state-machine semantics and add no core/stage or shader dependency. Unit evidence covers payload delivery, final/always macrosteps, task cancellation/generation isolation, DOM view ownership and bounded XML conversion. The package browser gate renders the Inspector-compatible view and checks default DOMParser round trips in normal Chromium and forced compatibility mode. The view has no backend-specific GPU math; these captures establish DOM placement, live trace/history updates and cleanup, rather than renderer numerical accuracy. XML execution, a complete SCXML processor and remote actor inspection are outside these claims. README work is recorded in the build-phase owed list.

### Section 5 evidence: sprite rigging (batch 245 job 2)
The optional skeletal entry owns all new transforms, IK, slots and timeline
math. There are no core/stage changes. The two-bone solver uses the cosine law
where the first bone has uniform magnitude scale; general affine hierarchies
use bounded coordinate descent and report their residual. Bezier time is inverted
before evaluating the channel value. Slot order is independent of bone order.
CPU evidence: rigging.test.js, including skin conversion regressions. GPU evidence:
rigging-check.mjs plus the existing skeletal-check.mjs, on both backends.


## Batch 252 navmesh worker evidence (section 5 supplement)

The optional navmesh/wasm entry loads one feature-local Rust SIMD raster asset and an owned CPU worker. Exact output evidence is in packages/navmesh/test/wasm.test.js and the crate's tests: byte-identical ordinary/tiled polygon files, equal reference clipping counts, cancellation/error/timeout teardown and source/artifact hash enforcement. The SIMD work proof keeps coverage, triangle order, span merging, classification and polygonization unchanged. Native rasterization uses fixed stack clip buffers, not allocations per cell. Evidence still owed: quiet-machine end-to-end speed measurements and browser/CSP hosting matrix. No core/stage or GPU backend change.
Batch 215 scroll pin evidence (section 5 supplement): packages/tween/test/scroll-pin-browser.mjs checks actual window/element layout and scroll destinations under native and compatibility browser runs. CPU fixtures use deterministic RAF clocks. Dependency VFX compatibility replay equality remains separately blocked as recorded in docs/known-bugs.md; no rendering-backend change is made by the pin entry.

## Section 5 evidence: batch 262 standalone bindings

Inspector's optional tweak entry has native DOM interaction checks alongside
rendering WebGPU and WebGL2 preview engines (test/parity-browser.mjs), plus
a forced --compat run of the same WebGPU path through WebGL2 compatibility. The browser script
is discoverable as inspector/test:browser for check:gpu-packages. CPU tests
exercise gesture boundaries, shared undo, enum identity and abort/disposal. No
core, stage, GPU mathematics or rendering pass is added.

## Section 5 evidence: inspector gizmo ownership and arbitration

The selection bridge uses existing controls rendering, including its WebGL2
compatibility path; it adds no GPU math or core API. Real pointer tests prove
rendered handles, selection retention, camera suspension and whole-drag undo.
The owner-scene regression now prevents inspector cleanup from removing a
same-named plugin in the default scene. Every gizmo plugin is attached in the
inspector's scene and is removed on abort, engine disposal or inspector removal.


### Batch 171 geographic atmosphere evidence

The optional sky/planet owner reuses AtmosphereTables and Hillaire transport for a supplied world-to-planet transform and observer. The sciviz facade inverts Figure.model, supplies ECEF solar direction from sky/astro, and shares an optional fragment appearance with geo tiles, scalar/point meshes and GPU flow. A type-only interface keeps sky out of existing root/feature imports. Each data fragment gets its own aerial segment rather than sampling an opaque globe depth at the wrong elevation. Earth polar stretch, chordal ground lighting and camera domain are explicit in limits.md.

Evidence is packages/sciviz/tests/atmosphere.test.js (independent NREL solar fixture, geodetic heights, curvature conversion and cancellation), packages/sky/test/planet.test.js (arbitrary observer, medium work caching and disposal), and packages/sciviz/tests/atmosphere-browser.mjs (NOAA flow, solar time, elevated glyphs, zero/nonzero clouds and actual device replacement on both backends). No measurement accuracy or speed claim is made. README work is deferred in readme-owed.md.


## Batch 252 border evidence (section 5 supplement)

Whole-level grids and tile contexts honor ceil(borderSize), retain their world lattice and crop tile output after filtering/erosion. Padded grids are checked against the existing 16,000,000-cell budget before allocation; the tile check also covers deferred builds. Evidence: packages/navmesh/test/border.test.js and the padded worker parity case in wasm.test.js. This changes the optional CPU build pipeline only, with no rendering/core/stage change.
Batch 255 job 2 evidence (section 5): no rendering math/backend changes. Owner playback snapshots preserve interrupted fades and ordered layers. CPU continuation/sync/rollback assertions and the save engine browser exact-pixel check cover capture and restore; changed-package native and compatibility GPU checks are required. No wall-clock performance assertion.


## Section 5 evidence: batch 262 scene editor

Optional inspector/edit composes existing geometry and clustered lighting; it adds no
GPU shader or core/stage behavior. The editor's early light update reads current local
TRS through scene/worldMatrix before the transform tick, including parents. Reversible
deletion detaches geometry and retains identity, with last-command finalization.
CPU regression tests prove prior gizmo/property undo survives deletion and history
limit eviction cannot destroy another command's retained mesh. Native and preview
browser input tests cover creation, drag reparent, delete/restore and actual light
rendering; compatibility runs exercise the same WebGPU API through the layer.

Batch 262 scene-edit gate: React after-scene material readiness now enumerates current engine.plugins values. Its former historical name matches could double-count recreated opaque-color plugins before a material installation attached. The CPU plugin-state regression and original real-pixel transmission assertion cover the repaired observation; production React and engine code are unchanged.
### Section 5 evidence: terrain projection and imagery (batch 239 job 3)

The optional tiles/imagery entry uses lazy external branch tilesets, avoiding the linear latitude subdivision of geographic implicit regions for Mercator terrain. Quantized v is inverse-projected before ECEF placement and skirts use those same positions. Metadata availability is requested before child branches are emitted. Existing glTF rendering draws the composite drape on either backend. Native Canvas 2D performs per-scanline reprojection and ordered alpha composition; no rendering backend or core code changes. CPU evidence: packages/tiles/tests/imagery.test.js covers WMS axes, WMTS URLs/dimensions, exact Mercator bounds and vertex placement, metadata pruning and cancellation. Browser evidence: the imagery case requests WMS and WMTS, checks the composited RGBA texel, and renders the real licensed quantized-mesh sample through the Mercator adapter. No timing evidence or speed claim.
Batch 255 job 1 evidence (section 5): material serialization does not alter shader algorithms. Exact compiled stage/declaration preservation is covered by CPU tests and native/compatibility material pixels. GPU-only resources require explicit application bindings rather than inference from opaque handles. The core/stage entry is unchanged.
### Section 5 evidence: batch 260 HTML texture preview
HTMLTextureGL in html/texture-gl shares rasterization and interaction with HTMLTexture and uses a native depth-writing GL pass only on preview. Browser pixels prove panel/button colours and partial geometry occlusion on WebGPU, full WebGL2 compatibility and native preview; pointer hit testing, redraw and disposal run on each. GL blending uses premultiplied source-over, the preview camera's ordinary depth and restored draw/upload state. Core and stage source are unchanged. No timing claim.

### 5. XR locomotion eye overlays

The optional XR package now provides an eye callback after scene/depth rendering and before submission on its separate and engine routes. The comfort overlay uses each projection and viewport with load/store blending and no depth writes. CPU coverage proves stable view indices, ordering, unsubscribe and disposal during a callback; a stereo pixel comparison exercises both backends/routes/eyes. Physical headset evidence remains absent. No core or stage changes or speed claims accompany this feature.

### Section 5 evidence: batch 267 live inspection
Optional mcp/live and mcp/live-host add a development-only page/Node boundary without core or stage changes. Inspector owns property discovery/validation. Canvas capture renders then uses origin-clean PNG serialization; WebGPU and compatibility each pass scene/edit/pixel/error tool proof in packages/mcp/tests/live-browser.mjs. Uncaught page/rejection/GPU errors feed a bounded ring. The host binds loopback and validates bearer, Host and exact Origin. No server-side evaluation or production auto-activation. GPU test uses a shared slot only during browser execution.

### Section 5 evidence: sprite picking (batch 245 job 3)
The optional CPU picker reuses the float32 transform packer and mask conversion
from rendering; it inverts the packed rotation and signed scale before sampling
atlas alpha. It never changes the draw list. Its pixel fixture compares every
pixel centre to the GPU image under rotated/reflected transforms, flips, camera
zoom, sorting and masks, on both backends. pick.test.js also checks quantized
zero-alpha sprites require no missing pixel page and expose underlying images.
No core/stage or backend code changes.
Mask regression detail: pixel (16,7) has centre (16.5,7.5), exactly on the circle
centred at (12,13.5) with radius 7.5. The old renderer dropped the rotated red
sprite there in both draw orders; pick-check.mjs requires red and zero mismatches.
SpriteLayer now tests builtin fragment position minus view origin. The origin
reuses two uniform padding floats; no extra uniform bytes or position varying.
### Section 5 evidence: batch 260 CSS3D apertures
html/blend draws zero RGBA over a rectangular CSS3D panel only where its scene-depth test passes, on WebGPU/full WebGL2 compatibility and native alpha-enabled preview. It shares LabelRenderer's pose, inherited visibility and near-plane clipping; layout size is remeasured each frame. The DOM stays live beneath the canvas. Browser checks cover per-pixel foreground coverage, movement/resizing, removal, visibility, native input and canvas-style restoration. Unit tests verify depth writes, replacement blending, alpha-mode preservation, ownership and the opaque-preview diagnostic. No core or stage changes, timing claim or readback-based clipping.





## Section 5 evidence: batch 262 texture inspection

Texture capture is explicit and optional, before engine/device creation; late viewers
read its weak registry. No core instrumentation is added. New texture descriptors gain
legal sampling usage for inspection without changing their source object; transient
attachments remain untouched. Preview uses textureLoad with a format-specific binding,
a mip-scoped view and explicit layer/slice, then row-padded readback into top-left RGBA8.
Integer, unfilterable float, depth/stencil and multisample paths avoid treating data as
filtered color. All temporary GPU resources release on success, cancellation or failure;
viewer outputs are suppressed from capture. Native and compatibility pixel assertions
cover the selected subresources and a real licensed texture; no performance proof.

Current evidence: native and compatibility texture pixels pass, including
stencil, depth-after-stencil, MSAA and the CC0 real-image assertions. The backend
unit regression fails before extension/aspect selection and proves ordinary-view
aspect isolation. The compatibility feature and renderer matrix also gate the
backend repair. No core or stage code changes.

- Section 5 evidence, Stats geometry (batch 264): native command wrappers count WebGPU/WebGL2 submissions with preserved receivers. CPU tests exercise topology, instances, opaque commands, multiview reset and Stats wrapper composition. Hardware proof: scripts/test-stats-parity.mjs on both engine backends. Counts describe submitted candidates, with restart/opaque limitations in limits.md; core, stage and GPU math are unchanged.
### 5. XR skinned hand ownership

Tracked world poses are converted to glTF node locals after parent worlds are staged; all 25 joints map by name. Existing optional Animation handles skin deformation. Explicit per-scene subscription owners release frame hooks and players when their model scene closes, without relying on the engine's ambient scene. Real standard weighted profile assets exercise software behavior; headset proof remains absent.

### Section 5 evidence: batch 254 optional audio parity
The four audio entries are independently optional: pan 677 B, binaural 1809 B, voices 2117 B, sprites 1508 B minified gzip. Each new size budget records the 0 B prior entry and its measured cost. Core/stage source and the 25000 B combined gate are unchanged. The audio package browser suite renders existing scenes on WebGPU, native WebGL2 and compatibility WebGL2 while Web Audio offline PCM proves stereo balance, all 16 AmbiX modes through native HRTFs, virtual phase handoffs and named sprite boundaries/fallback. CPU tests cover transport and teardown; dependent CPU suites pass. Device output, listening quality and other browser codecs remain unmeasured; no timing benchmarks run during the build phase.

- Section 5 evidence, Stats/gl (batch 264): frame GPU time is partitioned into non-overlapping EXT_disjoint_timer_query_webgl2 intervals so elapsed-only implementations support named passes without nested queries. CPU regressions cover invalidation, context restore, bounded storage, external query ownership, receiver preservation and multiview accumulation. scripts/test-stats-parity.mjs proves real asynchronous frame/main/custom-pass samples on the preview backend, with WebGPU geometry coverage retained. No core/stage or backend source change.
### 5. XR AR extras ownership and evidence

Mesh geometry and poses are copied from native frame observations; unchanged geometry retains its arrays while its pose can move each frame. Optional visualization uses package-owned normals and core Geometry through existing APIs, with an explicit scene subscription owner. Module feature failures remain visible. Persistent handles are browser/origin data, and abort cleanup preserves pre-existing or concurrently claimed handles. CPU and real-GPU stereo checks establish consumer behavior with stand-in XR observations; no sensor accuracy or cross-restart storage claim is made.
#### 5. Batch 273 scatter shadow-culling proof

The canonical shadow-culling fixture reads command buffers from the selected
implementation's owner: native cascadeCull or compatibility route.shadow.
The unchanged three-scene native and compatibility checks pass exact shadow
depth/frame comparisons and complete per-ring/per-cascade count checks, including
the CPU plane classifier and distant-tree exclusion. The fixture regression
executes the actual counts method and fails on the old native-only lookup.
### Section 5 evidence: batch 260 self-contained DOM resources
html/inline supplies inlineResources and resourceInliner; HTMLTexture's optional prepare hook runs before foreignObject serialization on both texture backends. The real browser fixture serves existing licensed image/font bytes from a separate CORS origin, including an imported font stylesheet. 1,893 selected image pixels match the direct image raster within one channel value; the embedded and live Source Sans glyph widths are exactly 92 px. Tests also cover same-origin URL resolution, fetch deduplication, CSS URL strings, SVG fragments, import cycles, errors, deadlines, cancellation and surface-removal cancellation. There is no new rendering backend or core/stage work. Performance is not claimed.


### Generated public metadata after concurrent merges

tests/generated-metadata-conflicts.test.js checks the generated API summary, public help/llms files and umbrella manifest for unresolved merge boundaries. It runs with root CPU tests in local CI/check:merge. Its actual test fails against a88cfd4fe's published metadata in an isolated worktree-local fixture and passes after authoritative api:update regeneration. Native Windows PowerShell command sequences must explicitly stop on nonzero LASTEXITCODE; an earlier failed merge helper must never be followed by staging/commit/push. All graphical source hashes and previous atmosphere CPU/GPU evidence are unchanged by this repair.

Scoped API updates now reject inherited unresolved boundaries before interpreting a table. tests/api-report-scope.test.js covers conflicts in the headline, table header and package row, with LF and CRLF. This prevents the truncated-table path from inserting duplicate package rows and inflating summary totals.
## Section 5 evidence: batch 237 assembly
The optional wfc/assemble entry creates ordinary core meshes sharing template geometry and materials; no changes to core/stage or rendering backends. Native WebGPU and WebGL2 compatibility tests assert four rendered instances in one draw. CPU tests verify 24 cube orientations plus a reflection, nested TRS, and rollback. Static glTF models are supported; animated controllers are not cloned.

### 5. XR projection scale, foveation and camera controls

Optional XR transports a validated per-session projection scale, with the compatibility bridge translating it into framebufferScaleFactor while retaining its global default when unset. Foveation writes are range checked and restored only before session end. Raw camera textures stay owned by the browser and use its XR-compatible GL context; the native WebGPU unsupported path is explicit. CPU and real-GPU stand-in coverage exists for option transport and texture ownership, while device quality/performance and actual sensor frames remain unmeasured. Core/stage bytes are unchanged.

Section 5, core version guard: core owns each engine's version/module identity and checks plugin
requirements before changing registries. The emitter freezes package build versions at plugin,
attachment and runtime-access boundaries. Packed duplicate installs and stale build declarations
are rejected with linked code `version`; matching imports remain identical. Core/stage 23950 to
24209 B, unchanged 25000 B limit. Core 21584 -> 21775 B (+191 B); the core-only ratchet
remains at the final measured size. Optional ceiling receipts are in docs/limits.md. [Design and research](../core-version-guard.md).

### Section 5 evidence: Stats panels (batch 264)

Four histories keep CPU work, frame cadence, GPU execution and memory source distinct. The optional entry composes existing collectors and keeps WebGPU pass labels with their timestamp slots; it never changes core, stage or backend implementations. Native evidence covers both renderers and a named compute pass, query availability, DOM graphs and memory; CPU evidence covers foreign timestamp ownership, unsupported devices, missing-data graphs and scene/disposal ownership. The hardware screenshot has been visually reviewed. Remaining naming and chart polish is tracked privately for the finish phase.

Batch 257 job 4 remains BLOCKED on native Safari hardware. Local Firefox 157.0 proves WebGL2 worker pixels and input transfer; Windows Playwright WebKit 27.2 proves page fallback pixels and retained ownership because worker canvas APIs are absent. Default profiles expose no WebGPU adapter. Strict Chromium assertions remain intact; browser-matrix records capabilities and asserts actual selected-path rendering. No native Safari claim.
### Section 5 evidence: inspector animation, batch 263

The optional animation panel samples existing Animation players, blends local TRS/morph poses and lets the owning Animation compute deformation. SkeletonHelper supplies current world-space joints for an SVG overlay on the primary camera. No core/stage or backend implementation changes. CPU tests cover clock and lifetime contracts; the native/compatibility browser tests use the licensed Fox asset and check a changed pose and live skeleton. Multi-view SVG placement and weighted pointer-extension properties are tracked for the finish phase.

- Section 5 evidence, batch 245 blending: optional BlendLayer partitions packed instances into ordered operator runs through protected SpriteLayer pipeline/draw hooks. Transparent multiply is an interleaved colour-only correction and multiply/source-over draw per sprite. Normal attachments retain their standard write path. blend.test.js checks order, mutation and ownership; blend-check.mjs checks 146 readbacks on native WebGPU and the WebGL2 compatibility layer, including sRGB and transparent targets. Existing sprites and dependent GPU suites gate the shared hooks. After the upstream version guard, core/stage measure 24209 B. No speed measurement.

### Section 5: signed normalized compute storage publication

WebGL2 compatibility CPU compute publishes r8snorm, rg8snorm and rgba8snorm through native signed-byte texture uploads, since those formats are not framebuffer-renderable. Written row spans preserve other texels and existing texture view version tracking. No core, stage or WGSL route selection changes. Evidence: webgl2-compat/test/snorm-storage-browser.mjs exact byte/mask/mip/layer checks, the compute-browser native/compat matrix including strict CSP, and shader/test/compute-texture-check.mjs. Sources and conversion rules are in clean-room.md. The umbrella generator also supplies the already-public XR performance alias; tests/umbrella.test.js rejected its missing source and output before regeneration.
#### 5. Batch 273 Firefox evidence
The shipped Firefox uses a package-test-owned BiDi transport with hard command and process bounds and fresh disposable profiles. Its executable is supplied only through BROWSER_EXECUTABLE. Native Chromium reference launch temporarily removes that override and restores it on success or failure. No shared browser/shutdown helper changes.
The receipt docs/whitepaper/results/batch-273-firefox-matrix.json retains the original eleven-driver sweep including failures. Supplemental cross-browser execution passes all 18 feature, 14 ordinary compute and 14 strict-CSP compute cases at their original numeric bars. Strict CSP proves interpreter loading and exactly one blocked unsafe-eval probe. Final corpus execution draws733 recorded render pipelines, dispatches477 compute pipelines and proves one required10-versus8 storage-binding rejection. Existing20 tracer pipelines retain their dedicated owner. No speed or whole-package/native-Firefox parity claim.
### Section 5 evidence: inspector WebGL2 debugging, batch 263

`inspector/gl` adds a preview-backend pass for shared wireframe geometry and existing normals, box and light helper data. Its native GL state changes are restored in finally; resources rebuild after context loss. The capture wraps existing graph passes for one frame, restores methods on success/error/abort, and uses stats/gl for asynchronous GPU intervals. Native WebGL2 pixels on a CC0 real asset and CPU failure/lifetime fixtures are the evidence. The root inspector geometry extraction changes no root behaviour. No core or stage edits; current combined root size is measured by the landing gate.

Batch 220 job 1, section 5 evidence: math/compat adds CPU-side camera transforms and geometric queries without touching core, stage, shader maths or backends. Analytic tests cover native combined matrices and separate camera matrices under both depth ranges. Existing per-type size tests stay intact because the subclasses occupy an optional entry. No GPU execution or speed claim is introduced.
# Batch 204 evidence supplement (section 5)

Sparse/interleaved export keeps matrix-column padding, normalized integer
components and vertex offsets in their original types. Streams are four-byte
aligned and split at 252 bytes. CPU tests compare every decoded accessor value,
including negative zero; existing own-package GPU checks exercise both backends.
There is no kernel, core, backend or runtime shader change. [Evidence](../exporter-accessor-layout.md).

Gaussian GLB export uses the splats package's existing covariance decomposition;
the new optional exporter serializes the ratified kernel attributes, with
linear SH retained exactly and a linear point fallback. Independent CPU loader
round-trips and the existing native/compat exporter GPU suites are the evidence;
no renderer, backend or core math changes are added. [Contract](../exporter-splats.md).

Optional exporter optimization uses accessor-backed `EXT_mesh_gpu_instancing` TRS batches, preserving each retained parent's transform and splitting reflection signs. CPU evidence covers exact emitted transforms, animation exclusion and glTF validation. The exporters browser and capture runners now accept the existing `MARGO_COMPAT=1` shim so the package's own checks exercise native WebGPU and the WebGL2 compatibility layer through one shared GPU slot. No core, stage or backend implementation changes are involved. Animation reduction and resource pruning remain CPU operations without the GPU lock.


### Section 5 evidence: batch 267 asset wiring
mcp/assets performs only bounded network/filesystem preparation; no GPU lock during real downloads. mcp/assets-page lazily delegates GPU loading to existing gltf-pro/environment/materials APIs. Both backends exercise real CC0 scene assets; GPU pipeline readiness uses completion state. No new GPU maths, core/stage feature or benchmark.


#### 5. Batch273 scenery capture evidence
The scene-preset fixture preserves native synchronous drawImage capture after render and waits for the actual compatibility queue completion before its capture. This repairs an observation race with lazy compute preparation rather than changing scene output. The complete native scenery suite and complete compatibility suite pass every original preset, fog, stars and aurora assertion at4x and1x; the final compatibility scenes leaf separately confirms the conditional barrier. Two actual-fixture unit cases preserve each backend's scheduling contract.

### Section 5 evidence: property texture and attribute reads (batch 239 job 5)
The optional tiles/properties entry keeps semantic data queries outside rendering. Raw glTF accessor deinterleaving retains integer sentinel bits before PropertyTable transforms; sparse and matrix alignment/range checks reject malformed data. Margo's image decoder preserves data channels without color-space conversion or alpha premultiplication for PNG. Source-triangle barycentric UV lookup handles UV-set transforms and wrapping without claiming correspondence with optimized/deformed PBR geometry. CPU tests compare every value of a real 6876-point cloud with its source bytes, real texture golden samples, and synthetic encoding/validation edge cases. The tiles browser fixture draws that cloud with metadata-driven color and reads its real companion property texture on native WebGPU and the compatibility backend. No shader or backend source changes, core additions or speed assertions.

### Section 5 evidence: batch 221 BVH worker construction

The optional bvh/parallel entry reuses existing SAH construction in a coordinator plus bounded nested module-worker pool. Original face order, global depth and packed traversal topology survive subtree relocation. Numeric planning/build/merge work is off the page thread; input normalization/structured-clone and result validation remain caller-thread costs. Real worker-thread tests cover shared/cloned positions, one-million-triangle serial byte parity, queries, refit, precision, cancellation and worker/deadline failures. The production Vite consumer verifies both nested worker assets and exact serial output alongside bvh's existing WebGPU/WebGL2 checks. No GPU algorithm or core/stage change, and no benchmark/speed claim. Quiet-machine worker startup/transfer/build measurements remain owed. Existing builders already preserve editor face/index order by default; index-order.test.js validates that row with no duplicate indirect entry.

Section 5 batch 267 CI follow-through: the live/native, live/full-compat and real-assets leaves are registered by package script name. Frozen standard CC0 fixture bytes and license/provenance hashes make GPU execution independent of external catalogue availability. CPU preparation and network refresh never hold a GPU slot.
### Section 5 evidence: scientific pipeline (batch 172 job 1)

The optional sciviz/pipeline entry changes no GPU math or rendering backend. Its gate adds a real NASA FUN3D source/filter/layer demo on WebGPU and WebGL2 compatibility: coloured output, downstream-only call counts and owned layer removal. CPU tests cover lazy diamonds, inherited/independent times, serialization, exact abort reasons, stale work rejection, JSON validation and reverse resource release. Cancellation requires operators to observe AbortSignal; no external callback can be forcibly preempted. No speed evidence or full volume-mesh demo is asserted. See docs/sciviz-analysis.md.

### Section 5 evidence: inspector camera/capture tools, batch 263

The tools entry preserves the engine camera identity, delegates loaded projection maths to the existing glTF camera helper and restores the initial projection on disposal. It changes no rendering backend, core or stage code. CPU evidence covers application and loaded orthographic cameras, model removal during an asynchronous switch, camera replacement, screenshot cancellation/failure/timeout, and actual glTF encoding. Native WebGPU and preview WebGL2 browser checks decode screenshots and recordings and exercise PNG/GLB download actions. Heavy modules remain lazy; the compatibility launch runs the same checks.
### Section 5 evidence: animation owner lifetime and dependent browser invocation

Animation's package-local scene tests cover registered-identity removal,
asynchronous geometry-cache ownership, signal cleanup and terminal disposal.
The same-name sentinel implements EnginePlugin.setup so those assertions run.
The dependent React bindings browser proof selects its repository root before
starting Vite; a subprocess regression reproduces npm's package working
directory without a GPU. No rendering algorithms or tolerances change.

Batch 220 section 5 landing repair: inspector GL capture/overlays borrow the native canvas WebGL2 context directly and own their fixed shaders. The optional inspector entry has no compatibility-package import/dependency. Existing isolation guards stay unchanged; additional native-context and shader-error regressions prove the boundary and cleanup. Affected GL browser checks cover overlays, captured shaders/draw state, restoration and visibility on native WebGL2 and the compatibility run. No core or stage change.
### Section 5 evidence: batch 230 tree mesh
The optional tree-mesh entry computes slope-aware bark normals, orthogonal tangents, seam UVs, flat bark and alpha-atlas foliage. CPU evidence includes analytical cone normals and triangle orientation checks, all species, input ownership and /trees interoperability. Its browser correctness gate renders indexed geometry on WebGPU and WebGL2; default LODs share the skeleton and decrease triangles. No renderer, backend or core/stage math was changed. Artistic atlas quality is not evidence of photographic species fidelity; fork surfaces overlap and are not a watertight union.
### Section 5 evidence: batch 226 graph
Optional scene/graph uses current local values and float64 affine matrices before the frame. Point inversion preserves sheared ancestor chains; attach/world rotation validate a representable local TRS before mutation. CPU checks compare kernel matrices, independent point products and axis oracles; both native WebGPU and WebGL2 compatibility preserve every rendered pixel through attach. No core, stage, backend or kernel edits, no speed assertion.

Batch 224 section evidence: packages/mesh-edit/tests/section.test.js checks cap/wall closure, signed volume and polygon holes. The package browser harness accepts --compat using the existing compatibility shim and draws capped section output through the existing sculpt presentation path. This adds no renderer or GPU mathematics; native and compatibility runs cover the changed package only.
### Section 5 evidence: batch 226 subtree cloning
Optional scene/clone retains resources through existing core setters and copies current local transform storage without renormalizing its stored quaternion. Allocation failure reverses every newly allocated mesh; metadata validation occurs first. Independent CPU checks prove exact kernel/world transforms and resource ownership; both GPU backends render identical pixels with the source disposed. Core and stage unchanged.

### Section 5 evidence: batch 239 feature selection

Tiles/features combines exact accessor/image ID reads with nearest-vertex Voronoi clipping and PBR surface extensions. PreparedGeometry.interpolatedDirections explicitly admits convex direction interpolants; the authored path still requires unit normals and tangents. Directions normalize in the fragment shader, preserving the original smooth field after clipping. writeGeometry can allocate a later UV buffer for optional metadata materials. Live grouped renderable budgets include retained geometry capacity and current highlight texture/factor allocations. CPU regressions cover affine fields, normalized/decoded sentinel precision and budget growth; the tile browser fixture checks the real CC0 sample, exact white-highlight shading, restoration and transformed UINT32 texture highlighting on both backends.

### Section 5 evidence: batch 230 PBR baking
The optional textures-pbr entry shares the existing periodic field kernel and emits four storage maps per invocation. Height differences derive tangent normals in UV units, roughness uses the same field, and explicit nearest RGBA8 quantization prevents ambiguous half-value encoding. Mip generation integrates complete NPOT source footprints; normals renormalize after decoding/averaging. New CPU lifecycle tests and a two-backend GPU readback test cover the implementation. Full WebGL2 compatibility uses the same WGSL and public GPUDevice API. Core, stage and backend implementation are untouched; microfacet variance filtering remains outside this mip-normal claim.

#### 5. Batch273 bitmap upload proof
ImageBitmap is cropped into a drawable canvas before GL pixel-store transforms because WebGL otherwise ignores its unpack flip/alpha flags. The actual queue regression covers all flip/alpha combinations on2D/cube/array targets and zeroes crop skips after normalization. Complete native and compatibility normal-map fixtures pass every derived/authored/mirrored UV frame, extension lobe and round-trip image comparison without altered bounds. Mesh domes retain their raised orientation; glTF conventions stay intact. Counterfactual units fail on parent abde17aab and pass on the repair.
The incoming inspector isolation blocker is independently repaired by main61b17b70d, retaining its own implementation and regressions. No duplicate inspector code lands with the bitmap fix.

## ECS shared-worker evidence (section 5 supplement, batch 249)
Parallel storage and scheduling are confined to ecs/parallel. CPU correctness covers real worker overlap with an atomic rendezvous, physical buffer hazards/aliases, dense-row/generation lookup, bounded abort/deadline, worker crashes and termination ownership. Structure stays locked if a host cannot prove its worker terminated. A GPU-disabled browser fixture proves shipped asset URLs, cross-origin isolation, SAB writes and unisolated rejection; it is part of ECS CPU tests and does not take a GPU slot. Core/stage and rendering backends are unchanged. Throughput measurement remains for the quiet speed phase; no performance result is claimed.
### Section 5 evidence: selection GPU hit details, batch 199
HitDetails supplies optional surface attachments through Picking's package-local extension contract. Core, model and caster replay share the selected pixel's depth, normal and UV; decode snapshots the cropped camera and eye before mapping. ID-only picks retain capture and original staging sizes. Proof: selection/test/hit-details.browser.mjs checks core, the attributed Khronos Box, UV0, reflected nonuniform transforms and orthographic inverse projection. Existing picking/model/xray suites remain the correctness coverage for deformation, cutouts, visibility, multisample outlines and resource disposal. Both native and full compatibility backends run the same package browser command. No core or stage code and no timing claim.
#### Section 5 evidence: UI curved surfaces (batch 259)
Optional UI renderers share a surface tuple with `CurvedPanel`: radius, kind, columns and rows. WGSL and GLSL construct identical cylinder/sphere coordinates and local normals from procedural grid vertices. Per-fragment sidedness avoids rejecting a curved surface by its centre plane. Rays solve the corresponding analytic quadric, check both roots against finite UV bounds and select the nearest valid patch. Core and stage are untouched. Evidence: `packages/ui/tests/curved.test.js` (UV round trips, rotations, both roots, back mirroring and tangent arrangements); `world-gl-browser.mjs` (plane/cylinder/sphere, native WebGPU and preview WebGL2 pixels, scene occlusion, input and GL state restoration). Hardware XR proof remains separate from simulated rays.

### Section 5 evidence: batch 210 action mixer
The optional action entry writes local TRS, morph and property values through existing APIs; Animation retains deformation/GPU ownership. Independent actions accumulate into one binding commit per property. Original state is captured on first activation and restored when its last action stops; owned Animations register in the model's scene, and mixer disposal uses registered plugin identity. CPU tests cover clocks, envelopes, sparse channels, additive and quaternion blending, cache eviction, inactive-scene ownership and disposal. Both-backend mixer-browser.mjs checks 510 deformed coordinate values (maximum error 1.36e-7) and a real Fox crossfade, with no validation errors. No new GPU math, core/stage source change or timing result.

Batch 224 batch evidence: exact-kernel.ts shares the existing binary BSP predicates and final validity repair with boolean-batch, retaining one integer scale and postponing all output rounding to final assembly. The original binary exact tests plus new n-ary topology/volume/work-count checks cover the refactor. Native/compatibility browser checks draw the same compiled output. No renderer or core math changed.
### Section 5 evidence: batch 226 lifecycle integration
Tags/lifecycle remain optional and backend independent. Explicit observer instances wrap only one engine and its live mesh instances; imports change nothing. Transactional attach/clone notifications expose final transforms and metadata, and publish no failed-allocation transients. Per-mesh restoration handles source disposal, scene disposal, engine disposal and external wrappers. CPU event ordering, reentrancy, abort/failure and metadata checks combine with exact native/compatibility rendered-pixel invariance under classification and cloning. Core, stage and GPU backends are unchanged; no timing assertion.
### 5. Loader face-group evidence (batch 202)
CPU tests preserve source face properties through fan triangulation, independently of GPU objects. The loader browser fixture also creates, renders and disposes PLY/OFF group-colored meshes. The loader browser runner now honors the existing compatibility shim, so the same fixture can run on both WebGPU and WebGL2. No core, stage or rendering math changes.

### Section 5 evidence: skeletal JSON import, batch 245

The optional sprites/spine reader owns serialization, validation and imported
pose state. It maps onto Skeleton2D and SkinnedMesh from job 2. Per-influence
local bind coordinates avoid inverse matrices for collapsed setup bones and
avoid four-weight truncation. CPU constraints and deterministic cubic sampling
stay in sprites. The skeletal GPU pass now uses light/dark tint, premultiplied
output and ordered operator runs; multiply correction is interleaved per triangle
to preserve transparent backdrop contributions. Core, stage and both backend
implementations are unchanged. Evidence: sprites spine.test.js, existing
skeletal/rigging tests and all sprites GPU suites on native/compatibility devices;
spine-check.mjs supplies 96 independent blend/clipping readbacks per backend plus
licensed tree animation and exact backwards seek. Physics is data-only, warns
per named constraint and awaits the physics phase. Broader exporter/high-curvature
path polish remains private. No speed gate or timing benchmark was added.

### Section 5 evidence: optional pulsing x-ray selection
Batch 199 job 2 reuses the existing whole-selection and equal-depth masks, without new rendering maths or a second mask renderer. Pulse time advances once per frame, including multiple views. selection/test/pulse.test.js covers validation and time ownership; pulse.browser.mjs compares actual hidden/visible outline pixels at bright and dim phases using both morphology and JFA on an attributed real Box fixture. Existing xray browser evidence continues to prove hidden dash runs and PBR/core depth behaviour. No new hardware or speed claim.



### 5. Batch 265 frame ownership

The React Canvas keeps native engine clocks and callbacks while ordering React subscriptions. Positive priorities suppress the native loop's trailing automatic render and leave explicit draws available inside all native callbacks. A subscription snapshot is reused until membership changes. Demand dispatch returns the render decision without starting a loop. XR renderFrame remains inside the active tracked frame and the React adapter routes manual full-scene rendering to it. CPU evidence covers the native Engine loop and XR two-eye draw counts; the browser fixture covers exact automatic/manual pixels, empty takeover, multiple draws, removal and demand mode. Hardware evidence is required on both backends before landing.

The registered bindings, instances and priority browser scripts establish the repository working directory before starting their server. Running them as package commands previously rooted Vite in packages/react while requesting repository-relative page paths. The unchanged bindings and instances GPU assertions now pass from the package runner. Automatic and manual XR eye output is also compared byte-for-byte in tests/modern-xr-passes.ts on both backends.
### Section 5 evidence: batch 204 native texture output
Optional exporters/textures adds CPU linear-light/associated-alpha resampling and platform canvas serialization; no renderer, kernel, core or stage change. Its analytical CPU checks cover box/bilinear/Lanczos, data roles, transparent edges, metadata and fallback ownership. Both native WebGPU and WebGL2 compatibility exporter browser runs independently decode native WebP and PNG fallbacks, verify dimensions/extension flags and detect unsupported AVIF encoding. Chromium 157 supplied WebP but not an AVIF encoder; the coded unsupported path is evidence, not AVIF bitstream certification. See docs/exporter-textures.md for limits and research.




### Review 99 mesh build checkpoint and section 5 evidence

The optional mesh kernel now skips/counts exactly zero-area input triangles
and keeps original input IDs after compaction. Float64 product expansions avoid
misclassifying thin Float32 geometry. The same committed counts are exposed by
mesh and composed tracers, including failed-update atomicity. The existing lazy
Rust/Wasm feature builds all-axis 16-bin SAH with a bounded median fallback,
without changing the triangle/node record sizes or traversal tolerance.

Evidence: both new regressions fail on the preceding Wasm and pass after repair;
144 package tests pass, then the expanded regression file passes all three tests
including 512 independent BigInt classifications. Five Rust tests pass. A gap-ray
fixture visits three node bounds instead of the median tree's five; this is a
deterministic work count only. The initial queue was cancelled before start; the continuation passes the complete mesh suite on native and WebGL2/Vulkan and its exact README example. Additional composed native acceptance fails at the unchanged 12-minute lease; the separate compatibility run passes all 32 subsets, reflected RIS and atomic updates. No full-scene closure is claimed: UVs,
smooth normals, shared BLAS/instance transforms and triangle NEE/RIS remain.

### Review 99 checkpoint validation and section 5 evidence

The complete mesh suite passes on native WebGPU and WebGL2/Vulkan, including
skipped counts, stable original IDs, mixed transport, exact predicates and
disabled/restored/disposed raster equality. The exact triangle-mesh README
example passes its unchanged 20-second deadline. Composed native validation
fails its unchanged 12-minute lease at subset 31 readiness; no retry was run.
The retained pipeline markers and process tree distinguish accumulated native
pipeline construction from the earlier unattributed WebGL2 timeout. Both are
bugs until repaired; the separate compatibility run passes all 32 subsets, reflected RIS and atomic updates. See known-bugs
and the updated review-99 mesh checkpoint receipt. Full scenes are still open.

### Review 99 local vertex attributes and section 5 evidence

The optional mesh build validates and gathers normal/UV arrays in its existing
Rust/Wasm feature, with caller snapshots taken before awaits. The GPU retains
Woop shear barycentrics, geometric boundary normals and offsets, and a distinct
interpolated shading normal. UVs address the existing sRGB texture table. All
147 package tests and six Rust tests pass; the two new regressions fail against
the prior build (missing attributes and missing validation). Strict types, lint,
hygiene and README type checks pass. Native and WebGL2/Vulkan each pass four
analytic image cases covering standalone and composed tracers, with shader
errors/messages empty; normals differ by at most 1.97087e-7 and UVs by at most
4.76838e-7. The full existing mesh suite also passes both backends, and both changed README examples pass their unchanged 20-second limits. Repository closing gates are recorded separately.
The full-scene finding remains open; the twelve-minute composed native timeout
is retained and has not been retried. No core or stage changes.

Review 99 local attribute closing checks: lint and sequenced hygiene pass. One
full verify for the changed inputs passes every chain and all 13,986 repository
tests, with zero failures/skips and zero shadow-cache disagreements. It ran
without GPU settings under a forty-minute hard tree limit. An earlier hygiene
command was incorrectly overlapped with the rebuild and observed a temporarily
absent animator declaration; that invalid run is retained, then hygiene passes
after the build completes. Full-scene and native-timeout findings remain open.

The updated attribute shader also passes all 32 composed WebGL2/Vulkan subsets,
triangle markers, reflected RGB RIS shadows and atomic scene replacement at
the unchanged twelve-minute lease. The native failure was not retried, and
this compatibility proof does not repair or attribute it. The local attribute
receipt retains the complete backend results. Shared BLAS/instances, triangle
NEE/RIS and the P3 findings still block full-scene closure and pushing this work.
NEE/RIS and the P3 findings still block full-scene closure. Checkpoint landing
also requires the unchanged release gates, including the package README check.

### Review 99 timeout diagnostics and section 5 evidence

Retained native evidence isolates the lease exhaustion to cumulative trace
pipeline creation: subsets 0..30 finish, and subset 31 has only trace outstanding.
The device exists and renderImage has not begun; no readback or disposal has
started for that subset. Internal Dawn/compiler/driver attribution is missing.
The earlier WebGL2 timeout lacks phase evidence and stays separately open.
The browser correctness suite now has an independent host supervisor and durable
per-backend JSON snapshots. Pipeline completions have operation IDs, so preview
completion cannot hide a pending trace. Shader reports, queue completion,
readback, device loss and browser teardown have distinct evidence. At 690 seconds
it reports the current phase and begins terminating only its owned child tree;
the remaining 30 seconds belong to the unchanged 720-second total lease.
The CPU regression is included in normal package tests and therefore verify and
check:merge. No assertion, feature subset or numerical bound is relaxed. No
native acceptance rerun or compiler repair is claimed. Scott's current request
allows the complete mesh builder and attribute checkpoints to land separately
with the full-scene and compiler gaps retained explicitly.

The r6 compatibility supervisor integration passes all 32 subsets, triangle
markers, reflected RGB RIS and atomic updates; shader errors/messages are empty.
All 159 package units and the twelve diagnostic regressions pass. Paired entry
and network records were genuinely recaptured together on 3e1b3bc13/dirty=true:
mesh 28206 B gzip and core plus stage 23924 B. Provenance was not relabeled.
The required full-package README command then fails the resampled example's
unchanged 20-second module deadline, after the composed example passes and
before the mesh example runs. No retry was made, and pushing is blocked.
The single full verify catches a stale generated controls size row (27266
instead of 27268 B): api:update ran before its refreshed size-record input.
Regenerate after the pair, then run only api:check and the cancelled unit chain;
retain every successful verify chain. No passing full verify is claimed for r6.

The corrected API check, LLM corpus check and links pass. The standalone unit
continuation returns 14094 passes and three ViewCube fixture failures: its
old fake engine lacks sceneOf after Controls began using the real owner API.
Current main already repairs that fixture in d15e46fd2. An independently
implemented matching fixture and identity regression pass 19/19; that redundant
draft is discarded so rebase supplies the existing owner repair. ViewCube's
real browser proof and both runtime README examples pass. No production API
or assertion is weakened. The full tracer README deadline remains the blocker.

The final rebase onto 79dbd81d1 includes main's d15e46fd2 fixture repair. Its
actual upstream test file passes all 19 cases after rebuilding the integrated
packages. The captured 3e1b3bc13/dirty=true size pair is archived whole in
review-99-size-pair-20261109.json; newer upstream canonical records are retained
whole, with no provenance relabeling. API and LLM outputs are regenerated from
the integrated build. There is no second full verify, native acceptance retry,
resampled README retry or push. The compiler, full-scene and P3 gaps stay open.

### Review 99 shared-instance checkpoint (section 5 evidence)

The optional mesh feature now accepts explicit meshInstances referencing shared
object-space geometry. A tracer-local cache compares all geometry/attribute
words exactly in the feature-local SIMD Wasm; matrix-only setScene performs
zero BLAS builds and retains identical BLAS bytes. A Rust binned-SAH TLAS wraps
conservatively transformed bounds. Object-space traversal preserves ray t;
inverse-transpose normals preserve outside orientation under reflection.
Instance AOV ordinals concatenate original triplets, preserving degenerate holes.
Both standalone and composed tracers own builder lifetimes, queue updates in
call order and release CPU cache on disposal. No core/stage source changed.
Independent baked-reference GPU checks pass translation, rotation/nonuniform
scale, shear, reflection, overlapping TLAS leaves, smooth normals/UVs, depth and
original triangle ids on native WebGPU and WebGL2/Vulkan. Maximum RGB discrepancy
is 1.1920928955078125e-7; maximum depth discrepancy 1.430511474609375e-6 against
unchanged 1e-5 bounds. Invalid transforms preserve image/storage/revision.
Receipt: whitepaper/results/review-99-shared-instances-20261109.json.
Triangle NEE/RIS and the P3 findings remain open. Lane-U owns the unchanged native
composition readiness failure and full-package README 20 s deadline failure;
these are not waived, attributed anew or retried by this checkpoint.

Batch 243 landing continuation: floor-browser.mjs restoration passes once on clean e95938f23 and once with the rebased BLAS implementation. No assertion, tolerance or rendering source was changed for the floor. Rule 23 applies: dependent CPU tests gate the push; dependent GPU suites remain local CI coverage.
### Section 5 evidence: batch 172 contours
Optional sciviz/contour owns CPU topology, consistent pulling tetrahedra, gradient normals, bounded GPU intersection/readback and cancellation. Core/stage are untouched. Contour CPU tests cover analytical signs/sections/shared faces; contour-browser.mjs dispatches the actual compute kernel on WebGPU and WebGL2 and checks coordinates within its documented arithmetic envelope and visible NASA isolines. The GPU path prepares topology/gradients on CPU; it does not claim a fully device-resident marching algorithm. Convex planar-faced cell and finite f32 input contracts are recorded in docs/sciviz-analysis.md. GPU device replacement uses a caller-provided fresh compute context on the next request; no persistent GPU result is retained.


### Section 5 evidence: batch 265 adaptive performance

The optional React performance entry owns its controller and presentation resources per Canvas. Its frame-output adapter runs after positive-priority suppression and immersive-XR routing, so a suppressed automatic frame cannot present stale content. It uses ordinary target views for reduced scene rasterization and a package-owned upsample pass, preserving the renderer's MSAA and the Canvas's logical geometry. Native view-based picking uses unscaled coordinates. Removal, demand idle, StrictMode and engine disposal have explicit lifetimes. CPU regressions cover window arithmetic, hysteresis, 60 Hz restoration, active 500 ms frames, fallback, subscriptions and committed callbacks. The browser fixture compares two real licensed Box scenes, counts target dimensions, tests real pointer events, and requires exact full-resolution restoration. Both backends are required; this is correctness evidence, not speed evidence. No core or stage changes.

Batch 265 performance hardware evidence: both WebGPU and WebGL2 compatibility pass all five modes with exact restored pixels, correct picking and teardown. Receipt: docs/whitepaper/results/batch-265-performance.json. The 128 by 128 scene target has one quarter of the 256 by 256 scene raster area, plus the separate full-size presentation pass; no total execution-time reduction is inferred.
Batch 219 job 1, section 5 evidence: optional geometry/nurbs-edit runs entirely on CPU and returns the established GeometryData. Mathematical refinement/trim tests plus the geometry GPU fixture cover upload, winding and a displayed trim hole on both full rendering backends. No core/stage or backend math change. Surface resolution is explicit; model-space tessellation error certification remains outside the API claim.


Batch 224 repair evidence: independent edge closure, signed volume, UV/source correspondence and downstream boolean checks cover soup normalization, parity orientation, disconnected fan splitting and cavity nesting. Existing strict polygon validation runs on owned compacted output. Nonfinite unused input positions are removed before the strict hole filler, rather than bypassing validation. Browser presentation covers native and compatibility devices; no GPU math or renderer code changed.
### 5. Legacy VTK topology and surfaces (batch 202)
The optional legacy reader shares package-local numeric and surface building modules with the previous root and XML readers. CPU evidence compares structured grid and outer-face topology and source-cell mapping exactly; the loader GPU fixture checks the resulting surface still renders on each backend. This factors existing math without changing its formulas. Legacy integer precision loss now rejects with a tested coded error.
### Section 5 evidence: area ID readback
Batch 199 job 3 generalizes selection's package-local micro renderer with optional region attachments and dimensions. A Symbol-tagged view carries one query through the existing engine queue, so concurrent region/point requests cannot swap operations. CPU decoding reuses scene/device/mesh liveness checks. area.browser.mjs proves full occlusion rejection, lasso pixel filtering, negative dimensions, bounds false-positive rejection, exact one-pixel behavior, concurrent operations, abort/allocation validation, and exactly one submission/map. Both native and compatibility run the same proof, with the attributed Khronos Box. Existing package point/model/xray GPU regressions retain the 3x3 and mask contracts. No core/stage changes or timing claims.
### Section 5 evidence: batch 210 plain playback
The optional subclass computes clip time and delegates all poses/deformation to Animation. It temporarily disables base modulo while sampling exact terminal endpoints, then restores the caller's option. Events fire after the pose; completion/cancellation promises settle once per run. Constructor signal listeners release on disposal and failed setup. Tests cover forward/reverse repeat, ping-pong, aggregated loops, reentrant completion, empty-duration completion and inactive-scene registration. Native/compatibility GPU checks compare 510 coordinates against independent trigonometry, maximum error 1.36e-7, plus exact Fox terminal times and valid deformation. No core/stage or GPU algorithm change.



### 5. Batch 243 mesh material channel ownership
voxel-pathtracer/mesh-pbr is optional and specializes the existing composed mesh feature. It appends material, RGBA8 and vertex-attribute storage after the same feature-local Wasm BLAS/TLAS packet, within the existing 128 MiB geometry binding cap. Root/core/stage gain no feature or pass. Instance padding stores private per-instance attribute/material offsets so geometry sharing does not constrain material ids. Geometric normals continue to own offsets and side tests; interpolated/tangent-space normals own shading. Atomic scene snapshots and cancellation stay with the existing composed facade. CPU/WGSL channel and glTF snapshot proofs are in packages/voxel-pathtracer/tests/mesh-pbr.test.js; native/compat pixel acceptance is tracked by mesh-pbr-browser.mjs.
### Section 5 evidence: batch 233 road intersection design
The optional intersections entry owns plan-view union, circular reentrant fillets and shared-ground lifting. Existing polygon/extrude entries load lazily. No core/stage or renderer changes. Face normals use final float32 coordinates; collapsed faces reject. CPU equations test areas, radius, holes and slopes. The road browser gate proves separate road/curb/sidewalk pixels, exact reboot and disposal on both backends. Nonlinear terrain is piecewise planar at triangulation vertices; no engineering certification or speed claim.
Batch 219 job 2, section 5 evidence: geometry/extras primitive generation remains CPU-only and backend-independent. The geometry GPU suite now uploads geodesic, Goldberg, hemisphere, tiled plane and tiled box arrays and checks outward winding plus visible Goldberg pixels on both rendering backends. Unit topology, UV and analytic geometry checks supplement rendering; no core, stage or backend change.

Batch 223 software occlusion: the optional culling/webgl2 entry owns CPU depth
and core batch redirects. Section 5 evidence is its CPU edge/near-plane/current
transform/cleanup tests and byte-identical Cesium Box scene on native WebGPU and
the full WebGL2 layer (webgl2-check.mjs). Every view uses separate upload buffers,
so later queue writes cannot replace earlier views' records before submission.
No engine hooks, rendering backends or frozen core/stage code were added. CPU
rasterization uses inner coverage and reversed-Z far bounds; seam and clipping
uncertainty retain extra geometry. CPU costs are not yet speed-phase evidence.




### 5. Batch 243 learned reconstruction ownership
The denoise-ml entry is independent of the mesh/PBR feature work. One optional compute pipeline reads lazy feature-local weights, packed RGB color/albedo/normal, coverage and a small uniform, writing owned packed RGB. There is no RGB-to-RGBA staging loop or shared engine feature. Weights/pipeline follow device identity; per-request storage/readback buffers are released in finally. An internal abort lifetime combines with caller cancellation so queued work and pending readback settle on disposal. Readiness/readback errors retain their cause under coded errors. CPU regression proof covers the Float32 upper-color boundary, invalid guides/limits/options, cancellation, disposal, device replacement and native error wrapping. Native and compatibility compute results agree with the same WGSL CPU evaluation, preserve constants/coverage and improve independent synthetic and licensed Box noisy input.
### Section 5 evidence: batch 172 clipping
Optional sciviz/clip owns convex simplex clipping and f64 tuple interpolation. Shared pulling topology remains in sciviz's optional analysis implementation, outside core and stage. Tests retain all 16 tetra sign cases, analytic volumes/areas, exact box intersections, disjoint complements and curvilinear structured sample coordinates. clip-browser.mjs renders CT-ORG and NASA filter results with existing mesh layers on WebGPU and WebGL2; no GPU compute or new backend shader is introduced. Sampled sphere and structured cell-data conventions are recorded in docs/sciviz-analysis.md. Exact predicates for arbitrarily ill-conditioned input are not claimed.
### Section 5 evidence: batch 206 PointInstancer

USD scatter expansion reuses prototype mesh/accessors and adds only scene nodes in an optional entry. OpenUSD 26.11 provides five pose/mask oracle cases; malformed streams, selectors and bounded expansion have CPU checks. The USD browser suite checks model creation and rendered-frame change on both backends. No core, stage or backend implementation changes.

### Section 5 evidence: selection glow/fill
Batch 199 job 4 adds an optional mask-only Selection consumer, two R16F separable Gaussian passes and straight-alpha highlight compositing. Ordinary Selection retains its existing outline path. Mask-only setup skips JFA pipelines, fields, jump uniforms and dispatch, regardless of the configured outline algorithm. Frame resource helpers retain per-view uniform values and bind-group reuse, and retired textures remain live for encoded views. highlight.test.js verifies style validation, no mask-only compute, steady-frame view/group reuse, restore/disposal and the default-algorithm mask extension. highlight.browser.mjs verifies actual fill, inner/outer exclusion, finite radius, broadening and byte-identical fully occluded output using the attributed Khronos Box, on native and full compatibility. Existing package xray/model GPU checks cover the retained ordinary path. No new hardware coverage or measured speed claim.

### 5. Geospatial vector evidence (batch 202)
Geo parsers preserve raw doubles and source features separately from float32 rendering. Planar fill delegates to @margoengine/geometry/triangulate, preserving holes and feature-to-triangle association; polygon outlines and explicit lines/points remain independently drawable. CPU tests check exact area, source cell/feature ownership and real geographic polygons; the browser case renders the resulting holed surface on WebGPU and WebGL2. No core, stage or backend math is added.
### Section 5 evidence: batch 233 lane paint
Optional lane meshes use arc-distance samples, horizontal tangent/lateral frames and final float32 face normals. No core/stage/GPU shader changes. Independent circle-radius, boundary, dash/phase and slope equations cover CPU geometry; the road browser gate renders actual curved line/arrow pixels on both backends, restores them exactly and disposes all paint meshes.
#### Section 5 evidence: UI layout editing (batch 259)
LayoutDocument validates through the markup owner before changing source/history; LayoutEditor rebuilds only its owned widget subtree. Preview rendering remains the existing UiRenderer on native WebGPU and compatibility WebGL2. CPU tests cover atomic edits, history, escaping, hierarchy cycles and canvas/mirror ownership. Browser tests edit real properties and source, preserve the last valid preview, download and reopen versioned JSON, and resize through 1440/1024/768/390/320 without page overflow. Source files contain no executable actions; applications opt in to named handlers. No renderer/kernel change or timing claim.

### Section 5 evidence: batch 210 categorical action channels
The standalone discrete entry contains no GPU code or rendering import. Its bound clip feeds a separate categorical channel accumulator in the existing optional mixer. Winner selection compares effective weights and original-state remainder, commits actual booleans/strings, and restores only live owners. CPU regressions include exhaustive scan-vs-binary-search sampling, sparse inputs, exact key endpoints, edits/serialization, safe paths, weighted crossfades and zero-duration/disposed-root failures. Both native and compatibility GPU checks use the licensed Fox and a live text element at five times: 169 visible pixels and one draw in visible states, zero draws/changed pixels while hidden, and restored originals after stop. Existing mixer vertex/deformation GPU proof also gates the shared scheduler change. No core/stage, backend or shader algorithm change; no speed claim.
### Section 5 evidence: batch 239 tile replacement fade

Optional tiles/fade observes selection before eviction, assigns complementary rank intervals down the REPLACE hierarchy and retains visible outgoing content until its interval is empty. ADD semantics stay additive. Mesh hooks share a clean-room rank function with the point material's live optional ditherFade interval and Splats.setDitherFade original-order content ranges; the splat masks follow sorted IDs in the fragment shader. Device recovery retains the CPU mask array. TileSplats updates masks within one globally sorted cloud without cloud rebuilds; origin/visibility rebuilds reapply the original content spans. CPU tests cover reversal, nested partitions, ADD, exact rank coverage, mask rounding, merged spans and restoration. The real-GPU tile fixture checks zero pixel change across identical parent/child replacement, eviction afterward, exact 128 by 128 point masks and real/synthetic sorted splat masks, on WebGPU and compatibility. No benchmark or speed claim.





### 5. Batch 243 mesh light proposal ownership
The optional mesh feature now owns world-space emissive-triangle sampling and delta spot/IES proposals. The same lazy mesh Wasm crate appends area/CDF records and per-instance lookup tables without changing shared BLAS indices or public triangle ordinals. Shader NEE and path-hit MIS read the same quantized CDF differences, preventing proposal/PDF mismatch. Material evaluation stays in mesh-pbr when selected; root transport, binding ownership, volumes and BSDFs remain unchanged. Spot/IES storage is bounded and validated before an asynchronous build. CPU proof covers nonuniform reflected areas, reciprocal PDFs, inverse-square/range attenuation, irregular photometry and atomic updates; mesh-lights-browser.mjs owns native and compatibility pixel acceptance. No core/stage source or browser lifecycle helper is changed.

Batch 243 light continuation evidence: the canonical native-then-compatibility suite passes all six original rows on each backend, with the 120000 ms per-image signal and analytic bounds unchanged. Per-render create/readiness/image/completion/disposal messages distinguish future failures. Instrumented GL and Chromium shader-disk-cache-disabled compatibility diagnostics also complete every row. The historical timeout cause remains unisolated; 919fdc09e already preceded that failure, so it is not credited as its repair. Receipt: whitepaper/results/batch243-mesh-lights-20261109.json.
Batch 219 job 3, section 5 evidence: geometry/teapot evaluates the standard historical control net entirely on CPU, with derivative normals and Float32 output validation. Independent polynomial/normal/count tests plus a displayed teapot in the shared geometry GPU fixture cover both full rendering backends. Core, stage and backend implementation remain unchanged; no performance claim is introduced.

Batch 224 hull evidence: geometry/hull exposes owned original-point indices without float32 narrowing; the existing geometry/extras behavior is regression-covered unchanged. Mesh Minkowski decomposition reuses exact BSP support planes and exact three-plane meets, then explicitly crosses into the documented floating hull/addition domain. CPU tests independently validate closed incidence and analytic convex/concave/cavity volumes. Geometry and mesh-edit own GPU checks run on WebGPU and the WebGL2 compatibility layer; dependent packages receive CPU checks only. No core math, backend or stage feature is added.


### 5. Batch 265 texture ownership

React maps use native material meshes with UV data held outside core. Material draw queues are keyed by the active Scene frame graph; PBRModel disposal looks up its owning Scene. The strict CPU recorder checks Scene isolation and disposal, and React tests check StrictMode, updates, borrowed resources, Suspense shapes and KTX decoder signals. The textures browser comparison covers ten native shading classes in both Scenes plus KTX2 and video on WebGPU and the WebGL2 compatibility layer. No timing or throughput claim is made.

Transmission opaque captures and MaterialInstallation disposal now use the owning Scene too; the recorder regression installs from outside the model setup and verifies separate captures and independent removal. Hook media stays alive for its Canvas while layout-owned material meshes are removed synchronously when React hides or removes a Mesh.

Batch 265 final evidence: all 24 texture comparisons are exact on both backends. CPU graph: 5492 of 5493 passed initially; the shader sceneColor recorder was then aligned with real Engine frameGraph/sceneOf and its existing test passes. The canonical dispersion compat reset remains open as pre-existing failure 9. A 57-render main-parent/feature GL input-trace comparison matched every count and paired digest, including the reset, with both diagnostic runs exact; this neither replaces the full grid nor establishes a driver cause. Durable record: whitepaper/results/batch-265-dispersion-parent-trace.json. All other required fast gates passed; no core or stage edit, timing claim, README check or dependent GPU run.
### Section 5 evidence: batch 206 implicit shapes

The optional USD shapes entry uses existing geometry primitives with schema-correct axes, normals and caps. OpenUSD 26.11 provides 22 extent cases. The package owns its prepare hook and budgets; core/stage/backend code is unchanged. Both browser backends render all five types.

### Section 5 evidence: batch 233 road import
The optional road network reader builds CPU topology and exact WGS84 east/up/south coordinates; core/stage and rendering backends are unchanged. Independent equator/dateline and topology equations plus a real ODbL OSM fixture provide CPU evidence. The changed-package browser gate renders the real imported road on native WebGPU and WebGL2 compatibility and checks exact reboot/disposal. Metadata width defaults are assumptions, not survey or navigation certification.

### Section 5 evidence: batch 172 probe geometry
Optional sciviz/probe owns f64 barycentric/isoparametric inversion, bucket candidate selection, exact declared-cell-model integrals, profile masks and resampling. Shared optional cell-complex logic adds explicit opt-in line/vertex validation for probes; contour and clip retain their prior surface/volume restrictions. CPU coverage retains those entries' tests plus the new analytical probe oracles. probe-browser.mjs renders real NASA/OpenNeuro data and verifies actual chart hover moves the 3D marker on WebGPU and WebGL2. Existing renderers and compute bindings are reused; no core/stage or backend shader is changed. Conditioning, sampled field models, bounded iteration and quadrature-point Jacobian checks are explicit in docs/sciviz-analysis.md. This is not an exact arithmetic geometry kernel or a speed certification.

### Section 5 evidence: batch 223 oriented boxes

Culling's optional /bounds subclasses add box tests to the existing mesh, model
and moving-instance cull passes through a package-local shape hook. Uniforms and
plain-model items append two aligned vec4 records only in these subclasses.
The plane support sum stays valid under shear; clip-coordinate interval padding
keeps near-depth tests conservative under oblique transforms. CPU tests pin
uniform alignment, padding, all three shader paths and 100 transformed-corner
comparisons. The licensed Cesium rod fixture compares culled and original pixels
on native and full WebGL2 routes; no core/stage or backend code changes.
### Section 5 evidence: animator graph layers (batch 211 job 1)

Detached graph evaluation writes only a borrowed local pose. Ordered masked override/additive composition precedes the owner's node commit and existing IK/skinning, so no extra palette or GPU pass is introduced. CPU tests cover independent state/clock/trigger flow and loaded-pose references; GPU tests render existing CC0 Fox through WebGPU and WebGL2 compatibility. No timing claim or hardware-tier change.
### Section 5 evidence: batch 233 road structures
The optional entry owns sampled terrain classification, road-crossing clearance, gravity-relative extrusion and support geometry. No core/stage, kernel or shader changes. Deck volume, box shell volume, open portal boundaries, sampled terrain thresholds, slope-plane foundations, pier exclusion and folded-strip rejection have CPU evidence. Oblique bridge/tunnel fixtures verify both coloured layers, exact reboot and disposal on native WebGPU and WebGL2 compatibility. Terrain entrance excavation belongs to the consuming mesh; returned rings do not claim a solid boolean result.
### Section 5 evidence: API summary aggregate regression
The root API scope tests now check every committed package row, including the unscoped umbrella, against the summary's package, entry and export counts. This catches manual merge totals that omit margoengine; full api:check still validates each row against compiled declarations. These root tests already run in local CI's normal suite. The reported 97-package summary fails the new check; the canonical 98-package index passes. No runtime package changed.

### 5. Native 3MF and material evidence (batch 202)
Optional parsing hooks belong to loaders and leave core/stage untouched. Source native geometry retains double precision and full affine instances; preview triangles use the existing render path. Tests cover source construction parameters, slice references/precedence and bounded expansion. Shared material equations now compose linear RGB and opacity rather than sRGB channel values, with spec-based regression expectations; the browser fixture renders the resulting source preview on each backend. Native construction data preserves clipping relations for consuming applications.

Batch 213 job 2: MToon uses a synchronous per-model material adapter in optional gltf-pro, inherited by live isolated renderers and scoped to the actual draw. Delegation bypasses only its immediate call, so nested views still adapt. Per-view uniform writes retain the caller context; body and outline layouts bind only statically used resources. Source, replica, HDR colour, G-buffer replay and two-distance hull proofs are described in [rigging-mtoon.md](../rigging-mtoon.md). Original materials and caller ownership are restored on disposal. Cross-model queue ordering and animated alpha-shadow integration remain explicit limits. No core/stage edits or speed claim.

### Section 5 evidence: rich animator trees (batch 211 job 2)

Optional tree compilation provides leaf clips and weights to the existing Animator pose sampler; it adds no renderer, palette or pass. Gradient-band CPU evidence covers cardinal samples, Cartesian midpoint, polar walk/run separation, 2D parameter sweeps and rotational/scale invariance. The real Fox GPU fixture evaluates a nested direct/directional tree inside a state layer on both backends. No timing result.


### 5. Batch 261 distance label layout
Distance policy is CPU/DOM layout code. LabelRenderer honors a layout-adjusted final scale while preserving its existing distanceScale output. The browser gate checks real scaled geometry and opacity over native WebGPU and WebGL2 scenes. No core, stage, backend pipeline or GPU shader change.
### Section 5 evidence: batch 172 calculator
Optional /calc adds bounded grammar-generated WGSL and sparse numeric reductions without core/stage changes. Topology, rank-revealing geometric basis and least-squares coefficients stay CPU-side; expression/reduction output is read from the GPU with finally-owned resources. calc.test.js supplies independent affine/transfer/quality oracles; calc-browser.mjs compares all derived operations and NASA data on both backends with explicit per-value forward-error bounds. Quantisation and reconstruction error are separate from execution parity; see docs/sciviz-analysis.md.



### Section 5 evidence: batch 223 ordering

The optional /sort entry encodes a stable GPU key network and full-row gather
after visibility compaction. The key is camera-forward depth of the transformed
local center. Padding keys sort last; original indices break equal depths. GPU
readbacks compare all 24 floats and all five argument words to independent CPU
expectations for capacities 0, 1, 3, 17, 65 and 257, including count below capacity,
nonzero record/argument offsets and a sheared node transform. Pixel checks cover
core meshes, static parts, models and moving instances, camera movement and the
runtime disable switch on both native and compatibility backends. Queue writes
use separate stage offsets and view resources. Source lists remain available to
picking/shadows. Only package-owned code changed; no core/stage hooks were added.

Sorting lifecycle CPU tests also pin per-owner release across all views and a
fresh allocation if the same owner is later encoded again. The GPU fixtures
exercise enable/disable transitions while cullers continue to update their lists.
Batch 266 section 5 evidence: React controls-extra adds no rendering math. Its shared-lock browser proof runs keyboard and native scroll input plus spring group rotation and snap-back on native WebGPU and WebGL2 compatibility, with the existing Cesium Box licensed fixture. HTML scrolling is hosted in a sticky zero-height overlay so native scroll does not apply the damped translation twice.

Batch 266 additional correctness: scroll mesh extent reads an installed camera projection for orthographic cameras, with a deterministic 4-world-unit fixture. Product-local pointer presses include live descendants in the existing controls BVH pick, with a detached-mesh regression. No rendering backend or core math changed.
Section 5 evidence, batch 205 legacy FBX: the optional pre-index normalization hook shares the existing bounded parser and scene pipeline, then the same PBR geometry, skins, morphs and animation. Real ASCII/binary paired accessors and validator are CPU evidence; legacy-browser renders actual binary 6.1 cube pixels in page/worker modes on native WebGPU and WebGL2 compatibility. Core and stage source remain untouched; base gzip is 24,209 B after the full package build.

### Lines optional stroke evidence (batch 227 job 1)
Optional line entries supply shader transforms and owned bind-group resources to the lines renderer, with no imports from its root into those entries. Colour and picking use the same layout and transform, cache separately by feature, and rebuild resources after device restoration. Stroke retains independent width and world-distance data so dashes do not overwrite taper. GPU evidence includes 1x/4x taper/reveal, depth, picks and restoration on WebGPU and the compatibility layer; storage struct alignment has a CPU regression. Core/stage are unchanged.



### 5. Batch 229 imagery surface evidence
The new optional terrain/imagery collection patches the lit surface color after the clipmap or RVT color call and before lighting, or the equivalent planet base color. PlanetTerrain gains the existing TerrainLighting contract in its own optional entry; core and stage stay untouched. imagery.test.js covers source addressing, bounded parents, ownership, validation, stale requests and restore; imagery.browser.mjs covers actual slope/planet draping and exact source equivalence on native WebGPU and WebGL2 compatibility. The complete terrain GPU suite runs on both backends; CPU dependents include biomes and the umbrella facade tests. Multi-GPU hardware coverage and quiet timing are not claimed.
### Section 5 evidence: graph transition clocks (batch 211 job 3)

Graph source selection and normalized destination entry are CPU pose controls; GPU skinning is unchanged. The fade uses elapsed seconds independently of destination time. CPU tests assert exact event boundaries, policy precedence, source chaining and continuity of the captured blended pose. The Fox GPU fixture exercises the new offset through the existing palette on both backends. No speed claim.


### 5. Batch 261 label cluster evidence
Clustering is optional CPU layout over the existing renderer projection; count bubbles are DOM overlays. Radius-graph components have independent all-pairs proof, 100k deterministic coincident-point coverage, renderer camera-zoom splitting and native WebGPU/WebGL2 DOM alignment checks. Core/stage and GPU shaders are unchanged.

Batch 266 section 5 portal evidence: RenderTexture uses existing target-bearing native views before main rendering; Hud uses native Scene views with preserved colour and fresh depth. The new optional React entry adds no core/backend math. portals.test.js checks camera/scene ownership, resize and implicit-view deduplication; test-portals-browser.mjs compares texture, Hud and stacked Hud pixels with direct native calls on WebGPU and compatibility WebGL2.

### Repeated stroke texture evidence (batch 227 job 2)
Texture extensions append image/sampler/uniform bindings to the same line-owned layout for colour and picking. Shader sampling uses continuous explicit UV gradients before control-flow discard, preserving repeat seams and mip selection. GPU tests exercise colour/alpha picks, UV edits and restoration on WebGPU and compatibility at 1x/4x. Mips use the existing optional-package GPU generator. Core and stage remain unchanged.

### Section 5 evidence: batch 172 glyphs and warp
Optional /glyph consumes core's existing shared-Geometry instancing and Margo geometry/primitives and math/affine APIs. There is no new GPU pass or frozen core/stage feature. Glyph tests check one draw for the real NOAA sample, both backends, every source shape/custom geometry, exact restoration and ownership cleanup. Independent CPU orientation/warp oracles include antipodes, curvilinear images and the pinned SEACAS displacement file. Image assembly and Exodus metadata handling stay outside the engine runtime, in the demo.
Section 5 evidence, batch 205 surfaces: bounded parametric normalization follows all document-generation migrations and precedes geometry indexing/build. The shared loaders/nurbs API owns rational evaluation and analytic/pole normals; FBX owns format fields, net transposition/wrapping, patch basis conversion, cap winding and ordinary material/node attachment. Evidence includes all 25 mixed patch basis pairs, rational analytic plane values, signed cap volume, reversed normals/winding, real Maya 6.1/7.5 planes and periodic sphere, validator and actual classic-worker preparation. Real NURBS plane pixels are checked on WebGPU and WebGL2 in page and worker modes. Core/stage source is unchanged.
### Section 5 evidence: per-bone layer influence (batch 211 job 4)

Dense mask weights multiply the existing layer strength before local pose composition, so skinning uses its existing palette and pass. CPU evidence covers quaternion shortest arcs, additive/override scale and translation, node morph weights, live masks and invalid values before node writes. Both GPU backends render the real Fox using soft masks. No additional GPU resource, backend feature or timing result is introduced.
### Section 5 evidence: painted 2D geometry (batch 247 job 1)
The optional SDF entry computes exact signed sampled-centre distances on GPU before the consuming GI frame. Linear-time row scans and column lower envelopes replace approximate nearest-seed propagation. No core, stage or shared rendering change. Conservative distance skips plus cell traversal preserve one-pixel walls; painted and analytic hits share nearest-hit ordering inside each visibility connector. sdf-regressions.js reads every field value against an independent brute-force oracle on empty/full, non-square and sparse/dense images; GPU output is compared against analytic unit-rectangle sources with black occlusion, live LayerCompositor painting, independent cameras, HDR, resize and real device replacement. Both rendering tiers run the same shader/input assertions; no speed claim. Texture memory and numerical semantics are in limits.md.
