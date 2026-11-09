# @margoengine/voxel-net

Import `margoengine/voxel-net` from the `margoengine` package, or `@margoengine/voxel-net` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Multiplayer for `@margoengine/voxel` worlds: an authoritative Node server, a client that runs in browsers and Node,
and headless bots for load tests. Clean-room code with no third-party runtime package: the WebSocket server (RFC 6455)
is written here on `node:http` and `node:crypto`. Optional and tree-shakable; core and the stage never import it.
Design and decisions: [DESIGN.md](DESIGN.md). Measured capacity: [bench/results.json](bench/results.json) and
`docs/voxel-net-capacity-2026-10-21.md`.

```ts
// Server (Node)
import { BlockTypes, VoxelWorld } from 'margoengine/voxel';
import { VoxelServer } from 'margoengine/voxel-net/server';
const blocks = new BlockTypes();
blocks.define('stone');
const server = new VoxelServer({ blocks, generator: { seed: 7 }, flight: true });
await server.listen(8787, '0.0.0.0');

// Client (browser): the world fills from the server; lighting and the renderer follow world.onChunk as usual.
import { connectVoxelNet, Keys } from 'margoengine/voxel-net';
import {Engine} from 'margoengine/core';
const yaw = 0;
const pitch = 0;
const x = 0;
const y = 0;
const z = 0;
const engine = await Engine.create(document.querySelector('canvas')!);
const world = new VoxelWorld({ blocks });
const drawBox = (...pose: unknown[]) => console.log(...pose); // your renderer
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
  chunks stay in memory, up to `maxEditedChunks`; past it they go to your `store` (see below).
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
  behind the newest snapshot. `other.name` holds its display name (see below).
- **Wire format** (`.`): one type byte and a varint body per WebSocket message. `encodeClientMessage`,
  `decodeClientMessage`, `encodeServerMessage` and `decodeServerMessage` check every length; chunks, block changes
  and players carry the `@margoengine/voxel/codec` bytes. Chunks go out without light (clients light them).
- **Bots** (`./bot`): `VoxelBot.connect({url, blocks})` joins with the same client, walks, jumps, swims and edits;
  it decodes only the chunks within one chunk of itself.
- **Entities** (`./entities`): mobs, items and other non-player things the server runs, sent to each player only
  when near; see [Entities and mobs](#entities-and-mobs-entities).
- **File store** (`./file-store`, Node): `new FileChunkStore(dir)` is a `ChunkStore` with one deflated file per chunk; pass
  it as the server's `store` and edits survive a restart.

## Connections, login and saved edits

Every limit has a safe default; set them on `new VoxelServer({...})`.

| Option | Default | What it does |
| --- | --- | --- |
| `origins` | the server's own host | Which web pages may connect, by their `Origin` header: by default only a page whose origin is `http://` or `https://` plus the request's `Host`. `'*'` allows any page; a list allows exactly those origins. Clients that send no Origin (Node, bots) connect unless you pass a list. A refused page gets HTTP 403 with a message naming `origins`. |
| `maxPending` | 64 | Connections that have not joined yet (no hello, or still in `authenticate`), all together. The next upgrade gets HTTP 503 before any player object or timer exists. |
| `maxPerAddress` | 8 | The same, per IP address; the next gets HTTP 429. Behind a reverse proxy every client has the proxy's address: raise it there. |
| `helloTimeout` | 3,000 ms | Time a new connection has to send its hello; then it is closed with 1008. |
| `heartbeatInterval` | 5,000 ms | A client that got no message for this long gets a `heartbeat` message, and one that sent no bytes for this long gets a WebSocket ping. Players with traffic get neither. Keep it well below the clients' `serverTimeout`. |
| `clientTimeout` | 20,000 ms | A client that sent not one byte for this long, pongs included, is closed with 1008 `'client-silent'` and its slot, counts and chunks are freed, within one tick of the time. Must exceed `heartbeatInterval`. |
| `authenticate` | none | `(req, hello) => boolean \| string \| Promise<...>`, called on the upgrade request (`hello` undefined: read a cookie or token header) and again on the hello (`{ name }`). `true` lets the client on, a non-empty string too and becomes `player.identity`, anything else closes it with 1008 `'not authorized'`. A throw, or a call longer than `authTimeout`, closes it with 1011 (reason `auth-failed...` or `auth-timeout...`) and goes to `onError`. |
| `authTimeout` | 5,000 ms | Time each `authenticate` call may take. |
| `maxEditedChunks` | 65,536 | Edited chunks held in memory. Past it the least recently edited one is saved to `store` and dropped, and read back when needed. Without a store, a player edit to one more chunk is refused and `onError` gets a MargoError `'failed'` naming the option. |
| `store` | none | Where edited chunks are kept: a `FileChunkStore` (a folder, one file per chunk; `margoengine/voxel-net/file-store`), any `ChunkStore` of `@margoengine/voxel/stream`, or your own `VoxelEditStore` (`save(key, chunk)`, `load(key)`, either may be async) for a database. It is also read when a chunk loads, and `server.close()` saves every edited chunk still in memory to it, so a world persists across restarts. |

