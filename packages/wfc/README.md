# @margoengine/wfc

Seeded 3D Wave Function Collapse with weighted entropy, six-direction adjacency, pinned cells and bounded restart attempts.

```ts
import {WFC} from '@margoengine/wfc';
const generator = new WFC([4,4,4], [{neighbors: [[0],[0],[0],[0],[0],[0]]}]);
const cells = generator.solve(123);
```

Tile IDs are 0..31; output is a flattened Uint8Array with X fastest, then Y, then Z. Directions are +X, -X, +Y, -Y, +Z, -Z. Adjacency must be reciprocal. solve(seed, pins, attempts) retries contradictions deterministically and throws when the bounded budget is exhausted. This is local WFC propagation with restart, not an exhaustive backtracking solver or a guaranteed connected-dungeon generator; connectivity belongs in the tile rules and caller validation.

## Overlapping model (`@margoengine/wfc/overlapping`, 1.9 kB min+gzip)

Learns N x N patterns from a sample image and generates outputs in which every N x N window appears in the sample.

```ts
import {OverlappingModel} from '@margoengine/wfc/overlapping';
// 0 floor, 1 wall, 2 door; any numbers work (palette indices, packed RGBA).
const rows = ['11111111', '10000101', '10000201', '11211111', '10000001', '11111111'];
const model = new OverlappingModel({data: rows.join('').split('').map(Number), width: 8, height: 6}, {N: 3, symmetry: 8});
const image = model.solve(64, 40, {seed: 7, periodic: false});   // Float64Array of sample values, X fastest
console.log(model.patterns, model.stats.backtracks, model.stats.attempts);
```

Options: `N` 2..5, `periodicInput` (patterns wrap around the sample), `symmetry` 1..8 (rotations and reflections, in
Gumin's order); `solve` takes `seed`, `periodic` output, `backtracks` (per attempt, default 1000) and `attempts`
(default 4). Propagation is arc-consistent (supporter counts per cell, pattern and direction). On a contradiction the
latest choice is undone from the trail and forbidden in its cell (chronological backtracking); past the budget the
attempt restarts from scratch with the seed stream continuing; when the attempts run out `solve` throws. Every loop is
bounded by the budgets, so an unsatisfiable sample fails instead of hanging (the tests run one in a child process with a
timeout). A 7 x 7 maze sample with `symmetry: 1` fails every seed without backtracking and solves them all with it.
Limits: at most 4096 patterns and `cells x patterns` <= 4,194,304 (memory: 18 bytes per cell and pattern); the
min-entropy scan is O(cells) per choice, fine to about 128 x 128; no ground/pinning constraints yet; CPU only.
Example: `examples/overlapping.html`.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/wfc

