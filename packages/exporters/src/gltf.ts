// glTF 2.0 writer: the Margo Engine counterpart of Three.js GLTFExporter.
import type { GLTFDocument } from '../../shared/gltf.js';
import { copyExtras } from './extras.js';
import {
  checkTexture,
  collect,
  decompose,
  determinant3,
  drawables,
  normalMatrix,
  isObject,
  samplerOf,
  type AnimationData,
  type AnimationChannelData,
  type CameraData,
  type ExportNode,
  type ExportScene,
  type ExportSource,
  type Geo,
  type LightData,
  type LightmapData,
  type Mat,
  type Node,
  type SceneOptions,
  type SkinData,
  type TextureData,
} from './scene.js';
import { cameraDefinition, lightDefinition } from './scene-metadata.js';

export interface GLTFOptions extends SceneOptions {
  /**
   * Write every mesh as a root node with its world transform instead of keeping the hierarchy, one node per
   * primitive; node and mesh extras, empty nodes and collapsed nodes are left out. Default false.
   */
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
  bin: Uint8Array | null;
  /** The URI the document uses for `bin`, else null. */
  binUri: string | null;
}

const FLOAT = 5126,
  UNSIGNED_SHORT = 5123,
  UNSIGNED_INT = 5125,
  ARRAY_BUFFER = 34962,
  ELEMENT_ARRAY_BUFFER = 34963;
const same = (a: number[], b: number[]) => a.every((v, i) => Math.fround(v) === b[i]);
const wraps = { repeat: 10497, clamp: 33071, mirror: 33648 };
interface PrimitiveData {
  attributes: Record<string, number>;
  indices: number;
  targets?: Record<string, number>[];
}

function floatData(values: ArrayLike<number>, count: number, label: string): Float32Array {
  if (!isObject(values) || values.length !== count) throw new TypeError(`${label} needs ${count} values`);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)))
      throw new RangeError(`${label} must be finite Float32 values`);
    out[i] = value;
  }
  return out;
}

type MeshItem = { geometry: Geo; material?: Mat; extras?: object };
const textureSlots = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
] as const;

class Writer {
  readonly parts: Uint8Array[] = [];
  length = 0;
  readonly json = {} as Required<GLTFDocument>;
  private readonly geometryCache = new Map<Geo, PrimitiveData>();
  private readonly attributeCache = new Map<
    Geo,
    { attributes: Record<string, number>; targets?: Record<string, number>[] }
  >();
  private readonly materialCache = new Map<Mat, number>();
  private readonly meshCache = new Map<Geo, Map<Mat | null, number>>();
  private readonly namedMeshes = new Map<
    object,
    { material: Mat | null; name?: string; extras?: object; index: number }[]
  >();
  private readonly textureCache = new Map<TextureData, number>();
  private readonly imageCache = new Map<Uint8Array, number>();
  private readonly skinCache = new Map<SkinData, number>();
  private readonly cache = new Map<unknown, number>();
  readonly used = new Set<string>();

  private memo(key: unknown, make: () => number): number {
    let index = this.cache.get(key);
    if (index === undefined) this.cache.set(key, (index = make()));
    return index;
  }

  private list(key: string, value: unknown): number {
    const list = (this.json[key] ??= []) as unknown[];
    list.push(value);
    return list.length - 1;
  }

  /** Appends bytes on a 4-byte boundary and returns a bufferView index. */
  private view(bytes: Uint8Array, target?: number): number {
    const byteOffset = this.length;
    this.parts.push(bytes);
    this.length += bytes.length;
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const view: Record<string, number> = { buffer: 0, byteOffset, byteLength: bytes.length };
    if (target) view.target = target;
    return this.list('bufferViews', view);
  }

