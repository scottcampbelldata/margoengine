# Fixing the code-review findings without compromising core

Date: 2026-10-16. Each finding from `docs/hn-code-review.md` is fixed outside the frozen behavior of `@margoengine/core` and the stage facade. The kernel memory layout stays the 70-float stride. No feature moves into core. `npm run measure:size` still has to report core plus stage under 20,000 bytes gzip after any edit that touches the kernel or `packages/core`.

## 1. The golfed kernel

Name the offsets. Do not rearrange them.

In `packages/kernel/src/lib.rs`, replace the bare field numbers with `const` items: `PARENT`, `LOCAL_SPHERE`, `WORLD_MATRIX`, `WORLD_SPHERE`, and `DEPTH_FLAGS`. Use those names in `matrix`, `sphere`, `world_matrix`, and `tick`. Split `world_matrix` into `local_matrix`, `multiply_affine`, and `publish`, and mark each `#[inline(always)]`. The generated wasm should be the same instructions.

In `packages/core/src/kernel.ts`, use the same names when the typed views are built. A test writes one node, ticks, and checks that the JavaScript `parents`, `bounds`, and `matrices` views see the bytes the kernel published. That test is the lock between the two files.

Stop there. A struct-of-arrays rewrite or a second layout changes the wasm and the gzip number. If `measure:size` moves at all, inline harder or put the names back. The stride is the format.

## 2. The quaternion written twice

Leave both writers. They serve different times.

`Mesh.syncRotation` in `packages/core/src/engine.ts` updates `qx, qy, qz, qw` when JavaScript sets an Euler angle, so a read before the next tick is already right. `Kernel::tick` recomputes the quaternion only when rotation-limit bits are set (`mask & 56`), because the kernel has just clamped those angles. Deleting either copy breaks one of those two moments. Exporting one wasm function for the JavaScript side adds bytes to the core package.

Lock them with one table. One test feeds the same XYZ angles through `Mesh.setRotation` and through a kernel tick that clamps those angles to the same values. The four quaternion lanes must match. A change to either formula fails that test until both match. No new core API.

## 3. The single directional light in the shader

Do not add image-based lighting, clustered lights, or shadows to `packages/gltf-pro/src/shader.ts`, and do not add them to core.

The direct GGX term and the hemisphere ambient stay the base shader. `environment`, `clustered`, and `shadows` already splice their own WGSL through `addLighting()`. That is the extension point. A reader who stops at `fragment` is reading the base lobe, which is what that file is.

The only edit in `shader.ts` is naming the two existing pieces, `direct_light` and `hemisphere_ambient`, as WGSL functions called from `fragment`. The baseline shader hash in `tests/modern-material-extension.test.js` will change. Record the new hash in that same change after the pixel comparison still matches bit for bit. No new uniforms, no new bindings, no new group.

## 4. `any` on glTF documents

Type the subset the animation package already checks. Do it in `@margoengine/animation` and `@margoengine/blender`. Do not put a glTF schema in core.

Add interfaces for an animation channel, a skin, and a morph target: the index fields, `componentType`, `normalized`, and the attribute names `JOINTS_0` and `WEIGHTS_0`. Parse functions return those interfaces or throw the same errors they throw today. The runtime checks stay. `any` goes away from the function bodies, not from the JSON parse boundary. A full Khronos schema package is a new dependency and does not make the checks stricter than they already are.

## 5. Caller-trusted extension WGSL

Keep the slot. Stop treating raw WGSL as the way materials are added.

`materialExtensionShader` in `packages/gltf-pro/src/material-extension.ts` can keep inserting `wgsl` and `declarations`. That is the low-level hook. `@margoengine/materials` does not take those strings from a glTF file or from application code. Clearcoat, transmission, volume, and the node graph emit the WGSL constants inside that package, and the tests compile those constants.

Reject a `declarations` string that contains `@group` or `@binding`. The slot owns group 3. A caller who needs a new binding uses `factors` and `textures`, which already allocate those bindings. This check is a string reject in `gltf-pro`, not a WGSL parser, and it does not run for an unextended primitive.

## 6. The thinner packages

Do not rewrite `tween`, `road`, or the other small modules, and do not fold them into core.

They are small on purpose. Rewriting them to look like the kernel adds code without changing the kernel. The boundary that protects core is the one that already exists: core does not import them. Leave that boundary. New behavior goes to the package that already owns the job, or it does not land.

## 7. Four joint influences

Add the second set in `@margoengine/animation` only.

`packages/animation/src/shader.ts` is the compute shader that deforms the vertices. `packages/animation/src/index.ts` is the check that throws on `JOINTS_1` and `WEIGHTS_1`. Accept those attributes as a second `vec4`, keep eight weights, renormalize the eight, and drop a missing second set as zeros. A vertex with a non-positive sum still throws. Core meshes stay position, normal, tangent, uv, and color. The skinning inputs stay in the animation package's storage buffers.

`docs/three-parity-next.md` already lists this as the character-file gap. It is not a core vertex-format change.

## Order

1. Named kernel offsets and the layout test. Measure the gzip size before continuing.
2. The shared quaternion table. No production code change if the numbers already match.
3. Named WGSL functions for the existing direct light and hemisphere, with a new baseline hash and the same pixels.
4. Animation and Blender interfaces for the glTF subset they already validate.
5. The `@group` / `@binding` reject on extension declarations.
6. Eight influences in the animation package.

Step 6 is a feature. Steps 1 through 5 are not. None of them add a core API, a material, or a light.
