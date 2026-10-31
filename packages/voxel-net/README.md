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
| `store` | none | A `VoxelEditStore` (`save(key, chunk)`, `load(key)`, either may be async) for disk or a database. It is also read when a chunk loads, and `server.close()` saves every edited chunk still in memory to it, so a world persists across restarts. |

Breaking change (2026-10-28): `origins` used to default to any page. A browser client served from another origin (a
dev server on another port, say) now gets 403; pass that origin, for example `origins: ['http://127.0.0.1:5173']`.

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deserialize, serialize } from 'node:v8';
import { BlockTypes } from 'margoengine/voxel';
import { type VoxelEditStore, VoxelServer } from 'margoengine/voxel-net/server';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand']) blocks.define(name);
await mkdir('world', { recursive: true });
// Edited chunks on disk, one file each: they survive a restart.
const store: VoxelEditStore = {
  save: (key, chunk) => writeFile(`world/${key}.chunk`, serialize(chunk)),
  load: (key) => readFile(`world/${key}.chunk`).then(deserialize, () => undefined),
};
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

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize, serialize } from 'node:v8';
import { BlockTypes } from 'margoengine/voxel';
import { VoxelServer } from 'margoengine/voxel-net/server';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand']) blocks.define(name);
const server = new VoxelServer({ blocks, filterName: (name, id) => name || `guest ${id}` });
await server.listen(8787, '0.0.0.0');
// A snapshot on disk: typed arrays in a Map, so v8.serialize writes it as it is.
await writeFile('world.snapshot', serialize(await server.exportEdits()));
// Back to it later, or in a new server before it listens.
await server.importEdits(deserialize(await readFile('world.snapshot')));
await server.close();
```

Breaking change (2026-10-31): `PROTOCOL_VERSION` is 3 (2 added names, 3 adds app messages). Server and clients must be
built from the same version; a client on another one is closed with 1008 and a reason naming both, which
`connectVoxelNet` passes to `onError`.

## App messages

Your game can send its own bytes along the connection, one player or all, without a second socket. The package never
reads them: the format is yours, and they arrive in order with the chunks, edits and players.

| Method or constant | What it does |
| --- | --- |
| `server.send(player, data)` | Queues `data` (a `Uint8Array`) for one player of `server.players`, sent with the next tick's other messages. Works from the player's welcome on, before it has spawned too. Returns `true` when queued and `false` when the player has already left (a connection can drop between your lookup and the call, so this is not an error). Throws `TypeError` for a `player` that is not one or `data` that is not a `Uint8Array`, and `RangeError` over `MAX_APP_BYTES`. |
| `server.broadcast(data)` | The same for every player that has joined; returns how many it was queued for. |
| `client.onApp` | `(data) => void`, called with a copy of each payload. A throw goes to `onError` and closes the connection, like any handler. Default does nothing. |
| `MAX_APP_BYTES` | 16,384: the largest payload, on the wire and in `send`. A frame over it is refused by the decoder. |

A client cannot send one: the server closes a connection that tries with 1002. `server.metrics.bytesOut.app` and
`client.stats.received.app` count the bytes. The server has no event for "a player spawned"; read `player.spawned` on
your own tick, as below.

```ts
import { BlockTypes, VoxelWorld } from 'margoengine/voxel';
import { connectVoxelNet } from 'margoengine/voxel-net';
import { VoxelServer } from 'margoengine/voxel-net/server';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand']) blocks.define(name);

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
| `serverTimeout` (client) | 15,000 ms | `connectVoxelNet` gives up on a server that sent nothing for this long, from the start of the connection on: `onError` gets a MargoError `'failed'`, then `onClose` gets `{ code: SERVER_SILENT_CODE, reason: 'server-silent', byClient: false }`, at once, without waiting for the socket's own close. 0 never gives up. |
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
for (const name of ['stone', 'dirt', 'grass', 'sand']) blocks.define(name);
const client = connectVoxelNet('ws://127.0.0.1:8787', new VoxelWorld({ blocks }), { serverTimeout: 15_000 });
client.onClose = ({ code, byClient }) => {
  if (byClient) return;
  console.log(code === SERVER_SILENT_CODE ? 'The server went quiet; joining again' : 'Disconnected; joining again');
};
```

## Limits of the prototype

No mobs, chat or inventories, no TLS (put `wss://` behind a reverse proxy), one process per world. The server trusts
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
