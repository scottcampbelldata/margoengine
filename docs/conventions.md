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
  `dependencies` (consumers need it for the types), and so does any package whose source imports math. Every build
  keeps a declared `@margoengine/math` and its subpaths external (`scripts/build-optional.js` does so for every
  declared dependency; `build-modern.js`, `build-postfx.js` and the packages' own build scripts through
  `scripts/support/math-external.mjs`), so an app
  holds one copy of math, and one `MargoError` class, however many packages it imports (KB-INL1; before 2026-11-26
  post, shadows, taa, creative, dof, tonemap and others kept math under `devDependencies` and each bundled its own copy).
- The packages on `SHARED_HELPERS` (`scripts/support/math-external.mjs`: controls, environment, shadows) also import
  `packages/shared/errors.js` and `hypot.js` from core's `@margoengine/core/extension` (`HELPERS_ENTRY`) instead of
  bundling them (KB-INL1 part B, Scott 2026-11-26): the build's `sharedHelpers` plugin turns those imports into the
  external entry, so the app holds one copy, core's. Such a package must declare core, and
  `tests/no-inlined-margo-error.test.js` fails on a copy or on a name core/extension does not export.
  `@margoengine/math/helpers` exports the same seven helpers for code that does not build on core.
  Module workers still bundle what they use: a worker reads no import map. `tests/no-inlined-margo-error.test.js`
  fails on a package dist that carries the class, or a package that imports math without declaring it.
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
| `version` | two copies of core meet: a package or plugin built against one core version is given an engine from another ([core-version-guard.md](core-version-guard.md)) |

Branch on `error.code`, not on the message. Messages name the subject, the problem and the fix, in that order:
`'Input is disposed; create a new Input'`. Packages import the class from math, but module workers and
`packages/shared` code carry their own copy, so `MargoError` matches by name (`static [Symbol.hasInstance]`): `error instanceof MargoError` holds for any package's copy. Do not subclass it.
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
scripts/errors/page.mjs`); `scripts/errors/check.mjs` checks that every link points at an entry, that every
MargoError code has one, that every literal message is listed under the entry it links to, and that the page matches
the file, for core, stage, compute, sciviz, ui, mcp, biomes and cache. `tests/errors-page.test.js` runs it, and so
does `npm run hygiene`, so the fast gate of any lane fails on an unlisted message even when it runs only its own
package tests (an unlisted sciviz message once reached `main` that way). The quality gate counts a linked message as naming its
fix, and a link to a missing entry as naming none.

Fix commits: `npm run hygiene` also checks every commit in `origin/main..HEAD` (override with
`HYGIENE_COMMIT_RANGE`; an empty range is skipped). A commit typed `fix` or `fix(scope)` must change a test file (under
a `tests/` or `test/` folder, or `*.test.*`) or carry a body line `Regression: <repo path>` naming a test file that
exists in that commit; otherwise hygiene fails naming the commit (`scripts/support/fix-regression.mjs`,
`tests/hygiene-fix-regression.test.js`). Commits already on `main` are never rewritten.

Optional packages use the same helpers and help page entries (add them to
`scripts/errors/entries.js`, one entry per message family), but the message itself
names the failing field, allowed range and fix. A help link supplements that
guidance; it does not replace it. Raise an optional entry's recorded ceiling with
before/after measurements rather than shorten diagnostics to fit. Core and the
stage root retain their size-limited message convention.

Every `margoengine.com` link in code, READMEs and docs names a page the site build produces and, after a `#`, an
anchor that page has; `npm run hygiene` fails on one that does not (`scripts/check-site-links.mjs`). Error help is at
`/errors#<id>`; package help is the package README at `/llms/packages/<package>.md` and a document of `docs/` is at
`/llms/docs/<path>.md`. There is no `/docs/<name>` page. A new demo page goes into `scripts/support/site-routes.mjs`,
which `scripts/build-site.js` builds from.

## Borrowed GPU objects

