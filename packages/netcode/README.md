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
  input when this tick's has not arrived, joins and leaves at the start of a tick (a player who leaves before that
  tick never reaches the game), snapshots against the newest
  snapshot each client confirmed (or in full), per-player views (`view`) for interest management or hidden
  information, reliable game messages (`send`, `onmessage`), `kick`, `close` and `using`.
- **Client** (`GameClient.join` resolves once welcomed, clock-synced and holding a snapshot): runs ahead of the server by
  the measured one-way delay plus a jitter margin, so its input for a tick arrives before the server runs that tick;
  predicts with the game's own step; on each snapshot compares its prediction for that tick byte for byte and, when
  they differ, goes back to the server's state and replays its unconfirmed inputs. Each input message repeats the
  newest 8 unconfirmed inputs, so a lost packet costs nothing. `interpolated()` blends the two snapshots around a
  render time a little in the past (default 2 snapshot intervals plus the jitter, or what an `AdaptiveDelay` measures;
  see below) on a clock that never runs backwards.
- **Clock sync** (`ClockSync`): Cristian's method over the last 8 pings; the fastest round trip gives the offset and
  the spread of round trips gives the jitter. The server also reports how many ticks it ran without the client's input,
  and the client leads by one more tick for a while each time that grows.
- **Transports**: anything with the `Connection` shape (`send(bytes, 'reliable' | 'unreliable')`, `close`, `onmessage`,
  `onclose`). `LoopbackNetwork` is the in-memory one, on a virtual clock: latency, jitter, loss, duplication and
  reordering from a seed, reliable messages resent under loss and never reordered. `messages(connection, { signal })`
  reads any connection as an async iterator.

## Measured render delay

Pass an `AdaptiveDelay` from `@margoengine/netcode/interpolation-delay` as `interpolationDelay` and the view stays as close as what the link allows, one snapshot interval on a clean one, instead of a fixed number of ticks. Nothing loads it unless you do. Snapshots live on `Timeline` from `@margoengine/netcode/interpolation-timeline`, the same ring `SnapshotBuffer` uses.

```ts
import { AdaptiveDelay } from 'margoengine/netcode/interpolation-delay';
import { defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from 'margoengine/netcode';

const schema = defineSchema({
  version: 1,
  types: { Input: { x: 'f32' }, State: { x: 'f32' } },
} as const);
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 30,
  initial: () => ({ x: 0 }),
  step: (state, inputs, _tick, dt) => {
    for (const input of inputs.values()) state.x += input.x * dt;
  },
});
const network = new LoopbackNetwork({ latency: 40, jitter: 30, seed: 3 });
const now = () => network.time;
const server = new GameServer(game, { now });
network.listen().onconnection = (connection) => server.accept(connection);
const delay = new AdaptiveDelay();
const joining = GameClient.join(game, network.connect(), { now, input: () => ({ x: 1 }), interpolationDelay: delay });
let client: Awaited<typeof joining> | undefined;
joining.then((joined) => (client = joined));
for (let frame = 0; frame < 300; frame++) {
  network.advance(1000 / 60);
  if (network.time >= (server.tick + 1) * game.tickMs) server.step();
  client?.update();
  client?.interpolated();
  await null;
}
console.log('delay', delay.target, 'view tick', client?.viewTick);
```

## Snapshot interpolation

`@margoengine/netcode/interpolation` and the three entries beside it hold what was the `@margoengine/net` package.

Bounded snapshot interpolation for position, quaternion and velocity, with capped dead reckoning.

```ts
import {SnapshotBuffer, createSnapshot} from 'margoengine/netcode/interpolation';
const renderTimeSeconds = performance.now() / 1000;
const buffer = new SnapshotBuffer(32);
const output = createSnapshot();
// buffer.push(timeSeconds, position, quaternion, velocity)
buffer.sample(renderTimeSeconds, output);
```

Position interpolation is cubic Hermite using endpoint velocities, and the sampled velocity is that curve's derivative; rotations use shortest-arc slerp. Ordered snapshots are copied into a preallocated ring, quaternions normalized, and duplicate/out-of-order timestamps return false. Extrapolation uses last velocity up to maxPrediction (default 0.25 seconds), then holds. Before the oldest sample, the oldest pose is held. Outputs are reused by default; supply your own to retain results. This is interpolation/prediction, not transport, authority, rollback or packet security.

### Adaptive render delay

`AdaptiveDelay` in `margoengine/netcode/interpolation-delay` picks how far behind the newest snapshot to draw from what the link does, so a calm link draws close and a rough one stays smooth.

```ts
import {SnapshotBuffer, createSnapshot} from 'margoengine/netcode/interpolation';
import {AdaptiveDelay} from 'margoengine/netcode/interpolation-delay';
const buffer = new SnapshotBuffer();
const delay = new AdaptiveDelay();
const pose = createSnapshot();
// A snapshot stamped with the server's time arrives:
const serverTime = 12.5;
buffer.push(serverTime, [1, 0, 2]);
delay.observe(serverTime, performance.now() / 1000);
// Each frame:
const time = delay.renderTime(performance.now() / 1000);
if (!Number.isNaN(time)) buffer.sample(time, pose);
console.log(delay.target, delay.spiking);
```

The sender's clock and yours need no agreement: only differences of received minus sent are used, and the smallest stands for the link's fixed delay plus the clock offset. Each arrival gives the delay it would have needed, which holds the send interval, the jitter and any lost snapshots at once, so a clean link settles on exactly one send interval. The target is the `quantile` of the last `window` of those. A sudden rise past `spikeHead` times the delay is followed and not learned from, until an arrival needs no more than `spikeTail` times the delay before it. The view's clock never goes back: it runs up to `slowdown` slower or `speedup` faster than real time until it reaches the target.

| Option | Default | Meaning |
| --- | --- | --- |
| `quantile` | 0.99 | Share of recent arrivals to cover, 0.5 to 1 |
| `window` | 256 | Arrivals remembered, 16 to 65,536 |
| `initial` | 0.1 | Seconds of delay, and the floor, for the first 8 arrivals |
| `min`, `max` | 0, 1 | Bounds on the delay in seconds |
| `margin` | 0 | Seconds added to the measured delay |
| `slowdown`, `speedup` | 0.25, 0.05 | How far off real time the view may run |
| `spikeHead`, `spikeTail` | 4, 2 | Where a spike starts and ends |

Call `reset()` after a reconnect. Its proof runs on seeded simulated links, not a captured network trace; [docs/limits.md](../../docs/limits.md) has the limits.

### Any field

`FieldBuffer` in `margoengine/netcode/interpolation-fields` does for any fields you name what `SnapshotBuffer` does for the pose, each field blending its own way.

```ts
import {FieldBuffer} from 'margoengine/netcode/interpolation-fields';
const buffer = new FieldBuffer({
  position: {type: 'hermite', velocity: 'velocity'},
  velocity: {type: 'linear', size: 3},
  rotation: {type: 'quaternion'},
  scale: {type: 'linear', size: 3},
  tint: {type: 'color'},
  clip: {type: 'step'},
  clipTime: {type: 'time', period: 1.2, clip: 'clip'},
});
buffer.push(10, {position: [0, 0, 0], velocity: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], tint: [1, 0, 0], clip: 2, clipTime: 1.15});
// A later snapshot need only hold what changed.
buffer.push(10.1, {position: [0.1, 0, 0], tint: [0, 0, 1], clipTime: 0.05});
const now = buffer.sample(10.05);
console.log(now?.position, now?.tint, now?.clipTime);
```

