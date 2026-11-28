import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { floats, limits, throwIfAborted, toBytes, uints, type BinaryInput, type Growable } from './util.js';
import { readZipDirectory, readZipEntry, type ZipEntry, type ZipOptions } from './zip.js';
import { decodeXML, readXML, type XMLExternalOptions } from './xml.js';
import { hexColor } from '@margoengine/math/color';
import type { VolumeFill } from './threemf-volume-colour.js';

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
export interface ThreeMFOptions
  extends ParseLimits,
    XMLExternalOptions,
    Pick<ZipOptions, 'maxEntries' | 'maxEntryBytes' | 'maxRatio'> {
  /** `'meters'` (default) scales by the model unit; `'file'` keeps the file's own units. */
  units?: 'meters' | 'file';
  /** Component nesting limit. Default 32. */
  maxDepth?: number;
  /**
   * Most model parts (production extension) one package may hold, the root included. Default 65,535: every part a
   * ZIP without ZIP64 can carry, as each part is its own entry and `maxBytes`, `maxTriangles` and `maxEntryBytes`
   * still bound the work. For 3MF `maxEntries` also defaults to 65,535.
   */
  maxModelParts?: number;
  /**
   * Which of a production extension object's alternative representations to read: the first alternative of this
   * resolution stands in for the object, which is kept when there is none. Default `'fullres'`.
   */
  modelResolution?: 'fullres' | 'lowres' | 'obfuscated';
  signal?: AbortSignal;
}

/** 3MF result: the merged triangle mesh plus the model unit and metadata. */
export interface ThreeMFResult extends LoadedGeometry {
  kind: 'mesh';
  unit: string;
  /** The production extension's UUID of the build, when the package gives one. */
  buildUUID?: string;
  /** `<metadata>` entries by name, in a null-prototype object (names come from the file). */
  metadata: Record<string, string>;
}

type Color = [number, number, number, number];
interface MeshData {
  vertices: Growable<Float32Array>;
  triangles: Growable<Uint32Array>;
  pid: Growable<Uint32Array>;
  p: Growable<Uint32Array>;
  /** For each triangle of an evaluated mesh, the colour its group takes: that of the triangle it came from. */
  flat?: (Color | undefined)[];
  /** The volume colour that fills the mesh's solid, sampled onto its surface once the surface is final. */
  fill?: VolumeFill;
  /** For a mesh made of several solids' surfaces, the volume colour of each triangle, instead of `fill`. */
  fills?: (VolumeFill | undefined)[];
}
interface BooleanReference {
  objectId: string;
  path?: string;
  transform: Float64Array;
}
interface BooleanData {
  operation: string;
  base: BooleanReference;
  operands: BooleanReference[];
}
interface ObjectData {
  id: string;
  name?: string;
  type: string;
  partNumber?: string;
  uuid?: string;
  pid?: string;
  pindex?: number;
  mesh?: MeshData;
  /** The object's mesh holds a beam lattice, which the core reader makes no triangles of. */
  beamLattice?: boolean;
  /** The mesh is a `displacementmesh`: these are its base triangles. */
  displaced?: boolean;
  /** The object's shape is a volumetric level set, which has no triangles. */
  levelSet?: boolean;
  /** The object's shape is a boolean operation on other objects (boolean operations extension). */
  boolean?: BooleanData;
  components: { objectId: string; path?: string; uuid?: string; transform: Float64Array }[];
  alternatives: { objectId: string; path?: string; uuid?: string; resolution: string }[];
}
interface Model {
  unit: string;
  objects: Map<string, ObjectData>;
  properties: Map<string, Color[]>;
  propertyIds: string[];
  items: { objectId: string; path?: string; uuid?: string; transform: Float64Array; partNumber?: string }[];
  metadata: Record<string, string>;
  buildUUID?: string;
}

/** The namespace of the production extension's `path` and `UUID` attributes. */
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

/** A parsed model part, as an extension of the 3MF reader sees it. */
export type ThreeMFModel = Model;
/** An object of a model part, as an extension of the 3MF reader sees it. */
export type ThreeMFObject = ObjectData;
/** An object's triangles, as an extension of the 3MF reader sees them. */
export type ThreeMFMesh = MeshData;

/** Package-part access for optional 3MF extensions that reference additional model streams. */
export interface ThreeMFReadContext {
  models: ReadonlyMap<string, ThreeMFModel>;
  loadModelPart(path: string): Promise<ThreeMFModel>;
  /** The package path of a model part, or undefined for the root. */
  partPath(model: ThreeMFModel): string | undefined;
}

