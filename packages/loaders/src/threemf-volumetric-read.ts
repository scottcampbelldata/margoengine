// The reader of the 3MF Volumetric and Implicit Extensions as hooks of the core reader, so that
// `parse3MFVolumetric` and `parse3MFEvaluated` share it.
import { beamReader, finishLattice } from './threemf-beam-reader.js';
import { threeMFBeamDistance } from './threemf-beams.js';
import type { FieldScope, Voxels } from './threemf-functions.js';
import type { ThreeMFBeamLattice } from './threemf-lattice.js';
import { MAX_CELLS, meshLevelSet } from './threemf-levelset.js';
import { colourMesh, MAX_COLOUR_SAMPLES } from './threemf-volume-colour.js';
import type {
  ThreeMFFunctionNode,
  ThreeMFImage3D,
  ThreeMFImageSampler,
  ThreeMFImplicit,
  ThreeMFPort,
  ThreeMFPortType,
  ThreeMFSampledField,
  ThreeMFVolumeData,
  ThreeMFVolumetricObject,
  ThreeMFVolumetricOptions,
  ThreeMFVolumetricResult,
} from './threemf-volumetric.js';
import type { ThreeMFExtension, ThreeMFMesh, ThreeMFModel } from './threemf.js';
import { LoaderError } from './types.js';
import { limits, throwIfAborted } from './util.js';

const F = '3MF';
const MAX_SHEETS = 65_536;
const MAX_BEAMS = 1_000_000;

const bad = (message: string): never => {
  throw new LoaderError(F, 'syntax', message);
};
const required = (a: Record<string, string>, key: string, element: string): string =>
  a[key] ?? bad(`<${element}> without ${key}`);
const number = (value: string | undefined, fallback: number, what: string): number => {
  if (value === undefined) return fallback;
  const n = Number(value);
  return value.trim() && Number.isFinite(n) ? n : bad(`invalid ${what}`);
};
/** An attribute under any prefix, as an extension qualifies those it adds to core elements. */
const prefixed = (a: Record<string, string>, name: string): string | undefined => {
  for (const key in a) if (key === name || key.endsWith(`:${name}`)) return a[key];
  return undefined;
};

interface Pending {
  functionId?: string;
  volumeId?: string;
  levelSet?: Omit<NonNullable<ThreeMFVolumetricObject['levelSet']>, 'domain'>;
}

/** One model part's resources, in the order it defines them. */
interface Part {
  namespaces: Map<string, string>;
  images: Map<string, ThreeMFImage3D & { count: number }>;
  functions: Map<string, ThreeMFImageSampler | ThreeMFImplicit>;
  volumes: Map<string, ThreeMFVolumeData>;
  objects: Map<string, Pending>;
  bases: Set<string>;
  lattices: Map<string, ThreeMFBeamLattice>;
  object?: string;
  image?: ThreeMFImage3D & { count: number };
  implicit?: ThreeMFImplicit;
  node?: ThreeMFFunctionNode;
  list?: 'in' | 'out';
  volume?: ThreeMFVolumeData;
}

/**
 * What one part's functions read: its image stacks, decoded by `@margoengine/decoders`, and distances to its meshes
 * from `@margoengine/bvh`, both loaded only for a package that has a level set.
 */
