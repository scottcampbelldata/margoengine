# @margoengine/sky

WebGPU atmospheric background with an analytical Preetham/Perez daytime sky and an Earth-based Bruneton-style precomputed Rayleigh/Mie model.

```ts
import {Sky} from '@margoengine/sky';
const sky = Sky.attach(engine, {model: 'bruneton', hours: 12, timeScale: 1 / 3600});
sky.options.hours = 18;
```

timeScale is clock hours per real second. Sun direction is exposed in the reused sun buffer. The sky draws only where the reversed-Z scene depth is clear. Bruneton precomputation includes transmittance, single scattering, scattering density and orders 2..4, cached until turbidity changes. Tables interpolate four dimensions (radius, view zenith, sun zenith, view/sun angle), with 8 x 32 x 16 x 8 samples; angular and ray integration use 32 samples. Camera Y is meters above Earth; atmosphere math is kilometers.

This is a compact atmospheric approximation, not a reference-quality reproduction of the original planetary renderer: no ozone spectrum, ground-albedo irradiance feedback, terrain light shafts or aerial perspective. Coarse horizon/angular sampling can band. Preetham is a daytime model with a night fade. Sun clock does not change the engine's direct-light settings automatically.

Models: [Preetham daylight notes](https://renderwonk.com/publications/s2003-course/preetham/notes-preetham.pdf), [Bruneton scattering equations](https://ebruneton.github.io/precomputed_atmospheric_scattering/atmosphere/functions.glsl.html).

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/sky

