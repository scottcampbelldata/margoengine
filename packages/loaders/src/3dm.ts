// Rhino 3DM files through a caller-owned rhino3dm runtime: meshes, layers and object attributes.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { floats, limits, toBytes, uints, type BinaryInput } from './util.js';

const F = '3DM';
/** Metres per unit, by the file's unit system number. */
const UNITS: Record<number, number> = {
  1: 1e-6,
  2: 1e-3,
  3: 1e-2,
  4: 1,
  5: 1e3,
  6: 1e-10,
  7: 1e-9,
  8: 0.0254,
  9: 0.3048,
  10: 1609.344,
};

interface Disposable {
  delete?(): void;
}
interface IndexedList<T> extends Disposable {
  count: number;
  get(index: number): T;
}
interface RhinoColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The part of a rhino3dm mesh this entry reads. */
export interface RhinoMesh extends Disposable {
  vertices(): IndexedList<number[]>;
  faces(): IndexedList<number[]>;
  normals?(): IndexedList<number[]>;
  textureCoordinates?(): IndexedList<number[]>;
  vertexColors?(): IndexedList<RhinoColor>;
}
/** What an object's geometry may offer. Anything with no mesh is counted in `skipped`. */
export interface RhinoGeometry extends Disposable {
  vertices?: RhinoMesh['vertices'];
  vertexColors?: RhinoMesh['vertexColors'];
  getMesh?(type: unknown): RhinoMesh | null | undefined;
  faces?(): IndexedList<{ getMesh(type: unknown): RhinoMesh | null | undefined } & Disposable>;
}
/** The part of a rhino3dm object's attributes this entry reads. */
export interface RhinoAttributes extends Disposable {
  name?: string;
  id?: string;
  layerIndex?: number;
  materialIndex?: number;
  visible?: boolean;
  drawColor?(document: unknown): RhinoColor;
  getUserStrings?(): [string, string][];
}
/** The part of a rhino3dm layer this entry reads. */
export interface RhinoLayer extends Disposable {
  name?: string;
  fullPath?: string;
  color?: RhinoColor;
  visible?: boolean;
}
/** The part of a rhino3dm file this entry reads. */
export interface RhinoDocument extends Disposable {
  objects(): IndexedList<{ geometry(): RhinoGeometry; attributes(): RhinoAttributes } & Disposable>;
  layers(): IndexedList<RhinoLayer>;
  settings?(): { modelUnitSystem?: { value?: number } | number } & Disposable;
}
/** A loaded rhino3dm module: `await rhino3dm()`. The caller owns it and its Wasm file. */
export interface RhinoRuntime {
  File3dm: { fromByteArray(bytes: Uint8Array): RhinoDocument | null | undefined };
  MeshType?: { Any?: unknown };
}

/** Options of {@link parse3DM}. */
export interface ThreeDMOptions extends ParseLimits {
  /** `'meters'` (default) scales by the file's unit when it has one; `'file'` keeps the file's own units. */
  units?: 'meters' | 'file';
  /** Read objects that are hidden, or on a hidden layer. Default false. */
  hidden?: boolean;
}

/** One layer of a {@link ThreeDMResult}. */
export interface ThreeDMLayer {
  name: string;
  /** The name with its parents, `Parent::Child`, when the file has one. */
  path: string;
  /** sRGB `[r, g, b, a]` in [0,1]. */
  color: [number, number, number, number];
  visible: boolean;
}

/** One object read into a {@link ThreeDMResult}: a range of `indices` with what the file says about it. */
export interface ThreeDMGroup extends LoadedGroup {
  /** The object's id. */
  id?: string;
  /** Index into `layers`. */
  layer?: number;
  /** The file's material index, -1 for none. */
  material?: number;
  /** Key and value text the object carries. Null prototype. */
  userStrings: Record<string, string>;
}

/** What {@link parse3DM} returns: one merged mesh, with a group per object. */
export interface ThreeDMResult extends LoadedGeometry {
  groups: ThreeDMGroup[];
  layers: ThreeDMLayer[];
  /** Metres per file unit, when the file names a unit. */
  metersPerUnit?: number;
  /** Objects without a mesh, such as curves, points and solids saved without their render mesh. */
  skipped: number;
}

const unit = (color: RhinoColor | undefined): [number, number, number, number] =>
  color ? [color.r / 255, color.g / 255, color.b / 255, color.a === undefined ? 1 : color.a / 255] : [1, 1, 1, 1];

