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

The separate `@margoengine/animator` package adds gameplay states, blend trees, additive masks and foot IK while reusing this pass's palette buffers. `sampleTrack()` and `multiplyMatrices()` are exported for animation consumers.

Animation installs an optional `model.prepareDeformation` encoding hook. GPU
picking and explicit CPU snapshots use it to update the same skin/morph output
after a seek, bone edit or weight change without needing a beauty frame. Queries
do not advance playback time. The hook survives device restoration; disposal
removes only the animation instance's own hook. No CPU skinning copy is added to
the playback path.

Run the character demo at `/examples/robot-expressive.html` (also `character-animation.html`). RobotExpressive comes from the Three.js sample assets, by Tomás Laulhé with morphs by Don McCurdy, [CC0 credits](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/README.md). It is not a Khronos sample.

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

Tracks target a bone (by name) or the caller's node by a stable string id, for translation, rotation and scale. Each
key carries its own interpolation for the time until the next key: `discrete` (hold, then jump at the next key),
`linear`, `easeIn`, `easeOut` or `easeInOut` (cubic); rotations slerp along the shortest path by the eased factor.
Sampling is a pure function of time, so editing, scrubbing, playback and offline rendering agree at any frame rate.
`bakeKeyframeClip` writes glTF samplers: a track of only discrete keys becomes STEP and one of only linear keys becomes
LINEAR, both at their keys and exact everywhere; other tracks are LINEAR at the keys plus every `1 / fps` second inside
eased segments, exact at those times. Pass the result to `@margoengine/exporters` as an `ExportScene` animation; tracks
whose target `resolve` maps to undefined are left out.
