// The engine's own meshes as a path-traced scene: every visible core `Mesh` of a scene becomes a placement of shared
// triangle geometry with a metallic-roughness material, so a raster scene can be traced without rebuilding it by hand.
// Geometry is read from `Geometry.vertices` (position and normal interleaved) and `indices`; placements from each mesh's
// world matrix; materials from `PbrMaterial.data` (linear colour, roughness, metalness, double-sided). Terrains come in
// through their CPU height query (`@margoengine/terrain/query` `TerrainQuery.triangles`), read structurally so this
// entry does not import the terrain package.
import type { Engine, Geometry, Mesh, PbrMaterial, Scene } from '@margoengine/core';
import type { PBRMeshTraceScene, TracePBRMaterial, TracePBRMesh } from './mesh-pbr-types.js';
import type { TraceMeshInstance } from './mesh.js';
import type { VoxelTraceScene } from './types.js';

/** Options of {@link traceSceneFromEngine}. */
export interface TraceEngineOptions {
  /** The engine scene to read. Default `engine.scene`. */
  scene?: Scene;
  /**
   * A scene to add the meshes to: its voxel models, instances, palette, environment, lights and any meshes and mesh
   * materials it already has are kept. Default an empty scene (revision 1).
   */
  base?: VoxelTraceScene & Partial<Pick<PBRMeshTraceScene, 'meshes' | 'meshInstances' | 'pbrMaterials'>>;
  /** Keeps a mesh when it returns true. Default: every mesh. */
  filter?: (mesh: Mesh) => boolean;
  /**
   * Terrains to trace, each as one world-space mesh from its height query. Default none. A `TerrainQuery` from
   * `@margoengine/terrain/query` (made from the same heights and `terrain.options` as the drawn `Terrain`, or by
   * `TerrainQuery.read`) fits `query`.
   */
  terrain?: readonly TraceTerrainSource[];
  /**
   * Scattered instances to trace: each ring of a `readScatter` result (`@margoengine/scatter/read`) becomes one mesh
   * with one placement per instance, or, for a ring read with `pose: true`, one world-space mesh of its posed vertices
   * (bent by the wind as drawn) whose `previousPositions` are the pose a frame before, so a shutter above 0 blurs the
   * sway. Default none.
   */
  scatter?: readonly TraceScatterSource[];
}
/** What {@link traceSceneFromEngine} needs of a scatter: a `ScatterReadout` from `readScatter` fits as it is. */
export interface TraceScatterSource {
  readonly rings: readonly {
    readonly geometry: Geometry;
    readonly transforms: Float32Array;
    /** World vertices posed vertex by vertex (`readScatter` `pose: true`); traced in place of the placements. */
    readonly posed?: {
      readonly positions: Float32Array;
      readonly normals: Float32Array;
      readonly previousPositions: Float32Array;
      readonly indices: Uint32Array;
    };
  }[];
  readonly color: readonly [number, number, number];
  readonly roughness: number;
  readonly metalness: number;
}
/** What {@link traceSceneFromEngine} needs of a terrain: `TerrainQuery.triangles` and the settings it takes. */
export interface TraceTerrainSource {
  readonly query: {
    triangles(options?: { step?: number; region?: TraceTerrainSource['region'] }): {
      readonly positions: Float32Array;
      readonly normals: Float32Array;
      readonly indices: Uint32Array;
    };
  };
  /** Samples between vertices, passed to `triangles`. Default 1, the heightmap's own samples. */
  readonly step?: number;
  /** World XZ rectangle to trace, passed to `triangles`. Default the whole heightmap. */
  readonly region?: { readonly min: readonly [number, number]; readonly max: readonly [number, number] };
  /**
   * The terrain's surface: a trace material without its id. Default a grey rough dielectric
   * (`baseColorFactor` [0.5, 0.5, 0.5, 1], roughness 1, metalness 0).
   */
  readonly material?: Omit<TracePBRMaterial, 'id'>;
}

interface Split {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}
// One copy of each geometry's arrays per Geometry object: Geometry is immutable after construction, so later calls
// hand the tracer the same arrays and its content key matches without a new build.
const splits = new WeakMap<Geometry, Split>();
const split = (geometry: Geometry): Split => {
  let s = splits.get(geometry);
  if (!s) {
    const v = geometry.vertices,
      n = v.length / 6,
      positions = new Float32Array(n * 3),
      normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++)
      for (let a = 0; a < 3; a++) {
        positions[i * 3 + a] = v[i * 6 + a];
        normals[i * 3 + a] = v[i * 6 + 3 + a];
      }
    s = { positions, normals, indices: geometry.indices.slice() };
    splits.set(geometry, s);
  }
  return s;
};

/**
 * Builds a {@link PBRMeshTraceScene} for `ComposedVoxelPathTracer` with the `meshPBR()` feature from the engine's meshes: one
 * trace mesh per (geometry, material) pair, one placement per visible mesh at its world matrix, plus one world-space
 * mesh and material per `terrain` source (ids `terrain-<n>`, holes left out). Matrices are those of the last update,
 * so call it after `engine.render()` (or a frame) once transforms change. Terrain triangles are built on every call
 * (a terrain's heights may change in place), so build the scene once and reuse it while the heights hold.
 *
 * ```ts
 * engine.render();
 * const scene = traceSceneFromEngine(engine, { base: { revision: 1, models: [], instances: [], materials: [], environment } });
 * const tracer = await ComposedVoxelPathTracer.create(engine, { scene, features: [meshPBR()] });
 * ```
 * @throws TypeError for an engine, scene, base, filter or terrain source of the wrong kind; RangeError from the
 * terrain query for a bad step or region.
 */
