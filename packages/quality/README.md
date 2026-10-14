# @margoengine/quality

Measured quality tiers. Desktops start on a light tier (single-sampled, pixel ratio capped, held to about 60 FPS) and
time how long the GPU takes to finish each frame; a browser with clear headroom gets the full 4× MSAA tier from its next
page load. Slow PCs never show a slow phase or a reload, and no rule based on device names is involved.

```ts
import {applyQualityTier, watchQuality} from '@margoengine/quality';
import {Engine} from '@margoengine/core';

applyQualityTier();                       // before creating the engine
const engine = await Engine.create(canvas, {backend: 'webgpu'});
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
- `capFrameRate(rate)` is exported for apps that want the same steady pacing elsewhere.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/quality
