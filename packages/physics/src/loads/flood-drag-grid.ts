import type { Bed } from '@margoengine/math/fields';
import { FORCING_WORDS, SURFACE_WATER_LAYOUT, WATER_DENSITY } from '../hydro/fields.js';
import { DRY } from '../hydro/shallow.js';
import type { Cell, Port, SolverHost } from '../world/solver.js';
import { invalidLoad } from './errors.js';

export interface FloodDragGridParams {
  /** The identical bed and grid used by ShallowWaterSolver, without raised building cells at the exchange sites. */
  readonly bed: Bed;
  /** Water density, in kg/m³. Match ShallowWaterSolver. Defaults to 1000. */
  readonly density?: number;
  /** Metres per origin cell. Match PhysicsWorld. Defaults to 4096. */
  readonly cellSize?: number;
}

export type PeriodicDragAxes = readonly [x: boolean, z: boolean];

interface AxisSample {
  readonly index: number;
  readonly position: number;
  readonly weight: number;
}

function axisSamples(point: number, start: number, spacing: number, count: number, periodic: boolean): AxisSample[] {
  const coordinate = (point - start) / spacing;
  if (!periodic && !(coordinate >= 0 && coordinate < count)) return [];
  if (!Number.isFinite(coordinate)) return [];
  // Both images of a one-cell periodic axis refer to the same fluid mass.
  // Their weighted first moment is the query point, so combine them here.
  if (periodic && count === 1) return [{ index: 0, position: point, weight: 1 }];
  const offset = periodic ? coordinate - 0.5 : Math.max(0, Math.min(count - 1, coordinate - 0.5));
  const first = Math.floor(offset);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(first + 1))
    throw invalidLoad('Keep periodic drag positions within the representable cell range or use a closer origin.');
  const last = periodic ? first + 1 : Math.min(first + 1, count - 1);
  const samples: AxisSample[] = [];
  for (let i = first; i <= last; i++)
    samples.push({
      index: periodic ? ((i % count) + count) % count : i,
      position: start + (i + 0.5) * spacing,
      weight: 1 - Math.abs(offset - i),
    });
  return samples;
}

interface WetCell {
  readonly index: number;
  readonly depth: number;
  readonly wetWeight: number;
  readonly wetCentre: number;
  readonly x: number;
  readonly z: number;
}

export interface DragSample {
  readonly cells: readonly WetCell[];
  readonly wet: number;
  readonly point: [number, number, number];
  readonly inverseMass: number;
  readonly vx: number;
  readonly vz: number;
}

/** Depth-averaged horizontal momentum exchange supported by the existing shallow-water forcing port. */
export class FloodDragGrid {
  readonly count: number;
  readonly cellSize: number;
  readonly density: number;
  readonly cellArea: number;
  private readonly dx: number;
  private readonly dz: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly densityArea: number;
  private readonly bed: Bed;

  constructor({ bed, density = WATER_DENSITY, cellSize = 4096 }: FloodDragGridParams) {
    if (
      !bed ||
      !Number.isSafeInteger(bed.columns) ||
      !Number.isSafeInteger(bed.rows) ||
      !(bed.columns > 0 && bed.rows > 0) ||
      !(bed.width > 0 && bed.depth > 0 && Number.isFinite(bed.width) && Number.isFinite(bed.depth)) ||
      bed.centre?.length !== 2 ||
      !bed.centre.every(Number.isFinite) ||
      bed.cell?.length !== 3 ||
      !bed.cell.every(Number.isSafeInteger)
    )
      throw invalidLoad('Use the same finite shallow-water bed grid for both water and hydrodynamic drag.');
    if (!(density > 0 && Number.isFinite(density) && Number.isSafeInteger(cellSize) && cellSize > 0))
      throw invalidLoad('Match the positive water density and the physics world cell size.');
    this.bed = bed;
    this.cellSize = cellSize;
    this.density = density;
    this.count = bed.columns * bed.rows;
    this.dx = bed.width / bed.columns;
    this.dz = bed.depth / bed.rows;
    this.cellArea = this.dx * this.dz;
    this.x0 = bed.centre[0] - bed.width / 2;
    this.z0 = bed.centre[1] - bed.depth / 2;
    this.densityArea = density * this.dx * this.dz;
    if (!Number.isSafeInteger(this.count) || !(this.densityArea > 0 && Number.isFinite(this.densityArea)))
      throw invalidLoad('Choose a shallow-water grid and density whose cell measures fit finite SI values.');
  }

  read(host: SolverHost, port: Port | undefined, previousTick: number): Float32Array {
    const region = port?.region;
    if (
      !region ||
      region.type !== 'f32' ||
      region.layout !== SURFACE_WATER_LAYOUT ||
      region.byteLength !== this.count * 3 * 4
    )
      throw invalidLoad('Use the matching live ShallowWaterSolver surface-water field.');
    if (port?.tick !== previousTick)
      throw invalidLoad('Match the flood and drag rate levels and stagger the drag exchange before shallow water.');
    if (!port.cell.every((cell, axis) => cell === this.bed.cell[axis]))
      throw invalidLoad('Use the same origin cell for the shallow-water solver and its supplied bed.');
    return new Float32Array((region.memory ?? host.memory).buffer, region.byteOffset, this.count * 3);
  }

