// glTF 2.0 / GLB export of gltf-pro models (loaded glTF and @margoengine/materials meshes): the Margo Engine counterpart
// of three.js GLTFExporter for PBR content. Writes the live node transforms, visibility, materials and morph weights,
// with skins, morph targets, animation clips, EXT_mesh_gpu_instancing, textures and the KHR material extensions
// gltf-pro renders. Accessors are re-written from the decoded data gltf-pro uses, so a re-import reads the same values.
import type { PBRModel, PBRMaterial, PBRPrimitive as ModelPrimitive } from '@margoengine/gltf-pro';
import type {
  GLTFMesh,
  GLTFSkin,
  GLTFNode,
  GLTFInstancing,
  GLTFSampler,
  GLTFImageDefinition,
} from '../../shared/gltf.js';
import type { PNGSource } from './png.js';
type PBRPrimitive = ModelPrimitive & { instances?: { count: number; data: Float32Array } };
import { Bin, ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, type GLTFJsonResult } from './container.js';
import { decompose } from './scene.js';
export type { GLTFJsonResult } from './container.js';

/** One animation channel. `node` indexes `model.nodes`; `values` holds one value per key (three per key for CUBICSPLINE). */
export interface ExportTrack {
  node: number;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  times: ArrayLike<number>;
  values: ArrayLike<number>;
  interpolation?: 'STEP' | 'LINEAR' | 'CUBICSPLINE';
}
export interface ExportClip {
  name?: string;
  tracks: readonly ExportTrack[];
}
/** A model and its clips; an @margoengine/animation `Animation` fits as it is. */
export interface ExportAnimation {
  model: PBRModel;
  clips: readonly ExportClip[];
}

export interface ModelExportOptions {
  /** Return GLB bytes (true) or a `.gltf` result (false, default), as three.js GLTFExporter. */
  binary?: boolean;
  /** Clips to write, e.g. `[animation]` for an @margoengine/animation `Animation`. Default none. */
  animations?: readonly ExportAnimation[];
  /** Skip hidden nodes and their descendants. Default true. */
  onlyVisible?: boolean;
  /** false keeps a loaded image's external `uri` instead of embedding it. Default true. */
  embedImages?: boolean;
  /** Re-encode larger images (as PNG) to fit this size; needs OffscreenCanvas. Default Infinity. */
  maxTextureSize?: number;
  /** `asset.generator`. Default 'Margo Engine exporters'. */
  generator?: string;
  /** `.gltf` only: embed the buffer as a data URI (default) or return it as `bin`. */
  embed?: boolean;
  /** `.gltf` only: the separate buffer's relative file name. Default 'scene.bin'. */
  binUri?: string;
}

type Json = Record<string, unknown>;
const clean = <T extends Json>(o: T): T => {
  for (const k in o) if (o[k] === undefined) delete o[k];
  return o;
};
const scaled = (info: Json | undefined, key: string, value: number) =>
  info && value !== 1 ? { ...info, [key]: value } : info;
const slots = ['map', 'metalRoughnessMap', 'normalMap', 'aoMap', 'emissiveMap'] as const;
interface PixelTexture {
  source: PNGSource;
  isVideo?: boolean;
  options?: {
    mipmaps?: boolean;
    minFilter?: string;
    magFilter?: string;
    wrapS?: string;
    wrapT?: string;
    flipY?: boolean;
  };
}
type TextureOwner = Partial<Record<(typeof slots)[number], PixelTexture>> & { shading?: string };
const wraps: Record<string, number> = { repeat: 10497, clamp: 33071, mirror: 33648 };

class Writer extends Bin {
  readonly used = new Set<string>();
  readonly required = new Set<string>();
  /** Images (and their source and flipY) whose PNG bytes are encoded after the synchronous walk. */
  readonly pending: [GLTFImageDefinition, PNGSource, boolean][] = [];
  private readonly cache = new Map<unknown, number>();
  constructor(
    private readonly embedImages: boolean,
    private readonly maxSize: number,
  ) {
    super();
  }

  memo(key: unknown, make: () => number): number {
    let i = this.cache.get(key);
    if (i === undefined) this.cache.set(key, (i = make()));
    return i;
  }

