# @margoengine/taa

Import `margoengine/taa` from the `margoengine` package, or `@margoengine/taa` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional WebGPU temporal anti-aliasing. Eight Halton (2,3) projection offsets move raster samples by fractions of a pixel. An `rg16float` velocity buffer stores current minus previous UV coordinates. History is kept at the unjittered pixel centres and reprojected by the motion alone (the velocity minus the jitter difference) with bilinear depth-tested taps, clamped to the current 3×3 neighborhood in YCoCg, and blended in linear RGB. Two HDR color histories and two `r32float` depth histories alternate without GPU readback.

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

TAA captures the final display color before main and resolves at frame-graph order 40, after SSAO or creative post-processing at 30. For another plugin that replaces scene depth, provide `depth:()=>sourceTexture` in the options: `SSAO.depthTexture` or `PostProcessing.target?.depth`. Attachments must be sampleable, single-sample (TAA throws a `state` MargoError for a multisampled one), match the viewport and use the scene's depth format. Beside a standalone `Tonemap`, or any capture that begins after TAA's own, TAA reads the depth that capture's scene was drawn into, resolved to one sample, so `TAA.attach(engine)` next to `Tonemap.attach(engine)` needs no `depth` option. SSAO and creative PostProcessing continue to own their respective HDR passes; TAA converts their final sRGB output to linear RGB before accumulation.

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
smear on the effect itself. Masks another package publishes for the frame, such as Water's `reactiveTexture`, are read
with no option and combined with `reactive` by their maximum, so a scene with water and TAA wires nothing. With no mask
given or published TAA compiles the same resolve as before; the first frame with one compiles the masked resolve, which
stays. The texture may change from frame to frame. A reactive pixel shows that frame's own jittered sample, so its
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

A still view converges on its supersampled mean. Until 2026-11-16 the resolve fetched history by the whole velocity,
jitter difference included, so a still view's history moved by up to 0.8 px through a bilinear tap every frame and
blurred: 8 px sine stripes converged at 113.9 sRGB levels against 103.4 for the mean of the 8 jitter phases and
103.75 box-filtered (KB-TAA-CLAMP1). Fetched by the motion alone they converge at 103.2 (102.9 to 103.4 frame by frame)
in every rejection mode
(`test/converge-browser.mjs`, RTX A6000). Sources: L. Yang, D. Nehab, P. V. Sander, P. Sitthi-amorn, J. Lawrence and
H. Hoppe, "Amortized Supersampling", ACM TOG 28(5), 2009, https://doi.org/10.1145/1618452.1618481 (the blur of repeated
bilinear resampling); L. J. F. Pedersen, "Temporal Reprojection Anti-Aliasing in INSIDE", GDC 2016,
https://www.gdcvault.com/play/1022970 (reprojection without the jitter); Karis 2014 and Yang, Liu and Salvi 2020 below.

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

## Still views settle

With the camera and the scene still, a jittered resolve keeps blending one of 8 sample positions into its history, so
small highlights and thin wires used to change from frame to frame for as long as the view held still (up to 189
levels, on 2.4% of the pixels of a bright scene). `settle` (default true, fixed at construction) stops that. The jitter
repeats every 8 frames, so with the camera still a pixel's sample in phase k must equal its sample in phase k one cycle
ago bit for bit unless the scene changed there (the temporal gradient of Schied et al. 2018, with the repeating jitter
supplying the re-shaded sample for free). A detect pass hashes each render pixel's sample per phase and counts the frames
in a row that matched. A pixel whose 3x3 footprint has matched for a whole cycle then averages the next cycle's 8
samples with equal weight, which is the supersampled value amortised over frames (Yang et al. 2009), shows that mean and
keeps it. Any mismatch in the footprint, a camera move, a reset, or a `reactive` pixel (particles, weather, splats)
hands the pixel back to the clamped history in the same frame, so a moving surface is never held. A scene with
per-frame noise never matches and behaves as before. `settle: false` keeps the per-frame resolve alone.

```ts
import {EngineKernel,box} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
engine.createMesh().setGeometry(box());
TAA.attach(engine, {settle: true}); // the default: a still view stops changing after about 16 frames
// TAA.attach(engine, {settle: false}); // the per-frame resolve alone, for a capture that wants the jitter
```

Measured on an RTX A6000 (`packages/taa/test/still-browser.mjs`, `settle-reactive-browser.mjs`): 0% of the pixels of
still frames change, with a largest difference of 0, against 2.4% before; a reactive pixel never settles and leaves no
trail (-1.33 levels against a bound of 3). It costs one compute pass at render size, one 16-byte uniform write and one
texture copy a frame, and 32 bytes a pixel (66 MB at 1920 x 1080); `TAAUpscale` takes two rgba16float textures at
output size and (ceil(phases / 3) + 1) words per render pixel instead.

