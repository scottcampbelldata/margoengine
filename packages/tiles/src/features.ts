/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, EnginePlugin } from '@margoengine/core';
import type { PBRModel, PBRPrimitive, MaterialExtension } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { SRGBToLinear } from '@margoengine/math/color';
import { readStructuralMetadata, type FeatureIdSet, type PropertyTable } from './metadata.js';
import type { TilesDecorationContext, TilesContentDecoration, TilesContentDecorator } from './renderer.js';
import { rawAccessor } from './raw-accessor.js';
import { applyUV, uvRows, uvRowsWGSL } from './uv-transform.js';
import { dataURI } from './data-uri.js';
import type { TilesetTile } from './tileset.js';
import {
  featureImage,
  checkFeatureImage,
  metadataTexel,
  textureFeatureId,
  type FeatureImage,
  type TextureWrap,
} from './feature-texture.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** A model ray hit, as returned by the optional bvh package. No bvh runtime is imported here. */
export interface TileFeaturePick {
  readonly model?: unknown;
  readonly primitive?: unknown;
  readonly primitiveIndex?: number;
  readonly faceIndex: number;
  readonly barycoord: readonly number[];
  readonly instanceId?: number;
}
/** A picked feature. IDs are scoped to content and feature set, rather than being global scene IDs. */
export interface TileFeature {
  readonly id: number;
  readonly set: number;
  readonly label?: string;
  readonly tile: TilesetTile;
  readonly model: PBRModel;
  readonly primitive: PBRPrimitive;
  readonly properties: Readonly<Record<string, unknown>>;
}
/** Feature controller options. */
export interface TileFeaturesOptions {
  /** Feature set index or label. Default: first set. */
  set?: number | string;
  /** Original packed bytes for precision-sensitive decoded feature accessors. */
  accessor?: (model: PBRModel, index: number) => Uint8Array | undefined;
  /** Optional preceding decoration, such as TilesStyle.decorate. Its lifetime follows the same tile. */
  decorate?: TilesContentDecorator;
  /** Supply original linear RGBA8 data for a texture. Default: retained model image decoded with Canvas 2D. */
  image?: (model: PBRModel, texture: number) => FeatureImage | Promise<FeatureImage>;
}
interface SetInfo {
  ids?: ArrayLike<number>;
  texture?: NonNullable<FeatureIdSet['texture']>;
  table?: PropertyTable;
  nullFeatureId?: number;
  label?: string;
  index: number;
}
interface Entry {
  context: TilesDecorationContext & { kind: 'model' | 'instances' | 'splats' };
  model: PBRModel;
  primitive: PBRPrimitive;
  sets: SetInfo[];
  saved: { vertices: Float32Array; indices: Uint32Array; uvs?: Float32Array };
  owners?: Uint32Array;
  extension?: MaterialExtension;
  texture?: GPUTexture;
  material: PBRPrimitive['material'];
  geometry?: boolean;
  textureBytes?: number;
  colors?: Float32Array;
}
let count = 0;
/**
 * Streaming feature resolution and highlight. Pass `decorate` to TilesRenderer and feed `resolve` a model ray hit.
 * The controller owns no picking engine: bvh's existing raycasts supply the surface hit and instance row.
 */
