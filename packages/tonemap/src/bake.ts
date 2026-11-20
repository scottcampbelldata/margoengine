import type { Grade } from './grade.js';
import type { CubeLUT } from './cube.js';

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function smooth(x: number): number {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
}

// Evaluate the actual uniform snapshot, including Grade's 33-sample curves, rather than resampling the authored
// cubic at export resolution. That keeps this bake aligned with the live shader's two-stage curve lookup.
// `tone`: the snapshot holds Grade's primaries (lift and saturation, gamma, gain at 152, 156 and 160), applied first as
// gradeTone does; `hue`: HueGrade's controls follow, at `base` (152, or 164 after the primaries).
function evaluate(v: Float32Array, c: number[], tone: boolean, hue: boolean): void {
  if (tone) {
    for (let k = 0; k < 3; k++)
      c[k] = clamp(Math.max(0, v[160 + k] * (c[k] + v[152 + k] * (1 - c[k]))) ** (1 / v[156 + k]));
    const y = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    for (let k = 0; k < 3; k++) c[k] = clamp(y + (c[k] - y) * v[155]);
  }
  const l = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  const ws = 1 - smooth(l * 2),
    wh = smooth((l - 0.5) * 2);
  const curve = (x: number, channel: number) => {
    const t = clamp(x) * 32,
      i = Math.min(Math.floor(t), 31);
    return mix(v[20 + i * 4 + channel], v[20 + (i + 1) * 4 + channel], t - i);
  };
  for (let k = 0; k < 3; k++) {
    c[k] = clamp(c[k] + v[k] * ws + v[4 + k] * (1 - ws - wh) + v[8 + k] * wh);
    c[k] = curve(curve(c[k], 0), k + 1);
  }
  let hi = Math.max(...c),
    lo = Math.min(...c),
    d = hi - lo;
  if (d > 0) {
    let h = hi === c[0] ? (c[1] - c[2]) / d : hi === c[1] ? 2 + (c[2] - c[0]) / d : 4 + (c[0] - c[1]) / d;
    h = ((h / 6 + 1) % 1) * 6;
    const i = Math.min(Math.floor(h), 5),
      s = mix(v[12 + i], v[12 + ((i + 1) % 6)], h - i);
    const y = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    for (let k = 0; k < 3; k++) c[k] = clamp(y + (c[k] - y) * s);
  }
  if (!hue) return;
  const base = tone ? 164 : 152;
  hi = Math.max(...c);
  lo = Math.min(...c);
  d = hi - lo;
  if (d === 0) return;
  let h = hi === c[0] ? (c[1] - c[2]) / d : hi === c[1] ? 2 + (c[2] - c[0]) / d : 4 + (c[0] - c[1]) / d;
  h = ((h / 6 + 1) % 1) * 360;
  const n = v[base + 1];
  let offset = v[base];
  if (n > 0) {
    let ax = v[base + 4 + (n - 1) * 4] - 360,
      ay = v[base + 5 + (n - 1) * 4],
      bx = v[base + 4],
      by = v[base + 5];
    for (let i = 0; i < n; i++)
      if (h >= v[base + 4 + i * 4]) {
        ax = v[base + 4 + i * 4];
        ay = v[base + 5 + i * 4];
        bx = i + 1 < n ? v[base + 4 + (i + 1) * 4] : v[base + 4] + 360;
        by = i + 1 < n ? v[base + 5 + (i + 1) * 4] : v[base + 5];
      }
    offset += mix(ay, by, (h - ax) / (bx - ax));
  }
  if (offset === 0) return;
  h = ((h + offset) / 360 + 2) % 1;
  for (let k = 0; k < 3; k++) {
    const phase = k === 0 ? 0 : k === 1 ? 2 / 3 : 1 / 3;
    c[k] = lo + d * clamp(Math.abs(((h + phase) % 1) * 6 - 3) - 1);
  }
}

/**
 * Samples a Grade or HueGrade's live uniform snapshot on a `size`³ grid over display-linear 0..1, red index varying
 * fastest, as Float32 values.
 * @throws TypeError for unsupported grading extensions or a modified uniform.
 */
export function bakeGrade(grade: Grade, size: number): CubeLUT {
  const key = grade && typeof grade.values === 'function' ? grade.key : '',
    hue = key.startsWith('grade-hue'),
    tone = key.endsWith(':tone');
  if (!['grade', 'grade-hue', 'grade:tone', 'grade-hue:tone'].includes(key))
    throw new TypeError('Unsupported grade; supply a Grade or HueGrade instance');
  const v = new Float32Array(grade.values());
  if (v.length !== (tone ? 164 : 152) + (hue ? 260 : 0) || !v.every(Number.isFinite))
    throw new TypeError('Unsupported grade uniform; supply an unmodified Grade or HueGrade');
  const data = new Float32Array(size ** 3 * 4),
    c = [0, 0, 0],
    last = size - 1;
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++, i += 4) {
        c[0] = r / last;
        c[1] = g / last;
        c[2] = b / last;
        evaluate(v, c, tone, hue);
        data.set(c, i);
        data[i + 3] = 1;
      }
  return { size, data, domainMin: new Float32Array(3), domainMax: new Float32Array([1, 1, 1]) };
}
