// @margoengine/tiles/metadata: binary metadata of 3D Tiles 1.1 content and Draco-compressed point clouds.
// - EXT_structural_metadata property tables (every type: SCALAR, VECn, MATn, STRING, BOOLEAN, ENUM, fixed and
//   variable-length arrays, normalized values, offset and scale, noData and default) and EXT_mesh_features feature IDs
//   (attribute and implicit), so a picked vertex leads to its feature's properties.
// - 3DTILES_draco_point_compression pnts, decoded with Google's Draco decoder from @margoengine/decoders/draco-points.
// Written from the 3D Tiles Metadata specification (Binary Table Format), the EXT_structural_metadata and
// EXT_mesh_features glTF extension specifications and the 3DTILES_draco_point_compression extension specification.
import { GLB_BIN, GLB_JSON, glbChunks, isGLB } from '../../shared/glb.js';
import { BatchTable, type PointsContent } from './formats.js';

/** A metadata component type. */
export type MetadataComponentType =
  | 'INT8'
  | 'UINT8'
  | 'INT16'
  | 'UINT16'
  | 'INT32'
  | 'UINT32'
  | 'INT64'
  | 'UINT64'
  | 'FLOAT32'
  | 'FLOAT64';
/** A metadata property type. */
export type MetadataType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4' | 'STRING' | 'BOOLEAN' | 'ENUM';

/** A class property of a metadata schema. */
export interface ClassPropertyJSON {
  type: MetadataType;
  componentType?: MetadataComponentType;
  enumType?: string;
  array?: boolean;
  count?: number;
  normalized?: boolean;
  offset?: unknown;
  scale?: unknown;
  noData?: unknown;
  default?: unknown;
  required?: boolean;
  semantic?: string;
  name?: string;
  description?: string;
}
/** A metadata schema (`EXT_structural_metadata.schema`). */
export interface StructuralSchemaJSON {
  id?: string;
  classes?: Record<string, { name?: string; properties?: Record<string, ClassPropertyJSON> }>;
  enums?: Record<string, { valueType?: MetadataComponentType; values: { name: string; value: number }[] }>;
}
/** A property table as stored in glTF. */
export interface PropertyTableJSON {
  name?: string;
  class: string;
  count: number;
  properties?: Record<
    string,
    {
      values: number;
      arrayOffsets?: number;
      stringOffsets?: number;
      arrayOffsetType?: 'UINT8' | 'UINT16' | 'UINT32' | 'UINT64';
      stringOffsetType?: 'UINT8' | 'UINT16' | 'UINT32' | 'UINT64';
      offset?: unknown;
      scale?: unknown;
    }
  >;
}

const SIZE: Record<MetadataComponentType, number> = {
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
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16, ENUM: 1 };
/** Largest value of each integer type, for normalized values (64-bit as a double, as the specification allows). */
const MAX: Partial<Record<MetadataComponentType, number>> = {
  INT8: 127,
  UINT8: 255,
  INT16: 32767,
  UINT16: 65535,
  INT32: 2147483647,
  UINT32: 4294967295,
  INT64: 9223372036854775807,
  UINT64: 18446744073709551615,
};
const text = /* @__PURE__ */ new TextDecoder();

function component(view: DataView, at: number, type: MetadataComponentType): number {
  switch (type) {
    case 'INT8':
      return view.getInt8(at);
    case 'UINT8':
      return view.getUint8(at);
    case 'INT16':
      return view.getInt16(at, true);
    case 'UINT16':
      return view.getUint16(at, true);
    case 'INT32':
      return view.getInt32(at, true);
    case 'UINT32':
      return view.getUint32(at, true);
    case 'INT64':
      return Number(view.getBigInt64(at, true));
    case 'UINT64':
      return Number(view.getBigUint64(at, true));
    case 'FLOAT32':
      return view.getFloat32(at, true);
    case 'FLOAT64':
      return view.getFloat64(at, true);
    default:
      throw new TypeError(`Unknown metadata componentType ${type as string}; use INT8 to UINT64, FLOAT32 or FLOAT64`);
  }
}

/** A buffer view's bytes, checked against the buffer. */
type Views = (index: number, what: string) => Uint8Array;