| Type | Blend | Past the newest snapshot |
| --- | --- | --- |
| `linear` | Straight line. One plain number, or `size` numbers | Holds |
| `hermite` | Cubic through both ends, using its `velocity` field (a `linear` field of the same size) | Runs on, up to `maxPrediction` |
| `angle` | Radians, the short way round | Holds |
| `quaternion` | Shortest-arc slerp, normalized when pushed | Holds |
| `color` | RGB or RGBA in linear light; `space` is `'srgb'` (default) or `'linear'`, alpha straight | Holds |
| `time` | Animation time. `period` loops it through the seam; `clip` names a `step` field it never blends across | Runs on at its last rate, up to `maxPrediction` |
| `step` | None: changes on the next snapshot's time | Holds |

The options are `capacity` (default 32) and `maxPrediction` (default 0.25 seconds). Like `SnapshotBuffer`, it ignores older or repeated times, gives the oldest snapshot before the ring begins, and reuses its output unless you pass your own from `create()`. Change the `clip` number on every restart of a clip, as a restart without one reads as a scrub back.

### One timeline

`margoengine/netcode/interpolation-timeline` is the one home of time-ordered snapshots in the engine. `SnapshotBuffer` and `FieldBuffer` here, and the client and the rewind of `@margoengine/netcode`, all sit on it. Use `Timeline` for snapshots that are objects, and `TimeRing` for rows of numbers in your own storage.

```ts
import {Timeline, blendAngle} from 'margoengine/netcode/interpolation-timeline';
const states = new Timeline<{heading: number}>(32);
states.add(100, {heading: 3});
states.add(102, {heading: -3});
states.dropThrough(90); // what is older than you need
if (states.locate(101) && states.from && states.to) {
  // `a` and `b` are equal on an entry and outside the ring; `past` says how far beyond the newest.
  console.log(blendAngle(states.from.heading, states.to.heading, states.u));
}
```

Times must rise: `add` refuses an older or repeated one, and `replace` changes the value at a time already held. `get` finds an exact time in O(log n), `locate` the two entries around a moment. The same file exports the blends the buffers share: `blendAngle`, `slerpInto` and `normalizeQuaternion`.

Apache-2.0. Optional, tree-shakable package; `/fields` depends on `@margoengine/math`, and nothing here needs core.

## Extrapolation

`client.interpolated()` holds the newest snapshot when the next one is late, so a remote player freezes. `Extrapolator` (its own entry, `@margoengine/netcode/extrapolate`) draws the same view, but past the newest snapshot it keeps moving on at the speed of the last two, for up to `maxTicks`, then holds. When the truth arrives it blends from what was on screen instead of jumping.

```ts
import { defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from '@margoengine/netcode';
import { Extrapolator } from '@margoengine/netcode/extrapolate';

const schema = defineSchema({
  types: {
    Input: { x: 'f32' },
    Box: { x: 'f32', heading: { type: 'f32', interpolate: 'angle' } },
    State: { boxes: { type: 'map', of: 'Box', maxSize: 8 } },
  },
} as const);
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 30,
  initial: () => ({ boxes: new Map() }),
  join: (state, id) => void state.boxes.set(id, { x: 0, heading: 0 }),
  step(state, _inputs, _tick, dt) {
    for (const box of state.boxes.values()) box.x += 3 * dt;
  },
});

const network = new LoopbackNetwork({ latency: 40 });
const now = () => network.time;
const server = new GameServer(game, { now });
network.listen().onconnection = (connection) => server.accept(connection);
let stalled = false;
const tick = () => {
  network.advance(1000 / 60);
  if (!stalled) while (network.time >= (server.tick + 1) * game.tickMs) server.step();
};
const joining = GameClient.join(game, network.connect(), { now, input: () => ({ x: 0 }) });
let joined = false;
joining.then(() => (joined = true));
while (!joined) {
  tick();
  await null;
}
const client = await joining;
const view = new Extrapolator(client, { now, maxTicks: 6, blend: 100 });
for (let frame = 0; frame < 180; frame++) {
  stalled = frame >= 90 && frame < 120; // half a second with no snapshots
  tick();
  client.update();
  const box = view.state().boxes.get(client.player); // draw this in place of client.interpolated()
  if (frame % 15 === 0) console.log(frame, box?.x, 'ticks late', view.late);
}
```

- `'linear'` fields move on in a line and `'angle'` fields the short way; integers, booleans and strings keep their newest value, as in `interpolated()`.
- `maxTicks` (default 6) bounds how wrong a guess can get: 200 ms at 30 ticks a second. Past it the entity holds.
- `blend` (default 100 ms, 0 jumps) is the time from what was drawn to the truth once a snapshot arrives. A snapshot that lands while still late starts a blend too.
- It is a straight line from the last two snapshots, so it overshoots a turn or a stop, and a teleport in the newest snapshot flings the entity on for `maxTicks`. Keep `maxTicks` small, or set it to 0 for a game full of sudden moves.
- It draws; it does not predict. `client.predicted` and the server see nothing of it, and a shot still rewinds to `client.viewTick`, the interpolated view, not to what was guessed.
- `client.previousSnapshot` is the snapshot before the newest with its tick, for your own schemes. `SnapshotBuffer` in `@margoengine/netcode/interpolation` extrapolates transforms for a game not on `GameClient`.

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

### Physics worlds: rollback, snapshot diffs and server bodies

`@margoengine/netcode/physics` puts a deterministic physics world (a `Physics` of `@margoengine/physics`, or anything with
`takeSnapshot`, `restoreSnapshot`, `step` and `fixedTimestep`) in a session; it imports no physics code itself.
`physicsGame({world, schema, input, apply})` is a rollback game whose state is the world's snapshot bytes: each tick
loads them, calls `apply(inputs, tick)` to drive the world (impulses, forces, motor targets), steps once and keeps the
snapshot it leaves, so rolling back is loading an older snapshot and every peer reaches the same bits. Every peer builds
the same world in the same order and keeps every body, collider and joint for the whole session. The tick rate is the
world's step rate.

