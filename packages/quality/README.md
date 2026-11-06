# @margoengine/quality

Import `margoengine/quality` from the `margoengine` package, or `@margoengine/quality` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Measured quality tiers. Desktops start on a light tier (single-sampled, pixel ratio capped, paced to an even rate of at
least 60 FPS) and read the real GPU time of each frame by timestamp queries; a page under the limit gets the full 4× MSAA tier
from its next load. No PC is first shown the 4× tier or reloaded by the probe (the light tier's own frame rate depends on
the GPU), and no rule based on device names is involved.

```ts
import {applyQualityTier, paceEngine, watchQuality} from 'margoengine/quality';
import {Engine} from 'margoengine/core';

applyQualityTier();                       // before creating the engine
const engine = await Engine.create(canvas, {backend: 'webgpu'});
paceEngine(engine);                       // light tier: an even rate of at least 60 FPS
// ...build the scene and start rendering, then:
watchQuality();
```

- `applyQualityTier()` returns `'light'`, `'high'` or `'phone'`. Phones are single-sampled with the pixel ratio capped
  at 1 (`globalThis.margoLow = 1`), even with `?quality=high` or `?scale=2`. It sets core's `globalThis.margoLow`, which
  core reads when it builds pipelines and sizes the canvas, so it must run before the engine is created.
- `watchQuality()` reads 120 frames on the light tier and, when the 90th percentile of the time a frame's GPU passes cover (passes that run side by side count once) is under
  `FAST_GPU_MS` (8 ms), remembers `'high'` for this page in `localStorage['margoQuality:' + location.pathname]`. One key
  per page, because the result says what this page's scene costs: a light scene must not mark a weak PC high for a heavy
  one. A slow reading remembers nothing, so one bad session cannot hold a browser on the light tier: the next load
  measures again. On the full tier, five consecutive seconds under 55 FPS remember that for good (`'held'`) and reload
  once (a machine that slowed down, for example on battery).
- Timestamps: `applyQualityTier()` adds `timestamp-query` to the devices this page asks for, only while the page is still
  to be measured, until `watchQuality()` starts. The reading is its own small chunk, downloaded only by a page that reads. During the reading (about 4 s at 60 FPS, 10 s at most) `submit` and
  `createCommandEncoder` are wrapped and every pass gets timestamp writes; then all of it is put back and its GPU objects
  destroyed, so nothing runs after the reading. Without `timestamp-query` the page stays light and stores nothing. A frame
  whose passes the page times itself is not counted. Copies between passes, presenting and other work between passes are
  not in the number.
- `onReading(milliseconds)` on `watchQuality` reports the reading when it ends, undefined when there is none.
- For testing: `?quality=high` or `?quality=low` forces a tier without remembering it; `?scale=1.5` sets the light
  tier's pixel ratio (1 to 2). `localStorage.removeItem('margoQuality:' + location.pathname)` measures again.
- `paceEngine(engine)` sets core's `engine.pace` hook on the light tier so `engine.start()` renders at an even rate of
  at least 60 FPS instead of swinging between 120 and 40 FPS on a slow GPU. Each frame spans the most whole refreshes that
  still reach 60, so the rate depends on the display:

  | Display | 60 Hz | 75 Hz | 90 Hz | 100 Hz | 120 Hz | 144 Hz | 165 Hz | 200 Hz | 240 Hz |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | Frames per second | 60 | 75 | 90 | 100 | 60 | 72 | 83 | 67 | 60 |

  Other tiers stay uncapped. Nothing global is patched: other `requestAnimationFrame` loops on the page run at the display
  rate. An app that renders from its own loop (calling `engine.render` itself) can gate it with `frameDue`.
- `capFrameRate(engine, rate = 60)` sets the same pacing on any engine regardless of tier. It reads the display's refresh
  from the last 16 callback gaps, so it follows a page moved to another display within 16 frames.
- The light-tier reading skips the first two seconds and gives up after ten, at any refresh rate.

## Dynamic resolution

```ts
import {applyQualityTier, watchResolution} from 'margoengine/quality';
import {Engine} from 'margoengine/core';
declare const canvas: HTMLCanvasElement;
applyQualityTier(); // light or phone tier
const engine = await Engine.create(canvas, {backend: 'webgpu'});
using resolution = watchResolution({budget: 12, min: 0.6}); // restores full resolution when disposed
console.log(resolution.scale);
```

`watchResolution` times each frame's GPU work (submit to finished) and, when the average passes `budget` milliseconds
(default 12), lowers the canvas pixel ratio in 5% steps sized to land under the budget; with room to spare (under 70% of
it) it rises 5% at a time, and backs off after a rise it had to undo. It moves `globalThis.margoLow`, which core reads every
frame, so it works on the light and phone tiers. On the full 4x MSAA tier it does nothing (changing the cap there would
also switch off multisampling); pass your own `apply(scale)` to scale some other way. `ResolutionScaler` is the same
decision logic without timers: `push(frameMs)` returns the new scale when it changes.

## Feature scaling

Resolution is one way down. `@margoengine/quality/features` lowers what the frame actually pays for, in steps it measures.

