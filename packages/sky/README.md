# @margoengine/sky

WebGPU atmospheric background with an analytical Preetham/Perez daytime sky and an Earth-based Bruneton-style precomputed Rayleigh/Mie model.

```ts
import {Sky} from '@margoengine/sky';
const sky = Sky.attach(engine, {model: 'bruneton', hours: 12, timeScale: 1 / 3600});
sky.options.hours = 18;
```

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

`reflectionTexture` exposes a borrowed 64 × 32 linear HDR equirectangular environment
for optional water reflection. Reading the getter enables its GPU refresh on
subsequent frames; it uses the existing atmospheric tables. The texture changes
on device restoration and must not be destroyed by its consumer.

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

The moon defaults to 10% of sun intensity and a cool blue color. It stays high
in the sky; sunset/sunrise blend one directional source for existing PCSS shadows
and water specular lighting. The atmospheric background and borrowed reflection
texture share the same night fade. This is a visual preset, with no lunar orbit
or phase calculation. RGB ambient patches the standard scene shader (including
scatter and mesh terrain) at group 0, binding 8, and composes with shadows and
clustered lights. Custom renderers using their own shaders need their own ambient
integration. The background fades to night even when scene moon lighting is omitted.

This is a compact atmospheric approximation, not a reference-quality reproduction of the original planetary renderer: no ozone spectrum, ground-albedo irradiance feedback, terrain light shafts or aerial perspective. Coarse horizon/angular sampling can band. Preetham is a daytime model with a night fade.

Models: [Preetham daylight notes](https://renderwonk.com/publications/s2003-course/preetham/notes-preetham.pdf), [Bruneton scattering equations](https://ebruneton.github.io/precomputed_atmospheric_scattering/atmosphere/functions.glsl.html).

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/sky

