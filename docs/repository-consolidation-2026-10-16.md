# Repository consolidation — 16 October 2026

This record describes the retained source, audit decisions and local verification for consolidation onto main. It does not announce a release or npm publication.

## Source provenance

The comparison covers `24f8348` (main), `fedf9a4` (final skinning checkpoint, following `79c9f4f`), `849ff51` (performance/security) and `4b5235b` (React work). The newest last-change commit supplied each file's initial version; compatible optional capabilities were then reconciled against retained consumers and regressions. Replaced implementations were not restored wholesale.

The local recovery archive is `C:/Users/ScottCampbell/.codex/repo-backups/margoengine-20261016/`: `all-refs-updated.bundle`, `file-decisions.json` and the archived `skinning-uncommitted.patch`. The last patch contains the intentionally rejected GPU-publication experiment and was not reapplied. `fedf9a4` adds only the final allocation handoff; that checkpoint is retained in [KINEMATICS_ALLOCATION_HANDOFF.md](KINEMATICS_ALLOCATION_HANDOFF.md).

## Complete package inventory

There are **74 public packages**, all present in the root workspaces. The union of `packages/` directories across all four source heads equals the current tree exactly: **76 directories, none missing and none extraneous**. The other two directories are the Rust/Wasm **kernel** and internal **shared** helpers; they are support code, not additional npm packages. The workspace also contains five private apps/starters, outside this public-package count.

