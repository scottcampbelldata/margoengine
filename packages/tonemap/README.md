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

## Auto-exposure, white balance, vignette, grain, dithering, chromatic aberration

```ts
import {createStage} from 'margoengine';
import {Tonemap, whiteBalanceMatrix} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend:'webgpu'});
const tonemap = Tonemap.attach(stage.engine, {
  curve: 'agx',
  autoExposure: {min: -3, max: 3, speed: 2, compensation: 0.3}, // or just `true`
  temperature: 4500, tint: 0.1, // white balance for the light in the scene, in Kelvin
  vignette: 0.35, grain: 0.1, chromaticAberration: 0.2,
});
tonemap.options.vignette = 0; // every option can change per frame
const balance = whiteBalanceMatrix(4500, 0.1); // the 3x3 matrix (column-major), if you need it elsewhere
stage.dispose();
```

All are off by default and compiled in only when asked for: without them the shaders, bindings and GPU calls are exactly what they were. Order: input conversion, white balance, exposure plus the auto-exposure stops, curve, contrast, LUT, vignette, grain, sRGB, dither. Chromatic aberration shifts the red and blue samples radially (1 = 2% of the view at its edge) before everything else.

- `autoExposure` meters the log-average luminance of the HDR source over the view with one 256-thread compute pass (4,096 samples) and moves the stored exposure toward 18% grey by `1 - exp(-speed * dt)` per frame (`min`, `max` in stops, `speed` in 1/s, `compensation` in stops; defaults -4, 4, 1.5, 0). The first frame snaps to the metered value. It adds one compute dispatch and an 8-byte storage buffer.
- **Metering modes.** `metering` picks where the meter looks: `'average'` (default, the whole view evenly),
  `'center'` (weighted by a Gaussian of the distance from the centre, sigma a quarter of the view height), `'spot'`
  (only the disc `spot: {x, y, radius}`, centre as fractions of the view, defaults 0.5, 0.5, radius 0.05 of the shorter
  side; all 4,096 samples land in it) or `'mask'` (each sample weighted by the red channel of `mask`, a texture of any
  size stretched over the view). `method: 'histogram'` sorts the weighted samples into 64 bins of log2 luminance (-12 to
  12) and averages only those between `percentiles` (default `[0.1, 0.9]`), so a small light or a dark corner does not
  swing the exposure; `'mean'` (default) is the weighted log-average. A mask of zero weight keeps the last exposure. `mask` may also be a function giving the texture for the current device; a plain mask belongs to the device it was made on, so after a device restore it is dropped (the exposure holds), reported once through `engine.onError`, and `tonemap.setAutoExposureMask(texture)` brings a new one in (docs/conventions.md, "Borrowed GPU objects").
  Every mode shares one compute pipeline; checked on a real GPU against a CPU oracle of the meter within 0.002 stops in
  all eight combinations (`packages/tonemap/tests/metering-browser.mjs`, Apple silicon Mac, Metal).

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const tonemap = Tonemap.attach(stage.engine, {autoExposure: {method: 'histogram', metering: 'center'}});
tonemap.options.autoExposure = {metering: 'spot', spot: {x: 0.5, y: 0.4, radius: 0.08}}; // meter the face
stage.dispose();
```

`mask` is a texture you made, or a function that returns the texture for the current device (read every frame, so keep one texture per device). A plain texture belongs to the device it was first used on: after a device restore (`engine.rebootDevice()`) it is dropped and reported once through `engine.onError` (`'state'`, linking margoengine.com/errors#borrowed-lost), the frame keeps drawing, the meter keeps its last exposure, and assigning a new `autoExposure.mask` brings it back. The function form needs nothing after a restore:

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
let made: {device?: GPUDevice; texture?: GPUTexture} = {};
const weights = () => {
  const device = stage.engine.gpu;
  if (!device) return undefined;
  if (made.device === device) return made.texture;
  const texture = device.createTexture({size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture}, new Uint8Array([255]), {bytesPerRow: 256}, [1, 1]); // weight 1 everywhere
  made = {device, texture};
  return texture;
};
const tonemap = Tonemap.attach(stage.engine, {autoExposure: {metering: 'mask', mask: weights}});
stage.dispose();
```
- `temperature` is the colour temperature of the scene's light (1667-25000 K, default 6500 = no change): 3200 cools tungsten light to neutral. `tint` runs from -1 (green) to 1 (magenta). It is a chromatic adaptation, as photo editors and cameras do it: a von Kries scaling in the Bradford cone space from the Planckian white of `temperature` to the 6500 K one, applied as one 3x3 matrix in the shader, so it holds over the whole range (a grey card lit by an 1800 K candle comes out neutral). The card keeps its luminance; colours the correction pushes outside Rec.709 clip at 0 before the curve. `whiteBalanceMatrix(temperature, tint)` returns the matrix.
- `vignette` 0-1 with `vignetteRadius` and `vignetteSoftness` (fractions of the distance to the corner; defaults 0.5). Per view when the engine draws several.
- `vignetteColor` (linear Rec.709 0-1, default `[0, 0, 0]`), `vignetteCenter` (fractions of the view, x from the left
  and y from the top, default `[0.5, 0.5]`), `vignetteRoundness` (0 stretches it with the view into an ellipse through
  the corners, the default; 1 makes it a circle; the corner distance stays 1 either way) and `vignetteBlend`
  (`'multiply'`, the default, multiplies the picture by the colour as the vignette comes in, so black darkens and a tint
  tints; `'opaque'` blends toward the colour itself, like a painted matte).