/** One column of a property table: reads the value of any row. */
class Column {
  readonly components: number;
  private readonly values: DataView;
  private readonly arrays?: DataView;
  private readonly strings?: DataView;
  constructor(
    readonly name: string,
    readonly definition: ClassPropertyJSON,
    json: NonNullable<PropertyTableJSON['properties']>[string],
    private readonly count: number,
    views: Views,
    private readonly enumValues?: Map<number, string>,
    private readonly enumType: MetadataComponentType = 'UINT16',
  ) {
    const type = definition.type;
    if (type !== 'STRING' && type !== 'BOOLEAN' && !COMPONENTS[type])
      throw new TypeError(`Property ${name}: unknown type ${type}; use SCALAR, VECn, MATn, STRING, BOOLEAN or ENUM`);
    if ((type === 'SCALAR' || type.startsWith('VEC') || type.startsWith('MAT')) && !SIZE[definition.componentType!])
      throw new TypeError(`Property ${name}: ${type} needs a componentType (INT8 to UINT64, FLOAT32 or FLOAT64)`);
    if (definition.array && definition.count === undefined && json.arrayOffsets === undefined)
      throw new TypeError(`Property ${name}: a variable-length array needs arrayOffsets`);
    if (type === 'STRING' && json.stringOffsets === undefined)
      throw new TypeError(`Property ${name}: a STRING property needs stringOffsets`);
    this.components = COMPONENTS[type] ?? 1;
    const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.values = view(views(json.values, `property ${name} values`));
    if (json.arrayOffsets !== undefined) this.arrays = view(views(json.arrayOffsets, `property ${name} arrayOffsets`));
    if (json.stringOffsets !== undefined)
      this.strings = view(views(json.stringOffsets, `property ${name} stringOffsets`));
    this.arrayType = json.arrayOffsetType ?? 'UINT32';
    this.stringType = json.stringOffsetType ?? 'UINT32';
    this.offset = json.offset ?? definition.offset;
    this.scale = json.scale ?? definition.scale;
  }
  private readonly arrayType: MetadataComponentType;
  private readonly stringType: MetadataComponentType;
  private readonly offset: unknown;
  private readonly scale: unknown;

