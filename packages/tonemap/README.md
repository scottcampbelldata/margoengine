# @margoengine/tonemap

Optional WebGPU HDR presentation and color grading, separate from core and stage.

```ts
import {createStage} from 'margoengine';
import {Tonemap} from '@margoengine/tonemap';
const stage = await createStage('#viewport', {backend:'webgpu'});
const tonemap = Tonemap.attach(stage.engine, {curve:'agx', exposure:0, contrast:1});
tonemap.options.exposure = 1;
tonemap.options.curve = 'neutral';
tonemap.setLUT(await (await fetch('/grade.cube')).text());
tonemap.setLUT(null);
tonemap.destroy();
stage.dispose();
```

`agx` uses the Rec.2020 AgX inset/outset matrices and an analytic sigmoid approximation. `acescg` selects an ACES fitted RRT/ODT display transform, with AP1 color handling; it is not the full ACES reference pipeline. ACEScg itself is a working color space. Core's default input is `linear-srgb`; use `inputColorSpace:'acescg'` only with an external AP1/D60 HDR `source`. `neutral` implements Khronos PBR Neutral. See [references and licenses](NOTICE.md).

Order: input color conversion → exposure in stops (−16 to 16) → selected curve → contrast around linear 18% gray (0 to 4) → optional LUT → clamp and exact sRGB transfer. The LUT operates on display-linear RGB after the curve; provide a LUT authored for that domain. It is not an automatic OCIO transform or a log/sRGB-encoded LUT decoder.

`parseCube(text)` accepts exactly `LUT_3D_SIZE 33`, optional `TITLE`, `DOMAIN_MIN` and `DOMAIN_MAX`, comments, and 35,937 finite RGB rows with red varying fastest. Unsupported/1D headers, wrong counts, duplicate size/domain headers, non-finite values and invalid domains are rejected. It returns Float32Array RGBA data and Float32Array domains. `setLUT` accepts this object, raw .cube text or null and retains a private copy for device restoration. A `rgba32float` 3D GPU texture is sampled with eight explicit texture loads and trilinear interpolation, requiring no optional float32 filtering feature.

Standalone capture at order −50 replaces the standard core shader's display mapping with linear HDR; grading presents at 31. To combine with DOF, attach DOF first and pass `source:()=>dof.outputTexture`. External sources must be sampleable viewport-sized single-sample 2D `rgba16float` or `rgba32float` textures containing linear HDR. The source callback is fixed at attachment and follows resize/restoration. TAA can resolve afterward at order 40; with DOF, give it `depth:()=>dof.depthTexture`. SSAO/Creative PostProcessing require their own HDR output integration and cannot share standalone capture.

GPU resources and JS descriptors are reused in steady state. Resize, LUT updates and device restoration rebuild the necessary resources; removal frees them. Opaque and transparent scene color are graded together.

```sh
npm --prefix packages/tonemap run build
npm --prefix packages/tonemap test
npm --prefix packages/tonemap run dev
npm --prefix packages/tonemap run build:demo
```

The standalone Vite demo at `examples/index.html` has exposure/contrast sliders, curve selection and a .cube file input. Run `npm run build:packages` first for core/stage. This package declares only core `^1.0.0` as a peer; while this checkout still declares core `0.1.0`, it is built outside npm workspace dependency resolution. The repository build includes it without changing core or stage. No runtime dependencies are added.
