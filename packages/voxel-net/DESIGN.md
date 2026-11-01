# @margoengine/voxel-net: design (approved 2026-10-21)

This design and the four questions at the end were accepted on 2026-10-21: the name, the
distances, the bench scenarios, and the faster `EntityCodec` path. It is built: README.md, `bench/`, and the measured
results in `docs/voxel-net-capacity-2026-10-21.md`.

Goal: the smallest real multiplayer layer for a Margo voxel world, then headless bots that load it, so we can say,
with measured numbers, how many players one server process on this PC can serve at 20 ticks per second.

Rules it follows: an optional package (core and stage stay frozen); clean-room code with no third-party runtime package
(the WebSocket server is written here on `node:http`, `node:crypto` and `node:worker_threads`); TSDoc on public
exports; errors per docs/conventions.md.

## What the existing code costs (measured 2026-10-21, this PC: Ryzen 9 9950X, Node 26.12, one thread)

A small probe on the sandbox's terrain settings (seed 1), for one player's view of radius 6 chunks, 3 up and 3 down:

| Measure | Result |
| --- | --- |
| Chunks in that view | 791 (335 of them one block type, mostly air or stone) |
| `noiseTerrain` per chunk | 0.34 ms mean, 0.32 ms median, 0.71 ms p95 (without the sandbox's plants) |
| `encodeChunk` (no light, deflated) for the whole view | 302 KB to send (3.8 MB before deflate) |
| The same 791 chunks held as `VoxelChunk`s | 3.7 MB |
| `encodeChunk` of a ground-level chunk | 0.31 ms |
| `VoxelCharacter` fixed step (1/120 s) | 1.1 µs |
| `EntityCodec.encode`, 100 receivers x 100 moving players | 9.5 ms (about 1 µs per player per receiver), 1,001 bytes per receiver |

What this suggests (estimates, not measurements): physics is cheap (400 players at 120 steps/s is about 2.6 ms per
tick); chunk generation is cheap enough for workers; the risk is player updates in a crowd, which grow with players
squared: 400 players in one spot would cost about 150 ms per tick with `EntityCodec` as it is, three times the budget.
The bench will measure that directly.

## Package

`packages/voxel-net`, entries:

- `.` (browser and Node): the message codecs and `VoxelNetClient`. No Node imports.
- `./server` (Node only): `VoxelServer`, the WebSocket server and the generator worker.
- `./bot` (Node only): `VoxelBot`, a headless client for load tests.

Depends on `@margoengine/voxel` and `@margoengine/net`; no other runtime dependency.

## Server

- **World.** One authoritative `VoxelWorld` (packages/voxel/src/world.ts) with the game's `BlockTypes`. The server
  holds full chunks only within the **simulation distance** of some player: that is where physics runs and edits are
  accepted. Chunks a client can see but nobody can touch are kept only as compressed bytes in a cache with a memory
  budget (the probe: 0.3 MB compressed against 3.7 MB as chunks for one view), and made again on a cache miss.
- **Generation.** `node:worker_threads` workers run `noiseTerrain` (packages/voxel/src/generate.ts), or a game's own
  generator module, and `encodeChunk` in the same job, so the main thread gets back both the packed chunk and the bytes
  to send. Same seed, same chunk, so dropping and remaking is safe. Default workers: a quarter of the cores, 1 to 8.
- **Edited chunks** stay in memory as `VoxelChunk`s up to `maxEditedChunks`, so an edit is never lost by unloading.
  With a `store` (a `VoxelEditStore`, or a `ChunkStore` such as `FileChunkStore` from `./file-store`, one deflated
  `encodeChunk` file per chunk written by temporary file and rename) the least recently edited go to it past the limit,
  `close()` saves the rest, and a chunk that loads reads the store first: edits survive a restart. A store cannot be
  listed, so a chunk is found by its position when a player needs it. Without a store, edits last as long as the process.
- **No light on the server.** Chunks go out without light bytes; clients light them with `VoxelLighting` as single
  player does today. That saves server CPU and bytes.
- **Tick: 20 per second** (50 ms budget). Windows timers are coarse (about 15 ms), so the loop schedules each tick from
  a fixed start time and catches up rather than drifting. Each tick, in order: run each player's queued movement
  steps, apply queued edit requests, update each client's set of wanted chunks if their chunk changed, then write per
  client: corrections, block changes, player updates and paced chunk sends, in one corked socket write.

## Transport: hand-written WebSocket (RFC 6455)

- `node:http` `upgrade` event; accept key = base64(SHA-1(key + RFC GUID)) from `node:crypto`. The Origin must be the
  server's own host unless `origins` says otherwise; connections that have not joined are capped (`maxPending`,
  `maxPerAddress`) before the 101 answer, so a flood of sockets costs no player objects or timers (README,
  "Connections, login and saved edits").
