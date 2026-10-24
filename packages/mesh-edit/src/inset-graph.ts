import type { MutableVec2 } from '@margoengine/math';
import { turn2 as turn } from './polygon.js';

type Segment = { a: string; b: string; p: MutableVec2; q: MutableVec2 };

/** Throw if any two 2D segments cross or overlap, including a vertex touching another segment. */
export function assertInsetEdges(segments: Segment[], epsilon: number, source = false): void {
  const fail = () => {
    throw new RangeError(
      source
        ? 'Selected region has crossing, overlapping or unwelded edges; repair its planar topology before insetting.'
        : 'Inset width collapses or crosses the region boundary; reduce the width or split the selected region.',
    );
  };
  const boxes = segments
    .map((s) => ({
      ...s,
      left: Math.min(s.p[0], s.q[0]),
      right: Math.max(s.p[0], s.q[0]),
      bottom: Math.min(s.p[1], s.q[1]),
      top: Math.max(s.p[1], s.q[1]),
      length: Math.hypot(s.q[0] - s.p[0], s.q[1] - s.p[1]),
    }))
    .sort((a, b) => a.left - b.left);
  const on = (a: MutableVec2, b: MutableVec2, p: MutableVec2, length: number) =>
    Math.abs(turn(a, b, p)) <= epsilon * length &&
    p[0] >= Math.min(a[0], b[0]) - epsilon &&
    p[0] <= Math.max(a[0], b[0]) + epsilon &&
    p[1] >= Math.min(a[1], b[1]) - epsilon &&
    p[1] <= Math.max(a[1], b[1]) + epsilon;
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i],
      al = a.length;
    if (al <= epsilon) fail();
    for (let j = i + 1; j < boxes.length && boxes[j].left <= a.right + epsilon; j++) {
      const b = boxes[j];
      if (b.bottom > a.top + epsilon || b.top < a.bottom - epsilon) continue;
      const common = a.a === b.a || a.a === b.b ? a.a : a.b === b.a || a.b === b.b ? a.b : undefined;
      if (common) {
        const p = common === a.a ? a.p : a.q,
          q = common === a.a ? a.q : a.p,
          r = common === b.a ? b.q : b.p;
        if (
          Math.abs(turn(p, q, r)) <= epsilon * al &&
          (q[0] - p[0]) * (r[0] - p[0]) + (q[1] - p[1]) * (r[1] - p[1]) > epsilon * epsilon
        )
          fail();
        continue;
      }
      const abC = turn(a.p, a.q, b.p),
        abD = turn(a.p, a.q, b.q),
        cdA = turn(b.p, b.q, a.p),
        cdB = turn(b.p, b.q, a.q),
        bl = b.length;
      if (
        (abC * abD < 0 && cdA * cdB < 0) ||
        on(a.p, a.q, b.p, al) ||
        on(a.p, a.q, b.q, al) ||
        on(b.p, b.q, a.p, bl) ||
        on(b.p, b.q, a.q, bl)
      )
        fail();
      if (bl <= epsilon) fail();
    }
  }
}

/** Spread boundary offsets smoothly over interior vertices (a graph Laplacian solved by conjugate gradients). */
export function insetInteriorDisplacements(
  vertices: number[],
  edges: readonly (readonly [number, number])[],
  boundary: ReadonlyMap<number, MutableVec2>,
): Map<number, MutableVec2> {
  const neighbors = new Map(vertices.map((v) => [v, new Set<number>()]));
  for (const [a, b] of edges) {
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  }
  const interior = vertices.filter((v) => !boundary.has(v)),
    at = new Map(interior.map((v, i) => [v, i])),
    result = new Map([...boundary].map(([v, d]) => [v, [...d] as MutableVec2]));
  for (const v of interior) result.set(v, [0, 0]);
  if (!interior.length) return result;
  const degree = Float64Array.from(interior, (v) => neighbors.get(v)!.size),
    offsets = new Int32Array(interior.length + 1),
    columns: number[] = [];
  for (let i = 0; i < interior.length; i++) {
    for (const n of neighbors.get(interior[i])!) {
      const column = at.get(n);
      if (column !== undefined) columns.push(column);
    }
    offsets[i + 1] = columns.length;
  }
  const adjacent = Int32Array.from(columns),
    dot = (a: Float64Array, b: Float64Array) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
      return sum;
    };
  for (let axis = 0; axis < 2; axis++) {
    const rhs = new Float64Array(interior.length);
    for (let i = 0; i < interior.length; i++)
      for (const n of neighbors.get(interior[i])!) rhs[i] += boundary.get(n)?.[axis] ?? 0;
    const x = new Float64Array(interior.length),
      r = rhs.slice(),
      z = Float64Array.from(r, (v, i) => v / degree[i]),
      p = z.slice(),
      ap = new Float64Array(interior.length);
    const tolerance = Math.max(1e-28, dot(rhs, rhs) * 1e-24);
    let rz = dot(r, z),
      converged = dot(r, r) <= tolerance;
    for (let step = 0; !converged && step < Math.min(20_000, Math.max(64, interior.length * 8)); step++) {
      for (let i = 0; i < p.length; i++) {
        let sum = 0;
        for (let j = offsets[i]; j < offsets[i + 1]; j++) sum += p[adjacent[j]];
        ap[i] = degree[i] * p[i] - sum;
      }
      const denominator = dot(p, ap);
      if (!(denominator > 0) || !Number.isFinite(denominator)) break;
      const alpha = rz / denominator;
      for (let i = 0; i < x.length; i++) {
        x[i] += alpha * p[i];
        r[i] -= alpha * ap[i];
      }
      converged = dot(r, r) <= tolerance;
      if (converged) break;
      for (let i = 0; i < z.length; i++) z[i] = r[i] / degree[i];
      const next = dot(r, z),
        beta = next / rz;
      rz = next;
      for (let i = 0; i < p.length; i++) p[i] = z[i] + beta * p[i];
    }
    if (!converged || Array.from(x).some((v) => !Number.isFinite(v)))
      throw new RangeError('Inset interior could not be resolved accurately; split the region into smaller patches.');
    for (let i = 0; i < interior.length; i++) result.get(interior[i])![axis] = x[i];
  }
  return result;
}
