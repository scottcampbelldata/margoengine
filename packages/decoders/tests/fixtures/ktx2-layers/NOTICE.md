# KTX2 cube map and array fixtures

Real files written by Khronos KTX-Software 4.4.2 (`ktx create`), used only by the tests.

`arraytex_7_mipmap_reference_u.ktx2` and `valid_R16G16B16A16_SFLOAT_CUBE_ARRAY_MIP.ktx2` are unmodified files of the
KTX-Software conformance suite, https://github.com/KhronosGroup/KTX-Software-CTS (`clitests/input/ktx2_sample` and
`clitests/input/ktx2`), Apache-2.0, copyright The Khronos Group Inc. and RasterGrid Kft.

The array file was downloaded again for the materials/mips proof from commit
`1815a621e92186114042aa38798b5162b7ed2520`, path
`clitests/input/ktx2_sample/arraytex_7_mipmap_reference_u.ktx2`: 9,928 bytes,
SHA-256 `fce87d983f3dfa995faf3df1d3dd60b1c8ba12cd52c1a6baccff20e905357fdb`,
identical to the tracked file. The repository's root LICENSE grants Apache-2.0.
Its KTXwriter is toktx v4.0; the seven layers each have five solid-colour mip levels.
The material proof splits those layers into 2D chains without changing texels.

The other six were made here with `ktx create` (`--encode uastc --zstd 5`, `--encode basis-lz`, `--zstd 5`, `--zlib 5`,
with `--cubemap`, `--layers` and `--generate-mipmap`) from mip levels of the suite's
`cubemap_goldengate_uastc_rdo4_zstd5_rd.ktx2` and `cubemap_yokohama_basis_rd.ktx2`, extracted with `ktx extract`.

`records.json` holds the SHA-256 of every image as `ktx extract --raw --all` wrote it (`scripts/ktx2-oracle.mjs`).
