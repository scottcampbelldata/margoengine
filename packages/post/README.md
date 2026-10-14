# Margo Engine Post

Optional WebGPU frame-graph SSAO, bloom, FXAA and an effect stack, separate from the frozen core and stage.

## Combining effects: `PostStack`

Each effect alone owns its own scene capture, so alone they reject each other. `PostStack`
(`@margoengine/post/stack`) captures the scene once in linear HDR and runs its effects on that
capture in array order, like three.js's EffectComposer:

```ts
import {PostStack} from '@margoengine/post/stack';
import {SSAO} from '@margoengine/post/ssao';
import {Bloom} from '@margoengine/post/bloom';
import {FXAA} from '@margoengine/post/fxaa';
import {DOF} from '@margoengine/dof';
import {Tonemap} from '@margoengine/tonemap';
const stack = PostStack.attach(stage.engine, [new SSAO(), new DOF({focalDistance: 6}), new Bloom({strength: 0.6}), new Tonemap({curve: 'agx'}), new FXAA()]);
// TAA wraps the stack: TAA.attach(stage.engine, {depth: () => stack.depthTexture});
stack.dispose(); // also disposes its effects
```

- Order is HDR effects (`SSAO`, `DOF`, `Bloom`), then at most one display effect (`Tonemap` or
  creative `PostProcessing`), then LDR effects (`FXAA`). Anything else throws. Put SSAO first: it
  darkens the captured ambient light.
- HDR effects hand linear light to the next effect. Without a display effect, the last HDR effect
  tonemaps exactly as it does alone (Bloom AgX, SSAO and DOF Reinhard).
- The stack attaches its effects; keep references to change their options. Effects given to a stack
  belong to it and cannot also be attached alone. Disposing one effect drops it from the chain.
- Standalone Bloom, SSAO, DOF, Tonemap or PostProcessing on the same engine are refused.
  `stack.depthTexture` (and each member's `depthTexture`) is the shared resolved depth. A stack with
  only LDR effects keeps the core shader's own display mapping.
- Intermediate targets are two `rgba16float` and up to two canvas-format textures, created on first
  use and kept until resize or device restoration. Steady frames create no GPU objects.

Used alone, every effect makes exactly the GPU calls it made before the stack existed
(`examples/package-benchmarks/proofs/post-stack.proof.js`).

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

`Bloom.attach(engine, {strength: 0.8, threshold: 1, exposure: 0})` captures linear HDR,
filters bright pixels at half resolution and presents with the analytic AgX transform
shared with `@margoengine/tonemap`. Exposure is in stops. `depthTexture` exposes its
viewport-sized scene depth for water. `sceneTexture` exposes the borrowed linear
HDR scene color, with `COPY_SRC` usage for water refraction. Both change on
resize/restoration and remain owned by Bloom. Alone it owns scene capture and cannot share it with
SSAO, Creative PostProcessing or standalone Tonemap; combine them in a `PostStack` (in a stack,
`sceneTexture` is undefined and `depthTexture` is the stack's). Buffers, bind groups and pass
descriptors are retained until resize or device restoration. The AgX approximation
and MIT attribution are described in `NOTICE.md`.

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from '@margoengine/gltf-pro';
import {SSAO} from '@margoengine/post/ssao';
const stage = await createStage('#viewport', {backend:'webgpu'});
const model = await loadGLTF(stage.engine, '/DamagedHelmet.glb');
const ssao = SSAO.attach(stage.engine, {radius:0.5,bias:0.025,samples:32});
const remove = ssao.add(model);
ssao.enabled = false;
remove();
ssao.destroy();
model.destroy();
stage.dispose();
```

Captures linear HDR color and reversed scene depth, reconstructs view-space normals and linear depth, and overlays material normal maps from registered sources. A deterministic 32-point hemisphere kernel and tiled 4×4 rotation texture feed SSAO. Two separable bilateral passes respect normal and depth discontinuities. Composition attenuates captured ambient lighting, preserving direct lighting and emission, then tone maps once.

Sources implement `draw(context, 'gbuffer' | 'ambient', color, depth)`; this structural interface avoids a dependency on glTF Pro. Core materials work without source registration. Resize, removal and device restoration recreate/release owned textures and buffers.

Alone, the effect owns the output target and cannot run alongside Creative PostProcessing or Bloom; use a `PostStack` to combine them. It requires the standard core lighting shader. Transparent surfaces do not write opaque depth; SSAO is based on the opaque scene. Sampling is bounded to 1–32 points; radius uses scene units.

To accumulate the composed output with the optional TAA package, use `TAA.attach(stage.engine, {depth:()=>ssao.depthTexture})`. `depthTexture` is undefined before the first frame and exposes the current owned depth texture after capture; it changes on resize/restoration. Ambient replay preserves TAA's vertex camera binding and rebuilds when that override is attached or removed.

The `@margoengine/post/scene-fade` subpath also exports
`afterPresented(queue, signal)`, which waits for submitted GPU work and two browser
animation-frame opportunities before resolving. It cancels cleanly when the
signal aborts; it does not establish whether the submitted frame contains the
scene's subject. Call it after the actual subject render.
