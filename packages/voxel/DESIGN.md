# @margoengine/voxel: approved design (names chosen 2026-10-19; Scott delegated naming)

Goal: a Minecraft-style voxel game on Margo, and later a MagicaVoxel-style editor sharing the package. Scott is
building Margo as the base of his own 3D modeller and game engine: it must look good and run well. Core and stage
are frozen (gzip gate 25,000; 21,343 now). Never one core entity per block, never vertex colours on core Geometry,
keep buffers within default WebGPU limits (128 MiB per storage binding, 256 MiB per buffer). Clean-room code (no
three.js or other engine code; three.js only as a test oracle). No new runtime dependency. Margo names, three.js-style
usage flow. Errors per docs/conventions.md, TSDoc on every public export, tree-shakable subpath entries.

## Extension points (cited by the design review; verify as you go)
- Own pipelines: `EnginePlugin` setup/registerPasses/onDeviceRestored/dispose (packages/core/src/plugin.ts:69-77);
  FramePass by `order`, main pass order 0 clears (plugin.ts:58-63, 86-88); PassContext gives device, encoder, color,
  depth, format (plugin.ts:30-52). Reverse-Z depth `greater-equal`, depth format depth32float-stencil8 when available
  (core/src/renderer.ts:161-165). MSAA 4 or 1 (core/src/quality.ts:5-7). Closest template for a custom pass:
  packages/terrain/src/index.ts:254-269, 315-391, 423-446 (prepare at order -6, draw at order 1, drawShadow).
- Lighting composition: follow VAT, not terrain: `addLighting(effect)` with `pbr(1)` hooks composed by `lightPBR`
  (packages/shared/pbr-hooks.js), `layout: 'auto'`, `getBindGroupLayout(1)` (packages/animation/src/vat.ts:473-482,
  569-576, 597-608, 640-643). Shadows.add calls addLighting (shadows/src/index.ts:300-312, 363-373); clustered calls
  receiver.addLighting (clustered/src/index.ts:71-73, 251-266, 285); Fog via ShaderEffect.add -> addLighting with an
  `output` hook on binding 25 (environment/src/lighting.ts:28-38, 84-99, 398-400). The voxel fragment shader must
  contain gltf-pro's hook points: `direct+ambient(s)`, `var color=...+s.emissive;`, `fn ambient(s:Surface)`, the
  tone-map line keyed on `f.settings.w` (pbr-hooks.js:28-62).
- Shadow casting: static `drawShadow` source drawn into the cached map, redrawn when `shadowVersion` changes
  (shadows/src/index.ts:80-86, 552-556, 786-797). Day/night: Sky writes the sun into engine.lighting every frame
  (sky/src/base.ts:338-366); read it as terrain does (terrain/src/index.ts:291-292). Pass orders in use: decals 1.9,
  sky 2, water 4, sky fog 5, vfx 6, OIT 8, SSAO 10+.
- Indirect draws: core requests only depth32float-stencil8 + EngineOptions.features (core/src/engine.ts:18-19,
  renderer.ts:128-131); avoid non-zero firstInstance (needs indirect-first-instance). drawIndexedIndirect already in
  packages/culling/src/index.ts:559. Frustum with reverse-Z: @margoengine/math/frustum (math/src/frustum.ts:38-39).
- Workers: `src/<name>.worker.ts` -> `dist/workers/<name>.js` classic IIFE (scripts/build-workers.js:8-36), started with
  `new URL('./workers/x.js?no-inline', import.meta.url)` (packages/fbx/src/worker.ts:6); build-optional.js builds
  every `exports` entry. Decoders pool (packages/decoders/src/pool.ts:71-224) has no priority/cancel.
- Rapier 0.21.0: ColliderDesc.voxels, setVoxel, combineVoxelStates, propagateVoxelChange
  (node_modules/@dimforge/rapier3d-compat/dist/geometry/collider.d.ts:434-470, 753); physics exposes `rapier`, `world`
  (packages/physics/src/physics.ts:155, 260).
