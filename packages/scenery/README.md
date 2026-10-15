# @margoengine/scenery

A moonlit night sky for Margo Engine: twinkling stars, a phased moon with glow, and horizon haze. `SkyMoon` is a
preset of `Sky` from `@margoengine/sky` (Margo's one sky implementation) held at midnight with its stylized
`night` options. `stage.sky()` loads it.

In this workspace, `npm run modern:dev` opens the starter; click **Toggle moonlit scenery**.

Once the packages are on npm (not yet; build from source until then):

```sh
npm install @margoengine/core @margoengine/scenery
```

```ts
import {Engine} from '@margoengine/core';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const {SkyMoon} = await import('@margoengine/scenery/sky');
const sky = SkyMoon.attach(engine, {moonDirection: [0.45, 0, -1], moonPhase: 0.85});
engine.start();
sky.config.moonPhase = 0.2; // read every frame
```

`@margoengine/scenery/sky` and the root export `SkyMoon` and the `SkyMoonConfig` type (an alias of Sky's
`SkyNightOptions`). `SkyMoon.attach(engine, config)` is `engine.use(new SkyMoon(config))`, and `new SkyMoon(config)` is `new Sky({hours: 0, timeScale: 0, night: config}, {night})` from
`@margoengine/sky/base` with plugin name `sky-moon`: it loads only the stylized-night feature (about 6.6 kB min+gzip
summed over this entry, Sky's base and Sky's night, against 10.2 kB for the full Sky;
[entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)), so it is not an `instanceof` the root `Sky`, and options that need
other features (fog, clouds, a day model) throw; build a `Sky` with those features instead. `config` (also
`sky.options.night`) is read every frame, so change it in place for live controls. Remove it with
`engine.removePlugin('sky-moon')` or `sky.dispose()`.

The options, defaults and limits are Sky's stylized night (see the `@margoengine/sky` README): zenith and horizon
colours, `hazeDensity`, moon direction, angular size, phase, colour and glow, star intensity and twinkle. The sky
draws behind opaque geometry at reversed-Z depth 0, on canvas and HDR targets, with 1x or 4x sampling. Its
colours are written as given on both.

The low-level `SkyMoonPass` (`@margoengine/scenery/sky-moon`) and the Night Citadel's `NightAtmosphere` were
removed when the three sky implementations were merged into `@margoengine/sky`. Use `Sky` directly for custom
night skies, and Sky's `fog` (`falloff: 'exp'`, `height`, `color`) for the citadel's height haze.

This ESM package includes strict TypeScript declarations, requires core 0.1.0 and `@margoengine/sky`, and supported
WebGPU hardware on HTTPS or localhost. MIT licensed.
