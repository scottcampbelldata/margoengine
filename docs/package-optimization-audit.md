# Package optimization audit

Stage applications use `margoengine`, which shares and re-exports core. Applications
using `Engine` directly may omit Stage. Import the feature entries an application
uses, plus their required dependencies, and load heavy features on demand. Keep a
single matching core version. Installing an optional package does not mean its
code must enter the initial browser download.

Core and Stage remain feature-frozen. Their combined gzip gate rejects 25,000
bytes and above. Gzip figures below are from this audit. The current build measures core at 18,876 bytes gzip and core plus stage at 21,107 bytes gzip. Optional packages retain their existing root exports; narrower
entries provide the same implementations and constructor identities.

## Second deep pass (2026-10-12)

This is the current working-tree audit and deployment. The later first-pass
sections retain historical measurements and their original report references.
The preserved second-pass baseline contains 730 visible package files; the final
inventory accounts for all **734 files across 61 package manifests plus Kernel
and shared**, with 110 changed or added files, four additions, and no missing or
removed records. Every final source hash matches its contributing review.
Authored code, tests, declarations, shaders, build metadata and documentation
were reviewed; generated/vendor/binary files have explicit classifications and
format/reference checks. Coverage is recorded in
`test-results/deep-second-pass-audit.json`, with a separate independent core
review in `test-results/deep-core-independent-review.json`.

The second pass fixes resource rollback and retry after partial initialization,
failed render-pass closure, interrupted depth allocation, sample/depth-format
cache invalidation, mutable buffer binding ranges, and TAA camera restoration.
It also fixes canceled work, malformed ZIP/geometry/physics inputs, extreme
finite quaternion and tween values, and listener/session lifecycle races.
Normal valid-input behavior and public module identities have focused
regressions; invalid inputs now reject before allocation or a non-progressing
sampling loop. Diagnostic strings were shortened to preserve the size gate;
validation and error classes remain intact, but exact error text changes.

| Area | Reproduced second-pass result |
| --- | --- |
| Grass / PlanetPass startup | Initial pipelines decrease from eight to two each; Grass spores decrease from twelve pipelines to three. Supported format, depth and sampling variants are built when needed and reused. |
| Animation / Audio / HTML / XR | Remove recurring pose views, listener arrays, occlusion capacity arrays and owned XR attachment views; retained state still invalidates on resource changes. |
| Water / Clustered / Particles / Navmesh | Remove temporary uniform views, packed obstacle arrays and stable ORCA validation arrays; packed uniform floats retain exact baseline bytes. |
| Core box / Stage sphere / Planet sphere | Write scalar vertex slots and reuse latitude trigonometry; regression fixtures preserve exact geometry bytes, winding and bounds. |
| Shared depth / render plugins | Failed setup and interrupted capture release owned resources, preserve borrowed targets and allow retry; real hardware validates eight sample/depth-format combinations. |
| Exporters | Add `@margoengine/exporters/usdz` and use it from the optional USDZ facade; existing root exports and implementation identities remain. |

No feature, shader math, model or texture detail, scene sampling, or public
constructor is removed in this pass. Existing desktop backing DPR 1 / 4× MSAA
and mobile DPR 2 / 1× policy remain unchanged. This does not erase the earlier
HiDPI density tradeoff. Retained caches track supported shader, sample-count,
format and resource-range changes. Arbitrary edits to raw pipeline descriptor
state still require an explicit pipeline; automatic tracking of every raw
WebGPU descriptor field is not claimed. Likewise, these targeted allocation
checks do not establish zero JavaScript allocations throughout every engine frame.

The integrated package build and strict size gate pass at **47,983 raw /
19,999 gzip bytes for Core + Stage**. The full unit suite passes **754/754**,
with no skips or failures. All 61 packed packages import without browser globals
and pass strict Bundler and NodeNext consumer compilation. All **28 sequential
native browser programs** pass on Edge 155 / NVIDIA RTX A6000, with hardware
WebGPU and no software fallback or pacing override. The cross-depth check
passes 1× and 4× sampling with depth24plus, depth24plus-stencil8, depth32float
and depth32float-stencil8. SkyMoon's obsolete two-pass assertion was corrected:
baseline and current both use scene, sky and final resolve at 4×. The strengthened
check verifies retained scene/sky descriptors, load/store/resolve semantics,
zero warmed GPU resource creations, pixels and restoration. Its shaders remain
unchanged.

