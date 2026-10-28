# @margoengine/netcode

Import `margoengine/netcode` from the `margoengine` package, or `@margoengine/netcode` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Game networking for any game, not only voxels: one schema describes your state and inputs, an authoritative server
runs the game at a fixed tick rate, and clients predict their own player, reconcile with the server and draw everyone
else interpolated. It runs in browsers, Node, Deno and workers (no platform APIs), it is optional and tree-shakable,
and core and the stage never import it. Clean-room code from public descriptions of the techniques (see "Sources").

```ts
import { defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from '@margoengine/netcode';

// One schema for both ends. Quantized floats are small on the wire; maps are entity collections sent as deltas.
const schema = defineSchema({
  types: {
    Input: { x: { type: 'quantized', min: -1, max: 1, bits: 8 }, y: { type: 'quantized', min: -1, max: 1, bits: 8 } },
    Box: { x: 'f32', y: 'f32' },
    State: { boxes: { type: 'map', of: 'Box', maxSize: 64 } },
  },
} as const);

// One deterministic step for both ends: the server runs it authoritatively, clients run it to predict.
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 30,
  initial: () => ({ boxes: new Map() }),
  join: (state, id) => void state.boxes.set(id, { x: 0, y: 0 }),
  leave: (state, id) => void state.boxes.delete(id),
  step(state, inputs, _tick, dt) {
    for (const [id, input] of inputs) {
      const box = state.boxes.get(id);
      if (box) (box.x += input.x * 5 * dt), (box.y += input.y * 5 * dt);
    }
  },
});

// A simulated network: 60 ms each way, 20 ms of jitter, 5% loss. Swap in a real transport for a real game.
const network = new LoopbackNetwork({ latency: 60, jitter: 20, loss: 0.05, seed: 1 });
const now = () => network.time;
const server = new GameServer(game, { now });
network.listen().onconnection = (connection) => server.accept(connection);

const joining = GameClient.join(game, network.connect(), { now, input: () => ({ x: 1, y: 0 }) });
let client: Awaited<typeof joining> | undefined;
joining.then((joined) => (client = joined));
for (let frame = 0; frame < 300; frame++) {
  network.advance(1000 / 60); // one frame of virtual time
  if (network.time >= (server.tick + 1) * game.tickMs) server.step();
  client?.update();
  await null; // let the join promise settle
}
console.log('me', client?.predicted.boxes.get(client.player), 'server', server.state.boxes.get(client?.player ?? 0));
```

In a real game the server calls `server.run({ signal })` (real-time ticks) and the client calls `client.update()` every
frame; the loop above drives both by hand so the example runs anywhere, at once, the same way every time.

## What it does

- **Schema-first binary codec** (`defineSchema`): structs of `u8` `u16` `u32` `i8` `i16` `i32`, 32-bit varints
  (`uint`, zigzag `int`), `f32` `f64`, quantized floats, `bool`, UTF-8 `string`, `bytes`, `enum`, `array`, `optional`
  and `map` (entity id to value). Full types from the definition (`Infer<typeof schema.definition, 'State'>`), every
  value checked on encode (a `RangeError` or `TypeError` that names the field and the fix), every byte checked on
  decode (truncated or malformed input throws a `RangeError`, never anything else, and never allocates more than the
  bytes it holds). `encodeDelta` / `decodeDelta` send only the fields and map entries that changed against a baseline
  both ends hold. `schema.json` is the normalized definition a generator in another language reads (see "Wire format").
- **Authoritative server** (`GameServer`): fixed-timestep ticks (`run` in real time, scheduled from a fixed start so
  timer error does not drift the rate; `step` for one tick), per-player input buffers keyed by tick, the player's last
  input when this tick's has not arrived, joins and leaves at the start of a tick, snapshots against the newest
  snapshot each client confirmed (or in full), per-player views (`view`) for interest management or hidden
  information, reliable game messages (`send`, `onmessage`), `kick`, `close` and `using`.