async function fieldScope(
  model: ThreeMFModel,
  part: Part,
  surfaces: ReadonlyMap<string, ThreeMFMesh>,
): Promise<FieldScope> {
  const [{ decodePNG }, { MeshBVH }, { pointInside }] = await Promise.all([
      import('@margoengine/decoders/png'),
      import('@margoengine/bvh'),
      import('@margoengine/bvh/inside'),
    ]),
    voxels = new Map<string, Voxels>();
  for (const f of part.functions.values()) {
    if (f.kind !== 'image' || voxels.has(f.imageId)) continue;
    const { rows, columns, sheets, id } = part.images.get(f.imageId)!;
    if (rows * columns * sheets.length > 2 ** 27)
      throw new LoaderError(F, 'limit', `image3d ${id.slice(0, 32)} holds more than ${2 ** 27} voxels`);
    const data = new Uint16Array(rows * columns * sheets.length * 4);
    sheets.forEach((sheet, i) => {
      let picture;
      try {
        picture = decodePNG(sheet.data, { bitDepth: 16, maxPixels: rows * columns });
      } catch (error) {
        bad(`${sheet.path.slice(0, 128)}: ${(error as Error).message}`);
      }
      if (picture!.width !== columns || picture!.height !== rows)
        bad(`${sheet.path.slice(0, 128)} is not ${columns} x ${rows} pixels`);
      data.set(picture!.data, i * rows * columns * 4);
    });
    voxels.set(f.imageId, { rows, columns, sheets: sheets.length, data });
  }
  const distances = new Map<string, (x: number, y: number, z: number) => number>();
  const lattices = new Map<string, (x: number, y: number, z: number) => number>();
  const scope: FieldScope = {
    functions: part.functions,
    voxels: (imageId) => voxels.get(imageId)!,
    lattice(objectId) {
      let found = lattices.get(objectId);
      if (!found) {
        const lattice =
            part.lattices.get(objectId) ?? bad(`a beamlattice node needs a lattice object ${objectId.slice(0, 32)}`),
          own = surfaces.get(objectId)!,
          beams = threeMFBeamDistance(own.vertices.result(), lattice),
          { clippingMode, clippingMesh } = lattice;
        if (clippingMode === 'none') found = beams;
        else {
          const clip = scope.distance(clippingMesh!, true),
            side = clippingMode === 'inside' ? 1 : -1;
          found = (x, y, z) => Math.max(beams(x, y, z), side * clip(x, y, z));
        }
        lattices.set(objectId, found);
      }
      return found;
    },
    distance(objectId, signed) {
      const key = `${signed} ${objectId}`;
      let found = distances.get(key);
      if (!found) {
        const mesh = surfaces.get(objectId);
        if (!mesh?.triangles.length) bad(`a distance needs a mesh object ${objectId.slice(0, 32)}`);
        const bvh = MeshBVH.build({ positions: mesh!.vertices.result(), stride: 3, indices: mesh!.triangles.result() }),
          at = [0, 0, 0];
        found = (x, y, z) => {
          at[0] = x;
          at[1] = y;
          at[2] = z;
          const { distance } = bvh.closestPointToPoint(at)!;
          return signed && pointInside(bvh, at) ? -distance : distance;
        };
        distances.set(key, found);
      }
      return found;
    },
  };
  return scope;
}

/**
 * The volumetric reader's hooks. `addLattices` runs for each model part once its level sets are meshed and before its
 * colours are sampled; `surfaces` holds the part's meshes without lattice triangles.
 */
