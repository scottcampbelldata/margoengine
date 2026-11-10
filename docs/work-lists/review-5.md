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
| weather | 95b63e3e8 | packages/weather/src/lens.ts:85, :175 | LensDrops uploaded time and speed and the shader formed y - time*speed in f32, so the falling layer lost precision as the pattern clock grew | `lens_field` with the uploaded settings at time 1000000 (documented range 0..1000000 s), wetness 1: GPU vs `lensField` worst error 1.0 over 2400 cases (drops jump in 1/128 image-height steps; about 1 px jitter after a day of clock). Fix: `lensSettings` splits the travel in f64 into whole cells (u32 in b.w) and a sub-cell remainder; worst error 5.1e-5 on WebGPU and the WebGL2 layer | this commit |
| weather | 4387ce46d, 692d2d3dc, 4fb0532ec, 50581d1a1 | | none found | Mac sweep clean: CPU 77; browser-check; gltf, cover and lens parity on WebGPU and `--compat` | |
