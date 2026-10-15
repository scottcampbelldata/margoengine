# @margoengine/sky

WebGPU atmospheric background with an analytical Preetham/Perez daytime sky and an Earth-based Bruneton-style precomputed Rayleigh/Mie model, an optional stylized night (stars, phased moon) and distance or height fog. This is Margo's one sky: scenery's `SkyMoon` is a midnight preset of it.

```ts
import {Engine} from '@margoengine/core';
import {Sky} from '@margoengine/sky';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const sky = Sky.attach(engine, {model: 'bruneton', hours: 12, timeScale: 1 / 3600});
sky.options.hours = 18;
```

## Load only what you use

`Sky` from `@margoengine/sky` carries every feature. To ship less, build the same class from
`@margoengine/sky/base` and pass only the feature entries the scene uses as the second argument:

```ts
import {Engine} from '@margoengine/core';
import {Sky} from '@margoengine/sky/base';
import {bruneton} from '@margoengine/sky/bruneton';
import {clouds} from '@margoengine/sky/clouds';
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

Each entry is compressed on its own ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)),
so sums overstate a combined bundle: the root `Sky` is 10.2 kB with all of them, against 13.7 kB
summed. `stage.sky()` (base, night) sums to about 6.3 kB and Night Citadel (base, night, fog) to about 8.1 kB. With every feature the WGSL is byte-identical to the build before the split; with fewer,
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
procedural cloud layer. Coverage is 0–1, speed is signed world meters per second
along a fixed XZ wind direction, and height is 100–10,000 world meters. Defaults
are 0.45, 8 and 1500; omitting `clouds` disables the layer. Four filtered noise
octaves shade the sheet with daylight or moonlight. The visible sky and water's
borrowed reflection use the same cloud field and clock, with filtering matched
to each target's resolution. No textures, ray marching or CPU cloud geometry are
required. Distant clouds fade into clear horizon haze instead of stretching down
to the sea. This sheet has no cloud shadows or volumetric flight-through rendering.

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
dusk. The engine's single blended light still drives scene lighting and shadows.
With no `lighting` options, both direct reflection intensities are zero.

Set `lighting.sunset: [1, 0.69, 0.36]` alongside a daylight `color` such as
`[1, 0.97, 0.92]` to warm sunlight continuously near dawn and dusk. The blend uses
sun elevation, reaching the sunset tint below roughly 5° and the daylight tint
above 30°. Scene lighting and the separate water light record share that tint.
Omitting `sunset` keeps the configured colour constant.

## Stylized night

Set `night` to replace the default night gradient with a moonlit sky: a zenith-to-horizon gradient, twinkling
stars above 15° and a moon disc with phase, glow and size. The object is read every frame, so mutate it for
live controls.

```ts
import {Engine} from '@margoengine/core';
import {Sky} from '@margoengine/sky';
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
import {Engine} from '@margoengine/core';
import {Sky} from '@margoengine/sky';
import {Bloom} from '@margoengine/post/bloom';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const bloom = Bloom.attach(engine);          // or @margoengine/water's Water: () => water.depthTexture
const sky = Sky.attach(engine);
sky.options.fog = {depth: () => bloom.depthTexture, start: 45, density: 0.008};
```

`start` is a clear distance in world meters (default 40); `density` is inverse
meters (default 0.01, range 0–1). Visibility is
`exp(-((max(0, distance - start) * density) ** 2))`; zero density disables the pass.
Fog uses the sky model's direction-dependent radiance, exposure and night fade,
with the same horizon sampling as the background and borrowed water environment.
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
the sun direction into engine lighting and scale direct intensity by sun elevation.
Intensity defaults to 1 and minimum to 0. Radiance color and ambient settings stay
under the caller's control. Omit `lighting` to keep independent scene lighting.

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
existing PCSS shadows retain a single smoothly blended twilight light. The
atmospheric background has its own earlier twilight fade. This is a visual preset, with no lunar orbit
or phase calculation. RGB ambient patches the standard scene shader (including
scatter and mesh terrain) at group 0, binding 8, and composes with shadows and
clustered lights. Custom renderers using their own shaders need their own ambient
integration. The background fades to night even when scene moon lighting is omitted.

`sky.nightFactor` exposes the same dusk/dawn blend: 0 in daylight and 1 at night.
It updates before rendering, including paused manual renders. To switch local
lights and emissive batches together, set `lights.intensityScale =
instances.emissiveIntensity = () => sky.nightFactor` using clustered and scatter.

This is a compact atmospheric approximation, not a reference-quality reproduction of the original planetary renderer: no ozone spectrum, ground-albedo irradiance feedback, terrain light shafts or physical aerial perspective. Coarse angular sampling can band; the visible horizon uses a skyward sample to avoid a dark ground strip. Preetham is a daytime model with a night fade.

Models: [Preetham daylight notes](https://renderwonk.com/publications/s2003-course/preetham/notes-preetham.pdf), [Bruneton scattering equations](https://ebruneton.github.io/precomputed_atmospheric_scattering/atmosphere/functions.glsl.html).

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/sky

GPU fog coverage and shader parity: node scripts/modern-sky-fog-tests.js

