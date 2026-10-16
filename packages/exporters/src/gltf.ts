// glTF 2.0 writer: the Margo Engine counterpart of Three.js GLTFExporter.
import {collect, decompose, determinant3, drawables, normalMatrix, isObject, type AnimationData, type ExportNode, type ExportScene, type ExportSource, type Geo, type Mat, type Node, type SceneOptions, type SkinData, type TextureData} from './scene.js';

export interface GLTFOptions extends SceneOptions {
  /** Write every mesh as a root node with its world transform instead of keeping the hierarchy. Default false. */
  flatten?: boolean;
  /** `asset.generator`. Default 'Margo Engine exporters'. */
  generator?: string;
}

export interface GLTFJsonOptions extends GLTFOptions {
  /** Embed the binary buffer as a base64 data URI (default) or return it separately. */
  embed?: boolean;
  /** URI of the separate buffer when `embed` is false. Default 'scene.bin'. */
  binUri?: string;
}

export interface GLTFJsonResult {
  /** The glTF document object. */
  json: Record<string, unknown>;
  /** The document as JSON text, ready to save as `.gltf`. */
  text: string;
  /** The separate buffer when `embed` is false and there is binary data, else null. */
  bin: Uint8Array|null;
  /** The URI the document uses for `bin`, else null. */
  binUri: string|null;
}

const FLOAT = 5126, UNSIGNED_SHORT = 5123, UNSIGNED_INT = 5125, ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
const same = (a: number[], b: number[]) => a.every((v, i) => Math.fround(v) === b[i]);
interface PrimitiveData {attributes: Record<string, number>; indices: number; targets?: Record<string, number>[]}

function floatData(values: ArrayLike<number>, count: number, label: string): Float32Array {
  if (!isObject(values) || values.length !== count) throw new TypeError(`${label} needs ${count} values`);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new RangeError(`${label} must be finite Float32 values`);
    out[i] = value;
  }
  return out;
}

class Writer {
  readonly parts: Uint8Array[] = [];
  length = 0;
  readonly json: Record<string, any> = {};
  private readonly geometryCache = new Map<Geo, PrimitiveData>();
  private readonly materialCache = new Map<Mat, number>();
  private readonly meshCache = new Map<Geo, Map<Mat|null, number>>();
  private readonly textureCache = new Map<TextureData, number>();
  private readonly imageCache = new Map<Uint8Array, number>();
  private readonly skinCache = new Map<SkinData, number>();

  private list(key: string, value: unknown): number {(this.json[key] ??= []).push(value); return this.json[key].length-1;}

  /** Appends bytes on a 4-byte boundary and returns a bufferView index. */
  private view(bytes: Uint8Array, target?: number): number {
    const byteOffset = this.length;
    this.parts.push(bytes);
    this.length += bytes.length;
    const pad = (4-this.length%4)%4;
    if (pad) {this.parts.push(new Uint8Array(pad)); this.length += pad;}
    const view: Record<string, number> = {buffer: 0, byteOffset, byteLength: bytes.length};
    if (target) view.target = target;
    return this.list('bufferViews', view);
  }

