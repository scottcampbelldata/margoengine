import type { Engine, Mesh } from '@margoengine/core/extension';
import { meshTriangles } from '../../shared/mesh-source.js';

/** What the engine holds, counted from its meshes: the numbers an inspector shows in its Resources section. */
export interface EngineResources {
  /** `'webgpu'` or `'webgl2'`. */
  backend: string;
  /** Meshes in the scene. */
  meshes: number;
  /** Meshes currently visible. */
  visibleMeshes: number;
  /** Distinct geometry or model sources: meshes sharing one count once. */
  geometries: number;
  /** Distinct materials. */
  materials: number;
  /** Vertices of the distinct geometries. */
  vertices: number;
  /** Triangles of the visible meshes: each mesh counts its geometry, so instances count each time. */
  triangles: number;
  /** Names of the attached plugins (post effects, sky, controls...), in attach order. */
  plugins: string[];
  /** Drawing-buffer size in pixels. */
  canvas: { width: number; height: number };
}

/**
 * Counts what `engine` draws from `meshes` (default: every mesh of the engine's default scene).
 * @throws TypeError when `engine` is not an engine.
 */
export function describeEngine(engine: Engine, meshes?: Iterable<Mesh>): EngineResources {
  if (!engine || typeof engine !== 'object' || !engine.meshes || !engine.scene)
    throw new TypeError('Not an engine; pass the Engine from Engine.create or the inspector engine');
  const list = meshes ?? engine.scene.meshes.values(),
    sources = new Set<object>(),
    materials = new Set<object>();
  let count = 0,
    visible = 0,
    vertices = 0,
    triangles = 0;
  for (const mesh of list) {
    count++;
    if (mesh.material) materials.add(mesh.material);
    const t = meshTriangles(mesh);
    if (!t) continue;
    const parts =
      t.kind === 'core'
        ? [{ vertices: t.geometry.vertices.length / 6, indices: t.geometry.indices.length }]
        : t.source.primitives.map((p: { vertices: Float32Array; indices: Uint32Array }) => ({
            vertices: p.vertices.length / 20,
            indices: p.indices.length,
          }));
    const key = t.kind === 'core' ? t.geometry : t.source;
    if (!sources.has(key)) {
      sources.add(key);
      for (const p of parts) vertices += p.vertices;
    }
    if (mesh.visible) {
      visible++;
      for (const p of parts) triangles += p.indices / 3;
    }
  }
  return {
    backend: engine.backend,
    meshes: count,
    visibleMeshes: visible,
    geometries: sources.size,
    materials: materials.size,
    vertices,
    triangles,
    plugins: [...engine.plugins.keys()],
    canvas: { width: engine.canvas.width, height: engine.canvas.height },
  };
}
