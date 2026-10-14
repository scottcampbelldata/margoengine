# Afterlight caller cadence and timestamp capability diagnostics

Status: **private recovery fixture ready; both earlier browser attempts failed
before timed measurements**. Core,
Stage, production orchestrators and default quality are unchanged. These test
falsifiable plumbing hypotheses after native GPU spans and actual render rates
did not alone establish a hardware wall. Existing Edge results are not assumed
to match the user's installed Chrome.

The cap diagnostic defaults to installed **Chrome**, accepts `BROWSER_CHANNEL`,
records channel/version and uses one native page/device for Off and 1M particle
ABBA windows. All paths retain desktop 4×, DPR1, 1432×768, current full terrain,
grass, water and shadow settings, fixed hours and exact camera. Trusted external
camera input is suppressed before application listeners, as in the corrected
sampling fixture. The immutable build predates the later first-reflection
startup fix; its retained steady graph is the scope of this comparison.

The temporary caller wrapper tests the existing Citadel `frameDue(clock,now,60)`
helper before delegating to the original `Engine.frame`. On actual render frames,
that original method still invokes its complete callback set, computes delta
from the previous actual render timestamp, renders and schedules its next real
RAF. Skips do not change engine last-time, app counters, Stats or particle state.
No synthetic frame counter or measured-FPS rewrite exists. Simulation retains
the original full-wall-time delta and 0.1-second clamp.

A read-only sibling review caught a fixture mismatch before execution: the
published immutable consumer compacts private Engine members to frame `m`,
outstanding RAF `g`, last timestamp `h` and callback set `i`. The prepared runner
now derives and verifies that mapping from the exact source SHA rather than
assuming readable TypeScript member names. The source/actual-method hashes are
recorded. Another review finding removed duplicate manual device destruction:
Core already retires the previous device during reboot. The new audit counts
destroy calls and cleanup destroys only still-owned devices, requiring exactly
one retirement per device and no live tracked buffers/textures. All wrappers
install in one ordered init script.

A separate bounded RAF observer measures the native callback cadence without
rendering or writing Stats. Actual app callback counts, completed engine-render
counts, original callback references, original delta, Stats intervals and native
RAF timestamps are recorded separately. Assertions require real app and render
counts to agree. It uses preallocated numeric storage; no GPU timestamp queries
or waits are introduced. Real pause/resume, repeated start and an actual hidden
tab/foreground return are checked outside measured windows; every real RAF is
canceled and original methods/callback membership are restored at cleanup.

The queued capability experiment uses the same fixture with uncapped cadence.
It filters **only** `timestamp-query` from requested device features, keeping
depth/stencil, limits and every unrelated descriptor field. Same-page device
reboots produce enabled/disabled/disabled/enabled windows at 4×/DPR1. Actual
negotiated features and zero default timing-query allocations are asserted in
both paths. It does not permanently disable GPU timing; full deterministic scene
pixel equality, startup and subsequent feature-on profiler proof remain required
before any adoption. No cost is assumed merely from negotiating a feature.

Prepared commands, only after the owner grants the exclusive hardware slot:

```sh
node test-results/afterlight-cadence-diagnostic.mjs cap 6 http-ready-lifecycle-v2
# Optional longer window after evidence warrants it:
node test-results/afterlight-cadence-diagnostic.mjs cap 10 http-ready-lifecycle-v2
# Separate grant/decision after the cap result:
node test-results/afterlight-cadence-diagnostic.mjs capability 6 http-ready-lifecycle-v2
```

All four lightweight fixture contract checks pass using the immutable entry's
actual compiled, compacted onFrame/start/frame/stop method bytes: a simulated
120 Hz clock dispatches 60 original cap renders with the exact wall-time delta; uncapped
dispatches 120; stop/idempotent start/resume/restoration preserve ownership; and
the capability filter changes only its one feature. Those checks use fake RAF
and render/device contracts, **not real GPU/FPS or app visibility proof**. Syntax checks
pass. Preparation/source/helper hashes are in
`test-results/afterlight-cadence-diagnostic-preparation.json`. New observations
will use distinct experiment/channel/window report names, preserving all older
sampling and cadence evidence. No physical-phone or one-second load claim follows.

