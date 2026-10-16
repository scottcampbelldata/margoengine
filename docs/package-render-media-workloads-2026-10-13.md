# Render and media package workloads

Seven reproducible local package workloads complete the initially missing demo
factories and give Blender a fixed default asset. The registry, selector and
automation are in `examples/package-benchmarks` and
`scripts/benchmark-package-workloads.js`. They use the actual optional package
APIs; model placeholders are cleared when the visible result uses a custom PBR
or splat renderer. Actor count, principal objects, transform capacity and the
engine-visible counter are kept distinct. No production package was changed.

| Package | Default and bounded presets | Actual workload | Initial proof and remaining limits |
| --- | --- | --- | --- |
| Animator | 1 robot; 1/2/4 | Existing 463,988-byte RobotExpressive GLB, 74 nodes and 19 primitives/model, Idle/Walking/Running blend, Idle cross-fades, masked additive right-arm Wave | Real GLB/model/Animation/Animator CPU paths, pose changes, layer/state controls and teardown pass with mocked GPU. Actual native skinning/morph renders and performance remain pending. Foot IK is outside this fixture. |
| TAA | 1 robot; 1/2/4 | Walking robot and moving parent; actual `taa.add(model)`, velocity snapshots, eight jitter phases, history reset/weight/toggle | Real registered animated PBR source and camera restoration pass with mocked GPU. Actual temporal quality, velocity pixels and cadence remain pending. |
| Text | 16 blocks; 4/16/64 | Real TextRenderer/Font, two-line billboard SDF text, outline/shadow, fixed-length updates and reused glyphs | Real layout/renderer/atlas/ownership passes with unit-only font rasterizer and mocked GPU; real browser font and glyph image quality remain pending. Late font completion after pagehide attaches no resources. |
| Splats | 4 bunny groups; 1/4/9 | 397 derived PCD samples/group, positive-definite rotated Gaussian covariance, opacity 0.55, one globally sorted cloud, optional first-degree SH and camera orbit | Real data validation/sort resources/encoding, SH rebuild, fixed input preservation and resize camera ownership pass with mocked GPU. Derived fixture is not a trained photogrammetric scene; GPU projection/sorting pixels and cadence remain pending. |
| Audio | 4 emitters; 1/4/9 | Actual positional Web Audio graph, generated looping tones, mesh-following panners, cone/distance attenuation and retained 1,024-point FFT | Actual package graph calls and fake Web Audio state/positional/analyser/cleanup pass. Browser audio will start silently and only resume through Enable sound; automated browser launch mutes output while keeping DSP active. File decode, audibility and physical audio latency are outside this fixture. |
| Video | 4 surfaces; 1/4/9 | Actual HTMLVideoElement with a generated 256×128 Canvas MediaStream, explicit frame requests, delivered-frame callback and external-texture draws | Mock media plus actual Video package encoding tests pass; late source data after abort cannot publish GPU surfaces. Browser frame delivery/import/pixels remain pending. File decoding/codecs are outside this fixture. |
| Blender | 4 models; 1/4/9 | Actual 1,004-byte Python-writer `.margo` fixture, two textured triangles/model, shared packed geometry and mirrored authored TRS; separate recurring decode-only batch | Real decoder/model/shared geometry/texture ownership/cancellation paths pass with mocked GPU and 2×2 bitmap decoder. Native PNG decode/upload/PBR pixels remain pending. Tiny fixture does not establish complex exports or commercial-scene throughput. |

The harness waits for asynchronous mounts before its principal-world submission
and two later animation callbacks. Capacity includes owned model nodes; previous
marker factories retain their default capacity. New model/effect factories must
show nonblank scenes, actual per-package counters and retained resources before
FPS or load claims are accepted. No FPS was obtained by preparing these sources.

Focused run:

