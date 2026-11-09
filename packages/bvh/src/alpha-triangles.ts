import type { Engine, Geometry, Mesh } from '@margoengine/core';
import type { ModelLike, ModelPrimitiveLike } from './raycaster.js';
import { worldTriangles, type WorldTriangles, type WorldTrianglesOptions } from './triangles.js';

/** Original input-face range, before a BVH rearranges its leaves. */
export interface AlphaTriangleRange {
  readonly firstFace: number;
  readonly faceCount: number;
  /** Undefined for a core mesh, whose triangles carry no glTF material. */
  readonly model?: ModelLike;
  readonly primitive?: ModelPrimitiveLike;
  /** Undefined for non-instanced geometry. */
  readonly instanceIndex?: number;
}
/** World triangles and matching alpha provenance. Rebuild after topology, UV or material edits. */
export interface AlphaWorldTriangles extends WorldTriangles {
  /** Six TEXCOORD_0 numbers per original input face, in vertex a,b,c order; zero for core geometry. */
  readonly uv: Float32Array;
  readonly ranges: readonly AlphaTriangleRange[];
}
/**
 * Collect exactly worldTriangles' live, filtered, transformed geometry plus original primitive/instance ranges and
 * per-face UVs for candidate alpha tests. Model skin/morph geometry stays in bind pose, like worldTriangles.
 */
export function alphaWorldTriangles(
  engine: Engine,
  objects: Iterable<Mesh | ModelLike>,
  options: WorldTrianglesOptions = {},
): AlphaWorldTriangles {
  const parts: { primitive?: ModelPrimitiveLike; indices: ArrayLike<number>; firstFace: number; copies: number }[] = [],
    ranges: AlphaTriangleRange[] = [];
  let faces = 0;
  const triangles = worldTriangles(engine, objects, {
    ...options,
    filter(mesh, model, primitive) {
      if (options.filter && !options.filter(mesh, model, primitive)) return false;
      const indices = primitive?.indices ?? (mesh as unknown as { geometry: Geometry }).geometry.indices,
        copies = primitive?.instances?.count ?? 1,
        faceCount = indices.length / 3;
      parts.push({ primitive, indices, firstFace: faces, copies });
      for (let i = 0; i < copies; i++) {
        ranges.push({
          firstFace: faces,
          faceCount,
          model,
          primitive,
          instanceIndex: primitive?.instances ? i : undefined,
        });
        faces += faceCount;
      }
      return true;
    },
  });
  const uv = new Float32Array(faces * 6);
  for (const { primitive, indices, firstFace, copies } of parts) {
    if (!primitive) continue;
    const vertices = primitive.vertices;
    for (let i = 0; i < copies; i++)
      for (let k = 0; k < indices.length; k++) {
        const at = indices[k] * 20 + 12,
          to = firstFace * 6 + i * indices.length * 2 + k * 2;
        uv[to] = vertices[at];
        uv[to + 1] = vertices[at + 1];
      }
  }
  return { ...triangles, uv, ranges };
}
