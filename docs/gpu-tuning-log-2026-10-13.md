# Desktop GPU tuning log — 2026-10-13

Target: Afterlight on the actual Windows laptop, at least 60 FPS in the original
desktop scene. Preserve rendering quality, package boundaries and the core/stage
size gate. Record experimental changes, keep demonstrated improvements, remove
unsuccessful changes. Production has not been updated by this investigation.

## Measurement conditions

These initial conditions describe the earlier runs. The dated continuation below
records later Chrome versions, immutable live fixtures and changed test settings.

- Intel Arc 140V, driver 32.0.101.8860, nonfallback WebGPU, Windows on AC power.
- Native headed Edge 154; desktop canvas 1432 × 768, device DPR 2, render DPR 1.
- Desktop geometry, 110k grass, 256 water segments, 1024-pixel shadows retained.
- Particle field Off isolates the reported slowdown; 1M remains available.
- Freeze the same clock/camera for comparisons, warm pipelines before sampling.
- Separate uninstrumented cadence measurements from sparse GPU timestamp samples.
- Other applications and GPU frequency changes can affect absolute results.
  Use counterbalanced comparisons and same-queue shader tests to reduce this.
- GPU pass durations exclude copies between passes, queue and presentation waits.
  Acquired canvas frames measure rendering cadence, not physical presentation.

## Experiments

