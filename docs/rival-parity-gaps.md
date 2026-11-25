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
| Radial / zoom blur | three.js | MISSING | S |  |
| Ramp, Grid, Depth view and texture overlay effects | pmndrs | MISSING | S each |  |
| Colour curves in image processing | Babylon | MISSING | S |  |
| Retroreflection material | three.js | MISSING | S |  |
| glTF `KHR_materials_diffuse_roughness` | three.js | MISSING (only `usdz/materialx`) | M |  |
| Material plugins on the stock PBR material (inject code into the built-in shader) | Babylon, three.js `onBeforeCompile` | MISSING | M |  |
| IBL shadows (shadows from the environment map) | Babylon | MISSING | M |  |
| Blurred / rough planar and screen-space reflections | three.js | PARTIAL | M |  |
| Caustics as a general package (today only inside water, studio, lightmap and the game bundle) | three.js, PlayCanvas | PARTIAL | M |  |

## Lane B: particles, simulation and physics

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Solid Particle System (many meshes as one mesh, per-particle transform and colour, pickable) | Babylon | MISSING | M |  |
| Particle sub-emitters (spawn on birth, death, collision) | Babylon, PlayCanvas | MISSING | S to M |  |
| Particle fluid solver (`ParticleLiquid` only draws particles today) | three.js, Babylon fluid rendering | PARTIAL | L |  |
| Soft-body defects KB-SOFT-LIGHT1 and KB-SOFT-ITER1, plus a cloth render bridge | three.js, Babylon | PARTIAL | M |  |
| Breakable / fracturing bodies | three.js `physics_ammo_break` | MISSING | M |  |

## Lane C: scene, assets, text and formats

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Asset containers: load, add, remove and duplicate a set of objects as one unit, plus scene save and load | Babylon | MISSING | M |  |
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
| Occlusion query API for apps (only internal in voxel-pathtracer; Hi-Z culling exists) | three.js, Babylon | MISSING | M |  |
| Mesh path tracer: instancing, skinning, emissive triangles, alpha blend, `/mesh-pbr` README | three-gpu-pathtracer | PARTIAL | L |  |
| Raycaster current-pose hits on skinned meshes (sync), Line and Points thresholds | three.js | PARTIAL | M |  |
| Greased Line: per-point width and colour | Babylon | PARTIAL | S |  |
| Geospatial camera with terrain collision and geo maths | Babylon | PARTIAL | M |  |
| Gaussian splat part visibility and compound mode, interactive splat editing | Babylon, PlayCanvas | PARTIAL | M to L |  |
| Voice chat and screen share over the netcode WebRTC transport | Needle | MISSING | M |  |

## Needs Scott or hardware first

| Gap | Why it waits | Size |
| --- | --- | --- |
| Visual scene editor (PlayCanvas Editor, Needle, Babylon Node Geometry and Render Graph editors) | A new product, not a package fix; needs Scott's scope | XL |
| Several canvases on one device | Needs a core change; core is frozen for features | L |
| WebXR VR and AR, XR passes, controller poses, XR layers | Never run on a headset or AR device; needs the hardware | M |
| WebGL2 layer: path tracers cannot finish on ANGLE D3D11, no integrated-GPU frame budget, Safari, Firefox and phones unmeasured | Needs those machines | L |
| Swappable physics plugin, floating-origin physics regions | Margo uses its own kernel by design | M |
| Deferred shading, voxel cone-traced GI | NOT PLANNED by decision; clustered forward and probes plus SSGI instead | XL |
| Flow Graph visual editor (the runtime is `KHR_interactivity`), USDZ interactive behaviours | Editor products | L |

The four audit tables behind this list (evidence paths per row) were working files and are not kept; rerun the audits
from this page's rows when it is next checked.
