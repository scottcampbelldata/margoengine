# @margoengine/wfc

Seeded 3D Wave Function Collapse with weighted entropy, six-direction adjacency, pinned cells and bounded restart attempts.

```ts
import {WFC} from '@margoengine/wfc';
const generator = new WFC([4,4,4], [{neighbors: [[0],[0],[0],[0],[0],[0]]}]);
const cells = generator.solve(123);
```

Tile IDs are 0..31; output is a flattened Uint8Array with X fastest, then Y, then Z. Directions are +X, -X, +Y, -Y, +Z, -Z. Adjacency must be reciprocal. solve(seed, pins, attempts) retries contradictions deterministically and throws when the bounded budget is exhausted. This is local WFC propagation with restart, not an exhaustive backtracking solver or a guaranteed connected-dungeon generator; connectivity belongs in the tile rules and caller validation.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/wfc

