# @margoengine/dof

Optional WebGPU depth of field; core and stage are unchanged.

```ts
import {createStage} from 'margoengine';
import {DOF} from '@margoengine/dof';
const stage = await createStage('#viewport', {backend:'webgpu'});
const dof = DOF.attach(stage.engine, {focalDistance:5, focalLength:0.05, aperture:2.8});
dof.options.focalDistance = 3;
dof.enabled = false;
dof.destroy();
stage.dispose();
```

Passes capture linear HDR and sampleable reversed-Z depth before drawing, calculate signed thin-lens CoC at order 20, gather circular near/far bokeh separately at 21, then present at 30. Focal distance and focal length use the same scene units; aperture is an f-number. Pixel scale follows camera vertical FOV and viewport height. `maxRadius` bounds cost and blur to 1–32 pixels. A deterministic 64-point disk per field uses no temporal history. Far samples reject foreground depth; near samples spread only onto surfaces behind them. Finite disk sampling can undersample tiny foreground silhouettes; it does not reconstruct hidden geometry. Opaque depth controls blur; transparent materials do not provide separate depth layers.

Standalone output uses Margo's Reinhard/sRGB presentation. For color grading, attach DOF first, then `Tonemap.attach(stage.engine, {source:()=>dof.outputTexture})`. The current HDR `outputTexture` and `depthTexture` are undefined before the first frame and change on resize/restoration. With TAA, supply `depth:()=>dof.depthTexture` to TAA. Destroy dependent effects before DOF. Alone, SSAO and Creative PostProcessing own conflicting scene captures and are rejected. To combine DOF with SSAO, Bloom, Tonemap, Creative PostProcessing or FXAA, add it to a `PostStack` from `@margoengine/post/stack`, e.g. `PostStack.attach(stage.engine, [new SSAO(), new DOF(), new Bloom(), new Tonemap()])`; there it reads the stack's shared HDR capture and depth, and its `depthTexture` is the stack's.

Owned textures, buffers and bind groups are reused between frames, rebuilt on resize/device restoration, and freed on removal. The package creates no JS arrays, typed arrays, descriptors or shader strings in steady-state frames; WebGPU itself returns pass encoder objects. Custom draws must write linear HDR into the current `context.color`; the default core shader is adapted through the extension API.

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
uses the published `dist` entry and marks readiness after the complete scene's
GPU submission/completion and two later animation callbacks. npm publication
is separate: use this repository's workspace or packed local archives until the
package is published.
