# VFX particle-state experiment

The full-write candidate is applied and retained after package, state/HDR and
paired compute-plus-draw checks. It retains the existing 16-float/64-byte particle record,
56-word/224-byte uniform, five-word indirect arguments, all birth/curl/gravity/
ground/rotation/color/alpha behavior, validation and capacity limits. Core and
stage are unchanged.

Each global invocation reads and writes only its own particle slot. Curl reads
that position and uniforms, and the other shared data use atomic counters.
Removing the distinct source/destination buffers therefore introduces no
cross-particle read/write dependency. The full candidate uses one read/write
particle binding, one compute group and one render group per pipeline. It
retains full-record writes and the existing billboard shader.

The initial trace found `gpuState` consumers only in real-GPU game/sandbox
readback and release checks; no consumer requires a prior-frame buffer. The
current record layout and getter shape stay the same. A retained particles
reference becomes stable and observes later updates, whereas the original
implementation alternates two buffers. Device restoration still replaces and
destroys the old buffer and reseeds rather than preserving old particles. This
behavioral detail should be stated in the README if the candidate is applied.

All measurements below used native Intel Arc 140V/xe-2lpg, Edge 154.0.4258.62,
Windows, no browser launch flags or fallback adapter. These are local isolated
producer/GPU measurements. The later native full-island FPS comparison below is
inconclusive under clock/contention drift; hosted startup, combined final-scene
60 FPS and physical Android acceptance remain pending.

| Variant | Published raw / gzip bytes | Delta | State bytes at 1M | Same-queue compute result |
| --- | ---: | ---: | ---: | --- |
| Original ping-pong | 14,105 / 4,742 | baseline | 128,000,000 | Reference |
| Single buffer, full writes | 13,841 / 4,659 | −264 / −83 | 64,000,000 | 1.376256→1.310720 ms; median paired ratio 1.05; 9/10 wins |
| Single buffer, partial writes | 14,010 / 4,704 | −95 / −38 | 64,000,000 | Median paired ratio 1.00; 4 wins / 5 ties / 1 loss; rejected |

The partial variant writes only life for an unrespawned dead slot, and writes
position/life, velocity/size and angle for existing live particles, retaining
full writes for births. It matched quality, but did not show a consistent speed
gain and adds branching. Reject it. The simpler full-write form saves 64 MB of
particle storage and shrinks runtime code; it is the candidate for subsequent
package checks and native whole-app comparisons.

The full and partial variants each passed every field-byte comparison across
one million live particles after 30 matched updates, 4,097 mixed live/dead slots
across four updates, and capacity 1 deterministic births, gravity/ground bounce,
death and rebirth. The deterministic bounce produced y 0.05 and upward speed 2.25.
Birth workloads at 4,097 and 1,000,000 verified populations, all live IDs unique and
in range, all 16 fields finite, HDR color/alpha/size/angular velocity, lifetime
bounds and ground clearance. Multi-particle births use an already unordered
atomic seed sequence, so their per-ID bytes are not a parity promise. Indirect
arguments remained six indices and the actual current live population.

The actual indirect billboard shader rendered 65,536 HDR pixels at 1× and 4× with
zero changed pixels for either candidate. Each mode had 951 visible translucent
pixels, 61/62 HDR pixels and no invalid values. Valid canonical live IDs isolated
record/alpha/render parity from the production atomic append order; these
checks do not claim stable transparency ordering.

Actual compiled original/full/partial classes also passed 1× D32 and 4× D32S8
rendering, HDR uniform packing and 193 live particles; fresh-device restoration
reseeded 193 and retired every old owned buffer exactly once. Idempotent disposal
retired current owned buffers once, removed the plugin and invalidated the
getter. The full/partial classes allocated six owned buffers instead of seven,
with one particle buffer instead of two. No shader compilation, validation or
uncaptured errors remained.

Four integration-fixture failures were recorded and corrected before the valid
result: missing base FrameGraph draw callback, overlapping duplicate mapped
range requests, missing negotiated stencil-format feature, and reusing a
consumed adapter instead of requesting a fresh replacement. Their failure log is
`test-results/vfx-inplace-class-failures.jsonl`. These were fixture errors, with
all affected browser/device/server instances closed, and did not change the
first valid paired timing report.

