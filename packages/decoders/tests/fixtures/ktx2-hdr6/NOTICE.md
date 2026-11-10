# HDR6 conformance fixtures

Margo-authored ramps, deterministic noise, solid colors and all-configuration streams are dedicated CC0-1.0. The real image re-encodes the existing this-way-up-uastc-hdr.ktx2 test fixture, sourced from test_this_way_up_RGB_HALF_128x128.exr in https://github.com/KhronosGroup/KTX-Software-CTS, Apache-2.0, copyright The Khronos Group Inc. and RasterGrid Kft.

KTX2 files and hashes were produced with the official Basis Universal v2_1_0r prebuilt encoder/transcoder, used as black-box tools only. Source: https://github.com/BinomialLLC/basis_universal/tree/v2_1_0r/webgl/encoder/build and /webgl/transcoder/build, Apache-2.0. No decoder files ship here. The frozen records.json stores fixture and output SHA-256 values for each mip and target. all-modes-abcd and all-modes-abce exercise every one of the 75 specified configurations five times with varied endpoints, weights and partitions.
