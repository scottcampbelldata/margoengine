# @margoengine/stats

Import `margoengine/stats` from the `margoengine` package, or `@margoengine/stats` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Zero runtime dependencies. Frame sampling uses a fixed Float64Array ring.
`tick(milliseconds, drawCalls?, dispatches?)` performs numeric updates only;
DOM strings and canvas drawing refresh separately every 150 ms. Encoder/pass wrappers
and asynchronous GPU readback allocate outside `tick`.

```ts
import {Stats} from 'margoengine/stats';
import type {EngineKernel} from 'margoengine/core';
function attach(engine: EngineKernel) {
  return Stats.attach(engine, {samples: 120, profiling: true});
}
```

GPU memory and a JSON report are in their own entry:

```ts
import {Engine} from 'margoengine/core';
import {Stats} from 'margoengine/stats';
import {GPUMemory, statsReport} from 'margoengine/stats/report';

const engine = await Engine.create(document.querySelector('canvas')!);
const memory = GPUMemory.attach(engine.gpu!);   // counts what is made from now on
const stats = Stats.attach(engine);
memory.view(stats);                             // a row in the panel
engine.start();
console.log(JSON.stringify(statsReport(stats, memory)));
```

Sizes come from the descriptors, so driver padding is not in them, and objects made before `attach` are not seen.

Pipeline compile tracking is in its own entry. It shows which shader and pipeline compiles ran near a slow frame, and when. Read a hitch as evidence, not proof: times are CPU time around each call, and browsers compile in another process, so that is the most a page can see. It sees only what is compiled after it starts, so use `trackNext` below to include the engine's startup pipelines:

```ts
import {Engine} from 'margoengine/core';
import {Stats} from 'margoengine/stats';
import {PipelineCompiles} from 'margoengine/stats/compile';

const engine = await Engine.create(document.querySelector('canvas')!);
const compiles = PipelineCompiles.attach(engine, {hitchMilliseconds: 33.4});
compiles.view(Stats.attach(engine));            // totals and the newest hitch in the panel
compiles.onHitch((hitch) => {
  console.warn(`${hitch.milliseconds.toFixed(1)} ms frame near`, hitch.compiles.map((record) => record.label));
});
engine.start();
console.log(JSON.stringify(compiles));          // every record and hitch, when you want them
```

Each record has `kind` (`'shader'`, `'render'` or `'compute'`), `label`, `blocking` (false for the `...Async` calls), `startedAt`, `frame`, `milliseconds` (null while an async call runs) and `failed`. A frame over `hitchMilliseconds` (default 33.4) with compiles in it or in the frame before is a hitch, with `frame`, `at`, `milliseconds` and `compiles`, blocking calls first and then the longest. `capacity` (default 256) is how many records and hitches stay; `count` goes on counting. Label your pipelines to read this easily, or pass `stacks: true` (default false) to keep where each call came from.

To see the engine's own startup pipelines as well, start before the engine does:

```ts
import {Engine} from 'margoengine/core';
import {PipelineCompiles} from 'margoengine/stats/compile';

const compiles = new PipelineCompiles().trackNext(); // catches the next device this page makes
const engine = await Engine.create(document.querySelector('canvas')!);
engine.use(compiles);
console.log(compiles.toJSON().count, 'compiles so far');
```

It follows the engine's device through a device restore and sees only what is compiled after `attach`, or after `trackNext`. Times are CPU time around each call. Browsers compile in another process, so a blocking call can return quickly and the stall arrives later, which is why the frame before counts too. A hitch is evidence that a compile was near a slow frame, not proof that it was the cause. With your own loop, call `compiles.track(device)` and `compiles.frame(milliseconds)` once per frame.

The CPU phase breakdown times the kernel tick, culling, encoding and submit of each frame:

```ts
import {Engine} from 'margoengine/core';
import {Stats} from 'margoengine/stats';
import {FramePhases} from 'margoengine/stats/phases';

const engine = await Engine.create(document.querySelector('canvas')!);
const phases = FramePhases.attach(engine, {samples: 120});
phases.view(Stats.attach(engine));              // the averages in the panel
engine.start();
setInterval(() => console.log(phases.last.encode, phases.average().tick), 1000);
```

All numbers are CPU milliseconds, and they add up to `total`:

| Phase | What it covers |
| --- | --- |
| `update` | `onFrame` callbacks, plugin updates, resize and camera, up to the kernel tick |
| `tick` | The kernel tick: world matrices and the frustum test, in one Wasm call |
| `cull` | Collecting the visible instances into batches and preparing the frame, up to the command encoder. Core's frustum test runs inside the kernel's one Wasm call, so its time is in `tick`, not here |
| `encode` | Every frame graph pass, then `encoder.finish()` |
| `submit` | `queue.submit` |
| `other` | The rest of the frame's task |