- Binary messages only. Client frames must be masked; fragmentation, ping/pong and close are handled; text frames close
  with 1003, protocol errors with 1002, messages over the limit (default 4 KiB from clients) with 1009.
- Backpressure: chunk sends stop while a socket holds more than 256 KiB unsent; a client more than 8 MiB behind is
  dropped as too slow.
- A player's inputs wait while the chunks within one chunk of it are not made, and those chunks go to the front of the
  generator's queue. The wait is the server's, so past 256 queued messages later inputs fold into the last one instead of
  closing the player: after the wait the 0.5 s bank moves at most 60 steps, and the rest only count. Sending more than 64
  messages a second during a wait, or 256 in one tick outside one, still closes it (1008 `too many messages`).
- No compression extension (chunks are already deflated) and no TLS in the prototype: `wss://` goes through a reverse
  proxy. The Node bots use a small client built on the same frame code; tests also check the server against Node's
  built-in `WebSocket` so the two halves cannot hide each other's mistakes.

## Messages

Each WebSocket message is one byte of type, then its body. Numbers are LEB128 varints (as in packages/voxel/src/codec.ts)
unless stated.

| Direction | Message | Body |
| --- | --- | --- |
| client → server | `hello` | protocol version, wanted view distance, name |
| client → server | `input` | first step number, then runs of (step count, key bits, yaw u16, pitch u8), then the position the client predicted after the last step (3 x f64) |
| client → server | `edit` | request number, cell x, y, z (zigzag), block state (0 breaks) |
| server → client | `welcome` | player id, tick rate, granted view, simulation and player distances, block table hash |
| server → client | `chunk` | cx, cy, cz (zigzag), then `encodeChunk` bytes (one-block-type chunks sent undeflated: 5 bytes for air) |
| server → client | `unload` | cx, cy, cz |
| server → client | `spawn` / `correct` | last step number applied, position (3 x f64), velocity (3 x f32), flying |
| server → client | `blocks` | `encodeBlockChanges` bytes |
| server → client | `players` | tick, then `EntityCodec` bytes for schema `{position: 'position', rotation: 'rotation'}` |
| server → client | `names` | count, then (player id, name length, UTF-8 bytes, at most 32) for each named player coming into range, just before its first `players` state |
| server → client | `loaded` | marks the first time the whole view has been sent (used to measure join time) |
| server → client | `heartbeat` | empty; sent only to a client that got no other message for `heartbeatInterval` |
| server → client | `app` | the game's own bytes, 0 to 16,384 (`MAX_APP_BYTES`), from `VoxelServer.send` or `broadcast`; the package never reads them. Kind byte 25. A client may not send one |

The connection is TCP, so every message arrives, in order. That lets `EntityCodec` use "the last state I sent you" as
its baseline with no acknowledgements.

## Silence

TCP says nothing about a peer that vanished: with nothing to send it waits for ever, and with data queued it retries for
many minutes. Before this, a lone idle player got no messages at all, and a client gone silently stayed a player with its
chunks held, until 8 MiB had queued for it (about 7 minutes in a crowd, never when alone).

Towards the client: browsers hide WebSocket pings from pages, and no existing message is steady (`players` stops when
nothing near moves), so the server sends a one-byte `heartbeat` when a client has had nothing else for `heartbeatInterval`.
`connectVoxelNet` ends the connection after `serverTimeout`, without waiting for the socket's own close.

Towards the server: a visible page sends 20 inputs a second, but a hidden one sends none and its scripts may be throttled,
so inputs cannot mean alive. The server sends a real WebSocket ping to a client it has not heard from for
`heartbeatInterval`; the browser answers without the page's scripts. Any byte counts as hearing from it. After
`clientTimeout` the client is closed and leaves.

Both ends count events rather than time: timer firings on the client, ticks on the server. A thread that was stuck sees
the timer before the bytes waiting in its socket, so comparing clocks would blame the peer for the stall; one late firing
or tick counts once. Client default 15 s, server 20 s: the page finds out first and rejoins, and a client on a bad link
gets 5 s more before losing its slot. Three heartbeats fit in the client's wait, so one lost burst does not end a game.

