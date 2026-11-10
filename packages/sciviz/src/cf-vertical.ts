import { rangeError } from '../../shared/errors.js';
import type { NetCDFFile, NetCDFVariable } from './netcdf.js';
import { convertCFUnits } from './cf-units.js';
/** Broadcast physical vertical coordinates in the named dimension order, last dimension fastest. */
export interface CFVertical {
  readonly data: Float64Array;
  readonly dimensions: readonly string[];
  readonly shape: readonly number[];
  readonly units: 'm' | 'Pa';
  readonly positive: 'up' | 'down';
}
const bad = (s: string) => rangeError(`CF vertical: ${s}`, 'sciviz');
const text = (v: NetCDFVariable, k: string) => (typeof v.attributes[k] === 'string' ? (v.attributes[k] as string) : '');
/** CF Appendix D formulas, or dimensional height/depth/pressure. Omitted formula terms are zero per CF 1.12. */
export async function readCFVertical(
  file: NetCDFFile,
  name: string,
  options: {
    readonly indices?: Readonly<Record<string, number>>;
    readonly signal?: AbortSignal;
    readonly maxElements?: number;
  } = {},
): Promise<CFVertical> {
  options.signal?.throwIfAborted();
  const coordinate = file.variables[name];
  if (!coordinate) throw bad(`unknown coordinate ${name}`);
  const formula = text(coordinate, 'standard_name'),
    sourceUnits = text(coordinate, 'units'),
    rawTerms = text(coordinate, 'formula_terms').trim(),
    terms: Record<string, NetCDFVariable> = {};
  let rest = rawTerms;
  for (const match of rawTerms.matchAll(/(\w+)\s*:\s*(\S+)/g)) {
    const key = match[1].toLowerCase(),
      variable = file.variables[match[2]];
    if (!variable || terms[key]) throw bad(`missing variable or duplicate formula term ${match[0]}`);
    terms[key] = variable;
    rest = rest.replace(match[0], '');
  }
  if (rest.trim()) throw bad('malformed formula_terms');
  const dimensional = !rawTerms && !/^(atmosphere_|ocean_).+_coordinate/.test(formula);
  const pressure = dimensional
    ? /^(Pa|hPa|kPa|bars?|mbars?|millibars?|dbar|atm|pascals?)$/.test(sourceUnits)
    : formula.startsWith('atmosphere_') && /pressure|sigma_coordinate/.test(formula);
  const units = pressure ? 'Pa' : 'm';
  const known = [
    'atmosphere_ln_pressure_coordinate',
    'atmosphere_sigma_coordinate',
    'atmosphere_hybrid_sigma_pressure_coordinate',
    'atmosphere_hybrid_height_coordinate',
    'atmosphere_sleve_coordinate',
    'ocean_sigma_coordinate',
    'ocean_s_coordinate',
    'ocean_s_coordinate_g1',
    'ocean_s_coordinate_g2',
    'ocean_sigma_z_coordinate',
    'ocean_double_sigma_coordinate',
  ];
  if (!dimensional && !known.includes(formula)) throw bad(`unsupported formula ${formula}`);
  const variables = dimensional ? { value: coordinate } : terms;
  const dimensions = [
      ...new Set([
        ...(dimensional ? [] : coordinate.dimensions),
        ...Object.values(variables).flatMap((v) => v.dimensions),
      ]),
    ],
    indices = options.indices ?? {};
  for (const [d, i] of Object.entries(indices))
    if (!dimensions.includes(d) || !Number.isInteger(i) || i < 0 || i >= file.dimensions[d])
      throw bad(`invalid index ${d}`);
  const outDims = dimensions.filter((d) => indices[d] === undefined),
    shape = outDims.map((d) => file.dimensions[d]),
    size = shape.reduce((a, b) => a * b, 1),
    max = options.maxElements ?? 16777216;
  if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(size) || size > max)
    throw bad('broadcast exceeds maxElements (default 16777216)');
  const tensors: Record<string, { variable: NetCDFVariable; data: Float64Array; shape: number[] }> = {};
  const lengthTerms = new Set([
    'orog',
    'ztop',
    'zsurf1',
    'zsurf2',
    'eta',
    'depth',
    'depth_c',
    'zlev',
    'z1',
    'z2',
    'href',
  ]);
  const pressureTerms = new Set(['ps', 'ptop', 'p0', 'ap']);
  for (const [key, variable] of Object.entries(variables)) {
    const count = variable.dimensions.map((d, i) => (indices[d] === undefined ? variable.shape[i] : 1)),
      start = variable.dimensions.map((d) => indices[d] ?? 0);
    let data = await variable.read({ start, count, signal: options.signal });
    const target = dimensional
      ? units
      : pressureTerms.has(key)
        ? 'Pa'
        : lengthTerms.has(key) ||
            (key === 'a' && ['atmosphere_hybrid_height_coordinate', 'ocean_double_sigma_coordinate'].includes(formula))
          ? 'm'
          : undefined;
    if (target) data = convertCFUnits(data, text(variable, 'units'), target);
    tensors[key] = { variable, data, shape: count };
  }
  const result = new Float64Array(size),
    position: Record<string, number> = {};
  const get = (key: string) => {
    const tensor = tensors[key];
    if (!tensor) return 0;
    let at = 0;
    for (let d = 0; d < tensor.shape.length; d++)
      at =
        at * tensor.shape[d] +
        (indices[tensor.variable.dimensions[d]] === undefined ? position[tensor.variable.dimensions[d]] : 0);
    return tensor.data[at];
  };
  for (let i = 0; i < size; i++) {
    if (i % 4096 === 0) options.signal?.throwIfAborted();
    let index = i;
    for (let d = shape.length - 1; d >= 0; d--) {
      position[outDims[d]] = index % shape[d];
      index = Math.floor(index / shape[d]);
    }
    const v = (key: string) => get(key),
      eta = v('eta'),
      depth = v('depth'),
      s = v('s'),
      dc = v('depth_c');
    let value: number;
    if (dimensional) value = v('value');
    else if (formula === 'atmosphere_ln_pressure_coordinate') value = v('p0') * Math.exp(-v('lev'));
    else if (formula === 'atmosphere_sigma_coordinate') value = v('ptop') + v('sigma') * (v('ps') - v('ptop'));
    else if (formula === 'atmosphere_hybrid_sigma_pressure_coordinate')
      value = (terms.ap ? v('ap') : v('a') * v('p0')) + v('b') * v('ps');
    else if (formula === 'atmosphere_hybrid_height_coordinate') value = v('a') + v('b') * v('orog');
    else if (formula === 'atmosphere_sleve_coordinate')
      value = v('a') * v('ztop') + v('b1') * v('zsurf1') + v('b2') * v('zsurf2');
    else if (formula === 'ocean_sigma_coordinate') value = eta + v('sigma') * (depth + eta);
    else if (formula === 'ocean_s_coordinate') {
      const a = v('a'),
        b = v('b'),
        c =
          a === 0
            ? s
            : ((1 - b) * Math.sinh(a * s)) / Math.sinh(a) +
              b * (Math.tanh(a * (s + 0.5)) / (2 * Math.tanh(0.5 * a)) - 0.5);
      value = eta * (1 + s) + dc * s + (depth - dc) * c;
    } else if (formula === 'ocean_s_coordinate_g1') {
      const S = dc * s + (depth - dc) * v('c');
      value = depth === 0 ? NaN : S + eta * (1 + S / depth);
    } else if (formula === 'ocean_s_coordinate_g2') {
      const S = (dc * s + depth * v('c')) / (dc + depth);
      value = dc + depth === 0 ? NaN : eta + (eta + depth) * S;
    } else {
      const level = coordinate.dimensions[0],
        k = indices[level] ?? position[level];
      if (formula === 'ocean_sigma_z_coordinate')
        value = Number.isFinite(v('sigma')) ? eta + v('sigma') * (Math.min(dc, depth) + eta) : v('zlev');
      else {
        const z1 = v('z1'),
          z2 = v('z2'),
          f = 0.5 * (z1 + z2) + 0.5 * (z1 - z2) * Math.tanh(((2 * v('a')) / (z1 - z2)) * (depth - v('href')));
        value = k <= v('k_c') ? v('sigma') * f : f + (v('sigma') - 1) * (depth - f);
      }
    }
    result[i] = value;
  }
  const positive = text(coordinate, 'positive').toLowerCase() || (pressure || formula === 'depth' ? 'down' : 'up');
  if (positive !== 'up' && positive !== 'down') throw bad('positive must be up or down');
  return Object.freeze({
    data: result,
    dimensions: Object.freeze(outDims),
    shape: Object.freeze(shape),
    units,
    positive: dimensional ? positive : pressure ? 'down' : 'up',
  });
}
