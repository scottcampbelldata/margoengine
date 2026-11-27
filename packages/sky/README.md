# @margoengine/sky

Import `margoengine/sky` from the `margoengine` package, or `@margoengine/sky` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

WebGPU atmospheric background with an analytical Preetham/Perez daytime sky and an Earth-based Bruneton-style precomputed Rayleigh/Mie model, an optional stylized night (stars, phased moon) and distance or height fog, plus optional weather (rain, snow, lightning and thunder timing). This is Margo's one sky: `SkyMoon` (`@margoengine/sky/night-preset`) is a midnight preset of it. The package also holds
the day presets, preset scenes, scene kits, the Milky Way, the aurora and a textured moon, each an entry of its own.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {model: 'bruneton', hours: 12, timeScale: 1 / 3600});
sky.options.hours = 18;
```

## Load only what you use

`Sky` from `@margoengine/sky` carries every feature. To ship less, build the same class from
`@margoengine/sky/base` and pass only the feature entries the scene uses as the second argument:

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky/base';
import {bruneton} from 'margoengine/sky/bruneton';
import {clouds} from 'margoengine/sky/clouds';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {model: 'bruneton', clouds: {coverage: 0.4}}, {bruneton, clouds});
```

| Entry | Enables | min+gzip, entry alone |
| --- | --- | --- |
| `@margoengine/sky/base` | clock, sun/moon discs, transmittance, default night gradient, `lights`, `nightFactor` | 7.3 kB |
| `/preetham` | Preetham day model (the default `model`) | 0.7 kB |
| `/bruneton` | Bruneton day model and its precomputed tables (about 1.8 MB of GPU memory), `groundAlbedo` | 3.5 kB |
| `/clouds` | `clouds` | 2.2 kB |
| `/night` | stylized `night` (stars, phased moon) | 2.4 kB |
| `/fog` | `fog` | 2.3 kB |
| `/reflection` | `reflectionTexture` | 1.1 kB |
| `/lighting` | `lighting` (engine sun/moon light, ambient) | 3.9 kB |
| `/look` | `look` and `atmosphere`: sky colour, air, sun disc and cloud controls, read each frame | 2.5 kB |
| `/settings` | `SKY_SETTINGS`, `applySkySettings`, `SKY_LOOKS`: every control as a table for sliders, and named looks (not a `Sky` feature) | 3.5 kB |
| `/sun` | typed angles, `setSun` / `setAmbient` over core's light, `sunlitSky`, `sunPath` (not a `Sky` feature) | 2.1 kB |
| `/ephemeris` | heliocentric planets, the Moon's longitude, Julian Days, calendar ticks: pure maths (not a `Sky` feature) | 2.0 kB |
| `/weather` | `Weather`, its own plugin (not a `Sky` feature): rain, snow, sleet, lightning, thunder timing | 6.0 kB |
| `/volumetric-clouds` | `VolumetricClouds`, its own plugin: ray-marched 3D clouds you can fly through (a hurricane's code loads only when a layer draws one) | 7.9 kB |
| `/cloud-shadows` | `volumetricCloudShadows`, a shadow effect for `@margoengine/shadows` | 3.2 kB |
| `/aerial` | `AerialPerspective`, its own plugin: distant surfaces take the air's colour | 6.9 kB |
| `/hillaire` | `HillaireSky`, its own plugin: a physical sky with ozone and an HDR environment bake | 11.1 kB |
| `/hurricane` | `Hurricane`: Holland wind and pressure, eye, eyewall, bands, rain and weather of a tropical cyclone; its cloud shaders load by `import()` when clouds draw it (4.4 kB, billed only then) | 2.6 kB |
| `/shafts` | `LightShafts`, its own plugin: god rays past geometry and through cloud gaps | 7.0 kB |
| `/presets` | `EARTH`, `MARS` and `marsAtmosphere` for the Hillaire entries (not a `Sky` feature) | 1.6 kB |
| `/astro` | `AstroSky`, its own plugin: the real sun, moon, planets and catalogue stars for a date and place | 9.6 kB |
| `/weather-fx` | `WeatherFX`, its own plugin: no rain under roofs, splashes, a wet lens | 5.4 kB |

Each entry is compressed on its own ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)),
so sums overstate a combined bundle: the root `Sky` is 18.1 kB with all of them, against 23.0 kB
summed. `addSky(stage)` (base, night) sums to about 9.7 kB and a night scene with fog and reflection (base, night, fog, reflection) to about 13.1 kB. Recorded traces (`test/fixtures/traces.json`) pin the root `Sky`'s GPU work, WGSL and uploads; with fewer features,
the shaders leave out the unused functions and branches, and the GPU work, uploads and rendered pixels are the
same as the root's for that configuration (`test/split.test.js`, and on a real GPU `test/browser-check.mjs`).
An option or `model` whose feature is missing throws a `TypeError` naming the entry to import. Without a day model
(neither `preetham` nor `bruneton`) the sky is night-only: `onPreUpdate` throws if the clock brings the sun up.
`model` still defaults to `'preetham'`, so a Bruneton-only sky must set `model: 'bruneton'`.

The procedural sun and moon use prominent stylized discs (angular radii 0.014
and 0.018 radians), bright HDR cores and localized soft halos. Disc edges are
filtered by pixel footprint, including the coarse borrowed sky reflection.
Atmospheric transmittance tints the sun; clouds continue to occlude both bodies.
The moon uses a lower radiance and tighter halo to keep its antialiased limb
readable through HDR bloom. Moon appearance follows the optional moon lighting
described below; caller exposure and bloom strength still affect its glow.

Set `clouds: {coverage: 0.45, speed: 8, height: 1500}` for an optional animated
procedural cloud layer. Coverage is 0-1, speed is signed world meters per second
along a fixed XZ wind direction, and height is 100-10,000 world meters. Defaults
are 0.45, 8 and 1500; omitting `clouds` disables the layer. The layer is a curved
shell at that height around the planet (radius 6,360 km), so clouds reach the
horizon and only the ground hides them; they fade by distance into the haze (half
strength at 28 km), not by angle. Four octaves of value noise on an integer hash
(pcg2d, Jarzynski and Olano 2020: no precision loss on phone GPUs), each turned 37°,
give the shape; coverage remaps it (Schneider 2015) and the fine octaves erode the
edges. Fine octaves fade to their mean once a pixel covers them. Each element's
optical depth grows as its depth to the 5/3, as an adiabatic cloud's does (liquid
water rising linearly above the base; Brenguier et al. 2000), so an element thins
smoothly to its rim and shades in its thick middle rather than reading as a flat,
hard-edged stain. Below 80 percent the sheet is broken cloud by definition, with
blue between the elements; for an even pale grey deck set `coverage` to 0.8 or
more. The element's own depth and three samples
toward the sun through the layer give Beer-Lambert self-shadowing with a powder
term, lit by the sun's transmittance colour with a two-lobe Henyey-Greenstein phase
(Hillaire 2016); the surrounding sky lights them as ambient, and the lighting moon
by night. A sky pixel evaluates at most ten noise lookups (four for the shape and
erosion, six for the sun samples), two where the sky is clear, and no
texture reads. The visible sky, water's reflection and the lighting environment use
the same cloud field and clock, with filtering matched to each target's resolution.
`sky.cloudLayer` gives the layer's noise and clock to what must match it: `cloudShadows(sky)` from

From 80 to 100 percent `coverage` the sheet closes into an overcast deck (`depth`, the deck's optical depth, 1 to
200, default 20, a stratus deck). Under a full overcast the sky is one even grey with no holes and no sun disc: the CIE
standard overcast sky (Moon and Spencer 1942; CIE S 011/E:2003 type 1), L(h) = Lz (1 + 2 sin h) / 3, of the
two-stream light the deck passes, T = 1 / (1 + 0.075 depth) of the light on its top (Meador and Weaver 1980; Bohren
1987), so level ground under it gets T of the light above. The light on its top is the sun on level ground plus the
clear sky's own light there, integrated from the sky model (`clearSkyLevel`, 15 directions), so under a low sun the
deck, the ambient it gives and the fog under it stay daylight grey instead of the sun's orange (Henderson and Hodgkiss
1963; Hernandez-Andres et al. 2001). The sheet's shape octaves shade it within 12 percent, a
stratus base's soft undulations, fading into the haze with distance. The engine's sun fades out with the deck (no
direct light under a full overcast) and the ground is lit by the sky's own picture. `overcastDeck` from
`@margoengine/sky/clouds` is the deck's radiance on the CPU; the `clouds.depth` slider row sets the depth.

```ts
import {Engine} from '@margoengine/core';
import {Sky} from '@margoengine/sky';
import {overcastDeck} from '@margoengine/sky/clouds';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});

const sky = Sky.attach(engine, {hours: 11, clouds: {coverage: 1, depth: 30}});
// The zenith of the deck under a sun 45 degrees up, per unit of the clouds' sun, the sun's share only: about 0.62.
console.log(overcastDeck([1, 1, 1], Math.SQRT1_2, 1, 30));
// With a clear sky of E / pi 0.3 grey-blue on its top as well (clearSkyLevel gives it from any radiance function):
console.log(overcastDeck([1, 1, 1], Math.SQRT1_2, 1, 30, 1, [0.25, 0.3, 0.4]));
```
`@margoengine/shadows/light-function` darkens the ground under these clouds. For clouds you can fly through, see [Volumetric clouds](#volumetric-clouds).

timeScale is clock hours per real second. Sun direction is exposed in the reused sun buffer. The sky draws only where the reversed-Z scene depth is clear. Bruneton precomputation includes transmittance, single scattering, scattering density and orders 2..4, cached until turbidity or `groundAlbedo` changes. Tables interpolate four dimensions (radius, view zenith, sun zenith, view/sun angle), with 8 x 32 x 16 x 8 samples; angular and ray integration use 32 samples. Camera Y is meters above Earth; atmosphere math is kilometers.

The default Preetham model computes the shared sun transmittance table. Scattering
tables are computed when Bruneton is first rendered, including after a model
switch or device restoration; changes to turbidity refresh the tables each model uses.
The shaders call only the model in use, so editing `sky.options.model` live compiles the sky, fog, reflection and
lighting shaders again on the next frame (one compile per switch; `reflectionTexture` and the lighting resources
stay the same objects). Steady frames compile nothing. A branch between the two models let Apple's compile under
WebKit round the sky one half-float step apart from `sky/base`.

`reflectionTexture` exposes a borrowed 64 × 32 linear HDR equirectangular environment
for optional water reflection. Reading the getter enables its GPU refresh on
subsequent frames; it uses the existing atmospheric tables. The texture changes
on device restoration and must not be destroyed by its consumer.

`sky.lights` exposes two retained sun/moon records updated before rendering. Each
holds `direction` (XYZ plus intensity) and RGB `radiance`. Pass these to
`Water.attach(engine, {lights: sky.lights})` for separate reflection paths during
dusk. The engine's single light (sun or moon) still drives scene lighting and shadows.
With no `lighting` options, both direct reflection intensities are zero.
The moon record, the moon disc, its glow, the cloud lighting and the engine's night light follow
`night.moonDirection` when it is set (so `AstroSky` lights the scene from its real moon). A night without one
lights from the night's own default moon ([0.4, 0.7, 0.5]), the one it draws; with no night set the lighting moon
keeps its fixed default direction ([-0.3, 0.22, -1]).

The sun's colour and strength come from the atmosphere's own transmittance: `color`
and `intensity` hold for the sun overhead, and lower down the light passes through
more air, warming and dimming it (at 17:34 with turbidity 3.2 the sun is at about
69% strength, with green at 64% and blue at 21% of red). Surfaces add their own N·L,
so there is no further elevation factor. `sunlight(mu, altitude, turbidity)` returns
that colour for any sun elevation. `sunset` is deprecated and ignored.

### Ground albedo: snow fields and deserts

With the Bruneton model, `groundAlbedo` makes the ground reflect light back into the air, which scatters part of
it toward the eye: the sky brightens, most near the horizon. Give one number or linear RGB, 0 to 1. About 0.8 suits
fresh snow, 0.3 to 0.4 desert sand and 0.1 to 0.25 grass or forest; 0, the default, is a black ground and the sky as
without the option.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky/base';
import {bruneton} from 'margoengine/sky/bruneton';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
// A snow field: on a real GPU, 90 degrees from a sun 30 degrees up, the horizon is about twice as bright as over a black ground.
const sky = Sky.attach(engine, {model: 'bruneton', groundAlbedo: 0.85}, {bruneton});
sky.options.groundAlbedo = [0.4, 0.33, 0.25]; // later, a sand desert: the tables rebuild once
```

The ground is Lambertian (Bruneton and Neyret 2008: sec. 2, the light the ground reflects from its irradiance; sec. 4, per order): its
radiance is albedo / pi times the light on it, the direct sun for the first bounce and the sky of the order before
for the next two, gathered into a 64-entry table over the sun's elevation. Each scattering order's density adds that
radiance, through the air between, for its directions that end on the ground. A changed albedo rebuilds the tables
once (three more small passes than without it); the transmittance table is kept. The ground is one albedo
everywhere, not a texture, and the Preetham model, which has no ground term, ignores it. For a world that is not
Earth, see `HillaireSky`, whose `atmosphere.groundAlbedo` does the same.

## Any sky colour: atmosphere and look

Two options, `atmosphere` and `look`, take the sky anywhere from Earth's to an alien green or a purple dusk, and
every value in them is read each frame, so a slider moves the sky with no recompile. Without them the sky sends the
GPU exactly the program and data it did before they existed (`test/defaults-unchanged.test.js` compares the SHA-256
of every shader and upload of 17 configurations against figures recorded before the change).

`atmosphere` is the air itself, as in the Unreal Engine SkyAtmosphere settings: what it scatters and absorbs changes
the sky, the sun's colour, the light the sky gives the scene and, under `bruneton`, the precomputed tables (they
refill once per change). `look` is art direction over that result, as the Unity HDRP Physically Based Sky's tints and
Gradient Sky: tints at the same brightness, a gradient, a horizon glow, the sun disc and the cloud sheet. Every
strength is 0 and every scale 1 by default, so `look: {}` draws the physical sky.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {model: 'bruneton', hours: 17, timeScale: 0});
// An alien world: the air scatters green, a thicker haze, and a big red sun.
sky.options.atmosphere = {rayleighColor: [0.3, 1, 0.2], mie: 3};
sky.options.look = {sunDiscSize: 2, sunDiscColor: [1, 0.3, 0.2]};
// A slider for the horizon tint: moving it recompiles nothing.
const slider = Object.assign(document.createElement('input'), {type: 'range', min: '0', max: '1', step: '0.01'});
slider.oninput = () => (sky.options.look!.horizonStrength = Number(slider.value));
document.body.append(slider);
// Clearing both compiles the original programs again: the frame is the plain sky's, pixel for pixel.
const reset = Object.assign(document.createElement('button'), {textContent: 'Earth'});
reset.onclick = () => {
  delete sky.options.atmosphere;
  delete sky.options.look;
};
document.body.append(reset);
```

The root `Sky` carries the `look` feature. With `@margoengine/sky/base`, pass it with the rest:

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky/base';
import {preetham} from 'margoengine/sky/preetham';
import {look} from 'margoengine/sky/look';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {look: {zenithColor: [0.6, 0.2, 1], zenithStrength: 0.7}}, {preetham, look});
```

| `atmosphere` | Range | Default | What it does |
| --- | --- | --- | --- |
| `sunIntensity` | 0 to 100 | 1 | Sun strength above the air: the day sky, the disc and the engine light scale with it |
| `sunColor` | linear RGB 0 to 4 | [1, 1, 1] | Sun colour above the air: tints the day sky, the disc and the engine light |
| `rayleigh` | 0 to 20 | 1 | Rayleigh scattering, a multiple of Earth's: 0.1 is a near black sky, 3 a deep blue one with a red sun low down |
| `rayleighColor` | linear RGB 0 to 4 | Earth's, about [0.175, 0.41, 1] | What the air scatters: [0.3, 1, 0.2] is a green sky |
| `mie` | 0 to 50 | 1 | Haze, a multiple of what `turbidity` gives |
| `mieColor` | linear RGB 0 to 1 | [1, 1, 1] | The share of each channel the haze scatters; the rest it absorbs, so [1, 0.5, 0.3] is reddish dust |
| `mieAnisotropy` | -0.95 to 0.95 | 0.8 | Cornette-Shanks asymmetry: higher is a tighter glow round the sun |
| `ozone` | 0 to 20 | 0 | Ozone absorption, a multiple of Earth's layer: a deeper blue at twilight |
| `scatteredLight` | linear RGB 0 to 4 | [0, 0, 0] | Light a low haze layer (smoke, ash, sea spray) scatters down, a share of the zenith sun on level ground: the layer shines evenly over the day sky with that light over pi, so the dome, its reflections, the light it gives the scene and the sky fog take its glow. A `WeatherDrive` writes it under a load |
| `layerTransmittance` | linear RGB 0 to 1 | [1, 1, 1] | That layer's direct share straight up: the night's own light (stars, moon, twilight, the clouds above) is seen through it, t^(1 / sin e) along a ray e up (e floored at 3 degrees), with the layer's glow (`scatteredLight`) in front, so a starry sky goes out under a thick smoke pall. The day sky takes the layer through `sunColor` and `scatteredLight`, so by day it changes nothing. A `WeatherDrive` writes it under a load |

| `look` | Range | Default | What it does |
| --- | --- | --- | --- |
| `zenithColor`, `zenithStrength` | RGB 0 to 1; 0 to 1 | [0.25, 0.45, 1]; 0 | Tint toward the zenith, fading to none at the horizon |
| `horizonColor`, `horizonStrength` | RGB 0 to 1; 0 to 1 | [1, 0.8, 0.6]; 0 | Tint at the horizon, over about 30 degrees |
| `groundColor`, `groundStrength` | RGB 0 to 1; 0 to 1 | [0.3, 0.25, 0.2]; 0 | Tint below the horizon |
| `gradient` | 2 to 8 `{elevation, color}` stops, -90 to 90 degrees rising, RGB 0 to 1 | ground, haze, blue | A gradient sky by elevation |
| `gradientStrength`, `gradientIntensity` | 0 to 1; 0 to 1000 | 0; 1 | How far the gradient replaces the sky, and the radiance of a colour of 1 |
| `sunDiscSize`, `sunDiscColor`, `sunDiscIntensity` | 0.1 to 20; RGB 0 to 4; 0 to 100 | 1; [1, 1, 1]; 1 | The drawn sun disc's radius (a multiple of 0.014 rad), colour and strength |
| `sunDiscSoftness` | 0 to 1 | 0 | The softness of the disc's edge: 0 a sharp edge, 1 spread over the whole radius (the glow round it is unchanged) |
| `glowColor`, `glowStrength` | RGB 0 to 1; 0 to 100 | [1, 0.45, 0.15]; 0 | Light added along the horizon |
| `glowWidth`, `glowSunward` | 0.5 to 90 degrees; 0 to 1 | 8; 0.5 | Height of the glow band, and how far it gathers on the sun's side |
| `cloudColor`, `cloudDensity` | RGB 0 to 4; 0 to 4 | [1, 1, 1]; 1 | The cloud sheet's colour and density (0 clear) |

Values out of range throw a `RangeError` naming the field, as every sky option does. The tints keep the sky's
brightness (Rec. 709 luma), so `exposure` stays the brightness control; colour grading of the whole frame (white
balance, contrast, saturation, lift, gamma, gain and a LUT) is `Tonemap` and `Grade` in `@margoengine/tonemap`.
Setting either option, or clearing both, compiles the sky's shaders once (the transmittance and Bruneton passes too);
the sky's uniform is then 544 bytes instead of 256. Under `preetham` the dome is a fit with turbidity only (Preetham
et al. 1999; Hosek and Wilkie 2012 has the same two inputs), so `atmosphere` changes its sun and the light it gives,
not the dome's scattering; use `bruneton` for a sky whose colour follows the air. Sources: Bruneton and Neyret 2008,
Hillaire 2020 (Table 1's coefficients and ozone layer), Bruneton 2017, Cornette and Shanks 1992; full citations in
`src/look.ts`. Limits: `VolumetricClouds` and `LightShafts` take their sunlight from `turbidity` alone, not from
`atmosphere`; the ground tint shows in the sky below the horizon, not in the reflection map or the light the sky gives
the scene, whose rays stop at the horizon; wind is the cloud sheet's own `clouds.speed`.

### Sliders for every control: settings

`@margoengine/sky/settings` lists every sky control as one table for panels and tools, and names eleven looks made
only of its values. `SKY_SETTINGS` has 133 rows across the clock, the sun, the air, clouds, the volumetric layer, the hurricane, lightning, fog, tints, the gradient,
the sun disc, the glow, exposure and grading; each row gives `name`, `group`, `kind` (`number`, `color`, `choice` or
`gradient`), `default`, `min`, `max`, `step`, `unit`, `about` and `live`. `applySkySettings({sky, tonemap, grade, clouds, weather}, values)`
writes a set of values (a name left out takes its default) onto the sky, onto a `Tonemap` and its `Grade` when
given, and onto a `VolumetricClouds` given as `clouds` (its 18 `volumetric.*` rows: coverage, bottom, top and density,
each `nullable` with a null default that follows the weather's `cloud`; `type` 'weather', 'cumulus', 'stratus', 'storm'
or 'hurricane' (forces that type's layer); `windSpeed` and `windDirection` (compass degrees, 0 is +Z, 90 is +X), each `nullable` and
following the weather's wind, writing `options.wind`; steps and lightSteps, rounded to whole counts;
stepCap, scale, evolution, maxDistance, sunIntensity, groundAlbedo; `temporal` 'auto', 'on' or 'off'; `dimLight` 'on' or 'off').
While `volumetric.type` is 'hurricane' the 34 `hurricane.*` rows write the clouds' `hurricane` option (into the options
of a `Hurricane` given there, else an object of their own, taken back when the type changes): every `Hurricane` option,
with the centre as `centerX` and `centerZ`, the motion as `speed` and compass `heading`, `hemisphere` 'north' or 'south'
with `latitude` 1 to 60, `bands` rounded to whole and `bandRotation` in degrees; `eyeRadius` and `bandStart` are
nullable, null following `maxWindRadius`. All are live (uniforms). None follows the weather: the storm makes the weather
through `WeatherRegions`' `storms`, not the other way round.
A `Weather` given as `weather` takes the 18 `lightning.*` rows into its `lightning` option: `rate` and `threshold` follow the
weather's lightning (the drive writes them; a value you set is held against it, and null hands it back), `hold` follows
the strikes, `cloud.base` follows the deck, and distance, flash strength and colour, the light's scale, height, colour and
shadow ('auto', 'on' or 'off'), the deck's scale and radius, the three `link.*` switches ('on' or 'off') and the seed
are plain rows. A null or default value leaves that option unset. Each row's default is what the target does without the option: with every value at its default the sky's
options are left unset, so it sends the GPU what a sky that never had them sends (`test/settings.test.js` checks the
SHA-256 against the figures recorded before the slider options existed), and Tonemap and Grade stay on their
default programs.

`live` says whether a row can change every frame: true for every row but `model`, which compiles the sky, fog,
reflection and lighting shaders again. `SKY_LIVE_SETTINGS` lists the live rows, so a film can key them over a shot. A
live row makes no pipeline, buffer or texture between two values away from its default (60 frames of every live row
are counted in `features-check.mjs settings`, native and on the WebGL2 layer, and the last frame equals writing those
values once). The first time a `look.*`, `atmosphere.*`, `groundAlbedo`, `tonemap.temperature`, `tonemap.tint`,
`tonemap.contrast`, `grade.saturation`, `grade.lift`, `grade.gamma` or `grade.gain` value leaves its default, and again
on the way back, one program compiles, so keep those rows off their defaults for a shot. The row shape is shared
by every package's settings (`packages/shared/settings.js`).

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {SKY_LOOKS, SKY_SETTINGS, applySkySettings, skySettingDefaults, type SkySettingValue} from 'margoengine/sky/settings';
import {Tonemap} from 'margoengine/tonemap';
import {Grade} from 'margoengine/tonemap/grade';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const grade = new Grade();
const tonemap = Tonemap.attach(engine, {extensions: [grade]});
const sky = Sky.attach(engine);
// The panel's state: every value at its default, then a look to start from.
const values: Record<string, SkySettingValue> = {...skySettingDefaults(), ...SKY_LOOKS.sunset};
const apply = () => applySkySettings({sky, tonemap, grade}, values);
apply();
// A look picker.
const picker = document.createElement('select');
for (const name of Object.keys(SKY_LOOKS)) picker.append(new Option(name, name));
picker.value = 'sunset';
picker.onchange = () => {
  Object.assign(values, skySettingDefaults(), SKY_LOOKS[picker.value as keyof typeof SKY_LOOKS]);
  apply();
};
document.body.append(picker);
// One slider per number row, built from the table.
for (const row of SKY_SETTINGS) {
  if (row.kind !== 'number') continue;
  const label = Object.assign(document.createElement('label'), {textContent: `${row.name} (${row.unit}) `, title: row.about});
  const slider = Object.assign(document.createElement('input'), {
    type: 'range',
    min: String(row.min),
    max: String(row.max),
    step: String(row.step),
    value: String(values[row.name]),
  });
  slider.oninput = () => {
    values[row.name] = Number(slider.value);
    apply();
  };
  label.append(slider);
  document.body.append(label);
}
```

