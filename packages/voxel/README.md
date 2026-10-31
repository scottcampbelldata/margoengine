# @margoengine/voxel

Import `margoengine/voxel` from the `margoengine` package, or `@margoengine/voxel` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Voxel worlds for Minecraft-style games and voxel editors: a block-type registry, 32 x 32 x 32 palette chunks with a
light byte per cell, and a chunked world with dirty tracking and change events. This release is the storage layer;
meshing, rendering, light, queries, streaming and `.vox` files follow as subpath entries (plan: [DESIGN.md](DESIGN.md)).

```ts
import { BlockTypes, VoxelWorld, VoxelChunk, blockState, blockId, blockData } from 'margoengine/voxel';

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
  (`'cube'`, `'cross'`, `'liquid'`, `'slab'`, `'stair'`), `solid`, `liquid`, `light` and `opacity` (0-15), `color`,
  `roughness`, `metalness`, `emissive`, `animation: {frames, fps}`, `maps: {normal, roughness, emissive}` (texture
  layers), `transmission` and `scatter`. `blocks.table` is the resolved list, plain data for workers.
  Ids follow definition order, so define types in the same order wherever saved states are read back.
- **Slabs and stairs.** Half-block shapes whose orientation is in the block state's data: `slabState(id, top)` (the
  lower half, or the upper half when `top`), `doubleSlabState(id)` (both halves: one block of the slab's material,
  shaped and lit like a cube) and `stairState(id, facing, upsideDown, corner?)` (a lower slab plus the upper quarter on
  its back side, `facing` `'+x'`, `'-x'`, `'+z'` or `'-z'` naming that side; upside down puts the slab on top).
  `connectStairs(world, x, y, z)` turns the stairs in that cell and beside it into the corners their neighbours call
  for: outer when a stair's back meets the side of another stair of the same half (toward that stair's back), inner
  when its front does; a `corner` given to `stairState` (`'straight'`, `'inner+z'`, `'outer-x'`, ...) is kept.
  `waterlogState(state)` waterlogs a slab or stair: the liquid its type names (`waterlog`, a defined liquid's id or
  name) fills the rest of the cell, meshed, lit and swum in like that liquid, while the block keeps colliding.
  `shapeOctants(type, state)` gives the half cells a state fills as an 8-bit mask (bit `x + 2y + 4z`, 255 for a cube).
  They mesh, shade, cast and receive shadows, pass light, collide and pick as those boxes (the sections below), and
  their states go through the codecs unchanged. `opacity` defaults to 0: light is stopped by the faces they cover
  whole, not by a cost.

```ts
import { connectStairs, doubleSlabState, slabState, stairState, waterlogState } from 'margoengine/voxel';

const water = blocks.define('water', { shape: 'liquid', liquid: true, solid: false, layer: 'translucent' });
const slab = blocks.define('stone_slab', { shape: 'slab', textures: stone, waterlog: water });
const stairs = blocks.define('oak_stairs', { shape: 'stair', textures: planks, waterlog: 'water' });
world.setBlock(x, y, z, slabState(slab)); // lower half; slabState(slab, true) is the upper half
world.setBlock(x, y + 1, z, doubleSlabState(slab)); // both halves
world.setBlock(x + 1, y, z, stairState(stairs, '+x')); // climbs toward +x; stairState(stairs, '+x', true) hangs
connectStairs(world, x + 1, y, z); // corners from the neighbouring stairs
world.setBlock(x + 2, y, z, stairState(stairs, '+x', false, 'outer+z')); // a corner by hand, kept
world.setBlock(x, y - 1, z, waterlogState(slabState(slab))); // a slab under water
```
- **Errors.** `TypeError` for wrong types, `RangeError` for values out of range (cells, states, ids, options),
  `MargoError` `'state'` for a duplicate block name or a chunk that is already loaded.

Measured with Node on one core of the development laptop (2026-10-19; `node --test
packages/voxel/tests/benchmark.test.js` prints yours): chunk get about 120 M/s and set about 27 M/s; world getBlock
about 7 M/s on random cells and 115 M/s along a column; pack + unpack of a 4-bit chunk 0.13 ms.

Apache-2.0. Optional, tree-shakable package; core peer ^1.0.0. Build and unit tests: `npm test --workspace @margoengine/voxel`

## Queries: `@margoengine/voxel/query`

Ray casts for picking (`engine.pick` does not see voxels), swept boxes for anything that moves through blocks, and a
player body.

```ts
import { raycastVoxels, sweepBox, VoxelCharacter } from 'margoengine/voxel/query';

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
  not, and a cross block (flower, torch) is hit as its whole cell; the optional `filter(state, type)` changes that. A
  slab or stair is hit where the ray meets its half-block boxes (the walk continues through its open part): `normal`
  is that box face's, `point` lies on it (a multiple of 0.5 there, such as a slab's top at `y + 0.5`).
- **Sweeps.** `sweepBox` moves along y, then x, then z, each axis stopped by the first solid block (`solid: true`,
  as its whole cell, or a slab's or stair's half-block boxes) after scanning every cell layer the move crosses. Touching, or overlapping by up to 1e-6 blocks,
  is not a collision, and a box can leave a block placed inside it. `position` is the box's new min corner; `onGround`
  is true when the downward move was stopped, or with motion y 0, when the box rests on a block.
