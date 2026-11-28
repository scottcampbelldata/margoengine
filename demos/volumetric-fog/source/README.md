# Volumetric Fog

The view follows a wet trail through an original cedar and fern grove. Use **Local fog** to vary the extinction of four banks of mist while keeping the surrounding haze and sun fixed. Use **Forward scattering** to compare nearly isotropic scattering at 0 with directional scattering toward the sun at 0.63.

The fixed 92 × 56 × 40 camera-space froxel grid covers the first 56 metres. Margo samples local boxes and spheres with soft boundaries and density variation, applies the shadow of the forest canopy and trunks to the directional sunlight, integrates the medium along each viewing ray and composites it against the scene depth. The readout is the peak extinction coefficient of the densest individual bank in inverse metres. Extinction adds where banks overlap. Zero local fog still leaves the thin, height-dependent background haze.

The mist distribution and light levels are authored for this demonstration. Rendering uses Margo's single-scattering model, with analytic height fog beyond the grid. The trees and terrain do not change between browser renderers. The same volume and geometry settings run on desktop and phone. The only viewport-dependent changes are camera framing and the pixel ratio cap applied to all displays.

The scene uses Margo Environment's VolumetricFog and FogVolumes, with Margo Shadows supplying the real canopy occlusion and Tonemap supplying scene depth and a fixed AgX display transform. The engine tries native WebGPU first, then the Margo WebGL2 compatibility layer. Fog draws through the compatibility layer when the browser provides the needed render-target capabilities. Public engine commit `0efd9cff8230507a32deb49907ecd499d46925f5`.

## References

- Sébastien Hillaire, [*Towards Unified and Physically-Based Volumetric Lighting in Frostbite*](https://advances.realtimerendering.com/s2015/), SIGGRAPH, 2015.
- Bartłomiej Wroński, [*Volumetric Fog and Lighting*](https://www.advances.realtimerendering.com/s2014/wronski/bwronski_volumetric_fog_siggraph2014.pdf), SIGGRAPH, 2014.
- Louis G. Henyey and Jesse L. Greenstein, [*Diffuse Radiation in the Galaxy*](https://doi.org/10.1086/144246), The Astrophysical Journal, 1941.
- U.S. National Park Service, [*Visiting the Hoh Rain Forest*](https://home.nps.gov/olym/planyourvisit/visiting-the-hoh.htm). Reference for the grove, ferns and fallen nurse log. The scene geometry is original.