The looks are `clearNoon`, `overcast`, `sunrise`, `sunset`, `dusk`, `storm`, `haze`, `greenSky`, `yellowSky`,
`redSky` and `purpleSky`. Each holds the clock, places the sun by angles (`sun.mode` `'angles'`, `sun.azimuth`,
`sun.elevation`, written as `sunDirection`) and draws with `bruneton`, so a `Sky` from `@margoengine/sky/base` needs
the `bruneton`, `clouds` and `look` entries for them. A name not in the table throws a `TypeError`, a value outside
its row's range or kind a `RangeError`. Notes:

- `clouds.coverage` 0 is the default and removes the sheet; above 0 the sheet's other rows apply.
- `fog.*` applies only while the sky has `fog`, which carries the scene depth; `fog.color` null takes the sky's
  colour in the view direction. The table's top of `fog.start` (10,000 m) and `fog.height` (1) is a slider's reach;
  the `fog` option itself has no upper limit there.
- The clock is part of the state: each call sets `hours`, so a panel that lets the clock run reads
  `sky.options.hours` back into its values before it applies them.
- `tonemap.*` and `grade.*` are written on every call to the targets given; at their defaults they change nothing.

## Volumetric clouds

`VolumetricClouds` from `@margoengine/sky/volumetric-clouds` is a layer of real 3D cloud between two heights that
you can fly into, through and above. Give it the sky that lights it and leave the sky's own `clouds` option off.
Volumetric clouds and `Sky` fog read the current depth from PostStack or another active scene capture by default.
This includes opaque surfaces and alpha-cutout foliage that already wrote depth. A supplied `depth` callback
selects another depth source. When there is no sampleable depth, clouds draw over the empty sky and fog has no surface to shade.
The separation of atmospheric integration from scene surfaces follows Andrew Schneider and Nathan Vos,
[The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn](https://www.advances.realtimerendering.com/s2015/index.html) (2015),
and Sébastien Hillaire, [Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite](https://blog.selfshadow.com/publications/s2016-shading-course/) (2016).

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {Bloom} from 'margoengine/post/bloom';
import {VolumetricClouds} from 'margoengine/sky/volumetric-clouds';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: {position: [0, 2, 0], target: [0, 40, -60], far: 200000},
});
Bloom.attach(engine);
const sky = Sky.attach(engine, {hours: 10, timeScale: 0});
const clouds = VolumetricClouds.attach(engine, {sky, coverage: 0.5});
clouds.options.wind = [15, 0]; // options are read every frame
```

Each pixel marches its view ray through the layer (`steps` samples, 64 by default, each starting at its own fraction of
a step so the steps do not band; with `temporal` that fraction moves on by the golden ratio each frame, for
`@margoengine/taa` to average the march's noise on thin cloud; the frame's own draw marches from the start a seek gives
at that frame however many mirror or cube captures draw the clouds first, and a still frame drawn again with delta 0
still moves it) and, wherever there is cloud, `lightSteps` samples (6)
toward the sun, and as many toward the moon. The shapes come
from two tiling noise volumes made once on the GPU (Schneider 2015): a 64³ Perlin-Worley and Worley volume for the
billows and a 32³ Worley volume that erodes their edges, wispy at the base and rounded higher up. A coarse slice of the
same volume spreads the clouds into groups and clear patches. The light at each sample is first-order scattering with
two Henyey-Greenstein lobes plus the diffuse field of the two-stream approximation (Meador and Weaver 1980; Bohren 1987)
on delta-Eddington scaled depths (Joseph, Wiscombe and Weinman 1976): the optical depth toward the sun and down the
column to the base give the slab's transmission T = 2 / (2 + (1 - g)(a + b)), g 0.85, and the light leaving toward the
eye takes Eddington's angular form, so a deck's base is brightest overhead as the CIE overcast sky is. Integrated step
by step as Hillaire 2016 does, so the sun breaks through gaps in shafts, cloud edges glow toward the sun, and a thick
deck passes what two-stream theory says: a full deck over a black ground with the sun overhead passes down 0.68, 0.45
and 0.22 of the sun at nominal optical depths 5, 20 and 80 (two-stream of its own noisy columns 0.75, 0.45 and 0.19)
and sends up the rest within 10% (RTX A6000, WebGPU and the WebGL2 layer alike; `features-check.mjs cloud-bounds`).
Until 2026-11-17 three octaves of weaker extinction (Wrenninge et al. 2013) stood for the multiple scattering: they lost
three quarters of the sun in such a deck and left thick bases near black. The moon lights the deck the same way, shaded through it, and its first scattering adds the
droplets' narrow diffraction peak (half the light a droplet removes, van de Hulst 1957), so a thin veil over the moon
glows round it and a thick deck hides it. The layer sits on the planet's curve (radius 6,360 km), so it reaches the horizon, and far cloud
thins into the haze as the sky's own layer does (half at 28 km).

With a `sky`, the sun's direction and its colour through the sky's atmosphere (warm and dim when low, nothing once it
has set), the sky's exposure, its moon light and its sky light carry over. The sky light comes from the sky's 64 × 32
reflection map (the `reflection` feature, part of the root `Sky`), reduced on the GPU each frame to the light from above
and from below (the ground); reading `sky.reflectionTexture` turns that map's refresh on. A sky without the feature, or no sky,
uses `ambient` and `sunDirection`.

In turn the clouds go into the sky's environment, so what reflects the sky or takes its light sees them. Each frame
they march their deck from the camera into a 64 × 32 map in the sky's layout (four rays a texel, 32 steps each, with
the same light, moon and flash as the view) and set it as `sky.environmentLayer`: the sky draws its reflection map
again with the deck over it (at frame-graph order 3.5, after the clouds took their own light from the clear map and
before Water reflects it). The scene's light takes a second map, `sky.environmentLightLayer`: the same deck holding only
the light no engine light carries, its sky light and its flash, and with `dimLight` off its sun and moon light matched
to the engine lights (the sky lighting's `intensity` over 4 pi `sunIntensity`), so each light reaches the scene once.
The `lighting` map takes it before its mips and harmonics, so a lightning flash inside the deck lights the ground, and
under a stratus deck (share 0.44 at noon) a grey block's sunlit top reads 0.51 of its clear level (until 2026-11-17 it
read 0.93: the deck's sun light came in again on top of the dimmed engine sun). Coverage 0 or `dispose()` gives the sky
back its plain maps.

The cloud march stops at the nearest surface in the scene depth. A camera inside the layer sees cloud in front of
nearby objects, and a mountain in front of the clouds hides them. With no sampleable depth the clouds draw only
over the empty sky.

| Option | Default | Meaning |
| --- | --- | --- |
| `sky` | none | the `Sky` that lights the clouds |
| `weather` | none | a weather state `{cloud, rain?, lightning?}` (0 to 1 each): its cloud type gives `coverage`, `bottom`, `top` and `density` for each left unset (below); the weather drive writes it |
| `type` | none | `'cumulus'`, `'stratus'` or `'storm'` forces that type's base, tops and density whatever the `weather` says (with no weather its `cloud` is 0.5); `'hurricane'` is the hurricane deck, 500 to 15,000 m, drawing the default storm at the origin; `cloudLayerFor(weather, out, type)` gives the same layer |
| `hurricane` | none | a `Hurricane` (or its options) shaping the layer: eye, eyewall, moat, bands, shield and canopy, turning and moving with the storm (below); `coverage` then scales its cover, and the weather drive leaves the layer's coverage, density and drift to it |
| `coverage` | 0.5 | share of the sky covered, 0 to 1; 0 draws nothing |
| `bottom`, `top` | 1500, 4000 | the layer's base and tops in metres above the ground (100 to 20,000) |
| `density` | 0.04 | extinction per metre inside the densest cloud |
| `scale` | 14,000 | metres one repeat of the shapes spans; the erosion repeats eight times as often |
| `wind` | [10, 3] | metres per second along X and Z |
| `evolution` | 3 | metres per second the field rises through itself, so shapes change as they drift |
| `steps`, `lightSteps` | 64, 6 | samples along the view ray and toward the sun (and the moon) |
| `temporal` | 'auto' | a new march start each frame, for TAA to average: `'auto'` is on when the scene has `@margoengine/taa` (a plugin named `taa`), `true` always, `false` never |
| `erosion` | 1 | the amount of fine erosion on the cloud edges (0 to 2): 0 leaves clean rounded outlines, 2 doubles the ragged detail; live |
| `stepCap` | 150 | the longest march step near the camera, metres (10 to 10,000): past it the steps grow with distance (below) |
| `dimLight` | true | dim the sky's sun and moonlight under the deck by `cloudDeckTransmittance` (`Sky.deck`); `false` when `volumetricCloudShadows` already shades the scene |
| `maxDistance` | 80,000 | longest stretch of each view ray marched inside the layer, metres, from where it enters (as Unreal's tracing max distance) |
| `sunIntensity` | 0.55 | the sun's irradiance on the clouds over 4 pi, in the sky's units: the sun that makes the clear noon sky give 0.165 of the light on level ground, the diffuse fraction of a clear sky (Erbs, Klein and Duffie 1982); 1.6 until 2026-11-17 |
| `groundAlbedo` | 0.2 | albedo of the ground under the clouds (fresh snow 0.8, grass 0.25, forest 0.1): it sends the share of the sun and sky the deck passes back up into the base; live (the sky's own `groundAlbedo` feeds only its Bruneton tables) |
| `sunDirection`, `ambient` | [0.3, 0.6, 0.4]; a clear day's above a dark ground | the light without a sky: `ambient` is the light from above and from below (the ground) |
| `depth` | active scene capture | optional callback that selects another reversed-Z depth source each frame |
| `flash` | none | a lightning flash lighting the clouds from inside: `{position, intensity, color?, radius?}` |

**Cloud types from the weather.** `cloudLayerFor(weather)` gives the layer of a weather state, three types blended by
`cloudTypeWeights(weather)` (they add up to 1): fair-weather cumulus (cover up to half the sky, 1,000 to 2,500 m,
extinction 0.03 a metre), stratus once the sky is 55 to 85 percent cloud (cover as `cloud`, 300 to 900 m, 0.08) and a
storm's cumulonimbus with rain or lightning (all the sky, 600 to 8,000 m, 0.1). Bases and tops follow the WMO
International Cloud Atlas, the types by height and cover Schneider's Nubis talk (SIGGRAPH 2017 Advances), and
extinction the liquid water of each type (0.02 to 0.1 a metre).

```ts
import {cloudLayerFor, cloudDeckTransmittance} from 'margoengine/sky/volumetric-clouds';
const storm = cloudLayerFor({cloud: 1, rain: 0.9, lightning: 0.8}); // 600 to 8,000 m, all the sky
const share = cloudDeckTransmittance(cloudLayerFor({cloud: 1}), 1); // 0.44 of an overhead sun under stratus
console.log(storm.top, share.toFixed(2));
```

**The light under the deck.** `cloudTransmission(tau)` is the two-stream share a cloud of optical depth `tau` passes,
1 / (1 + tau (1 - g) / 2) with g 0.85 (Meador and Weaver 1980; Bohren 1987): 0.73 at tau 5, 0.4 at 20, 0.14 at 80.
`cloudDeckTransmittance(layer, up)` applies it to a layer (its optical depth along a light at elevation sine `up`,
`density` times thickness times 0.35, the mean of the density profile, over `up`, at least 0.1) and to the share of the
sky it covers. With `dimLight` on (the default) and a `sky`, the clouds set `sky.deck` to it: the sky scales its sun
light (`lights[0]`) and its moonlight under the cloud (`moonUnderClouds`, in place of `lighting.moon.cloudCover`) by it,
so a scene under an overcast deck is lit as overcast with no cloud shadows wired; the moon's own light above the deck
(which lights the cloud tops and the disc) stays. `dispose()` or `dimLight: false` gives the sky its full sun back.

**Steps that grow with distance.** A view ray's `steps` samples sit at t_k = start + L ((k + j) / n)^p, L the stretch
marched, n the steps, j the pixel's start fraction: p is 1 (even steps) while L / n is at most `stepCap`, else the
power that makes the second step `stepCap` (eight fixed-point rounds of p = log(L (2^p - 1) / cap) / log n). Each step
is integrated on its own length as Hillaire 2016 does, and a jittered start with TAA averages the rest (Toft, Bowles and
Zimmermann 2016), so near cloud is sampled finely and far, hazed cloud coarsely at the same cost. On a low view across
the layer at 64 steps the mean error against a 256-step march fell from 0.00189 to 0.00174 (RTX A6000, WebGPU and the
WebGL2 layer alike).

`flash` puts a point of light in the layer, read every frame: `color` (a cool white by default) times `intensity` in
the sky's radiance units at 1 metre, falling with the square of the distance past `radius` (200 m). Each cloud sample
takes it through the base shape between it and the flash (three samples), with three octaves of weaker extinction for
the light the cloud scatters onward (Wrenninge et al. 2013), so a flash glows through thick cloud round it. Drive
`intensity` from `Weather.flash` and place it above `strike.position` (`weather.onLightning`); 0 costs nothing.

`clouds.drift` holds how far the shapes have moved and risen, each wrapped at their repeat, then the coverage map's own
wind drift, wrapped at its repeat (`scale` / 0.17), so the cover never jumps; `volumetricCloudShadows(clouds)` from
`@margoengine/sky/cloud-shadows` casts their shadows on the ground (below). Cost: one fragment per pixel marching up to `steps` + `steps` ×
`lightSteps` noise reads, at full resolution, with no temporal reuse; a 256 × 192 view took about 15 ms a frame on a
Radeon 680M (diagnostic, taken with other jobs on the machine). Lower `steps` on slow GPUs. Needs WebGPU (`MargoError`
`'unsupported'` on WebGL2).

### Hurricanes: the eye, the eyewall and the rain bands

`Hurricane` from `@margoengine/sky/hurricane` is a whole tropical cyclone at sea: its wind, rain and cloud at every
place and moment. Give it to the clouds' `hurricane` option and the layer becomes the hurricane deck (500 to 15,000 m)
shaped by the storm: the clear eye with a little low cloud on its floor, the eyewall leaning out with height so the eye
opens upward like a stadium, the moat, an optional concentric outer eyewall, spiral rain bands (the first, principal
band wider and reaching in to the eyewall), a stratiform shield between the bands and a cirrus canopy over the core.
The cloud turns with the storm's own wind (faster near the eyewall) and moves with the storm. From sea level in the eye
the sky overhead is clear and the sun shines in (the deck dims the sun by the cloud over the camera); from the air the
eye, the eyewall and the bands show 100 km off, as the cloud haze follows the air a ray crosses. Give the same storm to
`WeatherRegions`' `storms` (`@margoengine/weather/regions`) and the weather at the camera follows it: calm in the eye,
the wind, gusts and rain rising in the eyewall and in each band and falling between them.

The storm's shader code and maths (4.4 kB gzip) load by `import()` the first time a layer draws a storm, so clouds
without one do not carry them. Until they arrive the layer draws nothing, and so do its `volumetricCloudShadows` and
`LightShafts`: they start the load themselves, cast and draw nothing of the storm while it runs, and take the storm in
on the first frame after it lands, in any order you make them. `await clouds.ready` before the first frame you keep (a
film). `ready` rejects with a `RangeError` for storm options out of range.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {VolumetricClouds} from 'margoengine/sky/volumetric-clouds';
import {Hurricane} from 'margoengine/sky/hurricane';
import {WeatherMachine} from 'margoengine/weather';
import {WeatherRegions} from 'margoengine/weather/regions';
import {WeatherDrive} from 'margoengine/weather/drive';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 2, 0], target: [1, 4, 0], far: 400000},
});
const storm = new Hurricane({pressureDrop: 70, maxWindRadius: 25000, velocity: [4, 1]});
const sky = Sky.attach(engine, {hours: 13, timeScale: 0});
const clouds = VolumetricClouds.attach(engine, {sky, hurricane: storm, maxDistance: 300000});
await clouds.ready; // the storm's code has loaded
const map = new WeatherRegions({base: 'overcast', storms: [storm]});
const weather = new WeatherMachine('overcast');
WeatherDrive.attach(engine, {weather, sky, listener: engine.camera});
engine.onFrame((_, delta) => {
  map.update(delta);
  map.apply(weather, engine.camera.position[0], engine.camera.position[2]);
});
console.log(storm.regionAt(0, 0), storm.windAt(25000, 0).speed.toFixed(1)); // 'eye', about 50 m/s
```

