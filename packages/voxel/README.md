# @margoengine/voxel

Voxel worlds for Minecraft-style games and voxel editors: a block-type registry, 32 x 32 x 32 palette chunks with a
light byte per cell, and a chunked world with dirty tracking and change events. This release is the storage layer;
meshing, rendering, light, queries, streaming and `.vox` files follow as subpath entries (plan: [DESIGN.md](DESIGN.md)).

```ts
import { BlockTypes, VoxelWorld, VoxelChunk, blockState, blockId, blockData } from '@margoengine/voxel';

const blocks = new BlockTypes(); // id 0 is 'air'
const stone = blocks.define('stone');
const grass = blocks.define('grass', { textures: [2, 2, 0, 1, 2, 2] }); // +x, -x, +y (top), -y, +z, -z layers
const glass = blocks.define('glass', { layer: 'translucent' });
const torch = blocks.define('torch', { shape: 'cross', layer: 'cutout', solid: false, light: 14 });

const world = new VoxelWorld({ blocks });
world.setBlock(0, 64, 0, grass); // adds the chunk if it is not loaded
world.setBlocks([1, 64, 0, stone, 2, 64, 0, glass]); // flat [x, y, z, state, ...]
world.getBlock(0, 64, 0); // grass; unloaded cells read as air (0)

const off = world.onChange((x, y, z, state, previous) => {}); // once per changed cell
for (const key of world.dirty) {
  // 'cx,cy,cz' chunks to remesh: edits, border edits (neighbours too), added and removed chunks
  world.dirty.delete(key);
}

const door = blockState(blocks.define('door'), 3); // id in the low 16 bits, data (e.g. facing) in the high 16
blockId(door);
blockData(door); // 3

// Chunks are plain storage. In a worker: fill one and post it packed.
const chunk = new VoxelChunk(stone); // uniform: stored as its palette alone
chunk.set(5, 31, 5, torch);
const packed = chunk.pack(); // {palette, bits, words, light}: typed arrays that own their buffers
postMessage(packed, [packed.palette.buffer, packed.words.buffer]); // add light.buffer when light is a Uint8Array
// On the main thread:
worker.onmessage = ({ data }) => world.addChunk(0, 1, 0, VoxelChunk.unpack(data));
```

- **Chunks.** Cell `x | z << 5 | y << 10` holds an index into a palette of distinct block states, 0, 1, 2, 4, 8 or 16
  bits wide (an index never straddles a 32-bit word). Palette entries are reference counted: the width grows as
  states appear and narrows again (with hysteresis) as they disappear; one state left makes the chunk uniform.
  `chunk.fill(state)` makes it uniform at once. Light is `sky << 4 | block` per cell (`getLight`, `setLight`), one
  byte for the whole chunk until a cell differs.
- **World.** Cells are 32-bit integer x and z and 16-bit y (`minY`/`maxY` narrow it; heightmaps are int16). Chunk
  coordinates are cell >> 5. `addChunk` and `removeChunk` mark the chunk and its 26 loaded neighbours dirty; a dirty
  key with no chunk was removed. `heightmap(cx, cz)` is the column's 32 x 32 Int16Array that `./light` fills. Edit
  loaded chunks through the world (`chunk.set` on a loaded chunk bypasses dirty tracking and events).
- **Block types.** Options: `textures`, `layer` (`'opaque'`, `'cutout'`, `'translucent'`, `'invisible'`), `shape`
  (`'cube'`, `'cross'`, `'liquid'`), `solid`, `liquid`, `light` and `opacity` (0-15), `color`, `roughness`,
  `metalness`, `emissive`, `animation: {frames, fps}`. `blocks.table` is the resolved list, plain data for workers.
  Ids follow definition order, so define types in the same order wherever saved states are read back.
- **Errors.** `TypeError` for wrong types, `RangeError` for values out of range (cells, states, ids, options),
  `MargoError` `'state'` for a duplicate block name or a chunk that is already loaded.

