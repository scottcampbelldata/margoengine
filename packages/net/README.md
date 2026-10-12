# @margoengine/net

Bounded snapshot interpolation for position, quaternion and velocity, with capped dead reckoning.

```ts
import {SnapshotBuffer, createSnapshot} from '@margoengine/net';
const buffer = new SnapshotBuffer(32);
const output = createSnapshot();
// buffer.push(timeSeconds, position, quaternion, velocity)
buffer.sample(renderTimeSeconds, output);
```

Position interpolation is cubic Hermite using endpoint velocities; rotations use shortest-arc slerp. Ordered snapshots are copied into a preallocated ring, quaternions normalized, and duplicate/out-of-order timestamps return false. Extrapolation uses last velocity up to maxPrediction (default 0.25 seconds), then holds. Before the oldest sample, the oldest pose is held. Outputs are reused by default; supply your own to retain results. This is interpolation/prediction, not transport, authority, rollback or packet security.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/net

