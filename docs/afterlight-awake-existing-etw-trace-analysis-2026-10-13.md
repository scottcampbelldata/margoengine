# Native foreground trace with an existing WPR session

The saved browser trace shows substantial **host transport latency** from
renderer GPU-channel flush to GPU-service handling, plus large WebGPU and
Present host spans. It does not identify a complete app-submit → GPU execution
→ Present → physical-display chain. CPU encoding is material but observed GC
and long tasks do not account for most frame-return gaps. No browser, GPU,
benchmark or OS mutation ran during this offline analysis.

## Conditions and evidence

Capture root:
`test-results/live-afterlight-steady-trace-steady-awake-existing-etw-v1-2026-10-13T223907353Z`.
Raw `trace.json` is **99,340,721 bytes**, SHA256
`765309dba849818363739f1284767831aef7c9f579c6c01da3072e7241aba273`.
The capture is terminal, errors/cleanup empty, no trace data loss; 486,954
events, including 486,863 substantive events. Source live entry remains
`1d096ef1af9fc7b0d505d46e70d6e5bd1ee0de906590151f3e0b156977ce9fa1`.
The authored desktop scene retains 1M particles, 1× samples, engine DPR1,
browser DPR2 and 1432×768 viewport. No timestamp-profile pass data exists here.

| Window | Render/submit Hz | Real renders | Long tasks |
|---|---:|---:|---:|
|Control before|41.3613|250|0|
|Browser traced|40.6129|326|0|
|Control after|41.4044|250|0|

**These controls are not established as OS-untraced.** The root task verified
an administrative WPR recording already active around22:34 (reported session
age24:58); it likely remained active during this22:39–22:41 browser capture.
An unelevated status result cannot establish global recording=false. ETW
recovery is a separate root-owned operation. Before/after rates cannot isolate
CDP or WPR overhead from load/thermal/scheduling drift. The report's `mode`
name and performance-judgment field do not override that qualification.

Saved display/power point: AC Online, Intel Arc140V driver32.0.101.8860,
driver-reported120Hz at2880×1800. Native watch sidecars contain25/33/25 discrete
samples for before/traced/after: all Default input desktop, owned Chrome
foreground and known AC power. Median actual QPC sample gaps are273/269/265ms;
maximum gaps533/399/489ms. This is strong sampled foreground/power evidence,
not uninterrupted observation or physical scanout proof. `SystemStatusFlag=0`
is a power/battery-saver flag, not a separate screensaver API; Default desktop
and owned foreground establish the observed active context. Native sidecar
paths/hashes and complete sample-gap distributions are in the new tables.

## CPU return cadence and wall coverage

Three actual user-timing marks identify renderer main thread35024:28412 and
align page/CDP clocks with75µs spread. There are325 intervals between returned
real renders covering7,988.2ms (page49557.0–57545.2). This interval window is
slightly narrower than the full traced observation; it is not displayed-frame
timing.

| Browser CPU measure | Count | Median ms | p95 ms | Maximum ms |
|---|---:|---:|---:|---:|
|Engine.render call|326|3.900|8.000|12.800|
|Native queue.submit call|326|0.200|1.000|2.800|
|Real render-return interval|325|24.800|31.700|41.700|

Total render call wall is1,361.4ms; submit call wall110.7ms is contained in
render work and cannot be added. Main-thread exclusive recorded-span partition:

| Category | Wall ms |
|---|---:|
|Script|1,721.012|
|GC|25.521|
|Layout/paint|108.705|
|Compositor category|538.143|
|Scheduler host|278.512|
|Other recorded|127.862|
|Broad compilation-candidate classifier|0.725|
|Unaccounted recorded coverage|5,187.720|

No observed long task or separately classified Wasm span occurs in the traced
window; absence of a separate Wasm span is not proof of no Wasm execution.
The0.725ms compilation-candidate category consists of73 unique
`V8.BytecodeBudgetInterrupt[WithStackCheck]` spans. The existing broad `/Tint/i`
alternative also matches the text in BudgetInterrupt. These are **not evidence
of GPU shader/pipeline compilation**. Existing helper/raw results remain
unchanged and this false positive is explicitly qualified.

