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
