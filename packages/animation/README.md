# Margo Engine Animation

Install `npm i margoengine` and import `margoengine/animation` (or this package alone: `npm i @margoengine/animation`, imported as `@margoengine/animation`; the two are the same module).

Optional WebGPU skeletal animation and morph targets, isolated from core and stage.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
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

Every skinned or morphed primitive of a device, across all its Animations, lives in a few shared storage buffers and deforms in one compute dispatch per buffer page and influence format (100 morphed models with two primitives each: one dispatch, not 200). Copies of one asset primitive (`cloneModel`) share one copy of its morph deltas and skin influences. A primitive's deformed vertices start `primitive.deformedOffset` bytes (a multiple of 256) into `primitive.deformed`; gltf-pro, shadows, TAA, selection and picking read them there, and a custom reader binds or copies from that offset.

Use `animation.setMorph(nodeIndex, targetIndex, weight)` for manual expressions. Play a clip by name/index; set `loop:false` for one-shot playback. Up to eight influences per vertex are supported through paired `JOINTS_0`/`WEIGHTS_0` and optional `JOINTS_1`/`WEIGHTS_1`. Higher sets reject explicitly. No blending between clips is included.

Four-influence primitives keep their 32-byte influence records and the arithmetic of the per-primitive shader, bit for bit. An eight-influence primitive uses a 64-byte record and a second, lazily created compute pipeline; both formats can coexist in one model. Weights normalize across all present sets, including assets whose positive weights are entirely in the secondary set. Joint indices accept unsigned 8-bit or 16-bit accessors; weights accept Float32 or normalized unsigned 8-bit/16-bit accessors. Both sets require matching vertex counts, valid palette indices, nonnegative weights, and a positive combined sum.

Single-clip playback reuses sample buffers, quaternion arrays, palette matrices, and inverse-bind views. The animation hot path allocates no new typed arrays, quaternion copies, or GPU resources. Device restoration recreates both pipeline variants and the shared buffers. `sampleTrack()` retains its independently owned return value by default; an optional seventh `target: Float32Array` argument lets other consumers reuse their own output storage.

`createMaterialAnimation(model, {clip?, loop?})` plays a clip's `KHR_animation_pointer` STEP tracks on base-color `KHR_texture_transform` offset and scale (what `@margoengine/exporters` writes from `materialAnimations`): `seek(seconds)` writes the sampled UV transform into every primitive material of the targeted glTF material, and `dispose()` releases its claim on those properties. Given the opt-in `pointers` option, `Animation` also plays those channels, with every other `KHR_animation_pointer` channel it supports (see below); without it, it skips them and counts them in the clip's duration.

The separate `@margoengine/animator` package adds gameplay states, blend trees, additive masks and foot IK while reusing this pass's palette buffers. `sampleTrack()` is exported for animation consumers (matrix products: `@margoengine/math/mat4`).

Animation installs an optional `model.prepareDeformation` encoding hook. GPU
picking and explicit CPU snapshots use it to update the same skin/morph output
after a seek, bone edit or weight change without needing a beauty frame. Queries
do not advance playback time. The hook survives device restoration; disposal
removes only the animation instance's own hook. No CPU skinning copy is added to
the playback path.

Run the character demo at `/examples/robot-expressive.html` (also `character-animation.html`). RobotExpressive is by Tomás Laulhé with morphs by Don McCurdy (CC0). It is not a Khronos sample.

The demo leaves facial weights under the sliders' control by removing weight tracks from its clips. Expressions persist while playing, pausing and switching clips. Presets include a neutral reset; playback speed and a reset-view button accompany touch-enabled orbit controls. The studio floor uses the optional shadows and tone-mapping packages.

After building the packages, run `node --test packages/animation/tests/*.test.js` for influence validation, packed formats, lifecycle, and allocation checks. `node scripts/animation-influences-browser-tests.js` checks real WebGPU deformation against an independent CPU reference, four-influence parity, eight active influences with morphs, a 1,001-joint palette, and device restoration. Its Margo-made [rig fixture](tests/fixtures/README.md) (`scripts/make-rig-fixture.js`) has 273 vertices, 8 joints, two clips, and 247 vertices with secondary skin weights (up to eight influences); it is committed in the repository and not bundled with the package.

## Skeletons and skins from raw data

`Skeleton` and `Skin` rig a mesh from plain arrays, for editors that author bones and weights themselves (no glTF
document needed). Bones live in the skinned mesh's local space; exactly one bone is the root (`parent: -1`).

