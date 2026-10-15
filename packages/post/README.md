# Margo Engine Post

Optional WebGPU frame-graph SSAO, bloom, FXAA and an effect stack, separate from the frozen core and stage.

## Combining effects: `PostStack`

Each effect alone owns its own scene capture, so alone they reject each other. `PostStack`
(`@margoengine/post/stack`) captures the scene once in linear HDR and runs its effects on that
capture in array order, like three.js's EffectComposer:

```ts
import {createStage} from 'margoengine';
import {PostStack} from '@margoengine/post/stack';
import {SSAO} from '@margoengine/post/ssao';
import {Bloom} from '@margoengine/post/bloom';
import {FXAA} from '@margoengine/post/fxaa';
import {DOF} from '@margoengine/dof';
import {Tonemap} from '@margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const stack = PostStack.attach(stage.engine, [new SSAO(), new DOF({focalDistance: 6}), new Bloom({strength: 0.6}), new Tonemap({curve: 'agx'}), new FXAA()]);
// TAA wraps the stack: TAA.attach(stage.engine, {depth: () => stack.depthTexture});
stack.dispose(); // also disposes its effects
```

- Order is HDR effects (`SSAO`, `SSR`, `DOF`, `Bloom`), then at most one display effect (`Tonemap` or
  creative `PostProcessing`), then LDR effects (`FXAA`). Anything else throws. Put SSAO first: it
  darkens the captured ambient light. Put SSR before DOF and Bloom so reflections are blurred and glow too.
- HDR effects hand linear light to the next effect. Without a display effect, the last HDR effect
  tonemaps exactly as it does alone (Bloom AgX, SSAO and DOF Reinhard).
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
models and `@margoengine/materials` meshes added with `ssr.add(model)`. It is an HDR `PostStack` effect;
`SSR.attach(engine, options)` runs it alone in its own one-effect stack (tone mapped like SSAO alone).

```ts
import {PostStack} from '@margoengine/post/stack';
import {SSAO} from '@margoengine/post/ssao';
import {SSR} from '@margoengine/post/ssr';
import {Bloom} from '@margoengine/post/bloom';
const ssr = new SSR({maxRoughness: 0.6, thickness: 0.5, maxDistance: 100, steps: 64});
const stack = PostStack.attach(stage.engine, [new SSAO(), ssr, new Bloom({strength: 0.6})]);
const helmet = await loadGLTF(stage.engine, '/FlightHelmet.glb'); // from '@margoengine/gltf-pro'
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
  built from that depth. Memory: 16 B/pixel of targets (+4 B depth at 4x), a half-resolution `r32float` Hi-Z and a
  half-resolution `rgba16float` blur chain, about 45 MB at 1080p.
- **Model capture.** Models added with `ssr.add(model)` (a gltf-pro `PBRModel` or a materials mesh; returns a remover,
  disposal of the model or of SSR detaches it) then draw into the same three targets in one more pass, through
  gltf-pro's declared capture hook (gltf-pro README "Capture hook"; no text search of its shader): their own base
  colour, metal/roughness, normal and occlusion maps, materials' maps, alpha mask, instances and skinned/morphed
  vertices, depth tested against (and at 4x written into) the depth the Hi-Z is built from. BLEND, transmission and
  unlit primitives are skipped. Models not added are still reflected but do not reflect. With no model added SSR makes
  exactly the GPU calls it made before (`examples/package-benchmarks/proofs/post-ssr-models.proof.js`, against
  `3cf1453`). At 4x, models not added are missing from SSR's own depth, so rays pass through them. With models
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
- **Limits.** Core meshes and added models show reflections; water, terrain and other custom shaders are reflected but
  do not reflect (each draws with its own pipeline and would need its own capture into SSR's targets). Only what is
  on screen is reflected; with reflection probes (`@margoengine/environment/probes`) SSR removes the probes' own specular
  where its ray hits and keeps the probe's reflection elsewhere, so off-screen reflections come from the probes
  ([probes-gpu.json](../../examples/package-benchmarks/results/probes-gpu.json)). A clearcoat's own (hemisphere) reflection is not replaced; fog is not applied to the replaced
  term (core meshes alike). Materials `basic`/`normal`/`matcap` meshes reflect by their roughness like `standard` ones. With SSAO before it, a creased pixel's IBL specular was already darkened by AO, so a hit
  removes slightly more than was left (clamped at zero). Specular from other ambient plugins (sky's ambient patch) is
  not replaced.

## Projected decals: `Decals`

`@margoengine/post/decals` (4,118 B min+gzip, its own entry) projects textured boxes onto whatever is already drawn,
the screen-space way: each decal is a box projector; its pass reconstructs every covered pixel's world position from
scene depth, keeps the pixels inside the box, fades by the angle between the surface and the projection and samples one
texture atlas.

```ts
import {Tonemap} from '@margoengine/tonemap';
import {Decals} from '@margoengine/post/decals';
Tonemap.attach(engine);                               // any post capture provides the scene depth
const decals = Decals.attach(engine, {atlas});        // atlas: a sampled 2D GPUTexture (default: one white texel)
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
- **Checks** (Intel Arc 140V, Edge 155, AC, GPU lock; `node examples/package-benchmarks/decals-gpu.mjs`,
  [decals-gpu.json](../../examples/package-benchmarks/results/decals-gpu.json)), each at 4x and 1x MSAA, every 8th
  pixel ray-cast on the CPU: outside every decal box (3 cm margin) the frame equals the decal-free frame exactly; a
  multiply decal scales the floor's radiance by its colour (channel ratios within 0.04, through the inverse of Tonemap
  'neutral'); over a cube's top edge the top face is marked and the 90-degree side faces are untouched (0/255), and the
  floor below the box's depth range stays untouched; an `over` decal on the atlas's red quadrant shows exactly
  tonemap(0.6, 0, 0); a box containing the camera still draws; an empty Decals equals none.
- **Cost** (diagnostic: the quiet gate passed at 6% CPU, but other agents' sessions were open): GPU time of the whole frame, 4x MSAA, 1 m
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
maximum) are left untouched. SMAA is not provided.

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
filters bright pixels at half resolution and presents with the analytic AgX transform
shared with `@margoengine/tonemap`. Exposure is in stops. `depthTexture` exposes its
viewport-sized scene depth for water. `sceneTexture` exposes the borrowed linear
HDR scene color, with `COPY_SRC` usage for water refraction. Both change on
resize/restoration and remain owned by Bloom. Alone it owns scene capture and cannot share it with
SSAO, Creative PostProcessing or standalone Tonemap; combine them in a `PostStack` (in a stack,
`sceneTexture` is undefined and `depthTexture` is the stack's). Buffers, bind groups and pass
descriptors are retained until resize or device restoration. The AgX approximation
and its primary sources are listed in `NOTICE.md`.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
import {SSAO} from '@margoengine/post/ssao';
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

Alone, the effect owns the output target and cannot run alongside Creative PostProcessing or Bloom; use a `PostStack` to combine them. It requires the standard core lighting shader. Transparent surfaces do not write opaque depth; SSAO is based on the opaque scene. Sampling is bounded to 1–32 points; radius uses scene units.

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
- **DOF** (`@margoengine/dof`) keeps the sharp alpha: out-of-focus silhouettes spill colour onto
  transparent pixels. **TAA** (`@margoengine/taa`) writes opaque alpha. **SceneFade** darkens empty
  pixels while it fades. Use these on opaque canvases.
