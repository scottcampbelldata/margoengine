# @margoengine/tonemap

Import `margoengine/tonemap` from the `margoengine` package, or `@margoengine/tonemap` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional WebGPU HDR presentation and color grading, separate from core and stage.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend:'webgpu'});
const tonemap = Tonemap.attach(stage.engine, {curve:'neutral', exposure:0, contrast:1});
tonemap.options.exposure = 1;
tonemap.options.curve = 'agx';
tonemap.setLUT(await (await fetch('/grade.cube')).text());
tonemap.setLUT(null);
tonemap.dispose();
stage.dispose();
```

`agx` is the AgX Base display transform computed in the shader: Rec.2020 inset, log2 encoding over 16.5 stops around 18% grey, the parametric AgX sigmoid, hue restoration, then the outset back to Rec.709. 18% grey stays 18% grey. `acescg` selects an ACES fitted RRT/ODT display transform, with AP1 color handling; it is not the full ACES reference pipeline. ACEScg itself is a working color space. Core's default input is `linear-srgb`; use `inputColorSpace:'acescg'` only with an external AP1/D60 HDR `source`. `neutral`, the default, implements Khronos PBR Neutral: Margo's display curve, the one core and every package end with, so attaching Tonemap with no options changes nothing until you grade. See [references](NOTICE.md).

## Auto-exposure, white balance, vignette, grain, chromatic aberration

```ts
import {createStage} from 'margoengine';
import {Tonemap, whiteBalanceGain} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend:'webgpu'});
const tonemap = Tonemap.attach(stage.engine, {
  curve: 'agx',
  autoExposure: {min: -3, max: 3, speed: 2, compensation: 0.3}, // or just `true`
  temperature: 4500, tint: 0.1, // white balance for the light in the scene, in Kelvin
  vignette: 0.35, grain: 0.1, chromaticAberration: 0.2,
});
tonemap.options.vignette = 0; // every option can change per frame
const gain = whiteBalanceGain(4500, 0.1); // the RGB gain, if you need it elsewhere
stage.dispose();
```

All are off by default and compiled in only when asked for: without them the shaders, bindings and GPU calls are exactly what they were. Order: input conversion, white balance gain, exposure plus the auto-exposure stops, curve, contrast, LUT, vignette, grain, sRGB. Chromatic aberration shifts the red and blue samples radially (1 = 2% of the view at its edge) before everything else.

- `autoExposure` meters the log-average luminance of the HDR source over the view with one 256-thread compute pass (4,096 samples) and moves the stored exposure toward 18% grey by `1 - exp(-speed * dt)` per frame (`min`, `max` in stops, `speed` in 1/s, `compensation` in stops; defaults -4, 4, 1.5, 0). The first frame snaps to the metered value. It adds one compute dispatch and an 8-byte storage buffer.
- `temperature` is the colour temperature of the scene's light (1667-25000 K, default 6500 = no change): 3200 cools tungsten light to neutral. `tint` runs from -1 (green) to 1 (magenta). The gain keeps luminance.
- `vignette` 0-1 with `vignetteRadius` and `vignetteSoftness` (fractions of the distance to the corner; defaults 0.5). Per view when the engine draws several.
- `grain` 0-1 is film grain that changes every frame, strongest in the mid-tones.

Order: input color conversion → exposure in stops (−16 to 16) → selected curve → contrast around linear 18% gray (0 to 4) → optional LUT → clamp and exact sRGB transfer. The LUT operates on display-linear RGB after the curve; provide a LUT authored for that domain. It is not an automatic OCIO transform or a log/sRGB-encoded LUT decoder.

`parseCube(text)` accepts `LUT_3D_SIZE` integers from 2 through 65, including common 16³, 17³, 32³, 33³, 64³ and
65³ files. Supply exactly `size³` finite RGB rows with red varying fastest. Optional quoted `TITLE`, `DOMAIN_MIN`,
`DOMAIN_MAX`, comments and scientific notation are supported. Unsupported/1D headers, duplicate or late headers,
wrong counts, non-finite values and invalid domains reject. Input text is capped at 32 × 1024² JavaScript characters.
The result contains explicit `size`, Float32Array RGBA data and Float32Array domains. Manually constructed legacy
objects that omit `size` still mean 33³; other sizes require it.

`setLUT` accepts that object, raw `.cube` text or `null` and snapshots the size, samples and domains for restoration.
Replacement checks the device's 3D texture limit; failed validation or upload preserves the previous LUT. A
`rgba32float` 3D GPU texture uses eight explicit texture loads and trilinear interpolation, requiring no optional
float32 filtering feature. Non-33 sizes share a dimension-aware shader; 33³ and no-LUT inputs retain their existing
shader and rendering behavior. `setLUT(null)` clears grading by the LUT while retaining the selected tone curve.

Standalone capture at order −50 replaces the standard core shader's display mapping with linear HDR; grading presents at 31. To combine with DOF, attach DOF first and pass `source:()=>dof.outputTexture`. External sources must be sampleable viewport-sized single-sample 2D `rgba16float` or `rgba32float` textures containing linear HDR. The source callback is fixed at attachment and follows resize/restoration. TAA can resolve afterward at order 40; with DOF, give it `depth:()=>dof.depthTexture`. Alone, Tonemap cannot share capture with SSAO or Creative PostProcessing. In a `PostStack` from `@margoengine/post/stack` it is the display effect: it grades the stack's HDR result after SSAO, DOF and Bloom and before FXAA, e.g. `PostStack.attach(stage.engine, [new SSAO(), new Bloom(), new Tonemap({curve:'neutral'})])`. A stacked Tonemap takes no `source`.

Display P3 and HDR canvases: with `ColorOutput` from `@margoengine/environment` active (alone or in a PostStack), Tonemap compiles an output variant of its shader. Below the 0.76 knee the curves are the SDR ones; on an HDR canvas Khronos PBR Neutral's highlight rolloff aims at ColorOutput's `peak` instead of 1 (AgX and ACES are scaled by the same rolloff ratio of the brightest channel), and on a P3 canvas the input is clipped to the P3 gamut instead of sRGB. It writes the 0..1 part to its target as before and the rest (above white; negative components for colours outside sRGB) to ColorOutput's excess texture in a second full-screen pass. Without ColorOutput nothing changes: `examples/package-benchmarks/proofs/color-output.proof.js` records the same GPU calls as before. Details and limits: environment README, "Display P3 and HDR output".

GPU resources and JS descriptors are reused in steady state. Resize, LUT updates and device restoration rebuild the necessary resources; removal frees them. Opaque and transparent scene color are graded together.

```sh
npm --prefix packages/tonemap run build
npm --prefix packages/tonemap test
npm --prefix packages/tonemap run dev
npm --prefix packages/tonemap run build:demo
```

The standalone Vite demo at `examples/index.html` has exposure/contrast sliders, curve selection and a .cube file input. Run `npm run build:packages` first for core/stage. This package supports core `^0.1.0 || ^1.0.0` through the existing extension API and is included in workspace builds and release checks. No runtime dependencies are added.

The package's `1.0.0` version does not require Engine 1.0. It works with the
current Core/Stage 0.1.0. `node scripts/build-site.js` assembles its standalone
demo at `/demos/tonemap/`; the package catalog links to that built route. The demo
uses the package's built `dist` entry, preserves local LUT loading/controls, and marks
the complete scene's correlated GPU readiness. npm publication is separate:
use the workspace or packed local archives until the package is published.