/** What the materials entry adds to the 3MF reader: more elements, and one call per written triangle corner. */
export interface ThreeMFExtension {
  /** Observe any element; returning true consumes it before the core-format reader (for 2D slice vertices). */
  element?(model: ThreeMFModel, name: string, attributes: Record<string, string>): boolean | void;
  /** One built object with its composed row-vector affine transform and output unit scale. */
  instance?(model: ThreeMFModel, object: ObjectData, transform: Float64Array, scale: number, depth: number): void;
  /** True only when a built native primitive provides geometry despite an empty triangle fallback. */
  hasGeometry?(): boolean;
  /** The elements of volumetric and displacement resources, whose names the core format and other extensions reuse. */
  field?: {
    open(model: ThreeMFModel, name: string, attributes: Record<string, string>): void;
    close(model: ThreeMFModel, name: string): void;
  };
  /** The extension reads level set objects, which the core reader otherwise refuses. */
  levelSets?: boolean;
  /** The extension reads boolean shape objects, which the core reader otherwise refuses. */
  booleans?: boolean;
  /** The extension writes nothing per corner, so meshes stay indexed as `parse3MF` gives them. */
  welded?: boolean;
  /** An element the reader does not know, with its attributes. */
  open?(model: ThreeMFModel, name: string, attributes: Record<string, string>): void;
  /** The end of any element. */
  close?(model: ThreeMFModel, name: string): void;
  /** Every model part is parsed; `read` returns a package part's bytes. */
  ready?(read: (path: string) => Promise<Uint8Array>, context: ThreeMFReadContext): Promise<void>;
  /** Extra text for a triangle's group key: triangles with different keys get different groups. */
  bucket(model: ThreeMFModel, object: ObjectData, mesh: MeshData, triangle: number): string;
  /** Corner `corner` of `triangle` has just been written as the next vertex. */
  corner(model: ThreeMFModel, object: ObjectData, mesh: MeshData, triangle: number, corner: number): void;
  /** A group is finished; `triangle` is its first triangle. */
  group(group: LoadedGroup, model: ThreeMFModel, object: ObjectData, mesh: MeshData, triangle: number): void;
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
/** Property resources of the core and materials formats, which share one set of ids. */
const PROPERTY_RESOURCES = new Set([
  'basematerials',
  'colorgroup',
  'texture2d',
  'texture2dgroup',
  'compositematerials',
  'multiproperties',
  'pbmetallicdisplayproperties',
  'pbspeculardisplayproperties',
  'translucentdisplayproperties',
  'pbmetallictexturedisplayproperties',
  'pbspeculartexturedisplayproperties',
]);
/** Resource elements whose content only an extension reads (volumetric, implicit and displacement extensions). */
const FIELDS = new Set([
  'image3d',
  'functionfromimage3d',
  'implicitfunction',
  'volumedata',
  'displacement2d',
  'normvectorgroup',
  'disp2dgroup',
]);

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
  external?: XMLExternalOptions['external'],
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
  const propertyIds = model.propertyIds,
    resourceIds = new Set<string>(),
    /** The namespace each prefix was last declared for. */
    prefixes = new Map<string, string>();
  /** A production extension attribute, under whatever prefix the part declares for it (`p` when it declares none). */
  const production = (a: Record<string, string>, local: string): string | undefined => {
    for (const key in a) {
      const at = key.indexOf(':');
      if (at < 0 || key.slice(at + 1) !== local) continue;
      const prefix = key.slice(0, at);
      if ((prefixes.get(prefix) ?? (prefix === 'p' ? PRODUCTION : '')) === PRODUCTION) return a[key];
    }
    return undefined;
  };
  let object: ObjectData | undefined,
    colors: Color[] | undefined,
    metadataName: string | undefined,
    metadataText = '',
    // 3MF Core 1.4 section 4.1: <metadata> inside an object's or item's <metadatagroup> describes that element, not
    // the model, so only top-level entries reach the model metadata.
    metadataGroups = 0,
    /** Inside a slice stack, whose vertices are the layers' 2D points and no mesh's. */
    sliceStacks = 0,
    /** The depth inside a resource of `FIELDS`. */
    field = 0;
  let vertexCount = 0,
    triangleCount = 0,
    sawModel = false;
  readXML(
    xml,
    {
      open(name, a) {
        for (const key in a) if (key.startsWith('xmlns:')) prefixes.set(key.slice(6), a[key]);
        if (field || FIELDS.has(name)) {
          field++;
          extension?.field?.open(model, name, a);
          return;
        }
        if (extension?.element?.(model, name, a)) return;
        if (name === 'slicestack') sliceStacks++;
        if (sliceStacks) return;
        if (PROPERTY_RESOURCES.has(name) && a.id) {
          // A second resource of one id would silently replace the first.
          if (resourceIds.has(a.id))
            throw new LoaderError(F, 'syntax', `duplicate property resource id ${a.id.slice(0, 32)}`);
          resourceIds.add(a.id);
        }
        switch (name) {
          case 'model':
            if (sawModel) throw new LoaderError(F, 'syntax', 'nested <model>');
            sawModel = true;
            model.unit = a.unit ?? 'millimeter';
            if (!Object.hasOwn(THREEMF_UNITS, model.unit))
              throw new LoaderError(F, 'unsupported', `unknown unit "${model.unit.slice(0, 32)}"`);
            break;
          case 'metadatagroup':
            metadataGroups++;
            break;
          case 'metadata':
            metadataName = metadataGroups ? undefined : a.name;
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
              partNumber: a.partnumber,
              uuid: production(a, 'UUID'),
              pid: a.pid,
              pindex: a.pindex === undefined ? undefined : index(a.pindex, 'pindex'),
              components: [],
              alternatives: [],
            };
            model.objects.set(a.id, object);
            break;
          }
          case 'mesh':
          case 'displacementmesh':
            if (!object) throw new LoaderError(F, 'syntax', `<${name}> outside <object>`);
            object.mesh = { vertices: floats(), triangles: uints(), pid: uints(), p: uints() };
            if (name === 'displacementmesh') object.displaced = true;
            break;
          case 'booleanshape':
          case 'boolean': {
            const shape = name === 'boolean' ? object?.boolean : object;
            if (!shape)
              throw new LoaderError(
                F,
                'syntax',
                `<${name}> outside ${name === 'boolean' ? '<booleanshape>' : '<object>'}`,
              );
            if (!a.objectid) throw new LoaderError(F, 'syntax', `<${name}> without objectid`);
            // The extension's own attributes are unqualified, `path` among them.
            const reference = {
              objectId: a.objectid,
              path: a.path ?? production(a, 'path'),
              transform: parseTransform(a.transform),
            };
            if (name === 'boolean') object!.boolean!.operands.push(reference);
            else object!.boolean = { operation: a.operation ?? 'union', base: reference, operands: [] };
            break;
          }
          case 'beamlattice':
            if (object) object.beamLattice = true;
            extension?.open?.(model, name, a);
            break;
          case 'levelset':
            if (!object) throw new LoaderError(F, 'syntax', '<levelset> outside <object>');
            object.levelSet = true;
            extension?.open?.(model, name, a);
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
            object.components.push({
              objectId: a.objectid,
              path: production(a, 'path'),
              uuid: production(a, 'UUID'),
              transform: parseTransform(a.transform),
            });
            break;
          }
          case 'alternative': {
            if (!object) throw new LoaderError(F, 'syntax', '<alternative> outside <object>');
            if (!a.objectid) throw new LoaderError(F, 'syntax', '<alternative> without objectid');
            // The alternatives namespace's own attributes are unqualified, as its schema and sample write them.
            object.alternatives.push({
              objectId: a.objectid,
              path: a.path ?? production(a, 'path'),
              uuid: a.UUID ?? production(a, 'UUID'),
              resolution: a.modelresolution ?? 'fullres',
            });
            break;
          }
          case 'build':
            model.buildUUID = production(a, 'UUID');
            break;
          case 'item':
            if (!a.objectid) throw new LoaderError(F, 'syntax', '<item> without objectid');
            model.items.push({
              objectId: a.objectid,
              path: production(a, 'path'),
              uuid: production(a, 'UUID'),
              transform: parseTransform(a.transform),
              partNumber: a.partnumber,
            });
            break;
          default:
            extension?.open?.(model, name, a);
        }
      },
      close(name) {
        if (field) {
          field--;
          extension?.field?.close(model, name);
          return;
        }
        extension?.close?.(model, name);
        if (name === 'slicestack') sliceStacks--;
        if (name === 'object') object = undefined;
        else if (name === 'basematerials' || name === 'colorgroup') colors = undefined;
        else if (name === 'metadatagroup') metadataGroups--;
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
    { external },
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
 * Parses a 3MF package (core specification, plus basematerials and the materials extension colorgroup, and the
 * production extension: items and components in other model parts, UUIDs and alternative representations). Build item
 * and component transforms are baked into the positions, which are converted to meters by default. The result has one
 * group per build item object and color; `colors` is present only when some triangle has per-corner colors. A
 * displacement mesh gives its base triangles, in groups marked `displaced`; a volumetric level set or a boolean shape
 * throws `unsupported`.
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
    maxDepth = options.maxDepth ?? 32,
    maxModelParts = options.maxModelParts ?? 65_535;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0)
    throw new LoaderError(F, 'range', 'maxDepth must be a non-negative integer');
  if (!Number.isSafeInteger(maxModelParts) || maxModelParts < 1)
    throw new LoaderError(F, 'range', 'maxModelParts must be a positive integer');
  if (options.units !== undefined && options.units !== 'meters' && options.units !== 'file')
    throw new LoaderError(F, 'range', `units must be "meters" or "file"`);
  if (!['fullres', 'lowres', 'obfuscated', undefined].includes(options.modelResolution))
    throw new LoaderError(F, 'range', 'modelResolution must be "fullres", "lowres" or "obfuscated"');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new LoaderError(F, 'header', 'not a ZIP package (missing PK signature)');
  // A part is an entry, so the entry limit follows the part limit unless the caller sets it.
  const entries = readZipDirectory(bytes, { ...options, maxEntries: options.maxEntries ?? 65_535 });
  const byPath = new Map<string, ZipEntry>();
  for (const entry of entries) byPath.set(normalizePath(entry.name), entry);
  const read = async (path: string): Promise<Uint8Array> => {
    throwIfAborted(options.signal, F);
    const entry = byPath.get(normalizePath(path));
    if (!entry) throw new LoaderError(F, 'syntax', `package part "${path.slice(0, 128)}" is missing`);
    const data = await readZipEntry(bytes, entry, options);
    // The secure content extension's cipher files start `%3McF`.
    if (data[0] === 0x25 && data[1] === 0x33 && data[2] === 0x4d && data[3] === 0x63 && data[4] === 0x46)
      throw new LoaderError(
        F,
        'unsupported',
        `package part "${path.slice(0, 128)}" is encrypted; parse3MFKeystore from @margoengine/loaders/threemf-secure reads its key data, and decrypting it is the caller's`,
      );
    return data;
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
  const models = new Map<string, Model>(),
    /** The package path of each model part. */
    partPaths = new Map<Model, string>();
  const load = async (path: string): Promise<Model> => {
    const key = normalizePath(path);
    let model = models.get(key);
    if (!model) {
      if (models.size >= maxModelParts)
        throw new LoaderError(F, 'limit', `package names more than ${maxModelParts} model parts (maxModelParts)`);
      model = parseModel(decodeXML(await read(path)), limit, extension, options.external);
      models.set(key, model);
      partPaths.set(model, '/' + byPath.get(key)!.name.replace(/^\/+/, ''));
    }
    return model;
  };
  const root = await load(rootPath);
  /** The paths a model part's objects name, in components and alternatives. */
  const named = (model: Model): string[] =>
    [...model.objects.values()].flatMap((o) =>
      [...o.components, ...o.alternatives, ...(o.boolean ? [o.boolean.base, ...o.boolean.operands] : [])].flatMap(
        ({ path }) => (path ? [path] : []),
      ),
    );
  // Load every model part the root names before the synchronous build walk. A part's own build is ignored.
  for (const path of [...root.items.flatMap(({ path }) => (path ? [path] : [])), ...named(root)]) await load(path);
  for (const model of models.values())
    if (model !== root && named(model).length)
      throw new LoaderError(
        F,
        'syntax',
        `${partPaths.get(model)!.slice(0, 128)}: only the root model part may name another part (production extension 3.2)`,
      );
  const partPath = (model: Model): string | undefined => (model === root ? undefined : partPaths.get(model));
  await extension?.ready?.(read, { models, loadModelPart: load, partPath });
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
  /** The part number and UUID of the build item being emitted. */
  let itemPartNumber: string | undefined, itemUUID: string | undefined;
  /** What the production extension says of the object being emitted. */
  let identity: Pick<LoadedGroup, 'uuid' | 'componentUUID' | 'alternativeUUID'> = {};
  const wanted = options.modelResolution ?? 'fullres';
  /** A built object that is a beam lattice and no triangles, so an empty result can say why. */
  let latticeOnly: string | undefined;
  const emitMesh = (model: Model, o: ObjectData, mesh: MeshData, m: Float64Array): void => {
    const vertexCount = mesh.vertices.length / 3,
      triangleCount = mesh.triangles.length / 3;
    if (!triangleCount && o.beamLattice) latticeOnly ??= o.id;
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
      const own = mesh.flat ? mesh.flat[t] : c[0],
        key = (own ? own.join(',') : '') + suffix(t);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = { color: own, triangles: [] }));
      bucket.triangles.push(t);
    }
    const unweld = (!!colors && colored) || (!!extension && !extension.welded);
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
      if (o.type !== 'model') group.objectType = o.type;
      if (o.partNumber !== undefined) group.partNumber = o.partNumber;
      if (o.displaced) group.displaced = true;
      if (itemPartNumber !== undefined) group.itemPartNumber = itemPartNumber;
      if (itemUUID !== undefined) group.itemUUID = itemUUID;
      if (identity.uuid !== undefined) group.uuid = identity.uuid;
      if (identity.componentUUID !== undefined) group.componentUUID = identity.componentUUID;
      if (identity.alternativeUUID !== undefined) group.alternativeUUID = identity.alternativeUUID;
      if (model !== root) group.modelPath = partPaths.get(model);
      if (bucket.color) group.color = [...bucket.color];
      extension?.group(group, model, o, mesh, bucket.triangles[0]);
      groups.push(group);
    }
  };
  const visiting = new Set<ObjectData>();
  // Components may reuse an object many times per level: bound the expanded instances, not just the depth, or
  // fan-out^depth references to an empty object never finish (meshes are also bounded by the vertex limits).
  let instances = 0;
  const emit = (
    model: Model,
    id: string,
    path: string | undefined,
    m: Float64Array,
    depth: number,
    componentUUID?: string,
  ): void => {
    if (depth > maxDepth) throw new LoaderError(F, 'limit', `components nest deeper than ${maxDepth}`);
    if (++instances > MAX_INSTANCES)
      throw new LoaderError(F, 'limit', `the build expands to more than ${MAX_INSTANCES} object instances`);
    const [owner, o] = object(model, id, path);
    if (visiting.has(o))
      throw new LoaderError(F, 'syntax', `object ${id.slice(0, 32)} references itself through its components`);
    if (o.mesh && o.components.length)
      throw new LoaderError(F, 'syntax', `object ${id.slice(0, 32)} has both a mesh and components`);
    // Production alternatives: the first one of the resolution asked for stands in for the object, whose own content
    // has the lowest priority.
    const alternative = o.alternatives.find(({ resolution }) => resolution === wanted);
    let [source, shown] = [owner, o];
    if (alternative) {
      [source, shown] = object(owner, alternative.objectId, alternative.path);
      if (shown.alternatives.length)
        throw new LoaderError(F, 'syntax', `alternative object ${shown.id.slice(0, 32)} has alternatives of its own`);
      if (shown.mesh && shown.components.length)
        throw new LoaderError(F, 'syntax', `object ${shown.id.slice(0, 32)} has both a mesh and components`);
    }
    // Core 3MF: an `other` mesh is never output, however it is reached; the type of an object of components is ignored.
    if (shown.mesh && shown.type === 'other') return;
    if (shown.boolean && !extension?.booleans)
      throw new LoaderError(
        F,
        'unsupported',
        `object ${shown.id.slice(0, 32)} is a boolean shape; read the package with parse3MFBoolean from @margoengine/loaders/threemf-boolean`,
      );
    if (shown.levelSet && !extension?.levelSets)
      throw new LoaderError(
        F,
        'unsupported',
        `object ${shown.id.slice(0, 32)} is a volumetric level set; read the package with parse3MFVolumetric from @margoengine/loaders/threemf-volumetric`,
      );
    visiting.add(o);
    extension?.instance?.(source, shown, m, scale, depth);
    identity = { uuid: o.uuid, componentUUID, alternativeUUID: alternative?.uuid };
    if (shown.mesh) emitMesh(source, shown, shown.mesh, m);
    for (const component of shown.components)
      emit(source, component.objectId, component.path, compose(component.transform, m), depth + 1, component.uuid);
    visiting.delete(o);
  };
  for (const item of root.items) {
    itemPartNumber = item.partNumber;
    itemUUID = item.uuid;
    emit(root, item.objectId, item.path, item.transform, 0);
  }
  if (!indices.length && !extension?.hasGeometry?.()) {
    if (latticeOnly !== undefined)
      throw new LoaderError(
        F,
        'syntax',
        `the build contains no triangles: object ${latticeOnly.slice(0, 32)} is a beam lattice with none of its own; parse3MFEvaluated from @margoengine/loaders/threemf-evaluate makes them`,
      );
    throw new LoaderError(F, 'syntax', 'the build contains no triangles');
  }
  const result: ThreeMFResult = {
    kind: 'mesh',
    positions: positions.result(),
    indices: indices.result(),
    groups,
    unit: root.unit,
    metadata: root.metadata,
  };
  if (root.buildUUID !== undefined) result.buildUUID = root.buildUUID;
  if (colors) result.colors = colors.result();
  return result;
}