```ts
import {Engine} from 'margoengine/core';
import {SSAO} from 'margoengine/post/ssao';
import {Shadows} from 'margoengine/shadows';
import {featureKnobs, optionKnob, watchFeatures} from 'margoengine/quality/features';
import {TAAUpscale} from 'margoengine/taa/upscale';
declare const canvas: HTMLCanvasElement;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const shadows = Shadows.attach(engine, {distance: 120});
const ssao = SSAO.attach(engine);
const upscale = TAAUpscale.attach(engine, {scale: 1});

using features = watchFeatures(
  [
    ...featureKnobs({ssao, shadows, camera: engine.camera}),
    optionKnob('resolution', upscale.options, 'scale', [1, 0.85, 0.7], 2), // anything that reads an option live
  ],
  {budget: 12, onChange: ({name, level}) => console.log(name, level)},
);
console.log(features.scaler.levels, features.scaler.costs);
```

Over `budget` it takes one step, then compares the frame cost before and after. A step that saved under 3% of the frame
is given back at once and rests for 120 decisions, so nothing is lost for no gain. Once a step is measured it is
chosen by its measured saving: of the steps that cover the shortfall the least visible goes first (`weight`), and with
none known to cover it the next untried step is tried, in the knobs' order. Under 70% of the budget the most visible lowered feature
comes back, if its measured cost still leaves the frame under 90%; a rise that had to be undone doubles the wait, as in
`ResolutionScaler`. `dispose()` puts every feature back.

| `featureKnobs` key | Steps | Weight |
| --- | --- | --- |
| `post` | each effect's `enabled` goes false | 1 |
| `ssao` | `samples` halve twice, then `enabled` false | 1 |
| `ssr` | `steps` halve twice, then `enabled` false | 1 |
| `shadows` | `filter` soft, pcf, hard; a set `distance` to 70% and 50% | 1.5 |
| `lod` | `bias` 1.5 and 2 times | 2 |
| `camera` | `far` to 75% and 50%; what lies past it stops drawing, so pair it with fog | 3 |

Each starts from the value the app set, and a feature already off gets no knob. A knob is `{name, levels, apply(level), weight}`,
so anything can be one. `FeatureScaler` is the same logic without timers: `push(frameMs)` returns the change it made,
`budget` can be set at any time, and `restart()` drops the running measure after a change it did not make, such as a new
scene. Options: `budget` 12, `window` 30, `settle` 8 (samples ignored after a change), `minSaving` 0.03.

A first change of shadow filter compiles shader variants, so that frame hitches once; `settle` keeps it out of the
measure. Options that only apply at construction (shadow `resolution`, `cascades`, `VolumetricFog` on or off) cannot be
knobs: they are what the tier presets below set.

## Battery and heat

`@margoengine/quality/power` eases off when the machine is on battery or running hot.

```ts
import {Engine} from 'margoengine/core';
import {applyQualityTier, paceEngine} from 'margoengine/quality';
import {watchFeatures, featureKnobs} from 'margoengine/quality/features';
import {watchPower} from 'margoengine/quality/power';
declare const canvas: HTMLCanvasElement;
applyQualityTier();
const engine = await Engine.create(canvas, {backend: 'webgpu'});
paceEngine(engine);
using features = watchFeatures(featureKnobs({camera: engine.camera}));
using power = watchPower({
  engine,                                  // capped while easing off, its own pace back after
  features: features.scaler,               // budget cut while easing off
  onChange: ({level, charging, battery, pressure, hot}) => console.log(level, charging, battery, pressure, hot),
});
console.log(power.reading.level);
```

| Level | When | Frame cap (`rates`) | Budget (`budgets`) |
| --- | --- | --- | --- |
| 0 | On mains, or the browser does not say | The engine's own | Full |
| 1 | On battery | 60 | 75% |
| 2 | Hot, CPU pressure `serious` or `critical`, or battery at `lowBattery` (20%) or under | 30 | 50% |

- Battery comes from `navigator.getBattery` and CPU pressure from `PressureObserver`, where the browser has them. A
  browser that has neither still gets the frame time reading. A source that refuses is left out; the others keep working.
- Heat is read from frame times by `FrameDrift`: a GPU that throttles slows gradually, so the median frame cost creeps
  25% over the coolest reading with no step above 15% between five-second readings, and stays there for six of them. A
  new view or level moves the cost in one step and starts the measure over. Once hot it stays hot for 60 readings (five
  minutes) or until the cost creeps back, because easing off lowers the cost by itself. Options: `window` 300, `rise`
  1.25, `readings` 6, `jump` 0.15, `hold` 60. `power.restart()` forgets the measure after a change you know of.
- The full tier cannot change while running (4x multisampling is built into the pipelines). On it, leaving level 0 sets
  this tab's next load to the light tier, in sessionStorage, keeping what the page measured; back at level 0 the next load
  is full again. The page is not reloaded unless you ask: pass `reload: () => location.reload()` to change tier at once.
  `?quality=high` still wins. `currentTier()` from the root entry reads the tier.

## Tier presets

