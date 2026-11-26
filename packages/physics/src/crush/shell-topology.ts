import { MargoError } from '@margoengine/math/errors';
import { type CrushVector, cross, dot, scale, sub } from './rigid-contact.js';
import type { CrushShellMaterial } from './shell.js';

export type Triangle = readonly [number, number, number];

interface Edge {
  readonly start: number;
  readonly end: number;
  readonly opposite: number;
  readonly area: number;
  paired: boolean;
}

export interface ShellTopology {
  readonly nodeMass: Float64Array;
  readonly faces: ArrayBuffer;
  readonly hinges: ArrayBuffer;
  readonly maxStep: number;
  readonly boundaryEdges: ReadonlySet<string>;
}

const length = (point: CrushVector): number => Math.sqrt(dot(point, point));

export const shellEdgeKey = (a: number, b: number): string => (a < b ? `${a}/${b}` : `${b}/${a}`);

export function makeShell(
  positions: readonly CrushVector[],
  triangles: readonly Triangle[],
  material: CrushShellMaterial,
  rolling?: CrushVector,
): ShellTopology {
  const masses = new Float64Array(positions.length);
  const stiffnesses = new Float64Array(positions.length);
  const edges = new Map<string, Edge>();
  const seen = new Set<string>();
  const faceBytes = new ArrayBuffer(triangles.length * 56);
  const faceNodes = new Uint32Array(faceBytes);
  const faceValues = new Float64Array(faceBytes);
  const hingeNodes: number[] = [];
  const hingeValues: number[] = [];
  const { youngModulus, poissonRatio, density, thickness } = material;
  const rigidity = (youngModulus * thickness ** 3) / (12 * (1 - poissonRatio ** 2));
  const membraneBound = (2 * youngModulus) / (1 - Math.abs(poissonRatio));

  for (const [index, vertices] of triangles.entries()) {
    if (
      vertices.length !== 3 ||
      vertices.some((v) => !Number.isSafeInteger(v) || v < 0 || v >= positions.length) ||
      new Set(vertices).size !== 3
    )
      throw new MargoError('state', 'Give each shell triangle three distinct in-range vertex indices.');
    const key = [...vertices].sort((a, b) => a - b).join('/');
    if (seen.has(key)) throw new MargoError('state', 'Remove duplicate shell triangles.');
    seen.add(key);
    const [a, b, c] = vertices;
    const base = sub(positions[b]!, positions[a]!);
    const side = sub(positions[c]!, positions[a]!);
    const baseLength = length(base);
    const normal = cross(base, side);
    const doubleArea = length(normal);
    const height = doubleArea / baseLength;
    if (!(baseLength > 0 && height > 0 && Number.isFinite(doubleArea)))
      throw new MargoError('state', 'Use finite nondegenerate triangles for the shell.');
    const area = doubleArea / 2;
    const volume = area * thickness;
    const projection = dot(base, side) / baseLength;
    const bx = 1 / baseLength;
    const by = -projection / (baseLength * height);
    const cy = 1 / height;
    const gradients = [Math.sqrt(bx * bx + (by + cy) ** 2), Math.sqrt(bx * bx + by * by), cy];
    const rowBound = membraneBound * volume * (gradients[0]! + gradients[1]! + cy);
    faceNodes.set(vertices, 14 * index);
    if (rolling) {
      const first = scale(base, 1 / baseLength);
      const second = cross(scale(normal, 1 / doubleArea), first);
      const u = dot(rolling, first);
      const v = dot(rolling, second);
      const projection = Math.sqrt(u * u + v * v);
      if (!(projection > 0 && Number.isFinite(projection)))
        throw new MargoError('state', 'Give a rolling direction with a tangent projection on every shell face.');
      const cosine = u / projection;
      const sine = v / projection;
      faceValues.set(
        [cosine * bx + sine * by, -sine * bx + cosine * by, sine * cy, cosine * cy, volume],
        7 * index + 2,
      );
    } else {
      faceValues.set([bx, by, 0, cy, volume], 7 * index + 2);
    }
    for (const [corner, vertex] of vertices.entries()) {
      masses[vertex]! += (volume * density) / 3;
      stiffnesses[vertex]! += rowBound * gradients[corner]!;
    }
    for (const [start, end, opposite] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ] as const) {
      const edgeKey = shellEdgeKey(start, end);
      const previous = edges.get(edgeKey);
      if (!previous) {
        edges.set(edgeKey, { start, end, opposite, area, paired: false });
        continue;
      }
      if (previous.paired || previous.start !== end)
        throw new MargoError('state', 'Use consistently wound shell faces with at most two faces per edge.');
      previous.paired = true;
      const edge = sub(positions[start]!, positions[end]!);
      const squared = dot(edge, edge);
      const edgeLength = Math.sqrt(squared);
      const left = sub(positions[previous.opposite]!, positions[end]!);
      const right = sub(positions[opposite]!, positions[end]!);
      const stiffness = (3 * rigidity * squared) / (previous.area + area);
      const leftProjection = dot(edge, left) / squared;
      const rightProjection = dot(edge, right) / squared;
      const cGradient = edgeLength / (2 * previous.area);
      const dGradient = edgeLength / (2 * area);
      const hingeGradients = [
        Math.abs(leftProjection - 1) * cGradient + Math.abs(rightProjection - 1) * dGradient,
        Math.abs(leftProjection) * cGradient + Math.abs(rightProjection) * dGradient,
        cGradient,
        dGradient,
      ];
      const hingeBound = stiffness * hingeGradients.reduce((sum, value) => sum + value, 0);
      const hinge = [end, start, previous.opposite, opposite];
      for (const [corner, vertex] of hinge.entries()) stiffnesses[vertex]! += hingeBound * hingeGradients[corner]!;
      hingeNodes.push(...hinge);
      hingeValues.push(0, stiffness);
    }
  }
  const hingeBytes = new ArrayBuffer(hingeNodes.length * 8);
  const hingeIndices = new Uint32Array(hingeBytes);
  const hingeScalars = new Float64Array(hingeBytes);
  for (let start = 0; start < hingeNodes.length; start += 4) {
    hingeIndices.set(hingeNodes.slice(start, start + 4), start * 2);
    hingeScalars.set(hingeValues.slice(start / 2, start / 2 + 2), start + 2);
  }
  let bound = 0;
  for (let i = 0; i < masses.length; i++) {
    const mass = masses[i]!;
    const omegaSquared = stiffnesses[i]! / mass;
    if (!(mass > 0 && Number.isFinite(mass) && omegaSquared > 0 && Number.isFinite(omegaSquared)))
      throw new MargoError('state', 'Give every shell vertex incident area and use finite SI sheet dimensions.');
    bound = Math.max(bound, omegaSquared);
  }
  const boundaryEdges = new Set([...edges].filter(([, edge]) => !edge.paired).map(([key]) => key));
  return { nodeMass: masses, faces: faceBytes, hinges: hingeBytes, maxStep: 0.5 / Math.sqrt(bound), boundaryEdges };
}
