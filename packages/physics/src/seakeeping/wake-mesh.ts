import { MargoError } from '@margoengine/math/errors';
import type { HullMesh } from './wetted.js';

/** Validate input geometry before a reference wake bake clips it. */
export function requireWakeHullMesh(mesh: HullMesh): HullMesh {
  const { vertices, indices } = mesh ?? {};
  if (
    !vertices ||
    !indices ||
    !Number.isSafeInteger(vertices.length) ||
    !Number.isSafeInteger(indices.length) ||
    vertices.length < 9 ||
    indices.length < 3 ||
    vertices.length % 3 !== 0 ||
    indices.length % 3 !== 0
  )
    throw new MargoError('state', 'Pass vertex triples and indexed triangles for the closed hull wake geometry.');
  for (let i = 0; i < vertices.length; i++) {
    if (!Number.isFinite(vertices[i]))
      throw new MargoError('state', 'Use finite hull coordinates before baking the hull wake.');
  }
  for (let i = 0; i < indices.length; i++) {
    const vertex = indices[i]!;
    if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= vertices.length / 3)
      throw new MargoError('state', 'Use triangle indices that select vertices in the supplied hull mesh.');
  }
  return { vertices, indices };
}
