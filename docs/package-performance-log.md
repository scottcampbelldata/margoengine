# Package performance log

Requested scope: inspect and measure every package; retain demonstrated improvements in
the owning package, remove unsuccessful experiments, and continue until further plausible
changes stop producing a useful measured gain. This log is saved in the repository; the tuning changes remain uncommitted and unpublished.

Started 2026-10-13. Scope: all 63 directories under packages/: 61 npm packages
with package.json plus the internal Rust kernel and shared implementation units.
All-package work is in progress. No package is marked finished solely because its source
was read or its correctness tests passed. No changes from this tuning session are live.

Acceptance includes behavior/features, visual or numerical quality, frame/execution time,
allocation/resource behavior, startup and raw/compressed bytes. The combined frozen
core/stage limit remains below 20,000 gzip bytes. Record any byte increase explicitly;
The latest staged Afterlight consumer totals 102,472 gzip bytes across its initial and detail chunks, versus 99,299 for the saved live entry (+3,173). Size-neutral final acceptance remains unmet. Historical pre-staging measurements are preserved below.

Actual Windows GPU: Intel Arc 140V, nonfallback WebGPU; desktop canvas 1432 x 768.
GPU workloads run sequentially. Use warmed counterbalanced measurements and isolated
same-queue tests, then measure whole-app cadence with profiling disabled. Other active
GPU work and clock changes can affect absolute FPS. Android device is currently unavailable.

Detailed desktop experiments: [GPU tuning log](gpu-tuning-log-2026-10-13.md).
Earlier history, load and Citadel results: [Investigation](performance-investigation-2026-10-13.md).
The [package inventory](package-performance-inventory.json) maps the npm packages and internal units to
their actual source examples, correctness fixtures and benchmark references.
Its coverage counts are updated as actual labeled workloads are added under
`examples/package-benchmarks/`. Existing references are coverage evidence, not a
claim that new performance tests passed.

## Package index

| Package | Current work and evidence | Status |
| --- | --- | --- |
| [@margoengine/animation](../packages/animation/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/animator](../packages/animator/README.md) | Real skinned RobotExpressive PBR scene, state/blend/Wave layer controls; CPU/mock correctness passes. Native and candidate audit queued. [Fixture scope](package-render-media-workloads-2026-10-13.md). | Open |
| [@margoengine/audio](../packages/audio/README.md) | Actual generated-tone positional Web Audio graph and retained FFT; starts silent. Fake audio/spatial/cleanup correctness passes; browser DSP/cadence and candidate audit queued. [Fixture scope](package-render-media-workloads-2026-10-13.md). | Open |
| [@margoengine/blender](../packages/blender/README.md) | New fixed 1,004-byte textured .margo workload with shared geometry/mirrored TRS, repeat decode and late-image cleanup; CPU/mock correctness passes. Native PNG/PBR/cadence and candidate audit queued. [Fixture scope](package-render-media-workloads-2026-10-13.md). | Open |
| [@margoengine/bvh](../packages/bvh/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/cinematic](../packages/cinematic/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/clustered](../packages/clustered/README.md) | Zero-light guard tested and rejected: no convincing GPU gain. Broader lighting workload tuning pending. | Open |
| [@margoengine/controls](../packages/controls/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/core](../packages/core/README.md) | Optional timestamp support repaired; default query allocation stays zero; native 4x still exceeds frame budget. Combined core/stage 19,975 gzip bytes. | Open |
| [@margoengine/creative](../packages/creative/README.md) | Earth texture payload reduced 24.7% outside package renderer. Package rendering tuning pending. | Open |
| [@margoengine/decoders](../packages/decoders/README.md) | [Labeled package workload](../examples/package-benchmarks/index.html?package=decoders): Actual Draco Avocado worker decode with accessor-count checks and two-worker pool. Node proves honest SSR rejection; browser worker proof is pending. Eight shared correctness checks pass; native acceptance/candidate audit pending. | Open |
| [@margoengine/dof](../packages/dof/README.md) | Current Core0.1 compatibility verified in packed strict consumer; new built standalone route, actual controls/correlation/mobile framing/cleanup pass. Native functional principal3064.6ms misses load goal; timing/candidate audit remains open. [Immediate-use evidence](postfx-immediate-use-2026-10-13.md). | Open |
| [@margoengine/ecs](../packages/ecs/README.md) | New visible 10k-entity workload and correctness checks; native cadence/startup pending. | Open |
| [@margoengine/environment](../packages/environment/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/exporters](../packages/exporters/README.md) | [Labeled package workload](../examples/package-benchmarks/index.html?package=exporters): Actual GLB/PLY/STL/OBJ writers; displayed geometry is reimported emitted PLY. GLB validates with zero errors. Eight shared correctness checks pass; native acceptance/candidate audit pending. | Open |
| [@margoengine/fbx](../packages/fbx/README.md) | [Labeled package workload](../examples/package-benchmarks/index.html?package=fbx): Actual Three FBXLoader to GLTFExporter conversion of checked static ASCII triangle; emitted GLB validates with zero errors. Eight shared correctness checks pass; native acceptance/candidate audit pending. | Open |
| [@margoengine/fsm](../packages/fsm/README.md) | New visible 1k hierarchical-agent workload and correctness checks; native cadence/startup pending. | Open |
| [@margoengine/geometry](../packages/geometry/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/gizmo](../packages/gizmo/README.md) | New 16-cube transform overlay; native and phone-layout drag/reset/cleanup checks pass. Native baseline 120 Hz, 947 ms principal opportunity; candidate audit and broader hardware acceptance open. [Evidence](package-ui-runtime-workloads-2026-10-13.md). | Open |
| [@margoengine/gltf](../packages/gltf/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/gltf-pro](../packages/gltf-pro/README.md) | Authored culling: 30 exact GPU parity cases, 4x paired median speedup 14.3%, no 1x regression; final +14 package gzip bytes. | Open |
| [@margoengine/html](../packages/html/README.md) | New 16-cube/32-anchor example; actual native depth/paused-toggle/cleanup checks pass. Native baseline 120 Hz, 521 ms principal opportunity; nine passes versus two in phone layout exposes desktop resolve cost. Candidate audit remains open. [Evidence](package-ui-runtime-workloads-2026-10-13.md). | Open |
| [@margoengine/ifc](../packages/ifc/README.md) | [Labeled package workload](../examples/package-benchmarks/index.html?package=ifc): Actual web-ifc Wasm IFC4 wall tessellation, BIM identifiers and original 0.2 × 3 × 4 meter extent retained. Parser/API disposal passes. Eight shared correctness checks pass; native acceptance/candidate audit pending. | Open |
| [@margoengine/input](../packages/input/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/inspector](../packages/inspector/README.md) | New 16-cube editor and WebGPU AABB bounds; native/phone-layout edits/debug/cleanup checks pass. Native baseline 120 Hz, 599 ms principal opportunity; candidate audit and broader acceptance open. [Evidence](package-ui-runtime-workloads-2026-10-13.md). | Open |
| [@margoengine/labels](../packages/labels/README.md) | New moving 2D/CSS3D example; native/phone-layout interaction/projection/ownership checks pass. Native baseline 120 Hz, 356 ms principal opportunity; candidate audit and broader acceptance open. [Evidence](package-ui-runtime-workloads-2026-10-13.md). | Open |
| [@margoengine/lines](../packages/lines/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/loaders](../packages/loaders/README.md) | [Labeled package workload](../examples/package-benchmarks/index.html?package=loaders): Real bounded PLY parsing of 855 vertices/1,689 triangles with normal/geometry construction and repeated jobs. Eight shared correctness checks pass; native acceptance/candidate audit pending. | Open |
| [@margoengine/machinery](../packages/machinery/README.md) | Performance workload and candidate audit pending. | Open |
| [margoengine](../packages/margoengine/README.md) | Frozen stage facade; unchanged. CPU facade/bundle checks pending. | Open |
| [@margoengine/navigation](../packages/navigation/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/navmesh](../packages/navmesh/README.md) | New demo with 32 polygons and 64 A*/funnel/ORCA agents; source/behavior checks pass. Native mean 120 Hz; first local complete scene 1,497 ms misses deadline; full acceptance pending. [Evidence](package-routing-workloads-2026-10-13.md). | Open |
| [@margoengine/net](../packages/net/README.md) | Exact-output search/trig fix: about 3x CPU speed at 32 slots, about 20x at 257; final -1 package gzip byte. Native workload means exceed60; isolated tail stalls still need attribution. | Open |
| [@margoengine/physics](../packages/physics/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/points](../packages/points/README.md) | [Labeled package workload](../examples/package-benchmarks/index.html?package=points): Actual 397-point PCD clouds, 32-point range updates per cloud/frame, SpriteBatch markers, drawn-point pick and EDL toggle. Four shared CPU/encoding-recorder checks pass; native acceptance/candidate audit pending. | Open |
| [@margoengine/post](../packages/post/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/procedural](../packages/procedural/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/react](../packages/react/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/road](../packages/road/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/scatter](../packages/scatter/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/scenery](../packages/scenery/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/selection](../packages/selection/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/shadows](../packages/shadows/README.md) | PCSS constants faster in 10/10 GPU pairs; 1M HDR pixels identical; final -212 raw/0 gzip bytes; CPU basis rejected. | Open |
| [@margoengine/sky](../packages/sky/README.md) | Nearest-depth approximation removed; exact four-mask alternative slower in all 40 pairs. Original per-sample quality retained. | Open |
| [@margoengine/splats](../packages/splats/README.md) | Real globally sorted anisotropic Gaussian bunny scene with SH/orbit controls; data/encoding/resize/cleanup correctness passes with mock GPU. Native acceptance and candidate audit queued. [Fixture scope](package-render-media-workloads-2026-10-13.md). | Open |
| [@margoengine/splines](../packages/splines/README.md) | New demo with 3 curves, 336 followers and 48 guides; cubic/arc/tangent checks pass. Native mean 120 Hz, 533 ms first local principal opportunity; physical-mobile/cold-hosted acceptance pending. [Evidence](package-routing-workloads-2026-10-13.md). | Open |
| [@margoengine/stats](../packages/stats/README.md) | Pooled pass/span timing works on actual Core-created device;1 query set/2 buffers and zero measurement-window allocations. Default queries0; frame tails/overhead work continues. | Open |
| [@margoengine/taa](../packages/taa/README.md) | Actual registered walking PBR model with animated velocity, history/reset/toggle; mock camera/source/lifecycle checks pass. Native temporal quality/cadence and candidate audit queued. [Fixture scope](package-render-media-workloads-2026-10-13.md). | Open |
| [@margoengine/terrain](../packages/terrain/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/text](../packages/text/README.md) | Real SDF renderer/layout/atlas and fixed-length update scene; unit font rasterizer/mock GPU correctness and late-font abort pass. Real browser glyph quality/cadence and candidate audit queued. [Fixture scope](package-render-media-workloads-2026-10-13.md). | Open |
| [@margoengine/tonemap](../packages/tonemap/README.md) | Current Core0.1 compatibility verified in packed strict consumer; new built route with actual curves/exposure/contrast/LUT/late-file cleanup checks. Native functional principal1157.1ms misses load goal; tuning remains open. [Immediate-use evidence](postfx-immediate-use-2026-10-13.md). | Open |
| [@margoengine/toon](../packages/toon/README.md) | [Labeled package workload](../examples/package-benchmarks/index.html?package=toon): Specific Toon package stepped lighting and front-culled silhouette hull on real dolphin surfaces; plugin toggle/disposal. Four shared CPU/encoding-recorder checks pass; native acceptance/candidate audit pending. | Open |
| [@margoengine/transitions](../packages/transitions/README.md) | [Labeled package workload](../examples/package-benchmarks/index.html?package=transitions): Actual captured knight/dolphin scenes, one prior-scene copy per switch and all four composites; paused progress retained. Four shared CPU/encoding-recorder checks pass; native acceptance/candidate audit pending. | Open |
| [@margoengine/tween](../packages/tween/README.md) | New visible 1k eased-track workload and correctness checks; native cadence/startup pending. | Open |
| [@margoengine/usdz](../packages/usdz/README.md) | Performance workload and candidate audit pending. | Open |
| [@margoengine/usdz-export](../packages/usdz-export/README.md) | [Labeled package workload](../examples/package-benchmarks/index.html?package=usdz-export): Actual aligned standalone USDZ archive export/reimport of a 1,000-triangle knight; static untextured scope. Eight shared correctness checks pass; native acceptance/candidate audit pending. | Open |
| [@margoengine/vfx](../packages/vfx/README.md) | Billboard rotation experiment rejected earlier; all tiers preserved. Off still slow; package tuning pending. | Open |
| [@margoengine/video](../packages/video/README.md) | Generated Canvas MediaStream/HTMLVideoElement/external-texture workload; mock media/encoding/late-source ownership checks pass. Actual frame delivery/GPU/cadence and candidate audit queued. [Fixture scope](package-render-media-workloads-2026-10-13.md). | Open |
| [@margoengine/water](../packages/water/README.md) | 4x refraction copy removed in candidate; 16 unit tests pass; native pixel/hazard/timing acceptance open. | Open |
| [@margoengine/wfc](../packages/wfc/README.md) | New demo generates 64 constrained/pinned weighted cells; seed/rule checks pass. Native mean 120 Hz, 497 ms local principal opportunity; phone-layout OFF 91.7 ms tail prevents steady 60 claim. [Evidence](package-routing-workloads-2026-10-13.md). | Open |
| [@margoengine/xr](../packages/xr/README.md) | Performance workload and candidate audit pending. | Open |
| [Internal kernel](../packages/kernel/Cargo.toml) | Rust/Wasm transform and culling work is exercised through actual Core demos; independent CPU scaling/size audit pending. | Open |
| [Internal shared units](../packages/shared/demo-frame.js) | GPU target/readiness helpers exercised by package demos;6 readiness checks and real staged-scene lifecycle proof. Resolve tuning pending. | Open |