`snapshotDiff(base, next)` and `applySnapshotDiff(base, diff)` send a snapshot against one both ends have: the changed
32-bit words XORed, the unchanged ones counted. `bodyStates([[id, body], ...])` reads a server's bodies into the
`BODY_STATE_FIELDS` struct its state map sends, and a client's `BodyInterpolator` plays them back between the states it
has (`push(time, states)`, `sample(time)`, `apply(time, proxies)` onto kinematic bodies' next poses).

```ts
import { Physics } from '@margoengine/physics';
import { defineSchema, LoopbackNetwork } from '@margoengine/netcode';
import { physicsGame } from '@margoengine/netcode/physics';
import { RollbackSession } from '@margoengine/netcode/rollback';

await Physics.load();
const schema = defineSchema({ types: { Input: { x: 'f32' } } } as const);
function peer(local: number, link: import('@margoengine/netcode').Connection, push: number) {
  const world = new Physics(null);
  world.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
  const balls = [1, 2].map((p) => world.addBody(null, { position: [p * 2, 0.5, 0], colliders: { shape: 'sphere', radius: 0.5 } }));
  const game = physicsGame<{ x: number }, ReturnType<Physics['takeSnapshot']>>({
    world,
    schema,
    input: 'Input',
    apply: (inputs) => {
      for (const [p, input] of [...inputs].sort((a, b) => a[0] - b[0])) balls[p - 1]!.applyImpulse([input.x, 0, 0]);
    },
  });
  return new RollbackSession(game, { players: [1, 2], local, peers: new Map([[3 - local, link]]), now: () => network.time, input: () => ({ x: push }) });
}
const network = new LoopbackNetwork({ latency: 40, seed: 1 });
const [toTwo, toOne] = network.pair();
const one = peer(1, toTwo, 0.1),
  two = peer(2, toOne, -0.1);
for (let frame = 0; frame < 300; frame++) {
  network.advance(1000 / 60);
  one.update();
  two.update();
}
console.log(one.confirmed > 200, one.stats.desyncs + two.stats.desyncs); // true 0
```

`tests/physics.test.js` rolls a world of six boxes and two pushed balls back on two peers under 60 ms latency, 25 ms
jitter and 10% loss: 353 frames confirmed, 48 rollbacks and 137 frames stepped again, and every confirmed frame of each
peer has the checksum of the world stepped offline with every input on time; a diff of one step of a rolling ball is
221 bytes of a 1,661,504 byte snapshot.

### Past a full mesh: the relay and spectators

A full mesh needs a link from every peer to every other, which stops being practical at about 8. `@margoengine/netcode/relay` gives each peer one link, to a `RollbackRelay`, and shows it the other players through that link as ordinary connections, so `RollbackSession` does not change. The relay runs no game. It also learns each input on the way through, and streams every frame whose inputs are all known to `RollbackSpectator`s, who run the same game on them with no rollback.

```ts
import { defineGame, defineSchema, LoopbackNetwork } from '@margoengine/netcode';
import { RollbackSession } from '@margoengine/netcode/rollback';
import { relayPeers, RollbackRelay, RollbackSpectator } from '@margoengine/netcode/relay';

const schema = defineSchema({
  types: {
    Input: { x: 'f32' },
    Fighter: { x: 'f32' },
    State: { fighters: { type: 'map', of: 'Fighter', maxSize: 16 } },
  },
} as const);
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 60,
  initial: () => ({ fighters: new Map() }),
  join: (state, id) => void state.fighters.set(id, { x: 0 }),
  step(state, inputs, _frame, dt) {
    for (const [id, input] of inputs) state.fighters.get(id)!.x += input.x * dt;
  },
});

const network = new LoopbackNetwork({ latency: 30 });
const now = () => network.time;
const players = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const relay = new RollbackRelay({ players });
const connect = () => {
  const [near, far] = network.pair();
  relay.accept(far);
  return near;
};
const sessions = players.map(
  (local) =>
    new RollbackSession(game, {
      players,
      local,
      peers: relayPeers(connect(), { players, local }), // one link, however many players
      now,
      input: () => ({ x: local % 2 ? 1 : -1 }),
    }),
);
const watcher = new RollbackSpectator(game, connect());
for (let frame = 0; frame < 300; frame++) {
  network.advance(1000 / 60);
  for (const session of sessions) session.update();
  watcher.update();
}
console.log('players at', sessions[0].confirmed, 'spectator at', watcher.frame, watcher.state.fighters.get(1));
```

- Every message crosses twice, so a player sees the sum of two links' latency instead of one, and the relay carries every player's traffic: with `n` players, a peer's messages reach `n - 1` others through it. It holds no state of the game and cannot change an input, but it is one place that can fail.
- A spectator starts from the first frame however late it joins, at `maxFrames` a call (default 8), and what it shows is final: the same `onconfirm` checksums as the players. `spectatorDelay` keeps it that many frames behind, so a spectator cannot help a player. Frames are kept for `history` frames (default 216,000: an hour at 60 Hz); a spectator who comes after that is refused.
- `authorize(player, token)` decides who gets in, with `player` undefined for a spectator. A seat already taken closes with `CloseCode.full`. The relay trusts the `player` a connection names, so with no `authorize` a stranger can take an empty seat.
- A peer can still send different inputs to different peers: the relay keeps the first it saw for spectators, and the desync check catches the rest.

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

### Boxes and capsules

`LagCompensation` tests circles and spheres. `HitboxRewind` (its own entry, `@margoengine/netcode/hitboxes`) has the same `record`, `at` and `raycast`, and also takes boxes and capsules that turn. It is 3D: a 2D game passes z as 0.

```ts
import { HitboxRewind } from '@margoengine/netcode/hitboxes';

const rewind = new HitboxRewind({ history: 32 });
const turned = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]; // a quarter turn about y, as [x, y, z, w]
rewind.record(100, [
  [7, { position: [0, 1, 0], radius: 0.4, halfHeight: 0.5 }], // a player: a standing capsule
  [8, { position: [4, 1, 0], halfExtents: [2, 1, 0.1] }], // a shield: a box
]);
rewind.record(101, [
  [7, { position: [2, 1, 0], radius: 0.4, halfHeight: 0.5 }],
  [8, { position: [4, 1, 0], halfExtents: [2, 1, 0.1], rotation: turned }],
]);
// A shooter that saw tick 100.5 aimed along +z from (1, 1, -5): the capsule was at x = 1 then.
const hit = rewind.raycast(100.5, [1, 1, -5], [0, 0, 1], { maxDistance: 100 });
console.log(hit?.id, hit?.distance, hit?.point);
```

- Shapes: `{ position, radius }` is a sphere, `{ position, halfExtents, rotation? }` a box, and `{ position, radius, halfHeight, rotation? }` a capsule along its own y axis, `2 * (halfHeight + radius)` tall in all. `rotation` is a quaternion `[x, y, z, w]`, normalised for you, default none.
- Between two ticks positions and sizes blend in a line and rotations the short way round. A shape that changes between box and capsule takes the nearer tick. A tick older than `history` is clamped, so a client cannot rewind further.
- For several parts of one body, give each its own id and map ids back to the player yourself.
- The ray tests are those of `@margoengine/math`: a slab test for boxes and `Capsule.intersectRay`, in each shape's own frame. Spheres give what `LagCompensation` gives.

## Interest management and bandwidth budgets

`InterestManager` (its own entry, `@margoengine/netcode/interest`) is a ready-made `view` for `GameServer`: each client gets only the entities within `radius` of its player, the most important first, and no snapshot message goes over `budget` bytes. What it leaves out never reaches that client, so a cheat cannot read it from the wire.

```ts
import { defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from 'margoengine/netcode';
import { InterestManager } from 'margoengine/netcode/interest';

const schema = defineSchema({
  types: {
    Input: { x: 'f32' },
    Box: { x: 'f32', y: 'f32', spin: 'f32' },
    State: { boxes: { type: 'map', of: 'Box', maxSize: 1024 } },
  },
} as const);
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 30,
  initial: () => {
    const boxes = new Map<number, { x: number; y: number; spin: number }>();
    for (let i = 0; i < 500; i++) boxes.set(1000 + i, { x: i % 25, y: Math.floor(i / 25), spin: 0 });
    return { boxes };
  },
  join: (state, id) => void state.boxes.set(id, { x: 12, y: 10, spin: 0 }),
  leave: (state, id) => void state.boxes.delete(id),
  step(state) {
    for (const box of state.boxes.values()) box.spin += 0.1;
  },
});

const interest = new InterestManager(game, {
  collections: { boxes: { position: (box) => [box.x, box.y] } },
  radius: 8,
  budget: 400, // bytes per snapshot: 12,000 B/s at 30 snapshots a second
});
const network = new LoopbackNetwork({ latency: 30 });
const now = () => network.time;
const server = new GameServer(game, { now, view: interest.view });
network.listen().onconnection = (connection) => server.accept(connection);
const joining = GameClient.join(game, network.connect(), { now, input: () => ({ x: 0 }) });
let client: Awaited<typeof joining> | undefined;
joining.then((joined) => (client = joined));
for (let frame = 0; frame < 120; frame++) {
  network.advance(1000 / 60);
  if (network.time >= (server.tick + 1) * game.tickMs) server.step();
  client?.update();
  await null;
}
console.log('client holds', client?.authoritative.boxes.size, 'of', server.state.boxes.size);
console.log(interest.stats(client?.player ?? 0)); // { inScope, sent, deferred, removed, bytes, over }
```

- **Who is in scope:** the exact circle (or sphere, for 3-number positions) of `radius` around the player's own entity, or around `focus(state, player)` for a camera. A hashed grid only speeds the search, so `cell` never changes the result. An entity stays in scope until `leaveRadius` (default `radius` x 1.1), so one on the edge does not flicker. `always` adds entities at any distance (team mates, objectives) and `visible` hides ones inside the circle (behind a wall, stealthed). Other fields of the state, and maps you do not list, go to everyone whole.
- **Who goes first:** a priority accumulator per client. Each snapshot every entity with something new adds its `priority` (default `radius / distance`, 1 at the edge up to 16 close by); the highest go first, those sent go back to 0, those left out keep theirs, so nothing starves. An entity too big for the bytes left is skipped for a smaller one behind it.
- **The budget:** counts the whole message, the 21 bytes of envelope included, and `stats(player).bytes` never reads less than the real size. `budget` may be a function of the player and is read on every snapshot, so it can follow what the link does. For a rate, divide bytes per second by snapshots per second. The own entity and the fields not managed always go; if they alone pass the budget, `stats(player).over` says by how much.
- **What the client sees:** an entity held back keeps the value it last got and stays on screen; it never goes back to an older one in normal running. A value sent is repeated until the client confirms it, because a snapshot is a delta against what the client confirmed. That is what makes loss harmless, and it means that under a tight budget a moving entity updates about once per round trip plus one snapshot. With bytes to spare and nothing waiting, repeats are brought up to date at once.

`view` also gets the state the client confirmed as a third argument, so a `view` of your own can see what would cost nothing to send.

## Correction smoothing

When a snapshot corrects the prediction, `client.predicted` jumps to the truth at once. `CorrectionSmoother` (its own entry, `@margoengine/netcode/smoothing`) gives you a state to draw in which that jump is blended away over a few frames, while the simulation stays exact: every number has an offset that shrinks over time, drawn as value plus offset, and a correction folds into the offset so nothing moves on screen at that moment.

```ts
import { defineGame, defineSchema, GameClient, GameServer, LoopbackNetwork } from 'margoengine/netcode';
import { CorrectionSmoother } from 'margoengine/netcode/smoothing';

const schema = defineSchema({
  types: {
    Input: { x: 'f32' },
    Box: { x: 'f32', heading: { type: 'f32', interpolate: 'angle' } },
    State: { boxes: { type: 'map', of: 'Box', maxSize: 8 } },
  },
} as const);
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  tickRate: 30,
  initial: () => ({ boxes: new Map() }),
  join: (state, id) => void state.boxes.set(id, { x: 0, heading: 0 }),
  step(state, inputs, _tick, dt) {
    for (const [id, input] of inputs) {
      const box = state.boxes.get(id);
      if (box) box.x += input.x * dt;
    }
  },
});

const network = new LoopbackNetwork({ latency: 40 });
const now = () => network.time;
const server = new GameServer(game, { now });
network.listen().onconnection = (connection) => server.accept(connection);
const tick = () => {
  network.advance(1000 / 60);
  if (network.time >= (server.tick + 1) * game.tickMs) server.step();
};
const joining = GameClient.join(game, network.connect(), { now, input: () => ({ x: 1 }) });
let joined = false;
joining.then(() => (joined = true));
while (!joined) {
  tick();
  await null;
}
const client = await joining;
const smooth = new CorrectionSmoother(client, { now, halfLife: 50, snap: 10 });
for (let frame = 0; frame < 120; frame++) {
  tick();
  if (frame === 60) server.state.boxes.get(client.player)!.x += 2; // something the client cannot predict
  client.update();
  const drawn = smooth.state(); // draw this; client.predicted stays exact
  if (frame % 20 === 0) console.log(drawn.boxes.get(client.player)?.x, 'left to blend', smooth.error);
}
```

- Every field the schema interpolates eases: `'linear'` numbers in a line, `'angle'` numbers the short way round. Integers, booleans and strings step at once, as they do in `interpolated()`. Maps, arrays, optionals and nested structs are followed; an entity that appears or goes gets no offset.
- `halfLife` (default 50 ms) is how long an error takes to halve, by the clock, so the blend is the same at any frame rate.
- `fast: { from, to, halfLife }` blends in a second, shorter half life for errors from `from` to `to` world units, so a small error eases gently and a big one does not drag on. The numbers of one struct shrink as one vector, keeping its direction.
- `snap` (default never) is the distance over which an error jumps instead of blending: a teleport or a respawn. `smooth.reset()` clears everything by hand.
- `smooth.state()` returns `client.predicted` itself once settled, so a settled frame allocates nothing. Do not write to what it returns. `smooth.error` is what is left. `close()` or `using` stops it.

A `GameClient` also has `oncorrection(before, after)`, called with the predicted state just before and just after each correction: the raw event, for your own smoothing or for logging how often prediction goes wrong.

## Transports and the Node server

Each transport is its own entry, so an app loads only the one it uses.

- `@margoengine/netcode/websocket`: `openWebSocket(url, { signal, protocols })` resolves with a `Connection` over
  the standard WebSocket class (browsers, Deno, Bun, Node 22+). A WebSocket is one ordered reliable stream, so
  'unreliable' messages go reliably too, except that they are dropped while more than 64 KiB is buffered
  (`dropUnreliableAbove`): a stale snapshot queued behind others is worse than none.
- `@margoengine/netcode/webrtc`: `createDataChannels(peer)` makes two pre-negotiated data channels on an
  `RTCPeerConnection` (ordered reliable, and unordered with `maxRetransmits: 0`) and `dataChannelConnection(channels)`
  wraps them as a `Connection`, so snapshots and inputs really are unreliable and never wait behind a lost packet.
  `@margoengine/netcode/signal` carries the offers, answers and ICE candidates (see "Signalling for WebRTC" below), or carry them yourself over any channel. Works for client-server and for
  `RollbackSession` peers.
- `@margoengine/netcode/webtransport`: `openWebTransport(url, { signal, serverCertificateHashes, congestionControl })`
  resolves with a `Connection` over the W3C WebTransport class on HTTP/3: 'unreliable' messages are real datagrams, so a
  lost snapshot never holds up the next, with no ICE and no signalling, and 'reliable' messages go length-prefixed on
  one bidirectional stream. A message bigger than `maxDatagramSize` goes on the stream rather than vanish, and a full
  datagram queue drops the message, a stale snapshot being worse than none. Where there is no WebTransport it rejects
  with code `unsupported`: fall back to `openWebSocket`. The server end is yours to host: Node has no HTTP/3 server, so
  `acceptWebTransport(session)` takes a session of the W3C shape from the HTTP/3 server you run and gives the `Connection`
  for `server.accept`, and `webTransportConnection(session, stream)` wraps a stream you opened yourself. See "WebTransport" below.
- `@margoengine/netcode/node` (Node only): `listenWebSocket({ port, host, path, origins, maxConnections, firstMessageTimeout, maxPayload })` is a WebSocket
  server written here from RFC 6455 on `node:http` and `node:crypto` (no dependency): binary messages only (text
  closes with 1003), client frames must be masked (1002), messages over `maxPayload` (default 64 KiB) close with 1009,
  fragmentation and ping are handled, a close frame with a code no peer may send fails with 1002 and one whose reason
  is not UTF-8 with 1007, another protocol version gets 426 naming 13, a client more than 8 MiB behind is closed as too
  slow. Safe defaults, each with
  an option: only web pages served from the server's own host may connect (`origins`, default the own host; `'*'` allows
  any page, a list allows exactly those origins; a client that sends no Origin, such as Node, still connects unless a
  list is given; others get 403), at most 1,024 connections (`maxConnections`; the next upgrade gets 503) and a
  connection that sends no message within 10,000 ms is closed with `CloseCode.timeout` (`firstMessageTimeout`).
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
upgrade. The default `origins` compares the page's Origin with the request's `Host` header, so if the proxy rewrites
`Host` (or the page is served from another host than the game server), set `origins` to your site's origin, for
example `origins: ['https://game.example.com']`; `origins: '*'` accepts any page.

