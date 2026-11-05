# @margoengine/sky

Import `margoengine/sky` from the `margoengine` package, or `@margoengine/sky` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

WebGPU atmospheric background with an analytical Preetham/Perez daytime sky and an Earth-based Bruneton-style precomputed Rayleigh/Mie model, an optional stylized night (stars, phased moon) and distance or height fog, plus optional weather (rain, snow, lightning and thunder timing). This is Margo's one sky: scenery's `SkyMoon` is a midnight preset of it.

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
| `@margoengine/sky/base` | clock, sun/moon discs, transmittance, default night gradient, `lights`, `nightFactor` | 5.0 kB |
| `/preetham` | Preetham day model (the default `model`) | 0.7 kB |
| `/bruneton` | Bruneton day model and its precomputed tables (about 1.3 MB of GPU memory) | 2.2 kB |
| `/clouds` | `clouds` | 0.9 kB |
| `/night` | stylized `night` (stars, phased moon) | 1.3 kB |
| `/fog` | `fog` | 1.7 kB |
| `/reflection` | `reflectionTexture` | 0.8 kB |
| `/lighting` | `lighting` (engine sun/moon light, ambient) | 1.0 kB |
| `/sun` | typed angles, `setSun` / `setAmbient` over core's light, `sunlitSky`, `sunPath` (not a `Sky` feature) | 2.1 kB |
| `/weather` | `Weather`, its own plugin (not a `Sky` feature): rain, snow, lightning, thunder timing | 5.6 kB |

Each entry is compressed on its own ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)),
so sums overstate a combined bundle: the root `Sky` is 10.2 kB with all of them, against 13.7 kB
summed. `addSky(stage)` (base, night) sums to about 6.3 kB and Night Citadel (base, night, fog, reflection) to about 8.9 kB. Recorded traces (`test/fixtures/traces.json`) pin the root `Sky`'s GPU work, WGSL and uploads; with fewer features,
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
edges. Fine octaves fade to their mean once a pixel covers them. Three samples
toward the sun through the layer give Beer-Lambert self-shadowing with a powder
term, lit by the sun's transmittance colour with a two-lobe Henyey-Greenstein phase
(Hillaire 2016); the surrounding sky lights them as ambient, and the lighting moon
by night. A sky pixel evaluates at most ten noise lookups (four for the shape and
erosion, six for the sun samples), two where the sky is clear, and no
texture reads. The visible sky, water's reflection and the lighting environment use
the same cloud field and clock, with filtering matched to each target's resolution.
This layer has no cloud shadows on the ground or volumetric flight-through rendering.

timeScale is clock hours per real second. Sun direction is exposed in the reused sun buffer. The sky draws only where the reversed-Z scene depth is clear. Bruneton precomputation includes transmittance, single scattering, scattering density and orders 2..4, cached until turbidity changes. Tables interpolate four dimensions (radius, view zenith, sun zenith, view/sun angle), with 8 x 32 x 16 x 8 samples; angular and ray integration use 32 samples. Camera Y is meters above Earth; atmosphere math is kilometers.

The default Preetham model computes the shared sun transmittance table. Scattering
tables are computed when Bruneton is first rendered, including after a model
switch or device restoration; changes to turbidity refresh the tables each model uses.

`reflectionTexture` exposes a borrowed 64 × 32 linear HDR equirectangular environment
for optional water reflection. Reading the getter enables its GPU refresh on
subsequent frames; it uses the existing atmospheric tables. The texture changes
on device restoration and must not be destroyed by its consumer.

`sky.lights` exposes two retained sun/moon records updated before rendering. Each
holds `direction` (XYZ plus intensity) and RGB `radiance`. Pass these to
`Water.attach(engine, {lights: sky.lights})` for separate reflection paths during
dusk. The engine's single light (sun or moon) still drives scene lighting and shadows.
With no `lighting` options, both direct reflection intensities are zero.

