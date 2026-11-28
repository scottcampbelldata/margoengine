# Cloudscape

Fly from 455 m to the middle of a 940–3,340 m cumulus layer, then rise above its tops. The altitude slider follows the same continuous route between those stations. The coverage, sun shafts and moving ground shadows respond to the rendered three-dimensional cloud field. The flight option also advects the cloud field in the same direction as the simulated wind.

The archipelago is an original 19 km height field with smoothly interpolated pigments, slope and depth cues. It uses nine island forms with coherent terrain detail. There is a continuous sea surface around the tile. All scene lights and camera distances use meters.

Native WebGPU uses Margo Sky’s Preetham atmosphere, `VolumetricClouds`, `volumetricCloudShadows`, Margo Shadows, HDR Bloom, and depth-aware `LightShafts`. The native flight control opens on the working volume, then the shadow and shaft passes initialize. WebGL2 uses Margo’s direct FrameGraph preview device with an original compact GLSL volume, height field, and solar transmittance shader. It integrates live three-dimensional density, light visibility, depth ordering and in-scattering. Both devices give the same altitudes, route and controls. The cloud fine structure and scattering differ between the two render implementations.

## References

- Andrew Schneider and Nathan Vos, [The Real-time Volumetric Cloudscapes of Horizon Zero Dawn](https://advances.realtimerendering.com/s2015/), SIGGRAPH Advances in Real-Time Rendering, 2015. Layer height shaping, authored volume noise and ray sampling.
- Antoine Bouthors, Fabrice Neyret, and Sylvain Lefebvre, [Real-time Realistic Illumination and Shading of Stratiform Clouds](https://doi.org/10.2312/NPH/NPH06/041-050), Eurographics Workshop on Natural Phenomena, 2006. Incoming sunlight, cloud optical depth and ground illumination.
- Sébastien Hillaire, [Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite](https://blog.selfshadow.com/publications/s2016-shading-course/), SIGGRAPH 2016. Reference for separated volume integration and scene surfaces.