  private floatAccessor(data: Float32Array, size: number, type: string, bounds = false, target: number|null = ARRAY_BUFFER): number {
    const accessor: Record<string, unknown> = {bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), target ?? undefined), componentType: FLOAT, count: data.length/size, type};
    if (bounds) {
      const min = new Array(size).fill(Infinity), max = new Array(size).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {const c = i%size; if (data[i] < min[c]) min[c] = data[i]; if (data[i] > max[c]) max[c] = data[i];}
      accessor.min = min.map(v => v === 0 ? 0 : v); accessor.max = max.map(v => v === 0 ? 0 : v);
    }
    return this.list('accessors', accessor);
  }

  private primitive(geo: Geo): PrimitiveData {
    let cached = this.geometryCache.get(geo);
    if (cached) return cached;
    const attributes: Record<string, number> = {POSITION: this.floatAccessor(geo.positions, 3, 'VEC3', true), NORMAL: this.floatAccessor(geo.normals, 3, 'VEC3')};
    if (geo.tangents) attributes.TANGENT = this.floatAccessor(geo.tangents, 4, 'VEC4');
    if (geo.uvs) attributes.TEXCOORD_0 = this.floatAccessor(geo.uvs, 2, 'VEC2');
    if (geo.colors) attributes.COLOR_0 = this.floatAccessor(geo.colors, geo.colorSize, geo.colorSize === 3 ? 'VEC3' : 'VEC4');
    if (geo.joints) {
      const data = geo.joints;
      attributes.JOINTS_0 = this.list('accessors', {bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), ARRAY_BUFFER), componentType: UNSIGNED_SHORT, count: geo.count, type: 'VEC4'});
      attributes.WEIGHTS_0 = this.floatAccessor(geo.weights!, 4, 'VEC4');
    }
    // 65535 is the primitive restart value for 16-bit indices, so it forces 32-bit indices.
    const short = geo.count <= 65535, data = short ? Uint16Array.from(geo.indices) : geo.indices;
    const indices = this.list('accessors', {bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), ELEMENT_ARRAY_BUFFER), componentType: short ? UNSIGNED_SHORT : UNSIGNED_INT, count: data.length, type: 'SCALAR'});
    cached = {attributes, indices};
    if (geo.morphs) cached.targets = geo.morphs.map(morph => {
      const target: Record<string, number> = {POSITION: this.floatAccessor(morph.positions, 3, 'VEC3', true)};
      if (morph.normals) target.NORMAL = this.floatAccessor(morph.normals, 3, 'VEC3');
      if (morph.tangents) target.TANGENT = this.floatAccessor(morph.tangents, 3, 'VEC3');
      return target;
    });
    this.geometryCache.set(geo, cached);
    return cached;
  }

  private texture(texture: TextureData): number {
    let index = this.textureCache.get(texture);
    if (index !== undefined) return index;
    let source = this.imageCache.get(texture.image);
    if (source === undefined) {
      const image: Record<string, unknown> = {bufferView: this.view(texture.image.slice()), mimeType: texture.mimeType};
      if (texture.name) image.name = texture.name;
      source = this.list('images', image);
      this.imageCache.set(texture.image, source);
    }
    if (!this.json.samplers) this.list('samplers', {magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497});
    index = this.list('textures', {sampler: 0, source});
    this.textureCache.set(texture, index);
    return index;
  }

  private material(mat: Mat): number {
    let index = this.materialCache.get(mat);
    if (index !== undefined) return index;
    const pbr: Record<string, unknown> = {baseColorFactor: mat.color.map(Math.fround), metallicFactor: Math.fround(mat.metalness), roughnessFactor: Math.fround(mat.roughness)};
    if (mat.baseColorTexture) pbr.baseColorTexture = {index: this.texture(mat.baseColorTexture)};
    if (mat.metallicRoughnessTexture) pbr.metallicRoughnessTexture = {index: this.texture(mat.metallicRoughnessTexture)};
    const out: Record<string, unknown> = {};
    if (mat.name) out.name = mat.name;
    out.pbrMetallicRoughness = pbr;
    if (mat.normalTexture) out.normalTexture = {index: this.texture(mat.normalTexture)};
    if (mat.emissive.some(v => v !== 0)) out.emissiveFactor = mat.emissive.map(Math.fround);
    if (mat.alphaMode !== 'OPAQUE') out.alphaMode = mat.alphaMode;
    if (mat.alphaCutoff !== undefined) out.alphaCutoff = mat.alphaCutoff;
    if (mat.doubleSided) out.doubleSided = true;
    index = this.list('materials', out);
    this.materialCache.set(mat, index);
    return index;
  }

  mesh(geo: Geo, mat: Mat|undefined, name: string|undefined): number {
    if ((mat?.baseColorTexture || mat?.metallicRoughnessTexture || mat?.normalTexture) && !geo.uvs) throw new TypeError('Textured materials need geometry with uvs');
    let byMaterial = this.meshCache.get(geo);
    if (!byMaterial) this.meshCache.set(geo, byMaterial = new Map());
    let index = byMaterial.get(mat ?? null);
    if (index !== undefined) return index;
    const {attributes, indices, targets} = this.primitive(geo), primitive: Record<string, unknown> = {attributes, indices, mode: 4};
    if (targets) primitive.targets = targets;
    if (mat) primitive.material = this.material(mat);
    const mesh: Record<string, unknown> = {primitives: [primitive]};
    if (geo.morphs?.some(morph => morph.name !== undefined)) mesh.extras = {targetNames: geo.morphs.map((morph, i) => morph.name ?? 'Target '+i)};
    if (name) mesh.name = name;
    index = this.list('meshes', mesh);
    byMaterial.set(mat ?? null, index);
    return index;
  }

  node(name: string|undefined, t: number[], r: number[], s: number[], mesh?: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (name) out.name = name;
    if (mesh !== undefined) out.mesh = mesh;
    if (!same(t, [0, 0, 0])) out.translation = t.slice();
    if (!same(r, [0, 0, 0, 1])) out.rotation = r.slice();
    if (!same(s, [1, 1, 1])) out.scale = s.slice();
    return out;
  }

  skin(skin: SkinData, resolve: (node: ExportNode) => number): number {
    const cached = this.skinCache.get(skin);
    if (cached !== undefined) return cached;
    if (skin.name !== undefined && typeof skin.name !== 'string') throw new TypeError('Skin name must be a string');
    if (!Array.isArray(skin.joints) || !skin.joints.length || skin.joints.length > 65536 || new Set(skin.joints).size !== skin.joints.length) throw new TypeError('Skin joints must be distinct scene nodes');
    const joints = skin.joints.map(resolve), matrices = floatData(skin.inverseBindMatrices, joints.length*16, 'Inverse bind matrices');
    const parents = new Int32Array(this.json.nodes.length).fill(-1);
    this.json.nodes.forEach((node: {children?: number[]}, parent: number) => {for (const child of node.children ?? []) parents[child] = parent;});
    const root = (joint: number): number => {while (parents[joint] !== -1) joint = parents[joint]; return joint;};
    const common = root(joints[0]);
    if (joints.some(joint => root(joint) !== common)) throw new TypeError('Skin joints need a common hierarchy root');
    for (let i = 0; i < matrices.length; i += 16) if (matrices[i+3] !== 0 || matrices[i+7] !== 0 || matrices[i+11] !== 0 || matrices[i+15] !== 1) throw new RangeError('Inverse bind matrices must be affine');
    const out: Record<string, unknown> = {joints, inverseBindMatrices: this.floatAccessor(matrices, 16, 'MAT4', false, null)};
    if (skin.name) out.name = skin.name;
    const index = this.list('skins', out);
    this.skinCache.set(skin, index);
    return index;
  }

  animation(animation: AnimationData, resolve: (node: ExportNode) => number, lookup: Map<ExportNode, Node>): void {
    if (!isObject(animation) || !Array.isArray(animation.channels) || !animation.channels.length) throw new TypeError('Animation needs nonempty channels');
    if (animation.name !== undefined && typeof animation.name !== 'string') throw new TypeError('Animation name must be a string');
    const samplers: Record<string, unknown>[] = [], channels: Record<string, unknown>[] = [], destinations = new Set<string>();
    for (const channel of animation.channels) {
      if (!isObject(channel)) throw new TypeError('Animation channels must be objects');
      const node = resolve(channel.node), path = channel.path, interpolation = channel.interpolation ?? 'LINEAR';
      if (!['translation', 'rotation', 'scale', 'weights'].includes(path) || !['STEP', 'LINEAR', 'CUBICSPLINE'].includes(interpolation)) throw new TypeError('Invalid animation path or interpolation');
      const key = node+':'+path;
      if (destinations.has(key)) throw new TypeError('Duplicate animation target');
      destinations.add(key);
      const count = channel.times?.length;
      if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('Animation times must be nonempty');
      if (interpolation === 'CUBICSPLINE' && count < 2) throw new TypeError('Cubic animation needs at least two keys');
      const times = floatData(channel.times, count, 'Animation times');
      if (times.some((time, i) => time < 0 || i > 0 && time <= times[i-1])) throw new RangeError('Animation times must be nonnegative and strictly increasing Float32 values');
      const width = path === 'rotation' ? 4 : path === 'weights' ? lookup.get(channel.node)?.geometry?.morphs?.length ?? 0 : 3;
      if (!width) throw new TypeError('Animation weights need morph targets');
      const factor = interpolation === 'CUBICSPLINE' ? 3 : 1, values = floatData(channel.values, count*width*factor, 'Animation values');
      if (path === 'rotation') for (let i = 0; i < count; i++) {
        const at = (i*factor+(factor === 3 ? 1 : 0))*4, length = Math.hypot(values[at], values[at+1], values[at+2], values[at+3]);
        if (Math.abs(length-1) > 1e-4) throw new RangeError('Animation rotation values must be unit quaternions');
      }
      const input = this.floatAccessor(times, 1, 'SCALAR', true, null), output = this.floatAccessor(values, path === 'weights' ? 1 : width, path === 'rotation' ? 'VEC4' : path === 'weights' ? 'SCALAR' : 'VEC3', false, null);
      channels.push({sampler: samplers.length, target: {node, path}});
      samplers.push({input, output, interpolation});
    }
    const out: Record<string, unknown> = {samplers, channels};
    if (animation.name) out.name = animation.name;
    this.list('animations', out);
  }
}

