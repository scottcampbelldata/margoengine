# Finish later

Build phase (Scott, 2026-11-10): what a job left unfinished, one line each, `| <batch.job> | <package> | <what is left> |`.

| Job | Package | What is left |
| --- | --- | --- |
| 54.6 | lightmap | directional lightmaps: a WGSL apply path (decode the direction and directional maps, evaluate with the mapped and vertex normals) belongs with the draw-time apply entry (54.3); only the CPU reference `directionalIrradiance` exists |
| 54.6 | lightmap | directional lightmaps: an SH (L1) or H-basis option per texel for several strong lights; Habel and Wimmer 2010 (H-basis) still to read |
| 54.6 | lightmap | directional lightmaps: directional ambient (bent normal from the AO rays) and bounce light with a direction; quads (`bakeLightmap`) have no directional mode |
| 54.6 | lightmap | directional lightmaps: proven on stand-in meshes only, no real glTF file with a normal map baked |