  /** Convert a point between the position port and the bed's origin. No view over the bed is saved. */
  point(point: ArrayLike<number>, from: Cell, to: Cell = this.bed.cell): [number, number, number] {
    return [
      point[0]! + (from[0] - to[0]) * this.cellSize,
      point[1]! + (from[1] - to[1]) * this.cellSize,
      point[2]! + (from[2] - to[2]) * this.cellSize,
    ];
  }

  fromBed(point: ArrayLike<number>, to: Cell): [number, number, number] {
    return this.point(point, this.bed.cell, to);
  }

  sample(
    water: Float32Array | Float64Array,
    forcing: Float64Array | undefined,
    point: readonly [number, number, number],
    halfHeight: number,
    dt: number,
    bottomAt?: Float64Array,
    periodic?: PeriodicDragAxes,
  ): DragSample | undefined {
    const [x, y, z] = point;
    const nx = this.bed.columns;
    const nz = this.bed.rows;
    const across = axisSamples(x, this.x0, this.dx, nx, periodic?.[0] ?? false);
    const along = axisSamples(z, this.z0, this.dz, nz, periodic?.[1] ?? false);
    const cells: WetCell[] = [];
    const elevations = this.bed.elevations;
    const stride = nz + 1;
    let wet = 0;
    for (const { index: j, position: sampleZ, weight: weightZ } of along)
      for (const { index: i, position: sampleX, weight: weightX } of across) {
        const weight = weightX * weightZ;
        const index = i + nx * j;
        const depth = water[3 * index]!;
        if (!(weight > 0 && depth > DRY)) continue;
        const at = i * stride + j;
        // Same volume-equivalent average of the two triangles as ShallowWaterSolver's unblocked bed.
        const bottom =
          bottomAt?.[index] ??
          (elevations[at]! + elevations[at + stride + 1]! + 2 * (elevations[at + 1]! + elevations[at + stride]!)) / 6;
        const lower = Math.max(y - halfHeight, bottom);
        const upper = Math.min(y + halfHeight, bottom + depth);
        if (!(upper > lower)) continue;
        const wetWeight = (weight * (upper - lower)) / (2 * halfHeight);
        wet += wetWeight;
        cells.push({
          index,
          depth,
          wetWeight,
          wetCentre: (upper + lower) / 2,
          x: sampleX,
          z: sampleZ,
        });
      }
    if (!(wet > 0)) return undefined;
    let xWet = 0;
    let yWet = 0;
    let zWet = 0;
    let vx = 0;
    let vz = 0;
    let inverseMass = 0;
    for (const cell of cells) {
      const { index, depth } = cell;
      const share = cell.wetWeight / wet;
      xWet += share * cell.x;
      yWet += share * cell.wetCentre;
      zWet += share * cell.z;
      const offset = FORCING_WORDS * index;
      vx += (share * (water[3 * index + 1]! + dt * (forcing?.[offset] ?? 0))) / depth;
      vz += (share * (water[3 * index + 2]! + dt * (forcing?.[offset + 1] ?? 0))) / depth;
      inverseMass += (share * share) / (this.densityArea * depth);
    }
    return { cells, wet, point: [xWet, yWet, zWet], vx, vz, inverseMass };
  }

  /** Stage the negative of the body's horizontal impulse as a discharge rate over this step. */
  react(forcing: Float64Array, sample: DragSample, x: number, z: number, dt: number): void {
    for (const { index, wetWeight } of sample.cells) {
      const scale = wetWeight / (sample.wet * this.densityArea * dt);
      const at = FORCING_WORDS * index;
      forcing[at]! -= scale * x;
      forcing[at + 1]! -= scale * z;
      if (!Number.isFinite(forcing[at]) || !Number.isFinite(forcing[at + 1]))
        throw invalidLoad('Choose water depth, step duration and body drag whose discharge rates are finite.');
    }
  }

  /** Apply the paired horizontal reaction to the finalized water without changing its depth. */
  applyReaction(water: Float64Array, forcing: Float64Array, dt: number): void {
    for (let index = 0; index < this.count; index++) {
      const source = index * FORCING_WORDS;
      const target = index * 3;
      const x = forcing[source]!;
      const z = forcing[source + 1]!;
      if (x !== 0) water[target + 1]! += dt * x;
      if (z !== 0) water[target + 2]! += dt * z;
    }
  }
}

/** Implicit quadratic drag between two finite mobilities. Force at the end of the exchange never reverses the slip. */
export function floodDragImpulse(slip: number, inverseMass: number, coefficient: number, dt: number): number {
  const speed = Math.abs(slip);
  const resistance = 4 * dt * inverseMass * coefficient * speed;
  const end = (2 * speed) / (1 + Math.sqrt(1 + resistance));
  const impulse = dt * coefficient * end * end * Math.sign(slip);
  if (!Number.isFinite(impulse) || !Number.isFinite(resistance))
    throw invalidLoad('Choose finite body geometry, water velocities and inertia within the drag exchange range.');
  return impulse;
}
