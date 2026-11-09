# UASTC HDR KTX2 fixtures

Real files written by the official Basis Universal 1.50 encoder (`webgl/encoder/build/basis_encoder.wasm`, tag
v1_50_0_2, Apache-2.0, https://github.com/BinomialLLC/basis_universal), with generated mips, used only by the tests.

- `this-way-up-uastc-hdr.ktx2`, 128 x 128, from `test_this_way_up_RGB_HALF_128x128.exr`.
- `cube-uastc-hdr.ktx2`, 96 x 96 cube, seven mips, now uses six distinct Margo analytic light-field faces,
  dedicated CC0-1.0. The former Memorial Church image-use grant could not be established; its earlier OpenEXR/BSD
  attribution was unsupported. Scott directed replacement rather than waiting for grants. The generator, exact
  source arrays, hashes and 45-pair replacement baseline are documented in `../basis134/NOTICE.md`.
- `odd-uastc-hdr.ktx2`, 85 x 80, from `tiled_25x25_RGBA_HALF_85x80.exr`.

The EXR files are in the KTX-Software conformance suite, https://github.com/KhronosGroup/KTX-Software-CTS
(`clitests/input/exr_sample`), Apache-2.0, copyright The Khronos Group Inc. and RasterGrid Kft.

`records.json` holds source samples from the EXR image and the analytic cube, and the
worst relative error bounds. The cube retains its original 0.47 bound and sample count. `odd-uastc-hdr.ktx2` has no record: its source is a tiled EXR, which `parseEXR`
does not read, so its test checks the size and format only.
