# Margo Engine module catalog

[Browse the searchable catalog](https://scottcampbelldata.github.io/margoengine/).

Search all 99 packages by task, package name or public runtime export. Copy installation commands and imports, open each package guide, and try the four standalone HTML examples. The catalog marks exact versions available on npm; packages marked Source can be built from the repository until publication.

The [release notes](../CHANGELOG.md#unreleased) cover standalone USDZ parsing,
Draco/Meshopt support in glTF Pro and synchronous parsing behavior. The core and the stage
together measure **57,071 bytes raw / 23,013 bytes gzip**, below the 25,000-byte combined gzip ceiling. That figure is the engine, not an app: React, models and optional packages add to it. The
[entry measurements](../examples/package-benchmarks/results/entry-sizes.json) list every package entry, and the measured size of a React page is in
[limits](limits.md).

Margo is written clean room: the rule, the process and the source of every lighting and post-processing formula
are in [clean-room.md](clean-room.md).

Publishing uses the manual, gated [Publish workflow](../.github/workflows/publish.yml)
from `main`; see the [release guide](releasing.md). `npm run publish:dry-run` checks
and previews the workspace tarballs locally without publishing.

To preview a checkout, use Node.js 24.18+ and run this command from the repository root (End users: Node 22.12 or
newer, tested on 22.12 and the latest 22.x, 24.18 and 26. Contributors: Node 24.18 or newer.):

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

99 packages in 12 layers, the same as the [catalog](https://margoengine.com/catalog/).

### Start here (3)

| Package | What it is |
| --- | --- |
| [`margoengine`](../packages/margoengine/README.md) | Margo Engine in one install: the stage and every package as margoengine/<name> (margoengine/gltf, margoengine/shadows, margoengine/physics, margoengine/react). |
| [`@margoengine/stage`](../packages/stage/README.md) | The stage: createStage mounts a canvas, camera controls and rendering in five lines. Re-exported by margoengine. |
| [`@margoengine/core`](../packages/core/README.md) | WebGPU rendering and a Wasm transform kernel. WebGL2 is the optional @margoengine/webgl package. |

### Setup and diagnostics (7)

| Package | What it is |
| --- | --- |
| [`@margoengine/math`](../packages/math/README.md) | Vector, quaternion, matrix, Euler, color, bounds, ray, plane and frustum math, one module per type. |
| [`@margoengine/quality`](../packages/quality/README.md) | Measured quality tiers: start light, time the GPU, remember full 4x quality only where it has headroom. |
| [`@margoengine/webgl`](../packages/webgl/README.md) | WebGL2 fallback renderer for browsers without WebGPU: flat-shaded PBR core meshes, opt in with Engine.create(canvas, {fallback: webglRenderer}). |
| [`@margoengine/webgl2-compat`](../packages/webgl2-compat/README.md) | The WebGL2 compatibility layer for browsers without WebGPU (milestones M0 to M8 done); the site's demos run on it there. install() gives core a WebGPU-shaped device on WebGL2 that translates WGSL to GLSL ES 3.00; render shaders, texture views, readbacks of every copyable format, occlusion queries, render bundles, external textures, gather and storage-buffer reads run, compute pipelines run as fragment draws, point draws or on the CPU, whichever the shader allows, and DOF, splats and culling take routes of their own there. XR runs through the /xr entry; the voxel path tracer refuses it. |
| [`@margoengine/worker`](../packages/worker/README.md) | Runs Margo Engine in a Web Worker on an OffscreenCanvas: canvas transfer, resize, pixel ratio and input forwarding, so heavy scenes never block the page. |
| [`@margoengine/stats`](../packages/stats/README.md) | Allocation-free frame samples, DOM performance overlay, optional WebGPU timestamp profiling, pipeline compile tracking, a CPU phase breakdown, leak alerts and field telemetry. |
| [`@margoengine/inspector`](../packages/inspector/README.md) | Entity hierarchy, live properties, WebGPU wireframe, normal and bounding-box overlays, and a frame debugger. |

### Loading and formats (11)

| Package | What it is |
| --- | --- |
| [`@margoengine/gltf`](../packages/gltf/README.md) | Lazy static glTF/GLB loading for Margo Engine. |
| [`@margoengine/gltf-pro`](../packages/gltf-pro/README.md) | Opt-in glTF 2.0 metallic-roughness rendering for Margo Engine WebGPU. |
| [`@margoengine/loaders`](../packages/loaders/README.md) | PLY, STL, 3MF, PCD, OFF, XYZ, OBJ/MTL, COLLADA, Tiled TMX, VTK, NRRD, LDraw, Rhino 3DM, 3DS, LWO, AMF, MD2, PDB, KMZ, NURBS, LAS, OpenVDB, MaterialX, Lottie, static USDA/USDZ, SVG and TrueType font loaders for Margo Engine. |
| [`@margoengine/decoders`](../packages/decoders/README.md) | Worker-pooled Draco geometry and KTX2/Basis texture decoding, and synchronous PNG, TGA, TIFF, DDS and KTX reading, for Margo Engine. |
| [`@margoengine/fbx`](../packages/fbx/README.md) | Binary and ASCII FBX conversion into the optional Margo glTF animation pipeline. |
| [`@margoengine/usdz`](../packages/usdz/README.md) | Optional static USDA, USDC and USDZ ingestion through Margo glTF PBR. |
| [`@margoengine/exporters`](../packages/exporters/README.md) | glTF/GLB, STL, OBJ, PLY, USDZ, COLLADA and 3MF exporters for Margo Engine scenes and geometry data. |
| [`@margoengine/blender`](../packages/blender/README.md) | Optional offline Blender .margo assets using Margo's WebGPU PBR renderer. |
| [`@margoengine/cache`](../packages/cache/README.md) | Opt-in offline asset cache: a fetch-compatible IndexedDB cache for GLB, .bin and texture files with ETag/Last-Modified revalidation, app versioning, range requests, a byte budget with LRU eviction and network fallback. |
| [`@margoengine/splats`](../packages/splats/README.md) | Optional Gaussian splats with GPU covariance projection and stable compute radix sorting. |
| [`@margoengine/tiles`](../packages/tiles/README.md) | Streaming OGC 3D Tiles 1.1: implicit and explicit tilesets, screen-space-error selection, a fetch queue, a memory budget and glTF tiles drawn through gltf-pro. |

### Rendering and lighting (24)

| Package | What it is |
| --- | --- |
| [`@margoengine/materials`](../packages/materials/README.md) | Optional glTF PBR material lobes, transmission, volume, parallax occlusion, triplanar and subsurface scattering, and typed node graphs through an isolated extension slot. |
| [`@margoengine/shader`](../packages/shader/README.md) | Typed shader nodes that compile to readable WGSL: node materials, node post effects and node compute passes, with a visual node editor. |
| [`@margoengine/environment`](../packages/environment/README.md) | HDR/EXR/UltraHDR loading, EXR writing, image-based lighting (prefiltered specular, SH irradiance, BRDF LUT), environment backgrounds and scene fog for Margo Engine on WebGPU. |
| [`@margoengine/clustered`](../packages/clustered/README.md) | WebGPU clustered forward point and spot lighting with optional local shadows. |
| [`@margoengine/shadows`](../packages/shadows/README.md) | Four-cascade cached directional shadows with PCSS. |
| [`@margoengine/lightmap`](../packages/lightmap/README.md) | CPU lightmap atlases with native albedo, emission, normal and ORM textures; optional area lights, emissive surfaces, bounces and glass (./global) and caustics (./refracted). |
| [`@margoengine/sky`](../packages/sky/README.md) | Procedural atmospheric skies, clouds, sun, moon, stars and weather (rain, snow, lightning). |
| [`@margoengine/weather`](../packages/weather/README.md) | Weather over time: a state machine with presets that blends rain, snow, hail, wind and lightning; a deterministic wind field; wet and snowy surface hooks in JavaScript and WGSL; helpers for the sky's Weather; and bouncing GPU hail. |
| [`@margoengine/toon`](../packages/toon/README.md) | Stepped diffuse shading and inverted-hull outlines. |
| [`@margoengine/oit`](../packages/oit/README.md) | Order-independent transparency for gltf-pro BLEND primitives and materials transparent meshes: weighted blending, moment-based blending, or exact per-pixel layer lists, with no popping between overlapping transparent parts. |
| [`@margoengine/lod`](../packages/lod/README.md) | Level of detail with hysteresis and screen-size switching for thousands of instances, plus GPU-baked octahedral imposters drawn in one instanced call per atlas. |
| [`@margoengine/culling`](../packages/culling/README.md) | GPU-driven static instances: frustum and Hi-Z occlusion culling in compute, order-preserving compaction and indirect draws, no per-part CPU work per frame. |
| [`@margoengine/points`](../packages/points/README.md) | Large point clouds (PointCloud, PointsMaterial) and instanced sprites (SpriteBatch, SpriteMaterial) for Margo Engine, WebGPU. |
| [`@margoengine/sprites`](../packages/sprites/README.md) | 2D sprites at exact pixels: one instanced draw per layer, atlas rectangles, pivot, flip, rotation, tint, z and y sorting, integer pixel snapping and an optional normal map target. |
| [`@margoengine/lines`](../packages/lines/README.md) | Fat lines (Line, LineMaterial) and debug helpers for Margo Engine, WebGPU. |
| [`@margoengine/text`](../packages/text/README.md) | GPU signed distance field text for Margo Engine: runtime glyph atlases from any browser font, wrapping, alignment, outlines and shadows, WebGPU. |
| [`@margoengine/pixel`](../packages/pixel/README.md) | Pixel art rendering: a pixel camera with integer zoom and parallax, and a layer compositor that scales low-res layers by whole numbers and turns them with every output pixel one source pixel. |
| [`@margoengine/lighting2d`](../packages/lighting2d/README.md) | 2D lights for Margo Engine: point, spot and directional lights with normal-mapped shading and hard shadows from occluder edges, for pixel layers. |
| [`@margoengine/labels`](../packages/labels/README.md) | HTML labels and CSS 3D objects positioned over a Margo Engine canvas. |
| [`@margoengine/html`](../packages/html/README.md) | World-space DOM anchors, CSS3D placement and scene-depth occlusion. |
| [`@margoengine/video`](../packages/video/README.md) | WebGPU external video textures and optional Web Audio sampling. |
| [`@margoengine/xr`](../packages/xr/README.md) | Optional WebGPU WebXR sessions, input poses and stereo rendering for Margo Engine. |
| [`@margoengine/headless`](../packages/headless/README.md) | Render without a browser page: a stand-in canvas for core, GPU globals from the WebGPU binding you pass in, and readback to RGBA pixels or PNG bytes. |
| [`@margoengine/staging`](../packages/staging/README.md) | Product-shot staging: soft ground contact shadows (shadow-catcher plane) for core meshes and glTF models. |

### Post-processing (5)

| Package | What it is |
| --- | --- |
| [`@margoengine/post`](../packages/post/README.md) | HDR bloom, frame-graph SSAO, GTAO, SSGI and SSR, motion blur, lens flare, SMAA and FXAA, glitch and afterimage, and post-effect stacks for Margo Engine WebGPU. |
| [`@margoengine/tonemap`](../packages/tonemap/README.md) | Optional color grading: Khronos PBR Neutral (the engine default), AgX and ACES fitted curves, 2-65 cube LUTs. |
| [`@margoengine/dof`](../packages/dof/README.md) | Optional two-pass WebGPU depth of field with circular bokeh. |
| [`@margoengine/taa`](../packages/taa/README.md) | Optional temporal anti-aliasing with motion vectors and YCoCg history clamping. |
| [`@margoengine/transitions`](../packages/transitions/README.md) | WebGPU scene wipes, noise dissolves and chromatic displacement. |

### World and effects (15)

| Package | What it is |
| --- | --- |
| [`@margoengine/terrain`](../packages/terrain/README.md) | Geometry clipmaps and triplanar terrain layers. |
| [`@margoengine/biomes`](../packages/biomes/README.md) | Biome maps from a heightmap and a few climate settings: integer fixed-point climate fields, biome classification with smooth ecotones, presets, terrain ground weights and editor hooks, byte-identical on every platform. |
| [`@margoengine/voxel`](../packages/voxel/README.md) | Voxel worlds: a block-type registry, 32-cubed palette chunks with light bytes, and a chunked world with dirty tracking and change events. |
| [`@margoengine/voxel-pathtracer`](../packages/voxel-pathtracer/README.md) | Progressive WebGPU path tracer for instanced voxel models: diffuse, plastic, metal, glass, emissive, blended and volumetric materials, sun, sky, HDR environment and area lights, depth of field, motion blur, a denoiser and PNG capture. |
| [`@margoengine/voxel-edit`](../packages/voxel-edit/README.md) | Editing voxel models for editors and tools: dense and sparse grids, modeling operations, brushes and selections, picking, export meshing, .vox scene editing and frame animation. |
| [`@margoengine/water`](../packages/water/README.md) | Gerstner water surfaces, terrain-coupled shallow-water flow, foam and spray. |
| [`@margoengine/scenery`](../packages/scenery/README.md) | Procedural moonlit skies and scenery passes for Margo Engine. |
| [`@margoengine/scatter`](../packages/scatter/README.md) | Seeded instancing, distance-based LOD and procedural wind. |
| [`@margoengine/road`](../packages/road/README.md) | Arc-length spline road surfaces, raised curbs and tiled UVs. |
| [`@margoengine/tilemap`](../packages/tilemap/README.md) | 2D tile maps for Margo Engine: the TileMapData format (tilesets, animated tiles, collision shapes, tile and object layers, parallax), a chunked renderer at exact pixels, auto-tiling and the Tiled and LDtk importers. |
| [`@margoengine/vfx`](../packages/vfx/README.md) | GPU particle simulation and indirect billboards, with curves over life and sphere, cone and mesh-surface emitters. |
| [`@margoengine/creative`](../packages/creative/README.md) | WebGPU particles, atmosphere, toon shading and post-processing for Margo Engine. |
| [`@margoengine/procedural`](../packages/procedural/README.md) | Procedural cabins, foliage, grass, humanoids, Marching Cubes surfaces, seeded 2D/3D/4D noise, L-systems, Voronoi fracture and a bounded voxel expression language. |
| [`@margoengine/wfc`](../packages/wfc/README.md) | Seeded wave function collapse: 3D tile adjacency and the 2D overlapping (sample-based) model with backtracking. |
| [`@margoengine/splines`](../packages/splines/README.md) | 3D Catmull-Rom, Bezier, Hermite, B-spline and Kochanek-Bartels curves with arc-length lookup, closest point, stable frames and knot editing. |

### Animation and interaction (15)

| Package | What it is |
| --- | --- |
| [`@margoengine/animation`](../packages/animation/README.md) | Storage-buffer skinning and compute morph targets for Margo Engine. |
| [`@margoengine/animator`](../packages/animator/README.md) | Blend trees, additive layers, animation states, foot IK, CCD IK chains, root motion, and look-at and aim constraints. |
| [`@margoengine/kinematics-constraints`](../packages/kinematics-constraints/README.md) | Standalone analytical capsule, sphere and convex hull constraints for IK target and arm clearance. |
| [`@margoengine/rigging`](../packages/rigging/README.md) | Rigging and animation authoring: automatic skin weights, weight painting, skin checks, IK chains with poles, retarget presets, spring bones, VRM 1.0 avatars, geodesic voxel weights, corrective shapes, weight transfer, face tracking, automatic rigs from a bare mesh. |
| [`@margoengine/tween`](../packages/tween/README.md) | Allocation-free numeric tween updates and easing timelines. |
| [`@margoengine/cinematic`](../packages/cinematic/README.md) | Virtual cameras with priorities and blends, framing, dolly tracks, group framing, camera noise, confiners and focus tracking, on top of damped follow, look-at and shake. |
| [`@margoengine/cutscene`](../packages/cutscene/README.md) | Cutscene timelines: camera, transform, property, animation, audio, subtitle and event tracks, nested timelines, scrubbing, a player that fires events in order, virtual camera shots with blends, rendering to a video file, a take recorder, dialogue with lip sync, and particle and activation tracks, and a timeline editor panel. |
| [`@margoengine/controls`](../packages/controls/README.md) | Orbit, map, trackball, arcball, fly, first-person, pointer-lock and collision-aware walkthrough (/walk) camera controls, a transform gizmo and drag controls for Margo Engine. |
| [`@margoengine/cameras`](../packages/cameras/README.md) | Orthographic projection and exactly vertical (top-down) views for the core camera, with matching culling and picking. |
| [`@margoengine/input`](../packages/input/README.md) | Semantic keyboard, pointer, gamepad, touch, gyro and pen actions with haptics, tap, hold, slow tap and double press rules, local multiplayer, and recording and replay. |
| [`@margoengine/ui`](../packages/ui/README.md) | Game UI drawn in the engine: menus, HUDs, health bars, inventories, dialogs and toasts with flex layout, theming, keyboard, gamepad and touch navigation, screen reader support and React components. |
| [`@margoengine/viewcube`](../packages/viewcube/README.md) | CAD view cube: shows the camera orientation and animates to top, front, side and isometric views, with a perspective/orthographic toggle. |
| [`@margoengine/selection`](../packages/selection/README.md) | GPU picking and visible mesh selection outlines. |
| [`@margoengine/audio`](../packages/audio/README.md) | Web Audio listener, global and positional sounds and a frequency analyser for Margo Engine. |
| [`@margoengine/mixer`](../packages/mixer/README.md) | Audio mixing and effects: buses with gain, mute, solo, sends and ducking; equaliser, filter, compressor, limiter, delay and reverb on Web Audio; positional emitters; deterministic offline rendering. |

### Simulation and games (11)

| Package | What it is |
| --- | --- |
| [`@margoengine/physics`](../packages/physics/README.md) | Rigid-body physics for Margo Engine on Rapier: fixed-step engine plugin with interpolation, colliders, joints, queries, events and a character controller. |
| [`@margoengine/physics2d`](../packages/physics2d/README.md) | 2D rigid-body physics for Margo Engine on Rapier: fixed-step plugin with interpolation, sprite-driven bodies, joints, queries, events, a character controller and tile map colliders. |
| [`@margoengine/ragdoll`](../packages/ragdoll/README.md) | Ragdolls on Margo physics: capsule bodies from a skeleton, cone and hinge joint limits, kinematic hit boxes, going limp and blending back to the animation. |
| [`@margoengine/navmesh`](../packages/navmesh/README.md) | Convex polygon navigation with A*, funnel paths and ORCA avoidance; navmesh generation from triangles (./build) tiled meshes that rebuild at run time (./tiles), baked files (./codec), jump links (./links), long routes (./hierarchy), debug draw (./debug), voxel worlds (./voxel) and flying agents (./volume). |
| [`@margoengine/ecs`](../packages/ecs/README.md) | Typed-array packed sparse-set entity component storage. |
| [`@margoengine/fsm`](../packages/fsm/README.md) | Hierarchical state machines with history, delayed transitions, parallel regions, JSON documents, snapshots and traces. |
| [`@margoengine/behavior`](../packages/behavior/README.md) | Game AI: behaviour trees with a typed blackboard and async tasks, utility-AI scoring, steering and flocking behaviours, perception (./perception), environment queries (./eqs), a goal planner (./goap), smart objects (./smart-objects), flow fields (./flowfield), and a task network planner (./htn). |
| [`@margoengine/save`](../packages/save/README.md) | Save and load: versioned scene and world documents with stable ids, prefabs with overrides, migrations, all-or-nothing loading and storage adapters. |
| [`@margoengine/net`](../packages/net/README.md) | Hermite and quaternion snapshot interpolation with bounded prediction. |
| [`@margoengine/netcode`](../packages/netcode/README.md) | Game networking for any game: schema-first binary codec with delta snapshots, an authoritative fixed-timestep server, client prediction and reconciliation, interpolation and a loopback network for tests. |
| [`@margoengine/voxel-net`](../packages/voxel-net/README.md) | Multiplayer voxel worlds: an authoritative Node server on a hand-written WebSocket, a browser client with prediction and correction, and headless bots for load tests. |

### Geometry and spatial (4)

| Package | What it is |
| --- | --- |
| [`@margoengine/bvh`](../packages/bvh/README.md) | Triangle BVH, spatial queries and an engine Raycaster for Margo Engine. |
| [`@margoengine/geometry`](../packages/geometry/README.md) | Pure-CPU, tree-shakable geometry for Margo Engine: primitives, curves, shapes, extrusion, triangulation and mesh utilities. |
| [`@margoengine/mesh-edit`](../packages/mesh-edit/README.md) | Pure polygon editing with retained corner UVs, explicit topology provenance and conservative cleanup. |
| [`@margoengine/scene`](../packages/scene/README.md) | Scene graph conveniences for core meshes: children, traverse, userData, lookAt and world position, rotation and scale, as functions or as mesh members. |

### Data and science (2)

| Package | What it is |
| --- | --- |
| [`@margoengine/compute`](../packages/compute/README.md) | GPU compute without the WebGPU boilerplate, NumPy style: N-d arrays with views and broadcasting, fused expressions, reductions and statistics, scan, sort, selection, histograms, matmul, FFT, convolution, random numbers, streaming, neural networks, graph algorithms, and WGSL kernels bound by name. |
| [`@margoengine/sciviz`](../packages/sciviz/README.md) | Scientific visualisation for Margo Engine: volume rendering with transfer functions, slices and GPU isosurfaces, million-point scatter plots, surface and line plots with axes, ticks, labels and colour bars, and perceptual colour maps. |

### AI tools (1)

| Package | What it is |
| --- | --- |
| [`@margoengine/mcp`](../packages/mcp/README.md) | A Model Context Protocol server for Margo Engine: AI coding tools (Claude, Cursor, Copilot) search the docs and API, read a package, list the examples and type-check a snippet against the real package types. Plain stdio JSON-RPC, no dependencies. |

### Frameworks (1)

| Package | What it is |
| --- | --- |
| [`@margoengine/react`](../packages/react/README.md) | React 18/19 components and stable mesh refs for Margo Engine. |

<!-- /package-list -->