  /** A source accessor as gltf-pro decodes it: floats, JOINTS as unsigned ints, WEIGHTS normalized per vertex. */
  private data(model: PBRModel, id: number, name: string): number {
    const values = model.asset.accessor(id),
      type = model.asset.doc.accessors![id].type;
    return this.memo(values, () => {
      if (name.startsWith('JOINTS_')) {
        let max = 0;
        for (const v of values) if (v > max) max = v;
        return this.accessor(values, type, max < 256 ? 5121 : 5123, ARRAY_BUFFER);
      }
      if (name.startsWith('WEIGHTS_')) {
        // gltf-pro divides by the sum when skinning; written normalized so validators accept unnormalized sources.
        const w = new Float32Array(values.length);
        for (let i = 0; i < w.length; i += 4) {
          const s = values[i] + values[i + 1] + values[i + 2] + values[i + 3];
          for (let k = 0; k < 4; k++) w[i + k] = s > 0 ? values[i + k] / s : values[i + k];
        }
        return this.accessor(w, type, FLOAT, ARRAY_BUFFER);
      }
      return this.accessor(values, type, FLOAT, ARRAY_BUFFER, name === 'POSITION');
    });
  }

  private primitive(model: PBRModel, p: PBRPrimitive): Json {
    const def = p.definition,
      // Attribute names come from the source file: a null prototype keeps `__proto__` an ordinary key.
      attributes: Record<string, number> = Object.create(null),
      out: Json = { attributes },
      count = p.vertices.length / 20;
    if (def.attributes)
      for (const name in def.attributes) attributes[name] = this.data(model, def.attributes[name], name);
    else {
      // Packed 80-byte vertices (materials meshes): position, normal, tangent, uv0, uv1 (= uv0), color.
      const v = p.vertices,
        column = (at: number, width: number) => {
          const o = new Float32Array(count * width);
          for (let i = 0; i < count; i++) for (let k = 0; k < width; k++) o[i * width + k] = v[i * 20 + at + k];
          return o;
        };
      const tangents = column(8, 4),
        uvs = column(12, 2),
        colors = column(16, 4);
      attributes.POSITION = this.accessor(column(0, 3), 'VEC3', FLOAT, ARRAY_BUFFER, true);
      attributes.NORMAL = this.accessor(column(4, 3), 'VEC3', FLOAT, ARRAY_BUFFER);
      if (tangents.some((x, i) => i % 4 === 3 && x))
        attributes.TANGENT = this.accessor(tangents, 'VEC4', FLOAT, ARRAY_BUFFER);
      if (uvs.some((x) => x)) attributes.TEXCOORD_0 = this.accessor(uvs, 'VEC2', FLOAT, ARRAY_BUFFER);
      if (colors.some((x) => x !== 1)) attributes.COLOR_0 = this.accessor(colors, 'VEC4', FLOAT, ARRAY_BUFFER);
    }
    // 65535 is the primitive restart value for 16-bit indices.
    if (def.indices !== undefined || !def.attributes)
      out.indices = this.memo(def.attributes ? model.asset.accessor(def.indices) : p.indices, () =>
        this.accessor(p.indices, 'SCALAR', count <= 65535 ? 5123 : 5125, ELEMENT_ARRAY_BUFFER),
      );
    if (def.material !== undefined) out.material = this.material(model, p.material);
    if (def.targets?.length)
      out.targets = def.targets.map((t: Record<string, number>) =>
        Object.fromEntries(Object.entries(t).map(([k, id]) => [k, this.data(model, id, k)])),
      );
    return out;
  }

  mesh(model: PBRModel, docMesh: GLTFMesh, primitives: PBRPrimitive[]): number {
    return this.memo(docMesh, () =>
      this.list(
        'meshes',
        clean({
          name: docMesh.name,
          primitives: primitives.map((p) => this.primitive(model, p)),
          extras: docMesh.extras,
        }),
      ),
    );
  }

