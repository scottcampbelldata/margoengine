# Batch 56 wider scene-owner audit

Status: OPEN. Current syntactic snapshot includes the accepted stats repair
and the current-main rebase onto 449dd9676. This is a complete syntactic call inventory, not proof
that every candidate is a bug or that every plugin has correct lifetime.

The parser finds 182 actual removePlugin calls in package TypeScript sources:
71 resolve identity with sceneOf, 1 uses a stored scene/owner receiver whose
binding needs review, 3 are core scene-router implementation, and 107 require
registration/receiver inspection. The old 187-line text scan included signatures
and comments and came from older source. No calls or packages are silently
waived by this recount. No core edit is proposed. Physics remains on hold.

A second inventory finds 174 explicit EnginePlugin classes, all with dispose;
61 contain sceneOf(this) in disposal and 84 contain an active-engine-shaped
removal. These are syntactic categories, not exhaustive inheritance or dataflow
proof. Missing detachment can exist without any removePlugin call, as ScenePass
and RawShaders demonstrated. Existing schema does not statically encode scene
ownership. Research comparison and method: [clean-room record](../clean-room.md#batch-56-remaining-proof-and-owner-audit-2026-11-09).

Proven and repaired in this continuation: ComputePass, ScenePass, RawShaders,
all 11 terrain plugins and ComputeFrame. The real-engine suites cover direct
and owner removal, restoration, same-name isolation and replacement. Terrain's
new seven direct cases fail on the parent, with seven passing removal controls;
ComputeFrame's new direct case fails, with its removal control passing.

Terrain passes 107 units, all 15 package GPU commands and all 16 runtime README
examples. Compute passes 111 units, its native/compatibility owner dispatch
regression, all 132 browser checks (413 shader modules) and 21 README examples.
Shader acceptance is retained from the prior continuation. Five source guards
cover shader, compute frame and all terrain EnginePlugin classes. Three new
speed-policy guards protect deferred throughput without deferring correctness.
The wider audit remains OPEN. These results do not prove the remaining candidates.

For each candidate below, inspect setup/attach, bind the actual EnginePlugin
identity (including wrapper plugins), reproduce direct disposal and owner removal
with a same-name default plugin, restore and replacement, then fix the owning
optional package and run its unit/GPU/README gates. Active engine access during
setup may intentionally select that setup's scene; it needs context, not a blind
replacement. The remaining stored-owner call must be checked too.

Reproduce the candidate search with rg -n 'removePlugin\(' packages --glob
'**/src/**/*.ts', then parse CallExpression nodes rather than count text lines.
The lane-local JSON retains the full call and explicit-plugin inventories.

## Calls needing registration review

| Package | Calls | Locations and enclosing classes |
| --- | ---: | --- |
| animation | 8 | [Skin](../../packages/animation/src/skin.ts#L500), [MorphWeightPlayer](../../packages/animation/src/morph-gpu.ts#L326), [AnimationLOD](../../packages/animation/src/lod.ts#L261), [GLTFInteractivity](../../packages/animation/src/interactivity.ts#L289), [Animation](../../packages/animation/src/index.ts#L696), [Animation](../../packages/animation/src/index.ts#L870), [AnimationGroup](../../packages/animation/src/group.ts#L174), [GeometryCachePlayer](../../packages/animation/src/geometry-cache.ts#L535) |
| animator | 1 | [Animator](../../packages/animator/src/index.ts#L936) |
| biomes | 1 | [BiomeView](../../packages/biomes/src/view.ts#L1584) |
| cinematic | 2 | [Cinematic](../../packages/cinematic/src/index.ts#L293), [CameraBrain](../../packages/cinematic/src/brain.ts#L575) |
| clustered | 6 | [LocalShadows](../../packages/clustered/src/shadows.ts#L1138), [ProjectorLights](../../packages/clustered/src/projector.ts#L258), [Clustered](../../packages/clustered/src/index.ts#L644), [IESLights](../../packages/clustered/src/ies.ts#L436), [DirectionalLights](../../packages/clustered/src/directional.ts#L237), [AreaLights](../../packages/clustered/src/area.ts#L262) |
| controls | 4 | [TransformControls](../../packages/controls/src/transform.ts#L569), [<function>](../../packages/controls/src/orbit.ts#L859), [Controls](../../packages/controls/src/controls.ts#L187), [ArcballGizmo](../../packages/controls/src/arcball-gizmo.ts#L200) |
| creative | 2 | [Planet](../../packages/creative/src/planet.ts#L372), [GrassField](../../packages/creative/src/grass.ts#L475) |
| culling | 5 | [CulledModels](../../packages/culling/src/models.ts#L634), [CulledMeshes](../../packages/culling/src/meshes.ts#L443), [LodInstances](../../packages/culling/src/lod.ts#L369), [CulledInstances](../../packages/culling/src/index.ts#L669), [DynamicInstances](../../packages/culling/src/dynamic.ts#L815) |
| environment | 1 | [EnvironmentLighting](../../packages/environment/src/lighting.ts#L210) |
| gltf-pro | 2 | [GLTFTextureStream](../../packages/gltf-pro/src/texture-stream.ts#L273), [PBRModel](../../packages/gltf-pro/src/model.ts#L5223) |
| html | 2 | [HTMLTexture](../../packages/html/src/texture.ts#L530), [HTML](../../packages/html/src/index.ts#L556) |
| inspector | 2 | [Inspector](../../packages/inspector/src/index.ts#L907), [FrameDebugger](../../packages/inspector/src/frame.ts#L547) |
| labels | 1 | [LabelRenderer](../../packages/labels/src/renderer.ts#L706) |
| lighting2d | 6 | [SoftLighting2D](../../packages/lighting2d/src/soft.ts#L433), [Lighting2D](../../packages/lighting2d/src/index.ts#L417), [HeightLighting2D](../../packages/lighting2d/src/height.ts#L903), [GILighting2D](../../packages/lighting2d/src/gi.ts#L841), [EmissiveLighting2D](../../packages/lighting2d/src/emissive.ts#L582), [CookieLighting2D](../../packages/lighting2d/src/cookie.ts#L548) |
| lod | 2 | [<function>](../../packages/lod/src/auto.ts#L615), [<function>](../../packages/lod/src/auto.ts#L1051) |
| materials | 6 | [Transmission](../../packages/materials/src/transmission-pass.ts#L329), [StencilBuffer](../../packages/materials/src/stencil-buffer.ts#L155), [OpaqueColor](../../packages/materials/src/opaque-color.ts#L311), [NodeMaterialInstallation](../../packages/materials/src/nodes.ts#L494), [MaterialInstallation](../../packages/materials/src/index.ts#L413), [BatchedMesh](../../packages/materials/src/batched.ts#L473) |
| oit | 2 | [TransparentPass](../../packages/oit/src/pass.ts#L137), [TransparentDepth](../../packages/oit/src/depth.ts#L180) |
| physics | 2 | [Physics](../../packages/physics/src/physics.ts#L1209), [Physics](../../packages/physics/src/next/physics.ts#L896) |
| physics2d | 1 | [Physics2D](../../packages/physics2d/src/physics.ts#L630) |
| pixel | 1 | [Render3D](../../packages/pixel/src/render3d.ts#L361) |
| points | 1 | [OctreeCloud](../../packages/points/src/octree.ts#L623) |
| quality | 1 | [<function>](../../packages/quality/src/index.ts#L328) |
| ragdoll | 1 | [Ragdoll](../../packages/ragdoll/src/ragdoll.ts#L1211) |
| rigging | 2 | [<function>](../../packages/rigging/src/vrm.ts#L881), [<function>](../../packages/rigging/src/face.ts#L306) |
| scatter | 2 | [ScatterInstances](../../packages/scatter/src/instances.ts#L424), [Scatter](../../packages/scatter/src/index.ts#L1219) |
| scenery | 1 | [SkyLayer](../../packages/scenery/src/backdrop.ts#L155) |
| sciviz | 2 | [SciRenderer](../../packages/sciviz/src/render.ts#L268), [Axes](../../packages/sciviz/src/axes.ts#L206) |
| selection | 2 | [Picking](../../packages/selection/src/picking.ts#L975), [Selection](../../packages/selection/src/index.ts#L580) |
| shadows | 2 | [VirtualShadows](../../packages/shadows/src/virtual.ts#L1317), [Shadows](../../packages/shadows/src/index.ts#L1764) |
| sky | 8 | [Weather](../../packages/sky/src/weather.ts#L689), [WeatherFX](../../packages/sky/src/weather-fx.ts#L501), [VolumetricClouds](../../packages/sky/src/volumetric-clouds.ts#L601), [LightShafts](../../packages/sky/src/shafts.ts#L394), [HillaireSky](../../packages/sky/src/hillaire.ts#L588), [Sky](../../packages/sky/src/base.ts#L662), [AstroSky](../../packages/sky/src/astro.ts#L941), [AerialPerspective](../../packages/sky/src/aerial.ts#L334) |
| splats | 6 | [SplatLod](../../packages/splats/src/lod.ts#L467), [SplatLighting](../../packages/splats/src/lighting.ts#L271), [Splats](../../packages/splats/src/index.ts#L611), [SplatDepth](../../packages/splats/src/depth.ts#L168), [SplatBrush](../../packages/splats/src/brush.ts#L310), [Player](../../packages/splats/src/animate.ts#L137) |
| sprites | 3 | [SkeletalLayer](../../packages/sprites/src/skeletal.ts#L483), [SpriteLayer](../../packages/sprites/src/index.ts#L443), [BillboardLayer](../../packages/sprites/src/billboard.ts#L399) |
| tilemap | 2 | [TileMap](../../packages/tilemap/src/renderer.ts#L362), [GridTileMap](../../packages/tilemap/src/iso.ts#L287) |
| tiles | 2 | [TilesRenderer](../../packages/tiles/src/renderer.ts#L449), [TilesRenderer](../../packages/tiles/src/renderer.ts#L450) |
| toon | 3 | [ModelOutlines](../../packages/toon/src/models.ts#L444), [Toon](../../packages/toon/src/index.ts#L110), [Hatching](../../packages/toon/src/hatch.ts#L212) |
| vfx | 1 | [VFX](../../packages/vfx/src/base.ts#L1212) |
| video | 1 | [Video](../../packages/video/src/index.ts#L180) |
| viewcube | 1 | [ViewCube](../../packages/viewcube/src/index.ts#L562) |
| voxel | 2 | [VoxelStreamer](../../packages/voxel/src/stream.ts#L541), [VoxelRenderer](../../packages/voxel/src/render.ts#L1089) |
| voxel-pathtracer | 1 | [VoxelPathTracer](../../packages/voxel-pathtracer/src/tracer.ts#L718) |
| water | 2 | [Water](../../packages/water/src/index.ts#L1223), [FFTOcean](../../packages/water/src/fft.ts#L458) |
| weather | 3 | [SurfaceHook](../../packages/weather/src/scene-patch.ts#L188), [Hail](../../packages/weather/src/hail.ts#L421), [WeatherDrive](../../packages/weather/src/drive.ts#L204) |
| xr | 1 | [XR](../../packages/xr/src/index.ts#L487) |

## Stored scene/owner bindings to verify

- [<function>](../../packages/save/src/engine.ts#L482): scene.removePlugin(made.name)

Stats continuation: all four classes are reproduced and repaired with eight real-engine cases and a class-wide source guard. Package plus guard passes 95 checks; complete GPU and all eight runtime README examples pass. The collected full verify has 17 gate failures; all failed suites and compute units pass 244 checks after the gate repairs. Other full verify steps pass; no second full-green run is claimed. See the [stats receipt](../whitepaper/results/batch-56-stats-owner-20261109.json).

The expanded inheritance inventory identifies 23 locally resolved subclasses, 24 other setup-bearing classes, 35 unresolved bases (including unrelated non-plugins) and 18 named setup object expressions. These are additional syntactic candidates, not lifetime proof or a count of defects. Imported package bases, aliases, mixins and factory dataflow still require inspection. Lane-local owner-inheritance-inventory.json retains every candidate.

Save's stored scene removal is a proven bug: its factory attaches outside the target scene's setup scope. Three default controls pass and six secondary success/rollback cases fail before repair. The owning package fix is next; other owner groups remain unproved.

The fresh rebase inventory adds the upstream FFTOcean active-shaped removal to
the candidate list. Its registration/runtime ownership has not been accepted by
this audit; no defect or waiver is inferred from the syntactic category.