- `grain` 0-1 is film grain that changes every frame, strongest in the mid-tones.
- `dither` (`true`, or 0-1 to scale it; default off) removes banding from smooth gradients such as skies and fog:
  triangular (TPDF) noise of up to one code value of the target either way, added to the sRGB-encoded colour as the very
  last step before the target quantises it, changing every frame. Triangular noise keeps the mean and the noise level
  independent of the signal, unlike uniform noise; it is narrowed near 0 and 1 so pure black and white stay exact. One
  code value is 1/255 on an 8-bit canvas and 1/1023 on `rgb10a2unorm`; float targets do not band, so there it adds
  nothing. Checked on a real GPU: a gradient two codes wide bands into flat columns 0.25 code off on average without it
  and lands within 0.03 code with it (`packages/tonemap/tests/dither-vignette-browser.mjs`).

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const tonemap = Tonemap.attach(stage.engine, {
  dither: true, // no banding in the sky
  vignette: 0.6, vignetteColor: [0.1, 0.02, 0.15], vignetteCenter: [0.5, 0.45], vignetteRoundness: 1,
});
tonemap.options.vignetteBlend = 'opaque'; // a painted, coloured matte instead of a darkening
stage.dispose();
```

Order: input color conversion → exposure in stops (−16 to 16) → selected curve → contrast about 18% gray (0 to 4; display-linear `0.18 (x / 0.18)^contrast`, a slope in log exposure that never clips the shadows to black; contrast 0 is flat 18% gray, black included) → optional LUT → clamp and exact sRGB transfer. The LUT operates on display-linear RGB after the curve; provide a LUT authored for that domain. It is not an automatic OCIO transform or a log/sRGB-encoded LUT decoder.

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

### .3dl LUTs (Flame, Smoke, Lustre, Nuke)

`@margoengine/tonemap/3dl` reads and writes the integer `.3dl` format next to `.cube`. `parse3dl(text, options)`
returns the same `CubeLUT` object that `setLUT` takes. It reads the Flame and Smoke layout (a first line of the grid's
input code values, `0 64 128 ... 1023` for 17 samples at 10 bits, then N³ rows of integer R G B with blue varying
fastest) and the Lustre layout (`3DMESH` and `Mesh <input bits> <output bits>` first, with or without the input line),
from 2 to 65 samples per axis, with `#` comments. The output depth comes from the Lustre header, or `outputBits`, or
else it is the smallest of 8, 10, 12, 14 and 16 bits that holds both the largest value and the largest input code (so
a 12-bit LUT whose values all stay below 1024 needs `outputBits: 12`). The input line must be a uniform grid from 0 (a
non-uniform one is a shaper; resample the LUT); its vertices are read as evenly spaced over 0..1.
`export3dl(source, options)` writes a `Grade` or `HueGrade` snapshot (as `exportCube` bakes it; `size` default 33) or a
0..1-domain `CubeLUT` in the Flame layout, `inputBits` default 10 and `outputBits` default 12, values clamped to 0..1.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
import {Grade} from 'margoengine/tonemap/grade';
import {parse3dl, export3dl} from 'margoengine/tonemap/3dl';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const look = export3dl(new Grade({shadows: [0.02, 0, -0.02]}), {size: 33}); // save as look.3dl
const tonemap = Tonemap.attach(stage.engine);
tonemap.setLUT(parse3dl(look)); // or the text of a .3dl file from Flame, Lustre or Nuke
stage.dispose();
```

`setLUT` accepts that object, raw `.cube` text or `null` and snapshots the size, samples and domains for restoration.
Replacement checks the device's 3D texture limit; failed validation or upload preserves the previous LUT. A
`rgba32float` 3D GPU texture uses eight explicit texture loads and trilinear interpolation, requiring no optional
float32 filtering feature. Non-33 sizes share a dimension-aware shader; 33³ and no-LUT inputs retain their existing
shader and rendering behavior. `setLUT(null)` clears grading by the LUT while retaining the selected tone curve.

Standalone capture at order −50 replaces the standard core shader's display mapping with linear HDR; grading presents at 31. To combine with DOF, attach DOF first and pass `source:()=>dof.outputTexture`. External sources must be sampleable viewport-sized single-sample 2D `rgba16float` or `rgba32float` textures containing linear HDR. Non-finite source texels present as finite light, NaN and -Inf as black and +Inf as 65504, and `LocalExposure` reads them the same way, so one bad texel stays one pixel. The source callback is fixed at attachment and follows resize/restoration. TAA can resolve afterward at order 40; with DOF, give it `depth:()=>dof.depthTexture`. Alone, Tonemap cannot share capture with SSAO or Creative PostProcessing. In a `PostStack` from `@margoengine/post/stack` it is the display effect: it grades the stack's HDR result after SSAO, DOF and Bloom and before FXAA, e.g. `PostStack.attach(stage.engine, [new SSAO(), new Bloom(), new Tonemap({curve:'neutral'})])`. A stacked Tonemap takes no `source`.

Display P3 and HDR canvases: with `ColorOutput` from `@margoengine/environment` active (alone or in a PostStack), Tonemap compiles an output variant of its shader. Below the 0.76 knee the curves are the SDR ones; on an HDR canvas Khronos PBR Neutral's highlight rolloff aims at ColorOutput's `peak` instead of 1 (AgX and ACES are scaled by the same rolloff ratio of the brightest channel), and on a P3 canvas the input is clipped to the P3 gamut instead of sRGB. It writes the 0..1 part to its target as before and the rest (above white; negative components for colours outside sRGB) to ColorOutput's excess texture in a second full-screen pass. Without ColorOutput nothing changes: `examples/package-benchmarks/proofs/color-output.proof.js` records the same GPU calls as before. Details and limits: environment README, "Display P3 and HDR output".

Transparent canvas: with `TransparentCanvas` from `@margoengine/environment` attached (or
`createHeadlessStage({ transparent: true })`), a partly covered pixel holds its colour times its coverage. Tonemap
then compiles a variant that divides by the alpha, applies the curve to that straight colour and multiplies back
(T. Porter and T. Duff, "Compositing Digital Images", SIGGRAPH 1984,
<https://graphics.pixar.com/library/Compositing/paper.pdf>), so graphics laid over footage have no light rim, and
grain and dither add nothing to empty pixels. A pixel with light and no coverage (a Bloom halo, additive particles)
takes its brightest channel as alpha, so it stays in straight alpha. Covered pixels are the same as on an opaque canvas, and an opaque canvas
keeps its shader. A canvas you configure `premultiplied` yourself is not marked: attach `TransparentCanvas`.

Classic curves: `curve: 'reinhard'` (x / (1 + x) per channel), `'cineon'` (the filmic fit of Hejl and Burgess-Dawson,
taken back to linear with a 2.2 power before the sRGB encoding) and `'linear'` (a clamp to 0..1 after exposure) match
the curves of the same names in other engines, so a scene ported with its tone mapping keeps its look. They compile a
separate shader variant only when selected, and switching among them compiles nothing. Checked on a real GPU
(`packages/tonemap/tests/curves-browser.mjs`, Apple silicon Mac, Metal): over 144 input levels at exposures -4 to 1, each
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

`@margoengine/tonemap/grade` (2,426 B min+gzip, its own entry) grades the picture live, without a LUT: shadows,
midtones and highlights wheels, lift, gamma and gain, saturation, tone curves, and saturation against hue. Give it to
Tonemap's `extensions`; its options are read every frame, so sliders can drive them. White balance (`temperature`,
`tint`), `contrast`, `exposure` and a LUT (`setLUT`) are Tonemap's own options.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
import {Grade} from 'margoengine/tonemap/grade';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const grade = new Grade({shadows: [0, 0.01, 0.04], highlights: [0.04, 0.02, 0]}); // teal shadows, warm highlights
Tonemap.attach(stage.engine, {curve: 'agx', extensions: [grade]});
grade.options.curves = {master: [[0, 0.02], [0.25, 0.2], [0.75, 0.82], [1, 1]]}; // a gentle S curve
grade.options.hueSaturation = [1.2, 1, 0.8, 1, 1, 1]; // richer reds, quieter greens
grade.options.lift = [0, 0, 0.03]; // blue in the blacks
grade.options.gain = [1.05, 1, 0.95]; // warm whites
grade.options.saturation = 1.2;
```

