/// <reference lib="esnext.disposable" preserve="true" />
// Clean room from CF 1.12 chapters 3-5, 7-8 and appendices D/F.
import { rangeError } from '../../shared/errors.js';
import {
  openNetCDF,
  type NetCDFFile,
  type NetCDFVariable,
  type NetCDFAttribute,
  type FileInput,
  type FileOptions,
} from './netcdf.js';
import { climateProjection, type ClimateProjection } from './projections.js';
import { convertCFUnits } from './cf-units.js';
export { convertCFUnits } from './cf-units.js';
export { cfTimeCodec } from './cf-time.js';
export type { CFCalendar, CFDateTime, CFTimeOptions, CFTimeCodec } from './cf-time.js';
export { readCFVertical } from './cf-vertical.js';
export type { CFVertical } from './cf-vertical.js';
export { regridCF, cfMapLayer, conservativeCF, cfSampler } from './cf-grid.js';
export type { CFMapTarget, CFRegridOptions, CFMapGrid, CFSampleOptions } from './cf-grid.js';

/** Semantic role discovered from CF coordinate metadata. */
export type CFCoordinateKind = 'longitude' | 'latitude' | 'x' | 'y' | 'vertical' | 'time' | 'other';
/** A dimension, auxiliary or scalar coordinate, retaining CF metadata and lazy reads. */
export interface CFCoordinate {
  readonly name: string;
  readonly kind: CFCoordinateKind;
  readonly variable: NetCDFVariable;
  readonly units: string;
  readonly standardName: string;
  readonly positive: 'up' | 'down' | undefined;
  readonly bounds: NetCDFVariable | undefined;
}
/** Lazy scientific variable and its associated coordinates and mapping. */
export interface CFField {
  readonly variable: NetCDFVariable;
  readonly coordinates: readonly CFCoordinate[];
  readonly units: string;
  readonly gridMapping: NetCDFVariable | undefined;
}
/** Horizontal-plane selection and unpacked output units. */
export interface CFReadOptions {
  /** Zero-based index for each non-horizontal dimension with length >1. Never silently selects time/level/member. */
  readonly indices?: Readonly<Record<string, number>>;
  /** Optional target units. Default original unpacked units. */
  readonly units?: string;
  readonly signal?: AbortSignal;
}
/** Row-major [ny,nx] scalar plane. Rectilinear has nx longitude and ny latitude; curvilinear has nx*ny of each. */
export interface CFGrid {
  readonly nx: number;
  readonly ny: number;
  readonly longitude: Float64Array;
  readonly latitude: Float64Array;
  readonly values: Float64Array;
  readonly curvilinear: boolean;
  readonly units: string;
  /** CF cell bounds [low,high] per longitude/latitude sample, when supplied for rectilinear grids. */
  readonly longitudeBounds?: Float64Array;
  readonly latitudeBounds?: Float64Array;
}
const bad = (s: string) => rangeError(`CF: ${s}`, 'sciviz');
function cfText(attrs: Readonly<Record<string, NetCDFAttribute>>, key: string): string {
  const a = attrs[key];
  return typeof a === 'string' ? a : '';
}
function coordinate(variable: NetCDFVariable, file: NetCDFFile): CFCoordinate {
  const a = variable.attributes,
    units = cfText(a, 'units'),
    standardName = cfText(a, 'standard_name'),
    axis = cfText(a, 'axis').toUpperCase(),
    positive = cfText(a, 'positive').toLowerCase();
  const kind: CFCoordinateKind =
    standardName === 'longitude' || /^degrees?_?(east|E)$/.test(units)
      ? 'longitude'
      : standardName === 'latitude' || /^degrees?_?(north|N)$/.test(units)
        ? 'latitude'
        : standardName === 'time' || /\ssince\s/.test(units) || axis === 'T'
          ? 'time'
          : axis === 'Z' ||
              positive === 'up' ||
              positive === 'down' ||
              /^(Pa|hPa|kPa|mbar|millibars?|bars?|dbar|atm)$/.test(units) ||
              /^(depth|height|altitude|air_pressure)$/.test(standardName) ||
              /^(atmosphere_|ocean_).+_coordinate/.test(standardName)
            ? 'vertical'
            : axis === 'X' || standardName === 'projection_x_coordinate'
              ? 'x'
              : axis === 'Y' || standardName === 'projection_y_coordinate'
                ? 'y'
                : 'other';
  const boundsName = cfText(a, 'bounds'),
    bounds = boundsName ? file.variables[boundsName] : undefined;
  if (boundsName && !bounds) throw bad(`missing bounds variable ${boundsName}`);
  if (positive && positive !== 'up' && positive !== 'down') throw bad(`invalid positive attribute on ${variable.name}`);
  return Object.freeze({
    name: variable.name,
    kind,
    variable,
    units,
    standardName,
    positive: (positive as CFCoordinate['positive']) || undefined,
    bounds,
  });
}
/** Discovers dimension and explicitly associated auxiliary/scalar coordinates without reading payloads. */
export function inspectCFField(file: NetCDFFile, name: string): CFField {
  const variable = file.variables[name];
  if (!variable) throw bad(`unknown variable ${name}`);
  const names = new Set([
    ...variable.dimensions.filter(
      (d) => file.variables[d]?.dimensions.length === 1 && file.variables[d].dimensions[0] === d,
    ),
    ...cfText(variable.attributes, 'coordinates').trim().split(/\s+/).filter(Boolean),
  ]);
  const coordinates = [...names].map((n) => {
    const v = file.variables[n];
    if (!v) throw bad(`${name} references missing coordinate ${n}`);
    // CF section 6.1: a character label has a trailing string-length dimension, not a domain axis.
    const domain = v.type === 'char' ? v.dimensions.slice(0, -1) : v.dimensions;
    if (domain.some((d) => !variable.dimensions.includes(d)))
      throw bad(`coordinate ${n} dimensions are not a subset of ${name}`);
    return coordinate(v, file);
  });
  const mapping = cfText(variable.attributes, 'grid_mapping').trim();
  // CF expanded syntax can associate several CRSs. This plane requires one geographic mapping.
  const mappingNames = mapping.includes(':')
    ? [...mapping.matchAll(/(\S+):/g)].map((m) => m[1])
    : mapping
      ? [mapping]
      : [];
  if (mappingNames.length > 1) throw bad('multiple grid mappings; select one CRS before extracting a plane');
  const gridMapping = file.variables[mappingNames[0]];
  if (mappingNames.length && !gridMapping) throw bad(`missing grid mapping ${mappingNames[0]}`);
  return Object.freeze({
    variable,
    coordinates: Object.freeze(coordinates),
    units: cfText(variable.attributes, 'units'),
    gridMapping,
  });
}
/** Converts the supported CF Appendix F grid mappings to the owning optional projection API. */
export function cfGridProjection(
  mapping: NetCDFVariable,
  units: { readonly x?: string; readonly y?: string } = {},
): ClimateProjection {
  const a = mapping.attributes,
    text = (k: string) => cfText(a, k),
    number = (k: string, fallback: number) => {
      const v = a[k];
      if (v === undefined) return fallback;
      if (typeof v === 'string' || v.length !== 1 || !Number.isFinite(v[0]))
        throw bad(`grid mapping ${k} must be one finite number`);
      return v[0];
    },
    name = text('grid_mapping_name'),
    inv = number('inverse_flattening', 0),
    radius = number('earth_radius', number('semi_major_axis', 6378137)),
    minor = number('semi_minor_axis', radius),
    flattening =
      a.earth_radius !== undefined
        ? 0
        : a.inverse_flattening !== undefined
          ? inv === 0
            ? 0
            : 1 / inv
          : a.semi_minor_axis !== undefined
            ? 1 - minor / radius
            : 0;
  const names: Record<string, Parameters<typeof climateProjection>[0]> = {
    lambert_conformal_conic: 'lambert-conformal-conic',
    albers_conical_equal_area: 'albers',
    polar_stereographic: 'polar-stereographic',
    latitude_longitude: 'plate',
    mercator: 'mercator',
  };
  if (!names[name]) throw bad(`unsupported grid mapping ${name}; provide geographic auxiliary longitude/latitude`);
  const parallels = a.standard_parallel;
  if (typeof parallels === 'string') throw bad('standard_parallel must be numeric');
  return climateProjection(names[name], {
    radius,
    flattening: name === 'latitude_longitude' ? 0 : flattening,
    centralMeridian:
      number(
        'longitude_of_central_meridian',
        number('straight_vertical_longitude_from_pole', number('longitude_of_projection_origin', 0)),
      ) + number('longitude_of_prime_meridian', 0),
    latitudeOrigin: number('latitude_of_projection_origin', name === 'polar_stereographic' ? 90 : 0),
    standardParallels: parallels ? Array.from(parallels) : undefined,
    scaleFactor:
      a.scale_factor_at_projection_origin === undefined ? undefined : number('scale_factor_at_projection_origin', 1),
    falseOrigin: [
      convertCFUnits([number('false_easting', 0)], units.x ?? 'm', 'm')[0],
      convertCFUnits([number('false_northing', 0)], units.y ?? 'm', 'm')[0],
    ],
  });
}
/** Reads one scientific horizontal plane, transposing arbitrary file dimension order to [y,x]. */
export async function readCFField(file: NetCDFFile, name: string, options: CFReadOptions = {}): Promise<CFGrid> {
  options.signal?.throwIfAborted();
  const info = inspectCFField(file, name),
    v = info.variable,
    indices = options.indices ?? {};
  for (const [d, i] of Object.entries(indices))
    if (!v.dimensions.includes(d) || !Number.isInteger(i) || i < 0 || i >= file.dimensions[d])
      throw bad(`invalid index ${d}: ${i}`);
  const choose = (kind: CFCoordinateKind) => {
    const found = info.coordinates.filter((c) => c.kind === kind);
    if (found.length > 1) throw bad(`ambiguous ${kind} coordinates on ${name}`);
    return found[0];
  };
  const lon = choose('longitude'),
    lat = choose('latitude'),
    xx = choose('x'),
    yy = choose('y');
  let xd: string,
    yd: string,
    curvilinear = false,
    projection: ClimateProjection | undefined;
  const horizontal = (c: CFCoordinate) => c.variable.dimensions.filter((d) => indices[d] === undefined);
  if (lon && lat) {
    const ld = horizontal(lon),
      pd = horizontal(lat);
    if (ld.length === 1 && pd.length === 1 && ld[0] !== pd[0]) {
      xd = ld[0];
      yd = pd[0];
    } else if (ld.length === 2 && pd.length === 2 && ld.every((d, i) => d === pd[i])) {
      [yd, xd] = ld;
      curvilinear = true;
    } else
      throw bad(
        'longitude/latitude need independent axes or matching [y,x] auxiliary dimensions; select extra time/member dimensions',
      );
  } else if (!lon && !lat && xx && yy && info.gridMapping) {
    if (horizontal(xx).length !== 1 || horizontal(yy).length !== 1)
      throw bad('projected x/y must be one-dimensional after selection');
    xd = horizontal(xx)[0];
    yd = horizontal(yy)[0];
    if (xd === yd) throw bad('projected axes must be independent');
    projection = cfGridProjection(info.gridMapping, { x: xx.units, y: yy.units });
    curvilinear = true;
  } else throw bad('field needs longitude/latitude or projected x/y with grid_mapping');
  const nx = file.dimensions[xd],
    ny = file.dimensions[yd];
  const read = async (variable: NetCDFVariable) => {
    const start = variable.dimensions.map((d) => indices[d] ?? 0),
      count = variable.dimensions.map((d, i) =>
        d === xd || d === yd
          ? variable.shape[i]
          : indices[d] !== undefined || variable.shape[i] === 1
            ? 1
            : (() => {
                throw bad(`select non-horizontal dimension ${d}`);
              })(),
      );
    return { data: await variable.read({ start, count, signal: options.signal }), shape: count };
  };
  let longitude: Float64Array, latitude: Float64Array;
  const degrees = async (c: CFCoordinate) =>
    convertCFUnits((await read(c.variable)).data, c.units || 'degrees', 'degrees');
  if (projection) {
    const x = convertCFUnits((await read(xx!.variable)).data, xx!.units, 'm'),
      y = convertCFUnits((await read(yy!.variable)).data, yy!.units, 'm');
    longitude = new Float64Array(nx * ny);
    latitude = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const p = projection.inverse(x[i], y[j]);
        longitude[j * nx + i] = p?.[0] ?? NaN;
        latitude[j * nx + i] = p?.[1] ?? NaN;
      }
  } else {
    longitude = await degrees(lon!);
    latitude = await degrees(lat!);
  }
  const result = await read(v),
    shape = result.shape,
    xi = v.dimensions.indexOf(xd),
    yi = v.dimensions.indexOf(yd),
    stride = (k: number) => shape.slice(k + 1).reduce((a, b) => a * b, 1),
    xs = stride(xi),
    ys = stride(yi),
    values = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = result.data[j * ys + i * xs];
  const bounds = async (c: CFCoordinate | undefined) => {
    if (!c?.bounds || curvilinear) return undefined;
    const b = c.bounds;
    if (b.dimensions.length !== 2 || b.dimensions[0] !== c.variable.dimensions[0] || b.shape[1] !== 2)
      throw bad('rectilinear coordinate bounds must be [coordinate,2]');
    return convertCFUnits(await b.read({ signal: options.signal }), c.units, 'degrees');
  };
  return Object.freeze({
    nx,
    ny,
    longitude,
    latitude,
    values: options.units
      ? convertCFUnits(values, info.units, options.units, {
          temperatureDifference: cfText(v.attributes, 'units_metadata') === 'temperature: difference',
        })
      : values,
    curvilinear,
    units: options.units ?? info.units,
    longitudeBounds: await bounds(lon),
    latitudeBounds: await bounds(lat),
  });
}
/** Owns the NetCDF lifetime. All payloads remain lazy until read. */
export interface CFDataset {
  readonly file: NetCDFFile;
  field(name: string): CFField;
  read(name: string, options?: CFReadOptions): Promise<CFGrid>;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Opens NetCDF as a lazy CF dataset. Disposal cancels pending and future payload reads. */
export async function openCF(input: FileInput, options: FileOptions = {}): Promise<CFDataset> {
  const file = await openNetCDF(input, options);
  return Object.freeze({
    file,
    field: (name: string) => inspectCFField(file, name),
    read: (name: string, selection?: CFReadOptions) => readCFField(file, name, selection),
    dispose: () => file.dispose(),
    [Symbol.dispose]: () => file.dispose(),
  });
}
