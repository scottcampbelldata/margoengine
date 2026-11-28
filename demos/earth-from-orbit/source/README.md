# Earth From Orbit

Scrub one UTC day to move the Sun across the globe, or pick another UTC date to see the subsolar point and the shape of the day and night boundary change with the seasons. Drag to orbit (arrow keys pan the orbit when the canvas has focus); Reset view returns to 28° S, 66° W. The readout gives the place where the Sun is straight overhead, and the caption gives the place under the camera.

## Model

The world is fixed to the Earth: north is +Y, Greenwich is +X and east is −Z. `subsolarPoint` from `@margoengine/sky/astro` gives the latitude (the Sun's apparent declination) and the longitude (its right ascension less the apparent Greenwich sidereal time). The Sun's direction for the globe comes from `sunPosition` for an observer on the north pole at 90° W, whose horizon frame is the globe's frame, so the same astronomy places the light, the stars and the Milky Way. UTC stands in for UT1. The globe is `Planet` from `@margoengine/creative/planet`: the day map lit by the Sun, city lights fading in across twilight, ocean glint from the specular mask, a cloud shell above the surface and a rim glow.

The stars are the Yale Bright Star Catalogue drawn by `AstroSky` and the band is `MilkyWay`, both with `horizon: false`, the view from space: the whole sphere with no refraction or extinction. The band is a photometric model (Mellinger 2009), not a photograph, and is drawn brighter than the eye would see it beside a sunlit Earth. Light goes through bloom (`@margoengine/post/bloom`) and AgX tone mapping (`@margoengine/tonemap`). WebGPU first, with the WebGL2 compatibility layer when WebGPU is missing; `?backend=webgl2` forces it.

## Sources and credits

- **Day imagery**: NASA Earth Observatory, *Blue Marble: Next Generation, Base Map*, July 2004 composite, encoded as WebP. [NASA Earth Observatory](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/).
- **Night lights, clouds and ocean mask**: Solar System Scope (INOVE), *Solar System Scope Textures*, Earth maps, CC BY 4.0, repacked as WebP (cloud luma in one channel; ocean mask in red, roughness in green). [Textures](https://www.solarsystemscope.com/textures/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **Stars**: Dorrit Hoffleit and W. H. Warren Jr., *The Bright Star Catalogue, 5th Revised Ed.*, 1991, CDS V/50, cut to magnitude 5.6. [CDS V/50](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50).
- **Milky Way model**: Axel Mellinger, *A Color All-Sky Panorama Image of the Milky Way*, PASP 121, 2009. [arXiv:0908.4360](https://arxiv.org/abs/0908.4360).
- **Solar coordinates**: Jean Meeus, *Astronomical Algorithms*, 2nd ed., 1998, chapters 12 and 25; checked against the [USNO approximate solar coordinates](https://aa.usno.navy.mil/faq/sun_approx).

`source/scene.js` holds only the wiring. Rebuild with `node scripts/web-demos/build.mjs earth-from-orbit`.
