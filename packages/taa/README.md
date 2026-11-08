# @margoengine/taa

Import `margoengine/taa` from the `margoengine` package, or `@margoengine/taa` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional WebGPU temporal anti-aliasing. Eight Halton (2,3) projection offsets move raster samples by fractions of a pixel. An `rg16float` velocity buffer stores current minus previous UV coordinates. History is reprojected with bilinear depth-tested taps, clamped to the current 3×3 neighborhood in YCoCg, and blended in linear RGB. Two HDR color histories and two `r32float` depth histories alternate without GPU readback.

```ts
import {EngineKernel,box} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
engine.createMesh().setGeometry(box());
const taa = TAA.attach(engine, {historyWeight:0.9, depthThreshold:0.01});
engine.start();
// taa.reset() after a camera teleport, scene replacement or abrupt lighting change.
```

A materials mesh writes velocity where its surface is: `displacement` moves it and `surfaceClip` cuts it (`displacementMap`, `clippingPlanes`). A `NodeMaterial`'s `positionNode` and `discard()` do the same, from the same graph. A displacement that changes between frames adds no velocity of its own; the mesh's motion does.

Core mesh motion and loaded glTF/FBX node motion are automatic, including parent transforms and reused entity IDs. `taa.add(pbrModel)` remains available for explicit velocity sources and safely overlaps automatic discovery. TAA reads the current animated stride-80 vertex buffer after skinning/morph computation and snapshots it on the GPU for the next frame. Static PBR vertices receive a lazily allocated TAA-owned storage copy from retained CPU data; ordinary PBR buffer usage is unchanged. There is no animation pass or palette duplication. Alpha-masked primitives retain UV0/UV1 selection, affine texture transforms, opacity maps (materials `alphaMap`), vertex alpha (left out with `vertexAlpha: false`) and cutoff, so a hole writes no velocity. The returned function unregisters the explicit source. Custom sources use the `shadowPrimitives` contract (24-byte core or 80-byte PBR vertices); PBR buffers need storage usage or retained `primitive.vertices`; a primitive with no alpha texture reads as opaque. Disposed models are removed during rendering.

