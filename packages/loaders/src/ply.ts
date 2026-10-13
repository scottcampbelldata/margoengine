import {LoaderError, type LoadedGeometry, type ParseLimits} from './types.js';
import {checkCount, latin1, limits, toBytes, triangulate, uints, type BinaryInput, TextScanner} from './util.js';

const F = 'PLY';
type ScalarType = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';
const TYPES: Record<string, ScalarType> = {
  char: 'int8', int8: 'int8', uchar: 'uint8', uint8: 'uint8', short: 'int16', int16: 'int16', ushort: 'uint16', uint16: 'uint16',
  int: 'int32', int32: 'int32', uint: 'uint32', uint32: 'uint32', float: 'float32', float32: 'float32', double: 'float64', float64: 'float64',
};
const SIZES: Record<ScalarType, number> = {int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8};
const UNIT: Partial<Record<ScalarType, number>> = {uint8: 255, uint16: 65535, uint32: 4294967295, int8: 127, int16: 32767, int32: 2147483647};
type Reader = (view: DataView, offset: number, little: boolean) => number;
const READERS: Record<ScalarType, Reader> = {
  int8: (v, o) => v.getInt8(o), uint8: (v, o) => v.getUint8(o),
  int16: (v, o, l) => v.getInt16(o, l), uint16: (v, o, l) => v.getUint16(o, l),
  int32: (v, o, l) => v.getInt32(o, l), uint32: (v, o, l) => v.getUint32(o, l),
  float32: (v, o, l) => v.getFloat32(o, l), float64: (v, o, l) => v.getFloat64(o, l),
};
const MAX_HEADER = 1 << 20;
const MAX_POLYGON = 65536;

export interface PLYProperty {name: string; type: ScalarType; list?: {count: ScalarType}}
export interface PLYElement {name: string; count: number; properties: PLYProperty[]}
export interface PLYHeader {format: 'ascii' | 'binary_little_endian' | 'binary_big_endian'; elements: PLYElement[]; comments: string[]; bodyOffset: number}

export interface PLYOptions extends ParseLimits {}

/** Parses only the PLY header. */
export function parsePLYHeader(input: BinaryInput): PLYHeader {
  const bytes = toBytes(input, F);
  if (bytes.length < 4 || latin1(bytes, 0, 3) !== 'ply' || (bytes[3] !== 10 && bytes[3] !== 13)) throw new LoaderError(F, 'header', 'missing "ply" magic');
  const text = latin1(bytes, 0, Math.min(bytes.length, MAX_HEADER));
  const match = /(^|\n)end_header[ \t]*\r?\n/.exec(text);
  if (!match) throw new LoaderError(F, bytes.length > MAX_HEADER ? 'header' : 'truncated', 'end_header not found');
  const bodyOffset = match.index + match[0].length;
  const lines = text.slice(0, match.index).split('\n').map(line => line.trim()).filter(Boolean).slice(1);
  let format: PLYHeader['format'] | undefined;
  const elements: PLYElement[] = [], comments: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/), keyword = parts[0];
    if (keyword === 'comment' || keyword === 'obj_info') {comments.push(line.slice(keyword.length).trim()); continue;}
    if (keyword === 'format') {
      if (parts[1] !== 'ascii' && parts[1] !== 'binary_little_endian' && parts[1] !== 'binary_big_endian') throw new LoaderError(F, 'unsupported', `unknown format "${parts[1]}"`);
      if (parts[2] !== '1.0') throw new LoaderError(F, 'unsupported', `unsupported version "${parts[2]}"`);
      format = parts[1];
    } else if (keyword === 'element') {
      const count = Number(parts[2]);
      if (parts.length !== 3 || !Number.isSafeInteger(count) || count < 0) throw new LoaderError(F, 'header', `invalid element line "${line.slice(0, 80)}"`);
      elements.push({name: parts[1], count, properties: []});
    } else if (keyword === 'property') {
      const element = elements[elements.length - 1];
      if (!element) throw new LoaderError(F, 'header', 'property before any element');
      if (parts[1] === 'list') {
        const count = TYPES[parts[2]], item = TYPES[parts[3]];
        if (parts.length !== 5 || !count || !item) throw new LoaderError(F, 'header', `invalid list property "${line.slice(0, 80)}"`);
        if (count === 'float32' || count === 'float64') throw new LoaderError(F, 'header', 'list counts must be integers');
        element.properties.push({name: parts[4], type: item, list: {count}});
      } else {
        const type = TYPES[parts[1]];
        if (parts.length !== 3 || !type) throw new LoaderError(F, 'header', `invalid property "${line.slice(0, 80)}"`);
        element.properties.push({name: parts[2], type});
      }
    } else throw new LoaderError(F, 'header', `unknown header keyword "${keyword.slice(0, 32)}"`);
  }
  if (!format) throw new LoaderError(F, 'header', 'missing format line');
  return {format, elements, comments, bodyOffset};
}

