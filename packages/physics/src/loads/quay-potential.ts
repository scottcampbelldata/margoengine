import { invalidLoad } from './errors.js';
import { QuayCoarseCorrection, QUAY_SWEEP } from './quay-multigrid.js';

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
  /** Horizontal dispersion order on open, uniform layers. Default 2. */
  readonly horizontalOrder?: 2 | 4 | 8;
}

// A horizontal layer's graph Laplacian L has the same open-face boundaries as its gradient.
function axisDifference(u: Float64Array, faces: Float64Array, i: number, stride: number): number {
  const value = u[i]!;
  const left = faces[i - stride],
    right = faces[i];
  return (left ? left * (value - u[i - stride]!) : 0) + (right ? right * (value - u[i + stride]!) : 0);
}

function correctedGradient(u: Float64Array, faces: Float64Array, i: number, stride: number, scale: number): number {
  const j = i + stride;
  return u[i]! - u[j]! + scale * (axisDifference(u, faces, i, stride) - axisDifference(u, faces, j, stride));
}

function baseFlux(u: Float64Array, faces: Float64Array, i: number, stride: number): number {
  return faces[i] ? faces[i]! * (u[i]! - u[i + stride]!) : 0;
}

function fluxCorrection(
  base: number,
  left: number,
  middle: number,
  right: number,
  opening: number,
  factor: number,
): number {
  return opening ? base + opening * factor * (2 * middle - left - right) : 0;
}

// Write L = Dᵀ W D, with D the nearest-face difference and W the opening.
// The eighth-order symbol is L + L²/12 + L³/90 + L⁴/560 on a uniform layer.
// Apply the polynomial on faces so that a closed face never carries flux.
function eighthOrderFlux(
  u: Float64Array,
  faces: Float64Array,
  i: number,
  stride: number,
  inverseThickness: number,
): number {
  const left = i - stride,
    right = i + stride,
    farLeft = left - stride,
    farRight = right + stride;
  const leftOpen = (faces[left] ?? 0) * inverseThickness,
    centreOpen = faces[i]! * inverseThickness,
    rightOpen = (faces[right] ?? 0) * inverseThickness;
  const leftBase = baseFlux(u, faces, left, stride),
    centreBase = baseFlux(u, faces, i, stride),
    rightBase = baseFlux(u, faces, right, stride),
    farLeftBase = baseFlux(u, faces, farLeft, stride),
    farRightBase = baseFlux(u, faces, farRight, stride);
  // Horner factors are the ratios of consecutive coefficients.
  const first = 1 / 12,
    second = 1 / 90 / first,
    third = 1 / 560 / (1 / 90);
  const outerLeft = fluxCorrection(
    farLeftBase,
    baseFlux(u, faces, farLeft - stride, stride),
    farLeftBase,
    leftBase,
    (faces[farLeft] ?? 0) * inverseThickness,
    third,
  );
  const innerLeft = fluxCorrection(leftBase, farLeftBase, leftBase, centreBase, leftOpen, third);
  const centre = fluxCorrection(centreBase, leftBase, centreBase, rightBase, centreOpen, third);
  const innerRight = fluxCorrection(rightBase, centreBase, rightBase, farRightBase, rightOpen, third);
  const outerRight = fluxCorrection(
    farRightBase,
    rightBase,
    farRightBase,
    baseFlux(u, faces, farRight + stride, stride),
    (faces[farRight] ?? 0) * inverseThickness,
    third,
  );
  return fluxCorrection(
    centreBase,
    fluxCorrection(leftBase, outerLeft, innerLeft, centre, leftOpen, second),
    fluxCorrection(centreBase, innerLeft, centre, innerRight, centreOpen, second),
    fluxCorrection(rightBase, centre, innerRight, outerRight, rightOpen, second),
    centreOpen,
    first,
  );
}

/** Finite-volume harmonic extension for a fixed, impermeable quay in a linear free surface. */
export class QuayPotential {
  readonly surfaceCells: number;
  readonly volumeCells: number;
  private readonly cellArea: number;
  private readonly topDistance: number;
  private readonly wet: Uint8Array;
  private readonly active?: Uint32Array;
  private readonly diagonal: Float64Array;
  private readonly columnInverse: Float64Array;
  private readonly east: Float64Array;
  private readonly north: Float64Array;
  private readonly down: Float64Array;
  private readonly potential: Float64Array;
  private readonly residual: Float64Array;
  private readonly direction: Float64Array;
  private readonly applied: Float64Array;
  private readonly coarse?: QuayCoarseCorrection;
  private readonly coarseWork?: Float64Array;
  private readonly horizontalCorrection?: Float64Array;
  private readonly eighthOrder: boolean;
  private readonly basinOf?: Uint32Array;
  private readonly basinSurfaceCount: readonly number[];
  private readonly basinCorrection: Float64Array;
  private readonly basinSumError: Float64Array;

