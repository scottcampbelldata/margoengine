# Afterlight first-submission API diagnostic — 2026-10-13

This diagnostic preserves authored desktop terrain, settlement, explorer, full
ocean/reflection/spray and 4x sampling. It holds the deferred detail module after
the complete principal frame. It measures native API CPU durations and existing
queue-completion callbacks, without additional GPU commands, queries or waits.
It does not establish GPU execution durations or the one-second load target.

Conditions: source Vite, headless Edge 154, nonfallback Intel xe-2lpg,
1432 x 768 render buffer, browser DPR 2 and engine DPR 1, reduced motion, no CPU
or network throttling. The first context uses a fresh browser; the second uses
a fresh context in the same browser with existing Vite/driver caches. Root
reserved hardware execution sequentially. No physical Android or hosted CDN
claim follows. Stack capture and resource auditing add instrument overhead.

Source main.ts SHA-256: `960dc6ee7848d3d5dcd3f8c1d522765befc267ac0758b3b58c78664960e3474e`.
Raw report SHA-256: `679a33fe57891ccdabd92c27ba408c6e9fd3e4ccbebb5427c2ed1913419e1a72`. The preserved original is
`test-results/afterlight-startup-api-trace-baseline-20261013.json`.
The reusable diagnostic is
`node scripts/trace-afterlight-startup.js --run`; build packages first and reserve
an exclusive GPU slot. Its initializer is
`scripts/support/afterlight-startup-api-trace.js`. A metadata-only invocation
without `--run` starts no browser/server. Each run saves a dated raw report and
the latest-result alias without replacing prior dated captures.

| Context | Adapter wait | Device wait | Base async pipeline | Warm submit / callback complete | Principal submit / callback complete | Principal opportunity |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 282.2 | 25.3 | 25.5 | 735.2 / 1534.3 | 922.4 / 1534.3 | 1547.5 |
| 2 | 70.7 | 10.5 | 29.0 | 285.9 / 587.5 | 586.4 / 1003.3 | 1030.0 |

All native synchronous creation calls are cheap here: shader modules total
0.8 /
1.2 ms; render pipeline
creation totals 0.2 /
0.3 ms; compute pipeline
creation totals 0.0 /
0.0 ms. Timer resolution
quantizes many calls to zero; zero does not prove no native work. These cheap
returns do not show when the driver compiles or executes their shaders.

Warm submit precedes principal submit by 187.2 /
300.5 ms. The warm queue already contains eleven
Bruneton LUT dispatches: transmittance, single scattering and three repetitions
of density/multiple/sum. Principal includes all nine coastal initialization and
integration dispatches, spray, geometry, exact depth copies, fog and AgX.
Its actual reflection compute dispatch is confirmed before water's draw.
The first context's two callbacks arrive together; the second returns the warm
callback separately. Callback intervals combine queued work, first-use driver
preparation and callback scheduling. They cannot isolate shader compilation,
LUT execution or the final principal raster cost.

Both runs submit two command buffers, each in one queue call: warm 20 passes,
principal 18 passes. The principal has 3 terrain/explorer draws and 12 settlement
draws plus the retained full ocean/effects. All 74 buffers, 25 owned textures and
the device are destroyed once on pagehide. There are no reported page errors; all
contexts, browser and Vite server close.

## Actual pipeline identities

The complete WGSL hashes match between both contexts. Core's awaited base
pipeline is unused by these two HDR submissions. The initial Bloom HDR PBR
variant binds a pass with zero geometry draws. Water also creates an unused
depth-copy variant because this HDR4 path uses SceneTarget's exact sample copy.
These are observations, not accepted removals: alternate targets and later
frames retain their existing contracts.

