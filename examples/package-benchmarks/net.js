import { SnapshotBuffer, createSnapshot } from '../../packages/net/dist/index.js';
import { grid } from './layout.js';

export function createWorkload(count = 256) {
  const points = grid(count),
    origins = points.slice(),
    yaw = new Float32Array(count),
    buffers = [],
    outputs = [];
  const position = new Float64Array(3),
    rotation = new Float64Array(4),
    velocity = new Float64Array(3);
  let time = 0,
    packetTime = 0.05,
    packets = 0,
    dropped = 0;
  function push(i, stamp) {
    const phase = stamp + i * 0.137;
    position[0] = origins[i * 4] + Math.sin(phase) * 0.13;
    position[1] = 0.25 + Math.sin(phase * 2) * 0.1;
    position[2] = origins[i * 4 + 2];
    velocity[0] = Math.cos(phase) * 0.13;
    velocity[1] = Math.cos(phase * 2) * 0.2;
    velocity[2] = 0;
    rotation[0] = rotation[2] = 0;
    rotation[1] = Math.sin(phase / 2);
    rotation[3] = Math.cos(phase / 2);
    if (buffers[i].push(stamp, position, rotation, velocity)) packets++;
  }
  for (let i = 0; i < count; i++) {
    buffers.push(new SnapshotBuffer(32, 0.25));
    outputs.push(createSnapshot());
    push(i, -0.1);
    push(i, 0);
  }
  return {
    points,
    yaw,
    buffers,
    outputs,
    description:
      'Simulate 20 Hz packets for remote actors, then sample Hermite positions and quaternion rotations with a 100 ms playback delay. Periodic losses exercise capped prediction. No network requests.',
    step(delta) {
      time += delta;
      while (packetTime <= time) {
        for (let i = 0; i < count; i++) {
          if (i % 8 === 0 && packetTime % 4 >= 2 && packetTime % 4 < 2.4) {
            dropped++;
            continue;
          }
          push(i, packetTime);
        }
        packetTime += 0.05;
      }
      for (let i = 0; i < count; i++) {
        const pose = buffers[i].sample(time - 0.1, outputs[i]);
        points[i * 4] = pose.position[0];
        points[i * 4 + 1] = pose.position[1];
        points[i * 4 + 2] = pose.position[2];
        points[i * 4 + 3] = i % 8 === 0 ? 2 : 0;
        yaw[i] = 2 * Math.atan2(pose.rotation[1], pose.rotation[3]);
      }
    },
    details: () => ({ remoteActors: count, snapshotSlotsPerActor: 32, packetHz: 20, packets, dropped }),
    dispose() {
      for (const buffer of buffers) buffer.clear();
    },
  };
}
