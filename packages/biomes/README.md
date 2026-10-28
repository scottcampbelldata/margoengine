# @margoengine/biomes

Import `margoengine/biomes` from the `margoengine` package, or `@margoengine/biomes` from this package alone; the two
are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that
work today (run in a clone, or install local tarballs).

A biome map turns a heightmap and a few climate settings into tiled layers: climate fields, biome weights and masks
that terrain, scatter and a terrain editor read. This package is optional and tree-shakable and adds 0 bytes to core
and the stage. It is built in milestones; this release holds the foundation every later part stands on.

## Same seed, same bytes, everywhere

Everything that decides the output is integer arithmetic: fixed-point values, integer square roots, CORDIC
trigonometry, table logarithms and PCG hashes. No `Math.sin`, `Math.exp` or float rounding decides anything, so a world
gives byte-identical layers in every browser, in Node, on the main thread or in a worker. The helpers are public, so
your own rules can follow the same contract.

```ts
import { ONE, atan2, hash3, qexp2, qlog2, qmul, sincos } from '@margoengine/biomes';

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
| `valueNoise(seed, x, z)`, `fbm(...)`, `ridged(...)` | smooth 2D value noise and fractal sums in Q16.16 | exact |

Q16.16 means an i32 where 65,536 (`ONE`) is 1.0. Division follows WGSL's integer rules even for a zero divisor, where
JavaScript's `(x / 0) | 0` would give 0, so the CPU and a GPU kernel can never disagree; the package test bans any other
integer division in its sources. Every helper's result is checked against a BigInt model of the same
algorithm and against float references in the package tests.

## Procedural relief

`createRelief(options)` is a seeded landscape in integer millimetres: fractal lowlands, ridged mountains under a
mountain mask, an optional coast and river valleys. It is the default height of a biome world.

```ts
import { createRelief } from '@margoengine/biomes';

const relief = createRelief({ seed: 7, coast: 'west', rivers: 2 });
const metres = relief.height(120_000, -340_000) / 1000; // world x 120 m, z -340 m
console.log(metres, relief.rivers.length);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `seed` | 1 | u32 seed |
| `size` | [4096, 4096] | extent in metres, each 64..65,536 |
| `origin` | `-size / 2` | minimum corner in metres |
| `base` | 120 | mean lowland height in metres |
| `relief` | 900 | ridge height above the lowland in metres, 0..8,000 |
| `coast` | `'none'` | `'west'`, `'east'`, `'north'` or `'south'`: that side runs into the sea over a 1.5 km shelf |
| `rivers` | 0 | 0..8 river valleys (250 m half width) toward the coast |
| `seaDepth` | 40 | sea floor depth in metres |

`quantizeHeights(floats, unit?)` turns float heights (metres times `unit`) into integer millimetres once, so a
heightmap from any source enters the integer world the same way everywhere.

## The reference world R16

`R16` is the fixed scene of every biomes benchmark and quality report: 16 km by 16 km at 1 m, a western coast, two
river valleys, the temperate, alpine, wetland and boreal presets, about 25 million stored objects at full density. It
is plain frozen data, so the same world can be rebuilt anywhere, `createRelief(R16.relief)` included. The package test
locks its heights with a committed SHA-256 digest.

## Sources

Written clean room from public papers: Volder 1959 (CORDIC), Jarzynski and Olano 2020 (PCG hashes for GPUs), Perlin
2002 (quintic fade), Wendland 1995 (compactly supported kernels). Details in `docs/clean-room.md`.
