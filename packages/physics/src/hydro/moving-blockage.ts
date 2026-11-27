import { cos, sin } from '@margoengine/math/pinned';

type Point = readonly [number, number];

export interface BlockageGrid {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly dz: number;
}

export interface CylinderWall {
  readonly cell: number;
  /** Length-times-normal pointing out of the water and into the wall, averaged over the step. */
  readonly normal: Point;
  /** Unit normal into the wall. */
  readonly inward: Point;
  /** Moment arm along the projected wall in cylinder-local metres. */
  readonly centre: Point;
}

export interface CylinderGeometry {
  readonly occupiedStart: Float64Array;
  readonly occupiedEnd: Float64Array;
  /** Fractions of each cell's incoming x and z faces open over the step. */
  readonly openX: Float64Array;
  readonly openZ: Float64Array;
  readonly walls: readonly CylinderWall[];
}

export interface BlockageFootprint {
  readonly vertices: ReadonlyArray<Point>;
  readonly low: Point;
  readonly high: Point;
  /** Upper bound on the occupied area of any cell, in square metres. */
  readonly area: number;
  /** Distance from the rigid origin to the nearest side. */
  readonly margin: number;
}

function turn(a: Point, b: Point, x: Point): number {
  return (b[0] - a[0]) * (x[1] - a[1]) - (b[1] - a[1]) * (x[0] - a[0]);
}

/** Normalize a strictly convex perimeter and locate its bounds and rigid origin. */
export function prepareFootprint(outline: ReadonlyArray<Point>): BlockageFootprint | undefined {
  if (
    !Array.isArray(outline) ||
    outline.length < 3 ||
    outline.some((p) => p?.length !== 2 || !p.every(Number.isFinite))
  )
    return undefined;
  const vertices = outline.map(([x, z]): Point => [x, z]);
  const signed = measures(vertices).area;
  if (!Number.isFinite(signed) || signed === 0) return undefined;
  if (signed < 0) vertices.reverse();
  const low: [number, number] = [Infinity, Infinity];
  const high: [number, number] = [-Infinity, -Infinity];
  let margin = Infinity;
  const origin: Point = [0, 0];
  for (let i = 0; i < vertices.length; i++) {
    const next = (i + 1) % vertices.length;
    const a = vertices[i]!;
    const b = vertices[next]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.sqrt(dx * dx + dz * dz);
    const inset = turn(a, b, origin) / length;
    if (!(inset > 0 && Number.isFinite(inset))) return undefined;
    // Checking every other vertex against each inward half-plane also
    // rejects self-intersecting orders with same-sign local turns.
    for (let j = 0; j < vertices.length; j++) {
      if (j !== i && j !== next && !(turn(a, b, vertices[j]!) > 0)) return undefined;
    }
    margin = Math.min(margin, inset);
    low[0] = Math.min(low[0], a[0]);
    low[1] = Math.min(low[1], a[1]);
    high[0] = Math.max(high[0], a[0]);
    high[1] = Math.max(high[1], a[1]);
  }
  return { vertices, low, high, area: Math.abs(signed), margin };
}

/** Polygonal footprint, inscribed in a vertical cylinder; 64 sides give under 0.17% area error. */
export function cylinderFootprint(radius: number): readonly Point[] {
  return Array.from({ length: 64 }, (_, i) => {
    const angle = (i * 2 * Math.PI) / 64;
    return [radius * cos(angle), radius * sin(angle)];
  });
}

function clip(polygon: readonly Point[], a: number, b: number, c: number): Point[] {
  if (!polygon.length) return [];
  const clipped: Point[] = [];
  let before = polygon.at(-1)!;
  let distanceBefore = a * before[0] + b * before[1] + c;
  for (const after of polygon) {
    const distanceAfter = a * after[0] + b * after[1] + c;
    if (distanceAfter >= 0 !== distanceBefore >= 0) {
      const fraction = distanceBefore / (distanceBefore - distanceAfter);
      clipped.push([before[0] + fraction * (after[0] - before[0]), before[1] + fraction * (after[1] - before[1])]);
    }
    if (distanceAfter >= 0) clipped.push(after);
    before = after;
    distanceBefore = distanceAfter;
  }
  return clipped;
}

/** Clip the unit square by a rectangle under p = base + t * travel + s * edge. */
function clipMovingSegment(base: Point, travel: Point, edge: Point, low: Point, high: Point): readonly Point[] {
  const t = clip(unitSquare(), travel[0], edge[0], base[0] - low[0]);
  const x = clip(t, -travel[0], -edge[0], high[0] - base[0]);
  const z = clip(x, travel[1], edge[1], base[1] - low[1]);
  return clip(z, -travel[1], -edge[1], high[1] - base[1]);
}

function wallInCell(base: Point, travel: Point, edge: Point, low: Point, high: Point): readonly Point[] {
  const [dx, dz] = edge;
  // When an edge stays on a grid face, only its fluid side owns wall
  // pressure. Crossing that face at one instant has zero time measure.
  if (travel[0] === 0 && dx === 0 && base[0] === (dz < 0 ? low[0] : high[0])) return [];
  if (travel[1] === 0 && dz === 0 && base[1] === (dx > 0 ? low[1] : high[1])) return [];
  return clipMovingSegment(base, travel, edge, low, high);
}

function unitSquare(): Point[] {
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
}

