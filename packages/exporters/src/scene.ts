// Shared scene collection for every exporter: walks a Margo Engine engine (or a plain data scene), validates and
// normalizes geometry and materials, and computes local and world transforms in double precision.
import {engineRuntime, meshRuntime} from '@margoengine/core/extension';
import type {EngineKernel, Mesh, Geometry, PbrMaterial} from '@margoengine/core';
import {composeMatrix, multiplyMatrices} from '@margoengine/math/mat4';

/** Plain geometry with optional UVs, tangents and vertex colors, for data that core `Geometry` cannot hold. */
export interface GeometryData {
  /** xyz per vertex. */
  positions: ArrayLike<number>;
  /** xyz per vertex. Normalized on export; zero vectors are replaced by the area-weighted face normal. */
  normals: ArrayLike<number>;
  /** uv per vertex (glTF convention, v down). */
  uvs?: ArrayLike<number>;
  /** xyzw per vertex, w is the bitangent sign (+1 or -1). */
  tangents?: ArrayLike<number>;
  /** Linear rgb or rgba per vertex, each in [0, 1]. */
  colors?: ArrayLike<number>;
  /** Triangle list. Omit for non-indexed triangles. */
  indices?: ArrayLike<number>;
}

/** An encoded PNG or JPEG image referenced by a material. */
export interface TextureData {
  image: Uint8Array;
  mimeType: 'image/png'|'image/jpeg';
  name?: string;
}

/** A glTF metallic-roughness material described as data. */
export interface MaterialData {
  name?: string;
  /** Linear rgb or rgba, default [1, 1, 1, 1]. */
  color?: readonly number[];
  roughness?: number;
  metalness?: number;
  doubleSided?: boolean;
  /** Linear rgb, default black. */
  emissive?: readonly number[];
  alphaMode?: 'OPAQUE'|'MASK'|'BLEND';
  alphaCutoff?: number;
  baseColorTexture?: TextureData;
  metallicRoughnessTexture?: TextureData;
  normalTexture?: TextureData;
}

/** A node of a plain data scene. Rotation is a quaternion [x, y, z, w]. */
export interface ExportNode {
  name?: string;
  translation?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
  geometry?: Geometry|GeometryData;
  material?: PbrMaterial|MaterialData;
  visible?: boolean;
  children?: readonly ExportNode[];
}

/** A plain data scene; geometry and material objects shared between nodes are written once. */
export interface ExportScene {nodes: readonly ExportNode[]}

/** Either a Margo Engine engine (from `Engine.create`) or a plain data scene. */
export type ExportSource = EngineKernel|ExportScene;

interface Lookup<K, V> {get(key: K): V|undefined}

export interface SceneOptions {
  /** Skip hidden meshes and their descendants. Default true. */
  onlyVisible?: boolean;
  /** Export only this engine mesh and its descendants. */
  root?: Mesh;
  /** Richer data (UVs, tangents, colors) to write in place of a core Geometry. */
  geometryData?: Lookup<Geometry, GeometryData>;
  /** Richer data (textures, emission) to write in place of a core PbrMaterial. */
  materialData?: Lookup<PbrMaterial, MaterialData>;
}

/** @internal Normalized geometry. */
export interface Geo {
  positions: Float32Array; normals: Float32Array; uvs?: Float32Array; tangents?: Float32Array; colors?: Float32Array; colorSize: 3|4;
  indices: Uint32Array; count: number;
}
/** @internal Normalized material. */
export interface Mat {
  name?: string; color: number[]; roughness: number; metalness: number; doubleSided: boolean; emissive: number[];
  alphaMode: 'OPAQUE'|'MASK'|'BLEND'; alphaCutoff?: number;
  baseColorTexture?: TextureData; metallicRoughnessTexture?: TextureData; normalTexture?: TextureData;
}
/** @internal Normalized node. */
export interface Node {
  name?: string; t: number[]; r: number[]; s: number[]; local: Float64Array; world: Float64Array;
  geometry?: Geo; material?: Mat; children: Node[];
}

const fail = (message: string): never => {throw new TypeError(message);};
export const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null;
const isCoreGeometry = (value: any): value is Geometry => value?.vertices instanceof Float32Array && value.indices instanceof Uint32Array && value.bounds instanceof Float32Array;
const isCoreMaterial = (value: any): value is PbrMaterial => value?.data instanceof Float32Array && value.data.length === 8;

