# Changelog

## Unreleased (1.0.0)

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
