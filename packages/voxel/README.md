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
