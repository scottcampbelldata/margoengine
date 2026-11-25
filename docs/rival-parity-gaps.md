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
| Colour curves in image processing (`Grade` curves and wheels already existed; `ranges` added) | Babylon | DONE | S | 67827878e |
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
| Particle fluid solver (`ParticleLiquid` only draws particles today) | three.js, Babylon fluid rendering | PLANNED: FLUID-01 and FLUID-02 in [physics-solvers.md](physics-solvers.md) | L |  |
| Soft-body defects KB-SOFT-LIGHT1 and KB-SOFT-ITER1, plus a cloth render bridge | three.js, Babylon | DONE (KB-SOFT-LIGHT1, KB-SOFT-ITER1, cloth render bridge `@margoengine/gltf/soft-mesh`) | M | 0a4570d8e, d640a7242, 606261f00 |
| Breakable / fracturing bodies | three.js `physics_ammo_break` | PLANNED: BREAK-01 in [physics-solvers.md](physics-solvers.md) | M |  |
| Swappable physics plugin (one API over different engines) | Babylon physics v2 plugins | PLANNED: "Other engines as solvers", [physics-framework.md](physics-framework.md) section 5 | M |  |
| Floating-origin physics regions (large worlds without precision loss) | Babylon | PLANNED: "Large worlds", [physics-framework.md](physics-framework.md) section 2 | M |  |
| WebXR AR GPU depth occlusion (real objects hide virtual ones; only CPU depth today) | three.js, Babylon | EXISTS (`packages/xr/src/occlusion.ts`: CPU and `gpu-optimized` depth, `feather` soft edge, `npm run test:gpu:occlusion`; not yet run on a device) | M | 25c4bbbfe |
| WebXR AR reflection cube map from light estimation, as the environment's specular | three.js, Babylon | DONE (`@margoengine/xr/reflection`; not yet run on a device) | M | dbbd7fc7f |
| WebXR VR and AR passes, controller poses and XR layers not covered by the stand-in sessions | three.js, Babylon | DONE (`@margoengine/xr/session`: blend mode, visibility, frame rate, play-area bounds; layer `quality`, `blendTextureSourceAlpha`, `chromaticAberrationCorrection`, `mipLevels`. Multiview not built, see limits.md; not yet run on a headset) | M | 5f1f6ca25 |
| AR Quick Look and Scene Viewer launch where WebXR is absent | model-viewer | DONE (`@margoengine/xr/launch`: Quick Look `rel="ar"` link, Scene Viewer intent, fallback; URL scheme checks; not yet run on a phone) | S | 73d8e2269 |
| USDZ interactive behaviours (Quick Look tap and trigger actions in the USDZ exporter) | Apple AR Quick Look | MISSING | M |  |
| SVG from an engine scene (sciviz writes SVG from supplied geometry only) | three.js SVGRenderer | PARTIAL | M |  |
| WebXR multiview (both eyes in one pass where the device and binding offer it, a view per eye otherwise) | three.js, Babylon | MISSING | M |  |

## Lane C: scene, assets, text and formats

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| Asset containers: load, add, remove and duplicate a set of objects as one unit, plus scene save and load | Babylon | DONE (scene save and load already existed: `save/src/engine.ts`) | M | f19d13852 |
| Layer sort modes (back-to-front, front-to-back, manual) | PlayCanvas | DONE (`setMaterialSortModes`: per engine, opaque and transparent material meshes) | S | 8aaf6a290 |
| Blob shadow and planar `ShadowMesh` | three.js, drei | DONE (`@margoengine/materials/fake-shadows`; pixels not GPU-checked) | S | 196b41134 |
| drei helpers: Float, Center, Resize, ScreenSizer, interaction prompt | drei, model-viewer | DONE (`@margoengine/scene/helpers`) | S each | b83eba2dc |
| Font formats: WOFF and WOFF2, CFF `.otf`, GPOS kerning | three.js TextGeometry, troika | DONE | M | d2f0084e2 |
| Configurable `loadTexture` caps (fixed at 16.7 MP and 64 MiB) | three.js | DONE (`maxBytes`, `maxPixels`; cube maps and restore take them too, cd259602f, e1c8eff03) | S | 8aaf6a290 |
| 3MF textures, texture `center` on the texture, live metaball object | three.js | LIMIT | S each |  |
| Webcam / MediaStream texture outside React | three.js | EXISTS: `new Texture(video)` takes any HTMLVideoElement (`packages/materials/src/built-material.ts`, live upload per frame), and `prepareVideo` accepts a video whose `srcObject` is a getUserMedia stream (`packages/video/src/playback.ts`); no React needed | S |  |
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
| Gaussian splat part visibility and compound mode, interactive splat editing | Babylon, PlayCanvas | DONE | M to L | b78b414f5 (SplatEditSession, packages/splats/src/session.ts); compound EXISTS packages/splats/src/set.ts, brush EXISTS packages/splats/src/brush.ts, visibility 5fee46878 |
| Voice chat and screen share over the netcode WebRTC transport | Needle | DONE | M | 8092aaee6 |
| WebGL2 layer: voxel and mesh path tracers on ANGLE D3D11 (Safari, Firefox, phones and the integrated-GPU frame budget recorded as not yet measured in [limits.md](limits.md)) | three.js WebGLRenderer, Babylon WebGL2 | DONE | L | 508b6c1cc (warm draw restored), 7144a4fc0 (no synchronous query behind a warm compile); `test:gpu:d3d11` and `test:gpu:mesh-pbr` pass on an Intel Arc 140V, Chrome 157. The serial draw-time fxc compile left is ANGLE's (KB-L5a-10) |

