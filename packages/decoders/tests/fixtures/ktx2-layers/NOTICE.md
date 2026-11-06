# KTX2 cube map and array fixtures

Real files written by Khronos KTX-Software 4.4.2 (`ktx create`), used only by the tests.

`arraytex_7_mipmap_reference_u.ktx2` and `valid_R16G16B16A16_SFLOAT_CUBE_ARRAY_MIP.ktx2` are unmodified files of the
KTX-Software conformance suite, https://github.com/KhronosGroup/KTX-Software-CTS (`clitests/input/ktx2_sample` and
`clitests/input/ktx2`), Apache-2.0, copyright The Khronos Group Inc. and RasterGrid Kft.

The other six were made here with `ktx create` (`--encode uastc --zstd 5`, `--encode basis-lz`, `--zstd 5`, `--zlib 5`,
with `--cubemap`, `--layers` and `--generate-mipmap`) from mip levels of the suite's
`cubemap_goldengate_uastc_rdo4_zstd5_rd.ktx2` and `cubemap_yokohama_basis_rd.ktx2`, extracted with `ktx extract`.

`records.json` holds the SHA-256 of every image as `ktx extract --raw --all` wrote it (`scripts/ktx2-oracle.mjs`).