| Experiment | Result | Decision / evidence |
| --- | --- | --- |
| Particle Off versus 100k | Both remained slow in the reproduced desktop workload. User's live screenshot shows 46 FPS with Off. | Particles do not explain this regression. No default change accepted. |
| Original desktop 4× → descriptor-only 1× → restored 4× | Without timestamp instrumentation: 34.85 → 67.43 → 42.32 acquired frames/s. Same desktop scene, clock, camera and canvas. GPU work roughly 18–21 → 9 ms; JavaScript median 1.2–1.4 ms. | Isolates desktop multisampled GPU rendering as the main cost. 1× is an ablation, not an accepted quality change. `test-results/afterlight-off-native-sampling.json`, `afterlight-off-ablation.json`. |
| Disable fog, then restore | Sparse-profiled cadence 34.59 → 40.91 → 38.83; fog itself 1.18–1.38 ms at 4× versus 0.13 ms at 1×. | Fog contributes but is not the whole slowdown. Restore authored fog settings. |
| Remove PBR backface discard | Original → removed → restored: 33.12 → 31.11 → 34.30 FPS. Terrain GPU 8.192 → 9.110 → 7.930 ms. | Rejected; only injected into test browser, no source change. `test-results/afterlight-discard-ablation.json`. |
| Precompute PCSS golden-angle offsets, retain 16 blocker + 32 filter samples | Candidate terrain 6.62 versus restored original 8.59 ms; total 17.76 versus 19.53 ms. Whole-app FPS gain inconclusive, initial baseline suffered an outlier. | Candidate pending same-queue performance and pixel comparison. No package change yet. `test-results/afterlight-pcss-offset-ab.json`. |
| Skip Clustered calculations when no lights contribute | No convincing GPU improvement against restored baseline. | Rejected; no package change. Same PCSS comparison artifact. |
| Shared Sky fog once per pixel, retaining coverage mask and 4× geometry | Build, 10 unit tests and actual GPU sample coverage/compilation checks pass. | Candidate pending whole-app performance/visual acceptance. Covered subpixel layers share nearest-depth fog; fixture explicitly measures the fog-start difference. `test-results/sky-fog.json`. |
| Borrow resolved HDR color directly for 4× water refraction | Investigation shows water writes 4× attachment while resolved 1× color is a distinct stable input; the 1× path still requires a copy. | Candidate under implementation and validation. Preserve all water optics and samples. |
| Existing Stats GPU profiler audit | One preallocated query set, two 2 KB buffers, reused descriptors, one async read in flight; sample every 15 frames; no per-frame queue wait. | Retain existing pool; add per-pass durations and elapsed span. Twelve tests pass, including 100 readbacks with the same CPU array and three GPU resources. Current core device does not enable timestamp-query; controlled diagnostics enable it before device creation. |
| Combined Sky/Water/PCSS candidates, full 4x desktop | Uninstrumented ABBA: baseline 30.75/33.48 versus candidate 34.75/37.41 frames/s, about 12.4 percent mean improvement. | Target remains unmet; continue tuning. Paused screenshots differ in 2.052 percent of pixels, mean RGB error 0.0232 byte values; classify changes before visual acceptance. `test-results/afterlight-whole-app-ab.json`. |
| Pooled GPU timings: pass sum versus elapsed span | Baseline sum 20.51 ms, span 29.16 ms; candidate sum 15.86 ms, span 23.46 ms. | Inter-pass work/gaps account for 8.65/7.60 ms. Investigate copies, transitions and possible external GPU scheduling before naming a cause. Zero query/buffer allocations during both eight-second measurement windows; no GPU errors. `test-results/afterlight-pooled-profile.json`. |
| Plain depth32float without unused stencil | Every native pixel and the draw/dispatch counts match. FPS 47.99 -> 51.72 -> restored 57.21. | Clock drift prevents a demonstrated gain. No source change. `test-results/afterlight-core-target-ab.json`. |
| Terrain triangle order reversal | Same-page 49.93 -> 55.03 -> restored 51.78 FPS, +8.2% versus bracketing mean. All three orbit image comparisons have zero RGB difference. | No source change yet; static reversal could hurt other camera views. `test-results/afterlight-terrain-order-samepage.json`. |
| Authored single-sided terrain/closed humanoid hardware culling | ABBA original 41.35/39.05 versus culling 47.25/43.93 FPS, +13.4% mean. Three above-ground orbit images identical. | Existing materials are double-sided. Preserve underside behavior; do not change defaults. `test-results/afterlight-authored-cull-ab.json`. |
| GPU copy/transition markers | Cached 16 MB shadow-depth copy median 0.655 ms; wet-state and scatter counter copies contribute less than 0.06 ms combined on average. Remaining gaps distributed across transitions/pass boundaries. | No single 7 ms copy explains the elapsed span. Marker capture uses reused resources; no errors. `test-results/afterlight-copy-gap-summary.json`. |
| Native final depth-copy/color-resolve fusion | Same-queue ten AB/BA pairs including dependent-read sentinel: 0.852 -> 1.180 ms median, candidate loses all ten. All HDR and four-sample depth pixels identical. | Rejected, no package/payload change. `test-results/msaa-native-final-fusion-microbench.json`. |
| Software depth/color resolve fusion | Dependent-read sentinel shows 0.393 -> 0.328 ms median; repeated ten pairs all faster. Full HDR/alpha/depth parity in the fixture. | Generic unorm/sRGB semantics and added code/size are unproven; not accepted into core. `test-results/msaa-fused-resolve-microbench.json`. |
| CPU-precomputed PCSS cascade basis | Four varied fitted cascade orientations, 40 AB/BA pairs: old/new medians identical; 52-173 HDR pixels per 1M differ by up to one half-float ULP. CPU basis preparation ~0.148 microseconds per frame excluding upload. | Rejected: no consistent gain and no exact pixel parity. No source change. `test-results/pcss-basis-microbench.json`. |
| glTF-pro authored hardware culling | All 30 actual HDR/depth comparisons identical. Four-sample paired median span 0.590 -> 0.459 ms, 9 wins/1 tie; 1x 4 wins/6 ties/no losses. | Performance and parity demonstrated. Optional package +30 gzip bytes; final size acceptance pending. `test-results/gltf-cull-hardware.json`. |
| Exact four-mask fog alternative | All 4M RGBA sample comparisons per case identical. Four lighting cases, 40 pairs: 1.049/1.180/1.245/1.049 -> 1.311/1.442/1.573/1.507 ms. | Rejected: slower in all pairs. No source change. Nearest-depth approximation also removed to preserve original subpixel layers. `test-results/sky-exact-masks-microbench.json`. |
| Opaque main-mesh depth prepass | Six native color/depth comparisons exact; 134 -> 137 draws, dispatches unchanged. Candidate 31.16/32.96 FPS versus restored original 41.62. First original has invalid transient 1-4 FPS. | Rejected. Initial auto bind-group layout reuse fails validation, repaired with explicit bindings before valid tests. No package change. `test-results/afterlight-depth-prepass-ab.json`. |
| Skip shared final depth resolve globally | Other optional/user passes can write depth; no safe write-generation marker exists. | Rejected as unsafe; preserve depth and nested capture contracts. |
| Bloom Gaussian weights precomputed on CPU | One native Intel Arc 140V/Edge154 command buffer, 40 AB/BA pairs, actual shared two-pass filter, 1,024² HDR outputs and identical dependent-read sentinel. Only 4/40 pairs win; typical medians 0.459 -> 0.459-0.524 ms. Four of nine actual GPU exp weights differ from CPU Float32 values by one ULP. Every horizontal/final HDR pixel is checked: threshold 1.2 changes 1/8 pixels, threshold 0 changes 11,493/11,881, threshold 1 changes 2,426/3,240; maximum HDR difference 0.0625. Alpha and finite-value checks pass. Shader grows 118 raw bytes. | Rejected: output differences, no consistent speed gain and larger payload. No Post source change. First fixture attempt used a reserved WGSL identifier; corrected before these valid results. `test-results/bloom-weights-microbench.json`. |

