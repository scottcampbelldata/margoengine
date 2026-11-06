# Test fixtures

Fixtures are used only by the tests and are not part of the published package (`files` is `dist`).

- `Box.glb` and `BoxTextured.glb` are the binary (`glTF-Binary`) versions of the Khronos glTF sample models Box and
  BoxTextured, https://github.com/KhronosGroup/glTF-Sample-Assets: Cesium,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode). BoxTextured's texture shows the Cesium logo.
- `jpeg/` was made for these tests from a generated pattern, with Pillow 13.0.0 on libjpeg-turbo 3.2.0: each `.jpg` is a
  file written by that library and each `.png` beside it is what that library decodes it to. No third-party image is in it.
