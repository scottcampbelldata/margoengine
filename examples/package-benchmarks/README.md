# Package workloads

These are local, clearly labeled package benchmarks. They exercise real package
APIs and display the resulting actors through the same EngineKernel and Stats
harness. They start paused; use the keyboard-accessible **Run / Pause** button.
The target is 60 FPS, or 16.67 ms per complete frame. No measured result is supplied
until the workload runs.

Build the packages with `npm run build:packages`, then run
`npx vite --host 127.0.0.1`. Open one of these paths:

- [ECS](./index.html?package=ecs): 10,000 entities by default. Intersect packed
  position/velocity components and integrate every matching entity each frame.
- [FSM](./index.html?package=fsm): 1,000 hierarchical state machines. Each updates
  a parent/child path and processes staggered events, with visible state changes
  and 0.2-second cross-fades.
- [Tween](./index.html?package=tween): 1,000 eased tracks. Staggered completion
  callbacks reverse each track continuously; callback-driven track creation is
  included in the workload measurement.
- [Net](./index.html?package=net): 256 remote actors. Simulated 20 Hz packets feed
  32-slot snapshot rings; each frame samples Hermite positions and quaternion
  rotations with a 100 ms playback delay. Periodic packet losses exercise capped
  prediction. This page sends no network packets.
- [BVH](./index.html?package=bvh): deform and refit a 20,000-triangle heightfield,
  then cast 256 rays per frame and query a moving broad-phase region with
  `shapecast`. Green and amber markers show actual hits; red markers show misses.
  Its counters separate build, refit, raycast and shapecast CPU work.
- [Splines](./index.html?package=splines): 384 rendered samples by default: 48
  fixed path markers and 336 followers. Real Catmull-Rom, Bezier and Hermite
  curves drive positions and headings through parameter/tangent and cached
  arc-length queries. The initial arc-cache setup CPU is recorded separately.
- [Navmesh](./index.html?package=navmesh): 96 actors by default: 32 walkable-polygon
  markers and 64 agents. Real A*/funnel paths route around a blocked center;
  simultaneous ORCA velocities use nearby agents, and a caller boundary guard
  rejects steps outside the walkable mesh. Purple marks polygons, amber marks
  changed velocities and red marks rejected steps. Package ORCA does not supply
  static-wall constraints; the demo does not claim agent-radius wall clearance.
- [WFC](./index.html?package=wfc): 64 generated cells by default. Seeded weighted
  WFC enforces reciprocal height-level adjacency and pinned opposite corners.
  Run changes the seed once per simulation second; solve/validation CPU and
  startup setup CPU are recorded separately. Frames between solves render the
  existing solution. Larger presets expose synchronous generation stalls; this
  is bounded propagation/restart generation, not an exhaustive backtracking solver.
- [Navigation](./index.html?package=navigation): actual Recast voxelization and
  Detour path queries around a missing central floor. The default is 72 input
  floor markers plus 56 agents; it provides paths without crowd avoidance.
  Optional Wasm initialization/build elapsed is included in readiness and
  separated from synchronous query CPU. Native baseline averaged 120 callbacks/s;
  its 1,409 ms initial principal opportunity missed the startup deadline.
- [Physics](./index.html?package=physics): 64 rotation-locked Rapier cubes and
  16 real downward ray-hit markers by default. The Margo Physics package performs
  fixed steps, contacts, impulses and scene queries. Initialization elapsed is
  separated from simulation/query CPU. Native baseline averaged 120 callbacks/s;
  its 1,454 ms initial principal opportunity missed the startup deadline.
- [Road](./index.html?package=road): actual spline road sweeps with 16 segments
  by default. Its 136 markers show eight unique cross-section corners per row;
  generated normals, UVs and triangle counts are separate. This is a vertex view
  rather than a filled road rendering. Native baseline averaged 119.6 callbacks/s;
  its initial principal opportunity was 389 ms.
- [Gizmo](./index.html?package=gizmo): 16 selectable cubes and the real transform
  overlay. Drag handles to translate/rotate/scale, change world/local space or
  reset the attached pose. Snap steps are 0.25 units, 15 degrees and 0.25 scale.
- [Inspector](./index.html?package=inspector): 16 selectable cubes in the actual
  hierarchy/property editor, with independent materials. WebGPU renders AABB
  bounds by default; its own controls also enable wireframes or vertex normals.
  Effect fields remain disabled because this scene has no attached effects.