| Id | Actual pipeline | Samples | Warm / principal use | WGSL bytes | WGSL SHA-256 |
| --- | --- | ---: | --- | ---: | --- |
| 0 | Core base PBR (async) | 4 | No / No | 1942 | `73cdcc2273a3952056c68ddfa6aeb663cbcc4b91c96886a613d2307aae5b0ff2` |
| 1 | Bloom blur | 1 | Yes / Yes | 783 | `0f2999b8cbd131702ee2139b9740092107171e29fadc41218926582e8b75e08b` |
| 2 | Sky transmittance | 1 | Yes / No | 2870 | `151fb57bced96bbcb55928e892b1e97151de342aaa3008f7143d9c9419dee6b4` |
| 3 | Sky single scattering | 1 | Yes / No | 3220 | `1855fbda96ae2a3a886f24e048829ac360edb22670ec30be60de581dc44052ec` |
| 4 | Sky scattering density | 1 | Yes / No | 3071 | `ec17c1344cb5c38bd13018cd517c5ff26a37592be1889a548bcc11586d6701a8` |
| 5 | Sky multiple scattering | 1 | Yes / No | 3007 | `b3fb255402f08cc568c1bc3add214951b78507467ea0be801e7939f870355fcc` |
| 6 | Sky scattering sum | 1 | Yes / No | 378 | `44b710cbaa9f428deaafd1b52e2ff3cabd2077d276f4053fa2ff58395928f28f` |
| 7 | Sky reflection | 1 | No / Yes | 8525 | `cdf10c8adb117649432e511f7dbed5a5581c96dcd054fb57d90973b1441c870b` |
| 8 | Bloom AgX presentation | 4 | Yes / Yes | 1707 | `bc4eaffeef31ed8b7c27625886ae80fc58b94db63ed0a7dc370d76380d99582a` |
| 9 | Bloom warm HDR PBR (zero geometry draws) | 4 | Yes / No | 1884 | `3dfba885e276839a8447c7fff47bf61bd10d261d2b49fc3bee4459c445ef3c32` |
| 10 | Sky visible atmosphere | 4 | Yes / Yes | 7763 | `2e462868e36eb60f628e9047209edc283571a7deae505bbfba601ad25240d1ed` |
| 11 | Sky warm fog (single depth) | 4 | Yes / No | 8566 | `bd25d8e94528fd207258cd8ba7bd9ff1ebc4ad43d82e75c5e9e72e02fd074f4a` |
| 12 | SceneTarget max-depth copy (1x) | 1 | Yes / Yes | 434 | `c91c8619a5dfc5967d0a0d3e8aeb94da2f84dec264e30623bce01a8276494cf4` |
| 13 | SceneTarget exact-depth copy (4x) | 4 | Yes / Yes | 391 | `9a82d18723bda22b432e80294b822afa95a0285c06f7f2031ef34d95dc2dec3d` |
| 14 | Settlement shadow (unused before details) | 1 | No / No | 2363 | `48ca9a51365082fc59dba46e31a5b68bb95dcc929332758b9c026c63e846e23a` |
| 15 | Terrain/explorer HDR PBR | 4 | No / Yes | 3396 | `3a6be4095c8a86862038723fd9447b910bd202705b8c347a0bee6600483b9eb0` |
| 16 | Settlement HDR PBR | 4 | No / Yes | 5735 | `e24f8733d587a89e36bbbbd1b301b459516fa9145178612f1b79fa95d5624e3c` |
| 17 | Water depth-copy variant (unused on this HDR4 path) | 4 | No / No | 342 | `b89188a7d6a5b3d36b02bca3a4e8a0386582246d09e3a87115647e79d599eb60` |
| 18 | Water visible surface | 4 | No / Yes | 11676 | `e443e5c7d42ad15abd78472dd35d46d714c49a220b40b00935b04db0f9be4fc2` |
| 19 | Coastal initialization | 1 | No / Yes | 1057 | `0947aba0f73c08fef21352f6546d63dd2cf7780e93f98a2e0dc72e58dd340bf0` |
| 20 | Coastal flow | 1 | No / Yes | 1492 | `da069d6806a612828ea2dd5dc61ad8026a299568309ff8b817c6c469c9d2ffb1` |
| 21 | Coastal integration | 1 | No / Yes | 3576 | `a4b2a984b08074749bd7a384ffa4663b069f0eea53e0ba67fccdb16b57ad5f17` |
| 22 | Coastal connectivity | 1 | No / Yes | 1302 | `17a7bd603e68b5e5c5964c3fe09f0c96f25ab846c68569d0c2eebb74e2540d98` |
| 23 | Coastal compression | 1 | No / Yes | 1302 | `17a7bd603e68b5e5c5964c3fe09f0c96f25ab846c68569d0c2eebb74e2540d98` |
| 24 | Spray simulation | 1 | No / Yes | 2018 | `b6fe527c8565929445f9bcb1b58d7ab42fb481e9b0c52257278ac0631f58fbcc` |
| 25 | Spray visible draw | 4 | No / Yes | 1923 | `3f9b48d18c09ecbd76506723f9a959961068d8dfe2ea0878ff30d43fad82a00f` |
| 26 | Sky principal fog (4x depth) | 4 | No / Yes | 8623 | `a81d76ee6e7e65b091d06d871ca812d884c642697ec4b45558609728dfe8e8a5` |