| `Hurricane` option | Default | Meaning |
| --- | --- | --- |
| `center`, `velocity` | [0, 0], [0, 0] | world `[x, z]` of the centre at time 0, and its motion in m/s |
| `pressureDrop` | 60 | hPa below the 1,010 hPa ambient (5 to 150) |
| `maxWindRadius` | 30,000 | radius of maximum wind, metres |
| `holland` | 1.5 | Holland's B, 1 to 2.5: higher is a sharper peak |
| `latitude` | 20 | degrees, 1 to 60 north or -1 to -60 south: the Coriolis term and the turn (anticlockwise seen from above in the north) |
| `airDensity`, `surfaceFactor`, `inflow` | 1.15, 0.9, 22 | kg/m3; the surface wind over the gradient wind; degrees the surface wind turns in |
| `gustFactor` | 1.23 | the 3 s gust over the mean in the open storm; the eyewall and bands add half again of the excess |
| `eyeRadius`, `eyeSlope` | 0.7 `maxWindRadius`, 1.2 | the clear eye at the cloud base, and the radius its edge gains per metre up |
| `eyewallWidth`, `eyeCloud` | 18,000, 0.25 | metres; the low cloud cover on the eye's floor |
| `outerEyewall`, `outerEyewallStrength` | 0 (none), 0.8 | radius of a concentric outer eyewall and its cloud and wind |
| `moat` | 0.1 | cloud between the eyewall and the bands |
| `bands`, `bandPitch`, `bandWidth` | 3, 15, 14,000 | spiral bands, their crossing angle with a circle in degrees (5 to 40), their width |
| `bandStart`, `bandTop` | 2.5 `maxWindRadius`, 0.6 | where the bands start, and their tops as a share of the layer |
| `bandRotation`, `bandDrift` | 0, 0 | turn of the band pattern (radians) and its rate (radians a second; 0 keeps it fixed to the storm) |
| `principalBand` | 0.5 | how much wider the first band is, and how far in it reaches (to the eyewall at 1) |
| `extent`, `shield`, `canopy` | 350,000, 0.3, 0.6 | outer radius; the shield's cover between the bands; the cirrus canopy's cover near the tops |
| `rainMax`, `rainExtent` | 50, 150,000 | peak rain in the eyewall, mm/h; the 1/e fall-off outside it, metres |
| `flowPeriod`, `swirl` | 900, 1 | seconds between the two cross-faded phases of the turning cloud; its turn over the wind's (0 holds it still) |

`windAt(x, z, t)` gives the surface wind (speed, gust, `[x, z]` velocity and the weather's direction),
`rainAt(x, z, t)` the rain rate in mm/h, `coverAt(x, z, height, t)` the cloud cover parts (the shader's field on the
CPU), `regionAt(x, z, t)` the part of the storm (`'eye'`, `'eyewall'`, `'moat'`, `'outerEyewall'`, `'band'`,
`'shield'` or `'outside'`) and `weatherAt(x, z, t)` the weather with its weight and the full mean wind speed.
`StormVortex.fromHurricane(storm.resolved)` from `@margoengine/physics/vortices` shares that profile with physical
consumers. `hollandWind(r)`, `hollandPressure(r)` and `hollandMaxWind()`
are the profile itself. The `hurricane.*` rows of `SKY_SETTINGS` drive every option while `volumetric.type` is
`'hurricane'` (below); `type: 'hurricane'` alone draws the default storm at the origin.

The model, from papers (no other engine's code was read): the wind and pressure are Holland's (1980) profile,
p = pc + dp exp(-(R/r)^B) and V = sqrt(B dp (R/r)^B exp(-(R/r)^B) / rho + (r f / 2)^2) - r f / 2, peaking at R; the
surface wind is 0.9 of it (Franklin, Black and Valde 2003) turned in 22 degrees (Zhang and Uhlhorn 2012), with the
at-sea gust factor 1.23 (Harper, Kepert and Ginger 2010, WMO/TD-1555). The bands are logarithmic spirals with crossing
angles of about 10 to 25 degrees (Senn and Hiser 1959), held still relative to the centre as the stationary band
complex, with a principal band joining the eyewall (Willoughby, Marks and Feinberg 1984); the concentric eyewall, its
moat and its secondary wind maximum follow Willoughby, Clos and Shoreibah (1982). The eye's edge leans out about 1.2 m
per metre up, the peak of the measured inverse slopes of 1 to 1.5 (Hazelton and Hart 2013); tops near 15 km, the eye's
low floor cloud, the bands' lower tops, the shield and the canopy follow Houze's review (2010). The rain is the R-CLIPER
radial profile, rising to its peak in the eyewall and falling as exp(-(r - rm) / re) outside it (Tuleya, DeMaria and
Kuligowski 2007), times the cloud that rains there; lightning is weak in the eyewall and strongest in the outer bands
(Molinari, Moore and Idone 1999). The cloud turns by two noise phases, each carried round by the wind for one
`flowPeriod` and cross-faded half a period apart (Vlachos 2010, the flow map of "Water flow in Portal 2"), so it never
shears apart. The storm's march costs two shape reads (and two erosion reads on the view rays) per sample in place of
one.


### Tornado: funnel, wall cloud, debris and its path (`@margoengine/sky/tornado`)

`Tornado` is a tornado under its supercell, on the CPU: the vortex's wind and pressure, the condensation funnel they
make, the debris cloud, the rain of the rear flank and its path over film time. `TornadoCloud` draws it: the funnel,
the wall cloud hanging under the base, the turning mesocyclone base round it, and the debris cloud at the ground.

- **Wind and pressure.** `profile: 'burgers-rott'` (default) is the Burgers (1948) and Rott (1958) vortex, its wind
  peaking at `coreRadius` (1.12091 r0); `'rankine'` is Rankine's combined vortex with the wind outside the core falling
  as r^-`decay` (0.6 by default, as Doppler radar measures it: Wurman and Gill 2000, Kosiba and Wurman 2010; 1 is
  Rankine's own). The pressure is the cyclostrophic balance of that wind (Davies-Jones 1986), so `pressureDrop` (the
  central deficit) sets the peak wind: 80 hPa gives about 64 m/s with Burgers-Rott, an EF3.
- **The funnel, rope to wedge.** Its edge at each height is where the deficit cools the inflow to its condensation
  level, deficit = rho g (wall-cloud base - height) (Davies-Jones 1986). A strong deficit under a low wall cloud reaches
  the ground; a weak one hangs aloft; a narrow core makes a thin rope and a wide one a wedge wider than it is tall.
  `tilt` sets the foot off from under its top and `meander` weaves a rope.
- **The wall cloud and mesocyclone base** hang `wallCloudDrop` below `cloudBase`, out to `wallCloudRadius` and
  `mesocycloneRadius`, turning with the vortex and the mesocyclone's wind (Moller et al. 1994).
- **Debris** lofts where the surface wind passes `debrisWind`, up to `debrisHeight`, in `debrisColor`.
- **Over film time** it moves along `path` (`[seconds, x, z]` keys, a smooth curve) or with `velocity`, forms over
  `spinUp` seconds after `touchdown` (the deficit ramps in, so the funnel lowers to the ground) and dies after
  `liftoff`. `TornadoCloud.time` is its clock, moved by each frame update (`setTime` seeks).
- **The weather.** Give the same tornado to `WeatherRegions`' `storms` (`@margoengine/weather/regions`) and the wind,
  gusts and rain at the camera follow it: the turning wind turned in near the ground, the rear flank's rain behind its
  motion (Lemon and Doswell 1979). `velocityAt(x, y, z, t)` gives the 3D air for debris, with the core's updraft.
- **The ground.** `damagePath(t0, t1)` lists where it stood and how wide the ground saw an EF0 gust (29 m/s);
  `groundScar(t0, t1)` turns that into a scoured strip for `GroundChange.add` (`@margoengine/terrain/ground-change`),
  cut as the tornado passes.

Its shader (about 3 kB gzip) loads by `import()` at a `TornadoCloud`'s first frame, so a page that only reads a
tornado's wind does not carry it; until it arrives the storm draws nothing (`await cloud.ready` before the first frame
you keep). Every option is live, and the `tornado.*` rows of `SKY_SETTINGS` write them (`applySkySettings` with a
`tornado` target).

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {VolumetricClouds} from 'margoengine/sky/volumetric-clouds';
import {Tornado, TornadoCloud} from 'margoengine/sky/tornado';
import {WeatherMachine} from 'margoengine/weather';
import {WeatherRegions} from 'margoengine/weather/regions';
import {WeatherDrive} from 'margoengine/weather/drive';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu',
  camera: {position: [0, 2, 4000], target: [0, 400, 0], far: 200000},
});
const twister = new Tornado({
  path: [[0, -1500, 0], [120, 0, -200], [240, 1500, 0]],
  pressureDrop: 85,
  coreRadius: 160,
});
const sky = Sky.attach(engine, {hours: 17, timeScale: 0});
const clouds = VolumetricClouds.attach(engine, {sky, type: 'storm', bottom: 1000});
const storm = TornadoCloud.attach(engine, {tornado: twister, sky});
await storm.ready; // the tornado's shader has loaded
const map = new WeatherRegions({base: 'overcast', storms: [twister]});
const weather = new WeatherMachine('overcast');
WeatherDrive.attach(engine, {weather, sky, clouds, listener: engine.camera});
engine.onFrame((_, delta) => {
  map.update(delta);
  map.apply(weather, engine.camera.position[0], engine.camera.position[2]);
});
console.log(twister.peakWind().toFixed(0), (2 * twister.funnelRadiusAt(0)).toFixed(0)); // m/s, funnel width at the ground
```

| `Tornado` option | Default | Meaning |
| --- | --- | --- |
| `center`, `velocity` | [0, 0], [0, 0] | world `[x, z]` at time 0 and its motion in m/s (without a `path`) |
| `path` | none | `[seconds, x, z]` keys in rising time, passed through smoothly; it stands still outside them |
| `profile` | `'burgers-rott'` | the vortex: `'burgers-rott'` or `'rankine'` |
| `pressureDrop` | 80 | central deficit, 1 to 150 hPa |
| `coreRadius` | 150 | radius of maximum wind, 10 to 2,000 m |
| `decay` | 0.6 | the `'rankine'` wind outside the core falls as r^-decay, 0.5 to 1 |
| `airDensity` | 1.15 | kg/m3 |
| `cloudBase`, `wallCloudDrop` | 1,000, 400 | the base's height and how far the wall cloud hangs below it, m |
| `wallCloudRadius`, `mesocycloneRadius`, `mesocycloneWind` | 1,500, 3,000, 25 | m, m, m/s |
| `rotation` | `'cyclonic'` | anticlockwise seen from above, or `'anticyclonic'` |
| `tilt`, `meander` | [0, 0], 0 | the foot's offset from under the top, and a rope's weave, m |
| `debrisWind`, `debrisHeight`, `debrisDensity`, `debrisColor` | 35, null, 0.6, [0.34, 0.27, 0.2] | lofting wind (m/s), height (null: 2 core radii plus 50 m), opacity, linear RGB |
| `funnelDensity`, `wallCloudDensity` | 0.05, 0.01 | extinction per metre |
| `inflow`, `updraft`, `gustFactor` | 40, null, 1.3 | degrees the surface wind turns in; the core's updraft (null: 0.6 of the peak wind); 3 s gust over the mean |
| `rainMax` | 60 | peak rain of the rear flank, mm/h |
| `touchdown`, `liftoff`, `spinUp` | null, null, 60 | when it forms (null: formed already) and dies (null: never), and how long each takes, s |
| `turbulence`, `flowPeriod` | 0.5, 20 | the edges' raggedness; seconds between the cloud texture's cross-faded phases |

| `TornadoCloud` option | Default | Meaning |
| --- | --- | --- |
| `tornado` | required | a `Tornado` or its options |
| `sky`, `sunDirection`, `sunIlluminance` | none, [0.3, 0.6, 0.4], the sky's | the light, as `LightShafts` |
| `sunShare` | 0.35 | share of the sun reaching the storm under its deck |
| `ambient` | [0.05, 0.06, 0.075] | the sky's light round the storm over the sun's illuminance |
| `depth` | none | the scene depth, so hills hide the storm; omitted, it draws over the scene |
| `steps` | 160 | samples along each view ray, 16 to 512 |
| `name` | `'sky:tornado'` | the plugin's name, so several tornadoes can share a scene |

### Cloud shadows on the ground

`volumetricCloudShadows(clouds)` from `@margoengine/sky/cloud-shadows` is a shadow effect for `Shadows` or
`VirtualShadows` (`@margoengine/shadows`): everything that receives shadows darkens under the volumetric clouds, and the
shadows drift and change with them.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {Shadows} from 'margoengine/shadows';
import {VolumetricClouds} from 'margoengine/sky/volumetric-clouds';
import {volumetricCloudShadows} from 'margoengine/sky/cloud-shadows';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {hours: 10, timeScale: 0, lighting: {intensity: 3}});
const clouds = VolumetricClouds.attach(engine, {sky, coverage: 0.4});
const ground = engine.createMesh().setGeometry(box(400, 1, 400)).setMaterial(new PbrMaterial({color: '#6a7a4a'}));
const shadows = Shadows.attach(engine, {effects: [volumetricCloudShadows(clouds, {strength: 0.9})]});
shadows.add(ground);
```

Each lit pixel marches the clouds' own density field (the same noise, layer, coverage and drift, read from
`clouds.options` and `clouds.drift` every frame) from its position toward the shadows' sun, `samples` times (12) through
the layer, and multiplies the light by the transmittance, `strength` (1) of the way. So the ground is dark where a viewer
there would see cloud over the sun. The effect keeps its own copy of the noise volumes (the generator is deterministic,
so the copy is the same cloud) and needs nothing from the clouds' GPU objects; it takes four of a shadow effect's eight
bindings. The light is the shadows' sun (`engine.lighting.direction`), so drive it from the sky (`lighting`) to keep the
two together.

## Aerial perspective

