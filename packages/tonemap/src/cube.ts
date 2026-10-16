/** A parsed 33³ 3D LUT, as `parseCube` returns it and `Tonemap.setLUT` takes it. */
export interface CubeLUT {
  /** 33 x 33 x 33 RGBA texels (A = 1), red index varying fastest; display-linear RGB after the tone curve. */
  data: Float32Array;
  /** Input value mapped to the first texel per channel (RGB). Default [0, 0, 0]. */
  domainMin: Float32Array;
  /** Input value mapped to the last texel per channel (RGB); each above its `domainMin`. Default [1, 1, 1]. */
  domainMax: Float32Array;
}

/**
 * Parse a 33³ RGB .cube LUT, red index varying fastest.
 * @throws RangeError when the text is not a string, is over 8 MiB, or has the wrong row count.
 * @throws TypeError on a malformed TITLE, size or domain header, an unsupported header or a non-finite value.
 */
export function parseCube(text: string): CubeLUT {
  if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) throw new RangeError('Invalid .cube text size');
  const data = new Float32Array(33 * 33 * 33 * 4),
    domainMin = new Float32Array(3),
    domainMax = new Float32Array([1, 1, 1]);
  let size = false,
    min = false,
    max = false,
    count = 0;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^TITLE\s/.test(raw.trim())) {
      if (!/^TITLE\s+"[^"]*"\s*(?:#.*)?$/.test(raw.trim())) throw new TypeError('Invalid .cube TITLE');
      continue;
    }
    const line = raw.split('#', 1)[0].trim();
    if (!line) continue;
    const tokens = line.split(/\s+/),
      key = tokens[0];
    if (key === 'LUT_3D_SIZE') {
      if (size || count || tokens.length !== 2 || tokens[1] !== '33')
        throw new TypeError('.cube requires one LUT_3D_SIZE 33 header');
      size = true;
      continue;
    }
    if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      if (count || tokens.length !== 4 || (key === 'DOMAIN_MIN' && min) || (key === 'DOMAIN_MAX' && max))
        throw new TypeError('Invalid .cube domain header');
      const out = key === 'DOMAIN_MIN' ? domainMin : domainMax;
      for (let i = 0; i < 3; i++) {
        if (!number(tokens[i + 1])) throw new TypeError('Invalid .cube domain value');
        out[i] = Number(tokens[i + 1]);
      }
      if (key === 'DOMAIN_MIN') min = true;
      else max = true;
      continue;
    }
    if (!size || tokens.length !== 3 || count >= 33 * 33 * 33)
      throw new TypeError('Invalid .cube row or unsupported header');
    for (let i = 0; i < 3; i++) {
      if (!number(tokens[i])) throw new TypeError('Invalid .cube sample');
      data[count * 4 + i] = Number(tokens[i]);
    }
    data[count * 4 + 3] = 1;
    count++;
  }
  if (!size || count !== 33 * 33 * 33) throw new RangeError('.cube must contain exactly 33³ RGB rows');
  const lut = { data, domainMin, domainMax };
  validateLUT(lut);
  return lut;
}
function number(token: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token) && Number.isFinite(Math.fround(Number(token)));
}
export function validateLUT(lut: CubeLUT): void {
  if (
    !lut ||
    !(lut.data instanceof Float32Array) ||
    lut.data.length !== 33 * 33 * 33 * 4 ||
    !(lut.domainMin instanceof Float32Array) ||
    lut.domainMin.length !== 3 ||
    !(lut.domainMax instanceof Float32Array) ||
    lut.domainMax.length !== 3
  )
    throw new TypeError('Invalid 33³ LUT arrays');
  for (let i = 0; i < 3; i++)
    if (
      !Number.isFinite(lut.domainMin[i]) ||
      !Number.isFinite(lut.domainMax[i]) ||
      !Number.isFinite(Math.fround(lut.domainMax[i] - lut.domainMin[i])) ||
      lut.domainMax[i] <= lut.domainMin[i]
    )
      throw new RangeError('Invalid LUT domain');
  for (let i = 0; i < lut.data.length; i++)
    if (!Number.isFinite(lut.data[i])) throw new RangeError('Invalid LUT sample');
}
