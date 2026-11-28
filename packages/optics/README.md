# @margoengine/optics

Import `margoengine/optics` from the `margoengine` package, or `@margoengine/optics` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Physical optics as plain functions with no GPU or DOM: refraction and dispersion, polarised light, thin films and
multilayer coatings, diffraction, image formation and the colour of a spectrum. Every function is checked against a
closed-form solution or a published measurement (`tests/optics.test.js`). Angles are radians, wavelengths are
nanometres unless a parameter says metres, and argument errors throw `RangeError`.

| Entry | What it holds |
| --- | --- |
| `@margoengine/optics/refraction` | `snell`, `criticalAngle`, `brewsterAngle`, `fresnelAmplitudes`, `fresnelReflectance`, `sellmeierIndex` with `FUSED_SILICA` and `N_BK7`, `cauchyFromAbbe`, `cauchyIndex`, `prismDeviation`, `minimumDeviation`, `minimumDeviationIncidence`, `hexagonalHaloProfile`, `traceGradedRay`, `layeredElevation`, `ciddorRefractivity`, `heatedAirLayer`, `refractVector`, `tracePolygon` |
| `@margoengine/optics/polarization` | `malus`, `JonesVector`, `JonesMatrix` (polariser, retarder, `after`, `apply`), `photoelasticTransmission`, `photoelasticColors`, `photoelasticRetardation`, `diametralDiscStress` |
| `@margoengine/optics/interference` | `thinFilmReflectance`, `multilayerReflectance`, `quarterWaveStack`, `thinFilmColor`, `michelsonFringes`, `michelsonIntensity`, `michelsonTilt`, `moireSpacing` |
| `@margoengine/optics/diffraction` | `gratingAngle`, `gratingOrders`, `besselJ`, `airyIntensity`, `airyFirstZero`, `fresnelNumber`, `circularPointSpread` |
| `@margoengine/optics/imaging` | `thinLens`, `pinholeImage`, `relativeIllumination`, `astigmaticFoci`, `astigmaticImage`, `designFresnelLens`, `cornerCubeReflect`, `airIndexTemperatureSlope`, `knifeEdgeTransmission` |
| `@margoengine/optics/spectrum` | `cieXYZ`, `xyzToLinearSRGB`, `wavelengthToLinearSRGB`, `spectralColor`, `planckRelative`, `SpectralIntegrator` (`color`, `luminance`) |

The root entry re-exports all six; import an entry to load only that topic. `@margoengine/optics/screens` (below) is
the GPU side, drawn with `@margoengine/shader`, and is imported on its own.

## Refraction and dispersion

```ts
import { snell, criticalAngle, fresnelReflectance, brewsterAngle, sellmeierIndex, FUSED_SILICA, minimumDeviation } from '@margoengine/optics/refraction';
const deg = Math.PI / 180;
const inside = snell(1, 1.5, 30 * deg); // 0.3398 rad
const tir = criticalAngle(1.5, 1); // 0.7297 rad, 41.8 deg
const glare = fresnelReflectance(1, 1.5, brewsterAngle(1, 1.5)); // p is 0
const n = sellmeierIndex(587.56, FUSED_SILICA); // 1.4585 (Malitson 1965)
const halo = minimumDeviation(60 * deg, 1.31) / deg; // 21.84 deg, the 22 degree halo
console.log(inside, tir, glare.p, n, halo);
```

