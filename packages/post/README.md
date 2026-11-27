# Margo Engine Post

Import `margoengine/post` from the `margoengine` package, or `@margoengine/post` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional WebGPU frame-graph SSAO, GTAO, SSR and SSGI, bloom, motion blur, lens flare, afterimage trails, SMAA and FXAA, a glitch and an effect stack, separate from the frozen core and stage.

## HDR images and render exports: `ImagePost`

`ImagePost` (`@margoengine/post/image`) runs one bloom and display transform for both a path-traced HDR viewport and
its offscreen PNGs, so exports match what is on screen.

```js
import { ImagePost } from 'margoengine/post/image';
import {Engine} from 'margoengine/core';
const width = 64, height = 64, signal = AbortSignal.timeout(30_000);
const engine = await Engine.create(document.querySelector('canvas')!);

const post = ImagePost.attach(engine, { bloom: { strength: 0.8, threshold: 1, radius: 0.5 } });
// Any linear image: RGB floats, as the voxel path tracer's renderImage gives.
const image = { width, height, color: new Float32Array(width * height * 3).fill(0.5) };
const png = await post.capture(image, { signal });
```

Options: `bloom` (strength, threshold, radius), `toneMapping` (`'neutral'` by default, `'linear'` or
`'aces-narkowicz'`), `exposure` in stops (default 0), `gamma` (1 to 5; leave unset for sRGB) and `vignette` (default
0). The producer's viewport already applies its exposure and vignette, so pass the same values here; raw
`renderImage` pixels get them once on export. `setOptions()` replaces the whole preset and is refused while an export
runs. `capture()` returns a PNG blob; `renderImage(image, { signal })` returns display-encoded RGBA8 pixels instead.
Call it once per frame for a sequence.

The source image is linear RGB. Optional coverage `alpha` means RGB is premultiplied; output PNGs have straight alpha,
and glow can raise coverage over a transparent background. Exports are limited to 16,777,216 pixels and the device's
texture limits; use the tracer's own capture for larger images without post-processing. Cancelling, a device change or
disposal ends an active export. Dispose `ImagePost` before its engine, and detach it when bloom is off.

`Bloom.encodeImage(context, input, output)` runs the same HDR bloom kernel for other packages: use a separate
unattached `Bloom`, `rgba16float` views of the image size, and submit before disposing it.
Bloom reads non-finite HDR input as finite light: NaN and -Inf as 0, +Inf as 65504 (the largest half float), so one
bad texel from an overflowing emissive or a broken shader stays where it is instead of spreading through the glow
chain; finite images filter exactly as before.

### Bloom: energy and fireflies

Bloom's glow of a light sums to `strength` times its light above `threshold`, whatever the light's size: glare is a
linear spread by a point spread function that integrates to the share scattered (Spencer, Shirley, Zimmerman and
Greenberg, "Physically-Based Glare Effects for Digital Images", SIGGRAPH 1995). `fireflies` (default `'temporal'`,
read every frame) sets how a pixel far brighter than its neighbours is damped:

| `fireflies` | What glows |
| --- | --- |
| `'temporal'` | Light that was there the frame before glows with all its energy (its 3 x 3 neighbourhood of the coarsest level, 64 px a texel at six levels, bounds what each pixel keeps, so a steady light may move that far a frame). A spike that was not there (a glint one sample caught for one frame) keeps only the Karis share for that frame. The first frame keeps everything. |
| `'karis'` | Every top-level box is weighted by 1 / (1 + luma) (Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014; Jimenez, SIGGRAPH 2014), steady or not: a lamp flame 2 x 3 px at 17,000 cd/m2 keeps 57% of its glow, a lone texel 25%. Bloom did this on every frame before KB-CABIN-BLOOM1. |
| `'none'` | Every pixel glows by its energy, one-frame spikes included. |

`packages/post/test/bloom-energy-browser.mjs` measures it on a GPU: a 2 x 3 px flame at 17,000 cd/m2 keeps 99.3% of
`strength` x its light with the Cabin Hearth kit's options and 99.7% with the defaults (binary16 rounding bounds the
loss at 0.86%), also when it moves 40 px between frames; a new one-texel spike keeps the Karis share, 25%. The temporal
mode adds nine texel reads per top-level texel and 256 B of uniform; the coarsest level it reads is the chain's own.

```ts
import {Engine} from 'margoengine/core';
import {Bloom} from 'margoengine/post/bloom';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const bloom = Bloom.attach(engine, {strength: 0.12, threshold: 1.2, radius: 0.8});
bloom.options.fireflies = 'karis'; // every bright spike damped, from the next frame
```

## Combining effects: `PostStack`

On the WebGL2 compatibility layer, a stack with HDR or display effects requires
the half-float or full device tier. LDR clamps linear scene radiance and fails the
layer's existing pixel rule, so these stacks throw linked `unsupported` at setup,
before attaching effects or allocating their GPU resources. A device restore to
LDR releases the old capture and refuses the same requirement. Stacks containing
only LDR effects remain available on LDR devices. The example below runs unchanged
on native WebGPU, full WebGL2 and half-float WebGL2.
Standalone Bloom and SSAO have the same minimum tier, including Bloom's image
encoding path. Their initialization refuses LDR before allocating; restoration
releases old resources before rechecking. SSAO's geometry buffers need signed
values, while Bloom needs linear radiance above one. GTAO inherits SSAO's check
inside its required PostStack. No effect silently replaces these values with
clamped eight-bit data.

A refused restoration disposes and detaches standalone Bloom or SSAO. A refused
HDR stack disposes and detaches its children too, before `engine.onError` reports
the original error once. Later frames render without those effects. Handle initial
attachment refusal and restoration notification separately:

```ts
import {Engine} from 'margoengine/core';
import {PostStack} from 'margoengine/post/stack';
import {SSAO} from 'margoengine/post/ssao';
import {Bloom} from 'margoengine/post/bloom';
const engine = await Engine.create(document.querySelector('canvas')!, {backend:'webgpu'});
const unsupported = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'unsupported';
engine.onError = (error) => {
  if (unsupported(error)) {
    console.info('HDR effects detached: this device cannot preserve HDR.');
    return;
  }
  console.error(error);
};
try {
  PostStack.attach(engine, [new SSAO(), new Bloom()]);
} catch (error) {
  if (!unsupported(error)) throw error;
  console.info('HDR effects unavailable: rendering the scene without them.');
}
// After capability recovery, attach a new stack with new effects.
```

Post effects and `PostStack` can be attached to a secondary scene with `scene.use()`.
Disposing an effect detaches it from its owning scene. A stack removes only its
original attached children, preserving same-name replacements and other scenes.
`DepthTexture` also detaches its wrapper registration before releasing its capture.

```ts
import {Engine} from 'margoengine/core';
import {PostStack} from 'margoengine/post/stack';
import {FXAA} from 'margoengine/post/fxaa';
const engine = await Engine.create(document.querySelector('canvas')!);
const product = engine.createScene('product');
const stack = new PostStack([new FXAA()]);
product.use(stack);
stack.dispose();
```

Each effect alone owns its own scene capture, so alone they reject each other. `PostStack`
(`@margoengine/post/stack`) captures the scene once in linear HDR and runs its effects on that
capture in array order:

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {SSAO} from 'margoengine/post/ssao';
import {Bloom} from 'margoengine/post/bloom';
import {FXAA} from 'margoengine/post/fxaa';
import {DOF} from 'margoengine/dof';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const stack = PostStack.attach(stage.engine, [new SSAO(), new DOF({focalDistance: 6}), new Bloom({strength: 0.6}), new Tonemap({curve: 'neutral'}), new FXAA()]);
// TAA wraps the stack: TAA.attach(stage.engine, {depth: () => stack.depthTexture});
stack.dispose(); // also disposes its effects
```

- Order is HDR effects (`SSAO`, `SSR`, `DOF`, `Bloom`, `Afterimage`), then at most one display effect (`Tonemap` or
  creative `PostProcessing`), then LDR effects (`SMAA` or `FXAA`, then `Glitch`). Anything else throws, and so does a
  stack holding both `SMAA` and `FXAA` (`TypeError`: keep one anti-aliasing effect). Put SSAO first: it
  darkens the captured ambient light. Put SSR before DOF and Bloom so reflections are blurred and glow too.
- HDR effects hand linear light to the next effect. Without a display effect, the last HDR effect
  tonemaps exactly as it does alone, with Margo's display curve (Khronos PBR Neutral, then sRGB), as core does.
- The stack attaches its effects; keep references to change their options. Effects given to a stack
  belong to it and cannot also be attached alone. Disposing one effect drops it from the chain.
- Standalone Bloom, SSAO, DOF, Tonemap or PostProcessing on the same engine are refused.
  `stack.depthTexture` (and each member's `depthTexture`) is the shared resolved depth. A stack with
  only LDR effects keeps the core shader's own display mapping.
- `stack.sceneTexture` is the shared 1x linear HDR capture (`rgba16float`) when the stack has an HDR or
  display effect (undefined otherwise). It is what `@margoengine/water` refracts, so water refraction works
  together with SSAO: `Water.attach(engine, {depth: () => stack.depthTexture, sceneColor: () => stack.sceneTexture})`.
  Water draws into the capture before the stack's effects run. Real-GPU check:
  `packages/water/test/stack.browser.mjs` (refraction shows an underwater block, SSAO active in the same frame).
- Intermediate targets are two `rgba16float` and up to two canvas-format textures, created on first
  use and kept until resize or device restoration; one that no effect wrote in a frame (after a remove or a move) is
  freed at the end of that frame. Steady frames create no GPU objects.

### Changing the stack after setup

`addEffect`, `removeEffect` and `moveEffect` change a live stack between frames, and `PostStack.join` adds an
effect to the scene's stack or makes one. The new effect draws from the next frame:

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {SSAO} from 'margoengine/post/ssao';
import {Bloom} from 'margoengine/post/bloom';
import {FXAA} from 'margoengine/post/fxaa';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const stack = PostStack.attach(stage.engine, [new SSAO(), new Tonemap(), new FXAA()]);
const bloom = new Bloom({strength: 0.6});
stack.addEffect(bloom);                 // after the last HDR effect: SSAO, Bloom, Tonemap, FXAA
stack.moveEffect(bloom, 0);             // Bloom, SSAO, Tonemap, FXAA; nothing is disposed
console.log(stack.effects.map((effect) => effect.name)); // ['bloom', 'ssao', 'tonemap', 'fxaa']
stack.removeEffect(bloom);              // takes it out and disposes it, as scene.removePlugin does
const own = PostStack.join(stage.engine, new Bloom()); // the scene already has a stack: the same one
console.log(own === stack);             // true
stack.dispose();
```

- `stack.addEffect(effect, index?)` returns the stack. With no index the effect goes after the last effect of its
  kind (HDR, display, LDR), so a Bloom added to `[SSAO, Tonemap, FXAA]` lands before Tonemap. An index places it
  there and must keep the order. A refused call changes nothing: `TypeError` for an effect that cannot join, a
  repeated name or SMAA with FXAA; `RangeError` for an index out of range or out of order (a second display effect
  too); `MargoError` `'attached'` for an effect that is already attached or in another stack, `'unsupported'` for an
  HDR or display effect on the LDR tier, `'disposed'`, and `'state'` while a frame draws. An effect refused for its
  place may be added to the same stack again.
- `stack.removeEffect(effect)` returns true when the effect was in the stack. It disposes the effect, the same as
  `scene.removePlugin(name)`; to switch an effect off and on without that, set its `enabled` option.
- `stack.moveEffect(effect, index)` reorders without disposing; the order rule still holds.
- `stack.effects` is a frozen copy of the list, replaced on every change. An empty stack (`new PostStack()`) passes
  frames through untouched.
- `PostStack.join(engine, effect, index?)` adds to the PostStack of the engine's scene, or attaches a new one holding
  the effect; a stack that `join` made disposes itself when its last effect is removed. The one-effect factories
  (`NodePass.attach`, `ShaderPass.attach`, water `Caustics`, `Underwater` and `ParticleLiquid`, creative `Painterly`
  and `AnisotropicPainterly`, cameras `WideAngle` and `WideAngleCube`) use it, so they work on a scene that has a stack.
- Nothing is rebuilt stack-wide. The added effect compiles its own pipelines on its first frame, the same work as at
  construction; an existing effect compiles again only when its output changes (it becomes or stops being the last
  effect, or the last HDR effect that tonemaps). `packages/post/test/stack-dynamic.test.js` counts it: adding Bloom
  to `[SSAO, Tonemap, FXAA]` creates 4 pipelines and 3 textures, exactly the difference between constructing the two
  lists; moving or removing it creates none; removing Tonemap after Bloom creates 1 pipeline (Bloom's tonemapping
  output).
- The names other composers use (`addPass`, `insertPass`, `removePass`, `passes`) are mapped in the
  porting guide in `docs/`.

When the stack landed (`5b1fe66`), every effect used alone made exactly the GPU calls it made before the stack existed:
`examples/package-benchmarks/proofs/post-stack.proof.js` checks 12,378 recorded calls across 12 single-effect stories,
`5b1fe66^` against `5b1fe66`. With `--current` it checks the working tree against its stored historical tape, accounting
for exactly 23 unused SSAO resolves removed across its two stories (which switch between 1x and 4x).
Every other call and shader byte is compared. Bloom, FXAA and SSAO keep the canvas alpha.

## Ambient occlusion: `SSAO`

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {SSAO} from 'margoengine/post/ssao';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#8090a0'}));
const ao = SSAO.attach(engine, {radius: 0.5, samples: 32});
// Or put new SSAO() first in a PostStack, before the display effect.
ao.options.radius = 0.8;
```

At 4x MSAA, SSAO and GTAO resolve depth before extracting normals and replaying
ambient light. Scene colour resolves after these replays, before composition.
This removes one unused early HDR colour resolve per frame. At 1x no resolve
is needed. Sampling, ambient-only darkening, blur and display transforms are
unchanged. The work-count and exact-pixel checks are documented in
[the reproduction guide](../../docs/whitepaper/reproduce.md#batch-164-ssao-resolve-work).

SSAO and GTAO read view depth from an `r32float` target of their own (4 B a pixel), so an orthographic picture does
not change when the eye moves along its view, and scenes past 65,504 units keep their occlusion. The G-buffer that
sources draw into keeps normals and a half-float depth. `npm run test:gpu:ssao` in this package checks orthographic
cameras, an eye inside the part and image-based light.

## Screen-space reflections: `SSR`

`@margoengine/post/ssr` reflects what is on screen in glossy core meshes (floors, polished CAD metal) and in glTF PBR
models, `@margoengine/materials` meshes, `Terrain` (@margoengine/terrain) and `Water` (@margoengine/water) added with
`ssr.add(model)`. It is an HDR `PostStack` effect;
`SSR.attach(engine, options)` runs it alone in its own one-effect stack (tone mapped like SSAO alone).
At WebGPU's compatibility feature level, where one dispatch may not bind two views of a texture, SSR and SSGI reduce
each Hi-Z level into a texture of its own and copy it into the pyramid (one copy per level a frame, and the levels'
memory twice); elsewhere the pyramid is reduced in place.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {EnvironmentLighting} from 'margoengine/environment';
import {PostStack} from 'margoengine/post/stack';
import {SSAO} from 'margoengine/post/ssao';
import {SSR} from 'margoengine/post/ssr';
import {Bloom} from 'margoengine/post/bloom';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const ibl = await EnvironmentLighting.load(stage.engine, '/studio.hdr');
const ssr = new SSR({maxRoughness: 0.6, thickness: 0.5, maxDistance: 100, steps: 64});
const stack = PostStack.attach(stage.engine, [new SSAO(), ssr, new Bloom({strength: 0.6})]);
const helmet = await loadGLTF(stage.engine, '/FlightHelmet.glb'); // from 'margoengine/gltf/pbr'
ibl.add(helmet);                     // EnvironmentLighting, so SSR replaces its specular (below)
const stop = ssr.add(helmet);        // glTF PBR model or materials mesh: its own surfaces reflect; stop() undoes it
ssr.enabled = false; // pass-through, no recompiles
```

- **Material replay.** After the scene (order 14, after SSAO's replays) SSR redraws core meshes once at 1x with core's
  own shader (every pass binding; the lighting sits in a dead `if(false)` block so it keeps the bindings but costs
  nothing) into three targets: the environment specular already in the pixel plus roughness (`rgba16float`), the
  split-sum weight `F0·A+B` (`rgb10a2unorm`) and the shading normal (`rgb10a2unorm`). A 1x scene is replayed
  depth-`equal` against the stack's capture depth; a 4x scene into SSR's own 1x `depth32float` (pixel-centre
  materials and depth, so MSAA silhouettes never average two materials, and no multisampled targets). The Hi-Z is
  built from that depth. Memory: 16 B/pixel of targets (+4 B depth at 4x, or at 1x once models are added), a half-resolution `r32float` Hi-Z and a
  half-resolution `rgba16float` blur chain, about 45 MB at 1080p.
- **Model capture.** Models added with `ssr.add(model)` (a gltf/pbr `PBRModel` or a materials mesh; returns a remover,
  disposal of the model or of SSR detaches it) then draw into the same three targets in one more pass, through
  gltf/pbr's declared capture hook (gltf/pbr README "Capture hook"; no text search of its shader): their own base
  colour, metal/roughness, normal and occlusion maps, materials' maps, alpha mask, instances and skinned/morphed
  vertices, depth tested against and written into SSR's own 1x depth, which the Hi-Z is built from (with models added
  SSR keeps its own depth at 1x MSAA too, so a capture never writes the stack's depth, which water samples). BLEND, transmission and
  unlit primitives are skipped. Models not added are still reflected but do not reflect. With no model added SSR makes
  exactly the GPU calls it made before (`examples/package-benchmarks/proofs/post-ssr-models.proof.js`, against
  `3cf1453`). Models not added are missing from SSR's own depth, so rays pass through them. `Terrain` and `Water`
  take the same hook: shaders without gltf/pbr's PBR `Surface` get only `margoSSR` and the `MargoSSR` targets (the
  `SSRCapture` TSDoc), terrain calls `margoSSR` with its layer colour and roughness, water returns its own sky
  reflection as the specular to replace; their READMEs have the checks. One capture hook per model, shared with SSGI
  (`packages/post/src/capture.ts`). With models
  added the composite also never removes more specular than a pixel holds (a 4x silhouette pixel is the resolve of
  both sides while its material is the centre sample's; on DamagedHelmet's part seams this turned 68 pixels black):
  removal and replacement are scaled by `min(1, scene / specular)`, which is 1, so exact, wherever they agree.
- **Ray march.** One mirror ray per pixel, clipped to the near/far planes and the screen, marched in screen space over
  a hierarchical depth pyramid (Hi-Z: the closest depth per 2^n cell, up to 64 px cells) with `steps` iterations and a
  `thickness` (scene units) a ray may pass behind a surface. Pixel x/y and NDC depth are linear along the projected
  ray for perspective and orthographic (`@margoengine/cameras`) projections alike.
- **Roughness.** Surfaces rougher than `maxRoughness` are skipped; reflections fade out from half of it. The hit colour
  comes from a half-resolution mip chain of the scene, at the level whose texel spans the reflection cone's footprint
  at the hit: the cone of the surface's roughness (GGX alpha = roughness² as a Phong exponent, the cone holding 3/4 of
  the lobe, doubled for the reflected ray; Karis 2013, Walter et al. 2007, Uludag 2014: the same maths as environment's
  planar reflectors, `reflectionConeTangent`), times the world distance to the hit, projected at the hit's depth. So a
  contact stays sharp and the blur grows with distance from the surface whichever way the ray runs (until 2026-11-25
  the footprint came from the ray's on-screen length, which left rays running away from the camera nearly sharp;
  `test/ssr-cone-browser.mjs`). The chain is five half-resolution levels, so footprints over 64 pixels stop growing.
- **Rough reflections (`stochastic: true`).** Instead of skipping them, surfaces rougher than half of `maxRoughness`
  trace one ray per pixel per frame along a microfacet normal sampled from the GGX distribution of visible normals
  (Heitz 2018), and a resolve pass averages the rays over frames: last frame's result, reprojected through last frame's
  camera onto this pixel's surface point, is clamped to the mean plus or minus one standard deviation of this frame's
  3x3 neighbourhood and blended with this frame's sample by `max(1 / (frames + 1), 1 / 16)`. The composite adds it as
  `s · (weight · radiance − hitShare · iblSpecular)`, `s` rising from 0 at half of `maxRoughness` to 1 at it while the
  mirror path fades out, so the two meet without a seam. Off by default, which keeps frames deterministic and makes
  exactly the GPU calls SSR made before.