## WebTransport

```ts
import { defineGame, defineSchema, GameClient, type GameServer } from '@margoengine/netcode';
import { acceptWebTransport, openWebTransport, type WebTransportSession } from '@margoengine/netcode/webtransport';

const schema = defineSchema({
  types: {
    Input: { x: 'f32' },
    State: { x: 'f32' },
  },
} as const);
const game = defineGame({
  schema,
  state: 'State',
  input: 'Input',
  initial: () => ({ x: 0 }),
  step(state, inputs, _tick, dt) {
    for (const [, input] of inputs) state.x += input.x * dt;
  },
});

// In a browser: one line. A session that is not up rejects with a coded error; `signal` aborts it.
async function join(url: string) {
  const connection = await openWebTransport(url);
  return GameClient.join(game, connection, { input: () => ({ x: 1 }) });
}

// In the HTTP/3 server you run: hand each session of the W3C shape to the game.
async function welcome(server: GameServer<unknown, unknown>, session: WebTransportSession) {
  server.accept(await acceptWebTransport(session));
}

console.log('ready to wire up', join.name, welcome.name);
```

- A server with no public certificate passes `serverCertificateHashes` from a self-signed certificate of at most 14 days, the browser's rule.
- `congestionControl` defaults to `'low-latency'` here, for snapshots; it is a hint the browser may ignore.
- Chromium reported a `maxDatagramSize` of 1,211 B on loopback. A snapshot over the limit goes on the stream, in order and behind anything lost, so keep snapshots small (see the budgets of `@margoengine/netcode/interest`).
- Options shared with the other transports: `dropUnreliableAbove` (default 65,536 B waiting on the stream) and `maxMessageBytes` (default 16 MiB; a bigger reliable message closes the connection with `CloseCode.rateLimit`).
- Close codes and reasons reach the other end; a reason is cut to 1,024 bytes on a character boundary, as the W3C API asks.
- Proved against a real browser and a real HTTP/3 server: `packages/netcode/tests/webtransport-proof/` runs Chromium against an echo server on the outside tool aioquic, which is test-only and is not shipped.

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
(default `console.error`) and the server keeps running; a room whose `onCreate` threw is disposed. When a timed patch
or a `setSimulationInterval` step throws, `onerror` gets it with the room, and that room is stopped: every client is
closed with `CloseCode.error` and the room is disposed.

