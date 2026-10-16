# @margoengine/stats

Zero runtime dependencies. Frame sampling uses a fixed Float64Array ring.
`tick(milliseconds, drawCalls?, dispatches?)` performs numeric updates only;
DOM strings and canvas drawing refresh separately every 150 ms. Encoder/pass wrappers
and asynchronous GPU readback allocate outside `tick`.

```ts
import {Stats} from '@margoengine/stats';
import type {EngineKernel} from '@margoengine/core';
function attach(engine: EngineKernel) {
  return Stats.attach(engine, {samples: 120, profiling: true});
}
```

The engine plugin samples actual frame intervals and counts direct/indirect draw
and dispatch commands in its frame graph. Render bundle contents and commands
recorded on other encoders are outside these counters. For a custom encoder,
call `stats.track(encoder)` before recording and `stats.tick(deltaMs)` once per
frame. Submit immediately after `encoder.finish()`; timestamp readback starts
in the next microtask. The Stats plugin profiles one frame out of every 15;
draw/dispatch counting and numeric ring sampling continue every frame.

`{lowAllocationPasses: true}` is an explicit opt-in for applications that own their
pass objects. It shares frozen prototypes for ordinary same-realm native WebGPU
passes instead of attaching a separate owner and command methods to each pass.
The default remains `false`, with the original own-property wrapper behavior.
The opt-in falls back to that behavior for unknown factories, other realms,
custom methods, existing own or inherited Stats owners, changed native
methods/accessors, nonwritable inherited methods,
and passes that cannot accept the derived prototype. Native command receivers,
draw/dispatch counters and timestamp handling are preserved. Host allocations
and profiling readbacks remain; this option does not promise zero allocation.
Guards and inherited accessors can increase CPU cost, so measure your workload.

This option changes reflective behavior: `Object.getPrototypeOf(pass)` is a
shared frozen object that inherits from the native prototype; wrapper methods
and the owner are inherited instead of own properties. Native `instanceof` and
constructor identity are retained. Assigning an individual pass method creates
an ordinary writable own property, and nested Stats instrumentation can replace
the owner. Deleting an own method reveals the shared wrapper rather than the
native method. If the application prevents extensions **after** wrapping, later
method reassignment or nested Stats owner transfer cannot add an own property
and throws; default Stats already has writable own methods and an owner slot
and can update them in that situation. Keep the
default when consumers depend on native prototype identity, own-property
reflection, deletion, or these extensibility semantics. No shared prototype can
be mutated through a returned pass.

The hardware browser regression checks the actual built package's native pass
layout, fallback behavior, counters, GPU output and timestamp readback. Build
Stats with `node scripts/build-optional.js stats`, then run
`node scripts/gpu-lock.mjs run --owner=stats-native-passes -- node scripts/test-stats-native-passes.mjs`.
It requires a hardware WebGPU adapter with timestamp-query support and writes
its proof to `test-results/stats-native-passes.json`; it does not measure allocations.

GPU timing is the sum of profiled pass durations, not presentation latency.
Timing needs a device created with the `timestamp-query` feature: create the
engine with `Engine.create(canvas, {features: ['timestamp-query']})` (requested only
if the adapter offers it, and again after device restoration). Without it,
`{profiling: true}` reports timing as unavailable and keeps CPU metrics and
counters. Stats profiling is off by default and creates no queries, query buffers
or readbacks. The overlay distinguishes off,
supported warmup and unavailable timing; unsupported devices retain CPU metrics
and counters. Custom devices can use
`stats.enableGPUProfiling(device)` or the standalone `GPUProfiler` API:
`beginFrame()`, `timestampWrites()` for each pass descriptor, `resolve(encoder)`,
submit, then `await read()`. Frames while a readback is pending are skipped;
samples above 128 passes are omitted. Existing timestampWrites are preserved
and those passes are excluded from this profiler.

The standalone profiler also exposes the latest complete sample through
`passMilliseconds` (a reused 128-element Float64Array) and `passCount`, in the
order that `timestampWrites()` was called. `milliseconds` remains the sum of
those pass durations. `elapsedMilliseconds` spans the first profiled pass beginning
to the last profiled pass end, including intervening copies, unprofiled passes
and GPU gaps. Commands before the first pass or after the last pass, queue waiting
before execution and presentation are outside that span. Timestamp precision
depends on the browser. Unsupported, empty, overflowing or invalid samples clear
all timing fields; busy readbacks retain the last complete sample. No additional
GPU resources are allocated per sample.

Stats exposes that same completed sample through read-only getters
`gpuPassMilliseconds` (the existing reused array, or null when unsupported/off),
`gpuPassCount` and `gpuElapsedMilliseconds`. Read only the first `gpuPassCount`
entries. The array is replaced when a new device requires a new profiler; no copy
or array allocation occurs when reading these getters. The overlay's GPU span
includes the inter-pass work described above and is not a displayed-frame time.

`gpuSampleId` increments after each valid completed GPU readback, even when its
duration equals the previous sample. It stays monotonic through device replacement;
unsampled frames, pending reads, and invalid samples do not increment it.
`gpuSampleEncodedAt` records the CPU `performance.now()` at the sampled encoder's
`finish()`, and `gpuSampleReadAt` records the CPU time when its readback completes.
These timestamps describe host encoding/readback, not GPU execution on a host clock.
They are null before a valid sample and when timing is cleared. They can correlate
events with samples; temporal proximity alone does not establish a cause.

`dispose()` removes the overlay, timer and plugin and destroys owned GPU resources.
