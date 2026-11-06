# UASTC HDR KTX2 fixtures

Real files written by the official Basis Universal 1.50 encoder (`webgl/encoder/build/basis_encoder.wasm`, tag
v1_50_0_2, Apache-2.0, https://github.com/BinomialLLC/basis_universal), with generated mips, used only by the tests.

- `this-way-up-uastc-hdr.ktx2`, 128 x 128, from `test_this_way_up_RGB_HALF_128x128.exr`.
- `cube-uastc-hdr.ktx2`, 96 x 96 cube. Each face is a square cut from `memorial.exr` (Paul Debevec's Memorial Church HDR
  image, from the OpenEXR sample images, https://github.com/AcademySoftwareFoundation/openexr-images, BSD-3-Clause), so
  the six faces differ.
- `odd-uastc-hdr.ktx2`, 85 x 80, from `tiled_25x25_RGBA_HALF_85x80.exr`.

The EXR files are in the KTX-Software conformance suite, https://github.com/KhronosGroup/KTX-Software-CTS
(`clitests/input/exr_sample`), Apache-2.0, copyright The Khronos Group Inc. and RasterGrid Kft.

`records.json` holds pixels sampled from the EXR files, read with `parseEXR` from `@margoengine/environment`, and the
worst relative error measured against them. `odd-uastc-hdr.ktx2` has no record: its source is a tiled EXR, which `parseEXR`
does not read, so its test checks the size and format only.
