import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { floats, limits, throwIfAborted, toBytes, uints, type BinaryInput, type Growable } from './util.js';
import { readZipDirectory, readZipEntry, type ZipEntry, type ZipOptions } from './zip.js';
import { decodeXML, readXML } from './xml.js';
import { hexColor } from '@margoengine/math/color';

const F = '3MF';
const NONE = 0xffffffff;
// The per-file part cap shared by every loader that makes one mesh per part (docs/limits.md).
const MAX_INSTANCES = 100_000;
/** Meters per 3MF unit. */
export const THREEMF_UNITS: Readonly<Record<string, number>> = {
  micron: 1e-6,
  millimeter: 1e-3,
  centimeter: 1e-2,
  inch: 0.0254,
  foot: 0.3048,
  meter: 1,
};

/**
 * Options of parse3MF: size limits, zip limits, the unit handling, the component nesting depth and an AbortSignal.
 */
export interface ThreeMFOptions extends ParseLimits, Pick<ZipOptions, 'maxEntries' | 'maxEntryBytes' | 'maxRatio'> {
  /** `'meters'` (default) scales by the model unit; `'file'` keeps the file's own units. */
  units?: 'meters' | 'file';
  /** Component nesting limit. Default 32. */
  maxDepth?: number;
  signal?: AbortSignal;
}

/** 3MF result: the merged triangle mesh plus the model unit and metadata. */
export interface ThreeMFResult extends LoadedGeometry {
  kind: 'mesh';
  unit: string;
  /** `<metadata>` entries by name, in a null-prototype object (names come from the file). */
  metadata: Record<string, string>;
}

type Color = [number, number, number, number];
interface MeshData {
  vertices: Growable<Float32Array>;
  triangles: Growable<Uint32Array>;
  pid: Growable<Uint32Array>;
  p: Growable<Uint32Array>;
}
interface ObjectData {
  id: string;
  name?: string;
  type: string;
  pid?: string;
  pindex?: number;
  mesh?: MeshData;
  components: { objectId: string; path?: string; transform: Float64Array }[];
}
interface Model {
  unit: string;
  objects: Map<string, ObjectData>;
  properties: Map<string, Color[]>;
  propertyIds: string[];
  items: { objectId: string; path?: string; transform: Float64Array }[];
  metadata: Record<string, string>;
}

/** A parsed model part, as an extension of the 3MF reader sees it. */
export type ThreeMFModel = Model;

/** What the materials entry adds to the 3MF reader: more elements, and one call per written triangle corner. */
export interface ThreeMFExtension {
  /** An element the reader does not know, with its attributes. */
  open?(model: ThreeMFModel, name: string, attributes: Record<string, string>): void;
  /** The end of any element. */
  close?(model: ThreeMFModel, name: string): void;
  /** Every model part is parsed; `read` returns a package part's bytes. */
  ready?(read: (path: string) => Promise<Uint8Array>): Promise<void>;
  /** Extra text for a triangle's group key: triangles with different keys get different groups. */
  bucket(model: ThreeMFModel, object: ObjectData, mesh: MeshData, triangle: number): string;
  /** Corner `corner` of `triangle` has just been written as the next vertex. */
  corner(model: ThreeMFModel, object: ObjectData, mesh: MeshData, triangle: number, corner: number): void;
  /** A group is finished; `triangle` is its first triangle. */
  group(group: LoadedGroup, model: ThreeMFModel, object: ObjectData, mesh: MeshData, triangle: number): void;
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

function parseColor(value: string | undefined): Color {
  const rgba = hexColor(value?.trim() ?? '');
  if (!rgba) throw new LoaderError(F, 'syntax', `invalid color "${String(value).slice(0, 16)}"`);
  return rgba;
}

function parseTransform(value: string | undefined): Float64Array {
  if (value === undefined) return IDENTITY;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 12 || !parts.every(Number.isFinite))
    throw new LoaderError(F, 'syntax', `invalid transform "${value.slice(0, 64)}"`);
  return new Float64Array(parts);
}