- [Labels](./index.html?package=labels): 16 mesh-following, clickable 2D labels
  with depth sorting, plus one actual CSS3D selection card. Toggle a label or
  remove/re-add the first using the package's ownership API.
- [HTML](./index.html?package=html): 16 cubes with 32 actual anchors. Clickable
  labels sit above each cube; inside anchors use asynchronous rendered-depth
  occlusion on WebGPU. Move those anchors above/inside to compare visibility.
  Startup and paused toggles use one completion wait and two bounded preview
  frames to display the asynchronous result; this is outside FPS measurement.
  WebGL provides projection without inventing rendered-depth support.

The seven runtime/UI cases have [local native and Intel phone-layout evidence](../../docs/package-ui-runtime-workloads-2026-10-13.md).
Those short runs do not establish physical-mobile or cold-hosted acceptance.

- [Loaders](./index.html?package=loaders): real PLY dolphins from the existing
  fixture. Fetch limits, parsing, normal/geometry construction and visible
  surfaces use the actual package. Run repeats a bounded parse batch each second.
- [Exporters](./index.html?package=exporters): the fixture knight is written to
  GLB, binary PLY, STL and OBJ/MTL; displayed surfaces come from parsing the PLY
  output. Writer CPU, reimport CPU and output sizes are separately reported.
- [USDZ-export](./index.html?package=usdz-export): the same fixture knight uses
  the actual standalone aligned-USDZ serializer and is parsed back for display.
  This covers static untextured export, with no Apple Quick Look claim.
- [Decoders](./index.html?package=decoders): actual Draco Avocado geometry from
  the package fixture, decoded through a two-worker pool with accessor checks.
  The surface uses transferred geometry, without source textures or KTX2 coverage.
- [IFC](./index.html?package=ifc): the actual IFC4 wall fixture goes through
  initialized web-ifc and Margo's tessellator, retaining meter geometry and BIM
  identifiers. Source wall dimensions remain recorded before display normalization.
- [FBX](./index.html?package=fbx): the existing ASCII triangle fixture goes
  through actual FBX→GLB conversion. Its converted geometry is displayed;
  this tiny static fixture does not establish production skin/texture/clip support.
- [Points](./index.html?package=points): four real 397-point bunny PCD clouds
  and four billboard sprites. Every frame updates a 32-point range in each cloud
  and rotates the sprite markers. Toggle eye-dome lighting, recolor a selected
  cloud or click drawn points to invoke package picking. Input/drawn point counts
  and actual GPU-upload bytes are separate from the small core anchor cubes.
- [Toon](./index.html?package=toon): four real dolphin surfaces with the specific
  Toon package's stepped lighting and front-culled expanded silhouette hull.
  Run rotates the models; the toggle removes/re-attaches the actual plugin.
- [Transitions](./index.html?package=transitions): real knight/dolphin scenes
  captured and blended through wipe, seeded dissolve, radial and chromatic passes.
  Run changes geometry every 1.5 seconds and animates each 0.75-second transition.
  The button starts a new transition; progress requires Run while paused.
- [Animator](./index.html?package=animator): one real skinned RobotExpressive
  model by default, with actual Idle/Walking/Running blends, state cross-fades
  and a masked right-arm Wave additive layer. Model nodes and skinning buffers
  are owned by the existing PBR/Animation packages; actor boxes are cleared.
- [TAA](./index.html?package=taa): actual temporal accumulation, animated-vertex
  and parent-motion velocity on the same walking robot. Toggle/reset the effect
  and inspect history controls; no empty actor-box TAA surrogate is used.
- [Text](./index.html?package=text): 16 real two-line SDF text blocks over depth
  anchors. Local monospace font setup, atlas/glyph counts, fixed-length string
  changes, and outline/shadow toggles use the actual TextRenderer package.
- [Splats](./index.html?package=splats): one combined, globally sorted Gaussian
  cloud with 397 input samples per bunny group. It uses actual anisotropic
  covariance/SH input and camera motion. This is a derived PCD fixture; it does
  not claim trained photogrammetry or every external splat file format.
- [Audio](./index.html?package=audio): four generated looping tones in real
  positional Web Audio sources, with mesh-following panners, cone/distance
  attenuation and reused FFT analysis. **Enable sound** is explicit; the default
  is silent. Run moves emitters, and Pause suspends sound. This covers generated
  buffers and graph/spatial work, without a decoded-file or hearing-test claim.
