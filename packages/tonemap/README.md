# @margoengine/tonemap

Import `margoengine/tonemap` from the `margoengine` package, or `@margoengine/tonemap` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional WebGPU HDR presentation and color grading, separate from core and stage.

For exposure driven by aperture, shutter time and ISO, use
[`PhysicalCamera` from `@margoengine/cameras/physical`](../cameras/README.md#physical-exposure-margoenginecamerasphysical).
Its runnable example shares an HDR stack with Tonemap, depth of field and motion blur; `camera.apply({exposure: tonemap})`
sets Tonemap's exposure in stops.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend:'webgpu'});
const tonemap = Tonemap.attach(stage.engine, {curve:'neutral', exposure:0, contrast:1});
tonemap.options.exposure = 1;
tonemap.options.curve = 'agx';
// A complete identity Cube LUT; replace its RGB rows with your own grade.
tonemap.setLUT(`LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`);
tonemap.setLUT(null);
tonemap.dispose();
stage.dispose();
```

With 4x MSAA, Tonemap captures the scene, resolves its colour and restores the canvas depth for later passes; its final resolve copies no depth it does not read (batch 164).

`Tonemap` detaches from its owning scene on disposal, preserving same-name
effects in other scenes. Use `scene.use()` for a secondary scene:

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
const engine = await Engine.create(document.querySelector('canvas')!, {backend:'webgpu'});
const product = engine.createScene('product');
const tonemap = new Tonemap();
product.use(tonemap);
tonemap.dispose();
engine.dispose();
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
- **Metering modes.** `metering` picks where the meter looks: `'average'` (default, the whole view evenly),
  `'center'` (weighted by a Gaussian of the distance from the centre, sigma a quarter of the view height), `'spot'`
  (only the disc `spot: {x, y, radius}`, centre as fractions of the view, defaults 0.5, 0.5, radius 0.05 of the shorter
  side; all 4,096 samples land in it) or `'mask'` (each sample weighted by the red channel of `mask`, a texture of any
  size stretched over the view). `method: 'histogram'` sorts the weighted samples into 64 bins of log2 luminance (-12 to
  12) and averages only those between `percentiles` (default `[0.1, 0.9]`), so a small light or a dark corner does not
  swing the exposure; `'mean'` (default) is the weighted log-average. A mask of zero weight keeps the last exposure.
  Every mode shares one compute pipeline; checked on a real GPU against a CPU oracle of the meter within 0.002 stops in
  all eight combinations (`packages/tonemap/tests/metering-browser.mjs`, M6 Mac mini, Metal).

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const tonemap = Tonemap.attach(stage.engine, {autoExposure: {method: 'histogram', metering: 'center'}});
tonemap.options.autoExposure = {metering: 'spot', spot: {x: 0.5, y: 0.4, radius: 0.08}}; // meter the face
stage.dispose();
```
- `temperature` is the colour temperature of the scene's light (1667-25000 K, default 6500 = no change): 3200 cools tungsten light to neutral. `tint` runs from -1 (green) to 1 (magenta). The gain keeps luminance.
- `vignette` 0-1 with `vignetteRadius` and `vignetteSoftness` (fractions of the distance to the corner; defaults 0.5). Per view when the engine draws several.
- `grain` 0-1 is film grain that changes every frame, strongest in the mid-tones.

Order: input color conversion → exposure in stops (−16 to 16) → selected curve → contrast around linear 18% gray (0 to 4) → optional LUT → clamp and exact sRGB transfer. The LUT operates on display-linear RGB after the curve; provide a LUT authored for that domain. It is not an automatic OCIO transform or a log/sRGB-encoded LUT decoder.

For CPU-only parsing, supply the complete text. The result can later be passed to `tonemap.setLUT`:

```ts
import {parseCube} from '@margoengine/tonemap';
const lut = parseCube(`LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1`);
console.log(lut.size, lut.data.length); // 2, 32 RGBA values
```

Parsing reads one line at a time, validates RGB while converting it, and checks the domain before returning.
Manually supplied LUT objects receive full validation when passed to `setLUT`.

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

Classic curves: `curve: 'reinhard'` (x / (1 + x) per channel), `'cineon'` (the filmic fit of Hejl and Burgess-Dawson,
taken back to linear with a 2.2 power before the sRGB encoding) and `'linear'` (a clamp to 0..1 after exposure) match
the curves of the same names in other engines, so a scene ported with its tone mapping keeps its look. They compile a
separate shader variant only when selected, and switching among them compiles nothing. Checked on a real GPU
(`packages/tonemap/tests/curves-browser.mjs`, M6 Mac mini, Metal): over 144 input levels at exposures -4 to 1, each
pixel lands within 1.1 levels of a CPU oracle of its formula.

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

## Live grading: `Grade`

`@margoengine/tonemap/grade` (1,552 B min+gzip, its own entry) grades the picture live, without a LUT: shadows,
midtones and highlights wheels, tone curves, and saturation against hue. Give it to Tonemap's `extensions`; its
options are read every frame, so sliders can drive them.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
import {Grade} from 'margoengine/tonemap/grade';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const grade = new Grade({shadows: [0, 0.01, 0.04], highlights: [0.04, 0.02, 0]}); // teal shadows, warm highlights
Tonemap.attach(stage.engine, {curve: 'agx', extensions: [grade]});
grade.options.curves = {master: [[0, 0.02], [0.25, 0.2], [0.75, 0.82], [1, 1]]}; // a gentle S curve
grade.options.hueSaturation = [1.2, 1, 0.8, 1, 1, 1]; // richer reds, quieter greens
```

| Option | Default | Meaning |
| --- | --- | --- |
| `shadows` | `[0, 0, 0]` | RGB offset for the dark tones, each -1 to 1 |
| `midtones` | `[0, 0, 0]` | RGB offset for the middle tones, each -1 to 1 |
| `highlights` | `[0, 0, 0]` | RGB offset for the bright tones, each -1 to 1 |
| `curves` | straight | `{master, red, green, blue}`, each two or more `[x, y]` points in 0..1 with x increasing |
| `hueSaturation` | `[1, 1, 1, 1, 1, 1]` | Saturation multipliers, 0 to 4, at red, yellow, green, cyan, blue, magenta |

- **Method.** On display-linear colour after the curve and contrast, before a LUT. The wheels add their offsets
  weighted by luminance masks that sum to 1: shadows 1 - smoothstep(0, 0.5, l), highlights smoothstep(0.5, 1, l),
  midtones the rest. Curves are monotone cubics through the points (no overshoot), sampled 33 times a frame and read
  with linear interpolation; the master curve runs first, then each channel's. Hue against saturation interpolates the
  six multipliers around the HSV hue circle and scales each colour's distance from its luma.
- **Checked on a real GPU** (`packages/tonemap/tests/grade-browser.mjs`, M6 Mac mini, Metal, Chromium): default
  options change no pixel; a blue shadows offset lifts the blue of the dark pixels by 59 levels and leaves the bright
  ones; a red highlights cut lands within half a level of a CPU oracle of the wheel math; saturation 0 turns every
  pixel grey and a flat curve at 0.5 gives sRGB 188 everywhere.
- **Limits.** Display-referred grading in 0..1 (what lies above white under an HDR `ColorOutput` passes ungraded); 33
  curve samples; one Grade per Tonemap.

`extensions` takes any `TonemapExtension` (`key`, `patch(shader, binding, extra)` returning the WGSL with its code in,
an optional `values()` for one uniform buffer at that binding); changing the list rebuilds the pipeline once.

## Custom curve: `CustomCurve`

`@margoengine/tonemap/custom` replaces the display curve with your own, written in WGSL or as a JavaScript function.
Give it to Tonemap's `extensions`; contrast, `Grade`, a LUT and the sRGB encoding still run after it.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
import {CustomCurve} from 'margoengine/tonemap/custom';
const stage = await createStage('#viewport', {backend: 'webgpu'});
// WGSL: the first function is the curve; params are live as curveParams[0] to curveParams[3] (four vec4f).
const film = new CustomCurve({
  wgsl: 'fn film(x: vec3f) -> vec3f { let k = curveParams[0].x; return x / (x + vec3f(k)); }',
  params: [0.6],
});
Tonemap.attach(stage.engine, {extensions: [film]});
film.options.params = [0.4]; // no recompile
// Or a JavaScript curve of one channel, sampled every frame:
const soft = new CustomCurve({curve: (x) => 1 - Math.exp(-x)});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `wgsl` | none | WGSL starting with `fn name(x: vec3f) -> vec3f`: exposed scene-linear RGB in, display-linear 0..1 out |
| `curve` | none | `(x) => y`, the same for one channel, applied to R, G and B; give exactly one of `wgsl` and `curve` |
| `params` | zeros | Up to 16 numbers for the WGSL curve, read every frame |

- **Method.** The curve runs on the exposed (and white-balanced) scene-linear colour, in place of the built-in one.
  A JavaScript curve is sampled at 128 points spaced evenly in log2 from 2^-12 to 2^8 and read with linear
  interpolation in log2; below 2^-12 it runs linearly from its value at 0, above 2^8 it holds. A new `wgsl` string
  compiles a new pipeline; `params` and `curve` changes do not. Under an HDR `ColorOutput` the result takes the same
  rolloff toward the display peak as AgX and ACES.
- **Checked on a real GPU** (`packages/tonemap/tests/custom-browser.mjs`, M6 Mac mini, Metal, Chromium): a WGSL
  x / (x + k) with k = 1 from `params`, and a JavaScript x / (1 + x), match a CPU oracle on every pixel over 111 input
  levels at exposures -4 to 1, within what each 8-bit input level allows; a live `params` change to k = 0.25 does too;
  the WGSL curve compiles and draws without a GPU error under an HDR `ColorOutput`.
- **Limits.** Shader-node graphs from `@margoengine/shader` are not taken directly (Tonemap does not depend on that
  package): write the curve as WGSL. A JavaScript curve is per channel and sampled (128 points over 20 stops). A WGSL
  function whose name the Tonemap shader already uses is rejected; other WGSL errors show as a GPU validation error.

## Local exposure: `LocalExposure`

`@margoengine/tonemap/local` keeps detail in bright windows and dark interiors in one frame: dark regions come up and
bright ones come down toward middle grey, while the detail inside each region keeps its contrast. Give it to Tonemap's
`extensions`; its options are read every frame.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
import {LocalExposure} from 'margoengine/tonemap/local';
const stage = await createStage('#viewport', {backend: 'webgpu'});
using local = new LocalExposure({strength: 0.5, maxStops: 3});
Tonemap.attach(stage.engine, {curve: 'agx', autoExposure: true, extensions: [local]});
local.options.strength = 0.7; // a flatter, more "HDR photo" look
```

| Option | Default | Meaning |
| --- | --- | --- |
| `strength` | `0.5` | How far each region's level moves toward middle grey, 0 (off) to 1 (flat) |
| `maxStops` | `3` | Largest local change, 0 to 8 stops |
| `radius` | `0.02` | Region size: the blur's spatial sigma as a fraction of the view height, 0.002 to 0.1 |
| `edges` | `1.3` | Edge stop of the bilateral blur in stops of luminance, 0.1 to 8: lower keeps edges sharper |

- **Method.** The base and detail split of Durand and Dorsey (2002): log2 luminance is averaged over 4 by 4 blocks, then
  blurred by a bilateral filter run as two separable passes (horizontal, vertical; an approximation of the 2D filter),
  all in `r32float`. Each pixel's exposure then moves by `-strength * (base + exposure - log2(0.18))` stops, clamped to
  `maxStops`, with the base read bilinearly; only the smooth base is compressed. It follows `exposure` and
  `autoExposure`, and runs before the curve, so every curve, `Grade` and a LUT apply after it.
- **Cost.** Three render passes at quarter resolution before the presentation pass and three `r32float` textures (a
  1920 by 1080 view: 480 by 270, about 1.5 MB). Dispose it (or `using`) to free them. GPU time not measured.
- **Checked on a real GPU** (`packages/tonemap/tests/local-browser.mjs`, M6 Mac mini, Metal, Chromium): on a synthetic
  source with a bright window and a dark interior, both with a checker of detail, every pixel lands within one 8-bit
  level of a CPU oracle of the whole chain; strength 0 changes no pixel; the interior comes up 3 stops (the clamp), the
  window goes down 0.75, and neighbouring checker cells differ in local stops by under 0.02.
- **Limits.** The separable bilateral blur is an approximation: a thin bright line across a dark region can leave a
  faint halo along it; one view rect at a time (the whole source is filtered); 4 by 4 blocks set the finest region.

`extensions` takes any `TonemapExtension`: `patch(shader, binding, extra)`, an optional `values()` for one uniform at
`binding`, `resources()` for up to four more resources at `extra` on, and `encode(context)` for passes of its own before
the presentation pass.

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.