## History is fetched by the motion alone

Both matrices are jittered, so the velocity of a still pixel is not zero: it holds the difference between this frame's
jitter and the last one. Fetched by the whole velocity, a still view's history was bilinearly resampled up to 0.8 px
away every frame, which blurred it (8 px sine stripes sat 10.5 sRGB levels off the supersampled mean, KB-TAA-CLAMP1).
The resolve now fetches at the pixel centre minus the velocity plus `taa.velocity.jitter`, so a still pixel reads
its own history texel. `taa.velocity` itself is unchanged: it still holds the whole difference, and an effect that
wants the scene's own motion subtracts the jitter, as `MotionBlur` does.

```ts
import {EngineKernel,box} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
engine.createMesh().setGeometry(box());
const taa = TAA.attach(engine);
engine.start();
// The scene's own motion of a pixel is its velocity minus the jitter (uv units); the jitter is zero without history.
const jitter = taa.velocity?.jitter;
```

With `settle: false` the per-frame resolve of still stripes stays within 1 sRGB level of the settled mean in every
rejection mode (`packages/taa/test/converge-browser.mjs`: 102.9 to 103.4 against 103.4; before 113.9).

Sources: L. Yang, D. Nehab, P. V. Sander, P. Sitthi-amorn, J. Lawrence and H. Hoppe, "Amortized Supersampling", ACM
Transactions on Graphics 28(5), 2009, https://doi.org/10.1145/1618452.1618481; C. Schied, C. Peters and C. Dachsbacher,
"Gradient Estimation for Real-Time Adaptive Temporal Filtering", HPG 2018, https://doi.org/10.1145/3233301;
M. Jarzynski and M. Olano, "Hash Functions for GPU Rendering", JCGT 9(3), 2020,
https://jcgt.org/published/0009/03/02/; B. Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014 Advances in
Real-Time Rendering; M. Salvi, "An Excursion in Temporal Supersampling", GDC 2016.

## Shapes a shader moves

TAA reprojects each pixel by its velocity, and a mesh whose matrix never changes writes none, so a shape its vertex
shader moves (a wave, a sliding pattern, a flag) used to read its own stale history and trail. Two kinds now write their
own motion. A NodeMaterial `positionNode` that reads the graph's uniforms (a `uniform()` you change, `time`, the camera)
runs a second time in TAA's velocity pass on last frame's values, kept per view and draw, at last frame's model matrix.
A raw WGSL mesh opts in with `velocityEntry` and `taa.add(raw)` (see `@margoengine/shader/raw`); a raw mesh without it
keeps camera motion from its depth only. A move read from a storage buffer or texture that changes is not tracked.
Raw pipelines compile asynchronously on first use, so a raw mesh draws, and writes its motion, from the frame after its
pipelines finish; render once and `await raw.ready()` before frames that must show it.

Object motion is drawn again for each moving mesh with depthCompare 'equal' against the depth its colour pass wrote, so
TAA computes the clip position by the colour vertex's expression, `camera * (model * p)`, and declares it `@invariant`
(WGSL 12.10), as core's and gltf/pbr's colour shaders do: 1e4 m from the origin every pixel of a moving core or
gltf/pbr box gets its motion on WebGPU and the WebGL2 layer (`test/far-velocity-browser.mjs`).

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
| `depthThreshold` | `0.01` | Relative depth distance outside the history's depth range round the reprojected point that rejects history, 0 to 1 |
| `clampGamma` | `1.5` | Colour range history may keep, in standard deviations of the 3x3 neighbourhood |
| `sharpen` | `0.2` | Output sharpening, 0 to 1 |
| `settle` | `true` | A still view settles on the mean of one jitter cycle and stops changing; see "Still views settle". Fixed at construction |

Limits: one full-canvas view; multi-view frames throw. A scene `background` or a camera layer mask, which core passes as one full-canvas view, upscales like a plain frame. A `PostStack` inside it runs at the render size. Plugins that draw
after frame-graph order 39, such as `Selection`, draw over the full frame without scene depth. Moving objects are rejected
through depth and colour, not per-object velocity, so thin fast objects can ghost more than under `TAA`.

Measured on `packages/taa/test/upscale-browser.mjs` (640x480, scale 0.5, 4x MSAA, 50 frames, against a full-size frame):
31.8 dB accumulated against 30.5 dB for Lanczos, no red pixels trailing a box that crosses the frame.