| Option | Default | Meaning |
| --- | --- | --- |
| `shadows` | `[0, 0, 0]` | RGB offset for the dark tones, each -1 to 1 |
| `midtones` | `[0, 0, 0]` | RGB offset for the middle tones, each -1 to 1 |
| `highlights` | `[0, 0, 0]` | RGB offset for the bright tones, each -1 to 1 |
| `curves` | straight | `{master, red, green, blue}`, each two or more `[x, y]` points in 0..1 with x increasing |
| `hueSaturation` | `[1, 1, 1, 1, 1, 1]` | Saturation multipliers, 0 to 4, at red, yellow, green, cyan, blue, magenta |
| `lift` | `[0, 0, 0]` | Per channel, -1 to 1: raises or lowers the blacks, leaves white |
| `gamma` | `[1, 1, 1]` | Per channel, 0.1 to 10: above 1 brightens the midtones; black and white stay |
| `gain` | `[1, 1, 1]` | Per channel, 0 to 4: scales the whites, leaves black |
| `saturation` | `1` | Saturation about Rec. 709 luma, 0 (grey) to 4 |
| `ranges` | none | `{global, shadows, midtones, highlights}`, each `{hue, density, saturation, exposure}` |

### Colour curves by tonal range: `ranges`

Each of `global`, `shadows`, `midtones` and `highlights` tints, saturates and exposes its part of the picture. The
global range multiplies into the other three, which are mixed by the wheels' luminance masks.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
import {Grade} from 'margoengine/tonemap/grade';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const grade = new Grade({ranges: {
  global: {saturation: 1.1},
  shadows: {hue: 210, density: 0.4, exposure: -0.25}, // cool, deeper shadows
  highlights: {hue: 35, density: 0.25}, // warm highlights
}});
Tonemap.attach(stage.engine, {extensions: [grade]});
grade.options.ranges = {midtones: {saturation: 0.8, exposure: 0.2}}; // read every frame
```

| Range control | Default | Meaning |
| --- | --- | --- |
| `hue` | `0` | Hue of the tint in degrees, 0 to 360 (0 red, 120 green, 240 blue); the opposite tint is 180 away |
| `density` | `0` | Amount of the tint, 0 to 1; a grey keeps its luminance |
| `saturation` | `1` | Saturation about Rec. 709 luma, 0 (grey) to 4 |
| `exposure` | `0` | Stops, -8 to 8 |

After lift, gamma, gain and saturation and before the wheels, each channel is multiplied by
`2^exposure (1 + density (h - Y(h)))`, with `h` the fully saturated RGB of the hue (the HSV hexcone, A. R. Smith,
[Color Gamut Transform Pairs](https://doi.org/10.1145/800248.807361), SIGGRAPH 1978) and `Y` Rec. 709 luma, then
saturated about luma, clamped to 0..1 after each step. `exportCube` and `export3dl` bake it with the rest. Ranges are
compiled only while one changes something (a hue with density 0 does not), and have no rows in the settings table.
The units are Margo's own, so values from another engine's colour curves do not carry over.

- **Method.** On display-linear colour after the curve and contrast, before a LUT. Lift, gamma and gain run first,
  `(gain (x + lift (1 - x)))^(1 / gamma)` per channel (the slope, offset and power of the ASC Color Decision List v1.2,
  2009, written so lift holds white and gain holds black), then saturation about Rec. 709 luma (ITU-R BT.709-6). They
  are compiled only while one is away from its default, so a `Grade` without them sends the GPU the same program and
  data as before they existed (`tests/grade.test.js` checks the SHA-256 of both); setting or clearing them rebuilds
  the pipeline once. The wheels add their offsets
  weighted by luminance masks that sum to 1: shadows 1 - smoothstep(0, 0.5, l), highlights smoothstep(0.5, 1, l),
  midtones the rest. Curves are monotone cubics through the points (no overshoot), sampled 33 times a frame and read
  with linear interpolation; the master curve runs first, then each channel's. Hue against saturation interpolates the
  six multipliers around the HSV hue circle and scales each colour's distance from its luma.
- **Checked on a real GPU** (`packages/tonemap/tests/grade-browser.mjs`, Apple silicon Mac, Metal, Chromium): default
  options change no pixel; a blue shadows offset lifts the blue of the dark pixels by 59 levels and leaves the bright
  ones; a red highlights cut lands within half a level of a CPU oracle of the wheel math; saturation 0 turns every
  pixel grey and a flat curve at 0.5 gives sRGB 188 everywhere. On this PC's RTX A6000 (Chromium, D3D12) lift 0.2
  raises the dark pixels 105 levels and the bright ones 10, gain 0.5 lowers the bright ones 56 and the dark ones 9,
  gamma 2 lifts the red box's green 52 levels, saturation 0 greys every pixel and 2 widens the red box's red-blue gap
  from 165 to 222 levels, and back at the defaults no pixel differs from the default `Grade`.
- **Limits.** Display-referred grading in 0..1 (what lies above white under an HDR `ColorOutput` passes ungraded); 33
  curve samples. Several `Grade` and `HueGrade` (`@margoengine/tonemap/hue`) extensions may share one list, for a base
  grade and a shot grade: each declares its own WGSL and they apply in the order given.

`extensions` takes any `TonemapExtension` (`key`, `patch(shader, binding, extra)` returning the WGSL with its code in,
an optional `values()` for one uniform buffer at that binding); changing the list rebuilds the pipeline once.

## Colour enhancement and channel mixer: `ColorEnhance`

`@margoengine/tonemap/enhance` (1,282 B min+gzip, its own entry) grades the HDR picture before the display curve: a
3x3 RGB channel mixer, dehaze, shadows, midtones and highlights in stops, and vibrance. Give it to Tonemap's
`extensions`, alone or with `Grade`; its options are read every frame and no value rebuilds the pipeline.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from 'margoengine/tonemap';
import {ColorEnhance} from 'margoengine/tonemap/enhance';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const enhance = new ColorEnhance({shadows: 0.8, highlights: -0.6, vibrance: 0.3, dehaze: 0.2});
Tonemap.attach(stage.engine, {curve: 'agx', extensions: [enhance]});
enhance.options.midtones = 0.15; // stops at middle grey
enhance.options.hazeColor = [0.7, 0.78, 0.9]; // the colour of a blue haze
// The channel mixer, a row of input red, green and blue per output channel: a little green moved into red.
enhance.options.mixer = {red: [0.85, 0.15, 0]};
```