Breaking change (2026-10-28): `origins` used to default to any page. A browser client served from another origin (a
dev server on another port, say) now gets 403; pass that origin, for example `origins: ['http://127.0.0.1:5173']`.

```ts
import { BlockTypes } from 'margoengine/voxel';
import { FileChunkStore } from 'margoengine/voxel-net/file-store';
import { VoxelServer } from 'margoengine/voxel-net/server';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);
// Edited chunks on disk, one file each in world/chunks: they survive a restart.
const store = new FileChunkStore('world/chunks');
const server = new VoxelServer({
  blocks,
  origins: ['https://game.example.com'],
  // Your login: a session cookie on the upgrade request, then the chosen name on the hello.
  authenticate: (req, hello) => {
    const session = /session=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!session) return false;
    return hello ? `account-${session}` : true;
  },
  store,
});
await server.listen(8787, '0.0.0.0');
```

## Names and snapshots

A player's `name` reaches other clients as `RemotePlayer.name`, in a `names` message sent just before the player's
first state each time it comes into range. A client that passes `players: false` ignores them.

Names come from clients, so the server treats them as hostile. A hello whose name is over 32 UTF-8 bytes or is not
UTF-8 closes the connection (1002). Every other name goes through `cleanPlayerName` before `authenticate`,
`filterName`, `player.name` or anyone else sees it: NFC, without controls, bidi overrides, zero widths, blank letters
or angle brackets, at most 2 stacked combining marks, whitespace collapsed. Still show names as text, never as HTML.

