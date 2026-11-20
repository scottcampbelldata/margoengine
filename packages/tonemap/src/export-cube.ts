import type { Grade } from './grade.js';
import { bakeGrade } from './bake.js';

/** Controls for exporting a display-linear Grade as a portable 3D .cube LUT. */
export interface CubeExportOptions {
  /** Samples per RGB axis, integer 2..65. Default 33. Larger grids reduce interpolation error. */
  size?: number;
  /** Single-line title without quotes or control characters, at most 1024 characters. Default 'Margo Grade'. */
  title?: string;
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
  const lut = bakeGrade(grade, size),
    rows = [
      `TITLE "${title}"`,
      '# Margo display-linear RGB Grade snapshot',
      `LUT_3D_SIZE ${size}`,
      'DOMAIN_MIN 0 0 0',
      'DOMAIN_MAX 1 1 1',
    ];
  for (let i = 0; i < lut.data.length; i += 4) rows.push(`${lut.data[i]} ${lut.data[i + 1]} ${lut.data[i + 2]}`);
  return rows.join('\n') + '\n';
}
