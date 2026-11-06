# PVR fixtures

Real files, written by real tools. Neither came from a Margo encoder.

- `fern.pvr`, `bigMushroom_texture.pvr`, `Ground_Western_Village_roughness.pvr`: from powervr-graphics/Native_SDK, MIT.
- `test_image_pvrtc2bpp.pvr`, `test_image_pvrtc2bpp_v3.pvr`, `test_image_pvrtc4bpp.pvr`, `test_image_pvrtc4bpp_v3.pvr`: from
  cocos2d/cocos2d-x v4, MIT.

`records.json` holds the sha256 of the RGBA that texture2ddecoder 1.0.6 (MIT, run outside this repository) gave for every
level 8 texels wide or more. Margo's decoder was written from Fenney's paper "Texture Compression using Low-Frequency Signal
Modulation" and the public PVR format description; the outside decoder was only compared against. Levels under 8 texels wide
are left out: the two decoders differ there in 111 of 2,621,456 channels across 26 real levels (`docs/limits.md`).
