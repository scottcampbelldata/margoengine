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
- `ktx2-layers/`: see `ktx2-layers/NOTICE.md`.
- `ktx2-hdr/`: see `ktx2-hdr/NOTICE.md`.
- `NormalizedTriangle.gltf` and `NormalizedTriangle.bin` are Margo-made by `../generate-normalized-fixture.mjs` (one
  triangle encoded with the Draco 1.5.7 encoder); they contain no third-party data.