| Option or method | Default | What it does |
| --- | --- | --- |
| `filterName` | none | `(name, id) => string`: your rule for names, such as a word list or a fallback. Its result is cleaned too. A throw, or a result that is not a string, goes to `onError` and closes the client with 1011 `'name-failed'`. |
| `server.exportEdits()` | | Resolves to a `Map` of `'cx,cy,cz'` to a copy of each chunk edited since the server started, including those past `maxEditedChunks` in the `store`. A store cannot be listed, so what it holds from an earlier run and nobody edited in this one is left out. |
| `server.importEdits(map)` | | Makes the edited chunks exactly `map`: its chunks replace what the world holds, other edited chunks go back to the generator's, matching ones are left alone. Clients holding a changed chunk get it again. Everything is checked first, so a rejection changes nothing. Works before `listen`. With a `store`, going back to the generator's needs the store's `delete(key)`. |
| `client.onClose` | does nothing | `({ code, reason, byClient }) => void`: called once when a `connectVoxelNet` connection has ended, however it ended, after any `onError`. A clean server shutdown is code 1001 with the server's reason and no `onError`; a silent server is `SERVER_SILENT_CODE` (see below); `byClient` is true after `client.close()`. Use it to rejoin; no second socket is needed. With your own transport, call it yourself. |
| `client.onError` | `console.error` | `(error) => void`: a message the client cannot read, a chunk that fails to decode, and a chunk that cannot go into the world: one your code already made at that key with `world.setBlock` (it adds missing chunks) is a MargoError `'state'`. Write into the client's world only where `world.getChunk` already has the chunk. |

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize, serialize } from 'node:v8';
import { BlockTypes } from 'margoengine/voxel';
import { VoxelServer } from 'margoengine/voxel-net/server';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);
const server = new VoxelServer({ blocks, filterName: (name, id) => name || `guest ${id}` });
await server.listen(8787, '0.0.0.0');
// A snapshot on disk: typed arrays in a Map, so v8.serialize writes it as it is.
await writeFile('world.snapshot', serialize(await server.exportEdits()));
// Back to it later, or in a new server before it listens.
await server.importEdits(deserialize(await readFile('world.snapshot')));
await server.close();
```

Breaking change (2026-11-09): `PROTOCOL_VERSION` is 6 (2 added names, 3 app messages, 4 resuming a dropped
connection, 5 entities messages, 6 app messages from clients). Server and clients must be
built from the same version; a client on another one is closed with 1008 and a reason naming both, which
`connectVoxelNet` passes to `onError`.

## App messages

Your game can send its own bytes along the connection, one player or all, and players can send theirs to the game on
the server, without a second socket. The package never
reads them: the format is yours, and they arrive in order with the chunks, edits and players.

| Method or constant | What it does |
| --- | --- |
| `server.send(player, data)` | Queues `data` (a `Uint8Array`) for one player of `server.players`, sent with the next tick's other messages. Works from the player's welcome on, before it has spawned too. Returns `true` when queued and `false` when the player has already left (a connection can drop between your lookup and the call, so this is not an error). Throws `TypeError` for a `player` that is not one or `data` that is not a `Uint8Array`, and `RangeError` over `MAX_APP_BYTES`. |
| `server.broadcast(data)` | The same for every player that has joined; returns how many it was queued for. |
| `client.onApp` | `(data) => void`, called with a copy of each payload. A throw goes to `onError` and closes the connection, like any handler. Default does nothing. |
| `client.sendApp(data)` | Sends `data` to the game on the server, after this client's earlier inputs and edits, on the reliable stream. Returns `false` (and sends nothing) before spawning, between a drop and its resume, or after close. Throws `TypeError` for `data` that is not a `Uint8Array` and `RangeError` over `MAX_APP_BYTES`. |
| `server.onApp(listener)` | Calls `listener(player, data)` with each app message of a playing player, in order with its inputs and edits, on the tick that moves them. Several listeners may listen (`./chat` is one); each gets every message, so give yours a prefix of your own. A throw goes to `server.onError`. Returns an unsubscribe. |
| `appRate`, `appBurst` | Server options: app messages per second a player may send on average (default 20) and at once (default 20). One over them is dropped and counted in `server.metrics.appsDropped`; `appsReceived` counts the rest. |
| `MAX_APP_BYTES` | 16,384: the largest payload, on the wire, in `send` and in `sendApp`. A frame over it is refused by the decoder. |

A client app message is client message type 4; the server's own app message (type 25) from a client is unreadable
and closed with 1002. `server.metrics.bytesOut.app` and `client.stats.received.app` count the bytes the server sent. The server has no event for "a player spawned"; read `player.spawned` on
your own tick, as below.

```ts
import { BlockTypes, VoxelWorld } from 'margoengine/voxel';
import { connectVoxelNet } from 'margoengine/voxel-net';
import { VoxelServer } from 'margoengine/voxel-net/server';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);

// Server: greet each player once it has spawned, and tell everyone how many are here.
const server = new VoxelServer({ blocks });
await server.listen(8787, '0.0.0.0');
const greeted = new Set<number>();
setInterval(() => {
  for (const player of server.players)
    if (player.spawned && !greeted.has(player.id)) {
      greeted.add(player.id);
      server.send(player, new TextEncoder().encode(`Welcome, player ${player.id}`));
      server.broadcast(Uint8Array.of(server.players.length));
    }
}, 50);