A `GPUTexture`, `GPUTextureView`, `GPUSampler` or `GPUBuffer` that the caller made and passed in is borrowed. It
belongs to the device that made it: WebGPU makes an object valid to use only with its own device, and a lost device
takes all its objects with it and raises no errors of its own (W3C WebGPU, sections 3.2.1 and 3.5.2). Nothing can
ask an object for its device, and a lost object cannot be revived. So after a device restore (`engine.rebootDevice()`,
or core's own recovery) the package still holds an object the new device rejects. One rule covers every option that
takes one:

1. Margo never destroys a borrowed object and never carries it to another device.
2. Every such option also takes `(device: GPUDevice) => T`, called once per device: at first use and again after
   each restore. READMEs show this form first. With it nothing is lost and nothing is reported.
3. A plain object held at a restore is dropped and the frame keeps drawing. A part that draws only through the object
   is skipped (a sprite or tile layer, decals, a flare image, terrain; a light pattern becomes no pattern). A map that
   only modulates falls back to what its slot uses when the option is left out (white, a flat normal, black, no dirt).
4. The owner reports once per lost object through `engine.onError`, never by throwing from a frame:
   a `MargoError` with code `'state'`, `'<Owner> <option> lost with the device; pass a function or call <setter>'`,
   linking to [margoengine.com/errors#borrowed-lost](https://margoengine.com/errors#borrowed-lost).
5. A new object goes in through the option's setter at any time, usually from the caller's own plugin
   `onDeviceRestored(engine)`. The setter records `engine.gpu` at that moment, so the order of the caller's hook and
   the owner's hook does not matter.
6. Not covered: per-frame getters `() => GPUTexture | undefined` (read live every frame), per-call arguments (core
   `RenderView.target`, a transition's frame target) and the caster, pick and draw records one package hands another
   each frame. A lost object handed in after the restore is the caller's error and takes core's validation path.

A caller's object that holds a device of its own, rather than one GPU object (a `GpuVoxelMesher` given to
`VoxelRenderer`), has a `setDevice(device)` method, and the owner it was given to calls it from its restore hook with
`engine.gpu`; the owner keeps the object and never disposes or remakes it. Used on its own, the caller calls it after
`engine.rebootDevice()`; until then its work waits and none goes to the lost device.

Owners build this from `packages/shared/borrowed.js`: `borrow(value, name, setter, device?)` makes a slot,
`lend(slot, device, engine)` returns what to bind (the function's result for this device, the plain object while its
device is in use, or `undefined` after the one report), `relend(slot, value, device)` is what a setter calls, and
`fix(slot, engine.gpu)` in `setup` ties an object given before attach to the device it was set up on.

An option that takes either a GPU object or an options object (`{ texture, sampler }`) tells them apart with
`isOptionObject(value)` from the same module: an options object is a plain object, and every GPU object, on either
backend, and every materials Texture is a class instance. Never by field names: the WebGL2 layer's texture keeps its GL
texture as `texture` and its views keep their texture there, so a `'texture' in value` test once bound the GL object
and threw on every frame (KB-COMPAT-RAWFIRST1).
`tests/borrowed-gpu.test.js` reads every `api/*.api.md`, finds each member that can hold one of the four GPU types, and
fails unless `scripts/borrowed-registry.json` lists it as `ruled` (its source imports `shared/borrowed.js`), `exempt`
with a reason, or `pending`; pending rows are open work tracked in docs/known-bugs.md (KB-RESTORE-BORROWED1).
The scan (`scripts/borrowed-sites.mjs`) throws, naming the report and line, on any head or statement it cannot read,
instead of skipping what follows: a type parameter default in a head, a comment line, a template literal over several
lines and an enum once hid 17 members without a word.

Rivals, from their public docs: Babylon.js rebuilds its own resources after a context loss and leaves the
application's buffers to `onContextRestoredObservable`; PlayCanvas fires `devicerestored` and resumes rendering while
the application regenerates GPU-made content; three.js offers `onDeviceLost` and an `onError` so errors do not
escalate. None of them stops drawing.

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

**Exception, `powerPreference` (Scott, 2026-10-29, "do the core add i agree"):** core gains one option,
`EngineOptions.powerPreference` (`'low-power'` | `'high-performance'`), which `GPURenderer.create` passes to
`requestAdapter` at creation and again on device restore, so an app can pick the integrated or discrete GPU on a
two-GPU PC. Unset keeps the old request (`'high-performance'`, nothing on Windows). Cost: core 21,077 -> 21,106 B gzip, core + stage 22,494 -> 22,524 B. The exception
covers this one option; the freeze applies again after it.

**Exception, one render pass for a package's frame (Scott, 2026-11-05: core may change if justified, documented and under the
size limit):** `FramePass.joins` and the context's `attach` let a package's pass take core's clear and resolve (perf-history
entry 51). No package can hold this: core owns the clear, the resolve target and the graph's order. Cost: core + stage
22,522 -> 22,815 B gzip. The exception covers this one change; the freeze applies again after it.

