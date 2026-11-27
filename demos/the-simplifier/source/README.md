# The Simplifier

Night Herald is an original 1.8-metre limestone owl sculpted for the exhibit. Drag the detail control to inspect five genuine meshes. **Surface** smooths the shading and **Facets** gives each triangle its own normal. **Auto LOD** changes the geometry as the camera moves across distance thresholds. The triangle count is read from the geometry the engine is drawing.

Margo's isotropic remesher prepares the carved mesh and `@margoengine/lod/auto` builds the nested levels by quadric-error edge collapse. The four reduced meshes are generated ahead of time and reach the browser in a compact quantized packet. The browser uses `LODSystem` for the distance-based selection. The last level holds 736 of the original 14,958 triangles. The five meshes have closed, consistently oriented edges and nonzero triangle areas after packing. The visual differences come from the geometry and normals, with the same camera and studio lighting in both manual views.

## Reproduction

From the showcase root, set `MARGO_ENGINE_CHECKOUT` to the pinned public engine checkout and run `node src/the-simplifier/tools/prepare.mjs`. The tool uses Chromium WebGPU to build the actual Margo LOD chain and writes the level packet. The remesher and simplifier run during preparation. A live studio rig supplies the light and shadows to both phone and desktop.

## References

- Akio Doi and Akio Koide, *An Efficient Method of Triangulating Equi-Valued Surfaces by Using Tetrahedral Cells* (1991). [Paper](https://globals.ieice.org/en_transactions/information/10.1587/e74-d_1_214/_p).
- Mario Botsch and Leif Kobbelt, *A Remeshing Approach to Multiresolution Modeling* (2004). [Paper](https://doi.org/10.2312/SGP/SGP04/189-196).
- Michael Garland and Paul S. Heckbert, *Surface Simplification Using Quadric Error Metrics* (1997). [Paper](https://publications.ri.cmu.edu/surface-simplification-using-quadric-error-metrics).
- Metropolitan Museum of Art, *Stirrup-spout bottle with owl* and *Guardian Lion*. Reference for the silhouette of an owl and deliberate chisel relief in stone. [Owl](https://www.metmuseum.org/art/collection/search/309388), [Limestone carving](https://www.metmuseum.org/art/collection/search/49575).