// Client: the first message is text, the others are the count.
const client = connectVoxelNet('ws://127.0.0.1:8787', new VoxelWorld({ blocks }));
client.onApp = (data) => console.log(data.length > 1 ? new TextDecoder().decode(data) : `${data[0]} players`);
```

## A dead network

A phone that walks out of Wi-Fi or a dropped route shows nothing until TCP gives up, which for a connection with nothing
to send is never. So both ends watch for silence, and the page's usual handling takes over:

| Option or constant | Default | What it does |
| --- | --- | --- |
| `serverTimeout` (client) | 15,000 ms | `connectVoxelNet` gives up on a server that sent nothing for this long, from the start of the connection on, without waiting for the socket's own close. A spawned player then tries to resume (below). Otherwise, or when that fails, `onError` gets a MargoError `'failed'` and `onClose` gets `{ code: SERVER_SILENT_CODE, reason: 'server-silent', byClient: false }`. 0 never gives up. |
| `SERVER_SILENT_CODE` | 4408 | That close code. No server sends it. |
| `heartbeatInterval`, `clientTimeout` (server) | 5,000 ms, 20,000 ms | See the table above. A dead client is gone from the server at most 20 s after its last byte. |

Silence is counted in firings of a timer on the client and in ticks on the server, never on a clock, so a thread that was
stuck (a long frame, a throttled background tab, a stalled server) does not blame the other end for messages that are
waiting behind it: one late firing is one fifteenth of the timeout. A hidden tab whose timers fire once a minute takes
longer to notice a dead server, and catches up when it is shown. The server's pings are answered by the browser itself,
so a hidden tab keeps its slot. Cost: 1 byte per second down and 1.2 up for a hidden lone player, and nothing for a player
with traffic (`docs/voxel-net-capacity-2026-10-21.md`).

```ts
import { BlockTypes, VoxelWorld } from 'margoengine/voxel';
import { connectVoxelNet, SERVER_SILENT_CODE } from 'margoengine/voxel-net';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);
const client = connectVoxelNet('ws://127.0.0.1:8787', new VoxelWorld({ blocks }), { serverTimeout: 15_000 });
client.onClose = ({ code, byClient }) => {
  if (byClient) return;
  console.log(code === SERVER_SILENT_CODE ? 'The server went quiet; joining again' : 'Disconnected; joining again');
};
```

## Resuming a dropped connection

A CDN closes old sockets (Cloudflare from about 15 minutes of age), and phones change networks. `connectVoxelNet` and
`VoxelBot` come back on their own, with the same player, the same spot and the world they had:

```ts
import { BlockTypes, VoxelWorld } from 'margoengine/voxel';
import { connectVoxelNet } from 'margoengine/voxel-net';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);
const client = connectVoxelNet('ws://127.0.0.1:8787', new VoxelWorld({ blocks }));
client.onResume = ({ attempt, cause, delay }) => {
  if (attempt >= 2) console.log(`Reconnecting (${cause}), try ${attempt} in ${Math.round(delay)} ms`);
};
client.onResumed = ({ gapMs, chunksResent }) => console.log(`Back after ${gapMs} ms, ${chunksResent} chunks again`);
client.onClose = ({ code, resumeFailed }) => {
  if (resumeFailed) console.log(`Could not get back (${resumeFailed}); the connection ended with ${code}`);
};
```

| Option | Default | What it does |
| --- | --- | --- |
| `resume` (client, bot) | on, 5 tries | `false` turns it off. `{ attempts, signal }` sets the tries, and an `AbortSignal` that ends them with `onClose` 1000 `aborted`. |
| `resumeTimeout` (server) | 30,000 ms | How long a dropped player is kept. 0 turns resume off: no token goes out and a drop frees the player at once. |

- **In the gap** the player is held (no steps are sent) and `edit` returns false and changes nothing. World, chunks and
  other players stay on screen. `detached` says when it is so. The first try comes within 0.6 s, then after 1, 2, 4 and
  8 s, each within half of that, and none starts after 30 s.
- **After it** the server sends again only what the client lost or what changed: chunks written into the dead socket,
  chunks edited while it was away, and those of its own last edits, so a prediction the server never saw goes back to the
  truth. `onSpawn` and `onLoaded` do not fire again. Inputs in the gap are not queued: the server would correct them away.
- **On the server** only a socket that ended with no close (1006) or a client gone silent parks a player. A player who
  left on purpose, a kick, a server closing or a server that restarted (`resume-unknown`) ends as it always did. Others see
  the figure go at once and come back with its name. A parked player keeps its `maxPlayers` place, its chunks loaded, and
  an out queue of at most 8 MiB. `player.connected` is false while it is so; `authenticate` hooks that count places by
  identity should count connected players only, so that every tab of one line can come back. One line can then hold up to
  twice its limit, for at most `resumeTimeout`.
- **Lost for good**: app messages written into a dead socket (`send` and `broadcast` have no acknowledgement). Those sent
  while the player is parked wait and go out in order. A token is 16 random bytes, works once, and is never in a URL.
- **Numbers**: `server.metrics` counts `parked { socket, clientSilent }`, `resumed`, `resumeFailed { unknown, expired }`,
  `replaced`, `chunksResent` and `fullResends`; `client.stats` counts `drops`, `resumes`, `resumeAttempts` and
  `resumeFailed`.

## Entities and mobs (`./entities`)

`VoxelEntities` runs creatures, dropped items and anything else that is not a player on the server. Each tick it runs
every entity's brain (a function that returns where to walk, or nothing to stand), moves its body (a `VoxelCharacter`:
it falls, collides and steps up ledges in the server's world), then sends each player only the entities near it.
An entity enters a player's set within `radius` (default 64 blocks) and leaves past `leaveRadius` (default 10% more),
so one on the edge does not flicker; past `maxPerPlayer` (default 256) the nearest go. States go as `EntityCodec`
deltas: only what changed. On the client, `VoxelEntityView` decodes them and interpolates each entity 100 ms behind,
as the client does other players. Entities over chunks the server has not loaded (no player near) wait where they are.

```ts
import { BlockTypes, VoxelWorld } from 'margoengine/voxel';
import { connectVoxelNet } from 'margoengine/voxel-net';
import { VoxelEntities, VoxelEntityView, wander } from 'margoengine/voxel-net/entities';
import { VoxelServer } from 'margoengine/voxel-net/server';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);
const PIG = 1,
  STONE_ITEM = 2;