The portable scripts require the explicit original Git ref and built core:

```sh
node scripts/measure-vfx-memory.js 5fc55a0826fba23f0ff220f48bc6bf6de6c305cd
node scripts/benchmark-vfx-memory.js 5fc55a0826fba23f0ff220f48bc6bf6de6c305cd
node scripts/test-vfx-memory-integration.js
```

The first script bundles original and both isolated candidates with identical
optional-package flags and `write:false`; it emits experiment modules under
ignored `test-results` for the integration script. The GPU script uses one
queue/command buffer for both 20-warm-up/10-pair comparisons, one pooled query
set and two timestamp read/resolve buffers, and reads results after completion.
No per-frame queue wait is included in timing. Both fixture variants are
reconstructed from the explicit Git source, so landing the chosen implementation
does not replace the benchmark baseline. Native comparisons should run alone.

Complete original evidence is retained in `test-results/vfx-inplace-size-lifecycle.json`,
`vfx-inplace-gpu.json` and `vfx-inplace-class-gpu.json`. No whole-app 60 FPS or
sub-second load claim follows from the 65 microseconds median compute reduction.

## Production checks and current full-island comparison

The applied package builds to the same measured 13,841 raw / 4,659 gzip bytes.
Both VFX package tests, the game-package checks and partial-initialization
failure checks pass: 21 tests, zero failures. Production uses six owned buffers,
one current 64-byte particle buffer, the same indirect live-population ABI and
the same billboard shader. The additional unit check verifies stable current
buffer references, exact retirement and restoration/disposal behavior.

The actual complete Afterlight scene ran in one native Edge page, replacing only
the original/full VFX class. It retained the 1432×768 buffer, desktop 4× HDR,
1,000,000 particles, 256 water segments, 1024 shadow resolution, 73,728 terrain
triangles, 110,000 grass blades, current full island/cabin/grove/explorer/ocean,
fixed camera and fixed 17.599931666666535 hours. Other user Chrome/desktop-app
GPU processes remained open. None were stopped or assigned a causal role from
a single GPU counter sample.

Unprofiled ABBA render rates were 28.07 → 26.47 → 23.44 → 23.71 Hz
(original/full/full/original). A separate pooled GPU ABBA ran at 41.01 → 41.04 →
36.38 → 27.26 Hz; Main shading rose from 5.898 to 8.520 ms across the restored
original windows. Full GPU spans were 22.938 → 23.396 → 25.297 → 35.717 ms.
These traces show substantial clock/workload drift. Arithmetic means are
descriptive only and are not evidence of an app improvement or regression.
The fresh baseline is independent of the earlier 22.74 ms GPU-span measurement.
The profiler reused one query set and two timestamp buffers; both cadence and
profile windows made zero steady GPU buffer/query allocations or queue waits.

For paused full-scene parity, every 16-word record and canonical live ID was
seeded identically, VFX GPU compaction was suppressed while the package's exact
CPU uniform packing remained active, and existing coast/spray evolution was
frozen while their rendering remained present. Original→original,
original→full and full→full comparisons each changed zero HDR pixels/channels
and zero of the 16 million particle words. Both populations remained one
million. Normal compaction and water evolution were restored before timing.

The initial app fixture served the wrong Vite root and failed before any
measurements. A first paused comparison left scene evolution/compaction active
and changed 5,556 HDR pixels despite exact state words; the corrected controls
above passed. A profiles-only retry initially accessed an unset effect global;
that fixture error was corrected. All failures are retained in
`test-results/vfx-island-native-failures.jsonl` and separate failed-session JSON
artifacts. The original pass classifier also included Water Spray because both
declare `struct Particle`; current source uses the VFX-specific `positionLife`,
`respawn.sequence`, `curlNoise` and billboard camera/circle signatures. Retained
app results are corrected using the current effect's newly created pipeline
IDs, verified against each captured pass, with original attribution preserved.

## Same-queue actual compute-and-billboard chains

