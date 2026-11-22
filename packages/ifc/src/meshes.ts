// Mesh readers of /scene, kept free of @margoengine/materials so the streaming worker can bundle them. readIFCMeshes
// and streamIFCMeshes read the same element list in the same order (envelope classes first, then file order), chunk
// by chunk with one web-ifc GetFlatMesh per element, so a streamed load and a whole load give the same placements.
import { checkColor, checkPlacement } from './index.js';
import { checkAbort, checkModel, deletedLines, fail, native, type IFCModel } from './open.js';

/** One representation's triangles in its own coordinates (meters, engine axes): web-ifc's geometryExpressID. */
export interface IFCMeshGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}
/** One placed geometry of an element. */
export interface IFCPlacement {
  /** The element's expressID. */
  element: number;
  /** Key into `geometries`. */
  geometry: number;
  /** Column-major placement, translation already rebased by `origin` in float64. */
  matrix: Float64Array;
  /** Surface colour, sRGB and alpha, 0..1. */
  color: [number, number, number, number];
}
/** What readIFCMeshes returns: structured-cloneable, so a worker can read it. */
export interface IFCMeshes {
  schema: string;
  /** The point subtracted from every placement (engine axes, meters). */
  origin: [number, number, number];
  geometries: Map<number, IFCMeshGeometry>;
  placements: IFCPlacement[];
}
/** Options of readIFCMeshes and streamIFCMeshes. */
export interface IFCMeshOptions {
  signal?: AbortSignal;
  /** As readIFCGeometry's `origin`. Default none. */
  origin?: 'auto' | readonly [number, number, number];
  /** Only these elements (expressIDs, for example one storey's from readIFCData). Default every IfcProduct. */
  elements?: Iterable<number>;
  /** Read IfcSpace volumes too. Default false. IfcOpeningElement voids are never read. */
  spaces?: boolean;
  /**
   * `'envelope'` reads walls, slabs, roofs and curtain walls first, then the other building elements, then the rest
   * (furniture, services, proxies), each in file order, so the first chunks already show the building's shell;
   * `'file'` reads in file (expressID) order. Default `'envelope'`.
   */
  order?: 'envelope' | 'file';
}
/** Options of streamIFCMeshes. */
export interface IFCStreamOptions extends IFCMeshOptions {
  /** Elements read per chunk, 1 to 1,000,000. Default 256. */
  chunk?: number;
}
/**
 * One chunk of streamIFCMeshes: the placements of the elements read since the last chunk and the geometries first
 * used by them (a geometry a later chunk places again is not sent again). `loaded` of `total` elements are read.
 */
export interface IFCMeshChunk extends IFCMeshes {
  loaded: number;
  total: number;
}

const SHELL = /^IFC(WALL|SLAB|ROOF|CURTAINWALL)/,
  BUILT =
    /^IFC(COLUMN|BEAM|MEMBER|PLATE|WINDOW|DOOR|STAIR|RAMP|RAILING|COVERING|FOOTING|PILE|CHIMNEY|SHADINGDEVICE|BUILDINGELEMENTPART|BUILTELEMENT|BUILDINGELEMENT$)/;
const ids = (vector: { size(): number; get(i: number): number }) => {
  const out: number[] = [];
  for (let i = 0; i < vector.size(); i++) out.push(vector.get(i));
  return out;
};

/** The elements a mesh read visits, in reading order. */
function elementsOf(model: IFCModel, options: IFCMeshOptions): number[] {
  const { api, id } = model,
    order = options.order ?? 'envelope';
  if (order !== 'envelope' && order !== 'file') fail('range', "order must be 'envelope' or 'file'");
  const type = (code: number) => native('reading the schema', () => api.GetLineIDsWithType(id, code, true));
  const skip = new Set(deletedLines(model));
  // web-ifc's own type codes, which are the same in every schema it reads.
  for (const e of ids(type(3588315303 /* IFCOPENINGELEMENT */))) skip.add(e);
  if (!options.spaces) for (const e of ids(type(3856911033 /* IFCSPACE */))) skip.add(e);
  const products = new Set(ids(type(4208778838 /* IFCPRODUCT */)));
  let list: number[];
  if (options.elements === undefined) list = [...products];
  else {
    list = [];
    for (const e of new Set(options.elements)) {
      if (!Number.isSafeInteger(e)) fail('range', 'elements must be expressIDs; pass integers');
      if (products.has(e)) list.push(e);
    }
  }
  list = list.filter((e) => !skip.has(e)).sort((a, b) => a - b);
  if (order === 'file') return list;
  const rank = (e: number) => {
    const name = native('reading a type', () => api.GetNameFromTypeCode(api.GetLineType(id, e))).toUpperCase();
    return SHELL.test(name) ? 0 : BUILT.test(name) ? 1 : 2;
  };
  const ranks = new Map(list.map((e) => [e, rank(e)]));
  return list.sort((a, b) => ranks.get(a)! - ranks.get(b)! || a - b);
}

function originOf(origin: IFCMeshOptions['origin']): [number, number, number] | undefined {
  if (origin === undefined) return [0, 0, 0];
  if (origin === 'auto') return undefined;
  if (!(Array.isArray(origin) && origin.length === 3 && origin.every(Number.isFinite)))
    fail('range', "origin must be 'auto' or three finite numbers");
  return [origin[0], origin[1], origin[2]];
}