/** Row-vector composition: apply `a`, then `b`. */
function compose(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(12);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 3; c++) {
      let sum = r === 3 ? b[9 + c] : 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = sum;
    }
  return out;
}

const determinant = (m: Float64Array): number =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

function index(value: string | undefined, what: string): number {
  if (value === undefined) return NONE;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number >= NONE)
    throw new LoaderError(F, 'range', `invalid ${what} "${value.slice(0, 32)}"`);
  return number;
}

function parseModel(
  xml: string,
  limit: { maxVertices: number; maxTriangles: number },
  extension?: ThreeMFExtension,
): Model {
  const model: Model = {
    unit: 'millimeter',
    objects: new Map(),
    properties: new Map(),
    propertyIds: [],
    items: [],
    // Null prototype: <metadata name="..."> comes from the file (`__proto__`, `constructor`, `hasOwnProperty`).
    metadata: Object.create(null),
  };
  const propertyIds = model.propertyIds;
  let object: ObjectData | undefined,
    colors: Color[] | undefined,
    metadataName: string | undefined,
    metadataText = '';
  let vertexCount = 0,
    triangleCount = 0,
    sawModel = false;
  readXML(
    xml,
    {
      open(name, a) {
        switch (name) {
          case 'model':
            if (sawModel) throw new LoaderError(F, 'syntax', 'nested <model>');
            sawModel = true;
            model.unit = a.unit ?? 'millimeter';
            if (!Object.hasOwn(THREEMF_UNITS, model.unit))
              throw new LoaderError(F, 'unsupported', `unknown unit "${model.unit.slice(0, 32)}"`);
            break;
          case 'metadata':
            metadataName = a.name;
            metadataText = '';
            break;
          case 'basematerials':
          case 'colorgroup':
            if (!a.id) throw new LoaderError(F, 'syntax', `<${name}> without id`);
            colors = [];
            model.properties.set(a.id, colors);
            propertyIds.push(a.id);
            break;
          case 'base':
            if (colors) colors.push(a.displaycolor ? parseColor(a.displaycolor) : [1, 1, 1, 1]);
            break;
          case 'color':
            if (colors) colors.push(parseColor(a.color));
            break;
          case 'object': {
            if (!a.id) throw new LoaderError(F, 'syntax', '<object> without id');
            if (model.objects.has(a.id)) throw new LoaderError(F, 'syntax', `duplicate object id ${a.id}`);
            object = {
              id: a.id,
              name: a.name,
              type: a.type ?? 'model',
              pid: a.pid,
              pindex: a.pindex === undefined ? undefined : index(a.pindex, 'pindex'),
              components: [],
            };
            model.objects.set(a.id, object);
            break;
          }
          case 'mesh':
            if (!object) throw new LoaderError(F, 'syntax', '<mesh> outside <object>');
            object.mesh = { vertices: floats(), triangles: uints(), pid: uints(), p: uints() };
            break;
          case 'vertex': {
            const mesh = object?.mesh;
            if (!mesh) throw new LoaderError(F, 'syntax', '<vertex> outside <mesh>');
            if (++vertexCount > limit.maxVertices)
              throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${limit.maxVertices}`);
            const x = Number(a.x),
              y = Number(a.y),
              z = Number(a.z);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
              throw new LoaderError(
                F,
                'syntax',
                `vertex ${mesh.vertices.length / 3} of object ${object!.id} has an invalid coordinate`,
              );
            mesh.vertices.push3(x, y, z);
            break;
          }
          case 'triangle': {
            const mesh = object?.mesh;
            if (!mesh) throw new LoaderError(F, 'syntax', '<triangle> outside <mesh>');
            if (++triangleCount > limit.maxTriangles)
              throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${limit.maxTriangles}`);
            const v1 = index(a.v1, 'v1'),
              v2 = index(a.v2, 'v2'),
              v3 = index(a.v3, 'v3');
            if (v1 === NONE || v2 === NONE || v3 === NONE)
              throw new LoaderError(
                F,
                'syntax',
                `triangle ${mesh.triangles.length / 3} of object ${object!.id} is missing v1, v2 or v3`,
              );
            mesh.triangles.push3(v1, v2, v3);
            let pid = NONE;
            if (a.pid !== undefined) {
              pid = propertyIds.indexOf(a.pid);
              if (pid < 0) pid = NONE - 1;
            }
            mesh.pid.push(pid);
            mesh.p.push3(index(a.p1, 'p1'), index(a.p2, 'p2'), index(a.p3, 'p3'));
            break;
          }
          case 'component': {
            if (!object) throw new LoaderError(F, 'syntax', '<component> outside <object>');
            if (!a.objectid) throw new LoaderError(F, 'syntax', '<component> without objectid');
            object.components.push({ objectId: a.objectid, path: a['p:path'], transform: parseTransform(a.transform) });
            break;
          }
          case 'item':
            if (!a.objectid) throw new LoaderError(F, 'syntax', '<item> without objectid');
            model.items.push({ objectId: a.objectid, path: a['p:path'], transform: parseTransform(a.transform) });
            break;
          default:
            extension?.open?.(model, name, a);
        }
      },
      close(name) {
        extension?.close?.(model, name);
        if (name === 'object') object = undefined;
        else if (name === 'basematerials' || name === 'colorgroup') colors = undefined;
        else if (name === 'metadata' && metadataName) {
          model.metadata[metadataName] = metadataText.trim();
          metadataName = undefined;
        }
      },
      text(text) {
        if (metadataName) metadataText += text;
      },
    },
    F,
  );
  if (!sawModel) throw new LoaderError(F, 'syntax', 'no <model> element');
  return model;
}

