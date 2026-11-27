import { invalidLoad } from './errors.js';

/** Fixed still-water geometry. The layer closest to the surface comes first. */
export interface QuayPotentialGrid {
  readonly cells: readonly [number, number];
  readonly cellSize: number;
  /** Layer faces in metres below the surface, starting at zero. */
  readonly depths: readonly number[];
  /** One entry per cell, X then Z then depth. Zero excludes a solid cell. Omit for an entirely wet volume. */
  readonly wet?: ArrayLike<number>;
  /** Open fraction toward +X at each cell. Faces at the grid edge are always closed. Default 1. */
  readonly openX?: ArrayLike<number>;
  /** Open fraction toward +Z at each cell. Faces at the grid edge are always closed. Default 1. */
  readonly openZ?: ArrayLike<number>;
}

/** Finite-volume harmonic extension for a fixed, impermeable quay in a linear free surface. */
export class QuayPotential {
  readonly surfaceCells: number;
  readonly volumeCells: number;
  private readonly cellArea: number;
  private readonly topDistance: number;
  private readonly wet: Uint8Array;
  private readonly diagonal: Float64Array;
  private readonly columnInverse: Float64Array;
  private readonly east: Float64Array;
  private readonly north: Float64Array;
  private readonly down: Float64Array;
  private readonly potential: Float64Array;
  private readonly residual: Float64Array;
  private readonly direction: Float64Array;
  private readonly applied: Float64Array;

