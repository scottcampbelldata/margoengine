# Mutation testing of @margoengine/biomes

`scripts/mutation.mjs` is a hand-rolled runner with no dependency. It parses a source file, lists small changes (a comparison
or arithmetic operator swapped, a constant plus one, a `!` removed, `true` and `false` swapped), builds the package once per
change and runs the named test files against that build. A failing test, a crash or a timeout kills the mutant; a mutant
every test passes survives and means a test is missing or too weak. Score = killed / (killed + survived).

    node scripts/mutation.mjs biomes                     all three targets
    node scripts/mutation.mjs biomes fixed --cap=150     a seeded sample of at most 150 mutants
    node scripts/mutation.mjs biomes --list              only count the mutants
    node scripts/mutation.mjs biomes classify --lines=540-626   only the mutants on those lines

A mutant slot holds its own copy of `src`, so tests that import the TypeScript source see the mutant too.

Run 2026-11-05 (Windows, Node 26, 6 jobs). Targets and test files are in `TARGETS` in the runner. `placement` runs
the `placement-output`, `placement-band` and `placement` tests (`placement-valid` reads the real `dist`, so it cannot see a mutant).

| Target | Mutants | Run | Killed | Score |
| --- | --- | --- | --- | --- |
| `src/fixed.ts` | 487 | all | 401 | 82.3 % (74.0 % before the new tests, on a 150 sample) |
| `src/classify.ts` | 501 | all | 405 | 80.8 % (60.7 % on the first 150-sample, before classify-mutants.test.js) |
| `src/placement.ts` | 1538 | 150 sample, seed 1 | 93 | 62.0 % (measured before placement-mutants.test.js; not re-measured, see below) |

## What was fixed

`packages/biomes/tests/fixed-mutants.test.js` (new) pins what the first run found unpinned in `fixed.ts`: wide divisions against
BigInt, `isqrt` at perfect squares, `qmul`/`qdiv` at the 2^53 edge, and full-sweep digests of `qexp2`, `qlog2`, `qpow`,
`atan2`, `sincos`, `qacos`, `fade` and `wendland`. `classify-mutants.test.js` (new, 12 tests) drives `classifier`/`classify`/`membership` over synthetic layers with biomes on every input, claims, all paint modes with masks and feathering, a zone scorer and the nearest-envelope fallback, and locks the warped inputs, memberships and stored ids and weights by digest. `placement-mutants.test.js` (new, 11 tests) is described below. No existing test or tolerance was changed, and no mutant exposed a bug in `src`. 74.0 % to 82.3 % (the first figure is a
150 sample, the second all 487).

## Surviving mutants (open work: each needs a test, or a written reason it cannot change an output)

Equivalent by argument (fixed.ts): the comparisons at exactly 2^53 in `mulShift`/`qmul` (the slow path gives the same
integer); `divWide`/`divFloor` limit comparisons and the correction steps in `divWider` (the double quotient is exact for
|n| below 2^53, checked in the new test); `n >= 0` and `n <= -18` in `qexp2` (same result by shifts); the shift-guess
constants in the second `atan2` scaling branch (the two loops after it correct any start); `bilinear` (lines 361 to 368)
is not exported from any entry, so no test can reach it.
fixed.ts survivors by line: 17 (0 -> 1); 49 (> -> >=, < -> <=); 60 (< -> <=, > -> >=); 80 (0 -> 1, || -> &&, 1 -> 2, === -> !==); 95 (0 -> 1); 107 (< -> <=, > -> >=, < -> <=, > -> >=); 117 (< -> <=, 0 -> 1, 1 -> 2, 1 -> 2); 118 (>= -> >, 0 -> 1); 119 (-= -> +=); 120 (>= -> >, += -> -=); 121 (+= -> -=, 0 -> 1); 122 (<= -> <, -= -> +=); 129 (< -> <=, > -> >=, < -> <=, > -> >=); 136 (0 -> 1, < -> <=, < -> <=, 0 -> 1); 155 (* -> +); 156 (1 -> 2, 1 -> 2, <= -> <); 175 (>= -> >, 15 -> 16); 182 (32768 -> 32769); 183 (0 -> 1, < -> <=, 32768 -> 32769); 187 (16384 -> 16385); 201 (33554432 -> 33554433); 215 (33554432 -> 33554433); 216 (50331648 -> 50331649); 219 (>= -> >, 0 -> 1); 220 (<= -> <, 18 -> 19); 225 (<= -> <); 251 (< -> <=, | -> &, 0 -> 1, 0 -> 1, | -> &); 255 (>= -> >, 0 -> 1); 256 (>= -> >, 0 -> 1); 258 (< -> <=, 3 -> 4, - -> +, 28 -> 29, - -> +); 259 (>= -> >, 2 -> 3, 536870912 -> 536870913); 266 (< -> <=, 30 -> 31); 285 (> -> >=, < -> <=); 286 (+ -> -); 327 (- -> +, + -> -); 332 (< -> <=, > -> >=); 340 (<= -> <); 341 (>= -> >); 361 (0 -> 1, - -> +); 368 (+ -> -, + -> -).

