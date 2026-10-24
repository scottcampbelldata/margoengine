# Margo Engine Animation

Optional WebGPU skeletal animation and morph targets, isolated from core and stage.

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
animation.destroy();
model.destroy();
stage.dispose();
```

Parses glTF skins, joint hierarchies and inverse bind matrices. Samples STEP, LINEAR (quaternion slerp), and CUBICSPLINE tracks. Animation advances in seconds before the engine updates world matrices. A compute pass blends position/normal/tangent morphs before skinning and writes the vertex draw buffer. Bone matrices use read-only storage buffers, bounded by the GPU's storage limits rather than a fixed bone count.

Use `animation.setMorph(nodeIndex, targetIndex, weight)` for manual expressions. Play a clip by name/index; set `loop:false` for one-shot playback. Up to eight influences per vertex are supported through paired `JOINTS_0`/`WEIGHTS_0` and optional `JOINTS_1`/`WEIGHTS_1`. Higher sets reject explicitly. No blending between clips is included.

Four-influence primitives keep their existing 32-byte influence records and exact compute shader. An eight-influence primitive uses a separate 64-byte record and lazily creates its compute pipeline; both formats can coexist in one model. Weights normalize across all present sets, including assets whose positive weights are entirely in the secondary set. Joint indices accept unsigned 8-bit or 16-bit accessors; weights accept Float32 or normalized unsigned 8-bit/16-bit accessors. Both sets require matching vertex counts, valid palette indices, nonnegative weights, and a positive combined sum.

Single-clip playback reuses sample buffers, quaternion arrays, palette matrices, and inverse-bind views. The animation hot path allocates no new typed arrays, quaternion copies, or GPU resources. Device restoration recreates both pipeline variants and their owned buffers. `sampleTrack()` retains its independently owned return value by default; an optional seventh `target: Float32Array` argument lets other consumers reuse their own output storage.

`createMaterialAnimation(model, {clip?, loop?})` plays a clip's `KHR_animation_pointer` STEP tracks on base-color `KHR_texture_transform` offset and scale (what `@margoengine/exporters` writes from `materialAnimations`): `seek(seconds)` writes the sampled UV transform into every primitive material of the targeted glTF material, and `dispose()` releases its claim on those properties. `Animation.attach` skips those pointer channels and counts them in the clip's duration.

The separate `@margoengine/animator` package adds gameplay states, blend trees, additive masks and foot IK while reusing this pass's palette buffers. `sampleTrack()` and `multiplyMatrices()` are exported for animation consumers.

Animation installs an optional `model.prepareDeformation` encoding hook. GPU
picking and explicit CPU snapshots use it to update the same skin/morph output
after a seek, bone edit or weight change without needing a beauty frame. Queries
do not advance playback time. The hook survives device restoration; disposal
removes only the animation instance's own hook. No CPU skinning copy is added to
the playback path.

Run the character demo at `/examples/robot-expressive.html` (also `character-animation.html`). RobotExpressive is by Tomás Laulhé with morphs by Don McCurdy (CC0). It is not a Khronos sample.

The demo leaves facial weights under the sliders' control by removing weight tracks from its clips. Expressions persist while playing, pausing and switching clips. Presets include a neutral reset; playback speed and a reset-view button accompany touch-enabled orbit controls. The studio floor uses the optional shadows and tone-mapping packages.

After building the packages, run `node --test packages/animation/tests/*.test.js` for influence validation, packed formats, lifecycle, and allocation checks. `node scripts/animation-influences-browser-tests.js` checks real WebGPU deformation against an independent CPU reference, four-influence parity, eight active influences with morphs, a 1,001-joint palette, and device restoration. Its pinned [Babylon.js octopus fixture](tests/fixtures/README.md) has 48,222 vertices, 91 joints, seven clips, and 1,552 vertices with genuine secondary skin weights. The CC BY 4.0 asset downloads into `test-results/` and is not bundled with the package.

## Skeletons and skins from raw data

`Skeleton` and `Skin` rig a mesh from plain arrays, for editors that author bones and weights themselves (no glTF
document needed). Bones live in the skinned mesh's local space; exactly one bone is the root (`parent: -1`).

```ts
import {Material, createMesh} from '@margoengine/materials';
import {Skeleton, Skin} from '@margoengine/animation';
const skeleton = new Skeleton([
  {name: 'upper', parent: -1},
  {name: 'forearm', parent: 0, translation: [0, 1, 0]},
]); // inverse bind matrices come from this base pose unless passed as a second argument
const mesh = createMesh(stage.engine, geometry, new Material({map: tileTexture}));
// Four bone indices and four weights per vertex; weights normalise to sum 1, a zero sum follows the root bone.
const skin = Skin.attach(mesh, skeleton, joints, weights); // or new Skin(...) for CPU-only skinning
skeleton.setPose(1, {rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2]}); // posing; the GPU follows next frame
skeleton.restorePose(1); // Restore Pose; restorePose(1, true) also resets nested bones; restorePose() resets all
skeleton.setBindPose(); // the current pose becomes the base pose, inverse binds recomputed
skin.setInfluences(first, joints4, weights4); // weight painting
const world = skeleton.worldMatrix(1, mesh.primitives[0].node.matrix); // for drawing and picking bones
const posed = skin.pose(geometry.positions, geometry.normals); // CPU skinning: picking, Export Static Pose (OBJ/DAE)
skin.dispose();
```

`Skin.attach` reuses the four-influence compute shader above and swaps the mesh's draw buffer (`primitive.deformed`), so
textures, nearest sampling, vertex colours, shadows and GPU picking follow the pose; the mesh needs one shared vertex
array (any `createMesh` mesh). An unchanged pose dispatches nothing. A pose change uploads 64 bytes per bone;
`setInfluences` costs O(changed vertices) on the CPU, then the next frame uploads 32 bytes per vertex spanning the
changed ones.
Validation rejects bad indices and counts, repeated names, parent cycles and anything but one root (`RangeError` /
`TypeError`). Material meshes do not render through `model.createRenderer(otherDevice)`, so neither does a skin.

## Keyframe clips from raw keys

```ts
import {createKeyframeClip, applyKeyframeClip, sampleKeyframes, segmentTime, bakeKeyframeClip} from '@margoengine/animation';
const wave = createKeyframeClip({name: 'Wave', tracks: [
  {target: 'forearm', path: 'rotation', keys: [
    {time: 0, value: [0, 0, 0, 1], interpolation: 'easeInOut'}, // shapes the time until the next key
    {time: 0.5, value: [0, 0, 0.38268, 0.92388], interpolation: 'discrete'},
    {time: 1, value: [0, 0, 0, 1]},
  ]},
  {target: 'door', path: 'translation', keys: [{time: 0, value: [0, 0, 0]}, {time: 1, value: [2, 0, 0]}]},
]});
const t = segmentTime(elapsed, wave.duration, {loop: true, timeScale: -1}); // a reversed, looping segment
applyKeyframeClip(wave, skeleton, t); // poses bones named by track targets
const door = sampleKeyframes(wave.tracks[1], t); // any other target: sample it yourself
const animation = bakeKeyframeClip(wave, 30, (target) => exportNodes.get(target)); // exporters AnimationData
```

Tracks target a bone (by name) or the caller's node by a stable string id, for translation, rotation, scale and morph
`weights` (one number per morph target in every key, blended per component and never normalised). Each
key carries its own interpolation for the time until the next key: `discrete` (hold, then jump at the next key),
`linear`, `easeIn`, `easeOut` or `easeInOut` (cubic); rotations slerp along the shortest path by the eased factor.
Sampling is a pure function of time, so editing, scrubbing, playback and offline rendering agree at any frame rate.
`bakeKeyframeClip` writes glTF samplers: a track of only discrete keys becomes STEP and one of only linear keys becomes
LINEAR, both at their keys and exact everywhere; other tracks are LINEAR at the keys plus every `1 / fps` second inside
eased segments, exact at those times. Pass the result to `@margoengine/exporters` as an `ExportScene` animation; tracks
whose target `resolve` maps to undefined are left out.

A track's `blend` picks the arithmetic between keys a and b at eased factor f. The default, `'delta'`, is
`a + (b - a) * f`. `'weighted'` is for saved data that needs a finite, exactly held result: a sample at a key, before
the first, after the last or inside a discrete segment copies the key's value before any arithmetic, and translation
and scale between keys are `(1 - f) * a + f * b`, finite for all finite keys (keys of ±1e308 included, where
`'delta'`'s b - a overflows to NaN). Rotations slerp the same way in both. `'weighted'` reproduces Margo Voxel Studio's
saved vector-track evaluation bit for bit (`tests/keyframes-blend.test.js`).

Code clips also drive glTF-pro models: pass the model's `Animation` instead of a skeleton. Tracks then name model nodes
(the first node with that name); transform tracks set the node's local transform and `weights` tracks set every morph
weight through `animation.setMorph`, so expressions authored in code play on loaded characters. Pause the model's own
clip (`animation.playing = false`) while a code clip drives it. A `weights` track whose width differs from the node's
morph target count throws `RangeError`; a `Skeleton` skips `weights` tracks. `bakeKeyframeClip` writes `weights`
tracks as glTF `weights` channels, which gltf-pro and `Animation` play back (`tests/keyframes-weights.test.js` checks
the round trip through `exportGLB`).

```ts
const blink = createKeyframeClip({name: 'Blink', tracks: [
  {target: 'Face', path: 'weights', keys: [{time: 0, value: [0, 0]}, {time: 0.1, value: [1, 0]}, {time: 0.2, value: [0, 0]}]},
]});
const animation = Animation.attach(model);
animation.playing = false;
applyKeyframeClip(blink, animation, t); // node 'Face' has two morph targets
```

`skin.pose()` runs the GPU pass's maths on the CPU (linear blend of the four bone matrices; normals by the cofactor
matrix, flipped under mirroring scales) and returns Float32 positions and normals in the mesh's space.
`tests/raw-rig-roundtrip.test.js` writes a raw rig and clip with `@margoengine/exporters` `exportGLB` (bones as export
nodes under the mesh node, `skeleton.inverseBindMatrices`, `bakeKeyframeClip`), reads it back through gltf-pro and
`Animation`, and matches `skin.pose()` within 1e-4 at frame and key times.
`node scripts/animation-skin-browser-tests.js` (real WebGPU, after building the packages) reads back the deformed
buffer of a skinned `createMesh` strip and matches `skin.pose()` positions and normals within 1e-5 after posing, a
ranged `setInfluences` and a device restore, with no validation errors.

## Rigid rigs: whole meshes bound to bones

`compileRigidClip(bones, bindings, keys, {name, duration})` turns keys of meshes rigidly bound to bones into stepped
bone translation and rotation tracks. A key moves its bone by the mesh's offset from its rest pose and rotates it by
the key rotation times the inverse rest rotation; each bone follows the first bound mesh (in binding order) keyed so
far, and holds the last pose until `duration`. Times are seconds; rotations are `[x, y, z, w]`.

```ts
const clip = compileRigidClip(
  [{id: 'arm', translation: [0.5, 1.5, 0]}],
  [{object: 'sword', bone: 'arm', position: [1, 1, 0], rotation: [0, 0, 0, 1]}],
  [{object: 'sword', time: 0.5, position: [1, 2, 0], rotation: [0, 0, 0, 1]}],
  {duration: 2},
);
applyKeyframeClip(clip, skeleton, time);
```

## Groups: one clip for many models

`AnimationGroup` is one clip and one clock for a crowd. Members are glTF-pro models'
`Animation`s playing a glTF clip they all have (by name or index), or, for a code-authored `KeyframeClip`, `Skeleton`s
and `Animation`s whose bones or nodes the tracks name. Each member can run ahead or behind by an offset in seconds.

```ts
import {Animation, AnimationGroup} from '@margoengine/animation';
const crowd = new AnimationGroup('Walking', {speed: 1});
for (const [i, model] of walkers.entries()) crowd.add(Animation.attach(model), i * 0.37); // offset per walker
stage.engine.use(crowd); // advances in onPreUpdate; or call crowd.update(delta) yourself
crowd.seek(2); crowd.playing = false; crowd.setOffset(walkerAnimation, 0.5); crowd.remove(walkerAnimation);
```

Adding an `Animation` pauses its own playback; the group seeks it each frame through its usual sampling path. A glTF
clip loops as each member's own `loop` option says (a negative member time wraps back from the end); code clips take
the group's `loop` option (default true; false holds the first and last frames). Code-clip tracks are bound to bones,
nodes and morph weights once, in `add`, and group playback creates no typed arrays per frame
(`tests/group.test.js` traps the constructors over 120 frames). Each member still deforms on the GPU through its own
`Animation`; the group adds no GPU work.

## Sampling (`@margoengine/animation/sampling`)

`sampleTrack`, `sampleTrackInto` and `multiplyMatrices` (also on the root) without the deformation pipeline or
gltf-pro, for code that samples tracks itself (`@margoengine/animator` does).

## Cloning and retargeting (`@margoengine/animation/skeleton-utils`)

Cloning skinned models and retargeting poses and clips between skeletons, in their own entry:

```ts
import {Animation, AnimationGroup, applyKeyframeClip} from '@margoengine/animation';
import {Retarget, cloneModel, retargetRig} from '@margoengine/animation/skeleton-utils';

const second = await cloneModel(robot); // own nodes and skeleton; shares the parsed asset
Animation.attach(second).play('Dance'); // animates apart from `robot`

// Both characters stand in the same reference pose (T-pose, say) when their rigs are made.
const retarget = new Retarget(retargetRig(mixamoModel), retargetRig(hero), {
  names: {Hips: 'mixamorig:Hips', Spine: 'mixamorig:Spine', LeftArm: 'mixamorig:LeftArm'}, // others map by equal name
  hip: 'Hips', // follows the source hips' movement, scaled by the rest hip heights unless hipScale is given
});
retarget.apply(mixamoModel, hero); // live: pose hero as mixamoModel is posed now
const walk = retarget.clip({animation: mixamoAnimation, clip: 'Walk'}, {fps: 30}); // or a source KeyframeClip
applyKeyframeClip(walk, Animation.attach(hero), t); // or new AnimationGroup(walk) for many heroes
```

`cloneModel(model)` resolves to a new `PBRModel` with its own root and nodes, starting in the source's current local
transforms, visibility and morph weights, and registered with the engine when the source is. It shares the source's
parsed asset (document, buffers, accessors), compressed textures, and packed vertex arrays where gltf-pro cached them
(worker and progressive loads, prepared static scenes; otherwise it packs its own from the shared accessors). Decoded
bitmaps are copied with `createImageBitmap`, because disposing a model closes its own. Disposing either model leaves
the other working. gltf-pro uploads vertex buffers and textures per model, so each clone costs its own GPU
memory; materials are rebuilt from the document, so runtime material edits on the source are not copied.

`retargetRig(skeletonOrModel)` reads a bone hierarchy and its current local pose, which becomes the rig's rest pose; a
model's rig is every node, so armature and mesh nodes count toward bone orientations. `new Retarget(source, target,
options)` maps target bones to source bones by name (`names` overrides, `''` leaves a bone at rest; unnamed glTF nodes
map only through `names`). Each mapped target bone turns in model space by the rotation its source bone has turned
from rest, which absorbs different bone axes and rest orientations; bones keep their own lengths and scales, unmapped
bones keep their rest local pose, and the `hip` bone's position follows the source hip's movement times `hipScale`.
`pose(sourceLocal, out?)` does this on raw arrays (10 numbers per bone: translation, quaternion, scale) without
allocating, `apply(source, target)` reads and writes Skeletons or models, and `clip(source, {fps, name})` samples a
source `KeyframeClip`, or a glTF clip through the source model's `Animation` (restoring its clip, time and playing
state), into a target `KeyframeClip` with a rotation track per mapped bone and a translation track for the hip. Both
characters' model spaces must face the same way; morph weight tracks are not carried over.
`tests/retarget.test.js` checks analytic poses (bone directions, lengths, scaled hip motion, unmapped bones) across
renamed rigs with different bone axes, and models driven by their `Animation`.
