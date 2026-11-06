# GPU transcode fixtures

Real files written by Khronos KTX-Software 4.4.2 (`ktx create`, run outside this repository), from the `alpha_triangles`
sample of libjxl's conformance suite (https://github.com/libjxl/conformance, BSD-3-Clause), as decoded by `djxl`.

- `alpha-uastc-zstd.ktx2` and `alpha-etc1s.ktx2`: 128 x 128 with alpha and mips, `--encode uastc --zstd 5` and `--encode basis-lz`.
- `odd-uastc-zstd.ktx2` and `odd-etc1s.ktx2`: 301 x 203, a size that is not a whole number of blocks, the same encoders.