Measured with Node on one core of the development laptop (2026-10-19; `node --test
packages/voxel/tests/benchmark.test.js` prints yours): chunk get about 120 M/s and set about 27 M/s; world getBlock
about 7 M/s on random cells and 115 M/s along a column; pack + unpack of a 4-bit chunk 0.13 ms.

MIT. Optional, tree-shakable package; core peer ^1.0.0. Build and unit tests: `npm test --workspace @margoengine/voxel`

## Queries: `@margoengine/voxel/query`

Ray casts for picking (`engine.pick` does not see voxels), swept boxes for anything that moves through blocks, and a
player body.

```ts
import { raycastVoxels, sweepBox, VoxelCharacter } from '@margoengine/voxel/query';

const hit = raycastVoxels(world, eye, forward, 8); // {cell, normal, adjacent, point, distance, state} or null
if (hit) world.setBlock(...hit.adjacent, stone); // place against the face; setBlock(...hit.cell, 0) breaks it
raycastVoxels(world, eye, forward, 8, (state, type) => type.liquid); // pick water instead

// An item or a mob: never tunnels, whatever the speed.
const { position, hit: axes, onGround } = sweepBox(world, box, [vx * dt, vy * dt, vz * dt]); // box: {min, max}, a Box3

const player = new VoxelCharacter(world, { stepHeight: 0.6, speeds: { walk: 4.317 } });
player.position = [0.5, 80, 0.5]; // feet; assign again to teleport
player.flying = false;
engine.onFrame((_, dt) => {
  player.update(dt, { direction: [forwardX, 0, forwardZ], jump, descend, sprint });
  const [x, y, z] = player.renderPosition; // interpolated between fixed steps: smooth at any refresh rate
  engine.camera.position = [x, y + 1.62, z];
});
```

- **Ray casts.** Cell by cell (Amanatides and Woo, 1987); a cell is the half-open box `[x, x + 1)` on each axis. A ray
  through an exact edge or corner skips the cells it only touches; a ray in a face plane runs in the cells on the
  plane's positive side; a ray that starts inside a block hits it at distance 0 with normal `[0, 0, 0]`. `point` lies
  exactly on the face (that coordinate is an integer). By default every drawn block except liquids is hit, solid or
  not, and a cross block (flower, torch) is hit as its whole cell; the optional `filter(state, type)` changes that.
- **Sweeps.** `sweepBox` moves along y, then x, then z, each axis stopped by the first solid block (`solid: true`,
  as its whole cell) after scanning every cell layer the move crosses. Touching, or overlapping by up to 1e-6 blocks,
  is not a collision, and a box can leave a block placed inside it. `position` is the box's new min corner; `onGround`
  is true when the downward move was stopped, or with motion y 0, when the box rests on a block.
- **Player body.** `update(dt, intent)` runs fixed 1/120 s steps (the remainder carries over, at most 0.25 s per
  call), so the path is the same at 30, 60 or 144 Hz; `renderPosition` interpolates between the last two steps.
  Walking accelerates and brakes in about 0.15 s on the ground (weakly in the air), falls at `gravity` (default 32
  blocks/s², capped at 78.4 blocks/s) and jumps at `speeds.jump` (9: 1.27 blocks high). It steps onto ledges up to
  `stepHeight` (0.6) only from the ground, when landing or in liquid, and only when the raised body fits under the
  ceiling. Full blocks make ground ledges whole blocks, so 0.6 matters when climbing out of water and for anything
  that leaves the feet off the grid. In a liquid block it swims: slower (`speeds.swim`, 2), buoyant (a fifth of
  gravity), `jump` swims up, and jumping against a wall climbs out onto the bank. `flying` turns gravity off; `jump`
  and `descend` rise and sink at `speeds.fly` (11). Defaults: size `[0.6, 1.8, 0.6]`, walk 4.317, sprint 5.612.

Measured with Node on one core of the development laptop (2026-10-19; `node --test packages/voxel/tests/query.test.js`
prints yours): about 200 rays/ms for 64-block rays over terrain, 600 sweeps/ms for a player box moving one block, and
700 character updates/ms at 60 Hz (two fixed steps each).

