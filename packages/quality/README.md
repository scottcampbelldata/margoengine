# @margoengine/quality

Measured quality tiers. Desktops start on a light tier (single-sampled, pixel ratio capped, paced to at most about
60 FPS) and time how long the GPU takes to finish each frame; a browser with clear headroom gets the full 4× MSAA tier
from its next page load. No PC is first shown the 4× tier or reloaded by the probe (the light tier's own frame rate
depends on the GPU), and no rule based on device names is involved.

```ts
import {applyQualityTier, paceEngine, watchQuality} from '@margoengine/quality';
import {Engine} from '@margoengine/core';

applyQualityTier();                       // before creating the engine
const engine = await Engine.create(canvas, {backend: 'webgpu'});
paceEngine(engine);                       // light tier: about 60 FPS
// ...build the scene and start rendering, then:
watchQuality();
```

- `applyQualityTier()` returns `'light'`, `'high'` or `'phone'`. Phones keep core's own path (single-sampled, pixel
  ratio up to 2). It sets core's `globalThis.margoLow`, which core reads when it builds pipelines and sizes the canvas,
  so it must run before the engine is created.
- `watchQuality()` measures on the light tier and remembers `'high'` or `'low'` in `localStorage.margoQuality`. On the
  full tier, five consecutive seconds under 55 FPS remember `'low'` and reload once (a machine that slowed down, for
  example on battery).
- For testing: `?quality=high` or `?quality=low` forces a tier without remembering it; `?scale=1.5` sets the light
  tier's pixel ratio (1 to 2). `localStorage.removeItem('margoQuality')` measures again.
- `paceEngine(engine)` sets core's `engine.pace` hook on the light tier so `engine.start()` renders about 60 FPS
  (every other refresh at 120 Hz, 72 FPS at 144 Hz) instead of swinging between 120 and 40 FPS on a slow GPU. Other
  tiers stay uncapped. Nothing global is patched: other `requestAnimationFrame` loops on the page run at the display
  rate. An app that renders from its own loop (calling `engine.render` itself) can gate it with `frameDue`.
- `capFrameRate(engine, rate = 60)` sets the same pacing on any engine regardless of tier.
- The light-tier measurement skips the first two seconds and gives up after ten, at any refresh rate.

## Tier presets

The tier also scales optional features. `applyQualityTier()` publishes the tier's `QualityPreset` as
`globalThis.margoPreset`; each feature package below reads its key when an effect is constructed (`X.attach` or
`new X`) and uses a preset value only for an option the app left undefined. **Explicit options always win.** Feature
packages never import this package: the global is the whole contract, so an app that does not use
`@margoengine/quality` gets every package's own defaults, unchanged.

| Key | Package, class | Option | Full tier (package default) | Light and phone tiers |
| --- | --- | --- | --- | --- |
| `shadows` | `@margoengine/shadows` `Shadows` | `resolution` | 2048 (two 4-layer maps, 128 MiB) | 1024 (32 MiB) |
| `ssao` | `@margoengine/post/ssao` `SSAO` | `samples` | 32 | 16 |
| `ssr` | `@margoengine/post/ssr` `SSR` | `enabled`, `steps` | on, 64 | off (pass `enabled: true` to keep it), 32 |
| `volumetric` | `@margoengine/environment/volumetric` `VolumetricFog` | `grid` | [160, 90, 64] | [80, 45, 32] |
| `localShadows` | `@margoengine/clustered/shadows` `LocalShadows` | `resolution` | 512 | 256 |
| `vfx` | `@margoengine/vfx` `VFX` | `capacity` | 1,000,000 | 100,000 |

```ts
import {applyQualityTier, qualityPreset} from '@margoengine/quality';
import {Shadows} from '@margoengine/shadows';

applyQualityTier();                                  // light tier: margoPreset.shadows = {resolution: 1024}
const shadows = Shadows.attach(engine, {distance: 120});              // 1024 on light, 2048 on the full tier
const crisp = Shadows.attach(engine, {distance: 120, resolution: 2048}); // explicit: 2048 on every tier
const particles = qualityPreset().vfx?.capacity ?? 1_000_000;          // read a value for your own UI
```

- `QUALITY_PRESETS` holds the table above (`high` is empty: package defaults). `qualityPreset()` returns this page's.
- The preset is read once per effect, at construction; changing tier means a new page load, as before.
- With a preset the effect's `options` is a copy (the app's object is not modified); edit `effect.options`, not the
  object you passed, to change a value later. Without a preset `effect.options` is the object you passed.
- `VFX`: an explicit `initialCount` larger than the preset capacity keeps the default capacity (the app asked for that
  many particles). `burst(n)` above the preset capacity throws as it always did above `capacity`; pass `capacity`
  explicitly if your app bursts more than 100,000 particles on the light tier.
- Bloom, FXAA, Tonemap, TAA and culling have no tier preset: none has an option that trades quality for GPU time.
  DOF has none either: `maxRadius` 8 instead of 16 measured no GPU saving on the light tier (its 64 taps are fixed)
  and only shrank the blur (`examples/package-benchmarks/results/tier-presets-light-diagnostic.json`).
- Contract tests: `test/quality.test.js` (writer) and `tests/quality-presets.test.js` (every reader). GPU-call proof
  (no preset: identical calls to before; preset = passing its values; explicit options win):
  `node examples/package-benchmarks/proofs/quality-presets.proof.js`.

## Pipeline warm-up and device restoration

```ts
import {warmUp} from '@margoengine/quality/warm';
import {redrawAfterRestore} from '@margoengine/quality';

// ...attach features and build the scene, then, still behind the loading screen:
const report = await warmUp(engine);      // {pipelines, fallbacks, rounds, rebooted}
engine.start();
redrawAfterRestore(engine, () => engine.render({delta: 0})); // only for apps that render on demand
```

- `warmUp(engine)` creates the pipelines of every attached feature with `createRenderPipelineAsync` /
  `createComputePipelineAsync`, so the first visible frame that draws a feature does not stall on shader compilation.
  Features create pipelines lazily inside their passes, so it renders warm frames (delta 0) into an offscreen texture:
  a frame that reaches a missing pipeline is stopped there, the work it already encoded is submitted, the pipeline
  compiles asynchronously, and the frame is rendered again until two complete. Nothing is presented and frames from the
  engine's own loop are untouched. It resolves once the GPU has finished the warm frames, so pipelines a feature made
  synchronously at attach (GrassField does) have compiled by then too, during loading but not in parallel. A feature that stores state before creating its pipeline (so the retry skips the
  creation) fails on the retry; warmUp then restores the device (`engine.rebootDevice()`, every feature's restore hook)
  and finishes with synchronous creation (`report.rebooted`). A feature attached later or switched off is not warmed:
  call `warmUp` again after attaching it. Zero cost unless imported: no package reads it.
- `redrawAfterRestore(engine, render)`: core restores a lost GPU device by itself and the engine's loop draws the next
  frame, but an app that renders on demand (paused, loop stopped) shows an empty canvas until it renders again. This
  runs `render` on the two frames after every restoration (effects that read the previous frame, such as water
  refraction and sky reflections, settle on the second).
- First-use hitch per feature (`node examples/package-benchmarks/warm-up-gpu.mjs`, results
  `examples/package-benchmarks/results/warm-up-gpu.json`): see the table there and in docs/HANDOFF.md 5i.c.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/quality
