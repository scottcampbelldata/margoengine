# Exact identity recovery from saved steady Chrome v2 trace

Offline only. No browser/GPU/native desktop call ran. The immutable84,920,684-byte trace from `live-afterlight-steady-trace-steady-live-v2-2026-10-13T182628177Z` was hash checked before parsing. Final exact-identity parse used Node24.15 JSON.parse reviver `context.source`: large64-bit integer IDs become their original decimal lexemes. They never pass through Number-to-string conversion. Original ordinary-decoded inventory remains preserved and explicitly unsuitable for frame-token joins: its21 surface/13 display distinct values were precision collapse, not real ID cardinalities.

Artifacts are in `test-results/afterlight-steady-v2-identity-20261013`: `pairing-summary.json`, `flow-pairs.json`, `async-lifecycles.json`, `graphics-token-links.json`, `exact-identity-events.json`, `transport-latencies.json` and stdout/selfcheck logs. Executed analyzer/pairer/test sources and primary-reference copies are retained with hashes. Raw trace and earlier correlation/Present outputs are unchanged.

## Explicitly matched identities

Full capture contains21,988 flow pairs,19,797 nestable async lifecycle pairs and4,822 async instants. The earlier39,595 unsupported async events were19,798 begins plus19,797 ends. There are zero flow pairing diagnostics and one genuinely unclosed FrameSequenceTrackerV3 begin; no missing end was invented. Six small tests cover exact raw64-bit lexemes, local versus global scope, category/name/scope collisions, unsafe Number rejection, nested/reused async lifecycles, and exact compositor token matching.

Legacy flow pairs require ID/category/name/scope. Explicit local IDs additionally require PID; globals remain distinct. Nestable async scopes match category/scoped ID and lifecycle name. These semantics follow Chromium's [Catapult importer](https://raw.githubusercontent.com/catapult-project/catapult/master/tracing/tracing/extras/importer/trace_event_importer.html); this private parser conservatively rejects unknown/ambiguous identities and never auto-closes a missing lifecycle.

Exact recovery yields1073 surface-frame trace IDs and486 display-frame trace IDs. There are485 unique full-capture compositor-submit→Viz-receive links and972 explicit surface→display aggregation links. The [exact Chromium revision's schema](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/base/tracing/protos/chrome_track_event.proto) defines surface IDs as BeginFrameAck trace IDs before aggregation, display IDs as after-aggregation identities, and `aggregated_surface_frame_trace_ids` as the explicit join. These are browser compositor identities; none is an application GPUQueue submit ordinal. Reused async track IDs are also not one-to-one application frame IDs.

Within traced-observation bounds, intersecting scopes include5223 Graphics.Pipeline flows,995 GPU-channel flows,401 DrawAndSwap lifecycles and402 exact compositor-submit→Viz-receive pairs. Intersecting counts may include boundary-crossing intervals; the latency table below uses only fully contained pairs. Lifecycle/flow durations overlap each other and duration scopes, so their sums do not account for additional CPU/GPU work.

## Host flow latency distributions

Both endpoints must lie within page23402.2→33414.7ms, corresponding to native trace25208398473→25218410973µs using the previously measured clock offset25184996273µs. Missing, reversed and non-finite endpoints are rejected. No invalid pair was accepted. Median averages the two central values; p95/p99 use nearest rank. Units are milliseconds.

| ID-supported path | Fully contained pairs | Median | p95 | p99 | Maximum |
|---|---:|---:|---:|---:|---:|
| Main-thread sending graphics-command flush→scheduled GPU-service handling |429|48.456|51.579|61.642|75.386|
| Compositor sending graphics-command flush→scheduled GPU-service handling |562|50.880|55.310|98.461|124.545|
| Compositor submit→Viz receive, exact surface token |402|0.263|0.422|0.492|0.684|

For the first path, [GpuChannelHost::InternalFlush](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/gpu/ipc/client/gpu_channel_host.cc) emits the global flush flow before FlushDeferredRequests. [CommandBufferStub::OnAsyncFlush](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/gpu/ipc/service/command_buffer_stub.cc) emits the matching global flow before decoder command flushing. These are **sending graphics-command flush→scheduled GPU-service handling** intervals. They include host transport and service scheduling/dependencies, exceed the scope of pure wire IPC, and do not end at hardware completion. Generic main/compositor flushes cannot be assigned to one specific application submit from this capture.

Largest two fully contained intervals per path retain exact IDs and endpoints in `transport-latencies.json`:

| Path | ID | Elapsed ms | Start page ms / native us | End page ms / native us |
|---|---|---:|---|---|
| Main flush | legacy flow5412 |75.386|24135.493 /25209131766|24210.879 /25209207152|
| Main flush | legacy flow20408 |66.200|32534.555 /25217530828|32600.755 /25217597028|
| Compositor flush | legacy flow11778 |124.545|27675.038 /25212671311|27799.583 /25212795856|
| Compositor flush | legacy flow11784 |122.179|27677.465 /25212673738|27799.644 /25212795917|
| Compositor submit/receive | surface3904333892875340899 |0.684|32449.608 /25217445881|32450.292 /25217446565|
| Compositor submit/receive | surface3904333892875337997 |0.631|29274.919 /25214271192|29275.550 /25214271823|

Main source thread is renderer13840:30496, compositor13840:38416. GPU service flush target is43032:25244; Viz receipt target43032:38536. The main/compositor flow IDs are scoped with the exact `gpu,toplevel.flow` category and `GpuChannel::Flush` name in the raw sidecar. Large surface IDs above are original decimal strings, not rounded Numbers.7 main,157 compositor and83 compositor-submit/receive full-capture pairs lie outside or cross the traced bounds and are excluded from the distributions.

## Missing end-to-end causal link

The traced observation independently records403 successful native app submits. Full capture has829 `WebGPU` duration scopes with zero flow/async IDs, and486 `DXGISwapChainImageBacking::Present` duration scopes with zero IDs/frame tokens. There is no direct QueueSubmit named trace identity and no recorded mapping from the numeric app submit ordinal to a channel flush/surface token. Present args provide dirty rectangle and alpha state only. Therefore renderer GPUQueue.submit→Dawn→Viz→DXGI Present→physical display is **not established**, even though portions of Chrome's transport/compositor pipeline are now ID-linked.

The ~18ms average Present wrapper wall remains unclassified internally. These results cannot label it GPU execution, a per-frame completion wait, idle time, memory bandwidth, or physical presentation. Host flow delays overlap each other and cannot be summed or added to Present durations. No closest-time matching, automatic19ms delta cause, refresh-divisor conclusion or60Hz acceptance is introduced. Further live diagnostics still require Default input desktop and owned native Chrome foreground proof.
