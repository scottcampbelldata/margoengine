# The Baked Room

A small plaster gallery holds a group of ceramics and an oak bench. Its window fins cast a pattern on the floor. **Start live bake** replaces the labeled opening reference with newly computed light. Each pass adds one sampled path per covered lightmap texel. **Denoise** runs Margo's edge-aware filter on the displayed bake. Press it again to compare the unfiltered version.

## Lighting and rendering

All 2,930 triangles and the 210 non-overlapping lightmap charts are authored here. One 256 × 192 linear irradiance atlas is mapped onto those charts in a live Margo render. The surfaces apply their individual RGB albedo with Lambertian response, fixed exposure and PBR Neutral display conversion. The bake uses an ambient term, directional sunlight, two diffuse bounces and an authored uniform reflectance for indirect hits. This is a diffuse lighting study.

The opening atlas is a two-pass result from the pinned Margo GPULightmapBaker. It was generated from the scene in this folder with the same lights, geometry and atlas. The asset stores its encoded linear RGB and triangle IDs, so the opening Denoise button filters real baked samples. The stock baker reported 13,820 covered texels with zero overlapping and zero degenerate UV triangles.

The first live preview ray traces the entire room on the GPU, using a compact depth-first traversal of a Margo-built triangle BVH and cosine-weighted diffuse paths. It presents its actual running mean at 1, 2, 4, 8 and 16 passes. The stock lightmap baker then runs in a background worker and presents its independent estimate at 24, 40 and 64 passes. Both sample the same diffuse model with separate random sequences. The worker keeps the displayed preview and filter available while the stock shader initializes. On the tested WebGL2 path, the stock shader took longer than the first live pass and preview. The atlas, geometry, preview and stock work are the same on phone and desktop.

Margo WebGPU opens first, with a full Margo WebGL2 route wherever the required floating targets and shader storage are available. Pinned public engine commit `0efd9cff8230507a32deb49907ecd499d46925f5`.

## References

- James T. Kajiya, [*The Rendering Equation*](https://doi.org/10.1145/15886.15902), SIGGRAPH, 1986.
- Brian Smits, [*Efficiency Issues for Ray Tracing*](https://doi.org/10.1080/10867651.1998.10487488), Journal of Graphics Tools, 1998.
- Tomas Möller and Ben Trumbore, [*Fast, Minimum Storage Ray-Triangle Intersection*](https://doi.org/10.1080/10867651.1997.10487468), Journal of Graphics Tools, 1997.
- Holger Dammertz, Daniel Sewtz, Johannes Hanika and Hendrik P. A. Lensch, [*Edge-Avoiding À-Trous Wavelet Transform for Fast Global Illumination Filtering*](https://diglib.cgv.tugraz.at/items/89ef8071-636b-407c-b56c-2e2ab391bf0a), HPG, 2010.
- [Khronos PBR Neutral tone mapper](https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/README.md).
- [Kimbell Art Museum, Louis I. Kahn Building](https://kimbellart.org/art-architecture/architecture/kahn-building), reference for daylight and material restraint. The room and objects here are original.
