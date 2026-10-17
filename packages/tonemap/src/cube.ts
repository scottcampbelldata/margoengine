export interface CubeLUT {
  /** Samples per axis (integer 2–65). Omitted on legacy manually constructed LUTs means 33. */
  size?: number;
  data: Float32Array;
  domainMin: Float32Array;
  domainMax: Float32Array;
}

/** Parse a 2³–65³ RGB .cube LUT, red index varying fastest. Text is capped at 32 × 1024² JavaScript characters. */
export function parseCube(text: string): CubeLUT {
  if (typeof text !== 'string') throw new TypeError('.cube text must be a string; supply the file contents');
  if (text.length > 32 * 1024 * 1024)
    throw new RangeError('.cube text exceeds 32 Mi characters; supply a smaller LUT file');
  const domainMin = new Float32Array(3),
    domainMax = new Float32Array([1, 1, 1]);
  let data: Float32Array | undefined,
    size = 0,
    title = false,
    min = false,
    max = false,
    count = 0;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^TITLE\s/.test(raw.trim())) {
      if (title || count || !/^TITLE\s+"[^"]*"\s*(?:#.*)?$/.test(raw.trim()))
        throw new TypeError('.cube TITLE is invalid; supply one quoted title before the sample rows');
      title = true;
      continue;
    }
    const line = raw.split('#', 1)[0].trim();
    if (!line) continue;
    const tokens = line.split(/\s+/),
      key = tokens[0];
    if (key === 'LUT_3D_SIZE') {
      if (size || count || tokens.length !== 2 || !/^[+-]?\d+$/.test(tokens[1]))
        throw new TypeError('.cube size header is invalid; supply one LUT_3D_SIZE integer before the sample rows');
      size = dimension(Number(tokens[1]));
      data = new Float32Array(size ** 3 * 4);
      continue;
    }
    if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      if (count || tokens.length !== 4 || (key === 'DOMAIN_MIN' && min) || (key === 'DOMAIN_MAX' && max))
        throw new TypeError('.cube domain header is invalid; supply each three-value domain once before sample rows');
      const out = key === 'DOMAIN_MIN' ? domainMin : domainMax;
      for (let i = 0; i < 3; i++) {
        out[i] = number(tokens[i + 1], '.cube domain');
      }
      if (key === 'DOMAIN_MIN') min = true;
      else max = true;
      continue;
    }
    if (!data || tokens.length !== 3 || count >= size ** 3)
      throw new TypeError('.cube sample row is invalid; supply exactly size³ RGB rows after the size header');
    for (let i = 0; i < 3; i++) {
      data[count * 4 + i] = number(tokens[i], '.cube sample');
    }
    data[count * 4 + 3] = 1;
    count++;
  }
  if (!data || count !== size ** 3)
    throw new TypeError('.cube sample count is invalid; supply exactly size³ RGB rows after a LUT_3D_SIZE header');
  const lut = { size, data, domainMin, domainMax };
  validateLUT(lut);
  return lut;
}
function number(token: string, subject: string): number {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) {
    if (/^[+-]?(?:NaN|Infinity)$/.test(token))
      throw new RangeError(`${subject} is not finite; supply a finite Float32 value`);
    throw new TypeError(`${subject} syntax is invalid; supply a decimal or scientific-notation number`);
  }
  const value = Number(token);
  if (!Number.isFinite(Math.fround(value)))
    throw new RangeError(`${subject} is outside Float32 range; supply a finite Float32 value`);
  return value;
}
function dimension(size: unknown): number {
  if (typeof size !== 'number') throw new TypeError('LUT size must be a number; supply an integer from 2 through 65');
  if (!Number.isInteger(size) || size < 2 || size > 65)
    throw new RangeError('LUT size is outside 2–65; supply an integer from 2 through 65');
  return size;
}
export function validateLUT(lut: CubeLUT): void {
  if (!lut || typeof lut !== 'object') throw new TypeError('LUT must be an object; supply Float32 data and domains');
  const size = dimension(lut.size === undefined ? 33 : lut.size);
  if (
    !(lut.data instanceof Float32Array) ||
    lut.data.length !== size ** 3 * 4 ||
    !(lut.domainMin instanceof Float32Array) ||
    lut.domainMin.length !== 3 ||
    !(lut.domainMax instanceof Float32Array) ||
    lut.domainMax.length !== 3
  )
    throw new TypeError('LUT arrays are invalid; supply size³ RGBA samples and two three-value Float32 domains');
  for (let i = 0; i < 3; i++)
    if (
      !Number.isFinite(lut.domainMin[i]) ||
      !Number.isFinite(lut.domainMax[i]) ||
      !Number.isFinite(Math.fround(lut.domainMax[i] - lut.domainMin[i])) ||
      lut.domainMax[i] <= lut.domainMin[i]
    )
      throw new RangeError('LUT domain is invalid; supply finite minima below maxima with finite Float32 ranges');
  for (let i = 0; i < lut.data.length; i++)
    if (!Number.isFinite(lut.data[i]))
      throw new RangeError('LUT sample is not finite; supply finite RGB and alpha values');
}
