# Rival parity gaps (2026-11-24)

What Margo still lacks against three.js r186 (core, add-ons and the examples gallery), Babylon.js 8.x, PlayCanvas 2.x
and the three.js ecosystem libraries users expect (drei, pmndrs postprocessing, three-mesh-bvh, troika, model-viewer,
Needle, Filament). Godot, Unity, Unreal and Blender are not the bar.

Built from four audits on 2026-11-24: the three.js examples gallery grouped into features, the Babylon.js docs, the
PlayCanvas manual plus the ecosystem libraries, and a code check of the 52 export-only rows of
[threejs-parity.md](threejs-parity.md). Every MISSING row was grepped in `packages/*/src` before it was listed. Rival
features come from documentation and example names only, never their source (clean room).

A finished row reads DONE in Status with its commit in Landed; a row found to exist already reads EXISTS with its evidence path.

Sizes: S under a day, M one to three days, L about a week, XL more.

## Not gaps after all (removed from the audit lists)

glTF `KHR_animation_pointer` (`animation/src/pointer.ts`), `KHR_interactivity` (`animation/src/interactivity.ts`),
async pipeline compile (core `createRenderPipelineAsync`), directional lightmaps (`lightmap/src/directional.ts`),
light-probe grids (`environment/src/probes.ts`, `lightmap/src/probes.ts`), dashed lines (`bvh/src/lines.ts`), the
shader node editor (`shader/src/editor.ts`), metaballs (`procedural/src/marching-cubes.ts`), point attractors
(`vfx/src/base.ts`), globe controls (`controls/src/globe.ts`), splat picking (`kit-viz/src/splats/pick.ts`).

## Lane A: post-processing and materials

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| ASCII effect | three.js, pmndrs | DONE | S | 12d7c41c5 |
| Radial / zoom blur | three.js | DONE | S | 9d6aa73d9 |
| Ramp, Grid, Depth view and texture overlay effects (`DepthTexture` already existed; `DepthView` builds on it) | pmndrs | DONE | S each | 7efaf1445 |
| Colour curves in image processing | Babylon | MISSING | S |  |
| Retroreflection material | three.js | DONE | S | 566dabc45 |
| glTF `KHR_materials_diffuse_roughness` | three.js | MISSING (only `usdz/materialx`) | M |  |
| Material plugins on the stock PBR material (inject code into the built-in shader) | Babylon, three.js `onBeforeCompile` | MISSING | M |  |
| IBL shadows (shadows from the environment map) | Babylon | MISSING | M |  |
| Blurred / rough planar and screen-space reflections | three.js | PARTIAL | M |  |
| Caustics as a general package (today only inside water, studio, lightmap and the game bundle) | three.js, PlayCanvas | PARTIAL | M |  |

