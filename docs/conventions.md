# Package conventions

Rules every Margo package follows for shared types, errors and export names.
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
| `ColorInput` | `string \| number \| readonly number[]` | `'#rrggbb'`, `'#rgb'`, `0xrrggbb` (sRGB), CSS `'color(display-p3 r g b)'` (also `srgb`, `srgb-linear`, `display-p3-linear`) or linear sRGB `[r, g, b]`; decode with `parseColor`. A P3 colour outside sRGB decodes to negative linear sRGB channels and keeps them; linear arrays must stay non-negative. Light colours (clustered, area, directional) may be negative per channel with a luminance of 0 or more; core's sun takes only sRGB, so give it `clipToSRGB(rgb)`. |
| `HeightField` | `(x, z) => number` | ground height samplers |
| `Vec2Like`, `Vec3Like`, `Vec4Like` | `{x, y}`, `{x, y, z}`, `{x, y, z, w}` | object-shaped input (`mesh.position`, navigation path endpoints) |
| `SphereLike`, `PlaneLike`, `BoxLike` | `{center, radius}`, `{normal, constant}`, `{min, max}` | structural input of the bounds classes |

Rules:

- Readonly tuples for input, `Mutable*` for results the caller owns. A mutable tuple is accepted wherever the readonly
  one is.
- A package that keeps a public name for one of these re-exports it (`export type { Vec3 } from '@margoengine/math'`),
  never redeclares it.
