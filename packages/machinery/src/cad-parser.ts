import { Geometry } from '@margoengine/core';
import { triangulatePolygon } from '../../shared/polygon.js';
import { checkCount, countLimit } from '../../shared/limits.js';
export const maxBytes = 64 * 1024 * 1024,
  maxVertices = 1_000_000,
  maxIndices = 3_000_000;
/** FNV-style mix of the six rounded weld values stored at `offset`. */
function weldHash(keys: number[], offset: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < 6; i++) h = Math.imul(h ^ (keys[offset + i] | 0), 0x01000193);
  return h ^ (h >>> 15);
}
function flat(positions: number[], progress?: (value: number) => void): Geometry {
  if (
    !positions.length ||
    positions.length / 3 > maxIndices ||
    positions.length % 9 ||
    !positions.every((v) => Number.isFinite(Math.fround(v)))
  )
    throw new RangeError('CAD requires bounded finite triangles');
  // Welding keys are six values rounded to 1e-5, kept as numbers (six per unique vertex) behind an open-addressed table of vertex ids.
  const packed: number[] = [],
    normals: number[] = [],
    indices: number[] = [],
    keys: number[] = [];
  let table = new Int32Array(1024).fill(-1);
  for (let i = 0; i < positions.length; i += 9) {
    const ux = positions[i + 3] - positions[i],
      uy = positions[i + 4] - positions[i + 1],
      uz = positions[i + 5] - positions[i + 2],
      vx = positions[i + 6] - positions[i],
      vy = positions[i + 7] - positions[i + 1],
      vz = positions[i + 8] - positions[i + 2],
      cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx,
      length = Math.hypot(cx, cy, cz);
    if (!length) throw new RangeError('Degenerate CAD triangle');
    const nx = cx / length,
      ny = cy / length,
      nz = cz / length,
      r3 = Math.round(nx * 100_000),
      r4 = Math.round(ny * 100_000),
      r5 = Math.round(nz * 100_000);
    for (let o = i; o < i + 9; o += 3) {
      const x = positions[o],
        y = positions[o + 1],
        z = positions[o + 2],
        at = keys.length;
      keys.push(Math.round(x * 100_000), Math.round(y * 100_000), Math.round(z * 100_000), r3, r4, r5);
      let slot = weldHash(keys, at) & (table.length - 1),
        id = table[slot];
      while (id !== -1) {
        const k = id * 6;
        if (
          keys[k] === keys[at] &&
          keys[k + 1] === keys[at + 1] &&
          keys[k + 2] === keys[at + 2] &&
          keys[k + 3] === r3 &&
          keys[k + 4] === r4 &&
          keys[k + 5] === r5
        )
          break;
        slot = (slot + 1) & (table.length - 1);
        id = table[slot];
      }
      if (id !== -1) keys.length = at;
      else {
        id = packed.length / 3;
        if (id >= maxVertices) throw new RangeError('CAD unique vertex limit');
        table[slot] = id;
        packed.push(x, y, z);
        normals.push(nx, ny, nz);
        // Keep the table under half full; rebuilding re-inserts every vertex id from its stored key.
        if ((id + 1) * 2 > table.length) {
          table = new Int32Array(table.length * 4).fill(-1);
          for (let v = 0; v <= id; v++) {
            let s = weldHash(keys, v * 6) & (table.length - 1);
            while (table[s] !== -1) s = (s + 1) & (table.length - 1);
            table[s] = v;
          }
        }
      }
      indices.push(id);
    }
    if (i % 90_000 === 0) progress?.(0.5 + (0.5 * i) / positions.length);
    const a = indices[indices.length - 3],
      b = indices[indices.length - 2],
      c = indices[indices.length - 1];
    if (a === b || b === c || a === c) throw new RangeError('Triangle collapses at CAD welding tolerance');
  }
  // Core uses uint32 indices consistently across both GPU backends.
  return new Geometry(packed, normals, indices);
}
/** Strict UTF-8 text, or a named error instead of TextDecoder's own TypeError. */
function utf8(data: Uint8Array, format: string): string {
  try {
    return new TextDecoder('utf8', { fatal: true }).decode(data);
  } catch {
    throw new TypeError(`Invalid ${format}: not UTF-8 text`);
  }
}
function stl(
  input: string | Uint8Array,
  progress?: (value: number) => void,
): Array<{ name: string; geometry: Geometry }> {
  const positions: number[] = [];
  if (input instanceof Uint8Array && input.length >= 84) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength),
      count = view.getUint32(80, true);
    if (84 + count * 50 === input.length) {
      if (count * 3 > maxIndices || !count) throw new RangeError('STL triangle limit');
      for (let face = 0; face < count; face++) {
        for (let i = 0; i < 9; i++) positions.push(view.getFloat32(84 + face * 50 + 12 + i * 4, true));
        if (face % 10_000 === 0) progress?.((0.5 * face) / count);
      }
      return [{ name: 'STL body', geometry: flat(positions, progress) }];
    }
  }
  const text = typeof input === 'string' ? input : utf8(input, 'STL');
  if (!/^\s*solid\b/.test(text) || !/\bendsolid\b/.test(text)) throw new TypeError('Invalid STL');
  const number = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?',
    vertex = new RegExp(`vertex\\s+(${number})\\s+(${number})\\s+(${number})`, 'g');
  // Same facets as /facet\s+normal[\s\S]*?endfacet/g, in linear time: that regex rescans to the end of the text for
  // every unterminated `facet normal` (quadratic, minutes on a hostile 64 MiB file).
  const facets: string[] = [],
    start = /facet\s+normal/g;
  for (let match; (match = start.exec(text)); ) {
    const end = text.indexOf('endfacet', start.lastIndex);
    if (end < 0) break;
    facets.push(text.slice(match.index, end + 8));
    start.lastIndex = end + 8;
  }
  if (facets.length * 3 > maxIndices || !facets.length) throw new RangeError('STL triangle limit');
  let face = 0;
  for (const facet of facets) {
    if (face++ % 10_000 === 0) progress?.((0.5 * face) / facets.length);
    const matches = [...facet.matchAll(vertex)];
    if (matches.length !== 3 || !/outer\s+loop/.test(facet) || !/endloop/.test(facet))
      throw new TypeError('Invalid STL facet');
    for (const match of matches) positions.push(...match.slice(1).map(Number));
  }
  return [{ name: text.match(/solid\s+([^\r\n]*)/)?.[1] || 'STL body', geometry: flat(positions, progress) }];
}
function obj(
  text: string,
  progress?: (value: number) => void,
  maxParts?: number,
): Array<{ name: string; geometry: Geometry }> {
  const partLimit = countLimit('maxParts', maxParts);
  const vertices: number[][] = [],
    parts: Array<{ name: string; positions: number[] }> = [{ name: 'OBJ body', positions: [] }],
    workCounter = { used: 0, limit: 10_000_000 };
  let current = parts[0],
    total = 0;
  const lines = text.split(/\r?\n/);
  let lineNumber = 0;
  for (const raw of lines) {
    if (lineNumber++ % 10_000 === 0) progress?.((0.5 * lineNumber) / lines.length);
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [tag, ...fields] = line.split(/\s+/);
    if (tag === 'v') {
      const p = fields.map(Number);
      if (p.length !== 3 || !p.every((v) => Number.isFinite(Math.fround(v))) || vertices.length >= maxVertices)
        throw new RangeError('Invalid OBJ vertex');
      vertices.push(p);
    } else if (tag === 'o' || tag === 'g') {
      checkCount('OBJ part limit', parts.length + 1, partLimit, 'maxParts');
      current = { name: fields.join(' ') || 'OBJ body', positions: [] };
      parts.push(current);
    } else if (tag === 'f') {
      if (fields.length < 3 || fields.length > 4096) throw new RangeError('OBJ face vertex limit');
      const face = fields.map((field) => {
        if (!/^-?\d+(?:\/(?:-?\d*)?(?:\/-?\d+)?)?$/.test(field)) throw new TypeError('Invalid OBJ face');
        const index = Number(field.split('/')[0]),
          point = vertices[index > 0 ? index - 1 : vertices.length + index];
        if (!index || !point) throw new RangeError('OBJ index exceeds vertices');
        return point;
      });
      const a = face[0],
        b = face[1],
        c = face[2],
        normal = [
          (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
          (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
          (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        ],
        length = Math.hypot(...normal);
      if (!length) throw new RangeError('Degenerate OBJ face');
      const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))),
        u = (axis + 1) % 3,
        v = (axis + 2) % 3;
      if (face.some((p) => Math.abs(normal.reduce((sum, n, i) => sum + n * (p[i] - a[i]), 0)) / length > 1e-5))
        throw new RangeError('Nonplanar OBJ face');
      const result = triangulatePolygon(
        face.map((p) => [p[u], p[v]]),
        [],
        { maxVertices, workCounter },
      );
      for (let i = 0; i < result.indices.length; i += 3) {
        const triangle = result.indices.slice(i, i + 3);
        if (normal[axis] < 0) triangle.reverse();
        for (const index of triangle) {
          const p = [0, 0, 0];
          p[u] = result.positions[index * 2];
          p[v] = result.positions[index * 2 + 1];
          p[axis] = a[axis] - (normal[u] * (p[u] - a[u]) + normal[v] * (p[v] - a[v])) / normal[axis];
          current.positions.push(...p);
          if (++total > maxIndices) throw new RangeError('OBJ triangle limit');
        }
      }
    } else if (!['vn', 'vt', 's', 'usemtl', 'mtllib'].includes(tag))
      throw new TypeError(`Unsupported OBJ record ${tag.slice(0, 32)}`);
  }
  return parts
    .filter((part) => part.positions.length)
    .map((part) => ({ name: part.name, geometry: flat(part.positions) }));
}