## Lane B: particles, simulation and physics

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Solid Particle System (many meshes as one mesh, per-particle transform and colour, pickable) | Babylon | DONE | M | 86b898ed7 |
| Particle sub-emitters (spawn on birth, death, collision) | Babylon, PlayCanvas | DONE (death and collision EXISTS in `packages/vfx/src/events.ts`; birth added) | S to M | 0480e7a40 |
| Particle fluid solver (`ParticleLiquid` only draws particles today) | three.js, Babylon fluid rendering | MAC (physics: built by Scott's Mac) | L |  |
| Soft-body defects KB-SOFT-LIGHT1 and KB-SOFT-ITER1, plus a cloth render bridge | three.js, Babylon | DONE (KB-SOFT-LIGHT1, KB-SOFT-ITER1, cloth render bridge `@margoengine/gltf/soft-mesh`) | M | 0a4570d8e, d640a7242, 606261f00 |
| Breakable / fracturing bodies | three.js `physics_ammo_break` | MAC (physics: built by Scott's Mac) | M |  |
| WebXR AR GPU depth occlusion (real objects hide virtual ones; only CPU depth today) | three.js, Babylon | MISSING | M |  |
| WebXR AR reflection cube map from light estimation, as the environment's specular | three.js, Babylon | MISSING | M |  |
| WebXR VR and AR passes, controller poses and XR layers not covered by the stand-in sessions | three.js, Babylon | PARTIAL | M |  |

## Lane C: scene, assets, text and formats

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Asset containers: load, add, remove and duplicate a set of objects as one unit, plus scene save and load | Babylon | DONE (scene save and load already existed: `save/src/engine.ts`) | M | f19d13852 |
| Layer sort modes (back-to-front, front-to-back, manual) | PlayCanvas | MISSING | S |  |
| Blob shadow and planar `ShadowMesh` | three.js, drei | MISSING | S |  |
| drei helpers: Float, Center, Resize, ScreenSizer, interaction prompt | drei, model-viewer | MISSING | S each |  |
| Font formats: WOFF and WOFF2 (throw today), CFF `.otf`, GPOS kerning | three.js TextGeometry, troika | PARTIAL | M |  |
| AR Quick Look and Scene Viewer launch where WebXR is absent | model-viewer | MISSING | S |  |
| SVG from an engine scene (sciviz writes SVG from supplied geometry only) | three.js SVGRenderer | PARTIAL | M |  |
| Configurable `loadTexture` caps (fixed at 16.7 MP and 64 MiB) | three.js | LIMIT | S |  |
| 3MF textures, texture `center` on the texture, live metaball object | three.js | LIMIT | S each |  |
| Webcam / MediaStream texture outside React | three.js | VERIFY | S |  |
| Stale docs: cloth, caustics and the mesh path tracer still marked NOT PLANNED in [threejs-parity.md](threejs-parity.md); its MISSING 0 count; the "Not yet" section of [from-threejs.md](from-threejs.md) | — | DONE | S | 1525aff1e |

## Lane D: tools, runtime and interaction

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Script component system (attributes, lifecycle hooks, hot reload) | PlayCanvas, Needle | DONE | L | b95470338 |
| Occlusion query API for apps (only internal in voxel-pathtracer; Hi-Z culling exists) | three.js, Babylon | DONE | M | 3a95eb3b7 |
| Mesh path tracer: instancing, skinning, emissive triangles, alpha blend, `/mesh-pbr` README | three-gpu-pathtracer | DONE | L | README 4f7780bf7, BLEND eb57207ea, skinned poses 8ce7e3e8d; instancing EXISTS (d34b3de1c, src/mesh-instances.ts), emissive triangles EXISTS (adc7807e5, src/mesh-light-build.ts) |
| Raycaster current-pose hits on skinned meshes (sync), Line and Points thresholds | three.js | DONE | M | 99d42804c (thresholds EXISTS: packages/bvh/src/scene.ts, packages/bvh/src/points.ts) |
| Greased Line: per-point width and colour | Babylon | DONE | S | 61f3dcf3f (colorMode; per-point colour and width EXISTS: packages/lines/src/line.ts, packages/lines/src/stroke.ts) |
| Geospatial camera with terrain collision and geo maths | Babylon | DONE | M | 56d8616c4 (WGS84/ECEF/ENU EXISTS: packages/tiles/src/wgs84.ts, now backed by math/geo) |
| Gaussian splat part visibility and compound mode, interactive splat editing | Babylon, PlayCanvas | PARTIAL | M to L |  |
| Voice chat and screen share over the netcode WebRTC transport | Needle | DONE | M | 8092aaee6 |

## Needs Scott or hardware first

| Gap | Why it waits | Size |
| --- | --- | --- |
| WebXR VR and AR, XR passes, controller poses, XR layers | Being built by lane B without a device (Scott, 2026-11-25: "Anything that's waiting on hardware, just build it, push it to main, and assume that it works") | M |
| WebGL2 layer: path tracers cannot finish on ANGLE D3D11, no integrated-GPU frame budget, Safari, Firefox and phones unmeasured | The ANGLE fix is lane D's (reproducible on this laptop); the other machines are recorded as not yet measured | L |
| Swappable physics plugin, floating-origin physics regions | Physics: built by Scott's Mac | M |
| Deferred shading, voxel cone-traced GI | NOT PLANNED by decision; clustered forward and probes plus SSGI instead | XL |
| USDZ interactive behaviours | Not yet given to a lane | M |

The visual scene editor, several canvases on one device and the visual flow-graph editor are in
[do-later.md](do-later.md), out of every current list (Scott, 2026-11-25).

The four audit tables behind this list (evidence paths per row) were working files and are not kept; rerun the audits
from this page's rows when it is next checked.