The sun's colour and strength come from the atmosphere's own transmittance: `color`
and `intensity` hold for the sun overhead, and lower down the light passes through
more air, warming and dimming it (at 17:34 with turbidity 3.2 the sun is at about
69% strength, with green at 64% and blue at 21% of red). Surfaces add their own N·L,
so there is no further elevation factor. `sunlight(mu, altitude, turbidity)` returns
that colour for any sun elevation. `sunset` is deprecated and ignored.

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
Stars twinkle on independent phases. The moon disc is drawn before its glow: the unlit part keeps a faint
earthshine and reads as a darker disc inside the halo, and the rim is filtered by the pixel or texel footprint.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {hours: 0, timeScale: 0, night: {
  zenithColor: [0.015, 0.025, 0.065], horizonColor: [0.08, 0.09, 0.15], hazeDensity: 1,
  moonDirection: [0.4, 0.7, 0.5], moonSize: 0.038, moonPhase: 0.85, moonColor: [0.92, 0.95, 1],
  glowIntensity: 1.2, starIntensity: 0.8, starTwinkleIntensity: 1,
}});
sky.options.night!.moonPhase = -0.2;
```

Those are the defaults. Colours are non-negative linear RGB; `moonDirection` is normalized; `moonSize` is an
angular radius in radians between 0 and π/2; `moonPhase` clamps to −1 (new) … 1 (full); glow, star and twinkle
intensities and `hazeDensity` clamp to zero or above (zero twinkle holds stars steady, zero haze removes the
gradient). The stylized night shows where the sun is below the horizon, blended by `nightFactor` at dusk, and
its colours are written as given, also on display targets (the physical day sky is tonemapped there). It
replaces the separate preset moon; leave `lighting.moon` unset with it.

## Fog

For lightweight distance haze, provide sampleable reversed-Z scene depth:

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {Bloom} from 'margoengine/post/bloom';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const bloom = Bloom.attach(engine);          // or @margoengine/water's Water: () => water.depthTexture
const sky = Sky.attach(engine);
sky.options.fog = {depth: () => bloom.depthTexture, start: 45, density: 0.008};
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
sample count. The texture must match the viewport, have `TEXTURE_BINDING` usage
and stay owned by its provider. With no water, use your post effect's scene depth.
Re-read the provider after resize/device restoration. Omit `fog` to retain the
existing rendering.

Three optional fog fields change the look: `falloff: 'exp'` uses `1 - exp(-optical)` instead of the squared
default; `height` adds density below y = 0 (optical depth × (1 + height × metres below 0), e.g. 0.065 for a
sea haze); `color` replaces the sky radiance with a fixed linear colour. Night Citadel uses
`{start: 0, falloff: 'exp', height: 0.065, color: horizon}`. This is homogeneous distance haze, without height fog,
volumetric light shafts or particle-depth fog; large scenes need a suitable
camera far plane.

The clock and sun update before rendering, so shadows and scene lighting can use
the same frame's direction. Set `lighting: {intensity: 6, minimum: 0.15}` to copy
the sun direction, strength and transmittance colour into engine lighting.
Intensity defaults to 1 and minimum to 0; the radiance colour is always written.
Omit `lighting` to keep independent scene lighting.

For a day/night scene, enable the optional moon and RGB ambient floor:

```ts
Sky.attach(engine, {hours: 18.5, lighting: {
  intensity: 6, color: [1, 0.8, 0.54],
  moon: {intensity: 0.6, color: [0.25, 0.45, 0.75]},
  ambient: {day: [0.18, 0.18, 0.18], night: [0.02, 0.04, 0.09]},
}});
```

The moon defaults to 10% of sun intensity and a cool blue color. Its visual preset
sits about 12° above the horizon. Its disc, borrowed environment and separate water
glint use one fade, starting when the sun drops below the horizon and reaching full
strength with the sun about 7° below the horizon (about 18:28 on this clock). They fade
out together before sunrise; there is no daytime moon glint. Scene lighting and
PCSS shadows use one light, the stronger of sun and moon: the sun fades out through
its transmittance as its disc sets before the moon fades in, so the light changes
direction once, below 1% of noon strength, instead of sweeping across the sky. The
atmospheric background has its own earlier twilight fade. This is a visual preset, with no lunar orbit
or phase calculation. The background fades to night even when scene moon lighting is omitted.

With `ambient`, the sky lights the scene itself. Each frame it renders a 64 × 32
environment (the same sky water reflects, clouds and moon included, the sun's disc
left to the engine light) with three box-filtered mips, projects it onto nine
spherical harmonics (Ramamoorthi and Hanrahan 2001) on the GPU, and patches the
standard scene shader (including scatter and mesh terrain) at group 0, bindings 8,
10 and 11. Surfaces get directional diffuse light from the harmonics, never below
the `ambient` floor for the time of day, plus split-sum sky reflections (Karis 2013):
the environment blurred through its mips by roughness, times Karis's analytic
environment BRDF. Glass and glossy paint now reflect the sky by day. The term is
named `margoAmbient`, so SSAO occludes it; `EnvironmentLighting` uses the same name, so
use one or the other. It composes with shadows and clustered lights; custom
renderers using their own shaders need their own ambient integration.

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

`sky.nightFactor` exposes the same dusk/dawn blend: 0 in daylight and 1 at night.
It updates before rendering, including paused manual renders. To switch local
lights and emissive batches together, set `lights.intensityScale =
instances.emissiveIntensity = () => sky.nightFactor` using clustered and scatter.

## Weather: rain, snow and lightning

`Weather` from `@margoengine/sky/weather` is its own plugin, not a feature of `Sky`, so a clear-sky scene pays nothing
for it. Rain streaks or snow flakes fall in a box that follows the camera (25 m half-width and 20 m high by default).
Each particle is placed by an integer hash and moved by the wind with no per-frame upload, drawn depth-tested over the
scene (nearer geometry hides it) after the sky and fog. Defaults: 24,000 rain streaks or 16,000 flakes at intensity 1.

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
| `precipitation` | `'rain'` | `'rain'`, `'snow'` or `'none'` |
| `intensity` | 0.5 | target amount, 0 to 1 |
| `fadeSeconds` | 4 | seconds across the whole range; 0 jumps |
| `wind` | `[0, 0]` | metres per second, world X and Z: rain slants, snow drifts |
| `radius`, `height` | 25, 20 | half-width and height in metres of the box that follows the camera |
| `particles` | 24,000 rain, 16,000 snow | count at intensity 1, up to 500,000; the amount scales it |
| `color`, `brightness`, `opacity` | pale grey-blue (rain) or white (snow), 1, 0.35 (rain) or 0.8 (snow) | linear RGB, its scale, one particle's alpha |
| `lightning` | none | storms, below |

Particle colour is a fixed linear RGB, so scale `brightness` with the light of the scene (above, `1 - sky.nightFactor`).
A flake or streak smaller than a pixel dims instead of sparkling. Rain falls at 9 m/s and snow at 1.2 m/s with a
gentle sway.

Lightning (`lightning: {}` for the defaults) strikes as a Poisson process: `rate` strikes a minute (default 6) at
intensity 1, rising from nothing at `threshold` (default 0.6), at a random distance between `minDistance` (300 m) and
`maxDistance` (6,000 m) and direction around the listener. The same `seed` and frame times give the same storm. A strike
has one to four return strokes (each rises in 8 ms and decays with a 70 ms time constant) and adds `strength` (default
0.35) of `color` over the frame, brighter toward the top. `onLightning` fires as the flash starts, `onThunder` after
`distance / 343` seconds with a `loudness` (falls with distance) and `rumble` length for your audio; a throwing listener
does not stop the others. `weather.flash` (0 to 1) is the same flash as a number to drive a light.
`thunderDelay(distance, speed)` and `lightningFlash(seconds, offsets, amplitudes)` are the underlying functions.

The state reads as plain numbers: `amount`, `flash`, `wetness` (rises under rain in about 20 s, dries in 90 s; drive
roughness with it) and `snowCover` (builds in 2 minutes, melts in 5; drive a snow layer). `weather.listener` is the
position strikes are placed around; the render pass follows the camera, and without a GPU engine you may set it yourself
and call `onPreUpdate(delta)` for audio or game logic. `Weather` needs WebGPU (`MargoError` `'unsupported'` on WebGL2). Sky lighting runs on the WebGL2 compatibility layer with
no change to your code: the package loads a small route there that computes the same light on the GPU.
This is a screen-space-free particle overlay: no splashes on the ground, no rain running down the lens, no rain
occlusion under roofs (it respects the scene depth, not covered areas).

This is a compact atmospheric approximation, not a reference-quality reproduction of the original planetary renderer: no ozone spectrum, ground-albedo irradiance feedback, terrain light shafts or physical aerial perspective. Coarse angular sampling can band; the visible horizon uses a skyward sample to avoid a dark ground strip. Preetham is a daytime model with a night fade.

Models: [Preetham daylight notes](https://renderwonk.com/publications/s2003-course/preetham/notes-preetham.pdf), [Bruneton scattering equations](https://ebruneton.github.io/precomputed_atmospheric_scattering/atmosphere/functions.glsl.html).

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/sky

GPU fog coverage and shader parity: node scripts/modern-sky-fog-tests.js

