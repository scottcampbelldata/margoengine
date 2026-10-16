// Shared scene collection for every exporter: walks a Margo Engine engine (or a plain data scene), validates and
// normalizes geometry and materials, and computes local and world transforms in double precision.
import {engineRuntime, meshRuntime} from '@margoengine/core/extension';
import type {EngineKernel, Mesh, Geometry, PbrMaterial} from '@margoengine/core';
import type {PBRSource} from '../../shared/pbr-source.js';

/** Plain geometry with optional UVs, tangents and vertex colors, for data that core `Geometry` cannot hold. */
export interface GeometryData {
  /** xyz per vertex. */
  positions: ArrayLike<number>;
  /** xyz per vertex. Normalized on export; zero vectors are replaced by the area-weighted face normal. */
  normals: ArrayLike<number>;
  /** uv per vertex (glTF convention, v down). */
  uvs?: ArrayLike<number>;
  /** Optional second UV set. */
  uvs1?: ArrayLike<number>;
  /** xyzw per vertex, w is the bitangent sign (+1 or -1). */
  tangents?: ArrayLike<number>;
  /** Linear rgb or rgba per vertex, each in [0, 1]. */
  colors?: ArrayLike<number>;
  /** Triangle list. Omit for non-indexed triangles. */
  indices?: ArrayLike<number>;
  /** Four joint indices and weights per vertex, required together. */
  joints?: ArrayLike<number>;
  weights?: ArrayLike<number>;
  /** Dense xyz deltas in base-vertex order. */
  morphs?: readonly MorphData[];
}

export interface MorphData {
  name?: string;
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  /** xyz deltas; the base tangent keeps its handedness component. */
  tangents?: ArrayLike<number>;
}

export interface SkinData {
  name?: string;
  /** References to nodes included in this scene. */
  joints: readonly ExportNode[];
  /** Sixteen column-major values per joint. */
  inverseBindMatrices: ArrayLike<number>;
}

export interface AnimationChannelData {
  node: ExportNode;
  path: 'translation'|'rotation'|'scale'|'weights';
  interpolation?: 'STEP'|'LINEAR'|'CUBICSPLINE';
  /** Nonnegative, strictly increasing seconds after Float32 conversion. */
  times: ArrayLike<number>;
  /** CUBICSPLINE uses in-tangent, value, out-tangent for each key. */
  values: ArrayLike<number>;
}

export interface AnimationData {name?: string; channels: readonly AnimationChannelData[]}

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
  skin?: SkinData;
  morphWeights?: readonly number[];
}

