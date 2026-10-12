# Margo module completion audit

Inspected and completed on 2026-10-11 in this checkout. The earlier marathon
description did not match the files on disk: 12 requested packages already had
substantial implementations, 6 capabilities existed inside other packages but
lacked the requested standalone package, and 19 modules had not started.

All 37 now have `@margoengine/*` manifests, builds, exported TypeScript
declarations and passing unit tests. All declare the core peer range
`^0.1.0 || ^1.0.0` and `sideEffects: false`. Existing changes were preserved;
no core or stage source, manifest or README changed during this task. The
initial and final SHA-256 hashes of their 20 nongenerated files match.

## Package inventory

Package names below are all under `@margoengine/`. "Partial" describes an
existing reusable capability, not a half-written package directory.

| # | Package | Initial state | Completed implementation / evidence |
|---|---|---|---|
| 1 | input | Not started | Semantic actions, keyboard/mouse/gamepad edges, captured touch sticks/buttons and optional haptics; input tests |
| 2 | ecs | Not started | Packed typed-array sparse sets, swap removal, generation-checked entities and reusable query output; ECS tests |
| 3 | fsm | Not started | Hierarchical paths, ancestor hooks, bubbled events, guarded transitions and cross-fade progress; FSM tests |
| 4 | navmesh | Not started | Convex polygon validation, A* corridors, funnel paths and reciprocal ORCA velocity constraints; path/avoidance tests |
| 5 | cinematic | Not started | Frame-rate-independent spring follow/look-at and decaying shake; camera tests |
| 6 | splines | Not started | Catmull-Rom, Bezier and Hermite curves, tangents and arc-length lookup; spline tests |
| 7 | transitions | Not started | Captured previous frame, wipe/dissolve/radial/chromatic shaders, progress, resize and restoration; unit/GPU checks |
| 8 | toon | Partial: creative/ToonShading | Reuses stepped lighting and adds front-culled inverted-hull outlines; unit/GPU checks |
| 9 | water | Not started | GPU Gerstner displacement/normals and linear-depth shoreline foam history; unit/GPU motion checks |
| 10 | sky | Partial: scenery/SkyMoon | New Preetham/Perez and compact precomputed Bruneton-style Rayleigh/Mie models, orders 2..4 and sun clock; unit/GPU checks |
| 11 | selection | Not started | Depth-tested selection mask, JFA and morphological dilation/compositing; unit/GPU outline checks |
| 12 | wfc | Not started | Seeded weighted 3D constraint propagation, pinned tiles and bounded restart recovery; WFC tests |
| 13 | procedural | Not started | Established marching-cubes and simplex dependencies, seeded Perlin/Worley, bounded voxel extraction and normals; procedural tests |
| 14 | road | Not started | Arc-length road sweeps, configurable cross-sections/curbs, hard normals and tiled UV output; road tests |
| 15 | scatter | Partial: specialized creative/Grass | General GPU density/height/slope placement, frustum culling and three indirect distance-LOD draws; unit/GPU checks |
| 16 | html | Partial: labels | Reuses DOM projection and adds asynchronous scene-depth occlusion; unit/GPU visible/hidden anchor checks |
| 17 | video | Not started | Native external video textures, reusable frequency bins and shared media-element audio routing; unit/GPU frame checks |
| 18 | net | Not started | Fixed snapshot ring, Hermite position, shortest-arc slerp and capped dead reckoning; network interpolation tests |
| 19 | stats | Not started | Allocation-free numeric ring sampling, DOM/canvas overlay, direct/indirect counters and optional timestamp profiler; unit/hardware checks |
| 20 | inspector | Not started | Accessible hierarchy, live transforms/material/effect controls and lines-based wireframe/normals/AABB; unit/desktop/mobile GPU checks |
| 21 | navigation | Not started | Recast/Detour Wasm construction and bounded path queries, explicit cleanup and independent strict declarations; real Wasm tests |
| 22 | tween | Not started | Numeric easing/delay/overwrite/cancel tracks and allocation-free update compaction; reentrant callback tests |
| 23 | fbx | Not started | Established binary/ASCII FBX parser, PBR material conversion and GLB bridge; Khronos validation, animated CPU fixture and real skinned GPU asset |
| 24 | usdz-export | Partial: exporters/exportUSDZ | Standalone export of the existing tested USDZ serializer; wrapper and exporter tests |
| 25 | bvh | Implemented, not workspace-integrated | Preserved implementation; brute-force spatial/raycast comparisons and serialization tests |
| 26 | lines | Implemented, not workspace-integrated | Preserved fat lines, joins, dashes and helpers; line tests and inspector GPU rendering |
| 27 | environment | Implemented, not workspace-integrated | Preserved HDR/EXR, SH and IBL implementation; real/synthetic HDR/EXR and processor tests |
| 28 | geometry | Implemented, not workspace-integrated | Preserved procedural primitives; geometry topology/bounds/validation tests |
| 29 | loaders | Implemented | Preserved multi-format and USDZ loaders; parser and reference-asset tests |
| 30 | exporters | Implemented | Preserved scene serializers; enabled local Khronos validation and round-trip tests |
| 31 | decoders | Implemented, not workspace-integrated | Preserved worker bridge; real Draco/Basis/Meshopt and worker ownership/error tests |
| 32 | text | Implemented, not workspace-integrated | Preserved SDF/layout/BiDi implementation; typography, atlas and distance-transform tests |
| 33 | controls | Implemented, not workspace-integrated | Preserved orbit/map/trackball/fly/first-person controls; gesture/damping/transform tests |
| 34 | gizmo | Partial: controls/TransformControls | Standalone export of tested DCC transform controls; identity and controls tests |
| 35 | points | Implemented, not workspace-integrated | Preserved point/sprite renderer; packing, attributes and material tests |
| 36 | audio | Implemented, not workspace-integrated | Preserved listener/spatial graph; lazy context, playback, attenuation and ownership tests |
| 37 | physics | Implemented, not workspace-integrated | Preserved Rapier integration; removed temporary arrays/Set iterators from mesh synchronization and enabled real Rapier checks |

