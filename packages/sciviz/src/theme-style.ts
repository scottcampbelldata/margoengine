import { hexColor } from '@margoengine/math/color';
import { multiplyMatrices } from '@margoengine/math/mat4';
import type { Theme } from './axes.js';
import { rangeError, typeError } from '../../shared/errors.js';
/** @internal Shared resolved typography for HTML and its computed-style exports. */
export function themeFont(theme: Theme, title = false): string {
  const size = title ? (theme.titleSize ?? theme.fontSize ?? 13) : (theme.fontSize ?? 12);
  return `${title ? '600 ' : ''}var(--margo-${title ? 'title-size' : 'font-size'}, ${size}px) var(--margo-font-family, ${theme.fontFamily ?? 'system-ui, sans-serif'})`;
}
/** @internal Validate optional style tokens before any owned state changes. */
export function validateThemeStyle(theme: Theme): void {
  if (
    theme.fontFamily !== undefined &&
    (typeof theme.fontFamily !== 'string' || !theme.fontFamily.trim() || /[;{}<>\r\n]/.test(theme.fontFamily))
  )
    throw typeError('Theme fontFamily needs a CSS family list without declarations; supply a font family', 'sciviz');
  for (const key of ['fontSize', 'titleSize', 'lineWidth', 'axisWidth', 'gridWidth'] as const)
    if (theme[key] !== undefined && (!Number.isFinite(theme[key]) || theme[key]! <= 0 || theme[key]! > 256))
      throw rangeError(`Theme ${key} must be in (0,256] CSS pixels; correct the token`, 'sciviz');
  if (
    theme.tickCount !== undefined &&
    (!Number.isInteger(theme.tickCount) || theme.tickCount < 2 || theme.tickCount > 100)
  )
    throw rangeError('Theme tickCount must be 2..100; correct the token', 'sciviz');
  if (theme.tickSize !== undefined && (!Number.isFinite(theme.tickSize) || theme.tickSize < 0 || theme.tickSize > 64))
    throw rangeError('Theme tickSize must be in [0,64] CSS pixels; correct the token', 'sciviz');
  if (theme.gridStyle !== undefined && !['solid', 'none'].includes(theme.gridStyle))
    throw typeError('Theme gridStyle must be solid or none; correct the token', 'sciviz');
  if (
    theme.palette !== undefined &&
    (!Array.isArray(theme.palette) ||
      !theme.palette.length ||
      theme.palette.some((c) => typeof c !== 'string' || c.length !== 7 || !hexColor(c)))
  )
    throw typeError('Theme palette needs nonempty #rrggbb colours; correct the palette', 'sciviz');
}

/** @internal An inward tick of a specified screen length, solved in homogeneous coordinates. */
export function tickSegment(
  engine: import('@margoengine/core').EngineKernel,
  model: Float32Array,
  origin: readonly [number, number, number],
  axis: number,
  length: number,
): number[] {
  const e = engine as unknown as { camera: { matrix: Float32Array }; canvas: HTMLCanvasElement };
  const matrix = multiplyMatrices(e.camera.matrix, model),
    width = e.canvas.clientWidth || e.canvas.width,
    height = e.canvas.clientHeight || e.canvas.height;
  const [x, y, z] = origin;
  const ax = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    ay = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    aw = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const dx = matrix[axis * 4],
    dy = matrix[axis * 4 + 1],
    dw = matrix[axis * 4 + 3];
  const k = Math.hypot(((dx * aw - ax * dw) * width) / 2, ((dy * aw - ay * dw) * height) / 2),
    denominator = k - length * aw * dw;
  if (!(aw > 0 && denominator > 0)) return [];
  const t = (length * aw * aw) / denominator,
    end = [x, y, z];
  end[axis] += t;
  return [x, y, z, ...end];
}
