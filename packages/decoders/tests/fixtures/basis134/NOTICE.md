# Batch 134 licensed comparison fixtures

These replace three historical .basis files (AGI HQ atlas, alpha3 and Kodak03)
and the Memorial Church HDR cube because their original image-use grants could
not be proved. Scott directed substitution without waiting for permission records.
The historical measurement snapshot is retained; it is not the active corpus.

The three .basis files derive from the FlightHelmet GlassPlasticMat BaseColor
PNG, CC0-1.0, copyright 2018 Public, conversion by Gary Hsu. The pinned upstream
asset and Legal notice are in `flighthelmet-cc0.png`, `FlightHelmet-NOTICE.md`
and `manifest.json`. Dimensions remain 1024 x 1024 (opaque ETC1S atlas) and
768 x 512 (alpha ETC1S and opaque UASTC), with one image and one level each.
Nearest source-pixel resampling changes size; the alpha case adds a deterministic
128-pixel product ramp. This is real image content with a generated alpha plane.

The six 96 x 96 HDR faces are Margo's analytic light field, dedicated CC0-1.0:
R = 2^(face-3) * (0.0625+x/16), G = 0.125+y/24,
B = 0.25+((x*y)%197)/32, A = 1, stored as little-endian float32.
The replacement cube is `../ktx2-hdr/cube-uastc-hdr.ktx2`; all six different
faces, seven mip levels and five old HDR targets remain covered. It is a
synthetic conformance/precision fixture and makes no photographic quality claim.

The source arrays are losslessly gzip-compressed with a zero timestamp. Hashes
refer to uncompressed arrays. `baseline.json` retains old-prebuilt output hashes
and source errors for all 45 replaced file/target pairs and 250 images, including
explicit R/alpha errors for BC5/EAC RG. Exact-area integration in stored channels
defines source mip references. This does not claim to recreate an encoder filter.

The official Basis encoder was executed opaquely outside the repository to
generate these standard test assets; no encoder implementation was read or copied.
Its Wasm hash and all asset hashes are recorded in `manifest.json`. Regenerate
with `node packages/decoders/scripts/generate-basis134.mjs <outside-encoder-folder>`.
The outside folder holds the opaque `basis_encoder.cjs` and `basis_encoder.wasm`.

These fixtures and source arrays are test-only and are not shipped in the package.