- [Video](./index.html?package=video): four external-texture surfaces share one
  actual HTMLVideoElement fed by a generated 256 × 128 Canvas MediaStream.
  Source drawing and explicit frame requests are included in workload CPU;
  delivered video-frame counts are recorded separately. First mount waits for
  an actual source frame, and disposal stops tracks/callbacks/media ownership.
  This covers external media textures; file decoding/codecs are not exercised.
- [Blender](./index.html?package=blender): four complete, textured `.margo`
  fixture models, each with two triangles sharing geometry and an authored
  mirrored transform. The 1,004-byte fixture comes from the existing Python
  format writer. Mount uses actual image decode and PBR upload; Run separately
  repeats bounded decode-only batches. This is a format/lifecycle workload,
  without a complex-export or commercial-scene performance claim.

Asset scenes use 1/4/9 complete models and normalize only display scale/center,
preserving topology and the untouched source fixtures. A batch is launched at
most once per simulation second, with no overlapping batch. FPS includes real
worker/package/geometry activity; asynchronous job elapsed time is distinct from
synchronous frame CPU. Pausing cancels ownership of pending jobs, and disposal
cancels their results/resources. Eight asset correctness checks pass, including
actual Wasm and serialized-output validation; Draco worker and all asset GPU/FPS
acceptance remain queued. Visible models do not imply coverage of every supported
file feature. Toon/Transitions retain cached models without background parse jobs.
Fixture attribution remains in the original loader/decoder fixture folders and
vendor notices. The local triangle file matches the project's existing FBX test.

The four UI scenes use presets of 4/16/64 actors. Selected cubes retain edits
while other cubes move. Package controls also render a preview while paused;
ordinary paused measurement has no scheduled scene frames. DOM projection,
Gizmo overlay tessellation and Inspector debug synchronization run as actual
engine passes and are included in **Render CPU**. The Inspector's own hierarchy
refresh timer is part of whole-scene cadence, outside synchronous frame CPU.
Each mounted UI factory owns and removes its controls, package listeners,
overlays and debug resources when rebuilt or closed. These examples are not
production-site routes. The seven native/UI cases have the recorded local
acceptance above; physical-mobile and cold-hosted acceptance remain open.

The full URL is `http://127.0.0.1:5173/examples/package-benchmarks/index.html?package=ecs`
with the default Vite port. The size control selects bounded presets. Every actor
in the selected workload is rendered; rendering can become the limiting cost.
Switching the workload disposes the previous engine and its owned resources.
Changing tabs or hiding the page pauses measurement.
Factories may await their optional dependencies. The readiness record includes
that wait; a page closed before initialization finishes disposes the late result
instead of creating an engine afterward. No empty workload is published on a
dependency failure. Mounting may also await actual font/model setup; the principal
render happens after it completes. Transform capacity includes owned model nodes,
and model counts, principal primitives, and the engine's actual visible counter
are recorded separately when an optional renderer uses its own draw path.

**Workload CPU** includes the package calls and pose-generation loop. **Render CPU**
includes mesh synchronization, core transforms, uploads and command encoding.
Both are rolling means over 120 frames and cover synchronous JavaScript only.
Stats reports complete frame cadence and draw/dispatch counts. GPU execution,
queue/presentation latency and timestamp profiling overhead are not measured by
the CPU columns; 60 FPS depends on the complete scene, browser and GPU. Initial
setup and typed-array/object creation happen before Run.

**GPU timing** is optional and off by default. Enabling it rebuilds the selected
engine with `timestamp-query` when the adapter supports it, then uses Stats' pooled
profiler to sample one frame in 15. Its GPU value sums profiled pass execution;
copies between passes, queue waiting and presentation are outside that sum.
The status distinguishes unsupported devices from warming-up samples. FPS with
timing enabled includes instrumentation overhead; use the default off setting
for the unprofiled FPS baseline.

The setup helper on this isolated example page temporarily wraps
`GPUAdapter.requestDevice`; the exact method is restored on success, failure or
pagehide. It preserves compatibility with earlier core builds that did not
negotiate this capability. Current core requests supported timestamp-query
capability at device creation and restoration; the profiling checkbox controls
whether Stats actually allocates queries or reads them. The status checks the
actual active device's features. If a restored adapter loses support, the value
is unavailable; recreating the engine cannot invent a missing GPU capability.

