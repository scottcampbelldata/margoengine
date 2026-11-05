# Mutation testing of @margoengine/biomes

`scripts/mutation.mjs` is a hand-rolled runner with no dependency. It parses a source file, lists small changes (a comparison
or arithmetic operator swapped, a constant plus one, a `!` removed, `true` and `false` swapped), builds the package once per
change and runs the named test files against that build. A failing test, a crash or a timeout kills the mutant; a mutant
every test passes survives and means a test is missing or too weak. Score = killed / (killed + survived).

    node scripts/mutation.mjs biomes                     all three targets
    node scripts/mutation.mjs biomes fixed --cap=150     a seeded sample of at most 150 mutants
    node scripts/mutation.mjs biomes --list              only count the mutants

Run 2026-11-05 (Windows, Node 26, 6 jobs). Targets and test files are in `TARGETS` in the runner. `placement` runs
the `placement-output`, `placement-band` and `placement` tests (`placement-valid` reads the real `dist`, so it cannot see a mutant).

| Target | Mutants | Run | Killed | Score |
| --- | --- | --- | --- | --- |
| `src/fixed.ts` | 487 | all | 401 | 82.3 % (74.0 % before the new tests, on a 150 sample) |
| `src/classify.ts` | 501 | 150 sample, seed 1 | 91 | 60.7 % |
| `src/placement.ts` | 1538 | 150 sample, seed 1 | 93 | 62.0 % |

## What was fixed

`packages/biomes/tests/fixed-mutants.test.js` (new) pins what the first run found unpinned in `fixed.ts`: wide divisions against
BigInt, `isqrt` at perfect squares, `qmul`/`qdiv` at the 2^53 edge, and full-sweep digests of `qexp2`, `qlog2`, `qpow`,
`atan2`, `sincos`, `qacos`, `fade` and `wendland`. No existing test or tolerance was changed. 74.0 % to 82.3 % (the first figure is a
150 sample, the second all 487).

## Surviving mutants (open work: each needs a test, or a written reason it cannot change an output)

Equivalent by argument (fixed.ts): the comparisons at exactly 2^53 in `mulShift`/`qmul` (the slow path gives the same
integer); `divWide`/`divFloor` limit comparisons and the correction steps in `divWider` (the double quotient is exact for
|n| below 2^53, checked in the new test); `n >= 0` and `n <= -18` in `qexp2` (same result by shifts); the shift-guess
constants in the second `atan2` scaling branch (the two loops after it correct any start); `bilinear` (lines 361 to 368)
is not exported from any entry, so no test can reach it.
fixed.ts survivors by line: 17 (0 -> 1); 49 (> -> >=, < -> <=); 60 (< -> <=, > -> >=); 80 (0 -> 1, || -> &&, 1 -> 2, === -> !==); 95 (0 -> 1); 107 (< -> <=, > -> >=, < -> <=, > -> >=); 117 (< -> <=, 0 -> 1, 1 -> 2, 1 -> 2); 118 (>= -> >, 0 -> 1); 119 (-= -> +=); 120 (>= -> >, += -> -=); 121 (+= -> -=, 0 -> 1); 122 (<= -> <, -= -> +=); 129 (< -> <=, > -> >=, < -> <=, > -> >=); 136 (0 -> 1, < -> <=, < -> <=, 0 -> 1); 155 (* -> +); 156 (1 -> 2, 1 -> 2, <= -> <); 175 (>= -> >, 15 -> 16); 182 (32768 -> 32769); 183 (0 -> 1, < -> <=, 32768 -> 32769); 187 (16384 -> 16385); 201 (33554432 -> 33554433); 215 (33554432 -> 33554433); 216 (50331648 -> 50331649); 219 (>= -> >, 0 -> 1); 220 (<= -> <, 18 -> 19); 225 (<= -> <); 251 (< -> <=, | -> &, 0 -> 1, 0 -> 1, | -> &); 255 (>= -> >, 0 -> 1); 256 (>= -> >, 0 -> 1); 258 (< -> <=, 3 -> 4, - -> +, 28 -> 29, - -> +); 259 (>= -> >, 2 -> 3, 536870912 -> 536870913); 266 (< -> <=, 30 -> 31); 285 (> -> >=, < -> <=); 286 (+ -> -); 327 (- -> +, + -> -); 332 (< -> <=, > -> >=); 340 (<= -> <); 341 (>= -> >); 361 (0 -> 1, - -> +); 368 (+ -> -, + -> -).

classify.ts survivors by line (first 150-sample): 109 (1 -> 2); 119 (=== -> !==); 132 (3 -> 4); 153 (&& -> ||); 159 (> -> >=); 183 (>> -> <<); 187 (* -> +, 1048576 -> 1048577, 1048576 -> 1048577); 219 (* -> +); 294 (3 -> 4); 295 (0 -> 1); 297 (&& -> ||); 315 (< -> <=); 317 (0 -> 1); 318 (10 -> 11); 320 (0 -> 1); 322 (+ -> -, * -> +, 16 -> 17, 6553600 -> 6553601); 325 (< -> <=); 367 (1 -> 2); 387 (< -> <=, - -> +); 393 (!== -> ===); 397 (4 -> 5); 398 (4 -> 5); 402 (! removed); 407 (=== -> !==); 408 (0 -> 1); 415 (1 -> 2); 420 (false -> true); 426 (1 -> 2); 434 (<= -> <); 449 (< -> <=); 471 (+= -> -=); 479 (< -> <=); 498 (4 -> 5); 524 (1 -> 2); 525 (1 -> 2); 530 (4 -> 5); 561 (+ -> -); 563 (* -> +); 564 (+ -> -, 2 -> 3); 566 (2 -> 3); 567 (* -> +); 569 (0 -> 1); 570 (0 -> 1); 590 (+= -> -=); 605 (+= -> -=); 610 (1 -> 2); 611 (+= -> -=, * -> +); 612 (+= -> -=, - -> +); 617 (0 -> 1); 622 (+ -> -). Many sit in `membership`/`farAt` (used by
the GPU input builders) and in warp modes 2 to 5 of `classifyInputs`, which no preset reaches: a direct test of each mode
is the next job.

placement.ts survivors by line (150-sample): 189 (64 -> 65); 268 (<= -> <, && -> ||); 278 (<= -> <); 282 (* -> +); 300 (65536 -> 65537); 324 (> -> >=); 331 (0 -> 1); 354 (205887 -> 205888); 362 (10000 -> 10001); 432 (! removed); 563 (0 -> 1); 591 (<= -> <, * -> +, + -> -); 592 (- -> +); 610 (&& -> ||, * -> +); 628 (- -> +, * -> +); 655 (1 -> 2); 666 (* -> +); 690 (* -> +); 706 (0 -> 1, < -> <=); 707 (0 -> 1); 724 (- -> +); 731 (1024 -> 1025); 738 (1024 -> 1025); 739 (1024 -> 1025); 789 (0 -> 1); 869 (65536 -> 65537); 889 (> -> >=); 890 (* -> +); 995 (1 -> 2); 1010 (16 -> 17); 1105 (< -> <=); 1139 (< -> <=); 1140 (< -> <=); 1236 (0 -> 1); 1333 (&& -> ||, > -> >=); 1394 (|| -> &&, >= -> >); 1418 (> -> >=); 1420 (=== -> !==); 1461 (1 -> 2); 1462 (<= -> <); 1485 (0 -> 1); 1572 (>= -> >); 1611 (- -> +); 1642 (&& -> ||, 2 -> 3); 1739 (1 -> 2); 1806 (<= -> <); 1823 (< -> <=); 1829 (0 -> 1).
