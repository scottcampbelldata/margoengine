// The reader of the 3MF Displacement Extension as hooks of the core reader, so that `parse3MFDisplacement` and
// `parse3MFEvaluated` share it.
import type {
  ThreeMFDisplacementGroup,
  ThreeMFDisplacementMap,
  ThreeMFDisplacementMesh,
  ThreeMFDisplacementOptions,
  ThreeMFDisplacementResult,
} from './threemf-displacement.js';
import { tessellate, type HeightGroup, type HeightMap } from './threemf-tessellate.js';
import type { ThreeMFExtension, ThreeMFModel } from './threemf.js';
import { LoaderError } from './types.js';
import { floats, limits, throwIfAborted, type Growable } from './util.js';

const F = '3MF';

const bad = (message: string): never => {
  throw new LoaderError(F, 'syntax', message);
};
const required = (a: Record<string, string>, key: string, element: string): string =>
  a[key] ?? bad(`<${element}> without ${key}`);
const number = (value: string | undefined, what: string, fallback?: number): number => {
  if (value === undefined) return fallback ?? bad(`missing ${what}`);
  const n = Number(value);
  return value.trim() && Number.isFinite(n) ? n : bad(`invalid ${what}`);
};
const index = (value: string | undefined, count: number, what: string): number => {
  const n = number(value, what);
  if (!Number.isInteger(n) || n < 0 || n >= count)
    throw new LoaderError(F, 'range', `${what} ${String(value).slice(0, 16)} is outside 0..${count - 1}`);
  return n;
};

interface Group {
  id: string;
  mapId: string;
  vectorsId: string;
  height: number;
  offset: number;
  coords: Growable<Float32Array>;
  normals: number[];
}

interface Part {
  maps: Map<string, Omit<ThreeMFDisplacementMap, 'data'>>;
  vectors: Map<string, number[]>;
  groups: Map<string, Group>;
  meshes: Map<string, { groups: number[]; corners: number[] }>;
  group?: Group;
  list?: number[];
  object?: string;
  /** The displacement mesh being read, with its default group. */
  mesh?: { groups: number[]; corners: number[]; did?: string };
}

/** The groups of one model part with their maps decoded by `@margoengine/decoders`, loaded only for a displaced mesh. */
async function heightGroups(groups: readonly ThreeMFDisplacementGroup[], maps: readonly ThreeMFDisplacementMap[]) {
  const { decodePNG } = await import('@margoengine/decoders/png'),
    pictures = new Map<Uint8Array, { width: number; height: number; data: Uint16Array }>();
  return groups.map(({ mapId, modelPath, height, offset, coordinates, vectors }): HeightGroup => {
    const map = maps.find((m) => m.id === mapId && m.modelPath === modelPath)!;
    let picture = pictures.get(map.data);
    if (!picture) {
      try {
        pictures.set(map.data, (picture = decodePNG(map.data, { bitDepth: 16 })));
      } catch (error) {
        bad(`${map.path.slice(0, 128)}: ${(error as Error).message}`);
      }
    }
    const heights: HeightMap = {
      ...picture!,
      channel: 'RGBA'.indexOf(map.channel),
      tileU: map.tileU,
      tileV: map.tileV,
      nearest: map.filter === 'nearest',
    };
    return { height, offset, coordinates, vectors, map: heights };
  });
}