// Server: a wandering pig and a dropped stone that falls to the ground. Kinds and the state byte are yours.
const server = new VoxelServer({ blocks });
await server.listen(8787, '0.0.0.0');
const entities = new VoxelEntities(server, { radius: 48 });
const pig = entities.spawn({ kind: PIG, position: [16, 40, 16], brain: wander() });
entities.spawn({ kind: STONE_ITEM, position: [18, 40, 16], body: { size: [0.25, 0.25, 0.25] } });
pig.state = 1; // say, "hurt": clients get it with the next tick

// Client: draw each entity where the view puts it.
const client = connectVoxelNet('ws://127.0.0.1:8787', new VoxelWorld({ blocks }));
const view = new VoxelEntityView(client);
view.onEnter = (e) => console.log(`entity ${e.id} of kind ${e.kind} came into view`);
setInterval(() => {
  for (const e of view.sample().values()) console.log(e.kind, e.snapshot.position);
}, 1000);
```

- **Server.** `spawn({kind, position, yaw?, state?, body?, brain?})` returns the entity; write its `position`, `yaw`
  and `state` at any time. `body: false` gives an entity you move yourself. `remove(entity)`, `get(id)`,
  `near(position, radius)` (nearest first), `size` and iteration. `wander({seed, every, rest})` walks about and jumps
  when a wall stops it. `maxEntities` (default 4,096) caps the world. `dispose()` (or `using`) stops the entities and
  tells every client to drop them.
- **Client.** `view.entities` by id (`kind`, `state`, `snapshot` filled by `sample(now)`), `onEnter` and `onLeave`.
  The view takes the client's `onEntities` handler; a parked player that comes back gets every entity again in full.
- **Wire.** An `entities` message (type 26, protocol 5): the server tick, a full flag and `EntityCodec` bytes of
  `ENTITY_SCHEMA` (position, a yaw rotation, kind u16, state u8). `server.metrics.bytesOut.entities` and
  `client.stats.received.entities` count the bytes.

## Sharded worlds (`./shards`)

One world on several servers (processes or machines), split by region. A `ShardMap` cuts the x-z plane into square
regions (`regionSize`, default 256 blocks) and gives each region to one shard: by default a hash of the region, so
every shard gets about the same share, or your `assign(rx, rz)`. Each shard owns the edits of its regions
(`allowEdit` refuses the rest) and spawns new players inside them. When a player walks more than `margin` (default 8)
blocks past its shard's regions, the shard sends it a handoff: the next shard's address and a ticket signed with the
secret all shards share (HMAC-SHA-256, good for `ticketLife`, default 10 s, and only once). The client closes the old
connection, takes that server's chunks out of the world and connects to the next shard, which checks the ticket and
spawns the player where it left, with the same name and identity.

```ts
import { BlockTypes, VoxelWorld } from 'margoengine/voxel';
import { VoxelServer } from 'margoengine/voxel-net/server';
import { connectShards, ShardMap, VoxelShard } from 'margoengine/voxel-net/shards';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);

