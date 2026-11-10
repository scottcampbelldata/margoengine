# Finish later

Build phase (Scott, 2026-11-10): what a job left unfinished, one line each, `| <batch.job> | <package> | <what is left> |`.

| Job | Package | What is left |
| --- | --- | --- |
| 54.6 | lightmap | directional lightmaps: a WGSL apply path (decode the direction and directional maps, evaluate with the mapped and vertex normals) belongs with the draw-time apply entry (54.3); only the CPU reference `directionalIrradiance` exists |
| 54.6 | lightmap | directional lightmaps: an SH (L1) or H-basis option per texel for several strong lights; Habel and Wimmer 2010 (H-basis) still to read |
| 54.6 | lightmap | directional lightmaps: directional ambient (bent normal from the AO rays) and bounce light with a direction; quads (`bakeLightmap`) have no directional mode |
| 54.6 | lightmap | directional lightmaps: proven on stand-in meshes only, no real glTF file with a normal map baked |
| 52.3 | @margoengine/clustered | Shadows from sphere, disc and tube lights (LocalShadows has no shaped-light faces yet). |
| 52.3 | @margoengine/clustered | GPU timing of ShapeLights per light and a picture check against a rival's sphere and tube lights. |
| 52.3 | @margoengine/clustered | Cluster culling or a range for shaped lights (every fragment evaluates all 64 today). |
| 54.7 | lightmap | probes: load the baked SH into `@margoengine/environment/probes` `LightProbes` (it bakes its own on the GPU and has no import path), so draws use them on the GPU |
| 54.7 | lightmap | probes: Chebyshev visibility per probe against leaks through thin walls, as the environment volume has; windowing (Sloan 2008) against SH ringing |
| 54.7 | lightmap | probes: emissive surfaces, area lights and quad bakes (`bakeLightmap` atlases) as bounce sources; several rooms per bake |
| 54.7 | lightmap | probes: Greger et al. 1998 (The Irradiance Volume) still to read in full |
