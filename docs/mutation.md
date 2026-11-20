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

## @margoengine/math

Run 2026-11-15 (Windows, Node 26, 8 jobs). Fifteen targets, one per source file, every mutant of each file (no cap). A target runs the
whole CPU test list of the package in one `node --test` process (`parallel: true`), which stops at the first failing test. The packages
`math`, `splines`, `fsm`, `tween` and `wfc` keep their tests in `test/`, so the runner reads `tests/` where it exists and `test/` otherwise.
`equivalent` lists, per target, the survivors that provably cannot change an output, each with its reason; they count neither as killed
nor as survived. Score = killed / (killed + survived). The "before" column is the package's tests as they stood (all `test/*.test.js`),
the "after" column adds the seven `*-pins.test.js` files, `box3-unbounded.test.js` and `seed-pins.test.js`, and (run of
`ray`, `frustum`, `triangle` and `mathutils` again after the fixes below) `frustum-unbounded.test.js`, `shape-box-unbounded.test.js`,
`ray-box-edges.test.js` and `mathutils-log2.test.js`.

| Target | Mutants | Before | After (killed, survived, equivalent) |
| --- | --- | --- | --- |
| `vector2` | 95 | 37 killed, 38.9 % | 93, 0, 2: 100 % |
| `vector3` | 257 | 175, 68.1 % | 254, 0, 3: 100 % |
| `vector4` | 116 | 51, 44.0 % | 114, 0, 2: 100 % |
| `quaternion` | 212 | 183, 86.3 % | 209, 0, 3: 100 % |
| `euler` | 222 | 210, 94.6 % | 222, 0, 0: 100 % |
| `matrix3` | 243 | 198, 81.5 % | 239, 0, 4: 100 % |
| `matrix4` | 654 | 535, 81.8 % | 631, 0, 23: 100 % |
| `box3` | 172 (178 after the fix below, 177 after KB-MATH-UNB2) | 88, 51.2 % | 171, 0, 6: 100 % |
| `sphere` | 109 | 20, 18.3 % | 105, 0, 4: 100 % |
| `plane` | 148 | 87, 58.8 % | 144, 0, 4: 100 % |
| `ray` | 202 (207 after the fix) | 117, 57.9 % | 200, 0, 7: 100 % |
| `line3` | 136 | 127, 93.4 % | 128, 0, 8: 100 % |
| `frustum` | 91 (97 after the fix) | 73, 80.2 % | 94, 0, 3: 100 % |
| `triangle` | 454 (460 after the fix) | 380, 83.7 % | 421, 0, 39: 100 % |
| `mathutils` | 105 | 81, 77.1 % | 96, 0, 9: 100 % |
| Total | 3,216 (3,238 after the fixes) | 2,362 / 3,216, 73.4 % | 3,121 killed, 0 survived, 117 equivalent: 100 % |

Not run for `math` (no target yet): `capsule`, `obb`, `color`, `curve`, `billboard`, `project`, `sh`, `compat`, `color-space`.

Closed survivors (2026-11-15, second pass):

- `ray.ts`: the padding factor 8 and the unbounded-box branch are killed by `ray-box-edges.test.js` (a gap of 56 eps hits and 64 eps
  misses, worked out by hand from the documented rule, and a miss against an unbounded slab); the two slab guards are killed by
  boxes whose later slab starts or ends inside the slack of an earlier one. `t0 - slack > near` with `>=` assigns an equal value,
  so it is equivalent.
- `frustum.ts`: the three `> 0` corner choices sit inside `n !== 0`, where `>=` is the same test (equivalent, as for `Box3`).
- `mathutils.ts` lines 49 and 56: the second correction step of `ceilPowerOfTwo` and `floorPowerOfTwo` only runs for 0 and
  Infinity, where the mutants give the same value, because `Math.log2` never rounds across a power of two; `mathutils-log2.test.js`
  pins that at every power of two (subnormals included) and 4,096 steps either side, past which a log2 accurate to under 1 ulp
  cannot cross. The six mutants are equivalent on that proof; the test also checks both functions against a bit-level reference.

Found by the second pass (`docs/known-bugs.md`, KB-MATH-UNB1): `Frustum.intersectsBox` kept boxes unbounded on an axis a plane does
not use (`0 * Infinity`) and empty boxes; `Triangle.intersectsBox` and `Capsule.intersectsBox` reported shapes outside an unbounded
box as touching it (NaN centre and half sizes); `Ray.intersectsBox` hit an empty box.

