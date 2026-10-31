# Voxel sandbox

A small block-world game on [`@margoengine/voxel`](../../packages/voxel/README.md): streamed infinite terrain with
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
| P | photo mode on / off: the loaded world path traced |
| Enter | in photo mode: save a PNG of the view (256 samples, denoised) |

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
| `photo` | | Starts in photo mode (also with `view`). |
| `server` | | `ws://host:port` of a multiplayer server (see below): play there instead of in a local world. |

## How it is built

- **World** (`src/blocks.ts`): 35 block types: stone, dirt, grass, sand, water, log, leaves, planks, cobblestone,
  bricks, glass, torch, plants, glowstone, slabs, stairs, the sign's red heart, and the Plaza's sandstone, marble, slate,
  plaster, walnut planks, roof tiles, gravel, moss, tin ore, silver ore, malachite ore, amber, opal and glow cap, all
  painted in code (`src/textures.ts`). Saves store block ids, so new types go at the end.
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
- **Photo mode** (`src/photo.ts`, P): `@margoengine/voxel-pathtracer` traces the loaded world over the game's frame.
  Each loaded chunk is one traced model (a chunk's cells are in the tracer's own order), sent again only when it
  changes (at most every 0.3 s); the block textures are the tracer's textures, so faces tile as the game draws them.
  Leaves let light through their cut-away texels, water and glass refract, glowstone and torches are lights (a torch
  is a thin glowing stick; tall grass and flowers are left out), and the sky follows the clock: Preetham's daylight
  and the sun by day, a dark sky and the moon by night, with fog thickening toward the view distance. The view
  denoises while the camera moves and refines when it stops.
- **Light, sky, fog and post** live in one function, `setupLighting` in `src/lighting.ts`: `Sky` (Preetham, clouds,
  sun and moon into `engine.lighting`), sun and moon shadows (`Shadows`, 2 cascades to 96 blocks, the voxels added
  with `{static: true}`), a `Clustered` point light on each of the 24 light-emitting blocks (torches, glowstone)
  nearest the camera, Sky's depth fog closing in before the render distance, Bloom (HDR and a little glow), and the
  voxel `daylight` following the sky's night factor. Water ripples and bobs (the renderer's liquid animation).
  `window.voxelSandbox.scene` exposes the shadows and lights.

## Deterministic mode: screenshots and benchmarks