  private floatAccessor(
    data: Float32Array,
    size: number,
    type: string,
    bounds = false,
    target: number | null = ARRAY_BUFFER,
  ): number {
    const accessor: Record<string, unknown> = {
      bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), target ?? undefined),
      componentType: FLOAT,
      count: data.length / size,
      type,
    };
    if (bounds) {
      const min = new Array(size).fill(Infinity),
        max = new Array(size).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const c = i % size;
        if (data[i] < min[c]) min[c] = data[i];
        if (data[i] > max[c]) max[c] = data[i];
      }
      accessor.min = min.map((v) => (v === 0 ? 0 : v));
      accessor.max = max.map((v) => (v === 0 ? 0 : v));
    }
    return this.list('accessors', accessor);
  }

  private primitive(geo: Geo): PrimitiveData {
    let cached = this.geometryCache.get(geo);
    if (cached) return cached;
    // Primitives cut from one geometry share its vertex attributes and morph targets; each has its own indices.
    const owner = geo.base ?? geo;
    let shared = this.attributeCache.get(owner);
    const fresh = !shared;
    if (!shared) {
      const attributes: Record<string, number> = {
        POSITION: this.floatAccessor(owner.positions, 3, 'VEC3', true),
        NORMAL: this.floatAccessor(owner.normals, 3, 'VEC3'),
      };
      if (owner.tangents) attributes.TANGENT = this.floatAccessor(owner.tangents, 4, 'VEC4');
      if (owner.uvs) attributes.TEXCOORD_0 = this.floatAccessor(owner.uvs, 2, 'VEC2');
      if (owner.uvs1) attributes.TEXCOORD_1 = this.floatAccessor(owner.uvs1, 2, 'VEC2');
      if (owner.colors)
        attributes.COLOR_0 = this.floatAccessor(owner.colors, owner.colorSize, owner.colorSize === 3 ? 'VEC3' : 'VEC4');
      if (owner.joints) {
        const data = owner.joints;
        attributes.JOINTS_0 = this.list('accessors', {
          bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), ARRAY_BUFFER),
          componentType: UNSIGNED_SHORT,
          count: owner.count,
          type: 'VEC4',
        });
        attributes.WEIGHTS_0 = this.floatAccessor(owner.weights!, 4, 'VEC4');
      }
      shared = { attributes };
      this.attributeCache.set(owner, shared);
    }
    // 65535 is the primitive restart value for 16-bit indices, so it forces 32-bit indices.
    const short = geo.count <= 65535,
      data = short ? Uint16Array.from(geo.indices) : geo.indices;
    const indices = this.list('accessors', {
      bufferView: this.view(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(),
        ELEMENT_ARRAY_BUFFER,
      ),
      componentType: short ? UNSIGNED_SHORT : UNSIGNED_INT,
      count: data.length,
      type: 'SCALAR',
    });
    if (fresh && owner.morphs)
      shared.targets = owner.morphs.map((morph) => {
        const target: Record<string, number> = { POSITION: this.floatAccessor(morph.positions, 3, 'VEC3', true) };
        if (morph.normals) target.NORMAL = this.floatAccessor(morph.normals, 3, 'VEC3');
        if (morph.tangents) target.TANGENT = this.floatAccessor(morph.tangents, 3, 'VEC3');
        return target;
      });
    cached = { attributes: shared.attributes, indices };
    if (shared.targets) cached.targets = shared.targets;
    this.geometryCache.set(geo, cached);
    return cached;
  }

  /** A textureInfo: the texture, its UV set and `more` (scale, strength) when given. */
  private info(texture: TextureData, more?: Record<string, number>): Record<string, unknown> {
    const out: Record<string, unknown> = { index: this.texture(texture) };
    if (texture.texCoord) out.texCoord = texture.texCoord;
    return more ? { ...out, ...more } : out;
  }

  texture(texture: TextureData): number {
    let index = this.textureCache.get(texture);
    if (index !== undefined) return index;
    let source = this.imageCache.get(texture.image);
    if (source === undefined) {
      const image: Record<string, unknown> = {
        bufferView: this.view(texture.image.slice()),
        mimeType: texture.mimeType,
      };
      if (texture.name) image.name = texture.name;
      source = this.list('images', image);
      this.imageCache.set(texture.image, source);
    }
    const s = samplerOf(texture),
      nearest = s.minFilter === 'nearest',
      sampler = {
        magFilter: s.magFilter === 'nearest' ? 9728 : 9729,
        minFilter: s.mipmaps ? (nearest ? 9984 : 9987) : nearest ? 9728 : 9729,
        wrapS: wraps[s.wrapS],
        wrapT: wraps[s.wrapT],
      };
    const definition: Record<string, unknown> = {
        sampler: this.memo(JSON.stringify(sampler), () => this.list('samplers', sampler)),
        source,
      },
      extras = copyExtras(texture.extras, 'Texture extras');
    if (extras) definition.extras = extras;
    index = this.list('textures', definition);
    this.textureCache.set(texture, index);
    return index;
  }

  private material(mat: Mat): number {
    let index = this.materialCache.get(mat);
    if (index !== undefined) return index;
    const pbr: Record<string, unknown> = {
      baseColorFactor: mat.color.map(Math.fround),
      metallicFactor: Math.fround(mat.metalness),
      roughnessFactor: Math.fround(mat.roughness),
    };
    if (mat.baseColorTexture) pbr.baseColorTexture = this.info(mat.baseColorTexture);
    if (mat.metallicRoughnessTexture) pbr.metallicRoughnessTexture = this.info(mat.metallicRoughnessTexture);
    const out: Record<string, unknown> = {};
    if (mat.name) out.name = mat.name;
    out.pbrMetallicRoughness = pbr;
    if (mat.normalTexture)
      out.normalTexture = this.info(mat.normalTexture, mat.normalScale !== 1 ? { scale: mat.normalScale } : undefined);
    if (mat.occlusionTexture)
      out.occlusionTexture = this.info(
        mat.occlusionTexture,
        mat.occlusionStrength !== 1 ? { strength: mat.occlusionStrength } : undefined,
      );
    if (mat.emissiveTexture) out.emissiveTexture = this.info(mat.emissiveTexture);
    if (mat.emissive.some((v) => v !== 0)) out.emissiveFactor = mat.emissive.map(Math.fround);
    if (mat.alphaMode !== 'OPAQUE') out.alphaMode = mat.alphaMode;
    if (mat.alphaCutoff !== undefined) out.alphaCutoff = mat.alphaCutoff;
    if (mat.doubleSided) out.doubleSided = true;
    const extensions: Record<string, unknown> = {};
    if (mat.unlit) extensions.KHR_materials_unlit = {};
    if (mat.transmission > 0) extensions.KHR_materials_transmission = { transmissionFactor: mat.transmission };
    if (mat.ior !== 1.5) extensions.KHR_materials_ior = { ior: mat.ior };
    if (mat.emissiveStrength !== 1)
      extensions.KHR_materials_emissive_strength = { emissiveStrength: mat.emissiveStrength };
    for (const name in extensions) this.used.add(name);
    if (Object.keys(extensions).length) out.extensions = extensions;
    const extras = copyExtras(mat.extras, 'Material extras');
    if (extras) out.extras = extras;
    index = this.list('materials', out);
    this.materialCache.set(mat, index);
    return index;
  }

  mesh(geo: Geo, mat: Mat | undefined, name: string | undefined): number {
    let byMaterial = this.meshCache.get(geo);
    if (!byMaterial) this.meshCache.set(geo, (byMaterial = new Map()));
    let index = byMaterial.get(mat ?? null);
    if (index !== undefined) return index;
    index = this.meshPrimitives([{ geometry: geo, material: mat }], name);
    byMaterial.set(mat ?? null, index);
    return index;
  }

  /** The mesh of a hierarchy node: shared by nodes with the same geometry or primitives, name and mesh extras. */
  nodeMesh(node: Node): number | undefined {
    const items: MeshItem[] | undefined =
      node.primitives ?? (node.geometry ? [{ geometry: node.geometry, material: node.material }] : undefined);
    if (!items) return undefined;
    const key = node.primitivesKey ?? (node.primitives ? undefined : node.geometry);
    if (!key) return this.meshPrimitives(items, node.name);
    if (!node.primitivesKey && node.meshName === undefined && !node.meshExtras)
      return this.mesh(node.geometry!, node.material, node.name);
    const material = node.primitivesKey ? null : (node.material ?? null),
      entries = this.namedMeshes.get(key) ?? [],
      found = entries.find(
        (entry) => entry.material === material && entry.name === node.meshName && entry.extras === node.meshExtras,
      );
    if (found) return found.index;
    const index = this.meshPrimitives(items, node.meshName ?? node.name, node.meshExtras);
    entries.push({ material, name: node.meshName, extras: node.meshExtras, index });
    this.namedMeshes.set(key, entries);
    return index;
  }

  meshPrimitives(items: MeshItem[], name: string | undefined, meshExtras?: object): number {
    const primitives = items.map(({ geometry, material, extras: source }) => {
      for (const slot of textureSlots) {
        const texture = material?.[slot];
        if (texture && !(texture.texCoord === 1 ? geometry.uvs1 : geometry.uvs))
          throw new TypeError(
            texture.texCoord === 1
              ? 'Textures sampled with texCoord 1 need geometry with uvs1'
              : 'Textured materials need geometry with uvs',
          );
      }
      const { attributes, indices, targets } = this.primitive(geometry),
        primitive: Record<string, unknown> = { attributes, indices, mode: 4 };
      if (targets) primitive.targets = targets;
      if (material) primitive.material = this.material(material);
      const extras = copyExtras(source, 'Primitive extras');
      if (extras) primitive.extras = extras;
      return primitive;
    });
    const mesh: Record<string, unknown> = { primitives },
      geo = items[0].geometry;
    if (geo.morphs?.some((morph) => morph.name !== undefined))
      mesh.extras = { targetNames: geo.morphs.map((morph, i) => morph.name ?? 'Target ' + i) };
    const extras = copyExtras(meshExtras, 'Mesh extras');
    if (extras) mesh.extras = { ...(mesh.extras as object), ...extras };
    if (name) mesh.name = name;
    return this.list('meshes', mesh);
  }

  camera(camera: CameraData): number {
    return this.memo(camera, () => this.list('cameras', cameraDefinition(camera)));
  }

  /** A KHR_lights_punctual light index. */
  light(light: LightData): number {
    return this.memo(light, () => {
      this.used.add('KHR_lights_punctual');
      const lights = (((this.json.extensions ??= {}) as Record<string, { lights: unknown[] }>).KHR_lights_punctual ??= {
        lights: [],
      }).lights;
      return lights.push(lightDefinition(light)) - 1;
    });
  }

  node(
    name: string | undefined,
    t: number[],
    r: number[],
    s: number[],
    mesh?: number,
    matrix?: number[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (name) out.name = name;
    if (mesh !== undefined) out.mesh = mesh;
    if (matrix) {
      if (!same(matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) out.matrix = matrix.slice();
      return out;
    }
    if (!same(t, [0, 0, 0])) out.translation = t.slice();
    if (!same(r, [0, 0, 0, 1])) out.rotation = r.slice();
    if (!same(s, [1, 1, 1])) out.scale = s.slice();
    return out;
  }

  skin(skin: SkinData, resolve: (node: ExportNode) => number): number {
    const cached = this.skinCache.get(skin);
    if (cached !== undefined) return cached;
    if (skin.name !== undefined && typeof skin.name !== 'string') throw new TypeError('Skin name must be a string');
    if (
      !Array.isArray(skin.joints) ||
      !skin.joints.length ||
      skin.joints.length > 65536 ||
      new Set(skin.joints).size !== skin.joints.length
    )
      throw new TypeError('Skin joints must be distinct scene nodes');
    const joints = skin.joints.map(resolve),
      matrices = floatData(skin.inverseBindMatrices, joints.length * 16, 'Inverse bind matrices');
    const parents = new Int32Array(this.json.nodes.length).fill(-1);
    this.json.nodes.forEach((node: { children?: number[] }, parent: number) => {
      for (const child of node.children ?? []) parents[child] = parent;
    });
    const root = (joint: number): number => {
      while (parents[joint] !== -1) joint = parents[joint];
      return joint;
    };
    const common = root(joints[0]);
    if (joints.some((joint) => root(joint) !== common)) throw new TypeError('Skin joints need a common hierarchy root');
    for (let i = 0; i < matrices.length; i += 16)
      if (matrices[i + 3] !== 0 || matrices[i + 7] !== 0 || matrices[i + 11] !== 0 || matrices[i + 15] !== 1)
        throw new RangeError('Inverse bind matrices must be affine');
    const out: Record<string, unknown> = {
      joints,
      inverseBindMatrices: this.floatAccessor(matrices, 16, 'MAT4', false, null),
    };
    if (skin.name) out.name = skin.name;
    if (skin.skeleton !== undefined) {
      const skeleton = resolve(skin.skeleton);
      const above = (joint: number): boolean => {
        for (let at = joint; at !== -1; at = parents[at]) if (at === skeleton) return true;
        return false;
      };
      if (!joints.every(above)) throw new TypeError('Skin skeleton must be an ancestor of (or one of) its joints');
      out.skeleton = skeleton;
    }
    const extras = copyExtras(skin.extras, 'Skin extras');
    if (extras) out.extras = extras;
    const index = this.list('skins', out);
    this.skinCache.set(skin, index);
    return index;
  }

  animation(animation: AnimationData, resolve: (node: ExportNode) => number, lookup: Map<ExportNode, Node>): void {
    if (!isObject(animation) || !Array.isArray(animation.channels) || !animation.channels.length)
      throw new TypeError('Animation needs nonempty channels');
    if (animation.name !== undefined && typeof animation.name !== 'string')
      throw new TypeError('Animation name must be a string');
    const samplers: Record<string, unknown>[] = [],
      channels: Record<string, unknown>[] = [],
      destinations = new Set<string>();
    for (const channel of animation.channels as readonly AnimationChannelData[]) {
      if (!isObject(channel)) throw new TypeError('Animation channels must be objects');
      const node = resolve(channel.node),
        path = channel.path,
        interpolation = channel.interpolation ?? 'LINEAR';
      if (lookup.get(channel.node)?.matrix && path !== 'weights')
        throw new TypeError('An animated node needs translation, rotation and scale, not matrix');
      if (
        !['translation', 'rotation', 'scale', 'weights'].includes(path) ||
        !['STEP', 'LINEAR', 'CUBICSPLINE'].includes(interpolation)
      )
        throw new TypeError('Invalid animation path or interpolation');
      const key = node + ':' + path;
      if (destinations.has(key)) throw new TypeError('Duplicate animation target');
      destinations.add(key);
      const count = channel.times?.length;
      if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('Animation times must be nonempty');
      if (interpolation === 'CUBICSPLINE' && count < 2) throw new TypeError('Cubic animation needs at least two keys');
      const times = floatData(channel.times, count, 'Animation times');
      if (times.some((time, i) => time < 0 || (i > 0 && time <= times[i - 1])))
        throw new RangeError('Animation times must be nonnegative and strictly increasing Float32 values');
      const width =
        path === 'rotation' ? 4 : path === 'weights' ? (lookup.get(channel.node)?.geometry?.morphs?.length ?? 0) : 3;
      if (!width) throw new TypeError('Animation weights need morph targets');
      const factor = interpolation === 'CUBICSPLINE' ? 3 : 1,
        values = floatData(channel.values, count * width * factor, 'Animation values');
      if (path === 'rotation')
        for (let i = 0; i < count; i++) {
          const at = (i * factor + (factor === 3 ? 1 : 0)) * 4,
            length = Math.hypot(values[at], values[at + 1], values[at + 2], values[at + 3]);
          if (Math.abs(length - 1) > 1e-4) throw new RangeError('Animation rotation values must be unit quaternions');
        }
      const input = this.floatAccessor(times, 1, 'SCALAR', true, null),
        output = this.floatAccessor(
          values,
          path === 'weights' ? 1 : width,
          path === 'rotation' ? 'VEC4' : path === 'weights' ? 'SCALAR' : 'VEC3',
          false,
          null,
        );
      channels.push({ sampler: samplers.length, target: { node, path } });
      samplers.push({ input, output, interpolation });
    }
    const out: Record<string, unknown> = { samplers, channels };
    if (animation.name) out.name = animation.name;
    const extras = copyExtras(animation.extras, 'Animation extras');
    if (extras) out.extras = extras;
    this.list('animations', out);
  }
}

/** Bakes a sheared world transform into a copy of the geometry. */
function bake(geo: Geo, m: Float64Array): Geo {
  const n = normalMatrix(m),
    positions = new Float32Array(geo.positions.length),
    normals = new Float32Array(geo.normals.length);
  for (let i = 0; i < geo.count; i++) {
    const x = geo.positions[i * 3],
      y = geo.positions[i * 3 + 1],
      z = geo.positions[i * 3 + 2];
    for (let r = 0; r < 3; r++) positions[i * 3 + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
    const nx = geo.normals[i * 3],
      ny = geo.normals[i * 3 + 1],
      nz = geo.normals[i * 3 + 2];
    const v = [n[0] * nx + n[3] * ny + n[6] * nz, n[1] * nx + n[4] * ny + n[7] * nz, n[2] * nx + n[5] * ny + n[8] * nz],
      l = Math.hypot(v[0], v[1], v[2]) || 1;
    for (let r = 0; r < 3; r++) normals[i * 3 + r] = v[r] / l;
  }
  const out: Geo = { ...geo, positions, normals };
  if (geo.tangents) {
    const tangents = new Float32Array(geo.tangents.length),
      flip = determinant3(m) < 0 ? -1 : 1;
    for (let i = 0; i < geo.count; i++) {
      const x = geo.tangents[i * 4],
        y = geo.tangents[i * 4 + 1],
        z = geo.tangents[i * 4 + 2];
      const v = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z],
        l = Math.hypot(v[0], v[1], v[2]) || 1;
      tangents.set([v[0] / l, v[1] / l, v[2] / l, geo.tangents[i * 4 + 3] * flip], i * 4);
    }
    out.tangents = tangents;
  }
  if (determinant3(m) < 0) {
    out.indices = geo.indices.slice();
    for (let i = 0; i < out.indices.length; i += 3) {
      const b = out.indices[i + 1];
      out.indices[i + 1] = out.indices[i + 2];
      out.indices[i + 2] = b;
    }
  }
  return out;
}

function document(source: ExportSource, options: GLTFOptions): Writer {
  const flatten = options.flatten ?? false,
    generator = options.generator ?? 'Margo Engine exporters';
  if (typeof flatten !== 'boolean') throw new TypeError('flatten must be boolean');
  if (typeof generator !== 'string') throw new TypeError('generator must be a string');
  const roots = collect(source, options),
    writer = new Writer(),
    json = writer.json,
    sceneNodes: number[] = [];
  const animations = Array.isArray((source as ExportScene).nodes) ? (source as ExportScene).animations : undefined;
  if (animations !== undefined && !Array.isArray(animations)) throw new TypeError('Animations must be an array');
  const nodeIndices = new Map<ExportNode, number>(),
    nodeData = new Map<ExportNode, Node>();
  const resolve = (node: ExportNode): number => {
    const index = nodeIndices.get(node);
    if (index === undefined) throw new TypeError('Skin joint or animation target is not an exported scene node');
    return index;
  };
  json.asset = { version: '2.0', generator };
  json.scene = 0;
  if (flatten) {
    const check = (node: Node): void => {
      if (node.skin || node.geometry?.joints || node.geometry?.morphs || node.morphWeights)
        throw new TypeError('Flatten does not support skins, morphs or animation');
      if (node.camera || node.light)
        throw new TypeError('Flatten does not support cameras or lights; keep the hierarchy');
      node.children.forEach(check);
    };
    roots.forEach(check);
    if (animations?.length) throw new TypeError('Flatten does not support skins, morphs or animation');
    for (const item of drawables(roots)) {
      const parts = decompose(item.world);
      const node = parts
        ? writer.node(item.name, parts.t, parts.r, parts.s, writer.mesh(item.geometry, item.material, item.name))
        : writer.node(
            item.name,
            [0, 0, 0],
            [0, 0, 0, 1],
            [1, 1, 1],
            writer.mesh(bake(item.geometry, item.world), item.material, item.name),
          );
      (json.nodes ??= []).push(node);
      sceneNodes.push(json.nodes.length - 1);
    }
  } else {
    const visit = (node: Node): number => {
      const geometries =
        node.primitives?.map((primitive) => primitive.geometry) ?? (node.geometry ? [node.geometry] : []);
      if (geometries.some((geometry) => geometry.joints) && !node.skin)
        throw new TypeError('Joint attributes need a skin on the same node');
      if (node.skin && (!geometries.length || geometries.some((geometry) => !geometry.joints)))
        throw new TypeError('Skinned geometry needs joint indices and weights');
      const out = writer.node(node.name, node.t, node.r, node.s, writer.nodeMesh(node), node.matrix);
      const index = (json.nodes ??= []).push(out) - 1;
      if (node.source) {
        nodeIndices.set(node.source, index);
        nodeData.set(node.source, node);
      }
      if (node.morphWeights) out.weights = Array.from(node.morphWeights);
      if (node.camera) out.camera = writer.camera(node.camera);
      if (node.light) out.extensions = { KHR_lights_punctual: { light: writer.light(node.light) } };
      const extras = copyExtras(node.extras, 'Node extras');
      if (extras) out.extras = extras;
      if (node.children.length) out.children = node.children.map(visit);
      return index;
    };
    for (const root of roots) sceneNodes.push(visit(root));
    for (const [sourceNode, node] of nodeData) {
      if (node.skin) {
        if (!node.geometry?.joints) throw new TypeError('Skinned geometry needs joint indices and weights');
        const skin = writer.skin(node.skin, resolve);
        const geometries = node.primitives?.map((primitive) => primitive.geometry) ?? [node.geometry];
        if (geometries.some((geometry) => geometry.joints!.some((joint) => joint >= node.skin!.joints.length)))
          throw new RangeError('Joint index exceeds skin joints');
        json.nodes[resolve(sourceNode)].skin = skin;
      } else if (node.geometry?.joints) throw new TypeError('Joint attributes need a skin on the same node');
    }
    for (const animation of animations ?? []) writer.animation(animation, resolve, nodeData);
  }
  const data = Array.isArray((source as ExportScene).nodes) ? (source as ExportScene) : undefined,
    scene: Record<string, unknown> = {};
  if (data?.scene !== undefined) {
    if (!isObject(data.scene)) throw new TypeError('scene must be an object');
    if (data.scene.name !== undefined && typeof data.scene.name !== 'string')
      throw new TypeError('Scene name must be a string');
    if (data.scene.name) scene.name = data.scene.name;
  }
  if (sceneNodes.length) scene.nodes = sceneNodes;
  const sceneExtras = copyExtras(data?.scene?.extras, 'Scene extras');
  if (sceneExtras) scene.extras = sceneExtras;
  json.scenes = [scene];
  if (data?.asset !== undefined) {
    if (!isObject(data.asset)) throw new TypeError('asset must be an object');
    const { copyright } = data.asset;
    if (copyright !== undefined && typeof copyright !== 'string')
      throw new TypeError('Asset copyright must be a string');
    if (copyright) json.asset.copyright = copyright;
    const extras = copyExtras(data.asset.extras, 'Asset extras');
    if (extras) json.asset.extras = extras;
  }
  const extras = copyExtras(data?.extras, 'Scene root extras') ?? {};
  if (data?.lightmap !== undefined) lightmap(writer, data.lightmap, roots, extras);
  if (Object.keys(extras).length) (json as Record<string, unknown>).extras = extras;
  if (writer.used.size) json.extensionsUsed = [...writer.used];
  if (writer.length) json.buffers = [{ byteLength: writer.length }];
  // Stable key order: asset first, buffers last.
  const order = [
    'asset',
    'extensionsUsed',
    'extensions',
    'scene',
    'scenes',
    'nodes',
    'cameras',
    'skins',
    'animations',
    'meshes',
    'materials',
    'textures',
    'images',
    'samplers',
    'accessors',
    'bufferViews',
    'buffers',
    'extras',
  ];
  const sorted: Record<string, unknown> = {};
  for (const key of order) if (json[key] !== undefined) sorted[key] = json[key];
  for (const key of Object.keys(json)) delete json[key];
  Object.assign(json, sorted);
  return writer;
}

/** Writes the lightmap texture and its record under the root `extras[key]`. */
function lightmap(writer: Writer, data: LightmapData, roots: Node[], extras: Record<string, unknown>): void {
  if (!isObject(data)) throw new TypeError('lightmap must be an object');
  const texture = checkTexture(data.texture, 'Lightmap texture'),
    texCoord = data.texCoord ?? 1,
    key = data.key ?? 'lightmap',
    more = copyExtras(data.extras, 'Lightmap extras') ?? {};
  if (!texture) throw new TypeError('Lightmap needs a texture');
  if (texCoord !== 0 && texCoord !== 1) throw new RangeError('Lightmap texCoord must be 0 or 1');
  if (typeof key !== 'string' || !key) throw new TypeError('Lightmap key must be a nonempty string');
  if (key in extras) throw new TypeError(`Root extras already hold ${key}; give the lightmap another key`);
  if ('texture' in more || 'texCoord' in more)
    throw new TypeError('Lightmap extras cannot set texture or texCoord; the writer records them');
  for (const { geometry } of drawables(roots))
    if (!(texCoord ? geometry.uvs1 : geometry.uvs))
      throw new TypeError(`Lightmap texCoord ${texCoord} needs ${texCoord ? 'uvs1' : 'uvs'} on every mesh`);
  extras[key] = { texture: writer.texture(texture), texCoord, ...more };
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** @internal Base64 without btoa or Buffer, so it runs anywhere. */
export function base64(bytes: Uint8Array): string {
  const out: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i],
      b = bytes[i + 1],
      c = bytes[i + 2],
      n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    chunk +=
      alphabet[(n >> 18) & 63] +
      alphabet[(n >> 12) & 63] +
      (b === undefined ? '=' : alphabet[(n >> 6) & 63]) +
      (c === undefined ? '=' : alphabet[n & 63]);
    if (chunk.length >= 8192) {
      out.push(chunk);
      chunk = '';
    }
  }
  out.push(chunk);
  return out.join('');
}

