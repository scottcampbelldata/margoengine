import { rangeError } from '../../shared/errors.js';
const bad = (s: string) => rangeError(`CF units: ${s}`, 'sciviz');
type Unit = { scale: number; offset: number; dimensions: Record<string, number> };
// Affine temperatures and a composable climate SI vocabulary. Unknown units stay metadata until conversion is requested.
const vocabulary: Record<string, [number, string, number?]> = {
  '1': [1, ''],
  '%': [0.01, ''],
  percent: [0.01, ''],
  fraction: [1, ''],
  m: [1, 'L'],
  meter: [1, 'L'],
  metre: [1, 'L'],
  km: [1000, 'L'],
  cm: [0.01, 'L'],
  mm: [0.001, 'L'],
  um: [1e-6, 'L'],
  s: [1, 'T'],
  sec: [1, 'T'],
  second: [1, 'T'],
  min: [60, 'T'],
  minute: [60, 'T'],
  h: [3600, 'T'],
  hr: [3600, 'T'],
  hour: [3600, 'T'],
  d: [86400, 'T'],
  day: [86400, 'T'],
  kg: [1, 'M'],
  g: [0.001, 'M'],
  K: [1, 'K'],
  kelvin: [1, 'K'],
  degC: [1, 'K', 273.15],
  degree_Celsius: [1, 'K', 273.15],
  degrees_Celsius: [1, 'K', 273.15],
  Celsius: [1, 'K', 273.15],
  degF: [5 / 9, 'K', 255.3722222222222],
  Pa: [1, 'P'],
  pascal: [1, 'P'],
  hPa: [100, 'P'],
  kPa: [1000, 'P'],
  bar: [100000, 'P'],
  mbar: [100, 'P'],
  millibar: [100, 'P'],
  dbar: [10000, 'P'],
  atm: [101325, 'P'],
  rad: [1, 'A'],
  radian: [1, 'A'],
  degree: [Math.PI / 180, 'A'],
  degrees: [Math.PI / 180, 'A'],
  degrees_east: [Math.PI / 180, 'A'],
  degree_east: [Math.PI / 180, 'A'],
  degrees_E: [Math.PI / 180, 'A'],
  degree_E: [Math.PI / 180, 'A'],
  degreesE: [Math.PI / 180, 'A'],
  degreeE: [Math.PI / 180, 'A'],
  degrees_north: [Math.PI / 180, 'A'],
  degree_north: [Math.PI / 180, 'A'],
  degrees_N: [Math.PI / 180, 'A'],
  degree_N: [Math.PI / 180, 'A'],
  degreesN: [Math.PI / 180, 'A'],
  degreeN: [Math.PI / 180, 'A'],
  W: [1, 'W'],
  J: [1, 'J'],
  Hz: [1, 'H'],
  N: [1, 'N'],
  mol: [1, 'mol'],
};
const derived: Record<string, Record<string, number>> = {
  P: { M: 1, L: -1, T: -2 },
  W: { M: 1, L: 2, T: -3 },
  J: { M: 1, L: 2, T: -2 },
  H: { T: -1 },
  N: { M: 1, L: 1, T: -2 },
};
function parse(source: string): Unit {
  if (!source.trim()) throw bad('missing units');
  const input = source
    .trim()
    .replace(/\*\*/g, '^')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s*\*\s*/g, ' ')
    .replace(/\s*\^\s*/g, '^');
  let scale = 1,
    offset = 0,
    divide = false;
  const dimensions: Record<string, number> = {};
  const tokens = input.split(/\s+/);
  for (const token of tokens) {
    if (token === '/') {
      if (divide) throw bad('use explicit exponents for multiple division');
      divide = true;
      continue;
    }
    const match = /^([A-Za-z_%]+|1)(?:\^?([+-]?\d+))?$/.exec(token);
    if (!match) throw bad(`unsupported unit expression ${source}`);
    const key = match[1],
      u = vocabulary[key] ?? vocabulary[key.endsWith('s') ? key.slice(0, -1) : key];
    if (!u) throw bad(`unknown unit ${key}`);
    const exponent = Number(match[2] ?? 1) * (divide ? -1 : 1);
    if (u[2] !== undefined && (tokens.length !== 1 || exponent !== 1))
      throw bad('on-scale temperature cannot appear in a compound unit; convert differences in K');
    offset = u[2] ?? 0;
    scale *= u[0] ** exponent;
    for (const [d, p] of Object.entries(derived[u[1]] ?? (u[1] ? { [u[1]]: 1 } : {})))
      dimensions[d] = (dimensions[d] ?? 0) + p * exponent;
  }
  for (const key of Object.keys(dimensions)) if (dimensions[key] === 0) delete dimensions[key];
  return { scale, offset, dimensions };
}
/** Converts climate SI units and affine temperature scales. Unknown or incompatible units reject explicitly. NaN masks survive. */
export function convertCFUnits(
  values: ArrayLike<number>,
  from: string,
  to: string,
  options: { readonly temperatureDifference?: boolean } = {},
): Float64Array {
  if (from === to) return Float64Array.from(values);
  const a = parse(from),
    b = parse(to),
    keys = new Set([...Object.keys(a.dimensions), ...Object.keys(b.dimensions)]);
  if ([...keys].some((k) => a.dimensions[k] !== b.dimensions[k])) throw bad(`incompatible ${from} and ${to}`);
  return Float64Array.from(
    values,
    (v) =>
      (v * a.scale + (options.temperatureDifference ? 0 : a.offset) - (options.temperatureDifference ? 0 : b.offset)) /
      b.scale,
  );
}