| Option | Default | Meaning |
| --- | --- | --- |
| `mixer` | identity | `{red, green, blue}`, each `[r, g, b]` of -2 to 2: how much of each input channel goes into that output channel |
| `shadows` | `0` | Stops for the dark tones, -3 to 3 (1/8 to 8 times the light) |
| `midtones` | `0` | Stops at middle grey (18%), fading out over 7 stops either side, -1 to 1 |
| `highlights` | `0` | Stops for the bright tones, -3 to 3 |
| `vibrance` | `0` | -1 to 1: above 0 boosts dull colours more than saturated ones, below 0 mutes them |
| `dehaze` | `0` | -1 to 1: above 0 removes haze (deeper shadows, clearer colour), below 0 adds it |
| `hazeColor` | `[1, 1, 1]` | Colour of the haze after exposure, linear Rec.709, 0.01 to 16 per channel |

A value out of range throws `RangeError`, a value of the wrong shape `TypeError`, at construction and on the frame
that reads it.

- **Order.** On scene-linear colour after exposure, white balance and `LocalExposure` (wherever it stands in the list),
  before the curve, so `contrast`, `Grade` and a LUT come after. Inside: mixer, dehaze, tones, vibrance. Several
  `ColorEnhance` apply in list order.
- **Mixer.** `out = M in`, linear, so exposure does not change its result. A negative result is no light on an sRGB
  canvas and a colour outside sRGB under an HDR `ColorOutput`; the other steps work on what is zero or above.
