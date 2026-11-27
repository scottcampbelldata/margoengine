# Mesh Booleans

Exhibit 46 of Margo Web Demos is a live triangle-mesh subtraction. A faceted lapis specimen and a tapered brass-colored cutter appear in a separated display pose. The cut uses the cutter at its registered orientation inside the stone.

Choose Pocket, Deep pocket or Through, then select Carve mesh. Once carved, changing the depth performs another subtraction. Inspect back reveals whether the passage opens on both sides. Show triangles draws every rendered triangle edge, including the new edges created by the cut. Show both inputs returns to the uncut meshes.

The lapis specimen, cutter, beveled display bed, incised rule, mineral veins and tool marks were authored for this exhibit and generated from source. The working scale is a decimeter per model unit and the rendered positions are in meters. The lighter palette inside the cut identifies new surfaces derived from the cutter. The veins extend continuously across the original and new surfaces.

## Geometry and evidence

The exhibit calls the public mesh-edit booleanMeshesExact function with the difference operation. Both closed inputs consist of triangles. The engine intersects their polygonal surfaces, matches half-edges and returns the trimmed polygon mesh with face provenance. We triangulate each resulting polygon with Margo’s ear clipping so the drawn triangles retain all split boundary corners. The wire view follows each actual rendered triangle using barycentric coordinates.

The edge readout counts undirected triangle edges whose orientations lack exactly one incidence in each direction. The removed-volume readout comes from subtracting the signed tetrahedral volumes of the original and carved meshes. Three tested fixture depths cover two blind cuts and a passage. The real cutter is an oblique twelve-sided mesh and its cross-section stays faceted in the result. The fixed fixture and three controls are the supported domain for this exhibit.

| Cut | Triangles | Unpaired edges | Removed volume | Euler characteristic |
| --- | ---: | ---: | ---: | ---: |
| Uncut | 200 | 0 | 0 cm³ | 2 |
| Pocket | 864 | 0 | 363 cm³ | 2 |
| Deep pocket | 894 | 0 | 683 cm³ | 2 |
| Through | 1,044 | 0 | 1,123 cm³ | 0 |

Independent QA intersects both meshes and verifies that removed and remaining volumes add back to the original. A test ray along the tool’s central line meets a rear surface and a pocket floor in each blind cut. It passes through the first and second openings in the tunnel with zero surface hits. All displayed output triangles have consistently paired edges. The exact package rounds its final coordinates to float64 and folds features too thin to represent at that precision.

## Running and verification

The exhibit uses packages built from the verified public Margo revision 0efd9cff8230507a32deb49907ecd499d46925f5. The sole optional feature is mesh-edit with its boolean-exact and modeling entries. Margo Core’s FrameGraph renders the same geometry/materials on its native WebGPU and WebGL2 preview paths. The scene has no external runtime assets. First use computes each mesh and repeat selections reuse its result.

The local QA runner qa-output/mesh-booleans-check.mjs builds with MARGO_ENGINE_CHECKOUT pointing to that pinned checkout. It executes the three operations and verifies the exact values on the page, the first rendered touch, the front and rear views, triangle overlay and return to the inputs. The phone profile used Chrome at 390 × 844, fresh browser contexts, disabled cache, 150 ms latency, 1.6 Mbps and fourfold CPU throttling.

| Renderer | First usable frame | First rendered cut |
| --- | ---: | ---: |
| Phone WebGPU | 1.118 s | 1.697 s |
| Phone automatic WebGL2 | 0.992 s | 1.434 s |
| Phone forced WebGL2 | 0.954 s | 1.366 s |
| Desktop WebGPU | 0.275 s | 0.409 s |

Rendered image states and measurements are under qa-output/mesh-booleans.

## References

- Qingnan Zhou, Eitan Grinspun, Denis Zorin and Alec Jacobson show why closed output and consistent classification matter for Boolean operations on triangle meshes. [Mesh Arrangements for Solid Geometry, SIGGRAPH 2016](https://www.cs.columbia.edu/cg/mesh-arrangements/).
- Marcel Campen and Leif Kobbelt describe exact polygon intersection and topology changes at cut surfaces. [Exact and Robust (Self-)Intersections for Polygonal Meshes, Eurographics 2010](https://doi.org/10.1111/j.1467-8659.2009.01609.x).
- The Metropolitan Museum of Art documents a blue-striated carved vessel with distinct marks from interior hand finishing and a polished outer surface. [Marble vase with lug handles](https://www.metmuseum.org/art/collection/search/855250).
- The Met’s hardstone exhibition documents lapis lazuli alongside gilded metal, the material direction for the original digital specimen and cutter. [Art of the Royal Court, Pietre Dure](https://www.metmuseum.org/exhibitions/listings/2008/pietre-dure/photo-gallery).