## Detailed entries

### shadows

- Tested precomputed Float32 spiral offsets with all 16 blocker and 32 filtering taps retained.
- Ten alternating AB/BA pairs in one submitted command buffer: median 4.391 to 3.932 ms;
  all ten candidate passes faster. More than 1,048,576 rgba16float pixels match exactly.
- Same-queue fixture uses four 1024-square shadow maps with real soft-shadow filtering.
- Shared implementation and build/type checks pass; 13 targeted tests pass.
- Two identical repeated matrix-row expressions replaced with length(rowX); Float32
  row checks pass. Moving documentation out of generated WGSL changes no arithmetic;
  comparable optional package build is now 20,393 to 20,196 raw bytes and 6,622 to
  6,625 gzip bytes, +3 gzip. Size-neutral acceptance remains open.
- CPU-precomputed cascade basis rejected: four real fitted-cascade orientations,
  40 alternating GPU pairs and a dependent-read sentinel show no consistent gain.
  Between 52 and 173 of 1,048,576 HDR pixels differ per case, at most one half-float ULP.
  CPU preparation costs about 0.148 microseconds per four-cascade frame, excluding upload.
  No source changes retained. Fixture: `test-results/pcss-basis-microbench.mjs` and JSON.
- Whole-app improvement has not reached 60 FPS; continue tuning.

### sky

- Desktop fog repeated atmosphere lookup per coverage sample. Candidate computes once
  per pixel while retaining MSAA coverage mask; 1x path unchanged.
- Build and ten unit tests plus real GPU coverage, multiple sky models and daylight/night
  tests pass. Covered subpixel layers use nearest depth, including fog start, so visual
  parity fails. Removed the nearest-depth source/test expectation; original per-sample
  haze is restored. Retained the meaningful GPU regression fixture and updated it to
  require exact per-sample reference parity, including distinct near/far layers.
- Exact alternative tested: four constant-sample masked draws in one render pass.
  All 4,194,304 RGBA samples per lighting case match, but all 40 GPU pairs are slower:
  Bruneton day 1.049 -> 1.311 ms; twilight 1.180 -> 1.442; night 1.245 -> 1.573;
  Preetham day 1.049 -> 1.507. No source change. Fixture:
  `test-results/sky-exact-masks-microbench.mjs` and JSON. Continue other plausible paths.

### water

- Candidate samples the existing resolved 1x opaque HDR color during 4x water rendering
  instead of copying it into another full-screen texture. The active 4x attachment is separate.
- 1x and unrelated/non-bindable sources retain the copy. Borrowed textures are never destroyed.
- Build/type checks and 16 unit tests pass, including resource/ownership/fallback cases.
- Native pixel equivalence, hazards and isolated GPU timing remain pending.

### stats

- Retained existing pool: one query set, two 2 KB buffers, one async readback in flight.
- Added reused numeric per-pass timings and elapsed span for efficient attribution.
- Cleared stale readings for invalid/empty/overflow samples; 12 tests pass including
  100 readbacks reusing the same CPU array, GPU resources and timestamp descriptors.
- Native pooled captures pass with zero query/buffer allocations during both eight-second
  windows. Sampled pass sums of 20.51/15.86 ms miss inter-pass work; corresponding
  elapsed spans are 29.16/23.46 ms. Profiling-on/off overhead acceptance remains pending.

