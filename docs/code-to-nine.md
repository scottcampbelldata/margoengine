# From a code 8 to a code 9

Date: 2026-10-16. This grade ignores npm, the README, and the catalog page. The starting code grade was an **8**. The kernel, the glTF runtime, the constraints solver, and the native FBX importer are the reason. The two requirements for a **9** are now complete, with the evidence below. No FBX features or packages were added. The remaining sections preserve the original gap assessment.

## Completion evidence

- `insertInfluence` names the four-slot weight rule, preserving strict comparison and earlier-joint tie order. A private sampler returns `sampleLocal(time)`; `keepQuaternionHemisphere` applies the sign rule to the same Float32 samples as before. `refineTimes` is unchanged.
- [The real Blender fixture](../packages/fbx/test/fixtures/README.md) includes its CC0 license, authoring/export script, provenance, and source ground truth. [The headless test](../packages/fbx/test/real-file.test.js) reads that binary, checks three joints, all sixteen inverse-bind values, `Bend`, both quaternion endpoints, and the runtime bind pose.
- The primary CI job requires that same fixture in `test:modules:browser`. The local Node 24 WebGPU run passed skin retention, clip playback, pixel changes on playback and seek, and exact first-frame restoration. Playback changed 9,798 pixels; seek changed 14,662 of 480,000 pixels. CI saves `margo-modules.json` and `margo-fbx.png`.
- Verification: **53 FBX tests** (all 52 existing tests unchanged), **939 full-suite tests** under Node 24.22.0 with no failures or skips, **62 package typechecks and packed imports**, and **19,999 bytes gzip** for core + stage. Local logs are `test-results/code-to-nine-{fbx,full,types,packages,browser}-node24.log`.
- Concurrent React work added four public exports. Its stale catalog and API expectation lists were aligned with those exports so the full-suite gate could pass; no React implementation was changed for this task.
- `geometry.ts`, `convert.ts`, and `packages/kernel/src/lib.rs` are byte-for-byte unchanged. Broader DCC compatibility remains outside this task; the fixture's export settings and identity joint bind convention are documented with the asset.

## What the 8 already is

`packages/kernel/src/lib.rs` is fixed-capacity and `no_std` on wasm. A bad quaternion or a zero scale returns no matrix. Core plus stage measured 19,999 bytes gzip against the 20,000-byte gate.

`packages/fbx/src/skin.ts` reserves scratch before it allocates, rejects a missing bind, keeps the four strongest weights, and copies them onto split vertices. Cubic curves, extra inheritance modes, and progressive morphs throw. `npm test --workspace @margoengine/fbx` passed 52 tests. `npm test --workspace @margoengine/exporters` passed 17. `packages/gltf-pro/src/compression.ts` checks Draco vertex counts, index ranges, and the decoded-byte budget before it keeps a result.

## Hole 1: the FBX proof was synthetic

Closed. The CC0 Blender file, the headless numbers, and the required CI browser check are the proof recorded above. The older synthetic tests remain. They are no longer the only proof.

The requirement was:

1. A headless check. Load the file through `convertFBX`. Assert the joint count, one inverse-bind translation written as sixteen numbers, the clip name, and the first and last quaternion. Those numbers come from the file, not from a builder in the test.
2. The existing `MARGOENGINE_FBX_FIXTURE` browser check, pointed at that same file. It already looks for retained skins and clips and for pixels that change after a seek. Make that fixture required in one CI job, not an optional environment variable.

Do not add cubic curves, `InheritType` 1 and 2, or progressive morphs to earn this. Those are more behavior. The 9 is one real file that the current subset already claims to load.

## Hole 2: three functions were too dense to change safely

Closed. `insertInfluence`, `sampleLocal`, and `keepQuaternionHemisphere` are in the reader. `triangulate`, `convert`, and the kernel were left as they were.

The requirement was:

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

Met on 2026-10-16.

- One real FBX file is in the repo. The headless numbers and the browser pixel check both run in CI.
- `insertInfluence` and `keepQuaternionHemisphere` exist, and the previous 52 FBX tests passed unchanged. The suite is now 53 tests.
- Core plus stage measured 19,999 bytes gzip.

On the criteria in this note, the code grade is a **9**. Broader Blender, Maya, and Max certification stays outside that grade. The fixture's bind convention is documented with the asset.
