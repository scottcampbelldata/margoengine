# The Material Factory

Generate a repeatable finish for an original machined ring and flat witness coupon. Choose oxide, walnut or cut limestone. Change the detail, generate a new seed and sweep the directional light to read surface structure on flat and curved forms.

## Generated maps

Margo’s procedural PBR baker generates four linear RGBA8 textures at 256 × 256, with nine mip levels. Seed, repeat count, palette, detail, relief strength and roughness are the requested recipe. All three finishes use that public GPU baker. Limestone uses jittered cells with mortar and softly chipped edges. Oxide and walnut are procedural color and height fields.

The studio samples all four maps on the specimen. Albedo colors the base, the mipmapped tangent-space normal changes its shading, and the roughness map controls the surface highlight. The height field drives a one-sample view-dependent texture offset. The geometry retains its machined shape. The viewport-specific cylindrical and planar projections feed the generated maps to Margo’s standard PBR lighting and tone mapping. The witness and ring are real Margo meshes, alongside the machined fixture and its rendered contact shadows.

The four inspection thumbnails are read from mip level one of the active GPU textures. The color preview converts linear albedo for display, roughness and encoded normals show their stored channels, and height scales its quantized range to readable contrast.

## Opening and compatibility

The finished station opens with an unfinished specimen and accepts the first bake request while the GPU programs are preparing. The first chosen result appears when all four actual GPU maps have been generated. The opening seed is 37. Each Bake or Rebake press increments it, and an unattended opening generates seed 37.

Native WebGPU uses the rendering device. On the automatic or forced WebGL2 path, the public Margo compatibility adapter starts an offscreen baking device in parallel with the scene. All generated mip bytes are copied to the render device. A browser that declines the second adapter uses the render device for baking. Both renderers use the same geometry, recipes, maps and visual settings. Small floating-point differences can change some quantized normal or roughness values across GPUs.

Append `?backend=webgl2` to request compatibility. [Verified public Margo revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

## References

- Ken Perlin, *An Image Synthesizer*, SIGGRAPH 1985. [Procedural solid textures](https://doi.org/10.1145/325334.325247).
- Steven Worley, *A Cellular Texture Basis Function*, SIGGRAPH 1996. [Cellular texture model](https://doi.org/10.1145/237170.237267).
- The Khronos 3D Formats Working Group, *glTF 2.0 Specification*. [Linear roughness, tangent-space normals and metallic-roughness shading](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials).
- Margo Engine, *PBR material maps*, at the pinned revision. [Procedural package reference](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/procedural/README.md#pbr-material-maps-margoengineproceduraltextures-pbr).