/** Exports glTF 2.0 JSON with the binary data embedded as a data URI, or returned as a separate `.bin`. */
export function exportGLTF(source: ExportSource, options: GLTFJsonOptions = {}): GLTFJsonResult {
  const embed = options.embed ?? true,
    binUri = options.binUri ?? 'scene.bin';
  if (typeof embed !== 'boolean') throw new TypeError('embed must be boolean');
  if (typeof binUri !== 'string' || !binUri || /^[a-z][a-z0-9+.-]*:/i.test(binUri) || /[#?\\]/.test(binUri))
    throw new TypeError('binUri must be a relative file name');
  const writer = document(source, options),
    json = writer.json;
  let bin: Uint8Array | null = null,
    uri: string | null = null;
  if (writer.length) {
    const data = concat(writer.parts, writer.length);
    if (embed) json.buffers[0].uri = `data:application/octet-stream;base64,${base64(data)}`;
    else {
      bin = data;
      uri = encodeURI(binUri);
      json.buffers[0].uri = uri;
    }
  }
  return { json, text: JSON.stringify(json), bin, binUri: uri };
}

/** Exports a binary glTF (`.glb`): 12-byte header, a space-padded JSON chunk and a zero-padded BIN chunk. */
export function exportGLB(source: ExportSource, options: GLTFOptions = {}): Uint8Array {
  const writer = document(source, options);
  const text = new TextEncoder().encode(JSON.stringify(writer.json)),
    jsonLength = Math.ceil(text.length / 4) * 4;
  const binLength = writer.length,
    total = 12 + 8 + jsonLength + (binLength ? 8 + binLength : 0);
  const out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (binLength) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, 0x004e4942, true);
    let offset = at + 8;
    for (const part of writer.parts) {
      out.set(part, offset);
      offset += part.length;
    }
  }
  return out;
}