`new RoomServer(options)` limits what clients can hold; every option has a safe default and `new RoomServer()` uses
them all:

| Option | Default | What happens past it |
| --- | --- | --- |
| `joinTimeout` | 10,000 ms | A connection that has not sent its join is closed with `CloseCode.timeout`. |
| `maxConnections` | 1,024 | Connections in rooms plus those still joining; the next is closed with `CloseCode.full`. `rooms.connections` counts them. |
| `maxRooms` | 256 | Rooms, those in `onCreate` included. `rooms.create()` rejects with MargoError `'failed'`; a client's `create` or `joinOrCreate` that would make one more is refused (its join rejects). |
| `limits.messagesPerSecond` | 120 | A token bucket per client in every room; a client over it, its burst spent, is closed with `CloseCode.rateLimit`. A room may set its own `maxMessagesPerSecond`, as it sets `maxMessageBytes`. |
| `limits.burst` | 60 | The bucket size; a room may set its own `messageBurst`. |

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

### Reconnection and held seats

Set `reconnectWindow` on a room and a client whose link drops keeps its seat for that many milliseconds. `onDrop` runs at once, and `onLeave` only if the time runs out. The seat counts against `maxClients`, an empty room with a held seat stays alive, and the same `RoomClient` comes back, so `idOf` and `userData` hold. The client keeps `room.reconnectionToken` and hands it to `RoomsClient.reconnect` on a new connection; the whole state follows.

```ts
import { defineSchema, LoopbackNetwork } from '@margoengine/netcode';
import { Room, RoomsClient, RoomServer, type RoomClient } from '@margoengine/netcode/rooms';

const schema = defineSchema({
  types: {
    Player: { online: 'bool' },
    State: { players: { type: 'map', of: 'Player', maxSize: 8 } },
  },
} as const);
interface State {
  players: Map<number, { online: boolean }>;
}

class Table extends Room<State> {
  schema = schema;
  stateType = 'State';
  reconnectWindow = 30_000; // a dropped player has 30 seconds to come back
  onCreate() {
    this.setState({ players: new Map() });
  }
  onJoin(client: RoomClient) {
    this.state.players.set(this.idOf(client), { online: true });
  }
  onDrop(client: RoomClient) {
    this.state.players.get(this.idOf(client))!.online = false;
  }
  onReconnect(client: RoomClient) {
    this.state.players.get(this.idOf(client))!.online = true;
  }
  onLeave(client: RoomClient) {
    this.state.players.delete(this.idOf(client));
  }
}

const network = new LoopbackNetwork({ latency: 10 });
const rooms = new RoomServer().define('table', Table);
network.listen().onconnection = (connection) => rooms.accept(connection);
const connections: ReturnType<LoopbackNetwork['connect']>[] = [];
const client = new RoomsClient(async () => {
  connections.push(network.connect());
  return connections.at(-1)!;
});
const options = { schema, stateType: 'State' };
const tick = setInterval(() => network.advance(10), 5);

const first = await client.joinOrCreate<State>('table', {}, options);
connections[0].close(1006, 'link lost');
await new Promise((resolve) => setTimeout(resolve, 100));
const back = await client.reconnect<State>(first.reconnectionToken, options); // keep the token in sessionStorage
console.log('same seat:', back.sessionId === first.sessionId);
clearInterval(tick);
rooms.close();
```

- `reconnectWindow` defaults to 0: no seats are held, no token is sent and everything behaves as it did. `room.dropped` lists the clients being waited for.
- A token works once; each reconnect gives a new one. It holds 128 random bits from `crypto.getRandomValues`, and whoever has it can take the seat, so keep it private to the player.
- No seat is kept after a clean `leave()`, a kick, a protocol or rate-limit close, or a hook that threw: the seat is for a link that was lost.
- A client that comes back before the server noticed the loss takes over: its old connection closes with `CloseCode.removed`, and neither `onDrop` nor `onLeave` runs.
- A seat is held for the client that had it. To hold a seat ahead for a player who has not joined yet (for example from a matchmaker), use `LobbyRoom` below.

### Lobby listings and reserved seats

`@margoengine/netcode/lobby` adds a room list and one-time seat reservations, the two things a matchmaker needs.
Subclass `LobbyRoom` in place of `Room`, give it searchable `setMetadata({...})`, and serve `RoomLobby.list()` from
your own authenticated HTTP API. `reserve(roomId, options)` holds a seat for a player who has not connected yet: the
seat counts against `maxClients` (so a public join cannot take it), keeps an empty room alive, and runs out after
`lifetime` milliseconds (default 15,000). The player joins with `joinById(roomId, { seatToken })`; `onAuth` and
`onJoin` get the options given at reservation, never options the player sends.