### Geospatial camera: best in open source

Scott, 2026-11-25: most demos are open world, so `@margoengine/controls/geospatial` must beat every open-source
geospatial camera. Rivals are judged by their public docs and feature lists only.

| Gap | Rival | Status | Size | Landed |
| --- | --- | --- | --- | --- |
| 1. Surface-true picking: zoom-to-cursor, rotate-around and pan grab the real surface hit (BVH on terrain, tiles, meshes), anchored drag | CesiumJS, 3D Tiles renderer GlobeControls, Google 3D map controls | DONE | M | 5f77e327e |
| 2. Collision of the whole near plane against terrain, tiles and meshes; minimum clearance; underground mode; collision while flying and during flyTo | CesiumJS, Babylon geospatial camera | DONE | M | 4840d19ed |
| 3. Navigation modes with smooth switches: globe orbit, local orbit, first-person fly, walk/drive with ground following, top-down map, cinematic path | CesiumJS, deck.gl views, Google 3D map controls | MISSING | L |  |
| 4. flyTo on the van Wijk and Nuij 2003 optimal path, duration from distance, easing, AbortSignal, cancel on input; flyToBoundingSphere, fit-to-bounds | CesiumJS, MapLibre GL `flyTo`, deck.gl `FlyToInterpolator` | DONE | M | fc34f60cd |
| 5. Feel: per-axis inertia, height-scaled speed, presets (Cesium-like, map-like, CAD/DCC), touch, keyboard, gamepad, pen, reduced motion | CesiumJS, MapLibre GL, Google 3D map controls | MISSING | M |  |
| 6. Planet scale: near/far and depth from street level to orbit with the floating origin, no jitter at large coordinates | CesiumJS, 3D Tiles renderer | MISSING | M |  |
| 7. Heights above terrain, ellipsoid and geoid; ENU heading/pitch/roll; north-up reset; compass and state events; view save/restore with a URL hash | CesiumJS, MapLibre GL hash, Google 3D map controls | MISSING | M |  |
| 8. Works out of the box with terrain, tiles (a tiles height query) and biomes open worlds, zero config | CesiumJS, 3D Tiles renderer | MISSING | M |  |
| 9. Follow camera for moving targets (chase, orbit-follow, side, flyby, lock-on with lead room, flock framing), critically damped springs, banking, surface clearance, built on third-person | CesiumJS `trackedEntity`, Babylon `FollowCamera` | MISSING | L |  |

## Needs Scott or hardware first

| Gap | Why it waits | Size |
| --- | --- | --- |
| WebXR VR and AR, XR passes, controller poses, XR layers | Being built by lane B without a device (Scott, 2026-11-25: "Anything that's waiting on hardware, just build it, push it to main, and assume that it works") | M |
| Deferred shading, voxel cone-traced GI | NOT PLANNED by decision; clustered forward and probes plus SSGI instead | XL |

The visual scene editor, several canvases on one device and the visual flow-graph editor are in
[do-later.md](do-later.md), out of every current list (Scott, 2026-11-25).

The four audit tables behind this list (evidence paths per row) were working files and are not kept; rerun the audits
from this page's rows when it is next checked.
