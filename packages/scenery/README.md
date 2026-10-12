# @margoengine/scenery

Optional WebGPU scenery for Margo Engine, starting with a procedural moonlit sky, lunar phases, twinkling stars, corona glow and horizon haze. Load it independently on top of core, like the machinery package.

In this workspace, `npm run dev` opens the standalone Night Citadel showcase with moon, phase, haze, twinkle and glow controls. Run `npm run modern:dev` for the original starter and click **Toggle moonlit scenery** beside **Toggle GPU leaves**. The starter loads scenery on demand with the moon in view. It coordinates the sky/haze with the FX toggle and restores the FX atmosphere when scenery is removed.

```sh
npm install @margoengine/core @margoengine/scenery
```

```ts
import {Engine} from '@margoengine/core';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const {SkyMoon} = await import('@margoengine/scenery');
engine.use(new SkyMoon({moonDirection: [0.45, 0, -1], moonPhase: 0.85}));
engine.start();
```

`SkyMoon` registers a background pass after opaque geometry. It loads the color/depth attachments and tests at Reversed-Z depth 0 without writing depth. Canvas and HDR (`rgba16float`) pipelines are constructed during setup; frame recording reuses its uniform arrays, matrix inversion workspace and render-pass descriptor. Resize changes the attachment views without rebuilding resources. Core restores the plugin on device replacement and disposes it on `engine.dispose()`; remove it with `engine.removePlugin('sky-moon')`. Options are applied during setup; remove/re-add the plugin to change them. When combining with `PostProcessing`, leave `atmosphere.sky` disabled so the post stack does not replace this backdrop.

For custom rendering, use the low-level pass:

```ts
import {SkyMoonPass, type SkyMoonConfig} from '@margoengine/scenery';

function createSky(device: GPUDevice, format: GPUTextureFormat) {
  const sky = new SkyMoonPass(device, format, 'depth32float');
  const config: SkyMoonConfig = {moonDirection: [0.4, 0.7, 0.5], moonPhase: 0.85};
  sky.setConfig(config);
  return sky;
}
```

Retain the pass, inverse view-projection matrix, camera position and render-pass descriptor across frames. Call `sky.updateFrame(inverseViewProjection, cameraPosition, timeSeconds)` before `sky.record(passEncoder)`. Match the constructor's color/depth formats to the attachments and use sample count 1. Clear Reversed-Z depth to 0. Omit the depth format only for a pass without a depth attachment. `updateFrame` and `record` create no temporary JavaScript objects on valid frames. Browser GPU command encoding may allocate internally.

The uniforms occupy 160 bytes with 16-byte alignment. Colors are non-negative linear RGB. Moon direction must be finite and nonzero and is normalized on configuration; angular radius defaults to 0.038 radians and must be between 0 and PI / 2. Phase clamps to [-1, 1] (new, half, full), and glow/star intensities clamp to zero or above. `starTwinkleIntensity` defaults to 1; zero keeps stars steady. Stars fade in above 15° elevation. `hazeDensity` defaults to 1; zero removes the horizon haze gradient and larger values thicken it. Both controls clamp to zero or above and use existing uniform padding, keeping the 160-byte layout. Invalid inputs throw before changing the staged uniforms. The perspective ray reconstruction supports finite and infinite Reversed-Z projections, runs at the triangle's three vertices and interpolates across the screen. Lunar angular sine/cosine are computed only on configuration changes. Recreate a low-level pass when the device or attachment formats change, and call `sky.dispose()` on teardown.

This ESM package includes strict TypeScript declarations, requires core 0.1.0 and supported WebGPU hardware on HTTPS or localhost, and is MIT licensed. It has no dependency on machinery or creative. `StylizedToonPass` is not implemented yet.