  /** Live values from gltf-pro's material record (shared with an @margoengine/materials Material). */
  private material(model: PBRModel, m: PBRMaterial): number {
    return this.memo(m, () => {
      const owner = (model as { material?: TextureOwner }).material,
        e = m.extensions ?? {},
        t = (i: number) => this.textureInfo(model, m, i, owner),
        P = m.physical,
        ext: Json = {};
      const [roughness, metallic, normalScale, occlusion] = m.factors,
        mode = ['OPAQUE', 'MASK', 'BLEND'][m.settings[0]];
      // gltf-pro holds emissiveFactor * strength; factors above 1 move into KHR_materials_emissive_strength.
      const strength = Math.max(e.KHR_materials_emissive_strength?.emissiveStrength ?? 1, ...m.emission);
      if (strength !== 1) ext.KHR_materials_emissive_strength = { emissiveStrength: strength };
      if (m.ext![0] || owner?.shading === 'basic') ext.KHR_materials_unlit = {};
      if (e.KHR_materials_ior || m.ext![1] !== 1.5) ext.KHR_materials_ior = { ior: m.ext![1] };
      if (P && e.KHR_materials_clearcoat)
        ext.KHR_materials_clearcoat = clean({
          clearcoatFactor: P[0],
          clearcoatRoughnessFactor: P[1],
          clearcoatTexture: t(5),
          clearcoatRoughnessTexture: t(6),
          clearcoatNormalTexture: scaled(t(7), 'scale', P[2]),
        });
      if (P && e.KHR_materials_transmission)
        ext.KHR_materials_transmission = clean({ transmissionFactor: P[3], transmissionTexture: t(8) });
      if (P && e.KHR_materials_sheen)
        ext.KHR_materials_sheen = clean({
          sheenColorFactor: P.slice(8, 11),
          sheenRoughnessFactor: P[11],
          sheenColorTexture: t(9),
          sheenRoughnessTexture: t(10),
        });
      if (P && e.KHR_materials_specular)
        ext.KHR_materials_specular = clean({
          specularFactor: P[7],
          specularColorFactor: P.slice(4, 7),
          specularTexture: t(11),
          specularColorTexture: t(12),
        });
      const v = e.KHR_materials_volume;
      if (v)
        ext.KHR_materials_volume = clean({
          thicknessFactor: v.thicknessFactor,
          attenuationDistance: v.attenuationDistance,
          attenuationColor: v.attenuationColor,
        });
      for (const name in ext) this.used.add(name);
      return this.list(
        'materials',
        clean({
          name: m.name,
          pbrMetallicRoughness: clean({
            baseColorFactor: [...m.base],
            metallicFactor: metallic,
            roughnessFactor: roughness,
            baseColorTexture: t(0),
            metallicRoughnessTexture: t(1),
          }),
          normalTexture: scaled(t(2), 'scale', normalScale),
          occlusionTexture: scaled(t(3), 'strength', occlusion),
          emissiveTexture: t(4),
          emissiveFactor: m.emission.some((x: number) => x) ? m.emission.map((x: number) => x / strength) : undefined,
          alphaMode: mode === 'OPAQUE' ? undefined : mode,
          alphaCutoff: mode === 'MASK' && m.settings[1] !== 0.5 ? m.settings[1] : undefined,
          doubleSided: m.settings[2] ? true : undefined,
          extensions: Object.keys(ext).length ? ext : undefined,
          extras: m.extras,
        }),
      );
    });
  }

  /** Texture info for map slot `i` (gltf-pro order), with its KHR_texture_transform taken back out of the material's UV rows. */
  private textureInfo(model: PBRModel, m: PBRMaterial, i: number, owner: TextureOwner | undefined): Json | undefined {
    const map = m.maps[i],
      texture = i < 5 ? owner?.[slots[i]] : undefined;
    if (!map && !texture) return undefined;
    const info: Json = { index: map ? this.docTexture(model, map.index) : this.pixelTexture(texture!) };
    if (map?.texCoord) info.texCoord = map.texCoord;
    // Rows: [cos*sx, sin*sy, offset x, uv set], [-sin*sx, cos*sy, offset y, 0].
    const [a0, a1, x, , b0, b1, y] = m.uvt!.slice(i * 8, i * 8 + 8);
    if (a0 !== 1 || a1 || x || b0 || b1 !== 1 || y) {
      const r = Math.atan2(-b0, a0),
        c = Math.cos(r),
        s = Math.sin(r);
      info.extensions = {
        KHR_texture_transform: clean({
          offset: x || y ? [x, y] : undefined,
          rotation: r || undefined,
          scale: [a0 * c - b0 * s, a1 * s + b1 * c],
        }),
      };
      this.used.add('KHR_texture_transform');
    }
    return info;
  }