```ts
import {Engine} from 'margoengine/core';
import {SSR} from 'margoengine/post/ssr';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const ssr = SSR.attach(engine, {maxRoughness: 0.6, stochastic: true}); // rough floors reflect too, denoised over frames
ssr.options.stochastic = false;                                         // back to the deterministic mirror path
```

- **Fades.** Rays toward the camera, hits on back faces (hit normal along the ray), hits near the screen edge and hits
  near `maxDistance` fade out.
- **IBL fallback without double counting.** With `EnvironmentLighting` the replay computes the IBL specular the scene
  added (`prefiltered(R, roughness) · (F0·A+B) · intensity`, with environment's own LUT and cube) and the weight
  `F0·A+B`; the composite writes `scene + f · (weight · reflected − iblSpecular)`, `f` being the fades above. A ray that
  misses (`f = 0`: off screen, behind everything, too rough) leaves the pixel exactly as the environment lit it; a hit
  replaces the environment's specular instead of adding to it. Without IBL nothing is removed and the weight is an
  analytic split-sum fit. On models the environment's term is `iblShade(...)·occlusion` (and clearcoat/sheen scale the
  base layer by `k`), so the capture writes that specular and the weight both times `k·occlusion`: still exactly the
  term the model was lit with. Checked on a real GPU: a mirror floor under a uniform grey environment loses its grey
  reflection where the red box is reflected (green channel falls to the box's own), for a core floor, a glTF plane and
  a materials mesh alike, and a box above the view leaves the frame unchanged.
- **Temporal.** Without `stochastic`, deterministic (no noise), so frames are stable without TAA; with TAA wrapping the stack the jittered
  camera is used throughout and TAA's history smooths reflection edges.
- **Alpha and bindings.** Keeps the scene alpha (TransparentCanvas). SSR runs in its own passes (the composite samples 7 textures),
  so it adds nothing to the mesh shader's 16-texture budget.
- **Cost** (Intel Arc 140V, Edge 155, quiet machine, a 0.1-roughness floor filling most of the view: the worst case,
  every floor pixel traces). GPU time of SSR's own passes, replay + Hi-Z / blur + trace + composite:
  1280x720 4x 2.3 ms (0.7 / 1.6), 1x 2.2 ms (0.5 / 1.7); 1920x1080 4x 5.8 ms (1.6 / 4.2), 1x 5.9 ms (1.1 / 4.9).
  `steps: 16` cuts the trace by about a third. `enabled = false` still costs one full-screen copy (0.2-1.0 ms);
  remove SSR from the stack to drop it entirely. `examples/package-benchmarks/ssr-gpu.mjs` (results/ssr-gpu.json).
  The model capture pass adds 0.19-0.21 ms at 1280x720 and 0.44-0.46 ms at 1920x1080 for a glTF floor filling most
  of the view, 0.05-0.07 ms for DamagedHelmet (4x and 1x; diagnostic timings on a busy machine); the reflective model
  pixels then trace like core ones. `examples/package-benchmarks/ssr-models-gpu.mjs` (results/ssr-models-gpu.json).
- **Limits.** Core meshes and added models (gltf/pbr, materials, terrain, water) show reflections; other custom shaders
  are reflected but do not reflect (each would need its own capture into SSR's targets). Only what is on screen is
  reflected; with reflection probes (`@margoengine/environment/probes`) SSR removes the probes' own specular
  where its ray hits and keeps the probe's reflection elsewhere, so off-screen reflections come from the probes
  ([probes-gpu.json](../../examples/package-benchmarks/results/probes-gpu.json)). A clearcoat's own (hemisphere) reflection is not replaced; fog is not applied to the replaced
  term (core meshes alike). Materials `basic`/`normal`/`matcap` meshes reflect by their roughness like `standard` ones. With SSAO before it, a creased pixel's IBL specular was already darkened by AO, so a hit
  removes slightly more than was left (clamped at zero). Specular from other ambient plugins (sky's ambient patch) is
  not replaced. With `stochastic`: one history per SSR, so a second view in the same frame (split screen) reprojects
  against the first view's history; the history follows surfaces, not reflections, so a moving camera smears rough
  reflections for a few frames (the clamp limits it); 1 ray per pixel with a 1/16 blend floor leaves some noise
  (mean change from one still frame to the next 0.15/255 against 1.28/255 at the second frame); three more
  `rgba16float` targets (24 B/pixel); GPU cost not measured.

## Ray-traced reflections: `RTReflections`

`@margoengine/post/rt-reflections` is SSR with a ray tracer behind it. The material replay and the Hi-Z march stay as
above; where the screen holds no hit (the reflected thing is off screen, behind the camera, hidden behind nearer
geometry, or the ray runs toward the camera) the same ray is traced through a `GPUSceneBVH` from
`@margoengine/bvh/gpu-scene` (an optional peer). Every SSR option, `add(model)`, `enabled` and `stochastic` work the
same.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {MeshBVH} from 'margoengine/bvh';
import {GPUSceneBVH} from 'margoengine/bvh/gpu-scene';
import {RTReflections} from 'margoengine/post/rt-reflections';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const shape = box(2, 2, 2);
engine.createMesh().setGeometry(shape).setPosition([0, 3.5, -4]).setMaterial(new PbrMaterial({color: '#ff0000'}));
const scene = GPUSceneBVH.forShader(engine.gpu!, [
  {bvh: MeshBVH.fromGeometry(shape), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3.5, -4, 1], material: {color: [1, 0, 0]}},
]);
const rt = RTReflections.attach(engine, {scene, maxRoughness: 0.6}); // or put it in your PostStack like SSR
rt.options.shadows = false;   // skip the sun's shadow ray at traced hits (default true)
rt.options.stochastic = true; // rough surfaces trace their sampled rays through the scene too
```

- **Hybrid order** (Barre-Brisebois et al. 2019; Stachowiak 2015). SSR's fades (screen edge, rays toward the camera,
  back faces, distance) are the share of the ray the screen covers, `cover`. The trace adds the rest of the
  roughness-faded share, `smoothstep fade − cover`, from the same surface point along the same ray, offset by `bias`
  (default 0.01 scene units) along the normal, up to `maxDistance` and faded over its last 20% like SSR's hits. So a
  pixel the screen answers fully never traces, and on-screen and traced reflections meet without a seam.
- **Shading of traced hits.** Core's own lighting at the hit: the glTF 2.0 metal-rough BRDF of core's shader (GGX,
  height-correlated Smith, Schlick, Lambert) with the instance's `material` (colour, metalness, roughness, emissive),
  the engine's sun (`engine.lighting`, read every frame) with a shadow ray toward it through the same scene (`shadows`),
  core's flat ambient, and the emissive. The view vector is the reflected ray's reverse; the normal is the triangle's
  geometric normal turned toward it.
- **Rough surfaces (`stochastic`).** The GGX-sampled ray of each pixel traces the scene where its march leaves a share,
  and the resolve averages them as before.
- **Fallback.** A disposed scene, or one made on a device that was lost, runs as plain SSR (the same passes, no
  trace) until `rt.options.scene` is given a new one. Swapping the scene costs one bind group, not a shader.
- **Devices.** The traced passes bind the scene's 4 storage buffers in a fragment shader. A device at WebGPU's
  compatibility feature level that allows fewer (`maxStorageBuffersInFragmentStage`; 4 by default at that level, and
  an OpenGL ES 3.1 GPU need allow none) warns once with code `unsupported` and runs as plain SSR; it never throws.
  The WebGL2 layer traces on its full and half-float tiers; its LDR tier refuses any HDR PostStack.
- **Checked on a real GPU** (`test/rt-reflections-browser.mjs`: WebGPU, WebGPU at the compatibility level, the WebGL2
  layer and its half-float tier, identical figures on an RTX A6000 apart from the rough count, 2,684 to 2,747): a mirror floor under a red box above the view, which SSR alone leaves dark, shows the box's underside
  (1,415 pixels), median 208 against the closed form 208.46 (display of the floor's split-sum weight times albedo x
  ambient + emissive); the sun from below behind a plate leaves it unlit, without the plate it is lit (248), and
  `shadows: false` equals the unshadowed frame exactly; a rough floor with `stochastic` shows the box on 2,699 pixels.
- **Limits.** Traced hits see the scene's instances only: what is not in the `GPUSceneBVH` is not traced, and its
  materials are one record per instance (no textures, no vertex colours). Traced hits get core's sun and flat ambient,
  not EnvironmentLighting, probes, clustered lights or shadow maps, and no reflection of their own. Flat normals (the
  triangle's), so a smooth curved mesh reflects faceted. One ray per pixel, no denoise beyond SSR's own resolve. GPU
  cost not measured yet (build phase).

## Ground-truth ambient occlusion: `GTAO`

`@margoengine/post/gtao` (10,531 B min+gzip, its own entry; it carries SSAO and the stack) is GTAO, written from
Jimenez, Wu, Pesce and Jarabo 2016 ("Practical Real-Time Strategies for Accurate Indirect Occlusion"). It is an HDR
`PostStack` effect; `GTAO.attach(engine, options)` runs it alone in its own one-effect stack (tone mapped like SSAO alone).

```ts
import {PostStack} from 'margoengine/post/stack';
import {GTAO} from 'margoengine/post/gtao';
import {SSR} from 'margoengine/post/ssr';
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/scene.glb');
const gtao = new GTAO({radius: 0.5, slices: 2, steps: 6});
PostStack.attach(stage.engine, [gtao, new SSR()]); // or GTAO.attach(stage.engine)
gtao.add(model);                // gltf/pbr model: its normal maps feed the horizon search, as with SSAO
gtao.options.slices = 1;        // options and `enabled` are read every frame
```

- **Method.** Per pixel, `slices` planes through the view vector, each along a screen direction. On each side of the
  pixel `steps` depth samples within `radius` give the horizon (the highest sample, as an angle from the view vector),
  clamped to the hemisphere around the normal projected into the slice. The paper's closed form (its eq. 10) gives the
  cosine-weighted visibility of the open arc, weighted by the projected normal's length; the slices average to the
  visible share of the cosine-weighted hemisphere. Occluders fade out between 60% and 100% of `radius`. The 4x4 pixel
  tile rotates the slices and offsets the steps (both 4x4 Bayer orders), and SSAO's bilateral blur averages the tile.
  A sample's pixel is the nearest one to its point on the slice's line, up to half a pixel off it; each sample is slid
  back into the slice along the surface's tangent plane, keeping its height above that plane, so an open plane of any
  tilt reads exactly 1 (before, an open floor seen 53 degrees off its normal read 0.980; KB-GTAO-OPENFLOOR1).
- **Shared with SSAO.** The normal G-buffer (with `gtao.add(source)` material normals), the blur, the ambient replay and
  the composite are SSAO's, so GTAO darkens exactly the ambient and image-based light (`margoAmbient`), not direct light
  or emission, under perspective and orthographic cameras. GTAO is a subclass of `SSAO`; with no GTAO, SSAO makes the
  same GPU calls as before (`examples/package-benchmarks/proofs/post-stack.proof.js`, `--current`).
- **Checked on a real GPU** against closed forms (NVIDIA RTX A6000, Edge 155; `examples/package-benchmarks/post-effects-gpu.mjs
  --only=gtao`, [gtao-gpu.json](../../examples/package-benchmarks/results/gtao-gpu.json)): ambient light only, the
  frame with GTAO over the frame with it disabled. A point on a floor where a plane through it closes the hemisphere to
  a wedge of angle b keeps `(1 - cos b) / 2` of its ambient light. Next to the crease GTAO measures 0.520, 0.268 and
  0.783 for 90, 60 and 120 degree wedges (closed form 0.5, 0.25, 0.75; the blur mixes in floor up to a few cm out),
  rising to 0.85-0.96 at 0.64 m with `radius: 2`; the open floor measures 0.996-1.009. The same at 1x MSAA and with
  an orthographic camera (0.532, 0.264, 0.777; open floor 1.000). Alone, the open floor is unchanged (0/255) and the crease darker; in
  a stack with SSR and Bloom and under TAA, no errors and no NaN.
- **Sky occlusion** (`skyRadius`, default 0: off). Above 0, the slices search their horizons a second time out to
  `skyRadius` scene units (`skySteps` samples a side, default 16, spaced by the square of their index from 1 pixel
  out, slid into the slice like the GTAO term's) and keep only the sky half of each slice, the directions above the world horizon. The visible share of that sky
  arc, cosine weighted with the same closed form and divided by the open sky arc, multiplies the occlusion, so the sky
  light darkens in streets, valleys, slots and under eaves at a larger scale than `radius`, while an open surface of
  any tilt reads 1 (a wall does not count the ground below the horizon as cover). The `animatedFeature` look sets it to
  8 m (`POST_LOOKS`, rows `gtao.skyRadius` and `gtao.skySteps`). With `skyRadius` 0 the occlusion is the plain GTAO's
  bit for bit (the uniform's sky values are 0 and the sky term returns 1 before any work). Checked on a real GPU,
  WebGPU and the WebGL2 layer, by `test/gtao-sky-browser.mjs` on an RTX A6000: an open floor seen 53 degrees off its
  normal reads 1.0000 of the plain GTAO and a 30 degree slope 1.0000 (the plain GTAO itself 1.0000 on both, and about
  0.5 in a 90 degree crease of floor and wall: 0.674 after the blur at its darkest pixel, WebGL2 layer 0.612); the middle of a slot 2 m wide and 2 m
  deep, seen from above, reads 0.471 (WebGL2 layer 0.476) against its view factor to the opening, sin(atan(w / 2h)) =
  0.447, high because the nearest sample past the rim lies about half a step beyond it; switching it off restores the
  plain occlusion exactly, which also matched the build before this option value for value. Sources: Bavoil, Sainz and
  Dimitrov 2008, "Image-Space Horizon-Based Ambient Occlusion" (SIGGRAPH talk); Jimenez, Wu, Pesce and Jarabo 2016;
  Klehm, Ritschel, Eisemann and Seidel 2011, "Bent Normals and Cones in Screen-space", VMV
  (https://doi.org/10.2312/PE/VMV/VMV11/177-182); Max 1988, "Horizon mapping: shadows for bump-mapped surfaces", The
  Visual Computer 4(2); Timonen and Westerholm 2010, "Scalable Height Field Self-Shadowing", Computer Graphics Forum
  29(2); Hottel and Sarofim 1967, "Radiative Transfer" (crossed strings, the slot's view factor).

  ```ts
  import {GTAO} from 'margoengine/post/gtao';
  import {createStage} from 'margoengine';
  const stage = await createStage('#viewport', {backend: 'webgpu'});
  const gtao = GTAO.attach(stage.engine, {skyRadius: 8}); // sky light darkens within 8 m of cover
  gtao.options.skyRadius = 0;                            // live: back to plain GTAO from the next frame
  ```
- **Limits.** Screen-space: occluders off screen or hidden behind nearer surfaces do not occlude, and thin objects
  occlude as if infinitely thick (no thickness heuristic). No multi-bounce colour approximation, no bent normals and no
  specular occlusion cone: the IBL specular is darkened by the same factor as the diffuse, as with SSAO. Up to 4 slices
  and 16 steps per side; options `radius` (0, 100], `slices` 1-4, `steps` 1-16 (`RangeError` otherwise). It runs only in
  a `PostStack` (`MargoError` code `state` when attached alone with `engine.use`). GPU cost not measured yet. WebGPU only.
- **Blended surfaces.** GTAO finds occluders only in the depth buffer, so a surface drawn blended with no depth write
  does not occlude. `@margoengine/scatter` grass, drawn by prefiltered coverage, writes its depth in a depth-only pass
  after the blending where each blade covers (a hashed alpha test of its coverage), so GTAO sees it and its shade on
  the ground (KB-SCENES-DUNE-GTAO1). The grass itself is not darkened: only core meshes and `gtao.add` sources are in
  the ambient replay.

## Screen-space global illumination: `SSGI`

`@margoengine/post/ssgi` (12,638 B min+gzip, its own entry; it carries the stack) adds one bounce of diffuse light: light
that lit surfaces on screen throw onto their neighbours (a red wall tints the floor in front of it). It is an HDR
`PostStack` effect; `SSGI.attach(engine, options)` runs it alone in its own one-effect stack.

```ts
import {PostStack} from 'margoengine/post/stack';
import {SSGI} from 'margoengine/post/ssgi';
import {SSR} from 'margoengine/post/ssr';
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/scene.glb');
const ssgi = new SSGI({rays: 4, maxDistance: 10, thickness: 0.5, steps: 32, intensity: 1});
const ssr = new SSR();
PostStack.attach(stage.engine, [ssgi, ssr]);
ssgi.add(model); ssr.add(model);  // gltf/pbr model or materials mesh: both may capture it (one shared capture hook)
```

- **Material replay.** At order 15 (after SSAO's and SSR's replays) core meshes are redrawn once at 1x with core's own
  shader into three targets: the ambient light the scene added at the pixel (`rgba16float`; SSAO's ambient replay:
  `margoAmbient` when a plugin such as `EnvironmentLighting` names it, else core's ambient term), the diffuse albedo
  `base·(1−metal)` (`rgba8unorm`) and the normal (`rgb10a2unorm`). At 4x MSAA the replay writes its own 1x depth, as
  SSR's does. Models added with `ssgi.add(model)` draw into the same targets through gltf/pbr's capture hook (their
  own `ambient(s)`, occlusion included, albedo and normal maps). A model takes one capture hook, so SSR and SSGI share
  one per model (`packages/post/src/capture.ts`); with only SSR, SSR's calls are what they were
  (`proofs/post-ssr-models.proof.js`).
- **Rays.** `rays` cosine-weighted directions per pixel around its normal, from a set of `16 · rays` (Malley's method on
  a golden-angle spiral) that the 4x4 pixel tile shares out, each marched over a hierarchical depth pyramid with SSR's
  own march (`packages/post/src/hiz.ts`; `steps`, `thickness`, `maxDistance`). A hit takes the lit scene there (the
  stack's input; a blurred mip for far hits). Hits on back faces and near `maxDistance` fade out.
- **Replacing, not adding.** Where a share `h` of the rays hit, the composite writes `scene + intensity · (albedo ·
  hitLight − ambient · h)`, `hitLight` being the hit light summed over all rays over their count: the ambient light is
  replaced by the light the rays found, so geometry that blocks the sky also occludes (SSGI includes ambient occlusion;
  with SSAO or GTAO before it, creases darken twice). A bilateral blur over 8 taps per axis (normal and plane aware)
  averages the 4x4 tile. Deterministic, so frames are stable without TAA.
- **Checked on a real GPU** against the form factor (NVIDIA RTX A6000, Edge 155; `post-effects-gpu.mjs --only=ssgi`,
  [ssgi-gpu.json](../../examples/package-benchmarks/results/ssgi-gpu.json)): ambient light 1 only, a white floor before
  a red 4 x 2 m wall. A ray that hits the wall swaps the floor's ambient light (1, 1, 1) for the wall's (1, 0, 0), so
  the floor's green falls by the share of its cosine-weighted hemisphere the wall covers (the form factor from a
  floor point to the rectangle, integrated numerically) and its red stays. At 18 floor points 5 cm to 2 m from the
  wall the measured share is within 0.023 of it (0.471 against 0.486 at 5 cm, 0.234 against 0.249 at 1 m, 0.110
  against 0.111 at 2 m) and red stays 1.000; the same at 1x MSAA, for a gltf/pbr floor added to SSGI and SSR (red
  0.990: gltf/pbr's ambient also holds a specular term, removed and not re-added), and with an orthographic camera
  (within 0.021). With GTAO, SSR and TAA in the same frame and alone: no errors, no NaN.
- **More bounces (`multiBounce: true`).** Rays then read the light they hit from the previous frame's result,
  reprojected through the previous frame's camera, which already holds the bounces before it: each frame adds one
  more bounce, so a room open to the sun fills with light and a still view settles to all of them. A hit the previous
  frame did not see on screen (and the first frame) takes the current input, so the first frame is exactly one bounce.
  The results ping-pong between two `rgba16float` targets; SSGI then hands the newer one to the next HDR effect, or
  draws it with the display transform when it ends the stack. Checked on a real GPU (Apple silicon Mac, Metal, Chromium;
  `node packages/post/test/ssgi-bounce-browser.mjs`): a white room open toward the camera, its ceiling over the back
  half: the first multi-bounce frame equals one bounce within 1/255 (the `rgba16float` step), after 42 frames the
  mean luma is 10.4/255 higher with 57,229 of 76,800 pixels brighter by more than 2/255, the next frame changes
  nothing, and switching it off gives the one-bounce frame back exactly.

```ts
import {Engine} from 'margoengine/core';
import {SSGI} from 'margoengine/post/ssgi';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const gi = SSGI.attach(engine, {rays: 4, multiBounce: true}); // indoor scenes: bounces build up over frames
gi.options.multiBounce = false;                                // back to one bounce, nothing kept between frames
```

- **Limits.** Only what is on screen bounces: light from off-screen or hidden surfaces is missing, and rays that leave
  the screen keep the ambient light. Diffuse only; one bounce by default, the bounce light being the scene as lit
  before SSGI (emission included). With `multiBounce` the extra bounces trail a moving camera or light by a few
  frames, a hit hidden in the previous frame takes the light of whatever covered it there for a frame, and one history
  serves every view of a frame (split screen). Water, terrain and other custom
  shaders bounce light but take none (no albedo in the replay). Options: `rays` 1-16, `steps` 1-256, `maxDistance` and
  `thickness` > 0, `intensity` 0-4 (`RangeError` otherwise); stack only (`MargoError` code `state` alone with
  `engine.use`). Memory: three material targets, two `rgba16float` GI targets, a half-resolution Hi-Z and blur chain,
  and its own 1x depth at 4x. GPU cost not measured yet. WebGPU only.

## Ray-traced bounce light: `RTGI`

`@margoengine/post/rt-gi` is SSGI with a ray tracer behind it. SSGI's material replay, cosine-weighted Hi-Z rays, tile
spread, bilateral blur and composite stay as above; a ray the screen does not answer (it leaves the screen, runs behind
the camera or under nearer geometry) is traced through a `GPUSceneBVH` from `@margoengine/bvh/gpu-scene` (an optional
peer) from the same start along the same direction. Every SSGI option, `multiBounce` included, works the same.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {MeshBVH} from 'margoengine/bvh';
import {GPUSceneBVH} from 'margoengine/bvh/gpu-scene';
import {RTGI} from 'margoengine/post/rt-gi';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const lamp = box(4, 0.1, 4);
engine.createMesh().setGeometry(lamp).setPosition([0, 3, -4]).setMaterial(new PbrMaterial({color: '#ffffff'}));
const scene = GPUSceneBVH.forShader(engine.gpu!, [
  {bvh: MeshBVH.fromGeometry(lamp), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, -4, 1], material: {emissive: [1, 1, 1]}},
]);
const gi = RTGI.attach(engine, {scene, rays: 4}); // or put it in your PostStack like SSGI
gi.options.multiBounce = true; // traced hits add into the history like screen hits
gi.options.shadows = false;    // skip the sun's shadow ray at traced hits (default true)
```

- **Hybrid order** (Barre-Brisebois et al. 2019). Each ray marches the Hi-Z first; only a ray with no screen hit
  traces, from SSGI's own start (two pixel footprints off the surface) up to `maxDistance`, faded over its last 20%
  like SSGI's screen hits. Traced and screen hits add into the same sum over rays, so the share of rays that hit and
  the bounce light stay one average.
- **Shading of traced hits.** The same as `RTReflections`: core's BRDF text with the instance's `material`, the engine
  sun with a shadow ray through the scene (`shadows`; `bias` default 0.01), core's flat ambient and the emissive. The
  view vector is the ray's reverse.
- **Fallback.** A disposed scene, or one made on a device that was lost, runs as plain SSGI until `gi.options.scene`
  is given a new one.
- **Devices.** The traced trace binds 5 storage buffers in a fragment shader (the scene's 4 and SSGI's rays). A device
  at WebGPU's compatibility level that allows fewer warns once with code `unsupported` and runs as plain SSGI; it never
  throws. The WebGL2 layer traces on its full and half-float tiers; its LDR tier refuses any HDR PostStack.
- **Checked on a real GPU** (`test/rt-gi-browser.mjs`: WebGPU, WebGPU at the compatibility level, the WebGL2 layer and
  its half-float tier, identical figures on an RTX A6000; at the compatibility level held to 4 fragment storage
  buffers it warns once and every frame is SSGI's 0): a white matte floor under a wide emissive ceiling that is never on screen, sun and ambient off, which SSGI
  alone leaves black, reads 181 against the closed form 180.54 (display of emissive x the mean distance fade, 0.99888)
  with one bounce and with `multiBounce`; the floor turned away from the ceiling stays 0, and a disposed scene gives
  SSGI's 0 back.
- **Limits.** Everything `RTReflections` lists for traced hits (scene instances only, one material record per
  instance, core's sun and flat ambient only, flat normals), plus: no ReSTIR GI reuse and no SVGF denoise, so the
  noise is SSGI's `rays` per pixel and its blur; traced hits are lit directly, so with `multiBounce` a traced hit does
  not carry the bounces already built up on screen. GPU cost not measured yet (build phase).

## Motion blur: `MotionBlur`

`@margoengine/post/motion-blur` (6,861 B min+gzip, its own entry; it carries the stack) blurs along per-pixel motion
vectors. It is an HDR `PostStack` effect fed by a velocity callback, like `TAA({depth})`: with `@margoengine/taa`,
`new MotionBlur({velocity: () => taa.velocity})`; any viewport-sized two-channel float texture of uv motion works too. With no anti-aliasing wanted, `TAA.attach(engine, {velocityOnly: true, depth: () => stack.depthTexture})` makes the vectors alone and the blur runs inside the stack.

```ts
import {TAA} from 'margoengine/taa';
import {PostStack} from 'margoengine/post/stack';
import {MotionBlur} from 'margoengine/post/motion-blur';
import {Bloom} from 'margoengine/post/bloom';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
let taa: TAA;
const stack = PostStack.attach(stage.engine, [new MotionBlur({velocity: () => taa.velocity, shutter: 0.5}), new Bloom()]);
taa = TAA.attach(stage.engine, {depth: () => stack.depthTexture});
```

- **Method** (after McGuire, Hennessy, Bukowski and Osman 2012, "A Reconstruction Filter for Plausible Motion Blur"):
  each pixel's blur radius is half its motion over the open shutter (`shutter` share of the frame), at most `maxBlur`
  pixels; the largest radius per `maxBlur`-sized tile, then the largest over each tile's 3x3 neighbourhood; then
  `samples` taps along that neighbourhood maximum. A tap shows when it is in front and its own blur reaches the pixel,
  or behind while the pixel's blur reaches it (soft depth test at 1% of distance); every other share stays the pixel's
  own colour. So a rigidly moving surface over a still one gets exactly the shutter's box: the share of taps on it.
  Taps are staggered per pixel by interleaved gradient noise that does not change between frames.
- **TAA's jitter.** Both of TAA's matrices carry its Halton jitter, so its vectors also hold the jitter difference.
  `taa.velocity.jitter` is that difference in uv, and MotionBlur subtracts it: a still scene does not blur.
- **TAA's history stays sharp.** TAA resolves at order 40, after the stack composes at 30, so blurring in the stack
  would put blurred frames in TAA's history. With TAA's vectors (they carry `resolved`) MotionBlur copies the stack's
  frame through unchanged and blurs TAA's resolved frame after it, at order 41, into the canvas (sRGB-encoded like
  TAA's own output). The blur then runs on TAA's display-referred frame, not linear HDR. Without TAA it blurs the
  stack's linear HDR frame in place.
- **Checked on a real GPU** (NVIDIA RTX A6000, Edge 155; `post-effects-gpu.mjs --only=motion`,
  [motion-gpu.json](../../examples/package-benchmarks/results/motion-gpu.json)), a white box before a dark wall,
  ambient light only, against the unblurred frame filtered with the shutter's box (radius 10 px): uniform 40 px/frame
  motion from a velocity texture, worst error in box coverage 0.022 (4x) and 0.025 (1x) along the ramps; a box moving 40
  px/frame under TAA, worst error 0.057, and TAA's resolved frame identical to the run without MotionBlur (largest
  difference 0). At rest under TAA every pixel of TAA's velocity texture equals `taa.velocity.jitter` within 2e-6 uv
  (jitter difference that frame -0.625, 0.333 px) and the frame equals the frame without MotionBlur (0/255). Alone and
  with GTAO, SSR and Bloom under TAA: no errors, no NaN.
- **Limits.** Straight-line blur along each pixel's motion over one frame (no rotation arcs, no curved paths); motion
  over `maxBlur` pixels is clamped; areas the motion uncovers show only what is on screen now. Under TAA the blur is
  applied after tone mapping, and a canvas format other than `rgba8unorm`/`bgra8unorm` gets the resolved values as
  is. Options: `shutter` 0-1, `maxBlur` 1-128 px, `samples` 2-64 (`RangeError`); a velocity texture of another size
  throws `MargoError` code `state`. With no vectors for a frame (TAA's first frame) the frame is copied unblurred.
  GPU cost not measured yet. WebGPU only.

## Lens flare: `LensFlare`

`@margoengine/post/lens-flare` (7,673 B min+gzip, its own entry; it carries the stack) adds a lens flare for the sun:
a glow around it, a halo ring about the screen centre on its side, and six tinted ghosts (the lens's internal
reflections) on the line from the sun through the screen centre. It is an HDR `PostStack` effect; put it after SSR and
before Bloom so the flare glows. `LensFlare.attach(engine, options)` runs it alone.

```ts
import {PostStack} from 'margoengine/post/stack';
import {LensFlare} from 'margoengine/post/lens-flare';
import {Bloom} from 'margoengine/post/bloom';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
PostStack.attach(stage.engine, [new LensFlare({intensity: 0.1}), new Bloom()]);   // follows engine.lighting
// With @margoengine/sky: new LensFlare({sun: () => sky.lights[0].direction})    // w = 0 below the horizon hides it
```

A flare from a point light with your own images: `position` in place of `sun`, and `elements` in place of the
built-in glow, halo and ghosts.

```ts
import {PostStack} from 'margoengine/post/stack';
import {LensFlare} from 'margoengine/post/lens-flare';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
// Any 2D texture of the engine's device with a filterable format; here a small white disc fading to its edge. As a
// function it is made once per device, so the images are back by themselves after a device restore.
const pixels = new Uint8Array(64 * 64 * 4);
for (let i = 0; i < 64 * 64; i++) {
  const r = Math.hypot((i % 64) - 31.5, Math.floor(i / 64) - 31.5) / 32;
  pixels.set([255, 255, 255, Math.max(0, 1 - r) * 255], i * 4);
}
const glow = (device: GPUDevice) => {
  const texture = device.createTexture({size: [64, 64], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture}, pixels, {bytesPerRow: 64 * 4}, [64, 64]);
  return texture;
};
const lamp = [0, 6, 0];
PostStack.attach(stage.engine, [
  new LensFlare({
    position: () => lamp,                                 // a world point; its w, when given, scales the flare
    elements: [
      {texture: glow, size: 512},                         // at the light, 512 px across
      {size: 60, distance: 0.6, color: [0.6, 0.8, 1]},    // no texture: a soft round glow
      {texture: glow, size: 120, distance: 0.9},          // 0.5 is the screen centre, 1 the light's mirror image
    ],
  }),
]);
```

- **The sun.** `sun()` gives the direction toward it (default `engine.lighting.direction`); its w, when given, scales
  the flare and 0 or less hides it. The sun's screen point is found the way creative's god rays find it: a point far
  along that direction (half the far distance) through the camera's own matrix, so perspective and orthographic alike;
  behind the camera or outside the depth range there is no flare.
- **Occlusion.** A compute pass tests an 8 x 8 grid of depth samples over a disc of `occlusionRadius` pixels around the
  sun against the stack's depth (`host.depthTexture`): a sample sees the sun where nothing nearer than the sun's point
  is drawn. The flare is scaled by the share that does, so a sun behind geometry disappears, one at an edge dims, and
  one leaving the screen fades out. The share stays on the GPU (no readback).
- **Device restore.** An element's `texture` is a `GPUTexture` or `(device) => GPUTexture`, made once per device. A plain
  texture is lost with its device: that image draws nothing, `engine.onError` hears of it once (`'state'`,
  [#borrowed-lost](https://margoengine.com/errors#borrowed-lost)), and giving the element a new texture brings it back.
- **Checked on a real GPU** (NVIDIA RTX A6000, Edge 155; `post-effects-gpu.mjs --only=flare`,
  [flare-gpu.json](../../examples/package-benchmarks/results/flare-gpu.json)), the frame with the flare minus without,
  linear: the brightest pixel is the sun's projected pixel (within one pixel); the flare is mirror-symmetric about the
  line from the sun through the centre (weighted mean offset 0.3 px) with each ghost on it; a box over the sun leaves
  the frame unchanged (0); a box whose edge splits the disc leaves 0.4998 of the flare where 26 of the 52 depth
  samples see past it (0.5); behind the camera and at strength 0, nothing; orthographic, the peak at the projected
  pixel; in a stack with SSR and Bloom and alone, no errors.
- **A point light and your own elements** (2026-11-11). `position()` gives a world point (x, y, z, and a strength in w)
  in place of `sun`; the same depth disc hides it behind anything drawn nearer, and behind the camera there is no
  flare. Its tint defaults to white rather than the engine light. `elements` (at most 16, at most 15 of them with a
  texture) replace the built-in flare:
  each is a square of `size` pixels on the line from the light through the screen centre at `distance` (0 the light,
  0.5 the centre, 1 its mirror image), drawing its `texture` (rgb times alpha, linear filtering) or, with none, a soft
  round glow, times its `color`. With elements, `intensity` defaults to 1, so each image adds at its own brightness.
  Every element with a texture takes one sampled texture binding; the caller owns the textures. Element values are
  written each frame (32 B each); a new texture rebuilds the bind group, and adding or removing a texture rebuilds
  the pipeline. Checked on a real GPU (NVIDIA RTX A6000, Chromium 157, WebGPU and the WebGL2 layer with the same
  values; `npm run test:gpu:flare` in packages/post): an element at distance 0 peaks at the light's pixel and one at
  1 at its mirror pixel (both within one pixel), with its tint (green and blue 0.49995 and 0.24997 of red for 0.5 and
  0.25); a textured element adds its texel times alpha (0.3936 for 0.3937, within 0.002); nothing changes outside the
  element squares; a covered point light or one behind the camera adds nothing.
- **Limits.** One light per `LensFlare`, a fixed built-in ghost set (use `elements` for your own), no starburst or
  aperture-shaped ghosts, no flare from spot-light cones. A transparent surface in front of the sun that writes no
  depth does not hide it; one that writes depth hides it fully. Options: `intensity` 0-10, `occlusionRadius` 1-64,
  `color` three finite values >= 0 (`RangeError`); a zero direction throws `MargoError` code `state`. GPU cost not
  measured yet. WebGPU only.

## SMAA

`@margoengine/post/smaa` (5,630 B min+gzip, its own entry) is enhanced subpixel morphological anti-aliasing after
Jimenez et al., "SMAA: Enhanced Subpixel Morphological Antialiasing" (Eurographics 2012). Like FXAA it smooths the
stair steps of single-sampled output, but it rebuilds each edge's line from its staircase, so it blurs less and leaves
flat areas and straight, pixel-aligned shapes alone.

```ts
import {SMAA} from 'margoengine/post/smaa';
import {PostStack} from 'margoengine/post/stack';
import {Bloom} from 'margoengine/post/bloom';
import {Glitch} from 'margoengine/post/glitch';
import {Tonemap} from 'margoengine/tonemap';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const standalone = SMAA.attach(stage.engine, {quality: 'high'}); // wraps the finished frame, like FXAA
standalone.dispose(); // Release the standalone owner before replacing it with the stack.
// In a stack, after the display effect and before Glitch:
PostStack.attach(stage.engine, [new Bloom(), new Tonemap(), new SMAA({quality: 'ultra'}), new Glitch()]);
```

- **How.** Three passes. Edges: where the luma of the display-encoded colour (or, with `edgeDetection: 'color'`, the
  largest channel), or alpha, differs from the left or top neighbour by `threshold` or more and by at least half the
  strongest contrast around it. Weights: from each edge pixel a walk along the edge, two pixels per bilinear fetch,
  finds both ends and the crossing edges there; the silhouette is rebuilt as a line from the middle of each crossing
  edge to the middle of the edge (Z, L and U shapes), and the area it cuts from each pixel is looked up. Blend: each
  pixel mixes with its neighbours by those areas, along the stronger direction. The area (260 x 260) and search
  (33 x 33) lookup textures are computed in code from these definitions on first use; no published texture data or
  shader code is used.
- **Presets.** `quality`: `'low'` (threshold 0.15, 4 search steps, so 8 px each way), `'medium'` (0.1, 8 steps),
  `'high'` (default: 0.1, 16 steps, corners) or `'ultra'` (0.05, 32 steps, corners). `threshold` (0.01-0.5),
  `maxSearchSteps` (1-32) and `cornerRounding` (0-1) override the preset; all options may change per frame. Corners:
  where the crossing edge at an end runs on (the corner of a shape, not a step of a slanted line), only
  `cornerRounding` of the blending is kept: 0.25 in high and ultra, 0 keeps corners sharp, 1 rounds them (low, medium).
- **SMAA or FXAA.** Use one: a stack holding both throws `TypeError`; attaching one next to the other throws
  `MargoError` code `attached`. Put SMAA first among the LDR effects so later ones (Glitch) stay sharp. With TAA it is
  usually unnecessary.
- **Checked on a real GPU** (NVIDIA RTX A6000, Edge 155; `scripts/post-looks-gpu-check.js`, results in
  `test-results/post-looks/gpu.json`): black/white edges of slope 1/8 and 8, each mirrored, drawn aliased so the true
  line passes through the middle of each step, come out equal to the exact pixel coverage of the line within 0.0027
  (8-bit output) in the low, high and ultra presets, against 0.4375 aliased; a red/blue edge with colour edges alike; a
  pixel-aligned rectangle is unchanged with `cornerRounding: 0`; disabled, the frame passes through unchanged; alone on
  a core scene at 4x and 1x only pixels next to an edge change; no validation errors.
- **Limits.** No diagonal-pattern search (the paper's diagonal patterns), so edges near 45 degrees get the orthogonal
  result (blends of 1/8); no temporal (T2x) or multisample (S2x, 4x) modes and no predication. An edge end more than
  2 x `maxSearchSteps` pixels away counts as open, so very long, nearly horizontal or vertical runs are smoothed only
  within that reach of their steps. Blending is in display-encoded values, as FXAA, not in linear light. GPU cost not
  measured yet. WebGPU only.

## Glitch

`@margoengine/post/glitch` (6,016 B min+gzip, its own entry; it carries the stack) is a digital glitch:
after a random quiet wait of 90-300 frames (1.5-5 s at 60 Hz) a burst of 3-10 glitched frames, the first at full
strength and the rest at 20-80%. Each glitched frame draws new random block displacement (cells of a grid slide
sideways), an RGB split (red and blue read a few pixels apart, opposite ways, in a random direction) and scanline
tearing (up to four bands of rows slide sideways, each line jittered). It is an LDR
`PostStack` effect; `Glitch.attach` runs it alone.

```ts
import {Glitch} from 'margoengine/post/glitch';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const glitch = Glitch.attach(stage.engine, {seed: 7});
glitch.options.wild = true;        // glitch every frame
glitch.options.intensity = 0.4;    // 0-1, scales displacement, split and tearing
```

- **Determinism.** `seed` (an integer below 2^32) fixes the sequence: the same seed glitches the same enabled frames
  the same way, and changing it restarts. Without one the seed is random. Disabled frames pass through and pause the
  sequence. `glitch.active` tells whether the last frame was glitched. Waits and bursts count rendered frames.
- **Placement.** After the display effect, and after SMAA or FXAA. Displaced reads wrap horizontally; alpha is the
  largest of the three reads, so a transparent canvas stays valid.
- **Checked on a real GPU** (same run): idle frames and `intensity: 0` pass the frame through exactly (also alone on
  a core scene, 4x and 1x); wild frames move pixels but keep every row's content in its row; the same seed replays
  exactly and another seed differs.
- **Limits.** Sizes follow the canvas (split up to 1.5% of its height, cell shifts up to 10% and tear shifts up to 12%
  of its width); the wait and burst lengths are fixed; no colour noise. GPU cost not measured yet. WebGPU only.

## Afterimage

`@margoengine/post/afterimage` (5,408 B min+gzip, its own entry; it carries the stack) leaves trails:
each channel of the output is `max(current, history x keep)`, and the output becomes the next frame's
history. `keep = 0.5 ^ (delta / halfLife)` with the frame's `delta` in seconds, so a trail halves in `halfLife`
seconds (default 0.15) at any frame rate; a paused render (`delta` 0) keeps it.

```ts
import {Afterimage} from 'margoengine/post/afterimage';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const trails = Afterimage.attach(stage.engine, {halfLife: 0.25});
trails.halfLife = 0.1; // seconds, any frame
trails.reset();       // drop the trail, e.g. on a camera cut
```

- **HDR placement.** An HDR `PostStack` effect: the history is linear `rgba16float`, so trails fade smoothly to black
  (an 8-bit history would stop fading once `keep` cannot lower a value by a whole step), and Bloom
  after it makes bright trails glow. Put it among the HDR effects, before Bloom; alone or last it presents through
  Margo's display curve.
- **Resets.** The trail starts empty on the first frame, after a resize, after a device restore, after `reset()` and
  while disabled (disabled frames pass through).
- **Checked on a real GPU** (same run): a bright square (linear 3.0) moving 20 px per frame leaves exactly
  `max(current, history x keep)` (60 Hz frames) within the float16 rounding of the stored history (0.0022 relative after
  six frames); a half-life far below a frame and disabled equal the frame without Afterimage; the first frame after a
  resize or a device restore has no trail; premultiplied alpha trails with its colour; the presented frame is the
  display curve of the expected trail within 2/255.
- **Limits.** Screen-space trails: a moving camera smears the whole frame. Two full-size `rgba16float` history
  textures. GPU cost not measured yet. WebGPU only.

## Accumulate

`@margoengine/post/accumulate` (its own entry; it carries the stack) averages frames in linear HDR for film output:
`begin()` starts a sum, every frame drawn after it is added times `weight`, and the effect outputs the running weighted
mean, so later HDR effects and `Tonemap` see the average of linear light and the tone curve is applied once
(Haeberli and Akeley, "The Accumulation Buffer", SIGGRAPH 1990). `renderAccumulated` in
`@margoengine/headless/accumulate` drives it with sub-pixel offsets and shutter times.

```ts
import {Accumulate} from 'margoengine/post/accumulate';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const accumulate = Accumulate.attach(stage.engine);
accumulate.begin(); // the next frame starts a new sum
accumulate.weight = 1; // weight of each frame from now on
console.log(accumulate.count, accumulate.total); // frames and weight summed so far
```

- **Targets.** Two full-size `rgba32float` sums ping-pong (float32 is not blendable, so the fold reads one with
  `textureLoad`), and one pass writes the new sum and the `rgba16float` mean (`texture`, with `COPY_SRC`, for
  `readTexture`). On the WebGL2 layer's half-float tier the sum is float16: keep to a few hundred frames there.
- **Resets.** A new sum starts after `begin()`, a resize, a device restore, and when enabled again (disabled frames pass
  through). Alpha is averaged as it comes, premultiplied.
- **Checked on a real GPU** through `@margoengine/headless/accumulate` (its README has the figures): linear edge
  coverage, the tone curve applied once, bit-identical runs and shutter smear, on WebGPU and the WebGL2 layer.
- **Limits.** Three full-size float targets (40 bytes a pixel). Effects before it that keep history advance once per
  frame added. GPU cost not measured yet.

## Outlines: `Outline`

`@margoengine/post/outline` draws lines where a Sobel filter finds a step in scene depth and, when you give it normals,
a crease. It is an LDR effect: place it after the display effect and before `SMAA` or `FXAA`.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {SceneTargets} from 'margoengine/post/mrt';
import {Outline} from 'margoengine/post/outline';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const targets = SceneTargets.attach(stage.engine, {outputs: {normal: 'normal'}});
const outline = new Outline({color: [0.05, 0.05, 0.1, 1], width: 1, normal: () => targets.texture('normal')});
PostStack.attach(stage.engine, [outline]);
outline.options.width = 2; // options are read every frame
```

| Option | Default | Meaning |
| --- | --- | --- |
| `color` | `[0, 0, 0, 1]` | Display-encoded red, green, blue, opacity |
| `width` | `1` | Filter radius in whole pixels, 1 to 16; a line covers about twice this |
| `depthThreshold` | `0.03` | Depth step per pixel, as a share of the pixel's distance |
| `normalThreshold` | `0.4` | Normal change, about a 30 degree crease |
| `normal` | none | World normals texture; without it creases draw no line |
| `mask` | none | Red channel limits lines to marked objects; no texture means no lines |
| `maskId` | any above 0 | The red value that counts as marked |
| `enabled` | `true` | False passes frames through |

For per-object lines use `mask: () => selection.maskTexture` with `Selection` from `@margoengine/selection`. That mask is
drawn after the stack, so it is one frame old. Selection's own outline is separate and needs no stack.

## Writing your own effect

`PostStack` takes any plugin with a `joinStack(host)` method. It returns a stage: `kind` says where the stage goes in the
order (`'hdr'`, `'display'` or `'ldr'`), and `render(context, input, output)` draws `input` into `output.view`. `host.depthTexture`
is the shared resolved depth. `output.hdr` is false when your stage is last or follows the display effect, so an `'hdr'` stage
must then encode for display itself.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const code = `
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);
}
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let c=textureLoad(image,vec2i(at.xy),0);
 return vec4f(1-c.rgb,c.a);
}`;
const invert = {
  name: 'invert',
  setup() {},
  dispose() {},
  joinStack() {
    return {
      kind: 'ldr' as const,
      render(c: any, input: GPUTextureView, output: {view: GPUTextureView; format: GPUTextureFormat; multisample: GPUMultisampleState}) {
        const module = c.device.createShaderModule({code});
        const pipeline = c.device.createRenderPipeline({
          layout: 'auto',
          vertex: {module, entryPoint: 'vertex'},
          fragment: {module, entryPoint: 'fragment', targets: [{format: output.format}]},
          multisample: output.multisample,
        });
        const pass = c.encoder.beginRenderPass({colorAttachments: [{view: output.view, loadOp: 'clear', storeOp: 'store'}]});
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, c.device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: input}]}));
        pass.draw(3);
        pass.end();
      },
    };
  },
};
PostStack.attach(stage.engine, [invert]);
```

Build the pipeline and bind group once and rebuild them only when `output.format` or `input` changes; the example keeps them
in `render` to stay short. Release what you create in `dispose`.

## Contact shadows: `ContactShadows`

`@margoengine/post/contact-shadows` marches a short ray toward the light through the frame's depth, in a `PostStack`. It catches the
small gaps where an object meets the ground. Options: `distance` (0.4), `thickness` (0.2), `strength` (0.7), `steps` (16), `enabled`
(true). It sees only what is on screen, and it darkens ambient light too in the pixels it hits. A depth texel holds one depth
for its whole pixel, so a hit needs the ray behind the depth by more than 1.5 pixels' worth of the surface's depth change;
without that, lit slopes shadowed themselves in a dither pattern. Contacts thinner than that are not drawn.

```ts
import {Engine} from 'margoengine/core';
import {ContactShadows} from 'margoengine/post/contact-shadows';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
ContactShadows.attach(engine, {distance: 0.3});
```

## Caustics from any surface: `SurfaceCaustics`

`@margoengine/post/caustics` throws the sun's light, refracted through any surface mesh you give it (a pool or pond surface,
the liquid in a tank, a rippled glass sheet), onto every opaque receiver below it, in a `PostStack`. Each surface triangle is
refracted by Snell's law at its corners' normals and traced down as a beam into horizontal depth slices of a map over the
receiving square, carrying the light it takes in (its area seen by the sun times the Fresnel transmission) spread over the
area it lands on, so convex ripples focus into bright lines and the total is kept. A receiver pixel reads the slices at its
height and adds the flux through its own normal times its own colour. These are the same beams and the same projection
`@margoengine/water/caustics` draws for `Water` and `FFTOcean`: water hands its waves to the shared shaders this entry
exports (`causticBeams`, `causticRange`, `causticProject`), so a fix to one is a fix to both.

```ts
import { Engine } from '@margoengine/core';
import { SurfaceCaustics } from '@margoengine/post/caustics';

const engine = await Engine.create(document.querySelector('canvas')!);
// A 2 x 2 m pool surface 1 m above its floor, one quad; normals default to the face normals.
const surface = { positions: [-1, 1, -1, -1, 1, 1, 1, 1, 1, 1, 1, -1], indices: [0, 1, 2, 0, 2, 3] };
const pool = SurfaceCaustics.attach(engine, { geometry: surface, refractiveIndex: 1.333 });
pool.setGeometry(surface); // each frame the surface moves
pool.options.intensity = 0.8; // options are read every frame
```

| Option | Default | Meaning |
| --- | --- | --- |
| `geometry` | required | `{positions, normals?, indices?}`, world space; normals point out of the medium (up for water) |
| `center`, `size` | the surface's middle, twice its larger extent | The square `[x, z]` and side that receives light, 0.1 to 100000 m |
| `heightRange` | one `size` below the surface's lowest point up to it | Lowest and highest receiver heights |
| `resolution`, `layers` | 256, 12 | Map side (a power of two, 32 to 2048) and depth slices (2 to 32); fixed at creation |
| `refractiveIndex` | 1.333 | Index of the medium under the surface, 1 to 3 (glass 1.5) |
| `intensity`, `color` | 1, `[1, 1, 1]` | Multiplier and linear tint of the scene's sun (`engine.lighting`) |
| `absorption` | `[0, 0, 0]` | RGB absorption per metre in the medium |
| `shadows` | none | A `Shadows` for the light entering the surface and reaching receivers |
| `enabled` | true | False passes the picture through unchanged |

The surface is one refracting interface: light enters it and the receivers lie inside the medium, as under water. Draw the
surface itself without writing depth (transparent), or it hides the receivers it lights. For light through a closed glass
object onto a floor, with its exit face and internal reflections, use `ProductCaustics` of `@margoengine/studio/caustics`,
which traces photons; for baked light maps, `@margoengine/lightmap`'s refracted caustics. Checked on WebGPU and the WebGL2
layer (`test/surface-caustics-browser.mjs`): a flat surface passes 1 - Fresnel(0) of the sun to the floor under it within 0.2%
and nothing past its edge, and ripples of the same footprint focus the light while keeping its total within 1.1%.

## Heat haze: `HeatHaze`

`@margoengine/post/heat-haze` draws the shimmer of what lies behind the hot plume over a fire, in a `PostStack`. Each pixel's
view ray is bent by the refraction of the hot air it crosses: the refractivity of air falls as 1 / T (Gladstone and Dale 1863,
the ideal gas), the plume's temperature follows McCaffrey's measured flame and plume laws (about 850 K low in the flame, falling
as z^(-5/3) above it) over Heskestad's Gaussian half-width, and its eddies (0.4 of the mean rise, George et al. 1977) rise with
it at the flame's own speed. A bend at distance t shifts a background at tb by 1 - t / tb (background-oriented schlieren), so
a wall just behind the fire barely moves, the far hills move most, and a surface in front of the plume never moves.

Feed it plumes: a `Flame` of `@margoengine/vfx/flame` carries its own as `flame.plume` (its base, length, footprint, lean in
the wind and clock, so a seeked flame shimmers as a played one), and a `FireFront`'s flames are `front.flameVolumes` and
`front.buildingFlameVolumes`. A plain `{position, length, footprint?, yaw?, lean?, time?}` works too. Options: `sources`
(a list or a function called every frame), `strength` (1, the physical bend; 0 to 100), `turbulence` (0.4), `ambient`
(293.15 K), `steps` (24, the least march steps through a plume, more where it is narrow), `enabled` (true). Put it first among
the HDR effects so the glow and focus see the bent scene.

The physical bend is small: a 3 m flame turns light by about 1e-4 radian, a fraction of a pixel at a 60 degree field of view
and a pixel or two through a telephoto, which is why real heat shimmer shows best on a long lens. Raise `strength` for a
stylised look. `plumeBend` gives the bend of one ray on the CPU, `airRefractivity` and `plumeExcess` the physics.

A plain plume without `time` rises on the effect's own clock, `haze.time`, the sum of its frame deltas. Its frame update
moves it through `haze.advanceTime(delta)` (a draw never does), so `seek` of `@margoengine/cutscene/seek` replays it with
the scene's other clocks and a film rendered scene by scene shows the same shimmer across a cut.

```ts
import {Engine} from 'margoengine/core';
import {PostStack} from 'margoengine/post/stack';
import {HeatHaze} from 'margoengine/post/heat-haze';
import {Flame} from 'margoengine/vfx/flame';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 3, 40], target: [0, 3, 0], fov: 15},
});
const flame = Flame.attach(engine, {position: [0, 0, 0], length: 4});
PostStack.attach(engine, [new HeatHaze({sources: [flame]})]);
```

### Heat haze from a temperature field

Set `temperatureVolume` to a cell-centred air temperature grid, or a callback that returns the latest grid once per frame.
Use a world-space lower corner in metres, the cell counts and cell sizes on each axis, and Kelvin values in x-fastest order.
The pressure defaults to 101325 Pa. The renderer converts the values to air refractivity at that pressure, interpolates between
the cell centres, and joins the field to ambient air over a cell interval at the boundary. The interpolation reaches ambient
at the ghost centre half a cell past the outside face. Rays integrate the transverse gradient through the volume and stop at
the nearest opaque surface. The grid can sit alongside plumes from separate fires. Its temperature already includes
resolved fluctuations, so the analytic plume's eddies are not added to it.

```ts
import {Engine} from 'margoengine/core';
import {HeatConduction} from '@margoengine/physics/thermal';
import {PhysicsWorld} from '@margoengine/physics/world';
import {HeatHaze} from 'margoengine/post/heat-haze';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const heat = await HeatConduction.load();
const world = new PhysicsWorld({rate: {num: 24, den: 1}});
const origin = [-0.15, 0, 0] as const;
const dimensions = [3, 1, 1] as const;
const cellSize = [0.1, 0.4, 0.4] as const;
world.add(heat, {
  dimensions, cellSize,
  materials: {conductivity: 0.026, heatCapacity: 1206},
  initialTemperature: [293.15, 800, 293.15],
});
HeatHaze.attach(engine, {
  temperatureVolume: () => ({origin, dimensions, cellSize, kelvin: heat.readTemperature()}),
});
world.advance(24);
```

The renderer uploads a 32-bit refractivity value per cell and visits the interpolation cells a ray crosses, so draw
cost depends on the grid resolution and its projected area. The maximum dimension is the GPU's 3D texture limit.
This models the optics of an air temperature field at uniform pressure. The supplying solver sets the heat transport and
air motion.

## Subsurface scattering: `SSS`

`@margoengine/post/sss` (6,945 B min+gzip, its own entry; it carries the stack) softens skin, wax and marble: light that enters such a surface leaves it a little way off, so
`SSS` blurs the lit image of the pixels you mark by a colour profile measured in world units. It is the screen-space
half of subsurface scattering; the `subsurface` option of `@margoengine/materials` is the other half (light seen
through thin parts and wrapped round the terminator). An HDR `PostStack` effect: put it first among the HDR effects.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {SceneTargets} from 'margoengine/post/mrt';
import {SSS} from 'margoengine/post/sss';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
// Mark what scatters: here every surface lighter than half grey, as an r8 mask (any red channel 0..1 works).
const targets = SceneTargets.attach(stage.engine, {
  outputs: {skin: {wgsl: 'vec4f(step(0.5, t.albedo.r))', format: 'r8unorm'}},
});
const sss = new SSS({mask: () => targets.texture('skin'), radius: 0.012});
PostStack.attach(stage.engine, [sss, new Tonemap()]);
sss.options.profile = [1, 0.85, 0.7]; // marble: options are read every frame
```

| Option | Default | Meaning |
| --- | --- | --- |
| `mask` | none | Red channel 0..1 of a texture over the frame: how much each pixel scatters (`SceneTargets` output, `() => selection.maskTexture`). Nothing scatters without it |
| `radius` | `0.01` | How far light travels under the surface, world units (1 cm: skin at metre scale) |
| `profile` | `[1, 0.4, 0.25]` | Red, green, blue spread, each a share of `radius` (skin: red travels farthest); wax and marble spread more evenly |
| `strength` | `1` | Share of the scattered light mixed in, times the mask |
| `taps` | `8` | Taps on each side of a pixel in each of the two passes, 1 to 32 |
| `enabled` | `true` | False passes frames through |

- **Method.** The separable screen-space blur of Jimenez et al. (2015): one 1-D pass across, one down. Each channel's
  kernel is a Gaussian as wide as `radius x profile` (d'Eon and Luebke 2007 fit measured skin profiles with sums of
  Gaussians, red the widest). Widths are in world units, turned into pixels from the depth at each pixel, so the look
  keeps its size at any distance and works for orthographic cameras. Weights are normalised per channel, so a flat
  colour stays exactly that colour. A tap off the mask, on the background or across a depth step (a gap larger than
  `radius`) counts as the centre colour, so light does not bleed across silhouettes or onto unmarked objects.
- **Checked on a real GPU** (`packages/post/test/sss-browser.mjs`, Apple silicon Mac, Metal, Chromium): a light
  and a dark box meeting in an edge, both masked, `radius` 0.12, 16 taps: the 10 to 90% edge is 15 px wide in red, 6 in
  green and 3 in blue (sharp without SSS), the flat faces keep their colour to 0/255, the background is untouched, and
  no mask equals no effect exactly.
- **Limits.** Screen space: only what is on screen scatters, and one 2-D Gaussian per channel stands in for a sum of
  them (no long red tail). The kernel stops at 64 px each side, so a surface filling the screen near the camera
  scatters less than `radius` asks. The mask is yours to supply; a material's `subsurface` value does not mark pixels
  by itself. One `rgba16float` texture at the frame size. GPU cost not measured yet. WebGPU only.

## Anamorphic streaks: `Anamorphic`

`@margoengine/post/anamorphic` (6,295 B min+gzip, its own entry; it carries the stack) draws the cinema lens look:
bright points and highlights throw thin horizontal streaks of light, tinted blue by default. An HDR `PostStack` effect:
put it before `Bloom` or `Tonemap`.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {Anamorphic} from 'margoengine/post/anamorphic';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const streaks = new Anamorphic({threshold: 2, intensity: 0.6});
PostStack.attach(stage.engine, [streaks, new Tonemap()]);
streaks.options.tint = [1, 0.8, 0.6]; // warm streaks: options are read every frame
```

| Option | Default | Meaning |
| --- | --- | --- |
| `threshold` | `1.5` | Linear brightness (largest channel) where streaks start, with a soft knee of half of it below |
| `intensity` | `0.5` | Streak strength, 0 to 10 |
| `tint` | `[0.4, 0.6, 1]` | Linear RGB colour the streak light is multiplied by, each 0 to 1 |
| `passes` | `5` | Spreading passes, 1 to 6: streaks reach 2 (3^passes - 1) half-width texels each side (5: 968 px) |
| `enabled` | `true` | False passes frames through |

- **Method.** A bright pass keeps the light above `threshold` (soft knee) at half width and a quarter of the height,
  taking the brightest of each four rows so a one-pixel light is never lost. Then `passes` horizontal passes of 9 taps
  each, pass k spaced 3^k texels apart with weights exp(-|i|/2): a chain of growing sparse kernels whose product is one
  smooth falloff. The composite adds the streaks times `intensity` and `tint`, sampled bilinearly back to full size.
- **Checked on a real GPU** (`packages/post/test/anamorphic-browser.mjs`, Apple silicon Mac, Metal, Chromium): one small
  white box in a dark frame, threshold 0.4: its row brightens out to both frame edges, rows 24 px or more above and
  below are unchanged to the bit, and a threshold above everything equals the effect disabled exactly.
- **Limits.** Horizontal only; one colour per streak (no rainbow split); streaks are about 4 px tall. Two quarter-size
  and one full-size `rgba16float` targets. GPU cost not measured yet. WebGPU only.

## Blur: `Blur`

`@margoengine/post/blur` (8,249 B min+gzip, its own entry; it carries the stack) blurs the frame, all of it or one
rectangle: frosted glass behind a menu, a focus pull, or a step in your own chain of effects. An HDR `PostStack` effect.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {Blur} from 'margoengine/post/blur';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const glass = new Blur({radius: 12, region: [0.6, 0.1, 0.95, 0.9]});
PostStack.attach(stage.engine, [glass, new Tonemap()]);
glass.radius = 4; // a focus pull: options are read every frame
```

| Option | Default | Meaning |
| --- | --- | --- |
| `kind` | `'gaussian'` | `'gaussian'` (sigma = radius / 3) or `'box'` (equal weights) |
| `radius` | `8` | Half width of the kernel in pixels, 0 to 64; 0 passes the frame through |
| `region` | `[0, 0, 1, 1]` | Part of the view to blur, `[x0, y0, x1, y1]` in 0..1, y down; outside it the frame passes |
| `enabled` | `true` | False passes frames through |

- **Method.** Separable: a horizontal pass of 2 radius + 1 taps into an `rgba16float` texture, then a vertical pass.
  Gaussian weights exp(-x^2 / (2 sigma^2)) normalised over the taps, box weights all equal. Taps past the frame edge
  read the nearest pixel.
- **Checked on a real GPU** (`packages/post/test/blur-browser.mjs`, Apple silicon Mac, Metal, Chromium): a box blur of
  radius 6 over a light and dark edge changes exactly 12 pixels on each middle row, all within 7 px of the edge; with
  `region` the top half, the bottom half equals the unblurred frame to the bit; radius 0 equals disabled exactly.
- **Limits.** Cost grows with the radius (2 radius + 1 reads a pixel a pass); the region has a hard edge; a bright
  frame border bleeds inward. One or two full-size `rgba16float` targets. GPU cost not measured yet. WebGPU only.

### Zoom and spin (radial blur)

`kind: 'zoom'` streaks the frame towards `center`, for speed and impact shots; `kind: 'spin'` smears it around
`center`. One pass; `region` and `enabled` work as above, `radius` is not used.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {Blur} from 'margoengine/post/blur';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const rush = new Blur({kind: 'zoom', center: [0.5, 0.45], strength: 0.25, innerRadius: 0.15});
PostStack.attach(stage.engine, [rush, new Tonemap()]);
rush.options.strength = 0.05; // live: every option is read each frame
// Light rays from a sun at the top right: the frame stays sharp, light above `threshold` streaks away from it.
Object.assign(rush.options, {center: [0.8, 0.15], strength: 0.9, samples: 96, decay: 0.97, rays: 1.5, innerRadius: 0});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `center` | `[0.5, 0.5]` | The sharp point, 0..1 of the view, y down; -10 to 10, so it may be off screen |
| `strength` | `0.1` | 0 to 1; 0 passes the frame. Zoom: share of the way to the centre. Spin: arc in radians |
| `samples` | `32` | Taps per pixel, a whole number 2 to 128 |
| `innerRadius` | `0` | Radius around the centre kept sharp, 0 to 10 view heights |
| `falloff` | `0.2` | Distance past `innerRadius` over which the blur grows to full, 0 to 10 view heights |
| `decay` | `1` | Weight of each tap as a share of its neighbour's nearer the pixel, 0 to 1 |
| `rays` | `0` | 0 to 8. Above 0, adds the streaks of the light above `threshold`, times `rays`, to the sharp frame |
| `threshold` | `1` | With `rays`: linear light per channel below this casts no ray, 0 to 64 |

- **Method.** `samples` bilinear taps: zoom along the straight line from the pixel towards the centre, spin along the
  arc centred on the pixel, in units of view height so circles stay round; taps past the view edge read its nearest
  pixel. `rays` is the screen-space radial sum of K. Mitchell, "Volumetric Light Scattering as a Post-Process",
  [GPU Gems 3, 2007, chapter 13](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process),
  without its occlusion pre-pass: `threshold` picks the light.
- **Limits.** A long streak with few samples shows steps. Rays come from any bright pixel, in front of the light or
  not. GPU cost not measured yet. WebGPU and the WebGL2 layer.

## Lens model: `Lens`

`@margoengine/post/lens` (6,631 B min+gzip, its own entry; it carries the stack) adds what a real lens does to the
picture: barrel or pincushion distortion, and dirt on the front glass that lights up around bright lights. An HDR
`PostStack` effect: put it after the effects that draw light (`Bloom`, `LensFlare`) so they are distorted too. For the
Panini projection of a wide field of view use the `WideAngle` camera in `@margoengine/cameras/panini`.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {Lens} from 'margoengine/post/lens';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const lens = new Lens({distortion: 0.15, dirtIntensity: 1.5});
PostStack.attach(stage.engine, [lens, new Tonemap()]);
lens.options.distortion = -0.1; // pincushion: options are read every frame
lens.options.dirt = (device: GPUDevice) => {  // your own dirt image, made once per device
  const image = device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture: image}, new Uint8Array([255, 240, 220, 255]), {bytesPerRow: 4}, [1, 1]);
  return image;
};
```

| Option | Default | Meaning |
| --- | --- | --- |
| `distortion` | `0` | Radial distortion k, -1 to 1: above 0 barrel (corners stay put), below 0 pincushion |
| `dirtIntensity` | `1` | Strength of the lit dirt, 0 to 10; 0 skips the glow passes |
| `threshold` | `1` | Linear brightness (largest channel) above which light lights the dirt |
| `dirt` | built-in smudges | A `GPUTexture` of the engine's device, linear RGB, stretched over the view, or `(device) => GPUTexture`, made once per device so it is back after a device restore. A plain texture is lost with its device: the built-in smudges draw, `engine.onError` hears of it once (`'state'`, [#borrowed-lost](https://margoengine.com/errors#borrowed-lost)), and assigning `lens.options.dirt` a new texture brings it back |
| `enabled` | `true` | False passes frames through |

- **Method.** Each pixel reads the frame at c + (p - c) (1 + k r^2) s, with r measured in view heights from the
  centre c; for barrel s scales the corners back onto the corners. The dirt glow is the light above `threshold`
  averaged over 8 by 8 pixel blocks, blurred by a 25-tap Gaussian across and down at an eighth of the size, and added
  times the dirt at the undistorted point (the dirt sits on the glass).
- **Checked on a real GPU** (`packages/post/test/lens-browser.mjs`, Apple silicon Mac, Metal, Chromium): with k 0.3 a bar
  moves to within 0.13 px of where the mapping predicts; with dirt white on the left half and black on the right, the
  dark background around the left bar brightens and the right half equals the frame without the effect to the bit; a
  threshold above everything, and no distortion with no dirt, equal disabled exactly.
- **Limits.** One radial term (no tangential or colour split); distortion resamples bilinearly, softening slightly; the
  glow reaches about 50 px. Two eighth-size and one full-size `rgba16float` targets. GPU cost not measured yet. WebGPU
  only.

## Multiple render targets: `SceneTargets`

`@margoengine/post/mrt` draws the scene's surfaces into several named textures in one pass. Each output is a built-in
value (`albedo`, `normal` (world), `position` (world), `distance` (from the camera), `emissive`, `material`
(roughness, metalness, occlusion)) or your WGSL `vec4f` expression over `t: TargetSurface` (the same values, all world
space), with its own float, normalised or integer colour format. Core meshes always draw (a replay of core's shader with the
lighting left out); add gltf/pbr models, materials meshes and a `Terrain` with `targets.add(model)` so their own maps,
skinning and instances write the outputs, a lit `Scatter` with `targets.add(scatter, {ground: false})` and a `Water` the same way (`@margoengine/water`). The pass runs after the passes at -5 that change core's shader and draw
shadow maps (`Shadows`, sections), whatever order they were attached in, and before the main pass (`order: -4.5` by
default), so materials can read this frame's targets; a material that reads a target must not be added. Its own depth
is `targets.depth`. Textures follow the drawing size and are replaced on resize (`onResize`). WebGPU only (and the
WebGL2 layer that runs it).

Sun light and the look masks. `t.shadow` is the sun's visibility on the surface (1 lit, 0 hidden): the share of the sun
a shadow plugin lets through (`@margoengine/shadows`, its light functions and coloured shadows counted by Rec. 709
luminance), 1 with no shadow plugin; `t.light` is the unit direction toward the sun and `t.subject` is 1 on models
added with `targets.add(model, {subject: true})`. Built-in values make the masks `@margoengine/headless/look`'s
clean-frame checks read (`r8unorm`, 1 inside): `penumbra` (a surface facing the sun, cosine over 0.05, with
visibility strictly between 0.02 and 0.98), `litGround` (ground, a normal within 45 degrees of up, facing the sun with
a cosine of at least 0.2, visibility at least 0.98), `shadedGround` (the same ground with visibility at most 0.02) and
`subject`; `shadow` itself is `rg16float`, the visibility and the cosine to the sun. The limits are exported as
`TARGET_MASK_LIMITS`. Checked on a real GPU, WebGPU and the WebGL2 layer, by `test/scene-targets-shadow-browser.mjs`: a
terrain and a core floor under a high sun each carry a box's soft shadow (about 350 shaded, 70 penumbra and 20,700 lit
pixels at 320 x 240, visibility 0.0002 shaded and 0.99999 lit), the frame is darker inside the shaded mask, a gltf box
fills the subject mask, and with the Shadows plugin removed every surface reads 1. Core meshes cannot be marked as the
subject (core draws them in one pass); make the subject a gltf/pbr model or a materials mesh.

```ts
import { Engine } from 'margoengine/core';
import { SceneTargets } from 'margoengine/post/mrt';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const targets = SceneTargets.attach(engine, {
  outputs: {
    albedo: 'albedo',
    normal: 'normal',
    mask: { wgsl: 'vec4f(t.roughness, t.metalness, 0, 1)', format: 'rg8unorm' },
  },
});
targets.onResize(() => console.log(targets.texture('normal')?.width));
```

Integer outputs. Any colour-renderable `uint` or `sint` format (`r8uint` to `rgba32sint`, `rgb10a2uint`) takes
`wgsl` of type `vec4u` or `vec4i`; the built-in values are floats and need a float or normalised format. Its `clear`
takes whole numbers inside the format's range (default 0). Read the texture as `texture_2d<u32>` or
`texture_2d<i32>` with `textureLoad`; integer textures cannot be filtered. Checked on a real GPU, WebGPU and the
WebGL2 layer, by `test/scene-targets-integer-browser.mjs`: `r32uint`, `rg16sint` and `rgba8uint` outputs of a core
floor, a materials mesh and a water read back exact on every pixel, clear values included.

The outputs together must fit the device's `maxColorAttachmentBytesPerSample`, 32 on a default device. WebGPU counts
8 bytes for `rgba8unorm`, `bgra8unorm` and the `rgb10a2` formats and `rg11b10ufloat`, otherwise a format's own size,
each placed at its component size: four `rgba16float` outputs fill it. `attach` throws `unsupported` with the total
when they do not fit; pass smaller formats or use a second `SceneTargets`. `rg11b10ufloat` also needs the engine
created with `features: ['rg11b10ufloat-renderable']`. Sources: W3C, "WebGPU", Texture Format Capabilities
(<https://www.w3.org/TR/webgpu/#texture-format-caps>); W3C, "WebGPU Shading Language", fragment outputs
(<https://www.w3.org/TR/WGSL/>); C. Burns and W. Hunt, "The Visibility Buffer: A Cache-Friendly Approach to Deferred
Shading", JCGT 2(2), 2013 (<https://jcgt.org/published/0002/02/04/>), an integer id target in use.

```ts
import { Engine } from 'margoengine/core';
import { SceneTargets } from 'margoengine/post/mrt';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const targets = SceneTargets.attach(engine, {
  outputs: {
    colour: 'albedo',
    // 1 core meshes, 2 the subject, 3 models added as not ground; 0 where nothing is drawn.
    kind: {
      wgsl: 'vec4u(select(select(1u, 2u, t.subject > 0.5), 3u, t.ground < 0.5), 0u, 0u, 0u)',
      format: 'r8uint',
    },
    // Height in centimetres, -32768 where nothing is drawn.
    height: { wgsl: 'vec4i(i32(t.position.y * 100.0), 0, 0, 0)', format: 'r16sint', clear: [-32768, 0, 0, 0] },
  },
});
targets.onResize(() => console.log(targets.texture('kind')?.format));
engine.start();
```

The look masks of a shot (`tools/shot`, docs/shots.md) from the sun's shadow and a subject model:

```ts
import { Engine, box } from 'margoengine/core';
import { Shadows } from 'margoengine/shadows';
import { loadGLTF } from 'margoengine/gltf/pbr';
import { SceneTargets } from 'margoengine/post/mrt';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const ground = engine.createMesh().setGeometry(box(20, 0.2, 20));
const person = await loadGLTF(engine, '/models/person.glb');
const shadows = Shadows.attach(engine);
shadows.add(ground, { static: true });
shadows.add(person);
const looks = SceneTargets.attach(engine, {
  outputs: { penumbra: 'penumbra', lit: 'litGround', shadow: 'shadedGround', subject: 'subject' },
});
looks.add(person, { subject: true });
engine.start();
```

Plants and props hide the ground and are not ground: `targets.add(model, {ground: false})` sets `t.ground` to 0 on the
model, so `litGround` and `shadedGround` read 0 there (grass, ferns and blades carry the ground's up-facing normal)
while it still hides the ground behind it and writes depth, `shadow`, `penumbra`, `subject` and every custom output.
The default `ground: true` lets the normal decide, as before; `t.ground` is 1 on core meshes. A lit `Scatter`
(`@margoengine/scatter`) and its subclasses are added like any model: their capture draws this frame's LOD rings with
their own stage (see that README, "Material capture").

## Depth texture: `DepthTexture`

`@margoengine/post/depth` keeps the scene's depth in textures of its own, so any pass or material can sample it without
borrowing one from an effect: `depth.texture` (depth32float, reversed Z, bind as `texture_depth_2d`) and
`depth.distance` (r32float world distance from the camera, 0 where empty; read with `textureLoad`). It runs before the
main pass, so a material reads this frame's depth: soft particles, shorelines, fog volumes. Core meshes always draw
into it; add gltf/pbr models and materials meshes with `depth.add(model)`, but not one whose material reads the depth.

```ts
import { Engine } from 'margoengine/core';
import { Texture, WgslMaterial } from 'margoengine/materials';
import { DepthTexture } from 'margoengine/post/depth';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const depth = DepthTexture.attach(engine);
const water = new WgslMaterial({
  wgsl: `fn shade(i:Out,s:Surface)->Surface {var o=s;
    let behind=textureLoad(sceneDistance,vec2i(i.clip.xy),0).r;
    let gap=behind-distance(f.eye.xyz,i.position);
    o.base=vec4f(mix(vec3f(1),o.base.rgb,clamp(gap/0.4,0.0,1.0)),1);return o;}`,
  textures: { sceneDistance: new Texture({ data: new Float32Array(1), width: 1, height: 1, format: 'r32float' }) },
});
depth.onResize(() => (water.textures.sceneDistance = new Texture(depth.distance!)));
```

Both textures are single-sample at any scene MSAA. A canvas view and a view `target` of another size keep a texture
set each, so drawing both every frame creates no textures after the first; `onResize` fires whenever the current set
changes, so a material bound through it follows the view being drawn.

Verified on a real GPU by `npm run check:depth` (scripts/test-depth-browser.mjs; NVIDIA RTX A6000, Edge 156, 128 x 96,
the same results at 1x and 4x MSAA):

- Reversed-Z depth of a box face 5.75 in front of a perspective camera (near 0.1, far 100): 0.0164077, within 6.3e-10
  of what `camera.matrix` gives for that point; 0 where nothing is drawn.
- `distance`: within 1.9e-7 (relative) of the analytic distance to the face (5.76101); 0 where empty.
- Orthographic (`@margoengine/cameras` CameraProjection): depth linear in view depth (slope 0.0100000 per unit for a
  100-unit clip range, within 1.4e-8 of `camera.matrix`); distance within 5.9e-6 (relative).
- A basic-shaded WgslMaterial plane reading `distance` with `textureLoad` writes the expected colour exactly (red 200
  of 255 for 5.761 / 10, sRGB encoded).
- A FramePass at order 50 reading `texture` as `texture_depth_2d` gets every texel exactly.
- At 4x MSAA the values equal 1x exactly across 11410 texels away from edges.
- Two views with their own cameras keep their own halves (5.7610 and 8.7516, within 3.4e-7); the second view does not
  clear the first.
- A materials mesh added with `depth.add` is in the depth (within 1.1e-6), one not added is not, and removing it
  leaves it out.

## Projected decals: `Decals`

`@margoengine/post/decals` (5,243 B min+gzip, its own entry) projects textured boxes onto whatever is already drawn,
the screen-space way: each decal is a box projector; its pass reconstructs every covered pixel's world position from
scene depth, keeps the pixels inside the box, fades by the angle between the surface and the projection and samples one
texture atlas.

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
import {Decals} from 'margoengine/post/decals';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine);                               // any post capture provides the scene depth
const decals = Decals.attach(engine);                 // default white texel; pass {atlas} for a sampled 2D GPUTexture
decals.setAtlas((device) => {                         // or (device) => GPUTexture, made once per device: back after a device restore
  const atlas = device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture: atlas}, new Uint8Array([200, 60, 40, 255]), {bytesPerRow: 4}, [1, 1]);
  return atlas;
});
decals.setDecals([
  {position: [0, 0, 1], direction: [0, -1, 0], width: 1, height: 0.5, rect: [0, 0, 0.5, 0.5]},        // grime, multiply
  {position: [2, 1, -1], direction: [0, 0, -1], width: 0.6, height: 0.3, mode: 'over', color: [4, 3, 2]}, // glowing sign
]);
```

- **Projection.** `direction` points into the surface; the footprint is `width` x `height` around `position` (right =
  direction x `up`), the box reaches `depth` (default the smaller side) along `direction`, and the last 10% at both ends
  fades. `rect` is the atlas region (u0, v0, u1, v1; v down). The atlas is a texture or `(device) => texture` (made once per
  device); a plain atlas lost at a device restore draws no decal, is reported once through `engine.onError`
  (`'state'`, [#borrowed-lost](https://margoengine.com/errors#borrowed-lost)), and `setAtlas` brings the decals back.
- **Normal-angle fade.** The surface normal comes from the depth buffer (per axis, the neighbour on the same surface, so
  silhouettes do not smear); a surface turned more than `angle` (default 60 degrees) from facing the projector gets
  nothing, with a fade over the last third, so a decal on a box top does not stretch down its sides.
- **Blending.** `'multiply'` (default) scales the lit pixel by `color x texel` mixed by alpha: lighting, shadows and
  reflections stay (grime, cracks, paint on a light surface); it cannot brighten. `'over'` blends `color x texel` as
  unlit radiance (signs, glows; `color` may exceed 1). Multiply decals draw first, then over decals, each in list order.
- **Where it runs.** Order 1.9: after opaque core meshes (0), gltf/pbr and materials models (1) and LOD (1.5); before the
  sky (2), water (4), volumetric fog (5) and particles, so everything that writes depth before it can carry decals and
  the effects after it draw over them. Back faces of the boxes only, no depth test: each covered pixel runs once, also
  with the camera inside a box. One render pass, one instanced draw per mode (36 vertices per decal), one storage buffer
  of 96 B per decal; it adds nothing to any mesh shader. With no decals the pass records nothing.
- **Culling.** Each frame, on the CPU, a decal is drawn only when its bounding sphere (centre `position`, radius half
  the box diagonal) is inside the six clip planes of the camera's view-projection and spans at least `minPixels`
  (default 1) on screen. The span is a conservative bound, so a culled decal covers less than that. The visible decals
  are packed together and uploaded only when the visible set changes, so thousands cost what is in view: draw counts,
  per-pixel work and the upload follow the visible ones. `decals.drawn` reads how many the last frame drew;
  `minPixels: 0` turns the size cull off (the view cull never changes the picture).

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
import {Decals} from 'margoengine/post/decals';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Tonemap.attach(engine);
const decals = Decals.attach(engine, {minPixels: 2});  // skip decals under 2 px across
decals.setDecals(Array.from({length: 4096}, (_, i) => ({
  position: [(i % 64) * 2 - 64, 0, Math.floor(i / 64) * 2 - 64], direction: [0, -1, 0], width: 1, height: 1,
})));
engine.render();
console.log(`${decals.drawn} of ${decals.count} decals drawn`);
```

- **Validation.** `setDecals` checks the whole list (no holes, every field valid, values finite as Float32) before
  replacing anything, so a bad list throws and leaves the current decals drawing. `setDecals([])` clears them.
- **Checks** (Intel Arc 140V, Edge 155, AC; `node examples/package-benchmarks/decals-gpu.mjs`,
  [decals-gpu.json](../../examples/package-benchmarks/results/decals-gpu.json)), each at 4x and 1x MSAA, every 8th
  pixel ray-cast on the CPU: outside every decal box (3 cm margin) the frame equals the decal-free frame exactly; a
  multiply decal scales the floor's radiance by its colour (channel ratios within 0.04, through the inverse of Tonemap
  'neutral'); over a cube's top edge the top face is marked and the 90-degree side faces are untouched (0/255), and the
  floor below the box's depth range stays untouched; an `over` decal on the atlas's red quadrant shows exactly
  tonemap(0.6, 0, 0); a box containing the camera still draws; an empty Decals equals none.
- **Culling check** (Apple silicon Mac, Metal, Chromium; `node packages/post/test/decals-cull-browser.mjs`): 4,096 decals
  with one on screen (2,000 beside the view, 2,045 behind the camera, 50 under a tenth of a pixel across) equal the frame
  with that decal alone exactly, and `drawn` is 1. On the CPU, 200 random spheres anywhere in view, from 0.5 to 60 m:
  none whose real projected span (4,000 surface points) reaches `minPixels` is culled.
- **Cost** (diagnostic: the quiet gate passed at 6% CPU, but other jobs were running): GPU time of the whole frame, 4x MSAA, 1 m
  decals on the floor in front of the camera: 1280 x 720 1.64 ms without, 1.64 / 1.97 / 6.36 ms with 1 / 16 / 256
  decals (256 overlap about four deep); 1920 x 1080 3.67 ms -> 3.93 / 4.33 / 14.03 ms. The first decal's cost is mostly
  its own pass over the multisampled target; each covered pixel then reads five depth values (position and normal) and
  one atlas texel.

Limits: needs a post capture's scene depth (throws `Decals need scene depth: attach a post capture (Tonemap, Bloom,
PostStack, SSAO, TAA) first`); at 4x MSAA it reads depth sample 0 and writes every covered sample, so decal edges along
geometry silhouettes are per pixel, not per sample; gltf/pbr BLEND primitives (drawn before it, without depth) get no
decal of their own and are tinted with the decal of the surface behind them; it changes colour only (`MaterialDecals` below changes normal, roughness and metalness); `multiply` cannot lighten; up to 4,096 decals per `setDecals`; the cull costs one sphere test per decal per frame on the CPU and the size cull drops
decals under `minPixels` across (default 1 px). WebGPU only.

## Material decals: `MaterialDecals`

`@margoengine/post/material-decals` (its own entry) projects boxes that change the surface itself: its normal, from a
tangent-space normal atlas, its roughness, metalness and base colour, for bullet holes, dents, wet patches and grime
with depth. It is an HDR PostStack effect: the surface under each pixel comes from a `SceneTargets` capture (built-in
`albedo`, `normal` and `material`), the light is the scene's sun and ambient (`engine.lighting`), and the pixel's direct
and ambient light are worked out with core's lit shading model for the surface before and after the decals; the
difference is added to the lit image. How much sun reached the pixel is read back from the lit image, so a decal in
shadow stays in shadow.

```ts
import {Engine, box, PbrMaterial} from 'margoengine/core';
import {SceneTargets} from 'margoengine/post/mrt';
import {PostStack} from 'margoengine/post/stack';
import {Tonemap} from 'margoengine/tonemap';
import {MaterialDecals} from 'margoengine/post/material-decals';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
engine.createMesh().setGeometry(box(8, 0.2, 8)).setMaterial(new PbrMaterial({color: '#808080', roughness: 1}));
const targets = SceneTargets.attach(engine, {outputs: {albedo: 'albedo', normal: 'normal', material: 'material'}});
const decals = new MaterialDecals({
  targets: () => ({albedo: targets.texture('albedo')!, normal: targets.texture('normal')!, material: targets.texture('material')!}),
});
PostStack.attach(engine, [decals, new Tonemap()]);
decals.setDecals([
  {position: [0, 0.1, 0], direction: [0, -1, 0], width: 1.5, height: 1, roughness: 0.08, color: [0.6, 0.6, 0.65]}, // a wet patch
  {position: [2, 0.1, 1], direction: [0, -1, 0], width: 0.3, height: 0.3, metalness: 1, bump: 2},              // scraped metal
]);
```

- **Decals.** Each is a box projector placed as a `Decal` of `@margoengine/post/decals` (`position`, `direction`,
  `width`, `height`, `depth`, `up`, `rect`, `opacity`, `angle`, same defaults). `bump` (0 to 4, default 1) scales the
  atlas normal; `roughness` and `metalness` (0 to 1) replace the surface's, unset keeps them; `color` (default
  `[1, 1, 1]`) multiplies the base colour. Coverage is the atlas alpha times `opacity` and the angle and depth fades;
  later decals apply over earlier ones. At most 64 per `setDecals`; every pixel tests each one.
- **Atlas.** `atlas` is a sampled 2D texture: RGB a tangent-space normal map (green up, as glTF and OpenGL), alpha the
  coverage, read at mip level 0. The map's x follows the decal's right axis (`up` x `direction`) and its y the decal's up
  axis, laid onto the surface. Default a flat normal with full coverage, so a decal without an atlas changes only
  roughness, metalness and colour. Pass `atlas` as `(device) => GPUTexture` and it is made once per device, so it is back
  after a device restore. A plain texture is lost with its device: no decal applies, `engine.onError` hears of it once
  (`'state'`, [#borrowed-lost](https://margoengine.com/errors#borrowed-lost)), and assigning `decals.options.atlas` a new
  texture brings the decals back.
- **Light.** The relight uses core's lit model (Lambert plus GGX, the sun and the ambient of `engine.lighting`). Core
  meshes match it; gltf/pbr and materials models, which add image-based light and more lights, get the sun and ambient
  part of the change only.
- **Checks** (Apple silicon Mac, Metal, Chromium; `node packages/post/test/material-decals-browser.mjs`): on a rough grey
  floor seen along the sun's mirror direction, a 1 m decal with a normal tilted 45 degrees toward the sun brightens
  3,949 pixels and darkens none, tilted away darkens 3,949 and brightens none, roughness 0.05 shows the highlight,
  metalness 1 darkens all it covers; a decal that changes nothing, no capture and `enabled: false` each equal the frame
  without decals exactly.

Limits: needs a `SceneTargets` capture (one more scene pass) and runs in a PostStack, so it also relights what
transparent effects drew over the decal's surface; the shadow share is read per pixel from the lit image, so where the
unshadowed sun gives the old surface nothing (facing away from the sun) a new normal that faces it is treated as lit;
the atlas has no mipmaps in use (level 0), so a far, dense normal map can shimmer; up to 64 decals, no culling. WebGPU
only.

## ASCII art: `ASCII`

`@margoengine/post/ascii` (8,976 B min+gzip, its own entry; it carries the stack) redraws the frame as a grid of
characters, each picked by how bright its cell is, and can hand the same grid back as text. An LDR `PostStack` effect:
put it last.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {ASCII} from 'margoengine/post/ascii';
const stage = await createStage('#viewport', {backend: 'webgpu'});
stage.box();
const ascii = new ASCII({cellSize: [6, 8], edges: true});
PostStack.attach(stage.engine, [ascii]);
ascii.options.color = '#33ff66'; // a green terminal: options are read every frame
stage.engine.render();
console.log(await ascii.text()); // the same picture as lines of text
```

