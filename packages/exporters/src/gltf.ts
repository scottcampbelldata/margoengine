// glTF 2.0 writer: the Margo Engine counterpart of Three.js GLTFExporter.
import {collect, decompose, determinant3, drawables, normalMatrix, type ExportSource, type Geo, type Mat, type Node, type SceneOptions, type TextureData} from './scene.js';
import {Bin, ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, type GLTFJsonResult} from './container.js';
export type {GLTFJsonResult} from './container.js';

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

const same = (a: number[], b: number[]) => a.every((v, i) => Math.fround(v) === b[i]);

class Writer extends Bin {
  private readonly geometryCache = new Map<Geo, {attributes: Record<string, number>; indices: number}>();
  private readonly materialCache = new Map<Mat, number>();
  private readonly meshCache = new Map<Geo, Map<Mat|null, number>>();
  private readonly textureCache = new Map<TextureData, number>();
  private readonly imageCache = new Map<Uint8Array, number>();

  private primitive(geo: Geo): {attributes: Record<string, number>; indices: number} {
    let cached = this.geometryCache.get(geo);
    if (cached) return cached;
    const attributes: Record<string, number> = {POSITION: this.accessor(geo.positions, 'VEC3', undefined, ARRAY_BUFFER, true), NORMAL: this.accessor(geo.normals, 'VEC3', undefined, ARRAY_BUFFER)};
    if (geo.tangents) attributes.TANGENT = this.accessor(geo.tangents, 'VEC4', undefined, ARRAY_BUFFER);
    if (geo.uvs) attributes.TEXCOORD_0 = this.accessor(geo.uvs, 'VEC2', undefined, ARRAY_BUFFER);
    if (geo.colors) attributes.COLOR_0 = this.accessor(geo.colors, geo.colorSize === 3 ? 'VEC3' : 'VEC4', undefined, ARRAY_BUFFER);
    // 65535 is the primitive restart value for 16-bit indices, so it forces 32-bit indices.
    const indices = this.accessor(geo.indices, 'SCALAR', geo.count <= 65535 ? 5123 : 5125, ELEMENT_ARRAY_BUFFER);
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
  writer.finish();
  return writer;
}

/** Exports glTF 2.0 JSON with the binary data embedded as a data URI, or returned as a separate `.bin`. */
export function exportGLTF(source: ExportSource, options: GLTFJsonOptions = {}): GLTFJsonResult {
  const embed = options.embed ?? true, binUri = options.binUri ?? 'scene.bin';
  new Bin().gltf(embed, binUri); // validates both before the scene walk
  return document(source, options).gltf(embed, binUri);
}

/** Exports a binary glTF (`.glb`): 12-byte header, a space-padded JSON chunk and a zero-padded BIN chunk. */
export function exportGLB(source: ExportSource, options: GLTFOptions = {}): Uint8Array {
  return document(source, options).glb();
}
