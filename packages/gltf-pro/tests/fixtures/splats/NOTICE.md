# Gaussian splat fixtures

Used only by the tests; not part of the published package (`files` is `dist`).

| File | Source | Licence |
| --- | --- | --- |
| `sh_unit_cube.glb` | CesiumJS, `Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/0/0.glb` (https://github.com/CesiumGS/cesium), 27 splats with SH degree 3 in a `KHR_gaussian_splatting_compression_spz_2` payload. sha256 `55b3e768cc81164c5415da918b16954ab4600cf8116f5a94906c0acef3ea15b9` | Apache-2.0, Copyright Cesium GS, Inc. |
| `minimal_point.gltf`, `minimal_point.bin` | luma.gl, `examples/showcase/gaussian-splats/fixtures/godot-minimal/` (https://github.com/visgl/luma.gl), one uncompressed splat written by the godot-gsplat sample | MIT, Copyright (c) 2026 KOGA Mitsuhiro |

The real capture `tower/0/0.glb` from the same CesiumJS folder (286,868 splats, 7,499,156 bytes, sha256
`9ef9d8d0756d1f423cd6aa8bd99f7dd26957f96df03dcbcec6e37103e39350b4`) is too large to commit. The tests that read it say
so and pass over it when it is absent: set `MARGO_SPLAT_SAMPLES` to a folder holding it as `tower.glb`.