History is rejected only where the reprojected surface is missing from the history: its nearest depth (the closest of
the 3x3 render pixels, after Karis 2014) is tested against the depth range of a 3x3 footprint of history, taps one
render pixel apart, not against the one history texel it lands on. Both depths are dilated at render size and the
jitter moves that dilation by up to a render pixel a frame, so a one-texel test at a silhouette passed and failed with
the jitter while the camera moved, and the edge showed the raw jittered frame (Nehab et al. 2007 for the cached-depth
test; Yang, Liu and Salvi 2020 on its failure at depth edges). `packages/taa/test/stability-browser.mjs` orbits a
0.1 m bright post in front of a far wall at 0.01 rad a frame and measures the edge alternation (per pixel and frame,
the part of the second difference in time that a steady change does not explain, in sRGB luma levels; RTX A6000):
0.195 on WebGPU and 0.201 on the WebGL2 layer, against 0.361 on WebGPU with the one-texel test (the layer read 0.200
before too: its resolve already takes each depth as the nearest of five texels, a wider dilation); 0.133 at 0.001 rad
a frame. A box crossing the wall leaves no red trail.

Sources for the rejection: B. Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014 Advances in Real-Time
Rendering, https://advances.realtimerendering.com/s2014/; D. Nehab, P. V. Sander, J. Lawrence, N. Tatarchuk and
J. R. Isidoro, "Accelerating Real-Time Shading with Reverse Reprojection Caching", Graphics Hardware 2007,
https://doi.org/10.2312/EGGH/EGGH07/025-036; L. Yang, S. Liu and M. Salvi, "A Survey of Temporal Antialiasing
Techniques", Computer Graphics Forum 39(2), 2020, https://doi.org/10.1111/cgf.14018; M. Salvi, "An Excursion in
Temporal Supersampling", GDC 2016,
https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf. Colour-side
clipping such as Ikkala et al., "k-DOP Clipping: Robust Ghosting Mitigation in Temporal Antialiasing" (2024,
https://webpages.tuni.fi/vga/publications/k_DOP_Clipping.html) narrows ghosts but does not touch the depth test, so it
was not the fix here.

## Film time: seeking the jitter to a cut

`TAA` and `TAAUpscale` have `advanceTime(delta)`, the CPU part of their frame update, and a `time` getter; with frame
updates the Halton jitter phase follows them, so `seek` from `@margoengine/cutscene/seek` lands a fresh scene on the
phase a continuous run has there (`test/seek.test.js`). The history is view history: a cut starts it empty, as a camera
cut does, and `reset()` restarts the history but keeps the phase of an engine-updated TAA. An update with a delta of 0
is the same instant drawn again (a `Reflector`, `Refractor` or `CubeCamera` from `@margoengine/environment` renders the
scene with one inside every frame), so it moves no phase; a frame drawn after updates of 0 only takes one new phase.
With `historyWeight` w the
history keeps w^n of any gap after n frames, so a warm-up of ln 255 / ln(1 / w) frames (53 at the default 0.9) leaves
under 1 level of 255 on an LDR frame (`test/seek-check.mjs`, WebGPU and the WebGL2 compatibility layer).

```ts
import {Engine} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
import {seek} from 'margoengine/cutscene/seek';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const taa = TAA.attach(engine);
// The scene starts 95 s into the film: seek 53 frames short of it, then draw them as the warm-up.
await seek(engine, 95 - 53 / 60, {fps: 60});
for (let frame = 0; frame < 53; frame++) engine.render({delta: 1 / 60});
console.log(taa.time);
```

## Preview tier contract

On the WebGL2 compatibility layer, `TAA` and `TAAUpscale` need the half-float tier or better: their history accumulates
below one 8-bit level, and on the LDR tier 90 percent of pixels came out more than 2 levels off. They refuse LDR at
attach and after a device restore with `MargoError` code `unsupported` (`TAA history`) before allocating anything; a
restore that refuses also removes the effect from its scene.

With a 4x capture on the WebGL2 layer, `TAAUpscale` reads each depth texel as the nearest of the texel and its four
neighbours. WebGL2 shaders cannot read single samples, so the layer's resolved depth is one sample where native WebGPU
keeps the nearest of four; the neighbours put silhouette texels back on the object. The test scene accumulates 31.96 dB
on the layer against 31.76 dB natively (30.90 before). Native WebGPU reads are unchanged.

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

TAA and TAAUpscale keep the source camera on their transient raster-camera wrappers. The optional
staging still controller uses the source projection for idle detection and tracing, then restores
the raster camera before temporal resolve; stationary jitter does not reset still convergence.

Explicit TAA and TAAUpscale disposal detaches from the owning scene and preserves effects with the same name in other scenes. The scene-owner regression covers replacement and repeated disposal.
