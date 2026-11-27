# The Shader Node Editor

An original sculpted vessel and a curved glaze sample show the output of a live material graph. Their model, glaze, plinth and lighting are rendered in Margo Engine on WebGPU and its WebGL2 compatibility layer. The geometry takes inspiration from luminous blue-green Longquan glaze and has an original profile, fluted body and folded rim.

## Working with the graph

**Surface roughness** edits the Number node wired to the roughness output. The control follows the current connection, so it also edits a Number you add and wire there. A computed roughness output is edited in the node graph. **Orbit preview** moves the camera without changing the material. Select **Add node** to open the packaged palette. Connect sockets by dragging between them or by tapping the output then the input. **Fit** frames the visible nodes, **Arrange** lays them out again and **Undo** restores the previous edit. **Reset graph** restores the authored glaze.

The initial color is the mix of two editable linear RGB colors. Absolute sine of the dot product between local position and a vector controls that mix. The vector sets the spacing and orientation of the ribs of color. A separate Number sets roughness.

The exhibit uses the pinned Margo `NodeEditor` and its actual typed `GraphModel` for node creation, movement, wires, constants, and validation. Every valid material edit compiles through `createGraphMaterial` and updates the same live material on both meshes. **Generated WGSL** shows the compiler’s real `fragmentCode` surface statements. An incomplete or ill-typed graph leaves the last rendered valid material and WGSL visible, so edits can continue. Detached nodes remain editable and are pruned from the emitted shader until connected.

The material preview uses a small procedural cube of studio lights with precomputed linear-light mipmaps. It shows the reflectance change over a fixed exposure. The glaze is a material study with a procedural color pattern.

## References

- World Wide Web Consortium, [WebGPU Shading Language](https://www.w3.org/TR/WGSL/). Shader syntax and types.
- The Academy Software Foundation, [MaterialX specification](https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/MaterialX.Specification.md). Typed material graphs and connected inputs.
- Brent Burley, [Physically Based Shading at Disney](https://www.disneyanimation.com/publications/physically-based-shading-at-disney/), 2012. Roughness and appearance in a physically based material.
- The Metropolitan Museum of Art, [Longquan bottle vase](https://www.metmuseum.org/art/collection/search/51050), and Smithsonian National Museum of Asian Art, [Longquan vase or bottle](https://asia.si.edu/explore-art-culture/collections/search/edanmdm%3Afsg_F1946.25/). Glaze and finish references for the original digital exhibit.
- [The Margo Shader visual editor at the verified public commit](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/shader#visual-editor-margoengineshadereditor). Portable graph operations, validation and editor controls.
