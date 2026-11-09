# @margoengine/wfc

Import `margoengine/wfc` from the `margoengine` package, or `@margoengine/wfc` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Seeded 3D Wave Function Collapse with weighted entropy, six-direction adjacency, pinned cells and bounded restart attempts.

```ts
import {WFC} from 'margoengine/wfc';
const generator = new WFC([4,4,4], [{neighbors: [[0],[0],[0],[0],[0],[0]]}]);
const cells = generator.solve(123);
```

Tile IDs are 0..31; output is a flattened Uint8Array with X fastest, then Y, then Z. Directions are +X, -X, +Y, -Y, +Z, -Z. Adjacency must be reciprocal. solve(seed, pins, attempts) retries contradictions deterministically and throws when the bounded budget is exhausted. This is local WFC propagation with restart, not an exhaustive backtracking solver or a guaranteed connected-dungeon generator; use the optional constraints entry for connected layouts, required paths and count limits. Tile weights must have finite sums and weighted logarithms; overflowing arithmetic is rejected.

## Overlapping model (`@margoengine/wfc/overlapping`, 2,457 B min+gzip)

Learns N x N patterns from a sample image and generates outputs in which every N x N window appears in the sample.

```ts
import {OverlappingModel} from 'margoengine/wfc/overlapping';
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
Limits: at most 4096 patterns, rejected during extraction before retaining a 4097th distinct pattern,
and `cells x patterns` <= 4,194,304 (memory: 18 bytes per cell and pattern); the
min-entropy scan is O(cells) per choice, fine to about 128 x 128; CPU only; works identically beside WebGPU and WebGL2 (tested in a real browser).
Example: `examples/overlapping.html`.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/wfc


## Fixed entrances and floors

Overlapping pins use output pixel coordinates and original sample values. Every covering pattern is restricted before
search, including the final N-1 pixels and periodic seams; backtracking cannot undo those restrictions.

```ts
import {OverlappingModel} from '@margoengine/wfc/overlapping';
const model = new OverlappingModel({data: [0,0,0,0], width: 2, height: 2}, {N: 2});
const image = model.solve(16, 12, {
  seed: 7,
  pins: [{position: [15, 0], value: 0}],
  ground: {value: 0, rows: 2},
});
console.log(image[15], image.at(-1));
```

Defaults: pins empty, ground absent, ground.rows 1, signal absent. Ground fixes the bottom image rows, and does not
forbid the value elsewhere. Pins and ground may coexist; conflicts or values absent from the sample exhaust the bounded
search and throw coded failed with a help link. Invalid coordinates/rows throw RangeError. A pre-aborted AbortSignal
throws its reason; synchronous checkpoints cannot receive new events while JavaScript owns the thread. No GPU resources
or shaders are used. Existing attempt/backtrack and memory limits apply. Generated binary/maze samples are stand-ins.
Heap/chunk backend selection and the paired Rust/Wasm SIMD measurement are documented below. Pattern extraction and the existing overlapping solver remain TypeScript.

## Global constraints (`@margoengine/wfc/constraints`, 2,484 B min+gzip)

```ts
import {ConstrainedWFC} from '@margoengine/wfc/constraints';
const ids = [0, 1]; // wall, walkable floor
const model = new ConstrainedWFC([4, 3, 1], ids.map(() => ({
  neighbors: Array.from({length: 6}, () => ids),
})), {
  connected: [1],
  paths: [{from: [0, 0, 0], to: [3, 2, 0], tiles: [1]}],
  counts: [{tiles: [1], min: 8, max: 8}],
});
const cells = model.solve({seed: 7}); // Uint16Array, X then Y then Z
console.log(cells[0], cells[11], model.stats.backtracks);
```

Local reciprocal adjacency, group counts and potential reachability propagate together during chronological backtracking.
A returned layout satisfies every constraint. Connected means one nonempty six-neighbour component containing every cell
using that tile group. Each path forces its endpoints to its own walkable group and requires a six-neighbour route between
them. These are authored logical traversability rules; they do not infer avatar clearance, doors, jump physics or geometry.
No external validator, callback or caller repair is needed. Exhaustive binary 3x2 truth tables test satisfiable and
unsatisfiable combinations of counts, connectivity and corner paths; larger generated cases exercise backtracking.

Defaults: connected absent, paths/counts empty; count min 0, max cell count; solve seed 1, pins empty, backtracks 10,000
per attempt, attempts 4, signal absent. Counts group distinct tile IDs and include pinned/path endpoint cells. Input grids,
adjacency and constraint groups are copied. Limits: 1..4096 tile IDs, 1,000,000 cells, 16,777,216 cell/tile pairs;
Uint16 output removes the legacy root's 32-tile limit for this optional solver. Invalid inputs throw TypeError/RangeError;
unsatisfiable or budget-exhausted searches throw coded failed with a help link. Satisfiable inputs can exhaust the budget.
The entropy pick scans the grid; this entry does not promise fast large worlds. Domains and the undo trail scale with
cell/tile pairs; connectivity scratch scales with cells. CPU only, tested beside real WebGPU and WebGL2 contexts with
identical seeded output. AbortSignal checks are synchronous and cannot receive new events on the blocked thread.

## Sockets and rotations (optional wfc/sockets, 776 B min+gzip)

```ts
import {buildSocketTiles} from 'margoengine/wfc/sockets';
import {ConstrainedWFC} from 'margoengine/wfc/constraints';
const tiles = buildSocketTiles([
  {sockets: ['road','road','air','air','air','air']},
  {sockets: ['road','air','air','air','road','air']},
]);
const cells = new ConstrainedWFC([4, 1, 4], tiles).solve({seed: 7});
const first = tiles[cells[0]];
console.log(first.source, first.rotation, cells.length);
```

Six socket strings describe +X, -X, +Y, -Y, +Z, -Z. Opposite labels must be exactly equal; empty strings match too.
Labels represent orientation-independent connectors, not textured face patterns or gendered plugs. Default rotations
are four proper +Y-axis orientations; cube selects all 24 proper cube rotations, none selects identity. Identity is
first, followed by stable signed-axis enumeration. No reflections or symmetry deduplication. Each source weight
(default 1) is divided across its orientations, preserving total source frequency within floating-point rounding.
The quotient must remain positive in float64: a weight that rounds to zero after division by 4 or 24 is rejected
with RangeError. `Number.MIN_VALUE` is accepted with `rotations: 'none'`. Source weights at or below
`2 * Number.MIN_VALUE` for y or `12 * Number.MIN_VALUE` for cube round to zero per variant and are rejected;
`4 * Number.MIN_VALUE` and `24 * Number.MIN_VALUE`, respectively, split exactly into `Number.MIN_VALUE` variants.
Metadata gives the source index,
rotated sockets and a column-major 3x3 rotation to apply to geometry. Inputs are copied.

Up to 4096 expanded variants, checked before adding a source's orientations, Uint16 IDs through ConstrainedWFC;
legacy root WFC remains 32 IDs. Socket source arrays and all six string labels must be dense. Adjacency building
is O(variants squared), with six lists per variant; invalid inputs throw RangeError. Solver budgets and memory limits
still apply. Pure CPU, identical on WebGPU and WebGL2 pages. Generated 48-variant tests are stand-ins; no artist
asset compatibility claim. This entry builds rules only and imports no solver or rendering backend.

`npm run test:gpu --workspace @margoengine/wfc` runs the overlapping solver beside WebGPU and WebGL2. Its server resolves the repository root from the script location, so workspace execution uses the same imports, and teardown closes the browser and server together.

## Large outputs and chunks (optional wfc/chunks, 3,647 B min+gzip)

```ts
import {ChunkedWFC, HeapWFC} from 'margoengine/wfc/chunks';
const tiles = [0,1].map(() => ({neighbors: Array.from({length:6}, () => [0,1])}));
const large = await HeapWFC.create([192,192,1], tiles);
console.log(large.solve({seed:7}).length, large.backend);
using world = new ChunkedWFC([16,16,1], tiles, 7);
const left = await world.solveChunk([-1,0,0]);
const right = await world.solveChunk([0,0,0]);
console.log(left.length, right.length, world.size);
```

HeapWFC uses indexed binary-heap selection, bitset propagation and fixed seeded per-cell tie keys. A domain change
updates one heap position in O(log cells), without stale heap entries. This is a new seed algorithm; root,
overlapping and constraints seed streams keep their previous behavior. Local adjacency and pins only; it uses
bounded restarts, without global counts/connectivity or chronological backtracking. Defaults: seed 1, attempts 4
(1..64), pins empty, signal absent. Grid limits: 1..4096 IDs, <=1,000,000 cells, <=16,777,216 cell/tile pairs.
Invalid inputs throw RangeError/TypeError; exhausted attempts throw coded failed with a help link.
All WFC entries reject holes in dimensions, coordinates, pins, rules and constraint lists before search;
all three dimensions and their safe integer product are validated before grid allocation.

Constructor HeapWFC is synchronous TypeScript. Async HeapWFC.create defaults to backend auto: lazily loads the
feature's own Rust/Wasm SIMD artifact for <=32 unit-weight tiles, using new URL relative to the module; wider or
weighted sets use TypeScript. Explicit typescript forces JS; explicit wasm rejects ineligible sets or missing SIMD
with coded unsupported and a help link. Load accepts AbortSignal; network, response-body, local-file and
instantiation failures are coded failed with a help link and the original cause. Abort throws the exact signal
reason. Build inputs and
artifact hashes live in native/solver, rebuild with node packages/wfc/scripts/build-wasm.mjs (Rust wasm32 target).
No shared Wasm bundle, core/stage import or import-time loading. Both implementations perform the same local solve
and produce identical IDs for identical seeds; benchmark decision is recorded below. Browser WebGPU and WebGL2 use
the same CPU code. Synchronous solving checks cancellation but cannot receive new events while blocking its thread.
Wasm work statistics use 32-bit counters (wrap above 4,294,967,295); measured fixtures stay below that bound.

ChunkedWFC solves a one-cell halo constrained by all previously committed neighbouring cells, then commits only the
interior. Every successful seam satisfies the tile rules. Coordinates, world cell bounds and halo bounds must be safe
integers; negative and distant addresses work. Grid/pair limits include the halo (each dimension plus 2). Chunk seed
is the world seed mixed with all coordinate halves; generation is reproducible for the same solve order. Order can
change layouts, and arbitrary rules may make a later chunk impossible: it throws rather than editing old chunks.
There is no global playability guarantee across chunks. Calls must be serial; concurrent generation/clear throws
coded failed. Cached outputs are copies. Storage grows with visited chunks; clear, dispose and Symbol.dispose release
it. Failed or aborted calls commit nothing. The world seed defaults to 1; solveChunk takes backend auto, attempts 4 and
signal absent. No hidden eviction, caller-authored boundary rules or caller repair is required.

Rust/Wasm SIMD is selected for eligible sets because it was faster in every paired round on both the 192x192 open and 64x64x4 parity fixtures, with identical output hashes and work counts. The seven rounds interleave three runs per implementation and compare per-round minima. This is loaded SCOTT-DEV evidence, not a release speed claim; wider/weighted cases retain TypeScript because the measured Rust path supports only <=32 unit-weight IDs. See docs/whitepaper/results/batch-69-heap.json.

## Worker solving (optional wfc/worker, 1,331 B min+gzip)

```ts
import {WFCWorkerSolve} from 'margoengine/wfc/worker';
const tiles = [0,1].map(() => ({neighbors: Array.from({length:6}, () => [0,1])}));
const controller = new AbortController();
using job = new WFCWorkerSolve([64,64,1], tiles, {seed:7, signal:controller.signal});
const progress = (async () => {
  for await (const work of job) document.body.dataset.wfcDecisions = String(work.decisions);
})();
const cells = await job.result;
await progress;
console.log(cells.length); // 4096. controller.abort(reason) terminates an active worker.
```

One dedicated classic Web Worker runs the same HeapWFC algorithm and the same eligible Rust SIMD artifact as chunks.
Rules, dimensions and pins are structured-cloned; the resulting Uint16Array transfers back without a copy. Construction
starts the worker immediately. No grid validation, heap construction or search runs on the calling thread; cloning
large input rules still has a cost. Auto, typescript and wasm have the same selection rules as HeapWFC.create, preserving
its seed stream exactly. This entry solves local adjacency and pins; it does not run the overlapping/global solvers or
maintain a chunk cache. Existing grid, tile, pair and restart limits apply.

Defaults: seed 1, pins empty, attempts 4, backend auto, signal absent, timeout 60000 ms including startup/downloads.
Timeout must be an integer from 1 to 2147483647 ms. Progress is a single-consumer async iterable of actual cumulative
decisions, heap updates, intersections, current attempt and selected backend, emitted during both TS and synchronous
Wasm work and once at completion. It is not a percentage: restarts can revisit cells. Slow readers retain only the latest
snapshot, so memory stays bounded. Completion closes the stream; always await result to observe errors. Stopping progress
iteration leaves the solve running. Abort, timeout and dispose terminate the worker, remove listeners and close progress.
Abort rejects with the signal reason, timeout with coded timeout, disposal with coded disposed. Dispose/Symbol.dispose
are idempotent. Crashes, message and clone failures reject with coded failed; solver TypeError/RangeError and coded
errors survive transport. Coded errors carry a help link. A pre-aborted signal starts no worker.

Browser WebGPU and WebGL2 both run real solves while submitting rendered animation frames, with in-flight progress,
abort and synchronous parity checks. There is no GPU work in the solver and no shared-memory/isolation requirement.
Node/SSR imports are safe; construction throws coded unsupported there (use HeapWFC). CSP must allow the same-origin
worker asset and Wasm where selected. No Blob, eval or caller-authored worker is needed. The optional entry downloads
workers/wfc.js only when constructed, and wfc.wasm only for an eligible backend; it imports no rendering backend.
