# Review 5: correctness review of list 2 and 3 work

Batch R5 (work list 4). Each lane owns its section. A finding counts only with a concrete input and the wrong output,
confirmed by a failing test, and is fixed at the root with that regression test.

## Lane D

Packages, in order: sky, weather, biomes, road, procedural, audio, mixer, video. `git log --since=2026-11-10` alone
reads as "today at the current clock time" in git, so the scope is each package's list 2 and 3 feature and fix commits
that landed from the evening of 2026-11-09 to 2026-11-10.

| Package | Commit | File:line | Defect | Input and wrong output | Fix |
| --- | --- | --- | --- | --- | --- |
| sky | ec0428400, a88cfd4fe | | none found | Mac sweep clean (CPU 106; GPU browser, dither, features on WebGPU and the WebGL2 layer; planet) | |
| weather | 95b63e3e8 | packages/weather/src/lens.ts:85, :175 | LensDrops uploaded time and speed and the shader formed y - time*speed in f32, so the falling layer lost precision as the pattern clock grew | `lens_field` with the uploaded settings at time 1000000 (documented range 0..1000000 s), wetness 1: GPU vs `lensField` worst error 1.0 over 2400 cases (drops jump in 1/128 image-height steps; about 1 px jitter after a day of clock). Fix: `lensSettings` splits the travel in f64 into whole cells (u32 in b.w) and a sub-cell remainder; worst error 5.1e-5 on WebGPU and the WebGL2 layer | c9b0a86ba |
| weather | 4387ce46d, 692d2d3dc, 4fb0532ec, 50581d1a1 | | none found | Mac sweep clean: CPU 77; browser-check; gltf, cover and lens parity on WebGPU and `--compat` | |
| biomes | 32ccc0bb1, 2ab71bef2 | | none found | Mac sweep clean: CPU 478; browser, water, objects, shadows, flythrough, objects-frame, backend, backend-placement, prefetch, erosion browser | |
| road | b28e4c047 | packages/road/src/geojson.ts:197 | A GeoJSON T endpoint on another line's interior solved to a parameter a rounding error outside 0..1 (u = -1e-17) and was dropped, so the branch stayed unjoined | 200 seeded T junctions (branch starts on the trunk at 0.2..0.8 of its length): 1 in 3 gave 4 nodes and 2 roads instead of 3 roads sharing the junction node. Fix: snap parameters within 1 micrometre (the node key precision) of either end | 63f8570af |
| road | 1cd5069bd | packages/road/src/lanes.ts:86, :140 | Lanes and turn arrows were mirrored: offsets ran along (tz,-tx), the driver's left in Y-up right-handed axes, from -total/2, so lane 0 ("left to right") sat on the right and a 'left' arrow bent right; the original tests encoded the mirror | Road along +x, widths [3,4]: line 0 at z +3.5 (driver's right) and a left-turn arrow bending toward +z (the right). Fix: offsets descend from +total/2 and 'left' arrows bend to +lateral; the two lateral expectations are corrected | 63f8570af |
| road | bb024b8db | packages/road/src/structures.ts:70 | Doc only: TunnelOpening.boundary runs from the driver's right edge, not the left | doc corrected | 63f8570af |
| road | 0344e2b1d | | none found | Mac sweep clean: CPU 51; browser-check (WebGPU and compat) | |
| procedural | 0c689841e, 6ab64e777 | | none found | Mac sweep clean: CPU 117; poisson, textures, caves, tree-mesh and textures-pbr browser suites on WebGPU and WebGL2 (mip area filter checked by hand for NPOT 3, 5, 7 to 1, 2, 3) | |