Other opaque renderers get camera-motion reprojection from scene depth. Shapes a shader moves write their own motion: a NodeMaterial `positionNode` that reads its uniforms needs nothing (last frame's uniforms are kept per view), and a raw WGSL mesh does with `velocityEntry` and `taa.add(raw)` (`@margoengine/shader/raw`); other custom deformation needs registered velocity primitives. Transparent particles, blended glTF and splats use the underlying opaque depth and neighborhood clamping; they do not supply their own velocity or occlusion history. Fast transparent effects can still ghost unless they are drawn into the `reactive` mask (below). Call `reset()` when a scene change cannot be described by motion.

`historyWeight` is in [0,1), default 0.9; zero disables history blending. `depthThreshold` is the relative reversed-depth rejection tolerance in [0,1], default 0.01. Parameters are validated before commands. History resets on resize, projection changes and device restoration; first-frame/newly visible primitives reject history. Rendering receives a retained camera view with the jittered matrix and the public camera's current properties. The public camera matrix stays unchanged, including when another pass throws; presentation restores the original context camera reference. Culling uses the normal camera frustum. With engine views, each view (by `RenderView.id`) keeps its own history, jitter and captures at canvas size; a view not drawn for a frame releases them.

TAA captures the final display color before main and resolves at frame-graph order 40, after SSAO or creative post-processing at 30. For another plugin that replaces scene depth, provide `depth:()=>sourceTexture` in the options: `SSAO.depthTexture` or `PostProcessing.target?.depth`. Attachments must be sampleable, match the viewport and use the scene's depth format. SSAO and creative PostProcessing continue to own their respective HDR passes; TAA converts their final sRGB output to linear RGB before accumulation.

`taa.velocity` (undefined before the first resolved frame) is for effects that use the motion vectors, such as
`MotionBlur` from `@margoengine/post/motion-blur` (`new MotionBlur({velocity: () => taa.velocity})`): `texture` is the
`rg16float` velocity buffer (current minus previous uv, written at order 9), `jitter` the uv difference between this
frame's Halton offset and the last one, which every vector holds because both matrices are jittered (subtract it for
the scene's own motion; zero on a frame without history), and `resolved` the frame TAA presented (`rgba16float`, this
frame's after order 40). The getter adds no GPU work: with it TAA makes exactly the GPU calls it made before
(`examples/package-benchmarks/proofs/taa-velocity.proof.js`, against `6c20076d`); checked on a real GPU, at rest the
velocity texture equals `jitter` within 2e-6 uv (`post-effects-gpu.mjs --only=motion`). An effect that changes the
picture after TAA must not write `resolved`: TAA reads it as history next frame.

`velocityOnly: true` gives an effect the motion vectors without anti-aliasing: no jitter, no scene capture, no history and no resolve, so the picture stays the scene's own, `taa.velocity.jitter` is zero and `taa.velocity.resolved` is undefined. It needs `depth`, and at 4x MSAA a PostStack to read the scene from; `gpuState` throws, as there is no history to show. Fixed at construction, default false.

```ts
import {TAA} from 'margoengine/taa';
import {PostStack} from 'margoengine/post';
import {MotionBlur} from 'margoengine/post/motion-blur';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
let taa: TAA | undefined;
const stack = PostStack.attach(stage.engine, [new MotionBlur({velocity: () => taa?.velocity})]);
taa = TAA.attach(stage.engine, {velocityOnly: true, depth: () => stack.depthTexture});
```

`stochastic: true` keeps history across surfaces cut by noise, such as `alphaHash` from `@margoengine/materials/alpha-hash`. Such a pixel shows the surface on one frame and what is behind it on the next, and the per-pixel depth rejection would keep the two apart and leave the grain. History is accepted over the 3x3 depth range instead, with the nearest pixel's motion, at the price of a pixel of ghosting along moving edges. Default `false`, which compiles the same rejection as before.

```ts
import {EngineKernel} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
TAA.attach(engine, {stochastic: true});
```

`reactive` lets particles, blended glTF surfaces and splats mark the pixels where history cannot be trusted: they move
without motion vectors, so TAA would reproject what was behind them and leave a ghost trail. Return a texture whose red
channel, 0 to 1, takes that share of the history weight away (1 keeps none); draw their coverage into it each frame
before TAA resolves at frame-graph order 40 (particles draw at 6, splats at 3). Any 2D float or unorm format and any size
works (it is read scaled to the view); return undefined for a frame with nothing reactive. TAA keeps each frame's mask in
the alpha of its history, so the pixels an effect has just left drop their history too and the trail goes, not only the
smear on the effect itself. Fixed at construction whether a mask is used (default none, which compiles the same resolve
as before); the texture may change from frame to frame. A reactive pixel shows that frame's own jittered sample, so its
edges alias until history builds again.

```ts
import {EngineKernel} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const mask = engine.gpu!.createTexture({
  size: [640, 360],
  format: 'r8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
// Each frame, clear `mask` and draw the coverage of your particles or splats into it (a render pass at order 6 to 39).
TAA.attach(engine, {reactive: () => mask});
```

`rejection` and `locks` change how history is kept. With the default `rejection: 'clamp'` reprojected history is clamped,
per axis, to the min/max box of this frame's 3x3 neighbourhood in YCoCg; one bright pixel in the neighbourhood opens
that box wide, and a ghost survives inside it. `'variance'` clips history toward the centre of the box mean +-
`clipGamma` standard deviations (default 1.25, 0.5 to 4, read every frame), cut to the min/max box, which one outlier
moves much less. `locks: true` marks a pixel one pixel wide against its neighbours across x or y (a wire, a fence rail, a
far edge) and keeps its history unclipped for the eight frames of the jitter cycle after it was last seen, so a thin
feature the jitter misses on some frames stays on screen instead of flashing; rejected history and reactive pixels drop
the lock. Both are fixed at construction; depth rejection of disoccluded history applies in every mode.

```ts
import {EngineKernel} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
TAA.attach(engine, {rejection: 'variance', clipGamma: 1.25, locks: true});
```

`@margoengine/taa/sharpen` adds a contrast-adaptive sharpen after TAA at native resolution, for the softness history
blending leaves. `present: new Sharpen({amount})` (0 off to 1, default 0.3, read every frame from `sharpen.amount`) runs
an unsharp mask on the four neighbours in TAA's present pass. Its strength falls as a pixel's neighbourhood nears black
or white, and the result is clamped to that neighbourhood's range, so it adds no halo and never clips. Only the frame
shown is sharpened, never the history, so it does not build up from frame to frame. `TAAUpscale` uses the same function
for its `sharpen` option. `present` is fixed at construction; without it TAA's GPU work is unchanged.

```ts
import {EngineKernel} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
import {Sharpen} from 'margoengine/taa/sharpen';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const sharpen = new Sharpen({amount: 0.4});
TAA.attach(engine, {present: sharpen});
sharpen.amount = 0.6; // takes effect next frame
```

`gpuState` exposes velocity, current history color and history depth textures after rendering. `dispose()`/`destroy()` releases owned buffers, textures and source records. Device restoration recreates everything and discards stale history. The package is independent of PBR, animation, shadows, clustered lighting, particles and stage; helper-only imports discard the renderer. It follows the workspace's `@margoengine/*` naming convention.

## Shapes a shader moves

TAA reprojects each pixel by its velocity, and a mesh whose matrix never changes writes none, so a shape its vertex
shader moves (a wave, a sliding pattern, a flag) used to read its own stale history and trail. Two kinds now write their
own motion. A NodeMaterial `positionNode` that reads the graph's uniforms (a `uniform()` you change, `time`, the camera)
runs a second time in TAA's velocity pass on last frame's values, kept per view and draw, at last frame's model matrix.
A raw WGSL mesh opts in with `velocityEntry` and `taa.add(raw)` (see `@margoengine/shader/raw`); a raw mesh without it
keeps camera motion from its depth only. A move read from a storage buffer or texture that changes is not tracked.

```ts
import {EngineKernel} from 'margoengine/core';
import {planeGeometry} from 'margoengine/geometry';
import {createMesh} from 'margoengine/materials';
import {NodeMaterial, positionLocal, uniform, vec3, sin} from 'margoengine/shader';
import {TAA} from 'margoengine/taa';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
TAA.attach(engine);
const phase = uniform(0);
createMesh(engine, planeGeometry(2, 2), new NodeMaterial({positionNode: positionLocal.add(vec3(sin(phase), 0, 0))}));
engine.onFrame((_, delta) => { phase.value += delta * 4; }); // its motion reaches TAA by itself
```

## Stereo and XR

TAA runs per eye with no extra entry. `@margoengine/xr` with an engine from `createXREngine` draws each eye as a view of
`engine.render({views})` with its own id (`xr-0`, `xr-1`), and TAA keeps a history, jitter cycle and captures per view
id, so neither eye reprojects the other's frame. An eye's frustum may be off-axis, as WebXR gives it: the jitter is
added to the eye's own projection. Each eye then costs a full TAA pass and history at the eye's size. Multiview (both
eyes in one pass into a texture array) is not offered by the engine, so TAA has no multiview path.

```ts
import {box} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
import {XR,createXREngine} from 'margoengine/xr';
const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await createXREngine(canvas);
engine.createMesh().setGeometry(box()).setPosition([0,1.5,-2]);
TAA.attach(engine); // one history per eye
const xr=await XR.create(engine);
const enter=document.createElement('button');enter.textContent='Enter VR';document.body.append(enter);
enter.onclick=()=>void xr.requestSession('immersive-vr').catch(engine.onError);
engine.start();
```

## Upscaling: `TAAUpscale`

`@margoengine/taa/upscale` renders the scene below output size and rebuilds the full frame, from jittered frames or, with
`temporal: false`, with a Lanczos filter. It runs instead of `TAA`, not with it.

```ts
import {Engine} from 'margoengine/core';
import {TAAUpscale} from 'margoengine/taa/upscale';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const upscale = TAAUpscale.attach(engine, {scale: 0.67, sharpen: 0.2});
upscale.options.scale = 0.5; // options are read every frame, so a ResolutionScaler can drive this
upscale.reset(); // after a camera cut
```

| Option | Default | Meaning |
| --- | --- | --- |
| `scale` | `0.67` | Render size as a share of output size, 0.25 to 1 |
| `temporal` | `true` | False upscales each frame with Lanczos, no jitter and no history |
| `historyWeight` | `0.9` | Share of history in each frame, at least 0 and below 1 |
| `depthThreshold` | `0.01` | Relative depth difference that rejects history, 0 to 1 |
| `clampGamma` | `1.5` | Colour range history may keep, in standard deviations of the 3x3 neighbourhood |
| `sharpen` | `0.2` | Output sharpening, 0 to 1 |

Limits: one full-canvas view; multi-view frames throw. A `PostStack` inside it runs at the render size. Plugins that draw
after frame-graph order 39, such as `Selection`, draw over the full frame without scene depth. Moving objects are rejected
through depth and colour, not per-object velocity, so thin fast objects can ghost more than under `TAA`.

Measured on `packages/taa/test/upscale-browser.mjs` (640x480, scale 0.5, 4x MSAA, 50 frames, against a full-size frame):
31.8 dB accumulated against 30.5 dB for Lanczos, no red pixels trailing a box that crosses the frame.
