import { LoaderError } from './types.js';
import { toBytes, throwIfAborted, type BinaryInput } from './util.js';
import {
  buildGeo,
  geoLimit,
  GEO,
  ringPolygons,
  type GeoFeature,
  type GeoGeometry,
  type GeoOptions,
  type GeoPosition,
  type GeoResult,
} from './geo-model.js';

/** Shapefile sidecars and vector parse bounds. */
export interface ShapefileOptions extends GeoOptions {
  /** Optional matching dBASE attribute table, in original record order. */
  dbf?: BinaryInput;
  /** Source .prj text. Preserved as the result's CRS; coordinates are never silently reprojected. */
  prj?: string;
  /** dBASE string encoding. Default windows-1252. Pass the .cpg label when available. */
  encoding?: string;
  /** Keep records marked deleted by dBASE. Default false. */
  includeDeleted?: boolean;
}
function dbf(
  input: BinaryInput,
  options: ShapefileOptions,
): { properties: Record<string, unknown>; deleted: boolean }[] {
  const bytes = toBytes(input, GEO),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (bytes.length < 33) throw new LoaderError(GEO, 'truncated', 'dBASE header is incomplete');
  const records = view.getUint32(4, true),
    header = view.getUint16(8, true),
    stride = view.getUint16(10, true);
  if (
    header < 33 ||
    (header - 33) % 32 ||
    header > bytes.length ||
    bytes[header - 1] !== 13 ||
    stride < 1 ||
    header + records * stride > bytes.length
  )
    throw new LoaderError(GEO, 'truncated', 'invalid dBASE header or record lengths');
  if (records > geoLimit(options, 'maxFeatures', 100000)) throw new LoaderError(GEO, 'limit', 'too many dBASE records');
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(options.encoding ?? 'windows-1252');
  } catch {
    throw new LoaderError(GEO, 'unsupported', 'unsupported dBASE encoding; pass a TextDecoder encoding label');
  }
  const fields: { name: string; type: string; length: number; offset: number }[] = [];
  let offset = 1;
  for (let at = 32; at < header - 1; at += 32) {
    const name = decoder.decode(bytes.subarray(at, at + 11)).replace(/\0.*$/, '');
    const type = String.fromCharCode(bytes[at + 11]),
      length = bytes[at + 16];
    if (!name || !length || fields.some((f) => f.name === name))
      throw new LoaderError(GEO, 'syntax', 'invalid or duplicate dBASE field');
    fields.push({ name, type, length, offset });
    offset += length;
  }
  if (offset !== stride) throw new LoaderError(GEO, 'range', 'dBASE field widths do not match record width');
  return Array.from({ length: records }, (_, r) => {
    const start = header + r * stride,
      properties: Record<string, unknown> = Object.create(null);
    if (bytes[start] !== 32 && bytes[start] !== 42)
      throw new LoaderError(GEO, 'syntax', 'invalid dBASE deletion marker');
    for (const field of fields) {
      const at = start + field.offset,
        raw = decoder
          .decode(bytes.subarray(at, at + field.length))
          .replace(/\0+$/, '')
          .trim();
      let value: unknown = raw;
      if (field.type === 'N' || field.type === 'F') {
        if (!raw || /^\*+$/.test(raw)) value = null;
        else {
          const n = Number(raw);
          if (!Number.isFinite(n)) throw new LoaderError(GEO, 'syntax', `invalid dBASE number in ${field.name}`);
          value = Number.isInteger(n) && !Number.isSafeInteger(n) ? raw : n;
        }
      } else if (field.type === 'L') value = /^[YyTt]$/.test(raw) ? true : /^[NnFf]$/.test(raw) ? false : null;
      else if (field.type === 'D')
        value = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : null;
      else if (field.type === 'I' && field.length === 4) value = view.getInt32(at, true);
      else if ((field.type === 'B' || field.type === 'O') && field.length === 8) value = view.getFloat64(at, true);
      properties[field.name] = value;
    }
    return { properties, deleted: bytes[start] === 42 };
  });
}
/** Reads Shapefile points, multipoints, polylines, polygons and multipatches, including Z/M and optional dBASE. */
export function parseShapefile(input: BinaryInput, options: ShapefileOptions = {}): GeoResult {
  throwIfAborted(options.signal, GEO);
  const bytes = toBytes(input, GEO),
    maxBytes = geoLimit(options, 'maxBytes', 256 << 20),
    maxFeatures = geoLimit(options, 'maxFeatures', 100000);
  if (bytes.length > maxBytes) throw new LoaderError(GEO, 'limit', `Shapefile exceeds ${maxBytes} bytes`);
  if (bytes.length < 100) throw new LoaderError(GEO, 'truncated', 'Shapefile header is incomplete');
  const file = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (file.getInt32(0, false) !== 9994 || file.getInt32(28, true) !== 1000)
    throw new LoaderError(GEO, 'header', 'invalid Shapefile identifier or version');
  if (file.getInt32(24, false) * 2 !== bytes.length)
    throw new LoaderError(GEO, 'truncated', 'Shapefile length does not match its header');
  const declared = file.getInt32(32, true),
    rows = options.dbf ? dbf(options.dbf, options) : undefined,
    features: GeoFeature[] = [];
  if (![0, 1, 3, 5, 8, 11, 13, 15, 18, 21, 23, 25, 28, 31].includes(declared))
    throw new LoaderError(GEO, 'unsupported', `unsupported Shapefile shape ${declared}`);
  let at = 100,
    record = 0;
  while (at < bytes.length) {
    if (record >= maxFeatures) throw new LoaderError(GEO, 'limit', `Shapefile records exceed ${maxFeatures}`);
    if (at + 8 > bytes.length) throw new LoaderError(GEO, 'truncated', 'Shapefile record header is incomplete');
    const id = file.getInt32(at, false),
      length = file.getInt32(at + 4, false) * 2;
    at += 8;
    if (id < 1 || length < 4 || at + length > bytes.length)
      throw new LoaderError(GEO, 'truncated', 'invalid Shapefile record length or number');
    const v = new DataView(bytes.buffer, bytes.byteOffset + at, length),
      shape = v.getInt32(0, true);
    if (shape !== 0 && shape !== declared)
      throw new LoaderError(GEO, 'range', 'record shape type differs from file header');
    const need = (end: number): void => {
      if (end > length) throw new LoaderError(GEO, 'truncated', 'Shapefile record ends inside geometry');
    };
    const u32 = (offset: number): number => {
      need(offset + 4);
      return v.getUint32(offset, true);
    };
    const double = (offset: number): number => {
      need(offset + 8);
      const n = v.getFloat64(offset, true);
      if (!Number.isFinite(n)) throw new LoaderError(GEO, 'range', 'Shapefile coordinates must be finite');
      return n;
    };
    let geometry: GeoGeometry | null = null;
    if ([1, 11, 21].includes(shape)) {
      const p = [double(4), double(12)];
      let end = 20;
      if (shape === 11) {
        p.push(double(end));
        end += 8;
      }
      if (shape === 21 || (shape === 11 && length >= end + 8)) {
        if (p.length === 2) p.push(0);
        p.push(double(end));
        end += 8;
      }
      if (end !== length) throw new LoaderError(GEO, 'syntax', 'Shapefile point has trailing data');
      geometry = { type: 'Point', coordinates: p };
    } else if ([3, 5, 8, 13, 15, 18, 23, 25, 28, 31].includes(shape)) {
      need(40);
      const multi = [8, 18, 28].includes(shape),
        parts = multi ? 0 : u32(36),
        n = u32(multi ? 36 : 40);
      if (n > (options.maxVertices ?? 8000000) || parts > n)
        throw new LoaderError(GEO, 'limit', 'Shapefile point/part count exceeds bounds');
      let cursor = multi ? 40 : 44;
      const starts: number[] = [];
      for (let p = 0; p < parts; p++) {
        const index = u32(cursor);
        cursor += 4;
        if (index >= n || (p === 0 && index !== 0) || (p > 0 && index <= starts[p - 1]))
          throw new LoaderError(GEO, 'range', 'invalid Shapefile part offsets');
        starts.push(index);
      }
      if (!multi && !parts && n) throw new LoaderError(GEO, 'range', 'nonempty Shapefile needs parts');
      const patchTypes: number[] = [];
      if (shape === 31)
        for (let p = 0; p < parts; p++) {
          patchTypes.push(u32(cursor));
          cursor += 4;
        }
      need(cursor + n * 16);
      const coords: GeoPosition[] = Array.from({ length: n }, (_, i) => [
        double(cursor + i * 16),
        double(cursor + i * 16 + 8),
      ]);
      cursor += n * 16;
      if ([13, 15, 18, 31].includes(shape)) {
        need(cursor + 16 + n * 8);
        cursor += 16;
        for (let i = 0; i < n; i++) coords[i].push(double(cursor + i * 8));
        cursor += n * 8;
      }
      if ([13, 15, 18, 23, 25, 28, 31].includes(shape) && cursor < length) {
        need(cursor + 16 + n * 8);
        cursor += 16;
        for (let i = 0; i < n; i++) {
          if (coords[i].length === 2) coords[i].push(0);
          coords[i].push(double(cursor + i * 8));
        }
        cursor += n * 8;
      }
      if (cursor !== length) throw new LoaderError(GEO, 'syntax', 'Shapefile record has trailing geometry data');
      if (multi) geometry = { type: 'MultiPoint', coordinates: coords };
      else {
        const pieces = starts.map((start, p) => coords.slice(start, starts[p + 1] ?? n));
        if ([3, 13, 23].includes(shape)) geometry = { type: 'MultiLineString', coordinates: pieces };
        else if (shape === 31) {
          const polygons: GeoPosition[][][] = [],
            rings: GeoPosition[][] = [];
          for (let p = 0; p < pieces.length; p++) {
            const patch = pieces[p],
              kind = patchTypes[p];
            if (kind === 0 || kind === 1) {
              if (patch.length < 3)
                throw new LoaderError(GEO, 'range', 'multipatch strips/fans need at least three points');
              for (let i = 2; i < patch.length; i++) {
                const tri =
                  kind === 1
                    ? [patch[0], patch[i - 1], patch[i]]
                    : i % 2
                      ? [patch[i - 1], patch[i - 2], patch[i]]
                      : [patch[i - 2], patch[i - 1], patch[i]];
                polygons.push([[...tri, tri[0]]]);
              }
            } else if (kind >= 2 && kind <= 5) rings.push(patch);
            else throw new LoaderError(GEO, 'unsupported', `unknown multipatch part type ${kind}`);
          }
          polygons.push(...ringPolygons(rings));
          geometry = { type: 'MultiPolygon', coordinates: polygons };
        } else geometry = { type: 'MultiPolygon', coordinates: ringPolygons(pieces) };
      }
    } else if (shape !== 0) throw new LoaderError(GEO, 'unsupported', `unsupported Shapefile shape ${shape}`);
    if (!rows?.[record]?.deleted || options.includeDeleted) {
      const properties = rows?.[record]?.properties ?? Object.create(null);
      if (rows?.[record]?.deleted) properties.deleted = true;
      features.push({ type: 'Feature', id, properties, geometry });
    }
    record++;
    at += length;
  }
  if (rows && rows.length !== record) throw new LoaderError(GEO, 'range', 'dBASE record count differs from Shapefile');
  return buildGeo(features, options, options.prj ?? 'unspecified');
}