- **Dehaze.** The haze model `I = J t + A (1 - t)` with the haze colour `A`. Above 0: `J = (I - A) / t + A` per
  channel below `A`, with `t = 1 - 0.5 amount min(I / A)` over the three channels; channels at or above `A` stay.
  Below 0: `t = 1 - 0.5 |amount|` and the model runs forwards. It reads one pixel, not a neighbourhood or depth: for
  haze that follows distance use the fog of `@margoengine/environment`.
- **Tones.** A gain on all channels, so hue is kept. With `e = log2(Y / 0.18)` (`Y` Rec.709 luma),
  `low = smoothstep(-7, 0, e)` and `high = smoothstep(0, 7, e)`:
  `stops = shadows (1 - low) + midtones (low - high) + highlights high`. No allowed setting reverses two tones.
- **Vibrance.** `out = x + (x - Y) vibrance (1 - S)`, `S = (max - min) / max`: luminance is kept (unless a channel
  clips at 0) and a fully saturated colour does not move.
- **Not baked.** `exportCube` and `export3dl` take a display-linear `Grade`; `ColorEnhance` works on scene light and is
  not in them.
- **Checked on a real GPU** (`packages/tonemap/tests/enhance-browser.mjs`, WebGPU and the WebGL2 compatibility layer):
  every control alone, all together and two in a list land within 0.5 of an 8-bit level of a CPU oracle of these
  formulas; default options leave every pixel as without it.

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
- **Checked on a real GPU** (`packages/tonemap/tests/custom-browser.mjs`, Apple silicon Mac, Metal, Chromium): a WGSL
  x / (x + k) with k = 1 from `params`, and a JavaScript x / (1 + x), match a CPU oracle on every pixel over 111 input
  levels at exposures -4 to 1, within what each 8-bit input level allows; a live `params` change to k = 0.25 does too;
  the WGSL curve compiles and draws without a GPU error under an HDR `ColorOutput`.