Closing a socket whose peer stopped reading never finishes on its own, so `WebSocketConnection.close` cuts it off after
2 s. Without that, the dead client's queued bytes stayed in memory and `VoxelServer.close()` never resolved.

## Resume (protocol 4, 2026-10-31)

Cloudflare closes every proxied WebSocket from about 15 minutes of age, whatever it carries
(`docs/voxel-net-capacity-2026-10-31.md`, "Old connections"), so a game behind a CDN loses every socket several times an
hour. A reload through /join for each one costs a player their spot and a view of chunks. So a socket is not the player:
a playing client whose socket ended, or that went silent, is parked with its id, place, `sim` refs and `sent` set for
`resumeTimeout`. A hello with its one-use token moves a fresh connection into it.

What a dead socket can hide is told by three lists, none a guess. `chunks` in the hello against `chunksSent`, with a ring
of the last 512 keys written, gives the chunks lost; a negative or too large count clears `sent`, counted as a full
resend. Per client the keys of `blocks` messages and unloads written in the last `clientTimeout` go out again, as does
every chunk edited while parked. `stale` lists the chunks of the client's last 64 edits, so a prediction the server never
saw goes back. The client takes a chunk sent again in place of the old copy, with no hole.

Ruled out: queuing inputs or edits in the gap and replaying them (the server's 0.5 s bank would correct them away, and an
edit is refused at once and seen to be, never lost in silence); a client id in the URL (a token in a binary frame stays out
of logs, and one that was stolen lasts one session); keeping figures on others' screens through the gap (decision 3 of the
plan: a figure with no player behind it cannot be walked around).

## Join

1. Client connects and sends `hello`; the server answers `welcome` (or closes on a wrong version or full server).
2. The server picks a spawn column, generates the chunks within simulation distance first and finds the ground there.
3. It sends chunks nearest first: up to 64 chunks or 128 KiB per tick per client while the socket keeps up.
4. Once the chunks within one chunk of the spawn point have gone out it sends `spawn`; the client starts moving. When
   the whole view has gone out it sends `loaded`.

Clients never ask for chunks; the server decides. A client cannot make the server generate chunks far away.

## Movement

- The client runs `VoxelCharacter` (packages/voxel/src/query.ts) itself at fixed 1/120 s steps for an immediate feel.
  Each step's input is quantized first (key bits and a 16-bit yaw), so client and server compute the same direction.
  Inputs go out once per tick (6 steps), with the position the client ended up at.
- The server runs the same steps with the same inputs on its own `VoxelCharacter`. If its result differs from the
  client's by more than 1/64 block (an edit the client had not seen yet, a lost frame, a cheat), it sends `correct`:
  the client jumps to that state and replays its steps since then.
- Speed limit: a client can only spend steps it has had time for (120 per second since spawn, plus 0.25 s of slack);
  extra steps are dropped and corrected. Flying is a server option (on for the sandbox, off for bots).

## Block edits

- The client sends `edit` and shows the change at once (optimistic). The server checks: the edit rate (10 per second,
  bursts of 5), reach (cell centre within 6 blocks of the eye, plus 1 block of slack for lag), the chunk is in
  simulation range, a defined block id, a placed solid block does not overlap any player, a break hits a non-air cell.
- Accepted edits are applied with `setBlock`. At the end of the tick, each client gets one `blocks` message
  (`encodeBlockChanges`) with the changes in chunks it has been sent, including the editor (its confirmation).
- A refused edit sends the editor the cell's real state, which undoes its optimistic change.
- A chunk sent later already includes earlier edits: cached bytes carry a version and are re-encoded when stale.

## Other players

- Each tick the server takes one snapshot of every player (position, look direction as a quaternion), shared by all
  clients. Each client gets the players within its **player distance** through `EntityCodec.encode(nearby, lastSent)`;
  players who leave the distance are removed by the codec's removal record.
- The client pushes each player's positions into a `SnapshotBuffer` (packages/net/src/index.ts) keyed by server time
  (tick / 20 s), with velocity taken from successive positions, and draws them 100 ms behind the newest snapshot.

## Interest management (defaults)

| Distance | Default | Meaning |
| --- | --- | --- |
| View | 6 chunks (192 blocks) across, 3 chunks up and down; a client may ask for 2 to 8 | chunks sent to that client |
| Simulation | 3 chunks (96 blocks) across, 2 up and down | chunks the server holds in full: physics, edits |
| Player | 96 blocks | other players a client hears about |