/** A plain data scene; geometry and material objects shared between nodes are written once. */
export interface ExportScene {nodes: readonly ExportNode[]; animations?: readonly AnimationData[]}

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
  positions: Float32Array; normals: Float32Array; uvs?: Float32Array; uvs1?: Float32Array; tangents?: Float32Array; colors?: Float32Array; colorSize: 3|4;
  indices: Uint32Array; count: number;
  joints?: Uint16Array; weights?: Float32Array;
  morphs?: {name?: string; positions: Float32Array; normals?: Float32Array; tangents?: Float32Array}[];
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
  source?: ExportNode; skin?: SkinData; morphWeights?: Float32Array;
  /** Optional-package primitives retained on their original scene node. */
  primitives?: {geometry: Geo; material: Mat}[];
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
  if (data.uvs1 !== undefined) geo.uvs1 = floats(data.uvs1, count*2, 'UVs 1');
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
  if ((data.joints === undefined) !== (data.weights === undefined)) fail('Joint indices and weights are required together');
  if (data.joints !== undefined) {
    if (!isObject(data.joints) || data.joints.length !== count*4) fail('Joints need four values per vertex');
    const joints = new Uint16Array(count*4), weights = floats(data.weights, count*4, 'Weights');
    for (let i = 0; i < joints.length; i++) {
      const joint = data.joints[i];
      if (!Number.isInteger(joint) || joint < 0 || joint > 65535) throw new RangeError('Joint indices must be unsigned 16-bit integers');
      if (weights[i] < 0) throw new RangeError('Skin weights must be nonnegative');
      joints[i] = joint;
    }
    for (let i = 0; i < weights.length; i += 4) {
      const sum = weights[i]+weights[i+1]+weights[i+2]+weights[i+3];
      if (!(sum > 0)) throw new RangeError('Skin weights must have a positive sum');
      for (let c = 0; c < 4; c++) weights[i+c] /= sum;
    }
    geo.joints = joints; geo.weights = weights;
  }
  if (data.morphs !== undefined) {
    if (!Array.isArray(data.morphs) || !data.morphs.length) fail('Morphs must be a nonempty array');
    geo.morphs = data.morphs.map((morph: MorphData) => {
      if (!isObject(morph)) fail('Morph targets must be objects');
      if (morph.name !== undefined && typeof morph.name !== 'string') fail('Morph name must be a string');
      const out: NonNullable<Geo['morphs']>[number] = {name: morph.name, positions: floats(morph.positions, count*3, 'Morph positions')};
      if (morph.normals !== undefined) out.normals = floats(morph.normals, count*3, 'Morph normals');
      if (morph.tangents !== undefined) {
        if (!geo.tangents) fail('Morph tangents need base tangents');
        out.tangents = floats(morph.tangents, count*3, 'Morph tangents');
      }
      return out;
    });
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

export function compose(t: number[], q: number[], s: number[]): Float64Array {
  const [x, y, z, w] = q;
  return new Float64Array([
    (1-2*(y*y+z*z))*s[0], 2*(x*y+w*z)*s[0], 2*(x*z-w*y)*s[0], 0,
    2*(x*y-w*z)*s[1], (1-2*(x*x+z*z))*s[1], 2*(y*z+w*x)*s[1], 0,
    2*(x*z+w*y)*s[2], 2*(y*z-w*x)*s[2], (1-2*(x*x+y*y))*s[2], 0,
    t[0], t[1], t[2], 1,
  ]);
}

export function multiply(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c*4+r] = a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
  return out;
}

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
  const local = compose(t, r, s);
  return {name: typeof name === 'string' && name ? name : undefined, t, r, s, local, world: parent ? multiply(parent, local) : local, children: []};
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
  const pbrSkins = new Map<PBRSource, Map<number, SkinData>>();
  const pbr = (handle: Mesh, node: Node): void => {
    const source = (handle as unknown as {[key: symbol]: PBRSource|undefined})[Symbol.for('margoengine.pbr-source.v1')];
    if (!source) return;
    const primitives = source.primitives.filter(primitive => primitive.node === handle);
    if (!primitives.length) return;
    node.primitives = primitives.map(primitive => {
      const {vertices, indices, definition, material: mat} = primitive, count = vertices.length/20;
      if (!Number.isInteger(count) || !count) fail('Invalid PBR primitive vertices');
      if (mat.maps.some((map: unknown) => map) || mat.extension || primitive.extension || Object.keys(mat.extensions ?? {}).length) fail('PBR texture and material extension export is unsupported');
      const attribute = (offset: number, width: number): Float32Array => {
        const out = new Float32Array(count*width);
        for (let i = 0; i < count; i++) for (let c = 0; c < width; c++) out[i*width+c] = vertices[i*20+offset+c];
        return out;
      };
      const data: GeometryData = {positions: attribute(0, 3), normals: attribute(4, 3), indices};
      const attrs = definition.attributes ?? {};
      if (attrs.TANGENT !== undefined) data.tangents = attribute(8, 4);
      if (attrs.TEXCOORD_0 !== undefined) data.uvs = attribute(12, 2);
      if (attrs.TEXCOORD_1 !== undefined) data.uvs1 = attribute(14, 2);
      if (attrs.COLOR_0 !== undefined) data.colors = attribute(16, 4);
      if (attrs.JOINTS_1 !== undefined || attrs.WEIGHTS_1 !== undefined) fail('Export supports at most four skin influences per vertex');
      if (attrs.JOINTS_0 !== undefined) data.joints = source.asset.accessor(attrs.JOINTS_0, 'VEC4');
      if (attrs.WEIGHTS_0 !== undefined) data.weights = source.asset.accessor(attrs.WEIGHTS_0, 'VEC4');
      if (definition.targets?.length) data.morphs = definition.targets.map((target: Record<string, number>, i: number) => ({
        name: primitive.targetNames[i],
        positions: target.POSITION === undefined ? new Float32Array(count*3) : source.asset.accessor(target.POSITION, 'VEC3'),
        normals: target.NORMAL === undefined ? undefined : source.asset.accessor(target.NORMAL, 'VEC3'),
        tangents: target.TANGENT === undefined ? undefined : source.asset.accessor(target.TANGENT, 'VEC3'),
      }));
      const geometry = normalizeGeometry(data);
      const material = normalizeMaterial({name: mat.name, color: mat.base, roughness: mat.factors[0], metalness: mat.factors[1], emissive: mat.emission,
        doubleSided: !!mat.settings[2], alphaMode: mat.alphaMode ?? 'OPAQUE', alphaCutoff: mat.alphaMode === 'MASK' ? mat.settings[1] : undefined});
      return {geometry, material};
    });
    node.geometry = node.primitives[0].geometry;
    node.material = node.primitives[0].material;
    const count = node.geometry.morphs?.length ?? 0;
    if (node.primitives.some(primitive => (primitive.geometry.morphs?.length ?? 0) !== count)) fail('PBR mesh primitives need matching morph targets');
    if (count) node.morphWeights = floats(primitives[0].weights, count, 'Morph weights');
    const skinIndex = source.asset.doc.nodes?.[primitives[0].nodeIndex]?.skin;
    if (skinIndex !== undefined) {
      let skins = pbrSkins.get(source);
      if (!skins) pbrSkins.set(source, skins = new Map());
      let skin = skins.get(skinIndex);
      if (!skin) {
        const definition = source.asset.doc.skins?.[skinIndex];
        if (!definition || !Array.isArray(definition.joints)) fail('Missing PBR skin');
        const joints = definition.joints.map((index: number) => source.nodes[index] as unknown as ExportNode);
        skin = {name: definition.name, joints, inverseBindMatrices: definition.inverseBindMatrices === undefined
          ? Float32Array.from({length: joints.length*16}, (_, i) => i%16%5 === 0 ? 1 : 0)
          : source.asset.accessor(definition.inverseBindMatrices, 'MAT4')};
        skins.set(skinIndex, skin);
      }
      node.skin = skin;
    }
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
      node.source = handle as unknown as ExportNode;
      if (mesh.geometry) {node.geometry = geometry(mesh.geometry); node.material = material(mesh.material);}
      else pbr(handle, node);
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
        const t = store.transforms, local = compose([t.x[id], t.y[id], t.z[id]], unitQuaternion([t.qx[id], t.qy[id], t.qz[id], t.qw[id]]), [t.sx[id], t.sy[id], t.sz[id]]);
        base = base ? multiply(base, local) : local;
      }
    }
    const collected = roots.map(mesh => visit(mesh, base, 0)).filter((node): node is Node => node !== null);
    if (collected.length && !drawables(collected).length) fail('Engine export has no supported mesh geometry');
    return collected;
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
    node.source = data;
    if (data.skin !== undefined) {if (!isObject(data.skin)) fail('Skin must be an object'); node.skin = data.skin;}
    if (data.geometry !== undefined) {node.geometry = geometry(data.geometry); if (data.material !== undefined) node.material = material(data.material);}
    else if (data.material !== undefined) fail('A material needs geometry on the same node');
    if (data.skin !== undefined && !node.geometry) fail('A skin needs geometry on the same node');
    if (data.morphWeights !== undefined) {
      const count = node.geometry?.morphs?.length;
      if (!count) fail('Morph weights need morph targets on the same node');
      node.morphWeights = floats(data.morphWeights, count!, 'Morph weights');
    }
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
    if (node.primitives) for (const primitive of node.primitives) out.push({name: node.name, geometry: primitive.geometry, material: primitive.material, world: node.world});
    else if (node.geometry) out.push({name: node.name, geometry: node.geometry, material: node.material, world: node.world});
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** @internal World-space vertices, unit normals and winding-corrected indices of one drawable. */
export function toWorld({geometry, world}: Drawable): {positions: Float64Array; normals: Float64Array; indices: Uint32Array} {
  const {count} = geometry, positions = new Float64Array(count*3), normals = new Float64Array(count*3), n = normalMatrix(world);
  for (let i = 0; i < count; i++) {
    const x = geometry.positions[i*3], y = geometry.positions[i*3+1], z = geometry.positions[i*3+2];
    for (let r = 0; r < 3; r++) positions[i*3+r] = world[r]*x+world[4+r]*y+world[8+r]*z+world[12+r];
    const nx = geometry.normals[i*3], ny = geometry.normals[i*3+1], nz = geometry.normals[i*3+2];
    const v = [n[0]*nx+n[3]*ny+n[6]*nz, n[1]*nx+n[4]*ny+n[7]*nz, n[2]*nx+n[5]*ny+n[8]*nz], l = Math.hypot(v[0], v[1], v[2]) || 1;
    for (let r = 0; r < 3; r++) normals[i*3+r] = v[r]/l;
  }
  let indices = geometry.indices;
  if (determinant3(world) < 0) {
    indices = indices.slice();
    for (let i = 0; i < indices.length; i += 3) {const b = indices[i+1]; indices[i+1] = indices[i+2]; indices[i+2] = b;}
  }
  return {positions, normals, indices};
}

/** @internal Shortest decimal that reads back as the same Float32 value. */
export function num(value: number): string {
  const f = Math.fround(value);
  if (f === 0) return '0';
  for (let digits = 1; digits < 10; digits++) {const text = f.toPrecision(digits); if (Math.fround(Number(text)) === f) return String(Number(text));}
  return String(f);
}

export const toSrgb = (v: number): number => v <= 0.0031308 ? v*12.92 : 1.055*v**(1/2.4)-0.055;
export const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v*255)));

/** @internal Replaces whitespace so a name survives line-based formats. */
export const token = (name: string|undefined, fallback: string): string => (name ?? '').replace(/[\s#]+/g, '_') || fallback;
