import type { CubeLUT } from './cube.js';
import type { Grade } from './grade.js';
import { bakeGrade } from './bake.js';

// The .3dl 3D LUT text format of Autodesk Flame, Smoke and Lustre, written from Autodesk's product documentation
// ("Formatting 3D LUTs", Smoke 2011 help; "3D LUT file format", Lustre 2011 help): an optional Lustre header (`3DMESH`
// then `Mesh <input bits> <output bits>`), a line of the N input code values of the grid vertices (0 to the input
// maximum, e.g. 0 64 128 ... 1023), then N³ lines of integer output codes R G B with the blue index varying fastest,
// then green, then red.

/** Controls for {@link parse3dl}. */
export interface Parse3dlOptions {
  /**
   * Bits per output value, 1-16. Default: the Lustre `Mesh` header's output depth when present, else the smallest of
   * 8, 10, 12, 14 and 16 that holds both the largest value in the file and the largest input code value.
   */
  outputBits?: number;
}

/** Controls for {@link export3dl}. */
export interface Export3dlOptions {
  /** Samples per axis, integer 2-65, when exporting a Grade. Default 33. A CubeLUT keeps its own size. */
  size?: number;
  /** Bits of the input code values on the first line, 8-16. Default 10 (0 to 1023, as Flame writes them). */
  inputBits?: number;
  /** Bits per output value, 8-16. Default 12 (0 to 4095). */
  outputBits?: number;
}

const integer = /^\d+$/;
const bits = (v: unknown, lo: number, hi: number, name: string) => {
  if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi)
    throw new RangeError(`.3dl ${name} is invalid; supply an integer from ${lo} through ${hi}`);
  return v as number;
};

/**
 * Parses a 2³-65³ .3dl LUT (Flame, Smoke or Lustre layout) into the {@link CubeLUT} that `Tonemap.setLUT` takes:
 * red index varying fastest, output codes divided by the output maximum, and the input codes mapped to a 0..1 domain
 * on a uniform grid. Text is capped at 32 × 1024² JavaScript characters. Lines may carry `#` comments.
 * @throws TypeError when `text` is not a string, on a malformed header, a missing or non-uniform input line (a
 * non-uniform one is a shaper this loader does not apply; resample the LUT to a uniform grid), a sample row that is not
 * three non-negative integers, or a sample count that is not N³.
 * @throws RangeError when the text is over the cap, the size is outside 2-65, a depth is out of range, or a value is
 * above the output maximum.
 */
export function parse3dl(text: string, options: Parse3dlOptions = {}): CubeLUT {
  if (typeof text !== 'string') throw new TypeError('.3dl text must be a string; supply the file contents');
  if (text.length > 32 * 1024 * 1024)
    throw new RangeError('.3dl text exceeds 32 Mi characters; supply a smaller LUT file');
  let outBits = options.outputBits === undefined ? undefined : bits(options.outputBits, 1, 16, 'output depth'),
    meshSize = 0,
    mesh = false;
  const rows: string[][] = [];
  for (const raw of text.split('\n')) {
    const comment = raw.indexOf('#'),
      line = (comment < 0 ? raw : raw.slice(0, comment)).trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] === '3DMESH' || tokens[0] === 'Mesh') {
      if (
        rows.length ||
        (tokens[0] === '3DMESH' ? mesh || meshSize || tokens.length !== 1 : meshSize || tokens.length !== 3)
      )
        throw new TypeError('.3dl header is invalid; supply 3DMESH and then Mesh <input bits> <output bits> first');
      if (tokens[0] === '3DMESH') {
        mesh = true;
        continue;
      }
      if (!integer.test(tokens[1]) || !integer.test(tokens[2]))
        throw new TypeError('.3dl Mesh header is invalid; supply two integer bit depths');
      const input = bits(Number(tokens[1]), 1, 6, 'Mesh input depth');
      meshSize = 2 ** input + 1;
      outBits ??= bits(Number(tokens[2]), 1, 16, 'Mesh output depth');
      continue;
    }
    if (!tokens.every((t) => integer.test(t)))
      throw new TypeError('.3dl row is invalid; supply non-negative integer code values');
    rows.push(tokens);
  }
  // The input line is present unless a Mesh header gives the size and the rows are exactly N³.
  const size = meshSize && rows.length === meshSize ** 3 ? meshSize : rows[0]?.length;
  if (!size || size < 2 || size > 65)
    throw new (size ? RangeError : TypeError)('.3dl size is outside 2-65; supply a 2- to 65-entry input line');
  const shaper = rows.length === size ** 3 + 1 ? rows.shift()!.map(Number) : undefined;
  if (rows.length !== size ** 3 || (meshSize && meshSize !== size))
    throw new TypeError('.3dl sample count is invalid; supply the input line and then exactly N³ R G B rows');
  if (shaper) {
    const top = shaper[size - 1],
      step = top / (size - 1);
    if (shaper[0] !== 0 || !shaper.every((v, i) => Math.abs(v - i * step) <= 1.5 + 0.02 * step))
      throw new TypeError('.3dl input line is not a uniform grid from 0; resample the LUT to a uniform grid');
  }
  let peak = 0;
  for (const row of rows) {
    if (row.length !== 3) throw new TypeError('.3dl sample row is invalid; supply exactly three values per row');
    for (const v of row) peak = Math.max(peak, Number(v));
  }
  if (outBits === undefined) {
    const need = Math.max(peak, shaper?.[size - 1] ?? 0);
    outBits = [8, 10, 12, 14, 16].find((b) => need <= 2 ** b - 1);
    if (outBits === undefined) throw new RangeError('.3dl value exceeds 16 bits; supply codes up to 65535');
  }
  const max = 2 ** outBits - 1;
  if (peak > max)
    throw new RangeError(
      `.3dl value exceeds the ${outBits}-bit output maximum ${max}; supply outputBits for the file's depth`,
    );
  const data = new Float32Array(size ** 3 * 4);
  let n = 0;
  for (let r = 0; r < size; r++)
    for (let g = 0; g < size; g++)
      for (let b = 0; b < size; b++, n++) {
        const o = 4 * ((b * size + g) * size + r),
          row = rows[n];
        data[o] = Number(row[0]) / max;
        data[o + 1] = Number(row[1]) / max;
        data[o + 2] = Number(row[2]) / max;
        data[o + 3] = 1;
      }
  return { size, data, domainMin: new Float32Array(3), domainMax: new Float32Array([1, 1, 1]) };
}