`AerialPerspective` from `@margoengine/sky/aerial` gives scene surfaces the air in front of them: each pixel is
multiplied by the air's transmittance, per colour channel, and given the light the air scatters toward the camera, so
distant mountains turn blue and hazy by real scattering (Hillaire 2020). It needs the scene's depth.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {Bloom} from 'margoengine/post/bloom';
import {AerialPerspective} from 'margoengine/sky/aerial';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu', camera: {far: 100000}});
const bloom = Bloom.attach(engine);
const sky = Sky.attach(engine, {hours: 16, timeScale: 0});
const aerial = AerialPerspective.attach(engine, {sky, depth: () => bloom.depthTexture});
aerial.options.metersPerUnit = 10; // a small scene with the air of a large one
```

The air is Earth's by default (`EARTH_ATMOSPHERE`, Hillaire 2020 Table 1): Rayleigh scattering, Mie scattering and
absorption (Mie absorption 0.000444 /km, the 0.9 single-scattering albedo reading of Table 1, whose printed 4.40e-6 /m
is the extinction; changed 2026-11-11, see docs/known-bugs.md), an ozone layer and the ground's albedo; `atmosphere` changes any of them (`atmosphereParameters` checks a
set and fills the rest). Two tables are worked out once per atmosphere, the transmittance to the top (256 × 64) and
multiple scattering (32 × 32, Hillaire 2020's second order over 64 directions summed as a geometric series; the
sums are kept as a value times exp(-optical depth), so an air thick enough to trap nearly all light still gives a
finite table, see docs/known-bugs.md). Each
frame a compute pass marches 32 × 32 view columns through 32 slices, reaching `maxDistance` (64 km) on a square-root
spacing, so slices are dense near the camera; the pixel reads its slice by its distance. With a `sky`, the sun, the
sky's turbidity (which scales Mie scattering as the sky does) and its exposure carry over; `sunIlluminance` defaults
to what matches the sky's model (20 for Bruneton, 10 for Preetham, the sky's own for `HillaireSky`). A `HillaireSky`
lends its whole atmosphere, its `metersPerUnit` and its `altitude` too, so the air and the sky behind it agree.

| Option | Default | Meaning |
| --- | --- | --- |
| `depth` | required | the scene's reversed-Z depth each frame |
| `sky` | none | the sky to follow; without it `sunDirection` (default [0.3, 0.6, 0.4]) |
| `maxDistance` | 64,000 | metres the air is worked out to; farther pixels keep that value |
| `metersPerUnit` | the sky's, else 1 | metres per world unit |
| `altitude` | the sky's, else 0 | metres added to the camera's height |
| `sunIlluminance` | from the sky | sun strength in the sky's units |
| `atmosphere` | the sky's, else Earth | the planet's air, kilometres |

The planet's centre is taken under the camera, at its height. Sky pixels (no depth) are untouched. On a display
target (no HDR scene capture) the air's light is display-encoded and blended there, an approximation; with Bloom,
tonemapping or another HDR capture it is exact. Needs WebGPU.

## Hillaire sky: from the ground to space

`HillaireSky` from `@margoengine/sky/hillaire` is a physically based sky after Hillaire 2020 ("A Scalable and Production
Ready Sky and Atmosphere Rendering Technique"): Rayleigh and Mie scattering, Mie absorption and an ozone layer, single
scattering toward the sun plus multiple scattering, so sunsets turn orange and red by the air alone and the zenith stays
blue through twilight, the ozone's doing. It is its own plugin, drawn behind the scene where `Sky` draws, so use it in
place of `Sky`, not with it.

```ts
import {Engine} from 'margoengine/core';
import {Bloom} from 'margoengine/post/bloom';
import {HillaireSky} from 'margoengine/sky/hillaire';
import {AerialPerspective} from 'margoengine/sky/aerial';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu', camera: {far: 100000}});
const bloom = Bloom.attach(engine);
const sky = HillaireSky.attach(engine, {hours: 18.2, timeScale: 0});
AerialPerspective.attach(engine, {sky, depth: () => bloom.depthTexture});
sky.options.altitude = 400000; // the same sky from orbit, 400 km up
```

Two tables are made once per atmosphere, shared with `AerialPerspective`: the transmittance to the top (256 × 64) and
multiple scattering (32 × 32). Each frame a compute pass fills a 192 × 108 sky-view table, the sky around the camera by
azimuth from the sun and zenith angle, its rows squeezed toward the horizon where the colour changes fastest (Hillaire
2020 section 5.2); every sky pixel then reads it. Above the top of the air (100 km on Earth) the table no longer fits
the view, so each pixel marches its own ray through the air instead: the planet's sunlit ground (Lambert, the ground
albedo), the blue limb and black space. The sun's disc (0.27° in radius) is the illuminance over its solid angle, dimmed by the air in front of it,
held at 65,504 (the largest half float, as the true value at illuminance 20 is about 300,000); `sunDisc: false` leaves it out.
`sky.sunTransmittance` holds the share of sunlight (rgb) that reaches the camera, worked out on the CPU each frame:
use it to colour the scene's sun.

| Option | Default | Meaning |
| --- | --- | --- |
| `hours` | 12 | clock time; the sun moves as `Sky`'s does (rises at 6 in +x) |
| `timeScale` | 1 / 3600 | clock hours per second; 0 holds the time |
| `sunDirection` | from the clock | direction toward the sun, in place of the clock |
| `exposure` | 0 | stops: the sky is multiplied by 2^exposure |
| `sunIlluminance` | 20 | the sun at the top of the air, in the scene's light units (`Sky`'s Bruneton scale) |
| `metersPerUnit` | 1 | metres per world unit |
| `altitude` | 0 | metres added to the camera's height, up to 100,000 km |
| `sunDisc` | true | draw the sun's disc |
| `atmosphere` | Earth | the planet's air, kilometres (`EARTH_ATMOSPHERE`, Hillaire 2020 Table 1) |

`AerialPerspective` and `VolumetricClouds` take it as their `sky`. The planet's centre is taken under the camera, at
its height. It does not light the scene itself (no engine sun, ambient or reflection map): set core's sun from
`sky.sun` and `sky.sunTransmittance`. The clouds still colour their sunlight with the root sky's turbidity model.
On a display target (no HDR scene capture) the sky is display-encoded there. Needs WebGPU.

### Other worlds: presets

`@margoengine/sky/presets` gives `HillaireSky` and `AerialPerspective` the air and sunlight of other worlds. Each preset
is `{atmosphere, sunIlluminance}`, so spread it into the options:

```ts
import {Engine} from 'margoengine/core';
import {HillaireSky} from 'margoengine/sky/hillaire';
import {MARS, marsAtmosphere} from 'margoengine/sky/presets';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
// A clear day on Mars: a butterscotch sky with a bright glow around a smaller, dimmer sun.
const sky = HillaireSky.attach(engine, {...MARS, hours: 10});
sky.options.atmosphere = marsAtmosphere(3); // later, a regional dust storm
```

`EARTH` is the entries' own default. `MARS` takes its size and air from NASA's Mars Fact Sheet (radius 3,389.5 km,
6.36 mb at about 214 K, scale height 11 km, 95% CO2, Bond albedo 0.25, 0.431 of Earth's sunlight). Its Rayleigh
scattering is CO2's measured cross section (Sneep and Ubachs 2005) at that density, about 58 times thinner than
Earth's air, so the dust colours the sky: `marsAtmosphere(opticalDepth)` spreads that dust optical depth (0.5 on a
clear day, 0 to 10) over the gas's scale height, scattering 0.975 of the red light it meets, 0.94 of the green and
0.90 of the blue (Wolff et al. 2009, the blue Margo's reading of their curve), forward with asymmetry 0.67 (Chen-Chen
et al. 2019). Any atmosphere may now give `mie` and `mieAbsorption` per channel. On a Radeon 680M, 90 degrees from a
sun 40 degrees up, the clear Martian sky reads red over blue 1.17 (Earth's reads blue over red 4.7) and a storm 1.82.

## Light shafts

`LightShafts` from `@margoengine/sky/shafts` adds god rays: light from the sun streaming past mountains, buildings and
trees, and through the gaps in `VolumetricClouds`, in the sky itself (Mitchell 2007, "Volumetric Light Scattering as a
Post-Process", GPU Gems 3 ch. 13). It needs the scene's depth.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {Bloom} from 'margoengine/post/bloom';
import {VolumetricClouds} from 'margoengine/sky/volumetric-clouds';
import {LightShafts} from 'margoengine/sky/shafts';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu', camera: {far: 100000}});
const bloom = Bloom.attach(engine);
const sky = Sky.attach(engine, {hours: 17.5, timeScale: 0});
const clouds = VolumetricClouds.attach(engine, {sky, coverage: 0.5, depth: () => bloom.depthTexture});
const shafts = LightShafts.attach(engine, {sky, clouds, depth: () => bloom.depthTexture});
shafts.options.intensity = 0.2;
```

Each frame a half-size mask marks where the sun can be seen: the share of each texel's 2 × 2 pixels that is open sky
by the scene depth, times the clouds' transmittance along that view ray (their own density field, drift and options,
marched `cloudSamples` times). Each pixel then samples the mask `samples` times on the line toward the sun's place on
screen, weighting each step by `decay`; that weighted share of lit air, times the sunlight (the sky's sun colour,
illuminance and exposure), the air's Henyey-Greenstein phase toward the camera and `intensity`, is added to the scene.
Pixels whose line to the sun crosses only geometry gain nothing. The shafts fade out as the sun passes 75 degrees off
the view axis and stop when it is behind the camera.

| Option | Default | Meaning |
| --- | --- | --- |
| `depth` | required | the scene's reversed-Z depth each frame |
| `sky` | none | the sky to follow (`Sky` or `HillaireSky`); without it `sunDirection` (default [0.3, 0.6, 0.4]) |
| `clouds` | none | `VolumetricClouds` the light comes through |
| `intensity` | 0.1 | share of the sunlight the lit air scatters toward the camera, 0 to 100 |
| `anisotropy` | 0.6 | Henyey-Greenstein g, 0 to 0.95: how strongly the shafts gather near the sun |
| `decay` | 0.97 | weight kept from one sample to the next, 0.5 to 1 |
| `length` | 0.9 | share of the way to the sun that is sampled, 0.05 to 1 |
| `samples` | 48 | mask samples per pixel, 8 to 128 |
| `cloudSamples` | 12 | cloud samples per mask texel, 2 to 64 |
| `sunIlluminance` | from the sky | sun strength in the sky's units (as `AerialPerspective`) |

It is a screen-space effect: a sun off screen still casts shafts from its place beyond the edge, but occluders off
screen cast none, and an orthographic camera gets none. The moon casts no shafts. On a display target (no HDR scene
capture) the light is display-encoded and blended there, an approximation; with Bloom, tonemapping or another HDR
capture it is exact. Needs WebGPU.

## Sun, ambient and a sky that lights the scene

`@margoengine/sky/sun` sets core's one sun and its ambient light with named options and typed angles, and builds sky
options in which the sky lights the scene. It lives here, not in core or the stage (both frozen, and they grow by zero
bytes for it), because this package already owns the sun's angles (`sunDirectionFromAngles`) and the sky's sunlight;
it is a separate entry, so an app that only draws a sky does not load it, and an app that only sets the sun loads
this entry alone (it imports nothing else from the sky).

A 35 degree sun, in three lines:

```ts
import {Engine} from 'margoengine/core';
import {degrees, setSun} from 'margoengine/sky/sun';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
setSun(engine, {azimuth: degrees(135), elevation: degrees(35), intensity: 3});
```

A sky that lights the scene: its sun disc and the engine's sun share one direction, and surfaces take the sky's
colours as ambient light.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {degrees, radians, setAmbient, getSun, sunlitSky} from 'margoengine/sky/sun';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {...sunlitSky({elevation: degrees(35)}), turbidity: 3});
const fromMath = radians(Math.atan2(1, 1)); // 45 degrees; fromMath.degrees === 45
console.log(getSun(engine).direction, fromMath.degrees, sky.name);
```

- **Angles carry their unit.** `degrees(35)` and `radians(0.61)` make an `Angle`; read `.degrees` or `.radians`. An
  `Angle` is not a number: `angle * 2` or `Number(angle)` throws a TypeError, and a plain number where an angle is
  expected throws a TypeError that says to wrap it. `sunDirectionFromAngles` (in `@margoengine/sky`) still takes plain
  degrees; `sunDirectionFrom(azimuth, elevation)` is its typed form. There is no warning for small plain-number
  elevations: 0.6 degrees is a real sun on the horizon, so a guess would give false alarms; typed angles make the
  mix-up impossible instead.
- **`setSun(target, options)`** (`target` is an `Engine` or a `Scene`): `direction` (any non-zero vector toward the
  sun) or `azimuth` with `elevation` (from +Z toward +X; elevation -90 to 90 degrees), `color` (linear RGB) and
  `intensity`. Options left out keep their current value; core's defaults are direction [3, 5, 4], white, intensity 3.
  It writes `lighting.direction` (w is the intensity) and `lighting.radiance` (rgb is the colour), and returns the sun
  as `getSun(target)` reads it: a unit `direction`, `color`, `intensity`. Every value is checked first, so a bad call
  changes nothing.
- **`setAmbient(target, {color, intensity})`**: the light every surface gets from all sides, `color * intensity` times
  its base colour. Defaults (core's): white, 0.15. It writes `lighting.radiance[3]` and `lighting.ambient`;
  `getAmbient(target)` reads them back.
- **A sky that drives the light wins.** While a sky with `lighting` is on the target, `setSun` throws MargoError
  `state` (the sky writes the sun every frame, so the value would be lost); with `lighting.ambient` or `environment`,
  `setAmbient` does. Change `sky.options.sunDirection` and `sky.options.lighting` instead.
- **Indoors.** The sky's light (`lighting.ambient`) reaches every surface with no visibility term, so a shed's floor is
  as bright as the open ground. Put a `LightProbes` volume over the interior and pass the sky as its `sky`
  (`@margoengine/environment/probes`, README "Sky light indoors"): outside the volume the sky lights the scene exactly
  as here, inside only through the door and windows the probes see.
- **`sunlitSky(options)`** returns `SkyOptions` with `sunDirection` and `lighting` set: `azimuth` (default
  `degrees(135)`), `elevation` (default `degrees(35)`), `intensity` (default 3, core's own sun strength, so the scene
  keeps its brightness when the sky takes over; the air dims a lower sun) and `skyAmbient` (default true: the sky's
  colours light surfaces, above the `skyEnvironmentFloor`). It needs the `lighting` feature (the root `Sky` has it). A
  `Sky` without `lighting`, its default, draws a backdrop and lights nothing: existing scenes and their pixels stay as
  they were.
- **`sunPath({latitude, dayOfYear, hour})`** places the sun for a latitude (an `Angle`, -90 to 90), a day of the year
  (integer 1 to 366) and local solar time (`hour` 0 to 24, 12 is solar noon), from Spencer's 1971 Fourier series for
  the declination and the equation of time. It returns `azimuth` and `elevation` (ready for `setSun` or `sunlitSky`),
  the unit `direction`, the `declination` and `equationOfTime` (minutes). World axes match `@margoengine/biomes`: north
  is -Z and east is +X, so azimuth 0 (+Z) is due south. Polar night gives a negative elevation, never NaN.

```ts
import {Engine} from 'margoengine/core';
import {degrees, setSun, sunPath} from 'margoengine/sky/sun';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sun = sunPath({latitude: degrees(47), dayOfYear: 172, hour: 16});
setSun(engine, {azimuth: sun.azimuth, elevation: sun.elevation});
console.log(sun.elevation.degrees, sun.equationOfTime);
```

- **Exposure.** Core has no exposure setting. Scene exposure is `exposure` (stops, default 0) on `Tonemap` from
  `@margoengine/tonemap`, read every frame: `Tonemap.attach(engine, {exposure: 1})`, then
  `tonemap.options.exposure = 0.5`. The sky's own `exposure` option brightens only the sky backdrop.

## Stylized night

Set `night` to replace the default night gradient with a moonlit sky: a zenith-to-horizon gradient, twinkling
stars above 15° and a moon disc with phase, glow and size. The object is read every frame, so mutate it for
live controls. Each star is drawn at least 0.7 px in radius and dimmed by the area it covers, so it keeps its
energy and holds steady while the camera moves; stars too small for the target (the 64 × 32 reflection) fade out.
Stars twinkle on independent phases. The moon lies beyond the air: its disc hides the stars while the gradient
and the glow in front show over it, the unlit part adds only earthshine (strongest near new moon), and the rim is
filtered by the pixel or texel footprint.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {hours: 0, timeScale: 0, night: {
  zenithColor: [0.015, 0.025, 0.065], horizonColor: [0.08, 0.09, 0.15], hazeDensity: 1,
  moonDirection: [0.4, 0.7, 0.5], moonSize: 0.038, moonPhase: 0.85, moonColor: [6.4, 7.6, 9.6],
  glowIntensity: 1.2, starIntensity: 0.8, starTwinkleIntensity: 1,
}});
sky.options.night!.moonPhase = -0.2;
```

Those are the defaults. Colours are non-negative linear RGB; `moonDirection` is normalized; `moonSize` is an
angular radius in radians between 0 and π/2; `moonPhase` clamps to −1 (new) … 1 (full), or takes a name (below); glow, star and twinkle
intensities and `hazeDensity` clamp to zero or above (zero twinkle holds stars steady, zero haze removes the
gradient). `moonLitBySun: true` (default false; `AstroSky` sets it) turns the lit side toward the sky's sun, as the real
moon's is, instead of a fixed side. The stylized night shows where the sun is below the horizon, blended by `nightFactor` at dusk, and
its colours are written as given, also on display targets (the physical day sky is tonemapped there). It
replaces the separate preset moon; leave `lighting.moon` unset with it. The shaders hold the stylized night only
while `night` is set: setting or clearing `sky.options.night` compiles the sky, fog, reflection and lighting
shaders again on the next frame, as a model switch does; editing its fields recompiles nothing.

### Moon presets

Call a moon by name. `night.moonPhase` takes a phase name, and `lighting.moon` takes `brightness` and `color`
presets that change the moon's light and the disc the night draws together. Numbers still work, and the
presets combine with each other and with `cloudCover`, `extinction` and `intensity`. An unknown name fails the
type check, and at run time it throws a RangeError.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
// A waning half moon at perigee, then a blood moon in eclipse.
const sky = Sky.attach(engine, {hours: 23, timeScale: 0, night: {moonPhase: 'lastQuarter'}, lighting: {moon: {brightness: 'bright'}}});
sky.options.night!.moonPhase = 'full';
sky.options.lighting!.moon = {color: 'blood'};
```

| `night.moonPhase` | Phase | Lit | Lit limb |
| --- | --- | --- | --- |
| `'new'` | -1 | 0% | |
| `'waxingCrescent'` | -0.7071 | 14.6% | right |
| `'firstQuarter'`, `'half'`, `'quarter'` | 0 | 50% | right |
| `'waxingGibbous'` | 0.7071 | 85.4% | right |
| `'full'` | 1 | 100% | |
| `'waningGibbous'` | 0.7071 | 85.4% | left |
| `'lastQuarter'` | 0 | 50% | left |
| `'waningCrescent'` | -0.7071 | 14.6% | left |

The phase is the cosine of the phase angle, so (phase + 1) / 2 of the disc is lit. The principal phases fall at
elongations of 0, 90, 180 and 270 degrees (J. Meeus, "Astronomical Algorithms", 2nd ed., 1998, ch. 49); a
crescent or gibbous moon takes the middle of its octant, a phase angle of 135 or 45 degrees. A waning name lights
the left limb (as seen from the northern hemisphere), in WGSL and in the WebGL2 compatibility layer; a number or a
waxing name lights the right one, and `moonLitBySun` turns the lit limb toward the sky's sun instead.
`moonPhase(name)`, `moonWaning(name)` and `MOON_PHASES` give the same values.

| `lighting.moon` preset | Light | Disc | Source |
| --- | --- | --- | --- |
| `brightness: 'bright'` | x 1.164 | 1.079 times as wide, as bright per area | perigee supermoon, (384,400 / 356,375 km)^2 (Meeus 1998, ch. 50) |
| `brightness: 'dim'` | x 0.5 | x 0.794 | thin cloud before the moon (USNO Circular 171, Janiczek and DeYoung 1987) |
| `color: 'blood'` | x 1.06e-4 | deep red, x 0.047 | total lunar eclipse: V -2.8 at mid-totality against -12.74 full; sunlight through a limb chord 12 km up (Garcia Munoz and Palle, JQSRT 112, 2011) |
| `color: 'reddened'` | through 5 degrees of air | orange | the low moon: Kasten and Young airmass 10.3 (Applied Optics 28, 1989), extinction `extinction` per airmass |

A number `brightness` scales the light and the disc. The light is photometric and takes each factor whole; a red
moon's light is dim enough that the night's blue shift takes most of its red, as the eye does, so the red shows on
the disc. The disc is the stylized night's, in display terms, so it changes as the eye judges brightness, as
luminance^0.33 (S. S. Stevens, "To honor Fechner and repeal his law", Science 133, 1961). The reddening uses the
sky's own air: Rayleigh with an 8 km scale height and the ozone layer of Hillaire 2020 and Bruneton 2017.
`moonLook(brightness, color, up, extinction)` gives the factors. Without a stylized night, the sky's own moon disc
follows the light. Defaults: phase 0.85, `brightness` 1, the moon's own colour.

## Fog

For lightweight distance haze, enable fog with an active scene capture:

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {Bloom} from 'margoengine/post/bloom';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Bloom.attach(engine);
const sky = Sky.attach(engine);
sky.options.fog = {start: 45, density: 0.008};
```

A 4x capture resolves `depthTexture` only when it presents, after the fog, so over Bloom or a PostStack the fog reads
the capture's own samples of this frame.

`start` is a clear distance in world meters (default 40); `density` is inverse
meters (default 0.01, range 0-1). Visibility is
`exp(-((max(0, distance - start) * density) ** 2))`; zero density disables the pass.
Fog uses the sky model's direction-dependent radiance, exposure and night fade,
with the same horizon sampling as the background and borrowed water environment.
With a stylized night it takes the gradient alone, never the stars or the moon.
It composites after opaque surfaces and water, before VFX and tone mapping,
without another colour target or blur. Clear sky pixels are untouched, preserving
sun/moon discs. Both 1x and 4x depth work; multisampled depth must match the scene's
sample count. When supplying an explicit `depth` callback, use a texture that matches the viewport and has
`TEXTURE_BINDING` usage. Return the provider's current texture so resize and device restoration pick up the new resource.
Fog is enabled only while `fog` is set.

Three optional fog fields change the look: `falloff: 'exp'` uses `1 - exp(-optical)` instead of the squared
default; `height` adds density below y = 0 (optical depth × (1 + height × metres below 0), e.g. 0.065 for a
sea haze); `color` replaces the sky radiance with a fixed linear colour. The `night-fog` trace configuration
(`test/configs.js`) uses `{start: 0, falloff: 'exp', height: 0.065, color: horizon}`. This is homogeneous distance haze, without height fog,
volumetric light shafts or particle-depth fog; large scenes need a suitable
camera far plane.

The clock and sun update before rendering, so shadows and scene lighting can use
the same frame's direction. Set `lighting: {intensity: 6, minimum: 0.15}` to copy
the sun direction, strength and transmittance colour into engine lighting.
Intensity defaults to 1 and minimum to 0; the radiance colour is always written.
Omit `lighting` to keep independent scene lighting.

With `ambient`, surfaces facing down get the light the ground reflects: a level Lambertian ground of albedo
`lighting.ground` (default 0.2, the daylight models' standard ground) lit by the sky and the sun, added to the
sky's spherical harmonics each frame. Set it to the ground the scene stands on, for example
`lighting: {intensity: 5, ambient: {day: [0.03, 0.031, 0.033], night: [0.01, 0.015, 0.03]}, ground: 0.35}` for dry
sand, 0.8 for fresh snow or 0.1 for grass; 0 keeps the sky map's dark ground. The ambient floor is the least light
any side gets, so keep it under the ground's light (about a fifth of the level ground's): a floor above the sky's
own light lights every side alike. Reflections still show the sky map's dark ground below the horizon.