| Option | Default | Meaning |
| --- | --- | --- |
| `characters` | `' .:-+=*%#@'` | Ramp from least to most ink, 2 to 250 characters |
| `cellSize` | `[12, 16]` | Drawing-buffer pixels per character, one number (square) or `[width, height]`, 4 to 64. Multiples of `[6, 8]` keep the built-in glyphs sharp |
| `font` | built-in bitmap | A CSS font family, such as `'monospace'`, drawn through `OffscreenCanvas` (page or worker); needed for characters outside printable ASCII, such as `' ░▒▓█'` |
| `fontSize` | cell height | Size of `font` in pixels, above 0 up to 256 |
| `color` | `'scene'` | Ink: `'#rgb'`, `'#rrggbb'` or `'scene'`, the cell's average colour |
| `background` | `'#000000'` | Paper, same forms; `'scene'` paints colour blocks (give `color` a fixed value then) |
| `invert` | `false` | Dense characters for dark cells, for dark ink on light paper |
| `edges` | `false` | A cell holding one strong edge draws a character along it |
| `edgeCharacters` | `'\|/-\\'` | Vertical, rising, horizontal and falling edge characters |
| `edgeThreshold` | `0.2` | Luminance step, 0 to 1, a straight edge needs to count |
| `intensity` | `1` | Mix over the scene, 0 to 1 |
| `enabled` | `true` | False passes frames through |