Recovery evidence: `afterlight-cap-fixed-camera-chrome-6s.json` failed while
waiting for the actual hidden state with RAF polling. Hidden RAF polling cannot
advance reliably, so the same actual hidden/stopped/canceled-RAF condition now
uses 50ms timer polling. The next attempt,
`afterlight-cap-fixed-camera-chrome-6s-lifecycle-polling.json`, timed out at the
first navigation with zero timed runs. Its original preview port 63192 now
refuses connections. Current focused process queries found no matching cadence
or Vite Node process and no Chrome process with a Playwright profile. User
Chrome was left untouched. The old timeout's exact cause remains unproven.

The runner now checks the preview HTML, module entry and CSS via direct HTTP
before launching Chrome, requiring exact immutable snapshot bytes and the
module's JavaScript content type. The private quality override intercepts the
script using those same immutable disk bytes instead of making a second
`route.fetch` request. Navigation phases, response statuses, request failures
and interception errors are recorded. `open()` failures retire any created
devices and close their owned context; context/browser/server shutdowns are
bounded, and each tier has a 210-second outer deadline. Existing report paths
are rejected so retries cannot erase earlier failure evidence.

HTTP-only recovery proof is saved in
`test-results/afterlight-cap-fixed-camera-chrome-6s-http-readiness-recovery.json`.
The new preview returned exact HTML/module/CSS bytes with HTTP 200 in about
128/58/16ms, then exited with no errors or cleanup failures. This probe used
`CADENCE_HTTP_ONLY=1`, launched no browser, ran no GPU workload or build, and
supplies no rendering-performance claim. The four lightweight cadence contract
checks pass again after recovery preparation. Actual pause/resume, hidden-stop,
full-quality, original-delta and actual GPU-submission assertions are retained.

The granted Chrome cap retry `http-ready-lifecycle-v2` reached DOMContentLoaded
and the complete sandbox with no interception errors, but produced **zero timed
runs**. Bringing the blank page forward left the original page actually visible,
focused and running throughout the 10-second timer wait. The real hidden-stop
assertion failed and was preserved; it was not replaced by synthetic visibility.
The tracked device retired exactly once with zero live textures/buffers. Chrome
close exceeded the 10-second bound; a single remaining GPU child of this exact
Playwright profile exited on its own before any termination. Final focused
checks found no remaining Chrome process with that profile, no runner and a
closed preview port. No process was killed. Stdout, structured failure and a
terminal-cleanup sidecar are retained under the distinct retry label. No cap
benefit or actual render/submit parity claim can follow from this failed run.

The next separately granted retry, `focus-native-v3`, explicitly disabled
Playwright's default focus emulation via CDP on both owned pages. Their target
IDs were distinct and window IDs equal, proving the test used two tabs in one
window. The original page nevertheless remained visible/focused and running,
so native focus emulation alone did not resolve the visibility condition. The
failure was recorded separately and foreground recovery was attempted. That
recovery correctly stopped before timing because the actual viewport was
1440×765 rather than the required 1432×768; `viewport:null` had relied on the
maximized native window to produce exact dimensions. No viewport assertion was
weakened. This run again produced zero timed windows; its tracked device retired
once with zero live resources. Final process checks found no Playwright Chrome
or cadence runner, and port 64937 was closed after the bounded browser-close
timeout. No process was killed. Both failure reports/stdout/cleanup sidecars
remain available. Explicit fixture viewport sizing is the next smallest fix;
native visibility behavior remains unresolved and cannot be called passed.

The next prepared fixture uses an explicit 1432×768 viewport, browser DPR2 and
the existing private engine-DPR1 override. The fifth command argument selects
private samples 1 or 4 (default 4); the sixth selects `both` particle tiers
(default) or just `1m`. Production sampling and Core/public APIs are unchanged.
Actual hidden-stop failures remain separately recorded as partial results.
Timing requires actual visible/focused state, the original target/window,
running engine/real RAF, exact camera and full-quality resource checks. Focus
emulation is disabled, never enabled as a prerequisite for cadence.

