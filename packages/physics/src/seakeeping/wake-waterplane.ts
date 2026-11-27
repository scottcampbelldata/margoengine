import { MargoError } from '@margoengine/math/errors';
import type { HullMesh } from './wetted.js';

// Four-point Gauss–Legendre on [0, 1], DLMF §3.5(v).
const X = [0.06943184420297371, 0.33000947820757187, 0.6699905217924281, 0.9305681557970262] as const;
const W = [0.17392742256872693, 0.32607257743127307, 0.32607257743127307, 0.17392742256872693] as const;
const NODES = X.length * X.length;

interface Line {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly slope: number;
}

interface Strip {
  readonly x: number;
  readonly span: number;
  readonly low: Line;
  readonly high: Line;
  readonly along: number;
  readonly across: number;
}

export interface WakeWaterplaneOptions {
  /** Maximum quadrature panel span in metres along body X or across body Z. */
  readonly maxPanelSize: number;
  /** Caller-supplied upper bound on the number of output nodes. */
  readonly maxRows?: number;
}

export interface WakeWaterplane {
  /** Reference hull-local Y in metres. */
  readonly waterline: number;
  /** Consecutive hull-local X, Z and positive area-weight triples. */
  readonly nodes: Float64Array;
}

function at(line: Line, x: number): number {
  return line.z0 + (x - line.x0) * line.slope;
}

function cutLines({ vertices, indices }: HullMesh, waterline: number): Line[] {
  const lines: Line[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const offsets = [indices[i]! * 3, indices[i + 1]! * 3, indices[i + 2]! * 3];
    const cuts: [number, number][] = [];
    for (let edge = 0; edge < 3; edge++) {
      let a = offsets[edge]!;
      let b = offsets[(edge + 1) % 3]!;
      if (vertices[a + 1]! > vertices[b + 1]!) [a, b] = [b, a];
      const low = vertices[a + 1]!;
      const high = vertices[b + 1]!;
      // Always interpolate from the lower end so a shared mesh edge yields the same knot in both triangles.
      if (!(low < waterline && high >= waterline)) continue;
      const t = (waterline - low) / (high - low);
      const x = high === waterline ? vertices[b]! : vertices[a]! + t * (vertices[b]! - vertices[a]!);
      const z = high === waterline ? vertices[b + 2]! : vertices[a + 2]! + t * (vertices[b + 2]! - vertices[a + 2]!);
      cuts.push([x, z]);
    }
    if (cuts.length !== 2) continue;
    let [[x0, z0], [x1, z1]] = cuts as [[number, number], [number, number]];
    if (x0 === x1) continue;
    if (x0 > x1) [x0, z0, x1, z1] = [x1, z1, x0, z0];
    lines.push({ x0, x1, z0, slope: (z1 - z0) / (x1 - x0) });
  }
  return lines.sort((a, b) => a.x0 - b.x0);
}

// Consecutive knots split the exact polygon into trapezoids, including separate wet spans or dry holes.
function cutStrips(lines: readonly Line[], panel: number): Strip[] {
  const knots = [...new Set(lines.flatMap(({ x0, x1 }) => [x0, x1]))].sort((a, b) => a - b);
  const active = new Set<Line>();
  const strips: Strip[] = [];
  let next = 0;
  for (let i = 0; i + 1 < knots.length; i++) {
    const x = knots[i]!;
    const end = knots[i + 1]!;
    const span = end - x;
    const middle = x + span / 2;
    for (const line of active) if (line.x1 <= x) active.delete(line);
    while (next < lines.length && lines[next]!.x0 <= x) active.add(lines[next++]!);
    const order = [...active].sort((a, b) => at(a, middle) - at(b, middle));
    if (order.length % 2)
      throw new MargoError('state', 'Close the hull waterplane outline before baking its wake quadrature.');
    for (let j = 0; j < order.length; j += 2) {
      const low = order[j]!;
      const high = order[j + 1]!;
      const breadth = Math.max(at(high, x) - at(low, x), at(high, end) - at(low, end));
      if (!(breadth > 0)) continue;
      const along = Math.ceil((span * Math.max(1, Math.abs(low.slope), Math.abs(high.slope))) / panel);
      strips.push({ x, span, low, high, along, across: Math.ceil(breadth / panel) });
    }
  }
  return strips;
}

/**
 * Bake the actual indexed waterplane into four-point Gauss–Legendre panels on each axis.
 * The positive weights integrate area and both first moments exactly on each trapezoid. For an affine
 * rigid-body vertical velocity, their signed volume matches its integral over the waterplane.
 * Use smaller panels to resolve shorter waves. The wake's receiver radius is a separate projection choice.
 * @throws MargoError `state` if the options, closed outline or row budget cannot specify a valid bake.
 */
export function bakeWakeWaterplane(mesh: HullMesh, waterline: number, options: WakeWaterplaneOptions): WakeWaterplane {
  const { maxPanelSize, maxRows } = options ?? {};
  if (
    !Number.isFinite(waterline) ||
    !(maxPanelSize > 0 && Number.isFinite(maxPanelSize)) ||
    (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 0))
  )
    throw new MargoError(
      'state',
      'Bake a finite reference waterline with positive panel spacing and a whole row limit.',
    );

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
    throw new MargoError('state', 'Pass vertex triples and indexed triangles for the closed hull waterplane.');
  for (let i = 0; i < vertices.length; i++) {
    if (!Number.isFinite(vertices[i]))
      throw new MargoError('state', 'Use finite hull coordinates before baking the waterplane.');
  }
  for (let i = 0; i < indices.length; i++) {
    const vertex = indices[i]!;
    if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= vertices.length / 3)
      throw new MargoError('state', 'Use triangle indices that select vertices in the supplied hull mesh.');
  }
  const strips = cutStrips(cutLines({ vertices, indices }, waterline), maxPanelSize);
  const rows = strips.reduce((sum, { along, across }) => sum + along * across * NODES, 0);
  if (
    !Number.isSafeInteger(rows) ||
    rows * 3 * Float64Array.BYTES_PER_ELEMENT > 0xffffffff ||
    (maxRows !== undefined && rows > maxRows)
  )
    throw new MargoError('state', 'Increase the waterplane panel spacing or the wake source row budget before baking.');

  const nodes = new Float64Array(3 * rows);
  let row = 0;
  for (const { x: start, span, low, high, along, across } of strips) {
    const dx = span / along;
    for (let i = 0; i < along; i++) {
      for (let a = 0; a < X.length; a++) {
        const x = start + dx * (i + X[a]!);
        const lower = at(low, x);
        const dz = (at(high, x) - lower) / across;
        for (let j = 0; j < across; j++) {
          for (let b = 0; b < X.length; b++) {
            nodes[row++] = x;
            nodes[row++] = lower + dz * (j + X[b]!);
            nodes[row++] = dx * dz * W[a]! * W[b]!;
          }
        }
      }
    }
  }
  return { waterline, nodes };
}
