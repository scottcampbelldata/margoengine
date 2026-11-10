// Optional EXT_structural_metadata property attributes and textures. Binary transforms share the table decoder.
import type { GLTFAsset } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { ACCESSOR_WIDTHS } from '../../shared/accessor.js';
import { rawAccessor } from './raw-accessor.js';
import { applyUV, uvRows } from './uv-transform.js';
import { dataURI } from './data-uri.js';
import { parseJSON } from '../../shared/json.js';
import { readResponse } from '../../shared/loading.js';
import {
  PropertyTable,
  type StructuralSchemaJSON,
  type ClassPropertyJSON,
  type MetadataComponentType,
  type PropertyTableJSON,
} from './metadata.js';

/** Linear RGBA8 texture samples, top row first. No colour conversion or alpha premultiplication. */
export interface PropertyImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}
interface Transform {
  offset?: unknown;
  scale?: unknown;
}
interface TextureProperty extends Transform {
  index: number;
  texCoord?: number;
  channels?: number[];
  extensions?: {
    KHR_texture_transform?: { offset?: number[]; scale?: number[]; rotation?: number; texCoord?: number };
  };
}
interface AttributeJSON {
  class: string;
  name?: string;
  properties?: Record<string, Transform & { attribute: string }>;
}
interface TextureJSON {
  class: string;
  name?: string;
  properties?: Record<string, TextureProperty>;
}
interface Extension {
  schema?: StructuralSchemaJSON;
  schemaUri?: string;
  propertyAttributes?: AttributeJSON[];
  propertyTextures?: TextureJSON[];
}
/** Synchronous property reader options; images are indexed by glTF texture, not image. */
export interface PropertyReadOptions {
  schema?: StructuralSchemaJSON;
  image?: (texture: number) => PropertyImage | undefined;
  /** Original tightly packed bytes for a decoded accessor, when a codec's float cache loses raw sentinel precision. */
  accessor?: (index: number) => Uint8Array | undefined;
  /** Packed attribute allocation cap. Default: four times the asset's configured byte limit. */
  maximumDecodedBytes?: number;
}
/** Network/resource options for loadPropertyMetadata. Existing asset buffers need no further loading. */
export interface PropertyLoadOptions extends PropertyReadOptions {
  signal?: AbortSignal;
  /** Defaults to asset.baseURL, then the current page. Required for relative resources in a parsed document in Node. */
  baseURL?: string;
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** Per schema or image resource. Default 64 MiB. */
  maximumBytes?: number;
}
const sizes: Record<MetadataComponentType, number> = {
  INT8: 1,
  UINT8: 1,
  INT16: 2,
  UINT16: 2,
  INT32: 4,
  UINT32: 4,
  INT64: 8,
  UINT64: 8,
  FLOAT32: 4,
  FLOAT64: 8,
};
const components: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
  ENUM: 1,
  BOOLEAN: 1,
};
const gltfTypes: Record<number, MetadataComponentType> = {
  5120: 'INT8',
  5121: 'UINT8',
  5122: 'INT16',
  5123: 'UINT16',
  5125: 'UINT32',
  5126: 'FLOAT32',
};
function finite(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new RangeError('Metadata contains a non-finite value; re-export finite property values');
  if (Array.isArray(value)) value.forEach(finite);
  return value;
}
function definitions(schema: StructuralSchemaJSON, name: string): Record<string, ClassPropertyJSON> {
  const klass = Object.hasOwn(schema.classes ?? {}, name) ? schema.classes![name] : undefined;
  if (!klass) throw new TypeError(`Metadata class ${name} is missing; include it in the schema`);
  return klass.properties ?? {};
}
function shape(
  definition: ClassPropertyJSON,
  schema: StructuralSchemaJSON,
): { type: MetadataComponentType; count: number; bytes: number } {
  const type =
    definition.type === 'ENUM'
      ? (schema.enums?.[definition.enumType ?? '']?.valueType ?? 'UINT16')
      : definition.type === 'BOOLEAN'
        ? 'UINT8'
        : definition.componentType!;
  const count = (components[definition.type] ?? 0) * (definition.array ? (definition.count ?? 0) : 1);
  if (!count || !sizes[type] || (definition.array && (!Number.isInteger(definition.count) || definition.count! < 1)))
    throw new TypeError(
      'Property attributes/textures need fixed-size numeric, enum or boolean values; use a property table for strings or variable arrays',
    );
  return { type, count, bytes: definition.type === 'BOOLEAN' ? Math.ceil(count / 8) : count * sizes[type] };
}
function required(schema: StructuralSchemaJSON, json: AttributeJSON | TextureJSON): void {
  for (const [name, definition] of Object.entries(definitions(schema, json.class)))
    if (definition.required && !Object.hasOwn(json.properties ?? {}, name))
      throw new TypeError(`Required property ${name} is missing; add its attribute or texture binding`);
  for (const name of Object.keys(json.properties ?? {}))
    if (!Object.hasOwn(definitions(schema, json.class), name))
      throw new TypeError(`Property ${name} is not in class ${json.class}; correct the binding or schema`);
}
/** One schema class associated with attributes of a particular primitive. */
export class PropertyAttributes {
  readonly names: readonly string[];
  constructor(readonly table: PropertyTable) {
    this.names = table.names;
  }
  get count(): number {
    return this.table.count;
  }
  get class(): string {
    return this.table.class;
  }
  /** Exact row value after noData/default, normalization and offset/scale. Out-of-range rows return undefined. */
  get(vertex: number, name: string): unknown {
    return finite(this.table.get(vertex, name));
  }
  /** Every class property of one vertex, including default values. */
  row(vertex: number): Record<string, unknown> {
    return Object.fromEntries(this.names.map((name) => [name, this.get(vertex, name)]));
  }
}
type UV = readonly number[] | ((set: number) => readonly number[]);
function wrap(value: number, mode: number | undefined): number {
  if (mode === 33071) return Math.max(0, Math.min(1, value));
  const whole = Math.floor(value),
    part = value - whole;
  return mode === 33648 && Math.abs(whole % 2) === 1 ? 1 - part : part;
}
function texel(image: PropertyImage, uv: readonly number[], s: number | undefined, t: number | undefined): Uint8Array {
  if (uv.length !== 2 || !uv.every(Number.isFinite))
    throw new TypeError('Metadata UV needs two finite coordinates; pass the requested texture coordinate set');
  const x = Math.min(image.width - 1, Math.floor(wrap(uv[0], s) * image.width)),
    y = Math.min(image.height - 1, Math.floor(wrap(uv[1], t) * image.height));
  return Uint8Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
}
/** One property texture. Queries read stored texels exactly; they do not interpolate encoded integer/float bytes. */
export class PropertyTextures {
  readonly names: readonly string[];
  private readonly decoders = new Map<
    string,
    { table: PropertyTable; bytes: Uint8Array; binding: TextureProperty; image: PropertyImage }
  >();
  constructor(
    readonly json: TextureJSON,
    readonly schema: StructuralSchemaJSON,
    private readonly asset: GLTFAsset,
    options: PropertyReadOptions,
  ) {
    required(schema, json);
    const defs = definitions(schema, json.class);
    this.names = Object.keys(defs);
    for (const [name, binding] of Object.entries(json.properties ?? {})) {
      const definition = defs[name],
        layout = shape(definition, schema),
        channels = binding.channels ?? [0],
        image = options.image?.(binding.index);
      if (!image)
        throw new MargoError(
          'state',
          'Property texture image is missing; pass decoded images or use loadPropertyMetadata',
        );
      if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray))
        throw new TypeError('Metadata image samples must be RGBA8 bytes; provide Uint8Array or Uint8ClampedArray data');
      if (
        !Number.isInteger(image.width) ||
        image.width < 1 ||
        !Number.isInteger(image.height) ||
        image.height < 1 ||
        image.data.length !== image.width * image.height * 4
      )
        throw new RangeError('Metadata image needs width*height*4 RGBA8 bytes; provide the complete decoded image');
      if (
        channels.length !== layout.bytes ||
        channels.length > 4 ||
        new Set(channels).size !== channels.length ||
        channels.some((c) => !Number.isInteger(c) || c < 0 || c > 3)
      )
        throw new RangeError(
          `Property ${name} needs ${layout.bytes} distinct RGBA8 channels; correct the texture channel mapping`,
        );
      const bytes = new Uint8Array(layout.bytes),
        table = new PropertyTable(
          { class: json.class, count: 1, properties: { [name]: { values: 0, ...binding } } },
          schema,
          () => bytes,
        );
      this.decoders.set(name, { table, bytes, binding, image });
    }
  }
  get class(): string {
    return this.json.class;
  }
  /** Reads the nearest stored texel, with glTF wrapping, selected UV set and KHR_texture_transform. */
  get(uv: UV, name: string): unknown {
    const entry = this.decoders.get(name);
    if (!entry) return definitions(this.schema, this.class)[name]?.default;
    const { binding, image, table, bytes } = entry,
      transform = binding.extensions?.KHR_texture_transform,
      set = transform?.texCoord ?? binding.texCoord ?? 0;
    const coordinate = typeof uv === 'function' ? uv(set) : uv;
    if (coordinate.length !== 2 || !coordinate.every(Number.isFinite) || !Number.isInteger(set) || set < 0)
      throw new TypeError(
        'Metadata UV needs two finite coordinates and a non-negative set index; correct its texture coordinates',
      );
    const scale = transform?.scale ?? [1, 1],
      offset = transform?.offset ?? [0, 0],
      angle = transform?.rotation ?? 0;
    if (scale.length !== 2 || offset.length !== 2 || ![...scale, ...offset, angle].every(Number.isFinite))
      throw new TypeError(
        'Metadata texture transform needs finite scale/offset/rotation; correct KHR_texture_transform',
      );
    const point = applyUV(uvRows(scale, offset, angle), coordinate[0], coordinate[1]);
    const texture = this.asset.doc.textures?.[binding.index];
    if (!texture) throw new TypeError('Property texture index is missing; add the referenced glTF texture');
    const sampler = this.asset.doc.samplers?.[texture.sampler ?? -1],
      pixel = texel(image, point, sampler?.wrapS, sampler?.wrapT);
    (binding.channels ?? [0]).forEach((channel, i) => (bytes[i] = pixel[channel]));
    return finite(table.get(0, name));
  }
  /** Reads every class property. A UV callback supports properties using different coordinate sets. */
  row(uv: UV): Record<string, unknown> {
    return Object.fromEntries(this.names.map((name) => [name, this.get(uv, name)]));
  }
}
/** Per-primitive property bindings and root texture definitions. */
export interface PropertyMetadata {
  readonly schema: StructuralSchemaJSON;
  readonly propertyTextures: readonly PropertyTextures[];
  readonly primitives: readonly (readonly {
    attributes: readonly PropertyAttributes[];
    textures: readonly PropertyTextures[];
  }[])[];
  /** Properties at a triangle hit, using its barycentric UVs independently for each texture coordinate set. */
  sample(
    mesh: number,
    primitive: number,
    triangle: number,
    barycoord: readonly number[],
  ): readonly Record<string, unknown>[];
}
/** Reads property attributes and decoded property textures from a loaded glTF asset, without creating engine objects. */
export function readPropertyMetadata(asset: GLTFAsset, options: PropertyReadOptions = {}): PropertyMetadata {
  const ext = asset.doc.extensions?.EXT_structural_metadata as Extension | undefined,
    schema = options.schema ?? ext?.schema;
  if (!schema)
    throw new TypeError(
      'Structural metadata schema is missing; provide the external schema or use loadPropertyMetadata',
    );
  const textures = (ext?.propertyTextures ?? []).map((json) => new PropertyTextures(json, schema, asset, options)),
    cache = new Map<number, Uint8Array>(),
    maximum = options.maximumDecodedBytes ?? asset.maxBytes * 4;
  if (!Number.isSafeInteger(maximum) || maximum < 0)
    throw new RangeError('Metadata maximumDecodedBytes must be a non-negative integer; choose a decoded byte limit');
  let retained = 0;
  const primitives = (asset.doc.meshes ?? []).map((mesh) =>
    mesh.primitives.map((primitive) => {
      const association = primitive.extensions?.EXT_structural_metadata as
        | { propertyAttributes?: number[]; propertyTextures?: number[] }
        | undefined;
      const attributes = (association?.propertyAttributes ?? []).map((index) => {
        const json = ext?.propertyAttributes?.[index];
        if (!json) throw new TypeError('Property attribute set is missing; correct the primitive metadata index');
        required(schema, json);
        const defs = definitions(schema, json.class),
          views: Uint8Array[] = [],
          properties: NonNullable<PropertyTableJSON['properties']> = {};
        const position = primitive.attributes?.POSITION,
          count = asset.doc.accessors?.[position ?? -1]?.count ?? 0;
        for (const [name, binding] of Object.entries(json.properties ?? {})) {
          const accessor = primitive.attributes?.[binding.attribute],
            definition = defs[name],
            layout = shape(definition, schema),
            source = asset.doc.accessors?.[accessor ?? -1];
          if (
            accessor === undefined ||
            !source ||
            source.count !== count ||
            ACCESSOR_WIDTHS[source.type] !== layout.count ||
            gltfTypes[source.componentType] !== layout.type
          )
            throw new TypeError(
              `Property ${name} accessor must match its class type and vertex count; correct the attribute binding`,
            );
          let bytes = cache.get(accessor);
          if (!bytes) {
            bytes = rawAccessor(asset, accessor, { ...options, maximumDecodedBytes: maximum - retained });
            cache.set(accessor, bytes);
            retained += bytes.byteLength;
          }
          if (definition.type === 'BOOLEAN') {
            const size = Math.ceil((count * layout.count) / 8);
            if (size > maximum - retained)
              throw new RangeError(
                'Boolean property attributes exceed the decoded byte limit; raise maximumDecodedBytes',
              );
            const bits = new Uint8Array(size);
            retained += size;
            bytes.forEach((value, i) => {
              if (value !== 0 && value !== 1)
                throw new RangeError('Boolean property attributes must encode 0 or 1; correct the attribute values');
              if (value) bits[i >> 3] |= 1 << (i & 7);
            });
            bytes = bits;
          }
          properties[name] = { values: views.length, offset: binding.offset, scale: binding.scale };
          views.push(bytes);
        }
        return new PropertyAttributes(
          new PropertyTable({ class: json.class, count, properties }, schema, (index) => views[index]),
        );
      });
      return {
        attributes,
        textures: (association?.propertyTextures ?? []).map((index) => {
          if (!textures[index])
            throw new TypeError('Property texture set is missing; correct the primitive metadata index');
          return textures[index];
        }),
      };
    }),
  );
  return {
    schema,
    propertyTextures: textures,
    primitives,
    sample(mesh, primitive, triangle, barycoord) {
      const sum = barycoord.reduce((a, b) => a + b, 0);
      if (
        barycoord.length !== 3 ||
        !barycoord.every(Number.isFinite) ||
        barycoord.some((v) => v < 0) ||
        Math.abs(sum - 1) > 3 * 2 ** -24
      )
        throw new RangeError(
          'Metadata hit needs three non-negative barycentric weights summing to one within float32 rounding; use a triangle ray hit',
        );
      const definition = asset.doc.meshes?.[mesh]?.primitives[primitive],
        sets = primitives[mesh]?.[primitive];
      if (!definition || !sets) return [];
      const mode = definition.mode ?? 4,
        indices = definition.indices === undefined ? undefined : asset.accessor(definition.indices, 'SCALAR'),
        count = indices?.length ?? asset.doc.accessors?.[definition.attributes?.POSITION ?? -1]?.count ?? 0;
      if (![4, 5, 6].includes(mode))
        throw new TypeError(
          'Metadata triangle sampling needs triangle list/strip/fan geometry; query point or line UVs with get',
        );
      const triangles = mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2);
      if (!Number.isInteger(triangle) || triangle < 0 || triangle >= triangles)
        throw new RangeError('Metadata triangle index is outside the primitive; use a source triangle index');
      const corners =
        mode === 4
          ? [triangle * 3, triangle * 3 + 1, triangle * 3 + 2]
          : mode === 5
            ? [triangle + (triangle % 2 ? 1 : 0), triangle + (triangle % 2 ? 0 : 1), triangle + 2]
            : [0, triangle + 1, triangle + 2];
      const vertices = corners.map((i) => (indices ? indices[i] : i));
      return sets.textures.map((texture) =>
        texture.row((set) => {
          const index = definition.attributes?.[`TEXCOORD_${set}`];
          if (index === undefined)
            throw new TypeError(`Property texture needs TEXCOORD_${set}; add the referenced coordinate attribute`);
          const values = asset.accessor(index, 'VEC2');
          return [0, 1].map((k) =>
            vertices.reduce((total, v, i) => total + (values[v * 2 + k] * barycoord[i]) / sum, 0),
          );
        }),
      );
    },
  };
}
/** Loads external schemas and referenced metadata images with cancellation, preserving raw PNG channels exactly. */
export async function loadPropertyMetadata(
  asset: GLTFAsset,
  options: PropertyLoadOptions = {},
): Promise<PropertyMetadata> {
  options.signal?.throwIfAborted();
  const ext = asset.doc.extensions?.EXT_structural_metadata as Extension | undefined,
    base = options.baseURL ?? asset.baseURL ?? globalThis.location?.href,
    fetch = options.fetch ?? globalThis.fetch.bind(globalThis),
    maximum = options.maximumBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new RangeError('Metadata maximumBytes must be a positive integer; choose a resource byte limit');
  const resource = async (uri: string) => {
    const embedded = dataURI(uri, maximum);
    if (embedded) return embedded;
    const response = await fetch(new URL(uri, base).href, { signal: options.signal });
    if (!response.ok)
      throw new MargoError('failed', `Metadata resource answered ${response.status}; check its URL and access`);
    return readResponse(response, { signal: options.signal, maxBytes: maximum, label: 'Structural metadata resource' });
  };
  const schema =
      options.schema ??
      ext?.schema ??
      (ext?.schemaUri
        ? parseJSON<StructuralSchemaJSON>(new TextDecoder().decode(await resource(ext.schemaUri)))
        : undefined),
    images = new Map<number, PropertyImage>();
  for (const texture of ext?.propertyTextures ?? [])
    for (const binding of Object.values(texture.properties ?? {}))
      if (!images.has(binding.index)) {
        let image = options.image?.(binding.index);
        if (!image) {
          const texture = asset.doc.textures?.[binding.index],
            source = texture?.extensions?.KHR_texture_basisu?.source ?? texture?.source,
            definition = asset.doc.images?.[source ?? -1];
          if (!definition) throw new TypeError('Property texture image is missing; correct the glTF image reference');
          const bytes =
            definition.bufferView !== undefined ? asset.view(definition.bufferView) : await resource(definition.uri!);
          if (bytes.byteLength > maximum)
            throw new RangeError(
              'Metadata image exceeds maximumBytes; reduce the embedded image or raise its byte limit',
            );
          const { decodeImage } = await import('@margoengine/decoders/image');
          image = await decodeImage(bytes, { signal: options.signal });
        }
        images.set(binding.index, image);
      }
  options.signal?.throwIfAborted();
  return readPropertyMetadata(asset, { ...options, schema, image: (index) => images.get(index) });
}
