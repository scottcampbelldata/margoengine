# Bounce Light

Brief 84. This original gallery places a pale limestone loop between terracotta and teal plaster walls. A cyan diffuser above the camera’s view sends light toward the floor and sculpture. The two views use the same room, materials and lighting. **Crop the walls** removes both colored side panels from the visible image while leaving their geometry and the diffuser in the room.

- **Direct** shows the fixed key and ambient fill. Margo’s post stack keeps the display response constant across the comparison.
- **Screen space** uses the Margo `SSGI` effect with ten cosine-weighted rays per pixel. It estimates a single diffuse bounce by marching the current frame’s hierarchical depth and sampling nearby visible lit surfaces. Surfaces outside the frame, hidden by other objects, or facing away limit those samples.
- **Ray traced** uses Margo’s `RTGI` effect with the same sampling controls. It first asks the same screen-space pass. Where that pass misses, it traverses a GPU BVH built from the actual room meshes and shades the first hit with its material, direct light, ambient and emission. The cropped picture retains colored transport from the diffuser, even though that color is absent from the screen-space samples.

The active camera and selected result are live. Native WebGPU uses Margo RTGI for the geometric misses. Margo’s WebGL2 route uses the SSGITrace extension from the pinned Margo Post package with a single, flattened BVH over the same rendered room triangles. The BVH uses an escape index at each node and the renderer traces the closest triangle on a miss, reads the material and emitter, and traces a separate visibility ray toward the key light. The two routes share the ray count, image march, diffuse and microfacet shading, distance fade, bilateral filter and final composite. Flattening the room geometry avoids the general two-level accelerator’s shader compilation time on the browser’s WebGL2 driver. A device lacking the required HDR targets or fragment storage shows the applicable capability message.

The gain, colors and light fixture are art-directed for a readable single-bounce comparison. Screen pixels and BVH hits are estimated with finite rays and denoised by the same Margo filters. The room geometry, sculpture, and surface palette are original.

## References

- Cindy M. Goral, Kenneth E. Torrance, Donald P. Greenberg and Bennett Battaile, [Modeling the Interaction of Light Between Diffuse Surfaces](https://www.graphics.cornell.edu/~westin/consortium-home/goral.pdf), SIGGRAPH 1984. Diffuse interreflection and the appearance of color bleeding.
- Morgan McGuire and Michael Mara, [Efficient GPU Screen-Space Ray Tracing](https://jcgt.org/published/0003/04/04/), JCGT 2014. Ray marching a view-dependent depth representation.
- Colin Barré-Brisebois et al., [Hybrid Rendering for Real-Time Ray Tracing](https://link.springer.com/chapter/10.1007/978-1-4842-4427-2_25), Ray Tracing Gems 2019. Combining the image-space answer and geometric rays.
- Christoph Schied et al., [Spatiotemporal Variance-Guided Filtering](https://research.nvidia.com/labs/rtr/publication/schied2017spatiotemporal/), HPG 2017. Reference for the visual limits of low ray counts. This exhibit uses Margo’s bilateral filters.
- Barragán Foundation, [Gilardi House](https://barragan-foundation.net/works/list/gilardi-house). Architectural reference for colored plaster, neutral material and directional light. No photographs, models or plans are reused.
- Tomas Möller and Ben Trumbore, [Fast, Minimum Storage Ray-Triangle Intersection](https://www.tandfonline.com/doi/abs/10.1080/10867651.1997.10487468), 1997. Triangle hits on the compact route.
- Timo Aila and Samuli Laine, [Understanding the Efficiency of Ray Traversal on GPUs](https://research.nvidia.com/publication/2009-08_understanding-efficiency-ray-traversal-gpus), HPG 2009. GPU acceleration structure design and costs.
- Bruce Walter, Stephen R. Marschner, Hongsong Li and Kenneth E. Torrance, [Microfacet Models for Refraction through Rough Surfaces](https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.html), EGSR 2007. Microfacet evaluation at secondary hits.
- [Margo Post package at the exact public engine pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/post#screen-space-global-illumination-ssgi). The exhibit uses its published SSGI and RTGI effects.
