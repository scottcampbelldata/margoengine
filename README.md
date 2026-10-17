# Margo Engine

The product is six packages: the [`margoengine`](packages/margoengine/README.md) stage, [`@margoengine/core`](packages/core/README.md), [`@margoengine/react`](packages/react/README.md), [`@margoengine/gltf`](packages/gltf/README.md), [`@margoengine/gltf-pro`](packages/gltf-pro/README.md), and [`@margoengine/machinery`](packages/machinery/README.md). The demo is [Night Citadel](apps/showcase-night-citadel/README.md): `npm run dev`.

The current consolidated build measures **18,626 bytes gzip** (42,922 raw) for core and **20,827 bytes gzip** (49,361 raw) for core plus the stage facade, including embedded Wasm and both backends. Those bytes are a mesh, one directional light, orbit controls, and the loader shell. That is below the gate. CI rejects a combined size of **25,000 bytes gzip or above**.

The optional React entry measures **20,966 bytes gzip** on its own, with React and optional package peers external. It is additional to the base; an application bundle also includes the peers it uses. Measurements are recorded in [entry-sizes.json](examples/package-benchmarks/results/entry-sizes.json).

A small Rust/Wasm engine for web apps, with WebGPU rendering, WebGL2 fallback, ordinary React components and optional domain packs.