Earlier measurements, the past-48-hours commit timeline, Citadel haze optimization,
texture payload work and unresolved Android/startup results are recorded in
`performance-investigation-2026-10-13.md`.

## Acceptance still required

Latest retained-source native ABBA (07:43UTC):48.08->57.76FPS Off and36.96->42.42FPS
at1M; all three matched paused views are pixel-exact. Default timing creates zero
queries; opt-in allocates exactly one pool and nothing during8-second windows.
The actual remaining Off GPU span is18.02ms versus13.43ms pass sum. Full scene
startup1.45-2.68s and tail intervals still fail. Live bytes99,299gzip versus
pre-staging candidate100,023gzip leave724bytes to recover. These measurements
supersede earlier approximate-fog candidate figures. New startup staging is
functional-tested separately and has not yet received native production timing.

Source audit of the proposed bandwidth fix: desktop render DPR is already1,
and Bloom's two half-resolution blur textures are1x. Its final AgX render pipeline
inherits4x and Core subsequently resolves the outer color. Investigate that
presentation path with exact pixels and later-depth-pass compatibility. A1x/DPR1.5
choice would also increase post-processing pixels2.25x relative to this actual
current DPR1 scene; neither DPI nor buffer-binding limits prove GPU throughput.
Core is already19,975gzip and has no newly added MSAA routing features.

- Whole-app before/after cadence and tail frame times with timing disabled.
- GPU timestamp breakdown, then measured overhead of the reusable profiler.
- Matched screenshots and meaningful pixel/sample coverage checks.
- Package builds, affected unit/browser checks, and unchanged core/stage size gate.
- Actual production read-back if a release is authorized; physical Android remains
  unavailable and its separate 3 FPS report is not resolved by the desktop ablation.

## Continued diagnosis: live build, 2026-10-13

The pinned live entry SHA256 is
`1d096ef1af9fc7b0d505d46e70d6e5bd1ee0de906590151f3e0b156977ce9fa1`.
The latest four fresh-context GPU windows used Chrome 155.0.8059.40,
1432 x 768 physical pixels, DPR 1, 1x sampling and 1M particles. Desktop /
phone settings / phone settings / desktop median native GPU spans were
27.525 / 23.396 / 23.790 / 27.918 ms. Particle simulation and particle drawing
each consume roughly 4.5-5.3 ms, main terrain/explorer shading 3.34-4.26 ms,
settlement shading 3.146 ms and grass drawing 0.197-0.786 ms. Median within-span
time outside timed passes was 3.47-5.37 ms. This is a measured workload breakdown,
not proof of bandwidth saturation, driver stalls or thermal throttling.