  private offsetAt(view: DataView, index: number, type: MetadataComponentType, what: string): number {
    const size = SIZE[type];
    if ((index + 1) * size > view.byteLength)
      throw new RangeError(`Property ${this.name}: ${what} ${index} is past its buffer view; the file is truncated or corrupt`);
    return component(view, index * size, type);
  }
  /** Element range [start, end) of one row: element indices into the values (or string offsets). */
  private range(row: number): [number, number] {
    const d = this.definition;
    if (!d.array) return [row, row + 1];
    if (d.count !== undefined) return [row * d.count, row * d.count + d.count];
    return [
      this.offsetAt(this.arrays!, row, this.arrayType, 'array offset'),
      this.offsetAt(this.arrays!, row + 1, this.arrayType, 'array offset'),
    ];
  }
  private element(index: number): unknown {
    const d = this.definition,
      type = d.type;
    if (type === 'BOOLEAN') {
      const byte = index >> 3;
      if (byte >= this.values.byteLength) throw new RangeError(`Property ${this.name}: boolean ${index} is past its buffer view; the file is truncated or corrupt, re-export it`);
      return ((this.values.getUint8(byte) >> (index & 7)) & 1) === 1;
    }
    if (type === 'STRING') {
      const start = this.offsetAt(this.strings!, index, this.stringType, 'string offset'),
        end = this.offsetAt(this.strings!, index + 1, this.stringType, 'string offset');
      if (end < start || end > this.values.byteLength)
        throw new RangeError(`Property ${this.name}: string ${index} is past its buffer view; the file is corrupt`);
      return text.decode(new Uint8Array(this.values.buffer, this.values.byteOffset + start, end - start));
    }
    const ct = type === 'ENUM' ? this.enumType : d.componentType!,
      size = SIZE[ct],
      n = this.components,
      at = index * n * size;
    if (at + n * size > this.values.byteLength)
      throw new RangeError(`Property ${this.name}: element ${index} is past its buffer view; the file is truncated or corrupt`);
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(component(this.values, at + k * size, ct));
    if (type === 'ENUM') return this.enumValues?.get(out[0]) ?? out[0];
    return n === 1 ? out[0] : out;
  }
  /** Normalization, then offset and scale (per component), as the specification orders them. */
  private transform(value: unknown, position: number): unknown {
    const d = this.definition;
    if (d.type === 'STRING' || d.type === 'BOOLEAN' || d.type === 'ENUM') return value;
    const normalize = d.normalized && MAX[d.componentType!],
      float = d.componentType === 'FLOAT32' || d.componentType === 'FLOAT64';
    if (!normalize && !float) return value;
    const pick = (v: unknown, k: number, fallback: number): number => {
      let x = v;
      if (Array.isArray(x) && d.array && d.count !== undefined) x = x[position];
      if (Array.isArray(x)) x = x[k];
      return typeof x === 'number' ? x : fallback;
    };
    const one = (v: number, k: number) => {
      let x = v;
      if (normalize) x = d.componentType!.startsWith('U') ? x / normalize : Math.max(x / normalize, -1);
      return pick(this.offset, k, 0) + pick(this.scale, k, 1) * x;
    };
    return Array.isArray(value) ? value.map((v, k) => one(v, k)) : one(value as number, 0);
  }
  private equals(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => this.equals(v, b[i]));
    return a === b;
  }
  /** The value of one row: the transformed value, `default` (or undefined) where the raw value is `noData`. */
  get(row: number): unknown {
    if (!Number.isInteger(row) || row < 0 || row >= this.count) return undefined;
    const d = this.definition,
      [start, end] = this.range(row);
    if (end < start) throw new RangeError(`Property ${this.name}: array ${row} ends before it starts; the file is corrupt`);
    const raw = Array.from({ length: end - start }, (_, i) => this.element(start + i));
    const value = d.array ? raw : raw[0];
    if (d.noData !== undefined && this.equals(value, d.noData)) return d.default;
    return d.array ? raw.map((v, i) => this.transform(v, i)) : this.transform(value, 0);
  }
}

/** One EXT_structural_metadata property table: `count` rows of a schema class. */
export class PropertyTable {
  /** Property names of the class, in schema order (those without a column read as their `default`). */
  readonly names: readonly string[];
  private readonly columns = new Map<string, Column>();
  constructor(
    readonly json: PropertyTableJSON,
    readonly schema: StructuralSchemaJSON,
    views: Views,
  ) {
    const klass = schema.classes?.[json.class];
    if (!klass) throw new TypeError(`Property table ${json.name ?? ''} names class ${json.class}, which the schema lacks; add the class to the schema or fix the table`);
    if (!Number.isInteger(json.count) || json.count < 0)
      throw new TypeError(`Property table ${json.name ?? json.class}: count must be a whole number of 0 or more`);
    const definitions = klass.properties ?? {};
    this.names = Object.keys(definitions);
    for (const [name, column] of Object.entries(json.properties ?? {})) {
      const definition = definitions[name];
      if (!definition) throw new TypeError(`Property table ${json.class}: property ${name} is not in the class; add it to the class or remove the column`);
      const enumDef = definition.type === 'ENUM' ? schema.enums?.[definition.enumType ?? ''] : undefined;
      if (definition.type === 'ENUM' && !enumDef)
        throw new TypeError(`Property ${name}: enum ${definition.enumType} is not in the schema; add the enum to the schema`);
      this.columns.set(
        name,
        new Column(
          name,
          definition,
          column,
          json.count,
          views,
          enumDef && new Map(enumDef.values.map(({ name: n, value }) => [value, n])),
          enumDef?.valueType,
        ),
      );
    }
  }
  get name(): string | undefined {
    return this.json.name;
  }
  get class(): string {
    return this.json.class;
  }
  /** Number of rows (features). */
  get count(): number {
    return this.json.count;
  }
  /** One feature's value of a property: undefined for a row out of range or a property the class lacks. */
  get(row: number, name: string): unknown {
    if (!Number.isInteger(row) || row < 0 || row >= this.json.count) return undefined;
    const column = this.columns.get(name);
    if (column) return column.get(row);
    return this.schema.classes?.[this.json.class]?.properties?.[name]?.default;
  }
  /** Every property of one feature as an object. */
  row(row: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const name of this.names) out[name] = this.get(row, name);
    return out;
  }
}