`?view=overview`, `?view=ground`, `?view=night` or `?view=shapes` fixes the seed's world, the camera and the clock (the sky clock does
not run and every frame renders with delta 0, so water and clouds hold still), stores nothing and takes no input. The
HUD and overlays are hidden; the hotbar and crosshair stay. The ground and night views build a small hut with glass
windows, torches and a glowstone lamp post by the lake (`src/showcase.ts`) once its chunks are loaded; the shapes view
builds slabs and stairs there instead (a plank deck under a top-slab roof with stair eaves, a stair flight, a slab
terrace with a double slab, a brick column ringed by stairs and corner stairs, a pool with a waterlogged slab and
stair), seen from above at 10:00 with sun shadows. Placing a slab on the open half of the same slab makes a double
slab, slabs and stairs placed in water are waterlogged, and stairs turn into corners from their neighbours.

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
node examples/voxel-sandbox/measure.mjs --live   # per-pass GPU times, frame CPU and walking speed of any build, to one file
node examples/voxel-sandbox/bench.mjs   # options --distances=8,16 --loads=3 --no-quiet; npm run bench:voxel runs it in the bench tool
```

It holds the GPU lock, waits for `scripts/quiet-gate.mjs` (numbers from a busy machine are labelled DIAGNOSTIC), loads
`?view=overview` at render distance 8 and 16 in headless Edge at 1920 x 1080 with the high tier (4x MSAA), and writes
`test-results/voxel-sandbox-bench.json`: spawn time (median of 3 loads after a warm-up load), frame CPU while the world
fills (median, p95 and worst over the 3 loads), frame CPU median and p95 over 300 still frames, voxel GPU time median
and p95 over 100 frames, a 10 s flight at 11 blocks/s while chunks stream in, and chunks, quads, quad bytes, draws and
chunk data bytes.

Measured 2026-10-20 on the RTX A6000 desktop, quiet-gated (copy in
`examples/package-benchmarks/results/voxel-sandbox-bench.json`):

| | Render distance 8 | Render distance 16 |
| --- | --- | --- |
| Spawn to every chunk in range drawn (3 loads) | 1.06-1.22 s | 3.59-3.67 s |
| First voxel draw | 427 ms | 463 ms |
| Frame CPU while the world fills (median / p95 / worst) | 4.2 / 8.8 / 11.6 ms | 6.6 / 11.1 / 15.8 ms |
| Frame CPU, still, right after the third load (median / p95) | 0.7 / 1.1 ms | 1.7 / 2.2 ms |
| Frame CPU, flying 11 blocks/s (median / p95 / worst) | 0.9 / 3.7 / 6.8 ms | 2.3 / 5.0 / 10.2 ms |
| Chunks loaded / with quads / visible | 1,379 / 602 / 206 | 5,579 / 2,435 / 772 |
| Quads, quad bytes on the GPU | 1,182,034, 14.5 MB | 4,838,612, 59.5 MB |
| Draws, chunk data on the CPU | 322, 15.9 MB | 1,170, 64.1 MB |

Until 2026-10-20 render distance 16 took 8.8-9.2 s (8.6-8.8 s that day): the streamer started at most 12 loads a frame
and the sandbox joined 0.5 ms of chunks a frame. Now a load starts as each one finishes, chunks above their column's
ceiling load as air without a generator job (about 2,360 of 5,579), all-air chunks need no mesh job, and the sandbox
joins 2 ms of chunks a frame while the world fills (0.5 ms once ready). Back to back on the same quiet machine, one
load each at render distance 16: 9.40 s before, 3.36 s after; still frames 1.0 / 1.5 ms before and 1.1 / 1.5 ms after;
flying 1.4 / 4.2 / 8.1 ms before and 1.5 / 3.9 / 7.4 ms after. Frames while the world fills cost more (p95 4.4-5.3 ms
before at render distance 16, 10.5-11.5 ms now) because about 2.6 times as much joins per frame; the worst stays under
a 60 Hz frame. Right after a fill the still frames settle over about 4 s (2.4 ms median in the first 2 s, then 1.3 ms,
p95 1.6-2.0 ms). The design's "RD16 < 6 s" meant a 256-block radius of 16-block chunks, the sandbox's render distance 8;
both distances now fill well under 6 s. Voxel GPU time from timestamps between passes is rough: 0.39 ms median at
render distance 8 and 1.51 ms at 16 in this run (2.56 and 0.72 ms in an earlier one).

### Visual checks

`scripts/visual-regression.js` defines `voxel-overview`, `voxel-ground` (high, light and phone), `voxel-night` and
`voxel-shapes` (high) on the site build's `/voxel/?view=...`; `voxel-shapes` has its reference on the Edge 156 profile
(`nvidia-ampere-msedge-156`, 2026-10-24, four runs pixel-identical). References exist on the RTX A6000 profile
(`nvidia-ampere-msedge-155`, recorded 2026-10-19 with shadows and torch lights; four runs each, pixel-identical). On
hardware whose profile is not in the views' `profiles` list they are captured but skipped: record them there with
`npm run visual:update -- --only=voxel --runs=4` and add the profile to `VOXEL` in that script.

## Multiplayer

```sh
npm run build:packages
node examples/voxel-sandbox/server.mjs            # ws://127.0.0.1:8787; --host=0.0.0.0 for other machines, --seed=N
npm run dev:voxel                                  # then open http://127.0.0.1:5173/?server=ws://127.0.0.1:8787
```

Every tab that opens the sandbox with `?server=` joins one shared world on
[`@margoengine/voxel-net`](../../packages/voxel-net/README.md). The server generates the same terrain and plants as
single player (`src/plants.ts` runs in both), holds the world and checks every edit; the page draws what it is sent,
moves its own player at once and is corrected if the server disagrees, and shows the other players as coloured boxes
(`src/multiplayer.ts`). Flying is allowed. The server lets on only pages from the dev server (`http://127.0.0.1:5173`
and `http://localhost:5173`); for a page served elsewhere pass its origin, `--origins=https://my.site`, or `--origins=*`
for any page. Nothing is saved: the world lasts as long as the server process, and the
render distance (`rd`, 2-8 on the server) is fixed when joining.

## Plaza server

`server/` runs the public world: `router.mjs` forks one `shard.mjs` per world and answers the page, and `admin.mjs` is the
operator's tool. Everything listens on 127.0.0.1, behind a proxy that sets `X-Real-IP` (`--proxied`).

```sh
npm run build:packages
node examples/voxel-sandbox/server/router.mjs --data=plaza-data --origins=*      # http://127.0.0.1:8790
curl http://127.0.0.1:8790/join                                                  # where to connect
node examples/voxel-sandbox/server/admin.mjs status --data=plaza-data
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--data` | required | Folder for worlds, snapshots and the identity salt. |
| `--port` | 8790 | The router's port. |
| `--shard-port` | 8800 | Shard `i` listens on this plus `i`. |
| `--proxied` | off | Take the client's address from `X-Real-IP`; without it, from the socket. |
| `--origins` | `https://margoengine.com` | Pages that may call `/join`, `/report` and `/counters` and connect to a shard, comma separated, or `*`. `/metrics` never gets CORS headers. |
| `--public-url` | the shard's own `ws://` | What `/join` answers, with `{i}` for the shard, such as `wss://example.com/s/{i}`. |
| `--capacity` | 200 | Players per shard. |
| `--max-shards` | 2 | Shards at most; another starts only while a core is free. |
| `--per-identity` | 8 | Players at once from one address; raise it only for a bench. |
| `--idle-minutes` | 10 | A player with no movement and no edit for this long is closed with code 4410, reason `idle`; 0 is no limit. |
| `--peer` | none | Base URL of a second box's router, such as `https://box2.example`. A `/join` with no place on this box goes there, and the answer names that box as `router`. Needs `PLAZA_PEER_SECRET`. Without it the router works alone. |
| env `PLAZA_METRICS_TOKEN` | none | Bearer token for `GET /metrics`; without one it answers 404. |
| env `PLAZA_PEER_SECRET` | none | The secret both boxes share, for `GET /peer/status` and `GET /peer/join`, sent as a Bearer header; without one they answer 404. They never get CORS headers. |

