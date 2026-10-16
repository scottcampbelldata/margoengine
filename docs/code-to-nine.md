# From a code 8 to a code 9

Date: 2026-10-16. This grade ignores npm, the README, and the catalog page. The code is an **8**. The kernel, the glTF runtime, the constraints solver, and the native FBX importer are the reason. A 9 is that same code with the two holes below closed. It is not more FBX features and it is not more packages.

## What the 8 already is

`packages/kernel/src/lib.rs` is fixed-capacity and `no_std` on wasm. A bad quaternion or a zero scale returns no matrix. Core plus stage measured 19,999 bytes gzip against the 20,000-byte gate.

`packages/fbx/src/skin.ts` reserves scratch before it allocates, rejects a missing bind, keeps the four strongest weights, and copies them onto split vertices. Cubic curves, extra inheritance modes, and progressive morphs throw. `npm test --workspace @margoengine/fbx` passed 52 tests. `npm test --workspace @margoengine/exporters` passed 17. `packages/gltf-pro/src/compression.ts` checks Draco vertex counts, index ranges, and the decoded-byte budget before it keeps a result.

## Hole 1: the FBX proof is synthetic

The 52 tests build FBX documents in the test files. They pin bind matrices, winding, and clip times for those documents. They do not load a Blender, Maya, or Max file, and they do not check a rendered frame. `docs/native-fbx-plan.md` already leaves that gate open.

A 9 needs one licensed file in the repo and two checks that fail when the importer is wrong:

1. A headless check. Load the file through `convertFBX`. Assert the joint count, one inverse-bind translation written as sixteen numbers, the clip name, and the first and last quaternion. Those numbers come from the file, not from a builder in the test.
2. The existing `MARGOENGINE_FBX_FIXTURE` browser check, pointed at that same file. It already looks for retained skins and clips and for pixels that change after a seek. Make that fixture required in one CI job, not an optional environment variable.

Do not add cubic curves, `InheritType` 1 and 2, or progressive morphs to earn this. Those are more behavior. The 9 is one real file that the current subset already claims to load.

## Hole 2: three functions are too dense to change safely

The budgets and the rejections are real. Several of the steps that justify them are one statement inside a larger function. The next edit has to re-derive the invariant from `packages/fbx/test/` instead of from the function name.

Split these, and leave the tests asserting the same numbers:

| Function | File | What the new function is |
| --- | --- | --- |
| The four-slot insert inside `prepare` | `packages/fbx/src/skin.ts` | `insertInfluence(jointIds, weights, controlPoint, joint, weight)`. One control point, four slots, the smallest weight drops out. The tie order stays the order already tested. |
| `evaluate` and the quaternion sign flip inside `buildAnimations` | `packages/fbx/src/animation.ts` | `sampleLocal(time)` returns translation, rotation, and scale. `keepQuaternionHemisphere(previous, next)` flips `next` when the dot product is negative. `refineTimes` stays the baker. |
| `triangulate` is already its own function | `packages/fbx/src/geometry.ts` | Leave it. `layer` and `layerIndex` are already readable. Do not restyle this file. |

`convert` in `packages/fbx/src/convert.ts` is short and ordered. Leave it. `packages/kernel/src/lib.rs` is dense because the layout is the format. Leave it. A 9 does not wrap the kernel in smaller functions that hide the 70-float stride.

After the split, a reader can see the weight rule and the hemisphere rule without opening a test. The tests stay the proof. They stop being the only place the rule is written down.

## What not to do

Do not add a package. A new module next to `tween` or `road` makes the repo wider and does not move this grade.

Do not rewrite the thin packages so they look like the kernel. `ecs`, `fsm`, and `tween` are small on purpose. The 9 applies to the kernel, `gltf-pro`, `exporters`, `fbx`, and `kinematics-constraints`. Those five are the code a change has to survive.

Draco and meshopt loading is implemented and tested. Keep the bounds checks in `packages/gltf-pro/src/compression.ts` and the tests that reject an over-budget decode. `parseGLTF` stays synchronous for uncompressed and meshopt assets; Draco input uses `parseGLTFAsync` or `loadGLTF`. KTX2 on a glTF texture remains unsupported. That is a declared limit.

## Done when

- One real FBX file is in the repo. The headless numbers and the browser pixel check both run in CI.
- `insertInfluence` and `keepQuaternionHemisphere` exist, and the current 52 FBX tests pass without changed expectations.
- Core plus stage is still under 20,000 bytes gzip.

That is the whole gap between an 8 and a 9.
