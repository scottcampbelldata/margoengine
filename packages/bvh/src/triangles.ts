import type { Engine, Geometry, Mesh } from '@margoengine/core';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { isModel, type ModelLike } from './raycaster.js';

// Structural view of `engineRuntime(engine)`; types only, like the Raycaster.
interface RuntimeEngine {
  store: { matrices: Float32Array; tick(culling?: boolean): void };
  meshes: Map<number, { id: number }>;
  disposed: boolean;
}

export interface WorldTrianglesOptions {
  /** Run the transform kernel first so world matrices include transform edits made since the last render. Default true. */
  refresh?: boolean;
  /** Return false to leave out a core mesh, or a model primitive (its node and model are passed). Hidden meshes are not skipped by default. */
  filter?: (mesh: Mesh, model?: ModelLike) => boolean;
}
/** Merged world-space triangles: packed xyz `vertices` and `indices` into them, three per triangle. */
export interface WorldTriangles {
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * World-space triangles of core meshes and gltf-pro models (`PBRModel`, @margoengine/materials meshes), merged into one
 * vertex and index array, for a physics trimesh (`{shape: 'trimesh', ...worldTriangles(engine, [level])}`) or a navmesh
 * (`Navigation.create(t.vertices, t.indices)`). Every node, instance and scale transform is applied; skinned and morphed
 * primitives are read in their bind pose. Core meshes without geometry and disposed meshes or models are skipped.
 */
export function worldTriangles(
  engine: Engine,
  objects: Iterable<Mesh | ModelLike>,
  { refresh = true, filter }: WorldTrianglesOptions = {},
): WorldTriangles {
  const runtime = engine as unknown as RuntimeEngine;
  if (runtime.disposed) throw new Error('Engine is disposed');
  if (refresh) runtime.store.tick(false);
  const live = (mesh: Mesh): boolean =>
    runtime.meshes.get((mesh as unknown as { id: number }).id) === (mesh as unknown);
  // Each part: positions (stride 6 for core geometry, 20 for model vertices), indices, and one world matrix per copy.
  const parts: { positions: Float32Array; stride: number; indices: ArrayLike<number>; matrices: Float32Array[] }[] = [];
  let vertexCount = 0,
    indexCount = 0;
  const add = (positions: Float32Array, stride: number, indices: ArrayLike<number>, matrices: Float32Array[]): void => {
    parts.push({ positions, stride, indices, matrices });
    vertexCount += (positions.length / stride) * matrices.length;
    indexCount += indices.length * matrices.length;
  };
  const world = (mesh: Mesh): Float32Array => {
    const id = (mesh as unknown as { id: number }).id;
    return runtime.store.matrices.subarray(id * 16, id * 16 + 16);
  };
  for (const object of new Set(objects)) {
    if (isModel(object)) {
      if (object.disposed) continue;
      for (const primitive of object.primitives) {
        if (!live(primitive.node) || (filter && !filter(primitive.node, object))) continue;
        const node = world(primitive.node),
          instances = primitive.instances,
          matrices: Float32Array[] = [];
        if (!instances) matrices.push(node);
        else
          for (let k = 0; k < instances.count; k++)
            matrices.push(multiplyMatrices(node, instances.data.subarray(k * 24, k * 24 + 16), new Float32Array(16)));
        add(primitive.vertices, 20, primitive.indices, matrices);
      }
    } else {
      const geometry = (object as unknown as { geometry: Geometry | null }).geometry;
      if (!geometry || !live(object) || (filter && !filter(object))) continue;
      add(geometry.vertices, 6, geometry.indices, [world(object)]);
    }
  }
  if (vertexCount > 0xffffffff) throw new RangeError('Too many vertices for 32-bit indices');
  const vertices = new Float32Array(vertexCount * 3),
    indices = new Uint32Array(indexCount);
  let v = 0,
    i = 0;
  for (const { positions: p, stride, indices: index, matrices } of parts)
    for (const m of matrices) {
      const base = v / 3;
      for (let o = 0; o < p.length; o += stride) {
        const x = p[o],
          y = p[o + 1],
          z = p[o + 2];
        vertices[v++] = m[0] * x + m[4] * y + m[8] * z + m[12];
        vertices[v++] = m[1] * x + m[5] * y + m[9] * z + m[13];
        vertices[v++] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      for (let k = 0; k < index.length; k++) indices[i++] = base + index[k];
    }
  return { vertices, indices };
}
