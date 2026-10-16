import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
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

export interface OFFOptions extends ParseLimits {}

/**
 * Parses an ASCII Object File Format mesh (`OFF`, with optional `ST`, `C` and `N` prefixes for texture
 * coordinates, vertex colors and normals). Polygons are fan-triangulated. Per-face colors are ignored.
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
  if (fields[1] === 'BINARY') throw new LoaderError(F, 'unsupported', 'binary OFF is not supported');
  const hasUV = !!match[1],
    hasColor = !!match[2],
    hasNormal = !!match[3];
  fields = fields.length > 1 ? fields.slice(1) : next();
  if (!fields || fields.length < 2) throw new LoaderError(F, 'header', 'missing vertex and face counts');
  const vertexCount = checkCount(Number(fields[0]), limit.maxVertices, F, 'vertex');
  const faceCount = checkCount(Number(fields[1]), limit.maxTriangles, F, 'face');
  const minimum = 3 + (hasNormal ? 3 : 0) + (hasColor ? 3 : 0) + (hasUV ? 2 : 0);
  // Budget before allocation: every value takes a digit and a separator, so a short file cannot claim millions.
  if (vertexCount * minimum * 2 + faceCount * 2 - 1 > scanner.text.length - scanner.pos)
    throw new LoaderError(F, 'truncated', 'file is too short for the declared vertex and face counts');

  const positions = new Float32Array(vertexCount * 3);
  const normals = hasNormal ? new Float32Array(vertexCount * 3) : undefined;
  const colors = hasColor ? new Float32Array(vertexCount * 3) : undefined;
  const uvs = hasUV ? new Float32Array(vertexCount * 2) : undefined;
  for (let i = 0; i < vertexCount; i++) {
    const line = next();
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
  let face: string[] = [];
  const at = (corner: number): number => Number(face[corner + 1]);
  for (let i = 0; i < faceCount; i++) {
    const line = next();
    if (!line) throw new LoaderError(F, 'truncated', `file ends after ${i} of ${faceCount} faces`);
    const count = Number(line[0]);
    if (!Number.isSafeInteger(count) || count < 0 || line.length < count + 1)
      throw new LoaderError(F, 'syntax', `face ${i} on line ${lineNumber} is malformed`);
    face = line;
    triangulate(indices, count, at, vertexCount, F, limit.maxTriangles);
  }
  const result: LoadedGeometry = { kind: indices.length ? 'mesh' : 'points', positions };
  if (normals) result.normals = normals;
  if (colors) result.colors = colors;
  if (uvs) result.uvs = uvs;
  if (indices.length) result.indices = indices.result();
  return result;
}