/** One feature ID set of a primitive (`EXT_mesh_features.featureIds[i]`). */
export interface FeatureIdSet {
  readonly featureCount: number;
  readonly nullFeatureId?: number;
  readonly label?: string;
  /** The `_FEATURE_ID_n` vertex attribute, when the IDs are per vertex. */
  readonly attribute?: number;
  /** The feature ID texture, when the IDs are in a texture (read the texture yourself; see the README). */
  readonly texture?: { index: number; texCoord?: number; channels?: number[] };
  /** The property table these IDs index. */
  readonly propertyTable?: PropertyTable;
  /** One ID per vertex (attribute or implicit sets; undefined for a texture set). */
  readonly ids?: Uint32Array;
}

/** Metadata of one glTF: its schema, property tables and the feature ID sets of each mesh primitive. */
export interface StructuralMetadata {
  readonly schema?: StructuralSchemaJSON;
  readonly propertyTables: readonly PropertyTable[];
  /** `primitives[mesh][primitive]` lists that primitive's feature ID sets (empty when it has none). */
  readonly primitives: readonly (readonly (readonly FeatureIdSet[])[])[];
  /**
   * The feature a vertex belongs to and its properties: the `set`-th feature ID set of the primitive, or undefined
   * when the vertex has the null feature ID, no ID or the set has no property table.
   */
  feature(
    mesh: number,
    primitive: number,
    vertex: number,
    set?: number,
  ): { id: number; table?: PropertyTable; properties?: Record<string, unknown> } | undefined;
}

/** Options of {@link readStructuralMetadata}. */
export interface StructuralMetadataOptions {
  /** Bytes of an external buffer (`buffers[i].uri` that is not a data URI). Default: such buffers are missing. */
  buffer?: (index: number, uri: string) => Uint8Array | undefined;
}

interface GLTFJSON {
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }[];
  meshes?: { primitives: { attributes: Record<string, number>; extensions?: Record<string, unknown> }[] }[];
  extensions?: Record<string, unknown>;
}

