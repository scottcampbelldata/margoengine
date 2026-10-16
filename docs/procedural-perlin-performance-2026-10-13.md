# Procedural Perlin fixed-axis experiment — 2026-10-13

Status: rejected for adoption. Production source is unchanged.

The private candidate changes only the upper bound of the `b` corner loop from
`2` to `(v ? 2 : 1)`, skipping contributions that are exactly zero for the island's
integer Y coordinate. Remaining operations keep their original order.

The executed CPU run checks 487,776 Float64 noise cases across twelve seeds,
including signed zero and adversarial values. Four complete terrain meshes,
256-square height textures and 513-square sample grids have identical bytes;
errors match. This proves output parity within that tested scope.

| Workload, 24 measurements per path | Baseline median | Candidate median | Change |
| --- | ---: | ---: | ---: |
| Actual island height samples | 101.517 ms | 84.681 ms | −16.58% |
| Complete landscape mesh and heightmap | 253.030 ms | 255.980 ms | +1.17% |
| Procedural package gzip bytes | 5,681 | 5,690 | +9 bytes |

The sampler gain does not translate into a measured complete construction gain.
Full-workload times vary widely, so the small regression is not asserted as a
stable performance penalty. It nevertheless fails to demonstrate the required
application benefit while increasing compressed size. No browser startup or GPU
gain is established, and the candidate remains private.

Evidence: `test-results/perlin-zero-axis-run-20261013.log` and
`test-results/procedural-perlin-zero-axis-2026-10-13T163017184Z.json`. The latter
contains raw measurements, source/build hashes and all compared array hashes.
Reproduction: `node test-results/compare-procedural-perlin-zero-axis.mjs --run`.

This experiment is local and unpublished.