## Next controlled diagnostic

An ignored initializer can request asynchronous compilation of the exact same
early optional-package descriptors while returning every original synchronous
pipeline unchanged. Start these requests before the warm submission, allowing
the normal CPU island construction to overlap compiler work. Record individual
async readiness and preserve the existing command/shader/target sequence, image
pixels and resource cleanup. No Core APIs or source changes are required for
this diagnostic. Until a counterbalanced run distinguishes it from ordinary
cache warmup, hidden compilation remains a hypothesis.

The prepared private command is
`node test-results/trace-afterlight-startup-api.mjs --run --early-precompile`.
It runs control/candidate/candidate/control contexts, requests only the same
13 early optional descriptors, returns all original synchronous pipelines, and
checks exact first-principal RGB images. Additional preparation promises are
awaited only after the recorded principal marker, before disposal. Its completed
results are recorded below; it is not a production change.

## Early async preparation experiment - rejected for adoption

The private exact-descriptor async preparation ABBA run completed on 2026-10-13.
First-principal presentation opportunities were control A1 3485.5 ms, candidate
B1 2571.3 ms, candidate B2 2636.0 ms and control A2 2539.1 ms. The first control
includes fresh-context startup costs; it cannot be compared alone against a
later warmed candidate. Both comparable candidates were slower than the final
control, and all three warmed cases exceeded one second. No demonstrated
startup win justifies extra asynchronous pipeline requests. Production remains
unchanged. This test does not isolate GPU execution or prove compiler cost.

All four principal RGB images were bit-exact. Each candidate requested the same
13 early optional descriptors and returned every original synchronous pipeline.
Both submissions and first reflection dispatch remained intact. All 74 buffers,
25 textures and one device per context retired once, with no page errors; all
contexts, browser and server closed. Raw evidence is
`test-results/afterlight-startup-early-precompile-abba.json`.

The first attempt failed only because the screenshot fixture selected both the
scene and Stats canvases. The selector now explicitly chooses `#scene`; the
failure report is preserved as
`test-results/afterlight-startup-early-precompile-fixture-failure.json`.

## Preliminary warm render removal experiment - rejected for adoption

The private warm-removal ABBA run completed on 2026-10-13 with exit 0. A
query-keyed Vite transform removed only the preliminary
`engine.render({delta: 0})` before island construction. The real principal render,
initial reflection request, complete terrain/settlement/explorer/ocean and later
detail path remained unchanged. Both entry transforms were prepared before the
browser opened. These are local instrumented source-server measurements, not
hosted cold-load results.

| Run | Principal submit (ms) | Queue completion callback (ms) | Principal presentation opportunity (ms) |
| --- | ---: | ---: | ---: |
| Control A1 | 2035.6 | 3086.7 | 3094.7 |
| Without warm B1 | 960.7 | 2662.6 | 2671.8 |
| Without warm B2 | 870.2 | 2519.6 | 2530.0 |
| Control A2 | 980.2 | 2372.4 | 2384.5 |