### core, post, terrain, scatter, procedural

- Desktop workload is GPU-bound: JavaScript median 1.2-1.4 ms versus roughly 18-21 ms GPU work.
- Particle Off, identical full scene: descriptor-only 4x to 1x improved native cadence
  approximately 35-42 to 67 FPS. This is a diagnostic ablation, not an accepted quality downgrade.
- Removing core fragment backface discard made GPU performance worse and was rejected.
- Combined candidate changes improve native mean cadence about 12.4%, but current
  counterbalanced baseline 30.75/33.48 versus candidate 34.75/37.41 still miss 60 FPS.
- Matched paused frames differ in 2.052 percent of pixels, mean RGB error 0.0232 byte values;
  locate and classify differences before acceptance. No claim of whole-frame exact parity.
- Plain depth32float instead of depth32float-stencil8 preserves all native pixels and draw/
  dispatch counts. FPS 47.99 to 51.72 to restored 57.21 cannot separate clock drift from
  benefit; rejected as unproven, no source change.
- Reversed terrain triangle order preserves every tested pixel at three orbit angles;
  same-page FPS 49.93 to 55.03 to restored 51.78 is about 8.2% over the bracketing mean.
  Static reversal could hurt the opposite camera view; no generic change accepted.
- Explicitly authored single-sided terrain/closed humanoid hardware culling preserves
  three above-ground orbit images. ABBA averages 40.20 to 45.59 FPS, about 13.4%.
  Existing materials are double-sided; changing their default would change underside
  behavior. No core or demo authoring change retained.
- Native final depth-copy/color-resolve fusion loses all ten GPU pairs: median 0.852
  to 1.180 ms. All HDR/depth samples match. Rejected without source or payload changes.
- Software one-pass depth/color resolve saves about 0.065-0.131 ms in controlled pairs
  with exact HDR/depth parity. Generic format semantics and code/size cost remain open;
  this limited fixture is not sufficient to accept a core change.
- Private opaque main-mesh depth prepass adds three draws, retaining all 4x samples
  and 13 dispatches. Six color/depth orbit comparisons are exact, but candidate FPS
  31.16/32.96 is below restored original 41.62. First original suffers transient 1-4 FPS
  and is invalid for comparison. Rejected without package changes. Initial automatic
  bind-group-layout reuse fails validation; explicit unchanged bindings repair it.
  Fixture: `test-results/afterlight-depth-prepass-ab.mjs` and JSON.

### ecs, fsm, tween, net

- Added clearly labeled demos under `examples/package-benchmarks/`, using the actual
  packages: component queries/integration, hierarchical state transitions/crossfades,
  eased/completed/reversed tracks, and synthetic packet loss/interpolation respectively.
- Bounded visible actor counts, Run/Pause, actual frame cadence and separate workload/
  render CPU measurements; net is a synthetic transport fixture, not a real network test.
- Optional GPU timing defaults off. Setup restores the temporary device-feature hook;
  unavailable devices and cleanup are covered by focused tests. No new dependencies.
- Native visual, cadence, complete-scene startup and timing overhead tests remain pending.

### gltf-pro

- Candidate uses existing authored double-sided and transform-sign uniforms to select
  none/back/front hardware culling. Shader and frontFace remain unchanged; beauty,
  gbuffer and ambient pipeline caches include the culling class.
- Nine focused existing/new checks pass. Candidate package delta: +50 raw/+30 gzip bytes.
  Thirty actual-package comparisons have exact HDR and depth parity across beauty,
  gbuffer and ambient passes, positive/mirrored transforms, double-sided materials,
  alpha MASK/BLEND, and 1x/4x samples. Four-sample dependent-read spans: median 0.590
  to 0.459 ms; 9 wins/1 tie, paired median speedup 14.3%. Single-sample medians tie
  at 0.197 ms; 4 wins/6 ties/no losses at 65.536-microsecond timer resolution.
  Fixture: `test-results/gltf-cull-hardware.mjs` and JSON. Final size acceptance remains open.

### net

- Traced all callers: public sample API, module consumer, package demo and existing tests.
  Replaced linear ordered-ring timestamp search with a lower-bound binary search and
  skipped unused acos/sin calls in the existing near-collinear quaternion branch.
  Input/output validation, normalization, Hermite arithmetic, prediction and storage unchanged.
- Exact original linear-search oracle checks wrapped buffers of capacities 2/3/7/32/257,
  irregular timestamps, before/after/exact packet times, short and large rotation steps,
  single-snapshot and clear behavior. Five package tests pass; ten combined with demo checks.
- `node scripts/benchmark-net.js test-results/net-baseline/index.js`: twenty warmed AB/BA
  CPU pairs per case on Node 24.15/Windows, exact output/checksum comparison. Median ms/frame:
  256 actors/32 slots/small rotation 0.114 -> 0.036; 1,024/32/small 0.414 -> 0.137;
  1,024/32/large 0.410 -> 0.154; 256/257/small 0.805 -> 0.041.
- First draft added 51 gzip bytes; simpler equivalent lower-bound selection reduces this
  to 22: 3,464 -> 3,559 raw and 1,288 -> 1,310 gzip. Faster CPU result is demonstrated;
  final size and native visible-demo acceptance remain pending. No mobile FPS claim.

- Portable final-source repetition: `node scripts/benchmark-net.js 5fc55a0` builds
  both versions with the installed Vite using an explicit Git commit, checks the
  actual candidate distribution is current and compares exact outputs/checksums.
  Only the nonexecuted region-path comment is normalized to the package build's
  header. The first guard correctly rejected a different header before this was
  normalized; no runtime mismatch was hidden.20 warmed counterbalanced pairs:
  256/32/small0.0689->0.0225ms,1024/32/small0.2860->0.1027ms,
  1024/32/large0.3337->0.1274ms,256/257/small0.7371->0.0389ms.
  Exact final package sizes remain3,464/1,288 versus3,480/1,287raw/gzip.

### clustered

- A zero-light early-return candidate did not demonstrate a useful GPU gain; removed.
- Test was golden hour with no contributing porch light; active multi-light workloads still pending.

### vfx

- Earlier billboard sin/cos removal reduced draw-pass cost but did not improve total FPS
  and altered tiny particle coverage; reverted. All original rotation and count behavior preserved.
- Particle Off does not explain the desktop slowdown or the reported Android 3 FPS.

### Final retained renderer comparison and size refresh — 2026-10-13 07:43 UTC

- Native headed Edge154, Intel Arc140V,1432x768,DPR capped1,4x scenes and all
  original desktop counts: live/candidate ABBA means48.08->57.76FPS with particles
  Off and36.96->42.42FPS at1M. All48 one-second observations were visible/focused.
  Candidate Off p95 spans17.7-25.5ms;1M spans26.0-33.5ms. Neither reaches the floor.
- Three matched paused scene views at0/90/180 degrees have zero changed pixels.
  This supersedes the earlier combined approximate-fog visual comparison; the
  approximation was removed. Default query resources remain0 in every run.
- Opt-in actual Core-created devices use one query set/two retained buffers and
  create no query/buffer resources during either8-second sample. Off GPU pass
  sum/span13.43/18.02ms;1M18.87/22.74ms.1M adds about2.49ms simulation and2.56ms draw.
- Saved live asset301,030raw/99,299gzip; pre-staging candidate303,091/100,023.
  +724gzip is still an unmet bundle acceptance requirement. Full-world fresh
  headed ready times1.45-2.68s also fail. Portable details and exact inputs:
  `docs/afterlight-native-performance-2026-10-13.md` when finalized by the GPU subtask;
  raw digest `test-results/afterlight-final-native-digest.json`.
- Final optional-package compactions: Shadows20,393->20,181raw and6,622->6,622gzip;
  Net3,464->3,480raw and1,288->1,287gzip; glTF-pro+25raw/+14gzip; BVH-89raw/-63gzip.
  The earlier draft byte figures above are historical, not the retained result.
- Core+Stage47,934raw/19,975gzip. Only supported timestamp negotiation and omission
  of redundant primitive defaults changed Core; no new MSAA routing/API was added.
- Full Scatter culling variant was reverted:30 exact GPU comparisons and faster
  single-sided fixtures did not offset default-path CPU overhead and447gzip bytes
  after normalized source-path comments. Original17 tests pass. Bloom constant
  weights were rejected for no consistent GPU gain and changed HDR samples.

### Complete-scene staging — Afterlight and Helmet