/** Bakes a sheared world transform into a copy of the geometry. */
function bake(geo: Geo, m: Float64Array): Geo {
  const n = normalMatrix(m), positions = new Float32Array(geo.positions.length), normals = new Float32Array(geo.normals.length);
  for (let i = 0; i < geo.count; i++) {
    const x = geo.positions[i*3], y = geo.positions[i*3+1], z = geo.positions[i*3+2];
    for (let r = 0; r < 3; r++) positions[i*3+r] = m[r]*x+m[4+r]*y+m[8+r]*z+m[12+r];
    const nx = geo.normals[i*3], ny = geo.normals[i*3+1], nz = geo.normals[i*3+2];
    const v = [n[0]*nx+n[3]*ny+n[6]*nz, n[1]*nx+n[4]*ny+n[7]*nz, n[2]*nx+n[5]*ny+n[8]*nz], l = Math.hypot(v[0], v[1], v[2]) || 1;
    for (let r = 0; r < 3; r++) normals[i*3+r] = v[r]/l;
  }
  const out: Geo = {...geo, positions, normals};
  if (geo.tangents) {
    const tangents = new Float32Array(geo.tangents.length), flip = determinant3(m) < 0 ? -1 : 1;
    for (let i = 0; i < geo.count; i++) {
      const x = geo.tangents[i*4], y = geo.tangents[i*4+1], z = geo.tangents[i*4+2];
      const v = [m[0]*x+m[4]*y+m[8]*z, m[1]*x+m[5]*y+m[9]*z, m[2]*x+m[6]*y+m[10]*z], l = Math.hypot(v[0], v[1], v[2]) || 1;
      tangents.set([v[0]/l, v[1]/l, v[2]/l, geo.tangents[i*4+3]*flip], i*4);
    }
    out.tangents = tangents;
  }
  if (determinant3(m) < 0) {
    out.indices = geo.indices.slice();
    for (let i = 0; i < out.indices.length; i += 3) {const b = out.indices[i+1]; out.indices[i+1] = out.indices[i+2]; out.indices[i+2] = b;}
  }
  return out;
}