`text({signal})` resolves to the characters of the last drawn frame, one line per cell row from the top. It rejects with
`'state'` before a frame has drawn with the effect enabled.

- **Method.** One pass writes a small texture, two texels a cell: the mean colour, and the character. The character is
  the ramp entry at floor(luminance times length), from Rec. 709 weights on the display-encoded mean. With `edges`, the
  structure tensor of luminance differences summed over the cell (Bigun and Granlund, "Optimal orientation detection of
  linear symmetry", ICCV 1987) replaces it by one of four edge characters when the differences reach `edgeThreshold` and
  at least half of them agree on one direction. A second pass draws the glyphs from an atlas made at the cell size. The
  built-in 5 x 7 glyphs are Margo's own and need no canvas or font file.
- **Checked on a real GPU** (`packages/post/test/ascii-browser.mjs`, Intel Arc 140V, Chromium, WebGPU and the WebGL2
  layer): all 405 characters equal a CPU reading of the unprocessed frame, equal characters draw equal pixels, colour
  blocks are within 1.5 of 255 of each cell's average, a box draws `|` and `-` on its sides and `/` and `\` when turned
  45 degrees, and `intensity: 0` and `enabled: false` equal the plain frame to the bit.
- **Limits.** Characters follow tone and one edge direction, not glyph shape (no shape matching as in Xu, Zhang and
  Wong, "Structure-based ASCII art", SIGGRAPH 2010). One code point per character, monospaced cells. Load a web font
  (`await document.fonts.load('16px MyFont')`) before the first frame that uses it: the atlas is rebuilt only when an
  option changes. Every frame reads each pixel twice (five times that for the character pass with `edges`); GPU cost not
  measured yet. A cell's alpha is its average coverage on a transparent canvas. WebGPU and the WebGL2 layer.

## Pixel art: `Pixelate`

`@margoengine/post/pixelate` (10,491 B min+gzip, its own entry; it carries the stack and the normal capture) draws the
frame as square cells of whole pixels, each taking the colour at its middle, and adds two edge lines the cell grid
would lose: a dark line along depth silhouettes and a light line along creases. An LDR `PostStack` effect: put it last.
`Pixelate.attach(engine, options)` runs it alone in an owned stack.

```ts
import {createStage} from 'margoengine';
import {Pixelate} from 'margoengine/post/pixelate';
const stage = await createStage('#viewport', {backend: 'webgpu'});
stage.box();
const pixels = Pixelate.attach(stage.engine, {pixelSize: 8, normalEdgeStrength: 0.5});
pixels.options.pixelSize = 4; // options are read every frame
stage.engine.render();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `pixelSize` | `6` | Drawing-buffer pixels along one side of a cell, a whole number from 1 to 128. `1` keeps every pixel |
| `depthEdgeStrength` | `0.4` | How far a silhouette darkens, 0 to 1. `0` draws none |
| `normalEdgeStrength` | `0.3` | How far a crease lightens toward white, 0 to 1. `0` draws none |
| `depthThreshold` | `0.02` | Relative step in linear depth, above 0, at which a silhouette starts. Smaller finds shallower steps |
| `normalThreshold` | `0.1` | `1 - dot(n0, n1)` between neighbouring cells, above 0, at which a crease starts |
| `normal` | owned capture | `() => GPUTexture \| undefined`: a texture of signed unit normals, any size, in place of the capture |
| `enabled` | `true` | False draws every pixel with no edges |

`add(model)` lets a model's own materials, alpha masks and deformed normals into the captured normals, as for `SSR`; it
returns a function that takes it out again. A bad option throws a `RangeError` or `TypeError` naming it, at
construction.

- **Method.** One pass. Each cell reads the scene at its middle texel. The four neighbouring cells' depths, as linear
  distance from the camera, give the silhouette: the relative step to each is smoothed from `depthThreshold` to twice
  that and the largest one darkens the cell. Where the depth step stays under `depthThreshold` (the same surface, not
  a silhouette), the largest `1 - dot` of the unit normals against the four neighbours, smoothed from `normalThreshold`
  to twice that, lightens the cell. Silhouettes and creases are separate settings: strength 0 turns one off alone.
- **Normals.** Without `normal` the effect plugs a scene-normal capture into the engine on setup and removes the need
  for you to run one; a `normal` you supply is read instead, and the capture is not made. Sky and other pixels with no
  depth get no edges.
- **Limits.** Edges are found at cell spacing, so a feature narrower than a cell cannot draw a line. The scene is
  sampled, not averaged, so a one pixel highlight can vanish or flicker as the camera moves. A supplied `normal`
  texture is sampled at the same relative place as the frame, so a different size is allowed but is not filtered. WebGPU
  and the WebGL2 layer.

## Overlays: `Ramp`, `Grid`, `DepthView`, `TextureOverlay`

`@margoengine/post/overlays` (10,454 B min+gzip, its own entry; it carries the stack) draws a layer over the frame:
a colour gradient, a screen-space grid, the scene depth, or an image. All four are LDR `PostStack` effects, so put them
last.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {Ramp, Grid, DepthView, TextureOverlay} from 'margoengine/post/overlays';
const stage = await createStage('#viewport', {backend: 'webgpu'});
stage.box();
const art = new OffscreenCanvas(256, 64);
const ink = art.getContext('2d')!;
ink.fillStyle = '#ffffff';
ink.font = '48px sans-serif';
ink.fillText('DRAFT', 48, 48);
const ramp = new Ramp({type: 'radial', stops: [{at: 0, color: '#ffffff'}, {at: 1, color: '#203060'}], blend: 'multiply'});
const grid = new Grid({cellSize: 40, opacity: 0.2});
const depth = new DepthView({near: 1, far: 20, opacity: 0}); // raise opacity to inspect the depth
const label = new TextureOverlay({source: art.transferToImageBitmap(), fit: 'none', offset: [0.3, 0.38], opacity: 0.8});
PostStack.attach(stage.engine, [ramp, grid, depth, label]);
depth.options.opacity = 0.5; // options are read every frame
stage.engine.render();
```

Every effect takes these:

| Option | Default | Meaning |
| --- | --- | --- |
| `blend` | `'normal'` (Ramp `'soft-light'`) | `normal`, `add`, `subtract`, `multiply`, `screen`, `overlay`, `soft-light`, `hard-light`, `darken`, `lighten`, `color-dodge`, `color-burn`, `difference`, `exclusion` |
| `opacity` | `1` (Grid `0.5`) | Layer strength, 0 to 1 |
| `mask` | `'none'` | `'luminance'` (of the frame) or `'depth'` (view distance) weights the layer |
| `maskRange` | `[0, 1]`; depth: `[near, far]` | Mask values given weight 0 and 1; swap them to invert |
| `enabled` | `true` | False passes frames through |

| Effect | Option (default) |
| --- | --- |
| `Ramp` | `type` (`'linear'`; `'radial'`, `'mirrored'`), `stops` (black to white, 2 to 8 of `{at, color, alpha}`), `start` (`[0, 0.5]`, radial `[0.5, 0.5]`), `end` (`[1, 0.5]`), `angle` (`0` degrees), `bias` (`0.5`), `gain` (`0.5`), `invert` (`false`) |
| `Grid` | `style` (`'lines'`; `'dots'`), `cellSize` (`32` pixels, or `[x, y]`), `lineWidth` (`1`, dots `3`), `color` (`'#ffffff'`), `offset` (`[0, 0]` pixels), `angle` (`0`) |
| `DepthView` | `depth` (the stack's capture, or a `DepthTexture`), `mode` (`'linear'`; `'raw'` reversed Z), `near` and `far` (camera planes), `invert` (`false`) |
| `TextureOverlay` | `source` (required: `ImageBitmap`, `GPUTexture` or `() => texture`), `fit` (`'cover'`; `'fill'`, `'contain'`, `'none'`), `offset` (`[0, 0]` frame fractions), `scale` (`1`, negative mirrors), `rotation` (`0` degrees), `repeat` (`false`) |

- **Method.** One pass per effect. Blends are the formulas of W3C "Compositing and Blending Level 1" on display
  values; `bias` and `gain` are Schlick's ("Fast Alternatives to Perlin's Bias and Gain Functions", Graphics Gems IV,
  1994). Gradient colours interpolate as display values, as CSS gradients do.
- **Depth.** To show a `DepthTexture` (with models you added to it), attach it and pass it:
  `new DepthView({depth: DepthTexture.attach(engine)})`. It is also what `mask: 'depth'` then reads on that effect.
- **Texture source.** A `GPUTexture` `source` belongs to the device it was made on (docs/conventions.md, "Borrowed GPU
  objects"): after a device restore it is not bound, the frame passes through, the loss is reported once through
  `engine.onError` (`'state'`, `#borrowed-lost`), and `label.setSource(texture)` with a texture of the new device brings
  it back. A `() => texture` source is read every frame, and an `ImageBitmap` is uploaded again by itself.

## Utility passes: `KawaseBlur`, `LUT1D`, `ColorAverage`, `DepthDownsample`

Four small passes, each its own entry: a wide blur on a small pyramid, a one-dimensional lookup table, a fast
greyscale and a lower-resolution copy of the scene depth.

### Dual-filter and Kawase blur: `KawaseBlur`

`@margoengine/post/kawase-blur` (8,504 B min+gzip, its own entry; it carries the stack) blurs the frame widely for
a fraction of a large Gaussian's cost: frosted glass, soft backgrounds, haze. An HDR `PostStack` effect, so it goes
before a `Tonemap`.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {KawaseBlur} from 'margoengine/post/kawase-blur';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
stage.box();
const blur = new KawaseBlur({levels: 4});
PostStack.attach(stage.engine, [blur, new Tonemap()]);
blur.options.strength = 0.5; // options are read every frame
Object.assign(blur.options, {method: 'kawase', size: 'large', resolutionScale: 0.25});
stage.engine.render();
const small = blur.texture; // the blurred image at reduced size (rgba16float), for your own passes
```

| Option | Default | Meaning |
| --- | --- | --- |
| `method` | `'dual'` | `'dual'`: halvings then doublings. `'kawase'`: repeated four-tap passes at one size |
| `levels` | `3` | Dual: halvings, 1 to 8; each roughly doubles the width |
| `size` | `'medium'` | Kawase: `'very-small'`, `'small'`, `'medium'`, `'large'`, `'very-large'`, `'huge'` (sigma about 1, 4, 10, 20, 66 and 101 texels of the working size; `KAWASE_KERNELS` lists the passes) |
| `offsets` | none | Kawase: your own passes, 1 to 32 offsets of 0 to 64 texels, in place of `size` |
| `scale` | `1` | Factor on every tap offset, 0 to 8; far above 1 shows a pattern |
| `resolutionScale` | `0.5` | Kawase: working size as a share of the view, 0.0625 to 1 |
| `strength` | `1` | Share of the blurred frame mixed over the sharp one, 0 to 1; 0 passes the frame |
| `enabled` | `true` | False passes frames through |

- **Method.** `'dual'` is the dual filter of M. Bjorge, "Bandwidth-Efficient Rendering", SIGGRAPH 2015: five taps a
  halving, eight a doubling. `'kawase'` is M. Kawase, "Frame Buffer Postprocessing Effects in DOUBLE-S.T.E.A.L
  (Wreckless)", GDC 2003: four bilinear taps k + 0.5 texels out each pass; below `resolutionScale` 0.5 the frame is
  halved first, so no texel is skipped. Each view of a split screen blurs on its own.
- **Limits.** The blur is not an exact Gaussian; very small bright points can flicker at low resolution. GPU cost not
  measured. WebGPU and the WebGL2 layer.

### One-dimensional LUT: `LUT1D`

`@margoengine/post/lut1d` (9,717 B min+gzip, its own entry; it carries the stack) looks each channel up in a curve:
film and gamma curves from a 1D `.cube` file, an array or a texture. An LDR `PostStack` effect on display values.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post/stack';
import {LUT1D, parseCube1D} from 'margoengine/post/lut1d';
const stage = await createStage('#viewport', {backend: 'webgpu'});
stage.box();
const warm = `LUT_1D_SIZE 3
0 0 0
0.56 0.5 0.44
1 0.98 0.92`;
const lut = new LUT1D({lut: warm});
PostStack.attach(stage.engine, [lut]);
lut.setLUT({data: [1, 1, 1, 0, 0, 0]}); // two entries: an inversion
lut.setLUT(parseCube1D(warm));
lut.options.opacity = 0.8;
stage.engine.render();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `lut` | required | `.cube` text with `LUT_1D_SIZE` (`TITLE`, `DOMAIN_MIN`, `DOMAIN_MAX`, comments), `{data, domainMin, domainMax}` (three numbers an entry; domain `[0, 0, 0]` to `[1, 1, 1]`), a linear-format `GPUTexture` read row by row, or `() => texture` |
| `blend`, `opacity`, `mask`, `maskRange`, `enabled` | `'normal'`, `1`, `'none'`, by mask, `true` | As on the overlay effects below |

- 2 to 65536 entries, linear interpolation between them (J. Selan, "Using Lookup Tables to Accelerate Color
  Transformations", GPU Gems 2, 2005; the text format is the 1D table of Adobe's Cube LUT Specification 1.0, 2013).
  Strings and arrays are read when a new object is handed in. A `GPUTexture` belongs to the device it was made on
  (docs/conventions.md, "Borrowed GPU objects"). For 3D LUTs use `Tonemap.setLUT`.

### Colour average: `ColorAverage`

`@margoengine/post/color-average` (8,036 B min+gzip, its own entry; it carries the stack) turns each pixel into
the average of its channels. An LDR `PostStack` effect with the same `blend`, `opacity`, `mask`, `maskRange` and
`enabled` as the overlay effects.

```ts
import {createStage} from 'margoengine';
import {ColorAverage} from 'margoengine/post/color-average';
const stage = await createStage('#viewport', {backend: 'webgpu'});
stage.box({color: '#c08040'});
const grey = ColorAverage.attach(stage.engine, {opacity: 0.7});
grey.options.weights = [0.2126, 0.7152, 0.0722]; // Rec. 709 luma; default [1, 1, 1]
stage.engine.render();
```

### Depth downsampling: `DepthDownsample`

`@margoengine/post/depth-downsample` (6,770 B min+gzip, its own entry) writes the scene depth, and optionally
normals, at a lower resolution, for half-resolution ambient occlusion, fog, soft particles and depth-aware
upsampling. A plugin, not a stack effect: it makes textures.

```ts
import {createStage} from 'margoengine';
import {DepthDownsample} from 'margoengine/post/depth-downsample';
const stage = await createStage('#viewport', {backend: 'webgpu'});
stage.box();
const half = DepthDownsample.attach(stage.engine, {mode: 'checkerboard'});
half.onResize(() => console.log('new textures', half.texture?.width, half.texture?.height));
stage.engine.render();
const depth = half.texture; // r32float, reversed Z (1 near, 0 empty): textureLoad it in your pass or material
```

| Option | Default | Meaning |
| --- | --- | --- |
| `depth` | own capture | `() => texture`: a single-sample depth or `r32float` source, reversed Z |
| `normal` | none | `() => texture`: normals of any size; the kept texel's normal goes to `normalTexture` (`rgba16float`) |
| `scale` | `0.5` | Output size as a share of the source, 0.0625 to 1 |
| `width`, `height` | from `scale` | Output texels, from 1/16 of the source up to it |
| `mode` | `'representative'` | `'representative'` (median depth), `'near'`, `'far'`, `'checkerboard'` (near and far on alternate texels) |
| `order` | `-4` | Frame-graph order, read at attachment. The default runs before the main pass, after its own capture |
| `enabled` | `true` | False writes nothing |

- Each texel keeps one source depth of its footprint, never a blend. `'representative'` takes the median of up to
  4 x 4 texels spread over the footprint; the other modes read all of it. Reductions after Greene, Kass and Miller,
  "Hierarchical Z-Buffer Visibility", SIGGRAPH 1993, and Bavoil and Andersson, "Stable SSAO in Battlefield 3 with
  Selective Temporal Filtering", GDC 2012.
- With its own capture, add gltf/pbr models and materials meshes with `half.add(model)`. A `depth` drawn later in the
  frame (such as `PostStack`'s `depthTexture`, resolved at order 30) needs a later `order`, or it is a frame old.

## Trail texture: `TrailTexture`

`@margoengine/post/trail` (3,556 B min+gzip, its own entry) paints pointer or object motion into a texture that
fades every frame: ripples and displacement under the cursor, reveal masks, wakes behind a moving object. Stamps are
soft round brushes; a fast move is joined by stamps at most half a radius apart, so it leaves no gaps, and each move
paints brighter the faster it goes. `texture` is `rgba16float` with the same value in all four channels, (0, 0) at
the top-left texel, and keeps its identity from frame to frame, so a material or bind group made once keeps reading
the latest trail. `trail.source` is a material `Texture` source that also follows a device restore.

```ts
import {Engine} from 'margoengine/core';
import {Material, Texture, createMesh} from 'margoengine/materials';
import {TrailTexture} from 'margoengine/post/trail';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const trail = TrailTexture.attach(engine, {size: 256, radius: 0.05});
const stop = trail.trackPointer(canvas); // the canvas box maps to the whole texture
// The trail lights a full-screen quad: move the pointer over the canvas.
createMesh(engine, {
  positions: [-1,-1,0, 1,-1,0, 1,1,0, -1,1,0],
  normals: [0,0,1, 0,0,1, 0,0,1, 0,0,1],
  uvs: [0,1, 1,1, 1,0, 0,0],
  indices: [0,1,2, 0,2,3],
}, new Material({color: '#101820', emissive: '#40c0ff', emissiveMap: new Texture(trail.source)}));
trail.move(0.2, 0.5); // or paint from code: texture coordinates, joined into one stroke
trail.move(0.8, 0.5);
trail.lift(); // the next move starts a new stroke
trail.stamp(0.5, 0.25, 0.5); // one stamp, not weighted by speed
trail.options.decay = 0.9; // options other than size and order are read every frame
engine.render();
stop();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `size` | `256` | Texels, a number for a square or `[width, height]`; fixed at construction |
| `decay` | `0.95` | Fraction kept per 1/60 s, in (0, 1], scaled by the frame's delta; 1 never fades |
| `radius` | `0.06` | Brush radius as a fraction of the texture width, in (0, 1]; round in texels |
| `intensity` | `1` | Peak value of one stamp, >= 0 |
| `smoothing` | `0` | Exponential smoothing of `move` samples in [0, 1); higher lags and rounds sharp turns |
| `blend` | `'screen'` | `'screen'` (1 - (1 - a)(1 - b), stays within 0..1), `'add'` (can pass 1) or `'max'` |
| `interpolate` | `32` | Most joining stamps between two `move` samples, 0 to 256; 0 stamps the samples only |
| `speed` | `1` | Texture widths per second at which a move paints at full `intensity`; 0 paints every move at full |
| `enabled` | `true` | False holds the trail as it is; queued stamps wait |
| `order` | `-20` | Frame graph order of the update, before the main pass; fixed at construction |

`move(x, y)` takes texture coordinates; for an object, pass the UV of the surface point under it or its projected
screen position over the canvas size. `clear()` starts from black on the next frame. The update runs once a frame,
also with several views. `TrailTexture` is disposable (`using trail = ...`). Limits are in
[docs/limits.md](../../docs/limits.md#trail-texture-margoengineposttrail-2026-11-26); sources in
[docs/clean-room.md](../../docs/clean-room.md#trail-texture-2026-11-26).

## Render graph: `RenderGraph`

`@margoengine/post/render-graph` (7,748 B min+gzip, its own entry) runs a frame pipeline described as JSON: a list
of tasks, each a registered type whose typed input and output slots name textures. Building checks the description
and refuses an unknown type or slot, an input no task writes, a texture with two writers, a slot of the wrong kind
(depth into colour, HDR straight to the screen) or a cycle, each a TypeError with a `code`. It then orders the tasks by
their dependencies and lets transient textures whose lifetimes do not overlap share one GPU texture. Each frame the
tasks run once, in that order, on core's frame graph. `history: true` textures ping-pong: a task reads last frame's
value as `name@previous`, so feedback effects need no cycle. `toJSON()` gives the description back and `load(json)`
rebuilds; a resize only makes the textures again.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {RenderGraph, effectTask, type RenderGraphJSON} from 'margoengine/post/render-graph';
import {Pixelate} from 'margoengine/post/pixelate';
const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color: '#d08040'}));
const description: RenderGraphJSON = {
  version: 1,
  textures: {ldr: {format: 'rgba8unorm'}},
  tasks: [
    {name: 'scene', type: 'scene', outputs: {color: 'hdr', depth: 'depth'}},
    {name: 'tonemap', type: 'blit', inputs: {source: 'hdr'}, outputs: {target: 'ldr'}},
    {name: 'pixels', type: 'pixelate', params: {pixelSize: 6}, inputs: {source: 'ldr'}, outputs: {target: 'screen'}},
  ],
};
const tasks = {pixelate: effectTask(Pixelate)};
RenderGraph.validate(description, {tasks}); // throws with a code, builds nothing
const graph = RenderGraph.attach(engine, description, {tasks});
console.log(graph.order, graph.textureCount); // ['scene', 'tonemap', 'pixels'] 1
const saved = JSON.stringify(graph.toJSON()); // store it, send it, load it again
graph.load(JSON.parse(saved));
engine.render();
graph.dispose();
```

Built-in task types (`renderGraphTasks`):

| Type | Inputs | Outputs | Params |
| --- | --- | --- | --- |
| `scene` | none | `color` (HDR, or display with `hdr: false`), `depth` | `hdr` (default `true`). The main pass draws into the graph's capture; a graph with a scene must write `'screen'`. At most one |
| `clear` | none | `target` (any colour) | `color`: linear `[r, g, b, a]`, default `[0, 0, 0, 1]` |
| `copy` | `source` (any colour) | `target` (any colour) | Bilinear, any size and format, values unchanged |
| `blit` | `source` (any colour) | `target` (display colour, `'screen'` included) | HDR sources get the display transform, as a PostStack's last HDR effect does |

`effectTask(EffectClass)` turns any effect of this package that joins a PostStack (Bloom, SSAO, KawaseBlur, Tonemap,
FXAA, Pixelate, ...) into a task type: `params` are its options, input `source`, output `target`, canvas-sized
textures only. A custom type is `{create(params) {return {inputs, outputs, execute(context, io)}}}`: slot types are
`'hdr'`, `'ldr'`, `'color'` (either) or `'depth'`; `io.input(slot)` and `io.output(slot)` give `{view, format, width,
height, multisample, screen}`.

| Texture field | Default | Meaning |
| --- | --- | --- |
| `format` | from the writing slot | `'rgba16float'` for HDR or any colour, `'rgba8unorm'` for display colour |
| `scale` | `1` | Fraction of the canvas size, (0, 1] |
| `size` | none | Fixed `[width, height]` in texels instead of `scale` |
| `persistent` | `false` | Kept across frames, never shared |
| `history` | `false` | Two textures that swap each frame; read last frame's as `name@previous` (black at first) |

`'screen'` is the canvas, an output only. Without a `scene` task the graph runs after the main pass, over its picture.
A RenderGraph replaces the PostStack: attaching one next to a PostStack throws MargoError `'attached'`. `RenderGraph`
is disposable (`using graph = ...`). Error codes are listed at
[margoengine.com/errors#render-graph](https://margoengine.com/errors#render-graph); limits in
[docs/limits.md](../../docs/limits.md#render-graph-margoenginepostrender-graph-2026-11-26); sources in
[docs/clean-room.md](../../docs/clean-room.md#render-graph-2026-11-26). The visual editor is not built yet.

## Mesh blending: `MeshBlend`

`@margoengine/post/mesh-blend` softens the hard seam where separate meshes meet, such as rocks set into terrain or
props sunk into the ground, in a `PostStack` (an HDR effect: place it before `Tonemap`). Tag the meshes that blend,
each with its own radius in world units; near a seam the colour of the other surface, mirrored across the seam, is
mixed in: half at the seam, none at the radius. Seams between untagged surfaces stay sharp, two tagged meshes that
touch blend with the larger radius, and a tag on a parent covers its child meshes. Depth-slope rejection keeps
silhouettes sharp: across a seam each side's depth is carried to the seam along its own slope, and where they do not
meet (a rock's top against far ground, any edge against the sky) nothing blends, so the effect never smears an
outline.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {MeshBlend} from 'margoengine/post/mesh-blend';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 1, 3], target: [0, 0, 0]}});
engine.createMesh().setGeometry(box(20, 0.1, 20)).setPosition([0, -0.05, 0])
  .setMaterial(new PbrMaterial({color: '#5a7a3a', roughness: 1}));
const rock = engine.createMesh().setGeometry(box(0.8, 0.6, 0.8)).setPosition([0, 0.2, 0])
  .setMaterial(new PbrMaterial({color: '#8a8078', roughness: 0.9}));
const blend = MeshBlend.attach(engine, {maxPixels: 32});
const untag = blend.tag(rock, 0.2); // blend within 0.2 world units of the rock's seams
engine.render();
blend.options.strength = 0.8; // options are read every frame
untag();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `maxPixels` | `32` | Largest reach on screen, whole pixels 1 to 128; a near mesh's radius is cut to this |
| `samples` | `32` | Search samples per pixel, 4 to 64, on a spiral over the reach, then 5 bisection steps to the seam |
| `depthTolerance` | `0.5` | Largest depth miss at the seam that still counts as touching, as a share of the radius; above 0 |
| `strength` | `1` | Share of the blend applied, 0 to 1 |
| `enabled` | `true` | False passes frames through |
| `order` | `20` | Frame graph order of the tag pass, after the main pass (0) and before the stack composes (30) |

`tag(target, radius)` returns a remover; `untag(target)` and `tags` (a copy) manage the set. A target is a core
mesh, a gltf/pbr model (`loadGLTF`), a materials mesh, a `Terrain`, a lit `Scatter` or a `Water`; models and terrain are drawn with their own
materials, so a rock model's alpha-masked edge or a terrain's holes blend where they are drawn:

```ts
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {MeshBlend} from 'margoengine/post/mesh-blend';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0.6, 2.5], target: [0, 0.3, 0]}});
const rock = await loadGLTF(engine, '/models/rock.glb');
rock.root.setPosition([0, 0.4, 0]);
const blend = MeshBlend.attach(engine);
blend.tag(rock, 0.15); // a terrain from @margoengine/terrain is tagged the same way: blend.tag(terrain, 0.1)
engine.render();
```

`meshBlendWeight` and `meshBlendGap` are the
shader's weight and depth-slope test on the CPU, for tuning. `MeshBlend` is disposable (`using blend = ...`), runs on
WebGPU and the WebGL2 layer, and costs a redraw of the core meshes into a tag target each frame. Limits are in
[docs/limits.md](../../docs/limits.md#mesh-blending-margoenginepostmesh-blend-2026-11-26); sources in
[docs/clean-room.md](../../docs/clean-room.md#mesh-blending-2026-11-26).

## Spatial upscaling: `SpatialUpscale`

`@margoengine/post/upscale` (its own entry) renders the scene below the canvas size and rebuilds the full frame from
that one frame, with no history: for phones, integrated GPUs and scenes where a temporal upscaler does not fit (no
motion data, a cut every frame). An edge-adaptive upsample reads the 12 render pixels around each output pixel,
finds the local edge direction and whether the feature is a long edge or a thin line, and filters with a kernel
stretched along the edge, then clamps to the four nearest pixels so the edge stays sharp with no ringing. A
contrast-adaptive sharpen follows, as strong as the local range allows without clipping. Both work on display-encoded
colour (a linear frame is encoded on read and decoded on write). Passes from frame-graph order -75 to 45 (the main
pass, a `PostStack`, TAA, motion blur) run at render size and get cheaper too.

```ts
import {Engine} from 'margoengine/core';
import {Material, createMesh} from 'margoengine/materials';
import {SpatialUpscale} from 'margoengine/post/upscale';
const engine = await Engine.create(document.querySelector('canvas')!);
createMesh(engine, {
  positions: [-1,-1,0, 1,-1,0, 0,1,0],
  normals: [0,0,1, 0,0,1, 0,0,1],
  indices: [0,1,2],
}, new Material({color: '#e0a040'}));
const upscale = SpatialUpscale.attach(engine, {scale: 0.5});
upscale.options.sharpen = 0.5; // options are read every frame, so a resolution scaler can drive `scale`
engine.render();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `scale` | `0.67` | Render size as a share of the canvas on each axis, 0.25 to 1; 0.77, 0.67, 0.59 and 0.5 are the usual quality steps |
| `sharpen` | `0.8` | Sharpening after the upscale, 0 (off) to 1 (the most the local range allows without clipping) |