For local automation, `window.packageBenchmark.run()`, `.pause()` and `.result()`
expose actual counters and measurements. Results are not uploaded or stored.
The initial readiness record identifies the last submission made by the assembled
principal-scene render, waits for that work once, and observes two animation
callbacks afterward. This is a presentation opportunity, not proof of physical
display. DOM readiness and an earlier empty or partial frame do not satisfy it.
`.result({samples: true})` returns at most 4,096 rows of native callback timestamp,
unclipped interval, workload CPU and render CPU times, in milliseconds. The
first callback after Run has a zero interval and is excluded from cadence.
Result snapshots also include the latest completed per-pass GPU durations and
the first-pass-begin to last-pass-end span from Stats' existing pooled profiler.
The duration array is copied only when a result snapshot is requested; the
frame loop uses the same query set, buffers and timing array. Passes appear in
encoder order, and the span includes copies/gaps between them, not presentation.

Run `node scripts/benchmark-package-workloads.js` for sequential native Edge and
Android layout/DPR runs, screenshots, timing OFF/ON/ON/OFF comparisons and
keyboard, pause, rebuild, resize and pagehide checks. JSON evidence is saved under
`test-results`; no measurements are sent to a server. The headed browser uses
explicit occlusion/background-throttling flags and records visibility/focus.
Its render callback cadence describes foreground throughput, not displayed FPS.
Phone layout emulation uses the same Intel laptop GPU; local Vite startup is not
a cold hosted-site or physical-phone measurement. Optional environment variables
`WORKLOAD_PACKAGES`, `WORKLOAD_PROFILES`, `WORKLOAD_DURATION_MS` and
`WORKLOAD_WARMUP_MS` select cases and bounded durations. `WORKLOAD_REPORT_PREFIX`
keeps reports and screenshots from separate runs distinct. BVH is selectable but
the default automation covers the first four workloads.
`WORKLOAD_TRACE=1` adds bounded startup resource timings, actual GPU API call and
first-submit durations, main-thread tasks of at least 50 ms, and neighboring
native frame rows around every missed 60 Hz interval. Tracing stays off by default
and allocates no GPU queries. It adds observer/wrapper overhead, so traced cases
identify causes and must be followed by an untraced acceptance comparison.
Synchronous pipeline API duration does not measure deferred driver compilation;
queued principal completion includes uploads, driver work, GPU work and waiting.
CPU work in a frame row executes at that callback, after its preceding interval.
The previous/current/next rows and overlapping tasks are retained to avoid
incorrectly attributing a scheduling gap to the following short CPU callback.
The runner saves all functional/performance evidence before failing when an
initial principal scene exceeds 1,000 ms, either unprofiled mean is below 60 Hz,
or an unprofiled render interval exceeds 16.67 ms plus 0.2 ms timing tolerance.
This strict local target does not substitute for physical display/mobile or
hosted cold-load proof; timestamp-profiled runs are recorded separately.
Use `WORKLOAD_PACKAGES=splines,navmesh,wfc` to select the new workloads explicitly.
Their [native and Intel phone-layout measurements](../../docs/package-routing-workloads-2026-10-13.md)
include startup misses and cadence tails. Physical-mobile/cold-hosted acceptance
remains open; bounded defaults are not a performance guarantee. Asset families
and Points/Toon/Transitions completed 18 actual native/layout diagnostic cases
and 72 timing windows, including exact output metadata, real Draco workers,
controls and cleanup. Sixteen strict local targets failed. Traces isolate
repeated synchronous export work and development-server import delays; built
startup, untraced cadence and physical-device acceptance remain open. See
[the asset/effect measurements](../../docs/package-asset-effect-workloads-2026-10-13.md).
Animator/TAA/Text/Splats, Audio/Video and Blender now have recorded actual native
and Intel phone-layout runs: all14 functional cases/56 windows pass, while five
strict local startup/tail targets fail. Real TAA validation isolated a static PBR
buffer-usage bug; the glTF-pro fix also passes actual prepared-model/reboot and
bit-exact non-TAA image checks. Hosted cold loads, physical phones and complete
optimization acceptance remain pending. Details and limitations are in
[the render/media workload log](../../docs/package-render-media-workloads-2026-10-13.md).
Correctness self-checks exercise the same workload factories without a browser:

```sh
node --test examples/package-benchmarks/*.test.js
```

Existing package unit tests cover entity generations, hierarchy invariants,
callback mutation, Hermite interpolation and quaternion normalization separately.
Native GPU/FPS acceptance must be recorded after browser testing; these examples
do not establish a device performance guarantee.
