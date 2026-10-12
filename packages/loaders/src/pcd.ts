import {LoaderError, type LoadedGeometry, type ParseLimits} from './types.js';
import {checkCount, latin1, limits, splitFields, TextScanner, toBytes, type BinaryInput} from './util.js';
import {decompressLZF} from './lzf.js';

const F = 'PCD';
const MAX_HEADER = 1 << 16;

export interface PCDField {name: string; size: number; type: 'I' | 'U' | 'F'; count: number; offset: number}
export interface PCDHeader {
  version: string; fields: PCDField[]; width: number; height: number; points: number;
  viewpoint: number[]; data: 'ascii' | 'binary' | 'binary_compressed'; rowSize: number; bodyOffset: number;
}
export interface PCDOptions extends ParseLimits {
  /** Keep points whose x, y or z is NaN or infinite (organized clouds mark holes that way). Default false. */
  keepInvalid?: boolean;
}

/** Parses only the PCD header. */
export function parsePCDHeader(input: BinaryInput, options: ParseLimits = {}): PCDHeader {
  const bytes = toBytes(input, F), limit = limits(options, F);
  const text = latin1(bytes, 0, Math.min(bytes.length, MAX_HEADER));
  const scanner = new TextScanner(text, F);
  const values: Record<string, string[]> = {};
  let data: string | undefined;
  for (let line = scanner.line(); line !== null; line = scanner.line()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = splitFields(trimmed);
    const upper = key.toUpperCase();
    if (upper === 'DATA') {data = rest[0]; break;}
    if (!['VERSION', 'FIELDS', 'COLUMNS', 'SIZE', 'TYPE', 'COUNT', 'WIDTH', 'HEIGHT', 'VIEWPOINT', 'POINTS'].includes(upper)) throw new LoaderError(F, 'header', `unknown header key "${key.slice(0, 32)}"`);
    values[upper === 'COLUMNS' ? 'FIELDS' : upper] = rest;
  }
  if (data === undefined) throw new LoaderError(F, bytes.length >= MAX_HEADER ? 'header' : 'truncated', 'DATA line not found');
  if (data !== 'ascii' && data !== 'binary' && data !== 'binary_compressed') throw new LoaderError(F, 'unsupported', `unknown DATA type "${String(data).slice(0, 32)}"`);
  const names = values.FIELDS;
  if (!names?.length) throw new LoaderError(F, 'header', 'missing FIELDS');
  const sizes = values.SIZE?.map(Number), types = values.TYPE, counts = values.COUNT?.map(Number) ?? names.map(() => 1);
  if (!sizes || sizes.length !== names.length || !types || types.length !== names.length || counts.length !== names.length) throw new LoaderError(F, 'header', 'FIELDS, SIZE, TYPE and COUNT must have the same length');
  const fields: PCDField[] = [];
  let rowSize = 0;
  names.forEach((name, i) => {
    const size = sizes[i], type = types[i].toUpperCase(), count = counts[i];
    if (![1, 2, 4, 8].includes(size)) throw new LoaderError(F, 'header', `invalid SIZE ${size} for ${name}`);
    if (type !== 'I' && type !== 'U' && type !== 'F') throw new LoaderError(F, 'header', `invalid TYPE ${type} for ${name}`);
    if (type === 'F' && size !== 4 && size !== 8) throw new LoaderError(F, 'header', `float field ${name} must be 4 or 8 bytes`);
    if (!Number.isSafeInteger(count) || count < 1 || count > 4096) throw new LoaderError(F, 'header', `invalid COUNT ${count} for ${name}`);
    fields.push({name, size, type, count, offset: rowSize});
    rowSize += size * count;
  });
  const width = Number(values.WIDTH?.[0] ?? NaN), height = Number(values.HEIGHT?.[0] ?? 1);
  if (!Number.isSafeInteger(width) || width < 0 || !Number.isSafeInteger(height) || height < 0) throw new LoaderError(F, 'header', 'invalid WIDTH or HEIGHT');
  const points = checkCount(values.POINTS ? Number(values.POINTS[0]) : width * height, limit.maxVertices, F, 'point');
  if (values.POINTS && width * height !== points) throw new LoaderError(F, 'header', `WIDTH x HEIGHT (${width * height}) does not match POINTS (${points})`);
  const viewpoint = values.VIEWPOINT?.map(Number) ?? [0, 0, 0, 1, 0, 0, 0];
  return {version: values.VERSION?.[0] ?? '', fields, width, height, points, viewpoint, data, rowSize, bodyOffset: scanner.pos};
}