Official website: [margoengine.com](https://margoengine.com). Built with precision, named with love. For Margie.

The implementation lives in `packages/`, with Vite and Next.js starters in `examples/`. Small internal helpers shared by the optional packs live in `packages/shared/`. Source is available in the public [Margo Engine repository](https://github.com/scottcampbelldata/margoengine). The renamed packages use `@margoengine/*`, with `margoengine` as the meta-package. Build from source or install local tarballs until the renamed packages are published.

## Use Margo Engine

For the high-level API built from this checkout, see [`margoengine`](packages/margoengine/README.md). It mounts the canvas, enables camera controls and starts rendering:

```ts
import {createStage} from 'margoengine';
const app = await createStage('#scene');
const orb = app.sphere({color: '#84d6bd', roughness: 0.25, scale: [1, 0.85, 1]});
app.onTick(delta => {orb.rotation.z += delta;});
window.addEventListener('pagehide', () => app.dispose(), {once: true});
```

Provide a container such as `<div id="scene" style="height:400px"></div>` and call `app.dispose()` on unmount. Models, machinery, creative effects and scenery load on demand through the same wrapper. PBR rendering, image-based lighting, and shadows require WebGPU; WebGL2 supports basic meshes. The new facade package is available locally and has not been published yet. Run `npm run modern:dev` and open `/quickstart.html` to try it.

Use the source setup below, or build local tarballs with `npm run pack:packages`.
Registry installation commands will be added with a verified package release.
The [React guide](packages/react/README.md) covers React 18 and 19; optional packs
are selected by importing the packages used by your scene.

## Run from source

```sh
git clone https://github.com/scottcampbelldata/margoengine.git margoengine
cd margoengine
npm ci
npm run dev
```

Open the localhost URL printed by Vite for the standalone [Night Citadel showcase](apps/showcase-night-citadel/README.md): procedural architecture and cliffs, a moving moon, stars, shadows, atmospheric controls and live telemetry. `npm run modern:dev` opens the original starter, with nested rotating geometry, PBR controls, lazy glTF import, GPU leaves, CAD navigation, conveyor machinery, capped cutaways, dimensions, STL/OBJ upload, atmosphere/FX and device restoration. Its **Toggle moonlit scenery** button still loads the scenery package on demand. Consumers use the checked-in Wasm and need no Rust toolchain.

```sh
npm test                      # builds packages and runs modern unit checks
npm run test:kernel           # native kernel tests; requires the pinned Rust toolchain
npm run build:packages        # builds workspace libraries with precompiled Wasm
npm run typecheck             # strict checks for all 74 packages after build
npm run measure:size          # verifies the combined core + stage gzip ceiling
npm run build                 # builds packages, both starters and Night Citadel
npm run pack:packages         # rebuilds and writes npm tarballs to test-results/
npm run package:blender       # creates dist/margo-blender-addon-v1.0.0.zip (Python 3.11+)
npm run modern:test:browser   # after build: GPU checks and production starter flows
npm run modern:test:domains   # caps, sorting, FX and real GPU-loss recovery
npm run modern:test:sky       # scenery phases, stars, depth and plugin lifecycle on WebGPU
npm run modern:test:citadel   # showcase pixels, controls, pacing, resize and orbit heap profile
npm run modern:test:packages  # frozen exports/types and React 18 lifecycle
npm run test:modules:packages # all 74 packed exports and strict Bundler/NodeNext consumers
npm run modern:test:usdz      # USDA/USDC fixtures, archive integrity and limits
npm run modern:test:gltf-compression # production Draco/Meshopt loading and decoder teardown
npm run modern:test:wrapper   # five-line setup, loading, lazy packs and teardown
npm run modern:test:finalization # picking, industrial depth and conveyor stress; dev server required
npm run modern:check:conveyor     # live UI, motor timing and 15s Chrome GC trace; dev server required
npm run modern:dev               # original Vite starter / machinery checks
npm run dev --workspace @margoengine/starter-next
```

## Packages

Libraries use the npm scope `@margoengine`; the stage facade is `margoengine`. The workspace libraries use version `1.0.0`. The [catalog](docs/README.md) lists every package, runtime export and npm publication status.

<!-- package-list: generated from docs/catalog.json by scripts/build-catalog.js; do not edit -->

74 packages in 10 layers, the same as the [catalog](https://margoengine.com/catalog/).

### Start here (2)

| Package | What it is |
| --- | --- |
| [`margoengine`](packages/margoengine/README.md) | Five-line setup for Margo Engine and its domain packs. |
| [`@margoengine/core`](packages/core/README.md) | Lean WebGPU/WebGL2 rendering with a deterministic Rust/Wasm transform kernel. |

### Setup and diagnostics (5)

| Package | What it is |
| --- | --- |
| [`@margoengine/math`](packages/math/README.md) | Vector, quaternion, matrix, Euler, color, bounds, ray, plane and frustum math with three.js-style names, one module per type. |
| [`@margoengine/quality`](packages/quality/README.md) | Measured quality tiers: start light, time the GPU, remember full 4x quality only where it has headroom. |
| [`@margoengine/webgl`](packages/webgl/README.md) | WebGL2 fallback renderer for browsers without WebGPU: flat-shaded PBR core meshes, opt in with Engine.create(canvas, {fallback: webglRenderer}). |
| [`@margoengine/stats`](packages/stats/README.md) | Allocation-free frame samples, DOM performance overlay and optional WebGPU timestamp profiling. |
| [`@margoengine/inspector`](packages/inspector/README.md) | Entity hierarchy, live properties, WebGPU wireframe, normal and bounding-box overlays, and a frame debugger. |

### Loading and formats (12)

| Package | What it is |
| --- | --- |
| [`@margoengine/gltf`](packages/gltf/README.md) | Lazy static glTF/GLB loading for Margo Engine. |
| [`@margoengine/gltf-pro`](packages/gltf-pro/README.md) | Opt-in glTF 2.0 metallic-roughness rendering for Margo Engine WebGPU. |
| [`@margoengine/loaders`](packages/loaders/README.md) | PLY, 3MF, PCD, OFF, XYZ, legacy VTK and static USDA/USDZ loaders for Margo Engine. |
| [`@margoengine/decoders`](packages/decoders/README.md) | Worker-pooled Draco geometry and KTX2/Basis texture decoding for Margo Engine. |
| [`@margoengine/fbx`](packages/fbx/README.md) | Binary and ASCII FBX conversion into the optional Margo glTF animation pipeline. |
| [`@margoengine/usdz`](packages/usdz/README.md) | Optional static USDA, USDC and USDZ ingestion through Margo glTF PBR. |
| [`@margoengine/usdz-export`](packages/usdz-export/README.md) | Static scene USDZ packaging for AR Quick Look. |
| [`@margoengine/exporters`](packages/exporters/README.md) | glTF/GLB, STL, OBJ and PLY exporters for Margo Engine scenes and geometry data. |
| [`@margoengine/ifc`](packages/ifc/README.md) | IFC geometry and BIM identifiers for Margo Engine, using an initialized web-ifc runtime. |
| [`@margoengine/blender`](packages/blender/README.md) | Optional offline Blender .margo assets using Margo's WebGPU PBR renderer. |
| [`@margoengine/cache`](packages/cache/README.md) | Opt-in offline asset cache: a fetch-compatible IndexedDB cache for GLB, .bin, textures and STEP files with ETag/Last-Modified revalidation, app versioning, range requests, a byte budget with LRU eviction and network fallback. |
| [`@margoengine/splats`](packages/splats/README.md) | Optional Gaussian splats with GPU covariance projection and stable compute radix sorting. |

### Rendering and lighting (18)

| Package | What it is |
| --- | --- |
| [`@margoengine/materials`](packages/materials/README.md) | Optional glTF PBR material lobes, transmission, volume and typed node graphs through an isolated extension slot. |
| [`@margoengine/shader`](packages/shader/README.md) | Typed shader nodes that compile to readable WGSL: node materials, node post effects and node compute passes. |
| [`@margoengine/environment`](packages/environment/README.md) | HDR/EXR/UltraHDR loading, image-based lighting (prefiltered specular, SH irradiance, BRDF LUT) applied to meshes and glTF models, environment and color backgrounds, and scene fog for Margo Engine on WebGPU. |
| [`@margoengine/clustered`](packages/clustered/README.md) | WebGPU clustered forward point and spot lighting with optional local shadows. |
| [`@margoengine/shadows`](packages/shadows/README.md) | Four-cascade cached directional shadows with PCSS. |
| [`@margoengine/sky`](packages/sky/README.md) | Procedural atmospheric skies, clouds, sun, moon and stars. |
| [`@margoengine/toon`](packages/toon/README.md) | Stepped diffuse shading and inverted-hull outlines. |
| [`@margoengine/oit`](packages/oit/README.md) | Weighted blended order-independent transparency for gltf-pro BLEND primitives and materials transparent meshes: no popping between overlapping transparent parts. |
| [`@margoengine/lod`](packages/lod/README.md) | Level of detail with hysteresis and screen-size switching for thousands of instances, plus GPU-baked octahedral imposters drawn in one instanced call per atlas. |
| [`@margoengine/culling`](packages/culling/README.md) | GPU-driven static instances: frustum and Hi-Z occlusion culling in compute, order-preserving compaction and indirect draws, no per-part CPU work per frame. |
| [`@margoengine/points`](packages/points/README.md) | Large point clouds (Points, PointsMaterial) and instanced sprites (Sprite, SpriteMaterial) for Margo Engine, WebGPU. |
| [`@margoengine/lines`](packages/lines/README.md) | Fat lines (Line2, LineSegments2, LineMaterial) and debug helpers for Margo Engine, WebGPU. |
| [`@margoengine/text`](packages/text/README.md) | GPU signed distance field text for Margo Engine: runtime glyph atlases from any browser font, wrapping, alignment, outlines and shadows, WebGPU. |
| [`@margoengine/labels`](packages/labels/README.md) | HTML labels and CSS 3D objects positioned over a Margo Engine canvas (THREE.CSS2DRenderer and CSS3DRenderer counterparts). |
| [`@margoengine/html`](packages/html/README.md) | World-space DOM anchors, CSS3D placement and scene-depth occlusion. |
| [`@margoengine/video`](packages/video/README.md) | WebGPU external video textures and optional Web Audio sampling. |
| [`@margoengine/xr`](packages/xr/README.md) | Optional WebGPU WebXR sessions, input poses and stereo rendering for Margo Engine. |
| [`@margoengine/staging`](packages/staging/README.md) | Product-shot staging: soft ground contact shadows (shadow-catcher plane) for core meshes and glTF models. |

### Post-processing (5)

| Package | What it is |
| --- | --- |
| [`@margoengine/post`](packages/post/README.md) | HDR bloom, AgX tonemapping and frame-graph SSAO for Margo Engine WebGPU. |
| [`@margoengine/tonemap`](packages/tonemap/README.md) | Optional AgX, ACES fitted and Khronos PBR Neutral color grading with 33-cube LUTs. |
| [`@margoengine/dof`](packages/dof/README.md) | Optional two-pass WebGPU depth of field with circular bokeh. |
| [`@margoengine/taa`](packages/taa/README.md) | Optional temporal anti-aliasing with motion vectors and YCoCg history clamping. |
| [`@margoengine/transitions`](packages/transitions/README.md) | WebGPU scene wipes, noise dissolves and chromatic displacement. |

### World and effects (10)

| Package | What it is |
| --- | --- |
| [`@margoengine/terrain`](packages/terrain/README.md) | Geometry clipmaps and triplanar terrain layers. |
| [`@margoengine/water`](packages/water/README.md) | Gerstner water surfaces, terrain-coupled shallow-water flow, foam and spray. |
| [`@margoengine/scenery`](packages/scenery/README.md) | Procedural moonlit skies and scenery passes for Margo Engine. |
| [`@margoengine/scatter`](packages/scatter/README.md) | Seeded instancing, distance-based LOD and procedural wind. |
| [`@margoengine/road`](packages/road/README.md) | Arc-length spline road surfaces, raised curbs and tiled UVs. |
| [`@margoengine/vfx`](packages/vfx/README.md) | GPU particle simulation and indirect billboards. |
| [`@margoengine/creative`](packages/creative/README.md) | WebGPU particles, atmosphere, toon shading and post-processing for Margo Engine. |
| [`@margoengine/procedural`](packages/procedural/README.md) | Procedural cabins, foliage, grass, humanoids, Marching Cubes surfaces, seeded 2D/3D/4D noise, L-systems and Voronoi fracture. |
| [`@margoengine/wfc`](packages/wfc/README.md) | Seeded wave function collapse: 3D tile adjacency and the 2D overlapping (sample-based) model with backtracking. |
| [`@margoengine/splines`](packages/splines/README.md) | 3D Catmull-Rom, Bezier and Hermite curves with arc-length lookup. |

### Animation and interaction (12)

| Package | What it is |
| --- | --- |
| [`@margoengine/animation`](packages/animation/README.md) | Storage-buffer skinning and compute morph targets for Margo Engine. |
| [`@margoengine/animator`](packages/animator/README.md) | Blend trees, additive layers, animation states and foot IK. |
| [`@margoengine/kinematics-constraints`](packages/kinematics-constraints/README.md) | Standalone analytical capsule and sphere constraints for IK target and arm clearance. |
| [`@margoengine/tween`](packages/tween/README.md) | Allocation-free numeric tween updates and easing timelines. |
| [`@margoengine/cinematic`](packages/cinematic/README.md) | Critically damped camera follow, look-at and screen shake. |
| [`@margoengine/controls`](packages/controls/README.md) | Orbit, map, trackball, fly, first-person, pointer-lock and collision-aware walkthrough (/walk) camera controls, a transform gizmo and drag controls for Margo Engine. |
| [`@margoengine/cameras`](packages/cameras/README.md) | Orthographic projection and exactly vertical (top-down) views for the core camera, with matching culling and picking. |
| [`@margoengine/input`](packages/input/README.md) | Semantic keyboard, pointer, gamepad and touch actions with haptics. |
| [`@margoengine/gizmo`](packages/gizmo/README.md) | Transform manipulators using the existing controls implementation. |
| [`@margoengine/viewcube`](packages/viewcube/README.md) | CAD view cube: shows the camera orientation and animates to top, front, side and isometric views, with a perspective/orthographic toggle. |
| [`@margoengine/selection`](packages/selection/README.md) | GPU picking and visible mesh selection outlines. |
| [`@margoengine/audio`](packages/audio/README.md) | Web Audio listener, global and positional sounds and an analyser for Margo Engine (THREE.AudioListener, Audio, PositionalAudio and AudioAnalyser counterparts). |

### Simulation and games (6)

| Package | What it is |
| --- | --- |
| [`@margoengine/physics`](packages/physics/README.md) | Rigid-body physics for Margo Engine on Rapier: fixed-step engine plugin with interpolation, colliders, joints, queries, events and a character controller. |
| [`@margoengine/navigation`](packages/navigation/README.md) | Optional Recast and Detour WebAssembly navigation. |
| [`@margoengine/navmesh`](packages/navmesh/README.md) | Convex polygon navigation with A*, funnel paths and ORCA avoidance. |
| [`@margoengine/ecs`](packages/ecs/README.md) | Typed-array packed sparse-set entity component storage. |
| [`@margoengine/fsm`](packages/fsm/README.md) | Hierarchical state transitions with cross-fade progress. |
| [`@margoengine/net`](packages/net/README.md) | Hermite and quaternion snapshot interpolation with bounded prediction. |

### CAD and engineering (3)

| Package | What it is |
| --- | --- |
| [`@margoengine/machinery`](packages/machinery/README.md) | Kinematics, polygonal CAD ingestion, sections and metrology for Margo Engine. |
| [`@margoengine/bvh`](packages/bvh/README.md) | Triangle BVH, spatial queries and an engine Raycaster for Margo Engine (three-mesh-bvh and THREE.Raycaster counterparts). |
| [`@margoengine/geometry`](packages/geometry/README.md) | Pure-CPU, tree-shakable geometry for Margo Engine: Three.js-compatible primitives, curves, shapes, extrusion, triangulation and mesh utilities. |

### Frameworks (1)

| Package | What it is |
| --- | --- |
| [`@margoengine/react`](packages/react/README.md) | React 18/19 components and stable mesh refs for Margo Engine. |

<!-- /package-list -->

The current consolidated build measures **18,626 bytes gzip** for core and **20,827 bytes gzip** for core plus the stage facade, including embedded Wasm and both backends. Those bytes are a mesh, one directional light, orbit controls, and the loader shell. The base is feature-frozen for v1.0.0; every push and pull request runs a CI build that rejects a combined size of **25,000 bytes gzip or above** and checks package isolation. Optional PBR, animation and SSAO packages use the existing extension hooks and do not enter the base bundle. The build also retains the 30 KiB combined core/static-glTF budget and 30 KiB raw Wasm budget. React/framework/application code is additional; domain packages have no separate 25 KiB ceiling.

The six requested game modules (shadows, clustered, animator, TAA, VFX and splats), plus terrain, use those hooks. Build with `npm run build:packages`; run `npm run modern:test:game` for their combined WebGPU rendering/culling/cache/IK/particle checks, temporal reprojection/clamping, skinned motion, stable radix sorting and ellipse blending. `npm run modern:test:game:packages` checks ten packed packages and seven standalone README TypeScript examples. The normal sort test covers 66,049 splats across hierarchical scan blocks; set `SPLAT_STRESS=1` for the additional three-million-splat capacity/sort check. Million-particle, three-million-splat and 1,024-light execution tests validate correctness separately from FPS claims. These source packages have not been published by this change.

```tsx
import { useRef } from 'react';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame, type MeshRef } from '@margoengine/react';

function Cube() {
  const mesh = useRef<MeshRef>(null);
  useFrame((_, delta) => { if (mesh.current) mesh.current.rotation.y += delta; });
  return <Mesh ref={mesh}>
    <BoxGeometry />
    <PbrMaterial color="#84d6bd" roughness={0.3} />
  </Mesh>;
}
export default function App() {
  return <Canvas style={{ height: 400 }}><Cube /></Canvas>;
}
```

`EngineKernel`/`Engine`, Canvas callbacks and React mesh refs expose the frozen portable TypeScript API; raw Wasm/GPU state is available only through the explicit `@margoengine/core/extension` entry. Entity creation occurs in effects. Nested components register upward to support child-first commit order. Frame callbacks mutate stable refs without scheduling React renders.

[MODERN-ENGINE.md](MODERN-ENGINE.md) contains the architecture, API examples, lifecycle rules, size evidence, supported loader subset, verification and remaining domain features. Thirty-one JavaScript tests, four Rust checks and 32 browser check groups passed after the modern-only cleanup, including production Vite/Next rendering, actual particle storage readback, packed consumers and React 18/19 lifecycle checks. Chrome conveyor captures verify UI picking/orbit, instanced draws, coupled timing and 15-second GC/allocation traces; the observed collections do not establish zero-GC. AMD Radeon integrated graphics and NVIDIA baseline measurements are recorded in the [benchmark summary](benchmarks/README.md). Raw captures and recovery archives remain local. Firefox/Safari and mobile GPU hardware remain unverified.

Node.js 22.12+ or 24+ is required; TypeScript consumers need TypeScript 7+ with DOM types; Wasm initialization uses SIMD and DecompressionStream gzip. WebGPU uses HTTPS/localhost; basic scenes fall back to WebGL2. GPU particles, sections, creative and scenery rendering require WebGPU; solid caps also require depth32float-stencil8 support; CPU machinery/CAD/annotations work with either backend. The libraries are [MIT licensed](LICENSE). The workspace root and starter apps remain private.

`npm run build:packages` uses the checked-in Wasm, emits ESM and TypeScript declarations, removes stale distribution files, copies the root license into each package and enforces the existing size/isolation budgets. Each library's `prepack` hook runs that same workspace build before `npm pack` or `npm publish`. Tarballs contain only built files, package metadata, a package README and the MIT license. To try local changes, install a rebuilt tarball from `test-results/`; optional packs require the matching core tarball. Existing `modern:*` commands remain available, including `modern:build` for rebuilding the Rust kernel.

Import the scoped packages listed above. Native STEP/IGES solids and heavier renderer/physics features remain deferred; implemented domain features and their limits are documented in MODERN-ENGINE.md. The public repository contains the modern modular engine; the earlier renderer and recovery archives are excluded.

Run `npm run modern:dev:extensions`, then open `/examples/damaged-helmet.html` for PBR and the SSAO toggle or `/examples/robot-expressive.html` for clip playback and facial morph sliders. The demos download credited sample assets. The three extension packages are local workspace packages and have not been published. Their READMEs document supported glTF features and limits. `npm run modern:test:extensions` checks GPU deformation readback, a 1,001-joint skin, ambient-only SSAO, resize/device recovery, and both demos; `npm run modern:test:packages` checks standalone tarballs and TypeScript consumers.



## Asset loading and release verification

The six core launch packages are the stage facade, `core`, `react`, `gltf`,
`gltf-pro` and `machinery`. USDZ remains an ancillary optional format outside
that launch set. Its USDA/USDC parsers are vendored with MIT attribution; the
root and package manifests require neither `three` nor `@types/three`.
Benchmark and visual-parity tools use a separately cached, pinned Three.js
0.186.1 reference.

`@margoengine/gltf-pro` automatically loads Draco and Meshopt glTF/GLB through
`loadGLTF`. In-memory `parseGLTF` remains synchronous for uncompressed and Meshopt
data; use `parseGLTFAsync` for Draco or embedded KTX2. Meshopt decodes at the buffer-view boundary
without workers or Wasm. Draco starts its bundled worker/Wasm decoder only when
needed and releases temporary workers after success, failure or cancellation.
Caller-supplied decoders remain caller-owned. KTX2/BasisU glTF textures transcode
to enabled GPU compression formats, retain their mip chains, and release their
temporary workers. Texture transforms and UV1 keep the fixed vertex layout;
nonidentity transforms use the optional group 3 uniform slot. Animation supports
four or eight normalized joint influences per vertex.

[`@margoengine/materials`](packages/materials/README.md) adds clearcoat, sheen,
specular color, anisotropy, iridescence, transmission, IOR, volume, and a closed TypeScript node graph through the optional
material extension slot. Install optional glTF metadata explicitly with
`materials.install(model)`, or compile an authored graph with `nodeMaterial()`.
Refraction samples the opaque screen color once; there is no ray-traced or
multi-bounce transmission, participating media, or node-graph file format.
Transmissive surfaces do not cast shadows or receive cascaded shadows. The new
lobes affect directional lighting and fixed hemispherical ambient; clustered and
environment lighting retain their base PBR response. Three.js TSL remains unsupported.
These features stay outside the frozen core and stage bundle.

Registered PBR models also support GPU picking and selection outlines through
`@margoengine/selection`, including current skin and morph deformation.
`@margoengine/bvh` provides an explicit asynchronous `intersectModel()` query
against a snapshot of that GPU pose. Core picking and ordinary PBR bindings stay
unchanged; models opt in through registration.

Historical verification on 16 October 2026, before this consolidation, passed
1,189 Node 24 tests, strict TypeScript checks and packed imports across the then
63 packages, the existing production browser
regressions, 42 node-material captures, 59 additional-lobe captures, 82 texture
captures, complete Khronos material/KTX2/UV1 assets, and eight-influence character
GPU readback, plus 45 local-shadow and 46 deformed-picking captures.
These results describe that earlier checkout, not a rerun of its browser captures
on the consolidated tree. The current `npm run measure:size` result is
**49,361 bytes raw / 20,827 bytes gzip** for core + stage.
The [release notes](CHANGELOG.md#unreleased) record the parser,
normalization, index-boundary and lifecycle checks.

## Package catalog and release

Run `npm run catalog` to preview the [searchable Margo catalog](docs/README.md). All 74 packages use their Margo names. `npm run catalog:build` refreshes the catalog from built runtime exports and checks exact-version availability on npm. [Release notes](CHANGELOG.md) describe source changes and their verification; an Unreleased entry does not indicate npm publication.

`npm run release:check` builds and tests the engine, enforces the 25,000-byte core + stage ceiling, and verifies every tarball's exports, TypeScript declarations and internal dependency versions. `npm run publish:dry-run` runs the local release and supply-chain checks and previews the workspace tarballs without publishing. Releases use the manual [Publish workflow](.github/workflows/publish.yml) from `main`; it defaults to a dry run and requires `NPM_PUBLISH_ENABLED=true` and the `npm-publish` environment. Follow the [release guide](docs/releasing.md) for approval, credentials and publishing the libraries and tools. Starter apps and showcases are private. Refresh the catalog after publishing and run `npm run build:site` to assemble the website.

[Committed SwiftShader results](benchmarks/README.md#swiftshader-runs-no-gpu) include repeat commands and the [historical conveyor picking failure](benchmarks/swiftshader/conveyor-check-picking-failure.txt). Software-renderer timings do not establish physical GPU performance.
