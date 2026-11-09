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