```sh
node --test --test-timeout=15000 examples/package-benchmarks/render-runtime-workloads.test.js examples/package-benchmarks/media-workloads.test.js examples/package-benchmarks/factory-loading.test.js tests/package-workload-metrics.test.js
```

Seventeen checks pass with no skips in 1.15 seconds. This is correctness-test
wall time, not any demo's load time. Two fixture mistakes were corrected: the TAA
test had checked the mount context instead of the GPU pass context; Blender's
textured path needed a mock command encoder/submission for mip generation. The
earlier failed Blender run took 80 seconds overall despite about half a second
in test bodies; the wall delay is unexplained and is not an engine performance
measurement. The fresh bounded run exits normally. No build or browser was run
while preparing these factories.

Native acceptance command, queued to run alone on the shared GPU:

```sh
WORKLOAD_PACKAGES=animator,taa,text,splats,audio,video,blender WORKLOAD_REPORT_PREFIX=package-render-media node scripts/benchmark-package-workloads.js
```

On PowerShell, set these environment variables separately before invoking the
runner. It runs timestamp profiling OFF/ON/ON/OFF with nonblank scene checks,
package controls, pause/rebuild/resize/terminal-pagehide cleanup and optional
pass/span timing. Physical Android and cold hosted startup remain distinct.
The runner saves complete evidence and reports a local-target failure if the
initial principal scene exceeds 1,000 ms, either unprofiled mean is below 60 Hz,
or any unprofiled render interval exceeds 16.67 ms plus 0.2 ms timing tolerance.
It does not count a high average as a sustained-floor pass. Audio additionally
requires the real running context clock/FFT/loop/panner to advance; Video requires
delivered frames and real external imports accompanying every rendered callback.
Their terminal owned context/loop and track/source retirement are asserted.

Internal directories are explicit in the 63-directory scope. `packages/kernel`
is the Rust/Wasm transform/culling implementation invoked by every marker and
model example; `tests/modern.test.js` checks independent JS composition, SIMD
remainder/touching-sphere behavior, stable memory and ownership. `packages/shared`
owns readiness/loading/math/GPU-target helpers; principal-scene and shared-target
tests validate correlation, abort, nested ownership and depth/resolve behavior.
They are not published npm packages. These integration fixtures are meaningful
coverage, while isolated internal tuning and complete acceptance remain open.

## Actual browser measurements and retained interop repair

The package runner completed all 14 real browser cases and 56 OFF/ON/ON/OFF
windows. Actual package controls, nonblank canvas images, model/point/text
counters, audio clock/FFT/panners, delivered video frames and external GPU
imports, rebuild/resize and terminal cleanup passed. GPU/page error arrays are
empty. Local strict target acceptance passes in 9 cases and fails in 5; the
command exits nonzero after preserving all cases. Each pair below is the two
unprofiled render-callback windows, with 750 ms warm-up and 2,500 ms target
measurement. This is local Vite/Intel evidence, not cold hosted or physical phone.

| Profile | Package | Principal opportunity ms | OFF callback Hz | Worst OFF interval ms | Local target |
| --- | --- | ---: | --- | ---: | --- |
| Native Windows | Animator | 1,117.7 | 119.997 / 119.998 | 9.0 | Fail: startup |
| Native Windows | TAA | 1,628.4 | 120.002 / 119.998 | 8.7 | Fail: startup |
| Native Windows | Text | 904.3 | 120.002 / 119.997 | 8.6 | Pass in these windows |
| Native Windows | Splats | 1,236.6 | 120.000 / 120.000 | 8.6 | Fail: startup |
| Native Windows | Audio | 814.7 | 116.829 / 119.997 | 74.8 | Fail: one long interval |
| Native Windows | Video | 749.4 | 120.003 / 120.000 | 8.9 | Pass in these windows |
| Native Windows | Blender | 875.3 | 120.005 / 120.000 | 9.7 | Pass in these windows |
| Android layout on Intel | Animator | 854.2 | 120.006 / 120.000 | 9.1 | Pass in these windows |
| Android layout on Intel | TAA | 797.5 | 119.997 / 120.002 | 8.6 | Pass in these windows |
| Android layout on Intel | Text | 538.5 | 119.992 / 120.002 | 8.8 | Pass in these windows |
| Android layout on Intel | Splats | 732.2 | 120.000 / 119.992 | 8.5 | Pass in these windows |
| Android layout on Intel | Audio | 682.9 | 120.000 / 119.997 | 8.5 | Pass in these windows |
| Android layout on Intel | Video | 581.3 | 120.000 / 120.002 | 8.7 | Pass in these windows |
| Android layout on Intel | Blender | 790.1 | 118.800 / 120.005 | 25.1 | Fail: one long interval |