// Every machine builds the same map. Here both shards run in one process on loopback; x >= 0 is shard 0.
const map = new ShardMap({
  shards: ['ws://127.0.0.1:8811', 'ws://127.0.0.1:8812'],
  assign: (rx) => (rx >= 0 ? 0 : 1),
});
const secret = 'change me: the same 16+ characters on every shard';
for (const index of [0, 1]) {
  const shard = new VoxelShard({ map, index, secret });
  const server = new VoxelServer(shard.options({ blocks }));
  shard.attach(server);
  await server.listen(8811 + index);
}

// Client: follows the player from shard to shard. Set handlers on it, not on follower.client (that changes).
const follower = connectShards(map, new VoxelWorld({ blocks }), { name: 'Ada' });
follower.onHandoff = (url) => console.log(`now on ${url}`);
follower.onApp = (data) => console.log(`your app message, ${data.length} bytes`);
```

- **Server.** `new VoxelShard({map, index, secret, margin?, ticketLife?, grace?})`, then `shard.options(yours)` for
  the `VoxelServer` (your `authenticate`, `spawn` and `allowEdit` still run: `authenticate` for players without a
  ticket, `spawn` for new players, default the middle of this shard's region nearest the origin) and
  `shard.attach(server)`. A player that stays `grace` (default 5 s) after its handoff is closed with 4001
  `'shard-handoff'` (`server.disconnect(player, code, reason)` is public). `shard.stats` counts `handedOff`, `arrived`
  and `refused` tickets. `signShardTicket(secret, ticket)` sends a player to a shard from your own lobby.
- **Client.** `connectShards(map, world, options, index = 0)` gives a `VoxelShardClient`: `client` (the connection now),
  `onApp`, `onHandoff`, `onClose`, `onError`, `close()`. `client.removeChunks()` takes a client's chunks out of the world.
- **Wire.** A handoff is an app message starting with `SHARD_HANDOFF_PREFIX` (`MSH` and 1); keep your own app messages
  from starting with it. The ticket rides the WebSocket URL as `?shard-ticket=`, so use `wss://` between machines.
- **Limits.** Each shard sees only its own edits: a player near a border sees the other side as generated, without
  that shard's edits, until it crosses. A handoff keeps the position, not the velocity, and lands the player on the
  ground. The chunks around the player are fetched again from the next shard (one round trip of empty world).