A separate native fixture used the actual compiled original/full VFX classes,
the same Afterlight camera and field/options, one million particles, 1432×768
HDR4 and D32S8. Twenty matched three-frame chains warmed each variant, then ten
AB/BA pairs shared one command encoder/queue. Each frame copied the actual CPU
uniform packing from one retained header buffer before ordinary simulation,
atomic live compaction and the actual indirect billboard draw. One query set
and two timestamp buffers were allocated once; no per-frame queue wait occurred.
The three-frame span includes the prior billboard read → next simulation write
transition that a compute-only fixture misses. Deterministic long-lived records
avoid respawn ordering during this timing window; births and deaths are covered
by the earlier population/field fixtures.

| Milliseconds per frame | Original median | Full median | Median paired saving | Wins / ties / losses |
| --- | ---: | ---: | ---: | --- |
| Compute | 1.7913 | 1.7258 | 0.0437 | 9 / 1 / 0 |
| Billboard draw | 2.7088 | 2.5777 | 0.1529 | 9 / 0 / 1 |
| Compute + draw pass sum | 4.4783 | 4.3254 | 0.1966 | 9 / 0 / 1 |
| Three-frame span, divided by three | 4.5438 | 4.3691 | 0.2185 | 9 / 1 / 0 |

All 16 million record words and rendered HDR pixels were exact after 90 matched
updates, with one million live instances in each variant, 6,199 visible pixels
and no GPU/shader errors. Canonical ordering was used only for image parity.
The fixture uses blank reversed-Z depth, retaining camera/field but omitting
island occlusion. It proves a useful isolated producer-plus-draw gain and no
new consecutive-frame hazard in this workload, not an overall 60 FPS result.
An earlier chain run also passed quality/timing but serialized a detached mapped
view as null populations; its original report is preserved and the corrected
run copies population numbers before unmapping. Timestamp sums are integers
before conversion, so floating addition does not misclassify ties.

Parent retained the natural full-write implementation for exact quality,
64 MB lower state storage, 83 gzip bytes smaller code and the paired chain gain.
The partial-write variant remains rejected. Native final combined-scene and
hosted startup acceptance are separate work.

The portable scripts also preserve the native app/chain experiments:

```sh
node scripts/benchmark-vfx-island.js 5fc55a0826fba23f0ff220f48bc6bf6de6c305cd
node scripts/benchmark-vfx-render-chain.js
```

Run the explicit-ref measurement script first. The chain script reads the camera
from the retained island report. Complete native evidence is in
`test-results/vfx-island-native-ab.json` and `vfx-render-chain-native.json`.

## Conservative behind-eye billboard experiment — measured, unretained

This is **measured and unaccepted for retention**. The ignored candidate tests only whether
the entire rotated quad is conservatively behind the homogeneous eye plane. It
does not change the 64-byte records, live-ID list, five-word indirect population,
simulation, bindings or dispatch count. Every vertex/fragment operation on the
visible path retains the original arithmetic. No Core or production VFX source
change is made. Shader text grows 1,295 → 1,613 characters. The actual optional
package adds 323 raw / 118 gzip bytes versus the retained single-buffer package;
final byte acceptance is still required before retention.

The prepared real-GPU fixture uses the immutable retained Afterlight build's
actual compiled VFX constructor. It captures the actual HDR4 background and
every reversed-Z depth sample immediately before its particle draw at three
camera yaws, then restores those samples for each original/candidate draw.
All HDR samples, all depth samples, actual indirect words and nonempty visible
particle coverage are checked. Eight additional 1×/4× synthetic cases exercise
near/far and side clipping, wholly behind-eye and partially clipped quads,
rotation, zero alpha, custom negative/zero sizes, oblique homogeneous-W matrices,
orthographic matrices and large coordinate cancellation. These synthetic cases
are labeled separately from the native island's occlusion; they do not claim
physical-phone coverage.