/**
 * The property a triangle corner names: the triangle's own `pid`, else its object's, and the corner's index, else the
 * triangle's first, else the object's `pindex`.
 */
export function cornerProperty(
  model: ThreeMFModel,
  object: ObjectData,
  mesh: MeshData,
  triangle: number,
  corner: number,
): { id: string; index: number } | undefined {
  const pid = mesh.pid.array[triangle],
    id = pid === NONE ? object.pid : pid === NONE - 1 ? undefined : model.propertyIds[pid];
  if (id === undefined) return undefined;
  const first = mesh.p.array[triangle * 3],
    fallback = first !== NONE ? first : (object.pindex ?? NONE),
    own = mesh.p.array[triangle * 3 + corner],
    index = own === NONE ? fallback : own;
  return index === NONE ? undefined : { id, index };
}

const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

/**
 * Parses a 3MF package (core specification, plus basematerials and the materials extension colorgroup, and
 * production extension `p:path` components). Build item and component
 * transforms are baked into the positions, which are converted to meters by default. The result has one
 * group per build item object and color; `colors` is present only when some triangle has per-corner colors.
 */
export async function parse3MF(input: BinaryInput, options: ThreeMFOptions = {}): Promise<ThreeMFResult> {
  return read3MF(input, options);
}

/** The reader behind {@link parse3MF}, with the hooks `@margoengine/loaders/threemf-materials` uses. */
export async function read3MF(
  input: BinaryInput,
  options: ThreeMFOptions,
  extension?: ThreeMFExtension,
): Promise<ThreeMFResult> {
  const bytes = toBytes(input, F),
    limit = limits(options, F),
    maxDepth = options.maxDepth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0)
    throw new LoaderError(F, 'range', 'maxDepth must be a non-negative integer');
  if (options.units !== undefined && options.units !== 'meters' && options.units !== 'file')
    throw new LoaderError(F, 'range', `units must be "meters" or "file"`);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new LoaderError(F, 'header', 'not a ZIP package (missing PK signature)');
  const entries = readZipDirectory(bytes, options);
  const byPath = new Map<string, ZipEntry>();
  for (const entry of entries) byPath.set(normalizePath(entry.name), entry);
  const read = async (path: string): Promise<Uint8Array> => {
    throwIfAborted(options.signal, F);
    const entry = byPath.get(normalizePath(path));
    if (!entry) throw new LoaderError(F, 'syntax', `package part "${path.slice(0, 128)}" is missing`);
    return readZipEntry(bytes, entry, options);
  };
  let rootPath = '3D/3dmodel.model';
  if (byPath.has('_rels/.rels')) {
    readXML(
      decodeXML(await read('_rels/.rels')),
      {
        open(name, a) {
          if (name === 'Relationship' && a.Type?.endsWith('/3dmodel') && a.Target) rootPath = a.Target;
        },
        close() {},
      },
      F,
    );
  }
  const models = new Map<string, Model>();
  const load = async (path: string): Promise<Model> => {
    const key = normalizePath(path);
    let model = models.get(key);
    if (!model) {
      if (models.size >= 1024) throw new LoaderError(F, 'limit', 'too many model parts');
      model = parseModel(decodeXML(await read(path)), limit, extension);
      models.set(key, model);
    }
    return model;
  };
  const root = await load(rootPath);
  // Load every model part referenced through p:path before the synchronous build walk.
  const pending = [root];
  while (pending.length) {
    const model = pending.pop()!;
    const paths = [
      ...model.items.map((i) => i.path),
      ...[...model.objects.values()].flatMap((o) => o.components.map((c) => c.path)),
    ];
    for (const path of paths) if (path && !models.has(normalizePath(path))) pending.push(await load(path));
  }
  await extension?.ready?.(read);
  throwIfAborted(options.signal, F);

  const scale = options.units === 'file' ? 1 : THREEMF_UNITS[root.unit];
  const resolveColors = (model: Model, object: ObjectData, mesh: MeshData, t: number): (Color | undefined)[] =>
    [0, 1, 2].map((k) => {
      const property = cornerProperty(model, object, mesh, t, k),
        group = property && model.properties.get(property.id);
      if (!group) return undefined;
      if (property.index >= group.length)
        throw new LoaderError(
          F,
          'range',
          `property index ${property.index} is outside property group ${property.id} (${group.length} entries)`,
        );
      return group[property.index];
    });
  const object = (model: Model, id: string, path: string | undefined): [Model, ObjectData] => {
    const owner = path ? models.get(normalizePath(path))! : model;
    const found = owner.objects.get(id);
    if (!found)
      throw new LoaderError(
        F,
        'syntax',
        `object ${id.slice(0, 32)} is not defined${path ? ` in ${path.slice(0, 128)}` : ''}`,
      );
    return [owner, found];
  };

  // Pass 1: does any referenced triangle need per-corner colors?
  let vertexColors = false;
  for (const model of models.values())
    for (const o of model.objects.values()) {
      if (!o.mesh || vertexColors) continue;
      for (let t = 0; t < o.mesh.triangles.length / 3 && !vertexColors; t++) {
        const [a, b, c] = resolveColors(model, o, o.mesh, t);
        vertexColors = a !== b || b !== c;
      }
    }

  const positions = floats(),
    indices = uints(),
    colors = vertexColors ? floats() : undefined,
    groups: LoadedGroup[] = [];
  const emitMesh = (model: Model, o: ObjectData, mesh: MeshData, m: Float64Array): void => {
    const vertexCount = mesh.vertices.length / 3,
      triangleCount = mesh.triangles.length / 3;
    if (!vertexCount && !triangleCount) return; // an empty mesh adds nothing; skip the per-instance bookkeeping
    const tri = mesh.triangles.array,
      source = mesh.vertices.array;
    for (let i = 0; i < tri.length && i < triangleCount * 3; i++)
      if (tri[i] >= vertexCount)
        throw new LoaderError(
          F,
          'range',
          `triangle index ${tri[i]} of object ${o.id} is outside 0..${vertexCount - 1}`,
        );
    const corner = (v: number): [number, number, number] => {
      const x = source[v * 3],
        y = source[v * 3 + 1],
        z = source[v * 3 + 2];
      return [
        (x * m[0] + y * m[3] + z * m[6] + m[9]) * scale,
        (x * m[1] + y * m[4] + z * m[7] + m[10]) * scale,
        (x * m[2] + y * m[5] + z * m[8] + m[11]) * scale,
      ];
    };
    const flip = determinant(m) < 0;
    // Bucket triangles by their first-corner color so each group has one uniform color.
    const buckets = new Map<string, { color?: Color; triangles: number[] }>(),
      suffix = (t: number): string => (extension ? `|${extension.bucket(model, o, mesh, t)}` : '');
    const triangleColors: (Color | undefined)[][] = [];
    let colored = false;
    for (let t = 0; t < triangleCount; t++) {
      const c = resolveColors(model, o, mesh, t);
      triangleColors.push(c);
      if (c[0]) colored = true;
      const key = (c[0] ? c[0].join(',') : '') + suffix(t);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = { color: c[0], triangles: [] }));
      bucket.triangles.push(t);
    }
    const unweld = (!!colors && colored) || !!extension;
    const base = positions.length / 3;
    if (base + (unweld ? triangleCount * 3 : vertexCount) > limit.maxVertices)
      throw new LoaderError(F, 'limit', `vertex count after instancing exceeds the limit of ${limit.maxVertices}`);
    if (indices.length / 3 + triangleCount > limit.maxTriangles)
      throw new LoaderError(F, 'limit', `triangle count after instancing exceeds the limit of ${limit.maxTriangles}`);
    if (!unweld)
      for (let v = 0; v < vertexCount; v++) {
        positions.push3(...corner(v));
        colors?.push3(1, 1, 1);
      }
    for (const bucket of buckets.values()) {
      const start = indices.length;
      for (const t of bucket.triangles) {
        const order = flip ? [0, 2, 1] : [0, 1, 2];
        for (const k of order) {
          const v = tri[t * 3 + k];
          if (unweld) {
            indices.push(positions.length / 3);
            positions.push3(...corner(v));
            const color = triangleColors[t][k] ?? [1, 1, 1, 1];
            colors?.push3(color[0], color[1], color[2]);
            extension?.corner(model, o, mesh, t, k);
          } else indices.push(base + v);
        }
      }
      const group: LoadedGroup = { start, count: indices.length - start, objectId: o.id };
      if (o.name) group.name = o.name;
      if (bucket.color) group.color = [...bucket.color];
      extension?.group(group, model, o, mesh, bucket.triangles[0]);
      groups.push(group);
    }
  };
  const visiting = new Set<ObjectData>();
  // Components may reuse an object many times per level: bound the expanded instances, not just the depth, or
  // fan-out^depth references to an empty object never finish (meshes are also bounded by the vertex limits).
  let instances = 0;
  const emit = (model: Model, id: string, path: string | undefined, m: Float64Array, depth: number): void => {
    if (depth > maxDepth) throw new LoaderError(F, 'limit', `components nest deeper than ${maxDepth}`);
    if (++instances > MAX_INSTANCES)
      throw new LoaderError(F, 'limit', `the build expands to more than ${MAX_INSTANCES} object instances`);
    const [owner, o] = object(model, id, path);
    if (visiting.has(o))
      throw new LoaderError(F, 'syntax', `object ${id.slice(0, 32)} references itself through its components`);
    if (o.mesh && o.components.length)
      throw new LoaderError(F, 'syntax', `object ${id.slice(0, 32)} has both a mesh and components`);
    visiting.add(o);
    if (o.mesh) emitMesh(owner, o, o.mesh, m);
    for (const component of o.components)
      emit(owner, component.objectId, component.path, compose(component.transform, m), depth + 1);
    visiting.delete(o);
  };
  for (const item of root.items) {
    const [, o] = object(root, item.objectId, item.path);
    if (o.type === 'other') continue;
    emit(root, item.objectId, item.path, item.transform, 0);
  }
  if (!indices.length) throw new LoaderError(F, 'syntax', 'the build contains no triangles');
  const result: ThreeMFResult = {
    kind: 'mesh',
    positions: positions.result(),
    indices: indices.result(),
    groups,
    unit: root.unit,
    metadata: root.metadata,
  };
  if (colors) result.colors = colors.result();
  return result;
}
