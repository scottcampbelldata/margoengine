// A small captured performance of Margo's own, in the file layout a per-frame capture uses: one binary little-endian PLY
// a frame with position, normal, DC colour, opacity logit, log scales and a rotation quaternion (w, x, y, z). Eight
// splats on a ring rise, turn about z and keep their order from frame to frame.
const names = 'x y z nx ny nz f_dc_0 f_dc_1 f_dc_2 opacity scale_0 scale_1 scale_2 rot_0 rot_1 rot_2 rot_3'.split(' ');
export const SPLATS = 8,
  FRAMES = 3,
  LONG = 0.12,
  SHORT = 0.04;

/** Centre of splat `i` in frame `f`. */
export const centre = (i, f) => {
  const angle = (i / SPLATS) * 2 * Math.PI;
  return [Math.cos(angle) * 0.6, Math.sin(angle) * 0.6 + f * 0.1, 0];
};
/** The turn about z of every splat in frame `f`, in radians. */
export const turn = (f) => f * (Math.PI / 6);

/** The bytes of frame `f`. */
export function plyFrame(f) {
  const header = new TextEncoder().encode(
      `ply\nformat binary_little_endian 1.0\nelement vertex ${SPLATS}\n` +
        `${names.map((name) => `property float ${name}`).join('\n')}\nend_header\n`,
    ),
    bytes = new Uint8Array(header.length + SPLATS * names.length * 4),
    view = new DataView(bytes.buffer);
  bytes.set(header);
  for (let i = 0; i < SPLATS; i++) {
    const row = [
      ...centre(i, f),
      ...[0, 0, 0],
      ...[1.2, (i / SPLATS) * 2 - 1, -1],
      2,
      ...[Math.log(LONG), Math.log(SHORT), Math.log(SHORT)],
      ...[Math.cos(turn(f) / 2), 0, 0, Math.sin(turn(f) / 2)],
    ];
    row.forEach((x, k) => view.setFloat32(header.length + (i * names.length + k) * 4, x, true));
  }
  return bytes;
}