**Exception, `Engine.renderTarget` (Scott, 2026-11-05):** one read-only getter so `PBRModel.compile()` can build the key of a render
pipeline off the frame (perf-history entry 56). No package can hold it: the depth format and sample count live in the renderer's
private descriptor. It prevents no engine failure; it is a speed gain Scott approved. Cost: core + stage 22,815 -> 22,859 B gzip. The
exception covers this one getter; the freeze applies again after it.

**Bug fix, `engine.stats` after another camera (Scott, 2026-11-07):** the counts moved from instance collection to the frame, because
the collection after `engine.render({ camera })`, and the one a pick runs, overwrote them. No package can hold it: the overwrite runs in
core's private restore after every plugin hook, and a package would have to wrap `engine.render`. Cost: core 21,468 -> 21,487 B gzip,
core + stage 22,859 -> 22,878 B gzip. It adds no feature.

**Bug fix, failed allocations (Scott, 2026-11-07, "if its a bug it needs fixed if we go over thats fine"):** `Engine.retain` allocates
before it changes anything, `Renderer.add` replaces a held geometry new first, and restore, scene disposal, store growth and instance
collection no longer leave state half-changed when a step throws. No package can hold it: the batch table, the reference counts and the
renderer's buffers are core's private state, and `Mesh.setGeometry` runs inside core. Failure prevented: after a failed allocation the
next frame threw a `TypeError` and meshes already drawing stopped. Cost: core 21,487 -> 21,541 B gzip, core + stage 22,878 -> 22,930 B
gzip. The core cap moved to 21,542 B on Scott's ruling, one over the measurement; the 21,504 B it was documented at was never what the
build enforced (`21 * 1024 + 512` is 22,016 B), so the enforced cap went down. It adds no feature.

**Bug fix, a failed restore on a healthy device (Scott, 2026-11-07, "im not shipping s bugged core"):** `rebootDevice` configures the
canvas after every rebuild, in place of `GPURenderer`'s constructor doing it first. No package can hold it: `GPURenderer` and
`rebootDevice` are core, and the order of the steps is inside them. Failure prevented: after a failed restore the canvas named a destroyed
device, and every frame failed WebGPU's validation on a device that had been healthy. Cost: core 21,541 -> 21,561 B gzip, core + stage
22,930 -> 22,948 B gzip. The core cap moved to 21,562 B on the same ruling, one over the measurement. It adds no feature.