```ts
import { defineSchema, LoopbackNetwork } from '@margoengine/netcode';
import { RoomsClient, RoomServer, type RoomClient, type RoomOptions } from '@margoengine/netcode/rooms';
import { LobbyRoom, RoomLobby } from '@margoengine/netcode/lobby';

const schema = defineSchema({
  types: { Player: { team: 'uint' }, State: { players: { type: 'map', of: 'Player', maxSize: 8 } } },
} as const);
interface State {
  players: Map<number, { team: number }>;
}

class Match extends LobbyRoom<State> {
  schema = schema;
  stateType = 'State';
  maxClients = 2;
  onCreate() {
    this.setState({ players: new Map() });
    this.setMetadata({ mode: 'duel', map: 'harbour' });
  }
  onJoin(client: RoomClient, options: RoomOptions) {
    this.state.players.set(this.idOf(client), { team: Number(options.team) });
  }
}

const network = new LoopbackNetwork({ latency: 10 });
const rooms = new RoomServer().define('match', Match);
network.listen().onconnection = (connection) => rooms.accept(connection);
const lobby = new RoomLobby(rooms);
const tick = setInterval(() => network.advance(10), 5);

// The matchmaker (server code): find a duel, hold a seat with the team it chose.
const room = await rooms.create('match');
console.log(lobby.list({ metadata: { mode: 'duel' } }).length, 'duel room open');
const seat = lobby.reserve(room.roomId, { team: 2 }, 10_000);

// The player, told roomId and seatToken over your authenticated API:
const client = new RoomsClient(async () => network.connect());
const joined = await client.joinById<State>(seat.roomId, { seatToken: seat.seatToken }, { schema, stateType: 'State' });
console.log('joined', joined.roomId === room.roomId);
clearInterval(tick);
rooms.close();
```

- The token holds 256 random bits and is good once; whoever holds it takes the reserved join identity, so send it to
  the player alone over TLS. `cancelReservation(seatToken)` frees a seat at once; expiry and room disposal free it too.
- The seat stays counted while the room's async `onAuth` runs, so slow authentication cannot overbook the room.
- Listings are exact-match filters on name and scalar metadata; locked, full and `privateRoom` rooms are left out,
  and a private room is still joinable by id or reservation. Plain `Room` subclasses are listed with empty metadata
  but cannot be reserved in.
- Reservations live in the memory of the one server process, as held seats do: a restart loses them.

### Many server processes: presence

`@margoengine/netcode/presence` lists and reserves rooms across several `RoomServer` processes. Wrap each server in a
`RoomNode` with its public `endpoint` and a shared `RoomPresence`; `run()` keeps a leased directory entry fresh and
serves reservation requests for the rooms it owns. Any node's `list()` sees the open rooms of every live process, and
`reserve(roomId)` is carried to the owning process, which grants the seat and returns its endpoint with the token.
`MemoryPresence` shares one process (tests, a single host with several servers); `openSqlitePresence(file)` shares
processes on one host through a SQLite WAL file; for several hosts implement `PresenceStore` (`set`, `get`, `keys`,
an atomic `take`, `delete`) on your database and pass it to `StorePresence`.

```ts
import { defineSchema } from '@margoengine/netcode';
import { RoomServer } from '@margoengine/netcode/rooms';
import { LobbyRoom } from '@margoengine/netcode/lobby';
import { MemoryPresence, RoomNode } from '@margoengine/netcode/presence';

const schema = defineSchema({ types: { State: { joined: 'uint' } } } as const);
class Match extends LobbyRoom<{ joined: number }> {
  schema = schema;
  stateType = 'State';
  maxClients = 2;
  onCreate() {
    this.setState({ joined: 0 });
    this.setMetadata({ mode: 'duel' });
  }
}

using presence = new MemoryPresence();
using east = new RoomServer().define('match', Match);
using west = new RoomServer().define('match', Match);
await using a = new RoomNode(east, { presence, endpoint: 'wss://east.example.com' });
await using b = new RoomNode(west, { presence, endpoint: 'wss://west.example.com' });
const room = await east.create('match');
const serving = a.run();
await a.sync(); // publish now instead of at the next heartbeat

const [open] = await b.list({ metadata: { mode: 'duel' } }); // west sees east's room
const seat = await b.reserve(open.roomId, { team: 1 }); // granted by east, the owner
console.log(seat.endpoint, seat.roomId === room.roomId); // connect there, then joinById with seat.seatToken
await a.close();
await serving;
```

- Leases default to 10,000 ms and heartbeats to 1,000 ms (the heartbeat must be shorter); a process that stops
  renewing drops out of every list when its lease ends. Lists are eventually consistent: call `sync()` after creating
  or changing a room to publish at once.
- Only the owner grants a seat, so two nodes can never hand out the same seat. A request that failed or timed out is
  never sent again, since it may have reached the owner; its seat then frees itself when the reservation expires.
- The directory is trusted server code. Authenticate the HTTP endpoints that call `list` and `reserve`.

Processes on one host share a SQLite file; several hosts share your own database through a `PresenceStore`. The
store's records are strings with a Unix-millisecond expiry, and `take` must remove a record atomically across every
process (a `DELETE ... RETURNING` or a compare-and-delete):

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlitePresence, StorePresence, type PresenceStore } from '@margoengine/netcode/presence';

// One host: every server process opens the same local file (not a network share).
using local = await openSqlitePresence(join(tmpdir(), `presence-${process.pid}.db`), { namespace: 'arena' });

// Several hosts: the five calls on your database. A Map stands in for it here.
class MyStore implements PresenceStore {
  private rows = new Map<string, { value: string; expiresAt: number }>();
  private live(key: string) {
    const row = this.rows.get(key);
    return row && row.expiresAt > Date.now() ? row : undefined;
  }
  async set(key: string, value: string, expiresAt: number) {
    this.rows.set(key, { value, expiresAt });
  }
  async get(key: string) {
    return this.live(key)?.value;
  }
  async keys(prefix: string) {
    return [...this.rows.keys()].filter((k) => k.startsWith(prefix) && this.live(k)).sort();
  }
  async take(key: string) {
    const row = this.live(key);
    this.rows.delete(key);
    return row?.value;
  }
  async delete(key: string) {
    this.rows.delete(key);
  }
  [Symbol.dispose]() {
    this.rows.clear();
  }
}
using shared = new StorePresence(new MyStore(), { namespace: 'arena', requestTimeout: 5000, pollInterval: 20 });
console.log(local instanceof StorePresence, shared instanceof StorePresence); // true true: pass either to RoomNode
```

- `StorePresence` takes ownership of its store and disposes it. `namespace` (default `margo-netcode`) keeps games on
  one database apart; `requestTimeout` (default 5,000 ms) bounds a routed reservation and `pollInterval` (default
  20 ms) is how often a waiting request reads its reply.
- `openSqlitePresence` loads Node's built-in `node:sqlite` only when called, opens the file in WAL mode, and takes the
  same options plus a `signal`. SQLite errors propagate as they are, without retries.

### Peer-to-peer host migration

`@margoengine/netcode/migrate` keeps a peer-to-peer game going when its host leaves. Every peer makes a
`HostMigration` with the same schema, starting state and roster, over reliable links to every other peer. The host
calls `confirm(state, frame)` at its checkpoints, which prepares and commits that state on every connected peer. When
the host drops, the surviving peers pick the lowest id, restore the newest checkpoint they all hold, and resume from
it; `handoff(id)` moves authority on purpose.

```ts
import { defineSchema, LoopbackNetwork, type Connection } from '@margoengine/netcode';
import { HostMigration } from '@margoengine/netcode/migrate';

const schema = defineSchema({ types: { State: { score: 'uint' } } } as const);
const network = new LoopbackNetwork({ latency: 10 });
const [ab, ba] = network.pair(),
  [ac, ca] = network.pair(),
  [bc, cb] = network.pair();
const peer = (local: number, peers: [number, Connection][]) =>
  new HostMigration({ schema, stateType: 'State', local, peers: new Map(peers), initial: { score: 0 } });
const a = peer(1, [[2, ab], [3, ac]]),
  b = peer(2, [[1, ba], [3, bc]]),
  c = peer(3, [[1, ca], [2, cb]]);