Feed it anti-aliased input (the engine's MSAA, TAA, or FXAA/SMAA inside a `PostStack`): it reconstructs edges, it does
not remove aliasing. It runs instead of `TAAUpscale`, not with it, upscales one full-canvas view (a frame of several
views or a partial view is drawn at full size), and plugins that draw after order 45 draw over the full frame without
the scene's depth. Values above 1 (an HDR canvas) are upscaled but not sharpened. `SpatialUpscale` is disposable
(`using upscale = ...`). Limits are in
[docs/limits.md](../../docs/limits.md#spatial-upscaler-margoenginepostupscale-2026-11-26); sources in
[docs/clean-room.md](../../docs/clean-room.md#spatial-upscaler-2026-11-26).

## Image filter graphs with no scene: `ImageFilterGraph`

`@margoengine/post/filter-graph` (13,446 B min+gzip, its own entry; nothing else of post comes with it) runs a
graph of image filters on images, video or the camera. It needs no engine or scene: it makes its own WebGPU device (or
takes yours, such as `engine.gpu`), and runs on the WebGL2 compatibility layer once `install()` from
`@margoengine/webgl2-compat` has run. A graph is plain JSON data. Blocks that can share a shader are fused into one
pass, and passes that do not overlap share intermediate textures.

```ts
import {ImageFilterGraph, parseFilterBlock, parseFilterGraph, type FilterGraph} from 'margoengine/post/filter-graph';
const canvas = document.querySelector('canvas')!;
// A custom block is one annotated WGSL file. 'pixel' images arrive as colours, then params, in header order.
const split = parseFilterBlock(`// filter-block {"type":"split","images":{"input":"pixel"},"params":{"at":{"type":"float","default":0.5}}}
fn apply(uv: vec2f, color: vec4f, at: f32) -> vec4f {
  return select(color, color.bgra, uv.x > at);
}
`);
const graph: FilterGraph = {
  inputs: {photo: {type: 'image'}, amount: {type: 'float', default: 1, min: 0, max: 1}},
  nodes: [
    {id: 'grey', type: 'black-and-white', images: {input: 'photo'}, params: {amount: '$amount'}},
    {id: 'blocks', type: 'pixelate', images: {input: 'grey'}, params: {size: 6}},
    {id: 'swap', type: 'split', images: {input: 'blocks'}},
    {id: 'frame', type: 'vignette', images: {input: 'swap'}},
  ],
  output: 'frame',
  blocks: [split], // a saved graph carries its own block types
};
const filter = await ImageFilterGraph.create(graph, {canvas});
console.log(filter.passes.length); // 1: all four blocks run in one pass

// Any image: here one painted in code. A canvas or video is read again every frame.
const picture = new OffscreenCanvas(320, 240);
const paint = picture.getContext('2d')!;
paint.fillStyle = '#d07030';
paint.fillRect(0, 0, 320, 240);
paint.fillStyle = '#3070d0';
paint.fillRect(80, 60, 160, 120);
filter.setImage('photo', picture);
// Or: await filter.load('photo', 'photo.jpg'), a video URL, a Blob, a MediaStream or {camera: true}.
filter.render();

filter.set('amount', 0.25); // live values change with no rebuild
filter.set('blocks.size', 12);
filter.set('swap.enabled', false); // a disabled block passes its first image through
filter.render(); // or filter.start() to draw every animation frame, and filter.stop() to end it

const saved = JSON.stringify(filter.save()); // the graph with the values set above
const again = await ImageFilterGraph.create(parseFilterGraph(saved), {size: [320, 240]});
again.setImage('photo', picture);
again.render();
const {data} = await again.read(); // straight-alpha RGBA8; again.output is the texture
console.log(data.length);
again.dispose();
filter.dispose(); // frees every GPU object and closes a camera it opened
```

### Graphs

`{inputs, nodes, output, blocks?, version?}`. An input is `{type: 'image'}` or a value
(`{type, default, min?, max?}` of type `float`, `int`, `bool`, `vec2`, `vec3`, `vec4` or `color`). A node is
`{id, type, images?, params?, consts?, scale?, enabled?, optimize?}`: `images` names a node or an image input for each
image of the block; a param is a value, `'$input'` (one input may drive many params) or `'$time'` (`render({time})`,
or the seconds since `start()`); `consts` are fixed when the runtime is made; `scale` (above 0 up to 4, default 1)
sizes the block against the output; `enabled` (default true) may be `'$input'`; `optimize` (default true) false keeps
it in its own pass. `set` and `get` take an input's name, or `node.param` and `node.enabled` of a node holding its own
value; `filter.parameters` lists them. Unused blocks cost nothing. A graph has at most 256 blocks.

### Custom and aggregate blocks

A block is data, `{type, images?, params?, consts?, scale?, optimize?, wgsl}`, carried in the graph's `blocks` or
passed in the options (a graph's own type wins, and either replaces a built-in of that name). `wgsl` declares
`fn apply(uv, <a vec4f per 'pixel' image>, <a value per param>) -> vec4f`, with any helpers, `const`s and `struct`s;
names are made unique per node, so a block may be used many times. A `'pixel'` image arrives as the colour at this
pixel; `'texel'` and `'sample'` images are read with `sample_<name>(uv)` and measured with `size_<name>()`:
`'texel'` reads one unfiltered texel a pixel, `'sample'` reads filtered, as many times as the block likes. `filterSize()` is the pass size and `filterOutputSize()` the graph's. Colours are
straight alpha, and values outside 0..1 survive between blocks. A graph is reused as a block with
`{type: 'my-look', graph}`: its image and value inputs become the block's images and params (nesting at most 8 deep).
`parseFilterBlock` reads the one-file form shown above.

### The optimizer

A block is fused into the pass of the block reading it when that is its only reader, both have the same `scale`, the
read is `'pixel'` or `'texel'` (one fused `'texel'` read along any chain of a pass), neither says
`optimize: false`, and the pass still reads no more textures than the
device's `maxSampledTexturesPerShaderStage`. A filtered (`'sample'`) read keeps its producer in a texture, and so
does a block read twice. Fused results are rounded as the texture they stand in for would round them: merged and
unmerged (`optimize: false`) pictures differ by at most 1 of 255 in 8-bit output. `filter.passes` lists the blocks of
every pass, and `planFilterGraph(graph)` gives the same plan, with each pass's WGSL, without a GPU.

### Built-in blocks

| Blocks | Reads | Params (defaults) |
| --- | --- | --- |
| `black-and-white`, `saturation`, `invert`, `sepia` | pixel | `amount` (1) |
| `exposure`, `hue`, `opacity`, `premultiply-alpha` | pixel | `stops` (0); `angle` radians (0); `opacity` (1); none |
| `brightness-contrast`, `levels`, `color-matrix` | pixel | `brightness` (0), `contrast` (1); `inBlack` (0), `inWhite` (1), `gamma` (1), `outBlack` (0), `outWhite` (1); rows `red`, `green`, `blue`, `alpha` (identity) and `offset` (0) |
| `tint`, `vignette`, `noise` | pixel | `color` (`#ffb070`), `amount` (0.5); `amount` (0.5), `radius` (0.75), `softness` (0.45), `color` (black); `amount` (0.08), `seed` (0; bind `'$time'`) |
| `posterize`, `threshold`, `green-screen` | pixel | `steps` (6); `level` (0.5), `softness` (0); `key` (`#00ff00`), `similarity` (0.4), `smoothness` (0.1), `spill` (0.1) |
| `mask` (`input`, `mask`) | pixel | `invert` (false); const `CHANNEL` luminance, alpha or red |
| `composite` (`background`, `foreground`) | pixel | `opacity` (1); const `MODE` over, add, multiply, screen, overlay, difference, darken or lighten |
| `wipe` (`start`, `end`) | pixel | `progress` (0.5), `angle` (0), `softness` (0.02) |
| `solid-color`, `gradient` (no image; give `size` without a canvas) | none | `color` (black); `start` (black), `end` (white), `angle` (0) |
| `pixelate` | texel | `size` in output pixels (8) |
| `kaleidoscope`, `mirror`, `tile` | sample | `segments` (6), `angle` (0), `center` (middle); `position` (0.5), const `AXIS` x or y; `count` ([2, 2]) |
| `transform`, `ripple`, `sprite-sheet` | sample | `offset`, `scale`, `rotation` (identity; transparent outside); `amplitude` (0.01), `frequency` (30), `phase` in cycles (0); `columns` (4), `rows` (4), `frame` (0) |
| `directional-blur`, `blur` | sample | `radius` in output pixels (8); `directional-blur` also `angle` (0) and const `TAPS` low, medium (default) or high; `blur` is a two-direction aggregate at half size |
| `sharpen`, `edges`, `chromatic-aberration` | sample | `amount` (0.5; 1; 3 pixels) |

### Runtime

| Option | Default | Meaning |
| --- | --- | --- |
| `device` | its own | A device to run on. An owned one restores itself after a loss; for yours call `restore(newDevice)` |
| `canvas` | none | Shown here, with premultiplied alpha; without it the picture is `output` |
| `target` | none | Your texture to draw into (`RENDER_ATTACHMENT`; `read` also needs `COPY_SRC`). It belongs to your `device` and is never destroyed here; after a loss call `restore(newDevice, {target: textureOnNewDevice})` |
| `size` | follows | `[width, height]`; else the canvas's or the first image's, each frame (`resize()`). A `target` is drawn at its own size |
| `format` | `'rgba8unorm'` | Format of the runtime's own output texture |
| `optimize` | `true` | False draws one pass a block |
| `blocks` | none | Custom block types |
| `signal` | none | Cancels creation (`load`, `read` and `restore` take one too) |
| `onError` | `reportError` | Receives a failed automatic restore |

`setImage(name, source)` takes an `ImageBitmap`, `ImageData`, `<img>`, `<video>`, canvas, `VideoFrame`, filterable
`GPUTexture` or `null`; `load(name, source)` opens URLs, Blobs, streams and the camera and closes what it opened.
`render()` returns false while a needed image is missing or not ready. A steady frame makes no buffer, texture, bind
group or pipeline. Errors are coded and link to [the error page](https://margoengine.com/errors#filter-graph).
Limits are in [docs/limits.md](../../docs/limits.md#image-filter-graph-margoenginepostfilter-graph-2026-11-26); sources
in [docs/clean-room.md](../../docs/clean-room.md#image-filter-graph-2026-11-26). A visual editor is not included.

## FXAA

`FXAA.attach(stage.engine)` (`@margoengine/post/fxaa`) is FXAA 3.11-style anti-aliasing for
single-sampled output, such as phones and the light quality tier, which have no MSAA. Alone it
captures the finished frame outside every other effect (order −80, presented at 50), so it also
works around a standalone Bloom, SSAO, DOF or Tonemap, and costs one fullscreen pass plus a
canvas-format colour and depth target. In a `PostStack` it runs last, on the display-encoded
result. Luma is taken from display-encoded colour; edges below 0.05 contrast (or 15% of the local
maximum) are left untouched, and from that gate to twice it the blend fades in (smoothstep), so noise whose
contrast crosses the gate moves the output by at most about one 8-bit code instead of jumping. `SMAA` (below) is the sharper alternative; an engine takes one of the two.

Import `Bloom` from `@margoengine/post/bloom` and `SSAO` from
`@margoengine/post/ssao` to load each effect independently in native ESM or a
bundled app. The existing root exports keep the same constructor identities and
remain available for applications that intentionally use the complete pack.

`SceneFade` is also available through `@margoengine/post/scene-fade`, without loading
SSAO or Bloom. It blends the last visible base frame over upgraded effects using a
smooth 180 ms opacity uniform. Attach before rendering the base scene, call
`capture()` immediately after that render, then `await warm()` before attaching
the remaining effects. After their GPU work completes, call `start()`, await
`finished`, and dispose the fade. Pass duration `0` for reduced motion. The fade reads `performance.now` by default; `SceneFade.attach(engine, duration, clock)` takes a milliseconds clock so a film frame fades by simulation time, not by how fast the machine renders (KB-FILM-CLOCK1). The
temporary texture and uniform are released on disposal or device restoration.

`Bloom` is Margo's one bloom (creative `PostProcessing` has none; put Bloom before it in a `PostStack`).
`Bloom.attach(engine, {strength: 0.8, threshold: 1, exposure: 0})` captures linear HDR,
spreads the light above `threshold` through a chain of up to six levels (1/2 to 1/64 of the viewport: 13-tap bilinear
downsamples, the first one Karis-weighted so single bright pixels do not flicker, then tent upsamples added back level
by level) and presents with Margo's display curve (Khronos PBR Neutral, then sRGB: the same as core and Tonemap's default), dithered by up to one step
before 8-bit output so dark gradients do not band. `strength` is the share of that light spread back as glow (the
levels are averaged). Exposure is in stops. `radius` (0 to 1, default 0.5) sets how far the glow spreads: level j
(j = 0 the tightest) is weighted by `k^j` with `k = 4^(2 * radius - 1)`, scaled so the weights sum to the level count
(`bloomWeights(radius, levels)` returns them), so the total glow stays the same; 0.5 is the even chain, 0 keeps about
three quarters of the glow in the tightest level and 1 in the widest. Like the other options it may change per frame
(`bloom.options.radius = 0.2`). `depthTexture` exposes its
viewport-sized scene depth for water. `sceneTexture` exposes the borrowed linear
HDR scene color, with `COPY_SRC` usage for water refraction. Both change on
resize/restoration and remain owned by Bloom. Alone it owns scene capture and cannot share it with
SSAO, Creative PostProcessing or standalone Tonemap; combine them in a `PostStack` (in a stack,
`sceneTexture` is undefined and `depthTexture` is the stack's). Buffers, bind groups and pass
descriptors are retained until resize or device restoration. The curve references are listed in `NOTICE.md`.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {SSAO} from 'margoengine/post/ssao';
const stage = await createStage('#viewport', {backend:'webgpu'});
const model = await loadGLTF(stage.engine, '/FlightHelmet.glb');
const ssao = SSAO.attach(stage.engine, {radius:0.5,bias:0.025,samples:32});
const remove = ssao.add(model);
ssao.enabled = false;
remove();
ssao.dispose();
model.dispose();
stage.dispose();
```

Captures linear HDR color and reversed scene depth, reconstructs view-space normals and linear depth, and overlays material normal maps from registered sources. A deterministic 32-point hemisphere kernel and tiled 4×4 rotation texture feed SSAO. Two separable bilateral passes respect normal and depth discontinuities. Composition attenuates captured ambient lighting, preserving direct lighting and emission, then tone maps once.

Sources implement `draw(context, 'gbuffer' | 'ambient', color, depth)`; this structural interface avoids a dependency on glTF PBR. Core materials work without source registration. Resize, removal and device restoration recreate/release owned textures and buffers.

**Orthographic cameras** (`@margoengine/cameras` or any projection that writes `camera.matrix`): when clip w is constant, samples are projected with the camera's own orthographic terms (scale, off-centre offset, signed near/far, from `shared/projection.js`) instead of a projection rebuilt from `fov`; depth reconstruction already inverts the real matrix. The gbuffer stores the signed view depth, so surfaces behind an orthographic eye (a negative near plane, cameras' default) are occluded like any other; exactly 0 marks "no surface". Perspective output is unchanged.

**Image-based lighting**: the light SSAO occludes is the ambient term it replays. By default that is core's constant `radiance[3]` (glTF PBR: its hemisphere `ambient()`). A plugin that replaces the ambient light names it in the mesh shader as `let margoAmbient=<light>;` and adds `margoAmbient` to the lit color; SSAO then replays the whole lit shader returning `margoAmbient` (`_=` keeps the remaining bindings in the auto layout, so every pass binding is passed; without `margoAmbient` the lighting sits in a dead `if(false)` block, so a plugin binding read anywhere in the lit shader, such as TerrainColors' look uniform, is bound as well), and glTF PBR's ambient replay does the same for its models. `@margoengine/environment`'s `EnvironmentLighting` follows this convention, so with both active SSAO darkens the IBL diffuse and specular; neither package imports the other, and each renders exactly as before without the other. Specular occlusion is approximated by the same AO factor as diffuse (no roughness- or view-dependent cone), which slightly over-darkens glossy reflections in creases. Other ambient light added on top (sky's ambient patch) is not occluded.

**Blended coverage**: strips blended over a surface without owning its depth (`@margoengine/scatter`'s covered grass rings, `@margoengine/vfx` billboards) take their coverage out of the replayed ambient light, so the composite never removes more light than a pixel holds. A covered grass blade writes depth where a hash of its coverage passes, so most of such a pixel's colour is the ground under it. In a frame with covered blades SSAO and GTAO keep the depth and ambient light under the blades before that depth lands (pass `ssao:under`, order 1.51; the blades' depth then draws at 1.52 and is copied at 1.53), and work out the occlusion of a pixel whose depth is a blade's at the ground under it, with the scene's depth, blades included, as the occluders (layered depth: Shade et al., SIGGRAPH 1998; multi-layer screen-space occlusion: Bavoil and Sainz, SIGGRAPH 2009 Talks; Mara et al., HPG 2016). The grass still darkens the ground and leaves no pale outline along its blades (KB-SCATTER-AOFRINGE1). Such a frame costs three 1x depth copies, a second ambient replay (4x when the scene is), a depth pass and a merge pass, and six more targets at the drawing size (about 50 MB at 1920 x 1080, 116 MB with 4x MSAA), made on the first such frame; a frame with no covered grass renders exactly as before.

Alone, the effect owns the output target and cannot run alongside Creative PostProcessing or Bloom; use a `PostStack` to combine them. It requires the standard core lighting shader. Transparent surfaces do not write opaque depth; SSAO is based on the opaque scene. Sampling is bounded to 1-32 points; radius uses scene units.

To accumulate the composed output with the optional TAA package, use `TAA.attach(stage.engine, {depth:()=>ssao.depthTexture})`. `depthTexture` is undefined before the first frame and exposes the current owned depth texture after capture; it changes on resize/restoration. Ambient replay preserves TAA's vertex camera binding and rebuilds when that override is attached or removed.

The `@margoengine/post/scene-fade` subpath also exports
`afterPresented(queue, signal)`, which waits for submitted GPU work and two browser
animation-frame opportunities before resolving. It cancels cleanly when the
signal aborts; it does not establish whether the submitted frame contains the
scene's subject. Call it after the actual subject render.

## Transparent canvas (`TransparentCanvas` from `@margoengine/environment`)

Checked on a real GPU (Intel Arc 140V laptop) by `examples/package-benchmarks/transparent-canvas-gpu.mjs`, which
asserts that empty pixels stay transparent with every effect below and that opaque frames are byte-identical before
and after the alpha changes (it writes frames only, no committed result yet).

- **FXAA** filters alpha with colour (premultiplied), so smoothed silhouettes stay valid.
- **Bloom** keeps the scene's alpha and raises it to the glow's brightest channel, so glow past an
  object shows over the page as a valid premultiplied veil. In a `PostStack` its linear output
  carries the scene alpha, and a Tonemap after it gives glow past an object its brightest channel as alpha.
- **Tonemap** (`@margoengine/tonemap`) carries the scene alpha and applies its curve to the straight colour of
  partly covered pixels, so a silhouette keeps the face colour at its coverage
  (`packages/headless/tests/transparent-gpu.mjs`: within 1.1 of 255, alone and in a stack with FXAA or SMAA).
- **Every effect that writes the canvas from a linear capture** (SSAO, GTAO, SSGI, SSR, Bloom, Afterimage, Accumulate,
  LensFlare, Lens, Anamorphic, Blur and radial blur, HeatHaze, ContactShadows, SSS, MaterialDecals, MotionBlur,
  SelectiveBloom, EffectMask) reads the mark TransparentCanvas sets and, on that canvas only, applies the display
  transform to the straight colour of partly covered pixels: `toDisplay(c / a) * a` (T. Porter and T. Duff,
  "Compositing Digital Images", SIGGRAPH 1984). Encoding the premultiplied colour made a 1 px rim about 36 of 255
  brighter than its alpha allowed (KB-POST-ALPHARIM1). `packages/post/test/alpha-rim-browser.mjs` draws a box with
  each effect alone, DOF in focus and TAA with its options included, on WebGPU and the WebGL2 layer (within 0.7 of 255,
  TAA 0.9, TAA without settling and Bloom 1.4); an opaque canvas keeps its shaders byte for byte
  (`packages/post/test/straight-display.test.js`).
- **PostStack** adds no pass of its own; its last effect writes the canvas.
- **SMAA** blends the stored premultiplied colour (alpha valid) and finds edges in alpha too; **Glitch** takes the
  largest alpha of its three reads; **Afterimage** applies its max to alpha too, so trails fade as a premultiplied
  veil. Checked through the stack's values (`scripts/post-looks-gpu-check.js`), not by the TransparentCanvas script.
- **DOF** (`@margoengine/dof`) gathers alpha with the same taps and weights as colour, so a blurred edge carries its
  coverage; **TAA** (`@margoengine/taa`) accumulates linear premultiplied colour with alpha; **SceneFade** dissolves
  all four premultiplied channels from the captured frame to the new one (the lerp of Porter and Duff 1984). See their
  READMEs. `TAAUpscale` and `TAAUpscaleVelocity` keep alpha as TAA does.

## Sliders for the lens and glow: `@margoengine/post/settings`

Every effect here keeps its options object and reads it each frame into a uniform, so the look changes while the scene runs and nothing is rebuilt. `@margoengine/post/settings` lists those controls as a table for sliders and panels: `POST_SETTINGS` has 69 rows (`name`, `group`, `kind`, `default`, `min`, `max`, `step`, `unit`, `about` and `live`), grouped by effect: `bloom`, `lens` (distortion and dirt), `lensFlare`, `anamorphic`, `motionBlur` (the shutter as an angle in degrees, 180 the film standard), `dof` (focus distance, focal length or film gauge, f-number, bokeh radius), `gtao`, `ssao`, `ssgi`, `ssr`, `contactShadows`, `heatHaze` (the bend's strength, the eddies' turbulence, the air's temperature, the march steps) and `smaa`. `applyPostSettings({bloom, lens, dof, ...}, values)` writes a set of values onto the effects you give (a name left out takes its default, a row set to null removes its option so the effect uses its own), and `POST_LOOKS` names five looks made only of row values: `natural` (the defaults), `cinematic`, `dream`, `documentary` and `nightGlow`. An unknown name throws `TypeError`, a value outside its row's range `RangeError`, and a row moved off its default whose effect you did not pass `TypeError`. Exposure, white balance, the grade, vignette, grain, dither and chromatic aberration are options of `Tonemap`, so they are rows of `@margoengine/tonemap/settings`.

64 rows are `live`: writing all of them every frame for 60 frames creates no pipeline, buffer or texture (`npm run test:settings:browser`, native WebGPU and the WebGL2 layer), and the defaults written draw exactly what each effect draws with no options. Five rows are `live: false` because they make GPU objects: `bloom.radius` (the first move off 0.5 compiles one compute program and makes one buffer, later moves make none), `motionBlur.maxBlur` (the tile size of the velocity search), `ssgi.multiBounce` and `ssr.stochastic` (a history), and `dof.temporal` (read when the DOF attaches).

```ts
import {Engine} from 'margoengine/core';
import {Bloom} from 'margoengine/post/bloom';
import {POST_LOOKS, applyPostSettings} from 'margoengine/post/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const bloom = Bloom.attach(engine);
applyPostSettings({bloom}, {'bloom.strength': 0.5, 'bloom.threshold': 1.2});
// Key a row over a shot: the glow swells over four seconds.
let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  applyPostSettings({bloom}, {...POST_LOOKS.cinematic, 'bloom.strength': 0.5 + 0.25 * Math.min(time, 4)});
});
```

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.