  constructor(grid: QuayPotentialGrid) {
    const { cells, cellSize, depths, wet, openX, openZ } = grid ?? {};
    if (
      cells?.length !== 2 ||
      cells.some((count) => !Number.isSafeInteger(count) || count < 1) ||
      !(cellSize > 0 && cellSize * cellSize > 0 && Number.isFinite(cellSize * cellSize)) ||
      depths?.length < 2 ||
      depths?.[0] !== 0 ||
      depths.some((depth, index) => !Number.isFinite(depth) || (index !== 0 && depth <= depths[index - 1]!))
    )
      throw invalidLoad('Use positive grid dimensions and spacing, and increasing depth faces starting at zero.');
    const [nx, nz] = cells;
    const plane = nx * nz;
    const layers = depths.length - 1;
    const count = plane * layers;
    if (!Number.isSafeInteger(count) || count > 0x1fffffff || [wet, openX, openZ].some((v) => v && v.length !== count))
      throw invalidLoad('Supply one mask and face fraction per volume cell and a grid within the array size limit.');
    this.surfaceCells = plane;
    this.volumeCells = count;
    this.cellArea = cellSize * cellSize;
    this.topDistance = depths[1]! / 2;
    this.wet = new Uint8Array(count);
    this.diagonal = new Float64Array(count);
    this.columnInverse = new Float64Array(count);
    this.east = new Float64Array(count);
    this.north = new Float64Array(count);
    this.down = new Float64Array(count);
    this.potential = new Float64Array(count);
    this.residual = new Float64Array(count);
    this.direction = new Float64Array(count);
    this.applied = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const wetValue = wet?.[i] ?? 1;
      const x = openX?.[i] ?? 1;
      const z = openZ?.[i] ?? 1;
      if ((wetValue !== 0 && wetValue !== 1) || !(x >= 0 && x <= 1 && z >= 0 && z <= 1))
        throw invalidLoad('Use zero or one for each cell and a fraction in [0, 1] for each horizontal opening.');
      this.wet[i] = wetValue;
    }
    for (let y = 0; y < layers; y++) {
      const thickness = depths[y + 1]! - depths[y]!;
      const vertical = y + 1 < layers ? (2 * this.cellArea) / (depths[y + 2]! - depths[y]!) : 0;
      if (!Number.isFinite(vertical) || (y === 0 && !Number.isFinite(this.cellArea / this.topDistance)))
        throw invalidLoad('Choose layer thicknesses that give finite face conductances.');
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          const i = x + nx * z + plane * y;
          if (!this.wet[i]) continue;
          if (x + 1 < nx && this.wet[i + 1]) this.east[i] = thickness * (openX?.[i] ?? 1);
          if (z + 1 < nz && this.wet[i + nx]) this.north[i] = thickness * (openZ?.[i] ?? 1);
          if (y + 1 < layers && this.wet[i + plane]) this.down[i] = vertical;
          this.diagonal[i]! += this.east[i]! + this.north[i]! + this.down[i]!;
          if (this.east[i]) this.diagonal[i + 1]! += this.east[i]!;
          if (this.north[i]) this.diagonal[i + nx]! += this.north[i]!;
          if (this.down[i]) this.diagonal[i + plane]! += this.down[i]!;
        }
    }
    this.nx = nx;
    this.iterationLimit = 8 * (nx + nz + layers) + 64;
    this.requireSurfaceConnection();
  }

  private readonly nx: number;
  private readonly iterationLimit: number;

  private requireSurfaceConnection(): void {
    const { volumeCells: n, surfaceCells: plane, wet, east, north, down, nx } = this;
    const queued = new Uint8Array(n);
    const frontier = new Uint32Array(n);
    let end = 0;
    const enqueue = (i: number) => {
      if (queued[i]) return;
      queued[i] = 1;
      frontier[end++] = i;
    };
    for (let i = 0; i < plane; i++) if (wet[i]) enqueue(i);
    if (end === 0) throw invalidLoad('Leave at least one free-surface cell open to the water.');
    for (let start = 0; start < end; start++) {
      const i = frontier[start]!;
      if (east[i]) enqueue(i + 1);
      if (east[i - 1]) enqueue(i - 1);
      if (north[i]) enqueue(i + nx);
      if (north[i - nx]) enqueue(i - nx);
      if (down[i]) enqueue(i + plane);
      if (down[i - plane]) enqueue(i - plane);
    }
    for (let i = 0; i < n; i++)
      if (wet[i] && !queued[i])
        throw invalidLoad('Connect every wet pocket to the free surface or exclude it from the wave domain.');
  }

  /** Solve for the upward derivative of the potential. For potential in m²/s, give bulk fluxes in m³/s.
   * A time-integrated potential uses volume impulses in m³. A positive source displaces water upward.
   * `surfaceLength` adds the Robin length for an implicit free-surface stage. Zero prescribes the surface potential.
   */
  project(
    surface: Float64Array,
    out: Float64Array,
    source?: Float64Array,
    surfaceLength = 0,
    bulk?: Float64Array,
  ): number {
    const {
      volumeCells: n,
      surfaceCells: plane,
      cellArea,
      topDistance,
      wet,
      potential,
      residual,
      direction,
      applied,
    } = this;
    if (
      surface.length !== plane ||
      out.length !== plane ||
      (source && source.length !== n) ||
      (bulk && bulk.length !== n) ||
      !(Number.isFinite(surfaceLength) && surfaceLength >= 0) ||
      surface.some((value) => !Number.isFinite(value)) ||
      source?.some((value, i) => !Number.isFinite(value) || (!wet[i] && value !== 0))
    )
      throw invalidLoad('Use finite surface values and put each finite volume source inside a wet cell.');
    const face = cellArea / (topDistance + surfaceLength);
    if (!(face > 0 && Number.isFinite(face))) throw invalidLoad('Use a finite positive surface conductance.');
    this.factorColumns(face);
    potential.fill(0);
    for (let i = 0; i < n; i++) {
      const top = i < plane && wet[i] ? face : 0;
      const rhs = (top ? top * surface[i]! : 0) - (source?.[i] ?? 0);
      residual[i] = rhs;
    }
    let energyResidual = this.precondition(residual, direction);
    const threshold = energyResidual * 1e-24;
    if (!Number.isFinite(energyResidual)) throw invalidLoad('Scale the inputs to a finite potential solve.');
    let iterations = 0;
    for (; energyResidual > threshold && iterations < this.iterationLimit; iterations++) {
      const curvature = this.multiply(direction, applied, face);
      if (!(curvature > 0 && Number.isFinite(curvature)))
        throw invalidLoad('Check that the wet geometry and face fractions form a connected potential solve.');
      const stride = energyResidual / curvature;
      for (let i = 0; i < n; i++) {
        potential[i]! += stride * direction[i]!;
        residual[i]! -= stride * applied[i]!;
      }
      const next = this.precondition(residual, applied);
      const ratio = next / energyResidual;
      for (let i = 0; i < n; i++) direction[i] = applied[i]! + ratio * direction[i]!;
      energyResidual = next;
    }
    if (!(energyResidual <= threshold))
      throw invalidLoad(
        'The quay potential did not converge. Use a better-conditioned grid and consistent open faces.',
      );
    for (let i = 0; i < plane; i++) out[i] = wet[i] ? (surface[i]! - potential[i]!) / (topDistance + surfaceLength) : 0;
    bulk?.set(potential);
    return iterations;
  }

  // A block Jacobi preconditioner solves each vertical column exactly. Thin surface layers then
  // do not force the horizontal search to resolve their large vertical conductance on every step.
  private factorColumns(top: number): void {
    const { down, wet, diagonal, columnInverse: inverse, surfaceCells: plane } = this;
    for (let i = 0; i < inverse.length; i++) {
      if (!wet[i]) continue;
      const upper = i < plane ? 0 : down[i - plane]!;
      const eliminated = upper === 0 ? 0 : upper * upper * inverse[i - plane]!;
      const factor = 1 / (diagonal[i]! + (i < plane ? top : 0) - eliminated);
      if (!(factor > 0 && Number.isFinite(factor)))
        throw invalidLoad('Use spaced, connected layers so the quay’s vertical columns can be factored.');
      inverse[i] = factor;
    }
  }

  private precondition(rhs: Float64Array, out: Float64Array): number {
    const { down, columnInverse: inverse, surfaceCells: plane } = this;
    for (let i = 0; i < out.length; i++) {
      const upper = i < plane ? 0 : down[i - plane]!;
      out[i] = rhs[i]! + (upper === 0 ? 0 : upper * inverse[i - plane]! * out[i - plane]!);
    }
    let norm = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      out[i] = inverse[i]! * (out[i]! + (down[i] ? down[i]! * out[i + plane]! : 0));
      norm += rhs[i]! * out[i]!;
    }
    return norm;
  }

  private multiply(u: Float64Array, out: Float64Array, top: number): number {
    const { surfaceCells: plane, volumeCells: n, nx, wet, east, north, down } = this;
    out.fill(0);
    let work = 0;
    for (let i = 0; i < n; i++) {
      const value = u[i]!;
      if (east[i]) {
        const difference = value - u[i + 1]!;
        const flux = east[i]! * difference;
        out[i]! += flux;
        out[i + 1]! -= flux;
        work += flux * difference;
      }
      if (north[i]) {
        const difference = value - u[i + nx]!;
        const flux = north[i]! * difference;
        out[i]! += flux;
        out[i + nx]! -= flux;
        work += flux * difference;
      }
      if (down[i]) {
        const difference = value - u[i + plane]!;
        const flux = down[i]! * difference;
        out[i]! += flux;
        out[i + plane]! -= flux;
        work += flux * difference;
      }
      if (i < plane && wet[i]) {
        out[i]! += top * value;
        work += top * value * value;
      }
    }
    return work;
  }

  /** Whether the volume cell is wet. Out-of-grid indices are dry. */
  wetCell(index: number): boolean {
    return this.wet[index] === 1;
  }

  /** A straight horizontal transfer between a source and a cell's centre must stay on open faces. */
  reaches(x: number, z: number, toX: number, toZ: number, offset: number): boolean {
    const nz = this.surfaceCells / this.nx;
    if (
      !(x >= 0 && x < this.nx && z >= 0 && z < nz) ||
      !Number.isInteger(toX) ||
      !Number.isInteger(toZ) ||
      toX < 0 ||
      toX >= this.nx ||
      toZ < 0 ||
      toZ >= nz ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset >= this.volumeCells ||
      offset % this.surfaceCells !== 0
    )
      return false;
    let i = Math.floor(x),
      j = Math.floor(z);
    if (!this.wetCell(offset + i + j * this.nx)) return false;
    const dx = toX + 0.5 - x,
      dz = toZ + 0.5 - z;
    const sx = Math.sign(dx),
      sz = Math.sign(dz);
    const stepX = 1 / Math.abs(dx),
      stepZ = 1 / Math.abs(dz);
    let hitX = sx === 0 ? Infinity : (i + (sx > 0 ? 1 : 0) - x) / dx;
    let hitZ = sz === 0 ? Infinity : (j + (sz > 0 ? 1 : 0) - z) / dz;
    while (i !== toX || j !== toZ) {
      const at = offset + i + j * this.nx;
      if (hitX <= hitZ) {
        if (!this.east[at - (sx < 0 ? 1 : 0)]) return false;
        i += sx;
        hitX += stepX;
      } else {
        if (!this.north[at - (sz < 0 ? this.nx : 0)]) return false;
        j += sz;
        hitZ += stepZ;
      }
    }
    return true;
  }

  /** Volume flux toward the next cell on the chosen axis from a solved potential. */
  faceFlux(axis: 'x' | 'z' | 'down', index: number, bulk = this.potential): number {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.volumeCells ||
      (axis !== 'x' && axis !== 'z' && axis !== 'down') ||
      bulk.length !== this.volumeCells
    )
      throw invalidLoad('Query a face on a valid volume cell.');
    const [faces, offset] =
      axis === 'x' ? [this.east, 1] : axis === 'z' ? [this.north, this.nx] : [this.down, this.surfaceCells];
    return faces[index] ? faces[index]! * (bulk[index + offset]! - bulk[index]!) : 0;
  }
}
