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
  sun and moon into `engine.lighting`), sun and moon shadows (`Shadows`, 2 cascades to 96 blocks, the voxels added
  with `{static: true}`), a `Clustered` point light on each of the 24 light-emitting blocks (torches, glowstone)
  nearest the camera, Sky's depth fog closing in before the render distance, Bloom (HDR and a little glow), and the
  voxel `daylight` following the sky's night factor. Water ripples and bobs (the renderer's liquid animation).
  `window.voxelSandbox.scene` exposes the shadows and lights.

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

### Benchmark

```sh
node examples/voxel-sandbox/bench.mjs   # or npm run bench:voxel; options --distances=8,16 --loads=3 --no-quiet
```

It holds the GPU lock, waits for `scripts/quiet-gate.mjs` (numbers from a busy machine are labelled DIAGNOSTIC), loads
`?view=overview` at render distance 8 and 16 in headless Edge at 1920 x 1080 with the high tier (4x MSAA), and writes
`test-results/voxel-sandbox-bench.json`: spawn time (median of 3 loads after a warm-up load), frame CPU median and p95
over 300 still frames, voxel GPU time median and p95 over 100 frames, a 10 s flight at 11 blocks/s while chunks
stream in, and chunks, quads, quad bytes, draws and chunk data bytes.

Measured 2026-10-19 on the RTX A6000 desktop, quiet-gated (copy in
`examples/package-benchmarks/results/voxel-sandbox-bench.json`):

| | Render distance 8 | Render distance 16 |
| --- | --- | --- |
| Spawn to every chunk in range drawn (3 loads) | 2.45-2.50 s | 8.8-9.2 s |
| First voxel draw | 375 ms | 418 ms |
| Frame CPU, still (median / p95) | 0.6 / 0.9 ms | 1.3 / 1.7 ms |
| Frame CPU, flying 11 blocks/s (median / p95 / worst) | 0.7 / 2.9 / 5.5 ms | 1.6 / 4.4 / 8.4 ms |
| Chunks loaded / with quads / visible | 1,379 / 602 / 206 | 5,579 / 2,435 / 772 |
| Quads, quad bytes on the GPU | 1,182,034, 14.5 MB | 4,838,612, 59.5 MB |
| Draws, chunk data on the CPU | 322, 15.9 MB | 1,170, 64.1 MB |

Voxel GPU time from timestamps between passes is rough: 2.56 ms median at render distance 8 in this run and 0.39 ms in
an earlier, busier one; 0.72 ms at 16 in both. Render distance 16 misses the design's 6 s spawn target.

### Visual checks

`scripts/visual-regression.js` defines `voxel-overview`, `voxel-ground` (high, light and phone) and `voxel-night`
(high) on the site build's `/voxel/?view=...`. References exist on the RTX A6000 profile
(`nvidia-ampere-msedge-155`, recorded 2026-10-19 with shadows and torch lights; four runs each, pixel-identical). On
hardware whose profile is not in the views' `profiles` list they are captured but skipped: record them there with
`npm run visual:update -- --only=voxel --runs=4` and add the profile to `VOXEL` in that script.

## Tests

```sh
npm run test --workspace examples/voxel-sandbox     # Node: textures, block ids, public imports only
node scripts/gpu-lock.mjs run --owner=you -- node examples/voxel-sandbox/test/play.browser.mjs
```

The browser play test (real GPU, headless Edge) spawns on dry ground, takes pointer lock, flies up and forward, lands,
breaks and places a block, swims, changes the render distance and finds the edits again after a reload.

## Not done yet

- No image-based light (the sky's ambient is a constant colour); `Fog.add(voxels)` works but the sky's depth fog hides
  the range edge better, so the example uses that.
- No touch controls (phones only show the deterministic views well), no mobs or items, no crafting.
- Water does not flow; breaking a lake's shore leaves a wall of water.
