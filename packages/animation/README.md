# Margo Engine Animation

Optional WebGPU skeletal animation and morph targets, plus vertex animation texture crowds, isolated from core and stage.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Animation} from '@margoengine/animation';
const stage = await createStage('#viewport', {backend:'webgpu',capacity:2048});
const model = await loadGLTF(stage.engine, '/RobotExpressive.glb');
const animation = Animation.attach(model);
animation.play('Walking');
animation.playing = false;
animation.seek(0.5);
animation.dispose();
model.dispose();
stage.dispose();
```

Parses glTF skins, joint hierarchies and inverse bind matrices. Samples STEP, LINEAR (quaternion slerp), and CUBICSPLINE tracks. Animation advances in seconds before the engine updates world matrices. A compute pass blends position/normal/tangent morphs before skinning and writes the vertex draw buffer. Bone matrices use read-only storage buffers, bounded by the GPU's storage limits rather than a fixed bone count.

Use `animation.setMorph(nodeIndex, targetIndex, weight)` for manual expressions. Play a clip by name/index; set `loop:false` for one-shot playback. Four influences per vertex are supported; additional influence sets reject explicitly. No blending between clips is included.

The separate `@margoengine/animator` package adds gameplay states, blend trees, additive masks and foot IK while reusing this pass's palette buffers. `sampleTrack()` and `multiplyMatrices()` are exported for animation consumers.

## Vertex animation textures (GPU crowds): `@margoengine/animation/vat`

A separate entry (about 6.8 kB min+gzip, [entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json); apps that only import `Animation` pay nothing for it). `bakeVAT` samples clips on the CPU with the same skinning and morph maths as the compute pass, every primitive merged in the model root's space, into rgba32float texels (position, normal per vertex per row). `VATCrowd` draws any number of copies in one instanced call; each instance has its own matrix, clip, time offset, speed and atlas region, and per-frame CPU work is one 160-byte uniform write (measured the same at 100 and 1,000 copies).

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Animation} from '@margoengine/animation';
import {bakeVAT, VATCrowd} from '@margoengine/animation/vat';
import {Texture, packAtlas} from '@margoengine/materials';
declare const red: ImageBitmap, blue: ImageBitmap, green: ImageBitmap; // tint swatches
declare function placement(i: number): Float32Array;                   // your 4x4 column-major instance matrix
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/RobotExpressive.glb');
const vat = bakeVAT(new Animation(model), {fps: 30, clips: ['Walking', 'Running']});
model.dispose();                                                                    // the baked data stands alone
const tints = packAtlas([red, blue, green]);
const crowd = VATCrowd.attach(stage.engine, vat, {map: new Texture(tints.image), roughness: 0.6});
for (let i = 0; i < 1000; i++) crowd.add({matrix: placement(i), clip: i % 2, offset: Math.random(), speed: 1, uvTransform: tints.regions[i % 3]});
crowd.set(5, {clip: 0, offset: 0});                                                   // live; uploads only what changed
```

RobotExpressive (7,214 vertices, 19 primitives) walking, CPU per frame on the mock GPU, measured at `700838e` (`proofs/animation-vat.proof.js`, which builds gltf-pro and animation from that commit): 1,000 skinned models 30.5 ms update + 434 ms draw recording (19,000 draws, 7,000 compute dispatches, 27.8 MB of uploads); one VATCrowd of 1,000 under 0.01 ms (1 draw, 160 bytes); CPU skinning would cost about 1.3 ms per character. Baking Walking at 30 rows/s took about 120 ms and 6.9 MB of texture. Real GPU check (`node examples/package-benchmarks/atlas-vat/check.mjs`, not in CI): it asserts that the VAT pose matches the GPU-skinned pose (silhouette IoU above 0.97) and that 1,024 walking robots (7.4M vertices) draw in one call; frame timings are not yet recorded.

Shadows and image-based lighting: `shadows.add(crowd)` (`@margoengine/shadows`) draws the posed instances into every cascade and shadows the crowd; `lighting.add(crowd)` (`EnvironmentLighting` from `@margoengine/environment`) replaces the hemisphere fill with IBL. Both call `crowd.addLighting(effect)`, which takes any effect with gltf-pro's `pbr` lighting hooks and composes it into a lit copy of the shader (bind group 1); a crowd with no effect keeps the unlit shader and exactly its previous GPU calls (`node examples/package-benchmarks/proofs/deformed-shadows.proof.js`). Real GPU (`node examples/package-benchmarks/deformed-shadows/check.mjs`, Arc 140V, Edge 155): 25 robots under a floating slab darken where shadowed (mean luma 182 -> 159) and cast onto the floor, IBL changes 74% of their pixels, 0 validation errors. Frame time with 1,024 walking robots, diagnostic (quiet gate passed, other agents' sessions open): 13.5 ms without casting, 35.8 ms with it, since every instance runs in all four cascades.

```ts
import {Shadows} from '@margoengine/shadows';
import {EnvironmentLighting} from '@margoengine/environment';
import {VATCrowd, type VATData} from '@margoengine/animation/vat';
import type {EngineKernel} from '@margoengine/core';
declare const engine: EngineKernel, vat: VATData;
const crowd = VATCrowd.attach(engine, vat);
const shadows = Shadows.attach(engine, {distance: 60});
const removeShadows = shadows.add(crowd);                                          // casts and receives
const lighting = await EnvironmentLighting.load(engine, '/studio.hdr');
lighting.add(crowd);                                                              // IBL
```

Limits: rows sample at `fps` and the shader blends adjacent rows linearly (fast rotations look slightly shrunk between rows); no blending between clips; one base colour and optional map for the whole crowd (UVs in three.js orientation, v up; per-instance regions are offset + scale, no rotation); opaque only, drawn with gltf-pro's key-light, hemisphere-fill and ACES look; shadows and IBL through `addLighting` (other `pbr`-hook effects such as Fog compose the same way but are not GPU-checked); no SSAO; shadow casting has no per-cascade instance culling; no CPU frustum culling (the GPU clips); texture memory is rows x vertices x 32 bytes and at most 8192 rows of 2048 texels.

Run the character demo at `/examples/robot-expressive.html` (also `character-animation.html`). RobotExpressive comes from the Three.js sample assets, by TomÃƒÂ¡s LaulhÃƒÂ© with morphs by Don McCurdy, [CC0 credits](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/README.md). It is not a Khronos sample.

The demo leaves facial weights under the sliders' control by removing weight tracks from its clips. Expressions persist while playing, pausing and switching clips. Presets include a neutral reset; playback speed and a reset-view button accompany touch-enabled orbit controls. The studio floor uses the optional shadows and tone-mapping packages.