- **Player body.** `update(dt, intent)` runs fixed 1/120 s steps (the remainder carries over, at most 0.25 s per
  call), so the path is the same at 30, 60 or 144 Hz; `renderPosition` interpolates between the last two steps.
  Walking accelerates and brakes in about 0.15 s on the ground (weakly in the air), falls at `gravity` (default 32
  blocks/s², capped at 78.4 blocks/s) and jumps at `speeds.jump` (9: 1.27 blocks high). It steps onto ledges up to
  `stepHeight` (0.6) only from the ground, when landing or in liquid, and only when the raised body fits under the
  ceiling. Full blocks make ground ledges whole blocks; slabs and stairs make half-block ones, so the default 0.6
  walks up stairs and onto slabs without jumping. In a liquid block it swims: slower (`speeds.swim`, 2), buoyant (a fifth of
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
import { encodeChunk, decodeChunk, encodeBlockChanges, applyBlockChanges, EntityCodec } from 'margoengine/voxel/codec';
import { IndexedDBChunkStore, MemoryChunkStore } from 'margoengine/voxel/stream';

const bytes = await encodeChunk(chunk); // deflate-raw by default; {light: false}, {compress: false}
world.addChunk(cx, cy, cz, await decodeChunk(bytes));

const edits = [];
world.onChange((x, y, z, state) => edits.push(x, y, z, state));
socket.send(encodeBlockChanges(edits)); // sorted, last state per cell, typically 2-4 bytes per change
applyBlockChanges(otherWorld, message); // all or nothing, through setBlocks (dirty marking, change events)

const codec = new EntityCodec({ position: 'position', rotation: 'rotation', health: 'u8', anim: 'u16' });
socket.send(codec.encode(players, acked)); // Maps of u32 id -> entity; only what changed since `acked`
const state = codec.decode(message, received); // `received`: the receiver's copy of `acked`
// A server sending one tick to many receivers quantizes each entity once; encode writes the same bytes from it.
const ready = new Map([...players].map(([id, p]) => [id, codec.prepare(p, id)]));
for (const client of clients) client.send(codec.encode(nearby(client, ready), client.lastSent));

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

## Meshing: `@margoengine/voxel/mesher`

`meshChunk` turns one chunk and the one-cell shell of its neighbours into greedy quads, 12 bytes each, for a renderer
that pulls vertices from a storage buffer. It is pure and synchronous (phase 3 runs it in workers).

```ts
import { meshChunk, meshInput, decodeQuad, blockMaterials, QUAD_WORDS } from 'margoengine/voxel/mesher';

for (const key of world.dirty) {
  const input = meshInput(world, key); // {chunk: packed, shell, light, blocks}; undefined for a removed chunk
  world.dirty.delete(key);
  if (!input) continue; // drop that chunk's mesh
  const mesh = meshChunk(input); // {opaque, cutout, translucent: Uint32Array, visibility}
  for (let i = 0; i < mesh.opaque.length / QUAD_WORDS; i++) decodeQuad(mesh.opaque, i); // {x, y, z, face, w, h, ...}
}
const materials = blockMaterials(blocks.table); // material id per block id * 6 + face
```

- **Faces.** An opaque cube hides every face against it; faces between blocks of the same id (glass and glass, water
  and water, leaves and leaves) are hidden; every other face stays, so stone behind glass keeps its face and the glass
  face against the stone goes. Invisible blocks emit nothing. Slabs and stairs, and cube faces with one within a cell,
  are meshed at half-block resolution: a quarter of a face shows when its block fills the half cell behind it and the
  half cell in front is neither an opaque block's nor the same block's, so a cube beside a slab keeps only its upper
  half face, a slab under a cube hides the cube's bottom only as a top slab, and two slabs side by side hide the faces
  between them. Visible quarters become at most two rectangles per face plane, on the cell's side or (for a slab's top,
  a stair's step and riser) half a block inside it, and merge greedily along every axis they are not trimmed on. A
  waterlogged slab or stair also holds its liquid in its open octants, meshed by the liquid rules per half block (no
  faces against the same liquid beside it, its surface waving with the pool's, sides of lowered water beside a slab cut
  at the water line). A chunk without slabs or stairs meshes to the same bytes as before. `cross` blocks emit two diagonal quads (faces 6 and 7),
  unshaded and lit by their own cell. A `liquid` cell without the same liquid above is a surface: its top and sides
  drop by its state data's low 3 bits in eighths of a block (`blockState(water, level)`) and carry the wave bit; a
  lowered top under a solid block stays, and a side above a lower surface of the same liquid stays.
- **Shading.** Each vertex gets ambient occlusion from the opaque cubes beside it in the face's front layer (0 when both
  edge cells are opaque, else 3 minus the count of edge and diagonal cells; 0fps.net's rule) and smooth light, the
  rounded mean of the open cells around it. The AO picks the triangle diagonal (the brighter pair). Faces merge only when
  their words are equal and their corners equal along the merge axis, so a merged quad shades exactly like the unit
  faces it covers; the tests check this against a one-quad-per-face oracle. On half-block faces the AO and light come
  from the four half cells of the front layer around each corner (a stair's step darkens where it meets its riser),
  and the tests check every face against a half-block oracle.
- **Quad words** (low bits first). Word 0: x 0-4, y 5-9, z 10-14 (the local cell), face 15-17 (+x, -x, +y, -y, +z, -z,
  then the two cross diagonals), w - 1 at 18-22, h - 1 at 23-27, flip 28, liquidDrop 29-31. Word 1: material 0-11, AO
  per corner at 12-19 (2 bits each), wave 20, inset 21 (the face lies half a block inside its cell), trim 22-25 (bits
  1, 2, 4, 8: the quad starts half a block later along u, ends half a block earlier along u, the same along v). Word
  2: per corner c, sky light at bits 8c-8c+3 and block light at 8c+4-8c+7. The u and v axes are z, y on x faces, x, z on y faces and x, y on z faces; corners run (0, 0), (w, 0),
  (w, h), (0, h). `ChunkMesh` documents the geometry in full.
- **Materials.** `blockMaterials(table)` numbers each distinct texture layer of each block in id order (up to 4,096), so
  a renderer builds its material table (layer, tint, roughness, metalness, emissive, animation) from the same walk.
- **Visibility.** `mesh.visibility` has bit `a * 6 + b` set when chunk faces a < b see each other through cells that are
  not opaque cubes, for cave culling.
- **Shell.** `MeshInput.shell` and `.light` hold the 6,536 cells of the 34-cubed block around the chunk outside it, in
  index order `(x + 1) + 34 (z + 1) + 1156 (y + 1)` for local x, y, z in -1..32; `meshInput` reads them from the
  loaded neighbours (unloaded cells are air with light 0).

Measured with Node on one core of the development laptop while other jobs ran (2026-10-19; `node --test
packages/voxel/tests/mesher-benchmark.test.js` prints yours): about 2 ms per random-terrain chunk (5,900 quads) and
7.5 ms for a full-chunk stone checkerboard (98,304 quads, the most opaque cubes can make); `meshInput` 0.2 ms. A 3D
checkerboard of two different blocks that hide nothing (two glasses, say) shows every face of every cell: 196,608 quads
in one layer.

## Light (`@margoengine/voxel/light`)

Sky and block light in the chunks' light bytes, by breadth-first flood fill on the main thread with a per-call budget.

```ts
import { VoxelLighting, MAX_LIGHT } from 'margoengine/voxel/light';

const lighting = VoxelLighting.attach(world, { budget: 4096 }); // also lights the chunks already loaded
engine.onFrame(() => lighting.update()); // at most `budget` cells a call, so big changes spread over frames
lighting.skyLight(x, y, z); // 0..MAX_LIGHT (15)
lighting.blockLight(x, y, z);
lighting.budget = Infinity; // e.g. behind a loading screen
lighting.dispose();
```

- **Sky light** is 15 in every cell above its column's heightmap (`world.heightmap`: the highest cell with opacity > 0,
  so glass passes it at full strength) and spreads from there; **block light** spreads from each type's `light`. Each
  step costs 1 plus the entered cell's `opacity` (stone's 15 stops it; leaves with `opacity: 1` dim it by 2 a block).