/**
 * The chunks of a mesh read, one per `chunk` elements. Chunks with no placements are left out, except the last,
 * whose `loaded` equals `total`. @internal
 */
export function* meshChunks(model: IFCModel, options: IFCStreamOptions = {}): Generator<IFCMeshChunk> {
  checkModel(model);
  const size = options.chunk ?? 256;
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_000_000)
    fail('range', 'chunk must be an integer from 1 to 1,000,000');
  let origin = originOf(options.origin);
  checkAbort(options.signal);
  const { api, id } = model,
    list = elementsOf(model, options),
    read = new Set<number>(),
    stored = new Set<number>(),
    total = list.length;
  for (let at = 0; at < total || at === 0; at += size) {
    checkAbort(options.signal);
    const part = list.slice(at, at + size),
      geometries = new Map<number, IFCMeshGeometry>(),
      placements: IFCPlacement[] = [];
    // One GetFlatMesh per element: web-ifc 0.0.78's StreamMeshes passes its browser build an argument that build's
    // binding rejects ("called with 4 arguments, expected 3"); GetFlatMesh reads the same placed geometries everywhere.
    for (const element of part) {
      checkAbort(options.signal);
      const mesh = native('reading meshes', () => api.GetFlatMesh(id, element, true));
      try {
        for (let i = 0; i < mesh.geometries.size(); i++) {
          const placed = mesh.geometries.get(i),
            key = placed.geometryExpressID,
            m = placed.flatTransformation;
          checkPlacement(m);
          origin ??= [Math.round(m[12]), Math.round(m[13]), Math.round(m[14])];
          if (!read.has(key)) {
            read.add(key);
            const geometry = native('reading a mesh', () => readGeometry(model, key));
            if (geometry) geometries.set(key, geometry), stored.add(key);
          }
          // A geometry with no triangles is not placed.
          if (!stored.has(key)) continue;
          const matrix = Float64Array.from(m);
          for (let r = 0; r < 3; r++) matrix[12 + r] -= origin[r];
          placements.push({ element: mesh.expressID, geometry: key, matrix, color: checkColor(placed.color) });
        }
      } finally {
        (mesh.geometries as { delete?: () => void }).delete?.();
      }
    }
    const loaded = Math.min(at + size, total);
    if (placements.length || loaded === total)
      yield { schema: model.schema, origin: origin ?? [0, 0, 0], geometries, placements, loaded, total };
  }
}

/**
 * Reads every product's placed geometries from an open model, each distinct geometry once: the input of
 * createIFCScene. The model stays open. The result equals streamIFCMeshes' chunks joined.
 */
export function readIFCMeshes(model: IFCModel, options: IFCMeshOptions = {}): IFCMeshes {
  const out: IFCMeshes = { schema: '', origin: [0, 0, 0], geometries: new Map(), placements: [] };
  for (const c of meshChunks(model, { ...options, chunk: 1_000_000 })) {
    out.schema = c.schema;
    out.origin = c.origin;
    for (const [k, g] of c.geometries) out.geometries.set(k, g);
    for (const p of c.placements) out.placements.push(p);
  }
  return out;
}

/**
 * Reads an open model's meshes `chunk` elements at a time (default 256), yielding to the event loop between chunks so
 * the page keeps drawing: create the scene from the first chunk and `add` each later one, and the building appears
 * while the rest is read. Each chunk carries `loaded` and `total` for a progress bar. Aborting the signal rejects the
 * next step with LoaderError code `aborted`; the model stays open (it is the caller's). Every chunk structured-clones,
 * so streamIFCInWorker (`/worker`) yields the same chunks from a worker.
 */
export async function* streamIFCMeshes(
  model: IFCModel,
  options: IFCStreamOptions = {},
): AsyncGenerator<IFCMeshChunk, void, undefined> {
  for (const c of meshChunks(model, options)) {
    yield c;
    if (c.loaded < c.total) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** @internal One web-ifc geometry as positions, normals and indices; undefined when it has no triangles. */
export function readGeometry(model: IFCModel, geometryId: number): IFCMeshGeometry | undefined {
  const { api, id } = model,
    geometry = api.GetGeometry(id, geometryId);
  try {
    const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize()),
      faces = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
    if (vertices.length % 6 || faces.length % 3) fail('range', 'invalid geometry layout; export the file again');
    const count = vertices.length / 6;
    if (!faces.length) return;
    const positions = new Float32Array(count * 3),
      normals = new Float32Array(count * 3);
    for (let v = 0; v < count; v++)
      for (let k = 0; k < 3; k++) {
        positions[v * 3 + k] = vertices[v * 6 + k];
        normals[v * 3 + k] = vertices[v * 6 + 3 + k];
      }
    if (!positions.every(Number.isFinite) || !normals.every(Number.isFinite))
      fail('range', 'non-finite vertex; export the file again');
    const indices = Uint32Array.from(faces);
    for (const i of indices) if (i >= count) fail('range', 'index outside geometry; export the file again');
    return { positions, normals, indices };
  } finally {
    geometry.delete();
  }
}