Each package below links to its retained guide. The [catalog](README.md) groups the same 74 packages by use. Package-name and public-type migrations are described in the [release notes](../CHANGELOG.md#public-api-migrations-retained-during-consolidation); renamed types and the removed duplicate SkyMoon pass are deliberate changes, not missing packages.

| Package | Package | Package |
| --- | --- | --- |
| [`@margoengine/animation`](../packages/animation/README.md) | [`@margoengine/animator`](../packages/animator/README.md) | [`@margoengine/audio`](../packages/audio/README.md) |
| [`@margoengine/blender`](../packages/blender/README.md) | [`@margoengine/bvh`](../packages/bvh/README.md) | [`@margoengine/cache`](../packages/cache/README.md) |
| [`@margoengine/cameras`](../packages/cameras/README.md) | [`@margoengine/cinematic`](../packages/cinematic/README.md) | [`@margoengine/clustered`](../packages/clustered/README.md) |
| [`@margoengine/controls`](../packages/controls/README.md) | [`@margoengine/core`](../packages/core/README.md) | [`@margoengine/creative`](../packages/creative/README.md) |
| [`@margoengine/culling`](../packages/culling/README.md) | [`@margoengine/decoders`](../packages/decoders/README.md) | [`@margoengine/dof`](../packages/dof/README.md) |
| [`@margoengine/ecs`](../packages/ecs/README.md) | [`@margoengine/environment`](../packages/environment/README.md) | [`@margoengine/exporters`](../packages/exporters/README.md) |
| [`@margoengine/fbx`](../packages/fbx/README.md) | [`@margoengine/fsm`](../packages/fsm/README.md) | [`@margoengine/geometry`](../packages/geometry/README.md) |
| [`@margoengine/gizmo`](../packages/gizmo/README.md) | [`@margoengine/gltf`](../packages/gltf/README.md) | [`@margoengine/gltf-pro`](../packages/gltf-pro/README.md) |
| [`@margoengine/html`](../packages/html/README.md) | [`@margoengine/ifc`](../packages/ifc/README.md) | [`@margoengine/input`](../packages/input/README.md) |
| [`@margoengine/inspector`](../packages/inspector/README.md) | [`@margoengine/kinematics-constraints`](../packages/kinematics-constraints/README.md) | [`@margoengine/labels`](../packages/labels/README.md) |
| [`@margoengine/lines`](../packages/lines/README.md) | [`@margoengine/loaders`](../packages/loaders/README.md) | [`@margoengine/lod`](../packages/lod/README.md) |
| [`@margoengine/machinery`](../packages/machinery/README.md) | [`margoengine`](../packages/margoengine/README.md) | [`@margoengine/materials`](../packages/materials/README.md) |
| [`@margoengine/math`](../packages/math/README.md) | [`@margoengine/navigation`](../packages/navigation/README.md) | [`@margoengine/navmesh`](../packages/navmesh/README.md) |
| [`@margoengine/net`](../packages/net/README.md) | [`@margoengine/oit`](../packages/oit/README.md) | [`@margoengine/physics`](../packages/physics/README.md) |
| [`@margoengine/points`](../packages/points/README.md) | [`@margoengine/post`](../packages/post/README.md) | [`@margoengine/procedural`](../packages/procedural/README.md) |
| [`@margoengine/quality`](../packages/quality/README.md) | [`@margoengine/react`](../packages/react/README.md) | [`@margoengine/road`](../packages/road/README.md) |
| [`@margoengine/scatter`](../packages/scatter/README.md) | [`@margoengine/scenery`](../packages/scenery/README.md) | [`@margoengine/selection`](../packages/selection/README.md) |
| [`@margoengine/shader`](../packages/shader/README.md) | [`@margoengine/shadows`](../packages/shadows/README.md) | [`@margoengine/sky`](../packages/sky/README.md) |
| [`@margoengine/splats`](../packages/splats/README.md) | [`@margoengine/splines`](../packages/splines/README.md) | [`@margoengine/staging`](../packages/staging/README.md) |
| [`@margoengine/stats`](../packages/stats/README.md) | [`@margoengine/taa`](../packages/taa/README.md) | [`@margoengine/terrain`](../packages/terrain/README.md) |
| [`@margoengine/text`](../packages/text/README.md) | [`@margoengine/tonemap`](../packages/tonemap/README.md) | [`@margoengine/toon`](../packages/toon/README.md) |
| [`@margoengine/transitions`](../packages/transitions/README.md) | [`@margoengine/tween`](../packages/tween/README.md) | [`@margoengine/usdz`](../packages/usdz/README.md) |
| [`@margoengine/usdz-export`](../packages/usdz-export/README.md) | [`@margoengine/vfx`](../packages/vfx/README.md) | [`@margoengine/video`](../packages/video/README.md) |
| [`@margoengine/viewcube`](../packages/viewcube/README.md) | [`@margoengine/water`](../packages/water/README.md) | [`@margoengine/webgl`](../packages/webgl/README.md) |
| [`@margoengine/wfc`](../packages/wfc/README.md) | [`@margoengine/xr`](../packages/xr/README.md) |  |

## Retained optional capabilities

Whole-file documentation selection omitted some older usage sections even though their implementations, exports and tests remain. This index keeps those capabilities discoverable without replacing newer README descriptions:

| Capability | Retained entry and reference |
| --- | --- |
| Baked animation crowds | `bakeVAT` / `VATCrowd` from `@margoengine/animation/vat`; [entry contract](../api/animation.vat.api.md), [crowd example](../examples/package-benchmarks/atlas-vat/) |
| Worker and progressive glTF | `@margoengine/gltf-pro/worker` and `/progressive`; [worker contract](../api/gltf-pro.worker.api.md), [progressive ready/complete/abort contract](../api/gltf-pro.progressive.api.md) |
| PBR instancing and hook composition | `@margoengine/gltf-pro/instancing`; [instance contract](../api/gltf-pro.instancing.api.md), [lighting/transparency/capture/transmission contracts](../api/gltf-pro.api.md), [shader conventions](shader-contracts.md) |
| Extended glTF materials and variants | [glTF Pro contracts](../api/gltf-pro.api.md), [materials guide](../packages/materials/README.md); keep newer compression, texture-coordinate and physical-material support |
| Frame debugger | `@margoengine/inspector/frame`; [contract](../api/inspector.frame.api.md) |
| Loaded-model export | `exportModel` from `@margoengine/exporters`; [contract](../api/exporters.api.md). Distinct from data-scene `exportGLB`/`exportGLTF`. |
| Whole-model physics | `Physics.addModel`; [contract](../api/physics.api.md). Retains model hierarchy, instance transforms and rollback alongside current mesh-source fitting. |
| Geometric model queries | BVH model/instance hits, proxy spheres, `worldTriangles`, asynchronous deformed queries; [contract](../api/bvh.api.md). Current-pose GPU readback is explicit. |
| X-ray selection and rich picks | Selection `xray`, model/node selections and primitive/instance/proxy pick metadata; [contract](../api/selection.api.md). Current alpha-aware deformed picking remains. |
| Optional light modules | `@margoengine/clustered/area` and `/shadows`; [area contract](../api/clustered.area.api.md), [shadow contract](../api/clustered.shadows.api.md) |
| CAD custom fetch and workers | `loadCAD(..., {fetch})`, parser budgets and worker APIs; [CAD contract](../api/machinery.cad.api.md), [async CAD contract](../api/machinery.cad-async.api.md) |

Historical performance figures from omitted sections are not promoted to current results. API contracts describe the integrated tree and package tests retain the corresponding behavior checks.

## Audit decisions

Confirmed UI issues were reproduced before repair: CAD pole/orbit/capture handling; Fly shift multipliers; React pointer-lock double updates; XR capacity growth; moving HTML occlusion; direct label disposal; CAD view hashing; singular normal-helper caching; touch releases clearing held mouse buttons; audio replay retaining delayed sources; and preloaded fonts bypassing registration. Selection retains private instance storage and capacity growth. Geometry degeneracy and navmesh portal ordering were repaired in their packages.

Other supplied findings referred to replaced code or already-correct behavior. Current React colliders use world transforms; empty models notify `onLoad` (the cited `onReady`/`center`/`fit` API is absent). Physics direct disposal unregisters its plugin. Camera-only Trackball controls require caller-driven `update`. BVH callback traversals own their state; nested-query regressions pass. ECS validates stale entities before recycling slots, zero-duration tweens complete immediately, and WFC validates pins before indexing. The current avoidance solver does not use the cited joint finite-difference code; current curve frames use parallel transport.

Rendering, material, loading/security and multi-plugin composition findings were handled in the same consolidation with separate scoped evidence. Local detailed logs and dispositions live under `test-results/`, including `audit-ui-summary.md`, `integration-retention-audit.md` and `integration-package-inventory.json`. The completed local verification is recorded below.

The final integration pass also corrected three consumer failures. Isolated PBR
renderers now own their device-specific instance buffers, observe live instance
changes, and release only their own projections; switching textured material
variants refreshes replica bindings even when the layout is unchanged. SSAO's
ambient replay retains TAA's vertex-camera binding **18** when fragment-lighting
bindings are omitted. React Canvas now forwards its existing `fallback` renderer
option and safely recreates the engine when that factory changes. The unchanged
packed React 18 browser fixture passes with the repaired WebGL fallback.

## Measured bundle boundaries

The current [entry measurements](../examples/package-benchmarks/results/entry-sizes.json) report **18,255 bytes gzip** for core and **47,486 bytes raw / 20,282 bytes gzip** for core plus stage. The enforced combined ceiling remains **strictly below 25,000 gzip bytes**. Core and stage remain feature-frozen; the controls changes are bug fixes.

The React entry is **20,966 bytes gzip** with React and optional package peers external. That is a standalone optional-entry measurement; the peer packages and application code are additional. These figures do not claim a complete application download size.

## Final local verification

The [portable verification record](../benchmarks/consolidation-2026-10-16.json) records all 33 passing browser/GPU groups and their local evidence paths. Package sources were held stable after the final complete build. Measurements identify the pre-commit consolidation working tree (`24f8348`, dirty), rather than claiming to measure that old commit alone.

| Check | Result |
| --- | --- |
| Complete Node suite, Node 26.12.0 | 2,215 passed, zero failures/skips |
| Added browser startup regressions | 3 passed; confirmed Vite reload retry only |
| Native kernel and Python Blender add-on | 5 Rust and 8 Python tests passed; add-on ZIP built |
| Package builds, strict types and installed exports | All 74 passed; strict Bundler and NodeNext consumers passed |
| Public API reports | 173 entries, 1,777 exports match |
| Packed consumer groups | React 18, interop, game and post-processing passed; 122 React lifecycle tests plus hardware smoke |
| Short fuzz campaign | Zero findings |
| Browser/GPU groups | 33 passed on physical NVIDIA RTX A6000, Edge 155; no software adapter |
| Stress matrix | 22/22 sessions, 120 frames, 10 lifecycle cycles configured |
| Production builds | Vite, Next, showcase, sandbox, catalog and complete site passed |
| Supply-chain records and Git LFS | Checks passed |

The final browser pass updated stale fixtures for optional WebGL fallback, renamed demos, Sky/light uniform layouts, explicitly allowed local texture URLs, automatic capacity growth, and quality-tier frame pacing. Assertions still verify rendered pixels, rollback, resource cleanup and shader validation. The shared startup helper retries only context loss accompanied by a received Vite full-reload; unrelated navigation and GPU failures still fail.

The final independent review verified the SSAO/TAA binding repair, independent replica instance buffers, and replica material rebinding with 11 passing scoped tests. Both headed backends recorded approximately 60 FPS with zero callback gaps over 25 ms. GC and heap variation were observed; these runs do not establish zero allocation or compositor timing.

Scope: no physical XR headset or native Blender installation was used. AMD/other browser engines, the 500-session release workload and optional 3M-splat branch were not repeated. The production audit used `--audit-only`. GitHub Actions results are separate from these local checks.