  private sampler(def: GLTFSampler): number {
    const s = clean({ magFilter: def.magFilter, minFilter: def.minFilter, wrapS: def.wrapS, wrapT: def.wrapT });
    return this.memo(JSON.stringify(s), () => this.list('samplers', s));
  }

  /** A texture of the loaded document, with its sampler and every image source it names. */
  private docTexture(model: PBRModel, index: number): number {
    const doc = model.asset.doc,
      def = doc.textures![index];
    return this.memo(def, () => {
      const out: Json = {},
        ext: Json = {};
      if (def.sampler !== undefined) out.sampler = this.sampler(doc.samplers![def.sampler]);
      if (def.source !== undefined) out.source = this.docImage(model, def.source);
      for (const name of ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'] as const) {
        const source = def.extensions?.[name]?.source;
        if (source === undefined) continue;
        ext[name] = { source: this.docImage(model, source) };
        this.used.add(name);
        if (def.source === undefined) this.required.add(name);
      }
      if (Object.keys(ext).length) out.extensions = ext;
      return this.list('textures', out);
    });
  }

  /** The loaded image's encoded bytes as they are; re-encoded from the decoded image only to fit maxTextureSize or when no bytes were kept. */
  private docImage(model: PBRModel, index: number): number {
    const def = model.asset.doc.images![index],
      decoded = model['images'][index];
    return this.memo(def, () => {
      const out: Json = clean({ name: def.name }),
        uri = /^data:([^;,]*);base64,(.*)$/s.exec(def.uri ?? '');
      const bytes =
        def.bufferView !== undefined
          ? model.asset.view(def.bufferView)
          : uri
            ? Uint8Array.from(atob(uri[2]), (c) => c.charCodeAt(0))
            : undefined;
      const big = decoded && !('mipmaps' in decoded) && Math.max(decoded.width, decoded.height) > this.maxSize;
      if (bytes && !big) {
        out.mimeType = def.mimeType ?? (uri?.[1] || (bytes[0] === 0x89 ? 'image/png' : 'image/jpeg'));
        out.bufferView = this.view(bytes.slice());
      } else if (!bytes && !this.embedImages) out.uri = def.uri;
      else if (decoded && !('mipmaps' in decoded) && !('ktx2' in decoded)) this.encode(out, decoded, false);
      else throw new Error(`glTF image ${index} has neither encoded bytes nor decoded pixels to embed`);
      return this.list('images', out);
    });
  }

  /** An @margoengine/materials Texture: its sampler options and its pixels as PNG, flipped back to glTF's v-down rows. */
  private pixelTexture(texture: PixelTexture): number {
    return this.memo(texture, () => {
      const o = texture.options ?? {},
        mips = o.mipmaps ?? !texture.isVideo,
        nearest = o.minFilter === 'nearest',
        image: Json = {};
      const sampler = this.sampler({
        magFilter: o.magFilter === 'nearest' ? 9728 : 9729,
        minFilter: mips ? (nearest ? 9984 : 9987) : nearest ? 9728 : 9729,
        wrapS: wraps[o.wrapS ?? 'clamp'],
        wrapT: wraps[o.wrapT ?? 'clamp'],
      });
      this.encode(image, texture.source, o.flipY ?? true);
      return this.list('textures', { sampler, source: this.list('images', image) });
    });
  }

  private encode(image: GLTFImageDefinition, source: PNGSource, flipY: boolean): void {
    image.mimeType = 'image/png';
    this.pending.push([image, source, flipY]);
  }