- **Limits.** Shader-node graphs from `@margoengine/shader` are not taken directly (Tonemap does not depend on that
  package): write the curve as WGSL. A JavaScript curve is per channel and sampled (128 points over 20 stops). A WGSL
  function whose name the Tonemap shader already uses is rejected; other WGSL errors show as a GPU validation error.

## Local exposure: `LocalExposure`

`@margoengine/tonemap/local` keeps detail in bright windows and dark interiors in one frame: dark regions come up and
bright ones come down toward middle grey, while the detail inside each region keeps its contrast. Give it to Tonemap's
`extensions`; its options are read every frame. Its textures go when the Tonemap is disposed or removed with its scene,
and after a device restore; it makes them again on its next frame. An extension of your own with GPU objects frees them
in an optional `dispose()`, which Tonemap calls at the same times.

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
  blurred by a bilateral filter that reaches three sigma on each side. When that would take more than 32 taps a side
  (a sigma above 10.7 blocks, e.g. the default radius on a 2160-row view) the blocks double until it fits (8 by 8, 16
  by 16, ...), the downsampled bilateral of the same paper; the blur runs as two separable passes (horizontal, vertical; an approximation of the 2D filter),
  all in `r32float`. Each pixel's exposure then moves by `-strength * (base + exposure - log2(0.18))` stops, clamped to
  `maxStops`, with the base read bilinearly; only the smooth base is compressed. It follows `exposure` and
  `autoExposure`, and runs before the curve, so every curve, `Grade` and a LUT apply after it.
- **Cost.** Three render passes at block resolution before the presentation pass and three `r32float` textures (a
  1920 by 1080 view at the default radius: 480 by 270, about 1.5 MB; larger radii use larger blocks and less). Dispose it (or `using`) to free them. GPU time not measured.
