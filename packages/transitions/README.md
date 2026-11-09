# @margoengine/transitions

Import `margoengine/transitions` from the `margoengine` package, or `@margoengine/transitions` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

WebGPU scene-to-scene wipes, seeded pixel-noise dissolves, radial clock wipes and chromatic displacement.

```ts
import {Transitions} from 'margoengine/transitions';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const transitions = Transitions.attach(engine);
engine.render(); // establishes the outgoing image
transitions.start('dissolve', 0.75);
// Change the active scene; subsequent renders advance the transition.
```

start freezes the last rendered color target on the next frame. Durations use seconds, in (0, 60]. progress ends at one and rendering continues normally. Resize preserves progress and samples the outgoing image at its original resolution with clamped nearest sampling. Device restoration cancels a transition because its old device's image is lost. Capture order is -80 and composite order 50; effects drawing after 50 are not part of the transition. WebGL2 attachment throws code `unsupported` with a help link. Dispose removes the effect from its owning scene, including when attached through scene.use(effect); other scenes remain attached. No core or stage code changes are required.

Custom WGSL is an optional entry, `@margoengine/transitions/custom` (also `margoengine/transitions/custom`):

```ts
import { Engine } from 'margoengine/core';
import { createCustomTransition } from 'margoengine/transitions/custom';
const engine = await Engine.create(document.querySelector('canvas')!);
const controller = new AbortController();
const transition = await createCustomTransition(engine, `
fn transition(a:texture_2d<f32>, b:texture_2d<f32>, uv:vec2f, p:f32)->vec4f {
  return mix(sample(a,uv), sample(b,uv), p*p);
}`, { signal: controller.signal });
engine.render();
transition.start('wipe', 0.75);
engine.render({ delta: 0.25 });
transition.dispose();
engine.dispose();
```

Supply the named WGSL function plus optional helper functions, at most 65,536 UTF-16 code units. `sample(image, uv)` is clamped nearest sampling; UV origin is top left. The function receives both images, UV and progress in [0,1]. Exact endpoints bypass it. The returned Transitions uses the supplied function for every kind; kind and displacement do not select built-in effects. Duration defaults to one second. This API validates compilation and its three fixed bindings before attachment; invalid code rejects with code `failed` and a help link. Additional texture, sampler, buffer and bind-group declarations are unsupported. Cancellation defaults to no signal and leaves no attached effect. Compilation itself is browser work and cannot be interrupted. Colors use the capture target's existing transfer function; this entry performs no extra color conversion. Shaders should return finite RGBA values. Device restoration recompiles the validated source and cancels missing history. Dispose the returned transition when finished.

GPU proof uses generated solid-color stand-ins and exact per-pixel value assertions, not a claim of artistic quality or measured speed. Run `npm run test:gpu --workspace @margoengine/transitions` through the shared GPU lock.

Texture mask wipes use `@margoengine/transitions/mask` (or `margoengine/transitions/mask`). Black reveals first, white last; the encoded red channel of a greyscale image sets the threshold. Alpha is ignored.

```ts
import { Engine } from 'margoengine/core';
import { createMaskTransition } from 'margoengine/transitions/mask';
const engine = await Engine.create(document.querySelector('canvas')!);
const mask = new ImageData(new Uint8ClampedArray([
  0,0,0,255, 255,255,255,255,
  64,64,64,255, 192,192,192,255,
]), 2, 2);
const transition = createMaskTransition(engine, mask, { softness: 0.02 });
engine.scene.background = '#0044ff';
engine.render();
transition.start('wipe', 1);
engine.scene.background = '#ff4400';
engine.render({ delta: 0.5 });
transition.dispose();
engine.dispose();
```

Accepts 8-bit ImageData (copied immediately) or an ImageBitmap, such as one decoded with `createImageBitmap(blob)`. Keep a borrowed bitmap open until transition disposal so device restoration can reupload it; the transition never closes your bitmap. Closed images are refused. Image dimensions are 1..min(4096, device maxTextureDimension2D); capture dimensions are at most 65,535, also within the device's limit. The mask stretches across the full capture with nearest sampling, top-left origin. Integer pixel-center addressing makes exact texel ties stable through odd-size resizes. ImageData bytes have no color conversion; bitmap upload uses WebGPU's default sRGB destination encoding. `softness` is a threshold half-width, default 0.02: zero gives hard edges; otherwise use 0.000001..1. Exact endpoints bypass the threshold. Call `start('wipe', seconds)`; kind and displacement do not alter the mask. Resize retains history/progress. Device replacement reuploads the mask and cancels unavailable scene history. Native WebGL2 gives linked code `unsupported`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/transitions

