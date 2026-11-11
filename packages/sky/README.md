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
| `@margoengine/sky/base` | clock, sun/moon discs, transmittance, default night gradient, `lights`, `nightFactor` | 7.1 kB |
| `/preetham` | Preetham day model (the default `model`) | 0.7 kB |
| `/bruneton` | Bruneton day model and its precomputed tables (about 1.3 MB of GPU memory), `groundAlbedo` | 3.0 kB |
| `/clouds` | `clouds` | 2.2 kB |
| `/night` | stylized `night` (stars, phased moon) | 2.4 kB |
| `/fog` | `fog` | 2.0 kB |
| `/reflection` | `reflectionTexture` | 1.1 kB |
| `/lighting` | `lighting` (engine sun/moon light, ambient) | 3.8 kB |
| `/sun` | typed angles, `setSun` / `setAmbient` over core's light, `sunlitSky`, `sunPath` (not a `Sky` feature) | 2.1 kB |
| `/weather` | `Weather`, its own plugin (not a `Sky` feature): rain, snow, sleet, lightning, thunder timing | 5.9 kB |
| `/volumetric-clouds` | `VolumetricClouds`, its own plugin: ray-marched 3D clouds you can fly through | 7.3 kB |
| `/cloud-shadows` | `volumetricCloudShadows`, a shadow effect for `@margoengine/shadows` | 3.2 kB |
| `/aerial` | `AerialPerspective`, its own plugin: distant surfaces take the air's colour | 6.5 kB |
| `/hillaire` | `HillaireSky`, its own plugin: a physical sky with ozone and an HDR environment bake | 10.8 kB |
| `/shafts` | `LightShafts`, its own plugin: god rays past geometry and through cloud gaps | 6.9 kB |
| `/presets` | `EARTH`, `MARS` and `marsAtmosphere` for the Hillaire entries (not a `Sky` feature) | 1.6 kB |
| `/astro` | `AstroSky`, its own plugin: the real sun, moon, planets and catalogue stars for a date and place | 9.5 kB |
| `/weather-fx` | `WeatherFX`, its own plugin: no rain under roofs, splashes, a wet lens | 5.3 kB |

