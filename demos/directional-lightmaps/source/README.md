# Directional Lightmaps

Switch between **Directional** and **Intensity only** on the same enamel panel. The bound lightmap's intensity stays fixed. In Directional, the slopes in the normal map can face toward or away from the stored light direction. Intensity only makes the same plate look flat. Both views use the same two-triangle face, camera, art and baked light values.

The original *Tide Register* frieze is a 1.78 m × 1.07 m nominal panel with a terraced headland, tidal currents and a punched disk. The procedural height field produces a 336 × 208 tangent-space normal map by measuring the surface derivatives in metres. Its independent enamel albedo has no baked shadows. Both textures appear in the same Margo glTF PBR material. The surrounding case, brass frame and lamp are rendered from original geometry. The case uses its own lighting view, and the plate has its live lights disabled.

## Bake

`author-lightmap.mjs` invokes Margo's `bakeDirectionalLightmap` for 1,440 texels on the panel's own UV1. One warm point source sits at the visible lamp position [−0.725, 0.890, 0.51] m. The other component is cool diffuse ambient. The bake stores scalar irradiance, the per-texel dominant direction and the directional colour. The comparison keeps one Margo `applyLightmap` binding. The directional control restores its saved directional multiplier. Intensity only sets that multiplier to zero while preserving the full scalar bake. The 8,910-byte archive stores the original bake textures and their numeric scales. A worker reconstructs the art textures before the first render and transfers the original image arrays to the renderer.

At the center texel the Margo CPU reference returns red-channel irradiance 2.458 at the plane normal, 5.093 on a slope toward the lamp and 0.530 on its opposite slope. The lamp and geometry stay fixed throughout the comparison. Both renderers use multi-sample anti-aliasing.

## Verification

Fresh-process cold phone emulation was 390 × 844 CSS pixels at 2× device scale, with 150 ms network latency, 1.6 Mbps download and 4× CPU throttling. The end mark follows the GPU fence for the image after a trusted touchscreen tap.

| Renderer | Navigation to first completed control |
| --- | ---: |
| Native WebGPU | 1.765 s |
| Automatic Margo WebGL2 | 2.481 s |
| Forced Margo WebGL2 | 2.667 s |

The desktop and phone browser test verified both modes and repeated the switch with Enter. Pixel analysis recorded 111,832 changed phone pixels and 103,669 changed desktop pixels at a four-level RGB threshold. The frame outside the plate stayed unchanged. Native and both compatibility renderers produced the same phone pixels, and returning to Intensity only reproduced the original frame. The previous hosted version measured 2.282 s native, 3.806 s automatic WebGL2 and 3.340 s forced WebGL2. The uploaded build needs its signed-out timing recheck. The only local browser warning was Chrome's Windows adapter power-preference notice.

From the showcase checkout, with `MARGO_ENGINE_CHECKOUT` set to the verified engine root:

```powershell
node src/directional-lightmaps/author-lightmap.mjs
node "$env:MARGO_ENGINE_CHECKOUT/scripts/run-with-timeout.mjs" --max=2 -- node qa-output/directional-lightmaps/check.mjs
python qa-output/directional-lightmaps/measure.py
```

## Sources

- Peter-Pike Sloan, *Stupid Spherical Harmonics (SH) Tricks* (GDC 2008), optimal linear light direction. [Paper](https://www.ppsloan.org/publications/StupidSH36.pdf)
- Jason Mitchell, Gary McTaggart and Chris Green, *Shading in Valve's Source Engine* (SIGGRAPH 2006), precedent for retaining baked directionality and evaluating a tangent-space normal at render time. Margo uses a dominant direction representation for this exhibit. [Course paper](https://cdn.akamai.steamstatic.com/apps/valve/2006/SIGGRAPH06_Course_ShadingInValvesSourceEngine.pdf)
- Khronos Group, *glTF 2.0 Specification*, tangent-space normal texture and handedness. [Specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
- Smithsonian American Art Museum, *North America Plate*, technical reference for patinated copper and repoussé tooling. [Collection record](https://collections.si.edu/search/detail/edanmdm%3Asaam_1998.113.3)
- Margo Engine `0efd9cff8230507a32deb49907ecd499d46925f5`. [Lightmap API and model limits](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/lightmap/README.md)
