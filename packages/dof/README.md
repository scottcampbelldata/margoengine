# @margoengine/dof

Optional WebGPU depth of field; core and stage are unchanged.

```ts
import {createStage} from 'margoengine';
import {DOF} from '@margoengine/dof';
const stage = await createStage('#viewport', {backend:'webgpu'});
const dof = DOF.attach(stage.engine, {focalDistance:5, focalLength:0.05, aperture:2.8});
dof.options.focalDistance = 3;
dof.enabled = false;
dof.dispose();
stage.dispose();
```

Passes capture linear HDR and sampleable reversed-Z depth before drawing, calculate signed thin-lens CoC at order 20, gather circular near/far bokeh separately at 21 (two compute passes), then present at 30. Focal distance and focal length use the same scene units; aperture is an f-number. Pixel scale follows camera vertical FOV and viewport height. With an orthographic camera (any `camera.matrix` with a constant clip w, such as `CameraProjection` from `@margoengine/cameras`) depth is linearized from the projection's own near/far and the circle of confusion grows linearly with the distance from the focal plane, `scale * (z - focalDistance) / focalDistance`, with the scale of a perspective lens whose pixel size at the focal distance matches the orthographic zoom; zooming in enlarges the blur in pixels. `maxRadius` bounds blur to 1–32 pixels. A deterministic spiral disk per field uses no temporal history. Far samples reject foreground depth; near samples spread only onto surfaces behind them. Finite disk sampling can undersample tiny foreground silhouettes; it does not reconstruct hidden geometry. Opaque depth controls blur; transparent materials do not provide separate depth layers.

Standalone output uses Margo's Reinhard/sRGB presentation. For color grading, attach DOF first, then `Tonemap.attach(stage.engine, {source:()=>dof.outputTexture})`. The current HDR `outputTexture` and `depthTexture` are undefined before the first frame and change on resize/restoration. With TAA, supply `depth:()=>dof.depthTexture` to TAA. Destroy dependent effects before DOF. Alone, SSAO and Creative PostProcessing own conflicting scene captures and are rejected. To combine DOF with SSAO, Bloom, Tonemap, Creative PostProcessing or FXAA, add it to a `PostStack` from `@margoengine/post/stack`, e.g. `PostStack.attach(stage.engine, [new SSAO(), new DOF(), new Bloom(), new Tonemap()])`; there it reads the stack's shared HDR capture and depth, and its `depthTexture` is the stack's.

## Cost

GPU time of the DOF passes (CoC, wide-disk 2x2-block gather, bokeh), Intel Arc 140V laptop iGPU, Edge 155, DamagedHelmet scene with environment light in a `PostStack` [DOF, Tonemap], median of 6 alternating old/new rounds x 90 frames (`examples/package-benchmarks/gates/dof.mjs`, `results/gates-dof.json`). "Before" is the 64-tap full-resolution gather of `5b9dbbd`.

| Focus | 720p 4x MSAA | 720p 1x | 1080p 4x | 1080p 1x |
| --- | --- | --- | --- | --- |
| 3.4 m, f/1.4, maxRadius 16 | 4.91 → 1.45 ms | 3.35 → 1.77 ms | 8.69 → 3.26 ms | 10.20 → 2.85 ms |
| 1.6 m (helmet and background blurred) | 5.15 → 2.23 ms | 5.02 → 2.49 ms | 10.06 → 4.28 ms | 10.68 → 4.47 ms |
| 12 m (helmet and floor in the near field) | 3.80 → 0.86 ms | 3.89 → 0.86 ms | 8.63 → 1.69 ms | 8.63 → 1.85 ms |
| 2 m, f/0.35, maxRadius 32 (9–23 px disks) | 5.45 → 2.35 ms | 4.86 → 2.75 ms | 10.52 → 4.84 ms | 11.22 → 4.90 ms |

MSAA does not change the DOF work (it reads the resolved scene); the 720p 4x/1x gate columns differ by GPU clock between runs.

The work follows the blur: in-focus and foreground pixels skip the far gather; the near gather reads only as far as the largest foreground disk in the neighbouring 8x8 tiles (nothing when none is in reach); far disks get about one tap per covered pixel (16 taps up to 2.26 px, 32 up to 3.19 px, 64 beyond); disks over 3.19 px are gathered once per 2x2 block and interpolated, except next to a depth change. Against the 64-tap gather the 8-bit frames differ by a mean of 0.00–0.11 levels (at most 0.3% of pixels by more than 6 levels, single pixels on high-contrast edges inside a blur); in-focus pixels and the near field are unchanged.

Owned textures, buffers and bind groups are reused between frames, rebuilt on resize/device restoration, and freed on removal. Steady frames construct no typed arrays and no GPU objects (counted by a mock-GPU test); WebGPU itself returns pass encoder objects. Custom draws must write linear HDR into the current `context.color`; the default core shader is adapted through the extension API.

From the repository root:

```sh
npm --prefix packages/dof run build
npm --prefix packages/dof test
npm --prefix packages/dof run dev
npm --prefix packages/dof run build:demo
```

The Vite HTML demo is `examples/index.html`. Run `npm run build:packages` once for core/stage artifacts. This package supports core `^0.1.0 || ^1.0.0` through the existing extension API and is included in workspace builds and release checks. No dependencies are bundled from core.

The package's `1.0.0` version does not require Engine 1.0. It works with the
current Core/Stage 0.1.0. `node scripts/build-site.js` assembles its standalone
demo at `/demos/dof/`; the package catalog links to that built route. The demo
uses the package's built `dist` entry and marks readiness after the complete scene's
GPU submission/completion and two later animation callbacks. npm publication
is separate: use this repository's workspace or packed local archives until the
package is published.