classify.ts, all 501 mutants after `classify-mutants.test.js`: 96 survivors, on these lines: 109 159 179 184 187 189 204 210 219 220 221 295 297 313 315 316 317 318 320 325 334 335 354 358 360 367 371 381 385 387 393 397 398 409 410 411 415 420 426 434 438 449 452 454 458 460 462 467 471 476 479 489 492 508 509 522 524 525 530 563 564 566 570 582 600 602 610 612 616 617 623.
Reasons they survive, by group: (a) lines 563 to 623, the loop starts and bounds of `featherPaint`: row 0, the last row and the first and last column of the read grid are the 1-cell margin that `classifyPlanes` never reads (it reads the inner cells only), so a changed start or bound there cannot reach an output; the sums at 582, 610 and 612 differ only at a box that holds no painted cell at the grid edge. (b) lines 109, 179 to 221 and 295 to 335: `flatten`, `membership` and `memberships` clamp and boundary constants (1048576 is the clamp of the signed distance; a value exactly at a clamp or bound gives the same Wendland argument) and scratch-plane sizes; `classifyInputs` mode bounds equal at the exact boundary. (c) lines 354 to 530, the selection tail: tie-break comparisons (`<` against `<=`, `>` against `>=`) that only differ when two biomes tie on weight and on rank, which `rank` makes impossible (ranks are unique), and the 4-slot constants (a fifth slot is cut by `Math.min(used, 4)`). These were argued from the code, not proven by a test; each is a candidate for a targeted test or a proof, and none has revealed a bug.
The fast path of the selection tail (line 434 to 443, one biome and no paint) and the remaining comparisons are covered by the goldens only on the preset worlds; the new tests add 8 synthetic cases and the `membership` export.

placement.ts: `placement-mutants.test.js` was written after the sample below and pins the validation limits of sizes, clusters and exclusions on both sides, every size, cluster and stand kind, line and polygon exclusions with verges, the tile cache (64-tile limit, least recently used, bounds) and a dense run. It has not been re-scored (a re-run was stopped on request), so 62.0 % is the last measured figure. Survivors of the 150-sample, by line:  189 (64 -> 65); 268 (<= -> <, && -> ||); 278 (<= -> <); 282 (* -> +); 300 (65536 -> 65537); 324 (> -> >=); 331 (0 -> 1); 354 (205887 -> 205888); 362 (10000 -> 10001); 432 (! removed); 563 (0 -> 1); 591 (<= -> <, * -> +, + -> -); 592 (- -> +); 610 (&& -> ||, * -> +); 628 (- -> +, * -> +); 655 (1 -> 2); 666 (* -> +); 690 (* -> +); 706 (0 -> 1, < -> <=); 707 (0 -> 1); 724 (- -> +); 731 (1024 -> 1025); 738 (1024 -> 1025); 739 (1024 -> 1025); 789 (0 -> 1); 869 (65536 -> 65537); 889 (> -> >=); 890 (* -> +); 995 (1 -> 2); 1010 (16 -> 17); 1105 (< -> <=); 1139 (< -> <=); 1140 (< -> <=); 1236 (0 -> 1); 1333 (&& -> ||, > -> >=); 1394 (|| -> &&, >= -> >); 1418 (> -> >=); 1420 (=== -> !==); 1461 (1 -> 2); 1462 (<= -> <); 1485 (0 -> 1); 1572 (>= -> >); 1611 (- -> +); 1642 (&& -> ||, 2 -> 3); 1739 (1 -> 2); 1806 (<= -> <); 1823 (< -> <=); 1829 (0 -> 1).
