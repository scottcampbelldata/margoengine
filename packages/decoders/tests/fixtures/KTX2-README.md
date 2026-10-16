# KTX2 glTF texture fixtures

`Dot_C.ktx2` and `Rib_N.ktx2` are unmodified textures from the Khronos
[Car Concept sample](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/edc7c9e67c639d230715049ee31f9a96a6babbbe/Models/CarConcept/glTF-KTX-BasisU-Draco).

Copyright 2024 Darmstadt Graphics Group GmbH. Textures by Eric Chadwick.
Licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/legalcode).
The originating model also contains Khronos and 3D Commerce logos, credited to
the Khronos Group in its [metadata](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/edc7c9e67c639d230715049ee31f9a96a6babbbe/Models/CarConcept/metadata.json).
These two texture files depict dots and a ribbed normal pattern.

| File | Encoding | Dimensions | Mips | SHA-256 |
| --- | --- | --- | --- | --- |
| `Dot_C.ktx2` | ETC1S / BasisLZ, sRGB | 128 × 128 | 8 | `08968e9d7d9855ae8d201cfaea889e2748fc9049a95838aa18ce689d29c041ca` |
| `Rib_N.ktx2` | UASTC / Zstandard, linear | 32 × 32 | 6 | `7bbd1d7776a087b48d3f7d50395d24840fd00dc5ab2622f8dce5685995df94d3` |

The files test real texture transcoding, complete mip pyramids, glTF source
selection, texture roles, and restoration after device loss.