A chunk leaves a client's view one chunk past the edge (so walking along a border does not resend it): the server
sends `unload` and forgets that the client has it. Players are found through a grid of chunk columns, not by checking
every pair.

## Browser client and the sandbox

- `VoxelNetClient` takes a `VoxelWorld` and a WebSocket (the browser's own). It adds and removes chunks as messages
  arrive (lighting and the renderer already follow `world.onChunk`), owns the local `VoxelCharacter` and its input
  history, applies `blocks`, and keeps a `SnapshotBuffer` per remote player.
- examples/voxel-sandbox with `?server=ws://127.0.0.1:8787` joins a server instead of streaming locally: no
  `VoxelStreamer`, no saves, edits go through the client, other players drawn as simple coloured boxes (core `box`
  geometry). A small `server.ts` next to it starts a `VoxelServer` with the sandbox's blocks and terrain (the plant
  step moves into a module both the browser worker and the server load).

## Bots and the bench

- `VoxelBot` (Node) joins like a browser and runs the same prediction. It walks in a random direction for 3 to 8 s,
  jumps when blocked, and every 2 s breaks or places a block within reach. To keep the load generator light, a bot
  decodes only chunks within one chunk of itself (it needs them for physics); others are counted, not decoded. One bot
  in eight decodes player updates in full as a correctness check; the rest count those bytes. All of this is stated in
  the results.
- The bench starts the server in its own process (so its numbers are its own) and bots in several other processes.
  Bots join at 25 per second, the run waits until every bot has its `loaded`, then measures 30 seconds of steady play.
- **Scenarios**: *spread*, bots spawn across a disc of 1,024 blocks radius (a survival server; heavy on chunk
  streaming); *crowd*, every bot within 64 blocks of spawn (heavy on player updates). Counts 50, 100, 200, 400; if 400
  still fits the budget, keep going (600, 800, ...) until it breaks or the bots themselves become the limit, and say
  which.
- **Measured**: server time per tick (median, p95, max) and achieved tick rate; event-loop busy share; process CPU
  including the workers; memory (RSS, heap, chunks held, cache bytes); bytes per second per client and in total, by
  message type, both directions; join time (connect to `spawn`, connect to `loaded`; median and p95); edit-to-other-
  client delay (one bot's send to another bot's receipt, matched by cell and state across processes on the shared
  clock; median and p95); corrections per player per minute. The breaking point is the first count whose p95 tick
  time is over 50 ms or whose tick rate falls under 19.5 per second.
- Caveat, written into the results: server and bots share this PC and talk over loopback, so there is no real network
  latency or bandwidth limit, and bots compete with the server for CPU.
- Output: `packages/voxel-net/bench/results.json` and a short summary in `docs/voxel-net-capacity-2026-10-21.md`.

## Tests (node:test)

WebSocket: the RFC's sample accept key, frames of every length form, masking, fragmentation, ping/pong, close, size
limit, and a round trip with Node's built-in `WebSocket`. Messages: round trips and hostile input (truncated, oversized,
wrong type) rejected with `RangeError`. Server with real sockets on a free port: two clients join and see each other;
an edit reaches the other client; out-of-reach, too-fast and overlapping edits are refused and undone; matching
prediction gets no corrections, a forced drift gets one and ends at the server's position; leaving the view unloads.
Bots: four bots for two seconds with no errors.

## Not in the prototype

Accounts and login, saving to disk, mobs, chat, inventories, TLS, several server processes for one world.

## Open questions (all answered yes)

1. **Name**: `@margoengine/voxel-net` (proposed), `@margoengine/voxel-server` or `@margoengine/voxel-multiplayer`?
2. **Distances**: view 6 chunks (192 blocks, a client may ask 2 to 8), simulation 3 chunks, players within 96 blocks.
   Good, or do you want the sandbox's own default of 8 chunks as the bench's view?
3. **Scenarios**: spread and crowd, at 50, 100, 200, 400 and onward until it breaks. Good?
4. **Player updates in a crowd**: measure `EntityCodec` as it is first. If it is the limit, may I then add a faster
   path to `@margoengine/voxel`'s codec (work out each player's quantized state once per tick instead of once per
   receiver) and measure again? Same bytes on the wire; voxel is not a frozen package.
