// The two kinds of ICC profile an image of display colour holds: matrix and curve RGB, and curve grey (ICC.1:2022, sections
// 8.3 and 10). Written from the public specification. A profile built on lookup tables alone is not read: undefined, so the
// caller keeps its samples and says so.

/** One input curve: encoded 0-1 in, linear 0-1 out. */
export type ICCCurve = (encoded: number) => number;

/** A profile that takes samples to linear colour with curves and, for RGB, a matrix to XYZ at D50. */
export interface ICCProfile {
  /** One curve for grey, three for red, green and blue. */
  curves: ICCCurve[];
  /** The red, green and blue columns in XYZ, row by row. Undefined for grey, whose white is the white of the PCS. */
  matrix?: number[];
}

// Linear sRGB from XYZ at D50: the inverse of the D50 colorants of the sRGB profile.
const FROM_D50 = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427];

function tagOf(view: DataView, name: string): number | undefined {
  const wanted = [...name].reduce((sum, letter) => sum * 256 + letter.charCodeAt(0), 0),
    count = view.getUint32(128);
  for (let i = 0; i < count; i++) if (view.getUint32(132 + i * 12) === wanted) return view.getUint32(136 + i * 12);
  return undefined;
}

const fixed = (view: DataView, at: number): number => view.getInt32(at) / 65536;

function tableCurve(view: DataView, at: number, count: number): ICCCurve {
  const table = new Float64Array(count);
  for (let i = 0; i < count; i++) table[i] = view.getUint16(at + i * 2) / 65535;
  return (encoded) => {
    const place = Math.min(Math.max(encoded, 0), 1) * (count - 1),
      low = Math.min(Math.floor(place), count - 2);
    return table[low] + (table[low + 1] - table[low]) * (place - low);
  };
}

// parametricCurveType, the five forms of ICC.1 section 10.18, with g, a, b, c, d, e, f in that order.
function parametricCurve(view: DataView, at: number): ICCCurve | undefined {
  const kind = view.getUint16(at + 8),
    count = [1, 3, 4, 5, 7][kind];
  if (count === undefined) return undefined;
  const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = Array.from({ length: count }, (_, i) => fixed(view, at + 12 + i * 4)),
    power = (x: number) => Math.pow(Math.max(a * x + b, 0), g);
  if (kind === 0) return (x) => Math.pow(Math.max(x, 0), g);
  if (kind === 1) return (x) => (x >= -b / a ? power(x) : 0);
  if (kind === 2) return (x) => (x >= -b / a ? power(x) + c : c);
  if (kind === 3) return (x) => (x >= d ? power(x) : c * x);
  return (x) => (x >= d ? power(x) + e : c * x + f);
}

function readCurve(view: DataView, name: string): ICCCurve | undefined {
  const at = tagOf(view, name);
  if (at === undefined) return undefined;
  const type = view.getUint32(at);
  if (type === 0x70617261) return parametricCurve(view, at);
  if (type !== 0x63757276) return undefined;
  const count = view.getUint32(at + 8);
  if (count === 0) return (x) => x;
  if (count === 1) {
    const gamma = view.getUint16(at + 12) / 256;
    return (x) => Math.pow(Math.max(x, 0), gamma);
  }
  return tableCurve(view, at + 12, count);
}

/** Reads a matrix and curve RGB profile or a curve grey profile; undefined for anything else, a damaged profile included. */
export function readICCProfile(bytes: Uint8Array): ICCProfile | undefined {
  if (bytes.length < 132) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    space = view.getUint32(16);
  try {
    if (space === 0x47524159) {
      const curve = readCurve(view, 'kTRC');
      return curve && { curves: [curve] };
    }
    if (space !== 0x52474220) return undefined;
    const curves = ['rTRC', 'gTRC', 'bTRC'].map((name) => readCurve(view, name)),
      columns = ['rXYZ', 'gXYZ', 'bXYZ'].map((name) => tagOf(view, name));
    if (curves.includes(undefined) || columns.includes(undefined)) return undefined;
    const matrix: number[] = [];
    for (let row = 0; row < 3; row++) for (const at of columns) matrix.push(fixed(view, at! + 8 + row * 4));
    return { curves: curves as ICCCurve[], matrix };
  } catch (error) {
    // A tag pointing past the end of the profile. The profile is unusable, which is the answer this function gives.
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

function multiply(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++)
      out.push(a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column]);
  return out;
}

// sRGB encoding of linear 0-1, by a table: its steps at the dark end are 0.05 of an 8-bit level, so a lookup rounds as well as
// the formula while costing no power function a sample.
const ENCODE_STEPS = 65535;
let encodeTable: Uint8Array | undefined;

function srgbEncoding(): Uint8Array {
  if (encodeTable) return encodeTable;
  encodeTable = new Uint8Array(ENCODE_STEPS + 1);
  for (let i = 0; i <= ENCODE_STEPS; i++) {
    const linear = i / ENCODE_STEPS;
    encodeTable[i] = Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055));
  }
  return encodeTable;
}

/**
 * Converts straight RGBA samples of 16 bits, encoded in `profile`, to sRGB RGBA8, relative colorimetric as Safari and
 * LittleCMS do it for a matrix profile. Colours outside sRGB clip. Alpha is carried over.
 */
export function profileToSRGB(samples: Uint16Array, profile: ICCProfile): Uint8Array {
  const out = new Uint8Array(samples.length),
    encode = srgbEncoding(),
    levels = profile.curves.map((curve) => Float64Array.from({ length: 65536 }, (_, i) => curve(i / 65535))),
    [red, green = red, blue = red] = levels,
    m = profile.matrix ? multiply(FROM_D50, profile.matrix) : [1, 0, 0, 0, 1, 0, 0, 0, 1],
    level = (linear: number) => encode[Math.round(Math.min(Math.max(linear, 0), 1) * ENCODE_STEPS)];
  for (let at = 0; at < samples.length; at += 4) {
    const r = red[samples[at]],
      g = green[samples[at + 1]],
      b = blue[samples[at + 2]];
    out[at] = level(m[0] * r + m[1] * g + m[2] * b);
    out[at + 1] = level(m[3] * r + m[4] * g + m[5] * b);
    out[at + 2] = level(m[6] * r + m[7] * g + m[8] * b);
    out[at + 3] = Math.round(samples[at + 3] / 257);
  }
  return out;
}