- **Checked on a real GPU** (`packages/tonemap/tests/local-browser.mjs`, Apple silicon Mac, Metal, Chromium): on a synthetic
  source with a bright window and a dark interior, both with a checker of detail, every pixel lands within one 8-bit
  level of a CPU oracle of the whole chain; strength 0 changes no pixel; the interior comes up 3 stops (the clamp), the
  window goes down 0.75, and neighbouring checker cells differ in local stops by under 0.02. The same holds at radius 0.1
  on a 320 by 1400 view (16 by 16 blocks, 27 taps a side), on WebGPU and the WebGL2 compatibility layer.
- **Limits.** The separable bilateral blur is an approximation: a thin bright line across a dark region can leave a
  faint halo along it; one view rect at a time (the whole source is filtered); 4 by 4 blocks set the finest region.

`extensions` takes any `TonemapExtension`: `patch(shader, binding, extra)`, an optional `values()` for one uniform at
`binding`, `resources()` for up to four more resources at `extra` on, and `encode(context)` for passes of its own before
the presentation pass. The pipeline layout is automatic, so the fragment shader must use every binding the extension
gives, even one a setting leaves unread (`_ = myUniform;` keeps it, as `CustomCurve` does for a curve that ignores
`curveParams`).

## Film time: seeking the grain to a cut