export function volumetricStage(
  options: ThreeMFVolumetricOptions,
  addLattices?: (
    model: ThreeMFModel,
    lattices: ReadonlyMap<string, ThreeMFBeamLattice>,
    surfaces: ReadonlyMap<string, ThreeMFMesh>,
    modelPath: string | undefined,
  ) => Promise<void>,
) {
  const { levelSetResolution = 64, colorResolution = 32 } = options;
  if (!(Number.isInteger(levelSetResolution) && levelSetResolution >= 2 && levelSetResolution <= MAX_CELLS))
    throw new LoaderError(F, 'range', `levelSetResolution must be an integer from 2 to ${MAX_CELLS}`);
  if (!(Number.isInteger(colorResolution) && colorResolution >= 1 && colorResolution <= MAX_COLOUR_SAMPLES))
    throw new LoaderError(F, 'range', `colorResolution must be an integer from 1 to ${MAX_COLOUR_SAMPLES}`);
  const parts = new Map<ThreeMFModel, Part>(),
    /** Each object the result lists, by its model part and id. */
    listed = new Map<ThreeMFModel, Map<string, ThreeMFVolumetricObject>>(),
    result = { images: [], functions: [], volumes: [], objects: [] } as Pick<
      ThreeMFVolumetricResult,
      'images' | 'functions' | 'volumes' | 'objects'
    >;
  let sheets = 0,
    levelSets = 0;
  const beams = beamReader(MAX_BEAMS);
  const part = (model: ThreeMFModel): Part => {
    let found = parts.get(model);
    if (!found)
      parts.set(
        model,
        (found = {
          namespaces: new Map(),
          images: new Map(),
          functions: new Map(),
          volumes: new Map(),
          objects: new Map(),
          bases: new Set(),
          lattices: new Map(),
        }),
      );
    return found;
  };
  const resource = (p: Part, a: Record<string, string>, element: string): string => {
    const id = required(a, 'id', element);
    if (p.images.has(id) || p.functions.has(id) || p.volumes.has(id)) bad(`duplicate resource id ${id.slice(0, 32)}`);
    return id;
  };
  const sampled = (a: Record<string, string>, element: string): ThreeMFSampledField => {
    const field: ThreeMFSampledField = {
        functionId: required(a, 'functionid', element),
        channel: required(a, 'channel', element),
        minFeatureSize: number(a.minfeaturesize, 0, 'minfeaturesize'),
        fallback: number(a.fallbackvalue, 0, 'fallbackvalue'),
      },
      { transform } = a;
    if (transform !== undefined) {
      const values = transform.trim().split(/\s+/).map(Number);
      if (values.length !== 12 || !values.every(Number.isFinite)) bad(`invalid ${element} transform`);
      field.transform = values;
    }
    return field;
  };
  const open = (model: ThreeMFModel, name: string, a: Record<string, string>): void => {
    const p = part(model),
      { implicit, volume } = p;
    if (implicit) {
      if (name === 'in' || name === 'out') {
        p.list = name;
        return;
      }
      if (p.list) {
        const reference = name.endsWith('ref'),
          type = (reference ? name.slice(0, -3) : name) as string,
          port: ThreeMFPort = {
            name: required(a, 'identifier', name),
            type: (type === 'resource' ? 'resourceid' : type) as ThreeMFPortType,
          };
        if (!['scalar', 'vector', 'matrix', 'resourceid'].includes(port.type)) bad(`unknown port <${name}>`);
        if (reference) port.ref = required(a, 'ref', name);
        // A node's inputs and the function's outputs read values; the function's inputs and a node's outputs name them.
        if (reference !== (p.node ? p.list === 'in' : p.list === 'out')) bad(`<${name}> in the wrong list`);
        const owner = p.node ?? implicit;
        owner[p.list === 'in' ? 'inputs' : 'outputs'].push(port);
        return;
      }
      if (p.node) bad(`<${name}> inside a node`);
      const { identifier, displayname, tag: _tag, ...attributes } = a;
      p.node = {
        id: identifier ?? bad(`<${name}> without identifier`),
        op: name,
        ...(displayname === undefined ? {} : { name: displayname }),
        attributes,
        inputs: [],
        outputs: [],
      };
      implicit.nodes.push(p.node);
      return;
    }
    if (volume) {
      if (name === 'color') {
        if (volume.color) bad('<volumedata> has two colors');
        volume.color = sampled(a, name);
      } else if (name === 'composite') {
        if (volume.composite) bad('<volumedata> has two composites');
        volume.composite = { baseMaterialId: required(a, 'basematerialid', name), mappings: [] };
      } else if (name === 'materialmapping') {
        (volume.composite ?? bad('<materialmapping> outside <composite>')).mappings.push(sampled(a, name));
      } else if (name === 'property') {
        const full = required(a, 'name', name),
          colon = full.indexOf(':'),
          namespace = p.namespaces.get(full.slice(0, colon));
        if (colon < 1 || namespace === undefined)
          bad(`property ${full.slice(0, 64)} needs a declared namespace prefix`);
        if (volume.properties.some((q) => q.namespace === namespace && q.name === full.slice(colon + 1)))
          bad(`property ${full.slice(0, 64)} is given twice`);
        volume.properties.push({
          ...sampled(a, name),
          name: full.slice(colon + 1),
          namespace: namespace!,
          required: a.required === 'true' || a.required === '1',
        });
      }
      return;
    }
    if (p.image) {
      if (name === 'imagestack') {
        p.image.rows = number(a.rowcount, 0, 'rowcount');
        p.image.columns = number(a.columncount, 0, 'columncount');
        p.image.count = number(a.sheetcount, 0, 'sheetcount');
      } else if (name === 'imagesheet') {
        if (++sheets > MAX_SHEETS) throw new LoaderError(F, 'limit', `image sheets exceed ${MAX_SHEETS}`);
        p.image.sheets.push({ path: required(a, 'path', name), data: new Uint8Array(0) });
      }
      return;
    }
    if (name === 'image3d') {
      const id = resource(p, a, name);
      p.image = { id, ...(a.name === undefined ? {} : { name: a.name }), rows: 0, columns: 0, count: 0, sheets: [] };
      p.images.set(id, p.image);
    } else if (name === 'functionfromimage3d') {
      const id = resource(p, a, name),
        imageId = required(a, 'image3did', name);
      if (!p.images.has(imageId)) bad(`image3d ${imageId.slice(0, 32)} is not defined before function ${id}`);
      p.functions.set(id, {
        id,
        kind: 'image',
        ...(a.displayname === undefined ? {} : { name: a.displayname }),
        imageId,
        filter: a.filter === 'nearest' ? 'nearest' : 'linear',
        tile: [a.tilestyleu ?? 'wrap', a.tilestylev ?? 'wrap', a.tilestylew ?? 'wrap'],
        offset: number(a.valueoffset, 0, 'valueoffset'),
        scale: number(a.valuescale, 1, 'valuescale'),
      });
    } else if (name === 'implicitfunction') {
      const id = resource(p, a, name);
      p.implicit = {
        id,
        kind: 'implicit',
        ...(a.displayname === undefined ? {} : { name: a.displayname }),
        inputs: [],
        nodes: [],
        outputs: [],
      };
    } else if (name === 'volumedata') {
      const id = resource(p, a, name);
      p.volume = { id, properties: [] };
      p.volumes.set(id, p.volume);
    }
  };
  /** A finished graph reads only what came before, in matching types, and names no function that is not yet defined. */
  const checkGraph = (p: Part, f: ThreeMFImplicit): void => {
    const known = new Map<string, ThreeMFPortType>(f.inputs.map((i) => [`inputs.${i.name}`, i.type])),
      reads = (ports: readonly ThreeMFPort[]): void => {
        for (const { ref, type } of ports)
          if (ref !== undefined && known.get(ref) !== type)
            bad(`function ${f.id}: ${ref.slice(0, 64)} is not an earlier ${type} output`);
      },
      nodes = new Set<string>();
    for (const node of f.nodes) {
      if (node.id === 'inputs' || node.id === 'outputs' || nodes.has(node.id))
        bad(`function ${f.id}: node identifier ${node.id.slice(0, 64)} is reserved or used twice`);
      nodes.add(node.id);
      reads(node.inputs);
      if (node.op === 'constresourceid' && node.attributes.value === f.id) bad(`function ${f.id} references itself`);
      for (const { name, type } of node.outputs) known.set(`${node.id}.${name}`, type);
    }
    reads(f.outputs);
  };
  const close = (model: ThreeMFModel, name: string): void => {
    const p = part(model);
    if (p.implicit) {
      if (name === 'implicitfunction') {
        checkGraph(p, p.implicit);
        p.functions.set(p.implicit.id, p.implicit);
        p.implicit = undefined;
      } else if (name === 'in' || name === 'out') p.list = undefined;
      else if (name === p.node?.op && !p.list) p.node = undefined;
    } else if (name === 'volumedata') p.volume = undefined;
    else if (name === 'image3d' && p.image) {
      const { rows, columns, count, sheets: listed, id } = p.image;
      if (!(rows > 0 && columns > 0 && count > 0) || count !== listed.length)
        bad(`image3d ${id.slice(0, 32)} needs one imagestack with sheetcount sheets of a positive size`);
      p.image = undefined;
    }
  };
  const hooks: ThreeMFExtension = {
    levelSets: true,
    welded: true,
    field: { open, close },
    close(model, name) {
      beams.close(part(model), name);
    },
    element(model, name, a) {
      const p = part(model);
      if (name === 'model') {
        for (const key in a) if (key.startsWith('xmlns:')) p.namespaces.set(key.slice(6), a[key]);
      } else if (name === 'object') p.object = a.id;
      else if (name === 'basematerials' && a.id) p.bases.add(a.id);
      else if (name === 'beamlattice' && p.object !== undefined) {
        if (p.lattices.has(p.object)) bad(`object ${p.object.slice(0, 32)} has two beam lattices`);
        const object = model.objects.get(p.object)!;
        p.lattices.set(p.object, beams.begin(p, a, object.pid, object.pindex));
      } else if (['beam', 'ball', 'beamset', 'ref', 'ballref'].includes(name)) beams.element(p, name, a);
      else if (name === 'displacementmesh' && prefixed(a, 'volumeid') !== undefined)
        // Volumetric extension 5.2: only a mesh or a level set, unless a shape's own extension allows more.
        bad(`object ${p.object?.slice(0, 32)} is a displacement mesh, which takes no volume data`);
      else if (name === 'mesh' && p.object !== undefined) {
        const volumeId = prefixed(a, 'volumeid');
        if (volumeId !== undefined) {
          if (!p.volumes.has(volumeId)) bad(`volumedata ${volumeId.slice(0, 32)} is not defined before its mesh`);
          p.objects.set(p.object, { volumeId });
        }
      } else if (name === 'levelset' && p.object !== undefined) {
        const volumeId = a.volumeid;
        if (volumeId !== undefined && !p.volumes.has(volumeId))
          bad(`volumedata ${volumeId.slice(0, 32)} is not defined before its level set`);
        p.objects.set(p.object, {
          volumeId,
          levelSet: {
            ...sampled(a, name),
            meshId: required(a, 'meshid', name),
            boundingBoxOnly: a.meshbboxonly === 'true' || a.meshbboxonly === '1',
          },
        });
      }
    },
    instance(model, object, m, scale) {
      const found = listed.get(model)?.get(object.id);
      if (!found) return;
      found.instances.push(m.map((v) => v * scale));
      if (object.levelSet) levelSets++;
    },
    hasGeometry: () => levelSets > 0,
    async ready(bytes, { models, partPath }) {
      const files = new Map<string, Uint8Array>();
      for (const model of models.values()) {
        const p = parts.get(model),
          modelPath = partPath(model);
        if (!p) continue;
        const where = modelPath === undefined ? {} : { modelPath },
          own = new Map<string, ThreeMFVolumetricObject>(),
          surfaces = new Map<string, ThreeMFMesh>();
        let scope: Promise<FieldScope> | undefined;
        /** Built once, on the first level set, color or sample that needs it. */
        const evaluator = (): Promise<FieldScope> => (scope ??= fieldScope(model, p, surfaces));
        listed.set(model, own);
        for (const [objectId, lattice] of p.lattices) {
          const mesh = model.objects.get(objectId)!.mesh;
          if (!mesh) bad(`lattice object ${objectId.slice(0, 32)} requires a mesh`);
          finishLattice(lattice, mesh!.vertices.result(), () => {});
        }
        for (const { count: _count, ...image } of p.images.values()) {
          for (const sheet of image.sheets) {
            let data = files.get(sheet.path);
            if (!data) files.set(sheet.path, (data = await bytes(sheet.path)));
            sheet.data = data;
          }
          result.images.push({ ...image, ...where });
        }
        for (const f of p.functions.values()) result.functions.push({ ...f, ...where });
        const check = ({ functionId, channel }: ThreeMFSampledField, type?: ThreeMFPortType): void => {
          const f = p.functions.get(functionId);
          if (!f) bad(`function ${functionId.slice(0, 32)} is not defined`);
          const output =
            f!.kind === 'implicit'
              ? f!.outputs.find((o) => o.name === channel)?.type
              : channel === 'color'
                ? 'vector'
                : ['red', 'green', 'blue', 'alpha'].includes(channel)
                  ? 'scalar'
                  : undefined;
          if (!output || (type && output !== type))
            bad(`function ${functionId.slice(0, 32)} has no ${type ?? ''} output ${channel.slice(0, 64)}`);
        };
        for (const volume of p.volumes.values()) {
          if (volume.color) check(volume.color, 'vector');
          if (volume.composite) {
            if (!p.bases.has(volume.composite.baseMaterialId) || !volume.composite.mappings.length)
              bad(`volumedata ${volume.id} composite needs a basematerials group and a materialmapping`);
            for (const mapping of volume.composite.mappings) check(mapping, 'scalar');
            const bases = model.properties.get(volume.composite.baseMaterialId)?.length;
            if (volume.composite.mappings.length !== bases)
              bad(`volumedata ${volume.id} composite needs one materialmapping for each of ${bases} base materials`);
          }
          for (const property of volume.properties) check(property);
          result.volumes.push({ ...volume, ...where });
        }
        for (const [objectId, { volumeId, levelSet }] of p.objects) {
          let shape: ThreeMFVolumetricObject['levelSet'];
          if (levelSet) {
            check(levelSet, 'scalar');
            const mesh = model.objects.get(levelSet.meshId)?.mesh;
            if (!mesh) bad(`level set ${objectId.slice(0, 32)} needs a mesh object ${levelSet.meshId.slice(0, 32)}`);
            shape = {
              ...levelSet,
              domain: {
                positions: mesh!.vertices.result(),
                indices: mesh!.triangles.result(),
              },
            };
          }
          const object: ThreeMFVolumetricObject = {
            objectId,
            ...where,
            ...(volumeId === undefined ? {} : { volumeId }),
            ...(shape ? { levelSet: shape } : {}),
            instances: [],
          };
          if (volumeId !== undefined) {
            const volume = p.volumes.get(volumeId)!;
            object.sample = async (positions) => {
              const { sampleVolume } = await import('./threemf-volume-sample.js');
              return sampleVolume(await evaluator(), volume, positions);
            };
          }
          own.set(objectId, object);
          result.objects.push(object);
        }
        // Distances and level set domains read each mesh as the file wrote it, before lattices and colour samples.
        for (const [objectId, object] of model.objects) if (object.mesh) surfaces.set(objectId, object.mesh);
        if (options.meshLevelSets !== false)
          for (const object of own.values()) {
            const { levelSet, objectId } = object;
            if (!levelSet) continue;
            const { mesh, cell, coarse } = await meshLevelSet(await evaluator(), levelSet, levelSet.domain.positions, {
              resolution: levelSetResolution,
              maxTriangles: limits(options, F).maxTriangles,
              signal: options.signal,
            });
            levelSet.cellSize = cell;
            levelSet.unresolved = coarse;
            model.objects.get(objectId)!.mesh = mesh;
            surfaces.set(objectId, mesh);
          }
        await addLattices?.(model, p.lattices, surfaces, modelPath);
        if (options.sampleColors === false) continue;
        for (const object of own.values()) {
          const color = object.volumeId === undefined ? undefined : p.volumes.get(object.volumeId)!.color,
            mesh = model.objects.get(object.objectId)!.mesh;
          if (color && mesh) mesh.fill = { scope: await evaluator(), field: color };
        }
      }
    },
    bucket: () => '',
    corner() {},
    group() {},
  };
  /**
   * Samples volume colour onto every mesh the build reaches. It runs after every step that changes a surface, and
   * before the core reader writes the triangles.
   */
  const paint = (models: ReadonlyMap<string, ThreeMFModel>): void => {
    const root = models.values().next().value!,
      seen = new Set<object>();
    const visit = (model: ThreeMFModel, id: string, path: string | undefined, depth: number): void => {
      const owner = path ? models.get(path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()) : model,
        object = owner?.objects.get(id);
      // The core reader reports a missing object or a loop.
      if (!owner || !object || seen.has(object) || depth > 64) return;
      seen.add(object);
      for (const next of [...object.components, ...object.alternatives])
        visit(owner, next.objectId, next.path, depth + 1);
      const mesh = object.mesh;
      if (!mesh?.triangles.length || !(mesh.fill || mesh.fills?.some(Boolean))) return;
      throwIfAborted(options.signal, F);
      const sampled = colourMesh(owner, object, mesh, {
          resolution: colorResolution,
          maxTriangles: limits(options, F).maxTriangles,
        }),
        found = listed.get(owner)?.get(id);
      if (found) {
        found.colorSpacing = sampled.spacing;
        found.colorUnresolved = sampled.coarse;
      }
      object.mesh = sampled.mesh;
    };
    for (const item of root.items) visit(root, item.objectId, item.path, 0);
  };
  return {
    hooks,
    paint,
    /** What the reader adds to the core result, once the build has been walked. */
    result(): Pick<ThreeMFVolumetricResult, 'images' | 'functions' | 'volumes' | 'objects'> {
      // The build walk has filled the instances; an object nothing builds, such as a level set's domain, is left out.
      return { ...result, objects: result.objects.filter((o) => o.instances.length) };
    },
  };
}