Found after the second pass (KB-MATH-UNB2): `Box3.getCenter` and `getBoundingSphere` gave NaN for an unbounded box. An axis with
an infinite bound now has centre 0 and the radius is `Infinity` (`box3-unbounded.test.js`); `box3` was run again, 177 mutants,
171 killed and the same 6 equivalent (their lines moved by 6).

Found by the run: `Box3.intersectsPlane` returned false for a box unbounded along an axis the plane does not use (`0 * Infinity` is
NaN). A zero normal component now adds nothing (`fix(math)`, `packages/math/test/box3-unbounded.test.js`).

`scripts/mutation.mjs` changes: `testDirOf` (`test/` or `tests/`), `parallel` targets, a `taskkill` of the whole test tree on Windows
(a killed `node --test` left its children holding the work folder), the `equivalent` table with `markEquivalent`, and the `equivalent`
count in the report.

## @margoengine/fsm

Run 2026-11-15 (Windows, Node 26, 8 jobs), every mutant of each of the nine source files, the whole CPU test list per target.
"Before" is the second-pass result (`pins.test.js` and `scxml-pins.test.js`); "after" adds `final-pins`, `document-issues`,
`index-pins`, `inspect-pins`, `invoke-pins`, `parallel-pins`, `trace-pins` and `scxml-export-pins` (`.test.js`): each refusal
on its own with its message, every runaway and size limit on its exact boundary (10,000 eventless steps, 100,000 delayed
transitions, 10,000 raised events, export at 10,000 elements, 1 MiB in characters and bytes, 126 hierarchy and 62 region
levels), one `onStable` per public call, re-armed delays, trace ring clearing and the view's mounting, frames and rows.
`document.ts` and `trace.ts` changed (KB-FSM-DOC1 fix; a redundant memory test dropped), so their counts moved.

| Target | Mutants | Before | After (killed, survived, equivalent) |
| --- | --- | --- | --- |
| `document` | 117 (108 now) | 112, 95.7 % | 108, 0, 0: 100 % |
| `events` | 7 (7 now) | 7, 100 % | 7, 0, 0: 100 % |
| `final` | 88 (88 now) | 71, 80.7 % | 85, 0, 3: 100 % |
| `index` | 133 (133 now) | 113, 85.0 % | 125, 0, 8: 100 % |
| `inspect` | 40 (40 now) | 23, 57.5 % | 39, 0, 1: 100 % |
| `invoke` | 29 (29 now) | 18, 62.1 % | 25, 0, 4: 100 % |
| `parallel` | 35 (35 now) | 29, 82.9 % | 34, 0, 1: 100 % |
| `scxml` | 236 (236 now) | 197, 83.5 % | 234, 0, 2: 100 % |
| `trace` | 71 (69 now) | 60, 84.5 % | 69, 0, 0: 100 % |
| Total | 756 (745 now) | 630, 83.3 % | 726 killed, 0 survived, 19 equivalent: 100 % |

Equivalent (each reason is in `scripts/mutation.mjs`): `final.ts` 26 (reset before any read), 110 (NaN distance skips either
way), 145 (the finally clears the queue); `index.ts` 114, 115 (0 or 1 both valid), 185 (the extra step past a path end),
263, 286 (equal values), 290 (indexes past the end), 300 (-1 and -2 both below 0); `inspect.ts` 74, `invoke.ts` 75 and 120
(an abort fires once); `invoke.ts` 124 and 129 (a run leaves `live` only when it is aborted); `parallel.ts` 202 (the queue is
already empty); `scxml.ts` 249 (unreachable: the callers already refuse depth above 127).

Found by the run (`docs/known-bugs.md`, KB-FSM-DOC1): `validateMachine` reported a non-object document twice, called a state
below a missing parent or below a cycle a cycle member, and refused an initial whose chain left the states further up.

## @margoengine/tween

Baseline run 2026-11-15 (Windows, Node 26, 8 jobs), every mutant of each of the seventeen source files, the whole CPU test list
of the package per target (`TARGETS.tween` in the runner). No test was added yet and no mutant is marked equivalent, so this is
the starting figure: each survivor below still needs a test that kills it, or a written reason in `scripts/mutation.mjs` that it
cannot change an output.