- Real-GPU tests: follow packages/sky/test/browser-check.mjs (openBrowser from scripts/browser.js) under
  `node scripts/gpu-lock.mjs run --owner=...`. WGSL is only proven valid in the browser; WGSL changes also need
  build:site + visual:check.

## Package layout (packages/voxel)
| Subpath | Exports | Worker |
|---|---|---|
| `.` | block registry, chunk storage, world, block-state helpers | no |
| `./mesher` | `meshChunk` (pure), `VoxelMesher` (worker client) | mesher.worker.ts |
| `./render` | `VoxelRenderer`, `BlockTextures` | CPU mip generation once |
| `./light` | `VoxelLighting` | no (main-thread BFS with a per-frame budget) |
| `./query` | ray cast, swept box, character | no |
| `./physics` | `VoxelPhysics` (optional peer @margoengine/physics) | no |
| `./stream` | `VoxelStreamer`, chunk stores | drives generation workers |
| `./generate` | worker-side generator API, built-in noise terrain | terrain.worker.ts (+ app module workers) |
| `./codec` | chunk, block-change, entity codecs | no |
| `./vox` | `.vox` read/write | no |
Dependencies: core (peer), math (MargoError, Frustum, types), procedural (bundled into the terrain worker), physics
optional peer for ./physics only. Compression: browser CompressionStream. Outside the package: internal
`packages/shared/worker-pool.js` (central priority queue, cancel, timeout); `AudioVoicePool` in @margoengine/audio;
atlas frames on @margoengine/vfx's texture option.

Usage: `const blocks = new BlockTypes(); const stone = blocks.define('stone', {...}); const world = new VoxelWorld({blocks});
const voxels = VoxelRenderer.attach(engine, {world, textures}); shadows.add(voxels, {static: true}); clustered.add(voxels);
fog.add(voxels); VoxelStreamer.attach(engine, {world, generator, store}); world.setBlock(x, y, z, stone);
voxels.daylight = 0.3; voxels.dispose();`

