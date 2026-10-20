// CPU mirror of clusterIes (src/ies.ts) for tests and the real-GPU check: the profile factor for the light at `index`, from
// the words IESLights uploads, the light's axis (a spot's unit direction, else null for a point light) and the unit vector
// `d` from the light to the shaded point. Also small LM-63 file writers for synthetic profiles.
const ROWS = 181;
export function iesFactor(words, index, axis, d) {
  const floats = new Float32Array(words.buffer);
  if (index >= words[0]) return 1;
  const id = words[68 + index * 2];
  if (id === 0) return 1;
  const o = words[4 + (id - 1) * 4],
    columns = words[5 + (id - 1) * 4],
    a = axis ?? [0, -1, 0],
    dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const value = (k) => {
    const w = words[68 + o + (k >> 1)];
    return ((k & 1 ? w >>> 16 : w & 0xffff) >>> 0) / 65535;
  };
  const t = (Math.acos(Math.min(1, Math.max(-1, dot(d, a)))) * (ROWS - 1)) / Math.PI,
    r0 = Math.min(Math.floor(t), ROWS - 2),
    fr = t - r0;
  let c0 = 0,
    c1 = 0,
    fc = 0;
  if (columns > 1) {
    const side = Math.abs(a[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0],
      k = dot(side, a),
      x0 = side.map((v, i) => v - a[i] * k),
      l = Math.hypot(...x0),
      x = x0.map((v) => v / l),
      y = [x[1] * a[2] - x[2] * a[1], x[2] * a[0] - x[0] * a[2], x[0] * a[1] - x[1] * a[0]];
    const turn = Math.atan2(dot(d, y), dot(d, x)) - floats[68 + index * 2 + 1],
      s = ((turn - 2 * Math.PI * Math.floor(turn / (2 * Math.PI))) * columns) / (2 * Math.PI);
    c0 = Math.min(Math.floor(s), columns - 1);
    c1 = (c0 + 1) % columns;
    fc = s - c0;
  }
  const mix = (p, q, f) => p + (q - p) * f,
    A = mix(value(c0 * ROWS + r0), value(c0 * ROWS + r0 + 1), fr),
    B = mix(value(c1 * ROWS + r0), value(c1 * ROWS + r0 + 1), fr);
  return mix(A, B, fc);
}
/** An LM-63-2002 file of `candela(theta, phi)` sampled at the given vertical and horizontal angles (degrees). */
export function iesFile(vertical, horizontal, candela, { multiplier = 1, tilt = 'NONE', lumens = -1 } = {}) {
  const values = horizontal.map((phi) => vertical.map((theta) => +candela(theta, phi).toFixed(4)).join(' '));
  return [
    'IESNA:LM-63-2002',
    '[TEST] synthetic',
    '[MANUFAC] Margo tests',
    '[MORE] second line',
    `TILT=${tilt}`,
    `1 ${lumens} ${multiplier} ${vertical.length} ${horizontal.length} 1 2 0.1 0.1 0`,
    '1.0 1.0 20',
    vertical.join(' '),
    horizontal.join(' '),
    ...values,
    '',
  ].join('\r\n');
}
export const range = (from, to, step) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);