For a day/night scene, enable the optional moon and RGB ambient floor. A scene holds one Sky, so set this up on a
new engine, or pass these options to the `Sky.attach` you already have; a second `Sky.attach` on one scene throws:

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Sky.attach(engine, {hours: 18.5, lighting: {
  intensity: 6, color: [1, 0.8, 0.54],
  moon: {intensity: 0.6, color: [0.25, 0.45, 0.75]},
  ambient: {day: [0.18, 0.18, 0.18], night: [0.02, 0.04, 0.09]},
}});
```

Give `moon: {}` and the moonlight follows the moon the sky draws, with no numbers to choose ([moonlight from the
drawn moon](#moonlight-from-the-drawn-moon)); the example's `intensity` and `color` replace it, and `brightness` and
`cloudCover` adjust either. Its visual preset
sits about 12° above the horizon. Its disc, borrowed environment and separate water
glint use one fade, starting when the sun drops below the horizon and reaching full
strength with the sun about 7° below the horizon (about 18:28 on this clock). They fade
out together before sunrise; there is no daytime moon glint. Scene lighting and
PCSS shadows use one light, the stronger of sun and moon: the sun fades out through
its transmittance as its disc sets before the moon fades in, so the light changes
direction once, below 1% of noon strength, instead of sweeping across the sky. The
atmospheric background has its own earlier twilight fade. The moon's place comes from the night's `moonDirection`
(or `AstroSky`'s real moon) and its light from that place and the night's `moonPhase`. The background fades to night
even when scene moon lighting is omitted.

### Twilight

After sunset the sky still lights the scene. With `lighting` set, `sky.twilightLight` carries the twilight sky's light.
Its illuminance on the ground is the U.S. Naval Observatory's measured sky term against the sun's altitude (P. M.
Janiczek and J. A. DeYoung, USNO Circular 171, 1987): 756 lux at sunset, 2.99 lux at the end of civil twilight (-6
degrees), 0.0044 at the end of nautical twilight (-12), times the sky's night blend (`sky.nightFactor`). The
environment draws the day sky times one minus that blend, so the two hand the sky's light over between them from the
sun 4.6 degrees up to 6.9 degrees down, never counting it twice and never switching on at once. The engine light is
the sun's beam plus the twilight, summed as irradiance vectors as the two add in reality: both come from the sun's
side, so as the beam goes out while the disc sets the light turns up toward the glow, and the moon takes over as a
whole body only once it is the stronger of the two, while both are dim. Its colour is sunlight scattered once by the air over the shadow, through the ozone layer
(E. O. Hulburt, JOSA 43, 1953), held past -6 degrees, with the night's blue shift for its level, so nautical
twilight is the bluest (Spitschan et al., Scientific Reports 6, 2016). It comes from the sun's side of the sky, 45
degrees up, in the sun's units: `intensity` 1 makes it a share of noon, `intensity: SUN_ILLUMINANCE` (108,437 lux)
makes it lux, on the moon's scale.

```ts
import {Engine} from 'margoengine/core';
import {Sky, SUN_ILLUMINANCE, twilightIlluminance} from 'margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
// An overcast dusk, the sun 6 degrees down, lit in lux.
const sky = Sky.attach(engine, {hours: 18.4, timeScale: 0, lighting: {intensity: SUN_ILLUMINANCE, twilight: {cloudCover: 1}, moon: {}}});
sky.options.lighting!.twilight = {brightness: 0.5}; // a dimmer dusk, read every frame
console.log(twilightIlluminance((-6 * Math.PI) / 180).toFixed(2), 'lux at the end of civil twilight');
```

| `lighting.twilight` | Default | Meaning |
| --- | --- | --- |
| (the option) | `{}` | `false` turns twilight off. |
| `brightness` | 1 | Scales it, 0 to 10,000. |
| `cloudCover` | the `clouds` sheet's `coverage`, else 0 | Share of the sky under cloud, 0 to 1: dims it by `cloudTransmittance`. |
| `color` | derived | Linear RGB; set, it replaces the colour and keeps the lux. |

The twilight is one directional light, so it casts the engine light's shadows from 45 degrees, where the real
twilight sky lights from all of it; `ambient` adds the sky's own diffuse light.

### Moonlight from the drawn moon

With `lighting.moon` set and no `intensity`, the sky lights with the moon it draws, every frame: phase, altitude and
air set the illuminance in lux (a directional light's unit, as in `@margoengine/clustered/units`), and the colour is
moonlight's own with the eye's night blue shift. `moonlight` (from `@margoengine/sky` or the small
`@margoengine/sky/moonlight`) gives the same numbers for your own lights. For the sky that draws the moon, see `@margoengine/sky/night-preset`.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {moonlight} from 'margoengine/sky/moonlight';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const moonDirection: [number, number, number] = [-0.45, 0.42, -1];
Sky.attach(engine, {hours: 23, timeScale: 0, night: {moonDirection, moonPhase: 0.75}, lighting: {moon: {}}});
const light = moonlight(0.75, moonDirection);
console.log(light.illuminance.toFixed(3), 'lux', light.color, light.intensity);
```

| `lighting.moon` | Default | Meaning |
| --- | --- | --- |
| `intensity` | derived | Light strength; set, it replaces the derived lux. 0 or more. |
| `brightness` | 1 | Scales the strength, derived or set, and the drawn disc, 0 to 10,000: 2 for a moon twice as bright, 0.5 for half. Or a preset, `'bright'` or `'dim'` ([moon presets](#moon-presets)). |
| `color` | derived | Linear RGB; set, it replaces the light's colour and keeps the lux. Or a red-moon preset, `'blood'` or `'reddened'`. |
| `extinction` | 0.172 | V-band extinction, magnitudes per airmass, 0 to 2 (about 0.2 to 0.3 at sea level). |
| `cloudCover` | the `clouds` sheet's `coverage`, else 0 | Share of the sky under cloud, 0 to 1: dims the moonlight under it by `cloudTransmittance`. |

Every scene can pick its own moon from these and keep it in the package's terms: a brighter or dimmer moon is a
`brightness` (or an `intensity`), a storm is a `cloudCover`.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {cloudTransmittance} from 'margoengine/sky/moonlight';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
// A moon one and a half times the real one, behind a sky three quarters covered.
const sky = Sky.attach(engine, {hours: 23, timeScale: 0, night: {moonPhase: 0.9}, lighting: {moon: {brightness: 1.5, cloudCover: 0.75}}});
sky.options.lighting!.moon!.brightness = 0.5; // a dimmer moon, read every frame
console.log(cloudTransmittance(0.75).toFixed(3), 'of the moonlight reaches the scene under that cloud');
```

- Cloud: F. Kasten and G. Czeplak, "Solar and terrestrial radiation dependent on the amount and type of cloud",
  Solar Energy 24(2):177-189, 1980, fitted global irradiance under cover N/8 (N in oktas) to 1 - 0.75 (N/8)^3.4 from
  ten years of Hamburg records: 93% through a half-covered sky, a quarter through an overcast one. It is the global
  (direct plus diffuse) share, the light the scene's one moon light stands for. Cloud droplets scatter all
  wavelengths alike (Bohren, Am. J. Phys. 55, 1987), so the cloud adds no colour; the colour (unless `color` is set)
  is moonlightColor of the dimmer light, so the moon under cloud is bluer by the same night shift. The cloud dims
  only the light under it: `sky.lights[1]` is the moonlight above the cloud (the cloud tops, the disc, water glints)
  and `sky.moonUnderClouds` the light the engine takes. Give `cloudCover: 0` when volumetric cloud shadows
  (`@margoengine/sky/cloud-shadows`) already shade the moon's light.

- Illuminance: Krisciunas and Schaefer, "A model of the brightness of moonlight", PASP 103:1033-1039, 1991
  (doi:10.1086/132921): above the air 10^(-0.4 (3.84 + 0.026 |a| + 4e-9 a^4)) foot-candles for phase angle
  a = acos(`moonPhase`) in degrees (0.313 lux full, 0.367 of that at phase 0.75), times 10^(-0.4 k X) for the
  airmass X = (1 - 0.96 sin^2 z)^(-1/2). Without a night, a full moon. A moon at or below the horizon gives 0.
- Colour: moonlight is sunlight off a surface whose albedo rises toward the red, so it is redder than sunlight:
  B - V 0.92 (Cox, ed., "Allen's Astrophysical Quantities", 4th ed., 2000), 4,943 K by Ballesteros (EPL 97, 2012).
  It looks blue because rods feed the blue mechanism at night (Trezona, Vision Research 10, 1970). Jensen, Premoze,
  Shirley, Thompson, Ferwerda and Stark ("Night Rendering", University of Utah UUCS-00-016, 2000; the basis of "A
  Physically-Based Night Sky Model", SIGGRAPH 2001, and of Thompson, Shirley and Ferwerda, JGT 7(1), 2002) shift a
  luminance Y toward the chromaticity (0.25, 0.25) by 1 - s, s the smoothstep of log10 Y from -2 to 0.6. The
  engine's tone mapping has no scotopic stage, so the light carries the shift, for Y = illuminance / pi (white paper
  facing the moon): a half moon gives the full night blue, a full moon high up nearly its own colour.
- Until 2026-11-16 the moonlight was a tenth of the sun's whatever the phase, in a fixed blue (KB-CABIN-MOON1).

With `ambient`, the sky lights the scene itself. Each frame it renders a 64 × 32
environment (the same sky water reflects, clouds and moon included, the sun's disc
left to the engine light) with three box-filtered mips, projects it onto nine
spherical harmonics (Ramamoorthi and Hanrahan 2001) on the GPU, and patches the
standard scene shader (including scatter and mesh terrain) at group 0, bindings 8,
10 and 11. Surfaces get directional diffuse light from the harmonics, never below
the `ambient` floor for the time of day, plus split-sum sky reflections (Karis 2013):
the environment blurred through its mips by roughness, times Karis's analytic
environment BRDF. Glass and glossy paint now reflect the sky by day. The term is
named `margoAmbient`, so SSAO occludes it. A shader holds one ambient term: when an
`EnvironmentLighting` or `LightProbes` lights the scene too, the explicit environment owns the
ambient of core's shader (the HDR, not the sky, lights the meshes) and the sky still drives the sun
and moon; a glTF or FBX model in the sky's scene takes the sky's ambient by itself (gltf/pbr `model.sceneSky`, default
true; `sky.add(model)` still works and lights a model from another scene), and one given `environment.add(model)` keeps
the environment's. It composes with shadows and clustered lights; custom
renderers using their own shaders need their own ambient integration.

`sky.add(terrain)` lights a clipmap `Terrain` (`@margoengine/terrain`) the same way: the sky's light, from the shaded
normal, takes the place of terrain's flat `lighting.ambient` x `radiance[3]` term in its lighting group (group 1,
bindings 8, 10 and 11), times whatever the terrain's effects multiplied that term by (layer materials' occlusion,
relief lighting's sky visibility); a `HemisphereLight` added to the terrain stays beside it. The sky patches at
`finish`, after every other terrain effect, so it may be added before or after `TerrainMaterials`. Shaded ground then
takes the sky's colour as the meshes on it do (KB-TERRAIN-SKYAMBIENT1; `BiomeView` adds its ground to its `sky`).

```ts
import {EngineKernel} from 'margoengine/core';
import {Terrain} from 'margoengine/terrain';
import {Sky} from 'margoengine/sky';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const sky = new Sky({hours:15, lighting:{ambient:{day:[0.05,0.05,0.06], night:[0.01,0.01,0.02]}}});
engine.use(sky);
const terrain = Terrain.attach(engine, {
  resolution:64, levels:6, cellSize:1, origin:[-50,-50], size:[100,100], heightScale:20,
  layers:[0.3,0.2,0.4,0.2].map((scale)=>({height:[-20,100] as [number,number],slope:[0,1] as [number,number],scale})),
  textures:device=>{
    // 6 = TEXTURE_BINDING | COPY_DST: flat grey demo ground; replace with your assets.
    const heightmap = device.createTexture({size:[4,4],format:'r32float',usage:6});
    device.queue.writeTexture({texture:heightmap},new Float32Array(16),{bytesPerRow:16},[4,4]);
    const layers = device.createTexture({size:[1,1,4],format:'rgba8unorm-srgb',usage:6});
    device.queue.writeTexture({texture:layers},new Uint8Array(16).fill(128),{bytesPerRow:4,rowsPerImage:1},[1,1,4]);
    return {heightmap,layers};
  }
});
const removeSkyLight = sky.add(terrain); // removeSkyLight() goes back to the flat ambient
engine.start();
```

The light map is drawn in the sky's own units and the engine sun in `lighting.intensity`'s, where 1 is the zenith sun
on the ground. Each frame `sky.lightScale`, the intensity over the zenith sun on the ground in sky units (4 pi x 0.55
for Preetham, the clouds' calibration; 20 times the zenith transmittance down to the camera for Bruneton), takes the
map into the sun's units, so a clear sky gives its measured share of the light on level ground at any intensity. On an
RTX A6000, WebGPU and the WebGL2 layer alike, with the sun 60 degrees up at turbidity 2, the sky gives 0.18 of the light
on a level grey plate under Preetham (clear skies measure 0.1 to 0.2, Erbs, Klein and Duffie 1982) and 0.064 under
Bruneton, whose air at that turbidity is nearly free of aerosol (Rayleigh air alone gives about 0.05, Bird and Hulstrom
1981), and the share holds within 0.01 from intensity 1 to 3 (`test/sky-light-units-check.mjs`). `await sky.irradiance(normal?, { signal? })`
(default normal straight up) reads back the light the shader took in the last frame: irradiance over pi in the engine
light's units, linear RGB, from the nine harmonics and never below the floor, or undefined while the sky lights
nothing. Against the sun's beam (intensity x colour x cos / pi) it predicts the plate's share within 0.003 in that test
(0.1752 against 0.1764 and 0.0641 against 0.0615, WebGPU and the WebGL2 layer); the shot tool records it for the look
checks' T6 limits. The `ambient` floor is
in engine units and is not scaled; the sky's `exposure` brightens the scene's sky light as it brightens the backdrop.
With `environment: true` the map follows the engine sun's own intensity, whatever set it.

- Change note (2026-11-17, KB-SKY-SUNUNITS1): every scene lit by `lighting.ambient` or `environment` takes less light
  from its sky. Until now the map lit in sky units: the clear sky gave level ground 1.3 to 1.5 times the sun's light (a
  share of 0.61 under Preetham and 0.56 under Bruneton at intensity 1) and a brighter sun only diluted it. The sky light
  is now 0.145 of before at intensity 1 under Preetham (0.43 at `sunlitSky`'s default 3) and 0.056 under Bruneton (0.17
  at 3). Faces turned from the sun and shaded ground are darker and less blue, sunlit tops change little, sky reflections
  on glossy surfaces dim by the same factor, and a night lit by the map dims with it down to the `ambient` floor.
  `VolumetricClouds` with `dimLight: false` give the scene the same deck light as before, now in the map's units.

When the sky is the only light, set `environment: true` (needs the `lighting` entry) to get that sky light as a
fallback environment without driving the sun: metals, which have no diffuse term, are lit by the sky's reflections
instead of rendering black. It uses the floor `skyEnvironmentFloor` (day `[0.04, 0.04, 0.04]`, night
`[0.01, 0.015, 0.03]`), gives way to `lighting.ambient` when you set both, and adds nothing while an
`EnvironmentLighting` (or anything else that patches the scene shader first) has already lit the meshes, so an
explicit environment always wins. Default false; `@margoengine/react`'s `<Sky>` turns it on.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
Sky.attach(engine, {hours: 12, environment: true});
```

### Coverage: where the sky shows

Set `coverage: true` and each frame the sky also records which pixels it drew in `sky.coverageTexture`: an `r8unorm`
texture the size of the frame target, 1 where the sky shows and 0 where geometry is in front of it, with the share of
the samples at a multisampled edge. It is the sky's own full-screen draw repeated into that texture against the same
depth with the same test, so it is exact under a `PostStack` too, which draws the scene into a depth of its own. The
frame's pixels do not change. Default false: nothing extra is drawn or allocated. Views drawn into a target of their
own are left out; clearing the option, a device restore and `dispose()` free the texture. The shot tool reads it as
the `sky-coverage` mask for its `skyClip` look check (docs/shots.md, Masks).

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {hours: 12, coverage: true});
engine.render({delta: 0});
const coverage = sky.coverageTexture!; // r8unorm: 1 where the sky shows
console.log(coverage.format, coverage.width, coverage.height);
```

`sky.nightFactor` exposes the same dusk/dawn blend: 0 in daylight and 1 at night.
It updates before rendering, including paused manual renders. To switch local
lights and emissive batches together, set `lights.intensityScale =
instances.emissiveIntensity = () => sky.nightFactor` using clustered and scatter.

## Astronomical sky: the real sun, moon, planets and stars

`AstroSky` from `@margoengine/sky/astro` puts the sun, the moon (its orbit, phase and size), the seven planets and the
stars of a catalogue where they are for a date, a time and a place on the Earth. It drives a `Sky`: the sun's
direction, and with a `night` option the moon's direction, phase and size, with its lit limb toward the sun. It draws
the stars and planets as points on the sky, refracted by the air near the horizon, dimmed by the air mass and faded in
with the sky's night. The stars come from the Yale Bright Star Catalogue (CDS V/50 `catalog.gz`, 9,096 stars to about
magnitude 6.5), read as the archive serves it.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {degrees} from 'margoengine/sky/sun';
import {AstroSky, fetchBrightStarCatalog} from 'margoengine/sky/astro';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {night: {}, timeScale: 0});
const astro = AstroSky.attach(engine, {
  latitude: degrees(51.48), longitude: degrees(0), // Greenwich
  date: new Date('2026-08-12T22:30:00Z'), timeScale: 60, sky,
});
astro.options.catalog = await fetchBrightStarCatalog('catalog.gz'); // from CDS V/50, served beside your page
console.log(astro.moon.illumination, astro.planets.find((p) => p.name === 'jupiter')!.elevation.degrees);
```

Options are read every frame from `astro.options`:

| Option | Default | Meaning |
| --- | --- | --- |
| `latitude`, `longitude` | required | where on the Earth, as `degrees(...)`; longitude east positive |
| `date` | now | the moment shown; assign it to jump. `astro.date` is the running clock |
| `timeScale` | 1 | sky seconds per real second (0 holds the moment) |
| `sky` | none | the `Sky` to drive; with `night` set, its moon too |
| `catalog` | none | stars from `parseBrightStarCatalog` or `fetchBrightStarCatalog`; it switches the sky's own procedural stars off |
| `planets` | true | draw Mercury to Neptune as points |
| `brightness` | 4 | a magnitude 0 star's light, in the scene's linear units |
| `limitingMagnitude` | 6.5 | the faintest drawn, after the air's extinction |
| `extinction` | 0.2 | magnitudes lost per air mass |
| `pointSize` | 1 | each point's spread in pixels; it does not change the brightness |
| `refraction` | true | lift each body by the refraction of standard air (Saemundsson down to the apparent horizon; below it the lift fades to none at -6 degrees) |
| `deltaT` | `deltaT(date)` | terrestrial minus universal time, seconds (Espenak and Meeus, years -500 to 2150) |

The maths is there on its own, for any engine or none: `sunPosition`, `moonPosition` and `planetPositions` take a
`Date` and an observer and give the apparent right ascension and declination, the distance, and the `azimuth`,
`elevation` and world `direction` as `@margoengine/sky/sun` uses them (pass `azimuth` and `elevation` to `setSun`);
the moon adds `illumination`, `phaseAngle`, `waxing` and `angularRadius`, a planet its `magnitude`. `skyMatrix` turns
J2000 vectors into world directions for the moment and place, `julianDay`, `deltaT`, `greenwichSiderealTime`,
`nutation`, `precessionMatrix` and `refract` are the steps underneath, and `starColor` gives a star's colour from its
B-V index.

The sun follows Meeus' low-accuracy method (about 0.01 degree), the moon his full series of chapter 47 (about 10
arcseconds) with its parallax from the observer, the planets Standish's Keplerian elements from JPL (valid 1800 to 2050,
tens of arcseconds), and stars their J2000 places moved by their proper motion, then precession and nutation to the
date. Aberration (up to 20.5 arcseconds) is not applied, and the planets are points, not discs. Planet magnitudes are
Meeus' chapter 41; Mars' follows Mallama and Hilton 2018, Eq. 6, with the face it turns to us and its season (within
0.003 of JPL Horizons from 1985 to 2045); Saturn's includes its rings by the tilt of the ring plane to the Sun and the
Earth (their Eq. 10: -0.55 at the widest rings of 2032 December 25, +1.17 nearly edge-on on 2025 April 20). Each star is a Gaussian 1 px (`pointSize`) wide that keeps its light at any size: on a float target the
sky behind it loses 1/64 of the star's alpha, so its light is added within 0.1%; on an 8-bit canvas it replaces the sky by its alpha, and no pixel goes past 1.

