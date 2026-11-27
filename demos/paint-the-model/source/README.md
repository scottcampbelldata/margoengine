# Paint the Model

A studio turntable for the original Kestrel display helmet. The outer shell, shaped visor, recessed neck seal, anodised pivots, intake lips, and the graphite plinth are authored meshes. The factory burnt-orange and ivory livery is drawn into a 512 × 256 straight-alpha sRGB albedo map. All work stays in the page.

Paint the enamel by tapping or dragging over it. Choose one of five pigments, change the brush diameter in atlas pixels, or turn the view around the shell. The eraser lifts applied pigment to the factory color beneath it. Undo includes reset and keeps up to 12 steps. For keyboard painting, focus the model, aim with arrows, and press Space. Hold Shift to move the aim farther.

Each pointer sample constructs a perspective ray from the actual Margo camera. The nearest intersected triangle decides whether the brush may paint. For a shell hit, the intersection's barycentric weights interpolate the same UVs that the renderer uses. The brush blends the albedo pixels and wraps the texture across the rear UV seam. Gaps in a stroke break interpolation. Brush diameter is measured in texels and its world size varies with the model's UV scale.

The page uses the public `Texture` from `@margoengine/materials/texture`. Each draw calls `Texture.update({x,y,width,height})` for the dirty rectangle and samples that same uploaded texture in a Margo frame pass. Undo and restore may re-upload the whole atlas. The studio shader supplies an approximate enamel, glass and metal finish with directional reflection patches. Paint changes albedo while retaining reflections. Higher-level optical properties are outside this painting tool.

Native WebGPU is preferred. The full Margo WebGL2 compatibility layer runs the same meshes, camera, brush, texture and lighting. Append `?backend=webgl2` to select it. In-engine layout fits each screen.

## References

- Pat Hanrahan and Paul Haeberli. *Direct WYSIWYG Painting and Texturing on 3D Shapes*. SIGGRAPH, 1990. Direct interaction with the surface representation. [Paper](https://people.csail.mit.edu/ericchan/bib/pdf/p215-hanrahan.pdf)
- Tomas Möller and Ben Trumbore. *Fast, Minimum Storage Ray–Triangle Intersection*. Journal of Graphics Tools, 1997. Nearest-hit barycentrics for UV interpolation. [Paper](https://doi.org/10.1080/10867651.1997.10487468)
- Khronos Group. *glTF 2.0 Specification*. sRGB encoding of base-color textures. [Specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
- Khronos Group. *PBR Neutral Tone Mapper*, 2024. Display roll-off used by the studio. [Specification](https://github.com/KhronosGroup/ToneMapping/tree/main/PBR_Neutral)
- Bell Racing. *GP3 Sport*. Reference for chin vent placement, visor seal and lateral pivots on a full-face shell. [Manufacturer's reference](https://www.bellracing.com/p/gp3-sport/)

The Kestrel, original livery, and all studio assets are built for this exhibit.