  constructor(grid: QuayPotentialGrid) {
    const { cells, cellSize, depths, wet, openX, openZ, horizontalOrder = 2 } = grid ?? {};
    if (horizontalOrder !== 2 && horizontalOrder !== 4 && horizontalOrder !== 8)
      throw invalidLoad('Set horizontalOrder to 2, 4 or 8 for the finite quay.');
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
    this.eighthOrder = horizontalOrder === 8;
    if (horizontalOrder !== 2) this.horizontalCorrection = new Float64Array(layers);
    this.diagonal = new Float64Array(count);
    this.columnInverse = new Float64Array(count);
    this.east = new Float64Array(count);
    this.north = new Float64Array(count);
    this.down = new Float64Array(count);
    this.potential = new Float64Array(count);
    this.residual = new Float64Array(count);
    this.direction = new Float64Array(count);
    this.applied = new Float64Array(count);
    let wetCount = 0;
    for (let i = 0; i < count; i++) {
      const wetValue = wet?.[i] ?? 1;
      const x = openX?.[i] ?? 1;
      const z = openZ?.[i] ?? 1;
      if ((wetValue !== 0 && wetValue !== 1) || !(x >= 0 && x <= 1 && z >= 0 && z <= 1))
        throw invalidLoad('Use zero or one for each cell and a fraction in [0, 1] for each horizontal opening.');
      this.wet[i] = wetValue;
      wetCount += wetValue;
    }
    // Dense slots and face order remain authoritative. Skip zero rows on substantially dry grids.
    if (wetCount * 2 <= count) {
      const active = new Uint32Array(wetCount);
      let next = 0;
      for (let i = 0; i < count; i++) if (this.wet[i]) active[next++] = i;
      this.active = active;
    }
    for (let y = 0; y < layers; y++) {
      const thickness = depths[y + 1]! - depths[y]!;
      if (this.horizontalCorrection) {
        const scale = (this.eighthOrder ? 1 : 1 / 12) / thickness;
        if (!(scale > 0 && Number.isFinite(scale)))
          throw invalidLoad('Use finite layer thicknesses for high-order horizontal flux.');
        this.horizontalCorrection[y] = scale;
      }
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
    const { basinOf, surfaceCounts } = this.connectedBasins();
    this.basinOf = basinOf;
    this.basinSurfaceCount = surfaceCounts;
    this.basinCorrection = new Float64Array(surfaceCounts.length);
    this.basinSumError = new Float64Array(surfaceCounts.length);
    if (count >= 2048 && (nx > 2 || nz > 2)) {
      const curtainX = new Uint8Array(plane),
        curtainZ = new Uint8Array(plane);
      for (let i = 0; i < count; i++) {
        const cell = i % plane;
        if ((cell % nx) + 1 < nx && (this.wet[i] !== this.wet[i + 1] || (openX?.[i] ?? 1) < 1)) curtainX[cell] = 1;
        if (cell + nx < plane && (this.wet[i] !== this.wet[i + nx] || (openZ?.[i] ?? 1) < 1)) curtainZ[cell] = 1;
      }
      this.coarse = new QuayCoarseCorrection({
        size: count,
        nx,
        nz,
        coordinate: (i) => (this.wet[i] ? i : -1),
        anchors: (i) => (i < plane ? 1 : 0),
        faces: (visit) => {
          for (let i = 0; i < count; i++) {
            if (!this.wet[i]) continue;
            const cell = i % plane,
              east = this.east[i]!,
              north = this.north[i]!,
              down = this.down[i]!;
            const fenceX = curtainX[cell] !== 0,
              fenceZ = curtainZ[cell] !== 0;
            if (east || (fenceX && this.wet[i + 1])) visit(i, i + 1, east, fenceX);
            if (north || (fenceZ && this.wet[i + nx])) visit(i, i + nx, north, fenceZ);
            if (down) visit(i, i + plane, down, false);
          }
        },
      });
      this.coarseWork = new Float64Array(count);
    }
  }

  private readonly nx: number;
  private readonly iterationLimit: number;

  private connectedBasins(): { basinOf?: Uint32Array; surfaceCounts: number[] } {
    const { volumeCells: n, surfaceCells: plane, wet, east, north, down, nx } = this;
    const queued = new Uint8Array(n);
    const frontier = new Uint32Array(n);
    const surfaceCounts: number[] = [];
    let basinOf: Uint32Array | undefined;
    let basin = -1;
    let end = 0;
    const enqueue = (i: number) => {
      if (queued[i]) return;
      queued[i] = 1;
      frontier[end++] = i;
      if (basinOf) basinOf[i] = basin;
      if (i < plane) surfaceCounts[basin]!++;
    };
    for (let seed = 0; seed < plane; seed++) {
      if (!wet[seed] || queued[seed]) continue;
      if (++basin === 1) basinOf = new Uint32Array(n);
      surfaceCounts.push(0);
      const begin = end;
      enqueue(seed);
      for (let start = begin; start < end; start++) {
        const i = frontier[start]!;
        if (east[i]) enqueue(i + 1);
        if (east[i - 1]) enqueue(i - 1);
        if (north[i]) enqueue(i + nx);
        if (north[i - nx]) enqueue(i - nx);
        if (down[i]) enqueue(i + plane);
        if (down[i - plane]) enqueue(i - plane);
      }
    }
    if (end === 0) throw invalidLoad('Leave at least one free-surface cell open to the water.');
    for (let i = 0; i < n; i++)
      if (wet[i] && !queued[i])
        throw invalidLoad('Connect every wet pocket to the free surface or exclude it from the wave domain.');
    return { basinOf, surfaceCounts };
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
      active,
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
    this.coarse?.prepare(face);
    this.clearWet(potential);
    const visits = active?.length ?? n;
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
      const top = i < plane && wet[i] ? face : 0;
      const rhs = (top ? top * surface[i]! : 0) - (source?.[i] ?? 0);
      residual[i] = rhs;
    }
    let columnResidual = this.precondition(residual, direction);
    const threshold = columnResidual * 1e-24;
    if (!Number.isFinite(columnResidual)) throw invalidLoad('Scale the inputs to a finite potential solve.');
    let energyResidual = this.coarsePrecondition(residual, direction, face, columnResidual);
    let iterations = 0;
    for (; columnResidual > threshold && iterations < this.iterationLimit; iterations++) {
      const curvature = this.multiply(direction, applied, face);
      if (!(curvature > 0 && Number.isFinite(curvature)))
        throw invalidLoad('Check that the wet geometry and face fractions form a connected potential solve.');
      const stride = energyResidual / curvature;
      for (let at = 0; at < visits; at++) {
        const i = active ? active[at]! : at;
        potential[i]! += stride * direction[i]!;
        residual[i]! -= stride * applied[i]!;
      }
      columnResidual = this.precondition(residual, applied);
      const next = this.coarsePrecondition(residual, applied, face, columnResidual);
      const ratio = next / energyResidual;
      for (let at = 0; at < visits; at++) {
        const i = active ? active[at]! : at;
        direction[i] = applied[i]! + ratio * direction[i]!;
      }
      energyResidual = next;
    }
    if (!(columnResidual <= threshold))
      throw invalidLoad(
        'The quay potential did not converge. Use a better-conditioned grid and consistent open faces.',
      );
    this.balanceSurfaceMean(surface, out, source, topDistance + surfaceLength, face);
    bulk?.set(potential);
    return iterations;
  }

