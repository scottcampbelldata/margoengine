# The Sculpting Clay

An interactive study in clay relief and surface transfer. This is exhibit 43 of the fixed Margo Web Demos brief.

Drag directly over the clay to make a stroke. Raise, Carve, and Smooth use these same controls with a diameter of 12–46% of the original ball. Focus the canvas and press Enter to dab the face of the clay that is pointing toward the camera. Turn the clay in 60° steps to reach the sides and back. Undo restores one stroke at a time. The Sculpt, Low poly, and Baked buttons keep the same camera and light direction for comparison.

The opening relief is an original model, with raised spiral lobes and shallow tool marks cut into a welded 6,240-triangle sphere. The 784-triangle target uses a separate sampling of the same underlying shape. Its spherical UVs split at the texture wrap and each cap has wedge-shaped islands. The clay, slotted wheel, brass trim, handles, closed stage, and material grain are generated from source. All scene lighting, drawing and picking are live.

## Surface transfer

Margo MeshSculptSession ray-picks the actual edited triangles and applies draw, inverted draw, or neighbor smoothing. A completed stroke groups its dabs into one undo step. The studio uploads the position and smooth-normal ranges reported by SculptDrawing.

The Bake worker receives the current high-resolution coordinates and shading normals. It runs Margo bakeSurfaceMaps to cast rays both directions along the low mesh’s smooth normals and transfer the nearest high-surface normal into each texel’s tangent frame. The ray limit is 0.33 scene units and the map is 256 × 128 pixels with five texels of padding. The low mesh used for both rendering and ray casting has the same explicit tangent frame and geometry. The texture stores green up and the download is the linear normal data in PNG form. The readout counts ray matches against covered UV texels. The standard result matches all 30,592 covered texels out of 32,768 total pixels, with the other pixels belonging to padding and UV gaps at the caps.

Normal transfer changes shading while keeping the low-resolution silhouette. Deep stacked strokes can move the high surface beyond the ray range. The count exposes any misses, which retain the low mesh’s normals. An edit invalidates the old result and requires a new bake. Vertex edits last for the current session.

## Renderer and verification

The exhibit uses public Margo main at 0efd9cff8230507a32deb49907ecd499d46925f5. Its only feature package is mesh-edit with the sculpt and bake entries. Margo’s core renderer and automatic WebGL2 preview draw the same artwork and share the material definition. Only the activated backend resources are initialized. The bake code and worker load on demand.

Pinned browser QA exercised trusted touch drags on mobile and mouse drag on desktop, undo, inverted carving, smoothing with a changed brush diameter, rotation, switching low and baked views, edited bake invalidation, and downloaded PNG. The reference dab moved 39 vertices with a peak displacement of 0.0460 scene units and restored the original geometry exactly on undo. Each browser produced the same normal map from the same sculpt state. The tested local browser used Chrome at 390 × 844, a disabled cache, 150 ms latency, 1.6 Mbps download, and fourfold CPU throttling.

| Renderer | First frame | First rendered stroke |
| --- | ---: | ---: |
| Phone WebGPU | 1.073 s | 1.198 s |
| Phone automatic WebGL2 | 1.212 s | 1.326 s |
| Phone forced WebGL2 | 1.064 s | 1.153 s |
| Desktop WebGPU | 0.354 s | 0.418 s |

The QA runner is qa-output/sculpting-clay-check.mjs with the built pinned checkout set in MARGO_ENGINE_CHECKOUT. It writes rendered captures, downloaded maps and per-browser proof under qa-output/sculpting-clay.

## References

- Jim Blinn describes the relationship between perturbed normals and illuminated surface appearance. [Simulation of Wrinkled Surfaces, 1978](https://www.microsoft.com/en-us/research/publication/simulation-of-wrinkled-surfaces/).
- Morten Mikkelsen discusses tangent-space normal representation and consistency between baker and renderer. [Simulation of Wrinkled Surfaces Revisited, 2008](https://page.mi.fu-berlin.de/block/htw-lehre/wise2012_2013/bel_und_rend/skripte/mikkelsen2008.pdf).
- Gabriel Taubin analyzes neighboring-vertex surface smoothing and its effects on detail. [A Signal Processing Approach to Fair Surface Design, SIGGRAPH 1995](https://doi.org/10.1145/218380.218473).
- The original spiral study draws on incised and curved pottery textures documented by the Metropolitan Museum of Art. [Terracotta frying pan, Early Cycladic II](https://www.metmuseum.org/art/collection/search/855301). The Victoria and Albert Museum’s working notes informed the mix of wet clay, turning, and hand tool finishes. [Richard Batterham, methods of making](https://www.vam.ac.uk/articles/richard-batterham-methods-of-making).