- A package whose public `.d.ts` uses a math type, or that throws `MargoError`, lists `@margoengine/math` under
  `dependencies` (consumers need it for the types). Bundling is the build script's choice: `scripts/build-optional.js`
  keeps dependencies external (one shared copy at runtime); packages with their own build scripts (lines, points,
  text, geometry) bundle the math helpers they use, as before. Exception: a package whose build inlines math (the
  default `build-modern` pipeline, `build-postfx.js`, creative's script) and whose `.d.ts` uses no math type keeps math
  under `devDependencies` (build order only; consumers never load it): post, clustered, shadows, taa, splats, creative,
  dof, tonemap. The tonemap test pins "no `dependencies`".
- A private alias that shows up in a published `.d.ts` (`type Context = Extract<PassContext, {backend: 'webgpu'}>`)
  is still a declaration there: give it a package-specific name (`SkyPassContext`, `PostPassContext`, ...) rather
  than the same name in many packages. Core (frozen) cannot host a shared one.

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
| `timeout` | a step that should finish never settled within its time limit: a stalled WebGPU startup step |

Branch on `error.code`, not on the message. Messages name the subject, the problem and the fix, in that order:
`'Input is disposed; create a new Input'`. Packages bundle their own copy of the class, so `MargoError` matches by
name (`static [Symbol.hasInstance]`): `error instanceof MargoError` holds for any package's copy. Do not subclass it.
`@margoengine/loaders` has its own `LoaderError` (format plus code) for malformed input.
Likewise `@margoengine/procedural/expression` throws `VoxelExpressionError` (code `syntax`, `limit` or `evaluation`, with
the 1-based line and column) for faults in the expression text; its arguments follow the table above.

`packages/shared` is copied into packages that may not depend on math, so it cannot import the class: it throws
`margoError(code, message)` from `packages/shared/errors.js`, which builds the same shape (name `MargoError`, `code`).

### Short messages with a help link

Core and the stage facade follow the same table, but keep messages short and link each to its entry on
[margoengine.com/errors](https://margoengine.com/errors), where the cause and the fix are written out: they throw
`fault(code, message, anchor?)`, `typeError(message, anchor)` and `rangeError(message, anchor)` from
`packages/shared/errors.js` (bundled into their dist), which append `; see https://margoengine.com/errors#<anchor>`
(the anchor defaults to the code). The page is generated from `scripts/errors/entries.js` (`node
scripts/errors/page.mjs`); `tests/errors-page.test.js` checks that every link points at an entry, that every
MargoError code has one, and that the page matches the file. The quality gate counts a linked message as naming its
fix, and a link to a missing entry as naming none.

Packages may follow the same pattern: a short message, the same helpers, and their entries on the same page (add them
to `scripts/errors/entries.js`, one entry per message family). A package message without a link must name its fix
itself, as the table above says.

## Core freeze

`@margoengine/core` and the stage facade are frozen for v1.0.0 against new features, not against bug fixes (since
2026-10-24). A bug, an unsafe API (a throw that cannot be branched on, a race, a leak) or a message that names no fix
is fixed in core, with a test, inside the 25,000-byte core + stage gzip gate; record the bytes it costs. New
capabilities go in optional packages, and a fix that would add a capability is listed for the maintainer instead.

**Exception, the stage facade (Scott, 2026-10-27):** the stage is lifted from the freeze for one restructuring,
because it broke "pay only for what you import" and nothing is published yet, so no user is broken. Its ten
optional-package methods (`load`, `gltf`, `creative`, `scenery`, `sky`, `particles`, `effects`,
`environment`, `shadows`) held `import()`s that every app building a `Stage` reached (class methods are never
tree-shaken), so webpack and Turbopack failed on uninstalled optional peers. They moved into feature entries that take
the stage (`@margoengine/stage/gltf` `addGLTF`, `/sky` `addSky`, `/particles` `addParticles`,
`/effects` `addEffects`, `/environment` `addEnvironment`, `/shadows` `addShadows`; the whole-pack accessors became a
plain `import()`), and the root gained `stage.signal`. The stage root shrank (core + stage 22,781 -> 21,910 B gzip).
Core is untouched. The exception covers this one change; the freeze applies again after it.

## Names exported by more than one package

A name declared and exported by two packages must mean the same thing, or be renamed. Decisions:

| Name | Packages | Decision |
| --- | --- | --- |
| `add`, `sub`, `dot`, `cross`, `length`, `normalize`, `clamp`, `smoothstep` | math, shader (`dot` also compute) | Kept: math's work on CPU numbers/arrays (three.js `MathUtils` names), shader's build GPU nodes (WGSL/TSL names), compute's `dot` multiplies GPU arrays (NumPy's name). Note the argument orders differ for `smoothstep`: math `(x, min, max)`, shader `(low, high, x)` as WGSL. Allowlisted. |
| `fbm`, `ridged`, `domainWarp` | procedural, shader | Kept: CPU noise and its GPU twin in `@margoengine/shader/noise` share names on purpose. Allowlisted. |
| `multiplyMatrices` | math, animation | math's `multiplyMatrices(a, b, out)` (out = a * b, `out` last like every math helper) is canonical. animation's `(out, a, b)` wrapper is removed or renamed by group B. |
| `parseColor`, `ColorInput`, `meshWorldMatrix`, `Mat4` | lines, points, text | One definition in math (`math/color`, `math/mesh`, `math`); import it from there (the packages no longer re-export `meshWorldMatrix`). |
| `Input`, `Stage`, `TextureSource` (shader) | input, margoengine, materials, points | Shader's renamed: `NodeInput`, `ShaderStage`, `BindableTexture`. |
| `projectPoint`, `PickHit`, `Blending`, `TextureSource` (points) | labels, selection, materials, shader | Points' renamed: `projectToPixels`, `PointsPickHit`, `PointsBlending`, `PointsTextureSource`. |
| `smoothstep` (tween) | math, shader | Tween's easing renamed `easeSmoothstep`. |
| `ExpandOptions` | lines, procedural | lines' renamed `ExpandLineOptions` (its function is `expandLine`). |
| `Vector3` (navmesh/build) | math | `Navigation` takes math's `Vec3Like`; math's `Vector3` is the class. |
| `loadGLTF`, `parseGLTF` | gltf, gltf-pro | Open, group B. |
| `texture` (vfx) | shader | vfx's `@margoengine/vfx/texture` feature object renamed `textureFeature` (pass `{texture: textureFeature}`); shader's `texture()` node keeps the name. |
| `Environment`, `Sky`, `Bloom`, `SSAO`, `GTAO`, `SSR`, `SSGI`, `MotionBlur`, `LensFlare`, `SMAA`, `FXAA`, `Glitch`, `Afterimage`, `TAA`, `Tonemap`, `Shadows`, `AmbientLight`, `HemisphereLight`, `Fog`, `Scene`, `RenderView`, `BatchedMesh`, `DepthTexture`, `SceneTargets`, `OrbitControls`, `MapControls`, `ArcballControls` | environment, sky, post, taa, tonemap, shadows, core, materials, controls; react | Kept: the plugin or pass class and react's JSX component that adds it with the same options (React names components after what they render). Allowlisted. |
| `Vec3` (lod), `Color` (sky, terrain), `HeightField` (terrain) | math | Math's: lod uses `MutableVec3` / `Vec3`, sky and terrain colours are `Vec3`, terrain re-exports math's `HeightField`. |
| `PbrMaterial` | core, materials, react | Kept, one meaning: materials' `PbrMaterial` takes every core `PbrMaterial` option with the same meaning and adds maps and physical options, with a textured material's defaults (white, roughness 1, metalness 0, front side) rather than core's indigo double-sided placeholder; core's stays the constant-colour material of core meshes, and react's is the JSX element that builds core's. Allowlisted. |

## Quality gate

`npm run quality` (`scripts/quality-gate.mjs`, part of `npm run verify` and CI, about 6.5 s after a build) runs five
ratchets over `packages/`. Each has a baseline of today's known violations in `scripts/quality/baselines/<gate>.json`:
a gate passes on what its baseline records and fails on anything new or worse, naming the fix.

| Gate | Items | Fails when |
| --- | --- | --- |
| `sizes` | gzip budget per entry and worker (entry-sizes.json's method; budget = size + max(3%, 256 B)); `leak` = an entry that statically loads another package's entry of 10,000 B or more (core and math excepted) | an entry is over its budget or new; a new static leak (use `import()` instead) |
| `duplicates` | duplicated lines per package pair (6-line normalised windows, our own detector); `family` = a known algorithm copy (CRC table, GGX, hidden-ancestor walk, ...); `reexport` = a runtime value re-exported from another package | more copied lines, a new copy or a new re-export: move the code to one package or `packages/shared` |
| `tests` | a package without a verify test; an entry no test imports | a new package or entry without a test that imports it |
| `api` | from `npm run hygiene`: undocumented public export; `throw new Error(`; a throw message that names no fix (Errors, above) | a new one of each. `tests/api-conventions.test.js` keeps attach / dispose / `Symbol.dispose` at 0 with no baseline |
| `clean-room` | mentions of three.js, Babylon or another graphics library anywhere in `packages/**`; third-party `dependencies` / `peerDependencies` | a new mention (put comparisons in docs/ or benchmarks/) or a new third-party dependency |

Baselines only shrink. When you fix a violation the gate fails until you lock it in:
`npm run quality -- --gate=<gate> --update`. Growing a baseline (a new entry's budget, an accepted dependency) needs
`npm run quality -- --gate=<gate> --update --reason="why"`; the reason is appended to the file's `history`. Size budgets
only suggest shrinking. `--summary` prints the biggest offenders; `--details` writes every item and duplicate block to
`test-results/quality.json`.

## Browser suites end with `closeAll`

A script that starts a browser must end it through `closeAll` from `scripts/support/shutdown.mjs` (bug 30, bug 70): the
browser context and browser first, then the servers' connections, the servers, and the child processes' trees, all inside
one budget that throws `SHUTDOWN_TIMEOUT` naming what was still open. A plain `server.close()` waits for every
connection a browser holds, so a suite that passed every assertion could hang on its cleanup for ever. `launchBrowser`,
`openBrowser` and `startDevServer` already close that way. `tests/browser-teardown.test.js` (part of `npm run verify`)
fails for any script that starts a browser and an HTTP server of its own without `closeAll`.
