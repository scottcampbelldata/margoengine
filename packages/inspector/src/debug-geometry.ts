import type { Mesh } from '@margoengine/core/extension';
import { Line } from '@margoengine/lines';
import { meshTriangles } from '../../shared/mesh-source.js';
const wirePositions = new WeakMap<object, Float32Array>();
interface MeshData {
  identity: object;
  pbr: boolean;
  parts: { vertices: Float32Array; indices: Uint32Array; stride: number }[];
  radius: number;
}
const debugData = new WeakMap<object, MeshData>();

export function meshData(mesh: Mesh) {
  const triangles = meshTriangles(mesh);
  if (!triangles) return null;
  const identity = triangles.kind === 'core' ? triangles.geometry : triangles.source;
  let data = debugData.get(identity);
  if (!data) {
    if (triangles.kind === 'core')
      data = {
        identity,
        pbr: false,
        parts: [{ vertices: triangles.geometry.vertices, indices: triangles.geometry.indices, stride: 6 }],
        radius: triangles.geometry.bounds[3],
      };
    else {
      const b = triangles.source.bounds;
      data = {
        identity,
        pbr: true,
        parts: triangles.source.primitives.map((p) => ({ vertices: p.vertices, indices: p.indices, stride: 20 })),
        radius: Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2,
      };
    }
    debugData.set(identity, data);
  }
  return data;
}

export function wireframe(mesh: Mesh): Line {
  const source = meshData(mesh)!;
  let positions = wirePositions.get(source.identity);
  if (!positions) {
    const data: number[] = [];
    for (const { indices, vertices, stride } of source.parts) {
      const count = vertices.length / stride,
        seen = new Set<number>();
      for (let i = 0; i < indices.length; i += 3)
        for (let edge = 0; edge < 3; edge++) {
          const a = indices[i + edge],
            b = indices[i + ((edge + 1) % 3)],
            key = Math.min(a, b) * count + Math.max(a, b);
          if (seen.has(key)) continue;
          seen.add(key);
          data.push(
            vertices[a * stride],
            vertices[a * stride + 1],
            vertices[a * stride + 2],
            vertices[b * stride],
            vertices[b * stride + 1],
            vertices[b * stride + 2],
          );
        }
    }
    positions = new Float32Array(data);
    wirePositions.set(source.identity, positions);
  }
  return new Line({ mesh, positions, mode: 'segments', color: '#72e8cc', onTop: true, cap: 'butt', join: 'miter' });
}
