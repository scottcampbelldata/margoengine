# Margo Engine module catalog

[Browse the searchable catalog](https://scottcampbelldata.github.io/margoengine/).

Search all 74 packages by task, package name or public runtime export. Copy installation commands and imports, open each package guide, and try the five standalone HTML examples. The catalog marks exact versions available on npm; packages marked Source can be built from the repository until publication.

The [release notes](../CHANGELOG.md#unreleased) cover standalone USDZ parsing,
Draco/Meshopt support in glTF Pro and synchronous parsing behavior. The current
consolidated build measures **18,626 bytes gzip** for core and **49,482 bytes raw /
20,850 bytes gzip** for core + stage, below the 25,000-byte combined gzip ceiling.
Package versions and npm availability remain independent of these source changes.
The optional React entry measures **20,966 bytes gzip**, with React and optional package peers external; those peers and application code are additional. See the [entry measurements](../examples/package-benchmarks/results/entry-sizes.json) and [74-package consolidation record](repository-consolidation-2026-10-16.md).

Publishing uses the manual, gated [Publish workflow](../.github/workflows/publish.yml)
from `main`; see the [release guide](releasing.md). `npm run publish:dry-run` checks
and previews the workspace tarballs locally without publishing.

To preview a checkout, use Node.js 22.12+ and run this command from the repository root:

```sh
npm run catalog
```

Open [localhost:5184](http://127.0.0.1:5184). No dependency installation or package build is needed for the catalog. Stop the preview with Ctrl+C.

The catalog uses plain HTML, CSS, JavaScript and `catalog.json`. It loads no engine packages. Examples fetch pinned distribution files from jsDelivr; React also uses esm.sh. Serve copied examples over localhost or HTTPS rather than opening them with `file://`. Examples include pause/play controls, respect reduced-motion preferences and dispose resources when the page closes. Creative rendering requires WebGPU. CDN examples need their Margo packages to be published first.

GitHub Pages serves this directory from `main` at `/margoengine/`; the website build also copies it into `/catalog/`. Run `npm run build:packages` and `npm run catalog:build` to refresh package names, versions, runtime exports and exact-version registry availability. Add runnable examples to the matching `catalog.json` entry; the generator retains that metadata. TypeScript-only types and the advanced core `/extension` entry are covered in the [API guide](../MODERN-ENGINE.md).

Run the catalog checks after installing workspace development dependencies:

```sh
node --test tests/catalog.test.js
```


## Packages

<!-- package-list: generated from docs/catalog.json by scripts/build-catalog.js; do not edit -->

74 packages in 10 layers, the same as the [catalog](https://margoengine.com/catalog/).

### Start here (2)

| Package | What it is |
| --- | --- |
| [`margoengine`](../packages/margoengine/README.md) | Five-line setup for Margo Engine and its domain packs. |
| [`@margoengine/core`](../packages/core/README.md) | WebGPU rendering and a Wasm transform kernel. WebGL2 is the optional @margoengine/webgl package. |

### Setup and diagnostics (5)

| Package | What it is |
| --- | --- |
| [`@margoengine/math`](../packages/math/README.md) | Vector, quaternion, matrix, Euler, color, bounds, ray, plane and frustum math with three.js-style names, one module per type. |
| [`@margoengine/quality`](../packages/quality/README.md) | Measured quality tiers: start light, time the GPU, remember full 4x quality only where it has headroom. |
| [`@margoengine/webgl`](../packages/webgl/README.md) | WebGL2 fallback renderer for browsers without WebGPU: flat-shaded PBR core meshes, opt in with Engine.create(canvas, {fallback: webglRenderer}). |
| [`@margoengine/stats`](../packages/stats/README.md) | Allocation-free frame samples, DOM performance overlay and optional WebGPU timestamp profiling. |
| [`@margoengine/inspector`](../packages/inspector/README.md) | Entity hierarchy, live properties, WebGPU wireframe, normal and bounding-box overlays, and a frame debugger. |

### Loading and formats (12)

| Package | What it is |
| --- | --- |
| [`@margoengine/gltf`](../packages/gltf/README.md) | Lazy static glTF/GLB loading for Margo Engine. |
| [`@margoengine/gltf-pro`](../packages/gltf-pro/README.md) | Opt-in glTF 2.0 metallic-roughness rendering for Margo Engine WebGPU. |
| [`@margoengine/loaders`](../packages/loaders/README.md) | PLY, 3MF, PCD, OFF, XYZ, legacy VTK and static USDA/USDZ loaders for Margo Engine. |
| [`@margoengine/decoders`](../packages/decoders/README.md) | Worker-pooled Draco geometry and KTX2/Basis texture decoding for Margo Engine. |
| [`@margoengine/fbx`](../packages/fbx/README.md) | Binary and ASCII FBX conversion into the optional Margo glTF animation pipeline. |
| [`@margoengine/usdz`](../packages/usdz/README.md) | Optional static USDA, USDC and USDZ ingestion through Margo glTF PBR. |
| [`@margoengine/usdz-export`](../packages/usdz-export/README.md) | Static scene USDZ packaging for AR Quick Look. |
| [`@margoengine/exporters`](../packages/exporters/README.md) | glTF/GLB, STL, OBJ and PLY exporters for Margo Engine scenes and geometry data. |
| [`@margoengine/ifc`](../packages/ifc/README.md) | IFC geometry and BIM identifiers for Margo Engine, using an initialized web-ifc runtime. |
| [`@margoengine/blender`](../packages/blender/README.md) | Optional offline Blender .margo assets using Margo's WebGPU PBR renderer. |
| [`@margoengine/cache`](../packages/cache/README.md) | Opt-in offline asset cache: a fetch-compatible IndexedDB cache for GLB, .bin, textures and STEP files with ETag/Last-Modified revalidation, app versioning, range requests, a byte budget with LRU eviction and network fallback. |
| [`@margoengine/splats`](../packages/splats/README.md) | Optional Gaussian splats with GPU covariance projection and stable compute radix sorting. |

### Rendering and lighting (18)

| Package | What it is |
| --- | --- |
| [`@margoengine/materials`](../packages/materials/README.md) | Optional glTF PBR material lobes, transmission, volume and typed node graphs through an isolated extension slot. |
| [`@margoengine/shader`](../packages/shader/README.md) | Typed shader nodes that compile to readable WGSL: node materials, node post effects and node compute passes. |
| [`@margoengine/environment`](../packages/environment/README.md) | HDR/EXR/UltraHDR loading, image-based lighting (prefiltered specular, SH irradiance, BRDF LUT) applied to meshes and glTF models, environment and color backgrounds, and scene fog for Margo Engine on WebGPU. |
| [`@margoengine/clustered`](../packages/clustered/README.md) | WebGPU clustered forward point and spot lighting with optional local shadows. |
| [`@margoengine/shadows`](../packages/shadows/README.md) | Four-cascade cached directional shadows with PCSS. |
| [`@margoengine/sky`](../packages/sky/README.md) | Procedural atmospheric skies, clouds, sun, moon and stars. |
| [`@margoengine/toon`](../packages/toon/README.md) | Stepped diffuse shading and inverted-hull outlines. |
| [`@margoengine/oit`](../packages/oit/README.md) | Weighted blended order-independent transparency for gltf-pro BLEND primitives and materials transparent meshes: no popping between overlapping transparent parts. |
| [`@margoengine/lod`](../packages/lod/README.md) | Level of detail with hysteresis and screen-size switching for thousands of instances, plus GPU-baked octahedral imposters drawn in one instanced call per atlas. |
| [`@margoengine/culling`](../packages/culling/README.md) | GPU-driven static instances: frustum and Hi-Z occlusion culling in compute, order-preserving compaction and indirect draws, no per-part CPU work per frame. |
| [`@margoengine/points`](../packages/points/README.md) | Large point clouds (Points, PointsMaterial) and instanced sprites (Sprite, SpriteMaterial) for Margo Engine, WebGPU. |
| [`@margoengine/lines`](../packages/lines/README.md) | Fat lines (Line2, LineSegments2, LineMaterial) and debug helpers for Margo Engine, WebGPU. |
| [`@margoengine/text`](../packages/text/README.md) | GPU signed distance field text for Margo Engine: runtime glyph atlases from any browser font, wrapping, alignment, outlines and shadows, WebGPU. |
| [`@margoengine/labels`](../packages/labels/README.md) | HTML labels and CSS 3D objects positioned over a Margo Engine canvas (THREE.CSS2DRenderer and CSS3DRenderer counterparts). |
| [`@margoengine/html`](../packages/html/README.md) | World-space DOM anchors, CSS3D placement and scene-depth occlusion. |
| [`@margoengine/video`](../packages/video/README.md) | WebGPU external video textures and optional Web Audio sampling. |
| [`@margoengine/xr`](../packages/xr/README.md) | Optional WebGPU WebXR sessions, input poses and stereo rendering for Margo Engine. |
| [`@margoengine/staging`](../packages/staging/README.md) | Product-shot staging: soft ground contact shadows (shadow-catcher plane) for core meshes and glTF models. |

### Post-processing (5)

| Package | What it is |
| --- | --- |
| [`@margoengine/post`](../packages/post/README.md) | HDR bloom, AgX tonemapping and frame-graph SSAO for Margo Engine WebGPU. |
| [`@margoengine/tonemap`](../packages/tonemap/README.md) | Optional AgX, ACES fitted and Khronos PBR Neutral color grading with 33-cube LUTs. |
| [`@margoengine/dof`](../packages/dof/README.md) | Optional two-pass WebGPU depth of field with circular bokeh. |
| [`@margoengine/taa`](../packages/taa/README.md) | Optional temporal anti-aliasing with motion vectors and YCoCg history clamping. |
| [`@margoengine/transitions`](../packages/transitions/README.md) | WebGPU scene wipes, noise dissolves and chromatic displacement. |

### World and effects (10)

| Package | What it is |
| --- | --- |
| [`@margoengine/terrain`](../packages/terrain/README.md) | Geometry clipmaps and triplanar terrain layers. |
| [`@margoengine/water`](../packages/water/README.md) | Gerstner water surfaces, terrain-coupled shallow-water flow, foam and spray. |
| [`@margoengine/scenery`](../packages/scenery/README.md) | Procedural moonlit skies and scenery passes for Margo Engine. |
| [`@margoengine/scatter`](../packages/scatter/README.md) | Seeded instancing, distance-based LOD and procedural wind. |
| [`@margoengine/road`](../packages/road/README.md) | Arc-length spline road surfaces, raised curbs and tiled UVs. |
| [`@margoengine/vfx`](../packages/vfx/README.md) | GPU particle simulation and indirect billboards. |
| [`@margoengine/creative`](../packages/creative/README.md) | WebGPU particles, atmosphere, toon shading and post-processing for Margo Engine. |
| [`@margoengine/procedural`](../packages/procedural/README.md) | Procedural cabins, foliage, grass, humanoids, Marching Cubes surfaces, seeded 2D/3D/4D noise, L-systems and Voronoi fracture. |
| [`@margoengine/wfc`](../packages/wfc/README.md) | Seeded wave function collapse: 3D tile adjacency and the 2D overlapping (sample-based) model with backtracking. |
| [`@margoengine/splines`](../packages/splines/README.md) | 3D Catmull-Rom, Bezier and Hermite curves with arc-length lookup. |

### Animation and interaction (12)

| Package | What it is |
| --- | --- |
| [`@margoengine/animation`](../packages/animation/README.md) | Storage-buffer skinning and compute morph targets for Margo Engine. |
| [`@margoengine/animator`](../packages/animator/README.md) | Blend trees, additive layers, animation states and foot IK. |
| [`@margoengine/kinematics-constraints`](../packages/kinematics-constraints/README.md) | Standalone analytical capsule and sphere constraints for IK target and arm clearance. |
| [`@margoengine/tween`](../packages/tween/README.md) | Allocation-free numeric tween updates and easing timelines. |
| [`@margoengine/cinematic`](../packages/cinematic/README.md) | Critically damped camera follow, look-at and screen shake. |
| [`@margoengine/controls`](../packages/controls/README.md) | Orbit, map, trackball, fly, first-person, pointer-lock and collision-aware walkthrough (/walk) camera controls, a transform gizmo and drag controls for Margo Engine. |
| [`@margoengine/cameras`](../packages/cameras/README.md) | Orthographic projection and exactly vertical (top-down) views for the core camera, with matching culling and picking. |
| [`@margoengine/input`](../packages/input/README.md) | Semantic keyboard, pointer, gamepad and touch actions with haptics. |
| [`@margoengine/gizmo`](../packages/gizmo/README.md) | Transform manipulators using the existing controls implementation. |
| [`@margoengine/viewcube`](../packages/viewcube/README.md) | CAD view cube: shows the camera orientation and animates to top, front, side and isometric views, with a perspective/orthographic toggle. |
| [`@margoengine/selection`](../packages/selection/README.md) | GPU picking and visible mesh selection outlines. |
| [`@margoengine/audio`](../packages/audio/README.md) | Web Audio listener, global and positional sounds and an analyser for Margo Engine (THREE.AudioListener, Audio, PositionalAudio and AudioAnalyser counterparts). |

### Simulation and games (6)

| Package | What it is |
| --- | --- |
| [`@margoengine/physics`](../packages/physics/README.md) | Rigid-body physics for Margo Engine on Rapier: fixed-step engine plugin with interpolation, colliders, joints, queries, events and a character controller. |
| [`@margoengine/navigation`](../packages/navigation/README.md) | Optional Recast and Detour WebAssembly navigation. |
| [`@margoengine/navmesh`](../packages/navmesh/README.md) | Convex polygon navigation with A*, funnel paths and ORCA avoidance. |
| [`@margoengine/ecs`](../packages/ecs/README.md) | Typed-array packed sparse-set entity component storage. |
| [`@margoengine/fsm`](../packages/fsm/README.md) | Hierarchical state transitions with cross-fade progress. |
| [`@margoengine/net`](../packages/net/README.md) | Hermite and quaternion snapshot interpolation with bounded prediction. |

### CAD and engineering (3)

| Package | What it is |
| --- | --- |
| [`@margoengine/machinery`](../packages/machinery/README.md) | Kinematics, polygonal CAD ingestion, sections and metrology for Margo Engine. |
| [`@margoengine/bvh`](../packages/bvh/README.md) | Triangle BVH, spatial queries and an engine Raycaster for Margo Engine (three-mesh-bvh and THREE.Raycaster counterparts). |
| [`@margoengine/geometry`](../packages/geometry/README.md) | Pure-CPU, tree-shakable geometry for Margo Engine: Three.js-compatible primitives, curves, shapes, extrusion, triangulation and mesh utilities. |

### Frameworks (1)

| Package | What it is |
| --- | --- |
| [`@margoengine/react`](../packages/react/README.md) | React 18/19 components and stable mesh refs for Margo Engine. |

<!-- /package-list -->
