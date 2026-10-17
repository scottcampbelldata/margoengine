import type { Mesh } from '@margoengine/core/extension';
import { invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import type { PBRMaterial, PBRPrimitive } from './index.js';

/** One static part baked into a material batch, with the root-relative matrix and source arrays captured at bake time. */
export interface BatchPart {
  primitive: PBRPrimitive;
  stamp: Float32Array;
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * Several unskinned, unmorphed, non-instanced primitives that share one material, drawn as one mesh parented to the
 * model root. Vertices are copied into root space. Callers draw the originals again when a part moves, hides, or
 * changes material.
 */
export interface StaticBatch {
  node: Mesh;
  material: PBRMaterial;
  primitive: PBRPrimitive;
  parts: BatchPart[];
}

const stride = 20;

function determinant(m: ArrayLike<number>): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
}

function eligible(p: PBRPrimitive): boolean {
  const m = p.material;
  if (p.topology || p.instances || p.deformed) return false;
  if (p.definition.targets?.length || p.definition.attributes?.JOINTS_0 !== undefined) return false;
  if (m.settings[0] === 2 || (m.tint && !m.extension?.replacesPhysical)) return false;
  if (p.indices.length < 3 || p.indices.length % 3 || p.vertices.length < stride * 3) return false;
  return p.vertices.length % stride === 0;
}

function bakeVertex(
  src: Float32Array,
  dst: Float32Array,
  o: number,
  relative: Float32Array,
  inverse: Float32Array,
  mirror: boolean,
): void {
  const x = src[0],
    y = src[1],
    z = src[2];
  dst[o] = relative[0] * x + relative[4] * y + relative[8] * z + relative[12];
  dst[o + 1] = relative[1] * x + relative[5] * y + relative[9] * z + relative[13];
  dst[o + 2] = relative[2] * x + relative[6] * y + relative[10] * z + relative[14];
  dst[o + 3] = src[3];
  const nx = src[4],
    ny = src[5],
    nz = src[6];
  // Inverse-transpose of the root-relative matrix. The shader applies the batch node's inverse-transpose on top.
  dst[o + 4] = inverse[0] * nx + inverse[1] * ny + inverse[2] * nz;
  dst[o + 5] = inverse[4] * nx + inverse[5] * ny + inverse[6] * nz;
  dst[o + 6] = inverse[8] * nx + inverse[9] * ny + inverse[10] * nz;
  dst[o + 7] = src[7];
  const tx = src[8],
    ty = src[9],
    tz = src[10];
  dst[o + 8] = relative[0] * tx + relative[4] * ty + relative[8] * tz;
  dst[o + 9] = relative[1] * tx + relative[5] * ty + relative[9] * tz;
  dst[o + 10] = relative[2] * tx + relative[6] * ty + relative[10] * tz;
  dst[o + 11] = src[11] * (mirror ? -1 : 1);
  dst.set(src.subarray(12, 20), o + 12);
}

/** Groups of two or more static primitives that can share one draw. World matrices must already be published. */
export function buildStaticBatches(
  primitives: readonly PBRPrimitive[],
  root: Mesh,
  createNode: () => Mesh,
): StaticBatch[] {
  const groups = new Map<PBRMaterial, PBRPrimitive[]>();
  for (const primitive of primitives) {
    if (!eligible(primitive)) continue;
    const list = groups.get(primitive.material);
    if (list) list.push(primitive);
    else groups.set(primitive.material, [primitive]);
  }
  const inverse = new Float32Array(16),
    relative = new Float32Array(16),
    partInverse = new Float32Array(16),
    workspace = new Float64Array(52),
    batches: StaticBatch[] = [];
  if (!invertMatrixStable(root.matrix, inverse, workspace)) return batches;
  for (const [material, parts] of groups) {
    if (parts.length < 2) continue;
    let vertices = 0,
      indices = 0,
      singular = false;
    const stamps: Float32Array[] = [];
    const mirrors: boolean[] = [];
    for (const part of parts) {
      multiplyMatrices(inverse, part.node.matrix, relative);
      const det = determinant(relative);
      if (!det || !Number.isFinite(det) || !invertMatrixStable(relative, partInverse, workspace)) {
        singular = true;
        break;
      }
      vertices += part.vertices.length / stride;
      indices += part.indices.length;
      const stamp = new Float32Array(16);
      stamp.set(relative);
      stamps.push(stamp);
      mirrors.push(det < 0);
    }
    if (singular || vertices > 1_000_000 || !indices) continue;
    const baked = new Float32Array(vertices * stride),
      merged = new Uint32Array(indices);
    let vertexBase = 0,
      indexBase = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i],
        mirror = mirrors[i];
      multiplyMatrices(inverse, part.node.matrix, relative);
      invertMatrixStable(relative, partInverse, workspace);
      const source = part.vertices;
      for (let v = 0; v < source.length; v += stride)
        bakeVertex(
          source.subarray(v, v + stride) as Float32Array,
          baked,
          vertexBase * stride + v,
          relative,
          partInverse,
          mirror,
        );
      const index = part.indices;
      for (let k = 0; k < index.length; k += 3) {
        const a = vertexBase + index[k],
          b = vertexBase + index[k + 1],
          c = vertexBase + index[k + 2];
        merged[indexBase + k] = a;
        merged[indexBase + k + 1] = mirror ? c : b;
        merged[indexBase + k + 2] = mirror ? b : c;
      }
      vertexBase += source.length / stride;
      indexBase += index.length;
    }
    const node = createNode();
    const primitive: PBRPrimitive = {
      node,
      nodeIndex: -1,
      vertices: baked,
      indices: merged,
      definition: { attributes: { POSITION: 0 }, mode: 4 },
      material,
      weights: new Float32Array(0),
      targetNames: [],
    };
    batches.push({
      node,
      material,
      primitive,
      parts: parts.map((part, i) => ({
        primitive: part,
        stamp: stamps[i],
        vertices: part.vertices,
        indices: part.indices,
      })),
    });
  }
  return batches;
}
