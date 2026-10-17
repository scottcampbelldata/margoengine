# Core parity hooks: verification

Date: 2026-10-16. Implemented on `codex/core-parity-hooks`, based on `12f3b28`, in an isolated worktree. These results describe the modified source tree, not the unchanged base commit. The user explicitly approved the three-hook exception to the core freeze. The stage facade implementation is unchanged.

## Delivered interfaces

- `Engine.render({camera})` selects a camera for one render. It restores primary frustum culling, visible instances, batches, pending uploads and statistics, including after an exception. Simulation callbacks run once. The permanent camera reference remains unchanged; alternate renders are sequential.
- Extension `Lighting.ambient` supplies nonnegative linear RGB multipliers; `radiance[3]` remains ambient intensity. The canonical frame preserves its old 112-byte prefix and appends a 16-byte ambient row. Its private buffer owners, ambient replays and WebGL preview are updated together.
- `DrawOptions.viewport` and `scissor` select independent top-left pixel rectangles per core draw. Values validate before drawing, state resets on subsequent draws, and WebGL honors `clear:false`. Clearing still affects the whole attachment.

The [core README](../packages/core/README.md) documents use and limits. Independent material lighting, temporal histories, optional native passes and picking do not acquire general multiview behavior. CubeCamera, Reflector and the remaining optional-package backlog are not implemented by these hooks.

## Size

Measured with the existing `npm run measure:size` after normal package compaction:

| State | Raw bytes | Core + stage gzip bytes | Added gzip bytes |
| --- | ---: | ---: | ---: |
| Before hooks | 47,486 | 20,282 | — |
| Per-render camera | 48,047 | 20,407 | 125 |
| Ambient RGB | 48,323 | 20,486 | 79 |
| Viewport/scissor | 48,783 | **20,641** | 155 |

Total increase: **359 bytes gzip**. The gate remains strictly below 25,000, leaving **4,358 usable bytes** through the maximum allowed 24,999. `scripts/core-budget.js`, its boundary tests and the CI build gate are unchanged. The optional WebGL root entry measures 6,374 raw / 2,727 gzip bytes; it is separate from this budget.

## Validation

| Check | Result |
| --- | --- |
| Complete package build | Passed |
| Full Node suite | **2,266 passed, zero failures/skips/TODOs** |
| Strict TypeScript | All 74 packages passed |
| API reports | 173 entries / 1,777 exports match |
| New hooks on a physical GPU | 14 captures and two RGBA16F offscreen camera readbacks passed; primary picking restored; zero changed channels for restored-primary and pre-hook white-ambient comparisons |
| Helmet streaming | All five cases passed; direct/streamed pixels identical with SSAO off/on |
| SSAO/IBL | Perspective/orthographic occlusion and open-surface checks passed |
| Simulated XR | Stereo pixel readback and teardown passed |
| Nature/scatter | All 13 shader checks passed, including private scatter frame/wind rows |
| Independent code review | No actionable findings |
| Diff integrity | `git diff --check` passed; stage facade source unchanged |

GPU checks used Edge `155.0.4283.60`, physical NVIDIA RTX A6000 / Ampere, with no software fallback. Every GPU command used the shared primary-checkout lock and released it normally. XR sessions were simulated; a headset and the original Intel Arc configuration were not tested. SSAO's optional historical screenshot baseline was absent; its analytic/spatial checks passed. The new core shader comparison uses the checked-in pre-hook shader and requires exact pixel equality.

The first full-suite run encountered six Git LFS pointer fixtures and skipped the large conveyor asset. `git lfs checkout` restored the cached assets. Both affected suites then passed (19 tests), followed by the complete 2,266-test run with no skips. No production change was needed for that setup issue.

## Reproduce

```sh
git lfs checkout
npm run test:all
npm run typecheck
npm run api:check
npm run measure:size
```

In a linked worktree, set `MARGO_GPU_LOCK` to the primary checkout's `test-results/gpu.lock` before these GPU commands:

```sh
node scripts/gpu-lock.mjs run --owner=core-hooks -- node scripts/core-parity-hooks-gpu-check.js
node scripts/gpu-lock.mjs run --owner=core-hooks -- node scripts/test-helmet-streaming.js
node scripts/gpu-lock.mjs run --owner=core-hooks -- node scripts/ssao-gpu-check.js
node scripts/gpu-lock.mjs run --owner=core-hooks -- node scripts/modern-xr-tests.js
node scripts/gpu-lock.mjs run --owner=core-hooks -- node tests/nature.browser.mjs
```

The [portable record](../benchmarks/core-parity-hooks-2026-10-16.json) records the measurements and outcomes. Detailed local logs and captures are under `test-results/core-parity-hooks/`; the complete passing Node log is `full-suite-hydrated.log`. The parity matrix now recounts **95 COVERED / 39 PARTIAL / 25 MISSING**: draw rectangles move one row from missing to partial, while the other hooks improve existing partial rows.