export class TileFeatures implements EnginePlugin, Disposable {
  /** Creates a registered feature controller. Defaults match the constructor. */
  static attach(engine: EngineKernel, options: TileFeaturesOptions = {}): TileFeatures {
    return new TileFeatures(engine, options);
  }
  readonly name = `tile-features-${++count}`;
  private readonly entries = new Map<PBRPrimitive, Entry>();
  private disposed = false;
  private current?: { feature: TileFeature; color: readonly number[] };
  private readonly images = new WeakMap<PBRModel, Map<number, FeatureImage>>();
  constructor(
    private readonly engine: EngineKernel,
    private readonly options: TileFeaturesOptions = {},
  ) {
    engine.use(this);
  }
  setup(engine: EngineKernel): void {
    if (engine !== this.engine)
      throw new MargoError('attached', 'TileFeatures belongs to another engine; create a controller for this engine');
  }
  private check(): void {
    if (this.disposed) throw new MargoError('disposed', 'TileFeatures is disposed; create a new controller');
  }
  /** Registers loaded content, and removes it before eviction. Uses the existing renderer decorator hook. */
  readonly decorate = async (context: TilesDecorationContext): Promise<TilesContentDecoration> => {
    this.check();
    context.signal?.throwIfAborted();
    const prior = await this.options.decorate?.(context),
      made: Entry[] = [];
    try {
      this.check();
      context.signal?.throwIfAborted();
      if (context.kind === 'points') return prior ?? { bytes: 0, dispose() {} };
      const model = context.model as PBRModel;
      const bytes = context.kind === 'model' || context.kind === 'splats' ? context.content.gltf : undefined;
      const metadata = bytes
        ? readStructuralMetadata(bytes, {
            buffer: (i) => model.asset.buffers[i],
            accessor: (i) => rawAccessor(model.asset, i, { accessor: (i) => this.options.accessor?.(model, i) }),
          })
        : undefined;
      for (const primitive of model.primitives) {
        let sets: SetInfo[] = [];
        if (context.kind === 'instances') {
          const c = context.content,
            ids = c.featureTable.property(
              'BATCH_ID',
              c.length,
              1,
              (
                c.featureTable.json.BATCH_ID as
                  | { componentType?: 'UNSIGNED_BYTE' | 'UNSIGNED_SHORT' | 'UNSIGNED_INT' }
                  | undefined
              )?.componentType ?? 'UNSIGNED_SHORT',
            );
          sets = [{ ids: ids ?? Uint32Array.from({ length: c.length }, (_, i) => i), index: 0 }];
        } else {
          const mesh = model.asset.doc.meshes?.findIndex((m) => m.primitives.includes(primitive.definition)) ?? -1,
            index = model.asset.doc.meshes?.[mesh]?.primitives.indexOf(primitive.definition) ?? -1;
          sets = (metadata?.primitives[mesh]?.[index] ?? []).map((s, i) => ({
            ...s,
            table: s.propertyTable,
            index: i,
          }));
          if (!sets.length) {
            const attribute = primitive.definition.attributes?._BATCHID ?? primitive.definition.attributes?._BATCH_ID;
            sets = [
              {
                index: 0,
                ids:
                  attribute === undefined
                    ? new Uint32Array(
                        primitive.part
                          ? primitive.part.vertexMap.reduce((a, b) => Math.max(a, b), 0) + 1
                          : primitive.vertices.length / 20,
                      )
                    : this.rawIds(model, attribute),
              },
            ];
          }
        }
        const entry: Entry = {
          context,
          model,
          primitive,
          sets,
          saved: { vertices: primitive.vertices, indices: primitive.indices, uvs: primitive.uvs },
          extension: primitive.extension,
          material: primitive.material,
          colors: primitive.instances?.data.slice(),
        };
        this.entries.set(primitive, entry);
        made.push(entry);
        for (const set of sets) if (set.texture) await this.prepareImage(entry, set);
      }
      this.check();
      context.signal?.throwIfAborted();
    } catch (error) {
      for (const entry of made) this.entries.delete(entry.primitive);
      prior?.dispose();
      throw error;
    }
    return {
      get bytes() {
        return (
          (prior?.bytes ?? 0) +
          made.reduce(
            (sum, e) =>
              sum +
              (e.textureBytes ?? 0) +
              (e.primitive.extension?.factors?.byteLength ?? 0) -
              (e.extension?.factors?.byteLength ?? 0),
            0,
          )
        );
      },
      dispose: () => {
        for (const entry of made) {
          this.restore(entry);
          this.entries.delete(entry.primitive);
          if (this.current?.feature.primitive === entry.primitive) this.current = undefined;
        }
        prior?.dispose();
      },
    };
  };
  private rawIds(model: PBRModel, index: number): Uint32Array {
    const bytes = rawAccessor(model.asset, index, { accessor: (i) => this.options.accessor?.(model, i) }),
      definition = model.asset.doc.accessors![index];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      type = definition.componentType;
    // EXT_mesh_features allows FLOAT feature IDs and legacy b3dm _BATCHID is commonly FLOAT (5126).
    return Uint32Array.from({ length: definition.count }, (_, i) => {
      const id =
        type === 5121
          ? view.getUint8(i)
          : type === 5123
            ? view.getUint16(i * 2, true)
            : type === 5126
              ? view.getFloat32(i * 4, true)
              : view.getUint32(i * 4, true);
      if (!Number.isInteger(id) || id < 0)
        throw new TypeError('Feature ID attribute holds a non-integer ID; store whole non-negative feature IDs');
      return id;
    });
  }
  private selected(entry: Entry): SetInfo | undefined {
    const set = this.options.set ?? 0;
    return typeof set === 'string' ? entry.sets.find((s) => s.label === set) : entry.sets[set];
  }
  private image(entry: Entry, set: SetInfo): FeatureImage {
    const image = this.images.get(entry.model)?.get(set.texture!.index);
    if (!image)
      throw new MargoError(
        'state',
        'Feature ID image is not ready; wait for tile loading before resolving its feature',
      );
    return image;
  }
  private async prepareImage(entry: Entry, set: SetInfo): Promise<void> {
    const index = set.texture!.index,
      texture = entry.model.asset.doc.textures?.[index];
    if (!texture) throw new TypeError('Feature ID texture is missing; correct the glTF texture index');
    let cache = this.images.get(entry.model);
    if (!cache) this.images.set(entry.model, (cache = new Map()));
    if (cache.has(index)) return;
    let image = await this.options.image?.(entry.model, index);
    if (!image) {
      const source = texture.extensions?.KHR_texture_basisu?.source ?? texture.source;
      const definition = entry.model.asset.doc.images?.[source ?? -1];
      let bytes: Uint8Array | undefined;
      if (definition?.bufferView !== undefined) bytes = entry.model.asset.view(definition.bufferView);
      else if (definition?.uri?.startsWith('data:')) {
        bytes = dataURI(definition.uri, Infinity);
      } else if (definition?.uri && entry.context.fetch) {
        const signal = entry.context.signal ?? new AbortController().signal;
        bytes = await entry.context.fetch(new URL(definition.uri, entry.context.tile.contentUrls[0]).href, signal);
      }
      if (bytes) {
        const { decodeImage } = await import('@margoengine/decoders/image');
        image = await decodeImage(bytes, { signal: entry.context.signal });
      } else image = featureImage(entry.model.image(source!));
    }
    entry.context.signal?.throwIfAborted();
    checkFeatureImage(image);
    cache.set(index, image);
  }
  private uv(entry: Entry, set: SetInfo, vertices: readonly number[], weights: readonly number[]): [number, number] {
    const transform = set.texture?.extensions?.KHR_texture_transform;
    const semantic = `TEXCOORD_${transform?.texCoord ?? set.texture?.texCoord ?? 0}`,
      accessor = entry.primitive.definition.attributes?.[semantic];
    if (accessor === undefined) throw new TypeError(`Feature texture needs ${semantic}; add the specified UV accessor`);
    const values = entry.model.asset.accessor(accessor, 'VEC2');
    const uv = [0, 1].map((k) => vertices.reduce((sum, v, i) => sum + values[v * 2 + k] * weights[i], 0));
    return this.transformed(set, uv);
  }
  private transformed(set: SetInfo, uv: readonly number[]): [number, number] {
    const t = set.texture?.extensions?.KHR_texture_transform,
      scale = t?.scale ?? [1, 1],
      offset = t?.offset ?? [0, 0],
      angle = t?.rotation ?? 0;
    if (scale.length !== 2 || offset.length !== 2 || ![...scale, ...offset, angle].every(Number.isFinite))
      throw new TypeError('Feature texture transform needs finite scale, offset and rotation');
    return applyUV(uvRows(scale, offset, angle), uv[0], uv[1]);
  }
  private id(entry: Entry, set: SetInfo, hit: TileFeaturePick): number | undefined {
    if (entry.context.kind === 'instances') return hit.instanceId === undefined ? undefined : set.ids?.[hit.instanceId];
    const indices = entry.primitive.indices,
      triangle = Array.from(indices.subarray(hit.faceIndex * 3, hit.faceIndex * 3 + 3));
    if (triangle.length !== 3) return undefined;
    // Ids and UVs are per vertex of the file's primitive: a part of a split one names its vertices through vertexMap.
    const map = entry.primitive.part?.vertexMap,
      source = triangle.map((v) => {
        const local = entry.owners?.[v] ?? v;
        return map ? map[local] : local;
      });
    if (set.texture) {
      // Highlight tessellation is only used for attributes; texture coordinates remain the authored coordinates.
      const texture = entry.model.asset.doc.textures?.[set.texture.index],
        sampler = entry.model.asset.doc.samplers?.[texture?.sampler ?? -1];
      return textureFeatureId(
        metadataTexel(
          this.image(entry, set),
          this.uv(entry, set, source, hit.barycoord),
          sampler?.wrapS as TextureWrap | undefined,
          sampler?.wrapT as TextureWrap | undefined,
        ),
        set.texture.channels,
      );
    }
    if (entry.owners) return set.ids?.[source[0]];
    const positions = entry.saved.vertices;
    const point = [0, 1, 2].map((k) => source.reduce((sum, v, i) => sum + positions[v * 20 + k] * hit.barycoord[i], 0));
    const distances = source.map((v) => point.reduce((sum, x, k) => sum + (x - positions[v * 20 + k]) ** 2, 0));
    let nearest = 0;
    for (let i = 1; i < 3; i++) if (distances[i] < distances[nearest]) nearest = i;
    return set.ids?.[source[nearest]];
  }
  /** Resolves vertex/texture feature sets, b3dm batch IDs and i3dm instance IDs from a surface hit. Null IDs return undefined. */
  resolve(hit: TileFeaturePick): TileFeature | undefined {
    this.check();
    const primitive = hit.primitive as PBRPrimitive | undefined;
    const entry = primitive
      ? this.entries.get(primitive)
      : [...this.entries.values()].find(
          (e) => e.model === hit.model && e.model.primitives[hit.primitiveIndex ?? -1] === e.primitive,
        );
    if (!entry) return undefined;
    const set = this.selected(entry);
    if (!set) return undefined;
    const id = this.id(entry, set, hit);
    if (id === undefined || id === set.nullFeatureId) return undefined;
    if (!Number.isInteger(id) || id < 0)
      throw new RangeError('Feature ID must be a non-negative integer; correct the feature accessor or texture');
    if (set.table && id >= set.table.count)
      throw new RangeError('Feature ID is past its property table; correct the feature IDs or table row count');
    return {
      id,
      set: set.index,
      label: set.label,
      tile: entry.context.tile,
      model: entry.model,
      primitive: entry.primitive,
      properties: set.table?.row(id) ?? entry.context.content.batchTable?.feature(id) ?? {},
    };
  }
  private restore(entry: Entry): void {
    entry.texture?.destroy();
    entry.texture = undefined;
    entry.textureBytes = 0;
    entry.primitive.extension = entry.extension;
    entry.primitive.material = entry.material;
    if (entry.colors && entry.primitive.instances)
      for (let i = 0; i < entry.primitive.instances.count; i++)
        entry.primitive.instances.setColorAt(i, entry.colors.subarray(i * 24 + 16, i * 24 + 20));
    if (entry.geometry) {
      entry.model.writeGeometry(
        entry.model.primitives.map((p) =>
          p === entry.primitive
            ? entry.saved
            : {
                interpolatedDirections: this.entries.get(p)?.geometry === true,
                vertices: p.vertices,
                indices: p.indices,
                uvs: p.uvs,
              },
        ),
      );
      entry.owners = undefined;
      entry.geometry = false;
    }
  }
  /** Clears the current highlight, restoring the authored/styled surface exactly. */
  clear(): void {
    this.check();
    for (const entry of this.entries.values()) this.restore(entry);
    this.current = undefined;
  }
  /** Highlights a picked feature with a linear-light multiply of the given sRGB RGBA. White restores its appearance. */
  highlight(feature: TileFeature, color: readonly number[] = [1, 1, 0, 1]): void {
    this.check();
    if (color.length !== 4 || color.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
      throw new RangeError('Feature highlight needs four sRGB components in 0..1; clamp the colour');
    if (!this.entries.has(feature.primitive))
      throw new MargoError('state', 'Picked tile has unloaded; pick a currently loaded feature');
    this.clear();
    this.current = { feature, color };
    // A feature may occupy several primitives in one content item. Resolve its selected set independently in each.
    try {
      for (const entry of this.entries.values())
        if (entry.model === feature.model) {
          const set = this.selected(entry);
          if (!set) continue;
          if (set.texture) this.highlightTexture(entry, set, feature.id, color);
          else this.highlightAttribute(entry, set, feature.id, color);
          if (color[3] < 1)
            entry.primitive.material = { ...entry.material, settings: [2, ...entry.material.settings.slice(1)] };
        }
    } catch (error) {
      this.clear();
      throw error;
    }
  }
  private highlightTexture(entry: Entry, set: SetInfo, id: number, color: readonly number[]): void {
    const device = this.engine.gpu;
    if (!device)
      throw new MargoError(
        'unsupported',
        'Feature texture highlight needs a GPU device; attach to a WebGPU or compatibility engine',
      );
    const image = this.image(entry, set),
      texture = device.createTexture({
        size: [image.width, image.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    device.queue.writeTexture({ texture }, image.data, { bytesPerRow: image.width * 4 }, [image.width, image.height]);
    entry.texture = texture;
    entry.textureBytes = image.data.byteLength;
    const original = entry.extension,
      slot = original?.textures?.length ?? 0,
      factors = new Float32Array((original?.factors?.length ?? 0) + 8),
      offset = factors.length / 4 - 2;
    if (original?.factors) factors.set(original.factors);
    factors[offset * 4] = id % 65536;
    factors[offset * 4 + 1] = Math.floor(id / 65536);
    factors.set(
      color.map((v, i) => (i < 3 ? SRGBToLinear(v) : v)),
      (offset + 1) * 4,
    );
    const tex = entry.model.asset.doc.textures?.[set.texture!.index],
      sampler = entry.model.asset.doc.samplers?.[tex?.sampler ?? -1];
    const wrap = (v: unknown) => (v === 33071 ? 'clamp-to-edge' : v === 33648 ? 'mirror-repeat' : 'repeat');
    const channels = set.texture!.channels ?? [0];
    textureFeatureId([0, 0, 0, 0], channels);
    const coordinate = set.texture!.extensions?.KHR_texture_transform?.texCoord ?? set.texture!.texCoord ?? 0;
    if (coordinate > 3)
      throw new MargoError(
        'unsupported',
        'Feature highlight needs one of the four supported UV sets; map metadata to TEXCOORD_0 through TEXCOORD_3',
      );
    if (coordinate > 1) {
      const accessor = entry.primitive.definition.attributes?.[`TEXCOORD_${coordinate}`];
      if (accessor === undefined)
        throw new TypeError('Feature texture UV accessor is missing; add the referenced TEXCOORD attribute');
      const values = entry.model.asset.accessor(accessor, 'VEC2'),
        uvs = entry.saved.uvs?.slice() ?? new Float32Array(entry.primitive.vertices.length / 5);
      const map = entry.primitive.part?.vertexMap;
      for (let i = 0, n = map ? map.length : values.length / 2; i < n; i++) {
        const s = map ? map[i] : i;
        uvs.set(values.subarray(s * 2, s * 2 + 2), i * 4 + (coordinate - 2) * 2);
      }
      entry.model.writeGeometry(
        entry.model.primitives.map((p) =>
          p === entry.primitive
            ? { ...entry.saved, uvs }
            : {
                interpolatedDirections: this.entries.get(p)?.geometry === true,
                vertices: p.vertices,
                indices: p.indices,
                uvs: p.uvs,
              },
        ),
      );
      entry.geometry = true;
    }
    const t = set.texture!.extensions?.KHR_texture_transform,
      scale = t?.scale ?? [1, 1],
      shift = t?.offset ?? [0, 0],
      angle = t?.rotation ?? 0;
    this.transformed(set, [0, 0]);
    const coordinateCode = uvRowsWGSL(uvRows(scale, shift, angle), `uv(i,${coordinate}.0)`);
    const code = `let tileFeatureBytes=vec4u(round(textureSampleLevel(materialTexture${slot},materialSampler${slot},${coordinateCode},0.0)*255.0));
      let tileFeatureId=${channels.map((c, i) => `(tileFeatureBytes[${c}] << ${i * 8}u)`).join(' | ')};
      if(tileFeatureId==(u32(materialFactors[${offset}].x)|(u32(materialFactors[${offset}].y)<<16u))){s.base*=materialFactors[${offset + 1}];if(s.base.a<=0.0){discard;}}`;
    entry.primitive.extension = {
      ...original,
      factors,
      textures: [
        ...(original?.textures ?? []),
        {
          view: texture.createView(),
          sampler: device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
            addressModeU: wrap(sampler?.wrapS),
            addressModeV: wrap(sampler?.wrapT),
          }),
        },
      ],
      wgsl: (original?.wgsl ?? '') + '\n' + code,
    };
  }
  private highlightAttribute(entry: Entry, set: SetInfo, id: number, color: readonly number[]): void {
    // i3dm rows have their own tint, so no geometry changes are necessary.
    if (entry.context.kind === 'instances') {
      const rows = entry.primitive.instances;
      if (rows && entry.colors)
        for (let i = 0; i < rows.count; i++) {
          if (set.ids?.[i] === id)
            rows.setColorAt(
              i,
              color.map((v, c) => (c < 3 ? SRGBToLinear(v) : v) * entry.colors![i * 24 + 16 + c]),
            );
        }
      return;
    }
    const { vertices, indices, uvs } = entry.saved,
      output: number[] = [],
      later: number[] = [],
      owners: number[] = [],
      map = entry.primitive.part?.vertexMap,
      idOf = (v: number) => set.ids?.[map ? map[v] : v];
    const tint = color.map((v, c) => (c < 3 ? SRGBToLinear(v) : v));
    const emit = (weights: readonly number[], triangle: readonly number[], owner: number) => {
      for (let k = 0; k < 20; k++) {
        let value = weights.reduce((sum, w, i) => sum + w * vertices[triangle[i] * 20 + k], 0);
        if (k >= 16 && idOf(triangle[owner]) === id) value *= tint[k - 16];
        output.push(value);
      }
      // Keep convex direction interpolants: normalization belongs after raster interpolation.
      const start = output.length - 20;

      output[start + 3] = 1;
      output[start + 7] = 0;
      output[start + 11] = vertices[triangle[owner] * 20 + 11];
      if (uvs)
        for (let k = 0; k < 4; k++) later.push(weights.reduce((sum, w, i) => sum + w * uvs[triangle[i] * 4 + k], 0));
      owners.push(triangle[owner]);
    };
    for (let face = 0; face < indices.length; face += 3) {
      const triangle = Array.from(indices.subarray(face, face + 3));
      const ids = triangle.map(idOf);
      if (ids.every((value) => value === ids[0])) {
        for (let i = 0; i < 3; i++) emit([Number(i === 0), Number(i === 1), Number(i === 2)], triangle, i);
        continue;
      }
      // Squared-distance differences are affine over a triangle. Clip by the two Voronoi half planes.
      for (let owner = 0; owner < 3; owner++) {
        let polygon = [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ];
        for (let other = 0; other < 3; other++)
          if (other !== owner) {
            const next: number[][] = [];
            for (let k = 0; k < polygon.length; k++) {
              const distance = (weights: readonly number[]) => {
                const point = [0, 1, 2].map((c) =>
                  triangle.reduce((sum, v, i) => sum + weights[i] * vertices[v * 20 + c], 0),
                );
                return point.reduce(
                  (sum, x, c) =>
                    sum + (x - vertices[triangle[other] * 20 + c]) ** 2 - (x - vertices[triangle[owner] * 20 + c]) ** 2,
                  0,
                );
              };
              const a = polygon[k],
                b = polygon[(k + 1) % polygon.length],
                da = distance(a),
                db = distance(b);
              if (da >= 0) next.push(a);
              if (da >= 0 !== db >= 0) {
                const t = da / (da - db);
                next.push(a.map((v, i) => v + (b[i] - v) * t));
              }
            }
            polygon = next;
          }
        for (let k = 1; k + 1 < polygon.length; k++)
          for (const point of [polygon[0], polygon[k], polygon[k + 1]]) emit(point, triangle, owner);
      }
    }
    const count = output.length / 20;
    entry.model.writeGeometry(
      entry.model.primitives.map((p) =>
        p === entry.primitive
          ? {
              interpolatedDirections: true,
              vertices: Float32Array.from(output),
              indices: Uint32Array.from({ length: count }, (_, i) => i),
              uvs: uvs ? Float32Array.from(later) : undefined,
            }
          : {
              interpolatedDirections: this.entries.get(p)?.geometry === true,
              vertices: p.vertices,
              indices: p.indices,
              uvs: p.uvs,
            },
      ),
    );
    entry.geometry = true;
    entry.owners = Uint32Array.from(owners);
    entry.primitive.extension = {
      ...entry.extension,
      wgsl: (entry.extension?.wgsl ?? '') + '\nif(i.color.a<=0.0){discard;}',
    };
  }
  onDeviceRestored(): void {
    if (this.current) {
      const current = this.current;
      this.highlight(current.feature, current.color);
    }
  }
  /** Releases content records and highlight resources, leaving the tiles and their prior decorator owned by the renderer. */
  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.entries.clear();
    this.disposed = true;
    // The scene this controller was attached to, not whichever scene is active now.
    this.engine.sceneOf(this)?.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
export { type FeatureImage, textureFeatureId, metadataTexel } from './feature-texture.js';
