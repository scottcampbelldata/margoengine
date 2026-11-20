# VRM first person

The optional `@margoengine/rigging/vrm-first-person` entry runs the `firstPerson` part of VRMC_vrm 1.0: each mesh annotation says which cameras draw a mesh. `thirdPersonOnly` meshes (the head and hair, seen from inside) are left out of the first-person view, `firstPersonOnly` meshes are drawn only in it, `both` everywhere, and `auto` (also a mesh with no annotation, or a file with no `firstPerson`) is split by its skin weights.

## How it works

`splitVRMFirstPerson(glb)` changes the file before it loads, so the loaded model holds plain glTF nodes. For each `auto` mesh node, the head set is the humanoid `head` bone and every node below it. A vertex is a head vertex when any of its `JOINTS_n` / `WEIGHTS_n` pairs puts a weight above `threshold` (default 0, the specification's rule) on a head-set joint; a triangle, line or point with at least one head vertex belongs to the head. A node all on the head becomes `thirdPersonOnly` with its geometry untouched, a node with no head vertex becomes `both`, and a mixed node keeps the rest and gains a child node (identity transform, same skin, appended last so no index moves) holding the head part. Each part gets compact copies of every attribute and morph target, so skinning work grows only by the seam vertices. Material, morph weights, target names, expression `morphTargetBinds` and animation weight channels are copied or twinned. Index types u8, u16, u32 and none, strips, fans, loops, normalized weights, byte strides and sparse accessors are read; Draco and meshopt streams are decoded through `@margoengine/decoders`, loaded only when a file needs it. An unskinned `auto` node (the specification is silent) is `thirdPersonOnly` when it sits under the head, else `both`. The output has no `auto` left, passes `checkVRM`, and a second split returns the same bytes.

`addVRMFirstPerson(model)` puts `thirdPersonOnly` nodes on layer 30 only and `firstPersonOnly` nodes on layer 29 only (`THIRD_PERSON_ONLY_LAYER`, `FIRST_PERSON_ONLY_LAYER` in packages/shared/layers.js, so no two Margo packages take the same bit; both are options), and returns `firstPersonLayers` and `thirdPersonLayers`. Every view that filters by layers then does the rest: `RenderView.layers`, a camera's mask (`setCameraLayers`), planar mirrors, cube cameras, and `xr.layers` for both eyes of either XR route. `viewpoint()` is `lookAt.offsetFromHeadBone` on the head bone's world matrix; the schema gives no default, so a missing offset is [0, 0, 0], as `vrmGaze` reads it.

## Limits

- A view, mirror or probe with no mask draws every layer, `firstPersonOnly` meshes included; give it `thirdPersonLayers`.
- Shadows are not filtered by the view's layers: the avatar casts its whole shadow in every view (measured below).
- Setting a mask replaces a layer the caller had set on that node until `dispose()`.
- The old mesh bytes of a split primitive stay in the BIN chunk; the split adds the part copies after them.
- No speed is claimed; the split is a one-time CPU pass before loading.

## Evidence

CPU (`node --test packages/rigging/tests/vrm-first-person.test.js`, 27 tests): on VRM1_Constraint_Twist_Sample.vrm (three `auto` nodes) no `auto` is left, each split primitive's two parts hold exactly the original triangles by vertex bytes and none twice, every head triangle has a head vertex and no rest triangle has one, the vertex count is the original plus the seam, morph targets are byte-equal, `checkVRM` is empty and a second split changes nothing. Seed-san (explicit annotations) comes back byte for byte. Built files cover strips, fans, no indices, u8 and u16 indices, `JOINTS_1`, sparse, Draco, meshopt with quantized vertices, an unskinned hat, one mesh on two nodes, no `firstPerson`, bind and channel twins, and Alicia converted from VRM 0.x.

GPU (`npm run test:first-person:browser --prefix packages/rigging`, native WebGPU and `MARGO_COMPAT=1`, RTX A6000, 192 x 192 views, no tolerance; native and WebGL2 gave the same numbers):

| Check | Seed-san | Twist sample |
| --- | --- | --- |
| First-person view against the render with the third-person nodes hidden | 0 pixels differ | 0 |
| First-person view against the unmasked render | 10,674 differ | 20,014 |
| Third-person view against the unmasked render | 0 | 0 |
| First-person shadow against the unmasked shadow | 0 | 0 |
| First-person shadow against a headless avatar's shadow | 2,179 differ | 4,376 |
| Mirror seen through the eyes: head pixels in the reflection | 287 | 520 |
| Mirror with `thirdPersonLayers` against a mirror with every layer | 0 | 0 |
| Split file against the unsplit file, third person | | 0 |

XR (`npm run test:gpu:view-layers --prefix packages/xr`): with a core cube and a gltf/pbr model on layer 30, `xr.layers = 1` makes both eyes equal the frame with the two hidden, pixel for pixel, on the `separate` and `engine` routes, native and WebGL2 (4,212 to 4,623 pixels differ from the unmasked frame).

Parity: three-vrm's documented `VRMFirstPerson` (`setup()` with first-person-only layer 9 and third-person-only layer 10, the `auto` head split) is matched; Margo's layers are options, defaulting to 29 and 30 to stay clear of user layers, and its split also reads compressed and sparse geometry and twins expression binds and animation channels on the head part. Only the documented API was read.

## Clean-room sources

- VRM Consortium, *VRMC_vrm 1.0* specification, firstPerson.md, the meshAnnotation schema and lookAt.md (`offsetFromHeadBone`), 2022, https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm-1.0. Defines the four annotation types, `auto` as the default and the head split by skin weights.
- Khronos Group, *glTF 2.0 Specification*, 2021, https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html. Accessors, sparse accessors, primitive modes and skinning attributes the split reads and writes.
- M. Slater, B. Spanlang, M. V. Sanchez-Vives, O. Blanke, "First Person Experience of Body Transfer in Virtual Reality", PLoS ONE 5(5), e10564, 2010, https://doi.org/10.1371/journal.pone.0010564. A body seen from the eyes and whole in a mirror, the two views the masks serve.
- B. Spanlang et al., "How to Build an Embodiment Lab: Achieving Body Representation Illusions in Virtual Reality", Frontiers in Robotics and AI 1, 2014, https://doi.org/10.3389/frobt.2014.00009. The same first-person and mirror setup in practice.
- pixiv, *three-vrm* public API documentation, `VRMFirstPerson`, https://pixiv.github.io/three-vrm/docs/. Feature comparison from documented API only; no implementation or companion code was read or copied.

No paper prescribes the split; the specification does.

## Sizes

New optional entry: 0 B before, 7,928 B gzip after (whole bundle, the sizes gate's method), ceiling 8,184 B. The glTF reader (`@margoengine/gltf/pbr`) and the Draco and meshopt decoders (`@margoengine/decoders`) load lazily, only when a file needs them. `loadVRM` always needs the split, so a separate lazy split chunk would add a fetch to every load and save nothing. `@margoengine/xr` grew from 9,336 to 9,620 B gzip for `layers` (ceiling 9,617 to 9,909 B). `@margoengine/rigging/vrm` stays 10,834 B. Core + stage stays 24,837 B gzip (`npm run measure:size`); core is untouched.