```ts
import {createStage} from 'margoengine';
import {boxGeometry} from 'margoengine/geometry';
import {Material, createMesh} from 'margoengine/materials';
import {Skeleton, Skin} from 'margoengine/animation';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const skeleton = new Skeleton([
  {name: 'upper', parent: -1},
  {name: 'forearm', parent: 0, translation: [0, 1, 0]},
]); // inverse bind matrices come from this base pose unless passed as a second argument
const geometry = boxGeometry(1, 2, 1);
const mesh = createMesh(stage.engine, geometry, new Material({color: '#c08060'}));
// Four bone indices and four weights per vertex; weights normalise to sum 1, a zero sum follows the root bone.
const count = geometry.positions.length / 3, joints = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
for (let v = 0; v < count; v++) {
  joints[v * 4] = geometry.positions[v * 3 + 1] > 0 ? 1 : 0; // the top half follows the forearm
  weights[v * 4] = 1;
}
const skin = Skin.attach(mesh, skeleton, joints, weights); // or new Skin(...) for CPU-only skinning
skeleton.setPose(1, {rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2]}); // posing; the GPU follows next frame
skeleton.restorePose(1); // Restore Pose; restorePose(1, true) also resets nested bones; restorePose() resets all
skeleton.setBindPose(); // the current pose becomes the base pose, inverse binds recomputed
skin.setInfluences(0, [1, 0, 0, 0], [1, 0, 0, 0]); // weight painting: vertex 0 now follows the forearm
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
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {
  Animation,
  Skeleton,
  applyKeyframeClip,
  bakeKeyframeClip,
  compileRigidClip,
  createKeyframeClip,
  sampleKeyframes,
  segmentTime,
} from 'margoengine/animation';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/face.glb');
const skeleton = new Skeleton([{name: 'forearm', parent: -1}]);
const exportNodes = new Map([['forearm', 0], ['door', 1]]); // track target -> exporter node index
const elapsed = 1.25; // seconds since the segment started
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
const baked = bakeKeyframeClip(wave, 30, (target) => exportNodes.get(target)); // exporters AnimationData
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
applyKeyframeClip(clip, skeleton, t);
```

## Property tracks: any number, vector or colour

```ts
import {applyKeyframeClip, bakeKeyframeTrack, createKeyframeClip, sampleKeyframes} from 'margoengine/animation';
const lamp = {intensity: 0, material: {roughness: 1, color: new Float32Array([1, 1, 1, 1])}};
let fov = 60;
const pulse = createKeyframeClip({name: 'Pulse', tracks: [
  {target: lamp, property: 'intensity', keys: [{time: 0, value: [0], interpolation: 'easeOut'}, {time: 1, value: [5]}]},
  {target: lamp, property: 'material.roughness', keys: [{time: 0, value: [1], interpolation: 'discrete'}, {time: 0.5, value: [0.2]}]},
  {target: lamp, property: 'material.color', type: 'color', keys: [{time: 0, value: [1, 0, 0]}, {time: 1, value: [0, 0, 1]}]},
  {target: lamp, name: 'fov', get: () => fov, set: (value) => { fov = value[0]; }, keys: [
    {time: 0, value: [40], interpolation: 'cubicSpline', outTangent: [30]},
    {time: 1, value: [60], inTangent: [0]},
  ]},
]});
applyKeyframeClip(pulse, 0.5); // writes all four properties
const color = sampleKeyframes(pulse.properties![2], 0.25); // [0.75, 0, 0.25]
const baked = bakeKeyframeTrack(pulse.properties![0], 30); // a glTF sampler for one property track
```