/**
 * Frees a rhino3dm object. The runtime's tables, such as `File3dmLayerTable`, have a method of their own called `delete`
 * that removes an entry by id, which hides the handle's `delete`, so the free comes from the handle's base prototype,
 * the one that owns `isDeleted`. A plain object without that base has only its own `delete`.
 */
function free(value: Disposable): void {
  let owner: object | null = value;
  while (owner && !Object.hasOwn(owner, 'isDeleted')) owner = Object.getPrototypeOf(owner);
  ((owner ?? value) as Disposable).delete?.call(value);
}

/** Runs `use` on a rhino3dm object and frees it, because its memory is outside JavaScript's reach. */
function using<T extends Disposable, R>(value: T, use: (value: T) => R): R {
  try {
    return use(value);
  } finally {
    free(value);
  }
}

/**
 * Reads the meshes, layers and attributes of a Rhino `.3dm` file through a rhino3dm runtime you load and own, so its Wasm
 * file is never part of this package. Each object becomes a group of one merged mesh:
 * a mesh as it is, and any other surface object through the render mesh saved in the file. Objects without one are
 * counted in `skipped`; the runtime meshes nothing on its own.
 *
 * @param rhino The loaded module.
 * @param input The file's bytes.
 * @param options The shared size limits, units and whether hidden objects load.
 * @returns The mesh, with a group per object, and the file's layers.
 * @throws LoaderError with code `header` for a file the runtime cannot read, `limit`, `range` or `syntax`.
 *
 * @example
 * ```ts
 * import { parse3DM, type RhinoRuntime } from '@margoengine/loaders/3dm';
 *
 * // `rhino` is `await rhino3dm()`, from the rhino3dm package you install and host.
 * export async function loadChair(rhino: RhinoRuntime) {
 *   const bytes = await (await fetch('/models/chair.3dm')).arrayBuffer();
 *   const { groups, layers } = parse3DM(rhino, bytes);
 *   console.log(groups[0].name, layers[groups[0].layer ?? 0].name);
 * }
 * ```
 */
export function parse3DM(rhino: RhinoRuntime, input: BinaryInput, options: ThreeDMOptions = {}): ThreeDMResult {
  const bytes = toBytes(input, F),
    { maxVertices, maxTriangles } = limits(options, F);
  if (options.units !== undefined && options.units !== 'meters' && options.units !== 'file')
    throw new LoaderError(F, 'range', 'units must be "meters" or "file"');
  if (typeof rhino?.File3dm?.fromByteArray !== 'function')
    throw new LoaderError(F, 'range', 'pass a loaded rhino3dm module: await rhino3dm()');
  const document = rhino.File3dm.fromByteArray(bytes);
  if (!document) throw new LoaderError(F, 'header', 'rhino3dm cannot read this file');
  return using(document, () => read(rhino, document, options, maxVertices, maxTriangles));
}