**Bug fix, CSS `#rgb` colours in core (Scott, 2026-11-07, "Change core"):** `hexColor` in `packages/shared/clear-color.js` reads
`#rgb` as CSS does (each digit doubled), so `PbrMaterial`, a scene's `clearColor` and a view's clear colour take `'#555'` as `'#555555'`.
The colour convention (`ColorInput` above) promises `#rgb`; core only passed six digits. Alpha forms stay refused: core colours have no
alpha. No package can hold it: core bundles the shared parser, and `PbrMaterial` and the clear colour run inside core. Failure prevented:
a valid CSS colour threw `Invalid Color`. Cost: core 21,561 -> 21,586 B gzip, core + stage 22,979 -> 23,013 B gzip. The core cap moved
to 21,587 B on the 2026-11-07 ruling, one over the measurement. It adds no feature.

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
| `loadGLTF`, `parseGLTF` | gltf, gltf/pbr | Open, group B. |
| `texture` (vfx) | shader | vfx's `@margoengine/vfx/texture` feature object renamed `textureFeature` (pass `{texture: textureFeature}`); shader's `texture()` node keeps the name. |
| `Environment`, `Sky`, `Bloom`, `SSAO`, `GTAO`, `SSR`, `SSGI`, `MotionBlur`, `LensFlare`, `SMAA`, `FXAA`, `Glitch`, `Afterimage`, `TAA`, `Tonemap`, `Shadows`, `AmbientLight`, `HemisphereLight`, `Fog`, `Scene`, `RenderView`, `BatchedMesh`, `DepthTexture`, `SceneTargets`, `OrbitControls`, `MapControls`, `ArcballControls` | environment, sky, post, taa, tonemap, shadows, core, materials, controls; react | Kept: the plugin or pass class and react's JSX component that adds it with the same options (React names components after what they render). Allowlisted. |
| `Vec3` (lod), `Color` (sky, terrain), `HeightField` (terrain) | math | Math's: lod uses `MutableVec3` / `Vec3`, sky and terrain colours are `Vec3`, terrain re-exports math's `HeightField`. |
| `PbrMaterial` | core, materials, react | Kept, one meaning: materials' `PbrMaterial` takes every core `PbrMaterial` option with the same meaning and adds maps and physical options, with a textured material's defaults (white, roughness 1, metalness 0, front side) rather than core's indigo double-sided placeholder; core's stays the constant-colour material of core meshes, and react's is the JSX element that builds core's. Allowlisted. |

## Quality gate

`npm run quality` (`scripts/quality-gate.mjs`, part of `npm run verify` and CI, about 25 s after a build) runs six
ratchets over `packages/`. Each has a baseline of today's known violations in `scripts/quality/baselines/<gate>.json`:
a gate passes on what its baseline records and fails on anything new or worse, naming the fix. One strict step,
`readme-types`, has no baseline: every example of every package README and guide must type-check against the built
packages (`npm run check:readmes` prints the same list; its known list only shrinks). It runs here, in every fast gate,
because a change to one package can break another package's example while a lane runs only its own package tests; on
2026-11-18 ten such errors were on main, seen only by the full verify after the push.