Its separate timing phase copies the actual package-packed 224-byte header
before each of three actual compute/draw steps. Both effects receive the same
initial native records and keep ordinary atomic compaction during 60 warm and
30 measured steps. One measured command buffer counterbalances ten pairs. The
native HDR/depth background is restored before the first compute timestamp for
each frame. Final all-16-million-word state equality, live counts and evolved
native HDR/depth equality precede any retention decision. Canonical alive order
is used only for pixel comparison; fixture allocations are excluded and steady
GPU-buffer/query allocations must remain zero.

The following commands ran sequentially with the exclusive hardware slot:

```sh
node test-results/measure-vfx-behind-candidate.mjs
node test-results/vfx-behind-fixture.mjs quality
node test-results/vfx-behind-fixture.mjs chain
```

The quality fixture passed all eleven cases with no shader/GPU/page errors.
Each of three native 1432×768 views compared all 4,399,104 HDR/depth samples,
with 10,665 / 8,817 / 3,298 visibly affected particle samples and nonempty island
depth coverage. Eight additional 1×/4× synthetic cases passed every channel and
depth sample with zero nonfinite colors. Native indirect populations stayed at
one million; synthetic populations stayed at 257. The precise guard leaves a
radius and arithmetic-cancellation margin around homogeneous W=0 rather than
rejecting every center behind the eye. Partly clipped billboard edges remain
covered by the test. Pixel equality uses canonical live ordering, as in the
earlier package checks; production compaction is unordered.

The native same-command compute/draw chain then passed all 16,000,000 state-word
comparisons, one-million populations and all 4,399,104 evolved HDR/depth samples.
It retained 9,969 visibly affected particle samples and the actual island depth.
Sixty warm-up and thirty measured updates per variant used the real compiled
class and ordinary atomic compaction. Ten alternating pairs shared one command
buffer, with no timed GPU-buffer/query allocations or GPU errors.

| Milliseconds per frame | Original median | Guard median | Median paired saving | Wins / ties / losses |
| --- | ---: | ---: | ---: | --- |
| Unchanged compute | 2.4685 | 2.4467 | 0.0437 | 6 / 1 / 3 |
| Billboard draw | 3.4516 | 3.3423 | 0.1092 | 8 / 0 / 2 |
| Compute-through-draw span | 5.9419 | 5.8327 | 0.1529 | 7 / 0 / 3 |

The observed span reduction is modest. The compute shader is unchanged, so its
small fluctuation is not attributable to vertex gating. This does not establish
a whole-island FPS gain, sustained 60 FPS or sub-second startup. The snapshot
precedes the later first-reflection startup fix; its steady rendering graph is
retained, while new startup must be tested independently on the new build.
The ten-pair summaries retain the fixture's upper-middle order statistic for
even sample counts; all raw samples and pairing order are preserved.
Timing coverage is the native occluded island field. The eleven quality cases
include visible/edge quads, but a fully in-front field where this predicate
rejects nothing has not been timed. Its added predicate work may behave
differently; that control is required before a generic package retention claim.

The `write:false` package measurement is 13,841 raw / 4,659 gzip bytes for the
current baseline and 14,164 / 4,777 for the guard. Its intentional byte gate
fails after saving the report. The +118 gzip cost versus the retained package
is +35 net versus the earlier 4,742-byte ping-pong implementation. Hardware
measurement completed despite that byte failure; byte acceptance is the final
retention condition rather than a reason to skip measuring the hardware delta.

A later private string-only preparation removes exactly one analytic-curl WGSL
comment body, preserving every newline and remaining simulation token. It
reconstructs the original source exactly when the comment is reinserted, keeps
the measured guard byte-exact and preserves classifier hooks. That estimates
14,094 raw / 4,728 gzip bytes: −14 gzip versus the pre-single-buffer package,
but +69 versus the current retained package. This has not been rebuilt, compiled
or GPU-verified. It cannot be double-counted with a broader comment-stripping
candidate. Package/consumer bytes, exact GPU state/HDR/depth checks and normal
whole-app cadence remain required before any adoption.

Raw evidence is `test-results/vfx-behind-{quality,chain,size}.json`; the recovery
preparation is `test-results/vfx-behind-comment-recovery-estimate.json`. Hardware
sessions 26984 (quality) and 95151 (chain) exited successfully and closed all
owned contexts, devices, browser and server before releasing the hardware slot.
The optional package distributions and production source remain unchanged.

