import type { Grade } from './grade.js';

/** Controls for exporting a display-linear Grade as a portable 3D .cube LUT. */
export interface CubeExportOptions {
  /** Samples per RGB axis, integer 2..65. Default 33. Larger grids reduce interpolation error. */
  size?: number;
  /** Single-line title without quotes or control characters, at most 1024 characters. Default 'Margo Grade'. */
  title?: string;
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function smooth(x: number): number {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
}

// Evaluate the actual uniform snapshot, including Grade's 33-sample curves, rather than resampling the authored
// cubic at export resolution. That keeps this bake aligned with the live shader's two-stage curve lookup.
function evaluate(v: Float32Array, c: number[]): void {
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
  if (v.length === 152) return;
  hi = Math.max(...c);
  lo = Math.min(...c);
  d = hi - lo;
  if (d === 0) return;
  let h = hi === c[0] ? (c[1] - c[2]) / d : hi === c[1] ? 2 + (c[2] - c[0]) / d : 4 + (c[0] - c[1]) / d;
  h = ((h / 6 + 1) % 1) * 360;
  const n = v[153];
  let offset = v[152];
  if (n > 0) {
    let ax = v[156 + (n - 1) * 4] - 360,
      ay = v[157 + (n - 1) * 4],
      bx = v[156],
      by = v[157];
    for (let i = 0; i < n; i++)
      if (h >= v[156 + i * 4]) {
        ax = v[156 + i * 4];
        ay = v[157 + i * 4];
        bx = i + 1 < n ? v[156 + (i + 1) * 4] : v[156] + 360;
        by = i + 1 < n ? v[157 + (i + 1) * 4] : v[157];
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
 * Snapshot the current Grade or HueGrade and return .cube file contents, red varying fastest.
 * Domain and output are display-linear RGB in 0..1. Save as UTF-8 with a .cube suffix, then use in a matching domain.
 * Includes all Grade wheels, sampled curves, hue saturation and optional hue rotation. Tonemap exposure/display
 * curves, other extensions and any existing LUT are outside Grade and are not included. Remove the live grade when
 * loading the baked LUT to avoid applying it twice. Finite grids approximate the grade between sample points.
 * @throws RangeError for invalid export controls or live grade options; correct size, title or grade options.
 * @throws TypeError for unsupported grading extensions; supply a Grade or HueGrade.
 */
export function exportCube(grade: Grade, options: CubeExportOptions = {}): string {
  const { size = 33, title = 'Margo Grade' } = options;
  if (!Number.isInteger(size) || size < 2 || size > 65)
    throw new RangeError('Invalid cube size; supply an integer from 2 through 65');
  if (typeof title !== 'string' || title.length > 1024 || /["\x00-\x1f\x7f\u2028\u2029]/u.test(title))
    throw new RangeError('Invalid cube title; supply at most 1024 characters without quotes or control characters');
  if (!grade || typeof grade.values !== 'function' || (grade.key !== 'grade' && grade.key !== 'grade-hue'))
    throw new TypeError('Unsupported grade; supply a Grade or HueGrade instance');
  const v = new Float32Array(grade.values());
  if (v.length !== (grade.key === 'grade' ? 152 : 412) || !v.every(Number.isFinite))
    throw new TypeError('Unsupported grade uniform; supply an unmodified Grade or HueGrade');
  const rows = [
    `TITLE "${title}"`,
    '# Margo display-linear RGB Grade snapshot',
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0 0 0',
    'DOMAIN_MAX 1 1 1',
  ];
  const c = [0, 0, 0],
    last = size - 1;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        c[0] = r / last;
        c[1] = g / last;
        c[2] = b / last;
        evaluate(v, c);
        rows.push(`${Math.fround(c[0])} ${Math.fround(c[1])} ${Math.fround(c[2])}`);
      }
  return rows.join('\n') + '\n';
}
