// The engine's own meshes as a path-traced scene: every visible core `Mesh` of a scene becomes a placement of shared
// triangle geometry with a metallic-roughness material, so a raster scene can be traced without rebuilding it by hand.
// Geometry is read from `Geometry.vertices` (position and normal interleaved) and `indices`; placements from each mesh's
// world matrix; materials from `PbrMaterial.data` (linear colour, roughness, metalness, double-sided).
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
 * trace mesh per (geometry, material) pair, one placement per visible mesh at its world matrix. Matrices are those of
 * the last update, so call it after `engine.render()` (or a frame) once transforms change.
 *
 * ```ts
 * engine.render();
 * const scene = traceSceneFromEngine(engine, { base: { revision: 1, models: [], instances: [], materials: [], environment } });
 * const tracer = await ComposedVoxelPathTracer.create(engine, { scene, features: [meshPBR()] });
 * ```
 * @throws TypeError for an engine, scene, base or filter of the wrong kind.
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
  const scene = base ?? { revision: 1, models: [], instances: [], materials: [] };
  return { ...scene, meshes, meshInstances, pbrMaterials };
}
