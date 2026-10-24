import type { MutableVec2 } from '@margoengine/math';
import { paintBarycentricUV, type PaintWeights } from './paint-common.js';

interface ClipVertex {
  point: MutableVec2;
  weights: PaintWeights;
}
interface TexelSample {
  triangle: number;
  weights: PaintWeights;
}

function clip(vertices: ClipVertex[], axis: 0 | 1, bound: number, lower: boolean): ClipVertex[] {
  if (!vertices.length) return [];
  const output: ClipVertex[] = [];
  let previous = vertices[vertices.length - 1];
  for (const current of vertices) {
    const inside = lower ? current.point[axis] >= bound : current.point[axis] <= bound,
      priorInside = lower ? previous.point[axis] >= bound : previous.point[axis] <= bound;
    if (inside !== priorInside) {
      const fraction = (bound - previous.point[axis]) / (current.point[axis] - previous.point[axis]),
        point = previous.point.map((v, i) => v + (current.point[i] - v) * fraction) as MutableVec2;
      point[axis] = bound;
      output.push({
        point,
        weights: previous.weights.map((v, i) => v + (current.weights[i] - v) * fraction) as PaintWeights,
      });
    }
    if (inside) output.push(current);
    previous = current;
  }
  return output;
}

function representative(vertices: ClipVertex[]): { area: number; weights: PaintWeights } {
  const first = vertices[0],
    moment: PaintWeights = [0, 0, 0];
  let area = 0;
  for (let i = 1; i + 1 < vertices.length; i++) {
    const a = vertices[i],
      b = vertices[i + 1],
      cross =
        (a.point[0] - first.point[0]) * (b.point[1] - first.point[1]) -
        (a.point[1] - first.point[1]) * (b.point[0] - first.point[0]);
    area += cross;
    for (let axis = 0; axis < 3; axis++)
      moment[axis] += (cross * (first.weights[axis] + a.weights[axis] + b.weights[axis])) / 3;
  }
  let weights: PaintWeights;
  if (area !== 0) weights = moment.map((value) => value / area) as PaintWeights;
  else
    weights = [0, 1, 2].map(
      (axis) => vertices.reduce((sum, vertex) => sum + vertex.weights[axis], 0) / vertices.length,
    ) as PaintWeights;
  // A convex combination stays in the original triangle; clamp roundoff at exact edge contacts only.
  weights = weights.map((value) => Math.max(0, Math.min(1, value))) as PaintWeights;
  const total = weights.reduce((a, b) => a + b, 0);
  return { area: Math.abs(area), weights: weights.map((value) => value / total) as PaintWeights };
}

/** Which triangle of a face's UV fan a texel samples, and where: its centre, or the centre of the covered part. */
export function projectedTexelSample(
  uv: readonly (readonly number[])[],
  x: number,
  y: number,
  width: number,
  height: number,
): TexelSample | null {
  const center: MutableVec2 = [(x + 0.5) / width, (y + 0.5) / height];
  for (let i = 1; i + 1 < uv.length; i++) {
    const weights = paintBarycentricUV(center, uv[0], uv[i], uv[i + 1]);
    if (weights) return { triangle: i, weights };
  }
  let best: (TexelSample & { area: number }) | null = null;
  for (let i = 1; i + 1 < uv.length; i++) {
    const points = [uv[0], uv[i], uv[i + 1]].map((point) => [point[0] * width, point[1] * height] as MutableVec2),
      area =
        (points[1][0] - points[0][0]) * (points[2][1] - points[0][1]) -
        (points[1][1] - points[0][1]) * (points[2][0] - points[0][0]);
    if (area === 0) continue;
    let vertices: ClipVertex[] = points.map((point, index) => ({
      point,
      weights: [0, 1, 2].map((i) => (i === index ? 1 : 0)) as PaintWeights,
    }));
    for (const [axis, bound, lower] of [
      [0, x, true],
      [0, x + 1, false],
      [1, y, true],
      [1, y + 1, false],
    ] as const)
      vertices = clip(vertices, axis, bound, lower);
    if (!vertices.length) continue;
    const sample = representative(vertices);
    if (!best || sample.area > best.area) best = { triangle: i, ...sample };
  }
  return best && { triangle: best.triangle, weights: best.weights };
}
