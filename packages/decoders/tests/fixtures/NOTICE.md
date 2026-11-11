# Test fixtures

Fixtures are used only by the tests and are not part of the published package (`files` is `dist`).

- `Box.gltf`, `Box.bin`, `Avocado.gltf` and `Avocado.bin` are the Draco-compressed (`glTF-Draco`) versions of the
  Khronos glTF sample models Box and Avocado, https://github.com/KhronosGroup/glTF-Sample-Assets. Box: Cesium,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode). Avocado: Microsoft,
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode).
- `AnisotropyBarnLamp_normalbump.ktx2` is a texture of the Khronos sample model AnisotropyBarnLamp (same repository):
  (c) 2023 Wayfair, model and textures by Eric Chadwick,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode).
- `Dot_C.ktx2` and `Rib_N.ktx2`: see `KTX2-README.md`.
- `webp/` and `bc/`: see `webp/NOTICE.md`.
- `ktx2-layers/`: see `ktx2-layers/NOTICE.md`.
- `ktx2-hdr/`: see `ktx2-hdr/NOTICE.md`.
- `NormalizedTriangle.gltf` and `NormalizedTriangle.bin` are Margo-made by `../generate-normalized-fixture.mjs` (one
  triangle encoded with the Draco 1.5.7 encoder); they contain no third-party data.

## Exact README streams

`readme/avocado.drc` and `readme/cube-positions.bin` contain unmodified compressed
bufferViews, extracted without decoding or encoding by
`node packages/decoders/scripts/make-readme-streams.mjs`.
Fresh source downloads on 2026-11-09 match the existing source buffers byte for byte.
Both come from Khronos glTF-Sample-Assets revision
`8f492390ddc7a2ae221a1369ef560589cf8c70fb`:

- [Avocado](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/Avocado/glTF-Draco):
  Microsoft, CC0 1.0, grant in the model README. Avocado.bin SHA-256
  `535123a66a19c0427298d0bbe81b0ba5efa6d8155b7c659e11c23d8c6d6fe2c6`.
  BufferView 0: offset 0, length 8,722, POSITION=3, NORMAL=1, TEXCOORD_0=0 (TANGENT=2).
  Extract SHA-256 `21dfb8f305c178834bc4d860388bfffe6bc26fc66847a476306e4127c38179f5`.
- [MeshoptCubeTest](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/MeshoptCubeTest/glTF):
  Arseny Kapoulkine, CC0 1.0, grant in the model README. MeshoptCubeTest.bin SHA-256
  `6578c1d82c5cc2b228e9513e37f348ca89cdb24b5985aa0567efef8d3c014360`.
  BufferView 25: compressed buffer 0, offset 3,500, length 97, count 24,
  stride 12, ATTRIBUTES/NONE. Extract SHA-256
  `a68a0aff67b80b4b3d554dfcb25c3672b88dd405fac553f467a41219663ad64e`.
  Decoded 288-byte SHA-256 `4f55b0060bc60fea4d2de088c4ca2dd42afacb368947df7112e1776c72601021`,
  independently recorded in meshopt-views.json by the existing outside reference decoder.

These are standard test assets, never decoder implementation files or new encoder output.
They prove the runnable examples with file-specific metadata, not arbitrary-model quality or speed.

`draco-metadata-past-value.json` (SHA-256 `f3e919d173611d295fa98a5a51455d48c77017173a5669a7568442479ba5aa2a`) holds the
22 Margo-crafted point-cloud streams whose last metadata group runs past the value (from
docs/whitepaper/results/batch-133-metadata-strings.json), each with the opaque full build's public string for the
stream itself and for the same value carrying three explicit zero bytes (E25 in docs/clean-room.md). Margo-authored
syntax and oracle output; no decoder implementation or wrapper source was read.
