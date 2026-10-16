export function createSkyProbeFrame() {
  // Include the six night-control vec4 fields; zero keeps the probe's night extension disabled.
  const frame = new Float32Array(64);
  frame.set([0, 0, 0, 0.01], 16);
  frame.set([0, 1, 0, 0], 20);
  frame.set([0.25, 0.45, 0.75, 0], 32);
  frame.set([0.45, 0, 1500, 0], 36);
  return frame;
}
