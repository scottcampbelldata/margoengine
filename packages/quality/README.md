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

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/quality
