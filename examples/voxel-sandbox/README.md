# Voxel sandbox

A small Minecraft-style game on [`@margoengine/voxel`](../../packages/voxel/README.md): streamed infinite terrain with
caves, lakes, trees and plants, sky and block light, a first-person body that walks, sprints, jumps, swims and flies,
breaking and placing blocks, a hotbar, and saves in the browser. Every block texture is painted in code (16 x 16 pixel
art from seeded noise, `src/textures.ts`); there are no image files. It uses only the packages' public entries
(`test/module-boundary.test.js` checks this).

```sh
npm run build:packages        # once, and after package changes
npm run dev:voxel             # http://127.0.0.1:5173/
```

The site build (`node scripts/build-site.js`) publishes it as `/voxel/`.

## Controls

| Key | Action |
| --- | --- |
| Click | play (pointer lock); Esc pauses and saves |
| W A S D, arrows | move |
| Mouse | look |
| Space | jump; swim up; fly up. Twice quickly: fly on / off |
| Shift | sprint; down when flying or swimming (C also goes down) |
| F | fly on / off |
| Left / right click | break / place a block (hold to repeat) |
| Middle click | put the block you look at in the hotbar |
| 1-9, wheel | choose a hotbar slot |
| V | render distance 4, 8, 12, 16 chunks (128-512 blocks) |
| T | time of day, in 3-hour steps |
| H or F3 | hide or show the HUD |

The HUD shows frames per second, position, chunk, render distance, chunks (with quads on the GPU, in view, loaded, still
to load), quads, quad memory and draw calls (`voxels.stats`).

## URL parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `seed` | 1 | World seed (an integer). Each seed has its own save. |
| `rd` | 8 | Render distance in chunks (2-32); V cycles 4, 8, 12, 16. |
| `time` | 10 | Clock hours at start; a day lasts 20 minutes. |
| `quality` | measured | `high` (4x MSAA) or `low` (light tier), as `@margoengine/quality`. |
| `workers` | package default | Mesher workers (1-8). |
| `reset` | | Deletes this seed's save (chunks and player), then reloads without it. |
| `view` | | Deterministic mode, see below. |
| `pose` | | With `view`: `x,y,z,yaw,pitch` replaces the view's camera (y 0: eye height over the ground). |
| `gpuTiming` | | Requests `timestamp-query` so `voxelSandbox.gpuTiming()` can time the voxel passes. |

## How it is built

- **World** (`src/blocks.ts`): 16 block types (stone, dirt, grass, sand, water, log, leaves, planks, cobblestone,
  bricks, glass, torch, tall grass, dandelion, poppy, glowstone). Saves store block ids, so new types go at the end.
- **Generation** (`src/generator.worker.ts`): a module worker that `VoxelStreamer` starts by URL (`?worker&url`,
  seed in the query). It runs the built-in `noiseTerrain` (`src/terrain.ts`: sea level 0, height 8, amplitude 32,
  scale 192, caves 0.3, trees 0.012) and then puts tall grass (9%), dandelions and poppies (0.6% each) on grass
  columns chosen by a hash of the column, so every chunk generates the same in any order.
- **Streaming**: `VoxelStreamer.attach` with the render distance, 3 chunks up and down, an `IndexedDBChunkStore` per
  seed (memory in deterministic views), 32 chunks per frame while loading and 8 once loaded. Edited chunks save when
  they unload, every 15 s, on Esc and when the page hides; the player's position and hotbar go to `localStorage`.
- **Light**: `VoxelLighting` updates after the streamer each frame (a plugin added after it), so a chunk that joins
  the world is lit before it is meshed; unlimited budget while loading, 16,384 cells a frame after.
- **Drawing**: `VoxelRenderer` with `BlockTextures` from the painted pixels. The block outline is a `@margoengine/lines`
  segment box.
- **Player**: `VoxelCharacter` (fixed 1/120 s steps, eye 1.62 above the feet). The body holds still while the chunk
  under it is not loaded. Breaking and placing use `raycastVoxels` (reach 6); a solid block is never placed inside the
  body, plants need a solid block under them, and breaking a block also breaks a plant or torch standing on it.
- **Light, sky, fog and post** live in one function, `setupLighting` in `src/lighting.ts`: `Sky` (Preetham, clouds,
  sun and moon into `engine.lighting`), Sky's depth fog closing in before the render distance, Bloom (HDR and a little
  glow), and the voxel `daylight` following the sky's night factor. The voxel renderer's own lighting hooks (shadows,
  clustered lights, fog, IBL, day/night, water animation; `packages/voxel/DESIGN.md` phase 5) are being built in
  parallel and go there when they land.

## Deterministic mode: screenshots and benchmarks

`?view=overview`, `?view=ground` or `?view=night` fixes the seed's world, the camera and the clock (the sky clock does
not run and every frame renders with delta 0, so water and clouds hold still), stores nothing and takes no input. The
HUD and overlays are hidden; the hotbar and crosshair stay. The ground and night views build a small hut with glass
windows, torches and a glowstone lamp post by the lake (`src/showcase.ts`) once its chunks are loaded.

`window.voxelSandbox` reports progress:

- `ready`: every chunk in range is loaded, lit, meshed and uploaded: the streamer has nothing pending, the light queue
  is empty, no chunk is dirty, and the renderer's chunk and quad counts have not changed for 30 frames.
- `timeline`: milliseconds from the streamer's start: `firstDraw`, `loaded` (nothing pending) and `spawn` (the last
  change before `ready`); `startedAt` is the page time when streaming started.
- `stats()`: `voxels.stats` plus loaded chunks, chunk data bytes, render distance, tier, canvas size and workers.
- `frames(n)`: CPU milliseconds of the next n frames (the frame callback: update and `engine.render`).
- `fly(n, speed)`: moves the camera forward `speed` blocks per second in fixed 1/60 s steps for n frames while chunks
  stream in; returns the frame CPU times and the stats after.
- `gpuTiming(n)`: GPU milliseconds of the voxel passes for n frames, from timestamp queries around pass orders 1 and
  4.5 (needs `?gpuTiming` and an adapter with `timestamp-query`; null otherwise).
- `world`, `player`, `streamer`, `voxels`, `target`, `spawned`: the live objects, for tests and the console.

## Tests

```sh
npm run test --workspace examples/voxel-sandbox     # Node: textures, block ids, public imports only
node scripts/gpu-lock.mjs run --owner=you -- node examples/voxel-sandbox/test/play.browser.mjs
```

The browser play test (real GPU, headless Edge) spawns on dry ground, takes pointer lock, flies up and forward, lands,
breaks and places a block, swims, changes the render distance and finds the edits again after a reload.

## Not done yet

- No shadows, fog on the voxels themselves, IBL or animated water surface (the renderer's lighting phase).
- No touch controls (phones only show the deterministic views well), no mobs or items, no crafting.
- Water does not flow; breaking a lake's shore leaves a wall of water.