const find = (properties: PLYProperty[], names: string[]): number => {
  for (const name of names) {const index = properties.findIndex(p => p.name === name && !p.list); if (index >= 0) return index;}
  return -1;
};

/**
 * Parses an ASCII or binary (little or big endian) PLY file. Replaces Three.js `PLYLoader`.
 * Faces become a triangle fan; a file without faces is returned as a point cloud.
 */
export function parsePLY(input: BinaryInput, options: PLYOptions = {}): LoadedGeometry {
  const bytes = toBytes(input, F), limit = limits(options, F), header = parsePLYHeader(bytes);
  const vertexElement = header.elements.find(e => e.name === 'vertex');
  if (!vertexElement) throw new LoaderError(F, 'header', 'no vertex element');
  const vertexCount = checkCount(vertexElement.count, limit.maxVertices, F, 'vertex');
  const faceElement = header.elements.find(e => e.name === 'face');
  if (faceElement) checkCount(faceElement.count, limit.maxTriangles, F, 'face');
  const elementLimit = Math.max(limit.maxVertices, limit.maxTriangles);
  for (const element of header.elements) checkCount(element.count, elementLimit, F, `"${element.name}" element`);

  const props = vertexElement.properties;
  const px = find(props, ['x']), py = find(props, ['y']), pz = find(props, ['z']);
  if (px < 0 || py < 0 || pz < 0) throw new LoaderError(F, 'header', 'vertex element needs x, y and z properties');
  const nx = find(props, ['nx', 'normal_x']), ny = find(props, ['ny', 'normal_y']), nz = find(props, ['nz', 'normal_z']);
  const cr = find(props, ['red', 'diffuse_red', 'r']), cg = find(props, ['green', 'diffuse_green', 'g']), cb = find(props, ['blue', 'diffuse_blue', 'b']);
  const tu = find(props, ['s', 'u', 'texture_u', 'texture_s']), tv = find(props, ['t', 'v', 'texture_v', 'texture_t']);
  const hasNormals = nx >= 0 && ny >= 0 && nz >= 0, hasColors = cr >= 0 && cg >= 0 && cb >= 0, hasUVs = tu >= 0 && tv >= 0;
  const positions = new Float32Array(vertexCount * 3);
  const normals = hasNormals ? new Float32Array(vertexCount * 3) : undefined;
  const colors = hasColors ? new Float32Array(vertexCount * 3) : undefined;
  const uvs = hasUVs ? new Float32Array(vertexCount * 2) : undefined;
  const colorScale = hasColors ? [cr, cg, cb].map(i => UNIT[props[i].type] ?? 1) : [1, 1, 1];
  const indices = uints(faceElement ? faceElement.count * 3 : 0);
  const row = new Float64Array(Math.max(1, ...header.elements.map(e => e.properties.length)));
  let polygon = new Float64Array(0);
  const storeVertex = (i: number): void => {
    positions[i * 3] = row[px]; positions[i * 3 + 1] = row[py]; positions[i * 3 + 2] = row[pz];
    if (normals) {normals[i * 3] = row[nx]; normals[i * 3 + 1] = row[ny]; normals[i * 3 + 2] = row[nz];}
    if (colors) {colors[i * 3] = row[cr] / colorScale[0]; colors[i * 3 + 1] = row[cg] / colorScale[1]; colors[i * 3 + 2] = row[cb] / colorScale[2];}
    if (uvs) {uvs[i * 2] = row[tu]; uvs[i * 2 + 1] = row[tv];}
  };
  const faceList = faceElement ? faceElement.properties.findIndex(p => p.list && (p.name === 'vertex_indices' || p.name === 'vertex_index')) : -1;
  if (faceElement && faceElement.count > 0 && faceList < 0) throw new LoaderError(F, 'header', 'face element has no vertex_indices list');
  const at = (corner: number): number => polygon[corner];
  const checkCorners = (count: number): void => {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_POLYGON) throw new LoaderError(F, 'range', `invalid list length ${count}`);
    if (count > polygon.length) polygon = new Float64Array(Math.min(MAX_POLYGON, Math.max(count, polygon.length * 2, 16)));
  };

  if (header.format === 'ascii') {
    const scanner = new TextScanner(latin1(bytes, header.bodyOffset), F);
    for (const element of header.elements) {
      const isVertex = element === vertexElement, isFace = element === faceElement;
      for (let i = 0; i < element.count; i++) {
        for (let p = 0; p < element.properties.length; p++) {
          const property = element.properties[p];
          if (!property.list) {row[p] = scanner.number(`${element.name} ${i}`); continue;}
          const count = scanner.integer(`${element.name} ${i} list length`);
          checkCorners(count);
          for (let k = 0; k < count; k++) polygon[k] = scanner.number(`${element.name} ${i} list`);
          if (isFace && p === faceList) triangulate(indices, count, at, vertexCount, F, limit.maxTriangles);
        }
        if (isVertex) storeVertex(i);
      }
    }
  } else {
    const little = header.format === 'binary_little_endian';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = header.bodyOffset;
    const end = bytes.byteLength;
    const truncated = (what: string): never => {throw new LoaderError(F, 'truncated', `binary data ends inside ${what}`);};
    for (const element of header.elements) {
      const isVertex = element === vertexElement, isFace = element === faceElement;
      const minimum = element.properties.reduce((sum, p) => sum + SIZES[p.list ? p.list.count : p.type], 0);
      if (element.count * minimum > end - offset) truncated(`the "${element.name}" element`);
      const fixed = element.properties.every(p => !p.list);
      const readers = element.properties.map(p => READERS[p.type]);
      for (let i = 0; i < element.count; i++) {
        for (let p = 0; p < element.properties.length; p++) {
          const property = element.properties[p];
          if (!property.list) {
            if (!fixed && offset + SIZES[property.type] > end) truncated(`${element.name} ${i}`);
            row[p] = readers[p](view, offset, little); offset += SIZES[property.type]; continue;
          }
          const countSize = SIZES[property.list.count], itemSize = SIZES[property.type];
          if (offset + countSize > end) truncated(`${element.name} ${i}`);
          const count = READERS[property.list.count](view, offset, little); offset += countSize;
          checkCorners(count);
          if (offset + count * itemSize > end) truncated(`${element.name} ${i}`);
          if (isFace && p === faceList) {
            for (let k = 0; k < count; k++) {polygon[k] = readers[p](view, offset, little); offset += itemSize;}
            triangulate(indices, count, at, vertexCount, F, limit.maxTriangles);
          } else offset += count * itemSize;
        }
        if (isVertex) storeVertex(i);
      }
    }
  }
  const result: LoadedGeometry = {kind: indices.length ? 'mesh' : 'points', positions};
  if (normals) result.normals = normals;
  if (colors) result.colors = colors;
  if (uvs) result.uvs = uvs;
  if (indices.length) result.indices = indices.result();
  return result;
}
