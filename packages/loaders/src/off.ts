import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import {
  checkCount,
  latin1,
  limits,
  normalizeColors,
  parseNumber,
  splitFields,
  TextScanner,
  toBytes,
  triangulate,
  uints,
  type BinaryInput,
} from './util.js';

const F = 'OFF';

/** Options of parseOFF: the shared size limits (ParseLimits). */
export interface OFFOptions extends ParseLimits {}

/**
 * Parses ASCII or big-endian binary OFF with optional ST/C/N vertex attributes.
 * Polygons are fan-triangulated; groups preserve each source face's color or colormap index.
 */
export function parseOFF(input: BinaryInput, options: OFFOptions = {}): LoadedGeometry {
  const bytes = toBytes(input, F),
    limit = limits(options, F);
  const scanner = new TextScanner(latin1(bytes), F);
  let lineNumber = 0;
  const next = (): string[] | null => {
    for (;;) {
      const line = scanner.line();
      if (line === null) return null;
      lineNumber++;
      const hash = line.indexOf('#'),
        fields = splitFields(hash >= 0 ? line.slice(0, hash) : line);
      if (fields.length) return fields;
    }
  };
  let fields = next();
  const keyword = fields?.[0] ?? '';
  const match = /^(ST)?(C)?(N)?(4)?(n)?OFF$/.exec(keyword);
  if (!fields || !match) throw new LoaderError(F, 'header', `missing OFF keyword (found "${keyword.slice(0, 16)}")`);
  if (match[4] || match[5]) throw new LoaderError(F, 'unsupported', `${keyword} (non-3D vertices) is not supported`);
  const binary = fields[1] === 'BINARY';
  let offset = scanner.pos;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (integer = false): number => {
    if (offset + 4 > bytes.length) throw new LoaderError(F, 'truncated', 'binary OFF ends inside a value');
    const value = integer ? view.getInt32(offset, false) : view.getFloat32(offset, false);
    offset += 4;
    if (!Number.isFinite(value)) throw new LoaderError(F, 'range', 'binary OFF values must be finite');
    return value;
  };
  const hasUV = !!match[1],
    hasColor = !!match[2],
    hasNormal = !!match[3];
  fields = binary ? [word(true), word(true), word(true)].map(String) : fields.length > 1 ? fields.slice(1) : next();
  if (!fields || fields.length < 2) throw new LoaderError(F, 'header', 'missing vertex and face counts');
  const vertexCount = checkCount(Number(fields[0]), limit.maxVertices, F, 'vertex');
  const faceCount = checkCount(Number(fields[1]), limit.maxTriangles, F, 'face');
  const minimum = 3 + (hasNormal ? 3 : 0) + (hasColor ? 3 : 0) + (hasUV ? 2 : 0);
  // Budget before allocation: every value takes a digit and a separator, so a short file cannot claim millions.
  const required = binary
    ? vertexCount * (minimum + (hasColor ? 1 : 0)) * 4 + faceCount * 8
    : vertexCount * minimum * 2 + faceCount * 2 - 1;
  if (required > bytes.length - (binary ? offset : scanner.pos))
    throw new LoaderError(F, 'truncated', 'file is too short for the declared vertex and face counts');

  const positions = new Float32Array(vertexCount * 3);
  const normals = hasNormal ? new Float32Array(vertexCount * 3) : undefined;
  const colors = hasColor ? new Float32Array(vertexCount * 3) : undefined;
  const uvs = hasUV ? new Float32Array(vertexCount * 2) : undefined;
  for (let i = 0; i < vertexCount; i++) {
    const line = binary ? Array.from({ length: minimum + (hasColor ? 1 : 0) }, () => String(word())) : next();
    if (!line) throw new LoaderError(F, 'truncated', `file ends after ${i} of ${vertexCount} vertices`);
    if (line.length < minimum)
      throw new LoaderError(
        F,
        'syntax',
        `vertex ${i} on line ${lineNumber} has ${line.length} values, expected at least ${minimum}`,
      );
    const where = `on line ${lineNumber}`;
    let k = 0;
    for (let a = 0; a < 3; a++) positions[i * 3 + a] = parseNumber(line[k++], F, where);
    if (normals) for (let a = 0; a < 3; a++) normals[i * 3 + a] = parseNumber(line[k++], F, where);
    if (colors) {
      // Colors take 3 or 4 values (RGB or RGBA); texture coordinates are always the last two.
      const colorValues = hasUV ? line.length - k - 2 : line.length - k;
      if (colorValues < 3)
        throw new LoaderError(F, 'syntax', `vertex ${i} on line ${lineNumber} is missing color values`);
      for (let a = 0; a < 3; a++) colors[i * 3 + a] = parseNumber(line[k + a], F, where);
      k += Math.min(colorValues, 4);
    }
    if (uvs) {
      uvs[i * 2] = parseNumber(line[line.length - 2], F, where);
      uvs[i * 2 + 1] = parseNumber(line[line.length - 1], F, where);
    }
  }
  if (colors) normalizeColors(colors);
  const indices = uints(faceCount * 3);
  const groups: LoadedGroup[] = [];
  let face: string[] = [];
  const at = (corner: number): number => Number(face[corner + 1]);
  for (let i = 0; i < faceCount; i++) {
    let line: string[] | null;
    if (binary) {
      const corners = word(true);
      checkCount(corners, 65536, F, 'face corner');
      if ((corners + 1) * 4 > bytes.length - offset)
        throw new LoaderError(F, 'truncated', 'binary OFF ends inside a face');
      line = [String(corners), ...Array.from({ length: corners }, () => String(word(true)))];
      const components = word(true);
      if (![0, 1, 3, 4].includes(components))
        throw new LoaderError(F, 'syntax', 'OFF face needs 0, 1, 3 or 4 color components');
      for (let c = 0; c < components; c++) line.push(String(word()));
    } else line = next();
    if (!line) throw new LoaderError(F, 'truncated', `file ends after ${i} of ${faceCount} faces`);
    const count = Number(line[0]);
    if (!Number.isSafeInteger(count) || count < 0 || line.length < count + 1)
      throw new LoaderError(F, 'syntax', `face ${i} on line ${lineNumber} is malformed`);
    face = line;
    const start = indices.length;
    triangulate(indices, count, at, vertexCount, F, limit.maxTriangles);
    const values = line.slice(count + 1).map((v) => parseNumber(v, F, `in face ${i}`));
    if (![0, 1, 3, 4].includes(values.length) || values.some((v) => !Number.isFinite(v) || v < 0))
      throw new LoaderError(F, 'syntax', `invalid color in face ${i}`);
    const group: LoadedGroup = { start, count: indices.length - start };
    if (values.length === 1) {
      if (!Number.isSafeInteger(values[0])) throw new LoaderError(F, 'range', 'OFF colormap index must be an integer');
      group.properties = { colorIndex: values[0] };
    } else if (values.length) {
      const scale = !binary && values.some((v) => v > 1) ? 255 : 1;
      if (values.some((v) => v > scale)) throw new LoaderError(F, 'range', `face ${i} color is out of range`);
      group.color = [
        values[0] / scale,
        values[1] / scale,
        values[2] / scale,
        values.length === 4 ? values[3] / scale : 1,
      ];
    }
    groups.push(group);
  }
  const result: LoadedGeometry = { kind: indices.length ? 'mesh' : 'points', positions };
  if (normals) result.normals = normals;
  if (colors) result.colors = colors;
  if (uvs) result.uvs = uvs;
  if (indices.length) result.indices = indices.result();
  if (groups.length) {
    if (groups.some((g) => g.color))
      for (const group of groups) if (!group.color && !group.properties) group.color = [0.666, 0.666, 0.666, 0.666];
    result.groups = groups;
  }
  return result;
}