| Gate | Items | Fails when |
| --- | --- | --- |
| `sizes` | gzip budget per entry and worker (entry-sizes.json's method; budget = size + max(3%, 256 B)); `leak` = an entry that statically loads another package's entry of 10,000 B or more (core and math excepted) | an entry is over its budget or new; a new static leak (use `import()` instead) |
| `duplicates` | duplicated lines per package pair (6-line normalised windows, our own detector); `family` = a known algorithm copy (CRC table, GGX, hidden-ancestor walk, ...); `reexport` = a runtime value re-exported from another package | more copied lines, a new copy or a new re-export: move the code to one package or `packages/shared` |
| `tests` | a package without a verify test; an entry no test imports | a new package or entry without a test that imports it |
| `api` | from `npm run hygiene`: undocumented public export; `throw new Error(`; a throw message that names no fix (Errors, above) | a new one of each. `tests/api-conventions.test.js` keeps attach / dispose / `Symbol.dispose` at 0 with no baseline |
| `clean-room` | mentions of three.js, Babylon or another graphics library anywhere in `packages/**`; third-party `dependencies` / `peerDependencies` | a new mention (put comparisons in docs/ or benchmarks/) or a new third-party dependency |
| `shader-comments` | per package: comments still inside the WGSL or GLSL strings of its built `dist` (.js and .d.ts), each literal the build strip has to leave whole counting one (see Shader comments, below) | any comment ships: rebuild, or move a comment that runs into an interpolation or the end of its string out into the JavaScript |

Baselines only shrink. When you fix a violation the gate fails until you lock it in:
`npm run quality -- --gate=<gate> --update`. Growing a baseline (a new entry's budget, an accepted dependency) needs
`npm run quality -- --gate=<gate> --update --reason="why"`; the reason is appended to the file's `history`. Size budgets
only suggest shrinking. `--update` leaves the size budgets of a package whose dist is stale (its build stamp no longer
matches the checked-out sources, as after a rebase onto other lanes' work) as recorded, and says how many it kept;
rebuild that package to update them. `--summary` prints the biggest offenders; `--details` writes every item and duplicate block to
`test-results/quality.json`.

### Shader comments

Write WGSL and GLSL comments in the source as usual: every package build strips them from the strings it ships
(`scripts/shader-comments.mjs`, run beside `declarePackageCore` by every build script; KB-WGSL1). The strip follows the
WGSL comment grammar (W3C WGSL, section 3.3 Comments and 3.2 Line Breaks; block comments nest) and GLSL ES 3.00.6
section 3.4 (block comments do not nest; GLSL text with a backslash is left whole for line continuation). A comment
leaves its line breaks, or one separating space, so every token keeps its text, order and line number; compilation
messages and the inspector's error placement still point at the right line. Rules worth knowing:

- Only string and untagged template literals that classify as WGSL or GLSL are touched. Each piece between
  interpolations is stripped on its own, so a comment that runs into `${...}` or to the end of its string leaves the
  whole literal as written, and the `shader-comments` gate fails: move that comment into the JavaScript beside it.
- A comment that code finds its place by (`code.split('//INDICES')`, `edit('// One lobe', ...)`) stays: any comment
  starting with the comment text of another string in the package's `src/` is an anchor.
- Every rewrite is checked token for token before it is written, and `tests/shader-comments.test.js` checks every
  shader in `packages/*/src` and proves that broken strips are caught. Text-patching code should still search code, not
  comments.

## API lock

`api/lock.json` and `api/breaks.json` are explicitly inert file-class records for GPU
selection, alongside API snapshots. Their contents still pass mandatory `api:check`.
Unknown API JSON paths remain unclassified and fail `tests/file-classes.test.js`;
that test also checks every tracked path and both named records. Reproduce with
`node --test --test-timeout=120000 tests/file-classes.test.js tests/check-merge-affected.test.js`.
Clean-room basis: D. Richard Kuhn, Raghu N. Kacker and Yu Lei, *Practical
Combinatorial Testing*, NIST SP 800-142 (2010),
https://csrc.nist.gov/pubs/sp/800/142/final, for independent input-space coverage;
and the Git project, *git-ls-files* (2026), https://git-scm.com/docs/git-ls-files,
for the authoritative tracked inventory. Compared a broad API-directory exception
with named records; named records preserve rejection of unknown inputs.


Run `npm run api:check` after the final rebase. New or extended APIs need `npm run api:update` output in
the same commit. Never edit `api/*.api.md` or `api/lock.json` by hand. Exports maps define coverage: every
non-alias entry needs a TypeScript report with no unresolved exports. Missing manifests/exports require an
explicit directory in `lock.json`'s `internal` list. TSDoc stays in hygiene and quality's zero-tsdoc API baseline.
Current internal directories are shared TypeScript, the Rust-only kernel crate and the retired webgl directory
containing licence/notice files. The latter two are explicit inventory exceptions, not user-facing JS packages.

The report reads cross-package declarations through `node_modules/@margoengine/*`, so those links must point at
this checkout's `packages/`. A worktree that junctions the main checkout's whole `node_modules` folder reads the
main checkout's packages instead, and every cross-package re-export came out as `from "undefined"` (15 reports
"changed" on a main that matched, KB-API-FOREIGN1). `api-report.js` now stops with the list of foreign links
before it reads anything (`foreignWorkspaceLinks` in `scripts/api-report-scope.mjs`,
`tests/api-report-foreign-links.test.js`). Give a worktree its own `node_modules` folder whose third-party entries
are junctions to the main checkout's and whose `@margoengine/*` entries are junctions to its own `packages/`, as
`linkModules` in `scripts/fresh-clone-check.mjs` does.

Day 0 locks every existing and future entry of core and stage. Every other reported package is in `watch`,
the conservative fallback to the private tracker. Watch diffs print `would fail:` and pass compatibility,
except an export or member added without `npm run api:update`, which fails `api:check` like any unrecorded change;
coverage failures still fail. After one green local CI run and no lane report of trouble, the coordinator
can promote watch packages to locked, recording their date and batch in `ticked`. Day 1 is separate work.

Signatures are compared as types: a destructured parameter (`load({ signal }?: Options)`) counts as one parameter of
its type, whatever names the pattern lists, so adding a property to an options object and reading it from the pattern
is not a break (`scripts/api-lock.mjs`, `withoutBindings`; `tests/api-lock.test.js`).

Removals, renames and changes to existing declarations, class/interface members, enum values, overloads,
unexported types or global blocks break locks. So do added required parameters, optional-to-required changes
and added `readonly`. New exports/members/overloads, trailing optional parameters, required-to-optional
changes and local-to-exported type promotion are compatible. Imports and member order do not affect
compatibility. Compatible textual differences still need `api:update` for locked/unlisted packages.
This is conservative declaration-text analysis, not subtype inference or a runtime behavioral guarantee.

Intentional breaks need a maintainer decision and an `api/breaks.json` record: `entry` (full import specifier), `symbol`,
`was` (SHA-1's first eight hex characters of the old LF-normalized, trimmed declaration block), `change`
(`removed`, `renamed`, `signature`), `reason`, `date`, `approved` (`Scott YYYY-MM-DD`). Diagnostics print a
record template with the exact hash. Members hash their member block; exports hash the whole declaration.
Renames are conservatively removal plus addition. A changed old hash cannot reuse the approval.
Update preflights the entire selection and writes no reports or surface when a locked break is unapproved.

`tests/api-lock.test.js` proves classification, overload/depth handling, one-shot approval, watch warnings,
coverage failures, zero TSDoc baseline and parsing every committed report. No runtime/GPU code changes.

Clean-room research (public descriptions only; no source code or companion repositories read):

- Tom Preston-Werner, *Semantic Versioning 2.0.0* (2013), [specification](https://semver.org/): separate
  incompatible contracts from compatible additions.
- Microsoft TypeScript team, *Declaration Merging* and *More on Functions* (living handbook, consulted 2026),
  [merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html),
  [functions](https://www.typescriptlang.org/docs/handbook/2/functions.html): name/kind grouping, overloads and optional parameters.
- Rush Stack contributors, *The API report* (living documentation, consulted 2026),
  [overview](https://api-extractor.com/pages/overview/demo_api_report/): committed, reviewable snapshots;
  Margo implements its own parser without that dependency.
- Lyuye Zhang, Chengwei Liu, Zhengzi Xu, Sen Chen, Lingling Fan, Bihuan Chen and Yang Liu,
  *Has My Release Disobeyed Semantic Versioning? Static Detection Based on Semantic Differencing* (ASE 2022),
  [paper](https://arxiv.org/abs/2209.00393): signature equality alone cannot prove behavior, so package tests remain necessary.
- Steven Raemaekers, Arie van Deursen and Joost Visser, *Semantic Versioning versus Breaking Changes:
  A Study of the Maven Repository* (SCAM 2014), [paper](https://doi.org/10.1109/SCAM.2014.30):
  compare actual declarations rather than trust version labels.

## Browser suites end with `closeAll`

A script that starts a browser must end it through `closeAll` from `scripts/support/shutdown.mjs` (bug 30, bug 70): the
browser context and browser first, then the servers' connections, the servers, and the child processes' trees, all inside
one budget that throws `SHUTDOWN_TIMEOUT` naming what was still open. A plain `server.close()` waits for every
connection a browser holds, so a suite that passed every assertion could hang on its cleanup for ever. `launchBrowser`,
`openBrowser` and `startDevServer` already close that way. `tests/browser-teardown.test.js` (part of `npm run verify`)
fails for any script that starts a browser and an HTTP server of its own without `closeAll`.

## Scripts that download

A script that downloads or installs anything reads its arguments before it does any work: `--help` prints usage and
exits 0, and an argument it does not take prints the error and usage and exits 2. Neither one reaches the network or
writes a file. JavaScript uses `downloadArguments` from `scripts/support/download-arguments.mjs` and runs its body only
when that returns values; Python calls `argparse` before its first request. Add the script to
`tests/download-script-arguments.test.js`, which runs each one with the network and file writes refused and fails on an
unlisted script that downloads. Never run one to find out which flags it takes: read it.

## Lifecycle repair audit (2026-11-10)

Engine-bound factories are additive convenience APIs. Construction that already registers or installs a
wrapper is called once; plugin factories register through the owning engine and dispose a newly created
resource if registration fails. GPULabelLayer and LivePageBridge detach their registrations on disposal.
LensDrops.attach lazily loads the optional post/stack peer and joins the scene's PostStack (or makes one, which
goes with its last effect); disposing the returned lens takes it out of the stack and removes its registration. It accepts an optional AbortSignal before and after the load.
ImportedLightmapInstallation.attach takes the model, bake and optional node indices, matching applyLightmap.
StereoOutput, Fur, AssetInstaller, SceneEvents, ValueClipPlayer and VoxelObjects factories retain their
constructor defaults and ownership. AnimationMixer.attach takes the engine and mixer root.

ViewportKeying exposes a prototype disposal method, bound per instance so extracted callbacks still work.
AutoScene's disposal symbols return the same cleanup promise as dispose(); use await using for a scope
that waits for asynchronous cleanup. A plain using scope starts cleanup but does not await its completion.
The API-report audit follows local unexported base classes, with cycle protection, while checking exported
engine-bound classes. Its fixture includes valid inherited, missing and cyclic factories.

Clean-room research compared the standard's scope cleanup protocol with TypeScript's inherited static
members and promise return semantics. No companion code or other engine sources were consulted:

- Ron Buckton and TC39, *ECMAScript Explicit Resource Management* (2026),
  https://tc39.es/proposal-explicit-resource-management/: synchronous disposal does not await a return value;
  asynchronous disposal is the awaited lifetime protocol.
- Microsoft TypeScript team, *Classes* (living handbook, consulted 2026),
  https://www.typescriptlang.org/docs/handbook/2/classes.html: static members are inherited, including
  through local bases; prototype methods need binding when used as callbacks.
- Microsoft TypeScript team, *Variable Declaration* (living handbook, consulted 2026),
  https://www.typescriptlang.org/docs/handbook/variable-declarations.html: using and await using scopes.

Regression evidence: tests/api-conventions.test.js plus the changed packages' CPU lifecycle, mixer, GPU-label
layout, imported-bake, stereo, shell, scene-tag, clip-player, voxel-object, viewport and auto-scene tests.

Scene GPU command repair: npm launches scripts from the package directory, while the fixture requests
repository-root URLs. All three scene scripts now change to the repository before launching their
fixture. tests/package-browser-root.test.js executes each command's directory setup from the
package directory, verifies its actual served root and checks both entry and requested page exist.
Research: npm contributors, *Scripts* (living documentation, consulted 2026),
https://docs.npmjs.com/cli/v11/using-npm/scripts/; Node.js contributors, *Child process*
(living documentation, consulted 2026), https://nodejs.org/api/child_process.html. The explicit command
root retains the existing browser helper and exact pixel assertions.
Each repaired scene GPU command executes both native and --compat routes.
The same command-root regression covers the worker matrix command, which also serves repository-root module URLs.
The rebased sciviz engineering and pointcloud commands also uses its existing browser-root launcher, as required by packages/sciviz/tests/browser-root.test.js.