## WebTransport datagrams (`./webtransport`)

Over a WebSocket one lost packet holds up everything behind it until it is sent again. Over WebTransport (HTTP/3)
movement goes as unreliable datagrams instead, so a lost packet costs nothing: each input datagram carries copies of
the last `inputCopies` (default 3) inputs, and the server cuts the steps it has and fills a gap it never got with the
keys last held (`server.metrics.stepsLost` counts those steps); each players snapshot is sent whole, not as a delta, and
a late one is dropped. Chunks, edits, corrections, names and app messages stay on the one reliable stream. It runs on
`@margoengine/netcode/webtransport`. Node has no HTTP/3 server of its own: your HTTP/3 server hands each session (of the
W3C shape) to `acceptVoxelNetWebTransport`, and `server.start()` runs the tick without a WebSocket listener (or call
`listen` too, to take both).

```ts
import { BlockTypes, VoxelWorld } from 'margoengine/voxel';
import { VoxelServer } from 'margoengine/voxel-net/server';
import { acceptVoxelNetWebTransport, connectVoxelNetWebTransport } from 'margoengine/voxel-net/webtransport';
import type { WebTransportSession } from 'margoengine/netcode/webtransport';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);

// Server: tick without a WebSocket listener; your HTTP/3 server calls onSession for each WebTransport session.
const server = new VoxelServer({ blocks });
await server.start();
const onSession = (session: WebTransportSession) => acceptVoxelNetWebTransport(server, session);
console.log(typeof onSession);

// Browser: where WebTransport exists, join over it; otherwise use connectVoxelNet (a WebSocket).
if ('WebTransport' in globalThis) {
  const client = await connectVoxelNetWebTransport('https://play.example.com/voxel', new VoxelWorld({ blocks }), {
    name: 'Ada',
  });
  client.onClose = ({ code }) => console.log(`closed ${code}`);
}
```

- **Server.** `server.start()`, `acceptVoxelNetWebTransport(server, session, {request?, address?})`, or
  `server.accept(connection, request?, address?)` for a `VoxelServerConnection` of your own (`datagrams: true` when
  messages may be lost or reordered). `voxelNetServerConnection(netcodeConnection)` makes one.
- **Client.** `connectVoxelNetWebTransport(url, world, options)` (the client options plus netcode's
  `serverCertificateHashes`, `congestionControl` and `signal`), or `joinOver(connection, world, options)` for a netcode
  `Connection` you opened. `inputCopies` (0 to 8) sets the copies.
- **Limits.** A dropped session is not resumed (connect again). The server's slow-client check does not see a
  WebTransport stream backing up (its writer does not say how much waits); netcode drops datagrams instead while the
  stream holds over `dropUnreliableAbove`. A snapshot bigger than a datagram goes on the stream. The tests run over a
  stand-in link in memory (a third of datagrams lost, some reordered); the session itself is netcode's, proved there
  against a real HTTP/3 server.

## Chat and inventory (`./chat`)

Ready-made chat and inventory messages on the app channel, beside your own app messages. On the server `VoxelChat`
takes each player's line, cleans it (`cleanChatText`: no controls, bidi overrides or zero widths, whitespace collapsed,
at most `MAX_CHAT_BYTES`, 256), rate-limits it (`rate` 1 per second, `burst` 5), runs your `filter`, and sends it to
every player within `distance` (default everyone), or to one player as a whisper. `VoxelInventories` keeps one
inventory per player on the server (`size` 36 slots, `stackLimit` 64): the server gives and takes items, each client
gets its whole inventory when it spawns and each changed slot after, and a client may only ask to move items between
its own slots, which the server checks (and your `canMove`). On the client `VoxelChatClient` takes these messages out
of `client.onApp` and passes your other app messages on.

