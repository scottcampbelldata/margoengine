# Changelog

## Unreleased (1.0.0)

### Code hygiene phase 2, group C (HANDOFF 5k)

Lighting, post and environment packages follow [docs/conventions.md](docs/conventions.md). No behaviour change, no
WGSL change; every converted message keeps its old text and appends the fix.

Public API changes:

- `@margoengine/lod`: the `Vec3` type export is removed. `octDecode`, `frameDirection`, `frameBasis`,
  `Imposter.center` and `ImposterData.center` use math's `MutableVec3` (same shape); `octEncode`, `frameBasis` and
  `frameMatrix` take math's read-only `Vec3`, so read-only tuples are accepted too. `octWGSL` is no longer exported
  (it was internal).
- `@margoengine/environment`: `ColorInput` is math's, re-exported (`string | number | readonly number[]`, wider than
  the old 3-tuple); `srgbColor` still accepts only 3-component arrays at runtime. `HALF_MAX` was never exported from
  an entry and is now module-private.
- `@margoengine/sky`: colour options (`lighting.color`, `sunset`, `moon.color`, `ambient`, `fog.color`, the `night`
  colours and `moonDirection`) are typed as math's `Vec3` (same shape as the old local `Color`).
- `@margoengine/terrain`: `TerrainColorOptions` colours are math's `Vec3`; `HeightField` is math's, re-exported.
- `@margoengine/vfx/texture`: the feature export `texture` is renamed `textureFeature` (it clashed with
  `@margoengine/shader`'s `texture()` node). Pass it as `new VFX(options, {texture: textureFeature})`; the
  `VFXFeatures` key stays `texture`. The missing-feature TypeError now names `textureFeature`.
- Private aliases that appear in the published `.d.ts` were renamed per package (`PostPassContext`,
  `ScatterPassContext`, `ShadowPassContext`, `SkyPassContext`, `TerrainPassContext`, vfx `OwnedResources`); type-only.
- Errors that were bare `Error` are now `MargoError` with a `code` (`disposed`, `attached`, `state`, `unsupported`,
  `failed`), or `TypeError`/`RangeError` for malformed input (tonemap `.cube` parsing, environment
  `parseEnvironmentImage` format detection, TAA velocity primitives), in environment (outside the EXR/HDR/UltraHDR
  decoders and inflate, deferred until the gate-11 security work lands), post, creative, clustered, tonemap, shadows,
  taa, sky, water, terrain, dof, oit, toon, transitions, splats, vfx, scatter, lod, webgl and culling. A WebGPU
  requirement thrown by a disposed effect reports `code` `'disposed'`.
- `@margoengine/math` is now a `dependencies` entry of environment, sky, water, terrain, oit, toon, transitions, vfx,
  scatter, lod, webgl and culling (their types or runtime `MargoError` import come from it; `build-optional`
  externalizes it, so sky, terrain, vfx and scatter no longer inline the math helpers they use). dof and tonemap list
  it under `devDependencies` (their builds inline `MargoError`), like post, clustered, shadows, taa, splats and
  creative already did.
- TSDoc on every public export of these packages (purpose, units, ranges, defaults, errors thrown).

Tooling: `scripts/hygiene-allowlist.json` `names` gains `Environment` (environment's class and react's component).

### Code hygiene phase 2, group A (HANDOFF 5k)

Shared types, errors and names follow [docs/conventions.md](docs/conventions.md). No behaviour change; every message
that changed keeps its old text and appends the fix.

Public API changes:

- `@margoengine/math`: new type-only exports `Vec2`, `Vec3` (core's, re-exported), `Vec4`, `Quat`, `MutableVec2`,
  `MutableVec3`, `Mat4`, `HeightField`, `SphereLike`, `PlaneLike`, `BoxLike`, and `ColorInput` from the root. New
  `MargoError` / `MargoErrorCode` (root and `@margoengine/math/errors`). New entry `@margoengine/math/mesh` with
  `meshWorldMatrix`. The `vec3` helpers' return type is now named `MutableVec3` (same shape).
- `@margoengine/shader`: types renamed `Input` -> `NodeInput`, `Stage` -> `ShaderStage`, `TextureSource` ->
  `BindableTexture`. The free functions return typed nodes instead of `Node<any>`: `add`/`sub`/`mul`/`div`/`mod`
  return `Node<BinaryResult<A, B>>`, the component-wise built-ins (`abs`, `min`, `clamp`, `mix`, ...) `Node<Widest<A>>`,
  `length`/`distance`/`dot` the scalar of that (new exported types `Widest`, `BinaryResult`). `Store.buffer` is
  `StorageBuffer`. Using a stage-only node in the wrong stage throws `TypeError`; WebGPU-only and attach errors are
  `MargoError`.
- `@margoengine/points`: renamed `projectPoint` -> `projectToPixels`, `PickHit` -> `PointsPickHit`, `Blending` ->
  `PointsBlending`, `TextureSource` -> `PointsTextureSource`.
- `@margoengine/lines`: `ExpandOptions` -> `ExpandLineOptions`.
- `@margoengine/lines`, `@margoengine/points`, `@margoengine/text`: `parseColor`, `ColorInput` and `meshWorldMatrix`
  are re-exported from math (same behaviour, one definition).
- `@margoengine/geometry`: the `Vec2` and `Vec3` type exports are removed; use `MutableVec2` / `MutableVec3` from
  math (same shapes). `Vec` stays.
- `@margoengine/procedural`: `SurfaceOptions` -> `MarchingCubesOptions`; `HeightField` is math's, re-exported.
- `@margoengine/navigation`: the `Vector3` type is removed; `path()` takes and returns math's `Vec3Like` (same shape).
- `@margoengine/navmesh`: `Vec3` is math's, re-exported.
- `@margoengine/tween`: the `smoothstep` easing is renamed `easeSmoothstep`.
- Errors that were bare `Error` are now `MargoError` with a `code` in tween, ecs, fsm, wfc, input, cinematic,
  navigation, lines, text, points and shader, and an error of the same shape (`name` `MargoError`, `code`) in the
  shared code bundled into other packages (scene depth, asset loading, PBR hook composition, demo frame). Core and
  the stage facade are unchanged (frozen).
- `@margoengine/math` is now a `dependencies` entry of lines, text, points, geometry, procedural, navigation, navmesh,
  tween, ecs, fsm, wfc, input, cinematic and shader (their types or errors come from it).

Tooling: `noImplicitOverride` and `noFallthroughCasesInSwitch` are on in the shared tsconfig base
(`packages/gltf/tsconfig.json`), core and the stage facade; `override` was added where required (no emitted change).
`scripts/hygiene-allowlist.json` gains `errors` (frozen core + stage) and `names` (same vocabulary in two domains).