A world lasts 6 hours. Its edited chunks are saved every 10 minutes, so a crash loses at most that; a world's end closes
each client with 1001, and the page asks `/join` again. A player idle for 10 minutes (no movement, no edit; a hidden tab still answers pings, so pings do not count) is closed with code 4410 and reason `idle`, which frees its place; a page must not rejoin on that code. Worlds get a stone square at the origin that players cannot edit
(`src/plaza.ts`, only with `plaza=1` in the generator's URL), and names come from two word lists (`src/names.ts`).
Those worlds also have wider tunnels and finds (`src/finds.ts`, never in the page's own generator or the deterministic views):
cave mouths about every 40 x 40 blocks (always near the spawn ring), each a 3 x 3 hole with a ramp back up, a stone lip and
glow caps; glow caps on tunnel floors; veins of tin (2 to 24 deep), silver (8 to 40), malachite (4 to 30) and amber (1 to 6,
in dirt and sand); and exactly 1,000 opals on tunnel floors within 512 blocks, worked out from the seed without generating a
chunk. None of it touches the square, the sign or a spawn ring column.

The shard keeps what each player finds (`server/counts.mjs`). The rules ask the server's own block state, never the client:
digging a natural ore or opal adds one to the digger's count; placing one needs a count and spends it; a placed one breaks
only for the person who placed it, who gets it back, so placing and breaking your own earns nothing, and other people cannot
take a build apart. Each dug cell pays once, even if a rollback or a crash brings the block back. A placed block a rollback
removes goes back to its owner. The world's opal count (`found` of 1,000) only goes up, and a placed opal never moves it.
A player is the salted hash of their address (`server/identity.mjs`), so a household shares one count, more than one tab
shares it too, and a new address starts from nothing and cannot break what the old one placed. Counts live in the world's
`state.json`, written every 30 seconds when they changed and with each snapshot, so a restart keeps them and a crash loses at
most the last 30 seconds. They belong to one world: when the 6 hours end each page gets its last counts, and then the state
file is deleted, so nobody's counts carry over to the next world and only `found` and `total` stay, in the final `<id>.json`,
`/finished/index.json` and, for the live world, `/join`. The page hears through one app message (`src/counts.ts`).
The router's `/join` answer carries the world's `seed` and `floor`; the page keeps `floor` and asks the shard's own
rule (`isPlazaProtected`, `src/plaza-area.ts`) before it predicts an edit, so a protected cell never flashes and the
player reads "The square is protected. Build outside it." (at most once every 4 seconds). An edit the shard refuses for
any other reason (too fast, out of reach, someone standing there, a frozen area) is put back by the server and the page
says "That change did not go through." A page joined with a bare `?server=` has no floor, so it shows no seed and
leaves the rule to the server.

With a second box, the first stays the only front door. Each box runs its own router and shards; the first asks the second for its room every 5 s and marks it down after two misses, and a `/join` it cannot place itself goes to the second with a 1.5 s limit. Any failure there gives the answer the first box would give alone. `/counters` and `/metrics` then add the second box's online count, and `/metrics` gains `peer: { up, online, room, forwards, failures }`. `blocksToday`, `worldsFinished` and `/finished/index.json` stay each box's own.

## Tests

```sh
npm run test --workspace examples/voxel-sandbox     # Node: textures, block ids, public imports, the Plaza server
node scripts/gpu-lock.mjs run --owner=you -- node examples/voxel-sandbox/test/play.browser.mjs
```

The browser play test (real GPU, headless Edge) spawns on dry ground, takes pointer lock, flies up and forward, lands,
breaks and places a block, swims, changes the render distance and finds the edits again after a reload.

## Not done yet

- No image-based light (the sky's ambient is a constant colour); `Fog.add(voxels)` works but the sky's depth fog hides
  the range edge better, so the example uses that.
- No touch controls (phones only show the deterministic views well), no mobs or items, no crafting.
- Water does not flow; breaking a lake's shore leaves a wall of water.

## Load time

`?timing` shows where the seconds of loading went, as plain text at the top left, in seconds from the moment the page was asked for. Each line reads phase, time, and the gap since the phase before it. Without the option nothing changes and its code is not downloaded. `CAN MOVE` is the player's moment; `Everything drawn` is the whole view.

`node examples/voxel-sandbox/loadtime.mjs` measures the same phases on this machine against a local router and shard, with the connection and CPU held to phone-like settings. It is an emulation with this machine's GPU, so its numbers are for comparing builds, not for quoting as a phone's.