function read(
  rhino: RhinoRuntime,
  document: RhinoDocument,
  options: ThreeDMOptions,
  maxVertices: number,
  maxTriangles: number,
): ThreeDMResult {
  const positions = floats(),
    normals = floats(),
    uvs = floats(),
    colors = floats(),
    indices = uints(),
    groups: ThreeDMGroup[] = [],
    meshType = rhino.MeshType?.Any;
  let hasNormals = false,
    hasUVs = false,
    hasColors = false,
    skipped = 0;

  const layers = using(document.layers(), (table) => {
    const out: ThreeDMLayer[] = [];
    for (let i = 0; i < table.count; i++)
      using(table.get(i), (layer) => {
        const name = layer.name ?? '';
        out.push({ name, path: layer.fullPath ?? name, color: unit(layer.color), visible: layer.visible !== false });
      });
    return out;
  });

  let scale = 1,
    metersPerUnit: number | undefined;
  if (document.settings)
    using(document.settings(), (settings) => {
      const system = settings.modelUnitSystem,
        value = typeof system === 'number' ? system : system?.value;
      metersPerUnit = value === undefined ? undefined : UNITS[value];
    });
  if (metersPerUnit !== undefined && options.units !== 'file') scale = metersPerUnit;

  const addMesh = (mesh: RhinoMesh): void => {
    const base = positions.length / 3;
    const count = using(mesh.vertices(), (vertices) => {
      if (base + vertices.count > maxVertices)
        throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
      for (let i = 0; i < vertices.count; i++) {
        const [x, y, z] = vertices.get(i);
        positions.push3(x * scale, y * scale, z * scale);
      }
      return vertices.count;
    });
    using(mesh.faces(), (faces) => {
      for (let i = 0; i < faces.count; i++) {
        const [a, b, c, d] = faces.get(i),
          quad = d !== undefined && d !== c;
        if (indices.length / 3 + (quad ? 2 : 1) > maxTriangles)
          throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${maxTriangles}`);
        for (const corner of quad ? [a, b, c, d] : [a, b, c])
          if (!(corner >= 0 && corner < count))
            throw new LoaderError(F, 'range', `face index ${corner} is outside 0..${count - 1}`);
        indices.push3(base + a, base + b, base + c);
        if (quad) indices.push3(base + a, base + c, base + d);
      }
    });
    // Each optional array has one entry per vertex or none; a mesh without one takes neutral values, so all stay aligned.
    const list = <T>(table: IndexedList<T> | undefined, each: (value: T) => void, fill: () => void): boolean => {
      const complete = table?.count === count;
      for (let i = 0; i < count; i++)
        if (complete) each(table.get(i));
        else fill();
      if (table) free(table);
      return complete;
    };
    if (list(mesh.normals?.(), ([x, y, z]) => normals.push3(x, y, z), () => normals.push3(0, 0, 0))) hasNormals = true;
    const uv = (u: number, v: number): void => {
      uvs.push(u);
      uvs.push(v);
    };
    if (list(mesh.textureCoordinates?.(), ([u, v]) => uv(u, 1 - v), () => uv(0, 0))) hasUVs = true;
    if (list(mesh.vertexColors?.(), (c) => colors.push3(c.r / 255, c.g / 255, c.b / 255), () => colors.push3(1, 1, 1)))
      hasColors = true;
  };

  /** Adds the object's meshes and says whether it had any. */
  const addGeometry = (geometry: RhinoGeometry): boolean => {
    // A solid has `vertices` and `faces` too, of another kind; only a mesh has vertex colours.
    if (geometry.vertices && geometry.vertexColors) {
      addMesh(geometry as unknown as RhinoMesh);
      return true;
    }
    if (geometry.getMesh) {
      const mesh = geometry.getMesh(meshType);
      if (!mesh) return false;
      using(mesh, addMesh);
      return true;
    }
    if (!geometry.faces) return false;
    return using(geometry.faces(), (faces) => {
      let any = false;
      for (let i = 0; i < faces.count; i++)
        using(faces.get(i), (face) => {
          const mesh = face.getMesh(meshType);
          if (!mesh) return;
          using(mesh, addMesh);
          any = true;
        });
      return any;
    });
  };

  using(document.objects(), (table) => {
    for (let i = 0; i < table.count; i++)
      using(table.get(i), (object) =>
        using(object.attributes(), (attributes) => {
          const layer = attributes.layerIndex,
            onLayer = layer === undefined ? undefined : layers[layer];
          if (!options.hidden && (attributes.visible === false || onLayer?.visible === false)) return;
          const start = indices.length;
          const added = using(object.geometry(), addGeometry);
          if (!added) {
            skipped++;
            return;
          }
          const userStrings: Record<string, string> = Object.create(null);
          for (const [key, value] of attributes.getUserStrings?.() ?? []) userStrings[key] = value;
          const group: ThreeDMGroup = { start, count: indices.length - start, userStrings };
          if (attributes.name) group.name = attributes.name;
          if (attributes.id) group.id = attributes.id;
          if (layer !== undefined) group.layer = layer;
          if (attributes.materialIndex !== undefined) group.material = attributes.materialIndex;
          const drawn = attributes.drawColor?.(document) ?? onLayer?.color;
          if (drawn) group.color = Array.isArray(drawn) ? [...drawn] as ThreeDMGroup['color'] : unit(drawn as RhinoColor);
          groups.push(group);
        }),
      );
  });

  const result: ThreeDMResult = {
    kind: 'mesh',
    positions: positions.result(),
    indices: indices.result(),
    groups,
    layers,
    skipped,
  };
  if (hasNormals) result.normals = normals.result();
  if (hasUVs) result.uvs = uvs.result();
  if (hasColors) result.colors = colors.result();
  if (metersPerUnit !== undefined) result.metersPerUnit = metersPerUnit;
  return result;
}