- Helmet now presents the complete existing6,179-triangle/512-map model first on
  desktop, then loads the original15,452-triangle/2048-map model. Full-quality
  final rendering and32-sample SSAO remain. Preview rendering precedes SSAO setup.
  A held full-detail request proves the complete first model exists independently;
  success/failure preserve camera and user AO choice. Local headless source
  principal opportunities498/638ms; hosted cold-load and physical mobile pending.
- Afterlight reuses the existing landscape-details module. Its first complete
  world has authored terrain and the same heightmap,12 settlement batches/all10
  trees,14 explorer parts/15 core geometry meshes, Sky/Bloom and full ocean optics,
  horizon/waves/spray. Dense grass/950 fieldstones/hidden wireframe, shadows,
  clustered porch light and the selected particle tier install after that world.
  All original final counts/resolutions/materials are retained. Heightmap reuse
  avoids resetting coastal simulation; default1M's132MB state is deferred.
- `node scripts/test-afterlight-streaming.js`:5 functional real-GPU scenarios pass,
  desktop defaults, control changes during delayed setup, Android layout on Intel,
  optional module failure and pagehide. Paused secondary rendering, current Off/
  wireframe/sun/wave choices, original counts and cleanup pass. Actual submission,
  queue completion and two presentation opportunities are correlated. Android
  layout is explicitly not a physical phone.
- Local headless source opportunities1,390/939/852/1,508/1,530ms: staging preserves
  the complete world but does not meet1000ms consistently.16 affected unit/module/
  readiness/lifecycle tests and Post/sandbox TypeScript checks pass. The first
  browser fixture used the repository root for an absolute /src entry; it was
  corrected to the actual sandbox Vite root before these valid results.

## Next measurements

### Additional measured candidates and coverage

- The private direct-1x final presentation prototype is rejected: virtual
  Core/Stage 20,005 gzip bytes breaches the gate, and native counterbalanced
  means 51.07->51.30 FPS do not demonstrate a material application gain. Its
  isolated terminal GPU saving was 0.262 ms, with tested images unchanged.
  Actual dependent HDR resolve spans are 0.524 ms before water and 1.114 ms
  at final HDR retirement. These synchronized spans cannot be added to assign
  the entire inter-pass gap. See the native evidence document for conditions.
- The unpublished Afterlight download-report controls were removed from the
  example HTML, CSS and entry point. CLI capture and regression tests remain;
  new whole-app size and native verification are pending.
- Meaningful demo coverage now reaches 46 of 61 npm packages. Kernel and shared
  remain explicit additional units in the 63-directory scope. Seven latest
  workloads passed 14 native/phone-layout cases and 56 measurement windows;
  native Navigation/Physics principal times 1,409/1,454 ms and phone-layout
  Physics 1,010 ms remain load misses. This is not physical Android proof.
- Exact-zero direct-shadow gating is now retained in optional Shadows. Controlled
  4x dependent spans at 0/25/75 percent lit are 2.490->0.983,
  2.490->1.049 and 2.556->2.097 ms, with all eight 1x/4x HDR fixtures exact.
  The fully lit shading median ties at this timer's resolution. The applied
  source grows 140 raw/37 gzip bytes; Core/Stage is unaffected. Native island
  ABBA means 51.52->48.81 FPS do not establish a gain amid substantial drift.
  A subsequent same-command-buffer replay of actual island geometry, with
  original intervening grass/rocks, saves a paired median 0.983 ms in 9 of 10
  pairs. Every HDR pixel and all four depth samples match bit for bit. This
  supports the captured geometry optimization, not a whole-app 60 FPS claim.
  The PCSS maximum is 16 blocker loads plus 32 comparison taps; the original
  no-blocker and cascade early exits mean this is not 48 comparisons per pixel.
- Omitting final HDR depth retirement is also unaccepted: full dependent span
  medians tie at 0.983 ms (4 wins, 4 losses, 2 ties), despite exact full HDR and
  four-sample depth output. No source change is retained from that candidate.

All seven production demo routes now record a correlated principal-world render
through the same readiness helper. `scripts/benchmark-demo-loads.js` requires that
principal presentation opportunity, rather than an early visible background or
DOM flag. The visible-frame fixture and held Afterlight module test separately
assert that an early canvas draw does not claim the complete subject. New Earth,
Meadow and Citadel markers are awaiting production browser validation; Citadel and
sandbox TypeScript checks pass. Staging and marker code is still local.

Continue desktop GPU attribution and preserve the 60 FPS target. Then work through
the remaining package workload inventory. Each new entry must record the actual test
command/fixture, input scale, hardware, before/after samples, quality/behavior check, byte
delta, accepted/rejected decision and remaining opportunities. Stop a package's tuning
only after its measured dominant cost and plausible further improvements are accounted for.

### Retained-build sampling ablation audit — 2026-10-13

- The existing ordinary cadence and separate pooled profile reports both finish
  all eight expected windows with zero reported errors. Immutable retained Site
  entry hash `e4ae61ab290913ab95d40dc0a9a8391a3d6af4696c6bbc0c070137d8bfb60484`.
  Temporary route override only: desktop workload, 1432x768, DPR1, actual device
  reboots, 4x/1x/1x/4x, Edge154/Intel xe-2lpg. Production quality/Core unchanged.
- Ordinary Off means 51.62->59.65 FPS are camera-confounded: B1 moves materially
  and B2 starts at another view. Reject causal attribution from that comparison.
  All 1M cameras match; means49.97->57.07 FPS still include large original-path
  drift55.48->44.46. A 1x1M one-second window remains46.68 FPS. No sustained floor.
- Every separate GPU-profile camera matches. Mean window-median full spans Off
  12.714->10.453 ms and1M16.777->11.534 ms. These are whole-path observations;
  unchanged particle compute speeds2.228/2.490->1.311 ms while particle draw
  worsens1.835/1.901->2.359 ms. Do not identify pure resolve/bandwidth cost from
  them. Latest profiled original4x Off also reaches about60 Hz. All profile
  windows reuse one query set/two2048-byte buffers with zero steady allocations.
- Actual1M indirect draw readbacks are[6,1000000,0,0,0] in all four windows;
  memory estimates227,381,264->91,009,040 texture bytes, not physical VRAM or
  measured bandwidth. No retired-device textures/buffers remain live in audit.
- Corrected ignored harness suppresses trusted camera/player input and checks
  camera identity at every one-second observation, start/end and across modes.
  It writes distinct fixed-camera reports and preserves original evidence.
  Preparation and syntax check pass; no browser/benchmark was run during audit.
  Later run: `node test-results/afterlight-retained-sampling-fixed-camera-ab.mjs cadence`.
  AA stills, longer stable runs, native cold load and physical Android remain.
- Current main4x PBR about3.37 ms;1x1M billboard draw2.36 ms. At this audit,
  conservative behind-eye vertex collapse and correctly clear-transferred
  opaque replay were unmeasured. The later measured VFX section records the
  modest guard win and unmet byte gate; opaque replay remains unmeasured.
  No changes retained from either.
  Exact tables, source hashes, population/resource evidence and limitations:
  `docs/afterlight-native-performance-2026-10-13.md`.

### Corrected fixed-camera sampling cadence — 2026-10-13 11:49 UTC

- All eight windows pass exact per-second/start/end/across-mode camera and orbit
  assertions. Counterbalanced means Off55.04->60.04 FPS,1M57.49->60.00 FPS at
  DPR1,1432x768. Four1x windows have p9517.2-17.5ms and no intervals above33.333ms;
  original4x windows retain tails34.4/56.0/35.0/34.4ms and condition drift.
- No default query resources, timed GPU allocations, reported errors or audited
  retired resources. Devices/contexts/browser/server close, exit0. This uses the
  unchanged immutable retained snapshot before the later reflection-startup fix.
  No additional fullprofile, permanent quality change or physical-phone claim.
- Report `test-results/afterlight-retained-sampling-fixed-camera-cadence.json`,
  SHA256 `3237a13e0c41884f91fde65219bda557d7b8ca1f07224e6e47ad3c5dcc19fdb1`.
  Near60Hz finite windows strengthen multisample-path evidence but do not prove
  long-duration floor, no AA-quality loss, one-second startup or bandwidth alone.

### Render/media factories and complete source coverage

- Animator, TAA, Text, Splats, Audio and Video now have actual labeled optional
  package factories in examples/package-benchmarks. A seventh Blender factory
  removes the file-picker-only default gap using the existing textured Python
  format fixture. Inventory now records 61/61 npm packages with meaningful local
  demo source and no required-user-asset default gap. This is source coverage,
  not 61 accepted speed/quality/load results; all package statuses remain Open.