function document(source: ExportSource, options: GLTFOptions): Writer {
  const flatten = options.flatten ?? false, generator = options.generator ?? 'Margo Engine exporters';
  if (typeof flatten !== 'boolean') throw new TypeError('flatten must be boolean');
  if (typeof generator !== 'string') throw new TypeError('generator must be a string');
  const roots = collect(source, options), writer = new Writer(), json = writer.json, sceneNodes: number[] = [];
  const animations = Array.isArray((source as ExportScene).nodes) ? (source as ExportScene).animations : undefined;
  if (animations !== undefined && !Array.isArray(animations)) throw new TypeError('Animations must be an array');
  const nodeIndices = new Map<ExportNode, number>(), nodeData = new Map<ExportNode, Node>();
  const resolve = (node: ExportNode): number => {
    const index = nodeIndices.get(node);
    if (index === undefined) throw new TypeError('Skin joint or animation target is not an exported scene node');
    return index;
  };
  json.asset = {version: '2.0', generator};
  json.scene = 0;
  if (flatten) {
    const check = (node: Node): void => {
      if (node.skin || node.geometry?.joints || node.geometry?.morphs || node.morphWeights) throw new TypeError('Flatten does not support skins, morphs or animation');
      node.children.forEach(check);
    };
    roots.forEach(check);
    if (animations?.length) throw new TypeError('Flatten does not support skins, morphs or animation');
    for (const item of drawables(roots)) {
      const parts = decompose(item.world);
      const node = parts
        ? writer.node(item.name, parts.t, parts.r, parts.s, writer.mesh(item.geometry, item.material, item.name))
        : writer.node(item.name, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1], writer.mesh(bake(item.geometry, item.world), item.material, item.name));
      (json.nodes ??= []).push(node);
      sceneNodes.push(json.nodes.length-1);
    }
  } else {
    const visit = (node: Node): number => {
      if (node.geometry?.joints && !node.skin) throw new TypeError('Joint attributes need a skin on the same node');
      if (node.skin && !node.geometry?.joints) throw new TypeError('Skinned geometry needs joint indices and weights');
      const out = writer.node(node.name, node.t, node.r, node.s, node.geometry ? writer.mesh(node.geometry, node.material, node.name) : undefined);
      const index = (json.nodes ??= []).push(out)-1;
      if (node.source) {nodeIndices.set(node.source, index); nodeData.set(node.source, node);}
      if (node.morphWeights) out.weights = Array.from(node.morphWeights);
      if (node.children.length) out.children = node.children.map(visit);
      return index;
    };
    for (const root of roots) sceneNodes.push(visit(root));
    for (const [sourceNode, node] of nodeData) {
      if (node.skin) {
        if (!node.geometry?.joints) throw new TypeError('Skinned geometry needs joint indices and weights');
        const skin = writer.skin(node.skin, resolve);
        if (node.geometry.joints.some(joint => joint >= node.skin!.joints.length)) throw new RangeError('Joint index exceeds skin joints');
        json.nodes[resolve(sourceNode)].skin = skin;
      } else if (node.geometry?.joints) throw new TypeError('Joint attributes need a skin on the same node');
    }
    for (const animation of animations ?? []) writer.animation(animation, resolve, nodeData);
  }
  json.scenes = [sceneNodes.length ? {nodes: sceneNodes} : {}];
  if (writer.length) json.buffers = [{byteLength: writer.length}];
  // Stable key order: asset first, buffers last.
  const order = ['asset', 'scene', 'scenes', 'nodes', 'skins', 'animations', 'meshes', 'materials', 'textures', 'images', 'samplers', 'accessors', 'bufferViews', 'buffers'];
  const sorted: Record<string, any> = {};
  for (const key of order) if (json[key] !== undefined) sorted[key] = json[key];
  for (const key of Object.keys(json)) delete json[key];
  Object.assign(json, sorted);
  return writer;
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {out.set(part, offset); offset += part.length;}
  return out;
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** @internal Base64 without btoa or Buffer, so it runs anywhere. */
export function base64(bytes: Uint8Array): string {
  const out: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i+1], c = bytes[i+2], n = a << 16 | (b ?? 0) << 8 | (c ?? 0);
    chunk += alphabet[n >> 18 & 63]+alphabet[n >> 12 & 63]+(b === undefined ? '=' : alphabet[n >> 6 & 63])+(c === undefined ? '=' : alphabet[n & 63]);
    if (chunk.length >= 8192) {out.push(chunk); chunk = '';}
  }
  out.push(chunk);
  return out.join('');
}

