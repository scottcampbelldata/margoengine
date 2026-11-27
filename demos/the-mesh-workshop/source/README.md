# The Mesh Workshop

An original polygon model of a ventilation housing sits on a tool fixture. Apply **Bevel**, **Knife**, **Subdivide**, **Dissolve** or **Bridge** to the corresponding component. The selected part’s gold lines follow its actual polygon edges. **Undo** restores each edit in reverse order.

| Tool | What changes |
| --- | --- |
| Bevel | Cuts back the housing's top front edge by 88 mm in each adjacent face and fills the strip. |
| Knife | Splits the access panel on a diagonal and inserts the new cut vertices into the adjacent edges. |
| Subdivide | Applies two Catmull–Clark steps to the side fairing. The engine splits nonplanar faces for its polygon model. |
| Dissolve | Removes a coplanar seam from the service cover and merges the two adjacent polygons. |
| Bridge | Adds two rows of faces between the offset 12-edge collars. The 24 original boundary edges become closed. |

The model uses editable polygon positions, faces and face-corner UVs. In the page each command calls the public Margo mesh editor and rebuilds its solid triangles and visible polygon edges. The scene uses an independent component for each tool, so any of the five edits can be performed first. Undo stores the original immutable polygon payload, including face IDs and per-corner UVs.

## Build and verification

The gallery uses the verified Margo Engine revision `0efd9cff8230507a32deb49907ecd499d46925f5`. The artifact is generated entirely by the source and needs no model or texture downloads. `workpiece.mjs` is the editable air housing. `fixture.js` builds the display fixture and draws the actual edge network. The same model and materials run in native WebGPU first and in Margo's full WebGL2 compatibility layer.

The Node regression `qa-output/the-mesh-workshop/topology.mjs` applies all five public modeling operations twice and compares their produced meshes. It checks finiteness, edge orientation and mesh boundaries. A full browser run in `qa-output/the-mesh-workshop/check.mjs` applies the five edits and verifies the totals at every rendered step. It reverses them and compares every restored polygon, vertex and UV byte for byte with the original serializable payload. The full sequence grows the workpiece from 51 to 262 faces and then returns to 51. A trusted first edit was visible at 1.091 s on mobile WebGPU, 1.594 s on forced WebGL2 and 1.661 s on automatic WebGL2. The tests used fresh 390 px Chrome contexts at 150 ms latency, 1.6 Mbps and fourfold CPU slowdown. The unthrottled desktop reached it at 0.291 s native and 0.149 s forced WebGL2. All five profiles completed the sequence without console errors. Samples and exact timings are in the same QA directory.

## References

- Edwin Catmull and Jim Clark. *Recursively Generated B-Spline Surfaces on Arbitrary Topological Meshes*, 1978. [Original paper](https://people.eecs.berkeley.edu/~sequin/CS284/PAPERS/CatmullClark_SDSurf.pdf)
- Blender Foundation. *BMesh* and *Knife*. Reviewed vertex, edge and face terminology and how the public tool describes a drawn cut. [Topology documentation](https://developer.blender.org/docs/features/objects/mesh/bmesh/), [Knife manual](https://docs.blender.org/manual/en/dev/modeling/meshes/editing/mesh/knife_topology_tool.html)
- Lindab. *Rectangular Product Overview*. Visual study of real sheet metal ventilation housings, rims and flanged transitions. The exhibit geometry and dimensions are original. [Manufacturer’s product guide](https://itsolution.lindab.com/lindabwebproductsdoc/pdf/documentation/ads/lindab/technical/productoverview_rectangular.pdf)