## Circular billboard rotation removal — rejected

The radial fragment formula suggested removing the per-vertex sine/cosine
rotation while retaining every simulation field and the original fragment.
The private virtual package shrank from 13,841 raw / 4,659 gzip bytes to
13,743 / 4,623, but native output failed the quality gate. At the first actual
4× HDR island view, **9,514 of 4,399,104 HDR samples differed**; depth samples
matched, nonfinite channels were zero and both populations stayed at 1M.
Mathematical circle symmetry therefore did not establish pixel equivalence.
No timing comparison ran and no production change was retained.

The first attempt rejected a changed browser viewport before measuring quality.
The corrected fixture fixed the actual canvas at 1432×768 and saved every
executed helper hash. It ran while the Windows screen saver was active: this
untimed native output comparison is not foreground FPS or presentation proof.
One device retired exactly once, tracked resources cleared, the browser/server
closed and all exact owned process IDs were verified absent.

The immutable failed comparison is
`test-results/vfx-circle-rotation-quality-viewport-fixed-v2.json`
(SHA256 `9c46820e72a1470f40949efa008820078c9e7cdf6ec812263155f2c35472380d`),
with terminal cleanup in its `.terminal-cleanup.json` sidecar. Package-only
bytes are `test-results/vfx-circle-rotation-package-size.json`; that size win
does not override the failed image comparison.

### Separate HDR error diagnostic — rejection confirmed

The strict failed raw and frozen helpers above are unchanged. A distinct
headless diagnostic reused that exact helper with an identical original A/A
draw and FP16 decoding, continuing all **3 native yaw + 8 synthetic cases**.
It ran on verified Intel `xe-2lpg`, fallback false, actual 1432×768/DPR1/native
HDR4 with unchanged 1M particles and no custom GPU/shader-debug flags. No timing
queries or frame-rate/presentation acceptance ran. The fresh initialized
snapshot differs from the prior one: its yaw0 has **9,661** changed HDR samples,
not the old immutable **9,514**; old pixel words were not saved for retrospective
error decoding.

| Native view | Max absolute HDR channel error | Mean error over changed channels | Background-relative contribution lost / gained |
|---|---:|---:|---:|
|Yaw0°|4.569336|0.0835834|625 /639|
|Yaw90°|4.346199|0.0815259|530 /591|
|Yaw180°|2.710236|0.0095291|96 /88|

Values are decoded linear HDR units, before display tone mapping. The yaw0
whole-frame mean is only 0.000144548 because unchanged background dominates;
it does not erase large local changes. Yaw0 contribution samples change
9,670→9,684, with 3,584 changed pixels. Nonzero HDR/RGBA counts include the
background and stay equal; contribution means packed color differing from the
identical restored background, rather than a geometric raster mask.

Original A/A has **zero HDR/depth differences in all 11 cases**. Candidate
depth also matches in all 11, while strict HDR equality fails in every case.
Synthetic maximum errors are 0.00390625–0.0078125; 4× orthographic contribution
coverage loses45/gains7 samples, with other synthetic coverage counts stable.
No nonfinite HDR/depth values occurred. Every differing sample's index and
old/new packed HDR/depth words are retained. Numeric metrics alone do not
define a visible-quality threshold; substantial native local errors and
contribution changes confirm keeping circular rotation removal rejected.

The run exitedzero with no errors; its one device retired once, browser/server
closed and all seven exact owned PIDs were absent. Startup/capture RAF callbacks
were counted only, never timed as cadence. Raw is
`test-results/vfx-circle-metrics-diagnostic-metrics-v1.json` (96,468,161 bytes);
compact immutable summary is its `-summary.json`, with full stdout `.log` and
frozen executed helper hashes. See
[all eleven cases and limits](vfx-circle-rotation-hdr-metrics-2026-10-13.md).
No source/distribution change or further timing trial was retained.

## VFX field-write comment recovery — gzip passes, quality partial, 2026-10-13