- Native automation distinguishes actor anchors, owned transform capacity,
  rendered principal objects and the engine's actual visible counter. It awaits
  async font/model/video mounts and checks actual package counters and controls.
  Old marker factories retain their counts and defaults. Resource/cadence/initial
  image/readiness checks are queued on the sole GPU slot.
- Focused 17-check run passes with no skips: eight render/runtime/Blender checks,
  four media checks, three factory-ownership checks and two timing-statistics
  checks. TAA's first failure was a test alias (mount versus pass context);
  Blender's first failure was a missing mock command encoder for texture mips.
  Production package files were not modified. Test wall time is not load time.
- Audio remains silent until explicit Enable sound; generated media avoids any
  new dependency or licensed asset. Video covers generated MediaStream frame
  delivery/external textures, without a file-codec claim. Text's unit rasterizer
  and all mock GPU/audio/media boundaries are documented rather than counted as
  physical-device proof. Blender's tiny fixture is not a commercial scene test.
- Kernel/shared remain explicit internal units in the 63-directory scope. Actual
  transform/culling and readiness/target helpers execute in the harness; their
  independent existing tests and isolated-tuning gaps are documented. No new
  internal performance claim is made from preparing these factories.
- Details, exact commands and per-package limitations:
  [Render/media workload evidence](package-render-media-workloads-2026-10-13.md).

### Actual render/media acceptance and TAA interop failure

- Seven new factories completed14 actual native/layout cases and56 profiling
  OFF/ON/ON/OFF windows. All functional/counter/UI/media, nonblank image,
  rebuild/resize and terminal cleanup assertions pass with zero GPU/page errors.
  Strict local target passes9/fails5: native Animator1117.7ms, TAA1628.4ms,
  Splats1236.6ms principal startup; native Audio74.8ms and layout Blender25.1ms
  single long intervals. These are retained failures, not averaged away.
- TAA.add(robot) exposed a confirmed real interop bug:12 static PBR vertex buffers
  lacked STORAGE while TAA compute snapshots required it. glTF-pro now adds the
  flag to its existing central allocation, retaining VERTEX/COPY_DST and sharing,
  source bytes, sizes and shaders. No new buffers/API or Core/Stage/TAA feature.
  Prepared.margo and restored allocations use that same path; Animation outputs
  already carried the flag. Published glTF-pro entry adds23raw/13gzip bytes.
- Thirty focused checks pass; twelve actual 4x/1x integration cases pass mixed
  static/deformed/prepared sources and device reboot. Four original/fixed non-TAA
  canvas comparisons are bit-exact. All1556 owned buffers/textures destroy once,
  every device retires, and default profiling queries remain zero. Core/Stage
  gate rechecked47934raw/19975gzip. No tuning-session release was deployed.
- First pre-repair Animator run was near60Hz; later runs were near120Hz. This
  refresh/foreground/clock drift is recorded and is not a2x speedup claim from a
  usage flag. Native/layout means alone do not prove physical Android, hosted
  cold loads or complete package acceptance. Every package remains Open.
- Exact table, fixture scope, commands and tracked measurements are in
  [Render/media evidence](package-render-media-workloads-2026-10-13.md).

### Immediate use of the two version-1 optional effects

- All61 manifests accept their actual current workspace dependency/peer versions;
  DOF/Tonemap own version1.0 is not a Core1.0 gate. Packed Core0.1 strict consumer
  import/type checks pass. Existing valid WebGPU and capture requirements remain.
- Production assembly now includes /demos/dof/ and /demos/tonemap/ using actual dist
  packages. Catalog/site links expose them, while modular routes do not pretend
  to be complete standalone copyable HTML. Source/publication labels stay truthful.
- Six actual built cases pass native/layout controls, nonblank pixels, complete
  object counts, LUT load/reject/late-read Clear, resize and early-pagehide cleanup
  with zero GPU/page errors. All198 owned resources destroy once, all devices close,
  and default timing queries stay zero. A14/16 mobile DOF crop was corrected by
  responsive camera FOV without reducing geometry or changing desktop framing.
- Native principal times3064.6ms(DOF)/1157.1ms(Tonemap) still fail the one-second
  target; Intel phone-layout602.5/604.3ms is not physical-phone or cold-hosted proof.
  No costly effect was forced onto Afterlight, no engine version bumped, and no
  npm/site publication happened. Core/Stage gate remains19975gzip. Full details:
  [Immediate-use evidence](postfx-immediate-use-2026-10-13.md).

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

### Measured private VFX and DOF shader candidates — 2026-10-13

- VFX conservative behind-eye guard passes eleven native/synthetic HDR/depth cases and the actual one-million-particle compute/draw chain: all 16 million state words and 4,399,104 evolved HDR/depth samples are exact. Native chain paired span saving is only 0.1529 ms (7 wins / 3 losses), with draw saving 0.1092 ms. No whole-app 60 FPS claim follows. Hardware delta was measured despite the final byte gate failing.
- Guarded VFX is 4,777 gzip bytes versus current retained 4,659 (+118), or +35 net versus the earlier pre-single-buffer 4,742. It is unretained. Removing only the analytic-curl WGSL comment estimates 4,728 bytes (−14 versus pre-single-buffer, +69 versus retained); exact guard/hook/source reconstruction checks pass, but rebuild/GPU/consumer acceptance is pending. Do not double count broader comment-strip recovery.
- DOF exact far-load predicate gate passes all RGBA16F channels in six controlled cases and the complete 16-object authored demo. Authored bokeh paired saving is 0.4588 ms (9 wins / 1 tie), while fully-far regresses 0.1966 ms (3 wins / 7 losses). This selective result remains unretained; fully-far confirmation is prepared next. The candidate adds 11 package gzip bytes and has no consuming-app acceptance.
- DOF matched build control differs from current published bytes only in two generated region-comment paths; normalizing them reproduces the published SHA-256 exactly. Original reports are preserved. Actual functional demo presentation opportunity is 1733.6 ms, failing one second; this is not a cold-load or sustained-FPS result.
- All measured windows allocate zero tracked GPU resources and report no GPU/page errors. Sessions 26984/60007/22017/95151 completed and closed before slot release. Detailed scope, numbers, limitations and private artifact names are in docs/vfx-performance-2026-10-13.md and docs/dof-performance-2026-10-13.md. No production shader/Core/default-quality edits were made by these experiments.

## Prepared asset/effect tracing and private Animation reuse gate

The remaining nine factories (Loaders, Exporters, USDZ-export, Decoders, IFC, FBX,
Points, Toon and Transitions) now have exact fixture/operation assertions. Draco
checks actual named workers, delivered jobs and once-only termination. The
traced native/layout batch is in progress; no acceptance is asserted before its
report finishes. Optional tracing records bounded startup resources and actual
GPU API calls/submits, long tasks and neighboring native frame rows around misses.
Tracing is off by default and introduces no GPU queries; traced speed evidence
requires an untraced comparison. Preparation/limits are in
[the asset/effect log](package-asset-effect-workloads-2026-10-13.md).

The private Animation output-cache candidate passed seven initial focused exact
correctness/metrics checks. Real Core transform setters preserve Float32 samples,
quaternion normalization/Euler values, all three interpolation modes, looping,
morphs and mutated-track error outcomes. A reused plain number[4] preserves Core's
existing normalization behavior; a Float32 quaternion replacement was excluded.
Over 128 frames the candidate removes 512 typed outputs/128 rotation copies for
one model, or 8,192/2,048 for sixteen models. Existing Core allocations remain.

The bounded CPU ABBA/BAAB medians improve 3.25x (one model) and 2.59x (sixteen).
Actual write:false package builds change 13,376 to 13,776 raw bytes and 4,838 to
4,987 gzip bytes (+400/+149). This is CPU-only seek sampling, not GPU, FPS or
startup proof. The candidate remains private and no production source was adopted.
Evidence is test-results/animation-output-private-candidate.json. A separate
arithmetic-only candidate keeps existing fresh-output/call-site contracts and is
prepared for exact/size/speed checks after the browser batch; it is not yet run.

Inventory routing for DOF/Tonemap now reflects actual built /demos/dof/ and
/demos/tonemap/ routes, current Core 0.1 packed-consumer proof and the measured
native cold-load failures. Mapping/build proof remains separate from live release
or npm publication. All 61 npm packages retain meaningful source demo coverage
and every optimization status remains open.



## Completed asset/effect native/layout diagnostic batch

All nine remaining factories completed 18 real browser cases and 72 timing
windows. Actual output/operation metadata, visuals, controls, pause, rebuild,
resize and teardown passed with zero GPU/page errors; Draco's 18 total workers
retired exactly once and every device/context/browser/server closed. Sixteen
strict local targets failed and remain failures. Full measurements and scope
are in [the asset/effect evidence](package-asset-effect-workloads-2026-10-13.md).

