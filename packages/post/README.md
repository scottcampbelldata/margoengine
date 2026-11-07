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

## Combining effects: `PostStack`

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
  use and kept until resize or device restoration. Steady frames create no GPU objects.

When the stack landed (`5b1fe66`), every effect used alone made exactly the GPU calls it made before the stack existed:
`examples/package-benchmarks/proofs/post-stack.proof.js` checks 12,378 recorded calls across 12 single-effect stories,
`5b1fe66^` against `5b1fe66`. With `--current` it checks the working tree: 13,056 calls against `e2cc4c5` (Bloom, FXAA and
SSAO keep the canvas alpha; the last intentional change to an effect).

## Screen-space reflections: `SSR`

`@margoengine/post/ssr` reflects what is on screen in glossy core meshes (floors, polished CAD metal) and in glTF-pro
models, `@margoengine/materials` meshes, `Terrain` (@margoengine/terrain) and `Water` (@margoengine/water) added with
`ssr.add(model)`. It is an HDR `PostStack` effect;
`SSR.attach(engine, options)` runs it alone in its own one-effect stack (tone mapped like SSAO alone).

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {EnvironmentLighting} from 'margoengine/environment';
import {PostStack} from 'margoengine/post/stack';
import {SSAO} from 'margoengine/post/ssao';
import {SSR} from 'margoengine/post/ssr';
import {Bloom} from 'margoengine/post/bloom';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const ibl = await EnvironmentLighting.load(stage.engine, '/studio.hdr');
const ssr = new SSR({maxRoughness: 0.6, thickness: 0.5, maxDistance: 100, steps: 64});
const stack = PostStack.attach(stage.engine, [new SSAO(), ssr, new Bloom({strength: 0.6})]);
const helmet = await loadGLTF(stage.engine, '/FlightHelmet.glb'); // from 'margoengine/gltf-pro'
ibl.add(helmet);                     // EnvironmentLighting, so SSR replaces its specular (below)
const stop = ssr.add(helmet);        // glTF-pro model or materials mesh: its own surfaces reflect; stop() undoes it
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
- **Model capture.** Models added with `ssr.add(model)` (a gltf-pro `PBRModel` or a materials mesh; returns a remover,
  disposal of the model or of SSR detaches it) then draw into the same three targets in one more pass, through
  gltf-pro's declared capture hook (gltf-pro README "Capture hook"; no text search of its shader): their own base
  colour, metal/roughness, normal and occlusion maps, materials' maps, alpha mask, instances and skinned/morphed
  vertices, depth tested against and written into SSR's own 1x depth, which the Hi-Z is built from (with models added
  SSR keeps its own depth at 1x MSAA too, so a capture never writes the stack's depth, which water samples). BLEND, transmission and
  unlit primitives are skipped. Models not added are still reflected but do not reflect. With no model added SSR makes
  exactly the GPU calls it made before (`examples/package-benchmarks/proofs/post-ssr-models.proof.js`, against
  `3cf1453`). Models not added are missing from SSR's own depth, so rays pass through them. `Terrain` and `Water`
  take the same hook: shaders without gltf-pro's PBR `Surface` get only `margoSSR` and the `MargoSSR` targets (the
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
  comes from a half-resolution mip chain of the scene, at a level that grows with roughness² and hit distance.
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
- **Temporal.** Deterministic (no noise), so frames are stable without TAA; with TAA wrapping the stack the jittered
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
- **Limits.** Core meshes and added models (gltf-pro, materials, terrain, water) show reflections; other custom shaders
  are reflected but do not reflect (each would need its own capture into SSR's targets). Only what is on screen is
  reflected; with reflection probes (`@margoengine/environment/probes`) SSR removes the probes' own specular
  where its ray hits and keeps the probe's reflection elsewhere, so off-screen reflections come from the probes
  ([probes-gpu.json](../../examples/package-benchmarks/results/probes-gpu.json)). A clearcoat's own (hemisphere) reflection is not replaced; fog is not applied to the replaced
  term (core meshes alike). Materials `basic`/`normal`/`matcap` meshes reflect by their roughness like `standard` ones. With SSAO before it, a creased pixel's IBL specular was already darkened by AO, so a hit
  removes slightly more than was left (clamped at zero). Specular from other ambient plugins (sky's ambient patch) is
  not replaced.

## Ground-truth ambient occlusion: `GTAO`

`@margoengine/post/gtao` (10,531 B min+gzip, its own entry; it carries SSAO and the stack) is GTAO, written from
Jimenez, Wu, Pesce and Jarabo 2016 ("Practical Real-Time Strategies for Accurate Indirect Occlusion"). It is an HDR
`PostStack` effect; `GTAO.attach(engine, options)` runs it alone in its own one-effect stack (tone mapped like SSAO alone).

```ts
import {PostStack} from 'margoengine/post/stack';
import {GTAO} from 'margoengine/post/gtao';
import {SSR} from 'margoengine/post/ssr';
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/scene.glb');
const gtao = new GTAO({radius: 0.5, slices: 2, steps: 6});
PostStack.attach(stage.engine, [gtao, new SSR()]); // or GTAO.attach(stage.engine)
gtao.add(model);                // gltf-pro model: its normal maps feed the horizon search, as with SSAO
gtao.options.slices = 1;        // options and `enabled` are read every frame
```

- **Method.** Per pixel, `slices` planes through the view vector, each along a screen direction. On each side of the
  pixel `steps` depth samples within `radius` give the horizon (the highest sample, as an angle from the view vector),
  clamped to the hemisphere around the normal projected into the slice. The paper's closed form (its eq. 10) gives the
  cosine-weighted visibility of the open arc, weighted by the projected normal's length; the slices average to the
  visible share of the cosine-weighted hemisphere. Occluders fade out between 60% and 100% of `radius`. The 4x4 pixel
  tile rotates the slices and offsets the steps (both 4x4 Bayer orders), and SSAO's bilateral blur averages the tile.
- **Shared with SSAO.** The normal G-buffer (with `gtao.add(source)` material normals), the blur, the ambient replay and
  the composite are SSAO's, so GTAO darkens exactly the ambient and image-based light (`margoAmbient`), not direct light
  or emission, under perspective and orthographic cameras. GTAO is a subclass of `SSAO`; with no GTAO, SSAO makes the
  same GPU calls as before (`examples/package-benchmarks/proofs/post-stack.proof.js`, `--current`).
- **Checked on a real GPU** against closed forms (NVIDIA RTX A6000, Edge 155; `examples/package-benchmarks/post-effects-gpu.mjs
  --only=gtao`, [gtao-gpu.json](../../examples/package-benchmarks/results/gtao-gpu.json)): ambient light only, the
  frame with GTAO over the frame with it disabled. A point on a floor where a plane through it closes the hemisphere to
  a wedge of angle b keeps `(1 - cos b) / 2` of its ambient light. Next to the crease GTAO measures 0.525, 0.267 and
  0.783 for 90, 60 and 120 degree wedges (closed form 0.5, 0.25, 0.75; the blur mixes in floor up to a few cm out),
  rising to 0.85-0.96 at 0.64 m with `radius: 2`; the open floor measures 0.995-1.009. The same at 1x MSAA and with
  an orthographic camera (0.533, 0.270, 0.779). Alone, the open floor is unchanged (0/255) and the crease darker; in
  a stack with SSR and Bloom and under TAA, no errors and no NaN.
- **Limits.** Screen-space: occluders off screen or hidden behind nearer surfaces do not occlude, and thin objects
  occlude as if infinitely thick (no thickness heuristic). No multi-bounce colour approximation, no bent normals and no
  specular occlusion cone: the IBL specular is darkened by the same factor as the diffuse, as with SSAO. Up to 4 slices
  and 16 steps per side; options `radius` (0, 100], `slices` 1-4, `steps` 1-16 (`RangeError` otherwise). It runs only in
  a `PostStack` (`MargoError` code `state` when attached alone with `engine.use`). GPU cost not measured yet. WebGPU only.

## Screen-space global illumination: `SSGI`

`@margoengine/post/ssgi` (9,801 B min+gzip, its own entry; it carries the stack) adds one bounce of diffuse light: light
that lit surfaces on screen throw onto their neighbours (a red wall tints the floor in front of it). It is an HDR
`PostStack` effect; `SSGI.attach(engine, options)` runs it alone in its own one-effect stack.

```ts
import {PostStack} from 'margoengine/post/stack';
import {SSGI} from 'margoengine/post/ssgi';
import {SSR} from 'margoengine/post/ssr';
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const model = await loadGLTF(stage.engine, '/scene.glb');
const ssgi = new SSGI({rays: 4, maxDistance: 10, thickness: 0.5, steps: 32, intensity: 1});
const ssr = new SSR();
PostStack.attach(stage.engine, [ssgi, ssr]);
ssgi.add(model); ssr.add(model);  // gltf-pro model or materials mesh: both may capture it (one shared capture hook)
```

- **Material replay.** At order 15 (after SSAO's and SSR's replays) core meshes are redrawn once at 1x with core's own
  shader into three targets: the ambient light the scene added at the pixel (`rgba16float`; SSAO's ambient replay:
  `margoAmbient` when a plugin such as `EnvironmentLighting` names it, else core's ambient term), the diffuse albedo
  `base·(1−metal)` (`rgba8unorm`) and the normal (`rgb10a2unorm`). At 4x MSAA the replay writes its own 1x depth, as
  SSR's does. Models added with `ssgi.add(model)` draw into the same targets through gltf-pro's capture hook (their
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
  against 0.111 at 2 m) and red stays 1.000; the same at 1x MSAA, for a gltf-pro floor added to SSGI and SSR (red
  0.990: gltf-pro's ambient also holds a specular term, removed and not re-added), and with an orthographic camera
  (within 0.021). With GTAO, SSR and TAA in the same frame and alone: no errors, no NaN.
- **Limits.** Only what is on screen bounces: light from off-screen or hidden surfaces is missing, and rays that leave
  the screen keep the ambient light. One diffuse bounce (no specular, no second bounce); the bounce light is the
  scene as lit before SSGI (emission included), so it does not see its own result. Water, terrain and other custom
  shaders bounce light but take none (no albedo in the replay). Options: `rays` 1-16, `steps` 1-256, `maxDistance` and
  `thickness` > 0, `intensity` 0-4 (`RangeError` otherwise); stack only (`MargoError` code `state` alone with
  `engine.use`). Memory: three material targets, two `rgba16float` GI targets, a half-resolution Hi-Z and blur chain,
  and its own 1x depth at 4x. GPU cost not measured yet. WebGPU only.

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

`@margoengine/post/lens-flare` (5,776 B min+gzip, its own entry; it carries the stack) adds a lens flare for the sun:
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

- **The sun.** `sun()` gives the direction toward it (default `engine.lighting.direction`); its w, when given, scales
  the flare and 0 or less hides it. The sun's screen point is found the way creative's god rays find it: a point far
  along that direction (half the far distance) through the camera's own matrix, so perspective and orthographic alike;
  behind the camera or outside the depth range there is no flare.
- **Occlusion.** A compute pass tests an 8 x 8 grid of depth samples over a disc of `occlusionRadius` pixels around the
  sun against the stack's depth (`host.depthTexture`): a sample sees the sun where nothing nearer than the sun's point
  is drawn. The flare is scaled by the share that does, so a sun behind geometry disappears, one at an edge dims, and
  one leaving the screen fades out. The share stays on the GPU (no readback).
- **Checked on a real GPU** (NVIDIA RTX A6000, Edge 155; `post-effects-gpu.mjs --only=flare`,
  [flare-gpu.json](../../examples/package-benchmarks/results/flare-gpu.json)), the frame with the flare minus without,
  linear: the brightest pixel is the sun's projected pixel (within one pixel); the flare is mirror-symmetric about the
  line from the sun through the centre (weighted mean offset 0.3 px) with each ghost on it; a box over the sun leaves
  the frame unchanged (0); a box whose edge splits the disc leaves 0.4998 of the flare where 26 of the 52 depth
  samples see past it (0.5); behind the camera and at strength 0, nothing; orthographic, the peak at the projected
  pixel; in a stack with SSR and Bloom and alone, no errors.
- **Limits.** One light (the sun), a fixed ghost set (positions, sizes and tints are not options), no starburst or
  aperture-shaped ghosts, no flare from point or spot lights. A transparent surface in front of the sun that writes no
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
SMAA.attach(stage.engine, {quality: 'high'});   // alone: wraps the finished frame, like FXAA
// or in a stack, after the display effect and before Glitch:
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
(true). It sees only what is on screen, and it darkens ambient light too in the pixels it hits.

```ts
import {Engine} from 'margoengine/core';
import {ContactShadows} from 'margoengine/post/contact-shadows';
declare const canvas: HTMLCanvasElement;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
ContactShadows.attach(engine, {distance: 0.3});
```

## Multiple render targets: `SceneTargets`

`@margoengine/post/mrt` draws the scene's surfaces into several named textures in one pass. Each output is a built-in
value (`albedo`, `normal` (world), `position` (world), `distance` (from the camera), `emissive`, `material`
(roughness, metalness, occlusion)) or your WGSL `vec4f` expression over `t: TargetSurface` (the same values, all world
space), with its own float or normalised colour format. Core meshes always draw (a replay of core's shader with the
lighting left out); add gltf-pro models and materials meshes with `targets.add(model)` so their own maps, skinning and
instances write the outputs. The pass runs before the main pass by default (`order: -5`), so materials can read this
frame's targets; a material that reads a target must not be added. Its own depth is `targets.depth`. Textures follow
the drawing size and are replaced on resize (`onResize`). WebGPU only.

```ts
import { Engine } from 'margoengine/core';
import { SceneTargets } from 'margoengine/post/mrt';
declare const canvas: HTMLCanvasElement;
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

## Depth texture: `DepthTexture`

`@margoengine/post/depth` keeps the scene's depth in textures of its own, so any pass or material can sample it without
borrowing one from an effect: `depth.texture` (depth32float, reversed Z, bind as `texture_depth_2d`) and
`depth.distance` (r32float world distance from the camera, 0 where empty; read with `textureLoad`). It runs before the
main pass, so a material reads this frame's depth: soft particles, shorelines, fog volumes. Core meshes always draw
into it; add gltf-pro models and materials meshes with `depth.add(model)`, but not one whose material reads the depth.

```ts
import { Engine } from 'margoengine/core';
import { Texture, WgslMaterial } from 'margoengine/materials';
import { DepthTexture } from 'margoengine/post/depth';
declare const canvas: HTMLCanvasElement;
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

`@margoengine/post/decals` (4,118 B min+gzip, its own entry) projects textured boxes onto whatever is already drawn,
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
decals.setDecals([
  {position: [0, 0, 1], direction: [0, -1, 0], width: 1, height: 0.5, rect: [0, 0, 0.5, 0.5]},        // grime, multiply
  {position: [2, 1, -1], direction: [0, 0, -1], width: 0.6, height: 0.3, mode: 'over', color: [4, 3, 2]}, // glowing sign
]);
```

- **Projection.** `direction` points into the surface; the footprint is `width` x `height` around `position` (right =
  direction x `up`), the box reaches `depth` (default the smaller side) along `direction`, and the last 10% at both ends
  fades. `rect` is the atlas region (u0, v0, u1, v1; v down).
- **Normal-angle fade.** The surface normal comes from the depth buffer (per axis, the neighbour on the same surface, so
  silhouettes do not smear); a surface turned more than `angle` (default 60 degrees) from facing the projector gets
  nothing, with a fade over the last third, so a decal on a box top does not stretch down its sides.
- **Blending.** `'multiply'` (default) scales the lit pixel by `color x texel` mixed by alpha: lighting, shadows and
  reflections stay (grime, cracks, paint on a light surface); it cannot brighten. `'over'` blends `color x texel` as
  unlit radiance (signs, glows; `color` may exceed 1). Multiply decals draw first, then over decals, each in list order.
- **Where it runs.** Order 1.9: after opaque core meshes (0), gltf-pro and materials models (1) and LOD (1.5); before the
  sky (2), water (4), volumetric fog (5) and particles, so everything that writes depth before it can carry decals and
  the effects after it draw over them. Back faces of the boxes only, no depth test: each covered pixel runs once, also
  with the camera inside a box. One render pass, one instanced draw per mode (36 vertices per decal), one storage buffer
  of 96 B per decal; it adds nothing to any mesh shader. With no decals the pass records nothing.
- **Validation.** `setDecals` checks the whole list (no holes, every field valid, values finite as Float32) before
  replacing anything, so a bad list throws and leaves the current decals drawing. `setDecals([])` clears them.
- **Checks** (Intel Arc 140V, Edge 155, AC, GPU lock; `node examples/package-benchmarks/decals-gpu.mjs`,
  [decals-gpu.json](../../examples/package-benchmarks/results/decals-gpu.json)), each at 4x and 1x MSAA, every 8th
  pixel ray-cast on the CPU: outside every decal box (3 cm margin) the frame equals the decal-free frame exactly; a
  multiply decal scales the floor's radiance by its colour (channel ratios within 0.04, through the inverse of Tonemap
  'neutral'); over a cube's top edge the top face is marked and the 90-degree side faces are untouched (0/255), and the
  floor below the box's depth range stays untouched; an `over` decal on the atlas's red quadrant shows exactly
  tonemap(0.6, 0, 0); a box containing the camera still draws; an empty Decals equals none.
- **Cost** (diagnostic: the quiet gate passed at 6% CPU, but other jobs were running): GPU time of the whole frame, 4x MSAA, 1 m
  decals on the floor in front of the camera: 1280 x 720 1.64 ms without, 1.64 / 1.97 / 6.36 ms with 1 / 16 / 256
  decals (256 overlap about four deep); 1920 x 1080 3.67 ms -> 3.93 / 4.33 / 14.03 ms. The first decal's cost is mostly
  its own pass over the multisampled target; each covered pixel then reads five depth values (position and normal) and
  one atlas texel.

Limits: needs a post capture's scene depth (throws `Decals need scene depth: attach a post capture (Tonemap, Bloom,
PostStack, SSAO, TAA) first`); at 4x MSAA it reads depth sample 0 and writes every covered sample, so decal edges along
geometry silhouettes are per pixel, not per sample; gltf-pro BLEND primitives (drawn before it, without depth) get no
decal of their own and are tinted with the decal of the surface behind them; no normal or roughness decals (it changes colour
only); `multiply` cannot lighten; up to 4,096 decals per `setDecals`, every one drawn every frame (no culling). WebGPU only.

## FXAA

`FXAA.attach(stage.engine)` (`@margoengine/post/fxaa`) is FXAA 3.11-style anti-aliasing for
single-sampled output, such as phones and the light quality tier, which have no MSAA. Alone it
captures the finished frame outside every other effect (order −80, presented at 50), so it also
works around a standalone Bloom, SSAO, DOF or Tonemap, and costs one fullscreen pass plus a
canvas-format colour and depth target. In a `PostStack` it runs last, on the display-encoded
result. Luma is taken from display-encoded colour; edges below 1/32 contrast (or 1/8 of the local
maximum) are left untouched. `SMAA` (below) is the sharper alternative; an engine takes one of the two.

Import `Bloom` from `@margoengine/post/bloom` and `SSAO` from
`@margoengine/post/ssao` to load each effect independently in native ESM or a
bundled app. The existing root exports keep the same constructor identities and
remain available for applications that intentionally use the complete pack.

`SceneFade` is also available through `@margoengine/post/scene-fade`, without loading
SSAO or Bloom. It blends the last visible base frame over upgraded effects using a
smooth 180 ms opacity uniform. Attach before rendering the base scene, call
`capture()` immediately after that render, then `await warm()` before attaching
the remaining effects. After their GPU work completes, call `start()`, await
`finished`, and dispose the fade. Pass duration `0` for reduced motion. The
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
import {loadGLTF} from 'margoengine/gltf-pro';
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

Sources implement `draw(context, 'gbuffer' | 'ambient', color, depth)`; this structural interface avoids a dependency on glTF Pro. Core materials work without source registration. Resize, removal and device restoration recreate/release owned textures and buffers.

**Orthographic cameras** (`@margoengine/cameras` or any projection that writes `camera.matrix`): when clip w is constant, samples are projected with the camera's own orthographic terms (scale, off-centre offset, signed near/far, from `shared/projection.js`) instead of a projection rebuilt from `fov`; depth reconstruction already inverts the real matrix. The gbuffer stores the signed view depth, so surfaces behind an orthographic eye (a negative near plane, cameras' default) are occluded like any other; exactly 0 marks "no surface". Perspective output is unchanged.

**Image-based lighting**: the light SSAO occludes is the ambient term it replays. By default that is core's constant `radiance[3]` (glTF-pro: its hemisphere `ambient()`). A plugin that replaces the ambient light names it in the mesh shader as `let margoAmbient=<light>;` and adds `margoAmbient` to the lit color; SSAO then replays the whole lit shader returning `margoAmbient` (`_=` keeps the remaining bindings in the auto layout, so every pass binding is passed), and glTF-pro's ambient replay does the same for its models. `@margoengine/environment`'s `EnvironmentLighting` follows this convention, so with both active SSAO darkens the IBL diffuse and specular; neither package imports the other, and each renders exactly as before without the other. Specular occlusion is approximated by the same AO factor as diffuse (no roughness- or view-dependent cone), which slightly over-darkens glossy reflections in creases. Other ambient light added on top (sky's ambient patch) is not occluded.

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
  carries the scene alpha.
- **SSAO** and **Tonemap** (`@margoengine/tonemap`) carry the scene alpha, but tone-map the
  premultiplied colour of partly covered silhouette pixels, so a 1 px rim can be up to ~45/255
  brighter than its alpha allows (shows as a faint light edge on dark pages).
- **PostStack** adds no pass of its own; its last effect writes the canvas.
- **SMAA** blends the stored premultiplied colour (alpha valid) and finds edges in alpha too; **Glitch** takes the
  largest alpha of its three reads; **Afterimage** applies its max to alpha too, so trails fade as a premultiplied
  veil. Checked through the stack's values (`scripts/post-looks-gpu-check.js`), not by the TransparentCanvas script.
- **DOF** (`@margoengine/dof`) keeps the sharp alpha: out-of-focus silhouettes spill colour onto
  transparent pixels. **TAA** (`@margoengine/taa`) writes opaque alpha. **SceneFade** darkens empty
  pixels while it fades. Use these on opaque canvases.
