# Parallax Walls

Look across red brick and a rounded limestone arch. **Relief** shifts the brick texture along the actual view ray through a height field. **Flat** moves that apparent depth to zero on the same flat brick mesh. **Joint depth** sets the effective recession range. At the deepest setting the midpoint brick face sits about 35 mm above its mortar. **Triplanar limestone** blends three world-axis projections by surface orientation. Unchecking it shows the object's deliberately simple two-dimensional coordinates so the stretching is easy to spot around the turn.

Two original continuously tileable masonry materials are built in workers. The normal slopes come from the same height data as the occlusion map. The brick ray uses sixteen ordered samples with an interpolated crossing. The limestone projects its color and normals on each axis and gives the most aligned axis more weight. The brick mesh keeps real silhouette and depth. The arch, its inner reveal and the rounded pier are modeled geometry.

Margo Materials supplies parallax occlusion and triplanar projection on both WebGPU and Margo's WebGL2 compatibility layer. The lamps and lintel are original geometry. This interactive exhibit holds the light direction steady to isolate changes due to the moving viewpoint.

## References

- Natalya Tatarchuk. *Dynamic Parallax Occlusion Mapping with Approximate Soft Shadows*, 2006. [Paper](https://doi.org/10.1145/1111411.1111423)
- Morten S. Mikkelsen. *Surface Gradient–Based Bump Mapping Framework*, 2020. [Paper](https://jcgt.org/published/0009/03/04/)
- Ryan Geiss. *Generating Complex Procedural Terrains Using the GPU*, 2007. [Triplanar projection discussion](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu)
