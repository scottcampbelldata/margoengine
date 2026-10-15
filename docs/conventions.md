# Package conventions

Rules every Margo package follows for shared types, errors and export names (HANDOFF 5k gates 5 and 7, 1h.h).
`npm run hygiene` measures them; `scripts/hygiene-allowlist.json` holds the few justified exceptions.

## Shared types: one definition, in `@margoengine/math`

Type-only shapes used by more than one package are declared once in `@margoengine/math` (`packages/math/src/types.ts`)
and imported from there. Types are erased at build time, so this costs 0 runtime bytes.

| Type | Shape | Use |
| --- | --- | --- |
| `Vec2` | `readonly [x, y]` | 2D input points |
| `Vec3` | `readonly [x, y, z]` | 3D input points, directions, Euler angles. Declared in `@margoengine/core` (frozen, upstream of math) and re-exported by math. |
| `Vec4` | `readonly [x, y, z, w]` | homogeneous points, RGBA |
| `Quat` | `readonly [x, y, z, w]` | unit quaternions (`setQuaternion`) |
| `MutableVec2`, `MutableVec3` | `[x, y]`, `[x, y, z]` | freshly allocated results the caller may modify (geometry curves, `@margoengine/math/vec3`) |
| `Mat4` | `ArrayLike<number>` | column-major 4x4 (`camera.matrix`, world matrices) |
| `ColorInput` | `string \| number \| readonly number[]` | `'#rrggbb'`, `'#rgb'`, `0xrrggbb` (sRGB) or linear `[r, g, b]`; decode with `parseColor` |
| `HeightField` | `(x, z) => number` | ground height samplers |
| `Vec2Like`, `Vec3Like`, `Vec4Like` | `{x, y}`, `{x, y, z}`, `{x, y, z, w}` | object-shaped input (`mesh.position`, Recast points) |
| `SphereLike`, `PlaneLike`, `BoxLike` | `{center, radius}`, `{normal, constant}`, `{min, max}` | structural input of the bounds classes |

Rules:

- Readonly tuples for input, `Mutable*` for results the caller owns. A mutable tuple is accepted wherever the readonly
  one is.
- A package that keeps a public name for one of these re-exports it (`export type { Vec3 } from '@margoengine/math'`),
  never redeclares it.
- A package whose public `.d.ts` uses a math type, or that throws `MargoError`, lists `@margoengine/math` under
  `dependencies` (consumers need it for the types). Bundling is the build script's choice: `scripts/build-optional.js`
  keeps dependencies external (one shared copy at runtime); packages with their own build scripts (lines, points,
  text, geometry) bundle the math helpers they use, as before.

## Errors

| Situation | Throw |
| --- | --- |
| An argument has the wrong type or shape, or a node is used in the wrong shader stage | `TypeError` |
| A value is out of range, non-finite, or over a limit | `RangeError` |
| Anything else | `MargoError` with a `code` |

`MargoError` (`import { MargoError } from '@margoengine/math'`, or `@margoengine/math/errors`) extends `Error` with
`name = 'MargoError'` and a stable `code`:

| `code` | Meaning |
| --- | --- |
| `disposed` | used after `dispose()` |
| `attached` | already attached to, or owned by, another engine, plugin or renderer |
| `state` | not valid right now: re-entrant call from a callback, missing prerequisite, stale handle |
| `unsupported` | the browser or device lacks something needed: WebGPU, OffscreenCanvas, a shader hook |
| `failed` | the operation ran and produced no result: no solution within the budget, a failed request |

Branch on `error.code`, not on the message. Messages name the subject, the problem and the fix, in that order:
`'Input is disposed; create a new Input'`. Packages bundle their own copy of the class, so `MargoError` matches by
name (`static [Symbol.hasInstance]`): `error instanceof MargoError` holds for any package's copy. Do not subclass it.
`@margoengine/loaders` has its own `LoaderError` (format plus code) for malformed input.

`packages/shared` is copied into packages that may not depend on math, so it cannot import the class: it throws
`margoError(code, message)` from `packages/shared/errors.js`, which builds the same shape (name `MargoError`, `code`).

Exception: `@margoengine/core` (21 sites) and the stage facade `margoengine` (2) keep their bare `Error` throws. Core +
stage is 19,999 of the 20,000-byte gzip budget and frozen for v1.0.0; Scott's decision, listed in the allowlist.

## Names exported by more than one package

A name declared and exported by two packages must mean the same thing, or be renamed. Decisions:

| Name | Packages | Decision |
| --- | --- | --- |
| `add`, `sub`, `dot`, `cross`, `length`, `normalize`, `clamp`, `smoothstep` | math, shader | Kept: math's work on CPU numbers/arrays (three.js `MathUtils` names), shader's build GPU nodes (WGSL/TSL names). Note the argument orders differ for `smoothstep`: math `(x, min, max)`, shader `(low, high, x)` as WGSL. Allowlisted. |
| `fbm`, `ridged`, `domainWarp` | procedural, shader | Kept: CPU noise and its GPU twin in `@margoengine/shader/noise` share names on purpose. Allowlisted. |
| `multiplyMatrices` | math, animation | math's `multiplyMatrices(a, b, out)` (out = a * b, `out` last like every math helper) is canonical. animation's `(out, a, b)` wrapper is removed or renamed by group B. |
| `parseColor`, `ColorInput`, `meshWorldMatrix`, `Mat4` | lines, points, text | One definition in math (`math/color`, `math/mesh`, `math`); the packages re-export it. |
| `Input`, `Stage`, `TextureSource` (shader) | input, margoengine, materials, points | Shader's renamed: `NodeInput`, `ShaderStage`, `BindableTexture`. |
| `projectPoint`, `PickHit`, `Blending`, `TextureSource` (points) | labels, selection, materials, shader | Points' renamed: `projectToPixels`, `PointsPickHit`, `PointsBlending`, `PointsTextureSource`. |
| `smoothstep` (tween) | math, shader | Tween's easing renamed `easeSmoothstep`. |
| `ExpandOptions` | lines, procedural | lines' renamed `ExpandLineOptions` (its function is `expandLine`). |
| `SurfaceOptions` | procedural, machinery | procedural's renamed `MarchingCubesOptions`. |
| `Vector3` (navigation) | math | Navigation takes math's `Vec3Like`; math's `Vector3` is the class. |
| `loadGLTF`, `parseGLTF` | gltf, gltf-pro | Open, group B (HANDOFF "API rough edges" item 7). |