The retained module explicitly requests advertised `timestamp-query`, allowing
a clean requested-feature experiment independent of the archived live module.
The prepared narrow command, awaiting a separate hardware grant, is:

```sh
node test-results/afterlight-cadence-diagnostic.mjs capability 8 timestamp-1x-native-v4 1 1m
```

This collects four 8-second windows with requested timestamp capability
enabled/disabled/disabled/enabled, profiling off, at private 1×/engineDPR1 and
unchanged full desktop 1M particles. All unrelated requested/negotiated features,
required limits, exact WGSL bytes, pipeline descriptors, texture descriptors and
memory counts must match after device reboot. No timing queries, query buffers,
read buffers or default query resources may appear. Actual app/render/submit
counts and original simulation delta must agree. Device-loss reason/message and
browser console/driver errors are saved, including failure cleanup metadata.
Shader recording introduces no GPU resources or waits and occurs at creation,
outside the steady measurement windows. Five lightweight contracts and runner/
browser-helper syntax checks pass; this capability comparison is unexecuted.

The still-prepared cap comparisons are:

```sh
node test-results/afterlight-cadence-diagnostic.mjs cap 6 cap-1x-native-v4 1
node test-results/afterlight-cadence-diagnostic.mjs cap 6 cap-4x-native-v4 4
```

Static Playwright inspection found one focus-emulation enable call in its
Chromium main-frame initialization; ordinary viewport update and bringToFront
paths do not contain it. Attached iframe sessions initialize separately, but
the call is guarded to main frames. No evidence establishes a later normal
navigation re-enable in these same-tab runs. Launch flags disable occlusion/
backgrounding behavior, but their role in both tabs remaining actually visible
has not been demonstrated. The recorded native hidden failure remains a fact,
not a confirmed browser-flag or focus-emulation root cause.

The separately granted `timestamp-1x-native-v4` run preserved its exact runner
and seven imported helper files with matching original/copy SHA256s in
`test-results/cadence-repro-20261013T172431858Z/manifest.json` before launch.
One enabled-feature window completed at 33.389 actual/native Hz: 270 app
callbacks, completed renders and real queue submissions agreed; simulation
delta mismatch and query/buffer allocation deltas were zero; the outside-timed
indirect readback confirmed all 1M particles. One-second rates were
31.71–34.95 Hz; Stats interval p95/p99/max were 57.9/83.3/105.4ms. No device loss
or console error was recorded in that completed window.

The actual hidden lifecycle again failed separately; exact foreground, target/
window, viewport1432×768/browserDPR2/engineDPR1 and full-quality checks then
passed before timing. After the enabled window, the transition toward the
disabled device did not return before the 210-second tier deadline. The exact
pending operation was not recorded, so reboot/driver/resource explanations
remain hypotheses. No disabled window or ABBA comparison exists and no timing
cost can be attributed to timestamp negotiation from this run.

The runner exited 1, recorded the browser-close timeout, and closed preview
port 63092. Its fallback context close produced no per-device retirement
observation; **GPU resource retirement is unproved for this failed transition**.
OS process cleanup is separately verified: Get-Process found no live owned
browser25272, utility33836 or runner30888. CIM still returned the old browser
entry after live process lookup could no longer find it; the attempted exact
owned PID termination returned PID-not-found and killed no process. The
terminal-cleanup sidecar records that discrepancy. User Chrome was untouched.
The hardware slot was released; no further browser/GPU launch followed.

## Completed old-live particle isolation, 2026-10-13