  skin(model: PBRModel, def: GLTFSkin, map: Int32Array): number {
    return this.memo(def, () => {
      const joints = def.joints.map((j: number) => {
        if (map[j] < 0) throw new RangeError('A skin joint is hidden; export with onlyVisible: false');
        return map[j];
      });
      return this.list(
        'skins',
        clean({
          name: def.name,
          joints,
          skeleton: def.skeleton !== undefined && map[def.skeleton] >= 0 ? map[def.skeleton] : undefined,
          inverseBindMatrices:
            def.inverseBindMatrices === undefined
              ? undefined
              : this.accessor(model.asset.accessor(def.inverseBindMatrices), 'MAT4'),
        }),
      );
    });
  }

  /** EXT_mesh_gpu_instancing: each drawn instance's node-space matrix as TRS, and its tint as `_COLOR_0` (three.js convention). */
  instances(inst: NonNullable<PBRPrimitive['instances']>): GLTFInstancing {
    const n = inst.count,
      t = new Float32Array(n * 3),
      r = new Float32Array(n * 4),
      s = new Float32Array(n * 3),
      d = inst.data;
    for (let i = 0; i < n; i++) {
      const m = Float64Array.from(d.subarray(i * 24, i * 24 + 16)),
        parts =
          decompose(m) ??
          ([0, 4, 8].some((c) => !Math.hypot(m[c], m[c + 1], m[c + 2]))
            ? { t: [m[12], m[13], m[14]], r: [0, 0, 0, 1], s: [0, 0, 0] }
            : null);
      if (!parts) throw new RangeError('Instance matrices must not shear');
      t.set(parts.t, i * 3);
      r.set(parts.r, i * 4);
      s.set(parts.s, i * 3);
    }
    const attributes: Record<string, number> = {
      TRANSLATION: this.accessor(t, 'VEC3'),
      ROTATION: this.accessor(r, 'VEC4'),
      SCALE: this.accessor(s, 'VEC3'),
    };
    const tint = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) tint[i] = d[(i >> 2) * 24 + 16 + (i & 3)];
    if (tint.some((v) => v !== 1)) attributes._COLOR_0 = this.accessor(tint, 'VEC4');
    this.used.add('EXT_mesh_gpu_instancing');
    return { attributes };
  }
}