All seven local and deployed desktop demos pass rendered-scene, controls,
resize, native HTML density, active 4× attachment and complete owned GPU cleanup
checks. The current deployment is
[73cbd49f](https://73cbd49f.margoengine.pages.dev), also served at
[margoengine.com](https://margoengine.com). Seven live entries and all 47
JavaScript files match the final local build byte for byte. Reports are
`test-results/desktop-demos-deep-second-local.json`,
`test-results/desktop-demos-deep-second-deployment.json` and
`test-results/deep-deployed-bundle-integrity.json`. In this single live run,
reported first-frame timestamps range from 537 to 1,160 ms; these are
instrumented startup observations, not a guarantee for other networks or PCs.
The unit, build, packed-consumer and native logs remain under
`test-results/deep-second-pass-*.log` and `test-results/deep-native-sweep.json`.

The user confirms this PC is accessed through RDP. All seven live demos have
about 32 Hz native callbacks on this host. Microsoft documents remote-session
frame-rate limits, including 30 FPS in some RDP configurations:
[Microsoft Learn](https://learn.microsoft.com/en-us/troubleshoot/windows-server/remote/frame-rate-limited-to-30-fps).
Physical-display 60 FPS and the original slowdown's common cause remain
unverified. Hardware CPU/GPU work is measured separately from remote presentation.

### Current deployed CPU/GPU measurements

The final timing run uses deployment 73cbd49f, native Edge 155 and the NVIDIA
RTX A6000, at 1440×900 CSS pixels and device DPR 2. It retains desktop backing
DPR 1 / 4× MSAA and normal requestAnimationFrame. Each demo warms for 91 native
callbacks, records 64 submitting CPU callbacks without GPU timing hooks, then
records 12 sparse hardware GPU timestamp samples. There are no page, network
or GPU errors. The blank-page callback control measures **31.62 Hz**.

| Demo | CPU callback median | GPU pass-span median | Largest sampled GPU pass span |
| --- | ---: | ---: | ---: |
| citadel | 0.30 ms | 7.14 ms | 13.70 ms |
| afterlight | 0.60 ms | 5.90 ms | 13.37 ms |
| helmet | 0.30 ms | 7.41 ms | 8.13 ms |
| character | 0.50 ms | 4.39 ms | 6.03 ms |
| robot | 0.50 ms | 4.98 ms | 8.06 ms |
| meadow | 0.30 ms | 4.78 ms | 11.86 ms |
| earth | 0.20 ms | 3.21 ms | 4.72 ms |

CPU callback medians are 0.20–0.60 ms; GPU pass-span medians are 3.21–7.41 ms.
All sampled spans in this run are below 16.67 ms. GPU pass-time sum medians are
2.36–5.18 ms. Pass sums exclude copy work and scheduling gaps; spans include
between-pass gaps but exclude work before the first and after the last measured
pass. Timestamp quantization is 65.536 microseconds, and diagnostic hooks can
change scheduling. Twelve sparse samples on one RDP host cannot establish
sustained physical-display 60 FPS, prove the original slowdown's cause or measure
a before/after FPS gain. Raw timestamps and hardware details are in
`test-results/production-native-frame-timing-deep-second.json`.

## First full package pass: changes (historical)

Counts below describe focused fixtures, rather than a promised gain for every
application. Stable-frame allocation counts exclude setup and resource replacement.

| Package | Change | Reproduced result |
| --- | --- | --- |
| Sky | Compute the scattering lookup only when Bruneton needs it | Preetham setup computes 1 stage instead of 11; ten hardware comparison phases have identical pixels and Sun/reflection texture bytes |
| TAA / Scatter | Retain the camera binding and rebuild bindings independently from pipelines | Eight warmed combined frames create zero additional Scatter pipelines and bind groups instead of 8 and 16 |
| Terrain | Cache lighting bindings with resource/range invalidation | 120 stable draws create 1 lighting group instead of 120; all ring draws remain |
| Selection | Retain mask views and draw bindings | Eight stable frames create zero extra groups/views instead of 8/24 |
| HTML | Cache depth bindings; skip empty anchor dispatch after validating depth | Stable anchors retain views/groups; empty overlays dispatch no occlusion work |
| Animator | Blend owned sampled poses without copying them again | Two-node, two-clip fixture copies 12 vectors instead of 18; fade snapshots remain independent |
| SSAO | Retain blur directions and projection view | 120 warmed frames create zero Float32Arrays instead of 240 |
| Clustered | Retain camera view | 120 warmed frames create zero temporary view objects instead of 120 |
| Audio | Reuse normalization and camera scratch storage | 120 unchanged listener updates make zero array slices instead of 360 |
| Text | Compare cached layout fields before constructing a snapshot | 120 cached reads create no mapped snapshot arrays; all layout invalidation keys remain |
| Cinematic | Reuse each damping decay across axes | Two exponential evaluations per tick instead of six; spring equations are unchanged |
| Inspector | Skip mesh scans when debug helpers are disabled and absent | Zero mesh scans in 120 default frames instead of 120 |
| WFC | Cache fixed weighted logarithms | Seeded eight-cell output is identical; 108 redundant tile logarithms are removed |
| FBX | Track decoded pixel totals incrementally; check cancellation per image | Twelve-image property reads decrease from 156 to 24; cancellation prevents subsequent decodes |
| Decoders | Check cancellation before compressed-input copying and pool creation | Pre-aborted Draco/Basis requests copy zero inputs instead of two |
| BVH | Normalize raw streams once; make the world sphere conservative under shear | Positions/normals convert once instead of three times; sheared geometry no longer disappears from ray queries |
| Loaders | Compute fallback normals only when needed; grow PLY polygon scratch on demand | Valid file normals avoid unused normal computation; point/triangle PLY files avoid the fixed 512 KiB scratch allocation |
| Geometry | Write PBR stream slots directly; reject invalid triangulation dimensions | Five temporary views per vertex are removed with bit-identical 80-byte rows; invalid dimensions cannot hang the caller |
| Physics | Release resources when initialization/attachment rejects | Failed setup releases native controllers/world/event queue while preserving the original error |
| Lines / Points | Include mutable line mode in the dash cache; commit a sprite slot after validation | Mode changes update distances; rejected sprites do not become active phantom instances |
| Environment / ZIP / VTK | Validate integer dimensions/offsets, NaN limits and early cancellation | Malformed inputs reject at their boundary; stored ZIP entries honor pre-aborted signals |

Bloom and SSAO have separate `@margoengine/post/bloom` and `/ssao` entries.
`@margoengine/gltf-pro/asset` exposes the existing CPU asset class without PBR
rendering, and `@margoengine/splats/data` exposes existing parsing and validation
without the renderer. Existing root namespaces remain available. Earlier narrow
Creative, Scenery and Machinery entries and lazy Stage helpers are retained.

No shader math, sample count, texture detail, model detail or supported feature is
removed by this package pass. The earlier desktop canvas change caps backing DPR
at 1 while retaining 4× MSAA; that density policy has its own HiDPI detail tradeoff
and is documented in [desktop-frame-rate.md](desktop-frame-rate.md).

## First full package pass: coverage and validation (historical)

The audit inventories authored implementations, shader/declaration sources,
manifests, build/config files, tests, fixtures, package documentation and examples.
Generated distributions and copied licenses are outputs; generated Wasm and binary
fixtures receive format/reference checks rather than a line-by-line source claim.
The combined record, `test-results/package-optimization-combined-audit.json`,
checks fresh hashes and asserts no missing package or visible file. It accounts
for all 730 visible files across 61 package manifests plus Kernel and shared:
743 records including copied licenses, 668 full text reviews, one complete
reference-fixture validation, and explicitly identified assets/generated/vendor
records. Per-reviewer records retain findings, unchanged-code justifications and
limits. An independent review covers another 51 changed source/test/caller files.

All package builds pass. Core + Stage remains 47,916 raw / **19,997 gzip bytes**.
The full repository unit run passes **627/627**, with no failures or skips. All
61 packed packages contain their declared exports, import without browser globals
and compile for strict Bundler and NodeNext consumers. Native import and bundled
consumer tests verify narrower entries and preserved root identities.

The rebuilt Meadow initial static code closure is 44,859 gzip bytes, down from
49,279 in the preceding live build. Citadel is 56,185, Afterlight 98,670, Earth
38,547, and each model page 39,278. These are sums over initial static chunks;
assets and dynamic startup imports are separate. Full reachable closures also
include dormant whole-package Stage helper exports. Raw module graphs and counts
are in `test-results/perf-bundle-closure-package-optimized.json`.

Native Edge/NVIDIA GPU checks pass the 13 module variants, desktop/phone sampling,
game/temporal rendering, PBR/SSAO/animation extensions, Stage on WebGPU/WebGL,
audio, lines, points/sprites, text, Environment and Selection picking. They retain
pixel, shader/error, controls, restoration and resource-lifetime assertions.

All seven rebuilt local and deployed desktop demos pass complete-scene, control,
resize, native HTML density, active 4× attachments and GPU-cleanup checks. The
production deployment is `https://240fa177.margoengine.pages.dev`, also served at
`https://margoengine.com`. Seven live entries and all 47 JavaScript files match
the local build byte for byte. Reports are
`test-results/desktop-demos-package-optimized-local.json`,
`test-results/desktop-demos-package-optimized-deployment.json` and
`test-results/deployed-bundle-integrity.json`.

Reviewing a file does not prove every branch correct or mean that every algorithm
is already optimal for every workload.

An audio browser failure reproduced against both the original and optimized
listener: the cold AudioContext clock stopped advancing while a wall timer kept
running. The test now measures smoothing settlement in audio time with a bounded
timeout, preserving immediate-pose assertions, smoothing duration and tolerances.
This changes test scheduling only. A successful SceneFade lifecycle regression
also covers normal/reduced-motion completion, restoration and borrowed output
ownership; the demos do not use SceneFade.

The Environment browser test previously classified partially covered MSAA edges
as fully covered mesh. Original and current runtimes produce identical pixels.
An independent coverage probe now keeps exact equality for 1,007 fully covered
mesh pixels and checks the background contribution to 89 partial edges (worst
error 1.071 bytes, within the existing 3-byte limit). All eight native checks pass,
including exact device-restoration output. Rendering code and bundles are unchanged
by both browser-test corrections.

## First full package pass: measurement limits (historical)

Native presentation on this Remote Desktop host is around 32 Hz even for a blank
page. Its hardware GPU checks validate rendering and measure GPU work; they cannot
establish a locked 60 FPS on the affected physical PCs. A final native timing run
on deployment `240fa177`, Edge 155 and NVIDIA RTX A6000 uses a 1440×900 CSS viewport,
device DPR 2 and the unchanged desktop backing DPR 1 / 4× MSAA policy. Each route
warms for 91 native callbacks, records 64 submitting CPU callbacks without GPU
timing hooks, then records 12 sparse GPU samples. Browser, network and GPU errors
are zero. Blank-page callbacks average 31.03 Hz.

| Demo | CPU callback median | GPU pass-span median | Largest sampled GPU pass span |
| --- | ---: | ---: | ---: |
| Citadel | 0.40 ms | 7.73 ms | 17.89 ms |
| Afterlight | 0.80 ms | 5.11 ms | 13.04 ms |
| Helmet | 0.40 ms | 7.41 ms | 8.13 ms |
| Character | 0.70 ms | 5.90 ms | 6.95 ms |
| Robot | 0.60 ms | 4.52 ms | 5.70 ms |
| Meadow | 0.30 ms | 5.05 ms | 15.40 ms |
| Earth | 0.20 ms | 3.87 ms | 6.68 ms |

GPU pass span includes gaps between measured passes, but excludes work before
the first and after the last. GPU pass-time sums have medians of 2.69–5.11 ms.
Timestamp resolution is 65.536 microseconds; diagnostic hooks/readback can alter
scheduling. Citadel's largest sampled span exceeds the 16.67 ms frame budget.
These sparse, single-host measurements cannot establish sustained 60 FPS or a
before/after gain. Raw samples, hardware and canvas dimensions are retained in
`test-results/production-native-frame-timing-package-optimized.json`; the older
`test-results/production-native-frame-timing.json` remains unchanged.

Valid-input behavior, errors, cancellation, resource ownership, restoration and
module identities are preserved by focused regressions. No npm release is
published as part of this working-tree audit. Remaining opportunities such as
mutable Terrain shader assembly or different path-search/splat-sort algorithms
need workload evidence and behavior comparisons before changing them.
