// glTF 2.0 writer: the Margo Engine counterpart of Three.js GLTFExporter.
import {collect, decompose, determinant3, drawables, normalMatrix, type ExportSource, type Geo, type Mat, type Node, type SceneOptions, type TextureData} from './scene.js';

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

class Writer {
  readonly parts: Uint8Array[] = [];
  length = 0;
  readonly json: Record<string, any> = {};
  private readonly geometryCache = new Map<Geo, {attributes: Record<string, number>; indices: number}>();
  private readonly materialCache = new Map<Mat, number>();
  private readonly meshCache = new Map<Geo, Map<Mat|null, number>>();
  private readonly textureCache = new Map<TextureData, number>();
  private readonly imageCache = new Map<Uint8Array, number>();

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

  private floatAccessor(data: Float32Array, size: number, type: string, bounds = false): number {
    const accessor: Record<string, unknown> = {bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), ARRAY_BUFFER), componentType: FLOAT, count: data.length/size, type};
    if (bounds) {
      const min = new Array(size).fill(Infinity), max = new Array(size).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {const c = i%size; if (data[i] < min[c]) min[c] = data[i]; if (data[i] > max[c]) max[c] = data[i];}
      accessor.min = min.map(v => v === 0 ? 0 : v); accessor.max = max.map(v => v === 0 ? 0 : v);
    }
    return this.list('accessors', accessor);
  }

  private primitive(geo: Geo): {attributes: Record<string, number>; indices: number} {
    let cached = this.geometryCache.get(geo);
    if (cached) return cached;
    const attributes: Record<string, number> = {POSITION: this.floatAccessor(geo.positions, 3, 'VEC3', true), NORMAL: this.floatAccessor(geo.normals, 3, 'VEC3')};
    if (geo.tangents) attributes.TANGENT = this.floatAccessor(geo.tangents, 4, 'VEC4');
    if (geo.uvs) attributes.TEXCOORD_0 = this.floatAccessor(geo.uvs, 2, 'VEC2');
    if (geo.colors) attributes.COLOR_0 = this.floatAccessor(geo.colors, geo.colorSize, geo.colorSize === 3 ? 'VEC3' : 'VEC4');
    // 65535 is the primitive restart value for 16-bit indices, so it forces 32-bit indices.
    const short = geo.count <= 65535, data = short ? Uint16Array.from(geo.indices) : geo.indices;
    const indices = this.list('accessors', {bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), ELEMENT_ARRAY_BUFFER), componentType: short ? UNSIGNED_SHORT : UNSIGNED_INT, count: data.length, type: 'SCALAR'});
    cached = {attributes, indices};
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
    const {attributes, indices} = this.primitive(geo), primitive: Record<string, unknown> = {attributes, indices, mode: 4};
    if (mat) primitive.material = this.material(mat);
    const mesh: Record<string, unknown> = {primitives: [primitive]};
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
  json.asset = {version: '2.0', generator};
  json.scene = 0;
  if (flatten) {
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
      const out = writer.node(node.name, node.t, node.r, node.s, node.geometry ? writer.mesh(node.geometry, node.material, node.name) : undefined);
      const index = (json.nodes ??= []).push(out)-1;
      if (node.children.length) out.children = node.children.map(visit);
      return index;
    };
    for (const root of roots) sceneNodes.push(visit(root));
  }
  json.scenes = [sceneNodes.length ? {nodes: sceneNodes} : {}];
  if (writer.length) json.buffers = [{byteLength: writer.length}];
  // Stable key order: asset first, buffers last.
  const order = ['asset', 'scene', 'scenes', 'nodes', 'meshes', 'materials', 'textures', 'images', 'samplers', 'accessors', 'bufferViews', 'buffers'];
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

const alphabet = Uint8Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', c => c.charCodeAt(0));
/** @internal Base64 without btoa or Buffer, so it runs anywhere. Encodes to ASCII bytes, then decodes them in 1 MiB pieces. */
export function base64(bytes: Uint8Array): string {
  const length = bytes.length, whole = length-length%3, codes = new Uint8Array(Math.ceil(length/3)*4), decoder = new TextDecoder(), out: string[] = [];
  let i = 0, o = 0;
  for (; i < whole; i += 3, o += 4) {
    const n = bytes[i] << 16 | bytes[i+1] << 8 | bytes[i+2];
    codes[o] = alphabet[n >> 18]; codes[o+1] = alphabet[n >> 12 & 63]; codes[o+2] = alphabet[n >> 6 & 63]; codes[o+3] = alphabet[n & 63];
  }
  if (i < length) {
    const pair = i+1 < length, n = bytes[i] << 16 | (pair ? bytes[i+1] << 8 : 0);
    codes[o] = alphabet[n >> 18]; codes[o+1] = alphabet[n >> 12 & 63]; codes[o+2] = pair ? alphabet[n >> 6 & 63] : 61; codes[o+3] = 61;
  }
  for (let at = 0; at < codes.length; at += 1 << 20) out.push(decoder.decode(codes.subarray(at, at+(1 << 20))));
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
