# Private correlated Afterlight tracing

No Core, Stage, public API, production default or display setting is changed.
The pinned live entry is 301,030 bytes with SHA256
`1d096ef1af9fc7b0d505d46e70d6e5bd1ee0de906590151f3e0b156977ce9fa1`.
Only the reviewed private 1×/engine-DPR1 override is served, with explicit
1432×768 viewport/browserDPR2 and the full authored desktop 1M capacity scene.

The first baseline capture preserved its files at
`test-results/live-afterlight-steady-trace-steady-live-v1-2026-10-13T180706185Z`.
Its control-before and instrumented windows passed real render/submit checks
at 39.09 and 40.39 Hz, but empty legacy category discovery yielded a
metadata-only raw trace. It is **not a usable CPU/GPU timeline**. The original
raw stream/report remain unchanged. Device retirement was observed once with
zero live tracked resources; exact owned OS PIDs exited, user Chrome untouched.
Driver-reported display refresh was 120 Hz and AC power was online, without
physical scanout or refresh-divisor proof.

The corrected minimal smoke at
`test-results/cdp-trace-smoke-json-2026-10-13T181553489Z` uses explicit
`traceConfig.includedCategories`, `enableSampling`, and Chrome tracing backend.
Legacy discovery was empty, but `getTrackEventDescriptor` returned a 14,068
character base64 descriptor, preserved in raw form. The recorded fallback uses
installed Playwright's normal trace categories plus renderer/compositor/GPU
categories. Actual output, rather than discovery, validates coverage: 5.56 MB,
27,128 substantive events, all three markers, 3,007 renderer and 6,377 GPU-thread
events, V8 GC/CPU and cc/viz/gpu categories, and no reported data loss. Its GC
probe was explicitly forced on the owned smoke page for coverage only. No full
WebGPU scene ran in that probe. Four lightweight contracts pass.

The full runner requires a validated JSON smoke proof before launching Chrome
and rejects metadata-only or missing renderer/GPU/marker output after draining
the raw stream. The corrected command is:

```text
node test-results/trace-live-afterlight-steady.mjs --run --mode=baseline --seconds=10 --control-seconds=6 --label=steady-live-v2 --smoke-proof=test-results/cdp-trace-smoke-json-2026-10-13T181553489Z/report.json --fences --counters
```

It captures an untraced control before and after the traced window, using one
fresh owned profile without device reboot. Numeric preallocated observations
record real render start/duration/ordinal, native submit start/return/ordinal/
frame association, native RAF and long tasks. Performance marks and bracketed
CDP metrics retain page and browser-monotonic clock mappings. Heap metrics,
network ResourceTiming, shader/pipeline metadata, device loss, GPU errors,
console errors, accepted flags, process creation, chrome://gpu DOM and read-only
display/power state are preserved. Tracing overhead and before/after drift
remain explicit; nested thread spans must not simply be summed. Zero GPU
allocations is not a claim of zero JS/Wasm allocation or GC.

Three optional sampled queue-completion fences occupy a separate window, with
bounded waits and no per-frame await. Their latency includes previously queued
work and scheduling, so it is not per-pass execution time. The optional external
timestamp-pool submit hook binds only after successful native submit and uses
originating render/submit ordinals; the default trace does not enable GPU timing
or add any Core timestamp API.

Baseline, developer-feature and HLSL-debug-symbol modes use separate owned
profiles. Developer features do not establish actual timestamp precision or
GPU/CPU clock alignment. HLSL debug-symbol mode skips shader optimization and
therefore forbids FPS judgments. Default profiling remains off.

The optional WPR worker is reviewed separately. It requires an elevated token,
an inactive recorder, GPU/GeneralProfile availability, a UUID ownership token
and a matching start handshake within a bounded 120-second preparation wait.
Capture itself is capped at 10 seconds. It has no cancel command and stops only
after its own successful start, writing to a guarded unique workspace ETL path.
A UUID cancellation file can end preparation without starting a recording.
Root handles the explicit RunAs/UAC launch; the browser runner never elevates
or launches a duplicate worker. Missing start/stop proof remains unverified.
GPU/DWM counters record permissions separately; utilization/adapter memory are
not hardware-clock or bandwidth proof, and shared DWM/adapter activity can
include other workloads.

Protocol reference: [Chrome DevTools Tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/).

The corrected full baseline `steady-live-v2` ran after the root-owned RunAs
launch returned **The operation was canceled by the user**. No WPR worker or
kernel capture started, and no elevation was retried. The copied launch result
is preserved beside the v2 artifacts.

`test-results/live-afterlight-steady-trace-steady-live-v2-2026-10-13T182628177Z`
contains a semantically validated 84,920,684-byte raw trace: 422,313 substantive
events, all three correlation markers, 56,670 renderer events, 100,933 GPU-thread
events and observed CPU/Wasm/GC/scheduler/cc/viz/gpu categories. Chrome reported
no trace data loss. Its 6-second control-before completed at 37.71 real
render/submit Hz (227 matched renders/submissions); the 10-second traced window
completed at 40.26 Hz (403 matched renders/submissions). Scene/foreground and
allocation assertions passed in both completed windows. These rates do not
establish a causal improvement or isolated tracing overhead.

An optional counter-completion wait timed out after the raw stream and semantic
validation succeeded. That timeout incorrectly aborted the control-after,
separate fences, final heap/resource timing and shader-metadata stages. Those
observations are **missing**, rather than zero. The executed report/raw/repro
remain unchanged, including exit1 and that failure. The future runner catches
optional counter availability failures separately and proceeds with its other
observations; no additional full trace was run just for coverage.

V2 device retirement was observed exactly once with zero live tracked textures/
buffers; cleanup recorded no errors. Exact owned PIDs from both CDP snapshots
and process-creation metadata were no longer live, preview50307 was closed, no
process was killed and user Chrome was untouched. Native/kernel capture and
GPU counters remain unverified. The hardware slot was released for offline
analysis and subsequent source experiments.

## Native foreground calibration consolidated — 2026-10-13

The short scene A/B, 60-second sampling runner and browser trace runner now require the Windows Default input desktop and exact owned Chrome foreground before and after timing, plus a bounded 250-ms native observer throughout each window. Saved Screen-saver/PID0 negative preflights reject before their performance browser launches; no FPS or GPU timing is inferred from them. Raw reports, errors, cleanup and SHA256 references are consolidated in `test-results/native-calibration-consolidation-20261013.json`. The latest read-only check at 20:29:39.738UTC still reported Screen-saver/PID0. No desktop switch, input injection, screensaver termination, display refresh change or elevation retry was performed. Positive compositor-density A/B and sustained-frame acceptance remain pending an awake laptop.
