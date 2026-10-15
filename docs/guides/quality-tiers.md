# Quality tiers: one app that runs at 60 FPS on a laptop and looks its best on a fast PC

**Problem.** The same scene runs at 120 FPS on a desktop GPU, 40 FPS on a laptop's integrated GPU, and somewhere in
between on a phone. Guessing from the device name picks the wrong settings.

**Recipe.** Let `@margoengine/quality` measure the GPU and pick a tier, and let the feature packages scale themselves
from that tier's preset. Leave the cost options you want scaled unset; set the ones you want fixed.

```ts
import {Engine} from '@margoengine/core';
import {applyQualityTier, paceEngine, watchQuality} from '@margoengine/quality';
import {Shadows} from '@margoengine/shadows';
import {SSAO} from '@margoengine/post/ssao';

const tier = applyQualityTier();             // 'light' | 'high' | 'phone'; before the engine exists
const engine = await Engine.create(canvas, {backend: 'webgpu'});
paceEngine(engine);                          // light tier: a steady ~60 FPS instead of 120/40 swings

Shadows.attach(engine, {distance: 150});     // resolution from the tier: 1024 light/phone, 2048 full
SSAO.attach(engine, {radius: 0.5});          // samples from the tier: 16 light/phone, 32 full
engine.start();
watchQuality();                              // measures the light tier; a fast GPU gets the full tier next load
console.log(tier);
```

What each tier does:

- **Light** (desktops until measured fast; `?quality=low` forces it): 1x MSAA, pixel ratio 1, paced to ~60 FPS, and the
  light preset (smaller shadow maps, half the SSAO samples, SSR off, a coarser fog grid, smaller local shadow maps,
  100,000 particles by default). The full table is in the
  [`@margoengine/quality` README](../../packages/quality/README.md#tier-presets).
- **Full** (`'high'`; `?quality=high` forces it): 4x MSAA and every package's own defaults.
- **Phone** (user agent): 1x MSAA, pixel ratio up to 2, the light preset.

Keep a value on every tier by passing it:

```ts
import {Shadows} from '@margoengine/shadows';
import {SSR} from '@margoengine/post/ssr';

Shadows.attach(engine, {resolution: 2048});   // explicit options always win over the preset
SSR.attach(engine, {enabled: true});          // SSR stays on even on the light tier (its steps still come from the tier)
```

Read the preset for your own settings, for example a particle-count menu:

```ts
import {qualityPreset, QUALITY_PRESETS} from '@margoengine/quality';

const particles = qualityPreset().vfx?.capacity ?? 1_000_000;   // 100,000 on light/phone, 1,000,000 on full
const lightShadow = QUALITY_PRESETS.light.shadows?.resolution;  // 1024
console.log(particles, lightShadow);
```

Notes:

- Apps without `@margoengine/quality` are unaffected: the packages read `globalThis.margoPreset` only, which nothing
  else sets.
- The measured tier is stored in `localStorage.margoQuality`; `localStorage.removeItem('margoQuality')` measures again.
- Testing: `?quality=low|high` forces a tier without storing it; `?scale=1.5` raises the light tier's pixel ratio.