The query-free Chrome155.0.8059.40 matrix completed four fresh-context10s
windows on the authored phone scene at fixed1432×768/DPR1/1×, the same camera,
solar time and actual1M capacity/options. Full43.6972Hz (p9528.7ms), compute-only
54.0826Hz (p9525.6ms), frozen draw-only49.5573Hz (p9526.5ms), both-off65.1069Hz
(p9518.4ms). Both isolated particle paths still affect frame tails. All real
render/submit/camera/foreground/full-capacity assertions passed, no timed GPU
allocations or pipeline/shader creation occurred, all resources retired and
owned processes exited without cleanup error. No locked60/presentation claim
is made. This measures the pinned older live two-state implementation, not the
newer single-state local source. See [full isolation evidence and limits](afterlight-particle-isolation-2026-10-13.md).

## Matched desktop source phone-values trial, 2026-10-13

The next query-free Chrome155.0.8059.40 A/B/B/A used two newly built immutable
source fixtures, both desktop UA and retained64MBsingle-state VFX, at the same
1432×768/DPR1/1×/full1M camera conditions. Baseline52.3977/52.6997Hz and candidate
63.4791/57.9756Hz; p95 baseline26.0/25.8ms versus candidate21.0/24.8ms. All five
phone values were verified at runtime, every detail loaded and principal
readiness recorded separately. No locked60 or one-second startup improvement
is established. All checks/retirements passed, runnerexit0 and owned native
processes absent; hardware slot released. See [source comparison and readiness](afterlight-desktop-phone-source-trial-2026-10-13.md).

The later native desktop check found an ASUS OLED screen-saver instance starting
18:34:07UTC, after the source ABBA final write18:33:37UTC. It does not explain
that run's B2 decline. Its page focus/visibility evidence is retained, while
native input-desktop/foreground and physical-presentation proof remain absent.
Later blend FPS measured under the screen saver is confounded separately; no
old source metrics or raw evidence were overwritten. Future foreground runs
require Default input desktop plus exact owned Chrome native foreground.

## Diagnostic claim audit, 2026-10-13

These are decisions from saved source/captures, not new hardware measurements.
The latest root native check at19:21UTC still reports Screen-saver/PID0; no
browser/GPU launch is permitted by the prepared native calibration guard.