- **Slabs and stairs** pass light through their open part: no light crosses a face their boxes cover whole (a lower
  slab's bottom, an upper slab's top, a stair's back and the half it stands on, every face of a double slab), any
  other face passes it at the usual cost (a waterlogged one costs its liquid's opacity when that is more). They end their column's open sky; one whose top is open (a lower slab, a stair) is itself lit as open
  sky when it tops its column, so its top face shades like the ground beside it.
- Edits and chunk loads and removals (`world.onChunk`) are queued as they happen; `update()` applies them in order,
  across chunk borders: a chunk loaded later takes light in from its loaded neighbours and gives its own out. Darkening
  uses the two-queue removal flood, so removing a torch, closing a roof or unloading a chunk clears only what that
  light reached. A removed chunk's heights stay in the heightmap, so a cave stays dark when the chunks above it unload;
  a chunk loaded again decides the heights of its own 32 cells per column.
- Chunks whose light changed, and loaded neighbours whose one-cell shell holds a changed cell, go into `world.dirty`.
  A chunk entirely under open sky keeps one light byte (`chunk.fillLight`); its first differing cell makes it 32 KiB.
- A chunk load is never split; it counts the cells it lights plus an eighth of those it scans (about 130 for open sky,
  up to about 13,000 for mixed blocks with emitters). `update()` returns the cells processed: 0 once light is current.
- Errors: `TypeError`/`RangeError` for a wrong world, budget or cell; `MargoError` `'attached'` for a second lighting
  on one world, `'disposed'` for `update()` after `dispose()`.

Measured with Node on the development laptop (2026-10-19; `node --test packages/voxel/tests/light-benchmark.test.js`
prints yours): a torch placed or removed in open air (3,300 cells) about 4,000-6,000 cells/ms; a 32 x 32 stone roof
removed over a 30-deep room (70,000 cells) about 5,400-7,600 cells/ms, put back about 6,800-8,500 cells/ms.

## MagicaVoxel `.vox` files (`@margoengine/voxel/vox`)

```ts
import { parseVox, writeVox, pasteVoxModel, readVoxRenderDictionaries } from 'margoengine/voxel/vox';

const scene = parseVox(new Uint8Array(await (await fetch('castle.vox')).arrayBuffer()));
scene.models[0].size; // [x, y, z], MagicaVoxel z up; voxels: Uint8Array of x, y, z, palette index
scene.palette; // 256 RGBA8 colours, palette index i at 4 * i
scene.nodes; // transform / group / shape nodes; transform frames have rotation (3 x 3), translation, frame
scene.materials[0].rough; // MATL: type, weight, rough, spec, ior, att, flux, plastic (+ attributes Map)

pasteVoxModel(world, scene, [0, 64, 0]); // every visible shape; colours become 'vox:rrggbb' block types
pasteVoxModel(world, scene.models[2], [10, 64, 0], mapping); // one model: mapping[paletteIndex] = block state

scene.nodes[2].frames[0].translation = [0, 0, 8];
const bytes = writeVox(scene); // the same bytes as the file, except what you changed

const render = readVoxRenderDictionaries(scene); // rOBJ / rCAM decoded; scene.chunks untouched
render.objects; // Map per rOBJ: '_type' => '_setting', '_sun', '_lens', ...
render.cameras; // { id, attributes } per rCAM
render.diagnostics; // { kind: 'malformed' | 'unsupported', id, chunk, message } for what gave no dictionary
```

- **Format.** Versions 150 and 200, from MagicaVoxel's published notes: SIZE + XYZI models, PACK, RGBA (file colour k
  is palette index k + 1; the default palette when absent), MATL, nTRN (the packed rotation byte as a signed
  permutation matrix, `_t`, `_f` per frame), nGRP, nSHP (a model per frame) and LAYR. Every other chunk (rOBJ, rCAM,
  NOTE, IMAP, META, MATT, future ones) stays as bytes in `scene.chunks`, which also records the file's chunk order, so
  `writeVox(parseVox(file))` is the file byte for byte. Typed fields are decoded from each dictionary's `attributes`;
  on write a typed field replaces its key only when its value changed, so untouched text keeps its exact form.
- **Render settings.** `readVoxRenderDictionaries(scene, {maxBytes, maxEntries})` decodes the kept rOBJ chunks (a
  DICT each) and rCAM chunks (an int32 camera id, then a DICT) without changing them, so `writeVox` still gives the
  file back byte for byte. Strings decode like the typed dictionaries (UTF-8, else windows-1252) and a repeated key is
  malformed, as in `parseVox`. A chunk over `maxBytes` (default 1 MiB) or a dictionary over `maxEntries` (default
  4096) is reported `'unsupported'` and not read; truncated or inconsistent content is `'malformed'`; child chunks are
  kept, reported and not read. Nothing throws for chunk content. The result feeds the path tracer's
  `magicaVoxelLighting(objects)` and `magicaVoxelCamera(camera.attributes, objects)`.
- **Pasting.** MagicaVoxel's z (up) becomes world y and its y becomes world -z (right-handed, not mirrored); the pasted
  box has its minimum corner at `at`. A scene pastes frame 0 of every shape not hidden by its node or layer, each
  model centred on its transform's translation. A bare model has no palette, so it needs a mapping. Without one, a
  colour whose MATL is metal, glass, blend, emit or media gets `voxBlockOptions(material)`: metalness, a translucent
  layer with transmission (`_trans`, `_alpha`, or a glass's `_weight`), `emissive = _weight * (1 + _flux)` (a starting
  point: MagicaVoxel's power steps are not linear), scatter for media; its options go in the type name
  (`vox:rrggbb:metalness=0.5`). Plain diffuse colours stay `vox:rrggbb`. Voxels are
  written chunk by chunk (a stable sort keeps each chunk's voxels in file order, and each chunk's palette widens once),
  with the results of one `setBlock` per voxel: the same cells, return count and dirty keys, and `onChange` once per
  changed cell right after it is written. Only the order across chunks differs.
- **Errors.** `parseVox` throws `RangeError` for truncated, oversized or inconsistent files (voxels outside SIZE, a
  SIZE outside 1-256, counts past the chunk, broken node references or cycles) and `TypeError` for bytes that are
  not a .vox file; it allocates no more than the file holds. `writeVox` rejects what `parseVox` would.

Measured with Node on the development laptop (2026-10-19; `node --test packages/voxel/tests/vox.test.js` prints
yours): a 1M-voxel model writes in about 10 ms and parses in about 6 ms (4 MiB). Pasting, measured with Node 26 on
the RTX A6000 desktop (32 logical cores) while other jobs kept it at 36-72% CPU (2026-10-19, best of 3): 1M random
cells in a 256-cubed box 43-57 ms (one `setBlock` per voxel, as pasting did before: 261-282 ms), and a 398-voxel model
tiled 2,635 times (1,048,730 voxels; measured with the former sample model, which the Margo-made `tests/fixtures/tree.vox`
replaced at the same voxel count) 45-52 ms (113-142 ms).

## Physics (`@margoengine/voxel/physics`)

Rapier colliders for the chunks near moving bodies, so mobs, item drops, debris and balls of a
[`@margoengine/physics`](../physics/README.md) world collide with the blocks. Needs `@margoengine/physics` (an optional
peer: only this entry uses it) with `@dimforge/rapier3d-compat` 0.17.1 or newer.

```ts
import { Physics } from 'margoengine/physics';
import { VoxelPhysics } from 'margoengine/voxel/physics';

const physics = Physics.attach(engine, { rapier: RAPIER });
const voxels = new VoxelPhysics(physics, world, { radius: 1, budget: 2 });
physics.addBody(mesh, { colliders: { shape: 'box' } }); // lands on the blocks
physics.addBody(ball, { colliders: { shape: 'sphere' } }); // rolls on them (triangle meshes, see below)
physics.on('contactstart', (event) => {
  if (event.bodyB === voxels.body) console.log(event.bodyA, 'hit chunk', voxels.chunkOf(event.colliderB));
});
world.setBlock(x, y, z, 0); // the collider changes in place; the body falls
voxels.budget = 4; // milliseconds of collider building per physics step, live
voxels.pending; // chunks whose colliders are still being built
voxels.colliders; // Map of chunk key -> the Rapier colliders bodies touch
voxels.dispose();
```

- **Which chunks.** Before each physics step, every loaded chunk within `radius` chunks (per axis, default 1: the
  body's chunk and its 26 neighbours) of any non-fixed body gets a collider; sleeping bodies count, so they keep their
  floor, and kinematic ones count, so character controllers walk on blocks. A chunk keeps it until no body is within
  `radius + 1` (a body resting on a chunk border does not make chunks come and go) or the chunk unloads.
- **Slabs and stairs.** Solid slabs and stairs are left out of the voxel collider and collide as their half-block
  boxes: each chunk with any gets one more triangle mesh of their open faces (`FIX_INTERNAL_EDGES`, always enabled,
  beside the voxels or the mesh pieces), rebuilt when a cell in or beside one changes. A box rests on a slab's top at
  `y + 0.5` and on a stair's step or back.
- **What collides.** The chunk's surface: cells of block types with `solid` (the default) that touch a non-solid cell
  or an unloaded chunk. Buried cells are left out, so an underground chunk costs almost nothing.
- **Seams and edits.** Each chunk has a Rapier voxel collider, coupled with its neighbours through
  `combineVoxelStates`, so bodies slide across chunk borders without catching on internal edges. `onChange` edits
  call `setVoxel` (and `propagateVoxelChange` on chunk borders): no rebuilds. A digging edit adds the solid cells it
  uncovers.
- **Balls.** Rapier 0.21.0 panics (`RuntimeError: unreachable`, which ends the Rapier instance) when a `sphere`
  collider meets a voxel edge: rolling off a ledge, across a chunk border or into a wall (open upstream reports:
  rapier issues 1029 and 1043). So chunks within `radius` of a body with a `sphere` collider also get a triangle mesh
  of the same faces (merged into rectangles, built with `FIX_INTERNAL_EDGES` so balls roll over edges and seams without
  a kick) and their voxel collider is disabled; it is still edited and coupled, so voxel chunks beside them stay
  seamless for boxes and capsules. They switch back once no ball body is within `radius + 1`. A mesh is cut into
  pieces of at most 2,048 triangles (the chunk is halved, horizontal cuts first, until each piece fits: a terrain
  surface is 1-2 pieces, a 50% random cave chunk 60), so no single Rapier build is long and an edit in or beside a
  piece rebuilds only that piece. Rapier can drop up to one step of travel where a ball passes from one collider to
  the next, a chunk border or a piece seam (separate Rapier boxes do the same); there is no bump.
- **Building over steps.** `budget` (milliseconds per physics step, default 2, live) spreads the building. What a
  body can reach before the next step (its collider's size, plus two steps of its velocity, plus 1 m) is built in that
  step whatever it costs: the surroundings of a body that spawns or is teleported, a chunk loaded under a body, the
  mesh pieces around a ball, an edited piece under a body. Everything else (chunks entering the radius, about a chunk
  from the body that needs them; meshes for a ball still a chunk away; stale borders) is built nearest first while the
  step's estimated cost fits the budget, at least one unit (one chunk's voxel collider, one scan of a chunk, or one
  mesh piece) per step. `budget: Infinity` builds everything in the step that needs it. What a ball touches meanwhile:
  - A chunk entering a ball's radius keeps its voxel collider (for the other bodies) while its mesh pieces are built,
    disabled, over the next steps, and switches to the mesh when the last piece is done. The ball is a chunk away.
  - A ball that reaches a chunk before its mesh is done (spawned or teleported into it, very fast, a chunk loaded
    under it) switches it in that step: the voxel collider is disabled and the pieces within reach of every body (the
    ball, a box resting elsewhere in the chunk) are built at once; each other piece is built in the budget or in the
    step a body comes within reach of it. A ball never touches a voxel collider and no body loses the blocks under it.
  - An edited piece keeps its previous mesh until its rebuild replaces it (in the same step when a body is within
    reach of it).
- **Events and queries.** Every collider belongs to `voxels.body`, one fixed `PhysicsBody` whose `userData` is the
  VoxelPhysics, so contacts with blocks raise the `Physics` events (`contactstart`, `contactend`, and
  `intersectionstart`/`intersectionend` for sensors) with it as `bodyA` or `bodyB` (its `mesh` is null),
  `contactFilter` sees it, and `physics.raycast` and the other queries hit blocks near bodies (pick anywhere with
  `raycastVoxels` from `./query`). `voxels.chunkOf(collider)` names the chunk of a voxel or mesh collider. A collider
  swap (a chunk switching between voxels and a mesh, a rebuilt piece) ends the contact with the old collider and starts
  one with the new in the same step. Removing `voxels.body` disposes the VoxelPhysics.

Measured with Node 26 on the reference desktop (NVIDIA RTX A6000, AMD Ryzen 9 9950X, 32 logical cores; 2026-10-19,
other jobs running, 11-15% total CPU; three runs of `node --test packages/voxel/tests/physics.test.js`, which
prints yours; time spent in VoxelPhysics per physics step). One chunk built all at once (best of 3): a terrain-surface
chunk's voxel collider 0.6 ms and triangle mesh 2.3-2.5 ms (2 pieces); a uniform stone chunk 0.9-1.0 ms and 1.0-1.1 ms;
a 50% random cave chunk 1.7-2.5 ms and 38-41 ms (60 pieces), the worst case for a ball. Per physics step:

- That cave chunk entering a ball's radius: 35-46 ms in one step with `budget: Infinity`; 27-29 steps of at most
  1.9-2.2 ms with the default.
- A ball spawned inside a cave chunk, at the corner of four pieces: 5.2-6.5 ms in its first step (5 of 39 pieces),
  then 20-21 steps of at most 2.0 ms.
- A body crossing chunk borders over cave chunks at 12 m/s: worst steps 11-13 ms all at once, 3.1-3.3 ms with the
  default (one cave chunk's voxel collider, 1.7-2.5 ms, is the largest unit). The chunk under it always had its
  collider.
- On terrain (8 x 8 chunk columns): a body crossing a chunk border builds 6 voxel colliders, 1.9-2.4 ms all at once,
  at most 2.0 ms a step with the default; a ball builds 9 colliders and meshes, 5.9-6.9 ms all at once, over 4-5 steps
  of at most 2.1 ms. A body spawning there builds 18 colliders (6.1-7.4 ms at once, or 4-6 steps of at most 2.0 ms), a
  ball 30 (18-21 ms, or 14-17 steps of at most 2.0 ms).
- A dig or place on voxel chunks costs 1.2-1.5 us against 0.2-0.3 us without colliders; an edit in a mesh chunk
  rebuilds one piece at the next step, 1.1-1.7 ms.

A ball rolling over the piece seams of a floor under caves (41-piece chunks) trails a one-box floor by at most
0.26 m after 150 steps, with no kick (the chunk-border case: 0.23 m). The cost of one unit on slower machines, and so
their worst step, is unverified; the development laptop measured these builds two to three times slower before this
change.

## Meshing in workers: `VoxelMesher`

`VoxelMesher` (also in `@margoengine/voxel/mesher`) runs `meshChunk` in a pool of workers that share one priority
queue. The worker script ships as `dist/workers/mesher.js`, a classic script without `eval` (fine under a strict CSP)
that your bundler copies as an asset.

```ts
import { VoxelMesher } from 'margoengine/voxel/mesher';

const mesher = new VoxelMesher(); // {workers}: default half the logical cores minus one, 1 to 4
mesher.warm(); // optional: start the workers now, so their code is not fetched beside the first chunks
for (const key of world.dirty) {
  world.dirty.delete(key);
  mesher.mesh(world, key, distanceToCamera(key), camera.position).then((mesh) => {
    if (mesh) upload(key, mesh); // null: cancelled, superseded, or the chunk is gone (world.getChunk tells which)
  });
}
mesher.cancel(key); // the pending job of one chunk resolves null
mesher.dispose(); // every pending job resolves null; the workers stop
```

- **Order.** Lower `priority` is meshed sooner (the chunk's distance to the camera, say); equal priorities in call order.
  Workers start as jobs arrive, up to `workers`.
- **Newest wins.** A `mesh` call for a key that already has a queued or running job supersedes it: the older promise
  resolves null at once (a running job's result is dropped when it arrives) and only the newest call's mesh is
  delivered. The `MeshInput` is built with `meshInput` when a worker takes the job, so it holds the world's latest
  blocks and a queued job holds no copy; its buffers and the mesh's arrays move between the threads without copies.
- **Translucent order.** Pass the camera's world position as `eye` and the worker returns `translucent` sorted back to
  front by quad centre distance. `sortQuads(words, localEye)` does the same on any thread (to re-sort a near chunk after
  the camera moves; `localEye` is the world position minus 32 times the chunk coordinates). Large merged quads beside
  small ones can still sort wrong: centre distance is Minecraft's order, not an exact one.
- **Failures.** A worker that crashes rejects its job's promise and is replaced for the next job.

Measured with Node 24 worker threads on the development laptop (8 logical cores) while other jobs kept the whole machine
at 98-100% CPU (2026-10-19; `node --test packages/voxel/tests/mesher-worker-benchmark.test.js` prints yours), 64
random-terrain chunks of about 5,600 quads: 326 meshes/s with 1 worker, 540 with 2, 828 with 3 (3.1-3.7 ms per mesh per
worker, `meshInput` on the main thread included).

## Streaming and generation (`./stream`, `./generate`)

`VoxelStreamer` (in `@margoengine/voxel/stream`) loads the chunks around the camera and other viewers and unloads the
rest: from the store first, else from a generator running in workers. `@margoengine/voxel/generate` holds the built-in
generator, `noiseTerrain`, and `serveVoxelGenerator` for your own.

```ts
import { IndexedDBChunkStore, VoxelStreamer } from 'margoengine/voxel/stream';

const streamer = VoxelStreamer.attach(engine, {
  world,
  generator: { seed: 7, seaLevel: 0, trees: 0.01 }, // NoiseTerrainOptions: the built-in worker
  store: new IndexedDBChunkStore('world-1'), // default: a MemoryChunkStore
  distance: 8, // chunks in x and z (256 blocks); verticalDistance: 4
  frameBudget: 0.5, // main-thread ms per update for chunks joining the world (and chunksPerFrame: 8)
});
streamer.viewers.push(otherPlayer.position); // more positions to load around, in blocks
if (streamer.pending === 0) hideLoadingScreen(); // chunks in range not loaded yet
addEventListener('pagehide', () => streamer.save()); // edits of loaded chunks; unloads save their own
await streamer.dispose(); // saves, flushes the store, stops the workers; the chunks stay in the world
```

```ts
// islands.worker.js, your module worker. Vite: import islands from './islands.worker.js?worker&url'
import { serveVoxelGenerator } from 'margoengine/voxel/generate';

serveVoxelGenerator((chunk, cx, cy, cz, { blocks }) => {
  const stone = blocks.find((type) => type.name === 'stone').id; // the world's BlockTypes table
  if (cy < 0) chunk.fill(stone); // chunk: a new air VoxelChunk; cell (x, y, z) is world (32 cx + x, ...)
  return -1; // optional: no block above cell y -1 in this column, so its chunks with cy >= 0 load as air without a job
});
// Main thread: new VoxelStreamer({ world, generator: islands }) (or attach), then streamer.update() each frame.
```

- **Range.** A chunk loads when it is within `distance` chunks of a viewer's chunk in x and z (a circle) and
  `verticalDistance` in y, inside the world's minY..maxY. It unloads once it is more than one chunk past that for every
  viewer, so walking back and forth over a chunk border reloads nothing. `distance` and `verticalDistance` can change
  at run time.
- **Order.** Loads start closest first, at most 4 per worker running or queued, and the next one starts as each finishes
  (not only once per `update()`) while the memory budget has room for every chunk on its way; finished chunks join the
  world closest first, and lighting and meshing follow through `world.onChunk` and `world.dirty`. A generated chunk is
  unpacked when it joins (about 0.06-0.08 ms on the main thread of the desktop below, 0.15-0.19 ms on the laptop). Per
  `update()` at most `chunksPerFrame` (default 8) join, and none after `frameBudget` milliseconds (default 0.5) of
  adding them, listeners included; one always joins, so loading never stalls (0 means one per update). Behind a loading
  screen set both to `Infinity`, or raise them while the world first fills: the sandbox joins 2 ms of chunks a frame
  then (render distance 16 ready in 3.6 s instead of 8.1-8.4 s at 0.5 ms) and goes back to 0.5 ms once ready.
- **Air above the ground.** A generator can return its column's ceiling, a cell y that no chunk of that column has a
  block above (`noiseTerrain` returns the highest ground, sea or tree crown that reaches the column). Once one chunk of
  a column has come back with it, the column's chunks wholly above it load as air without a worker job (the store is
  still read first, so built chunks up there load). In the sandbox at render distance 16, about 2,360 of 5,579 chunks
  need no job. A ceiling too low loses blocks; return nothing when unsure.
- **Saving.** Chunks edited through the world (`onChange`), and chunks someone else added, are saved to the store when
  they unload; chunks generated or read from the store and not edited are dropped and regenerate the same. A failed
  save is reported to `onError` and the chunk is kept in memory, where a reload finds it, until a save succeeds.
- **Memory.** Over `memoryBudget` (default 128 MiB of `chunk.byteLength`) the least recently used chunks outside the
  load range unload first; if the range alone is over, loading stops (closest chunks loaded) until there is room.
- **Failures.** A chunk the store or the generator fails on goes to `onError` (the engine's with `attach`) and is
  tried again only after it leaves the range and comes back.
- **`noiseTerrain(options)`.** A fractal simplex heightmap (`height` 8, `amplitude` 32, `scale` 192 blocks) of grass
  over dirt over stone, sand at the shore and on the sea floor, water up to `seaLevel` (0), cave tunnels where two 3D
  simplex fields are both near zero (`caves` 0..1, default 0.3: about 5% of the rock), and trees on grass (`trees`, the
  chance per column, default 0.01) placed by a hash of the column, so a crown that crosses a chunk border is the same
  in every chunk and every generation order. Caves never reach water: rock at a height where a side neighbour column
  holds sea stays (the top block is never carved either). A tree grows only where its whole crown is in open air above
  the ground of every column it covers, so no leaves end up in hillsides or caves; both rules read only the column
  heights around a cell, so chunks stay independent of generation order. The generator's tests scan 144-chunk regions
  across chunk borders for water beside cave air and leaves in the ground (none). Block types come by name
  (`blocks: {stone, dirt, grass, sand, water, log, leaves}`, each defaulting to its key), checked when the streamer
  is created. It runs on any thread (a `VoxelGenerate`); the streamer runs it in `dist/workers/terrain.js`, a classic
  script without `eval`.
- **Errors.** `TypeError` and `RangeError` for options; MargoError `'attached'` for a second streamer on a world,
  `'unsupported'` for a generator without Web Workers, `'disposed'` after `dispose()`.

Measured with Node 24 worker threads on the development laptop (8 logical cores) while other jobs kept it at 96-99%
CPU (2026-10-19; `node --test packages/voxel/tests/stream-benchmark.test.js` prints yours): `noiseTerrain` 1.4-1.8 ms
per chunk on one thread; filling a 565-chunk range: 495 chunks/s with 1 worker, 803 with 2, 765 with 3 (the machine
had no core left for the third); `update()` 11-14 us per call, unpacking included.

The cost of `update()` per frame while chunks join, measured with Node 26 on the RTX A6000 desktop (32 logical cores)
while other jobs kept it at 10-52% CPU (2026-10-19; same file, 3 terrain workers keeping 12 chunks ready, 16 ms
frames, 565 chunks): with only the 8-chunk cap (the behaviour before `frameBudget`) 0.51-0.64 ms median, 0.76-1.29 ms
p95 and 0.91-1.97 ms at worst, 7.8 chunks a frame; with the default 0.5 ms budget 0.52-0.56 ms median, 0.67-0.73 ms
p95, 0.76-0.85 ms at worst, 7.3-7.6 chunks a frame; with 0.25 ms 0.36-0.39 ms median and 0.60-0.72 ms at worst,
4.4-4.6 chunks a frame (565 chunks in 3.6-3.8 s instead of 2.2 s). Not yet measured on the laptop, where 8 chunks
cost 1.2-1.5 ms.

## Rendering (`@margoengine/voxel/render`)

`VoxelRenderer` draws a world with an engine (WebGPU): it meshes the world's dirty chunks in workers (an all-air chunk
needs no job: it has no faces whatever its neighbours hold), keeps their quads on the GPU and draws every chunk layer
with one indirect draw. `BlockTextures` holds the block textures.

Size: `./render` is 21,798 B gzip (18,931 before bevels and maps). The extra bytes are the parts every world can
use: about 1.0 KB draws beveled blocks (quad split, glass and liquid triangles sorted together, the triangle pipelines
in the beauty, shadow and post passes), about 0.6 KB the material table with normal, roughness and emissive maps,
transmission and texture layers up to 2,047, about 0.3 KB the lightmap hooks, and the rest multi-view. The bevel
builder and shader are in `./bevel` (2,201 B) and baked light in `./lightmap` (2,506 B), so plain worlds do not load them.

```ts
import { BlockTextures, VoxelRenderer } from 'margoengine/voxel/render';
import { VoxelLighting } from 'margoengine/voxel/light';

const textures = await BlockTextures.load(['stone.png', 'dirt.png', 'grass-top.png', 'grass-side.png']); // layers 0-3
// or BlockTextures.fromAtlas(image, { size: 16 }), or new BlockTextures({ images: [canvas, bitmap, ...] })
const lighting = VoxelLighting.attach(world); // the renderer shades with the chunks' light bytes
const voxels = VoxelRenderer.attach(engine, { world, textures });
engine.onFrame(() => lighting.update());
world.setBlock(x, y, z, stone); // drawn two frames later
textures.set(3, canvas); // live
voxels.daylight = 0.3; // dusk: sky light dims, block light (torches) does not
voxels.stats; // {chunks, visible, quads, triangles, bytes, draws, compiling, pending} of the last frame
voxels.dispose(); // workers and GPU buffers; textures.dispose() separately
```

- **Meshing.** Each frame the renderer takes the keys in `world.dirty` (it is their consumer), sends loaded chunks to a
  `VoxelMesher` (option `workers`) nearest first and frees removed ones at once. Finished meshes are uploaded nearest
  first, about 4 MiB per frame. Translucent quads come back sorted from the camera; chunks within 64 blocks are sorted
  again on the CPU after the camera moves 4 blocks, and translucent chunks draw back to front.
- **GPU memory.** One storage buffer holds every quad (12 bytes) in pages of 64; a chunk layer takes a run of pages
  (first fit, reused in place while it still fits). The buffer starts at 4 MiB and doubles up to `maxQuadBytes`
  (default 96 MiB, at most the device's storage binding limit); a mesh that does not fit waits until chunks free pages.
  Vertices are pulled from it by vertex index (no vertex buffers, no extra GPU feature).
- **Draws.** Pass order -6 prepares: frustum cull per chunk on the CPU (`@margoengine/math/frustum`) into the indirect
  arguments, uploads, the frame uniform. Order 1 draws opaque blocks (back faces culled) and cutout blocks (both sides,
  alpha to coverage at 4x MSAA, alpha test at 0.5 at 1x) by replaying a render bundle of one `drawIndexedIndirect` per
  chunk layer, re-recorded only when the set of chunk layers with quads, a buffer or the target changes (0.2-0.8 ms for
  2,000 draws). Order 4.5 draws translucent blocks (premultiplied over, no depth write while they blend), then their
  depth alone, so passes after it (screen-space fog, lines at the default order 20) meet the surface, not what is
  behind it. Draw lines that must show through water before 4.5 (`new Lines({ order: 4 })`). Pipelines compile
  asynchronously: the first frames after attaching, or on a new target format, draw nothing.
- **Shading.** Each pixel is shaded where its ray meets the face's plane, never from interpolated attributes: texture
  coordinates and their gradients (nearest texels up close, trilinear mips in the distance, no seams on tiled greedy
  quads), and AO, sky light and block light bilinear between the quad's corners, so a greedy quad shades like the unit
  faces it covers. Lighting: `engine.lighting`'s sun (PBR, scaled by sky visibility unless a shadow map covers the
  face, see below), a hemisphere ambient term (`radiance[3]` times the ambient colour) times AO, sky light and
  `daylight`, block light as emission in `blockLightColor`, and each type's `emissive`. Without light bytes every face
  sits in the dark: attach `VoxelLighting`, or fill them (`chunk.fillLight(0xf0)` is open sky). rgba16float targets get
  linear colour; others PBR Neutral and sRGB.
- **Materials.** One 32-byte entry per `blockMaterials` id: texture layer, animation frames and fps (up to 255.99,
  1/256 steps), tint, roughness, metalness, emissive, the normal, roughness and emissive map layers, transmission and
  scatter. Normal maps are tangent space with +y up the image (glTF): u runs along the face's tile coordinates. A
  roughness map replaces `roughness` (red channel), an emissive map scales `emissive` (red). On translucent blocks
  `transmission` lowers alpha by up to 85% and shows the block's own colour through it, softened by `scatter`: a cheap
  look, not refraction. Opaque blocks ignore texture alpha. `fancyLeaves: false` draws cutout cubes solid; cross blocks
  always cut out.
- **Textures.** An `rgba8unorm-srgb` 2D array: up to 2,048 layers of `size` x `size` texels (over 256 needs a device
  created with a higher `maxTextureArrayLayers`; the renderer throws `MargoError` `'unsupported'` otherwise) (a power of two; default the
  first image's width, or 16; other sizes are drawn at it, nearest-neighbour). Mips are made once on the CPU per layer:
  colour averaged in linear light weighted by alpha; for cutout textures (alpha only 0 and 255) alpha is rescaled so an
  alpha test keeps the level-0 coverage (Castano 2010), so leaves stay dense in the distance; other alpha is averaged.
  Raw `{width, height, data}` pixels need no DOM. Missing layers are white.
- **T-junctions.** A greedy quad's edges pass through the corners of smaller neighbours; once the rasterizer snaps the
  vertices to its subpixel grid, slivers there let single samples of the background through (up to 41 pixels of a
  320 x 240 grazing view on the Arc 140V). The vertex shader stretches merged quads 1/128 pixel along their own edges,
  in their plane, which closes them (none left in the browser check). Within that fraction of a pixel of an edge a
  sample can then belong to the neighbour, so a greedy image differs from a one-quad-per-face image in a few edge
  pixels (under 0.6% of those drawn, never over an area).
- **Device loss.** On `engine.rebootDevice()` (or a lost device) every chunk is meshed and uploaded again.
- **Errors.** `TypeError` for a wrong world, textures or option type, `RangeError` for values out of range (including
  `maxQuadBytes` over the device limit), `MargoError` `'unsupported'` without WebGPU or Web Workers; `BlockTextures`
  throws `RangeError` for sizes and layers, `MargoError` `'unsupported'` for an image without OffscreenCanvas,
  `'failed'` when `load` gets an HTTP error, `'disposed'` after `dispose()`.

Checked on the Arc 140V (`node scripts/gpu-lock.mjs run --owner=you -- node packages/voxel/tests/render-browser-check.mjs`):
no T-junction cracks at 4x and 1x MSAA, greedy and one-quad-per-face images equal outside edge samples on the canvas
format and rgba16float, glass and cutout composites to their exact linear values, an edit drawn two frames later, the
same image after `engine.rebootDevice()`, no validation errors. Rough timing (`--timing`, machine not quiet, timestamp
queries in 65 us steps): a synthetic render-distance-16 world (2,178 chunks, 1.13M quads, 13.7 MiB) spawns in 1.5-4.6 s
and its voxel passes take about 3.2 ms of GPU at 1920 x 1080 with 4x MSAA (582 chunks visible), 0.9 ms of CPU per frame
for the whole `engine.render`.

Checked again on the NVIDIA RTX A6000 desktop (2026-10-19, Edge 155): every check above passes at 4x and 1x MSAA, plus
the worst case: one chunk of 196,608 cutout quads and one of 196,608 translucent quads (3D checkerboards of two types
each) draw in full with no validation error. Greedy against one-quad-per-face: 22-207 differing edge pixels of
29,975-56,488 drawn at 4x (0.04-0.52%), 12-44 at 1x, never a 2 x 2 block; bit-identical images are not possible
because the two meshes put different vertices on the same edges and the rasterizer snaps each. With the edge stretch
switched off, a grazing slab view shows 14 crack pixels at 4x on this GPU; with it on, none. Rough timing (`--timing`,
machine not quiet): the render-distance-16 world above spawns in 0.63 s; its voxel passes take about 0.26 ms of GPU
(the timestamps here come in 0.26 ms steps) and `engine.render` 0.3 ms of CPU per frame.

### Lighting effects, day and night, water and lava

```ts
import { Shadows } from 'margoengine/shadows';
import { Clustered } from 'margoengine/clustered';
import { EnvironmentLighting, Fog } from 'margoengine/environment';

const shadows = Shadows.attach(engine, { distance: 96, cascades: 2 });
shadows.add(voxels, { static: true }); // casts (opaque and cutout) and receives; the map is redrawn only on change
const lights = Clustered.attach(engine);
lights.setLights([{ position: [x, y, z], range: 10, color: [1, 0.7, 0.4], intensity: 20 }]);
lights.add(voxels);
Fog.attach(engine, { color: '#b8c8d8', near: 64, far: 256 }).add(voxels);
environment.add(voxels); // an EnvironmentLighting: image-based ambient instead of the hemisphere term
engine.onFrame(() => (voxels.daylight = 1 - sky.nightFactor)); // a Sky drives engine.lighting's sun and moon itself
voxels.blockLightColor = [1, 0.7, 0.45]; // torches warmer
```

- **Effects.** `addLighting(effect)` takes any object with glTF-pro's lighting hooks (`pbr(group)`, `bindings()`):
  `Shadows`, `Clustered`, `Fog` and `EnvironmentLighting` call it from their `add`. The shader is composed again and
  compiled in the background; until it is ready the previous pipelines keep drawing (`stats.compiling` is true
  meanwhile). The last four compositions stay compiled, so taking out the effect added last, or putting one back,
  draws at once. `stats.pending` counts the chunks not yet on the GPU (changed, meshing or waiting for upload): a frame
  with `pending` 0, `compiling` false and `draws` above 0 shows the whole world. Each effect's remover takes it out again. Effects' bindings are group 1 (shadows 1-3, clustered 4-7, IBL 20-24, fog 25).
- **Shadows.** `drawShadow` draws the opaque and cutout chunks inside each cascade (CPU-culled per cascade) into the
  map, cutout blocks alpha tested at their texture's level 0; translucent blocks cast none. Every quad reaches 1/64
  block past its edges in the map, so T-junction slivers cannot let light through and merged and unit quads cast the
  same shadow. It returns false while its pipelines still compile (the first call starts them). With `{static: true}` the map is redrawn only when `shadowVersion` changes (chunks with opaque or cutout
  quads arriving, changing or leaving inside the last map's cascades, new textures or buffers) or the cascades move.
- **Sun and sky.** Without a shadow map the sun reaches a face as far as the open sky does (sky light squared, so
  caves stay dark). Inside a shadow map's range the map decides alone (an overhang's shadow is the map's, not a dimmed
  sky term); over the last tenth of the range the sky term fades back in, and beyond it the sky term rules.
- **Ambient.** The hemisphere term, or IBL's when an `EnvironmentLighting` is added, is scaled by the occlusion: AO x
  (0.03 + sky light x `daylight`), so caves and night dim it and block light does not. `daylight` 0 leaves 0.03 / 1.03
  of the daytime ambient.
- **Animation.** A block type's `animation: {frames, fps}` steps through `frames` texture layers from its first one
  (lava and water textures, fire). Liquid surfaces (the mesher's wave bit: a liquid cell's top and sides with no same
  liquid above) rise and fall together by 0.04 blocks (`0.04 sin(1.6 t)`) and ripple: the top's shading normal follows
  three travelling waves of world x and z, so neighbouring quads and chunks match.

Checked on the NVIDIA RTX A6000 (2026-10-19, `node scripts/gpu-lock.mjs run --owner=you -- node
packages/voxel/tests/render-lighting-browser-check.mjs`; linear HDR radiance at projected world points, 4x and 1x MSAA):
with the sun straight down and no ambient, the floor under a 4 x 4 slab and under a cutout block's opaque square is 0
while the floor beside them and under the square's transparent border keeps its unshadowed value (0.9272); five still
frames reuse the cached static map; removing the slab lights the floor again 2 frames later. A floor with no sky is lit
inside a 40-block shadow range (0.9316) and black beyond it. A clustered point light (range 8, 3 blocks up) gives 0.990
under it, 0.557 two blocks away, 0.164 at four and 0 outside its range, and nothing once removed. Linear fog from 0 to
40 blocks toward linear [0.2, 0.4, 0.8] at 19.42 blocks gives [0.5757, 0.6724, 0.8662] against [0.5750, 0.6721, 0.8662]
expected. IBL and the
hemisphere ambient at daylight 0 are 0.02914 of daylight 1 (0.03 / 1.03 = 0.02913). Block light 15 under no sky shows
`blockLightColor` [0.2, 0.4, 0.8] as [0.2000, 0.3999, 0.7998]. Two-frame animation shows red then blue after a second.
A water cell's side top edge moves 6 rows at 4x and 5 at 1x between crest and trough (5.54 expected). Greedy against
one-quad-per-face with soft shadows, a point light, fog and the waving pool: 141-267 differing edge pixels of 76,800 at
4x, 34-74 at 1x, never a 2 x 2 block. No validation errors.

## Bevels and baked light (`./render`)

`VoxelRenderer.attach(engine, { world, textures, bevel: voxelBevel(0.15) })` (`voxelBevel` from `./bevel`, its own
entry: worlds without a bevel carry none of it) chamfers exposed cube faces by 0.15 blocks: each chunk layer's cube
faces become a triangle mesh (`bevelQuads`, one 48-byte vertex buffer and an index buffer per layer), lit by the same shader end as the quads (sky light, sun, AO, block light, maps and lighting
effects), cast into shadow maps and replayed by post (gbuffer, ambient, occlusion, capture; `draw` returns false until
the replay's pipelines, compiled in the background on its first call, are ready). Crosses and liquids stay
quads (a chamfer has no lowered liquid top). Translucent chamfers and quads of a chunk are sorted together, back to
front, within the same distance and per-frame budget as quads. Without `bevel` nothing changes.

```ts
import { voxelLightmap } from 'margoengine/voxel/lightmap';

voxels.lightmap = voxelLightmap({ texture, positions, uv: atlas.uv, scale: atlas.lightmapScale, radiometry: 'physical' });
voxels.lightmap = undefined; // live lighting again
```

`voxelLightmap` (its own entry: worlds without baked light carry none of it) takes an atlas from
`@margoengine/lightmap` and the world-space quads it was baked for (integer, axis-aligned rectangles; at most 32,768
covering 1,048,576 cell faces). Fragments on a chart use the atlas's light times the diffuse
colour instead of the sun and ambient terms; emission still adds and the rest stay live. `radiometry: 'physical'`
(the bake's physical irradiance) divides by pi once. Positions and UVs are copied; the texture is borrowed, never
destroyed (upload it again on a new device). A hash index finds a fragment's chart in at most 16 probes per cell.

GPU check (physical GPU, under the shared lock): `node packages/voxel/tests/bevel-browser-check.mjs`: bevel silhouettes,
texture layers 256 and 2047, maps, glass and liquid sorting, four views, lightmaps, bevel replay, shadows and AO.