Raw evidence: test-results/package-render-media-fixed-20261013.json and its named
canvas screenshots. The tracked measurement copy is
[package-render-media-workloads-2026-10-13.json](package-render-media-workloads-2026-10-13.json).
Initial pre-repair evidence remains in test-results/package-render-media-initial-20261013.json
and package-render-media-taa-failure-20261013.json. The first run's Animator
cadence was approximately 60 Hz, whereas the later run was approximately 120 Hz.
That change is not attributed to the buffer-usage repair; foreground/refresh/clock
drift remains a limit on comparisons between separate whole-page runs.

The actual TAA run isolated a package interop bug missed by the earlier permissive
GPU mocks. taa.add(model) snapshots every 80-byte PBR source through a read-only
storage binding. Robot has both deformed and static primitives; 12 static buffers
had only VERTEX/COPY_DST. WebGPU rejected their bind groups and invalidated the
command buffer. The retained glTF-pro fix adds STORAGE to the existing central
vertex allocation, preserving VERTEX/COPY_DST, all source bytes, sharing,
geometry, indices, shaders and buffer sizes. Setup is also used by prepared
.margo models and restoration. Animation's deformed buffers already had the
required flags. Core, Stage and TAA gained no API or feature. This is an independent
interop repair, not an Afterlight speedup claim.

Published glTF-pro entry: 25,845 to 25,868 raw bytes and 9,465 to 9,478 gzip bytes
(+23/+13). Both asset chunks are byte-identical. Core + Stage remains 47,934 raw /
19,975 gzip, under the strict 20,000-byte limit. Descriptor buffer counts/sizes
are unchanged; driver physical memory-placement behavior was not measured.

Thirty focused checks pass (render/media, TAA attachments/failure/restoration,
PBR batching/culling and temporal resource reuse), including real Robot mixed
static/deformed source flags and replacement buffers after restoration, plus
prepared .margo source flags. Actual browser proof is separately runnable:

```sh
node scripts/test-taa-pbr-storage.js
```

That test completes 12 actual WebGPU cases over desktop 4x and Android-layout 1x:
static/deformed Robot and prepared .margo with TAA, full device reboot, preserved
camera and actual primitive counts, zero validation/page errors, and four bit-
exact non-TAA original/fixed-usage canvas comparisons. All 1,556 traced owned
buffers/textures are destroyed exactly once, all devices retire, and no profiling
queries are allocated. Hooks expose existing local engine/workload and remove
the single usage flag for the old non-TAA baseline. The first baseline hook was
corrected to preserve Vite's transformed response; its failed artifact remains.
The resource/source evidence is test-results/taa-pbr-storage-integration.json.

Next experiments must address the native startup misses and explain the isolated
Audio/Blender gaps using traces before changing implementation. These workloads
currently have ample local frame throughput; that does not finish optimization
audits, establish physical-device behavior or cover every asset/feature.
Read-only candidates include existing per-frame PBR/source record allocations
and temporal snapshots, text atlas warm-up versus later glyph updates, splat radix
work at larger representative counts, and positional graph work versus browser
scheduling. None is retained merely because it seems faster.