`last` is the newest finished frame, one object updated in place; `average()` is the mean over the last `samples` frames (2 to 4096, default 120). `JSON.stringify(phases)` gives `frames`, `last` and `average`. A frame ends when its task does, so read `last` from a later task. Views in one frame add into that frame. Nothing is allocated per frame, and core is not changed: the entry wraps `store.tick`, `createCommandEncoder` and `queue.submit` and adds two frame graph passes until `dispose()`. On WebGL2 `encode` is the frame graph and `submit` is 0.

The frustum test is part of the kernel call, so it counts as `tick`. Browsers round `performance.now()` to 5 to 100 microseconds, so trust the averages over a single short phase.

Leak alerts warn when GPU memory or a resource count keeps growing:

```ts
import {Engine} from 'margoengine/core';
import {Stats} from 'margoengine/stats';
import {GPUMemory} from 'margoengine/stats/report';
import {LeakWatch} from 'margoengine/stats/leaks';

const engine = await Engine.create(document.querySelector('canvas')!);
const memory = GPUMemory.attach(engine.gpu!);
const leaks = LeakWatch.attach(memory);         // totals and every label, sampled each 5 s
leaks.watch('meshes', () => engine.stats.visible, {min: 100}); // or any number of your own
leaks.view(Stats.attach(engine));               // what is growing, in the panel
leaks.onLeak((alert) => console.error(alert.name, alert.perMinute));
engine.start();
```

Each window of samples is cut into quarters and the lowest value of each is taken. A leak raises all four. A load, a level change or a pool that fills and empties does not, however high it peaks. An alert has `name`, `from`, `to` (the first and last low point), `perMinute` and `at`, and goes to `console.warn` unless you pass `warn` (null for none). It fires once, and can fire again after the growth stops. `leaks.leaking` names what is growing now, and `JSON.stringify(leaks)` gives every alert. Label your buffers and textures: the growing label is named, as `label <name> bytes` and `label <name> count`.

| Option | Default | Meaning |
| --- | --- | --- |
| `intervalMilliseconds` | 5000 | Time between samples; 0 means you call `leaks.sample()` |
| `window` | 48 | Samples judged together, 8 to 4096, a multiple of 4 |
| `minBytes` | 1048576 | Bytes a low point must grow by to alert |
| `minCount` | 16 | Objects a low point must grow by to alert |
| `maxSeries` | 64 | Numbers followed at most; each label is two |
| `warn` | `console.warn` | Called for each alert; null for none |

It needs a full window before it can alert: four minutes by default. After a device loss the old objects stay counted, so make a new `GPUMemory` and `LeakWatch` for the new device.

Field telemetry sends frame time percentiles from real sessions to an endpoint you choose:

```ts
import {Engine} from 'margoengine/core';
import {FrameBeacon} from 'margoengine/stats/beacon';

const engine = await Engine.create(document.querySelector('canvas')!);
const beacon = FrameBeacon.attach(engine, {
  endpoint: '/telemetry/frames',
  sampleRate: 0.1,                              // one session in ten
  context: {build: '1.2.3', scene: 'menu'},     // read at each send, so change it as you go
});
engine.start();
```

Each report is a POST with this JSON body, sent as `text/plain` so that a cross-origin endpoint needs no preflight:

```json
{"frames": 1794, "seconds": 30.01, "p50": 16.71, "p90": 17.48, "p95": 18.29, "p99": 33.12, "max": 41.2, "context": {"build": "1.2.3", "scene": "menu"}}
```

That is all it holds: no identifier, no user agent, no address of its own. Whether to create a `FrameBeacon` at all, and whether to ask users first, is the app's choice.

| Option | Default | Meaning |
| --- | --- | --- |
| `endpoint` | required | An http or https URL, relative to the page if relative |
| `intervalMilliseconds` | 30000 | Time between reports; 0 means only on page hide and `flush()` |
| `minFrames` | 60 | A report with fewer frames waits for more |
| `sampleRate` | 1 | Share of sessions that report, decided once; `beacon.active` says which |
| `context` | `{}` | Strings, numbers and booleans sent with every report |
| `signal` | none | An `AbortSignal` that stops reporting, as `dispose()` does |

It reports on the interval, when the page hides or closes, and on `dispose()`, through `navigator.sendBeacon`, or `fetch` with `keepalive` where that is missing or refuses. `sendBeacon` sends the page's cookies for the endpoint; the `fetch` route does not. Each report covers the frames since the last one. Paused time is left out. Percentiles use fixed bins, so memory stays at 2 KB however long the session is, and each reads at most 4.6% above the true value; `max` is exact. `sent` and `failed` count reports and `lastError` keeps the reason; nothing is retried. With your own loop, construct it and call `beacon.frame(milliseconds)`.

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