/** The displacement reader's hooks. */
export function displacementStage(options: ThreeMFDisplacementOptions) {
  const { samplesPerTexel = 1, maxSegments = 256 } = options;
  if (!(Number.isFinite(samplesPerTexel) && samplesPerTexel > 0))
    throw new LoaderError(F, 'range', 'samplesPerTexel must be a positive number');
  if (!(Number.isInteger(maxSegments) && maxSegments >= 1 && maxSegments <= 65_536))
    throw new LoaderError(F, 'range', 'maxSegments must be an integer from 1 to 65536');
  const parts = new Map<ThreeMFModel, Part>(),
    listed = new Map<ThreeMFModel, Map<string, ThreeMFDisplacementMesh>>(),
    maps: ThreeMFDisplacementMap[] = [],
    groups: ThreeMFDisplacementGroup[] = [],
    meshes: ThreeMFDisplacementMesh[] = [];
  const part = (model: ThreeMFModel): Part => {
    let found = parts.get(model);
    if (!found)
      parts.set(model, (found = { maps: new Map(), vectors: new Map(), groups: new Map(), meshes: new Map() }));
    return found;
  };
  const resource = (p: Part, a: Record<string, string>, element: string): string => {
    const id = required(a, 'id', element);
    if (p.maps.has(id) || p.vectors.has(id) || p.groups.has(id)) bad(`duplicate resource id ${id.slice(0, 32)}`);
    return id;
  };
  const hooks: ThreeMFExtension = {
    welded: true,
    field: {
      open(model, name, a) {
        const p = part(model);
        if (name === 'displacement2d') {
          const id = resource(p, a, name),
            channel = a.channel ?? 'G';
          if (!['R', 'G', 'B', 'A'].includes(channel)) bad(`invalid displacement channel ${channel.slice(0, 8)}`);
          p.maps.set(id, {
            id,
            path: required(a, 'path', name),
            channel: channel as ThreeMFDisplacementMap['channel'],
            tileU: a.tilestyleu ?? 'wrap',
            tileV: a.tilestylev ?? 'wrap',
            filter: a.filter ?? 'auto',
          });
        } else if (name === 'normvectorgroup') {
          const id = resource(p, a, name);
          p.vectors.set(id, (p.list = []));
        } else if (name === 'normvector' && p.list) {
          const v = [number(a.x, 'normvector x'), number(a.y, 'normvector y'), number(a.z, 'normvector z')],
            length = Math.hypot(...v);
          if (!(length > 0)) bad('a displacement vector has no length');
          // Consumers normalize vectors that are not (displacement extension 3.2.1).
          p.list.push(v[0] / length, v[1] / length, v[2] / length);
        } else if (name === 'disp2dgroup') {
          const id = resource(p, a, name),
            group: Group = {
              id,
              mapId: required(a, 'dispid', name),
              vectorsId: required(a, 'nid', name),
              height: number(a.height, 'height'),
              offset: number(a.offset, 'offset', 0),
              coords: floats(),
              normals: [],
            };
          if (!p.maps.has(group.mapId) || !p.vectors.has(group.vectorsId))
            bad(`disp2dgroup ${id.slice(0, 32)} names a map or vector group not defined before it`);
          p.groups.set(id, (p.group = group));
        } else if (name === 'disp2dcoord' && p.group) {
          const vectors = p.vectors.get(p.group.vectorsId)!,
            factor = number(a.f, 'f', 1);
          if (factor < 0) bad('a displacement factor is negative');
          p.group.coords.push3(number(a.u, 'u'), number(a.v, 'v'), factor);
          p.group.normals.push(index(a.n, vectors.length / 3, 'vector index'));
        }
      },
      close(model, name) {
        const p = part(model);
        if (name === 'normvectorgroup') p.list = undefined;
        else if (name === 'disp2dgroup') p.group = undefined;
      },
    },
    element(model, name, a) {
      const p = part(model);
      if (name === 'object') p.object = a.id;
      else if (name === 'displacementmesh' && p.object !== undefined) {
        p.mesh = { groups: [], corners: [] };
        p.meshes.set(p.object, p.mesh);
      } else if (name === 'triangles' && p.mesh) p.mesh.did = a.did;
      else if (name === 'triangle' && p.mesh) {
        const { d1, d2 = d1, d3 = d1, did = p.mesh.did } = a;
        if (d1 === undefined) {
          p.mesh.groups.push(-1);
          p.mesh.corners.push(-1, -1, -1);
          return;
        }
        const group = did === undefined ? undefined : p.groups.get(did);
        if (!group) bad(`a displaced triangle of object ${String(p.object).slice(0, 32)} names no disp2dgroup`);
        const count = group!.coords.length / 3;
        // The group's place in its part for now; `ready` turns it into its place in the result.
        p.mesh.groups.push([...p.groups.keys()].indexOf(did!));
        p.mesh.corners.push(index(d1, count, 'd1'), index(d2, count, 'd2'), index(d3, count, 'd3'));
      }
    },
    close(model, name) {
      if (name === 'displacementmesh') part(model).mesh = undefined;
    },
    instance(model, object, m, scale) {
      listed
        .get(model)
        ?.get(object.id)
        ?.instances.push(m.map((v) => v * scale));
    },
    async ready(bytes, { models, partPath }) {
      const files = new Map<string, Uint8Array>();
      for (const model of models.values()) {
        const p = parts.get(model);
        if (!p) continue;
        const modelPath = partPath(model),
          where = modelPath === undefined ? {} : { modelPath },
          first = groups.length,
          own = new Map<string, ThreeMFDisplacementMesh>();
        listed.set(model, own);
        for (const map of p.maps.values()) {
          let data = files.get(map.path);
          if (!data) files.set(map.path, (data = await bytes(map.path)));
          maps.push({ ...map, ...where, data });
        }
        for (const { id, mapId, vectorsId, height, offset, coords, normals } of p.groups.values()) {
          const list = p.vectors.get(vectorsId)!,
            vectors = new Float32Array(normals.length * 3);
          normals.forEach((n, i) => vectors.set(list.slice(n * 3, n * 3 + 3), i * 3));
          groups.push({ id, ...where, mapId, height, offset, coordinates: coords.result(), vectors });
        }
        for (const [objectId, found] of p.meshes) {
          const data = model.objects.get(objectId)!.mesh!,
            mesh: ThreeMFDisplacementMesh = {
              objectId,
              ...where,
              positions: data.vertices.result(),
              indices: data.triangles.result(),
              triangleGroups: Int32Array.from(found.groups, (g) => (g < 0 ? -1 : g + first)),
              triangleCoordinates: Int32Array.from(found.corners),
              instances: [],
            };
          own.set(objectId, mesh);
          meshes.push(mesh);
        }
        if (options.tessellate === false || !p.meshes.size) continue;
        const heights = await heightGroups(groups.slice(first), maps);
        for (const [objectId, found] of p.meshes) {
          throwIfAborted(options.signal, F);
          const object = model.objects.get(objectId)!;
          object.mesh = tessellate(
            model,
            object,
            object.mesh!,
            found.groups.map((g) => heights[g]),
            found.corners,
            { samplesPerTexel, maxSegments, maxTriangles: limits(options, F).maxTriangles },
          );
        }
      }
    },
    bucket: () => '',
    corner() {},
    group() {},
  };
  return {
    hooks,
    /** What the reader adds to the core result, once the build has been walked. */
    result(): Pick<ThreeMFDisplacementResult, 'maps' | 'displacementGroups' | 'meshes'> {
      return { maps, displacementGroups: groups, meshes: meshes.filter((m) => m.instances.length) };
    },
  };
}
