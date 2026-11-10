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


## Lane E

Packages, in order: tiles, splats, ui, labels, html, selection, viewcube. Scope as lane D: each package's list 2 and 3
feat and fix commits from the evening of 2026-11-09 to 2026-11-10 (`--since=2026-11-10T00:00:00Z`).

| Package | Commit | File:line | Defect | Input and wrong output | Fix |
| --- | --- | --- | --- | --- | --- |
| tiles | b47fdef13 | packages/tiles/src/properties.ts:246 | Property-texture KHR_texture_transform used the transposed rotation (u' = c·u − s·v), not the sign gltf-pro renders with (checked there against Khronos TextureTransformTest/MultiTest), so metadata was read from a different texel than the one drawn | 2x2 texture (10,20/30,40), clamp, `{offset:[0,1], rotation:π/2}`, uv (0.75, 0.25): read 30, drawn texel 10. Fix: one shared affine (`src/uv-transform.ts`) | bf3a3bad7 |
| tiles | 81a6e2c1a | packages/tiles/src/features.ts:255 | Same transposed rotation in feature-ID texture picking | `{rotation:π/2, scale:[2,1]}`, uv (0.1, 0.3): picked (−0.3, 0.2), drawn (0.3, −0.2), so `resolve()` returned the wrong feature | bf3a3bad7 |
| tiles | 81a6e2c1a | packages/tiles/src/features.ts:456 | Highlight WGSL `offset + R*uv*scale` scales after rotating (WGSL `*` is left to right) and kept the wrong sign, so the GPU highlight lit a different feature from the CPU pick | same input: shader sampled (−0.6, 0.1), CPU (−0.3, 0.2). Fix: shader emits the shared affine rows | bf3a3bad7 |
| tiles | 81a6e2c1a | packages/tiles/src/features.ts:197 | FLOAT feature-ID attributes (allowed by EXT_mesh_features; legacy b3dm `_BATCHID` is commonly FLOAT) read as raw uint32 bits | FLOAT ids [0,1,2,3] gave [0, 1065353216, 1073741824, 1077936128]. Fix: decode 5126 as float, refuse non-integers | bf3a3bad7 |
| tiles | 81a6e2c1a | packages/tiles/src/features.ts:228 | Percent-encoded (RFC 2397) data: URI feature images went through `decodeURIComponent`, which reads bytes as UTF-8 | `data:image/png,%89PNG...` threw `URIError: URI malformed`. Fix: the byte-exact decoder from properties, moved to `src/data-uri.ts` | bf3a3bad7 |
| tiles | 3d0de41dc | packages/tiles/src/imagery.ts:614, terrain.ts:505 | EPSG:3857 quantized-mesh v was spaced evenly in Mercator Y; the quantized-mesh 1.0 format says v is a linear interpolation between the tile's south and north latitudes (the projection only sets the rectangle). The old test asserted the wrong reading and is replaced | root 3857 tile, vertex v=24000: latitude placed by Mercator spacing instead of `south + v/32767·(north − south)` (tile 1/0/1 at v=16383: 66.51° instead of 42.52°, about 2,670 km off). `meshB3dm`'s `latitudeAt` parameter is removed | bf3a3bad7 |
| tiles | | | Mac sweep | CPU 121 pass; browser 23 checks, 19 WGSL modules, 0 errors on Metal. No compat run (no `--compat` mode in tiles) | clean |
| splats | 04e3d930f | packages/splats/src/progressive.ts:263 | Progressive PLY decoded the header as UTF-8 and used the character index of `end_header` as the body's byte offset, so a multi-byte header comment shifted every record | `raccoon-v2.ply` with `comment exported by café` after `ply`: the stream read records 1 byte off (here "Splat attributes must be finite"; other data gives wrong splats silently) while `parsePly` was right. Fix: decode the header as latin1 (one char per byte), as `parsePly` does | this commit |
| splats | 04e3d930f | packages/splats/test/progressive.test.js:39 | Mac sweep: "stream raccoon-v2.spz ... emits before EOF" failed on Node 26 (Mac). Its source yielded every packet at once and Node 26's DecompressionStream accepts about 139 KB of gzip input before its first output, so the whole 207 KB file was consumed before any batch; the reader itself emits at 98 KB of 207 KB when packets arrive a turn apart. Fix: the test's packets arrive one macrotask apart (the property tested is unchanged) | 207,217 of 207,217 bytes consumed before the first batch | this commit |
| splats | 0e4d61631, 192bff291, f4f1aa88b, f22e9404c | | none found | Round trips checked: `encodePly` binary/ASCII at SH 0-4, SOG v2/v3, progressive PLY/SPZ at 1, 3, 17 and 4096-byte chunks, abort with stalled sources. Mac sweep: CPU 118, `test:gpu`, formats (WebGPU and `--compat`), lod-sog, modify all pass on Metal | |
