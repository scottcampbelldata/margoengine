# AVIF conformance assets

These are standard sample/test assets under the exception in AGENTS.md. No external codec source, glue or binary ships in the Margo runtime.

The seven original fox/kimono AVIF files are unmodified AOM/Link-U conformance assets, pinned to bf4c18d1f3971069b75e87d6ee469790589f4f09. Their exact URLs, sizes and SHA-256 digests are in manifest.json. License: Creative Commons Attribution-ShareAlike 4.0 International, https://creativecommons.org/licenses/by-sa/4.0/legalcode . Original corpus statement: https://github.com/AOMediaCodec/av1-avif/blob/bf4c18d1f3971069b75e87d6ee469790589f4f09/testFiles/Link-U/README.md . Fox: Kaede Fujisaki, https://hexe.net/2017/12/02/16:33:53/ . Kimono: Momiji Jinzamomi and Kaede Fujisaki, as credited by that statement.

The tools-superres.avif test is a 256x256 derivative of the same fox asset, encoded by an opaque SVT-AV1 encoder with denominator 12. Its attribution and CC-BY-SA-4.0 license remain the same. All other tools-*.avif inputs are Margo-authored analytic rasters encoded through an opaque libaom executable; they are dedicated to CC0-1.0. Generator settings are recorded in generate-tools.py. None is a borrowed implementation or demonstration.

The four additional AVIF files abc_color_irot_alpha_irot.avif, sofa_grid1x5_420.avif, paris_icc_exif_xmp.avif and white_1x1.avif are standard libavif test images. container-references.json pins their source revision, URLs, hashes and original dimensions. Their upstream tests/data/README.md explicitly licenses each under the libavif BSD-2-Clause license below. The compressed RGBA references are independently decoded test data with the corresponding image license, not implementation files.

pixel-references.json freezes 16 independent frames and 14,828,077 tightly packed Y/U/V samples. Six are from Chromium 157.0.4341.42 (VideoDecoder for 8/10 bits and ImageDecoder for 12-bit 4:4:4). The full precision 12-bit monochrome frame and nine tool fixtures were captured with FFmpeg libavcodec 63.1.102/libdav1d through PyAV 19.0.2. Samples above eight bits occupy unshifted little-endian u16 words. Both scalar Rust and actual Wasm SIMD match every frozen digest exactly. Pixel references include observed palette/copy/Wiener/SGR counts, grain, super-resolution, tile and quantization-matrix assertions.

RGB references use Pillow 13.0.0/libavif 1.4.2, except the kimono BT.2020 case, which uses FFmpeg v9.0.2 swscale with centered chroma, bilinear, accurate_rnd and full_chroma_int. The latter avoids a black-box fast RGB path's blue-coefficient approximation; its reference preserves the existing one-code-level RGB bound. Alpha is exact throughout. Display crop/orientation is applied explicitly to the coded kimono image according to its rational properties. ICC bytes remain metadata.

## BSD-2-Clause notice for the four libavif standard images

Copyright 2019 Joe Drago. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
this list of conditions and the following disclaimer in the documentation
and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