The restored final control was faster than both candidates. The control mean
2739.6 ms versus candidate mean 2600.9 ms cannot establish a gain because the
order exposes strong cache/startup drift. Every run failed the one-second gate.
Removing the warm render is not accepted for production. Queue callback spans
include queued GPU work, driver preparation and callback scheduling; they are
not isolated GPU execution times.

All four nonempty 1432 x 768 first-principal RGB captures were exactly equal
(zero differing pixels). The 12 settlement batches, 73,728 terrain triangles,
14 explorer parts, 15 core geometry meshes, full 256-cell water and spray were
preserved. All 11 Bruneton LUT dispatches moved intact into the first principal
command. The principal pipeline, attachment, draw and dispatch signature matched
after removing only those moved LUT entries for comparison. The reflection
dispatch still preceded the water draw.

The candidate combined two submissions into one and removed empty warm-only
work: total passes 38 to 29, native pipelines 27 to 25, shader modules 26 to 24,
and bind groups/layouts 43 to 41. Buffer and texture counts stayed identical.
Every context retired 74 buffers, 25 textures and one device exactly once;
there were zero live resources, duplicate destroys, page errors or uncaptured
GPU errors. All contexts, browser and Vite server closed. Native synchronous
pipeline creation totaled 0.7 to 0.9 ms across the four runs, which still cannot
attribute the substantial submission-to-callback delays to a specific backend
operation.

Raw evidence: `test-results/afterlight-startup-without-warm-abba.json`.
SHA-256: `6ae98fcf913e931cf19b0e9afd9aedd44b7d9f33a1b1b7c15a75ab57db0627ca`.
Unmodified production entry SHA-256:
`960dc6ee7848d3d5dcd3f8c1d522765befc267ac0758b3b58c78664960e3474e`.
The runner is `test-results/compare-afterlight-warm-startup.mjs --run`.

The first attempt exited 1 before any candidate because its fixture classified
only eight of eleven LUT dispatches. Classification now uses the actual Sky
pipeline caller and compute entry, including the three simple scattering-sum
dispatches. The failure is preserved separately in
`test-results/afterlight-startup-without-warm-lut-classifier-failure.json` and
its log; all resources and browser/server were closed on that failed attempt.

## Prepared browser/driver trace diagnostic

`node test-results/trace-afterlight-browser-startup.mjs --run` is prepared and
syntax-checked, but has not run. Edge is the default; `--chrome` selects Chrome.
It records first and second fresh contexts, discovers the installed tracing
categories and enables browser main-thread/V8/scheduler activity plus GPU/Dawn
categories. Actual user-timing marks align native API submit/callback times with
the streamed trace, and a buffered long-task observer checks callback-delay
evidence. The analyzer reports separate per-thread interval unions so nested
or parallel spans are not incorrectly summed. The offline analyzer checks are
prepared in `test-results/afterlight-browser-trace-analysis-check.mjs`.

The default adds no GPU commands, features or waits. Optional `--gpu-span` is a
separate prepared diagnostic: it adds pooled timestamp writes to every original
initial pass, appends query resolve/copy commands to the existing command buffers
and reads them only after the principal presentation marker. Its one query set
and two 2048-byte buffers are retired on pagehide. The native first-principal span
starts at that command's first pass timestamp and ends at its final pass
timestamp. It excludes work or driver preparation before the first timestamp,
later presentation and appended query copies, and can contain scheduling gaps
between passes. Neither mode changes production source or the frozen Core API.

Category/protocol preparation uses the official
[Chrome DevTools protocol schema](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json)
and Chromium's
[Dawn command tracing](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/gpu/command_buffer/service/dawn_service_serializer.cc).
Dawn's
[D3D12 shader module source](https://raw.githubusercontent.com/google/dawn/main/src/dawn/native/d3d12/ShaderModuleD3D12.cpp)
contains compilation tracing, but the installed browser must actually emit those
events before backend attribution is justified. Recorded browser/driver spans
are CPU wall times, not GPU hardware execution; missing events do not prove that
compilation is absent. Full tracing itself adds overhead and is not a one-second
load acceptance run. These scripts remain private until the real run validates
their trace schema, clocks, complete scene and cleanup.