The grain and dither pattern changes every frame. `Tonemap` has `advanceTime(delta)`, the CPU part of its frame
update, and a `time` getter; its `onPreUpdate` runs the same `advanceTime`, so every view of one frame shows the same
grain and `seek` from `@margoengine/cutscene/seek` lands a fresh scene on the grain a continuous run shows there
(`tests/seek.test.js` to 54,000 steps). A Tonemap that no frame update reaches (one stacked in a `PostStack`) moves its
grain at each draw instead. An update with a delta of 0 (a mirror or cube capture inside the frame) moves no grain; a
frame drawn after updates of 0 only moves it once. Auto exposure is view history: a cut snaps it to the metered scene on its first frame, then
it adapts as a continuous run does, so after a warm-up of P seconds it keeps e^(-speed P) of the gap the cut left
(speed 1.5, 2 s: 5 %; `tests/seek-browser.mjs` on WebGPU and the WebGL2 compatibility layer).

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
import {seek} from 'margoengine/cutscene/seek';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const tonemap = Tonemap.attach(engine, {grain: 0.2, autoExposure: true});
// The scene starts 95 s into the film and draws 2 s of warm-up frames first: seek to 93 s.
await seek(engine, 93, {fps: 30});
for (let frame = 0; frame < 60; frame++) engine.render({delta: 1 / 30});
console.log(tonemap.time);
```

## Sliders for the display: `@margoengine/tonemap/settings`

`Tonemap`, `Grade`, `HueGrade` and `LocalExposure` keep their options object and read it each frame, so the look changes while the scene runs. `@margoengine/tonemap/settings` lists those controls as a table for sliders and panels: `TONEMAP_SETTINGS` has 49 rows (`name`, `group`, `kind`, `default`, `min`, `max`, `step`, `unit`, `about` and `live`) in six groups: `tonemap` (curve, exposure, contrast, white point, toe, shoulder, temperature, tint, grain, dither, chromatic aberration), `vignette` (amount, radius, softness, colour, centre, roundness, blend), `autoExposure` (min, max, speed, compensation, method, percentiles, metering, spot), `grade` (shadows, midtones and highlights wheels, six hue saturations, lift, gamma, gain, saturation), `hue` (the hue shift) and `local` (strength, stops, radius, edges). `applyTonemapSettings({tonemap, grade, hueGrade, local}, values)` writes a set of values onto the objects you give (a name left out takes its default; `autoExposure.enabled` off removes the option, on writes the object), and `TONEMAP_LOOKS` names three looks made only of row values: `filmic`, `bleach` and `ember` (`natural` is the defaults). An unknown name throws `TypeError`, a value outside its row `RangeError`, and a row moved off its default whose object you did not pass `TypeError`.

33 rows are `live`: writing all of them every frame for 60 frames creates no pipeline, buffer or texture (`npm run test:settings:browser`, native WebGPU and the WebGL2 layer), and the defaults written draw exactly what the effects draw with no options. The rows that change which program runs are `live: false`, and each is shown to make GPU objects: the white balance, tint, grain, dither and chromatic aberration and the vignette amount (each turns the effects program on at its first move off zero), `tonemap.whitePoint`, `toe` and `shoulder`, `autoExposure.enabled`, a classic curve (`reinhard`, `cineon`, `linear`; going among `neutral`, `agx` and `acescg` is free), the lift, gamma, gain and saturation of the grade (one program), and `local.radius` where it crosses a block size (about 43 px of blur, 0.04 of a 1080 px frame). Key those away from their defaults once before a shot, then move the live rows freely. The tone curves of `Grade`, the hue curve of `HueGrade`, the metering mask and the LUT are point lists or textures and stay on their option objects. The white point, toe and shoulder are `live: false` for the same reason: the first move of any of them off its default turns one more program on (moving them between other values is free; see "White point, toe and shoulder" below).

```ts
import {Engine} from 'margoengine/core';
import {Tonemap} from 'margoengine/tonemap';
import {Grade} from 'margoengine/tonemap/grade';
import {TONEMAP_LOOKS, applyTonemapSettings} from 'margoengine/tonemap/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const grade = new Grade();
const tonemap = Tonemap.attach(engine, {extensions: [grade]});
// The look first (it turns the vignette and grade programs on), then key live rows over the shot.
applyTonemapSettings({tonemap, grade}, TONEMAP_LOOKS.bleach);
let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  applyTonemapSettings({tonemap, grade}, {...TONEMAP_LOOKS.bleach, 'tonemap.exposure': -0.5 * Math.min(time / 4, 1)});
});
```

## White point, toe and shoulder

`Tonemap` options `whitePoint`, `toe` and `shoulder` shape the display curve (rows `tonemap.whitePoint`, `tonemap.toe`, `tonemap.shoulder`). After the curve and before contrast, `whitePoint` (0 to 64, default 0 = off) divides the curve output by the curve's own value at that scene-linear level (after exposure), so a pixel of that value lands on exactly 1 and brighter ones clip (the `reinhard` curve instead takes the paper's own white point, L (1 + L / W^2) / (1 + L), which also lands W on 1); then `toe` and `shoulder` (each 0 to 3, default 1) set the slope of the display curve at black and at white through the cubic Hermite spline of `shapeCurve(x, toe, shoulder)`, which is monotone over that range and the identity at 1 and 1. A toe below 1 eases into the shadows, a shoulder below 1 rolls the highlights off before white and 0 reaches white flat. With all three at their defaults the shaders, the program and the uniform bytes are exactly what they were (pinned by hash in `tests/shape.test.js`); the first move of any of them off its default compiles one more program, and a `CustomCurve` replaces the curve and this shaping together. Under `ColorOutput` (HDR or P3 canvas) the shaping applies to the picture up to SDR white and the highlight excess is not drawn while a control is on. Values of `whitePoint` from 0 to 0.01 act as 0.01. Sources: J. Hable, "Filmic Tonemapping Operators" (filmicworlds.com, 2010) and "Uncharted 2: HDR Lighting" (GDC 2010) for the toe, shoulder and white point of a filmic curve and the curve divided by its value at the white point; E. Reinhard, M. Stark, P. Shirley, J. Ferwerda, "Photographic Tone Reproduction for Digital Images" (SIGGRAPH 2002, https://doi.org/10.1145/566570.566575) for the white point of a global operator; F. N. Fritsch and R. E. Carlson, "Monotone Piecewise Cubic Interpolation" (SIAM J. Numer. Anal. 17(2), 1980, https://doi.org/10.1137/0717021) for the slope range 0 to 3 that keeps the cubic monotone. Read on 2026-11-17: the Reinhard paper (Eq. 4 is the `reinhard` white point) and the Hable page (the curve scaled by 1 / curve(W)); the toe and shoulder slope controls are Margo's own. The Fritsch and Carlson paper could not be obtained, so its square 0 to 3 is taken from secondary descriptions and checked by the derivative of the cubic over the whole square in `tests/shape.test.js`.

```ts
import {Engine} from 'margoengine/core';
import {Tonemap, shapeCurve} from 'margoengine/tonemap';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
// Scene-linear 6 lands on white, a soft toe, and highlights roll off before white.
const tonemap = Tonemap.attach(engine, {whitePoint: 6, toe: 0.7, shoulder: 0.5});
// The spline the shader uses, for a curve plot: 0.25 of the way from black to white.
console.log(shapeCurve(0.25, tonemap.options.toe, tonemap.options.shoulder));
```

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.