### Ephemeris: the planets round the Sun, for orreries and tours

`@margoengine/sky/ephemeris` is the heliocentric half of the astronomy, pure maths with no GPU code: where each
planet is round the Sun on a date, its mean longitude (where an orrery's uniformly turning wheel shows it), its mean
motion, the Moon's longitude round the Earth, and the Earth's longitude on every day of a year for a calendar ring. It
runs in Node as well as a browser.

```ts
import {julianDay, planetPosition, moonLongitude, meanMotion, yearCalendar} from 'margoengine/sky/ephemeris';
const jd = julianDay(new Date('2026-11-14T00:00:00Z'));
const mars = planetPosition('mars', jd); // {x, y, z} in au, J2000 ecliptic; longitude, meanLongitude, radius
console.log(mars.longitude.toFixed(2), mars.radius.toFixed(3), moonLongitude(jd).toFixed(1));
console.log(360 / meanMotion('jupiter'), yearCalendar(2026).days.length); // about 4332.6 days, 365 ticks
```

| Export | Gives |
| --- | --- |
| `planetPosition(name, jd)` | heliocentric `x`, `y`, `z` (au; x toward the J2000 equinox, z to the ecliptic pole), `longitude`, `meanLongitude` (degrees), `radius` (au) |
| `solarSystem(jd)` | every planet's `planetPosition`, keyed by name |
| `moonLongitude(jd)` | the Moon's geocentric ecliptic longitude, degrees, J2000 equinox |
| `meanMotion(name)` | degrees per day |
| `yearCalendar(year)` | `days`: Earth's longitude at 0h UTC, `day` and `month` (0 to 11) for each day of the year |
| `eccentricAnomaly(M, e)` | Kepler's equation solved by Newton's method to 1e-12 rad, any `e` in [0, 1) |
| `julianDay`, `dateOfJulianDay`, `centuries`, `J2000` | time: a `Date` or epoch milliseconds to a Julian Day and back; Julian centuries from J2000 |
| `wrap360`, `wrap180` | angles in degrees to [0, 360) and [-180, 180) |
| `STANDISH_ELEMENTS`, `FITTED_SPAN`, `HELIOCENTRIC_PLANETS` | the frozen element table, the Julian Days it was fitted over, the names in order |

The planets use Standish's Keplerian elements from JPL (Table 1, fitted to DE405 over 1800 to 2050), the Moon the
Astronomical Almanac's six-term low-precision series moved to the J2000 equinox by the IAU 2006 general precession.
Measured against JPL Horizons (DE441) at 51 dates from 1800 to 2050 (the test's fixture), the worst longitude errors are
0.33 to 1.7 arcminutes for every planet but Jupiter (7.6) and Saturn (11.9), distances are within 0.19 percent, and
the Moon is within 16.9 arcminutes. `earth` is the Earth-Moon barycentre, as in the table. Positions are geometric:
for a body's apparent place in a site's sky, use `planetPositions` from `/astro` above. An unknown planet name, an
eccentricity outside [0, 1) or a non-integer year throws a `RangeError` that names the fix.

## Weather: rain, snow and lightning

`Weather` from `@margoengine/sky/weather` is its own plugin, not a feature of `Sky`, so a clear-sky scene pays nothing
for it. Rain streaks or snow flakes fall in a box that follows the camera (25 m half-width and 20 m high by default).
Each particle is placed by an integer hash and moved by the wind with no per-frame upload, drawn depth-tested over the
scene (nearer geometry hides it) after the sky and fog. Defaults: 24,000 rain streaks or 500,000 flakes at intensity 1.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {Weather} from 'margoengine/sky/weather';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {hours: 17, clouds: {coverage: 0.8}});
const weather = Weather.attach(engine, {
  precipitation: 'rain', intensity: 0.8, wind: [4, 0],
  lightning: {rate: 8, seed: 42},
});
// A storm that builds over four seconds; rain dims with the dusk and the clouds thicken with it.
engine.onFrame(() => {
  weather.options.brightness = 1 - 0.8 * sky.nightFactor;
  sky.options.clouds!.coverage = 0.45 + 0.5 * weather.amount;
});
const stopLightning = weather.onLightning((strike) => console.log('flash', strike.distance, 'm'));
const stopThunder = weather.onThunder((strike) => console.log('rumble', strike.loudness, strike.rumble, 's'));
weather.strike({distance: 800});       // a strike you place yourself
stopLightning(); stopThunder();
```

Options are read every frame from `weather.options`; change them live. `intensity` (0 to 1) is the target and
`weather.amount` the eased value, reaching it over `fadeSeconds` (default 4). Fields and defaults:

| Option | Default | Meaning |
| --- | --- | --- |
| `precipitation` | `'rain'` | `'rain'`, `'snow'`, `'sleet'` (both at once) or `'none'` |
| `snowShare` | 0.5 | with `'sleet'`, the share that falls as snow, 0 to 1 |
| `intensity` | 0.5 | target amount, 0 to 1 |
| `fadeSeconds` | 4 | seconds across the whole range; 0 jumps |
| `wind` | `[0, 0]` | metres per second, world X and Z: rain slants, snow drifts |
| `radius`, `height` | 25, 20 | half-width and height in metres of the box that follows the camera |
| `particles` | 24,000 rain, 500,000 snow | count at intensity 1, up to 2,000,000; the amount scales it. Flakes are drawn at their real size, most under a pixel, so snow takes many |
| `rainRate` | unset | mm of water per hour, 0 to 300: the rain's drops fall at the speed of their own size (below); unset keeps a fixed 9 m/s. `WeatherDrive` of `@margoengine/weather` sets it from the state |
| `snowfallRate` | 1 | mm of melted water per hour, 0.01 to 30: sets the flakes' size distribution (below); harder snow has larger flakes |
| `flakeSizes` | `[2, 10]` | the flake sizes drawn, largest dimension in mm, 0.5 to 30, smallest first |
| `color`, `brightness`, `opacity` | pale grey-blue (rain) or white (snow), 1, 0.35 (rain) or 0.8 (snow) | linear RGB, its scale, one particle's alpha |
| `exposure` | 0 | seconds the shutter stays open, 0 to 1: each snow flake is drawn as the capsule it sweeps over that time, shaded as the time average of the moving flake (its light kept, the ends tapered), so a gale streaks it and summed sub-frames join into one even streak (1/120 is a 180 degree shutter at 60 fps; when sub-frames are summed, give each its share). Rain keeps its fixed streak |
| `reactive` | on while TAA runs | draw the particles' coverage into `weather.reactiveMask` (r8unorm), which TAA reads by itself; `true` every frame, `false` never |
| `lens` | `{focalDistance: 10, aperture: 2.8, filmGauge: 36}` | the lens the snow is seen through, named as `@margoengine/dof` names it: a flake off the focal plane draws as its blur disc, its light spread over it; `false` keeps every flake sharp. Rain keeps its streaks sharp |
| `nearFade` | `[0.4, 2]` | metres from the camera over which particles fade in; the first is never nearer than the camera's near plane |
| `lightning` | none | storms, below |

Particle colour is a fixed linear RGB, so scale `brightness` with the light of the scene (above, `1 - sky.nightFactor`).
A streak smaller than a pixel dims instead of sparkling, and a flake smaller than a pixel is drawn a pixel wide with its
alpha scaled by its true area over the pixel's, so it keeps its light without being drawn larger than it is. Under TAA that keeps the sky's history (volumetric
clouds) nothing needs wiring: while TAA runs, each frame the streaks and flakes are drawn, depth tested, into the mask
and published for the frame, so TAA takes little history where they are and they stay crisp instead of averaging into
the sky (the `weather` case of `features-check.mjs` measures it under a plain `TAA.attach(engine)`). Without TAA no mask
is drawn. Rain falls at 9 m/s;
each snow flake falls at the measured speed of its own size, with a gentle sway.

Snow seen through a lens (`lens`): a flake `d` metres out, with the lens focused `S` metres out, blurs to the thin
lens's circle of confusion, `A f |d - S| / (d (S - f))` on the sensor (Potmesil and Chakravarty 1981, "A lens and
aperture camera model for synthetic image generation", SIGGRAPH), with `f` the focal length the camera's field of view
gives on a `filmGauge` mm sensor and `A = f / aperture`. The flake draws as the disc of its own size and that circle
added in quadrature, with its peak opacity times its sharp area over the disc's, so its light is kept. A flake passing
a metre in front of a camera focused on the scene is then a faint soft disc, as a real lens shows it, not a sharp
speck on the lens.

Flake sizes are measured ones. Melted diameters follow Gunn and Marshall's exponential, `N(D) = N0 exp(-lambda D)` with
`lambda = 25.5 R^-0.48` per cm at `R` mm of melted water per hour (Gunn and Marshall 1958, "The distribution with size
of aggregate snowflakes", J. Meteorol. 15(5), 452 to 461; Sekhon and Srivastava 1970, "Snow size spectra and radar
reflectivity", J. Atmos. Sci. 27(2), refit it), cut to `flakeSizes`, and a melted diameter `m` is the flake whose mass,
`pi m^3 / 6` mg of water, is Locatelli and Hobbs's `0.073 D^1.4` mg for aggregates of dendrites (Locatelli and Hobbs
1974, "Fall speeds and masses of solid precipitation particles", J. Geophys. Res. 79(15), 2185 to 2197; measured over
2 to 10 mm, the default range). At 1 mm/h the mean flake is 4.2 mm across with a spread of 2.0 mm; before
KB-SNOW-NEARCAM2 every flake was drawn 24 mm across so distant snow stayed visible. Each flake keeps only its own
light: under a pixel its alpha is its true area over the pixel's (the point-sample coverage of Reeves 1983, "Particle
systems", ACM TOG 2(2); the area-ratio fade of Persson's "Phone-wire AA", GPU Pro 5, 2014), so the falling snow's
density comes from the count: 500,000 by default, about 31 times the 16,000 the 24 mm flakes took, the ratio of their
light. With `exposure` set, a flake moving during the shutter time draws as a streak of its speed times the exposure,
projected, with its light spread along it, as a camera's time average records it (Reeves 1983; Potmesil and Chakravarty
1983, "Modeling motion blur in computer-generated images", SIGGRAPH; Garg and Nayar 2007, "Vision and rain", IJCV
75(1), whose streak intensity is the drop's light times the time it stays on a pixel over the exposure). A night
exterior shot at 24 fps with a 180 degree shutter opens for 1/48 s (the `snowNight` kit's `exposure`). The snow's
haze beyond single flakes (the crystals under 2 mm and the snow past the box) is the fog's, at the snowfall's
visibility. `snowflakeDiameter(u, rate, sizes)` and `snowflakeSizeLaw(rate, sizes)` are the same sums in
JavaScript.

Each flake falls at the terminal speed Locatelli and Hobbs (1974, Table 1) measured for these aggregates of
dendrites at its own size, `V = 0.8 D^0.16` m/s with `D` in mm (`snowflakeFallSpeed(diameter)`, diameter in
metres; drawn in steps of 1/512 m/s): 0.89 m/s at 2 mm, 1.00 m/s for the mean 4.2 mm flake and 1.16 m/s at 10 mm, so
the large flakes overtake the small ones and each streaks by its own speed times the `exposure`. Before
KB-SNOW-FALLSPEED1 every flake fell at 1.2 m/s. Later video disdrometer measurements find aggregates falling faster
in warmer snow (Brandes, Ikeda, Thompson and Schoenhuber 2008, "Aggregate terminal velocity/temperature relations",
J. Appl. Meteorol. Climatol. 47(10)) and turbulence spreading the speeds (Garrett and Yuter 2014, Geophys. Res. Lett.
41(18)); rimed aggregates and graupel fall faster and follow other mass laws, which these flakes do not take.

```ts
import {snowflakeDiameter, snowflakeFallSpeed} from 'margoengine/sky/weather';
const median = snowflakeDiameter(0.5); // metres across, at 1 mm/h over 2 to 10 mm
console.log(median, snowflakeFallSpeed(median)); // about 0.0036 m, about 0.98 m/s
```

`weatherLens(lens, width, height, fov)` and `snowflakeBokeh(pixels, depth, lens)` are the same
sums in JavaScript. Focus it on what the shot looks at:

```ts
import {Engine} from 'margoengine/core';
import {Weather} from 'margoengine/sky/weather';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const weather = Weather.attach(engine, {precipitation: 'snow', intensity: 0.6, lens: {focalDistance: 15, aperture: 1.4}, exposure: 1 / 48});
weather.options.lens = false; // every flake sharp
weather.options.snowfallRate = 3; // heavier snow, larger flakes
```

Rain takes its fall from its rate. The drops that carry the water have the median volume diameter of Marshall and
Palmer's (1948) size law, `D0 = 0.895 R^0.21` mm (`rainDropDiameter(rate)`: 1.6 mm at 17 mm/h, 2.2 mm at 80), and fall at
the terminal speed Gunn and Kinzer (1949) measured, fitted by Atlas, Srivastava and Sekhon (1973) as
`V = 9.65 - 10.3 e^(-0.6 D)` m/s (`rainFallSpeed(diameter)`: 6.5 m/s at 2 mm, 9.1 at 5 mm). A drizzle falls at 1 to 2 m/s
and a downpour at 7, so the streaks slant by `atan(wind / fall)` (`rainSlant(wind, fall)`, within 2 degrees of the drawn
streak) and lengthen with the speed. `rainDropCount(rate)` is the drops per cubic metre, `8000 R^0.21 / 4.1`.

```ts
import {Weather, rainDropDiameter, rainFall, rainSlant} from 'margoengine/sky/weather';
console.log(rainDropDiameter(17), rainFall(17)); // about 1.6 mm drops falling about 6 m/s
console.log(rainSlant([8, 0], rainFall(17))); // 8 m/s of wind leans the rain about 54 degrees
const weather = new Weather({precipitation: 'rain', rainRate: 17, wind: [8, 0]});
weather.options.rainRate = 0.5; // a drizzle: smaller drops, falling slower, leaning further
```

`precipitation: 'sleet'` draws rain and snow together, `snowShare` (default 0.5) of it as snow and the rest as rain:
each kind gets that share of its particles at the eased amount, its own colour, opacity and fall, and its own hash
seed, so the two never stand on the same spots. Surfaces wet and snow settles by the same shares (`wetness` toward the
rain's, `snowCover` toward the snow's), and `weather.rainShare` says how much of it is rain.

```ts
import {Engine} from 'margoengine/core';
import {Weather} from 'margoengine/sky/weather';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const weather = Weather.attach(engine, {precipitation: 'sleet', snowShare: 0.3, intensity: 0.7});
weather.options.snowShare = 0.8; // colder: mostly snow now
```

Lightning (`lightning: {}` for the defaults) strikes as a Poisson process: `rate` strikes a minute (default 6) at
intensity 1, rising from nothing at `threshold` (default 0.6), at a random distance between `minDistance` (300 m) and
`maxDistance` (6,000 m) and direction around the listener. The same `seed` and frame times give the same storm. A strike
has one to four return strokes (each rises in 8 ms and decays with a 70 ms time constant) and adds `strength` (default
0.35) of `color` over the frame, brighter toward the top. `onLightning` fires as the flash starts, `onThunder` after
`distance / 343` seconds with a `loudness` (falls with distance) and `rumble` length for your audio; a throwing listener
does not stop the others. `weather.flash` (0 to 1) is the same flash as a number.
`thunderDelay(distance, speed)` and `lightningFlash(seconds, offsets, amplitudes)` are the underlying functions.

The flash lights the scene through `weather.lightningLight`, a point light (the shape of `@margoengine/clustered`'s
`PointLight`) changed in place each frame: at the brightest live strike (the last one between flashes), 700 m above
it, of a measured first return stroke's luminous intensity times the strokes' rise and fall, with inverse-square
falloff (so distance dims it, not `strength`, which scales only the overlay). Give it to a light list once:

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {Weather, LIGHTNING_PEAK_CANDELA} from 'margoengine/sky/weather';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const lights = Clustered.attach(engine);
const weather = Weather.attach(engine, {intensity: 0.9, lightning: {rate: 10, light: {peak: LIGHTNING_PEAK_CANDELA / 4}}});
lights.setLights([weather.lightningLight]);
weather.options.lightning!.hold = 0.6; // a still: the flash held at 0.6
```

| `lightning` | Default | Meaning |
| --- | --- | --- |
| `hold` | none | holds the flash at 0 to 1 (overlay, `flash` and the light) for stills |
| `light.peak` | `LIGHTNING_PEAK_CANDELA`, 1.43e7 cd | peak luminous intensity, candela, 0 or more |
| `light.height` | `LIGHTNING_LIGHT_HEIGHT`, 700 m | the light's height above the strike point, 0 to 20,000 m |
| `light.color` | `LIGHTNING_COLOR` | linear RGB, normalized to a largest channel of 1 |
| `light.range` | 1.5 x `maxDistance` | metres where the light ends |
| `light.scale` | 1 | multiplies `light.peak`; the deck's flash follows it (0 to 1,000) |
| `light.shadow` | a map where the lights have a free one | `true`, `false` or `{near, far}` (default near 1 m, far 3,000 m); see below |
| `link` | `true` | wires the flash into the scene by itself; `false` or `{clouds, fog, lights, group}` |

- Peak: a first stroke's light, 2.3e9 W in 0.4 to 1.1 um at peak (mean of strokes 5 to 35 km away; Y. Guo and E. P.
  Krider, "The optical and radiation field signatures produced by lightning return strokes", J. Geophys. Res. 87,
  8913-8922, 1982) for a characteristic width of 36 us (energy over peak power, the means of Quick and Krider,
  "Optical power and energy radiated by return strokes in rocket-triggered lightning", J. Geophys. Res. Atmos. 122,
  8816-8832, 2017: 150 J/m over 4.2 MW/m), 82 kJ, at 161.7 lm per watt: a 30,000 K Planck spectrum over the band
  (the channel's peak temperature, 28,000 to 31,000 K: R. E. Orville, J. Atmos. Sci. 25, 839-851, 1968) weighted by
  Wyman, Sloan and Shirley's photopic fit (JCGT 2(2), 2013). A frame records that light over its exposure, so the
  light keeps the stroke's luminous energy over the flash envelope (0.074 s at peak) and 4 pi sr. Lightning's light
  is lines, much of it in the near infrared, so the efficacy is an upper estimate.
- Height: a return stroke's light decays up the channel as exp(-z / 0.6 to 0.8 km) (C. D. Jordan and M. A. Uman,
  J. Geophys. Res. 88, 6555-6562, 1983); its centre on a long channel sits at that length.
- Colour: the chromaticity (0.2502, 0.2488) of the same 30,000 K spectrum, a blue-white.
- The rise and fall is the scene flash's (8 ms rise, 70 ms decay per stroke), not the microsecond waveform of the
  stroke itself; the peak is set so the energy matches. A held flash (`hold: 1`) keeps that peak.

