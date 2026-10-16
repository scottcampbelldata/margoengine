import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import {
  floats,
  latin1,
  limits,
  normalizeColors,
  splitFields,
  TextScanner,
  toBytes,
  type BinaryInput,
} from './util.js';

const F = 'XYZ';

/** Column meaning for XYZ rows. `'auto'` decides from the column count of the first row. */
export type XYZLayout =
  | 'auto'
  | 'xyz'
  | 'xyz-rgb'
  | 'xyz-normal'
  | 'xyz-normal-rgb'
  | 'xyz-intensity'
  | 'xyz-intensity-rgb';
export interface XYZOptions extends ParseLimits {
  layout?: XYZLayout;
}

const COLUMNS: Record<Exclude<XYZLayout, 'auto'>, number> = {
  'xyz': 3,
  'xyz-rgb': 6,
  'xyz-normal': 6,
  'xyz-normal-rgb': 9,
  'xyz-intensity': 4,
  'xyz-intensity-rgb': 7,
};
const numeric = (token: string): boolean => !Number.isNaN(Number(token)) || /^[+-]?nan$/i.test(token);

/**
 * Parses an ASCII XYZ point cloud (one point per line, separated by spaces, tabs, commas or semicolons).
 * Replaces Three.js `XYZLoader`. Auto layout: 3 columns xyz, 4 xyz+intensity, 6 xyz+rgb (xyz+normal when any
 * extra value is negative), 7 xyz+intensity+rgb (PTS), 9 xyz+normal+rgb; other counts keep xyz only.
 * A leading count line (PTS, chemistry XYZ) and a leading element label per row are skipped. Colors given
 * as 0..255 integers are scaled to [0,1].
 */
export function parseXYZ(input: BinaryInput, options: XYZOptions = {}): LoadedGeometry {
  const bytes = toBytes(input, F),
    limit = limits(options, F);
  let layout = options.layout ?? 'auto';
  if (layout !== 'auto' && !(layout in COLUMNS))
    throw new LoaderError(F, 'range', `unknown layout "${String(layout)}"`);
  const scanner = new TextScanner(latin1(bytes), F);
  const positions = floats(),
    extra = floats();
  let columns = -1,
    lineNumber = 0,
    first = true,
    labelled = false,
    count = 0,
    skipComment = false;
  for (let line = scanner.line(); line !== null; line = scanner.line()) {
    lineNumber++;
    const trimmed = line.trim();
    if (skipComment) {
      skipComment = false;
      if (!trimmed || !numeric(splitFields(trimmed)[0] ?? '')) continue;
    }
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    let fields = splitFields(trimmed);
    if (first) {
      first = false;
      if (fields.length === 1 && /^\d+$/.test(fields[0])) {
        skipComment = true;
        continue;
      }
    }
    if (columns < 0) labelled = fields.length >= 4 && !numeric(fields[0]) && fields.slice(1, 4).every(numeric);
    if (labelled) fields = fields.slice(1);
    if (columns < 0) {
      columns = fields.length;
      if (columns < 3)
        throw new LoaderError(F, 'syntax', `line ${lineNumber} has ${columns} values, expected at least 3`);
      if (layout !== 'auto' && columns < COLUMNS[layout])
        throw new LoaderError(
          F,
          'syntax',
          `layout ${layout} needs ${COLUMNS[layout]} values, line ${lineNumber} has ${columns}`,
        );
    } else if (fields.length !== columns)
      throw new LoaderError(F, 'syntax', `line ${lineNumber} has ${fields.length} values, expected ${columns}`);
    if (++count > limit.maxVertices)
      throw new LoaderError(F, 'limit', `point count exceeds the limit of ${limit.maxVertices}`);
    for (let c = 0; c < columns && c < 9; c++) {
      const value = Number(fields[c]);
      if (Number.isNaN(value) && !/^[+-]?nan$/i.test(fields[c]))
        throw new LoaderError(F, 'syntax', `invalid number "${fields[c].slice(0, 32)}" on line ${lineNumber}`);
      if (c < 3) positions.push(value);
      else extra.push(value);
    }
  }
  if (count === 0) throw new LoaderError(F, 'syntax', 'no points found');
  const stride = Math.min(columns, 9) - 3,
    values = extra.array;
  if (layout === 'auto') {
    if (columns === 4) layout = 'xyz-intensity';
    else if (columns === 6) {
      let negative = false;
      for (let i = 0; i < extra.length && !negative; i++) negative = values[i] < 0;
      layout = negative ? 'xyz-normal' : 'xyz-rgb';
    } else if (columns === 7) layout = 'xyz-intensity-rgb';
    else if (columns >= 9) layout = 'xyz-normal-rgb';
    else layout = 'xyz';
  }
  const result: LoadedGeometry = { kind: 'points', positions: positions.result() };
  const take = (offset: number, size: number): Float32Array => {
    const out = new Float32Array(count * size);
    for (let i = 0; i < count; i++) for (let a = 0; a < size; a++) out[i * size + a] = values[i * stride + offset + a];
    return out;
  };
  if (layout === 'xyz-normal' || layout === 'xyz-normal-rgb') result.normals = take(0, 3);
  if (layout === 'xyz-intensity' || layout === 'xyz-intensity-rgb') result.attributes = { intensity: take(0, 1) };
  const colorOffset =
    layout === 'xyz-rgb' ? 0 : layout === 'xyz-intensity-rgb' ? 1 : layout === 'xyz-normal-rgb' ? 3 : -1;
  if (colorOffset >= 0) {
    result.colors = take(colorOffset, 3);
    normalizeColors(result.colors);
  }
  return result;
}