```ts
import { BlockTypes, VoxelWorld } from 'margoengine/voxel';
import { connectVoxelNet } from 'margoengine/voxel-net';
import { VoxelChat, VoxelChatClient, VoxelInventories } from 'margoengine/voxel-net/chat';
import { VoxelServer } from 'margoengine/voxel-net/server';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);
const PICKAXE = 1,
  TORCH = 2;

// Server: chat heard within 64 blocks, no swearing, and a starter kit for everyone.
const server = new VoxelServer({ blocks });
await server.listen(8787, '0.0.0.0');
const chat = new VoxelChat(server, { distance: 64, filter: (text) => text.replaceAll('darn', '****') });
chat.onLine = (player, text) => console.log(`${player.name}: ${text}`);
const inventories = new VoxelInventories(server, { size: 9 });
server.onTick(() => {
  for (const player of server.players)
    if (player.spawned && inventories.count(player, PICKAXE) === 0) {
      inventories.give(player, PICKAXE, 1);
      inventories.give(player, TORCH, 16);
      chat.system(`Welcome, ${player.name}`, player);
    }
});

// Client: show the lines, say hello, and move the torches to the last slot.
const client = connectVoxelNet('ws://127.0.0.1:8787', new VoxelWorld({ blocks }), { name: 'Ada' });
const talk = new VoxelChatClient(client);
talk.onChat = ({ name, text, whisper }) => console.log(whisper ? `${name} whispers: ${text}` : `${name}: ${text}`);
talk.onSystem = (text) => console.log(text);
talk.onInventory = (slots) => console.log(slots.map((s) => (s ? `${s.count}x${s.item}` : '-')).join(' '));
client.onSpawn = () => {
  talk.say('hello there');
  talk.move(1, 8);
};
```

- **Server.** `VoxelChat`: `system(text, player?)`, `onLine(player, text, to)`, `stats` (`said`, `dropped`: over the
  rate, empty, filtered out or a whisper to nobody), `whispers` (default true). `VoxelInventories`: `give(player, item,
  count)` (returns what did not fit), `take(player, item, count)` (all or nothing), `count`, `set(player, index,
  stack)`, `slots(player)` to save and `load(player, slots)` to restore. Item ids are yours (1 or more). Both stop with
  `dispose()` (or `using`).
- **Client.** `say(text, to?)` (a player id whispers), `move(from, to, count?)` (0 or none moves the whole stack: onto
  an empty slot, onto the same item, or swapped with another whole stack; a count splits), `inventory`, `onChat`,
  `onSystem`, `onInventory(slots, index)`; dispose puts the old `client.onApp` back.
- **Wire.** Each message is an app message starting with `CHAT_PREFIX` (`MCH` and 1), then a kind byte, varints and
  UTF-8 text; `encodeChatMessage` and `decodeChatMessage` (undefined for an app message that is not one) are exported.
  A client that sends unreadable chat bytes is closed with 4002 `'unreadable-chat'`. Show lines as text, never as
  HTML: angle brackets stay.

## Limits of the prototype

No chat or inventories, no TLS (put `wss://` behind a reverse proxy); one world over several processes is `./shards` above. The server trusts
nothing from clients and rate-limits edits and inputs; connections that have not joined are capped as above, but a
flood at the network level needs a proxy or firewall in front.

## Bench

`npm run bench --workspace @margoengine/voxel-net` (after `npm run build --workspace @margoengine/voxel-net`) runs the
capacity bench: a server process, bots in several processes joining at 25 per second, a wait until each has its whole
view, then 30 s of measured play; counts rise until the 20 Hz budget breaks. Options: see the top of
[bench/run.mjs](bench/run.mjs).

Against a running server, through whatever proxy stands in front of it: `node bench/run.mjs --url=wss://host
--metrics=https://host/metrics --blocks=path/to/blocks.mjs` (the token in `PLAZA_METRICS_TOKEN`). Bots ask `/join` as a page
does, send the page's `Origin`, stay connected from step to step and read server numbers from `/metrics`; see
[bench/remote.mjs](bench/remote.mjs). `VoxelBot` and `connectWebSocket` accept `wss://` URLs and request headers.

Apache-2.0. Build and tests: `npm test --workspace @margoengine/voxel-net`.