A track whose `target` is an object drives a property of it instead of a bone or node: name it with a dot path
(`'material.roughness'`, `'intensity'`, `'position'`, `'lights.0.color'`) or pass `set` (and `get`, for
`track.read()`) accessors. Keys hold 1 to 4 numbers; `type` says what they are: `'number'`, `'vector'`, `'color'`
(linear RGB or RGBA, blended per channel in linear space) or `'quaternion'` (normalised, slerped along the shortest
path). They take the same interpolations (`'cubicSpline'` is a glTF CUBICSPLINE segment through the key's
`outTangent` and the next key's `inTangent`, in units per second) and the same `blend` modes as transform tracks.
`createKeyframeClip` resolves each path once into a setter, so playback does no lookups and allocates nothing: a
number property is assigned, a boolean gets `value >= 0.5`, an array or typed array (a materials `Material`'s live
`color`, a clustered light's `color`) is written in place, a getter that returns a fresh array is assigned through its
setter, and an `{x, y, z}` object such as a mesh's `position` is set through its `set(x, y, z)`. A path that does not
resolve throws `RangeError` naming the segment; one that ends on a value it cannot write throws `TypeError`. Engine
objects work the same way: `{target: mesh, property: 'visible'}`, `{target: material, property: 'roughness'}`,
`{target: stage.engine.camera, property: 'fov'}`. Replacing an object along a path later leaves the track driving the
old one: create the clip again. Property tracks land in `clip.properties`; `applyKeyframeClip(clip, time)` writes
them, and `applyKeyframeClip(clip, skeleton, time)` writes them and poses the skeleton. `bakeKeyframeClip` leaves them
out (glTF nodes have no such paths); `AnimationGroup` and `retarget` ignore them.

## KHR_animation_pointer playback

```ts
import {createStage} from 'margoengine';
import {loadGLTF, viewGLTFCamera} from 'margoengine/gltf-pro';
import {Animation} from 'margoengine/animation';
import {pointerChannels} from 'margoengine/animation/pointer';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/pointer-show.glb');
const animation = Animation.attach(model, {pointers: pointerChannels});
for (const warning of animation.warnings) console.warn(warning); // pointers this player skips
animation.playing = false;
animation.seek(1.5);
viewGLTFCamera(model, 0); // cameras and lights are data: hand them on after each update
```

Pointer playback is opt-in, like gltf-pro's optional decoders: import `pointerChannels` from
`@margoengine/animation/pointer` and pass it as the `pointers` option, so apps whose files have no pointer channels do
not ship it. Without it, `Animation` skips every pointer channel (still counting it in the clip's duration) and lists
it in `animation.warnings` with the fix. With it, `Animation` plays a clip's `KHR_animation_pointer` channels with its
ordinary ones, at the same time, speed and loop, with glTF's STEP, LINEAR and CUBICSPLINE sampling. It drives:

- nodes: `/nodes/i/translation`, `rotation` (slerp), `scale`, `weights`, `/meshes/i/weights` (every node using the mesh,
  unless the node's own weights are animated) and `/nodes/i/extensions/KHR_node_visibility/visible` (STEP, unsigned
  byte);
- materials (every primitive material of the glTF material): `pbrMetallicRoughness/baseColorFactor`, `metallicFactor`,
  `roughnessFactor`, `emissiveFactor`, `alphaCutoff`, `normalTexture/scale`, `occlusionTexture/strength`,
  `KHR_materials_emissive_strength`, `KHR_materials_dispersion`, and with the physical renderer the clearcoat,
  transmission, specular, sheen, IOR and volume factors (the transmission tint and volume follow);
- `KHR_texture_transform` `offset`, `scale` and `rotation` on the base, metallic-roughness, normal, occlusion,
  emissive, clearcoat, transmission, sheen and specular textures (the map and its uniform rows);
- `KHR_lights_punctual`: `color`, `intensity`, `range`, `spot/innerConeAngle`, `spot/outerConeAngle` on `model.lights`,
  so `model.clusteredLights()` and `applyGLTFLights` pick them up;
- cameras: `perspective/yfov`, `aspectRatio`, `znear`, `zfar` and `orthographic/xmag`, `ymag`, `znear`, `zfar` on
  `model.cameras`, for `viewGLTFCamera`.

Values are written to copies the model owns, never to `model.asset.doc`, and bound on the clip's first playback.
Pointers that break the glTF rules throw: malformed or out-of-range indices, properties animations may not change
(`/materials/0/name`), a repeated pointer, a node property animated both by pointer and by an ordinary channel,
accessors of the wrong type or count, and booleans that are not STEP unsigned bytes. Valid pointers this player cannot
drive are skipped and listed in `animation.warnings`: other extensions (iridescence, anisotropy and diffuse
transmission factors, unknown extensions), `extras`, `texCoord`, textures of extended materials, properties the file
leaves undefined (a camera without `zfar`, a light without `range`), factors gltf-pro did not load (physical factors
without the materials decoder, transmission on a material loaded without it) and targets no scene node or primitive
uses.

## Groups: one clip for many models

`AnimationGroup` is one clip and one clock for a crowd. Members are glTF-pro models'
`Animation`s playing a glTF clip they all have (by name or index), or, for a code-authored `KeyframeClip`, `Skeleton`s
and `Animation`s whose bones or nodes the tracks name. Each member can run ahead or behind by an offset in seconds.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Animation, AnimationGroup} from 'margoengine/animation';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const walkers = await Promise.all([0, 1, 2].map(() => loadGLTF(stage.engine, '/RobotExpressive.glb')));
const crowd = new AnimationGroup('Walking', {speed: 1});
const animations = walkers.map((model) => Animation.attach(model));
for (const [i, animation] of animations.entries()) crowd.add(animation, i * 0.37); // offset per walker
const walkerAnimation = animations[0];
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

`sampleTrack` and `sampleTrackInto` (also on the root) without the deformation pipeline or
gltf-pro, for code that samples tracks itself (`@margoengine/animator` does).

```ts
import {sampleTrack} from 'margoengine/animation/sampling';

const times = new Float32Array([0, 1]);
const values = new Float32Array([0, 0, 0, 10, 0, 0]); // x, y, z per key
const position = sampleTrack(times, values, 3, 0.5, 'LINEAR'); // Float32Array [5, 0, 0]
```

## Cloning and retargeting (`@margoengine/animation/skeleton-utils`)

Cloning skinned models and retargeting poses and clips between skeletons, in their own entry:

```ts
import {Animation, AnimationGroup, applyKeyframeClip} from 'margoengine/animation';
import {Retarget, cloneModel, retargetRig} from 'margoengine/animation/skeleton-utils';
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const [robot, mixamoModel, hero] = await Promise.all(
  ['/RobotExpressive.glb', '/mixamo-walk.glb', '/hero.glb'].map((url) => loadGLTF(stage.engine, url)),
);
const mixamoAnimation = Animation.attach(mixamoModel), t = 0.5;

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