## Integration and verification

- Added missing workspace entries and a `test:all` script that builds packages
  and discovers root tests plus both existing `tests/` and new `test/` layouts.
- `npm run test:all`: **434 passed, 0 failed, 0 skipped**. Includes actual
  Recast/Detour, Rapier, Draco/Basis/Meshopt and Khronos glTF validation.
- `npm run test:modules:packages`: all 37 packed distributions contain their
  JS, declarations and license, import without browser globals, and compile
  with strict Bundler and NodeNext consumers without `skipLibCheck`.
- `npm run test:modules:browser`: actual WebGPU on NVIDIA RTX A6000 in Edge
  155, nonblank effect pixels, animated water/transitions, clean selection
  outlines, depth-occluded DOM anchors, external video, GPU command counters,
  timestamp readback and combined/debug device restoration. Desktop
  1440x1100 and mobile 375x812 overlays have no overlap or page overflow.
- The optional `MARGOENGINE_FBX_FIXTURE` check also ran against Three r186's
  Samba Dancing FBX: 2 primitives, 2 skins, 104 joint references, 2 clips,
  53 animation channels and changing rendered pixels after seeking.
  The downloaded fixture is ignored test data, not redistributed package code.
- `npm run test:browser --workspace @margoengine/physics`: six real browser
  checks pass, including settled stacks, transform/pixel agreement, raycasting,
  GPU validation and world disposal. The browser and Node runners now find
  the root Rapier development dependency automatically.
- Core + stage gzip is **20,053 bytes**, below the **20,480-byte** ceiling.
  CI retains that automatic failure gate and now runs the complete unit sweep,
  packed consumer checks and Margo/Rapier GPU checks.

Reports/screenshots are under ignored `test-results/`, including
`margo-modules.json`, `margo-debug-mobile.png` and
`packages/physics/test-results/physics-browser.json`.

## Commit scope

The separately requested module commit includes the 37 packages, their tests,
this audit and module-specific workspace, dependency and test-runner additions.
Earlier changes to the Margo rename, core/stage baseline, CI, demos and other
extensions remain outside this commit. Verification above describes the full
working checkout; this scoped commit depends on that earlier local baseline
and has not been verified as a standalone clean checkout.

## Deliberate limits

Package READMEs describe units, ownership, supported geometry and bounds. The
following limits matter when choosing an implementation:

- Sky's Bruneton-style mode is a compact, coarsely sampled atmospheric
  approximation, not a reference-quality planetary renderer. It can band near
  the horizon and omits ozone, ground irradiance feedback and aerial perspective.
- Toon, selection and inspector geometry debug passes operate on frozen core
  triangle geometry, not separately rendered glTF-pro/skinned primitives.
  Inverted hulls can show seams on disconnected hard-normal vertices.
- Water is an opaque Gerstner surface, not a reflection/refraction solver.
  Screen-space accumulated foam can trail during camera movement. HTML GPU
  depth results are asynchronous; CSS3D anchors retain projection-only behavior.
  Custom depth sources are needed when another post-effect owns depth capture.
- Navmesh uses convex polygons and dynamic-agent ORCA, without static-wall
  avoidance or radius-inset corridor geometry. WFC uses bounded restarts;
  connectivity and a solution are not guaranteed for arbitrary tile rules.
- Gizmo and USDZ-export deliberately reuse existing implementations. The
  latter's static-scene limits remain; richer PBR USDZ is in `@margoengine/usdz`.
- FBX uses Three only in its optional package and inherits upstream format
  limits. Use trusted assets: byte budgets do not sandbox its synchronous parser.
  Road UVs are separate output because frozen core has no UV attribute channel.
- Stats numeric `tick()` and tween `update()` reuse storage; DOM refresh,
  GPU instrumentation/readback, track creation and Rapier stepping/events can
  allocate. Core does not request `timestamp-query`; the profiler supports
  externally supplied devices with that feature enabled.

Not exhaustively checked: physical gamepad/haptic devices, every browser/GPU,
arbitrary real-world asset formats and long-duration production workloads.
Passing this suite is verification of these implementations, not a blanket
production-readiness or reference-accuracy certification. No npm publication
or destructive cleanup was performed.