/**
 * Writes a Grade or HueGrade snapshot (as `exportCube` bakes it) or a 0..1-domain {@link CubeLUT} as .3dl text in the
 * Flame layout: the input code values of the grid vertices on the first line (multiples of 2^inputBits / (N - 1),
 * the last held at the input maximum: 0 64 128 ... 1023 for 17 samples at 10 bits), then N³ rows of R G B output codes,
 * blue varying fastest. Values are clamped to 0..1 and rounded to the output depth. Save as UTF-8 with a .3dl suffix.
 * @throws RangeError for an invalid size or depth, a size given for a CubeLUT that differs from its own, or a LUT
 * whose domain is not 0..1 (.3dl has no domain).
 * @throws TypeError for an unsupported source; supply a Grade, HueGrade or CubeLUT.
 */
export function export3dl(source: Grade | CubeLUT, options: Export3dlOptions = {}): string {
  const inBits = bits(options.inputBits ?? 10, 8, 16, 'input depth'),
    outBits = bits(options.outputBits ?? 12, 8, 16, 'output depth');
  let lut: CubeLUT;
  if (source && 'data' in source) {
    lut = source;
    const size = lut.size ?? 33;
    if (!(lut.data instanceof Float32Array) || lut.data.length !== size ** 3 * 4)
      throw new TypeError('Unsupported LUT; supply size³ RGBA Float32 samples');
    if (options.size !== undefined && options.size !== size)
      throw new RangeError('.3dl size differs from the LUT; omit size for a CubeLUT');
    if ([0, 1, 2].some((i) => lut.domainMin[i] !== 0 || lut.domainMax[i] !== 1))
      throw new RangeError('.3dl has no domain; supply a LUT with a 0..1 domain');
  } else lut = bakeGrade(source as Grade, bits(options.size ?? 33, 2, 65, 'size'));
  const size = lut.size ?? 33,
    inMax = 2 ** inBits - 1,
    outMax = 2 ** outBits - 1,
    code = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * outMax),
    lines = [
      Array.from({ length: size }, (_, i) => Math.min(Math.round((i * (inMax + 1)) / (size - 1)), inMax)).join(' '),
    ];
  for (let r = 0; r < size; r++)
    for (let g = 0; g < size; g++)
      for (let b = 0; b < size; b++) {
        const o = 4 * ((b * size + g) * size + r);
        lines.push(`${code(lut.data[o])} ${code(lut.data[o + 1])} ${code(lut.data[o + 2])}`);
      }
  return lines.join('\n') + '\n';
}
