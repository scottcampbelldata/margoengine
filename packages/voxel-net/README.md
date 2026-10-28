# @margoengine/voxel-net

Import `margoengine/voxel-net` from the `margoengine` package, or `@margoengine/voxel-net` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Multiplayer for `@margoengine/voxel` worlds: an authoritative Node server, a client that runs in browsers and Node,
and headless bots for load tests. Clean-room code with no third-party runtime package: the WebSocket server (RFC 6455)
is written here on `node:http` and `node:crypto`. Optional and tree-shakable; core and the stage never import it.
Design and decisions: [DESIGN.md](DESIGN.md). Measured capacity: [bench/results.json](bench/results.json) and
`docs/voxel-net-capacity-2026-10-21.md`.

```ts
// Server (Node)
import { VoxelServer } from 'margoengine/voxel-net/server';
const server = new VoxelServer({ blocks, generator: { seed: 7 }, flight: true });
await server.listen(8787, '0.0.0.0');

// Client (browser): the world fills from the server; lighting and the renderer follow world.onChunk as usual.
import { connectVoxelNet, Keys } from 'margoengine/voxel-net';
const client = connectVoxelNet('ws://127.0.0.1:8787', world, { name: 'Ada', view: 6 });
engine.onFrame((_, dt) => {
  client.update(dt, { keys: Keys.forward | Keys.jump, yaw, pitch }); // moves client.player at 1/120 s steps
  const [x, y, z] = client.renderPosition; // the camera follows this
  for (const other of client.samplePlayers().values()) drawBox(other.snapshot.position, other.snapshot.rotation);
});
client.edit(x, y, z, 0); // shown at once; the server confirms it or sends the cell back
```

## How it works

- **Server** (`./server`): one `VoxelWorld` holds the chunks within the *simulation distance* (default 3 chunks across,
  2 up and down) of some player: physics runs and edits are accepted there. Chunks a client can only see (its *view*,
  default 6 chunks across and 3 up and down; a client may ask for 2 to 8) are sent from a cache of finished messages
  (default 256 MiB). Worker threads run the generator (`noiseTerrain` options, or your own `VoxelGenerate` module) and
  `encodeChunk` in one job. A chunk whose generation fails goes to `server.onError` and is tried again after 250 ms,
  then 500 ms; after 3 failures the players who need it are closed with 1011 and a reason naming the chunk. Edited
  chunks stay in memory for the life of the process.
- **Tick**, 20 per second: each player's queued movement steps and edits in the order they came, then each client's
  view, then one corked write per client: corrections, block changes in chunks it has, nearby players (within 96
  blocks, `EntityCodec` deltas against the last message), and up to 64 chunks or 128 KiB, nearest first.
- **Movement**: the client runs `VoxelCharacter` at fixed 1/120 s steps with quantized inputs (`Keys` bits, a 16-bit
  yaw) and sends them every 6 steps with the position it reached. The server runs the same steps; when it disagrees by
  more than 1/64 block it sends a correction, which the client applies and replays its later steps on. A client can
  only spend steps it has had time for (120 per second, 0.5 s of slack).
- **Edits**: shown at once on the client; the server checks rate (10 per second, bursts of 5), reach (6 blocks from the
  eye plus 1 of slack), that a placed block replaces air, liquid or a plant and overlaps no player, and that a break hits
  a block, then sends the change to every client holding that chunk. A refused edit sends the cell back.
- **Other players**: `client.samplePlayers()` interpolates each one from a `@margoengine/net` `SnapshotBuffer`, 100 ms
  behind the newest snapshot.
- **Wire format** (`.`): one type byte and a varint body per WebSocket message. `encodeClientMessage`,
  `decodeClientMessage`, `encodeServerMessage` and `decodeServerMessage` check every length; chunks, block changes
  and players carry the `@margoengine/voxel/codec` bytes. Chunks go out without light (clients light them).
- **Bots** (`./bot`): `VoxelBot.connect({url, blocks})` joins with the same client, walks, jumps, swims and edits;
  it decodes only the chunks within one chunk of itself.

## Limits of the prototype

No accounts or login, no saving to disk, no mobs, chat or inventories, no TLS (put `wss://` behind a reverse proxy), one
process per world. The server trusts nothing from clients but rate-limits only edits and inputs; it has no protection
against many connections from one address.

## Bench

`npm run bench --workspace @margoengine/voxel-net` (after `npm run build --workspace @margoengine/voxel-net`) runs the
capacity bench: a server process, bots in several processes joining at 25 per second, a wait until each has its whole
view, then 30 s of measured play; counts rise until the 20 Hz budget breaks. Options: see the top of
[bench/run.mjs](bench/run.mjs).

Apache-2.0. Build and tests: `npm test --workspace @margoengine/voxel-net`.