type Read = (view: DataView, offset: number) => number;
function reader(field: PCDField): Read {
  if (field.type === 'F') return field.size === 4 ? (v, o) => v.getFloat32(o, true) : (v, o) => v.getFloat64(o, true);
  const signed = field.type === 'I';
  switch (field.size) {
    case 1: return signed ? (v, o) => v.getInt8(o) : (v, o) => v.getUint8(o);
    case 2: return signed ? (v, o) => v.getInt16(o, true) : (v, o) => v.getUint16(o, true);
    case 4: return signed ? (v, o) => v.getInt32(o, true) : (v, o) => v.getUint32(o, true);
    default: return signed ? (v, o) => Number(v.getBigInt64(o, true)) : (v, o) => Number(v.getBigUint64(o, true));
  }
}

/**
 * Parses a PCD point cloud with `DATA ascii`, `binary` or `binary_compressed` (LZF). Replaces Three.js `PCDLoader`.
 * Reads x/y/z, normal_x/y/z, packed rgb or rgba, and intensity (as `attributes.intensity`).
 */
export function parsePCD(input: BinaryInput, options: PCDOptions = {}): LoadedGeometry {
  const bytes = toBytes(input, F), header = parsePCDHeader(bytes, options), count = header.points;
  const field = (name: string): PCDField | undefined => header.fields.find(f => f.name === name);
  const x = field('x'), y = field('y'), z = field('z');
  if (!x || !y || !z) throw new LoaderError(F, 'header', 'fields x, y and z are required');
  const nx = field('normal_x'), ny = field('normal_y'), nz = field('normal_z'), rgb = field('rgb') ?? field('rgba'), intensity = field('intensity');
  const hasNormals = !!(nx && ny && nz);
  if (rgb && rgb.size !== 4) throw new LoaderError(F, 'header', 'rgb field must be 4 bytes');
  const positions = new Float32Array(count * 3);
  const normals = hasNormals ? new Float32Array(count * 3) : undefined;
  const colors = rgb ? new Float32Array(count * 3) : undefined;
  const intensities = intensity ? new Float32Array(count) : undefined;
  const bits = new DataView(new ArrayBuffer(4));
  const setColor = (i: number, packed: number): void => {
    colors![i * 3] = (packed >>> 16 & 255) / 255; colors![i * 3 + 1] = (packed >>> 8 & 255) / 255; colors![i * 3 + 2] = (packed & 255) / 255;
  };
  if (header.data === 'ascii') {
    // Token position of each field's first value in a row.
    let column = 0;
    const columns = new Map<PCDField, number>();
    for (const f of header.fields) {columns.set(f, column); column += f.count;}
    const scanner = new TextScanner(latin1(bytes, header.bodyOffset), F);
    let i = 0, lineNumber = 0;
    for (let line = scanner.line(); line !== null && i < count; line = scanner.line()) {
      lineNumber++;
      const tokens = splitFields(line);
      if (!tokens.length) continue;
      if (tokens.length < column) throw new LoaderError(F, 'syntax', `data line ${lineNumber} has ${tokens.length} values, expected ${column}`);
      const value = (f: PCDField): number => {
        const token = tokens[columns.get(f)!], parsed = Number(token);
        if (Number.isNaN(parsed) && !/^[+-]?nan$/i.test(token)) throw new LoaderError(F, 'syntax', `invalid number "${token.slice(0, 32)}" on data line ${lineNumber}`);
        return parsed;
      };
      positions[i * 3] = value(x); positions[i * 3 + 1] = value(y); positions[i * 3 + 2] = value(z);
      if (normals) {normals[i * 3] = value(nx!); normals[i * 3 + 1] = value(ny!); normals[i * 3 + 2] = value(nz!);}
      if (rgb) {
        const raw = value(rgb);
        if (rgb.type === 'F') {bits.setFloat32(0, raw, true); setColor(i, bits.getUint32(0, true));}
        else setColor(i, raw >>> 0);
      }
      if (intensities) intensities[i] = value(intensity!);
      i++;
    }
    if (i < count) throw new LoaderError(F, 'truncated', `file ends after ${i} of ${count} points`);
  } else {
    let body: Uint8Array;
    // Byte offset of each field's first value for point i: binary is row-major, binary_compressed is column-major.
    let locate: (f: PCDField, i: number) => number;
    if (header.data === 'binary') {
      if (header.bodyOffset + count * header.rowSize > bytes.length) throw new LoaderError(F, 'truncated', `binary data needs ${count * header.rowSize} bytes, file has ${bytes.length - header.bodyOffset}`);
      body = bytes.subarray(header.bodyOffset);
      locate = (f, i) => i * header.rowSize + f.offset;
    } else {
      if (header.bodyOffset + 8 > bytes.length) throw new LoaderError(F, 'truncated', 'missing compressed size words');
      const sizes = new DataView(bytes.buffer, bytes.byteOffset + header.bodyOffset, 8);
      const compressed = sizes.getUint32(0, true), uncompressed = sizes.getUint32(4, true);
      if (uncompressed !== count * header.rowSize) throw new LoaderError(F, 'header', `uncompressed size ${uncompressed} does not match ${count} points of ${header.rowSize} bytes`);
      if (header.bodyOffset + 8 + compressed > bytes.length) throw new LoaderError(F, 'truncated', `compressed data needs ${compressed} bytes, file has ${bytes.length - header.bodyOffset - 8}`);
      body = decompressLZF(bytes.subarray(header.bodyOffset + 8, header.bodyOffset + 8 + compressed), uncompressed, F);
      const starts = new Map<PCDField, number>();
      let start = 0;
      for (const f of header.fields) {starts.set(f, start); start += f.size * f.count * count;}
      locate = (f, i) => starts.get(f)! + i * f.size * f.count;
    }
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const rx = reader(x), ry = reader(y), rz = reader(z);
    const rn = hasNormals ? [reader(nx!), reader(ny!), reader(nz!)] : [];
    const ri = intensity ? reader(intensity) : undefined;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = rx(view, locate(x, i)); positions[i * 3 + 1] = ry(view, locate(y, i)); positions[i * 3 + 2] = rz(view, locate(z, i));
      if (normals) {normals[i * 3] = rn[0](view, locate(nx!, i)); normals[i * 3 + 1] = rn[1](view, locate(ny!, i)); normals[i * 3 + 2] = rn[2](view, locate(nz!, i));}
      if (rgb) setColor(i, view.getUint32(locate(rgb, i), true));
      if (intensities) intensities[i] = ri!(view, locate(intensity!, i));
    }
  }
  let kept = count;
  if (!options.keepInvalid) {
    kept = 0;
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(positions[i * 3]) || !Number.isFinite(positions[i * 3 + 1]) || !Number.isFinite(positions[i * 3 + 2])) continue;
      if (kept !== i) {
        positions.copyWithin(kept * 3, i * 3, i * 3 + 3);
        normals?.copyWithin(kept * 3, i * 3, i * 3 + 3);
        colors?.copyWithin(kept * 3, i * 3, i * 3 + 3);
        if (intensities) intensities[kept] = intensities[i];
      }
      kept++;
    }
  }
  const trim = (array: Float32Array, size: number): Float32Array => kept === count ? array : array.slice(0, kept * size);
  const result: LoadedGeometry = {kind: 'points', positions: trim(positions, 3)};
  if (normals) result.normals = trim(normals, 3);
  if (colors) result.colors = trim(colors, 3);
  if (intensities) result.attributes = {intensity: trim(intensities, 1)};
  return result;
}
