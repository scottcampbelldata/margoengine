# Ray-Traced Shadows

Change the shadow method while holding the bronze grille, limestone receiver, camera, exposure and light elevation fixed. At 64 or 128 texels across the map, observe where thin shadows disappear or neighboring shadows join. Use 512 × 512 to see what added map resolution restores. Turn the light to see where those differences follow the same grille geometry.

Margo's directional shadow map uses percentage-closer filtering over a fixed scene volume. The ray setting uses Margo's ray-traced filter and a BVH of the same 10,826 caster triangles in world space. One visibility ray toward the directional light is evaluated at each lit receiver fragment. The directional source has zero angular size, so the rays show geometric hard shadows. The plate is the shadow receiver and the grille geometry is static. The lighting rig uses metres.

The gallery opens on the 128 × 128 map. Both modes share a single compiled receiver program. The map mode bypasses the ray contribution, and the ray mode unregisters the map casters so only the rays affect the plate. WebGPU is the preferred renderer, with Margo's WebGL2 compatibility layer when needed. Ray tracing requires the fragment-storage capability reported by Margo. Devices without it can use the shadow-map resolutions and turn the light.

Original scene, geometry and materials, rendered with public Margo Engine commit `0efd9cff8230507a32deb49907ecd499d46925f5`.

## References

- Lance Williams, [*Casting Curved Shadows on Curved Surfaces*](https://cg.informatik.uni-freiburg.de/intern/seminar/shadowMapping_1978_Williams.pdf), SIGGRAPH, 1978.
- William T. Reeves, David H. Salesin and Robert L. Cook, [*Rendering Antialiased Shadows with Depth Maps*](https://graphics.pixar.com/library/ShadowMaps/paper.pdf), SIGGRAPH, 1987.
- Turner Whitted, [*An Improved Illumination Model for Shaded Display*](https://doi.org/10.1145/358876.358882), Communications of the ACM, 1980.
- [Margo Engine shadows](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/shadows) and [BVH](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/bvh) packages.