## Public names (final)
`.`: `CHUNK_SIZE` (32); `BlockTypes` (`define(name, options) -> id`, `id(name)`, `get(id)`, `table` plain data for
workers); `BlockTypeOptions` (`textures` per face (+x, -x, +y, -y, +z, -z) or all, `layer`, `shape`, `solid`,
`liquid`, `light` 0-15, `opacity` 0-15, `color`, `roughness`, `metalness`, `emissive`, `animation {frames, fps}`);
`BlockType` (a resolved definition: what `get` and `table` hold); `BlockLayer`
('opaque'|'cutout'|'translucent'|'invisible'); `BlockShape` ('cube'|'cross'|'liquid'); `blockState(id, state)`,
`blockId(s)`, `blockData(s)` (u32: id 16 bits, state 16 bits);
`VoxelChunk` (32^3 palette storage: get, set, fill, getLight, setLight, pack(), VoxelChunk.unpack()); `PackedChunk`
(transferable: palette, bits, words, light); `VoxelWorld` (getBlock, setBlock, setBlocks, getChunk, addChunk,
removeChunk, heightmap, dirty, onChange); `VoxelWorldOptions` (blocks, minY, maxY); `chunkKey(cx, cy, cz)`.
`./mesher`: `meshChunk(input) -> ChunkMesh`; `MeshInput` (chunk, 1-cell neighbour shell, light, block table);
`ChunkMesh` (opaque, cutout, translucent quad words + visibility bits); `VoxelMesher` (mesh(world, key, priority),
cancel); `QUAD_WORDS` (3); `decodeQuad(words, i)`.
`./render`: `VoxelRenderer` (plugin + lighting target: drawShadow, shadowVersion, stats, daylight, blockLightColor);
`VoxelRendererOptions` (world, textures, workers, maxQuadBytes, daylight, fancyLeaves); `VoxelRendererStats`
(chunks, visible, quads, bytes, draws); `BlockTextures` (owns the 2D-array texture: BlockTextures.load(),
fromAtlas(), live set(layer, image)); `BlockTexturesOptions` (size, images).
`./light`: `VoxelLighting` (attach(world), budget, skyLight(), blockLight()); `VoxelLightingOptions`; `MAX_LIGHT` (15).
`./query`: `raycastVoxels(world, origin, dir, max) -> VoxelHit | null`; `VoxelHit` (cell, normal, adjacent, point,
distance, state); `sweepBox(world, box, motion) -> VoxelSweep`; `VoxelSweep` (position, hit axes, onGround);
`VoxelCharacter` (walk, step-up, swim, fly); `VoxelCharacterOptions` (size, stepHeight, gravity, speeds);
`VoxelMoveIntent` (wish direction, jump, descend, sprint).
`./physics`: `VoxelPhysics` (Rapier voxel colliders for chunks near bodies); `VoxelPhysicsOptions` (radius).
`./stream`: `VoxelStreamer` (rings around viewers, priority queue, memory budget, save on unload);
`VoxelStreamerOptions` (world, generator: NoiseTerrainOptions or a URL, store, distance, verticalDistance, workers,
memoryBudget); `ChunkStore` (get, put, delete, flush); `IndexedDBChunkStore`.
`./generate`: `serveVoxelGenerator(fn)`; `VoxelGenerate` ((chunk, cx, cy, cz, context)); `noiseTerrain(options)`;
`NoiseTerrainOptions`.
`./codec`: `encodeChunk`/`decodeChunk`; `encodeBlockChanges`/`decodeBlockChanges`/`applyBlockChanges`; `EntityCodec`;
`EntityField` (position, rotation, u8, u16, f32).
`./vox`: `parseVox`/`writeVox`; `VoxScene`, `VoxModel`, `VoxMaterial`, `VoxNode`, `VoxLayer`;
`pasteVoxModel(world, model, at, mapping?)`.
Extras: `AudioVoicePool`, `AudioVoicePoolOptions` (audio); `ParticleAtlas` ({columns, rows, frames: 'random'|'lifetime'}
on vfx's texture option). Avoided taken names: `World`, `RayHit`, `WorkerPool`.

## Data formats
- Chunks 32^3 cubic (unlimited height, vertical culling, 8x fewer draws than 16^3; quad position/size fit 5 bits per
  axis; remesh 32,768 cells ~1-3 ms target). Render distance 16 means a 256-block radius = 8 chunks.
- Block state u32: id in the low 16 bits, state data in the high 16, so a plain block id is its own state and air
  is 0. Index order x | z<<5 | y<<10. Index widths 0,1,2,4,8,16 bits (never straddle a u32). Palette entries
  reference-counted (Uint16Array) so the palette shrinks: a width narrows once half the next narrower one would do
  (hysteresis), and a chunk left with one state becomes uniform. Uniform chunk = palette only. A cell that held the
  last use of its state reuses that slot, so the palette never exceeds 32,768 entries. `pack()` copies (each array
  owns its buffer); `unpack()` copies, merges duplicate or unused entries and narrows an over-wide width.
- Light per chunk Uint8Array(32768): sky high nibble, block low nibble; uniform byte until first differing write.
  Per chunk column (cx, cz) Int16Array(1024) heightmap (index x | z<<5: y of the highest light-blocking cell, -32768
  for none) seeds sky light; the world creates it with the column's first chunk and drops it with the last. Cell y
  is therefore int16 (VoxelWorldOptions minY/maxY default -32768/32767); x and z are int32.
- World: chunk keys are strings 'cx,cy,cz' (chunk coordinate = cell >> 5); unloaded cells read as air; a non-air
  setBlock in an unloaded chunk adds an air chunk; `dirty` holds keys to remesh (edited chunks, loaded neighbours
  whose one-cell shell holds an edited border cell, added chunks and their 26 loaded neighbours, removed keys, which
  have no chunk); `onChange(x, y, z, state, previous)` fires once per changed cell of setBlock/setBlocks.
- Mesher input: PackedChunk + a 34^3 shell (6,536 states + light: faces, edges, corners for AO/smooth light).
- Quad 12 bytes (3 u32, vertex pulling): w0 = x5 y5 z5 face3 (0-5 axes, 6-7 cross diagonals) (w-1)5 (h-1)5 flip1
  liquidDrop3; w1 = material12 ao 4x2 wave1 spare11; w2 = 4 corners x (sky4 block4). Greedy merges only faces with equal
  corners along the merge axis, so merged meshes shade identically to the naive mesh.
- Material table storage buffer, 16 B per entry, up to 4,096: texture layer, animation frames/fps, tint RGBA8,
  roughness, metalness, emissive.
- Chunk codec: u8 version, u8 flags, varint palette length, varint states, u8 bits, u32 index words LE, optional light
  (uniform byte or 32 KiB dense); compressed with CompressionStream('deflate-raw'). Block changes: varint count, entries
  sorted by chunk+index, zigzag-varint offset from previous + varint state. Entities: varint id delta, field mask,
  quantized fields (position zigzag varints in 1/512-block steps from baseline, rotation smallest-three 32 bits).
- Region file (OPFS/export only; IndexedDB stores one compressed record per chunk keyed [cx,cy,cz]): r.X.Y.Z.mvxr for
  8^3 chunks, 4 KiB header (magic MVXR, version, 512 x {u24 sector offset, u8 count}, 512 x u32 timestamps), 4 KiB
  sectors, compact when over half free.

## Renderer
- Passes: order -6 prepare (CPU frustum cull per chunk, translucent chunk back-to-front sort, finished-mesh uploads at
  most 4 MiB/frame, indirect-argument write); order 1 opaque + cutout (before decals 1.9 and sky 2); order 4.5
  translucent (after water 4, before sky fog 5).
- Pipelines (async, cached by format, samples, depth format, shader text): opaque (back-face cull, depth write);
  cutout (alpha test, alpha-to-coverage at 4x, no cull); translucent (premultiplied over, depth test no write, no
  cull); shadow (depth only, depth32float, less-equal, alpha-tested cutout variant).
- Bindings: group 0 frame uniform (camera, eye, engine.lighting, HDR flag settings.w, time, daylight, light curve,
  block-light colour), quad pool, page and chunk-origin tables, material table, block texture, sampler; group 1 from
  lighting effects via pbr(1) (shadows 1-3, clustered 4-7, IBL 20-24, fog 25).
- One quad pool storage buffer: 64 MiB default growing to maxQuadBytes (default 96 MiB). First-fit 64-quad pages,
  in-place reuse. Shader gets quad = vertex_index>>2, corner = &3, chunk from pages[quad>>6], firstInstance 0. Static
  u32 index buffer 2.25 MiB (worst-case 98,304 quads per chunk layer). 20-byte drawIndexedIndirect args per chunk and
  layer; opaque and cutout recorded into GPURenderBundles re-recorded only when the resident set, pipeline or lighting
  changes; per frame the CPU cull writes instanceCount 0/1 (~46 KB). Translucent chunks (~40) encoded directly in sorted
  order. If bundles prove too costly during streaming, fall back to direct draws.
- Texture: rgba8unorm-srgb 2D array, up to 256 layers (default limit), CPU mips with alpha-coverage-preserving box
  filter, mag nearest, min/mip linear, textureSampleGrad on unwrapped UV so tiled greedy quads do not seam.
- Lighting: AO x sky-light curve -> s.occlusion (also attenuates IBL ambient); block light -> s.emissive; direct sun x
  sky visibility beyond the shadow distance; `daylight` (live, default 1) scales sky light only. Water/lava: animated
  layers; liquid tops with `wave` move vertically by world x,z so neighbours stay seamless.
- Shadows: `{static: true}`, shadowVersion bumps only when a changed chunk intersects the shadow bounds; per-cascade
  CPU cull from ShadowContext.matrix.
- Translucency: sorted (chunks back to front; worker orders quads per chunk from the camera cell; re-sort near chunks
  after the camera moves >= 4 blocks); water-water and glass-glass faces culled.
- Device loss: onDeviceRestored remeshes everything.
- Budget targets at render distance 16 on the Arc 140V (1080p, 4x MSAA, 2-cascade PCF to 96 m, fog, sky): ~2,100
  resident chunks, 500-700 meshed, ~2.5M quads ~30 MiB GPU, ~50 MiB CPU chunk data (memoryBudget default 128 MiB),
  ~250 opaque + 120 cutout + 40 translucent draws, 60 FPS, voxel GPU <= 7 ms, main-thread voxel CPU <= 1 ms/frame,
  <= 3 ms per chunk mesh per worker (3 workers >= 600 meshes/s), spawn RD4 < 1 s and RD16 < 6 s, edit to pixels <= 2
  frames. Targets until phase 13 measures them.

## Decisions on the open questions (made 2026-10-19, report them; Scott can overrule)
1. Quads stay 12 bytes with baked per-vertex smooth light (best look now; a per-chunk 3D light texture is a later option).
2. 256 texture layers in v1 (default limits; no core change).
3. Translucency sorted in v1; no generic OIT source API.
4. World size bounded by float32 (~100 km jitter); no floating origin in v1; document it in limits.md.
5. `engine.pick` does not see voxels; games pick with `raycastVoxels`.
6. Light on the main thread with a per-frame budget, single-channel with one block-light tint colour in v1.
7. No SharedArrayBuffer; mesh jobs copy ~50 KB.
8. Measure T-junction cracks in phase 4; fix if visible.
9. Try render bundles; fall back to direct draws if re-recording costs too much.
10. App generators are module workers; built-in ones classic.
11. Worker pool stays internal in packages/shared.
12. `.vox`: SIZE, XYZI, RGBA, MATL, nTRN, nGRP, nSHP, LAYR; keep unknown chunks (rOBJ, rCAM, NOTE, IMAP, META) as raw
   bytes for lossless round trips. Fixtures: our own files written by `writeVox`, plus one sample from
   ephtracy/voxel-model (MIT since 2026-04-29) with its licence noted.

## Phases (one worktree agent each; every phase runs AGENTS.md gates; shader phases add build:site + visual:check)
1. Storage (`.`): registry, chunk, world, dirty tracking, pack/unpack. Node tests vs a dense-array oracle, palette
   growth/shrink, border edits mark neighbours dirty. Creates the package (package.json, README, build wiring,
   catalog) and commits this design as packages/voxel/DESIGN.md.
2. Mesher (pure): greedy, AO, smooth-light inputs, three layers, cross and liquid shapes, quad format. Tests: known
   shapes, AO values, merged quads expand to exactly the naive faces, culling rules, Node benchmark.
3. Worker mesher + shared pool: mesher.worker.ts, priority, cancel, shell extraction; CSP-safe worker test.
4. Renderer v1: pipelines, BlockTextures, pool allocator, cull, indirect draws + bundles, device restore. Browser check:
   greedy vs naive pixels identical at 4x and 1x MSAA on HDR and canvas formats, no validation errors.
5. Lighting hooks: addLighting, drawShadow, fog, clustered, IBL, daylight, animated water/lava.
6. Light (`./light`): BFS with removal across borders, heightmap seeding, budget; incremental == full recompute.
7. Queries (`./query`): ray cast vs brute force, step-up 0.5/1.0, ceilings, swim, no tunnelling.
8. Codec + store: round trips, fuzz targets in `npm run fuzz`, IndexedDBChunkStore.
9. Streaming + generation: rings, priority, LRU eviction, built-in and URL generators; no holes, memory budget.
10. `.vox`: round trip incl. unknown chunks, real fixture, fuzzing.
11. Rapier (`./physics`).
12. Extras: AudioVoicePool, vfx atlas frames, (optional) decoders on the shared pool.
13. Example + benchmarks: examples/voxel-sandbox, a /voxel/ site page with visual baselines (fixed seed and time),
   benchmark JSON for RD 8 and 16 behind the quiet gate, README, limits.md rows, catalog, api:update.
Order: 1 first; then 2, 6, 7, 8, 10, 11, 12 can run in parallel (they need only the storage API); 3 after 2; 4 after
3; 5 after 4; 9 after 3 and 8; 13 last.

## As built (phases 1-13; recorded by the merger 2026-10-19)

Status: on main are phases 1 (storage), 2 (mesher), 3 (worker mesher), 4 (renderer), 5 (renderer lighting), 6 (light),
7 (queries), 8 (codec, store), 9 (streaming, generation), 10 (.vox), 11 (Rapier), 12 (extras: audio and vfx) and 13
(example and benchmarks). Names and decisions beyond the lists above:

- Storage: `BlockType` (what `get` and `table` return); `VoxelChunk.getLight`/`setLight`/`fillLight`/`byteLength`;
  `VoxelWorld.heightmap`, `blocks`, `minY`, `maxY`, `onChunk(listener)` (fires for loaded chunks at subscribe, after
  each addChunk incl. setBlock's automatic air chunk, and with undefined after removeChunk). Block state: id in the low
  16 bits, data in the high 16. Chunk keys are strings 'cx,cy,cz'. A removed chunk's heights stay in the heightmap.
- Mesher: `meshInput(world, key)`, `blockMaterials(blocks)`, `DecodedQuad`; `ChunkMesh` fields `opaque`, `cutout`,
  `translucent`, `visibility` (cave-culling connectivity bit a*6+b for chunk faces a < b). Quad word 2 holds each
  corner's sky light in the LOW nibble and block light in the high one (the reverse of the chunk light byte).
  Material ids number distinct (block, texture layer) pairs, up to 4,096. Worst case 196,608 quads in one layer
  (a two-glass 3D checkerboard), twice the 98,304 the index buffer above assumes.
- Worker mesher: `VoxelMesherOptions`, `VoxelMesher.workers`, `mesh(world, key, priority, eye?)`, `sortQuads`;
  internal `packages/shared/worker-pool.js` (`JobPool`). The mesh input is built when a worker takes the job;
  re-calling `mesh` on a running job discards it. 828 meshes/s with 3 workers measured under full CPU load.
- Light: `VoxelLighting.attach(world, {budget})` (default 4096 cells per `update()`, Infinity allowed). Changed
  chunks go into `world.dirty`; there is no separate event.
- Queries: `raycastVoxels(..., filter?)`; `VoxelSweep.hit`; `VoxelMoveIntent.direction`; `VoxelCharacterOptions.speeds`
  {walk, sprint, swim, fly, jump}; `VoxelCharacter.renderPosition` (interpolated) and fixed 1/120 s steps.
- Codec and store: `EntityState`, `MemoryChunkStore`; `encodeChunk`/`decodeChunk` are async; stores take and return
  `VoxelChunk`.
- Streaming and generation: `VoxelStreamerOptions.chunksPerFrame` (default 8), `VoxelStreamer.viewers`, `onError`,
  `pending`, `save()`; `VoxelGenerateContext`; `@margoengine/procedural` is a dependency. ~800 generated chunks/s with
  2 workers under load; unpacking 8 chunks a frame costs 1.2-1.5 ms on the main thread at full speed.
- .vox: `VoxChunk`; records keep their raw `attributes`; all 48 rotation bytes; `pasteVoxModel` pastes a whole scene
  (z up becomes world y, y becomes world -z). Pasting is about 1 s per million voxels (per-cell setBlock): batch later.
- Rapier: `new VoxelPhysics(physics, world, {radius})`, `colliders`; colliders follow every non-fixed body and are
  kept until no body is within radius + 1. Rapier 0.21.0 panics on ball-vs-voxel edges (dimforge/rapier #1046 reports it; see #1029, #1043,
  #993, fix PR #1030), so chunks near a ball get a FIX_INTERNAL_EDGES triangle mesh and keep a disabled voxel
  collider; a cave-heavy chunk near a ball costs ~125 ms to build (not yet spread over frames). Voxel contacts produce
  no `Physics` collision events.
- Renderer (phase 4): `VoxelRendererOptions` as designed; `VoxelRendererStats` {chunks, visible, quads, bytes, draws};
  `BlockTextures` (constructor `{images, size}`, `load(urls)`, `fromAtlas(image, {size})`, `layers`, live
  `set(layer, image)`, `dispose()`). The quad pool starts at 4 MiB (not 64) and doubles to `maxQuadBytes`; the static index buffer holds the
  196,608-quad worst case (4.5 MiB). Each pixel is shaded where its ray meets the face plane (texture gradients from the
  neighbouring pixels' hits), so greedy quads shade like unit faces; merged quads are stretched 1/128 pixel along their
  edges to close T-junction cracks (14 crack pixels in a grazing view on the RTX A6000 without it, none with it).
  Greedy and one-quad-per-face images differ only in edge samples (under 0.6% of drawn pixels, never a 2 x 2 block):
  bit-identical images are impossible because the two meshes put different vertices on the same edges. Render bundles
  kept (re-record 0.1-0.8 ms). GPU-verified on the Arc 140V and the RTX A6000 (tests/render-browser-check.mjs).
- Renderer lighting (phase 5): `addLighting(effect)` takes a `VoxelRendererEffect` (glTF-pro hooks: `pbr(group)`,
  `bindings()`), composes it with `lightPBR` into all three pipelines (group 1) and keeps the previous pipelines
  drawing while the new ones compile; `drawShadow(VoxelShadowContext)`, `shadowVersion`, live `blockLightColor`
  (default [1, 0.82, 0.6]). Shadow pass: opaque depth only, cutout alpha tested at level 0, translucent casts none,
  every quad extended 1/64 block in its plane (extending merged quads alone made merged meshes cast 1.6 cm larger
  shadows than unit quads). Sun: sky visibility squared without a shadow map; with one, the map alone inside its range,
  the sky term fading back over its last tenth (read from the shadows package's `shadowFrame` uniform). Day and night:
  the app sets `daylight` (for example `1 - sky.nightFactor`); the sun and moon come through `engine.lighting` as
  before. Deviation from "liquid tops move vertically by world x,z": the surface rises and falls uniformly
  (0.04 sin 1.6t) and ripples only in its shading normal (three travelling waves of world x, z), because per-vertex
  height by position would open cracks at greedy quads' T-junctions and make merged and unit meshes differ.
  GPU-verified on the RTX A6000 (tests/render-lighting-browser-check.mjs).
- Example and benchmarks (phase 13): `examples/voxel-sandbox` (site page `/voxel/`; shadows, torch point lights, Sky,
  Bloom), visual references on the RTX A6000 profile only (other profiles skip them until recorded), benchmark
  `npm run bench:voxel` behind the quiet gate. Measured on the A6000 at 1920 x 1080, 4x MSAA (docs/limits.md): render
  distance 8 fills in 1.06-1.22 s (1.18 M quads, 322 draws, 0.7 ms frame CPU still), 16 in 3.59-3.67 s (4.84 M quads,
  1,170 draws; 1.1 ms still in a single-load run, settling from 2.4 ms over about 4 s after a fill); GPU time per
  frame is not yet measured reliably. The sandbox's chunks are 32 blocks, so its render distance 16 is a 512-block
  radius (5,579 chunks), four times the target's "RD16" above (its render distance 8); both fill under 6 s.
- Fill speed (2026-10-20; it took 8.8-9.2 s at render distance 16 before): `VoxelStreamer` starts a load as each one
  finishes (still at most 4 per worker queued, and between updates only while `memoryBudget` has room for every chunk
  on its way at the loaded mean size); a generator may return its column's ceiling (`noiseTerrain` does: highest
  ground, sea or tree crown within its crown radius), and the column's chunks wholly above it load as air without a
  job once the store is read; the renderer gives an all-air chunk its empty mesh without `meshInput` or a worker; the
  lighting reads a chunk's palette without packing it; the sandbox joins 2 ms of chunks a frame while it fills. The
  join budget was the limit: at 0.5 ms the fill took 8.1-8.6 s even with the other changes, at 1 ms 4.1 s, at 2 and
  4 ms 3.5 s, with 20,433, 7,932 and about 6,000 mesh jobs for 2,435 meshed chunks (bigger batches remesh less).
- Extras: `AudioVoicePool` in @margoengine/audio; `ParticleAtlas` on @margoengine/vfx's texture option. The decoders
  pool was not moved onto `JobPool` (its per-worker queue and timeout semantics differ).