  private balanceSurfaceMean(
    surface: Float64Array,
    out: Float64Array,
    source: Float64Array | undefined,
    distance: number,
    face: number,
  ): void {
    const {
      active,
      basinOf,
      wet,
      potential,
      basinSurfaceCount,
      basinCorrection: correction,
      basinSumError: error,
      surfaceCells: plane,
    } = this;
    correction.fill(0);
    error.fill(0);
    const add = (basin: number, term: number) => {
      const value = term - error[basin]!;
      const previous = correction[basin]!;
      const next = previous + value;
      error[basin] = next - previous - value;
      correction[basin] = next;
    };
    const visits = active?.length ?? potential.length;
    if (source) {
      for (let at = 0; at < visits; at++) {
        const i = active ? active[at]! : at;
        if (source[i]) add(basinOf?.[i] ?? 0, -source[i]! / face);
      }
    }
    for (let i = 0; i < plane; i++) {
      const difference = wet[i] ? surface[i]! - potential[i]! : 0;
      out[i] = difference;
      if (wet[i]) add(basinOf?.[i] ?? 0, difference);
    }
    // Summing a basin cancels its internal faces. Solve the remaining uniform potential mode
    // exactly from the Robin volume balance after the iterative relative-gradient solve.
    for (let basin = 0; basin < basinSurfaceCount.length; basin++) correction[basin]! /= basinSurfaceCount[basin]!;
    for (let i = 0; i < plane; i++) if (wet[i]) out[i] = (out[i]! - correction[basinOf?.[i] ?? 0]!) / distance;
    if (correction.some((value) => value !== 0)) {
      for (let at = 0; at < visits; at++) {
        const i = active ? active[at]! : at;
        if (wet[i]) potential[i]! += correction[basinOf?.[i] ?? 0]!;
      }
    }
  }