## Codecs (`./codec`)

## Codecs and chunk stores (`./codec`, `./stream`)

Bytes for saves and the network, and where unloaded chunks go. Decoders treat their input as hostile: every count
and length is checked against the bytes before it is read or allocated, a deflated chunk stops inflating at the
largest possible chunk (262,148 bytes), and anything malformed throws a `RangeError` naming the problem.

```ts
import { encodeChunk, decodeChunk, encodeBlockChanges, applyBlockChanges, EntityCodec } from '@margoengine/voxel/codec';
import { IndexedDBChunkStore, MemoryChunkStore } from '@margoengine/voxel/stream';

const bytes = await encodeChunk(chunk); // deflate-raw by default; {light: false}, {compress: false}
world.addChunk(cx, cy, cz, await decodeChunk(bytes));

const edits = [];
world.onChange((x, y, z, state) => edits.push(x, y, z, state));
socket.send(encodeBlockChanges(edits)); // sorted, last state per cell, typically 2-4 bytes per change
applyBlockChanges(otherWorld, message); // all or nothing, through setBlocks (dirty marking, change events)

const codec = new EntityCodec({ position: 'position', rotation: 'rotation', health: 'u8', anim: 'u16' });
socket.send(codec.encode(players, acked)); // Maps of u32 id -> entity; only what changed since `acked`
const state = codec.decode(message, received); // `received`: the receiver's copy of `acked`

const store = new IndexedDBChunkStore('world-1'); // or new MemoryChunkStore()
store.put(cx, cy, cz, chunk); // copies the chunk now; puts in one task share one transaction
const saved = await store.get(cx, cy, cz); // a VoxelChunk or undefined; sees uncommitted puts
await store.flush(); // e.g. on visibilitychange: everything committed, or the first failure
```

- **Chunks.** u8 version (1), u8 flags (1 light, 2 dense light, 4 deflated), then (deflate-raw when flagged) a
  varint palette length and states, u8 index bits and the `PackedChunk` words as little-endian u32, and the light:
  one byte when every cell shares it, else 32,768. `encodeChunk` reads the chunk before it returns.
- **Block changes.** A flat `[x, y, z, state, ...]` list in and out (`decodeBlockChanges` returns an Int32Array that
  `setBlocks` takes). Varint count, then per change sorted by chunk and cell index: a varint step (odd: new chunk,
  then three zigzag varint chunk offsets; even: the cell index offset) and a varint state.
- **Entities.** Fields `'position'` (1/512 block, error <= 1/1024, |coordinate| < 2,097,152), `'rotation'`
  (smallest-three in 32 bits: at most 0.28 degrees, about 0.08 on average), `'u8'`, `'u16'`, `'f32'`; up to 32 per
  schema, in the schema's key order. Per entity in id order: varint id offset, varint field mask (0 = removed),
  changed fields. Decoding against a baseline the bytes were not encoded from throws when an entity is missing.
- **Stores.** `ChunkStore` is `get`, `put`, `delete`, `flush` (promises; invalid arguments to put and delete throw
  at the call). `IndexedDBChunkStore(name)` keeps one
  deflated record per chunk keyed `[cx, cy, cz]` in object store `'chunks'`, writes each task's puts and deletes in
  one transaction after the previous one, and reports a failed commit (MargoError `'failed'`) through those puts and
  the next `flush`. `MemoryChunkStore` keeps uncompressed records in memory (tests, servers).

Measured with Node 24 on the development laptop (2026-10-19; `node --test packages/voxel/tests/codec-benchmark.test.js`
prints yours): a surface chunk (4-bit, 7 states, dense sky light) is 49,163 bytes raw and 2,586 deflated (16,395 and
1,876 without light); raw encode about 100 MB/s and decode about 140 MB/s; deflated encode and decode 1-4 ms each,
most of it Node's stream overhead (32 decodes in flight: about 0.7 ms each). 20,000 block changes in 8 chunks: 1.9
bytes each. 1,000 entities: 17,940 bytes in full, 1,796 when 30% moved.
