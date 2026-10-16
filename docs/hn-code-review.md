# Code review

Date: 2026-10-16. This is a read of the engine code a skeptical commenter would open first. It does not cover the repository, the README, or the install path.

## What holds up

The kernel is a real kernel. `packages/kernel/src/lib.rs` is `no_std` on wasm. `tick` does not allocate. A bad quaternion, a zero scale, a non-finite parent, or a hierarchy deeper than 64 returns no matrix instead of publishing one. World matrices are written only after every node validates. The bounding sphere grows by the matrix 1-norm and infinity-norm, which is a correct bound for an affine transform. Parent indexes are stored as `f32`, and that is exact because `TransformStore.create` stops at a capacity of 100,000, under the 24-bit integer limit of `f32`.

`packages/core/src/engine.ts` checks the same class of mistakes on the JavaScript side. `Mesh` throws on a disposed handle, a foreign parent, a hierarchy cycle, a zero scale, and a zero quaternion. `setQuaternion` renormalizes. Geometry is retained and released. Visibility is a boolean, not a truthy value.

`packages/gltf-pro/src/shader.ts` is one GGX lobe with Smith geometry and Schlick Fresnel, then a hemisphere ambient and ACES. It is short enough to audit. The material extension slot does not change that shader for an unextended primitive. The recorded baseline shader and frame bytes still match, and a pixel comparison against the pre-change renderer matched.

`packages/animation/src/index.ts` refuses a skin it cannot deform. Joints must be unique and in range. Inverse binds must be Float32 and one matrix per joint. Paired `JOINTS_1`/`WEIGHTS_1` now supply up to eight influences; higher sets reject explicitly. Each vertex needs a positive combined weight sum, and all present weights are renormalized before upload. Four-influence primitives keep their original 32-byte records and shader; eight-influence primitives use a separate 64-byte path. The morph buffer is checked against `maxStorageBufferBindingSize` before it is created.

`packages/ecs/src/index.ts` is a generational sparse set. `create` returns `generation * capacity + slot`. `alive` checks the generation, so a stale id does not alias a recycled one. Component storage rejects NaN and out-of-range integers. Removal is swap-remove. Query output is caller-owned.

`packages/fbx` fails closed. Unsupported inheritance, cubic curves, progressive morphs, and a missing bind throw. `insertInfluence` and `keepQuaternionHemisphere` name the two rules that used to be buried. A CC0 Blender file is checked as numbers and as a rendered frame.

GPU `catch` blocks end the pass and rethrow. They do not swallow the error. `packages/core/src/engine.ts`, `packages/gltf-pro/src/index.ts`, and `packages/shadows/src/index.ts` follow that pattern.

## What a commenter will attack

**The hot path is golfed.** `world_matrix` and `tick` in `lib.rs` pack the hierarchy walk, the matrix multiply, the sphere, and the Euler-to-quaternion step into single lines. The layout is numeric: field 10 is the parent, field 27 is the local sphere, field 50 is the world matrix, field 66 is the world sphere, and flag row `4 * n` is depth plus the hidden bit. `packages/core/src/kernel.ts` repeats those offsets when it builds the typed views. A wrong constant corrupts the scene without a type error. The tests are the specification. A reader who does not already know the stride cannot review a one-line change.

**The same quaternion is written twice.** `Mesh.syncRotation` in `engine.ts` and the angle block inside `Kernel::tick` both expand XYZ half-angles into `qx, qy, qz, qw`. The formulas match today. Nothing in the type system keeps them matched. A change to rotation order on one side leaves the other side publishing a different orientation.

**The default fragment is one directional light.** `fragment` in `shader.ts` shades `f.light` and a hemisphere built from `s.n.y`. Image-based lighting, clustered point lights, and cascaded shadows are other packages that splice this string. A reader who opens the shader and stops there will say the PBR is a textbook direct term plus a fake sky. That reading is accurate for this file. The rest of the lighting is not in it.

**glTF objects are `any`.** `packages/animation/src/index.ts` types channels, skins, and morph targets as `any`, then checks them by hand. The checks are strict. The compiler does not see them. The same pattern is in `packages/blender/src/index.ts`. A malformed document becomes a thrown string at runtime, which is the right failure, and it is invisible to typecheck.

**The extension WGSL is caller-trusted.** `materialExtensionShader` inserts `extension.wgsl` and `extension.declarations` into the fragment after `surface()`. It does not parse that text. A bad string fails pipeline creation. A string that samples an unbound binding fails at draw. The slot is the right boundary for clearcoat and transmission. It is also an injection point, and the package cannot prove a caller's WGSL is only a surface edit.

**Small packages are a different standard of code.** `ecs` is careful. Several of its neighbors are a single class with a small test and no numeric kernel. They compile and they do what the file says. They are not the same artifact as `lib.rs`. A reader who samples `tween` or `road` and then samples the kernel will think the repository is uneven, because it is.

**Resolved: the four-influence cut.** The original review found that the animation package threw on `JOINTS_1`. It now accepts paired secondary joint/weight sets, with a fixed eight-influence limit and an unchanged four-influence path. GPU readback against an independent CPU reference covers a production rig with genuine secondary weights. This resolves that character-file gap; it does not add unbounded influence sets.

## What I would not concede

The empty `catch` around `pass.end()` is cleanup during an unwind, and the original error is rethrown. That is not a swallowed failure.

The `f32` parent index is safe at the published capacity cap. It becomes unsafe only if that cap moves past 16,777,216 without changing the storage.

The ECS modulo is a generation packed into the high bits, not a hash. `alive` compares the generation before it trusts the row.

## Bottom of the read

The code that owns transforms, skins, and the base shader is defensive and tested at the boundaries. The cost is density: the layout and the lighting model live in constants and in tests more than in names. The code that will draw the sharp comments is the one-line kernel, the single directional light in `shader.ts`, and the `any` on the glTF document.