The largest41.7ms return interval has12.010ms script,0.200ms submit host,
0.224ms layout/paint,0.796ms compositor,2.520ms scheduler,0.955ms other and
24.995ms unaccounted, with zero GC. Unaccounted means missing classified
recorded coverage; it does not prove CPU/GPU idle, memory bandwidth or a
driver cause. Recorded bundled URLs do not independently attribute script
time to an optional package.

## Exact ID-supported transport

The existing exact-integer parser preserves raw unsafe64-bit decimal lexemes
before pairing. Flow IDs match category/name/scope and PID for local IDs;
graphics joins use exact source-defined surface/display tokens. No nearest-time
join was used. Percentiles below use complete nonnegative pairs with both
endpoints inside the full traced observation.

| Explicit endpoint relationship | Pairs | Median ms | p95 ms | Maximum ms |
|---|---:|---:|---:|---:|
|Renderer main GpuChannel::Flush → GPU-service endpoint|355|44.987|53.685|70.196|
|Renderer compositor GpuChannel::Flush → GPU-service endpoint|435|49.516|58.704|64.933|
|Compositor submit → Viz receive, same surface trace ID|326|0.448|1.052|2.815|

Cross-boundary pairs are excluded:23/390/223 respectively. The largest main
channel flow uses exact ID20762, renderer35024:28412 event424432 at page56132.419ms
→ GPU31500:52484 event424433 at56202.615ms. This is **host transport/scheduling
latency**, not native GPU duration or demonstrated per-app-submit backlog.
Overlapping flow intervals cannot be summed into frame cost.

Full-capture pairing retains25,784 flow pairs with zero flow diagnostics,
22,652 nestable async pairs,5,402 async instants and two open boundary
lifecycles without invented end times. There are1,559 exact surface IDs,
549 display IDs,549 uniquely paired compositor submit/receive links and1,098
explicit surface→display aggregation relationships. Reused async tracks are
lifecycle containers, not automatic app frame IDs.

The674 full-capture WebGPU scopes and549 DXGI Present scopes carry zero trace
IDs in these records. The326 app submit ordinals still have no proven bridge
to GPU-channel flow IDs, Dawn processing or a particular DXGI Present. Surface
aggregation links do not fill that missing app-submit bridge. Browser-named
presentation lifecycle events are not independently measured physical display.

## GPU-service and presentation host scopes

All values below are per-name **unions** clipped to the7,988.2ms return window.
Names nest/overlap; these rows must not be added. CrGpuMain is31500:52484.

| Recorded host scope | Count overlapping window | Union ms |
|---|---:|---:|
|Scheduler::RunTask|1,513|7,725.955|
|SkiaOutputSurfaceImplOnGpu::SwapBuffers|323|3,658.622|
|GpuChannel::ExecuteDeferredRequest|865|3,429.912|
|CommandBufferStub::OnAsyncFlush|865|3,357.899|
|WebGPU|669|3,072.393|
|SkiaOutputDevice→ScheduleOverlays|323|3,004.124|
|DXGISwapChainImageBacking::Present|323|2,981.083|
|SkiaOutputSurfaceImplOnGpu::EndAccessImages|323|542.193|
|SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass|323|478.463|
|SkiaOutputSurfaceImplOnGpu::BeginAccessImages|323|191.339|
|D3DImageBacking::ProduceGLTexturePassthrough|323|131.590|
|DCompPresenter::Present|323|49.408|

The323 Present wrappers have **zero recorded contained same-thread children**;
all2,981.083ms remains direct exclusive wrapper wall. Maximum23.070ms, then
21.895/21.224ms; all three longest have no recorded cross-thread wait overlap.
Other wrappers have small cross-thread commit-wait overlaps, which lack a
causal command ID. This does not isolate the native DXGI call, earlier GPU
completion waits, D3D11/D3D12 interop or physical presentation. A long scheduler
host scope also need not represent CPU execution; it can contain host waits.
Dirty rect remains `0,286 2864x1505`, with `has_alpha=false`; it is not proof
of the engine render-target size or swapchain descriptor.

Full per-thread exclusive partitions, nested name unions, every Present row,
largest ID-supported transport endpoints and async diagnostics are retained
without rewriting older trace evidence. This browser trace motivates the
separate native ETW investigation; it does not itself establish a driver bug.