Traces identify synchronous four-format export and USDZ work preceding repeated
24–75 ms gaps. Initial IFC/FBX imports and one Points asset fetch are dominated
by local development-server TTFB; those require a built-artifact comparison before
production attribution. Isolated short-CPU gaps remain unresolved. Tracing adds
overhead and does not provide cold-hosted or physical-phone acceptance.

The separate arithmetic-only Animation candidate also passes the expanded seven
focused exact/metrics tests. Real-Core CPU medians improve 1.18x (one model) and
1.43x (sixteen), while outputs/rotation-copy allocations remain unchanged. The
actual entry grows 57 raw/22 gzip bytes (4,838 to 4,860 gzip), so it remains
private pending a size-neutral alternative. Evidence is
test-results/animation-arithmetic-private-candidate.json; no production
Animation/Core change has been retained from either private candidate.

### Queued narrow confirmation and caller diagnostics — preparation only

- DOF fully-far confirmation removes output-allocation placement as a timing confound with one shared timed output, three ten-pair batches and separate full-channel equality first. An outer-loop alternative retains the exact original far loop and near/disk arithmetic; +550 raw/+20 shader gzip is unaccepted until hardware and byte evidence justify it. No new GPU run.
- Afterlight caller cap60 and timestamp-capability ABBA runners are prepared on the immutable fixed-camera/full-quality snapshot. Installed Chrome is the default; browser/channel are recorded. Cap delegates every actual render to original Engine.frame, preserves original wall-time delta and all callbacks, and measures independent native RAF separately from real app/render/Stats counters. Capability filtering removes only timestamp-query and remains a separate unmeasured hypothesis.
- Four lightweight fixture contract checks pass, covering cap/uncapped callback/render/delta counts, cancel/idempotent resume/restoration and feature-descriptor preservation. Fake contracts are not native browser/GPU/visibility proof. Actual pause/hidden-visible lifecycle, zero timed GPU allocations and exact camera are runtime assertions for the queued runs. No permanent cap, Core/default feature change, 60 FPS or load claim.
- Preparation, prioritized commands, source hashes and unmet acceptance criteria are in docs/dof-performance-2026-10-13.md and docs/afterlight-cadence-diagnostics-2026-10-13.md. Startup_review retains the exclusive CPU/GPU-heavy slot while this light preparation is performed.

- Pre-execution sibling review caught and repaired a private caller-fixture gap: the immutable consumer compacts Engine fields to m/g/h/i. The runner now derives them from the hash-verified artifact; all four contract checks pass against its actual compiled RAF/callback method bytes with fake scheduling/rendering. This was found before GPU use. Duplicate manual device.destroy after Core-owned reboot/disposal was also removed; the queued runner audits exactly-one device retirement and skips already-retired devices during cleanup. Ordered init wrapper installation is explicit. These are fixture repairs, not product performance changes.

## Current full correctness and build checkpoint

`npm run test:all` completed with exit 0 on 2026-10-13: 803 tests passed,
zero failed/cancelled/skipped/todo. The current package build and catalog browser
search/copy/link tests are included; the DOF/Tonemap current-version routes are
covered. The executed suite also includes the private Animation numerical/error
and mutation tests, without adopting its size-increasing candidates.

The test body took 50,624.6 ms after builds. Complete output is preserved in
`test-results/test-all-20261013-current.log`. Correctness/build success does not
establish steady 60 FPS, one-second principal loading, physical Android, a hosted
release or total-consumer size acceptance. All optimization statuses remain open.

## Retained USDZ CRC CPU improvement and emitted-entry proof

The exact branchless CRC32 substitution is retained in optional Exporters source.
Two isolated actual knight serializer runs improved export medians 39.2248 to
28.2846 ms (1.3868x) and 33.6397 to 26.5024 ms (1.2693x). CRC-only medians
improved 2.12x in both. Complete archives and actual loader output remain exact;
the second run passes 18 checks including independent Python ZIP/zlib CRC,
stored-member and 64-byte-alignment verification. Focused USDZ tests pass 5/5
before and after adoption. The measured full exporter bundle stays at 9,311 gzip
bytes; USDZ-export with its serializer bundled shrinks 4,892 to 4,891. Both raw
bundles shrink three bytes.

The targeted existing Exporter and USDZ-export production build configurations
and declaration emits completed with exit 0 at 16:38:22 UTC on 2026-10-13.
Emitted USDZ arithmetic was read back, and BOTH actual built package entry points
returned the exact Git `5fc55a0` baseline's 1,270-byte archive with fresh buffers.
Independent Python ZIP checks passed for both emitted outputs. Core and stage
emitted entry hashes stayed unchanged; this build did not touch their source.

Full executed output and current source/entry/declaration hashes are preserved in
`test-results/usdz-production-build-verification-20261013.log` and
`test-results/usdz-production-build-verification.json`. Both private CPU run
outputs and detailed scope are linked from
[the USDZ evidence](usdz-performance-2026-10-13.md). Local source/build/output
proof is complete for this retained CPU fix. Browser startup/frame-tail failures,
physical-phone acceptance and publication remain open; CPU timing does not
establish those claims. No subsequent heavy workload was started in this slot.

## Procedural fixed-axis Perlin candidate — rejected, 2026-10-13

Exact noise and complete terrain/heightmap parity passed. Actual height sampling
improved 101.517 to 84.681 ms, but full landscape construction did not improve
(253.030 to 255.980 ms median across 24 measurements per path). The candidate
also adds nine gzip bytes. Production source stays unchanged; no startup or GPU
gain is claimed. Raw measurements and acceptance decision are recorded in
[the Procedural experiment log](procedural-perlin-performance-2026-10-13.md).

## Minimal Animation arithmetic candidate — rejected, 2026-10-13

The four focused exact tests pass with the minimal variant included: Float32
samples/errors/fresh public outputs and actual Core transforms/quaternion
normalization/Euler/looping/morph/mutation outcomes remain unchanged. Existing
typed-output and rotation-copy allocations remain. This candidate keeps original
Math.hypot spread normalization, precomputed sample offsets and the native finite
predicate. The sole bounded actual seek CPU run improves 1.43938x for one model
(0.01430008 to 0.00993488 ms/model update) and 1.03107x for sixteen
(0.00831161 to 0.00806112). The larger-model result is small and is not app FPS,
GPU or startup evidence.

Actual write:false package bytes grow 13,376 to 13,378 raw (+2), 4,838 to
4,845 gzip (+7). The no-byte-growth gate fails, so this candidate remains private
and production Animation/Core source stays unchanged. Complete outputs, timings,
source/bundle hashes and the decision are linked from
[the minimal Animation evidence](animation-minimal-performance-2026-10-13.md).
The exclusive CPU slot was released immediately after this single candidate.

## Pinned live particle isolation — diagnostic completed, 2026-10-13

Four fresh Chrome 155.0.8059.40 contexts used the same old-live phone scene,
1432×768/DPR1/1×, fixed camera/solar time and unchanged actual 1M allocation and
authored settings, with profiling off. Full / compute-only / frozen draw-only /
both-off measured 43.6972 / 54.0826 / 49.5573 / 65.1069 real render-submit Hz.
Their gap p95 values were 28.7 / 25.6 / 26.5 / 18.4 ms. Every counted frame had
one successful native submit; no timed GPU resource/pipeline/shader creations
or GPU/page errors occurred. Fully initialized indirect1M was verified outside
each window, and frozen modes preserved indirect/front/time/remainder exactly.
All four devices/resources retired and the runner exited0 with exact owned
processes absent. This is old-live ping-pong VFX evidence, separate from the
newer 64MB single-state source trial. Particle simulation and drawing both
materially affect this workload; no physical phone, strict frame floor or
locked60 claim follows. Full tails, scope and raw hashes are recorded in
[the particle isolation evidence](afterlight-particle-isolation-2026-10-13.md).

## Matched desktop source phone-values trial — completed, 2026-10-13

Chrome155.0.8059.40 desktop-UA A/B/B/A, fresh contexts/10s, default queries0,
fixed1432×768/DPR1/1× and unchanged full1M/64MBsingle-state VFX measured
52.3977 /63.4791 /57.9756 /52.6997 real render-submit Hz. Candidate runtime
verified terrain96/heightmap128/grass25k/shadow512/water64. Its p95 gaps21.0
and24.8ms improved on baseline26.0/25.8ms but do not establish locked60.
All geometry/camera/capacity/real-submit/noallocation checks passed; principal
readiness and complete detail were verified before timing. Four exact device
retirements, zero live tracked GPU resources, no errors and runnerexit0; owned
processes and server absent. This current-source build dimension is separate
from old-live ping-pong VFX. Readiness, full conditions/raw hashes and scope are
recorded in [the source trial evidence](afterlight-desktop-phone-source-trial-2026-10-13.md).