- **Client** (`GameClient.join` resolves once welcomed, clock-synced and holding a snapshot): runs ahead of the server by
  the measured one-way delay plus a jitter margin, so its input for a tick arrives before the server runs that tick;
  predicts with the game's own step; on each snapshot compares its prediction for that tick byte for byte and, when
  they differ, goes back to the server's state and replays its unconfirmed inputs. Each input message repeats the
  newest 8 unconfirmed inputs, so a lost packet costs nothing. `interpolated()` blends the two snapshots around a
  render time a little in the past (default 2 snapshot intervals plus the jitter) on a clock that never runs backwards.
- **Clock sync** (`ClockSync`): Cristian's method over the last 8 pings; the fastest round trip gives the offset and
  the spread of round trips gives the jitter. The server also reports how many ticks it ran without the client's input,
  and the client leads by one more tick for a while each time that grows.
- **Transports**: anything with the `Connection` shape (`send(bytes, 'reliable' | 'unreliable')`, `close`, `onmessage`,
  `onclose`). `LoopbackNetwork` is the in-memory one, on a virtual clock: latency, jitter, loss, duplication and
  reordering from a seed, reliable messages resent under loss and never reordered. `messages(connection, { signal })`
  reads any connection as an async iterator.

## Determinism: why prediction converges exactly

The server simulates from exactly the values clients decode: after every tick it encodes the state and continues from
the decoded copy (floats at wire precision, maps sorted by id). The client does the same after each predicted step,
and both simulate with the decoded input. So the same inputs give the same bytes on both ends, and a prediction is
either byte-identical to the server's snapshot or replaced by it. Your `step` must be deterministic: use `+ - * /`,
`Math.sqrt` (all correctly rounded in IEEE 754), comparisons, and iterate maps; avoid `Math.sin`, `Math.random`,
`Date.now` and anything whose result can differ between engines.

The tests prove it: `tests/netcode.test.js` checks that a client's prediction equals the server's state at the same
tick under 60 ms latency, 25 ms jitter, 10% loss, duplication and reordering; that a clean link has no misprediction at
all once joined; and an 8-client soak for 60 s of game time under loss and jitter in which every client stays joined
and converges.

## Rollback netcode (peer to peer)

