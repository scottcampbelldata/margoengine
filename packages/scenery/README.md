# @margoengine/scenery

Import `margoengine/scenery` from the `margoengine` package, or `@margoengine/scenery` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

A moonlit night sky for Margo Engine: twinkling stars, a phased moon with glow, and horizon haze. `SkyMoon` is a
preset of `Sky` from `@margoengine/sky` (Margo's one sky implementation) held at midnight with its stylized
`night` options. `addSky(stage)` (`@margoengine/stage/sky`) loads it.

In this workspace, `npm run modern:dev` opens the starter; click **Toggle moonlit scenery**.

Once the packages are on npm (not yet; build from source until then):

```sh
npm install @margoengine/core @margoengine/scenery
```

```ts
import {Engine} from 'margoengine/core';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const {SkyMoon} = await import('margoengine/scenery/sky');
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

## Day presets

`@margoengine/scenery/presets` holds four times of day, `noon`, `goldenHour`, `overcast` and `dawn`, as options for
`Sky` from `@margoengine/sky`, with the light that goes with each. The sun's colour and strength are not stored: the
sky works them out from its own air (`sunlight` in `@margoengine/sky`), so the light always matches the sky drawn.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {applyDayPreset, dayLight, dayPreset} from 'margoengine/scenery/presets';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const sky = Sky.attach(engine, dayPreset('goldenHour'));
engine.start();
applyDayPreset(sky, 'overcast'); // switch a running sky
console.log(dayLight('noon').intensity); // the sun strength the sky drives into the engine light
```

- `dayPreset(name)` returns fresh `SkyOptions`: the sun placed by `sunDirection` with the clock held
  (`timeScale: 0`), `turbidity`, a cloud sheet when the preset has cloud, the backdrop `exposure`, and `lighting`
  with the direct sun strength overhead and a diffuse floor (`ambient.day`, and `[0.01, 0.015, 0.03]` by night). Use the
  root `Sky`, which has the clouds and lighting features these need. Pass a name or a `DayPreset` object.
- `applyDayPreset(sky, name)` writes a preset into a running sky's `options` (read every frame), removes a cloud sheet
  the preset has none of and keeps the rest (fog, night, model).
- `dayLight(name)` is the sun the sky drives on the first frame (`direction`, `color` with its largest channel 1,
  `intensity`) and the diffuse floor, for a scene that lights itself.
- `DAY_PRESETS` holds the frozen values and `dayPresetNames` the names. Copy one to make your own:
  `dayPreset({...DAY_PRESETS.noon, elevation: 50})`. Unknown names and out-of-range values throw `RangeError`.

| Preset | Sun (azimuth, elevation) | Turbidity | Clouds | Sky exposure | Sun strength overhead | Sun it gives |
| --- | --- | --- | --- | --- | --- | --- |
| `noon` | 0 (south), 70 | 2.2 | none | 0 | 5 | 4.98, nearly white |
| `goldenHour` | 270 (west), 5 | 3 | 0.2 | +0.5 | 5 | 3.10, (1, 0.57, 0.14) |
| `overcast` | 20, 45 | 6 | 1 | -2.5 | 0.5 | 0.49, (1, 0.98, 0.91) |
| `dawn` | 90 (east), 1 | 2.6 | 0.1 | +1 | 5 | 1.39, (1, 0.23, 0.005) |

Azimuth 0 is +Z, 90 is +X, as `@margoengine/sky/sun`. Overcast follows the CIE standard overcast sky: the cloud hides
the sun's disc, and its sky is 2.5 stops darker, which also dims the light the sky gives the scene, so its ground gets
about a fifth of the clear noon ground's light (measured on a Radeon 680M; daylight measurements give about 10 to 25 klux
against about 100 klux). These are looks, not a measured site: the cloud sheet is the sky's 2D sheet and nothing casts
cloud shadows; scene exposure is `Tonemap`'s (`@margoengine/tonemap`).

## Scene presets

`@margoengine/scenery/scenes` attaches a whole look in one call: a day preset's sky, sun and sky light, fog, bloom
and a display grade.

```ts
import {Engine} from 'margoengine/core';
import {PresetScene} from 'margoengine/scenery/scenes';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const scene = PresetScene.attach(engine, 'goldenHour');
engine.start();
scene.set('overcast'); // switch everything at once
scene.tonemap.options.autoExposure = true; // or fine-tune a part
scene.dispose(); // removes the sky and the post stack (or attach with `using`)
```

`PresetScene.attach(engine, name)` adds `sky` (the root `Sky` from `@margoengine/sky`, with `dayPreset(name)` and
sky fog over the scene depth) and `post`, a `PostStack` from `@margoengine/post/stack` of `bloom` (`Bloom`) and
`tonemap` (`Tonemap` from `@margoengine/tonemap`); the fog reads the stack's depth. Every value sits on the parts'
own `options`, read every frame. `set(name)` switches sky, light, fog, bloom and grade without re-creating anything;
`dispose()` (or `using`) removes both plugins. Pass a name or a `ScenePreset` object; `SCENE_PRESETS` holds the
frozen values and `scenePresetNames` the names (those of the day presets). Unknown names and out-of-range values
throw `RangeError` before anything is attached; `set` after `dispose` throws `MargoError` `'disposed'`. WebGPU only.

| Preset | Fog (visibility) | Bloom strength, threshold | Exposure | Contrast | White balance | Vignette |
| --- | --- | --- | --- | --- | --- | --- |
| `noon` | 20 km | 0.03, 1.5 | 0 | 1 | 6500 K | 0 |
| `goldenHour` | 10 km | 0.08, 1 | +1.5 | 1.05 | 7200 K (warmer) | 0.15 |
| `overcast` | 2 km | 0.02, 1.5 | +2.3 | 0.95 | 6500 K | 0 |
| `dawn` | 600 m (mist) | 0.06, 1 | +2.5 | 1 | 6000 K (cooler) | 0.15 |

The fog is exponential from the camera, density 3.912 / visibility (the distance where an object fades to 2%
contrast); the exposure brings each scene's lit ground back near noon's on screen. The fog takes the clear sky's
colour in each direction, so under overcast a far object fades a little bluer than the cloud above it.

This ESM package includes strict TypeScript declarations, requires core 1.0.0 and `@margoengine/sky` (the scenes entry also `@margoengine/post` and `@margoengine/tonemap`), and supported
WebGPU hardware on HTTPS or localhost. Apache-2.0 licensed.