**With no wiring.** A weather with `lightning` finds the scene's plugins by name each frame and lights them itself
(`lightning.link`, on by default), so one call lights a storm's cloud deck, the air under it, the ground and everything
on it. Each part takes only what the scene left unset: a deck given its own `flash`, a fog given its own `lightning`
are left alone, and `link: {clouds: false, fog: false, lights: false}` (or `link: false`) leaves all of it to you.

- Deck: every `VolumetricClouds` without a `flash` takes `weather.cloudFlash` and is lit from inside (Dobashi,
  Yamamoto and Nishita 2001: the light a channel gives off inside a cloud scatters through it). The flash sits in
  the deck found: its base is the deck's `bottom`, or the base its `weather` cloud type gives (storm 600 m, stratus
  300 m), and never above its tops. `lightning.cloud.base` still wins.
- Fog: every `VolumetricFog` (`@margoengine/environment`) without a `lightning` takes `{light: weather.lightningLight}`,
  so the lit deck lights the storm air under it.
- Ground and scene: a `LightGroups` (`@margoengine/clustered/groups`) in the scene gets a group (`link.group`, default
  `'lightning'`) holding `weather.lightningLight` while a flash lasts: a point light over the strike, as bright as
  the measured stroke, that follows each strike's place and fades with the strokes, so the ground, the water, the roofs
  and the people flash by themselves. The group is empty between flashes (the list changes only when a flash starts,
  moves or ends). The whole-frame overlay (`strength`) is the flash on whatever the lights do not reach.
- Shadows: when the scene's `Clustered` has shadow maps (`ClusteredOptions.shadows`) and a slot is free
  (`clustered.shadowSlots`, its `maxLights`, default 4, less the shadowed lights already listed), the light casts a
  shadow map out to `far` (3,000 m, or the light's `range` if less), so objects throw their flash shadows. `shadow:
  false` turns it off; `shadow: true` or `{near, far}` asks for it whenever the lights have a map.

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LightGroups} from 'margoengine/clustered/groups';
import {Sky} from 'margoengine/sky';
import {VolumetricClouds} from 'margoengine/sky/volumetric-clouds';
import {Weather} from 'margoengine/sky/weather';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {hours: 22, timeScale: 0});
LightGroups.attach(engine, Clustered.attach(engine, {shadows: {}}));
VolumetricClouds.attach(engine, {sky, weather: {cloud: 1, rain: 1, lightning: 1}});
const weather = Weather.attach(engine, {intensity: 0.9, lightning: {rate: 10}});
weather.strike({distance: 800}); // the deck, the air and the ground flash, with the light's shadows, wired by nothing
```

Inside the cloud deck the same flash lights the cloud from within through `weather.cloudFlash`, shaped as
`VolumetricClouds`' `flash` option and changed in place each frame, so it is given once. It is the part of the
channel's light given off above the cloud base: its light per metre falls off up the channel as exp(-z / 700 m)
(Jordan and Uman 1983, as above), so the part above a base `b` carries e^(-b / 700) of the stroke's light
(`lightningCloudShare(b)`: 0.117 for 1,500 m, 0.395 for 650 m), centred 700 m above the base. Its intensity is in
candela like `lightningLight`, so the deck matches the scene's lights when the sky is lit in lux.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {VolumetricClouds} from 'margoengine/sky/volumetric-clouds';
import {Weather} from 'margoengine/sky/weather';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {hours: 22, timeScale: 0});
const weather = Weather.attach(engine, {intensity: 0.9, lightning: {cloud: {base: 800}}});
VolumetricClouds.attach(engine, {sky, coverage: 0.85, bottom: 800, flash: weather.cloudFlash});
```

| `lightning.cloud` | Default | Meaning |
| --- | --- | --- |
| `base` | the linked deck's base, else `LIGHTNING_CLOUD_BASE`, 1,500 m | cloud base above the strike point, 0 to 20,000 m |
| `peak` | `light.peak` x `lightningCloudShare(base)` | peak luminous intensity inside the cloud, candela, 0 or more |
| `radius` | 200 m | the flash's core, 1 to 100,000 m (`flash.radius`) |
| `scale` | 1 | multiplies the deck's flash after `light.scale`, 0 to 1,000 |

### The bolt itself: `LightningBolt`

`@margoengine/sky/lightning-bolt` draws each strike's channel and makes the stroke's light follow it. Attach it beside
the weather:

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LightGroups} from 'margoengine/clustered/groups';
import {Weather} from 'margoengine/sky/weather';
import {LightningBolt, lightningChannel} from 'margoengine/sky/lightning-bolt';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
LightGroups.attach(engine, Clustered.attach(engine));
const weather = Weather.attach(engine, {intensity: 0.9, lightning: {bolt: {glow: 120}}});
LightningBolt.attach(engine, {weather});
weather.strike({distance: 1500, azimuth: 0}); // a branching bolt, lit like the scene below it
// The channel on its own: the same seed gives the same bolt.
const channel = lightningChannel({seed: 7, start: [0, 1500, 800], end: [0, 0, 800]});
console.log(channel.count, 'segments,', channel.trunk, 'on the main channel');
```

For a simulated strike, save `LightningSolver.channel()` from `@margoengine/physics/lightning` when the leader
grounds. Pass `channel: strike => channels.get(strike.id)` to `LightningBolt.attach`, with the immutable channel
stored under the corresponding Weather strike ID. The same channel drives the visible bolt and its lighting.
If the callback returns `undefined`, Weather uses the usual procedural channel for that strike.

- Shape: the channel grows a step at a time from the cloud base to the strike, each step picked among random
  candidates in a cone around the field (toward the ground, with a slow sideways drift) by its alignment with the
  field to the power `eta`, less the shielding of channel already grown beside it: the stochastic growth law of the
  dielectric breakdown model (Niemeyer, Pietronero and Wiesmann 1984, as applied to lightning by Kim and Lin 2004),
  without its grid. Forks leave the channel downward and shorten at each generation, as in the particle-traced
  channel of Reed and Wyvill (1994). It is deterministic: the weather's `lightning.seed` and the strike's number give
  the channel, so the same film time draws the same bolt.
- Look: hot core and glow of the channel's field (Reed and Wyvill's implicit-surface glow), drawn as screen-facing
  ribbons from one storage buffer, with maximum blending so overlaps and forks never double up, and a read-only depth
  test, so a hill in front hides it. Each return stroke of the strike lights the whole channel: a multi-stroke flash
  flickers, and the hot core falls away faster (`bolt.fade`, 30 ms) than the glow (the flash's 70 ms).
- Light: with a `LightningBolt` attached, the stroke's light is `light.segments` (default 3) lights along the main
  channel in place of one point light 700 m up: the same total candela, shared by height as the channel's light falls
  with it (Jordan and Uman 1983), each the sphere of its piece of the line. `lightning.light.line: false` keeps the
  point light. The brightest light takes the shadow map.

| `lightning.bolt` | Default | Meaning |
| --- | --- | --- |
| `scale` | 1 | brightness of the drawn bolt, 0 to 1,000 (0 draws none) |
| `width` | 1.5 m | hot core, 0.01 to 100 m, never under a pixel |
| `glow` | 80 m | glow width, 0 to 2,000 m (0: core only); stops at 5 percent of the frame height near the camera |
| `fade` | 0.03 s | the core's decay time after a stroke |
| `branching` | 0.06 | chance each channel point forks, 0 to 0.5 |
| `spread` | 50 degrees | cone of each growth step: how crooked, 5 to 85 |
| `detail` | 80 | growth steps down the main channel, 8 to 400 |
| `top` | the cloud base | channel top above the strike, metres |

These are the `lightning.bolt.*`, `lightning.light.line` and `lightning.light.segments` rows of `applySkySettings`.
The channel is the same for a strike while the shape rows (`branching`, `spread`, `detail`, `top`) hold; moving one
grows it again from the same seed.

The state reads as plain numbers: `amount`, `flash`, `wetness` (rises under rain in about 20 s, dries in 90 s; drive
roughness with it) and `snowCover` (builds in 2 minutes, melts in 5; drive a snow layer). `weather.listener` is the
position strikes are placed around; it follows the engine's camera at each update, and without a GPU engine you may set it yourself
and call `onPreUpdate(delta)` for audio or game logic. `Weather` needs WebGPU (`MargoError` `'unsupported'` on WebGL2). Sky lighting runs on the WebGL2 compatibility layer with
no change to your code: the package loads a small route there that computes the same light on the GPU.
On its own the weather respects the scene depth, not covered areas: rain falls under roofs, makes no splashes and
leaves the lens dry. `WeatherFX` (below) adds all three.

### Rain splashes, wet lens and cover

`WeatherFX` from `@margoengine/sky/weather-fx` makes the rain meet the scene: no rain or snow falls under roofs,
bridges and trees, splashes rise where the rain lands, and drops gather on the lens of a camera standing in the open.
Give it the meshes or models that keep rain off (the ground too, so splashes land on it).

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {Weather} from 'margoengine/sky/weather';
import {WeatherFX} from 'margoengine/sky/weather-fx';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const ground = engine.createMesh().setGeometry(box(200, 0.2, 200)).setMaterial(new PbrMaterial({color: '#555555'}));
const roof = engine.createMesh().setGeometry(box(8, 0.3, 8)).setMaterial(new PbrMaterial({color: '#884444'})).setPosition([0, 3, -6]);
const weather = Weather.attach(engine, {intensity: 0.9});
const fx = WeatherFX.attach(engine, {weather, occluders: [roof, ground]});
fx.options.lensDrops = 60; // a wetter lens
```

Each frame the occluders are drawn from above into a depth map over the weather's box (`resolution` texels a side,
256), as a shadow map is drawn from the sun: each texel holds the height of the topmost surface there. The weather
drops every particle below that height, so nothing falls under cover, and each splash slot lands once every third of a
second at a random place in the box, on that surface (on `ground`, default 0, where the map holds none): a crown ring
and four droplets, depth-tested against the scene. The lens wets toward the rain's amount in about 4 s while the
camera stands in the open (by the same map) and dries in about 25 s under cover or when the rain stops; its drops are
clear discs with a dark rim and a highlight, a few running down.

| Option | Default | Meaning |
| --- | --- | --- |
| `weather` | required | the `Weather` to follow |
| `occluders` | none | core meshes, or models and terrain with `shadowPrimitives`, that keep rain off |
| `ground` | 0 | height where splashes land when no occluder is below |
| `resolution` | 256 | cover map texels per side, 32 to 2048 |
| `splashes` | 3,000 | splash slots at full rain, 0 to 100,000 |
| `splashSize` | 0.15 | splash height in metres |
| `lensDrops` | 40 | drops on a lens in full rain, 0 to 500 |
| `dropSize` | 0.03 | drop radius, a share of the view's height |

Occluders are drawn without skinning, morphing, instancing or displacement (their rest shapes), and alpha-masked
leaves cover whole; snow is kept off under cover but makes no splashes and no lens drops. Lens drops shade the frame
rather than refract it. Needs WebGPU.

This is a compact atmospheric approximation, not a reference-quality reproduction of the original planetary renderer: no ozone spectrum or ground-albedo irradiance feedback (physical aerial perspective is the `/aerial` entry, light shafts the `/shafts` entry and a sky with ozone the `/hillaire` entry). Single scattering is stored without its phase functions and the phases are applied per pixel (Bruneton and Neyret 2008, sec. 4), so the glow round the sun fades smoothly on the coarse table; coarse angular sampling can still band the higher orders slightly; the visible horizon uses a skyward sample to avoid a dark ground strip. Preetham is a daytime model with a night fade.

Models: [Preetham daylight notes](https://renderwonk.com/publications/s2003-course/preetham/notes-preetham.pdf), [Bruneton scattering equations](https://ebruneton.github.io/precomputed_atmospheric_scattering/atmosphere/functions.glsl.html).

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/sky

GPU fog coverage and shader parity: node scripts/modern-sky-fog-tests.js



## Film time: seeking a sky to a cut

A film rendered scene by scene starts each scene in a fresh process, and every sky clock adds up frame deltas: the
cloud sheet's drift, the star time and `hours` (`Sky`, `HillaireSky`), the wind and evolution drift and the march start
counter of `VolumetricClouds` (cloud shadows and shafts read that drift too), the date of `AstroSky`, and the fade,
wetness, snow cover, wind drift and lightning schedule of `Weather`. Each has `advanceTime(delta)`, the CPU part of its
frame update, and a `time` getter (seconds on its clock); its `onPreUpdate` runs the same `advanceTime`. So
`seek` from `@margoengine/cutscene/seek` replays a run's steps and the next frame draws what a run started at 0 draws
there, bit for bit (`test/seek.test.js` field for field to 54,000 steps; `test/seek-check.mjs` pixel for pixel on WebGPU
and the WebGL2 compatibility layer).

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {VolumetricClouds} from 'margoengine/sky/volumetric-clouds';
import {Weather} from 'margoengine/sky/weather';
import {seek} from 'margoengine/cutscene/seek';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {hours: 18, timeScale: 120 / 3600, clouds: {coverage: 0.6}});
VolumetricClouds.attach(engine, {sky, wind: [6, 2]});
const weather = Weather.attach(engine, {precipitation: 'rain', intensity: 0.9, lightning: {seed: 7}});
// This scene starts 95 s into the film: the dusk, the clouds, the wetness and the storm are where a run from 0 had them.
await seek(engine, 95, {fps: 30});
engine.render({delta: 1 / 30});
console.log(sky.time, weather.time, weather.wetness);
```

- A replayed lightning strike calls no `onLightning` or `onThunder` listener (`advanceTime` is silent); the live frame
  after the seek hears what the continuous run heard on that frame. Strikes fall around `weather.listener`, which follows
  the engine's camera at each update (until 2026-11-16 the draw pass set it, so a strike's place hung on the last draw).
- `VolumetricClouds` moves its march start once per update (until 2026-11-16 once per draw, so two views in one frame
  moved it twice and a seek could not move it); the first frame still marches from 0.