Raw report and per-pass summary:
`test-results/afterlight-live-scene-gpu-profile-chrome-10s-live-scenes-gpu-v1.json`
and its `.pass-summary.json` sibling. Timestamp profiling changes the device
feature set and observed cadence; these are not accepted default FPS results.
Asynchronous mapping latency is not GPU execution time and is not calibrated
to a particular CPU frame. All four devices/resources retired; browser close
timed out separately. Native process absence is recorded in cleanup evidence.

User-requested differential matrix, prepared before further package changes:

| Test | Fixed conditions | What it distinguishes | Acceptance restriction |
| --- | --- | --- | --- |
| Full / compute only / draw only / neither | Same live build, phone scene values, 1x, DPR 1, frozen camera, initialized 1M state | Particle simulation, raster and joint synchronization cost | Fresh contexts; validate indirect occupancy outside measurement; suppress entire simulate method for static draws |
| Blending on / off | Identical geometry, particle capacity and sampling | Blend/fragment workload contribution | Diagnostic only; opaque particles change the image |
| Current display cadence / unloaded RAF | Actual Windows refresh, same browser | Whether cadence matches a presentation divisor | First read actual refresh; numeric resemblance alone proves nothing |
| Correlated browser trace with controls | Same pinned desktop build, no shader-debug flags | CPU/GC/Dawn/submission/compositor events and tracing overhead | Wall spans cannot simply be summed; do not equate CPU returns with GPU completion |
| Windows GPU + GeneralProfile ETW | Owned bounded recording, no pre-existing capture | Kernel scheduling/paging/presentation evidence | Requires OS elevation; missing ETW is explicitly unverified |

Live VFX already has two particle-state buffers. Current optimized source has
one state buffer. Particle draw uses read-only storage bindings, not a particle
VERTEX buffer. One command-buffer submission per measured frame is already
verified. Therefore the suggested missing ping-pong and exact UAV-to-VB transition
must not be reported as confirmed causes. Decoupling simulation from drawing
also requires coherent alive-index and indirect-count state, not only a second
position buffer. No such production change has been accepted.

The direct desktop phone-settings source trial changes terrain resolution to 96,
heightmap to 128, grass to 25,000, shadows to 512 and water segments to 64.
Core/Stage and the selectable 1M workload are unchanged. Source backup, candidate
hashes and guarded restore are in
`test-results/desktop-phone-settings-source-backup-20261013/`. Its production build,
matched 1x test, quality decision and retained/rejected result remain pending.

### Later results and native calibration restriction

The matched source ABBA completed: original / phone values / phone values /
original yielded 52.3977 / 63.4791 / 57.9756 / 52.6997 render-submit Hz at
1432×768/DPR1/1× and full 1M. Candidate p95 gaps were 21 and 24.8 ms; principal
GPU completion exceeded one second in every run. Thus the trial improves
cadence but fails the sustained-60 and one-second acceptance gates. It remains
a provisional app diagnostic, with guarded rollback and no hosted publication.
See [source evidence](afterlight-desktop-phone-source-trial-2026-10-13.md).

The default particle differential completed at 43.697 / 54.083 / 49.557 /
65.107 render-submit Hz for full / compute-only / frozen draw-only / neither.
Both simulation and drawing matter; these distinct-context rates cannot be
added to derive a barrier cost or a locked-60 result.

ASUS OLED Care screen saver started after that source run and before the blend
ABBA. Later native checks confirmed the Screen-saver input desktop/PID0; GPU
counters showed competing screen-saver activity. The blend result cannot
establish idle-awake foreground cost. A new native guard rejects this state
before Chrome launches. No display, power, lock or screen-saver setting changed.
Future performance windows require a Default input desktop and exact owned
Chrome foreground proof throughout measurement.

VFX circular billboard rotation removal saved 36 gzip bytes but changed 9,514
HDR samples, so it was rejected before timing. The field-write candidate passes
exact no-birth state/count/set and single-birth checks but not generic respawn,
image, size or speed acceptance. See [VFX evidence](vfx-performance-2026-10-13.md)
and [field-write checks](vfx-field-write-correctness-2026-10-13.md).