## Geometry numeric normal loop — rejected, 2026-10-13

Private exact-output fixtures passed for96/192 fields, complete heightmap/stream,
procedural meshes, degenerate/repeated/out-of-range inputs and existing alias/
error contracts. One finite counterbalanced CPU run saves0.5944ms median on the
current96field/128map (36.8317→36.2373ms); original192field/256map saves11.6734ms.
Actual virtual full Geometry gzip grows16147→16169 (+22), whole current consumer
102365→102370 (+5), so the no-growth gate fails and source remains unchanged.
Screen-saver/externalGPU and uncontrolled CPU thermal/clocks/power conditions
are recorded; no startup/FPS/GPU-completion gain is claimed. See
[the Geometry experiment and decision](geometry-normal-loop-performance-2026-10-13.md).

The one smaller Geometry modulo-index follow-up also passed exact41cases but
failed actual virtual byte gates: full Geometry+15raw/+3gzip and whole current
consumer+7raw/+4gzip. It stopped before any warmup/timing benchmark, preserving
the earlier rejected ternary evidence. No performance claim or source change
follows; the CPU/build slot was released after exit0. The follow-up report and
private executed-source copies are linked from the same Geometry decision log.

## VFX circular billboard trial — rejected, 2026-10-13

Removing only vertex rotation saved 36 gzip package bytes but changed 9,514
native 4× HDR samples in the first 1M island view. Depth matched; the quality
gate failed before timing. Production source/distributions remain unchanged.
Exact cleanup, raw report hashes and the screen-saver/presentation limitation
are recorded in [the VFX evidence](vfx-performance-2026-10-13.md).

## VFX unchanged-color traffic trial — correctness partial, 2026-10-13

Three private storage-assignment changes preserve simulation expressions,
256-thread workgroups, existing atomic algorithm, 64-byte state and billboards.
Virtual optional-package bytes increase by 22 gzip. Native headless no-birth
A/B36/36 and original A/A18/18 match exact state words, sets and counts;
single-particle accepted births match. Larger respawn and actual draw-order
parity remain unresolved. No image or speed test has passed and no source or
distribution change was adopted. Complete conditions, hashes, exact cleanup
and unresolved comparisons are in
[the field-write correctness evidence](vfx-field-write-correctness-2026-10-13.md).

## VFX circular billboard HDR diagnostic — rejection confirmed, 2026-10-13

A separate native headless diagnostic preserved the original failed strict
report (9,514 differing samples) and continued all3 native yaw/8 synthetic
cases with identical original A/A controls. The fresh native yaw0 state has
9,661 HDR differences: decoded maximum channel error4.569336 linear HDR units,
mean error among changed channels0.0835834, and625 lost/639 gained
background-relative contribution samples. Other native maxima are4.346199
and2.710236. The tiny whole-frame mean does not establish harmless rounding.
Original A/A and all candidate depth samples match exactly across11 cases;
candidate strict HDR still fails all11. Synthetic maximum errors are
0.00390625–0.0078125, with45 lost/7 gained contribution samples at4× orthographic.
No visibility threshold was invented and no performance test ran.

Intel/nonfallback identity,1432×768/native HDR4/1M invariants, zero timing queries,
all sparse difference words, once-only device retirement and seven absent
exact owned PIDs are retained in
`test-results/vfx-circle-metrics-diagnostic-metrics-v1.json` and its immutable
summary. Circular rotation removal remains rejected despite its byte saving;
production source/distributions are unchanged. Full conditions and results are
in [the HDR metrics evidence](vfx-circle-rotation-hdr-metrics-2026-10-13.md) and
[the VFX performance record](vfx-performance-2026-10-13.md).


## VFX field-write comment recovery — gzip passes, quality partial, 2026-10-13

One separate private variant removes only the existing analytic-curl WGSL
comment, preserving its newline and every field-write math token. Three static
checks prove reverse source reconstruction, billboard/64-byte ABI/atomic
identity and rejection of unexpected comment changes. Actual matched
`write:false` builds measure VFX **4,659→4,632 gzip (−27)** and the whole
current consumer **102,365→102,347 (−18)**; both raw totals increase92 bytes.
All inventoried production source/public distribution bytes remain unchanged.

Native headless Intel/nonfallback correctness matches all36 no-birth A/B and18
original A/A state/set/count comparisons; capacity1 accepted births match.
Actual alive order still varies. Multi-birth state/selection differs, including
capacity63 with546 differing words in each of3 A/B comparisons despite zero
differences in both A/A controls. Larger baseline variability does not establish
equivalence. Image parity, native traffic and speed remain unmeasured; no
adoption or performance acceptance. Zero RAF/render/query calls, one device
retired once, zero live buffers and all7 exact owned PIDs absent.

Detailed counts, hashes, immutable raw and complete logs are in
[the field-write correctness evidence](vfx-field-write-correctness-2026-10-13.md).

## VFX live-only field-store follow-up — consumer size failure, 2026-10-13

One private born-flag variant restores both original whole-record birth stores
and the local color assignment, using partial stores only for an already-live
particle. The one analytic-curl runtime comment is removed with its newline
preserved. Three static reconstruction/math/ABI/billboard guards pass.
Actual `write:false` VFX gzip **4,659→4,657 (−2)**, but all whole-current-app
JavaScript chunks total **102,365→102,367 (+2)**; raw rises95 bytes in both.
The consumer size gate fails, so no native correctness/respawn or timing ran.
All protected source/distribution hashes are unchanged; previous variants and
raw evidence remain immutable. No adoption or scheduling-quality claim.

See [the separate failed-size evidence](vfx-field-write-correctness-2026-10-13.md)
and `test-results/vfx-live-field-write-size-v1/report.json`.

## VFX immutable birth predicate — final private quality follow-up, 2026-10-13

Reusing the original expired-life predicate once as immutable `born` preserves
both original whole-record birth stores/local color and partial writes only
for already-live particles. Three static math/reversal/ABI/billboard guards pass.
Actual `write:false` package gzip **4,659→4,651 (−8)**; whole-current-consumer
gzip **102,365→102,358 (−7)**, raw+84 in both, protected source/dist unchanged.

Native headless Intel/nonfallback no-birth36/36 A/B and18/18 A/A state/set/count
match. Birth capacities1 and63 each match3/3 A/B plus2/2 A/A exact state and
actual order. Larger births/actual live order still vary with original A/A
variability; this is no blanket quality pass or asserted deterministic contract.
Image parity, actual generated traffic and speed remain unmeasured; no adoption.
Zero RAF/render/query, one device once/0 live buffers, all8 owned PIDs absent.
Branch closed after this final variant pending awake hardware and separate grant.

Complete table/hash/raw/frozen proof is in
[field-write correctness evidence](vfx-field-write-correctness-2026-10-13.md) and
`test-results/vfx-compaction-headless-live-predicate-v1/summary.json`.

## Current source full regression and Core/stage gate — 2026-10-13

`npm run test:all` rebuilt package distributions and passed **807/807 tests**, zero failures/skips/cancellations (test phase 37,967.3582 ms; execution session70686 exit0). `npm run measure:size` then passed: Core/stage **19,975 gzip bytes**, strictly below20,000; raw47,934. Current source/dist hashes and actual command/count limitations are in `test-results/full-regression-current-source-20261013.json`; size stdout is `test-results/core-stage-size-regression-20261013.stdout.txt`. Full test stdout is in tool history, not a complete saved file. These checks do not establish foreground/mobile FPS, <=1000ms principal visibility or hosted publication. Native preflights still report Screen-saver; positive performance windows remain pending. CAD worker URL build warnings are being inspected separately.

## Native foreground calibration consolidated — 2026-10-13

The short scene A/B, 60-second sampling runner and browser trace runner now require the Windows Default input desktop and exact owned Chrome foreground before and after timing, plus a bounded 250-ms native observer throughout each window. Saved Screen-saver/PID0 negative preflights reject before their performance browser launches; no FPS or GPU timing is inferred from them. Raw reports, errors, cleanup and SHA256 references are consolidated in `test-results/native-calibration-consolidation-20261013.json`. The latest read-only check at 20:29:39.738UTC still reported Screen-saver/PID0. No desktop switch, input injection, screensaver termination, display refresh change or elevation retry was performed. Positive compositor-density A/B and sustained-frame acceptance remain pending an awake laptop.

## Desktop detail restored after trial — 2026-10-13