- `AstroSky` defaults its date to the wall clock's now: give a film a `date`. Frames drawn with delta 0 move no clock.
- `WeatherFX`'s wet lens is history of the view, as TAA is: a cut starts it dry and the scene's warm-up frames wet it.
- Several cuts in one process: `resetTime()` on `Sky`, `HillaireSky`, `AstroSky`, `Aurora`, `TornadoCloud`,
  `VolumetricClouds` and `Weather` puts each clock back as a fresh one with the same options has it (`resetClocks` from
  `@margoengine/cutscene/seek` calls it on every clock), so a later `seek` gives what a fresh world seeked there gives.
  `Sky` and `HillaireSky` put `options.hours` back to the value they were built with, `AstroSky` its date to the
  moment it was built with, and `Weather` replays the same strikes from its seed, its lights dark; listeners stay.
  Evidence: `test/reset-time.test.js` (state of a reset clock equals a fresh one's, before and after a seek).

## External radiance reference

After building, run `node scripts/run-with-timeout.mjs --max=3 -- node packages/sky/scripts/rival-bench.mjs`.
Install Mitsuba 3.9.1 in the external engine-bench/batch-168/mitsuba-venv; setup and overrides are in
[reproduce](../../docs/whitepaper/reproduce.md). This evaluates the shipped Preetham WGSL against sunsky
over 297 directions. Each sky is normalized by its own zenith luminance because their absolute units differ.
Normalized RGB MAE is 1.439228; this remains an open model loss, not a physical radiance parity claim.
[Per-case results](../../docs/whitepaper/results/batch-168-sky.json).

## Bake an HDR environment

`bakeHillaireEnvironment` from the existing `/hillaire` entry reuses its transmittance and multiple-scattering
tables to make an owned linear RGBA Float32 equirectangular map. Columns turn about +Y from -Z at the centre
to +X at three quarters; rows run from zenith to nadir. The sun is returned separately, with its atmospheric
transmittance, to avoid putting a sharp disc into a coarse map.

```ts
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { bakeHillaireEnvironment } from '@margoengine/sky/hillaire';
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const environment = await bakeHillaireEnvironment(engineRuntime(engine).gpu!, {
  hours: 18.2, signal: AbortSignal.timeout(60000),
});
console.log(environment.width, environment.height, environment.data.length);
engine.dispose();
```

Defaults: width 256 (integer 1..2048), height 128 (integer 1..1024), hours 12 (finite, wraps at 24), altitude 0 metres
(0..100000000), sunIlluminance 20 (0..1000000), atmosphere Earth, multipleScattering true, night {}, optional signal.
An explicit nonzero sunDirection overrides hours. Atmosphere fields use the defaults above; bake coefficients and
ground albedo are 0..1, radii and scale heights at most 100000 km. `multipleScattering: false` isolates single
scattering. `night` accepts `SkyNightOptions` or false: the existing gradient, procedural stars and phased moon are
held at time zero with twinkle disabled. Unresolved stars retain their integrated mean light. Night numeric
magnitudes other than moonDirection are at most 1000000. The bake marches 64 steps per texel and frees temporary
resources on success, cancellation and failure. Recreate it when its settings change; the CPU result survives
device loss. WebGPU and WebGL2 compatibility GPUDevice work; plain WebGL2 refuses with coded `unsupported` and
a help link. Higher scattering orders are isotropic and the planet spherical; night is stylized, without an
astronomical catalogue, and the distant map adds no local aerial perspective.

The environment bake requires Float32-distinct planet/atmosphere radii and vertical scattering optical depth
at most 6 in every channel (Rayleigh plus scattering Mie, integrated from ground to top). This keeps a
representable escape probability in the geometric-series LUT. Minimum observer clearance is 1 metre or
2 to 4 Float32 radius steps, whichever is larger. Night moonSize must be at least 0.000001 radians; narrower
discs are outside the bake domain. Both equirectangular dimensions determine the night filtering footprint.

## Night sky preset

A moonlit night sky for Margo Engine: twinkling stars, a phased moon with glow, and horizon haze. `SkyMoon` is a
preset of `Sky` from `@margoengine/sky` (Margo's one sky implementation) held at midnight with its stylized
`night` options. `addSky(stage)` (`@margoengine/stage/sky`) loads it. For the light the moon casts (illuminance and colour), see `@margoengine/sky/moonlight`.

In this workspace, `npm run modern:dev` opens the starter; click **Toggle moonlit scenery**.

Once the packages are on npm (not yet; build from source until then):

```sh
npm install @margoengine/core @margoengine/sky
```

```ts
import {Engine} from 'margoengine/core';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const {SkyMoon} = await import('margoengine/sky/night-preset');
const sky = SkyMoon.attach(engine, {moonDirection: [0.45, 0, -1], moonPhase: 0.85});
engine.start();
sky.config.moonPhase = 0.2; // read every frame
```

`@margoengine/sky/night-preset` and the root export `SkyMoon` and the `SkyMoonConfig` type (an alias of Sky's
`SkyNightOptions`). `SkyMoon.attach(engine, config)` is `engine.use(new SkyMoon(config))`, and `new SkyMoon(config)` is `new Sky({hours: 0, timeScale: 0, night: config}, {night})` from
`@margoengine/sky/base` with plugin name `sky-moon`: it loads only the stylized-night feature (about 10.0 kB min+gzip
summed over this entry, Sky's base and Sky's night, against 18.1 kB for the full Sky;
[entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)), so it is not an `instanceof` the root `Sky`, and options that need
other features (fog, clouds, a day model) throw; build a `Sky` with those features instead. `config` (also
`sky.options.night`) is read every frame, so change it in place for live controls. Remove it with
`engine.removePlugin('sky-moon')` or `sky.dispose()`.

The options, defaults and limits are Sky's stylized night (see the `@margoengine/sky` README): zenith and horizon
colours, `hazeDensity`, moon direction, angular size, phase, colour and glow, star intensity and twinkle. The sky
draws behind opaque geometry at reversed-Z depth 0, on canvas and HDR targets, with 1x or 4x sampling. Its
colours are written as given on both.

The old low-level `SkyMoonPass` and the Night Citadel demo's `NightAtmosphere` were removed when the three sky
implementations were merged into `@margoengine/sky`. Use `Sky` directly for custom night skies, and Sky's `fog`
(`falloff: 'exp'`, `height`, `color`) for a height haze.

## Day presets

`@margoengine/sky/day-presets` holds four times of day, `noon`, `goldenHour`, `overcast` and `dawn`, as options for
`Sky` from `@margoengine/sky`, with the light that goes with each. The sun's colour and strength are not stored: the
sky works them out from its own air (`sunlight` in `@margoengine/sky`), so the light always matches the sky drawn.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {applyDayPreset, dayLight, dayPreset} from 'margoengine/sky/day-presets';

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
- A preset with the sun below the horizon (`elevation` under 0, as `sunPath` gives at night) also turns the night on:
  `night: {}` (stars and a phased moon at their defaults) and `lighting.moon: {}` (the sky's own moonlight, which takes
  over from the sun as it sets). The four presets keep the sun up, so they are unchanged.
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

`@margoengine/sky/scenes` attaches a whole look in one call: a day preset's sky, sun and sky light, fog, bloom
and a display grade.

```ts
import {Engine} from 'margoengine/core';
import {PresetScene} from 'margoengine/sky/scenes';

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

`sunScene(azimuth, elevation)` gives the scene preset for a sun where it is (degrees, as `sunPath` gives them):
`noon`'s look with the sun 20 degrees up or more, `goldenHour`'s below that, and a moonlit night with the sun below the
horizon. The night keeps the sun where it is, so the sky draws its stars and moon and the moon lights the scene, under
`noon`'s fog and a night grade: exposure +2, contrast 1.05, white balance 5600 K (cooler), vignette 0.2, bloom 0.08
over 1. The sky's moonlight puts moonlit ground about 4.5 stops under noon's at the same grade; the +2 leaves it about
2.5 stops under, as a day-for-night shot is held, darker and bluer than day but legible (Jensen et al., "Night
Rendering", 2000; Thompson, Shirley and Ferwerda, JGT 2002). Place the moon with the sky's `night` options
(`moonDirection`, `moonPhase`, `moonLitBySun`), for example from `moonPosition` of `@margoengine/sky/astro`.

```ts
import {Engine} from 'margoengine/core';
import {PresetScene, sunScene} from 'margoengine/sky/scenes';
import {degrees, sunPath} from 'margoengine/sky/sun';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const sun = sunPath({latitude: degrees(47.5), dayOfYear: 232, hour: 22});
const scene = PresetScene.attach(engine, sunScene(sun.azimuth.degrees, sun.elevation.degrees)); // a moonlit night
engine.start();
```

The fog is exponential from the camera, density 3.912 / visibility (the distance where an object fades to 2%
contrast); the exposure brings each scene's lit ground back near noon's on screen. The fog takes the clear sky's
colour in each direction, so under overcast a far object fades a little bluer than the cloud above it.

## Scene kits

`@margoengine/sky/scene-kits` holds the values of several packages chosen together for one kind of scene, so a scene
built from them looks right with no tuning and its parts agree: one moon, fog as thick as the snowfall, a grade for the
light the kit gives. A kit is plain, frozen data; the scene attaches each package with its part, and can change any
value after. `snowNight(options)` is a snowbound night with a lit interior (the Cabin Hearth scene,
`examples/cabin-hearth`).

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {Sky} from 'margoengine/sky/base';
import {preetham} from 'margoengine/sky/preetham';
import {night} from 'margoengine/sky/night';
import {lighting} from 'margoengine/sky/lighting';
import {Weather} from 'margoengine/sky/weather';
import {Snow} from 'margoengine/weather/snow';
import {VFX} from 'margoengine/vfx';
import {HemisphereLight} from 'margoengine/environment';
import {snowNight} from 'margoengine/sky/scene-kits';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
engine.createMesh().setGeometry(box(40, 0.2, 40)).setMaterial(new PbrMaterial({color: '#8d949c', roughness: 0.95}));
const kit = snowNight({snowfall: 'heavy'});
const sky = Sky.attach(engine, structuredClone(kit.sky), {preetham, night, lighting});
const snowfall = Weather.attach(engine, {...kit.precipitation});
const snow = Snow.attach(engine, {...kit.cover});
const bounce = HemisphereLight.attach(engine, {sky: [...kit.bounce.sky], ground: [...kit.bounce.ground]});
// The flames take the centre of the fuel's top: here, logs whose tops stand 0.46 m over the floor.
const fire = VFX.attach(engine, {...structuredClone(kit.hearth.fire), position: [0, 0.46, 0]});
engine.start();
console.log(kit.visibility, kit.fog.density); // 350 m, 0.0112 per metre
```

| Part | For | What the kit chooses |
| --- | --- | --- |
| `sky` | `Sky` (`preetham`, `night`, `lighting`) | 23:00, a deep blue night, a moon low in the sky at `moonPhase` (0.75) toward `moonDirection` (normalized; the sky's light comes from the same moon), `lighting.moon: {}`, so the sky lights with the moon it draws (`moonlight`, `@margoengine/sky/moonlight`: its phase, altitude and air set the lux, about 0.078 lux at the defaults, and the night's blue shift its colour), and a night ambient floor |
| `precipitation` | `Weather` (`@margoengine/sky/weather`) | snow at the snowfall's intensity (light 0.35, moderate 0.65, heavy 1), 750,000 flakes at their real size in a 22 m box, seen through f/1.4 with a 1/48 s shutter |
| `cover` | `Snow` (`@margoengine/weather/snow`) | full cover, 12 cm deep, drifts 3 m wide varying by half |
| `fog` | `VolumetricFog` (`@margoengine/environment/volumetric`) | density from the snowfall's visibility, a low height layer, forward scattering 0.45, a 90 m range; the scene adds `depth`, `lights` and `shadows` |
| `bounce` | `HemisphereLight` (`@margoengine/environment`) | the moonlight the snow sends back up: nothing from above, and from below the moonlit snow's radiance, `SNOW_ALBEDO` (0.85) times the snow plane's irradiance over pi (`snowBounce(moon, direction, ambient)`, from that same `moonlight`), so eaves, sills and the logs' undersides are lit by the snow as on a real snowy night (a surface facing down gets all of it, a wall half) |
| `bloom`, `tonemap` | `Bloom`, `Tonemap` | soft bloom from 1.2; AgX, +0.6 stops, white balance 5600 K so the snow stays blue and the fire orange, a vignette |
| `hearth` | `Fire` (`@margoengine/vfx/fire`), or `Clustered` with `clustered/line` and `clustered/flicker`, and `VFX` | the fire's light (`flameLight` of `@margoengine/clustered/flicker` at `FIRELIGHT_KELVIN`, 1,860 K, a wood fire's firelight (Zukauskas et al., IEEE Photonics Journal 6(3), 2014; 1,700 to 2,500 K, Zabiliute et al., Optics Letters 39(3), 2014; measured with a spectroradiometer by McCann, Proc. SPIE 6058, 2006: the smokeless wood flame about 1,700 K, flame with smoke above 2,000 K), linear [1, 0.224, 0]; 48.2 lm averaged over the `fire` flicker, 5.11 cd at its peak, times `fire`; range 9 m) as a flame line 0.62 m long, 0.14 m over the fuel top (the flames' radiance centroid), each point's shadow radius 0.155 m (`Fire` makes each point a sphere as bright as the flames); embers born 0.1 m over the flames; a lantern by the window, `hurricaneLantern({seed: 5})` of `@margoengine/clustered/flicker`: a 1,900 K kerosene flame (linear [1, 0.232, 0]), 82 lm as measured on a goniophotometer (Mills, LBNL 2003), 6.5 cd averaged over its `candle` flicker, range 18 m so its inverse square holds where its light lands, `radius` 0.011 m (its flame, half its 22 mm wick: a sphere light whose shadows have a flame's penumbra) and three particle effects: `fire`, `embers` and `steam` (place each with `position`; the flames at the centre of the fuel's top), each prewarmed for its longest lifetime (`schedule`, in the full `VFX` entry) so the first frame shows a fire already burning |

`snowfall` (`'light'`, `'moderate'` default, `'heavy'`) sets the visibility by the snow intensity bands of the Federal
Meteorological Handbook No. 1 (light at 5/8 statute mile or more, moderate from 5/16 to 5/8, heavy at 5/16 or less):
1,600 m, 750 m and 350 m. The fog density follows from it by Koschmieder (`fogDensityForVisibility`: 2% contrast at
3.912 / density metres). `fire` (0.25 to 4, default 1) scales the fire's light and its particles' birth rates.
`moonPhase` is -1 (new) to 1 (full). Each call returns a fresh, deeply frozen kit: give a package a copy
(`structuredClone(kit.sky)`, `{...kit.cover}`) when it changes its options in place. An unknown snowfall or a value
out of range throws `RangeError`. The values are Margo design values for this look, not a measured site.

The flames are born on the fuel: in a box 0.6 m along the logs, 0.14 m across their tops and 0.09 m high around
`position`, and they rise off it, as a flame stands on the burning surface that feeds it (Nguyen, Fedkiw and Jensen
2002). A box under the log tops and in front of the logs drew the young flames, still fading in, over the log faces: the
fire's base read as a soft smear. Measured on the Cabin Hearth close-up (1080p, the flame layer's 10 to 90% rise on five
lines up across the log tops, three held frames), the rise was 35 px tall and is 4 px now, natively and on the WebGL2
layer. Soft particles (Lorach 2007) were not the cause (`softness` 0 left it at 36 px, and with the births on the fuel
0, 0.02 and 0.08 differ by under a pixel), nor was TAA (Karis 2014; no history, the same 35 px) or the alpha curve's
zero first key (0.85 there, the same 35 px).
`packages/sky/test/fire-base-gpu.mjs` holds the rise under its bound.

- Nguyen, Fedkiw, Jensen, "Physically Based Modeling and Animation of Fire", SIGGRAPH 2002. https://doi.org/10.1145/566654.566643
- Lorach, "Soft Particles", NVIDIA whitepaper, 2007. https://developer.download.nvidia.com/whitepapers/2007/SDK10/SoftParticles_hi.pdf
- Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014 course. https://advances.realtimerendering.com/s2014/

### Whiteout: a blizzard with one lit window

`whiteout(options)` is a blizzard at dusk on open ground with one warm lit window (the Whiteout Pass scene,
`examples/whiteout-pass`). The storm is a weather state: `storm` and `lull` drive a `WeatherMachine` and a
`WeatherDrive` (`@margoengine/weather`), which set the snow, its gusting wind and, with `fogWind`, the drift of the
fog. Blend between the two to open and close the view; `whiteoutVisibility(kit, level)` gives the visibility at a
storm level (1 the storm, 0 the lull) for the fog's density.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky/base';
import {preetham} from 'margoengine/sky/preetham';
import {night} from 'margoengine/sky/night';
import {lighting} from 'margoengine/sky/lighting';
import {Weather} from 'margoengine/sky/weather';
import {WeatherMachine, blendStates} from 'margoengine/weather';
import {WeatherDrive} from 'margoengine/weather/drive';
import {VolumetricFog} from 'margoengine/environment/volumetric';
import {Tonemap} from 'margoengine/tonemap';
import {fogDensityForVisibility, whiteout, whiteoutVisibility} from 'margoengine/sky/scene-kits';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const kit = whiteout();
const machine = new WeatherMachine({...kit.storm});
const drive = WeatherDrive.attach(engine, {weather: machine, listener: engine.camera});
Sky.attach(engine, structuredClone(kit.sky), {preetham, night, lighting});
drive.options.precipitation = Weather.attach(engine, {...kit.precipitation});
// The fog reads the scene depth from a post capture, so the tonemap goes first.
Tonemap.attach(engine, {...kit.tonemap});
const fog = VolumetricFog.attach(engine, structuredClone(kit.fog));
drive.options.fogWind = fog;
// Ease the storm: half way to the lull.
machine.set(blendStates({...kit.lull}, {...kit.storm}, 0.5));
fog.options.density = fogDensityForVisibility(whiteoutVisibility(kit, 0.5));
engine.start();
console.log(kit.visibility, kit.lullVisibility); // 90 m in the storm, 1,200 m in the lull
```

| Part | For | What the kit chooses |
| --- | --- | --- |
| `sky` | `Sky` (`preetham`, `night`, `lighting`) | an overcast dusk lit by the snow: no moon disc or stars, the moonlight the sky derives for its half moon (`lighting.moon: {cloudCover: 1}`), a quarter of it through the overcast (`cloudTransmittance`, `@margoengine/sky/moonlight`), and a pale night ambient |
| `storm`, `lull` | `WeatherMachine` | snow 1 in a wind of `wind` (18 m/s) gusting by `gust` (0.55) toward `windDirection` (0.3); the lull at snow 0.35 and a third of the wind |
| `precipitation` | `Weather` (`@margoengine/sky/weather`) | 1,875,000 flakes at their real size in a 16 m box, bright for the dusk; the drive sets the amount and the wind |
| `cover` | `Snow` (`@margoengine/weather/snow`) | full cover, 12 cm deep, drifts 2 m wide |
| `fog` | `VolumetricFog` | the storm's density, a denser layer of blowing snow under 1.2 m, streaky noise, a pale blue-grey ambient, a 120 m range |
| `bloom`, `tonemap` | `Bloom`, `Tonemap` | bloom from 1.0 for the window's glow in the fog; AgX, white balance 5600 K, a vignette |
| `window` | `Clustered` with `clustered/flicker` | the lamp's light: `flameLight` (`@margoengine/clustered/flicker`), a kerosene flame at 1,900 K, 114 lm averaged over the `candle` flicker (speed 0.5), range 10 m |

A blizzard, by the US National Weather Service, is wind or frequent gusts of 35 mph (15.6 m/s) or more with falling
or blowing snow that leaves a quarter mile (402 m) of visibility or less: `wind` is 16 to 40 m/s and `visibility`
(default 90 m) 30 to 400 m; `lullVisibility` (default 1,200 m) is 400 to 5,000 m. The fog density for a visibility is
Koschmieder's (`fogDensityForVisibility`). The states' `fog` gives the drive's `fogDensity` the same visibility down
to its thickest fog, 196 m; below that set the fog volume's density from `whiteoutVisibility` as above. Out of range
options throw `RangeError`.

## Milky Way

`@margoengine/sky/milky-way` adds the Milky Way's band to a night sky, in its real place for the date and place. The
stars themselves come from `AstroSky` (`@margoengine/sky/astro`, with the Yale Bright Star Catalogue), which the band
follows.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {AstroSky, fetchBrightStarCatalog} from 'margoengine/sky/astro';
import {degrees} from 'margoengine/sky/sun';
import {MilkyWay} from 'margoengine/sky/milky-way';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const sky = new Sky({night: {}});
const catalog = await fetchBrightStarCatalog('/catalog.gz'); // CDS V/50, served beside your page
const astro = new AstroSky({latitude: degrees(-30), longitude: degrees(20), sky, catalog});
engine.use(astro);
engine.use(sky);
const band = MilkyWay.attach(engine, {astro}); // follows the astro's clock, place, night, brightness and extinction
engine.start();
band.options.clouds = 0.5; // calmer star clouds
```

`MilkyWay.attach(engine, options)` draws the band on the sky where nothing else was drawn (the far plane), added to
the sky's light, after the sky and before AstroSky's stars. Each pixel turns its view ray into galactic coordinates
(the Hipparcos J2000 to galactic rotation through `skyMatrix`), so the band is sharp at any resolution. Its surface
brightness is `surfaceBrightness` V magnitudes per square arcsecond at the galactic centre before its dust (default
20.5; larger is fainter), scaled by the same magnitude-0 `brightness` as AstroSky's stars and by each pixel's solid
angle, so band and stars keep their ratio at any field of view. It fades in with the sky's `nightFactor` (or, without a
sky, as the sun sinks to 12 degrees below the horizon), is dimmed by `extinction` toward the horizon and is not drawn
below it. `clouds` (0 to 1) sets the contrast of seamless star clouds and dark lanes, `seed` their pattern. Without
`astro`, pass `latitude`, `longitude` and `date`: the band then stays at that moment. `milkyWayBrightness(l, b)` and
`galacticCoordinates(direction, date, observer)` give the model and the frame on the CPU. Invalid options throw
`TypeError` or `RangeError`; WebGPU only.

The band's shape is a Margo model after all-sky photometry (Mellinger 2009): a disc that thins away from the plane and
fades from the centre, the bulge, and the Great Rift's dust from Aquila to Sagittarius; it is not a photograph of the
real star clouds. On a Radeon 680M every sampled pixel held the model's radiance within 0.32% at 40, 60 and 90 degrees
of view.

## Aurora

`@margoengine/sky/aurora` adds animated northern lights: curtains in arcs running east-west north of the world
origin, folding and rippling, green below and red above.

```ts
import {Engine} from 'margoengine/core';
import {Aurora} from 'margoengine/sky/aurora';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgpu'});
const aurora = Aurora.attach(engine, {intensity: 100, red: 0.5}); // a bright display with red tops
engine.start();
aurora.options.speed = 4; // livelier folds
aurora.time = 0; // jump back to the start
```

`aurora.advanceTime(delta)` moves the folds without drawing; each frame update runs it, so `seek` from
`@margoengine/cutscene/seek` starts a film scene with the curtains a continuous run shows at that time.

The light is three published auroral emissions: the oxygen green line (557.7 nm, from O(1S), whose 0.74 s lifetime
lets it shine down to about 100 km; brightest near 110 km), the oxygen red line (630.0 nm, from O(1D), whose 110 s
lifetime gets it quenched by collisions below about 150 to 200 km, so it glows above them, broad about 230 km) and
the blue band of the nitrogen ion (427.8 nm, a little below the green). Each has a Chapman-shaped height profile
(`auroraProfile`, sharp below the peak), its colour from the CIE 1931 colour-matching functions in linear sRGB, and
its luminance per kilorayleigh (`AURORA_LINES`). The curtains hang along the field (vertical here), each a thin
sheet (`thickness`, default 1.5 km) on a folded line, with rays about 3 km apart drifting along it; `arcs` arcs
(default 3) lie `spacing` km apart (default 40) from `distance` km north (default 150; north is -Z), each fainter.

`intensity` is the 557.7 nm column straight up through the brightest curtain in kR (default 30; the International
Brightness Coefficient grades I to IV are 1, 10, 100 and 1000 kR); `red` and `blue` are the other lines over it
(defaults 0.2 and 0.3: a green aurora; 1 and more for a red one). The light shares the magnitude-0 `brightness` of
`AstroSky`'s stars and `MilkyWay`'s band (default 4) and each pixel's solid angle, so 1 kR of green looks as bright as
sky of 21.9 V magnitudes per square arcsecond. Each pixel marches 64 steps through the shell from 80 to 450 km over a
round Earth, only where the arcs can be; `auroraColumn(origin, direction, time, options)` integrates the same model
finely on the CPU. `speed` scales the motion (folds travel along the arcs at 1 and 3 km/s; 0 holds them), `time`
is the aurora's clock and `seed` its pattern. With `sky` it fades in with the sky's `nightFactor`; it is drawn only
where nothing else was and never through the Earth. Invalid options throw `TypeError` or `RangeError`; WebGPU only.

On a Radeon 680M at 4x and 1x MSAA, the six brightest 8 x 8 pixel blocks of a view held the light of the CPU column
within 0.26%; the red share of the light at 50 degrees was 15.3 against 0.21 at 20 degrees. The shapes of the arcs,
folds and rays are a Margo model, not a measured display; the field lines are vertical (as near the magnetic pole).

This ESM package includes strict TypeScript declarations, requires core 1.0.0 and `@margoengine/sky` (the scenes entry also `@margoengine/post` and `@margoengine/tonemap`), and supported
WebGPU hardware on HTTPS or localhost. Apache-2.0 licensed.

## Preview tier contract

`MilkyWay` and `Aurora` draw on the WebGL2 compatibility layer with the pixels of WebGPU on the same GPU: on an RTX
A6000 the sky around them is identical, and 25 to 153 of the 196,608 values they add differ, by at most two half-float
steps, from the two shader compilers' rounding (`node packages/sky/test/compat-gpu.mjs`, part of
`npm run test:gpu`; docs/limits.md, "Sky layers on the WebGL2 layer").

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.
