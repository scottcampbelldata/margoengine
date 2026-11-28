# The Terrain Sculptor

A 2,048 × 2,048 metre synthetic volcanic basin with seven camera-centred geometry clipmap levels. Basalt, moss, iron ochre, and ash each have original colour, normal and surface maps with full mip chains. A rock-lined lava-tube shaft sits below a surveyed opening.

- **Raise, Lower, Smooth, Paint ochre.** Brush a point on the actual terrain. A perspective ray from the Margo camera meets the `TerrainQuery` heightfield, and native `TerrainSculpt` dispatches the height or weight brush over that region. The edited heightmap feeds the clipmap directly. Paint updates layer weights while preserving geometry. Undo and redo restore each completed stroke's data. On a keyboard, focus the view, aim with the arrows and press Space.
- **Cut cave.** A `TerrainHoles` polygon updates the terrain's mask and the CPU query sees the same opening. The survey camera reveals a modeled rock liner and a lit cavity underneath it. Inspect shaft moves the camera over the opening. Fill restores the original top surface over the shaft.
- **Terrain layers, PBR layers, Virtual texture.** All three modes draw the same current terrain. PBR layers use Margo's triplanar normals, ambient occlusion, roughness and height blending. Virtual texture uses a camera-centred Margo colour cache. The mode selector chooses the active surface path. Its actual cache work count is shown below the controls.

The height and weight maps, geology meshes, and every material mip are prepared once in a worker. The height and weight maps are 513 × 513. The hole mask has 2 m cells. The RVT uses five 256² levels beginning at 0.78 m per texel. Brush edits invalidate their world-space neighbourhood in the active cache. The survey slider moves the camera and its cache windows.

The same terrain bounds, layers, caves, clipmap resolution, and tools run on phone and desktop. WebGPU is preferred and the full Margo WebGL2 compatibility layer runs the same pinned terrain packages. Append `?backend=webgl2` to choose it.

## References

- Frank Losasso and Hugues Hoppe. *Geometry Clipmaps: Terrain Rendering Using Nested Regular Grids*. SIGGRAPH, 2004. [Paper](https://icg.gwu.edu/sites/g/files/zaxdzs6126/files/downloads/geomclipmap.pdf)
- Christopher C. Tanner, Christopher J. Migdal and Michael T. Jones. *The Clipmap: A Virtual Mipmap*. SIGGRAPH, 1998. [Paper](https://doi.org/10.1145/280814.280855)
- Morten S. Mikkelsen. *Surface Gradient–Based Bump Mapping Framework*. Journal of Computer Graphics Techniques, 2020. [Paper](https://jcgt.org/published/0009/03/04/)
- Jeffery Judd, U.S. Geological Survey Volcano Hazards Program. *Skylight in lava tube carrying lava from ‘Alae crater onto to Kīlauea's south flank*, 1970. Visual reference for an irregular basalt opening. [Collection record](https://www.usgs.gov/media/images/skylight-lava-tube-carrying-lava-alae-crater-kilau)

The landscape, shaft, and surface maps are original and synthetic.