One separate private variant removes only the existing analytic-curl WGSL
comment, preserving its newline and every field-write math token. Three static
checks prove reverse source reconstruction, billboard/64-byte ABI/atomic
identity and rejection of unexpected comment changes. Actual matched
`write:false` builds measure VFX **4,659→4,632 gzip (−27)** and the whole
current consumer **102,365→102,347 (−18)**; both raw totals increase92 bytes.
All inventoried production source/public distribution bytes remain unchanged.

Native headless Intel/nonfallback correctness matches all36 no-birth A/B and18
original A/A state/set/count comparisons; capacity1 accepted births match.
Actual alive order still varies. Multi-birth state/selection differs, including
capacity63 with546 differing words in each of3 A/B comparisons despite zero
differences in both A/A controls. Larger baseline variability does not establish
equivalence. Image parity, native traffic and speed remain unmeasured; no
adoption or performance acceptance. Zero RAF/render/query calls, one device
retired once, zero live buffers and all7 exact owned PIDs absent.

Detailed counts, hashes, immutable raw and complete logs are in
[the field-write correctness evidence](vfx-field-write-correctness-2026-10-13.md).

## VFX live-only field-store follow-up — consumer size failure, 2026-10-13

One private born-flag variant restores both original whole-record birth stores
and the local color assignment, using partial stores only for an already-live
particle. The one analytic-curl runtime comment is removed with its newline
preserved. Three static reconstruction/math/ABI/billboard guards pass.
Actual `write:false` VFX gzip **4,659→4,657 (−2)**, but all whole-current-app
JavaScript chunks total **102,365→102,367 (+2)**; raw rises95 bytes in both.
The consumer size gate fails, so no native correctness/respawn or timing ran.
All protected source/distribution hashes are unchanged; previous variants and
raw evidence remain immutable. No adoption or scheduling-quality claim.

See [the separate failed-size evidence](vfx-field-write-correctness-2026-10-13.md)
and `test-results/vfx-live-field-write-size-v1/report.json`.

## VFX immutable birth predicate — final private quality follow-up, 2026-10-13

Reusing the original expired-life predicate once as immutable `born` preserves
both original whole-record birth stores/local color and partial writes only
for already-live particles. Three static math/reversal/ABI/billboard guards pass.
Actual `write:false` package gzip **4,659→4,651 (−8)**; whole-current-consumer
gzip **102,365→102,358 (−7)**, raw+84 in both, protected source/dist unchanged.

Native headless Intel/nonfallback no-birth36/36 A/B and18/18 A/A state/set/count
match. Birth capacities1 and63 each match3/3 A/B plus2/2 A/A exact state and
actual order. Larger births/actual live order still vary with original A/A
variability; this is no blanket quality pass or asserted deterministic contract.
Image parity, actual generated traffic and speed remain unmeasured; no adoption.
Zero RAF/render/query, one device once/0 live buffers, all8 owned PIDs absent.
Branch closed after this final variant pending awake hardware and separate grant.

Complete table/hash/raw/frozen proof is in
[field-write correctness evidence](vfx-field-write-correctness-2026-10-13.md) and
`test-results/vfx-compaction-headless-live-predicate-v1/summary.json`.

## Triangle-strip proposal closed after read-only audit — 2026-10-13

Both the pinned old live bundle and current VFX already issue an indexed
triangle-list draw with indices [0,1,2,2,1,3] over four unique billboard corners.
The indirect first word 6 is an index count, not proof of six vertex-shader
executions. A four-vertex strip can represent the same two triangles, but no
2M vertex-invocation saving at 1M particles is established. The branch was
closed as diminished returns without preparing or adopting a strip candidate,
changing source or running a build/browser/GPU comparison.

Separately, the successful awake browser trace records about 40.6 Hz under an
already-active elevated WPR session. Its native recovery save remains pending
(child PID 49052 launched 22:50:51 UTC; worker observation timed out at 180
seconds; approximately 1 MB ETL provisional). No completed recovery, sustained
60 FPS or deployment claim follows. See the
[qualified awake trace evidence](afterlight-awake-existing-etw-trace-analysis-2026-10-13.md).