const saved = a.confirm({ score: 9 }, 120); // the host checkpoints frame 120
network.advance(5000);
await saved;
a.close(); // the host leaves
network.advance(5000);
const resumed = await b.waitForHost();
console.log(resumed.host, resumed.frame, resumed.state.score, c.isHost); // 2 120 9 false
b.close();
c.close();
```

- Only the peer whose `isHost` is true may simulate and publish; others wait with `waitForHost()`. `confirmed` is the
  last locally committed checkpoint; await `confirm` before treating it as held by everyone.
- Up to 64 peers; checkpoints up to `maxSnapshotBytes` (default 1 MiB, at most 16 MiB). Peers are trusted and the
  surviving mesh must stay connected: this is not consensus, so a split network or a lying peer needs your own
  membership and fencing. A peer cannot join a live session; start a new one.

A planned handoff, and the limits every operation runs under:

```ts
import { defineSchema, LoopbackNetwork } from '@margoengine/netcode';
import { HostMigration } from '@margoengine/netcode/migrate';

const schema = defineSchema({ types: { State: { score: 'uint' } } } as const);
const network = new LoopbackNetwork({ latency: 10 });
const [ab, ba] = network.pair();
const options = { schema, stateType: 'State', initial: { score: 0 }, timeout: 2000 };
using a = new HostMigration({ ...options, local: 1, peers: new Map([[2, ab]]) });
using b = new HostMigration({ ...options, local: 2, peers: new Map([[1, ba]]) });

const moved = a.handoff(2, { signal: AbortSignal.timeout(5000) }); // the host gives authority to peer 2
network.advance(5000);
await moved;
console.log(a.isHost, b.isHost, a.epoch, b.epoch); // false true 1 1
const resumed = await b.waitForHost();
console.log(resumed.host, resumed.epoch, resumed.frame); // 2 1 0
```

- `epoch` counts authority generations: each handoff and each recovery adds one, and a peer ignores checkpoints and
  status from an older epoch, so a host that left cannot overwrite the new one.
- The session owns the links in `peers`: `close()` (or `using`) closes them and puts back their previous `onmessage`
  and `onclose`. Leaving rejects every pending `confirm`, `handoff` and `waitForHost` with a `MargoError` `disposed`.
- `confirm`, `handoff`, recovery and `waitForHost` each end after `timeout` milliseconds (default 10,000) or when their
  `signal` aborts. A `confirm` or `handoff` that ends that way closes the session and its links, since some peers may
  hold the checkpoint and others not; build a new session from the last `confirmed` state.
- `host` (default the lowest id) and `frame` (default 0) start the session; every peer passes the same values.

## Signalling for WebRTC

Two browsers cannot open a WebRTC link until they have swapped an offer, an answer and ICE candidates through something else. `@margoengine/netcode/signal` is that something: a small server that passes messages between the peers of a room, a client, and `PeerMesh`, which makes a link to every peer of the room. Once linked, the peers talk directly and the server carries nothing.

```ts
// Server and two peers' signalling in one file for the example; in a game the server runs on Node and each
// peer in its own browser, where `new PeerMesh(room, ...)` then makes the links.
import { LoopbackNetwork } from '@margoengine/netcode';
import { SignalClient, SignalServer } from '@margoengine/netcode/signal';

const network = new LoopbackNetwork({ latency: 10 });
const signals = new SignalServer({ maxPeers: 8 });
network.listen().onconnection = (connection) => signals.accept(connection);
const tick = setInterval(() => network.advance(10), 5);

const one = await SignalClient.join(network.connect(), 'lobby-7');
const two = await SignalClient.join(network.connect(), 'lobby-7');
console.log('two sees', [...two.peers], 'which is', one.id);
one.onsignal = (from, data) => console.log('from', from, data);
two.send(one.id, { hello: 'there' });
await new Promise((resolve) => setTimeout(resolve, 100));
clearInterval(tick);
signals.close();
```

In the browser:

```ts
import { GameClient, type Game } from '@margoengine/netcode';
import { PeerMesh, SignalClient } from '@margoengine/netcode/signal';
import { openWebSocket } from '@margoengine/netcode/websocket';

export async function joinMesh(game: Game<unknown, unknown>, url: string) {
  const room = await SignalClient.join(await openWebSocket(url), 'lobby-7', { token: 'from your login' });
  return new PeerMesh(room, {
    configuration: { iceServers: [{ urls: 'stun:stun.example.com' }] }, // none means the same network only
    onconnection: (peer, connection) => void GameClient.join(game, connection, { input: () => ({}) }),
    onerror: (peer, error) => console.error(peer, error),
  });
}
```

On Node, `listenWebSocket` gives the server its connections: `listener.onconnection = (connection) => signals.accept(connection)`.

- The joiner offers to the peers already there, so two peers never offer to each other, and each step with a peer waits for the one before it. A candidate found before the description went out waits for it.
- `PeerMesh` takes over the client's `onsignal` and `onleft`; `onpeer` stays yours. `mesh.connections` holds each open `Connection`, ready for `GameClient`, `GameServer` or `RollbackSession`.
- A link that is up lives on its own: it ends when its channels close or it fails, not when the peer leaves the room or the server goes. A link still being set up goes with the peer.
- The server sets each message's sender itself, so a peer cannot pose as another, and a message never leaves its room. It keeps no history.
- Server options, each with a default: `maxRooms` 1,024, `maxPeers` 16, `maxMessageBytes` 65,536, `messagesPerSecond` 100 with a `burst` of 200, `joinTimeout` 10,000 ms, and `authorize(room, token)`, default anyone with the room's name.
- A room's name is not a secret unless `authorize` makes it one, and what a peer sends may be anything: `onsignal` is for you to check. `PeerMesh` sends what is not a description or candidate to `onerror`.
- Run behind `wss://`: the server sees every description, which holds each peer's addresses.

## One schema, generated code

`@margoengine/netcode/generate` turns a schema into a standalone TypeScript module: an interface per struct and
`encode<Name>`, `decode<Name>`, `encode<Name>Delta`, `decode<Name>Delta` and `same<Name>` functions that write and check
exactly the bytes `schema.encode` does, with no import at all (it runs in Node as is, since it uses only erasable
syntax). Use it where loading the runtime schema compiler is not wanted, or as the reference for a generator in
another language: `schema.json` is the normalized definition, and README "Wire format" says how each field is written.
`@margoengine/netcode/generate-rust` reads the same JSON and writes a Rust module that produces the same bytes (below); the
tests compare each generated module with the runtime codec on random values, deltas and corrupted input. Any struct name the schema takes works, Map and Uint8Array
included; only a pair such as `Player` and `PlayerDelta` is refused with a TypeError, since both would define
`encodePlayerDelta`.

```ts
import { defineSchema } from '@margoengine/netcode';
import { generateTypeScript } from '@margoengine/netcode/generate';

const schema = defineSchema({ types: { Ping: { at: 'f64', from: { type: 'string', maxLength: 16 } } } });
const source = generateTypeScript(schema, { source: 'ping schema' });
console.log(source.length, 'characters; write it to ping.protocol.ts');
console.log(JSON.stringify(schema.json)); // what the Rust generator reads
```

### Rust

`generateRust(schema)` (or `generateRust(schema.json)`) writes one standalone Rust 2021 file for a Rust server or
tool: no crate dependencies, Rust 1.82 or newer. Each struct becomes `Msg<Name>` with fields `f_<name>`; maps are
`BTreeMap<u32, T>`, enums their `u32` wire index and optionals `Option<Box<T>>`. Each type has `encode`, `decode`,
`encode_delta`, `decode_delta` and `same`, writing the bytes `schema.encode` writes, and the module carries the
schema's `SCHEMA_HASH`, so a Rust room server and a TypeScript client agree or refuse to talk.

