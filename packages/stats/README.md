# @margoengine/stats

Zero runtime dependencies. Frame sampling uses a fixed Float64Array ring.
`tick(milliseconds, drawCalls?, dispatches?)` performs numeric updates only;
DOM strings and canvas drawing refresh separately at 4 Hz. Encoder/pass wrappers
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
in the next microtask.

GPU timing is the sum of profiled pass durations, not presentation latency.
It requires `timestamp-query` enabled when requesting the device. Frozen core
does not request this feature: CPU metrics and counters still work, and GPU
time remains unavailable. Custom devices can use
`stats.enableGPUProfiling(device)` or the standalone `GPUProfiler` API:
`beginFrame()`, `timestampWrites()` for each pass descriptor, `resolve(encoder)`,
submit, then `await read()`. Frames while a readback is pending are skipped;
samples above 128 passes are omitted. Existing timestampWrites are preserved
and those passes are excluded from this profiler.

`dispose()` removes the overlay, timer and plugin and destroys owned GPU resources.
