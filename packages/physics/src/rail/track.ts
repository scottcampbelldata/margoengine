import { MargoError } from '@margoengine/math/errors';
import { cos, hypot, sin } from '@margoengine/math/pinned';
import { railNumber } from './contact.js';

export type RailPoint = readonly [number, number, number];

/** One station in an authored track centreline. Metres, radians, and optional per-rail roughness in metres. */
export interface RailStation {
  readonly centre: RailPoint;
  readonly cant?: number;
  readonly leftHeight?: number;
  readonly rightHeight?: number;
}

export interface RailSection {
  readonly name: string;
  readonly stations: readonly RailStation[];
  /** Named outgoing routes at a turnout. The first is the normal alignment. */
  readonly next?: readonly string[];
}

export interface RailSample {
  readonly centre: RailPoint;
  readonly tangent: RailPoint;
  readonly right: RailPoint;
  readonly up: RailPoint;
  readonly cant: number;
  readonly curvature: number;
  readonly leftHeight: number;
  readonly rightHeight: number;
  readonly supported: boolean;
}

interface Station {
  readonly centre: RailPoint;
  readonly cant: number;
  readonly leftHeight: number;
  readonly rightHeight: number;
  readonly tangent: RailPoint;
  readonly curvature: number;
  readonly distance: number;
}

const EPS = 1e-8;
const dot = (a: RailPoint, b: RailPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const diff = (a: RailPoint, b: RailPoint): RailPoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const blend = (a: number, b: number, t: number) => a + (b - a) * t;
const vectorBlend = (a: RailPoint, b: RailPoint, t: number): RailPoint => [
  blend(a[0], b[0], t),
  blend(a[1], b[1], t),
  blend(a[2], b[2], t),
];

function normalise(vector: RailPoint): RailPoint {
  const length = hypot(...vector);
  if (length < EPS) throw new MargoError('state', 'Supply track stations with a nonzero tangent.');
  return [vector[0] / length, vector[1] / length, vector[2] / length]; // float division: unit vector
}

/** A surveyed route compiled once from SI centreline stations and the selected turnout alignments. */
export class RailRoute {
  readonly length: number;
  private readonly stations: readonly Station[];

  constructor(input: readonly RailStation[]) {
    if (input.length < 2) throw new MargoError('state', 'Provide two or more rail stations.');
    const samples = input.map(({ centre, cant = 0, leftHeight = 0, rightHeight = 0 }) => ({
      centre: centre.map((value) => railNumber(value, 'rail coordinate')) as unknown as RailPoint,
      cant: railNumber(cant, 'rail cant in radians', -0.7, 0.7),
      leftHeight: railNumber(leftHeight, 'left rail elevation'),
      rightHeight: railNumber(rightHeight, 'right rail elevation'),
    }));
    const edges = samples.slice(1).map(({ centre }, i) => diff(centre, samples[i]!.centre));
    const spans = edges.map((edge) => {
      railNumber(hypot(edge[0], edge[2]), 'horizontal station spacing', EPS);
      return hypot(...edge);
    });
    let distance = 0;
    this.stations = samples.map((sample, i) => {
      const before = Math.max(0, i - 1);
      const after = Math.min(edges.length - 1, i);
      const a = normalise(edges[before]!);
      const b = normalise(edges[after]!);
      const span = 0.5 * (spans[before]! + spans[after]!);
      const bent = diff(b, a);
      const tangent = normalise(vectorBlend(a, b, 0.5));
      const curvature = dot(bent, [tangent[2], 0, -tangent[0]]) / span; // float division: curvature per arclength
      const station = { ...sample, tangent, curvature, distance };
      distance += spans[i] ?? 0;
      return station;
    });
    this.length = distance;
  }

  /** Interpolate the route frame and rail heights. Outside the route the tangent extends without wheel support. */
  sample(distance: number): RailSample {
    railNumber(distance, 'rail arclength');
    let lo = 0,
      hi = this.stations.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (distance < this.stations[mid]!.distance) hi = mid;
      else lo = mid;
    }
    const a = this.stations[lo]!;
    const b = this.stations[hi]!;
    const t = Math.max(0, Math.min(1, (distance - a.distance) / (b.distance - a.distance))); // float division: interval fraction
    const tangent = normalise(vectorBlend(a.tangent, b.tangent, t));
    const horizontal = normalise([tangent[2], 0, -tangent[0]]);
    const level = [
      tangent[1] * horizontal[2],
      tangent[2] * horizontal[0] - tangent[0] * horizontal[2],
      -tangent[1] * horizontal[0],
    ] as const;
    const cant = blend(a.cant, b.cant, t);
    const sine = sin(cant),
      cosine = cos(cant);
    const right = horizontal.map((value, i) => value * cosine - level[i]! * sine) as unknown as RailPoint;
    const up = horizontal.map((value, i) => value * sine + level[i]! * cosine) as unknown as RailPoint;
    const supported = distance >= 0 && distance <= this.length;
    const extension = distance < 0 ? distance : distance > this.length ? distance - this.length : 0;
    const point = vectorBlend(a.centre, b.centre, t);
    const centre = point.map((value, i) => value + extension * tangent[i]!) as unknown as RailPoint;
    return {
      centre,
      tangent,
      right,
      up,
      cant,
      supported,
      curvature: blend(a.curvature, b.curvature, t),
      leftHeight: blend(a.leftHeight, b.leftHeight, t),
      rightHeight: blend(a.rightHeight, b.rightHeight, t),
    };
  }
}

/** Resolve a finite train route at the named turnout alignments, without moving blades under a loaded wheel. */
export function railRouteAtSwitches(
  sections: readonly RailSection[],
  start: string,
  switches: Readonly<Record<string, string>> = {},
): RailRoute {
  const routes = new Map(sections.map((section) => [section.name, section]));
  if (routes.size !== sections.length) throw new MargoError('state', 'Use a unique name for each rail section.');
  const visited = new Set<string>();
  const result: RailStation[] = [];
  let name: string | undefined = start;
  while (name !== undefined) {
    const section = routes.get(name);
    if (!section || visited.has(name) || section.stations.length < 2)
      throw new MargoError('state', 'Use a finite route through known rail sections with two or more stations.');
    const previous = result.at(-1);
    const entrance = section.stations[0]!;
    if (previous && hypot(...diff(previous.centre, entrance.centre)) > EPS)
      throw new MargoError('state', 'Join turnout sections at a common centreline station.');
    result.push(...section.stations.slice(previous ? 1 : 0));
    visited.add(name);
    const next: string | undefined = switches[name] ?? section.next?.[0];
    if (next !== undefined && !section.next?.includes(next))
      throw new MargoError('state', 'Select an authored outgoing rail section at the turnout.');
    name = next;
  }
  return new RailRoute(result);
}
