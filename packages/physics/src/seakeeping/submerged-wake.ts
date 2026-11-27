import { MargoError } from '@margoengine/math/errors';
import { hullSectionMoments, type Section } from './strips.js';
import type { HullMesh } from './wetted.js';

type Span = readonly [left: number, right: number];

/** Signed wetted section difference sampled at one transverse Gauss point. */
export interface SubmergedWakeNode {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly band: number;
  readonly area: number;
}

const EMPTY: Span = [0, 0];
const GAUSS = 1 / Math.sqrt(3);

/** Equivalent contiguous span matching the integral of area and lateral first moment of a band. */
function bandSpan(area: number, moment: number, thickness: number): Span {
  if (!(area > 0)) return EMPTY;
  const centre = moment / area,
    half = (0.5 * area) / thickness;
  return [centre - half, centre + half];
}

/** One station face has at most two signed span differences, with two quadrature points each. */
export function submergedWakeNodes(
  mesh: HullMesh,
  waterline: number,
  sections: readonly Section[],
  depths: readonly number[],
  minimumRadius: number,
): SubmergedWakeNode[] {
  const draft = Math.max(...sections.map((section) => section.draft));
  if (depths.at(-1)! < draft - 1e-10 * Math.max(1, draft))
    throw new MargoError('state', 'The submerged wake bands do not cover the reference draft; add a deeper edge.');
  const n = sections.length,
    width = sections[0]!.width,
    start = sections[0]!.x - 0.5 * width;
  const nodes: SubmergedWakeNode[] = [];
  let top = hullSectionMoments(mesh, waterline, n);
  for (let band = 0; band < depths.length - 1; band++) {
    const thickness = depths[band + 1]! - depths[band]!;
    const bottom = hullSectionMoments(mesh, waterline - depths[band + 1]!, n);
    const spans = top.sections.map(({ area }, i) =>
      bandSpan(area - bottom.sections[i]!.area, top.lateralMoments[i]! - bottom.lateralMoments[i]!, thickness),
    );
    for (let i = 0; i <= n; i++) {
      const previous = spans[i - 1] ?? EMPTY,
        next = spans[i] ?? EMPTY;
      const x = start + i * width,
        breadth = Math.max(sections[i - 1]?.breadth ?? 0, sections[i]?.breadth ?? 0);
      // The Gauss points already integrate the lateral span. Let numerical smoothing shrink with the
      // longitudinal station interval, independently of the beam already represented in the quadrature.
      const radius = Math.max(minimumRadius, 0.5 * width);
      function sample(left: number, right: number, sign: number): void {
        // Adjacent clips of a prismatic span may differ by arithmetic roundoff.
        const span = right - left;
        if (!(span > 32 * Number.EPSILON * Math.max(Math.abs(left), Math.abs(right), breadth))) return;
        const half = 0.5 * span,
          middle = left + half;
        const area = sign * half * thickness;
        nodes.push({ x, z: middle - GAUSS * half, radius, band, area });
        nodes.push({ x, z: middle + GAUSS * half, radius, band, area });
      }
      function difference(a: Span, b: Span, sign: number): void {
        if (b[0] === b[1]) sample(a[0], a[1], sign);
        else {
          sample(a[0], Math.min(a[1], b[0]), sign);
          sample(Math.max(a[0], b[1]), a[1], sign);
        }
      }
      difference(previous, next, 1);
      difference(next, previous, -1);
    }
    top = bottom;
  }
  return nodes;
}
