# Voronoi Shatter Art

**Ecliptic** is an original twisted ceramic sculpture divided into 35 solid pieces. Drag **Separate cells** to see its cobalt and turquoise glaze give way to the amber cut faces. Move to the left endpoint to reassemble the ring, or use the right endpoint to inspect the full separation. The opening arrangement starts partway apart.

## Geometry and motion

The sculpture is a closed 112 × 24 tubular surface. Its centerline, changing elliptical cross-section and twist are authored for the exhibit. The public Margo `fractureMesh` API intersects that watertight sculpture with the 3D Voronoi cells of 35 fixed sites. Every cell contains the part of the original solid nearest its site. The amber faces use the clipping planes bisecting their sites and neighbors. Their grain and the glaze's color flow are procedural materials in the Margo render.

The slider seeks a Margo `Timeline` with smoothstep easing. The amount drives a rigid translation and small rotation of each piece around its site. At the left endpoint all piece transforms are the identity. The greatest full translation is approximately 1.007 m in the scene's coordinates. This is a reversible display of the cells with no fracture simulation, gravity, or collision response. Both renderers use the same geometry, stage and materials.

## Verification

From the showcase checkout set `MARGO_ENGINE_CHECKOUT` to the pinned build and run `node qa-output/voronoi-shatter-art/check.mjs`. Set `VORONOI_SHATTER_URL` to audit a hosted route. The test compares every rendered mesh vertex to the nearest of all sites, verifies the original versus summed piece volume, and checks the browser worker's cap count. It verifies trusted slider input through the GPU completion fence, motion against the actual easing formula, both endpoints, and visible canvas change. Different JS runtimes may triangulate a nearly coplanar cap differently while preserving volume and cell membership.

Phone tests use 390 × 844, DPR 2, 150 ms latency, 1.6 Mbps download and 4× CPU slowdown. Native WebGPU takes priority. Automatic and forced WebGL2 use the full compatibility layer.

## References

- Franz Aurenhammer (1991). *Voronoi Diagrams. A Survey of a Fundamental Geometric Data Structure*. [ACM Computing Surveys](https://doi.org/10.1145/116873.116880)
- Atsuyuki Okabe, Barry Boots, Kokichi Sugihara, and Sung Nok Chiu (2000). *Spatial Tessellations*. [Wiley](https://onlinelibrary.wiley.com/doi/book/10.1002/9780470317013)
- Naum Gabo (c. 1945–1946). *Linear Construction in Space No. 1*. The use of suspension and negative space informed the original staging. [Solomon R. Guggenheim Museum](https://www.guggenheim.org/artwork/1383)
- Margo Engine public revision `0efd9cff8230507a32deb49907ecd499d46925f5`. [Voronoi API notes](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/procedural/README.md#voronoi-and-fracture-margoengineproceduralvoronoi-48-kb-mingzip)
