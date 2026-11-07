# @margoengine/net

Import `margoengine/net` from the `margoengine` package, or `@margoengine/net` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Bounded snapshot interpolation for position, quaternion and velocity, with capped dead reckoning.

```ts
import {SnapshotBuffer, createSnapshot} from 'margoengine/net';
const renderTimeSeconds = performance.now() / 1000;
const buffer = new SnapshotBuffer(32);
const output = createSnapshot();
// buffer.push(timeSeconds, position, quaternion, velocity)
buffer.sample(renderTimeSeconds, output);
```

Position interpolation is cubic Hermite using endpoint velocities; rotations use shortest-arc slerp. Ordered snapshots are copied into a preallocated ring, quaternions normalized, and duplicate/out-of-order timestamps return false. Extrapolation uses last velocity up to maxPrediction (default 0.25 seconds), then holds. Before the oldest sample, the oldest pose is held. Outputs are reused by default; supply your own to retain results. This is interpolation/prediction, not transport, authority, rollback or packet security.

## Adaptive render delay

`AdaptiveDelay` in `margoengine/net/delay` picks how far behind the newest snapshot to draw from what the link does, so a calm link draws close and a rough one stays smooth.

```ts
import {SnapshotBuffer, createSnapshot} from 'margoengine/net';
import {AdaptiveDelay} from 'margoengine/net/delay';
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

## Any field

`FieldBuffer` in `margoengine/net/fields` does for any fields you name what `SnapshotBuffer` does for the pose, each field blending its own way.

```ts
import {FieldBuffer} from 'margoengine/net/fields';
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

## One timeline

`margoengine/net/timeline` is the one home of time-ordered snapshots in the engine. `SnapshotBuffer` and `FieldBuffer` here, and the client and the rewind of `@margoengine/netcode`, all sit on it. Use `Timeline` for snapshots that are objects, and `TimeRing` for rows of numbers in your own storage.

```ts
import {Timeline, blendAngle} from 'margoengine/net/timeline';
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

Build and unit tests: npm test --workspace @margoengine/net