/** Exports glTF 2.0 JSON with the binary data embedded as a data URI, or returned as a separate `.bin`. */
export function exportGLTF(source: ExportSource, options: GLTFJsonOptions = {}): GLTFJsonResult {
  const embed = options.embed ?? true, binUri = options.binUri ?? 'scene.bin';
  if (typeof embed !== 'boolean') throw new TypeError('embed must be boolean');
  if (typeof binUri !== 'string' || !binUri || /^[a-z][a-z0-9+.-]*:/i.test(binUri) || /[#?\\]/.test(binUri)) throw new TypeError('binUri must be a relative file name');
  const writer = document(source, options), json = writer.json;
  let bin: Uint8Array|null = null, uri: string|null = null;
  if (writer.length) {
    const data = concat(writer.parts, writer.length);
    if (embed) json.buffers[0].uri = `data:application/octet-stream;base64,${base64(data)}`;
    else {bin = data; uri = encodeURI(binUri); json.buffers[0].uri = uri;}
  }
  return {json, text: JSON.stringify(json), bin, binUri: uri};
}

/** Exports a binary glTF (`.glb`): 12-byte header, a space-padded JSON chunk and a zero-padded BIN chunk. */
export function exportGLB(source: ExportSource, options: GLTFOptions = {}): Uint8Array {
  const writer = document(source, options);
  const text = new TextEncoder().encode(JSON.stringify(writer.json)), jsonLength = Math.ceil(text.length/4)*4;
  const binLength = writer.length, total = 12+8+jsonLength+(binLength ? 8+binLength : 0);
  const out = new Uint8Array(total), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20); out.fill(0x20, 20+text.length, 20+jsonLength);
  if (binLength) {
    const at = 20+jsonLength;
    view.setUint32(at, binLength, true); view.setUint32(at+4, 0x004e4942, true);
    let offset = at+8;
    for (const part of writer.parts) {out.set(part, offset); offset += part.length;}
  }
  return out;
}
