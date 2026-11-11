# Test fixtures

Fixtures are used only by the tests and are not part of the published package (`files` is `dist`).

All of them are derived from two real captures that ship as samples in Niantic Labs' SPZ repository,
https://github.com/nianticlabs/spz (`samples/racoonfamily.spz`, 24,202,962 bytes, and `samples/hornedlizard.spz`,
18,143,098 bytes). The repository is MIT-licensed (Copyright (c) 2024 Niantic Labs;
https://github.com/nianticlabs/spz/blob/main/LICENSE) and states no separate licence for the samples. The full files
are not committed (too large). The tests require the complete files in the shared external cache;
run `node scripts/reference-rendering/fetch-skip-assets.mjs` from the repository root. The pinned
sources, sizes and SHA-256 values are in `scripts/support/external-test-assets.json`. Missing, changed
or Git LFS pointer bytes fail; no shell export is required. `MARGO_SPLAT_SAMPLES` can override the cache.

Each fixture keeps only the splats whose x lies in a thin slab (a few thousand splats, every attribute untouched):

| File | Bytes | What it is |
| --- | --- | --- |
| `raccoon-v2.spz` | 207,217 | 8,385 raccoon splats copied byte for byte out of the SPZ version 2 sample (re-gzipped) |
| `lizard-v2.spz` | 192,790 | 8,109 horned-lizard splats, same way |
| `raccoon-v2.ply` | 1,980,364 | `raccoon-v2.spz` converted to a Gaussian-splat PLY by PlayCanvas splat-transform 3.10.3 (MIT), the reference decode |
| `raccoon-v3.spz` | 226,647 | `raccoon-v2.ply` written as SPZ version 3 by splat-transform (`--spz-version 3`) |
| `raccoon-v4.spz` | 212,673 | the same as SPZ version 4 (Zstandard streams); must decode exactly like `raccoon-v3.spz` |
| `raccoon.sog` | 184,051 | `raccoon-v2.ply` written as a bundled SOG by splat-transform (`-g cpu`) |
| `raccoon-sog.ply` | 1,980,364 | `raccoon.sog` converted back to PLY by splat-transform (SOG reorders splats, so it is its own reference) |
| `raccoon-v2.splat` | 268,320 | The same 8,385-splat real PLY excerpt serialized here by Margo's `encodeSplat`; all positions unchanged; this format quantizes colour/quaternion and omits SH |

splat-transform (https://github.com/playcanvas/splat-transform, npm `@playcanvas/splat-transform`) was run only as
a black-box converter from a folder outside this repository; none of its code is used or read here.

The `.splat` file is a local test-only derivative under the source's MIT grant. Regenerate it after a build with
`node packages/splats/scripts/make-readme-splat.mjs`. Source PLY SHA-256:
`a0f8332242dd99f6b8a8c8aff6df829bafef0eb0e557d4e531ffc031906cd9a6`;
output SHA-256: `ec80ad829ffc324798c6bd7680ce53d2dd28819639b593e1393e39b83a8b1e25`.
README aliases select these exact format-specific files. They prove executable examples on a real excerpt,
not complete-capture quality/performance or independent accuracy of Margo's `.splat` encoder.

### Batch 238 KSplat derivatives and data oracles
The existing Niantic raccoon-v2.ply MIT excerpt above was passed to the documented public GaussianSplats3D 0.4.7 writer in ../engine-bench/batch-168, outside this repository. PlyLoader.loadFromURL arguments after the URL: undefined, false, undefined, 0 (minimum alpha), level (0/1/2), true (optimize), 2 (SH degree). Input fetch returned the source PLY bytes with Content-Length. No source code was read or copied. Generated captures retain all 8,385 records. The small JSON files retain 64 spread numeric samples from public centre, covariance, colour and SH getters; raw half/byte SH codes were converted using IEEE 754 or the header range. These are data-only test oracles, not runtime dependencies.
- raccoon-0.ksplat: 1179020 bytes; SHA-256 6a1fe91dfb4616de72888f56abc86c4671d3730bb5017de1acd7fae76b934d59
- ksplat-0-oracle.json: 23238 bytes; SHA-256 7a1d73206c6c6723ff4a97323946798a5242df5edf8d05dc06c44ff3869ea146
- raccoon-1.ksplat: 609368 bytes; SHA-256 b1ce355f8101966966137f2fd39b52780ac5b294f2b0c995a77548bce2b3fdd0
- ksplat-1-oracle.json: 24263 bytes; SHA-256 45bae7cf3a647cbe91c53f1ea7ba240583b0db2b4d10a45bb93dd343822cd8b4
- raccoon-2.ksplat: 408128 bytes; SHA-256 24ac0df884c4bade2fb325135403f8bcb69f9a962c12c9b100f37f54ea420321
- ksplat-2-oracle.json: 45085 bytes; SHA-256 6d8cf0026f62a09ac3e9ff284e97da75060a3003b7779937a919ee2b897d09d8
