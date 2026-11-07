// Reading meshes for physics, for both entries: where a mesh sits in its hierarchy, and the geometry to fit a collider to.
import { MargoError } from '@margoengine/math/errors';
import type { Mesh } from '@margoengine/core';
import { meshRuntime, Mesh as CoreMesh } from '@margoengine/core/extension';
import { meshTriangles, mergePrimitives } from '../../shared/mesh-source.js';
import { eulerToQuat, type Vec3 } from './math.js';
import { geometryPositions, type ColliderGeometry } from './shapes.js';
import { matrixRotation, worldMatrix } from './transform.js';

/** How many parents are above `mesh`. */
export function depthOf(mesh: Mesh): number {
  const runtime = meshRuntime(mesh) as unknown as { id?: number; engine?: { store?: { parents?: ArrayLike<number> } } },
    parents = runtime.engine?.store?.parents;
  if (!parents || runtime.id === undefined) return 0;
  let depth = 0;
  for (let node = parents[runtime.id]; node !== -1 && depth < 65; node = parents[node]) depth++;
  return depth;
}

export function parentOf(mesh: Mesh): number {
  const runtime = meshRuntime(mesh) as unknown as { id?: number; engine?: { store?: { parents?: ArrayLike<number> } } };
  const parents = runtime.engine?.store?.parents;
  return parents && runtime.id !== undefined ? parents[runtime.id] : -1;
}

/** Static bind-pose triangle data from optional PBR loaders; never attach a second core draw geometry. */
function primitiveGeometry(mesh: Mesh): ColliderGeometry | null {
  const triangles = meshTriangles(meshRuntime(mesh));
  if (!triangles) return null;
  if (triangles.kind === 'core') return triangles.geometry;
  if (triangles.source.skinned || triangles.source.morphed)
    throw new MargoError('state', 'Skinned mesh needs an explicit collider; pass colliders in the body options.');
  const { primitives } = triangles.source;
  if (!primitives.length) return null;
  return mergePrimitives(primitives);
}

/** Fit a geometry-free root to its static descendants without altering the hierarchy. */
export function colliderGeometry(mesh: Mesh, worldScale?: Vec3): { geometry: ColliderGeometry; scale: Vec3 } {
  const direct = primitiveGeometry(mesh);
  if (direct) return { geometry: direct, scale: worldScale ?? [mesh.scale.x, mesh.scale.y, mesh.scale.z] };
  const root = meshRuntime(mesh),
    engine = root.engine;
  if (!engine.meshes || !engine.store.tick)
    throw new MargoError('state', 'Mesh has no geometry; set geometry before adding a body.');
  engine.store.tick(false);
  const sources: { node: CoreMesh; positions: Float32Array; indices: ArrayLike<number> }[] = [];
  let vertexCount = 0,
    indexCount = 0;
  for (const node of engine.meshes.values()) {
    let ancestor = engine.store.parents[node.id],
      depth = 0;
    while (ancestor !== -1 && ancestor !== root.id && depth++ < 64) ancestor = engine.store.parents[ancestor];
    if (ancestor !== root.id) continue;
    const geometry = primitiveGeometry(node);
    if (!geometry) continue;
    const positions = geometryPositions(geometry);
    if (!positions.length || !geometry.indices?.length) continue;
    sources.push({ node, positions, indices: geometry.indices });
    vertexCount += positions.length / 3;
    indexCount += geometry.indices.length;
  }
  if (!vertexCount) throw new MargoError('state', 'Mesh has no geometry; set geometry before adding a body.');

  const vertices = new Float32Array(vertexCount * 3),
    indices = new Uint32Array(indexCount);
  // The body sits at the root's world pose: for a root below another mesh, that is not its local one.
  let [qx, qy, qz, qw] = eulerToQuat(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z),
    px = mesh.position.x,
    py = mesh.position.y,
    pz = mesh.position.z;
  if (engine.store.parents[root.id] !== -1) {
    const m = worldMatrix(engine.store, root.id, new Float64Array(16)),
      q = [0, 0, 0, 1];
    matrixRotation(m, q);
    [qx, qy, qz, qw] = q;
    px = m[12];
    py = m[13];
    pz = m[14];
  }
  let vertexOffset = 0,
    indexOffset = 0;
  for (const { node, positions, indices: sourceIndices } of sources) {
    const m = node.matrix;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i],
        y = positions[i + 1],
        z = positions[i + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12] - px;
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13] - py;
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14] - pz;
      // Invert the body's rigid pose, not its scaled world matrix: Rapier has no body scale.
      // The descendant world matrix already includes every scale, including the root's, once.
      const tx = -2 * (qy * wz - qz * wy),
        ty = -2 * (qz * wx - qx * wz),
        tz = -2 * (qx * wy - qy * wx);
      const offset = vertexOffset * 3 + i;
      vertices[offset] = wx + qw * tx - qy * tz + qz * ty;
      vertices[offset + 1] = wy + qw * ty - qz * tx + qx * tz;
      vertices[offset + 2] = wz + qw * tz - qx * ty + qy * tx;
      if (
        !Number.isFinite(vertices[offset]) ||
        !Number.isFinite(vertices[offset + 1]) ||
        !Number.isFinite(vertices[offset + 2])
      )
        throw new RangeError('Geometry positions must be finite');
    }
    for (let i = 0; i < sourceIndices.length; i++) indices[indexOffset++] = vertexOffset + sourceIndices[i];
    vertexOffset += positions.length / 3;
  }
  return { geometry: { vertices, indices, stride: 3 }, scale: [1, 1, 1] };
}