function dataUri(uri: string): Uint8Array | undefined {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(uri);
  if (!match) return undefined;
  const raw = atob(match[1]);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const ACCESSOR: Record<number, [number, (v: DataView, at: number) => number]> = {
  5120: [1, (v, at) => v.getInt8(at)],
  5121: [1, (v, at) => v.getUint8(at)],
  5122: [2, (v, at) => v.getInt16(at, true)],
  5123: [2, (v, at) => v.getUint16(at, true)],
  5125: [4, (v, at) => v.getUint32(at, true)],
  5126: [4, (v, at) => v.getFloat32(at, true)],
};

/**
 * Reads the EXT_structural_metadata property tables and EXT_mesh_features feature IDs of a glTF: a GLB, glTF JSON
 * bytes (data URIs and `options.buffer` for buffers) or a tile's glTF / b3dm content bytes (`content.gltf`).
 * Throws a TypeError or RangeError naming the problem for a malformed table; never reads out of bounds.
 */
export function readStructuralMetadata(gltf: Uint8Array, options: StructuralMetadataOptions = {}): StructuralMetadata {
  let json: GLTFJSON, bin: Uint8Array | undefined;
  if (isGLB(gltf)) {
    const chunks = glbChunks(gltf),
      head = chunks.find((c) => c.type === GLB_JSON);
    if (!head) throw new TypeError('GLB has no JSON chunk; the file is not valid glTF 2.0');
    json = JSON.parse(text.decode(head.data));
    bin = chunks.find((c) => c.type === GLB_BIN)?.data;
  } else json = JSON.parse(text.decode(gltf));
  const buffers = new Map<number, Uint8Array>();
  const bufferBytes = (index: number): Uint8Array => {
    let bytes = buffers.get(index);
    if (bytes) return bytes;
    const buffer = json.buffers?.[index];
    if (!buffer) throw new TypeError(`glTF buffer ${index} does not exist; the file is corrupt`);
    bytes = buffer.uri === undefined ? bin : (dataUri(buffer.uri) ?? options.buffer?.(index, buffer.uri));
    if (!bytes)
      throw new TypeError(
        `glTF buffer ${index} (${buffer.uri ?? 'GLB BIN'}) is missing; pass its bytes with the buffer option`,
      );
    buffers.set(index, bytes);
    return bytes;
  };
  const views: Views = (index, what) => {
    const view = json.bufferViews?.[index];
    if (!view) throw new TypeError(`${what}: bufferView ${index} does not exist; the file is corrupt`);
    const bytes = bufferBytes(view.buffer),
      start = view.byteOffset ?? 0;
    if (start + view.byteLength > bytes.byteLength)
      throw new RangeError(`${what}: bufferView ${index} is past its buffer; the file is truncated or corrupt`);
    return bytes.subarray(start, start + view.byteLength);
  };
  const ext = json.extensions?.EXT_structural_metadata as
    | { schema?: StructuralSchemaJSON; schemaUri?: string; propertyTables?: PropertyTableJSON[] }
    | undefined;
  const schema = ext?.schema;
  if (ext?.propertyTables?.length && !schema)
    throw new TypeError('EXT_structural_metadata uses schemaUri; only an embedded schema is read');
  const tables = (ext?.propertyTables ?? []).map((t) => new PropertyTable(t, schema!, views));
  const scalarIds = (accessorIndex: number, count: number): Uint32Array => {
    const accessor = json.accessors?.[accessorIndex];
    if (!accessor || accessor.type !== 'SCALAR' || !ACCESSOR[accessor.componentType])
      throw new TypeError(`Feature ID accessor ${accessorIndex} must be a SCALAR of a glTF component type`);
    const out = new Uint32Array(count);
    if (accessor.bufferView === undefined) return out;
    const [size, read] = ACCESSOR[accessor.componentType],
      view = json.bufferViews![accessor.bufferView],
      bytes = views(accessor.bufferView, `feature ID accessor ${accessorIndex}`),
      stride = view?.byteStride ?? size,
      base = accessor.byteOffset ?? 0,
      data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (accessor.count > 0 && base + (accessor.count - 1) * stride + size > bytes.byteLength)
      throw new RangeError(`Feature ID accessor ${accessorIndex} is past its buffer view; the file is corrupt`);
    for (let i = 0; i < Math.min(count, accessor.count); i++) out[i] = read(data, base + i * stride);
    return out;
  };
  const primitives = (json.meshes ?? []).map((mesh) =>
    mesh.primitives.map((primitive) => {
      const features = primitive.extensions?.EXT_mesh_features as
        | { featureIds?: (Omit<FeatureIdSet, 'propertyTable' | 'ids'> & { propertyTable?: number })[] }
        | undefined;
      const position = primitive.attributes.POSITION,
        vertices = position === undefined ? 0 : (json.accessors?.[position]?.count ?? 0);
      return (features?.featureIds ?? []).map((set): FeatureIdSet => {
        if (set.propertyTable !== undefined && !tables[set.propertyTable])
          throw new TypeError(`Feature ID set names property table ${set.propertyTable}, which the glTF lacks; the file is corrupt, re-export it`);
        let ids: Uint32Array | undefined;
        if (set.attribute !== undefined) {
          const accessor = primitive.attributes[`_FEATURE_ID_${set.attribute}`];
          if (accessor === undefined)
            throw new TypeError(`Feature ID set uses attribute _FEATURE_ID_${set.attribute}, which the primitive lacks; the file is corrupt, re-export it`);
          ids = scalarIds(accessor, vertices);
        } else if (!set.texture) ids = Uint32Array.from({ length: vertices }, (_, i) => i);
        return {
          ...set,
          propertyTable: set.propertyTable === undefined ? undefined : tables[set.propertyTable],
          ids,
        };
      });
    }),
  );
  return {
    schema,
    propertyTables: tables,
    primitives,
    feature(mesh, primitive, vertex, set = 0) {
      const ids = primitives[mesh]?.[primitive]?.[set];
      const id = ids?.ids?.[vertex];
      if (!ids || id === undefined || id === ids.nullFeatureId) return undefined;
      const table = ids.propertyTable;
      return { id, table, properties: table?.row(id) };
    },
  };
}

/** A Draco point cloud decoder: `DracoPointsDecoder` from `@margoengine/decoders/draco-points` is one. */
export interface DracoPointsSource {
  decode(
    data: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<{
    pointCount: number;
    attributes: { uniqueId: number; array: ArrayLike<number>; itemSize: number; normalized: boolean }[];
  }>;
}

let shared: DracoPointsSource | undefined;
async function defaultDecoder(): Promise<DracoPointsSource> {
  if (shared) return shared;
  const { DracoPointsDecoder } = await import('@margoengine/decoders/draco-points');
  shared ??= new DracoPointsDecoder() as unknown as DracoPointsSource;
  return shared;
}

/**
 * Decodes Draco-compressed pnts content (3DTILES_draco_point_compression) into ordinary point content: POSITION, RGBA
 * or RGB, NORMAL and BATCH_ID from the Draco buffer, and the batch table properties the extension names. Content that
 * is not compressed comes back as it is. Pass it to the renderer as `TilesRenderer.load(engine, url, { dracoPoints })`.
 */
export async function dracoPoints(
  content: PointsContent,
  signal?: AbortSignal,
  decoder?: DracoPointsSource,
): Promise<PointsContent> {
  const draco = content.draco;
  if (!draco) return content;
  const decoded = await (decoder ?? (await defaultDecoder())).decode(draco.bytes, { signal });
  signal?.throwIfAborted();
  const n = decoded.pointCount;
  if (n !== draco.length)
    throw new TypeError(`Draco pnts holds ${n} points but POINTS_LENGTH is ${draco.length}; the file is corrupt, re-encode it`);
  const attribute = (name: string, id: number | undefined, size: number) => {
    if (id === undefined) return undefined;
    const found = decoded.attributes.find((a) => a.uniqueId === id);
    if (!found) throw new TypeError(`Draco pnts names attribute ${id} for ${name}, which the Draco buffer lacks; the file is corrupt, re-encode it`);
    if (found.itemSize !== size || found.array.length < n * size)
      throw new TypeError(`Draco pnts ${name} has ${found.itemSize} components per point; ${size} are needed`);
    return found;
  };
  const p = draco.properties,
    position = attribute('POSITION', p.POSITION, 3),
    rgba = attribute('RGBA', p.RGBA, 4),
    rgb = rgba ? undefined : attribute('RGB', p.RGB, 3),
    normal = attribute('NORMAL', p.NORMAL, 3),
    batch = attribute('BATCH_ID', p.BATCH_ID, 1);
  if (!position) throw new TypeError('Draco pnts must compress POSITION (3DTILES_draco_point_compression)');
  let colors = content.colors;
  if (rgba || rgb) {
    const source = (rgba ?? rgb)!,
      size = rgba ? 4 : 3,
      scale = source.normalized && !(source.array instanceof Uint8Array) ? 255 : 1;
    colors = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < size; k++) colors[i * 4 + k] = source.array[i * size + k] * scale;
      if (size === 3) colors[i * 4 + 3] = 255;
    }
  }
  let batchTable = content.batchTable;
  if (draco.batchProperties && batchTable) {
    const json: Record<string, unknown> = { ...batchTable.json };
    for (const [name, id] of Object.entries(draco.batchProperties)) {
      const found = decoded.attributes.find((a) => a.uniqueId === id);
      if (!found) throw new TypeError(`Draco pnts batch property ${name} names attribute ${id}, which the buffer lacks; the file is corrupt, re-encode it`);
      const size = found.itemSize,
        values = Array.from(found.array);
      json[name] = size === 1 ? values : Array.from({ length: n }, (_, i) => values.slice(i * size, i * size + size));
    }
    batchTable = new BatchTable(json, batchTable.binary, batchTable.length);
  }
  return {
    ...content,
    positions: Float32Array.from(position.array as ArrayLike<number>),
    colors,
    normals: normal ? Float32Array.from(normal.array as ArrayLike<number>) : content.normals,
    batchIds: batch ? Uint32Array.from(batch.array as ArrayLike<number>) : content.batchIds,
    batchTable,
    draco: undefined,
  };
}