## Reproducibility and limits

Sixteen existing offline checks passed exact integer identity, scoped flows,
nested wall partition and Present-child handling. One fresh raw parse reused
`afterlight-trace-identity-pairs.mjs`, `afterlight-steady-trace-adapter.mjs`,
`afterlight-trace-correlation.mjs`, `trace-afterlight-browser-startup.mjs` and
`afterlight-present-scopes.mjs`. The existing transport driver was copied with
only its output-root path changed; it consumed the saved exact pair sidecars.

New root: `test-results/afterlight-awake-existing-etw-analysis-20261013`.
`tables.json` is the compact result; `summary.json`, `correlation.json`,
`transport-latencies.json`, `present-detail.json`, exact flow/graphics/async
sidecars and `analysis-manifest.json` retain raw/source/output hashes.
Frozen analyzer sources are under `repro/`; stdout and16-check logs use the
same analysis prefix. A compact record is appended to
`docs/afterlight-trace-runs-2026-10-13.jsonl`. All older raw/helpers remain
unchanged. Offline heavy CPU work ended before slot release; no new hardware
or application change was made.

## Subsequent ETW recovery status — save still pending

The root task reports recovery child PID 49052 launched at 22:50:51 UTC is
STILL saving the same existing elevated WPR trace after the recovery worker's
180-second observation timeout. Its approximately 1 MB output ETL remains
provisional. The worker observation timeout does not establish child completion,
recovery success or a final valid ETL; no completed native GPU analysis is
claimed. This update records supplied progress only and launches no analysis
or native call. The successful 99 MB browser trace's 326 real renders at about
40.6 Hz still do not prove sustained 60 FPS, isolated OS-untraced behavior or
a production deployment.

## Subsequent native header and one bounded raw-stream attempt

The pending-save note above is historical. The finalized recovered ETL is
96,254,033,920 bytes, last written 23:16:08.6370929Z; the single native-header
open/dispose proof records 22:07:39.4329562Z..22:52:45.0386131Z (45m05.6057s),
11,512,739 lost events and 0 lost buffers. The header loss count prevents
complete accounting claims; it does not locate loss inside or outside the
browser window.

The single 64-delivered-record native smoke returned its constructor, Process
and Dispose once. Actual first kernel-header callback calibrated QPC
384452660923 at 10,000,000 Hz to 22:07:39.4329562Z. Its failed observer exit-race
record is preserved with a separate PID-absence/terminal sidecar; the later
ordinary-child fixture proved the minimal same-handle race fix. No second
native smoke was run.

One separately authorized real raw-stream attempt used the fixed observer
and a narrower graphics interval [22:40:12Z,22:40:30Z), bracketing the traced
browser interval while preserving the same whole-file lifecycle whitelist
and all graphics PIDs. It stopped normally at 300.0066s: 174,291,957 delivered,
133,102 retained, 255,508,797 bytes, zero oversized-record omissions. Last/max
UTC was 22:12:20.4944518Z; it **did not reach the 22:40 focus**. It is a bounded
partial prefix, not complete native analysis of the owned Chrome workload.
Constructor/Process/Dispose each returned once; observer exit 0, worker
PID 44072 absent, no cancellation, observed peak working set 191,967,232 bytes.

The observed prefix exposed 275 DynamicTraceEventData schema descriptors:
DxgKrnl 227, DXGI 22 and Win32k 26. QueuePacket 244 was actually version 2 and 245
version 3, differing from reference versions 1/2. These are prefix schema
observations only; no full-capture provider absence or queue/GPU execution,
physical presentation or app-submit correlation is established. Classic
kernel descriptor counts can aggregate task GUIDs; each raw record retains
its actual task GUID/schema separately.

Evidence: `test-results/etl-tools-20261013/raw-stream-20261013T234947756Z/`
contains immutable executed source copies/hashes, `summary.json`,
`observation.json`, `stream/result.json`, clocks and partial JSONL. The manifest
hashes small metadata/source files; the 255.5 MB JSONL was not re-read for a
post-slot-release hash. No retry, browser/GPU/WPR operation, production source
or public distribution change occurred. CPU/I/O slot was released at terminal.