`hexagonalHaloProfile({ indices })` bins the light through randomly oriented hexagonal ice columns by scattering
angle, one channel per index, for a halo texture. `traceGradedRay(medium, options)` follows a ray through a medium whose
index changes with height (mirages, looming) by fourth-order Runge-Kutta on the ray equation; `n cos(elevation)` is
kept to integration accuracy and the turning point is reported. `heatedAirLayer` is the medium for a road or desert
mirage (Ciddor's dry-air refractivity, a temperature excess that falls off with height); its exact inverse puts the
turning point where n equals the ray invariant, and `layeredElevation` gives the angle a ray leaves the layer at.
`refractVector` is Snell's law for 2D or 3D direction vectors, and `tracePolygon` follows a 2D ray in and out of a
convex prism.

```ts
import { heatedAirLayer, layeredElevation, traceGradedRay, tracePolygon } from '@margoengine/optics/refraction';
const deg = Math.PI / 180;
const air = heatedAirLayer({ ambient: 26, surface: 62, depth: 0.02 }); // 36 C hotter at the asphalt
const ray = traceGradedRay(air, { height: 0.5, elevation: -0.32 * deg, distance: 640, ceiling: 0.5 });
console.log(ray.kind, ray.turn?.height, layeredElevation(ray.invariant, air.farIndex) / deg); // 'ceiling', ~0.013 m, 0.32
const prism = tracePolygon([[-0.5, 0], [0.5, 0], [0, 0.866]], [-0.9, 0.1], [Math.cos(20 * deg), Math.sin(20 * deg)], 1.6);
console.log(prism?.exitEdge, prism?.direction); // leaves through the right face, bent toward the base
```

## Polarisation

```ts
import { malus, JonesVector, JonesMatrix, photoelasticColors } from '@margoengine/optics/polarization';
const deg = Math.PI / 180;
const half = malus(45 * deg); // 0.5
const quarterWave = JonesMatrix.retarder(45 * deg, Math.PI / 2);
const circular = quarterWave.apply(JonesVector.linear(0));
const throughX = JonesMatrix.polarizer(0).apply(circular).intensity; // 0.5
const michelLevy = photoelasticColors(2000, 256); // linear sRGB of white light through 0..2000 nm retardation, crossed
console.log(half, throughX, michelLevy.length);
```

## Thin films and coatings

```ts
import { thinFilmReflectance, multilayerReflectance, quarterWaveStack, thinFilmColor, michelsonFringes, moireSpacing } from '@margoengine/optics/interference';
const coating = { filmIndex: Math.sqrt(1.52), thickness: 550 / (4 * Math.sqrt(1.52)), substrateIndex: 1.52 };
const antiReflection = thinFilmReflectance(coating, 550); // 0
const mirror = multilayerReflectance({ layers: quarterWaveStack(2.35, 1.38, 6, 600), substrateIndex: 1.52 }, 600); // 0.998
const soapBubble = thinFilmColor({ filmIndex: 1.33, thickness: 380, substrateIndex: 1 }); // linear sRGB
const fringes = michelsonFringes(10000, 632.8); // 31.6 fringes for 10 um of mirror travel
const bands = moireSpacing(1, 1, Math.PI / 90); // 28.65 line pitches
console.log(antiReflection, mirror, soapBubble, fringes, bands);
```

`multilayerReflectance` uses the characteristic matrix of each layer, so it takes any number of layers, tilted light
in s or p, and evanescent gaps past a critical angle (frustrated total internal reflection).

## Diffraction

```ts
import { gratingOrders, airyFirstZero, fresnelNumber, circularPointSpread } from '@margoengine/optics/diffraction';
const orders = gratingOrders(532, 600); // orders -3..3 with their angles
const ring = airyFirstZero(550e-9, 0.01); // 6.7e-5 rad: 1.22 lambda / D
const N = fresnelNumber(0.15e-3, 532e-9, 0.88, 0.28);
const spot = circularPointSpread({ radius: 0.15e-3, wavelength: 532e-9, distance: 0.28, fresnelNumber: N, maxRadius: 0.003 });
console.log(orders.length, ring, N, spot.diameter80);
```

## Image formation

```ts
import { thinLens, pinholeImage, astigmaticFoci, designFresnelLens, cornerCubeReflect, knifeEdgeTransmission } from '@margoengine/optics/imaging';
const image = thinLens(0.1, 0.3); // imageDistance 0.15, magnification -0.5
const onScreen = pinholeImage(0.2, 0.1, 2, 0.3);
const foci = astigmaticFoci(0.42, 0.06); // tangential, sagittal, circle of least confusion
const lens = designFresnelLens({ index: 1.49, focalDistance: 0.45, centerRadius: 0.024, ringWidth: 0.0176, rings: 10, baseDepth: 0.0046 });
const beam = lens.trace(0.45, 9).exterior; // about 0: a lamp at the focus leaves parallel
const back = cornerCubeReflect([0.3, 0.3, 0.3], [-0.5, -0.55, -0.67], 0.9);
const grey = knifeEdgeTransmission(0, { cutoff: 0.5, focalLength: 0.46, sourceWidth: 4.7e-5 }); // 0.5
console.log(image, onScreen, foci, beam, back?.direction, grey);
```

## Colour of a spectrum

```ts
import { cieXYZ, spectralColor, SpectralIntegrator } from '@margoengine/optics/spectrum';
const xyz = cieXYZ(555); // CIE 1931 colour matching functions
const laserGreen = spectralColor(532); // display colour of a spectral line, brightest channel 1
const integrator = new SpectralIntegrator({ step: 4, illuminant: 6504 });
const white = integrator.color(() => 1); // [1, 1, 1]
const blueFilter = integrator.color((nm) => (nm < 500 ? 1 : 0));
const kept = integrator.luminance((nm) => (nm < 500 ? 1 : 0)); // share of the brightness the filter passes
console.log(xyz, laserGreen, white, blueFilter, kept);
```

## Bench screens (GPU)

`@margoengine/optics/screens` draws what an optics bench shows: laser beams as crossed Gaussian tubes (core plus scatter
halo, Kogelnik and Li), glass plates with a rim and a sheen band, glowing spots (soft or hard-cored), a two-beam
interference detector whose field is `(1 + V cos(2 pi (u f + cycles))) / 2` under a Gaussian beam, and mirror facets that
reflect a soft studio. Every part of one set shares one `RawShaderMaterial` (one pipeline per blend mode), follows a core
mesh's transform, and takes its look as numbers, so a scene never writes shader text. Each part's `set(look)` changes
the look live (it rewrites only the values that changed); `part.mesh.visible` hides it. It runs on WebGPU and on the
WebGL2 compatibility layer (`npm run test:gpu:screens` in this package checks both). It needs `@margoengine/shader`; the
root entry does not re-export it.

| Part | Call | Look fields (defaults in the type docs) |
| --- | --- | --- |
| Laser beam | `beam(parent, look)`: along the parent's +z from 0 to 1, scale the parent to width and length | `edge`, `core`, `coreMix`, `colorFalloff`, `coreFalloff`, `coreWeight`, `haloFalloff`, `haloWeight`, `lengthBase`, `lengthSlope`, `lengthTaper`, `opacity` |
| Glass plate | `plate(parent, halfWidth, halfHeight, look)` | `tint`, `sheen`, `sheenMix`, `sheenFalloff`, `bandX`, `bandY`, `bandOffset`, `rimStart`, `base`, `rimWeight`, `bandWeight`, `bandFalloff`, `shape` (`'rect'` or `'disc'`) |
| Spot | `spot(parent, halfWidth, halfHeight, look)` | `edge`, `core`, `coreMix`, `colorFalloff`, `innerFalloff`, `innerWeight`, `outerFalloff`, `outerWeight`, `fade`, `opacity`, `hardCore` |
| Fringe detector | `fringes(parent, radius, look)` | `frequency`, `cycles`, `visibility`, `waist`, `edge`, `core`, `gamma`, `gain`, `body`, `glow`, `markWeight` |
| Mirror facet | `facet(parent, [p0, p1, p2], normal, look)` | `dark`, `panelColor`, `panelFalloff`, `panelHeight`, `tint`, `highlightFalloff`, `highlightTilt`, `highlightOffset`, `base`, `highlightWeight` |

`OpticsScreens.attach(engine, {blending})` takes `'normal'` (default) or `'additive'` for glowing parts drawn after the
opaque scene, or `'none'` for opaque parts that write depth (facets); every set on an engine draws through one
`RawShaders` plugin.

```ts
import { Engine } from '@margoengine/core';
import { michelsonFringes } from '@margoengine/optics/interference';
import { OpticsScreens } from '@margoengine/optics/screens';
const engine = await Engine.create(document.querySelector('canvas')!, { camera: { position: [0, 0, 3], target: [0, 0, 0] } });
const screens = OpticsScreens.attach(engine);
// A red He-Ne beam 2 units long along +x, 0.05 wide.
const anchor = engine.createMesh().setPosition([-1, 0.5, 0]).setQuaternion([0, Math.SQRT1_2, 0, Math.SQRT1_2]).setScale([0.05, 0.05, 2]);
screens.beam(anchor);
const splitter = screens.plate(engine.createMesh().setPosition([-0.8, -0.4, 0]), 0.3, 0.25);
const detector = screens.fringes(engine.createMesh().setPosition([0.6, -0.4, 0]), 0.5, { frequency: 3 });
await screens.ready();
// Move the mirror 200 nm: the fringes slide by 2d / wavelength cycles.
detector.set({ cycles: michelsonFringes(200, 632.8) % 1 });
splitter.set({ tint: [0.2, 0.5, 0.4] });
engine.render();
```

## Sources

Written clean room from these publications; no other engine's or paper's code was read.

- M. Born and E. Wolf, *Principles of Optics*, 7th ed., Cambridge University Press, 1999. Fresnel equations, layered
  media, the characteristic matrix, prism deviation, the ray equation, Airy pattern.
- E. Hecht, *Optics*, 5th ed., Pearson, 2017. Snell, Malus, thin lens, gratings, interferometers, retroreflectors.
- I. H. Malitson, "Interspecimen Comparison of the Refractive Index of Fused Silica", JOSA 55(10), 1205-1209, 1965.
  https://doi.org/10.1364/JOSA.55.001205
- SCHOTT AG, N-BK7 optical glass data sheet (Sellmeier coefficients). https://www.schott.com/en-us/products/optical-glass-p1000267
- S. G. Warren, "Optical constants of ice from the ultraviolet to the microwave", Applied Optics 23(8), 1206-1225,
  1984. https://doi.org/10.1364/AO.23.001206 (ice indices near 1.31 used in the halo test).
- R. Greenler, *Rainbows, Halos, and Glories*, Cambridge University Press, 1980; W. Tape, *Atmospheric Halos*, AGU
  Antarctic Research Series 64, 1994. https://doi.org/10.1029/AR064
- R. C. Jones, "A New Calculus for the Treatment of Optical Systems I", JOSA 31(7), 488-493, 1941.
  https://doi.org/10.1364/JOSA.31.000488
- M. M. Frocht, *Photoelasticity*, Wiley, 1941; J. W. Dally and W. F. Riley, *Experimental Stress Analysis*, 4th ed.,
  2005.
- H. A. Macleod, *Thin-Film Optical Filters*, 4th ed., CRC Press, 2010. https://doi.org/10.1201/9781420073034
- L. Belcour and P. Barla, "A Practical Extension to Microfacet Theory for the Modeling of Varying Iridescence", ACM
  TOG 36(4), 2017. https://doi.org/10.1145/3072959.3073620
- J. W. Goodman, *Introduction to Fourier Optics*, 3rd ed., Roberts, 2005. Fresnel number and near-field point spread.
- L. N. Trefethen and J. A. C. Weideman, "The Exponentially Convergent Trapezoidal Rule", SIAM Review 56(3), 385-458,
  2014. https://doi.org/10.1137/130932132 (Bessel integrals).
- I. Amidror, *The Theory of the Moire Phenomenon*, vol. 1, 2nd ed., Springer, 2009.
  https://doi.org/10.1007/978-1-84882-181-1
- P. E. Ciddor, "Refractive index of air: new equations for the visible and near infrared", Applied Optics 35(9),
  1566-1573, 1996. https://doi.org/10.1364/AO.35.001566
- A. S. Glassner (ed.), *An Introduction to Ray Tracing*, Academic Press, 1989, chapter 6 (vector refraction).
- G. S. Settles, *Schlieren and Shadowgraph Techniques*, Springer, 2001. https://doi.org/10.1007/978-3-642-56640-0
- C. Wyman, P.-P. Sloan and P. Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching Functions",
  JCGT 2(2), 1-11, 2013. https://jcgt.org/published/0002/02/01/
- IEC 61966-2-1:1999, sRGB (XYZ to linear sRGB matrix).
- H. Kogelnik and T. Li, "Laser Beams and Resonators", Applied Optics 5(10), 1550-1567, 1966.
  https://doi.org/10.1364/AO.5.001550 (Gaussian beam profile of the screens' beams).
- A. E. Siegman, *Lasers*, University Science Books, 1986 (beam profile and scatter halo).
- P. Hariharan, *Basics of Interferometry*, 2nd ed., Academic Press, 2007 (tilted-mirror fringes on the detector).
- C. Schlick, "An Inexpensive BRDF Model for Physically-based Rendering", Computer Graphics Forum 13(3), 233-246, 1994.
  https://doi.org/10.1111/1467-8659.1330233 (grazing-angle rim of the glass plates).
- J. F. Blinn and M. E. Newell, "Texture and Reflection in Computer Generated Images", CACM 19(10), 542-547, 1976.
  https://doi.org/10.1145/360349.360353 (mirror facets reflecting a studio along the reflected view ray).
