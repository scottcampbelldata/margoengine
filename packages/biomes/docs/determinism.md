# @margoengine/biomes: Same seed, same bytes, everywhere

The integer toolkit that makes every output byte-identical on every machine. One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

## Same seed, same bytes, everywhere

Everything that decides the output is integer arithmetic: fixed-point values, integer square roots, CORDIC
trigonometry, table logarithms and PCG hashes. No `Math.sin`, `Math.exp` or float rounding decides anything, so a world
gives byte-identical layers in every browser, in Node, on the main thread or in a worker. The helpers are public, so
your own rules can follow the same contract (entry `/toolkit`).

The golden digests run on Linux, macOS and Windows in `.github/workflows/biomes-digests.yml`. The tests are also
mutation-tested with a small runner in the repository (`node scripts/mutation.mjs biomes`): 82.3 % of the `fixed.ts`
mutants are killed (all 487), 80.8 % of `classify.ts` (all 501) and 62.0 % of a `placement.ts` sample, measured before
its new tests. The surviving mutants are listed with their lines and reasons in `docs/mutation.md`.

```ts
import { ONE, atan2, hash3, qexp2, qlog2, qmul, sincos } from '@margoengine/biomes/toolkit';

const half = ONE / 2; // 0.5 in Q16.16
const quarter = qmul(half, half); // 16384, exactly 0.25
const log = qlog2(8 * ONE); // 3.0 in Q16.16 (196608)
const grown = qexp2(log); // 8.0 again (524288)
const angle = atan2(1, 1); // a 32-bit binary angle: 2^29, an eighth of a turn
const [cos, sin] = sincos(angle, [0, 0]); // both about 0.7071 in Q16.16
const roll = hash3(7, 12, -4); // a u32 from (seed, x, z): the same number on every machine
console.log(quarter, log, grown, cos, sin, roll);
```

| Helper | What it computes | Accuracy |
| --- | --- | --- |
| `qmul(a, b)`, `mulShift(a, b, s)`, `mul64(a, b)` + `mulHigh()` | Q16.16 product, `floor(a b / 2^s)`, the full signed 64-bit product | exact |
| `idiv(a, b)`, `imod(a, b)`, `udiv`, `umod` | i32 and u32 division and remainder with WGSL's rules: `x / 0` is `x`, `x % 0` is 0, `-2^31 / -1` is `-2^31` | exact |
| `divWide(n, d)`, `divFloor(n, d)`, `qdiv(a, b)` | truncated and floor division of integers up to 2^53; Q16.16 quotient (same zero rule) | exact |
| `isqrt(n)`, `qsqrt(x)` | `floor(sqrt(n))` for n up to 2^52; Q16.16 square root | exact; 1 unit |
| `qlog2(x)`, `qexp2(x)`, `qpow(x, y)` | binary logarithm by repeated squaring; table plus series exponent | 6 units; 1 unit relative |
| `atan2(y, x)`, `sincos(angle, out)` | CORDIC, angles as 32-bit binary angles (2^32 is a full turn) | about 1e-7 rad; 2 units |
| `degreesToAngle(deg)` | degrees to a binary angle, by plain arithmetic | exact |
| `wendland(r)`, `fade(t)` | Wendland C2 kernel, Perlin's quintic fade, on Q16.16 | 8 units; 2 units |
| `pcg(v)`, `hash2` to `hash5` | PCG output hash and nested multi-input hashes | exact |
| `valueNoise(seed, x, z)`, `fbm(...)`, `ridged(...)` | smooth 2D value noise, its fractal sum, and ridged simplex noise (crests in every direction) in Q16.16 | exact |

Q16.16 means an i32 where 65,536 (`ONE`) is 1.0. Division follows WGSL's integer rules even for a zero divisor, where
JavaScript's `(x / 0) | 0` would give 0, so the CPU and a GPU kernel can never disagree; the package test bans any other
integer division in its sources. Every helper's result is checked against a BigInt model of the same
algorithm and against float references in the package tests.