/** Local translation, rotation and scale from the engine's transform store, defaults left out. */
function trs(node: PBRModel['root']): Json {
  const t = node.engine.store.transforms,
    id = node.id,
    out: Json = {},
    r = [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
    s = [t.sx[id], t.sy[id], t.sz[id]];
  if (t.x[id] || t.y[id] || t.z[id]) out.translation = [t.x[id], t.y[id], t.z[id]];
  if (r[0] || r[1] || r[2] || r[3] !== 1) out.rotation = r;
  if (s.some((v) => v !== 1)) out.scale = s;
  return out;
}

/**
 * Exports gltf-pro models (from loadGLTF/parseGLTF, or @margoengine/materials `createMesh`) as glTF 2.0: the hierarchy
 * with live transforms, meshes, materials and textures, skins, morph targets and weights, instancing, and `animations`.
 * `binary: true` resolves to GLB bytes, otherwise to the `.gltf` result. Async because textures without encoded bytes
 * are PNG-encoded. The clip writer and the PNG encoder load with import() only when needed.
 */
export function exportModel(
  models: PBRModel | readonly PBRModel[],
  options: ModelExportOptions & { binary: true },
): Promise<Uint8Array>;
export function exportModel(
  models: PBRModel | readonly PBRModel[],
  options?: ModelExportOptions & { binary?: false },
): Promise<GLTFJsonResult>;
export function exportModel(
  models: PBRModel | readonly PBRModel[],
  options?: ModelExportOptions,
): Promise<Uint8Array | GLTFJsonResult>;
export async function exportModel(
  models: PBRModel | readonly PBRModel[],
  options: ModelExportOptions = {},
): Promise<Uint8Array | GLTFJsonResult> {
  const list: readonly PBRModel[] = Array.isArray(models) ? models : [models as PBRModel];
  const {
    binary = false,
    animations = [],
    onlyVisible = true,
    embedImages = true,
    maxTextureSize = Infinity,
    generator = 'Margo Engine exporters',
  } = options;
  if (
    [binary, onlyVisible, embedImages].some((v) => typeof v !== 'boolean') ||
    typeof generator !== 'string' ||
    !Array.isArray(animations)
  )
    throw new TypeError('Invalid export options');
  if (!(maxTextureSize >= 1)) throw new RangeError('maxTextureSize must be at least 1');
  if (!list.length || list.some((m) => !m?.asset?.doc || !Array.isArray(m.nodes) || m.disposed))
    throw new TypeError('Expected live gltf-pro models');
  const w = new Writer(embedImages, maxTextureSize),
    json = w.json,
    maps = new Map<PBRModel, Int32Array>(),
    roots: number[] = [];
  json.asset = { version: '2.0', generator };
  for (const model of list) {
    const doc = model.asset.doc,
      defs: GLTFNode[] = doc.nodes ?? [],
      map = new Int32Array(defs.length).fill(-1),
      store = model.root.engine.store;
    const hidden = (node: PBRModel['root']) => onlyVisible && !!store.hidden[node.id];
    maps.set(model, map);
    if (hidden(model.root)) continue;
    const parent = new Int32Array(defs.length).fill(-1);
    defs.forEach((d, i) => d.children?.forEach((c: number) => (parent[c] = i)));
    // The active scene, as PBRModel builds it, keeping the document's node order (so node indices survive a round trip).
    const scene: number[] = doc.scenes
        ? (doc.scenes[doc.scene ?? 0].nodes ?? [])
        : defs.map((_, i) => i).filter((i) => parent[i] < 0),
      kept: number[] = [];
    const keep = (i: number) => {
      if (!hidden(model.nodes[i])) {
        kept.push(i);
        defs[i].children?.forEach(keep);
      }
    };
    scene.forEach(keep);
    for (const i of kept.sort((a, b) => a - b)) {
      const node = model.nodes[i],
        out = trs(node);
      if (node.name) out.name = node.name;
      if (defs[i].extras) out.extras = defs[i].extras;
      map[i] = w.list('nodes', out);
    }
    for (const i of kept) {
      const children = (defs[i].children ?? []).map((c: number) => map[c]).filter((c: number) => c >= 0);
      if (children.length) json.nodes[map[i]].children = children;
    }
    // model.root's own transform becomes a wrapper node.
    const top = scene.map((i) => map[i]).filter((i) => i >= 0),
      wrapper = trs(model.root);
    roots.push(...(top.length && Object.keys(wrapper).length ? [w.list('nodes', { ...wrapper, children: top })] : top));
    // Meshes, skins and instancing once every kept node has its index.
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i],
        primitives = model.primitives.filter((p) => p.nodeIndex === i),
        inst = (primitives[0] as PBRPrimitive | undefined)?.instances,
        out = json.nodes?.[map[i]];
      if (map[i] < 0 || !primitives.length || (inst && !inst.count)) continue;
      out.mesh = w.mesh(model, doc.meshes![def.mesh!], primitives);
      if (primitives[0].weights.length) out.weights = Array.from(primitives[0].weights);
      if (def.skin !== undefined) out.skin = w.skin(model, doc.skins![def.skin], map);
      if (inst) out.extensions = { EXT_mesh_gpu_instancing: w.instances(inst) };
    }
  }
  if (animations.some((a) => !maps.has(a?.model)))
    throw new TypeError('Animated models must be among the exported models');
  if (animations.length) {
    const { writeAnimation } = await import('./animation.js');
    for (const { model, clips } of animations) for (const clip of clips) writeAnimation(w, clip, maps.get(model)!);
  }
  json.scene = 0;
  json.scenes = [roots.length ? { nodes: roots } : {}];
  if (w.pending.length) {
    const { png } = await import('./png.js');
    for (const [image, source, flipY] of w.pending) image.bufferView = w.view(await png(source, maxTextureSize, flipY));
  }
  if (w.used.size) json.extensionsUsed = [...w.used];
  if (w.required.size) json.extensionsRequired = [...w.required];
  w.finish();
  return binary ? w.glb() : w.gltf(options.embed, options.binUri);
}
