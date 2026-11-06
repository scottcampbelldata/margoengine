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

A materials mesh writes velocity where its surface is: `displacement` moves it and `surfaceClip` cuts it (`displacementMap`, `clippingPlanes`). A displacement that changes between frames adds no velocity of its own; the mesh's motion does.

Core mesh motion and loaded glTF/FBX node motion are automatic, including parent transforms and reused entity IDs. `taa.add(pbrModel)` remains available for explicit velocity sources and safely overlaps automatic discovery. TAA reads the current animated stride-80 vertex buffer after skinning/morph computation and snapshots it on the GPU for the next frame. Static PBR vertices receive a lazily allocated TAA-owned storage copy from retained CPU data; ordinary PBR buffer usage is unchanged. There is no animation pass or palette duplication. Alpha-masked primitives retain UV0/UV1 selection, affine texture transforms, opacity maps (materials `alphaMap`), vertex alpha (left out with `vertexAlpha: false`) and cutoff, so a hole writes no velocity. The returned function unregisters the explicit source. Custom sources use the `shadowPrimitives` contract (24-byte core or 80-byte PBR vertices); PBR buffers need storage usage or retained `primitive.vertices`; a primitive with no alpha texture reads as opaque. Disposed models are removed during rendering.

Other opaque renderers get camera-motion reprojection from scene depth. Custom deformation needs registered velocity primitives. Transparent particles, blended glTF and splats use the underlying opaque depth and neighborhood clamping; they do not supply their own velocity or occlusion history. Fast transparent effects can still ghost. Call `reset()` when a scene change cannot be described by motion.

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
let taa;
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

`gpuState` exposes velocity, current history color and history depth textures after rendering. `dispose()`/`destroy()` releases owned buffers, textures and source records. Device restoration recreates everything and discards stale history. The package is independent of PBR, animation, shadows, clustered lighting, particles and stage; helper-only imports discard the renderer. It follows the workspace's `@margoengine/*` naming convention.

## Upscaling: `TAAUpscale`

`@margoengine/taa/upscale` renders the scene below output size and rebuilds the full frame, from jittered frames or, with
`temporal: false`, with a Lanczos filter. It runs instead of `TAA`, not with it.

```ts
import {Engine} from 'margoengine/core';
import {TAAUpscale} from 'margoengine/taa/upscale';
declare const canvas: HTMLCanvasElement;
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