  private clearWet(out: Float64Array): void {
    const { active } = this;
    if (!active) out.fill(0);
    else for (let at = 0; at < active.length; at++) out[active[at]!] = 0;
  }

  // A block Jacobi preconditioner solves each vertical column exactly. Thin surface layers then
  // do not force the horizontal search to resolve their large vertical conductance on every step.
  private factorColumns(top: number): void {
    const { down, wet, active, diagonal, columnInverse: inverse, surfaceCells: plane } = this;
    const visits = active?.length ?? inverse.length;
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
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
    const { down, active, columnInverse: inverse, surfaceCells: plane } = this;
    const visits = active?.length ?? out.length;
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
      const upper = i < plane ? 0 : down[i - plane]!;
      out[i] = rhs[i]! + (upper === 0 ? 0 : upper * inverse[i - plane]! * out[i - plane]!);
    }
    let norm = 0;
    for (let at = visits - 1; at >= 0; at--) {
      const i = active ? active[at]! : at;
      out[i] = inverse[i]! * (out[i]! + (down[i] ? down[i]! * out[i + plane]! : 0));
      norm += rhs[i]! * out[i]!;
    }
    return norm;
  }

  private coarsePrecondition(rhs: Float64Array, out: Float64Array, top: number, columnNorm: number): number {
    const { coarse, coarseWork: work, active } = this;
    if (!coarse || columnNorm === 0) return columnNorm;
    const visits = active?.length ?? out.length;
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
      out[i]! *= QUAY_SWEEP;
    }
    this.multiply(out, work!, top);
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
      work![i] = rhs[i]! - work![i]!;
    }
    coarse.add(work!, out, active);
    this.multiply(out, work!, top);
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
      work![i] = rhs[i]! - work![i]!;
    }
    this.precondition(work!, work!);
    let norm = 0;
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
      out[i]! += QUAY_SWEEP * work![i]!;
      norm += rhs[i]! * out[i]!;
    }
    return norm;
  }

  private multiply(u: Float64Array, out: Float64Array, top: number): number {
    const { surfaceCells: plane, volumeCells: n, nx, wet, active, east, north, down, horizontalCorrection } = this;
    this.clearWet(out);
    let work = 0;
    const visits = active?.length ?? n;
    for (let at = 0; at < visits; at++) {
      const i = active ? active[at]! : at;
      const value = u[i]!;
      const correction = horizontalCorrection?.[Math.floor(i / plane)];
      if (east[i]) {
        const difference = value - u[i + 1]!;
        const flux = correction ? this.horizontalFlux(u, east, i, 1, correction) : east[i]! * difference;
        out[i]! += flux;
        out[i + 1]! -= flux;
        work += flux * difference;
      }
      if (north[i]) {
        const difference = value - u[i + nx]!;
        const flux = correction ? this.horizontalFlux(u, north, i, nx, correction) : north[i]! * difference;
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

  private horizontalFlux(u: Float64Array, faces: Float64Array, index: number, stride: number, scale: number): number {
    if (this.eighthOrder) return eighthOrderFlux(u, faces, index, stride, scale);
    return faces[index]! * correctedGradient(u, faces, index, stride, scale);
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
    if (!faces[index]) return 0;
    const correction = axis === 'down' ? undefined : this.horizontalCorrection?.[Math.floor(index / this.surfaceCells)];
    return correction
      ? -this.horizontalFlux(bulk, faces, index, offset, correction)
      : faces[index]! * (bulk[index + offset]! - bulk[index]!);
  }
}
