import { MargoError } from '@margoengine/math/errors';
import type { FieldDescriptor, Port } from '../world/solver.js';
import { regionWords } from '../world/memory.js';
import { SHELL_APERTURE_LAYOUT, SHELL_APERTURE_QUANTITY, SHELL_APERTURE_WORDS } from '../crush/shell-aperture.js';
import { add, type CrushVector, cross, dot, scale, sub, triple } from '../crush/rigid-contact.js';

export interface ShellAperture {
  readonly area: number;
  readonly centre: CrushVector;
  readonly normal: CrushVector;
  readonly spans: Float64Array;
  readonly stripAreas: Float64Array;
}

export function isShellApertureField(field: FieldDescriptor): boolean {
  return field.kind === 'surfaceSampleSet' && field.quantity === SHELL_APERTURE_QUANTITY;
}

export function shellApertureRows(memory: WebAssembly.Memory, port: Port, last: number): Float64Array {
  const rowBytes = SHELL_APERTURE_WORDS * 8;
  const { region } = port;
  if (region.type !== 'f64' || region.layout !== SHELL_APERTURE_LAYOUT || region.byteLength % rowBytes !== 0)
    throw new MargoError('state', 'Use the layout-1 f64 CrushShellSolver aperture port for the hull.');
  if (last >= region.byteLength / rowBytes)
    throw new MargoError('state', 'Choose a shellSeam within the aperture port.');
  return regionWords(region.memory ?? memory, region) as Float64Array;
}

/** Integrates a live, possibly warped seam quad as its two triangular faces. */
export function panelAperture(
  rows: Float64Array,
  index: number,
  offset: CrushVector,
  outward: CrushVector,
  grid: number,
): ShellAperture | undefined {
  const at = index * SHELL_APERTURE_WORDS;
  const areaPublished = rows[at]!;
  if (areaPublished === 0) return undefined;
  const vertices = [triple(rows, at + 1), triple(rows, at + 4), triple(rows, at + 7), triple(rows, at + 10)] as const;
  if (
    !(areaPublished > 0 && Number.isFinite(areaPublished)) ||
    vertices.some((v) => v.some((x) => !Number.isFinite(x)))
  )
    throw new MargoError('state', 'Use finite positive shell aperture area and finite geometry.');
  const [a, b, c, d] = vertices;
  const triangleAreas = new Float64Array(2 * grid * grid);
  const spans = new Float64Array(triangleAreas.length * 2);
  let cell = 0;
  let area = 0;
  let centre: CrushVector = [0, 0, 0];
  let normal = centre;
  for (const [right, end] of [
    [b, c],
    [c, d],
  ] as const) {
    const n = cross(sub(right, a), sub(end, a));
    const patch = 0.5 * Math.sqrt(dot(n, n));
    area += patch;
    const fromA = scale(add(sub(right, a), sub(end, a)), 1 / 3);
    centre = add(centre, scale(fromA, patch));
    normal = add(normal, n);
    const height = (s: number, t: number) => a[1] + offset[1] + s * ((right[1] - a[1]) * (1 - t) + (end[1] - a[1]) * t);
    for (let i = 0; i < grid; i++) {
      const lo = i / grid;
      const hi = (i + 1) / grid;
      for (let j = 0; j < grid; j++) {
        const u = j / grid;
        const v = (j + 1) / grid;
        const corners = [height(lo, u), height(lo, v), height(hi, u), height(hi, v)];
        spans[2 * cell] = Math.min(...corners);
        spans[2 * cell + 1] = Math.max(...corners);
        // The triangular map has Jacobian 2*s*patch. Integrate each strip's area exactly.
        triangleAreas[cell] = (patch * (hi * hi - lo * lo)) / grid;
        cell++;
      }
    }
  }
  if (!(area > 0 && Number.isFinite(area)))
    throw new MargoError('state', 'Use a nondegenerate released shell aperture.');
  const length = Math.sqrt(dot(normal, normal));
  const unitNormal = length > 0 ? scale(normal, (dot(normal, outward) < 0 ? -1 : 1) / length) : outward;
  return {
    area,
    centre: add(add(a, offset), scale(centre, 1 / area)),
    normal: unitNormal,
    spans,
    stripAreas: triangleAreas,
  };
}
