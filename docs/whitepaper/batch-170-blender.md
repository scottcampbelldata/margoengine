# Batch 170 Blender export size (2026-11-10)

The same scene through Margo's Blender add-on (`.margo`) and Blender's bundled glTF exporter (glTF-Blender-IO, run as
a black box through `bpy.ops.export_scene.gltf`), Blender 5.3.0 Beta: a UV sphere of 256 segments by 128 rings, flat
shaded, one material, 10 objects sharing that one mesh (65,024 triangles, 32,514 Blender vertices).

| File | Bytes | gzip -9 | Vertices written | Bytes per vertex |
| --- | --- | --- | --- | --- |
| `.margo` (add-on, `bake_size=0`) | 11,227,568 | 2,910,714 | 130,560 | 80 |
| `.margo` after `compressMargoMeshopt` | 3,386,244 | 2,373,541 | 130,560 | 80 once decoded |
| `.glb` (glTF-Blender-IO) | 4,959,600 | 1,160,872 | 130,560 | 32 |

Both files hold one copy of the mesh for the 10 objects. Margo's file is 2.26 times the glTF file raw and 2.51 times
gzipped. This is an accepted difference in work, not a loss to hide.

## Cause

`.margo` stores the vertex layout the GPU draws from: 80 bytes per vertex, interleaved (position and normal each
padded to 16 bytes, a tangent with its sign, two UV sets and a colour), plus 32-bit indices. A mesh with a UV set or
colours always gets the full layout ([exporter.py](../../tools/blender-addon/exporter.py)). The loader hands views of the file's buffer straight to GPU
buffers, so loading copies and repacks no vertex data. glTF-Blender-IO writes only the attributes the mesh has
(position, normal and one UV set, 32 bytes per vertex) as separate accessors; a glTF loader reads each accessor and,
for an interleaved GPU layout, copies every vertex into it on load.

What Margo does extra: no vertex copy or repack at load. Trade-off: a larger download for meshes that lack tangents,
a second UV set or colours. Like for like (the same 80 bytes per vertex in both files) the vertex data would be the
same size; that row is below.

| Like for like | `.margo` | `.glb` |
| --- | --- | --- |
| Vertex bytes at 80 B per vertex, 130,560 vertices | 10,444,800 | 10,444,800 if glTF stored the same six attributes |
| Vertex bytes as each exporter writes them | 10,444,800 (80 B) | 4,177,920 (32 B) |

A compact `.margo` vertex layout (attributes trimmed or quantized at export, measured against glTF size) is listed in
[finish-later.md](../work-lists/finish-later.md); until it lands, `compressMargoMeshopt` is the smaller option.

Reproduce (outside this repository, Blender installed):
`blender --background --factory-startup --python engine-bench/batch-170/blender-compare.py -- <margo repo> <out dir>`
writes `counts.json`, `scene.margo` and `scene.glb`; gzip both at level 9 for the second column.

Research: Khronos *glTF 2.0 Specification* (accessed 2026-11-10), https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html ,
buffers, buffer views and accessors. glTF-Blender-IO ran only as a black box; its source was never read.