| Explanation | Verified evidence | Decision / still unknown |
|---|---|---|
| Refresh divisor | Active Windows mode120.000294Hz, Intel Arc140V/xe-2lpg, AC online. Traced RAF median25ms, about40Hz. |120/3 is a testable correspondence, not physical divisor proof. Native Present1 uses syncInterval0; frame feedback is not GPU-done proof. No automatic60 claim or display change. |
| UAV→vertex-buffer transition | Pinned live billboard shader reads particle/alive STORAGE bindings; pipeline has no vertex-input buffers and both have no VERTEX usage. | The specific VB premise does not describe this ABI. Compute→shader-read/indirect dependencies still exist; actual Dawn/driver barrier cost is unmeasured. A [UAV barrier](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_resource_uav_barrier) describes ordering, not a fixed-duration penalty. |
| Missing double state | Pinned old-live already has two separate64MB states, reversed compute groups and state-specific draw groups; alive/indirect/respawn are shared. Current local VFX uses one64MB state. | Builds must be distinguished. Adding the already-present second live state cannot be claimed as a fix; actual overlap/remaining shared hazards require measurement. |
| TBDR/tile flush | Actual tested adapter is Intel Arc140V, not a physical iPhone. [Intel Xe2 materials](https://cdrdv2-public.intel.com/824434/2024_Intel_Tech%20Tour%20TW_Xe2%20and%20Lunar%20Lakes%20GPU.pdf) describe pixel cache/blending/render backends. | A tile/cache-flush explanation is unconfirmed. Neither calling this TBDR nor categorically denying Intel tiling proves this workload's cache traffic. Hardware counters or valid controlled traces are missing. |
| Particle compute versus draw | Query-free full/compute-only/frozen draw-only/both-off rates43.697/54.083/49.557/65.107Hz; each actual render has one real native submit. Full occupancy1M at boundaries. | Both paths affect workload. Subtractions are not additive GPU costs; ordering/drift, frozen positions and overlap differ. Both-off p9518.4ms and p9925ms do not prove a strict60Hz floor. |
| Opaque/blend-off | Removing particle HDR blend changes alpha/color accumulation. ON/OFF/OFF/ON callbacks36.989/37.543/39.746/41.118Hz occurred after the18:34:07 screensaver start. | [Confound sidecar](../test-results/afterlight-live-particle-blend-abba-v1-screensaver-confound-20261013.json) disqualifies idle-awake foreground FPS/causal blend cost. Shader/ABI/count/retirement evidence survives. No appearance parity or production adoption. |
| Computed19ms delta | Engine delta is elapsed RAF timestamp difference, capped100ms, passed to original render/simulation; successful submits are independently counted. | Simulation time input is not shader execution or unexplained stall duration. No19ms cause is attributed without independent timing/dependency evidence. |
| Larger compositor output | App target1432×768/engineDPR1; browserDPR2; Present dirtyRect2864×1505. | Separate compositor work is plausible. DirtyRect is not the swapchain descriptor. Density-only ABBA is prepared, but real19:07 guard rejected Screen-saver/PID0 before Chrome launch. |

Primary-source call-tree/flag limits are in
[Chromium source investigation](afterlight-chromium-present-source-2026-10-13.md).
Hardware/mode evidence: `engine-hardware-inventory-20261013.json` and
`display-power-inventory-20261013T181104323Z.json`; matrix evidence:
`afterlight-live-particles-default-chrome-10s-particle-isolation-v1.json`.
Point inventories do not establish the same conditions throughout older runs.
No table row establishes sustained60 desktop/mobile, startup<=1000ms or quality
acceptance for all61packages. Raw reports and executed helper copies are unchanged.

Hardware wording correction: the recorded Core Ultra7 258V's
[Arc140V processor GPU](https://www.intel.com/content/www/us/en/products/sku/240957/intel-core-ultra-7-processor-258v-12m-cache-up-to-4-80-ghz/specifications.html)
is integrated and uses shared system memory. [Intel's memory explanation](https://www.intel.com/content/www/us/en/support/articles/000057824/graphics.html)
distinguishes this from discrete dedicated-memory graphics. The capture does
not establish an Optimus/discrete-GPU PCIe-copy path; Windows'16GB GPU label is
not evidence of16GB dedicated externalVRAM. Blending does not necessarily fetch
and write external memory for every fragment: cache/backend behavior matters,
and [Intel's Xe2 material](https://cdrdv2-public.intel.com/824434/2024_Intel_Tech%20Tour%20TW_Xe2%20and%20Lunar%20Lakes%20GPU.pdf)
explicitly discusses pixel-color cache and render-target prefetch. Actual
bandwidth/cache misses/flush costs remain unmeasured. Mobile tiling arguments
cannot establish cause across different sample counts and physical pixel sizes.

Likewise, a proposed computeB/renderA scheme adds a frame of state latency but
does not automatically make passes overlap in this one-WebGPU-queue submission
path. Ordered dependencies still need to hold; shared alive IDs, indirect
arguments and respawn counters retain hazards. Source and API shape alone
cannot prove concurrent compute/draw or a hardware ceiling. Any such comparison
must preserve observable behavior and prove its timing on the exact build.

## Native foreground calibration consolidated — 2026-10-13

The short scene A/B, 60-second sampling runner and browser trace runner now require the Windows Default input desktop and exact owned Chrome foreground before and after timing, plus a bounded 250-ms native observer throughout each window. Saved Screen-saver/PID0 negative preflights reject before their performance browser launches; no FPS or GPU timing is inferred from them. Raw reports, errors, cleanup and SHA256 references are consolidated in `test-results/native-calibration-consolidation-20261013.json`. The latest read-only check at 20:29:39.738UTC still reported Screen-saver/PID0. No desktop switch, input injection, screensaver termination, display refresh change or elevation retry was performed. Positive compositor-density A/B and sustained-frame acceptance remain pending an awake laptop.