The tier also scales optional features. `applyQualityTier()` publishes the tier's `QualityPreset` as
`globalThis.margoPreset`; each feature package below reads its key when an effect is constructed (`X.attach` or
`new X`) and uses a preset value only for an option the app left undefined. **Explicit options always win.** Feature
packages never import this package: the global is the whole contract, so an app that does not use
`@margoengine/quality` gets every package's own defaults, unchanged.

| Key | Package, class | Option | Full tier (package default) | Light tier | Phone tier |
| --- | --- | --- | --- | --- | --- |
| `shadows` | `@margoengine/shadows` `Shadows` | `resolution`, `filter`, `cascades` | 2048 (two 4-layer maps, 128 MiB), `'soft'` (PCSS), 4 | 1024 (32 MiB), `'pcf'`, 4 | 1024 (16 MiB), `'pcf'`, 2 |
| `ssao` | `@margoengine/post/ssao` `SSAO` | `enabled`, `samples` | on, 32 | on, 16 | off |
| `ssr` | `@margoengine/post/ssr` `SSR` | `enabled`, `steps` | on, 64 | off, 32 | off, 32 |
| `volumetric` | `@margoengine/environment/volumetric` `VolumetricFog` | `enabled`, `grid` | on, [160, 90, 64] | on, [80, 45, 32] | off |
| `localShadows` | `@margoengine/clustered/shadows` `LocalShadows` | `resolution` | 512 | 256 | 256 |
| `vfx` | `@margoengine/vfx` `VFX` | `capacity` | 1,000,000 | 100,000 | 100,000 |
| `scatter` | `@margoengine/scatter` `Scatter` | `lodFade` | 2 | 2 | 0 |

The phone preset publishes `ssao: { enabled: false }` and `volumetric: { enabled: false }`. Disabled `VolumetricFog`
registers no passes; omitting `enabled` keeps it on. Explicit feature options still win over preset defaults.

Shadows on the light and phone tiers use `filter: 'pcf'`: four hardware comparison taps per lit pixel instead of PCSS's
16 blocker reads and 32 taps (a fixed edge about three texels wide instead of contact-hardening penumbrae). Phones also
render two cascades instead of four (half the depth passes) and set scatter's `lodFade: 0`, which compiles its shaders
without `discard`: tile-based phone GPUs then keep early depth rejection under dense grass. Pass `filter: 'soft'`,
`cascades: 4` or `lodFade: 2` to keep those on every tier.

```ts
import {applyQualityTier, qualityPreset} from 'margoengine/quality';
import {Shadows} from 'margoengine/shadows';

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
import {warmUp} from 'margoengine/quality/warm';
import {redrawAfterRestore} from 'margoengine/quality';

// ...attach features and build the scene, then, still behind the loading screen:
const report = await warmUp(engine);      // {pipelines, fallbacks, rounds, rebooted}
// Options: {frames: 2, maxRounds: 256, signal}; pass an AbortSignal to cancel (rejects with signal.reason).
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
  `examples/package-benchmarks/results/warm-up-gpu.json`): see the table there.

## Supersampling: stills and screenshots

```ts
import {Engine} from 'margoengine/core';
import {supersample, supersampleBlob} from 'margoengine/quality/ssaa';
declare const canvas: HTMLCanvasElement;
const engine = await Engine.create(canvas, {backend: 'webgpu'});

const image = await supersample(engine, {samples: 16});
// image.width, image.height, image.data: RGBA bytes, top row first
const pixels = new ImageData(image.data, image.width, image.height);
console.log(pixels.width);

const poster = await supersampleBlob(engine, {samples: 64, width: 3840, height: 2160});
const link = URL.createObjectURL(poster); // PNG; pass type and quality for another format
console.log(link);
```

`supersample` renders `samples` whole frames, each moved by a fraction of a pixel along a Halton (2, 3) sequence, and
averages them in linear light in 32-bit floats. Every edge, thin line, shadow boundary and shader highlight gets that
many samples per pixel, which MSAA alone does not give. It works on every tier and at 4x MSAA it multiplies.

| Option | Default | Meaning |
| --- | --- | --- |
| `samples` | `16` | Frames averaged, 1 to 1024. Each costs one render; memory does not grow with it |
| `width`, `height` | canvas size | Picture size, up to the device's texture limit. Larger than the canvas works |
| `camera` | `engine.camera` | Camera to shoot through |
| `signal` | none | Rejects with `signal.reason`, checked every 4 frames and after the read |

Time stands still during a still (delta 0) and the same call gives the same picture. The engine's own loop keeps
running between batches and never sees the moved camera; the canvas ends on an ordinary frame. Effects with history
(`TAA`) run in the still and soften it: remove them first for the sharpest picture. `TAAUpscale` and other effects that
refuse views (`c.view`) throw. Measured on `packages/quality/test/ssaa-browser.mjs`: 64 samples read 45.3 dB against the
same scene drawn 8 times larger and box-filtered, a plain frame 26.1 dB (single-sampled, 160 x 120).

For live frames rather than stills, `@margoengine/taa/upscale` renders below output size and rebuilds the full frame
with Lanczos and sharpening or from jittered history.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/quality