/** `maxParts`: most OBJ objects and groups (default 100,000; up to core's 8,388,608 entities). */
export function parseCADGeometry(
  input: string | ArrayBuffer | ArrayBufferView,
  format: 'stl' | 'obj',
  progress?: (value: number) => void,
  maxParts?: number,
): Array<{ name: string; geometry: Geometry }> {
  countLimit('maxParts', maxParts);
  if (!['stl', 'obj'].includes(format)) throw new TypeError('CAD supports STL and OBJ');
  const data =
    typeof input === 'string'
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if ((typeof data === 'string' ? new TextEncoder().encode(data).length : data.length) > maxBytes)
    throw new RangeError('CAD exceeds 64 MiB');
  const definitions =
    format === 'stl'
      ? stl(data, progress)
      : obj(typeof data === 'string' ? data : utf8(data, 'OBJ'), progress, maxParts);
  if (!definitions.length) throw new Error('CAD contains no geometry');
  return definitions;
}

export function fingerprint(geometry: Pick<Geometry, 'vertices' | 'indices'>): Float32Array {
  if (geometry.indices.length > maxIndices) throw new RangeError('Deduplication triangle limit');
  const data = new Float32Array(geometry.indices.length * 6),
    order: number[] = [];
  const indices = geometry.indices,
    vertices = geometry.vertices;
  for (let face = 0; face < indices.length; face += 3) {
    let start = 0;
    for (let i = 1; i < 3; i++) {
      const candidate = indices[face + i] * 6,
        lowest = indices[face + start] * 6;
      for (let j = 0; j < 6; j++) {
        const difference = vertices[candidate + j] - vertices[lowest + j];
        if (difference < 0) {
          start = i;
          break;
        }
        if (difference > 0) break;
      }
    }
    for (let i = 0; i < 3; i++) {
      const from = indices[face + ((start + i) % 3)] * 6,
        to = face * 6 + i * 6;
      for (let j = 0; j < 6; j++) data[to + j] = vertices[from + j] || 0;
    }
    order.push(face / 3);
  }
  order.sort((a, b) => {
    for (let i = 0; i < 18; i++) {
      const difference = data[a * 18 + i] - data[b * 18 + i];
      if (difference) return difference;
    }
    return 0;
  });
  const sorted = new Float32Array(data.length);
  for (let i = 0; i < order.length; i++) {
    const from = order[i] * 18,
      to = i * 18;
    for (let j = 0; j < 18; j++) sorted[to + j] = data[from + j];
  }
  return sorted;
}
let crcTable: Uint32Array | undefined;
export function hash(data: Float32Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    return c >>> 0;
  });
  let crc = 0xffffffff;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    table = crcTable;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