function floats(values: ArrayLike<number>|undefined, size: number, label: string): Float32Array {
  if (!isObject(values) || typeof values.length !== 'number' || values.length !== size) fail(`${label} needs ${size} values`);
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const value = values![i];
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new RangeError(`${label} must be finite Float32 values`);
    out[i] = value;
  }
  return out;
}

function vector(values: readonly number[]|undefined, fallback: number[], label: string): number[] {
  if (values === undefined) return fallback.slice();
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) fail(`${label} must be an array`);
  return Array.from(floats(values, fallback.length, label));
}

function unit(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be in [0, 1]`);
  return value;
}

/** Validates and normalizes geometry data. Normals and tangents become unit length, tangent w becomes +1 or -1. */
export function normalizeGeometry(data: Geometry|GeometryData): Geo {
  if (isCoreGeometry(data)) {
    const count = data.vertices.length/6, positions = new Float32Array(count*3), normals = new Float32Array(count*3);
    for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) {positions[i*3+a] = data.vertices[i*6+a]; normals[i*3+a] = data.vertices[i*6+3+a];}
    return normalizeGeometry({positions, normals, indices: data.indices});
  }
  if (!isObject(data)) fail('Expected Geometry or geometry data');
  const length = data.positions?.length;
  if (typeof length !== 'number' || length === 0 || length % 3) throw new RangeError('Positions need xyz per vertex');
  const count = length/3, positions = floats(data.positions, length, 'Positions'), normals = floats(data.normals, length, 'Normals');
  let indices: Uint32Array;
  if (data.indices === undefined) {
    if (count % 3) throw new RangeError('Non-indexed geometry needs complete triangles');
    indices = Uint32Array.from({length: count}, (_, i) => i);
  } else {
    const source = data.indices;
    if (!isObject(source) || typeof source.length !== 'number' || source.length === 0 || source.length % 3) throw new RangeError('Indices must hold complete triangles');
    indices = new Uint32Array(source.length);
    for (let i = 0; i < source.length; i++) {
      const index = source[i];
      if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('Index exceeds vertices');
      indices[i] = index;
    }
  }
  // Area-weighted fallback normals for zero-length inputs.
  let fallback: Float64Array|null = null;
  for (let i = 0; i < count; i++) {
    const x = normals[i*3], y = normals[i*3+1], z = normals[i*3+2], l = Math.hypot(x, y, z);
    if (l > 1e-12) {normals[i*3] = x/l; normals[i*3+1] = y/l; normals[i*3+2] = z/l; continue;}
    fallback ??= faceNormals(positions, indices, count);
    const fx = fallback[i*3], fy = fallback[i*3+1], fz = fallback[i*3+2], fl = Math.hypot(fx, fy, fz);
    normals.set(fl > 1e-12 ? [fx/fl, fy/fl, fz/fl] : [0, 0, 1], i*3);
  }
  const geo: Geo = {positions, normals, indices, count, colorSize: 4};
  if (data.uvs !== undefined) geo.uvs = floats(data.uvs, count*2, 'UVs');
  if (data.tangents !== undefined) {
    const tangents = floats(data.tangents, count*4, 'Tangents');
    for (let i = 0; i < count; i++) {
      const x = tangents[i*4], y = tangents[i*4+1], z = tangents[i*4+2], l = Math.hypot(x, y, z);
      if (l <= 1e-12) throw new RangeError('Tangents must be nonzero');
      tangents.set([x/l, y/l, z/l, tangents[i*4+3] < 0 ? -1 : 1], i*4);
    }
    geo.tangents = tangents;
  }
  if (data.colors !== undefined) {
    const size = data.colors?.length === count*3 ? 3 : 4, colors = floats(data.colors, count*size, 'Colors');
    if (colors.some(v => v < 0 || v > 1)) throw new RangeError('Colors must be in [0, 1]');
    geo.colors = colors; geo.colorSize = size;
  }
  return geo;
}

function faceNormals(positions: Float32Array, indices: Uint32Array, count: number): Float64Array {
  const out = new Float64Array(count*3);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]*3, b = indices[i+1]*3, c = indices[i+2]*3;
    const ux = positions[b]-positions[a], uy = positions[b+1]-positions[a+1], uz = positions[b+2]-positions[a+2];
    const vx = positions[c]-positions[a], vy = positions[c+1]-positions[a+1], vz = positions[c+2]-positions[a+2];
    const n = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) out[v+k] += n[k];
  }
  return out;
}

function checkTexture(texture: unknown, label: string): TextureData|undefined {
  if (texture === undefined) return undefined;
  if (!isObject(texture) || !(texture.image instanceof Uint8Array)) fail(`${label} needs an image Uint8Array`);
  const {image, mimeType} = texture as TextureData;
  const png = image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
  const jpeg = image.length > 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  if (mimeType === 'image/png' ? !png : mimeType === 'image/jpeg' ? !jpeg : true) fail(`${label} must be a PNG or JPEG matching its mimeType`);
  return texture as TextureData;
}

/** Validates and normalizes a core PbrMaterial or material data. Base color is linear. */
export function normalizeMaterial(data: PbrMaterial|MaterialData): Mat {
  if (isCoreMaterial(data)) {
    const d = data.data;
    for (let i = 0; i < 8; i++) if (!Number.isFinite(d[i]) || d[i] < 0 || d[i] > 1) throw new RangeError('Invalid material values');
    return {color: [d[0], d[1], d[2], d[3]], roughness: d[4], metalness: d[5], doubleSided: d[6] === 1, emissive: [0, 0, 0], alphaMode: 'OPAQUE'};
  }
  if (!isObject(data)) fail('Expected PbrMaterial or material data');
  const m = data as MaterialData;
  const color = m.color === undefined ? [1, 1, 1, 1] : vector(m.color, m.color.length === 3 ? [0, 0, 0] : [0, 0, 0, 0], 'Color');
  if (color.length === 3) color.push(1);
  const emissive = vector(m.emissive, [0, 0, 0], 'Emissive');
  if ([...color, ...emissive].some(v => v < 0 || v > 1)) throw new RangeError('Material colors must be in [0, 1]');
  if (m.name !== undefined && typeof m.name !== 'string') fail('Material name must be a string');
  if (m.doubleSided !== undefined && typeof m.doubleSided !== 'boolean') fail('doubleSided must be boolean');
  const alphaMode = m.alphaMode ?? 'OPAQUE';
  if (!['OPAQUE', 'MASK', 'BLEND'].includes(alphaMode)) fail('Unknown alphaMode');
  if (m.alphaCutoff !== undefined && (alphaMode !== 'MASK' || !Number.isFinite(m.alphaCutoff) || !(m.alphaCutoff >= 0))) throw new RangeError('alphaCutoff needs MASK mode and a value >= 0');
  return {
    name: m.name, color, emissive, alphaMode, alphaCutoff: m.alphaCutoff, doubleSided: m.doubleSided ?? false,
    roughness: unit(m.roughness, 'Roughness', 1), metalness: unit(m.metalness, 'Metalness', 0),
    baseColorTexture: checkTexture(m.baseColorTexture, 'baseColorTexture'),
    metallicRoughnessTexture: checkTexture(m.metallicRoughnessTexture, 'metallicRoughnessTexture'),
    normalTexture: checkTexture(m.normalTexture, 'normalTexture'),
  };
}

// --- column-major 4x4 math in double precision ---

export const determinant3 = (m: Float64Array): number =>
  m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5]);

/** Inverse transpose of the upper 3x3, as a column-major 3x3. */
export function normalMatrix(m: Float64Array): Float64Array {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const det = determinant3(m);
  if (!det || !Number.isFinite(det)) throw new RangeError('Singular transform');
  // Cofactor matrix equals det * inverse transpose.
  return new Float64Array([(e*i-f*h)/det, (f*g-d*i)/det, (d*h-e*g)/det, (c*h-b*i)/det, (a*i-c*g)/det, (b*g-a*h)/det, (b*f-c*e)/det, (c*d-a*f)/det, (a*e-b*d)/det]);
}

/** Splits an affine matrix into translation, unit quaternion and scale, or returns null when it has shear. */
export function decompose(m: Float64Array): {t: number[]; r: number[]; s: number[]}|null {
  let sx = Math.hypot(m[0], m[1], m[2]); const sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  if (!sx || !sy || !sz) return null;
  if (determinant3(m) < 0) sx = -sx;
  const r = [m[0]/sx, m[1]/sx, m[2]/sx, m[4]/sy, m[5]/sy, m[6]/sy, m[8]/sz, m[9]/sz, m[10]/sz];
  const dot = (a: number, b: number) => r[a]*r[b]+r[a+1]*r[b+1]+r[a+2]*r[b+2];
  if (Math.abs(dot(0, 3)) > 1e-6 || Math.abs(dot(0, 6)) > 1e-6 || Math.abs(dot(3, 6)) > 1e-6) return null;
  const trace = r[0]+r[4]+r[8];
  let q: number[];
  if (trace > 0) {const s = 2*Math.sqrt(trace+1); q = [(r[5]-r[7])/s, (r[6]-r[2])/s, (r[1]-r[3])/s, s/4];}
  else if (r[0] > r[4] && r[0] > r[8]) {const s = 2*Math.sqrt(1+r[0]-r[4]-r[8]); q = [s/4, (r[3]+r[1])/s, (r[6]+r[2])/s, (r[5]-r[7])/s];}
  else if (r[4] > r[8]) {const s = 2*Math.sqrt(1+r[4]-r[0]-r[8]); q = [(r[3]+r[1])/s, s/4, (r[7]+r[5])/s, (r[6]-r[2])/s];}
  else {const s = 2*Math.sqrt(1+r[8]-r[0]-r[4]); q = [(r[6]+r[2])/s, (r[7]+r[5])/s, s/4, (r[1]-r[3])/s];}
  return {t: [m[12], m[13], m[14]], r: unitQuaternion(q), s: [sx, sy, sz]};
}

export function unitQuaternion(q: number[]): number[] {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!length || !Number.isFinite(length)) throw new RangeError('Quaternion must be nonzero');
  const out = q.map(v => v/length);
  return out[3] < 0 ? out.map(v => -v) : out;
}

// --- collection ---

function makeNode(name: unknown, t: number[], r: number[], s: number[], parent: Float64Array|null): Node {
  if (s.some(v => Math.fround(v) === 0)) throw new RangeError('Scale must be nonzero');
  const local = composeMatrix(t, r, s, new Float64Array(16));
  return {name: typeof name === 'string' && name ? name : undefined, t, r, s, local, world: parent ? multiplyMatrices(parent, local, new Float64Array(16)) : local, children: []};
}

function isEngine(source: unknown): source is EngineKernel {
  return isObject(source) && typeof source.createMesh === 'function' && isObject((source as any).store) && (source as any).meshes instanceof Map;
}

/** @internal Collects the exported node forest. */
export function collect(source: ExportSource, options: SceneOptions = {}): Node[] {
  if (!isObject(options)) fail('Options must be an object');
  const onlyVisible = options.onlyVisible ?? true;
  if (typeof onlyVisible !== 'boolean') fail('onlyVisible must be boolean');
  const geometries = new Map<object, Geo>(), materials = new Map<object, Mat>();
  const geometry = (value: Geometry|GeometryData): Geo => {
    let geo = geometries.get(value);
    if (!geo) {geo = normalizeGeometry((isCoreGeometry(value) && options.geometryData?.get(value)) || value); geometries.set(value, geo);}
    return geo;
  };
  const material = (value: PbrMaterial|MaterialData): Mat => {
    let mat = materials.get(value);
    if (!mat) {mat = normalizeMaterial((isCoreMaterial(value) && options.materialData?.get(value)) || value); materials.set(value, mat);}
    return mat;
  };

  if (isEngine(source)) {
    const engine = engineRuntime(source);
    if (engine.disposed) throw new Error('Engine is disposed');
    const store = engine.store, children = new Map<number, Mesh[]>(), tops: Mesh[] = [];
    for (const mesh of engine.meshes.values()) {
      const parent = store.parents[mesh.id];
      if (parent === -1) tops.push(mesh as unknown as Mesh);
      else {let list = children.get(parent); if (!list) children.set(parent, list = []); list.push(mesh as unknown as Mesh);}
    }
    let roots = tops;
    if (options.root !== undefined) {
      if (!isObject(options.root) || engine.meshes.get(meshRuntime(options.root).id) !== (options.root as unknown)) fail('root must be a live mesh of this engine');
      roots = [options.root];
    }
    const visit = (handle: Mesh, parent: Float64Array|null, depth: number): Node|null => {
      const mesh = meshRuntime(handle), id = mesh.id, t = store.transforms;
      if (depth > 64) throw new RangeError('Hierarchy is too deep');
      if (onlyVisible && store.hidden[id]) return null;
      const node = makeNode(mesh.name, [t.x[id], t.y[id], t.z[id]], unitQuaternion([t.qx[id], t.qy[id], t.qz[id], t.qw[id]]), [t.sx[id], t.sy[id], t.sz[id]], parent);
      if (mesh.geometry) {node.geometry = geometry(mesh.geometry); node.material = material(mesh.material);}
      for (const child of children.get(id) ?? []) {const out = visit(child, node.world, depth+1); if (out) node.children.push(out);}
      return node;
    };
    // An exported subtree root keeps its local transform, but its parents still place it in world space.
    let base: Float64Array|null = null;
    if (options.root !== undefined) {
      const chain: number[] = [];
      for (let id = store.parents[meshRuntime(options.root).id]; id !== -1; id = store.parents[id]) {
        chain.unshift(id);
        if (onlyVisible && store.hidden[id]) return [];
      }
      for (const id of chain) {
        const t = store.transforms, local = composeMatrix([t.x[id], t.y[id], t.z[id]], unitQuaternion([t.qx[id], t.qy[id], t.qz[id], t.qw[id]]), [t.sx[id], t.sy[id], t.sz[id]], new Float64Array(16));
        base = base ? multiplyMatrices(base, local, new Float64Array(16)) : local;
      }
    }
    return roots.map(mesh => visit(mesh, base, 0)).filter((node): node is Node => node !== null);
  }

  if (!isObject(source) || !Array.isArray((source as ExportScene).nodes)) fail('Expected a Margo Engine engine or {nodes: [...]}');
  if (options.root !== undefined) fail('root applies to engine sources; pass a scene with the wanted nodes instead');
  const seen = new Set<ExportNode>();
  const visit = (data: ExportNode, parent: Float64Array|null, depth: number): Node|null => {
    if (!isObject(data)) fail('Scene nodes must be objects');
    if (seen.has(data)) fail('A scene node appears twice');
    if (depth > 64) throw new RangeError('Hierarchy is too deep');
    seen.add(data);
    if (data.visible !== undefined && typeof data.visible !== 'boolean') fail('visible must be boolean');
    if (onlyVisible && data.visible === false) return null;
    if (data.name !== undefined && typeof data.name !== 'string') fail('Node name must be a string');
    const node = makeNode(data.name, vector(data.translation, [0, 0, 0], 'Translation'), unitQuaternion(vector(data.rotation, [0, 0, 0, 1], 'Rotation')), vector(data.scale, [1, 1, 1], 'Scale'), parent);
    if (data.geometry !== undefined) {node.geometry = geometry(data.geometry); if (data.material !== undefined) node.material = material(data.material);}
    else if (data.material !== undefined) fail('A material needs geometry on the same node');
    if (data.children !== undefined && !Array.isArray(data.children)) fail('children must be an array');
    for (const child of data.children ?? []) {const out = visit(child, node.world, depth+1); if (out) node.children.push(out);}
    return node;
  };
  return (source as ExportScene).nodes.map(node => visit(node, null, 0)).filter((node): node is Node => node !== null);
}

/** @internal A drawable with its world transform, in depth-first order. */
export interface Drawable {name?: string; geometry: Geo; material?: Mat; world: Float64Array}

export function drawables(nodes: Node[]): Drawable[] {
  const out: Drawable[] = [];
  const walk = (node: Node) => {
    if (node.geometry) out.push({name: node.name, geometry: node.geometry, material: node.material, world: node.world});
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** @internal World-space vertices, unit normals and winding-corrected indices of one drawable. */
export function toWorld({geometry, world}: Drawable): {positions: Float64Array; normals: Float64Array; indices: Uint32Array} {
  const {count} = geometry, source = geometry.positions, sourceNormals = geometry.normals, positions = new Float64Array(count*3), normals = new Float64Array(count*3), n = normalMatrix(world);
  const m0 = world[0], m1 = world[1], m2 = world[2], m4 = world[4], m5 = world[5], m6 = world[6], m8 = world[8], m9 = world[9], m10 = world[10], m12 = world[12], m13 = world[13], m14 = world[14];
  const n0 = n[0], n1 = n[1], n2 = n[2], n3 = n[3], n4 = n[4], n5 = n[5], n6 = n[6], n7 = n[7], n8 = n[8];
  for (let o = 0, end = count*3; o < end; o += 3) {
    const x = source[o], y = source[o+1], z = source[o+2];
    positions[o] = m0*x+m4*y+m8*z+m12; positions[o+1] = m1*x+m5*y+m9*z+m13; positions[o+2] = m2*x+m6*y+m10*z+m14;
    const nx = sourceNormals[o], ny = sourceNormals[o+1], nz = sourceNormals[o+2];
    const vx = n0*nx+n3*ny+n6*nz, vy = n1*nx+n4*ny+n7*nz, vz = n2*nx+n5*ny+n8*nz, l = Math.hypot(vx, vy, vz) || 1;
    normals[o] = vx/l; normals[o+1] = vy/l; normals[o+2] = vz/l;
  }
  let indices = geometry.indices;
  if (determinant3(world) < 0) {
    indices = indices.slice();
    for (let i = 0; i < indices.length; i += 3) {const b = indices[i+1]; indices[i+1] = indices[i+2]; indices[i+2] = b;}
  }
  return {positions, normals, indices};
}

// Powers of ten that a double holds exactly.
const POW10 = Array.from({length: 23}, (_, i) => Number(`1e${i}`));
const ZEROS = '0'.repeat(21);

/** @internal Shortest decimal that reads back as the same Float32 value. */
export function num(value: number): string {
  const f = Math.fround(value);
  if (f === 0) return '0';
  const a = Math.abs(f);
  let e = Math.floor(Math.log10(a));
  // Fast path: an integer mantissa below 1e9 times or over an exact power of ten is correctly rounded, so it equals
  // Number(f.toPrecision(digits)) without building the string. Other magnitudes take the string search below.
  if (e >= -13 && e <= 21) {
    let m = e < 0 ? a*POW10[-e] : a/POW10[e];
    if (m >= 10) {m /= 10; e++;} else if (m < 1) {m *= 10; e--;}
    for (let digits = 1, scale = 1; digits < 10; digits++, scale *= 10) {
      const scaled = m*scale, mantissa = Math.round(scaled), k = e-digits+1;
      // On a rounding tie the scaled value is too imprecise to pick a side. Below seven digits neither side can
      // round-trip (both are over half a Float32 step away); from seven digits on the string search decides.
      if (Math.abs(scaled-Math.floor(scaled)-0.5) < 1e-5) {if (digits < 7) continue; break;}
      const x = k < 0 ? mantissa/POW10[-k] : mantissa*POW10[k];
      if (Math.fround(x) !== a) continue;
      // The mantissa's digits are the shortest text of x, so place the decimal point by hand where String(x) would
      // (`point` digits before it); exponent notation and mantissas that end in zero are left to String.
      const point = e+1;
      if (mantissa%10 === 0 || point < -5 || point > 21) return String(f < 0 ? -x : x);
      const text = String(mantissa), sign = f < 0 ? '-' : '';
      return sign+(point <= 0 ? '0.'+ZEROS.slice(0, -point)+text : point >= digits ? text+ZEROS.slice(0, point-digits) : text.slice(0, point)+'.'+text.slice(point));
    }
  }
  for (let digits = 1; digits < 10; digits++) {const text = f.toPrecision(digits); if (Math.fround(Number(text)) === f) return String(Number(text));}
  return String(f);
}

export const toSrgb = (v: number): number => v <= 0.0031308 ? v*12.92 : 1.055*v**(1/2.4)-0.055;
export const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v*255)));

/** @internal Replaces whitespace so a name survives line-based formats. */
export const token = (name: string|undefined, fallback: string): string => (name ?? '').replace(/[\s#]+/g, '_') || fallback;
