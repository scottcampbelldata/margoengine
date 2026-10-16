// Test helpers: the Khronos validator loader, a headless engine, a GLB reader and small reference parsers.
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Engine, TransformStore} from '@margoengine/core/extension';

// An override remains available for external toolchains; CI uses the local test dependency.
export const toolsDir = process.env.MARGOENGINE_EXPORTERS_TOOLS ?? fileURLToPath(new URL('../../../',import.meta.url));
export const validator = existsSync(resolve(toolsDir, 'node_modules/gltf-validator')) ? createRequire(resolve(toolsDir, 'package.json'))('gltf-validator') : null;

/** Runs the Khronos validator and returns the issue summary plus any error/warning messages. */
export async function validate(data, resources = {}) {
  const options = {maxIssues: 0, externalResourceFunction: uri => resources[uri] ? Promise.resolve(resources[uri]) : Promise.reject(new Error(`missing ${uri}`))};
  const report = typeof data === 'string' ? await validator.validateString(data, options) : await validator.validateBytes(data, options);
  return {errors: report.issues.numErrors, warnings: report.issues.numWarnings, infos: report.issues.numInfos, messages: report.issues.messages.filter(m => m.severity <= 1), report};
}

/** A real Engine and TransformStore with a no-op renderer, so the Mesh API and the Wasm kernel run in Node. */
export async function headlessEngine(capacity = 256) {
  const store = await TransformStore.create(capacity);
  const renderer = {backend: 'webgl2', add() {}, remove() {}, dispose() {}, render() {}};
  return new Engine({width: 1, height: 1, getContext() {}}, store, renderer, undefined, null);
}

export function readGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) throw new Error('bad GLB header');
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20+jsonLength)));
  let bin = null;
  if (20+jsonLength < bytes.length) {const length = view.getUint32(20+jsonLength, true); bin = bytes.subarray(28+jsonLength, 28+jsonLength+length);}
  return {json, bin, jsonLength};
}

const sizes = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16};
export function accessor(json, bin, index) {
  const a = json.accessors[index], v = json.bufferViews[a.bufferView], n = a.count*sizes[a.type];
  const at = bin.byteOffset+(v.byteOffset ?? 0)+(a.byteOffset ?? 0);
  const copy = bin.buffer.slice(at, at+n*(a.componentType === 5123 ? 2 : 4));
  return a.componentType === 5126 ? new Float32Array(copy) : a.componentType === 5123 ? new Uint16Array(copy) : new Uint32Array(copy);
}

export function parseOBJ(text) {
  const out = {v: [], vt: [], vn: [], groups: [], mtllib: null};
  let group = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'v') out.v.push(rest.map(Number));
    else if (key === 'vt') out.vt.push(rest.map(Number));
    else if (key === 'vn') out.vn.push(rest.map(Number));
    else if (key === 'g') out.groups.push(group = {name: rest.join(' '), material: null, faces: []});
    else if (key === 'usemtl') group.material = rest[0];
    else if (key === 'mtllib') out.mtllib = rest[0];
    else if (key === 'f') group.faces.push(rest.map(corner => {
      const [v, t, n] = corner.split('/');
      return {v: Number(v), t: t ? Number(t) : null, n: Number(n)};
    }));
    else throw new Error(`unknown OBJ line ${line}`);
  }
  return out;
}

export function parseMTL(text) {
  const out = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'newmtl') out[rest[0]] = current = {};
    else current[key] = rest.map(Number);
  }
  return out;
}

export function parsePLY(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const end = new TextDecoder().decode(bytes.subarray(0, 2048)).indexOf('end_header\n')+'end_header\n'.length;
  const header = new TextDecoder().decode(bytes.subarray(0, end)).split('\n');
  if (header[0] !== 'ply') throw new Error('not PLY');
  const format = header[1].split(' ')[1], elements = [];
  for (const line of header) {
    const parts = line.split(' ');
    if (parts[0] === 'element') elements.push({name: parts[1], count: Number(parts[2]), properties: []});
    if (parts[0] === 'property') elements.at(-1).properties.push(parts[1] === 'list' ? {name: parts[4], list: [parts[2], parts[3]]} : {name: parts[2], type: parts[1]});
  }
  const result = {format, elements: {}};
  if (format === 'ascii') {
    const lines = new TextDecoder().decode(bytes.subarray(end)).split('\n').filter(Boolean);
    let row = 0;
    for (const element of elements) result.elements[element.name] = lines.slice(row, row += element.count).map(line => {
      const values = line.split(' ').map(Number), record = {};
      let i = 0;
      for (const p of element.properties) record[p.name] = p.list ? values.slice(i+1, i += values[i]+1) : values[i++];
      return record;
    });
    if (row !== lines.length) throw new Error('trailing PLY data');
    return result;
  }
  if (format !== 'binary_little_endian') throw new Error(`unsupported ${format}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = {float: [4, o => view.getFloat32(o, true)], uchar: [1, o => view.getUint8(o)], uint: [4, o => view.getUint32(o, true)]};
  let offset = end;
  for (const element of elements) {
    const rows = result.elements[element.name] = [];
    for (let r = 0; r < element.count; r++) {
      const record = {};
      for (const p of element.properties) {
        if (p.list) {
          const [cs, cr] = read[p.list[0]], [vs, vr] = read[p.list[1]], n = cr(offset); offset += cs;
          record[p.name] = Array.from({length: n}, () => {const value = vr(offset); offset += vs; return value;});
        } else {const [s, r2] = read[p.type]; record[p.name] = r2(offset); offset += s;}
      }
      rows.push(record);
    }
  }
  if (offset !== bytes.length) throw new Error('trailing PLY bytes');
  return result;
}

export function parseASCIISTL(text) {
  const facets = [];
  const lines = text.trim().split('\n').map(line => line.trim());
  if (!lines[0].startsWith('solid ') || !lines.at(-1).startsWith('endsolid ')) throw new Error('bad solid');
  for (let i = 1; i < lines.length-1; i += 7) {
    if (!lines[i].startsWith('facet normal ') || lines[i+1] !== 'outer loop' || lines[i+5] !== 'endloop' || lines[i+6] !== 'endfacet') throw new Error(`bad facet at ${i}`);
    facets.push({normal: lines[i].split(/\s+/).slice(2).map(Number), vertices: [2, 3, 4].map(k => {
      const parts = lines[i+k].split(/\s+/);
      if (parts[0] !== 'vertex') throw new Error('bad vertex');
      return parts.slice(1).map(Number);
    })});
  }
  return facets;
}

/** Applies a column-major 4x4 matrix to a point. */
export const transformPoint = (m, p) => [0, 1, 2].map(r => m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]);
