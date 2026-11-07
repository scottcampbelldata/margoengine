# WebP and BC test fixtures

- `Website_accessibility.webp`: unchanged from Wikimedia Commons, https://commons.wikimedia.org/wiki/File:Website_accessibility.webp, by Thesweetdonkey, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode). SHA-256 `6906a7f603ac73e8bf55bac29314693fcb699234534ecf656ea787e83375c318`.
- Every other `.webp` here was made for this project with cwebp and img2webp 1.4.0 from a 97 x 83 crop of "Clay - Cobblestone Embedded Asphalt - Preview", Amal Kumar via Poly Haven, on Wikimedia Commons, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode), SHA-256 `cdd3d9b3f6bda99165a4c4ede1d9901471e4002b368d8bd59d3999e2b34dd3e0`. Alpha is a made gradient. The `alpha-raw-*` files are `alpha-raw.webp` with the filter bits of its ALPH header changed.
- `dwebp/*.png` and `dwebp.json`: what dwebp 1.4.0 (anim_dump for `animated.webp`) wrote for those files, kept as the outside reference. No libwebp code is here.
- `../bc/vectors.json`: 50 single 8 or 16 byte blocks from the DDS test images of Pillow (HPND, commit 6f9d284ecd6cd45d580b90dd04b7715d4a07525f, `Tests/images`), each with the 4 x 4 pixels of the PNG beside its file. Whole files stay outside the repository, listed by URL in `../../real-files/manifest.json`.

libwebp-test-data states no licence, so none of its files are here; the manifest lists them by URL and SHA-256.
