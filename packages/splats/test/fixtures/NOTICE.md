# Test fixtures

Fixtures are used only by the tests and are not part of the published package (`files` is `dist`).

All of them are derived from two real captures that ship as samples in Niantic Labs' SPZ repository,
https://github.com/nianticlabs/spz (`samples/racoonfamily.spz`, 24,202,962 bytes, and `samples/hornedlizard.spz`,
18,143,098 bytes). The repository is MIT-licensed (Copyright (c) 2024 Niantic Labs;
https://github.com/nianticlabs/spz/blob/main/LICENSE) and states no separate licence for the samples. The full files
are not committed (too large); the tests that read them skip with a message when they are absent: set
`MARGO_SPLAT_SAMPLES` to a folder holding `racoonfamily.spz` and `hornedlizard.spz`.

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

splat-transform (https://github.com/playcanvas/splat-transform, npm `@playcanvas/splat-transform`) was run only as
a black-box converter from a folder outside this repository; none of its code is used or read here.
