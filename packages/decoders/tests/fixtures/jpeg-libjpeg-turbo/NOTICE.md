# Lossless and 12-bit JPEG test files

Margo generated data: images computed by `tests/support/jpeg-sources.js`, encoded by `cjpeg` of libjpeg-turbo 3.2.1
(conda-forge `libjpeg-turbo-3.2.1-hfd05255_0`, win-64, package SHA-256
`195be7b2ff1eeff02b31cf366437a38d84560c2f6c4facd56b2969024f50957f`), run as a program, its source never read.
`*.samples.gz` is `djpeg -dct float`'s decode of the lossy file beside it, as little-endian 16-bit words. Made by
`tests/generate-jpeg-libjpeg-turbo.mjs`. Test-only, never shipped.