Each entry is compressed on its own ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)),
so sums overstate a combined bundle: the root `Sky` is 17.7 kB with all of them, against 22.4 kB
summed. `addSky(stage)` (base, night) sums to about 9.5 kB and Night Citadel (base, night, fog, reflection) to about 12.6 kB. Recorded traces (`test/fixtures/traces.json`) pin the root `Sky`'s GPU work, WGSL and uploads; with fewer features,
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
`sky.cloudLayer` gives the layer's noise and clock to what must match it: `cloudShadows(sky)` from
`@margoengine/shadows/light-function` darkens the ground under these clouds. For clouds you can fly through, see [Volumetric clouds](#volumetric-clouds).

timeScale is clock hours per real second. Sun direction is exposed in the reused sun buffer. The sky draws only where the reversed-Z scene depth is clear. Bruneton precomputation includes transmittance, single scattering, scattering density and orders 2..4, cached until turbidity or `groundAlbedo` changes. Tables interpolate four dimensions (radius, view zenith, sun zenith, view/sun angle), with 8 x 32 x 16 x 8 samples; angular and ray integration use 32 samples. Camera Y is meters above Earth; atmosphere math is kilometers.

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

## Volumetric clouds

`VolumetricClouds` from `@margoengine/sky/volumetric-clouds` is a layer of real 3D cloud between two heights that
you can fly into, through and above. It is its own plugin: give it the sky that lights it, and leave the sky's own
`clouds` option off.

```ts
import {Engine} from 'margoengine/core';
import {Sky} from 'margoengine/sky';
import {Bloom} from 'margoengine/post/bloom';
import {VolumetricClouds} from 'margoengine/sky/volumetric-clouds';
const engine = await Engine.create(document.querySelector('canvas')!, {
  backend: 'webgpu', camera: {position: [0, 2, 0], target: [0, 40, -60], far: 200000},
});
const bloom = Bloom.attach(engine);
const sky = Sky.attach(engine, {hours: 10, timeScale: 0});
const clouds = VolumetricClouds.attach(engine, {sky, coverage: 0.5, depth: () => bloom.depthTexture});
clouds.options.wind = [15, 0]; // options are read every frame
```

Each pixel marches its view ray through the layer (`steps` samples, 64 by default, each starting at its own fraction of
a step so the steps do not band) and, wherever there is cloud, `lightSteps` samples (6) toward the sun. The shapes come
from two tiling noise volumes made once on the GPU (Schneider 2015): a 64³ Perlin-Worley and Worley volume for the
billows and a 32³ Worley volume that erodes their edges, wispy at the base and rounded higher up. A coarse slice of the
same volume spreads the clouds into groups and clear patches. The light is Beer-Lambert with the powder darkening,
two Henyey-Greenstein lobes, and multiple scattering as three octaves of weaker extinction and flatter phase (Wrenninge
et al. 2013), integrated step by step as Hillaire 2016 does, so the sun breaks through gaps in shafts and cloud edges
glow toward the sun. The layer sits on the planet's curve (radius 6,360 km), so it reaches the horizon, and far cloud
thins into the haze as the sky's own layer does (half at 28 km).

With a `sky`, the sun's direction and its colour through the sky's atmosphere (warm and dim when low, nothing once it
has set), the sky's exposure, its moon light and its sky light carry over. The sky light comes from the sky's 64 × 32
reflection map (the `reflection` feature, part of the root `Sky`), reduced on the GPU each frame to the light from above
and from the horizon; reading `sky.reflectionTexture` turns that map's refresh on. A sky without the feature, or no sky,
uses `ambient` and `sunDirection`.

`depth` takes the scene's reversed-Z depth each frame (any effect's scene depth, as the sky's fog does). With it the
march stops at scene surfaces, so a camera inside the layer sees cloud in front of nearby objects, and a mountain
in front of the clouds hides them. Without it the clouds draw only over the empty sky.

| Option | Default | Meaning |
| --- | --- | --- |
| `sky` | none | the `Sky` that lights the clouds |
| `coverage` | 0.5 | share of the sky covered, 0 to 1; 0 draws nothing |
| `bottom`, `top` | 1500, 4000 | the layer's base and tops in metres above the ground (100 to 20,000) |
| `density` | 0.04 | extinction per metre inside the densest cloud |
| `scale` | 14,000 | metres one repeat of the shapes spans; the erosion repeats eight times as often |
| `wind` | [10, 3] | metres per second along X and Z |
| `evolution` | 3 | metres per second the field rises through itself, so shapes change as they drift |
| `steps`, `lightSteps` | 64, 6 | samples along the view ray and toward the sun |
| `maxDistance` | 80,000 | farthest cloud drawn, metres |
| `sunIntensity` | 1.6 | sun radiance on the clouds in the sky's units, as the sky's own layer |
| `sunDirection`, `ambient` | [0.3, 0.6, 0.4]; a clear day's | the light without a sky |
| `depth` | none | the scene depth each frame |

`clouds.drift` holds how far the shapes have moved and risen; `volumetricCloudShadows(clouds)` from
`@margoengine/sky/cloud-shadows` casts their shadows on the ground (below). Cost: one fragment per pixel marching up to `steps` + `steps` ×
`lightSteps` noise reads, at full resolution, with no temporal reuse; a 256 × 192 view took about 15 ms a frame on a
Radeon 680M (diagnostic, taken with other jobs on the machine). Lower `steps` on slow GPUs. Needs WebGPU (`MargoError`
`'unsupported'` on WebGL2).

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
gradient). `moonLitBySun: true` (default false; `AstroSky` sets it) turns the lit side toward the sky's sun, as the real
moon's is, instead of a fixed side. The stylized night shows where the sun is below the horizon, blended by `nightFactor` at dusk, and
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
| `refraction` | true | lift each body by the refraction of standard air |
| `deltaT` | `deltaT(date)` | terrestrial minus universal time, seconds |

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
date. Aberration (up to 20.5 arcseconds) is not applied, Saturn's magnitude leaves out its rings, and the planets are
points, not discs. Each star is a Gaussian 1 px (`pointSize`) wide that keeps its light at any size: on a float target the
sky behind it loses 1/64 of the star's alpha, so its light is added within 0.1%; on an 8-bit canvas it replaces the sky by its alpha, and no pixel goes past 1.

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
| `precipitation` | `'rain'` | `'rain'`, `'snow'`, `'sleet'` (both at once) or `'none'` |
| `snowShare` | 0.5 | with `'sleet'`, the share that falls as snow, 0 to 1 |
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
does not stop the others. `weather.flash` (0 to 1) is the same flash as a number to drive a light.
`thunderDelay(distance, speed)` and `lightningFlash(seconds, offsets, amplitudes)` are the underlying functions.

The state reads as plain numbers: `amount`, `flash`, `wetness` (rises under rain in about 20 s, dries in 90 s; drive
roughness with it) and `snowCover` (builds in 2 minutes, melts in 5; drive a snow layer). `weather.listener` is the
position strikes are placed around; the render pass follows the camera, and without a GPU engine you may set it yourself
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

This is a compact atmospheric approximation, not a reference-quality reproduction of the original planetary renderer: no ozone spectrum or ground-albedo irradiance feedback (physical aerial perspective is the `/aerial` entry, light shafts the `/shafts` entry and a sky with ozone the `/hillaire` entry). Coarse angular sampling can band; the visible horizon uses a skyward sample to avoid a dark ground strip. Preetham is a daytime model with a night fade.

Models: [Preetham daylight notes](https://renderwonk.com/publications/s2003-course/preetham/notes-preetham.pdf), [Bruneton scattering equations](https://ebruneton.github.io/precomputed_atmospheric_scattering/atmosphere/functions.glsl.html).

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/sky

GPU fog coverage and shader parity: node scripts/modern-sky-fog-tests.js



## External radiance reference

After building, run `node scripts/gpu-lock.mjs run --max=3 --wait-max=1 --owner=codex-168 -- node packages/sky/scripts/rival-bench.mjs`.
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

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.