The five-value mobile-settings source trial did not pass sustained60FPS, one-second principal visibility or desktop quality acceptance. All three pre-trial source files were restored with the existing all-files SHA-guarded restore, preserving earlier package/startup fixes. Desktop authored terrain/heightmap resolution, grass count, shadow resolution and water segments are again the pre-trial values. The immutable desktop/phone trial builds and every measured raw result remain available. Read-back hashes and decision: `test-results/desktop-phone-source-trial-restoration-20261013.json`. No deployment or new performance claim. The earlier807-test snapshot included the provisional values; the restored source requires its own targeted app checks.

## Machinery CAD actual browser functionality — 2026-10-13

The existing `scripts/modern-machinery-runtime-tests.js` passed **19 functionality
checks**, exit0, on installed headless **Chrome155.0.8059.40**, Intel Arc140V /
WebGPU Intel xe-2lpg, nonfallback. Original assertions are unchanged; a private
preload records browser identity, asset responses and bounded close only.
STL/OBJ/STEP/IGES import, unit conversion, detached transferred buffers, monotonic
progress, shared geometry, 100,000-triangle streaming, cancellation/error/capacity
rollback, surface transport, telemetry, BVH picking/snapping/clearance and
annotations pass. Production OBJ/STEP/IGES asset routes and all four formats in
the production Vite starter file picker pass, including malformed input feedback.
All observed worker/OCCT JS/WASM responses are200. The package build's preliminary
`?no-inline` warnings do not indicate missing runtime assets in these paths.

Complete stdout, unchanged test/helper copies and hashes, original report and
cleanup evidence are preserved under
`test-results/machinery-functionality-chrome-owned-20261013T203318864Z/`.
Original report SHA256: `2dcfd0e112b2582ff47b1154fb229538af4e37c4a853a400d0156af896ae1d03`.
Browser.close returned normally; seven exact owned CDP PIDs are absent in native
Get-Process by ID/name and tasklist; exact-profile query and preview listeners
are empty. No process termination was needed. Prior bundled-browser fallback
and private CDP automation-flag failures are retained separately as launch/audit
failures, not package failures. One console404 without captured resource URL is
retained; original page-error assertions pass. Screen-saver was active and this
is headless functionality evidence only: no foreground FPS, load-time, physical
presentation or hosted CAD execution claim. No Core/Stage or production source
changes. CPU/GPU slot released after native absence verification.

Restored desktop source validation: island app10/10 targeted tests passed (no skips/failures), TypeScript and Vite production build passed. Source hashes match every pre-trial original; Core/Stage hashes remain unchanged from the19975-byte full-regression snapshot. Asset hashes and actual raw/gzip sizes are in `test-results/desktop-phone-source-restored-app-checks-20261013.json`. This is build/functionality evidence only, not a fresh FPS, physical-mobile or cold-load result.

## Goal blocked audit — awake hardware required, 2026-10-13

The previous goal turn made concrete progress: CAD19 runtime checks passed and desktop detail was restored/read-back verified, followed by10 passing island tests and production build. This turn revalidated Windows input desktop at20:36:02.888UTC: still Screen-saver/PID0. The same calibration blocker has persisted across three consecutive goal turns. Queued offline checks are complete, agents are terminal and owned test processes were retired; no live job is being awaited. Foreground scaling A/B, sustained frame tails, complete-scene startup acceptance and physical-mobile validation require external hardware readiness. Goal is blocked with its full61-package60FPS/1000ms/quality scope intact, not achieved or paused. Audit: `test-results/goal-blocked-native-calibration-audit-20261013.json`. No deployment or screensaver/display mutation.

## Awake compositor density ABBA — 2026-10-13

With the engine fixed at1432x768/DPR1/1x, full1M particles and authored phone scene, browser density2/1/1/2 measured **44.709 / 48.173 / 47.972 / 44.688Hz**. All4 native foreground observers pass, resources retire and exact owned PIDs are absent. Original execution exited1 at the last parity check solely because Chrome reordered its advertised-feature set; raw report is preserved. Corrected set-membership comparison passes all4 windows offline, with7/7 contract tests. Pooled browser2x **44.698Hz** vs1x **48.073Hz**, observed **7.55%** / **1.570ms** average cadence difference. This is application render/submit cadence, not isolated compositor GPU time or physical presentation. Every window has slow-frame tails; no sustained60 or startup acceptance and no quality-policy adoption. Full evidence/tails/guards/raw hashes: `test-results/afterlight-density-awake-v2-posthoc-verified.json`.

## Awake browser trace and pending ETW save — 2026-10-13

The successful native-foreground browser trace contains 99,340,721 bytes and
326 traced real renders at about 40.6 Hz. An existing elevated WPR recording
was already active, so these browser controls do not establish an OS-untraced
baseline or isolated tracing overhead. See the
[awake trace analysis](afterlight-awake-existing-etw-trace-analysis-2026-10-13.md)
for exact-ID host transport, Present wrapper and CPU evidence and unresolved links.

At the root task's progress update, recovery child PID 49052, launched at
22:50:51 UTC, was STILL saving that same trace after the recovery worker's
180-second observation timeout. The approximately 1 MB output ETL is provisional;
recovery completion, final ETL validity and native GPU analysis are not proven.
This is a pending save, not a completed recovery. No production deployment or
sustained 60 FPS proof resulted.

The VFX triangle-strip proposal was closed after read-only inspection. Both
pinned old live and current VFX already use six reused indices over four unique
billboard corners. Six indices do not prove six vertex-shader executions;
the hypothetical 2M invocation saving is unsupported. No strip candidate,
build, GPU comparison or production change was adopted.

## Scatter wind-view cache — rejected by size gate, 2026-10-13

One private candidate retained the four-float wind/time view used by lit LOD
Scatter rather than calling subarray(68,72) on every material pack. Actual
class checks reused optionalGPU and the existing mutable-binding/restoration
contracts: every captured upload byte, draw/pipeline/binding descriptor,
shader hash and validation outcome matched; wind/material/camera changes,
failed-group retry and once-only resource retirement were covered. Baseline
created 18 views during material-pack attempts plus 1 on a restored draw;
candidate created 1 constructor view and 0 per draw/restoration. This source
allocation proof is not a measured CPU or frame-rate gain.

Actual matched write:false Scatter package bytes: **34,179/9,915 →
34,210/9,924 raw/gzip (+31/+9)**. Whole current consumer, all emitted JavaScript
chunks: **306,191/102,470 → 306,218/102,480 (+27/+10)**. Both gzip gates fail,
so the sole candidate is rejected without adoption or further variants.
Protected production source/public distribution hashes remain unchanged.
No timing benchmark, browser, native call or GPU execution ran.

Immutable final report/summary and frozen helper:
`test-results/scatter-wind-view-cache-v2/`; complete stdout uses the same
prefix. The initial v1 fixture-only retirement assertion omitted texture
tracking and stopped before complete comparisons; its failed raw/stdout are
preserved. Correcting fixture tracking produced the final exact result for
the same source candidate. No production change or recovery-status inference.

## Quiet minute after terminal Windows save - 2026-10-13

The exact WPR stop process49052 (creation22:50:51.0963069UTC) became terminal at the retained-handle observation23:16:09.4968097UTC. Its exit code/time could not be recovered from that external-process wrapper and remain unknown; the earlier180-second timeout report is unchanged. Final file size is96,254,033,920bytes, stable last-write23:16:08.6370929UTC. File existence/size do not yet prove successful decoding or complete event coverage. The intermediate elevated status attempt returned duplicate control-library error0xc5580601 and is not absence proof. A separate elevated inspect-only run at23:18:05-07UTC returned NOT RECORDING, exit0/drained, all three status commands, no errors. Its raw journal is test-results/wpr-inspect-after-save-20261013T231800115Z/recovery-status.json.

The fresh6/60/6-second profiling-off desktop1x/full1M run completed exit0, errors/cleanup empty:41.098/38.283/41.241Hz. Quiet p99 gap37.3ms, max72.1ms;232 periodic native observations prove sampled owned foreground/AC/saver-off coverage under the guard. Fixed1432x768 engine backing, browserDPR2, desktop grass110k/terrain192/shadow1024/water256 retained. No timed query/buffer/pipeline/shader allocations, no long tasks, no GPU/page errors. Actual application cadence still fails sustained60; these are not physical-presentation or GPU-execution durations. Short controls overweight a repeatable restart transient, so their rates cannot be subtracted as causal tracing overhead. Exact full evidence and observer limitations: docs/afterlight-quiet-minute-2026-10-13.md. Post-shutdown owned profile process check is empty. No deployment or production/package change from this run.