export function traceSceneFromEngine(engine: Engine, options: TraceEngineOptions = {}): PBRMeshTraceScene {
  if (!engine || typeof engine !== 'object' || !engine.scene)
    throw new TypeError('traceSceneFromEngine expects an engine');
  if (!options || typeof options !== 'object') throw new TypeError('traceSceneFromEngine options must be an object');
  const source = options.scene ?? engine.scene,
    { filter, base } = options;
  if (!source || !(source.meshes instanceof Map))
    throw new TypeError('traceSceneFromEngine scene must be an engine Scene');
  if (filter !== undefined && typeof filter !== 'function')
    throw new TypeError('traceSceneFromEngine filter must be a function');
  if (base !== undefined && (!base || typeof base !== 'object' || !Array.isArray(base.models)))
    throw new TypeError('traceSceneFromEngine base must be a trace scene');
  const terrain = options.terrain ?? [];
  if (!Array.isArray(terrain) || terrain.some((t) => typeof t?.query?.triangles !== 'function'))
    throw new TypeError('traceSceneFromEngine terrain must be a list of { query } with a TerrainQuery');
  const scattered: readonly TraceScatterSource[] = options.scatter ?? [];
  if (!Array.isArray(options.scatter ?? []) || scattered.some((t) => !Array.isArray(t?.rings)))
    throw new TypeError('traceSceneFromEngine scatter must be a list of readScatter results');
  const pbrMaterials: TracePBRMaterial[] = [...(base?.pbrMaterials ?? [])],
    meshes: TracePBRMesh[] = [...((base?.meshes ?? []) as TracePBRMesh[])],
    // A base without placements draws each of its meshes once in world space; keep that with identity placements.
    meshInstances: TraceMeshInstance[] = base?.meshInstances
      ? [...base.meshInstances]
      : meshes.map((m) => ({ id: `base-${m.id}`, mesh: m.id }));
  let nextMaterial = pbrMaterials.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  const materialIds = new Map<PbrMaterial, number>(),
    meshIds = new Map<Geometry, Map<number, string>>();
  for (const mesh of source.meshes.values()) {
    const geometry = mesh.geometry;
    if (!geometry || geometry.indices.length === 0 || !mesh.visible) continue;
    if (filter && !filter(mesh)) continue;
    const material = mesh.material;
    let materialId = materialIds.get(material);
    if (materialId === undefined) {
      const d = material.data;
      materialId = nextMaterial++;
      materialIds.set(material, materialId);
      pbrMaterials.push({
        id: materialId,
        baseColorFactor: [d[0], d[1], d[2], 1],
        roughnessFactor: d[4],
        metallicFactor: d[5],
        doubleSided: d[6] !== 0,
      });
    }
    let byMaterial = meshIds.get(geometry);
    if (!byMaterial) meshIds.set(geometry, (byMaterial = new Map()));
    let meshId = byMaterial.get(materialId);
    if (meshId === undefined) {
      meshId = `engine-${meshes.length}`;
      byMaterial.set(materialId, meshId);
      const s = split(geometry);
      meshes.push({ id: meshId, positions: s.positions, normals: s.normals, indices: s.indices, material: materialId });
    }
    meshInstances.push({ id: `engine-mesh-${mesh.id}`, mesh: meshId, transform: Array.from(mesh.matrix) });
  }
  terrain.forEach((source, n) => {
    const { positions, normals, indices } = source.query.triangles({ step: source.step, region: source.region });
    if (indices.length === 0) return;
    const id = nextMaterial++,
      meshId = `terrain-${n}`;
    pbrMaterials.push({
      baseColorFactor: [0.5, 0.5, 0.5, 1],
      roughnessFactor: 1,
      metallicFactor: 0,
      ...source.material,
      id,
    });
    meshes.push({ id: meshId, positions, normals, indices, material: id });
    meshInstances.push({ id: `engine-${meshId}`, mesh: meshId });
  });
  scattered.forEach((source, n) => {
    const id = nextMaterial++;
    pbrMaterials.push({
      id,
      baseColorFactor: [source.color[0], source.color[1], source.color[2], 1],
      roughnessFactor: source.roughness,
      metallicFactor: source.metalness,
      doubleSided: true,
    });
    source.rings.forEach(({ geometry, transforms, posed }, ring) => {
      const count = transforms.length / 16;
      if (!count || geometry.indices.length === 0) return;
      const meshId = `scatter-${n}-${ring}`;
      if (posed) {
        const { positions, normals, previousPositions, indices } = posed;
        meshes.push({ id: meshId, positions, normals, indices, previousPositions, material: id });
        meshInstances.push({ id: `engine-${meshId}`, mesh: meshId });
        return;
      }
      const s = split(geometry);
      meshes.push({ id: meshId, positions: s.positions, normals: s.normals, indices: s.indices, material: id });
      for (let k = 0; k < count; k++)
        meshInstances.push({
          id: `engine-${meshId}-${k}`,
          mesh: meshId,
          transform: Array.from(transforms.subarray(k * 16, k * 16 + 16)),
        });
    });
  });
  const scene = base ?? { revision: 1, models: [], instances: [], materials: [] };
  return { ...scene, meshes, meshInstances, pbrMaterials };
}
