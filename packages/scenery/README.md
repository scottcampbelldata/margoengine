# @margoengine/scenery

A moonlit night sky for Margo Engine: twinkling stars, a phased moon with glow, and horizon haze. `SkyMoon` is a
preset of `Sky` from `@margoengine/sky` (Margo's one sky implementation) held at midnight with its stylized
`night` options, so it composes with Sky's fog and water reflection. `stage.sky()` loads it.

In this workspace, `npm run modern:dev` opens the starter; click **Toggle moonlit scenery**.

```sh
npm install @margoengine/core @margoengine/scenery
```

```ts
import {Engine} from '@margoengine/core';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const {SkyMoon} = await import('@margoengine/scenery/sky');
const sky = new SkyMoon({moonDirection: [0.45, 0, -1], moonPhase: 0.85});
engine.use(sky);
engine.start();
sky.config.moonPhase = 0.2; // read every frame
```

`@margoengine/scenery/sky` and the root export `SkyMoon` and the `SkyMoonConfig` type (an alias of Sky's
`SkyNightOptions`). `new SkyMoon(config)` is `Sky({hours: 0, timeScale: 0, night: config})` with plugin name
`sky-moon`; `config` (also `sky.options.night`) is read every frame, so change it in place for live controls.
Remove it with `engine.removePlugin('sky-moon')` or `sky.dispose()`.

The options, defaults and limits are Sky's stylized night (see the `@margoengine/sky` README): zenith and horizon
colours, `hazeDensity`, moon direction, angular size, phase, colour and glow, star intensity and twinkle. The sky
draws behind opaque geometry at reversed-Z depth 0, on canvas and HDR targets, with 1x or 4x sampling. Its
colours are written as given on both.

The low-level `SkyMoonPass` (`@margoengine/scenery/sky-moon`) and the Night Citadel's `NightAtmosphere` were
removed when the three sky implementations were merged into `@margoengine/sky`. Use `Sky` directly for custom
night skies, and Sky's `fog` (`falloff: 'exp'`, `height`, `color`) for the citadel's height haze.

This ESM package includes strict TypeScript declarations, requires core 0.1.0 and `@margoengine/sky`, and supported
WebGPU hardware on HTTPS or localhost. MIT licensed.
