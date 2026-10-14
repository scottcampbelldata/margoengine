# Additional optional runtime workloads

These local examples add coverage for packages with no meaningful visible demo
in the initial inventory. Controls, Input, Cinematic, Procedural, Terrain and
Geometry already have actual visible callers in Afterlight and other examples;
this batch does not duplicate those scenes. The separate Navmesh, Splines and
WFC workloads were authored in the preceding batch.

All three new factories use the existing package-benchmark marker harness. They
start paused, contain bounded work, and drive marker positions from actual
package results. They do not change production package implementations or
defaults. Native GPU/FPS, hosted cold startup and physical-phone acceptance are
pending; source coverage and CPU correctness checks do not establish those.

| Package | Bounded presets / default | Actual work and visible result | Timing scope |
| --- | --- | --- | --- |
| Navigation | 96, **128**, 256 actors | Recast builds 144 input triangles around a missing central floor. Seventy-two purple input-tile markers frame 24/56/184 agents. Every step queries Detour from each current position to its goal and follows actual waypoints. Amber denotes bent paths; red denotes failures. There is no crowd-avoidance claim. | Setup/build elapsed time includes asynchronous Wasm initialization. Path CPU is synchronous query and marker movement. |
| Physics | **80**, 272, 528 actors | Rapier simulates 64/256/512 rotation-locked cubes, a fixed ground collider, staggered impulses and real contact events. Sixteen purple query markers show actual downward ray hits. Visible cubes have the same 0.22-meter box dimensions as their colliders. | Initialization elapsed time is separate from synchronous world construction. Fixed-step/impulse CPU and ray-query CPU are separated; the overall workload column also includes public body-pose reads and packing. |
| Road | **136**, 520, 1,032 actors | A real spline sweep generates 16/64/128 segments every frame. Eight unique cross-section corners per row are shown, with amber raised curbs. Hard-normal duplicate vertices, UVs and triangle counts are reported. This is a clearly labeled vertex view, not a filled-mesh renderer. | Initial sweep setup and per-frame sweep CPU; pose packing remains in the harness workload column. |

Source files are `examples/package-benchmarks/navigation.js`, `physics.js` and
`road.js`; the independent CPU/Wasm regression file is
`examples/package-benchmarks/optional-runtime.test.js`. It checks actual
hole-avoiding Detour routes, actual Rapier poses/contact events/ray-hit positions,
generated sweep corner provenance/normals/UV topology, bounded inputs and
idempotent resource retirement. Run these checks against built packages with:

```sh
node --test examples/package-benchmarks/optional-runtime.test.js
```

The shared harness must await Navigation and Physics factory completion and
dispose a factory result if terminal pagehide occurred while it initialized.
Registry, HTML, README and automation integration are coordinated separately
with the harness owner. No benchmark measurements have been claimed for this
batch at authoring time.

The focused real-package CPU/Wasm run completed successfully on October 13:
four tests passed, none skipped, in 1.28 seconds. Navigation's 96 actors/24 agents
completed 120 frames without missing-floor crossings or failed paths; Physics
performed 241 fixed steps on 65 owned bodies with contacts/impulses, matching locked
poses and 16 actual ray hits; Road's 238 generated vertices/224 triangles matched the
displayed corner provenance, unit normals and tiled UVs. Disposal froze poses
and counters and freed the Recast query/navmesh and Rapier world. This was not a
browser/GPU/FPS run and did not build or modify any package.

The first read-only optimization hypotheses require measured baselines before
changes: Navigation's endpoint-validation arrays are small compared with actual
Detour/Wasm work; Physics public pose/query copies and fixed-step/contact costs
must be separated; Road allocates temporary XYZ/normal/UV arrays for every
generated vertex before copying into typed arrays and then core Geometry.
Direct writes are a candidate only after exact generated-output and raw/gzip
comparisons, plus repeatable CPU measurements. None of these hypotheses is a
confirmed bottleneck or an implemented optimization.