```ts
import { defineSchema } from '@margoengine/netcode';
import { generateRust } from '@margoengine/netcode/generate-rust';

const schema = defineSchema({ types: { Ping: { at: 'f64', from: { type: 'string', maxLength: 16 } } } });
const rust = generateRust(schema, { source: 'ping schema' });
console.log(rust.includes('pub struct MsgPing'), 'write it to src/ping_protocol.rs');
```

- Decoding returns `margo_wire::Result`: limits are checked, and trailing bytes, invalid UTF-8, non-finite floats and
  malformed map masks are errors, never a partial value. Nesting past 256 codec calls is an error, so untrusted input
  cannot recurse without bound.
- `f32` fields use Rust's `f32`; quantized fields decode to `f64`.

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
  `CloseCode.mismatch`. `maxPlayers` (default 64) counts every accepted player once,
  including a hello received before the next simulation tick, and closes the next
  one with `CloseCode.full`. A disconnect frees its slot immediately. Silent clients close with
  `CloseCode.timeout` after `timeout` ms (default 10,000).
- **Not covered here**: authentication (pass only connections you accepted, after your own login check), encryption
  (use `wss://` or WebRTC's DTLS), and denial of service at the network level (put the server behind a proxy).

## Limits (honest)

- Prediction treats other players as idle (their inputs are not sent to other clients), so in a crowd most snapshots
  differ from the prediction and the client replays its unconfirmed ticks each time. That is correct but costs CPU in
  proportion to the lead (a few ticks) times the step's cost. Draw other players from `interpolated()`, not from
  `predicted`.
- Corrections are applied at once to `client.predicted`. To draw them eased over a few frames use `CorrectionSmoother`.
- Snapshots go to every client every `snapshotEvery` ticks, the whole state (or your `view` of it) as a delta; there
  is no priority or bandwidth budget per entity yet. Measured on the arena fixture (8 players, 4 crates): 99 bytes per
  snapshot on average.
- `interpolated()` holds the newest snapshot when the next one is late; `Extrapolator` moves on instead.
- A client more than 8 ticks off its target jumps instead of slewing; a client that falls more than 4 x `history`
  ticks behind skips ticks rather than replaying them.
- Rollback keeps `maxRollback + 2` saved states (encoded bytes) and resimulates at most `maxRollback` frames per
  rollback; the cost of a rollback is that many calls of your `step`. Measured in the 4-peer test (50 ms latency,
  20 ms jitter, 10% loss, 30 frames per second, input delay 2): 147 rollbacks in 581 frames, 185 frames resimulated,
  never more than 3 at once. All peers must use the same `inputDelay`; a mismatch shows up as a desync.
- A physics world in rollback (`physicsGame`) saves its whole snapshot every frame and loads it every step: two copies of
  the world's memory a simulated frame (1.66 MB for the test's small world, whose memory holds room to grow), so its cost
  grows with the world's memory, not with what moves. The world must keep the same bodies, colliders and joints, and a
  world that grows its memory mid-session is refused. Send `snapshotDiff`s, not snapshots, when a world goes over the wire.
- Rollback sessions over direct links are a full mesh (each peer sends to every other), sensible up to about 8 players. Past that use `@margoengine/netcode/relay`, at the cost of a second hop.
- The WebSocket server has no compression extension (snapshots are small and already delta coded) and no TLS of its
  own (use a reverse proxy). The WebRTC transport is tested here with stand-in channels; signalling is not included.
- Rooms send the state to each client at the patch rate as a delta against the last state that client got (reliable
  channel), so a room's cost grows with clients times state size. Held seats (`reconnectWindow`) and reserved seats
  (`LobbyRoom`) live in the memory of one server process; a restart loses them.

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

## Voice chat and screen share

`@margoengine/netcode/media` adds microphone and screen tracks to the WebRTC links of a `PeerMesh`. Starting or stopping one renegotiates over the same signalling (the mesh runs the W3C "perfect negotiation" pattern: the peer with the higher room id is polite and gives way when both offer at once). A remote stream with video is a screen; one with only audio is a voice. Any number of peers may share a screen at once.

Remote voices play through Web Audio (volume, per-peer mute, the `spatial` hook and the speaking lights). The session also holds each voice in a muted media element, because Chromium decodes a remote voice only while one plays it. An `AudioContext` the session makes is resumed on the page's first click or key press if the browser starts it suspended, and closed by `dispose()`. Resume and close a context you pass yourself, from a click handler for example.

```ts
import type { PeerMesh } from '@margoengine/netcode/signal';
import { MediaSession, type MediaSessionEvent } from '@margoengine/netcode/media';

export async function voice(mesh: PeerMesh, context: AudioContext) {
  const media = new MediaSession(mesh, {
    audioContext: context,
    pushToTalk: false, // true: closed until media.talk(true)
    // Optional: route each voice through your own graph, for example a PannerNode that follows the player.
    spatial: (peer, volume, ctx) => {
      const panner = ctx.createPanner();
      panner.connect(ctx.destination);
      return panner;
    },
  });
  media.addEventListener('speaking', (event) => {
    const { peer, speaking } = (event as MediaSessionEvent<'speaking'>).detail;
    console.log(peer, speaking ? 'talks' : 'is quiet');
  });
  await media.startVoice({ signal: AbortSignal.timeout(15_000) }); // echo cancellation, noise suppression, auto gain on
  media.setMuted(true);
  media.setVolume(3, 0.5); // peer 3, this end only
  media.mutePeer(4, true);
  await media.startScreenShare(); // getDisplayMedia; 'screenended' fires when the user uses the browser's stop button
  for await (const remote of media.events('remote')) console.log(remote.peer, remote.kind, remote.active);
  return media; // media.dispose() or `using` stops every track
}
```

Options (defaults): `audio` microphone constraints (echo cancellation, noise suppression and automatic gain control on), `pushToTalk` (false), `speakingOn` (0.04 RMS), `speakingOff` (0.02), `speakingHangMs` (250), `pollMs` (50; 0 reads only on `poll()`), `audioContext`, `spatial`, `mediaDevices`, `now`. Speaking is an RMS level through an `AnalyserNode` with hysteresis (`SpeakingDetector` is exported for your own use). Remote streams are on `media.remotes.get(peer)` (`voice`, `screen`, `volume`, `muted`, `speaking`) for your own `<audio>` or `<video>` element.

## Sources

Clean room, from public descriptions only: Glenn Fiedler's articles "Fix Your Timestep!", "Snapshot Compression",
"Snapshot Interpolation", "Deterministic Lockstep" and "State Synchronization"; the GGPO documentation (Tony Cannon and
others, ggpo.net) on rollback; Gabriel Gambetta's "Fast-Paced Multiplayer" series (prediction, reconciliation, entity
interpolation); Yahn Bernier, "Latency Compensating Methods in Client/Server In-game Protocol Design and
Optimization" (GDC 2001); Timothy Ford, "Overwatch Gameplay Architecture and Netcode" (GDC 2017); F. Cristian,
"Probabilistic clock synchronization" (1989); the LEB128 and zigzag encodings as specified for DWARF and Protocol
Buffers; FNV-1a as published by Fowler, Noll and Vo; the W3C WebTransport Candidate Recommendation, in part; for media, W3C WebRTC 1.0 (addTrack, removeTrack, negotiationneeded and the perfect negotiation example), W3C Media Capture and Streams (getUserMedia, audio constraints, track `enabled` and `ended`), W3C Screen Capture (getDisplayMedia) and the W3C Web Audio API (MediaStreamAudioSourceNode, AnalyserNode, GainNode). No library's source was read.

Apache-2.0. Optional, tree-shakable package; depends on `@margoengine/math` only (the physics entry is typed by shape and imports no physics code).

Build and unit tests: npm test --workspace @margoengine/netcode
