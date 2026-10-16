# Optional live GPU timing compatibility repair

Afterlight's existing GPU value had two independent unavailable paths: core
requested only `depth32float-stencil8`, and its Stats attachment omitted
`profiling`, which defaults to false. A timestamp-capable adapter alone cannot
make a device's unrequested timestamp feature usable.

Core now negotiates the advertised subset of `depth32float-stencil8` and
`timestamp-query` at normal device creation and restoration. This repairs the
existing optional Stats profiler path with no core or stage API additions.
The redundant primitive descriptor was omitted: WebGPU's defaults remain
triangle-list topology, counter-clockwise front faces and no culling. The sole
production reader of `context.descriptor.primitive` was Toon's object spread,
which safely accepts its absence and sets front culling explicitly. Other
packages construct their own primitive state. Defaults and feature requirements
are specified by the [WebGPU standard](https://gpuweb.github.io/gpuweb/).

The real rebuilt core + stage measurement is **47,934 raw / 19,975 gzip bytes**;
the strict gate remains below 20,000. This leaves only 25 bytes of margin. An
ignored typechecked/write-false experiment measured the feature request alone
above the gate; removing the redundant defaults was necessary. No material,
skinning, graph or post-processing capability was added to the frozen base.

Stats keeps profiling off by default. Capability negotiation creates no query
sets, query buffers or readbacks. Opt-in Stats uses its existing one-in-15
sampling, one query set/two buffers, one in-flight map, cached descriptors and
reused 128-element CPU array. It does not wait for the GPU every frame. HUD labels
now distinguish off, supported warmup and unavailable timing. Valid GPU timing
is labeled as the sum of sampled passes; its additional span includes inter-pass
work and gaps, not queue waiting before execution or presentation.

Three read-only Stats getters expose the already pooled complete sample:
`gpuPassMilliseconds`, `gpuPassCount`, `gpuElapsedMilliseconds`. Off/unsupported
returns null/zero/null. Read only the first count entries. Getter reads create
no arrays or GPU resources; a new device requires a new profiler. Unsupported,
overflowing, invalid and disposed samples retain the existing clearing rules.

Validation: core and Stats compile/build passed; all 33 targeted checks passed
across the initial run and a fixture-only correction/rerun. New tests cover all
four advertised feature combinations, effective primitive defaults, Toon with
an absent primitive state, failed pipeline cleanup, and actual engine reboot.
A supported engine plus default Stats rendered 30 frames, rebooted and rendered
30 more with zero query allocations; explicit profiling then created one query
set. Stats checks cover reused getter identity, pass/sum/span values, invalid
sample clearing, unsupported/restored devices and status labels. Existing
MSAA/temporal/Toon/resource checks also passed.

Commands: the isolated core compaction/Stats build is in ignored
`test-results/build-core-stats-only.mjs`; strict validation uses
`node scripts/measure-size.js`. Tests are
`tests/core-timestamp-feature.test.js`, `tests/modern-msaa.test.js`,
`tests/modern-temporal-resources.test.js`, `packages/stats/test/stats.test.js`
and `packages/toon/test/toon.test.js`. No native browser/GPU measurement or hosted
deployment was performed for this compatibility repair by this subtask. Prior
package workload evidence predates it; requesting the capability alone should
not be presented as proof of unchanged native FPS. Afterlight's opt-in query
attachment and live validation are owned by the parent task.