| Target | Mutants | Killed | Survived | Score |
| --- | --- | --- | --- | --- |
| `async` | 34 | 24 | 10 | 70.6 % |
| `bezier` | 40 | 15 | 25 | 37.5 % |
| `control` | 98 | 75 | 23 | 76.5 % |
| `custom-ease` | 295 | 230 | 65 | 78.0 % |
| `damp` | 112 | 84 | 28 | 75.0 % |
| `easings` | 229 | 155 | 74 | 67.7 % |
| `full-timeline` | 280 | 170 | 110 | 60.7 % |
| `index` | 135 | 107 | 28 | 79.3 % |
| `inertia` | 230 | 149 | 81 | 64.8 % |
| `interpolate` | 131 | 92 | 39 | 70.2 % |
| `motion-path` | 82 | 54 | 28 | 65.9 % |
| `props` | 142 | 96 | 46 | 67.6 % |
| `scroll` | 55 | 43 | 12 | 78.2 % |
| `scroll-pin` | 174 | 97 | 77 | 55.7 % |
| `spring` | 136 | 113 | 23 | 83.1 % |
| `stagger` | 105 | 85 | 20 | 81.0 % |
| `timeline` | 134 | 95 | 39 | 70.9 % |
| Total | 2412 | 1684 | 728 | 69.8 % |

Survivors by line (`line (change)`), open work:

`async.ts`: 53 (true -> false); 63 (true -> false); 89 (true -> false); 121 (< -> <=, || -> &&); 123 (true -> false); 151 (! removed, 0 -> 1); 179 (false -> true); 213 (true -> false).
`bezier.ts`: 12 (* -> +, 3 -> 4, * -> +, + -> -, 2 -> 3, * -> +, * -> +, + -> -); 15 (< -> <=, 0 -> 1, 8 -> 9); 17 (< -> <=); 19 (< -> <=); 20 (-= -> +=); 22 (0 -> 1); 23 (1 -> 2); 25 (0 -> 1, < -> <=, && -> ||, 40 -> 41, - -> +, > -> >=); 26 (< -> <=); 28 (2 -> 3, + -> -).
`control.ts`: 38 (false -> true); 60 (true -> false); 66 (|| -> &&, < -> <=); 73 (&& -> ||); 98 (! removed, && -> ||, ! removed, true -> false); 112 (|| -> &&); 116 (!== -> ===, false -> true); 118 (&& -> ||, false -> true); 125 (=== -> !==, && -> ||); 128 (< -> <=, || -> &&, || -> &&, * -> +); 132 (true -> false); 142 (! removed, 0 -> 1).
`custom-ease.ts`: 34 (1 -> 2, < -> <=, 0 -> 1, - -> +); 32 (- -> +); 36 (- -> +, 1 -> 2, 2 -> 3); 35 (0 -> 1, 0 -> 1); 37 (1 -> 2, 1 -> 2, - -> +, * -> +, 1 -> 2, <= -> <); 38 (0 -> 1, < -> <=, - -> +, 1 -> 2); 39 (0 -> 1); 40 (+ -> -, 1 -> 2); 47 (> -> >=, 3 -> 4); 44 (+ -> -, 1 -> 2); 48 (* -> +); 49 (* -> +); 58 (- -> +); 61 (<= -> <); 72 (|| -> &&); 78 (< -> <=, 3 -> 4); 81 (> -> >=); 83 (< -> <=, > -> >=); 86 (1 -> 2); 117 (- -> +); 118 (3 -> 4, - -> +, 3 -> 4, - -> +); 122 (<= -> <); 123 (>= -> >, 1 -> 2); 131 (- -> +); 133 (3 -> 4, 3 -> 4); 147 (true -> false); 158 (0 -> 1); 169 (1 -> 2); 170 (1 -> 2, < -> <=); 177 (<= -> <); 172 (> -> >=); 178 (1 -> 2); 190 (>= -> >); 193 (|| -> &&); 194 (> -> >=); 196 (< -> <=, 2 -> 3); 204 (1 -> 2); 205 (0 -> 1, 1 -> 2).
`damp.ts`: 5 (700 -> 701); 8 (1 -> 2); 15 (> -> >=); 12 (0 -> 1); 17 (0 -> 1, || -> &&); 18 (0 -> 1); 31 (4 -> 5); 30 (4 -> 5); 40 (< -> <=); 44 (|| -> &&); 104 (> -> >=); 112 (< -> <=); 120 (< -> <=, 0 -> 1); 122 (* -> +, >= -> >); 121 (> -> >=); 124 (< -> <=); 125 (1 -> 2); 130 (< -> <=); 133 (> -> >=); 138 (1 -> 2); 139 (1 -> 2); 145 (< -> <=); 147 (0 -> 1); 150 (0 -> 1, < -> <=).
`easings.ts`: 11 (2 -> 3, < -> <=, 2 -> 3); 20 (* -> +, 1 -> 2, - -> +, 10 -> 11, 10 -> 11, 2 -> 3); 24 (< -> <=, * -> +); 25 (< -> <=); 26 (* -> +, + -> -, -= -> +=, < -> <=, * -> +); 64 (20 -> 21, 2 -> 3, 2 -> 3, - -> +, * -> +, 2 -> 3, 10 -> 11, - -> +, < -> <=, + -> -, * -> +, 2 -> 3, 2 -> 3, 20 -> 21, 10 -> 11); 71 (< -> <=, - -> +, - -> +, 2 -> 3, 2 -> 3); 80 (2 -> 3, 2 -> 3, 1 -> 2, 2 -> 3, 2 -> 3, * -> +, + -> -, * -> +, - -> +); 78 (* -> +); 79 (< -> <=); 81 (1 -> 2, + -> -, 2 -> 3, * -> +, * -> +, 2 -> 3, - -> +, 2 -> 3, + -> -); 100 (|| -> &&, > -> >=, < -> <=, || -> &&, 1 -> 2); 109 (<= -> <); 110 (1 -> 2, >= -> >); 124 (< -> <=, 1 -> 2); 127 (>= -> >, 0 -> 1, < -> <=, 0 -> 1, 0 -> 1); 128 (1 -> 2, > -> >=).
`full-timeline.ts`: 29 (|| -> &&); 39 (false -> true); 43 (0 -> 1); 44 (false -> true); 47 (1 -> 2); 52 (false -> true); 53 (false -> true); 57 (|| -> &&, || -> &&, || -> &&); 56 (false -> true); 66 (true -> false); 85 (! removed); 87 (true -> false); 104 (|| -> &&); 105 (+ -> -, 2 -> 3); 110 (- -> +); 121 (1 -> 2, 1 -> 2); 122 (=== -> !==, 0 -> 1, || -> &&, === -> !==, 1 -> 2); 131 (0 -> 1); 132 (1 -> 2); 139 (|| -> &&); 149 (0 -> 1); 157 (0 -> 1); 170 (=== -> !==, && -> ||, ! removed); 172 (false -> true); 180 (1 -> 2); 184 (0 -> 1); 190 (0 -> 1, 0 -> 1); 191 (0 -> 1); 192 (&& -> ||, 1 -> 2, 2 -> 3, 1 -> 2, < -> <=, 0 -> 1); 200 (- -> +); 206 (false -> true, false -> true, > -> >=); 214 (=== -> !==, && -> ||, ! removed); 218 (false -> true); 222 (1 -> 2, >= -> >, 0 -> 1); 230 (true -> false); 232 (1 -> 2, >= -> >, 0 -> 1); 234 (< -> <=, && -> ||); 237 (0 -> 1); 240 (< -> <=, || -> &&); 241 (< -> <=, - -> +); 242 (0 -> 1, true -> false); 253 (> -> >=, && -> ||, < -> <=, && -> ||, >= -> >); 256 (0 -> 1, - -> +, * -> +); 257 (< -> <=); 263 (0 -> 1, 0 -> 1, 0 -> 1); 265 (>= -> >); 268 (0 -> 1, 0 -> 1, - -> +, 1 -> 2); 269 (* -> +); 270 (&& -> ||, 2 -> 3, 1 -> 2, 1 -> 2, * -> +, < -> <=, 0 -> 1); 271 (- -> +, * -> +); 272 (- -> +, - -> +); 273 (|| -> &&); 274 (true -> false); 276 (< -> <=); 284 (>= -> >, - -> +); 299 (! removed); 301 (> -> >=); 306 (true -> false); 312 (> -> >=, false -> true); 317 (0 -> 1, 0 -> 1).
`index.ts`: 13 (3 -> 4, 2 -> 3, * -> +, * -> +, * -> +, - -> +); 15 (< -> <=, 3 -> 4); 76 (=== -> !==, false -> true); 84 (|| -> &&); 85 (|| -> &&); 86 (|| -> &&); 87 (|| -> &&); 122 (0 -> 1, 1 -> 2); 142 (&& -> ||, === -> !==, false -> true); 149 (0 -> 1); 150 (1 -> 2); 183 (true -> false); 208 (1 -> 2, 0 -> 1); 214 (1 -> 2); 216 (0 -> 1); 246 (! removed, 0 -> 1).
`inertia.ts`: 10 (|| -> &&, || -> &&, || -> &&, <= -> <, 2 -> 3, < -> <=, || -> &&, > -> >=, 1024 -> 1025); 9 (32 -> 33); 17 (|| -> &&, 1 -> 2); 19 (1 -> 2, 1 -> 2); 21 (> -> >=, 1 -> 2, 0 -> 1); 25 (0 -> 1); 29 (|| -> &&, || -> &&); 30 (> -> >=); 32 (- -> +); 34 (0 -> 1); 33 (0 -> 1); 36 (- -> +, - -> +); 40 (> -> >=, 0 -> 1); 118 (true -> false); 123 (|| -> &&, < -> <=, 0 -> 1); 129 (false -> true); 132 (|| -> &&, || -> &&, * -> +); 135 (true -> false); 137 (10 -> 11); 146 (>= -> >, <= -> <, && -> ||, <= -> <); 147 (< -> <=, > -> >=); 148 (0 -> 1); 149 (|| -> &&); 152 (|| -> &&); 156 (true -> false, false -> true); 170 (|| -> &&, || -> &&, || -> &&, || -> &&, <= -> <, 0 -> 1, > -> >=); 171 (|| -> &&, || -> &&, || -> &&); 173 (10 -> 11); 175 (|| -> &&); 181 (&& -> ||, && -> ||); 183 (- -> +, < -> <=); 188 (|| -> &&, || -> &&, > -> >=, 0 -> 1); 189 (- -> +); 190 (! removed, * -> +, > -> >=, 0 -> 1); 191 (+ -> -, + -> -, || -> &&, * -> +); 192 (* -> +, 0 -> 1, * -> +).
`interpolate.ts`: 28 (0 -> 1, + -> -, * -> +, * -> +, 1 -> 2, + -> -, 2 -> 3, * -> +); 29 (< -> <=); 36 (1 -> 2, - -> +); 38 (< -> <=); 44 (0 -> 1, + -> -); 45 (1 -> 2, + -> -); 46 (+ -> -); 48 (|| -> &&, 1 -> 2); 49 (0 -> 1); 51 (2 -> 3); 68 (1 -> 2); 71 (> -> >=); 84 (2 -> 3, < -> <=, 0 -> 1, || -> &&, 0 -> 1); 86 (0 -> 1); 88 (+ -> -, 0 -> 1); 90 (1 -> 2); 91 (- -> +); 95 (- -> +, 1 -> 2); 97 (1 -> 2); 98 (+ -> -, 2 -> 3); 99 (< -> <=).
`motion-path.ts`: 64 (0 -> 1); 57 (16 -> 17); 56 (9 -> 10); 70 (15 -> 16, 1 -> 2); 78 (0 -> 1, 0 -> 1, 0 -> 1, 0 -> 1, 0 -> 1, 1 -> 2, 0 -> 1, 0 -> 1); 85 (< -> <=, 3 -> 4); 87 (3 -> 4, < -> <=); 118 (true -> false); 122 (0 -> 1, > -> >=); 126 (0 -> 1, 0 -> 1, 0 -> 1, 0 -> 1, 1 -> 2, 0 -> 1, 0 -> 1, 0 -> 1).
`props.ts`: 69 (>= -> >); 71 (1 -> 2, 1 -> 2); 72 (0 -> 1, || -> &&, 1 -> 2); 74 (1 -> 2); 78 (&& -> ||); 84 (< -> <=, 0 -> 1); 87 (< -> <=); 88 (> -> >=); 136 (!== -> ===); 137 (< -> <=, 2 -> 3); 140 (0 -> 1); 141 (1 -> 2); 142 (0 -> 1); 143 (0 -> 1, < -> <=); 146 (|| -> &&, < -> <=, || -> &&, > -> >=, 1 -> 2, || -> &&); 147 (+ -> -, < -> <=, - -> +, - -> +); 149 (!== -> ===); 163 (0 -> 1, > -> >=); 164 (1 -> 2, 1 -> 2, < -> <=); 166 (0 -> 1, > -> >=, 0 -> 1, < -> <=, 1 -> 2, 1 -> 2, 1 -> 2); 168 (0 -> 1, > -> >=); 172 (true -> false).
`scroll.ts`: 57 (0 -> 1); 72 (1 -> 2); 95 (0 -> 1); 94 (0 -> 1); 105 (0 -> 1); 111 (< -> <=); 112 (0 -> 1); 122 (&& -> ||); 130 (true -> false); 136 (0 -> 1); 142 (true -> false); 148 (true -> false).
`scroll-pin.ts`: 53 (1 -> 2); 60 (0 -> 1); 61 (|| -> &&, 1 -> 2); 63 (- -> +); 64 (> -> >=, >= -> >, <= -> <); 65 (> -> >=, 1 -> 2, - -> +, 0 -> 1, 0 -> 1); 66 (< -> <=); 73 (|| -> &&); 75 (!== -> ===); 79 (+ -> -); 83 (false -> true, 0 -> 1, 0 -> 1, 0 -> 1, 0 -> 1); 84 (0 -> 1, 0 -> 1, false -> true, 0 -> 1); 85 (false -> true, 0 -> 1, 0 -> 1, 0 -> 1); 88 (false -> true); 90 (<= -> <, || -> &&, 0 -> 1); 92 (+ -> -, - -> +); 93 (=== -> !==); 98 (> -> >=, 1 -> 2); 105 (0 -> 1); 106 (0 -> 1); 110 (* -> +); 113 (0 -> 1); 118 (0 -> 1); 126 (- -> +, 0 -> 1, 0 -> 1, 1000 -> 1001); 127 (- -> +); 128 (false -> true); 129 (>= -> >, && -> ||, <= -> <); 131 (- -> +, > -> >=); 136 (3 -> 4); 138 (1 -> 2, false -> true); 140 (+ -> -, - -> +, * -> +); 141 (< -> <=, - -> +); 142 (&& -> ||, !== -> ===, 0 -> 1); 146 (<= -> <, 1 -> 2); 148 (- -> +); 160 (0 -> 1); 158 (true -> false); 186 (true -> false); 174 (0 -> 1, false -> true); 187 (true -> false); 188 (true -> false); 189 (true -> false).
`spring.ts`: 31 (> -> >=, > -> >=, 1 -> 2, > -> >=); 30 (1 -> 2); 35 (< -> <=); 78 (14 -> 15); 81 (0 -> 1); 82 (<= -> <); 83 (0 -> 1, || -> &&, < -> <=); 101 (<= -> <, <= -> <); 109 (< -> <=); 111 (+ -> -, + -> -); 113 (0 -> 1); 133 (* -> +, 1 -> 2); 135 (* -> +); 136 (- -> +); 139 (* -> +).
`stagger.ts`: 44 (> -> >=, 1 -> 2, 0 -> 1); 45 (1 -> 2, + -> -); 63 (< -> <=); 87 (1 -> 2); 96 (< -> <=, || -> &&, 0 -> 1); 103 (0 -> 1, < -> <=, > -> >=, 0 -> 1); 105 (&& -> ||, || -> &&, > -> >=, 0 -> 1); 114 (- -> +); 184 (9 -> 10).
`timeline.ts`: 67 (false -> true); 70 (false -> true); 75 (|| -> &&, !== -> ===); 76 (|| -> &&); 100 (|| -> &&); 106 (1 -> 2); 127 (|| -> &&, 0 -> 1, || -> &&, < -> <=, || -> &&); 130 (0 -> 1); 156 (> -> >=); 153 (false -> true); 154 (0 -> 1); 178 (false -> true); 180 (> -> >=, 0 -> 1); 187 (1 -> 2, 0 -> 1, >= -> >); 189 (< -> <=); 199 (1 -> 2, 1 -> 2); 200 (1 -> 2, >= -> >); 218 (* -> +, > -> >=); 219 (false -> true); 230 (> -> >=); 231 (> -> >=, && -> ||); 232 (< -> <=, && -> ||, >= -> >); 235 (true -> false); 236 (> -> >=, 0 -> 1).