For deterministic games where every peer runs the whole simulation (fighting games, small co-op): `RollbackSession`
(its own entry, `@margoengine/netcode/rollback`) uses the same `defineGame` definition. Each peer's input is used `inputDelay` frames after it is sampled (default 2),
inputs of other players that have not arrived are predicted as their last known input, and when the real one arrives
and differs, the session loads the state saved before that frame and simulates again to the present (at most
`maxRollback` frames, default 8; past that it waits). Frames whose every input is known are final: `onconfirm(frame,
checksum)` reports each, and peers exchange a checksum every `checksumEvery` confirmed frames (default 30) so a desync
calls `ondesync`. A peer that runs ahead of the others waits a frame now and then (half the difference of the two
sides' frame advantages), so no one rolls back all the time.

```ts
import { defineGame, defineSchema, LoopbackNetwork } from '@margoengine/netcode';
import { RollbackSession } from '@margoengine/netcode/rollback';

const schema = defineSchema({
  types: {
    Input: { x: { type: 'quantized', min: -1, max: 1, bits: 8 } },
    Fighter: { x: 'f32' },
    State: { fighters: { type: 'map', of: 'Fighter', maxSize: 4 } },
  },
} as const);
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 60,
  initial: () => ({ fighters: new Map() }),
  join: (state, id) => void state.fighters.set(id, { x: id * 2 }),
  step(state, inputs) {
    for (const [id, input] of inputs) {
      const fighter = state.fighters.get(id);
      if (fighter) fighter.x += input.x * 0.1;
    }
  },
});

// Two peers over a simulated 40 ms link; in a game each peer is a different machine with a WebRTC data channel.
const network = new LoopbackNetwork({ latency: 40, jitter: 10, seed: 2 });
const [toTwo, toOne] = network.pair();
const now = () => network.time;
const one = new RollbackSession(game, { players: [1, 2], local: 1, peers: new Map([[2, toTwo]]), now, input: () => ({ x: 1 }) });
const two = new RollbackSession(game, { players: [1, 2], local: 2, peers: new Map([[1, toOne]]), now, input: () => ({ x: -1 }) });
for (let frame = 0; frame < 600; frame++) {
  network.advance(1000 / 60);
  one.update();
  two.update();
}
console.log(one.confirmed, one.stats.rollbacks, one.state.fighters.get(1), two.state.fighters.get(1));
```

The test `tests/rollback.test.js` runs four peers for 20 s under 50 ms latency, 20 ms jitter and 10% loss and checks
that every confirmed frame of every peer has the same checksum as the game run once offline with every real input.

## Lag compensation (server-side rewind)

`LagCompensation` keeps where every hit shape (circle or sphere) was at each of the last `history` ticks (default 32).
Record the shapes after each server tick; when a shot arrives, check it against the shapes at the tick the shooter was
looking at (`client.viewTick`, sent with the shot), blended between the recorded ticks around it. A client cannot rewind
further than the history. Validate the rest of the shot on the server (that the origin is the shooter's position, the
rate of fire), as for any input.

```ts
import { LagCompensation } from '@margoengine/netcode';

const lag = new LagCompensation({ history: 32 });
lag.record(100, [[7, { position: [0, 0], radius: 0.5 }]]);
lag.record(101, [[7, { position: [2, 0], radius: 0.5 }]]);
// A shooter that saw tick 100.5 aimed along +y from (1, -5): the target was at (1, 0) then.
const hit = lag.raycast(100.5, [1, -5], [0, 1]);
console.log(hit?.id, hit?.distance); // 7 4.5
```

## Transports and the Node server

Each transport is its own entry, so an app loads only the one it uses.

- `@margoengine/netcode/websocket`: `openWebSocket(url, { signal, protocols })` resolves with a `Connection` over
  the standard WebSocket class (browsers, Deno, Bun, Node 22+). A WebSocket is one ordered reliable stream, so
  'unreliable' messages go reliably too, except that they are dropped while more than 64 KiB is buffered
  (`dropUnreliableAbove`): a stale snapshot queued behind others is worse than none.
- `@margoengine/netcode/webrtc`: `createDataChannels(peer)` makes two pre-negotiated data channels on an
  `RTCPeerConnection` (ordered reliable, and unordered with `maxRetransmits: 0`) and `dataChannelConnection(channels)`
  wraps them as a `Connection`, so snapshots and inputs really are unreliable and never wait behind a lost packet.
  Signalling (offer, answer, ICE candidates) is yours to carry, over any channel. Works for client-server and for
  `RollbackSession` peers.
- `@margoengine/netcode/node` (Node only): `listenWebSocket({ port, host, path, origins, maxPayload })` is a WebSocket
  server written here from RFC 6455 on `node:http` and `node:crypto` (no dependency): binary messages only (text
  closes with 1003), client frames must be masked (1002), messages over `maxPayload` (default 64 KiB) close with 1009,
  fragmentation and ping are handled, unknown origins get 403, a client more than 8 MiB behind is closed as too slow.
  `serve(game, options)` runs a `GameServer` on it in real time: the self-hosted server in one call.

```ts
// Server and client in one file for the example; in a game, put the schema and game in a module both import.
import { defineGame, defineSchema } from '@margoengine/netcode';
import { serve } from '@margoengine/netcode/node';
import { openWebSocket } from '@margoengine/netcode/websocket';
import { GameClient } from '@margoengine/netcode';

const schema = defineSchema({
  types: {
    Input: { x: { type: 'quantized', min: -1, max: 1, bits: 8 } },
    Player: { x: 'f32' },
    State: { players: { type: 'map', of: 'Player', maxSize: 16 } },
  },
} as const);
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  initial: () => ({ players: new Map() }),
  join: (state, id) => void state.players.set(id, { x: 0 }),
  leave: (state, id) => void state.players.delete(id),
  step(state, inputs, _tick, dt) {
    for (const [id, input] of inputs) {
      const player = state.players.get(id);
      if (player) player.x += input.x * 4 * dt;
    }
  },
});

const stop = new AbortController();
const { port } = await serve(game, { port: 0, signal: stop.signal }); // pass host: '0.0.0.0' to accept other machines

// A client (in a browser it is the same code with your server's wss:// URL).
const client = await GameClient.join(game, await openWebSocket(`ws://127.0.0.1:${port}`), { input: () => ({ x: 1 }) });
const frames = setInterval(() => client.update(), 1000 / 60);
setTimeout(() => {
  clearInterval(frames);
  console.log('moved to', client.predicted.players.get(client.player)?.x);
  client.close();
  stop.abort();
}, 1000);
```

Behind TLS: run it on a private port behind a reverse proxy (nginx, Caddy) that terminates `wss://` and forwards the
upgrade; set `origins` to your site's origin so other pages cannot open sockets to it.

## Rooms and matchmaking

`@margoengine/netcode/rooms` has the room API shape that web game servers commonly use, for games that want rooms,
messages and a synced state rather than tick-based prediction (turn-based games, lobbies, card games): a `Room`
subclass with `onCreate`, `onAuth`, `onJoin`, `onLeave`, `onDispose`, `onMessage(type, handler)`, `setState`,
`broadcast`, `setPatchRate`, `setSimulationInterval`, `lock` and `unlock`; a `RoomServer` that defines rooms by name and
matches clients into them (`joinOrCreate`, `create`, `join`, `joinById`); and a `RoomsClient` whose joined room has
`state`, `onStateChange`, `onMessage`, `send`, `leave` and `states()` (an async iterator). Written from public
descriptions of that API shape, not from any library's source. The state is a schema struct sent in full once, then as
deltas at the patch rate (default every 50 ms); messages are JSON with a size limit (default 4096 bytes), and anything
malformed closes the connection. A room is listed and joinable only once its `onCreate` resolved (joins that arrive
meanwhile wait for it). When `onCreate`, `onJoin`, `onLeave`, `onDispose` or a message handler throws (or its promise
rejects), the client concerned is closed with `CloseCode.error`, the error goes to `rooms.onerror(error, room)`
(default `console.error`) and the server keeps running; a room whose `onCreate` threw is disposed.

```ts
import { defineSchema, LoopbackNetwork } from '@margoengine/netcode';
import { Room, type RoomClient, RoomServer, RoomsClient } from '@margoengine/netcode/rooms';

const schema = defineSchema({
  types: {
    Player: { name: { type: 'string', maxLength: 32 }, score: 'uint' },
    State: { players: { type: 'map', of: 'Player', maxSize: 8 } },
  },
} as const);
type State = { players: Map<number, { name: string; score: number }> };

class Quiz extends Room<State> {
  schema = schema;
  stateType = 'State';
  maxClients = 8;
  onCreate() {
    this.setState({ players: new Map() });
    this.onMessage('answer', (client, answer: string) => {
      const player = this.state.players.get(this.idOf(client));
      if (player && answer === '42') player.score++;
    });
  }
  onJoin(client: RoomClient, options: { name?: string }) {
    this.state.players.set(this.idOf(client), { name: String(options.name ?? 'guest'), score: 0 });
  }
  onLeave(client: RoomClient) {
    this.state.players.delete(this.idOf(client));
  }
}

// Server and client in one page over the loopback; with Node, use listenWebSocket and openWebSocket instead.
const network = new LoopbackNetwork({ latency: 20 });
const rooms = new RoomServer().define('quiz', Quiz);
network.listen().onconnection = (connection) => rooms.accept(connection);
const client = new RoomsClient(async () => network.connect());
const joining = client.joinOrCreate<State>('quiz', { name: 'Ada' }, { schema, stateType: 'State' });
const tick = setInterval(() => network.advance(10), 10);
const room = await joining;
room.onStateChange((state) => console.log([...state.players.values()]));
room.send('answer', '42');
setTimeout(() => {
  clearInterval(tick);
  room.leave();
  rooms.close();
}, 300);
```

## One schema, generated code

`@margoengine/netcode/generate` turns a schema into a standalone TypeScript module: an interface per struct and
`encode<Name>`, `decode<Name>`, `encode<Name>Delta`, `decode<Name>Delta` and `same<Name>` functions that write and check
exactly the bytes `schema.encode` does, with no import at all (it runs in Node as is, since it uses only erasable
syntax). Use it where loading the runtime schema compiler is not wanted, or as the reference for a generator in
another language: `schema.json` is the normalized definition, and README "Wire format" says how each field is written.
A Rust generator would read the same JSON and produce the same bytes; the tests compare the generated module with the
runtime codec on random values, deltas and corrupted input.

```ts
import { defineSchema } from '@margoengine/netcode';
import { generateTypeScript } from '@margoengine/netcode/generate';

const schema = defineSchema({ types: { Ping: { at: 'f64', from: { type: 'string', maxLength: 16 } } } });
const source = generateTypeScript(schema, { source: 'ping schema' });
console.log(source.length, 'characters; write it to ping.protocol.ts');
console.log(JSON.stringify(schema.json)); // what a Rust generator reads
```

## The arena demo

`examples/arena/` (in this package's folder, not in the published tarball) is a small multiplayer arena of boxes: the
game definition the tests use (`game.js`), a Node server and a browser page that draws each player's own box predicted
(solid) and the others interpolated (outlined). From the repository folder:

1. Start the arena server: `node packages/netcode/examples/arena/server.mjs` (it prints the address it listens on).
2. In a second terminal, start the dev server: `npm run dev:examples`, and open
   `http://127.0.0.1:5173/packages/netcode/examples/arena/?server=ws://127.0.0.1:8787` (if Vite prints another port,
   use that one). Arrow keys or WASD move your box; a bot drives the second view.

Without `?server=` the page runs its own server in the page over a simulated network, with latency and loss sliders.
Opened straight from disk (`file://`) the page cannot run modules and says so, with these commands.
`tests/arena.test.js` runs both commands as written and checks the server accepts a client and the page is served.

## Security

- **The server trusts nothing but inputs.** Clients never send state; the server applies only decoded inputs, through
  your `step`, so a client can move only as your rules allow. Validate game rules (cool-downs, ammunition, speed) in
  `step` or in `validateInput(input, player, state)`, which drops an input that returns false.
- **Every byte is checked.** Envelopes and schema bytes are decoded with bounds on every count and length; anything
  that does not decode closes the connection with `CloseCode.protocol`. Fields outside their schema range cannot be
  represented at all.
- **Rate limits.** A token bucket per client (`limits.messagesPerSecond`, default 120, `limits.burst`, default 60) and
  a size limit (`limits.maxMessageBytes`, default 4096); a client over either is closed with `CloseCode.rateLimit`.
  Inputs more than `maxInputAhead` ticks ahead (default 2 seconds) are dropped, so a client cannot queue a burst, and
  the server consumes at most one input per player per tick, so a client cannot speed up time.
- **Join checks.** The hello names the envelope version and the schema hash; a mismatch closes with
  `CloseCode.mismatch`. `maxPlayers` (default 64) closes the next one with `CloseCode.full`. Silent clients close with
  `CloseCode.timeout` after `timeout` ms (default 10,000).
- **Not covered here**: authentication (pass only connections you accepted, after your own login check), encryption
  (use `wss://` or WebRTC's DTLS), and denial of service at the network level (put the server behind a proxy).

## Limits (honest)

- Prediction treats other players as idle (their inputs are not sent to other clients), so in a crowd most snapshots
  differ from the prediction and the client replays its unconfirmed ticks each time. That is correct but costs CPU in
  proportion to the lead (a few ticks) times the step's cost. Draw other players from `interpolated()`, not from
  `predicted`.
- Corrections are applied at once; there is no visual smoothing of a correction yet.
- Snapshots go to every client every `snapshotEvery` ticks, the whole state (or your `view` of it) as a delta; there
  is no priority or bandwidth budget per entity yet. Measured on the arena fixture (8 players, 4 crates): 99 bytes per
  snapshot on average.
- `interpolated()` holds the newest snapshot when the next one is late; it does not extrapolate.
- A client more than 8 ticks off its target jumps instead of slewing; a client that falls more than 4 x `history`
  ticks behind skips ticks rather than replaying them.
- Rollback keeps `maxRollback + 2` saved states (encoded bytes) and resimulates at most `maxRollback` frames per
  rollback; the cost of a rollback is that many calls of your `step`. Measured in the 4-peer test (50 ms latency,
  20 ms jitter, 10% loss, 30 frames per second, input delay 2): 147 rollbacks in 581 frames, 185 frames resimulated,
  never more than 3 at once. All peers must use the same `inputDelay`; a mismatch shows up as a desync.
- Rollback sessions are a full mesh (each peer sends to every other), sensible up to about 8 players; there is no
  spectator or relay mode yet. Lag compensation tests circles and spheres only (no capsules or boxes).
- The WebSocket server has no compression extension (snapshots are small and already delta coded) and no TLS of its
  own (use a reverse proxy). The WebRTC transport is tested here with stand-in channels; signalling is not included.
- Rooms send the state to each client at the patch rate as a delta against the last state that client got (reliable
  channel), so a room's cost grows with clients times state size; rooms have no reconnection or seat reservation yet.
- The Rust generator is not written yet: `schema.json`, the wire format above and the TypeScript generator (with its
  tests against the runtime codec) are the contract it will follow.

## Wire format

Everything is little-endian. `varint` is unsigned LEB128 of at most 32 bits (5 bytes); a zigzag `int` maps 0, -1, 1,
-2 ... to 0, 1, 2, 3 ... first.

| Field | Bytes |
| --- | --- |
| `u8` `u16` `u32` `i8` `i16` `i32` | 1, 2, 4 bytes (two's complement for the signed ones) |
| `uint`, `int` | varint, zigzag varint |
| `f32`, `f64` | IEEE 754, 4 or 8 bytes; NaN and infinities are refused |
| `bool` | 1 byte, 0 or 1 |
| `quantized` | `q = round((v - min) * ((2^bits - 2) / (max - min)))` in `ceil(bits / 8)` bytes; decoded `min + (max - min) * (q / (2^bits - 2))`; `q` above `2^bits - 2` is refused |
| `string`, `bytes` | varint byte length (at most `maxLength`), then the bytes (UTF-8 for strings, checked) |
| `enum` | varint index into `values` |
| `array` | varint count (at most `maxLength`), then the items |
| `optional` | 1 byte, 0 (absent) or 1, then the value |
| `map` | varint count (at most `maxSize`), the ids ascending, each written as the gap after the previous minus one (the first as itself), then the values in that order |
| struct | the fields in definition order |

A **delta** of a struct is one bit per field (`ceil(fields / 8)` bytes, bit `i & 7` of byte `i >> 3`, set when the field
changed), then each changed field: as a delta when it is a struct or a map and the baseline has it, otherwise in full.
A delta of a map is the removed ids (count, then gap-coded ids), then the added and changed ids (count, gap-coded), then
each of their values: a delta against the baseline entry when the entry existed and is a struct, otherwise in full.

`schema.hash` is FNV-1a (32-bit) of the UTF-8 bytes of `JSON.stringify(schema.json)`, the normalized definition with
every default written out; two ends speak the same format exactly when their hashes match.

**Envelope**: one byte of kind, then: 1 hello (varint version, u32 schema hash); 2 welcome (varint player, tick rate,
tick, snapshot interval); 3 inputs (varint snapshot ack, first tick, count up to 32, then each input as varint length
and schema bytes); 4 snapshot (varint tick, baseline tick or 0, newest input tick, missed ticks, then the state bytes);
5 ping (f64 client time); 6 pong (f64 client time, varint tick, f32 fraction of the next tick); 7 message (varint type
index into `schema.names`, then its schema bytes). Snapshots, inputs, pings and pongs go unreliable; everything else
reliable.

## Sources

Clean room, from public descriptions only: Glenn Fiedler's articles "Fix Your Timestep!", "Snapshot Compression" and
"State Synchronization"; Gabriel Gambetta's "Fast-Paced Multiplayer" series (prediction, reconciliation, entity
interpolation); Yahn Bernier, "Latency Compensating Methods in Client/Server In-game Protocol Design and
Optimization" (GDC 2001); Timothy Ford, "Overwatch Gameplay Architecture and Netcode" (GDC 2017); F. Cristian,
"Probabilistic clock synchronization" (1989); the LEB128 and zigzag encodings as specified for DWARF and Protocol
Buffers; FNV-1a as published by Fowler, Noll and Vo. No library's source was read.

Apache-2.0. Optional, tree-shakable package; depends on `@margoengine/math` only.

Build and unit tests: npm test --workspace @margoengine/netcode