function measures(polygon: readonly Point[]): { area: number; fraction: number } {
  if (polygon.length < 3) return { area: 0, fraction: 0 };
  // Translate first so moments do not subtract two large products at a cell edge.
  const origin = polygon[0]!;
  let twiceArea = 0;
  let moment = 0;
  for (let k = 1; k + 1 < polygon.length; k++) {
    const a = polygon[k]!;
    const b = polygon[k + 1]!;
    const ay = a[1] - origin[1];
    const by = b[1] - origin[1];
    const cross = (a[0] - origin[0]) * by - (b[0] - origin[0]) * ay;
    twiceArea += cross;
    moment += (ay + by) * cross;
  }
  return { area: 0.5 * twiceArea, fraction: twiceArea ? origin[1] + moment / (3 * twiceArea) : 0 };
}

function occupiedArea(footprint: readonly Point[], centre: Point, low: Point, high: Point): number {
  const t = clip(footprint, 1, 0, centre[0] - low[0]);
  const x = clip(t, -1, 0, high[0] - centre[0]);
  const z = clip(x, 0, 1, centre[1] - low[1]);
  return measures(clip(z, 0, -1, high[1] - centre[1])).area;
}

function blockedFace(footprint: readonly Point[], start: Point, travel: Point, base: Point, edge: Point): number {
  // Pull each solid half-plane back to the face's (time, coordinate)
  // square. Its clipped area is the mean solid coverage of this face.
  let face = unitSquare();
  let a = footprint.at(-1)!;
  for (const b of footprint) {
    const nx = a[1] - b[1];
    const nz = b[0] - a[0];
    face = clip(
      face,
      -nx * travel[0] - nz * travel[1],
      nx * edge[0] + nz * edge[1],
      nx * (base[0] - start[0] - a[0]) + nz * (base[1] - start[1] - a[1]),
    );
    if (!face.length) return 0;
    a = b;
  }
  return measures(face).area;
}

function wrap(value: number, n: number): number {
  const remainder = value % n;
  return remainder < 0 ? remainder + n : remainder;
}

/**
 * Time-integrated polygonal blockage of the flat periodic grid. Geometry is
 * local to the grid corner. The same polygon defines storage and face apertures.
 */
export function blockageGeometry(
  grid: BlockageGrid,
  shape: Pick<BlockageFootprint, 'vertices' | 'low' | 'high'>,
  start: Point,
  end: Point,
): CylinderGeometry {
  const { vertices: footprint, low: lower, high: upper } = shape;
  const { nx, nz, dx, dz } = grid;
  const travel: Point = [end[0] - start[0], end[1] - start[1]];
  const n = nx * nz;
  const occupiedStart = new Float64Array(n);
  const occupiedEnd = new Float64Array(n);
  const openX = new Float64Array(n).fill(1);
  const openZ = new Float64Array(n).fill(1);
  const walls: CylinderWall[] = [];
  const index = (i: number, j: number) => wrap(i, nx) + nx * wrap(j, nz);
  // Include the fluid-side cell on an exact lower grid face.
  const minX = Math.ceil((Math.min(start[0], end[0]) + lower[0]) / dx) - 1;
  const maxX = Math.floor((Math.max(start[0], end[0]) + upper[0]) / dx);
  const minZ = Math.ceil((Math.min(start[1], end[1]) + lower[1]) / dz) - 1;
  const maxZ = Math.floor((Math.max(start[1], end[1]) + upper[1]) / dz);
  for (let j = minZ; j <= maxZ; j++) {
    for (let i = minX; i <= maxX; i++) {
      const cell = index(i, j);
      const low: Point = [i * dx, j * dz];
      const high: Point = [(i + 1) * dx, (j + 1) * dz];
      openX[cell] = 1 - blockedFace(footprint, start, travel, low, [0, dz]);
      openZ[cell] = 1 - blockedFace(footprint, start, travel, low, [dx, 0]);
      occupiedStart[cell] = occupiedArea(footprint, start, low, high) / (dx * dz);
      occupiedEnd[cell] = occupiedArea(footprint, end, low, high) / (dx * dz);
      let a = footprint.at(-1)!;
      for (const b of footprint) {
        const edge: Point = [b[0] - a[0], b[1] - a[1]];
        const base: Point = [start[0] + a[0], start[1] + a[1]];
        const clipped = wallInCell(base, travel, edge, low, high);
        const { area, fraction } = measures(clipped);
        if (area > 0) {
          const [x, z] = edge;
          const length = Math.sqrt(x * x + z * z);
          walls.push({
            cell,
            normal: [-z * area, x * area],
            inward: [-z / length, x / length],
            centre: [a[0] + fraction * x, a[1] + fraction * z],
          });
        }
        a = b;
      }
    }
  }
  return { occupiedStart, occupiedEnd, openX, openZ, walls };
}

export function cylinderGeometry(
  grid: BlockageGrid,
  vertices: readonly Point[],
  radius: number,
  start: Point,
  end: Point,
): CylinderGeometry {
  return blockageGeometry(grid, { vertices, low: [-radius, -radius], high: [radius, radius] }, start, end);
}

/**
 * Hydrostatic pressure integral at a moving piston, over density. The
 * solid-normal relative velocity is positive into the solid. Causon,
 * Ingram and Mingham (2001), Eqs. 15–23, with the vacuum branch.
 */
export function cylinderPistonDepth(depth: number, normalVelocity: number, g: number): number {
  if (depth <= 0) return 0;
  const c = Math.sqrt(g * depth);
  if (normalVelocity <= 0) {
    const star = Math.max(0, 1 + (0.5 * normalVelocity) / c);
    return depth * star * star;
  }
  const ratio = normalVelocity / c;
  let lower = 1 + ratio;
  let upper = 1 + Math.SQRT2 * ratio;
  for (let i = 0; i < 45; i++) {
    const q = 0.5 * (lower + upper);
    if ((q - 1) * Math.sqrt((q + 1) / (2 * q)) < ratio) lower = q;
    else upper = q;
  }
  return 0.5 * (lower + upper) * depth;
}
