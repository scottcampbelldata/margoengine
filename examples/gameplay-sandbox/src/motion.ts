export type HeightField = (x: number, z: number) => number;

// state: xyz, heading, camera yaw/pitch, gait phase, speed; actions: strafe, forward, look xy, sprint.
export function stepLocomotion(state: Float32Array, actions: Float32Array, delta: number, height: HeightField): void {
  const dt = Math.min(0.05, Math.max(0, delta));
  state[4] -= actions[2];
  state[5] = Math.max(0.08, Math.min(0.9, state[5] + actions[3]));
  const length = Math.max(1, Math.hypot(actions[0], actions[1])), speed = actions[4] > 0 ? 7 : 3.4;
  const dx = (actions[0] * Math.cos(state[4]) - actions[1] * Math.sin(state[4])) / length;
  const dz = (-actions[0] * Math.sin(state[4]) - actions[1] * Math.cos(state[4])) / length;
  const damping = 1 - Math.exp(-14 * dt);
  state[7] += (Math.min(1, Math.hypot(actions[0], actions[1])) * speed - state[7]) * damping;
  state[0] = Math.max(-69, Math.min(69, state[0] + dx * state[7] * dt));
  state[2] = Math.max(-69, Math.min(69, state[2] + dz * state[7] * dt));
  state[1] = Math.max(0.45, height(state[0], state[2]));
  if (Math.hypot(dx, dz) > 0.001) {
    const heading = Math.atan2(dx, dz), angle = Math.atan2(Math.sin(heading - state[3]), Math.cos(heading - state[3]));
    state[3] += angle * (1 - Math.exp(-10 * dt));
  }
  state[6] += state[7] * dt * 2.6;
}
