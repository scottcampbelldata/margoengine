// Steady confined Darcy flow on a cell grid, for @margoengine/physics/groundwater: a confined aquifer slice, a
// permeameter, or a Hele-Shaw cell (two plates a gap b apart, where the gap-averaged flow obeys Darcy's law with
// transmissivity b³ / (12 μ) on the pressure). The unknown potential φ (hydraulic head, or pressure for a Hele-Shaw
// cell) satisfies ∇·(T ∇φ) + sources = 0 on the active cells, with fixed potentials on chosen sides or cells and no
// flow elsewhere. Finite volumes on the five-point stencil, harmonic face transmissivities, and Jacobi-preconditioned
// conjugate gradients (the K12 solve, run in a fixed order so the result is the same bits on every engine).
// Clean room, from:
// - H. Darcy, "Les fontaines publiques de la ville de Dijon" (1856);
// - H. S. Hele-Shaw, "The flow of water", Nature 58, 33-36 (1898), and G. K. Batchelor, "An Introduction to Fluid
//   Dynamics", Cambridge (1967), section 4.8 (the gap-averaged Hele-Shaw velocity -b²/(12 μ) ∇p, a potential flow);
// - A. W. Harbaugh, "MODFLOW-2005", USGS Techniques and Methods 6-A16 (2005), chapter 2 (block-centred finite
//   differences, harmonic-mean conductances, half-cell distance to a specified-head boundary);
// - M. R. Hestenes and E. Stiefel, "Methods of conjugate gradients for solving linear systems", J. Research NBS 49,
//   409-436 (1952).
import { MargoError } from '@margoengine/math/errors';

type Scalars = number | ArrayLike<number>;

/** A steady confined flow problem. Cell arrays are x-fast: cell (column, row) is `column + row * columns`. */
export interface ConfinedFlowInput {
  /** Cells along x and z. */
  readonly columns: number;
  readonly rows: number;
  /** Cell size along x, m, and along z (default the same). */
  readonly cellSize: number;
  readonly cellSizeZ?: number;
  /**
   * Transmissivity: flow per unit width per unit potential gradient. K b (m²/s) for an aquifer of conductivity K and
   * thickness b on the head; b³ / (12 μ) (m³/(Pa s)) for a Hele-Shaw gap on the pressure ({@link heleShawTransmissivity}).
   */
  readonly transmissivity: Scalars;
  /** Thickness the flow passes through (aquifer thickness or plate gap), m, for the mean speeds. Default 1. */
  readonly thickness?: number;
  /** Nonzero for a flow cell; zero cells are solid (an obstacle or outside the domain). Default every cell flows. */
  readonly active?: ArrayLike<number>;
  /** Fixed potentials on the outer faces of each side; an omitted side has no flow through it. */
  readonly sides?: Readonly<Partial<Record<'minX' | 'maxX' | 'minZ' | 'maxZ', number>>>;
  /** Fixed potentials per cell, NaN for a free cell (wells, drains, inner boundaries). */
  readonly fixed?: ArrayLike<number>;
  /** Inflow into each cell, m³/s (recharge, injection; negative extracts). */
  readonly sources?: Scalars;
  /** Position of the grid's minimum corner, [x, z] m, for the streamlines. Default [0, 0]. */
  readonly origin?: readonly [number, number];
  /** Relative infinity-norm residual to stop at. Default 1e-12. */
  readonly tolerance?: number;
  /** Conjugate-gradient iterations before giving up. Default 20 × the cell count. */
  readonly maxIterations?: number;
}

/** The solved potential and its flows. */
export interface ConfinedFlow {
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly cellSizeZ: number;
  readonly thickness: number;
  readonly origin: readonly [number, number];
  /** Potential per cell (NaN on solid cells). */
  readonly potential: Float64Array;
  /** Flow through each x face, m³/s, positive toward +x; (columns + 1) × rows, face `i + row * (columns + 1)`. */
  readonly flowX: Float64Array;
  /** Flow through each z face, m³/s, positive toward +z; columns × (rows + 1), face `column + j * columns`. */
  readonly flowZ: Float64Array;
  /**
   * Stream function at the cell corners, m³/s: (columns + 1) × (rows + 1), corner `i + j * (columns + 1)`, zero on the
   * minZ side and growing by each x face's flow upward. Its contours are the streamlines.
   */
  readonly streamFunction: Float64Array;
  /** Total flow in through the fixed sides and cells and the sources, and out, m³/s. */
  readonly inflow: number;
  readonly outflow: number;
  /** Largest mean speed at a cell centre, m/s (flow over face area and thickness). */
  readonly maxSpeed: number;
  /** Largest volume imbalance of a free cell, m³/s. */
  readonly maxResidual: number;
  readonly iterations: number;
}

/** Transmissivity of a Hele-Shaw gap on the pressure: b³ / (12 μ), m³/(Pa s). */
export function heleShawTransmissivity(gap: number, viscosity: number): number {
  if (!(gap > 0) || !(viscosity > 0)) throw new RangeError('A Hele-Shaw gap and viscosity must both be positive.');
  return (gap * gap * gap) / (12 * viscosity);
}

const at = (values: Scalars | undefined, i: number, fallback: number): number =>
  values === undefined ? fallback : typeof values === 'number' ? values : (values[i] ?? fallback);

/** Solves steady confined Darcy flow; see {@link ConfinedFlowInput}. */
export function solveConfinedFlow(input: ConfinedFlowInput): ConfinedFlow {
  const nx = input.columns,
    nz = input.rows;
  if (!Number.isInteger(nx) || !Number.isInteger(nz) || nx < 1 || nz < 1)
    throw new RangeError(`Grid size ${nx} x ${nz} must be positive integers.`);
  const dx = input.cellSize,
    dz = input.cellSizeZ ?? dx,
    b = input.thickness ?? 1;
  if (!(dx > 0) || !(dz > 0) || !(b > 0)) throw new RangeError('Cell sizes and thickness must be positive.');
  const n = nx * nz;
  for (const [name, values] of [
    ['transmissivity', input.transmissivity],
    ['active', input.active],
    ['fixed', input.fixed],
    ['sources', input.sources],
  ] as const)
    if (values !== undefined && typeof values !== 'number' && values.length !== n)
      throw new RangeError(`${name} holds ${values.length} values; the grid has ${n} cells.`);
  const t = new Float64Array(n),
    active = new Uint8Array(n),
    fixed = new Float64Array(n).fill(Number.NaN),
    source = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    active[i] = at(input.active, i, 1) !== 0 ? 1 : 0;
    const ti = at(input.transmissivity, i, Number.NaN);
    if (active[i] && !(ti > 0)) throw new RangeError(`Transmissivity at cell ${i} must be positive; got ${ti}.`);
    t[i] = ti;
    if (input.fixed !== undefined) fixed[i] = input.fixed[i]!;
    source[i] = at(input.sources, i, 0);
  }
  const sides = input.sides ?? {};
  const ax = dz / dx,
    az = dx / dz;
  const face = (i: number, j: number, ratio: number): number => (2 * t[i]! * t[j]! * ratio) / (t[i]! + t[j]!);
  // Boundary conductance and potential of each cell's open sides.
  const boundaryC = new Float64Array(n),
    boundaryQ = new Float64Array(n);
  const side = (i: number, value: number | undefined, ratio: number) => {
    if (value === undefined) return;
    const c = 2 * t[i]! * ratio;
    boundaryC[i] += c;
    boundaryQ[i] += c * value;
  };
  for (let row = 0; row < nz; row++)
    for (let col = 0; col < nx; col++) {
      const i = col + row * nx;
      if (!active[i]) continue;
      if (col === 0) side(i, sides.minX, ax);
      if (col === nx - 1) side(i, sides.maxX, ax);
      if (row === 0) side(i, sides.minZ, az);
      if (row === nz - 1) side(i, sides.maxZ, az);
    }
  const free = (i: number): boolean => active[i] === 1 && Number.isNaN(fixed[i]!);
  // Neighbour conductances of each cell: east, west, north (+z), south (-z); zero across solid cells.
  const east = new Float64Array(n),
    north = new Float64Array(n);
  for (let row = 0; row < nz; row++)
    for (let col = 0; col < nx; col++) {
      const i = col + row * nx;
      if (!active[i]) continue;
      if (col < nx - 1 && active[i + 1]) east[i] = face(i, i + 1, ax);
      if (row < nz - 1 && active[i + nx]) north[i] = face(i, i + nx, az);
    }
  const diagonal = new Float64Array(n),
    rhs = new Float64Array(n),
    x = new Float64Array(n);
  let start = 0,
    count = 0;
  for (const v of [sides.minX, sides.maxX, sides.minZ, sides.maxZ]) if (v !== undefined) (start += v), count++;
  for (let i = 0; i < n; i++) if (!Number.isNaN(fixed[i]!)) (start += fixed[i]!), count++;
  start = count ? start / count : 0;
  for (let i = 0; i < n; i++) {
    if (!free(i)) {
      x[i] = active[i] ? fixed[i]! : Number.NaN;
      continue;
    }
    x[i] = start;
    let d = boundaryC[i]!,
      r = boundaryQ[i]! + source[i]!;
    const col = i % nx;
    const link = (j: number, c: number) => {
      if (c === 0) return;
      d += c;
      if (!free(j)) r += c * fixed[j]!;
    };
    if (col < nx - 1) link(i + 1, east[i]!);
    if (col > 0) link(i - 1, east[i - 1]!);
    if (i + nx < n) link(i + nx, north[i]!);
    if (i - nx >= 0) link(i - nx, north[i - nx]!);
    diagonal[i] = d;
    rhs[i] = r;
  }
  // Every free cell must reach a fixed potential through flowing faces, or the system has no unique solution.
  const reached = new Uint8Array(n),
    queue: number[] = [];
  const seen = (j: number) => {
    if (free(j) && !reached[j]) {
      reached[j] = 1;
      queue.push(j);
    }
  };
  for (let i = 0; i < n; i++) {
    if (!free(i)) continue;
    const col = i % nx;
    const touchesFixed =
      boundaryC[i]! > 0 ||
      (col < nx - 1 && east[i]! > 0 && !free(i + 1)) ||
      (col > 0 && east[i - 1]! > 0 && !free(i - 1)) ||
      (i + nx < n && north[i]! > 0 && !free(i + nx)) ||
      (i - nx >= 0 && north[i - nx]! > 0 && !free(i - nx));
    if (touchesFixed) seen(i);
  }
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k]!,
      col = i % nx;
    if (col < nx - 1 && east[i]! > 0) seen(i + 1);
    if (col > 0 && east[i - 1]! > 0) seen(i - 1);
    if (i + nx < n && north[i]! > 0) seen(i + nx);
    if (i - nx >= 0 && north[i - nx]! > 0) seen(i - nx);
  }
  for (let i = 0; i < n; i++)
    if (free(i) && !reached[i])
      throw new MargoError(
        'failed',
        `Cell ${i} has no path to a fixed potential; open a side or fix a cell it reaches.`,
      );
  const multiply = (v: Float64Array, out: Float64Array): void => {
    for (let i = 0; i < n; i++) {
      if (!free(i)) {
        out[i] = 0;
        continue;
      }
      const col = i % nx;
      let s = diagonal[i]! * v[i]!;
      if (col < nx - 1 && free(i + 1)) s -= east[i]! * v[i + 1]!;
      if (col > 0 && free(i - 1)) s -= east[i - 1]! * v[i - 1]!;
      if (i + nx < n && free(i + nx)) s -= north[i]! * v[i + nx]!;
      if (i - nx >= 0 && free(i - nx)) s -= north[i - nx]! * v[i - nx]!;
      out[i] = s;
    }
  };
  const tolerance = input.tolerance ?? 1e-12,
    maxIterations = input.maxIterations ?? 20 * n;
  const r = new Float64Array(n),
    z = new Float64Array(n),
    p = new Float64Array(n),
    q = new Float64Array(n);
  multiply(x, q);
  let scale = 0,
    rz = 0;
  for (let i = 0; i < n; i++) {
    if (!free(i)) continue;
    scale = Math.max(scale, Math.abs(rhs[i]!));
    r[i] = rhs[i]! - q[i]!;
    z[i] = r[i]! / diagonal[i]!;
    p[i] = z[i]!;
    rz += r[i]! * z[i]!;
  }
  const norm = (): number => {
    let m = 0;
    for (let i = 0; i < n; i++) if (free(i)) m = Math.max(m, Math.abs(r[i]!));
    return m;
  };
  let iterations = 0;
  const target = tolerance * Math.max(scale, Number.MIN_VALUE);
  while (norm() > target) {
    if (iterations++ >= maxIterations)
      throw new MargoError('failed', `The confined flow solve did not converge in ${maxIterations} iterations.`);
    multiply(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i]! * q[i]!;
    const alpha = rz / pq;
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (!free(i)) continue;
      x[i] += alpha * p[i]!;
      r[i] -= alpha * q[i]!;
      z[i] = r[i]! / diagonal[i]!;
      next += r[i]! * z[i]!;
    }
    const beta = next / rz;
    rz = next;
    for (let i = 0; i < n; i++) if (free(i)) p[i] = z[i]! + beta * p[i]!;
  }
  return assemble(input, nx, nz, dx, dz, b, x, active, east, north, sides, t, source, fixed, iterations);
}

function assemble(
  input: ConfinedFlowInput,
  nx: number,
  nz: number,
  dx: number,
  dz: number,
  b: number,
  phi: Float64Array,
  active: Uint8Array,
  east: Float64Array,
  north: Float64Array,
  sides: NonNullable<ConfinedFlowInput['sides']>,
  t: Float64Array,
  source: Float64Array,
  fixed: Float64Array,
  iterations: number,
): ConfinedFlow {
  const n = nx * nz,
    pitch = nx + 1,
    ax = dz / dx,
    az = dx / dz;
  const flowX = new Float64Array(pitch * nz),
    flowZ = new Float64Array(nx * (nz + 1));
  for (let row = 0; row < nz; row++)
    for (let f = 0; f <= nx; f++) {
      let value = 0;
      if (f === 0) {
        const i = row * nx;
        if (active[i] && sides.minX !== undefined) value = 2 * t[i]! * ax * (sides.minX - phi[i]!);
      } else if (f === nx) {
        const i = row * nx + nx - 1;
        if (active[i] && sides.maxX !== undefined) value = 2 * t[i]! * ax * (phi[i]! - sides.maxX);
      } else {
        const i = row * nx + f - 1;
        if (east[i]! > 0) value = east[i]! * (phi[i]! - phi[i + 1]!);
      }
      flowX[f + row * pitch] = value;
    }
  for (let j = 0; j <= nz; j++)
    for (let col = 0; col < nx; col++) {
      let value = 0;
      if (j === 0) {
        const i = col;
        if (active[i] && sides.minZ !== undefined) value = 2 * t[i]! * az * (sides.minZ - phi[i]!);
      } else if (j === nz) {
        const i = col + (nz - 1) * nx;
        if (active[i] && sides.maxZ !== undefined) value = 2 * t[i]! * az * (phi[i]! - sides.maxZ);
      } else {
        const i = col + (j - 1) * nx;
        if (north[i]! > 0) value = north[i]! * (phi[i]! - phi[i + nx]!);
      }
      flowZ[col + j * nx] = value;
    }
  const psi = new Float64Array(pitch * (nz + 1));
  for (let j = 0; j < nz; j++)
    for (let f = 0; f <= nx; f++) psi[f + (j + 1) * pitch] = psi[f + j * pitch]! + flowX[f + j * pitch]!;
  let maxSpeed = 0,
    maxResidual = 0,
    inflow = 0,
    outflow = 0;
  const count = (q: number) => (q > 0 ? (inflow += q) : (outflow -= q));
  for (let row = 0; row < nz; row++) {
    count(flowX[row * pitch]!);
    count(-flowX[nx + row * pitch]!);
  }
  for (let col = 0; col < nx; col++) {
    count(flowZ[col]!);
    count(-flowZ[col + nz * nx]!);
  }
  for (let i = 0; i < n; i++) {
    if (!active[i]) {
      phi[i] = Number.NaN;
      continue;
    }
    const col = i % nx,
      row = (i - col) / nx;
    const west = flowX[col + row * pitch]!,
      eastFlow = flowX[col + 1 + row * pitch]!,
      south = flowZ[col + row * nx]!,
      northFlow = flowZ[col + (row + 1) * nx]!;
    const faces = west - eastFlow + south - northFlow;
    if (Number.isNaN(fixed[i]!)) {
      maxResidual = Math.max(maxResidual, Math.abs(faces + source[i]!));
      count(source[i]!);
    } else count(-faces);
    const u = (0.5 * (west + eastFlow)) / (dz * b),
      v = (0.5 * (south + northFlow)) / (dx * b);
    maxSpeed = Math.max(maxSpeed, Math.sqrt(u * u + v * v));
  }
  return {
    columns: nx,
    rows: nz,
    cellSize: dx,
    cellSizeZ: dz,
    thickness: b,
    origin: input.origin ?? [0, 0],
    potential: phi,
    flowX,
    flowZ,
    streamFunction: psi,
    inflow,
    outflow,
    maxSpeed,
    maxResidual,
    iterations,
  };
}

/** One streamline: its points at every x face and the travel time to each, from the seed face. */
export interface Streamline {
  readonly x: Float64Array;
  readonly z: Float64Array;
  /** Travel time from the first point, s. */
  readonly time: Float64Array;
  readonly duration: number;
}

/** Options for {@link traceStreamlines}. */
export interface StreamlineOptions {
  /** Seed positions across the minX side, each a fraction of the width in [0, 1]. */
  readonly seeds: ArrayLike<number>;
  /** Least x speed used for the travel time, m/s, so a stagnant face does not stall a parcel. Default 0. */
  readonly minSpeed?: number;
}

/**
 * Streamlines of a flow that runs from the minX side to the maxX side: each is the stream-function contour through
 * its seed, found on every x face by interpolating the corner values, with the travel time integrated as the trapezoid
 * of dx / u between faces.
 */
export function traceStreamlines(flow: ConfinedFlow, options: StreamlineOptions): Streamline[] {
  const { columns: nx, rows: nz, cellSize: dx, cellSizeZ: dz, thickness: b, streamFunction: psi, flowX } = flow,
    pitch = nx + 1,
    [x0, z0] = flow.origin,
    minSpeed = options.minSpeed ?? 0;
  const lanes: Streamline[] = [];
  for (let k = 0; k < options.seeds.length; k++) {
    const seed = options.seeds[k]!;
    if (!(seed >= 0 && seed <= 1)) throw new RangeError(`Streamline seed ${seed} must lie in [0, 1].`);
    const rowAt = seed * nz,
      below = Math.min(nz - 1, Math.floor(rowAt)) * pitch;
    const value = psi[below]! + (psi[below + pitch]! - psi[below]!) * (rowAt - Math.floor(rowAt));
    const x = new Float64Array(pitch),
      z = new Float64Array(pitch),
      time = new Float64Array(pitch);
    let previous = 0;
    for (let f = 0; f <= nx; f++) {
      let j = 0;
      while (j < nz - 1 && psi[(j + 1) * pitch + f]! < value) j++;
      const lo = psi[j * pitch + f]!,
        hi = psi[(j + 1) * pitch + f]!;
      const w = hi > lo ? Math.max(0, Math.min(1, (value - lo) / (hi - lo))) : 0.5;
      x[f] = x0 + f * dx;
      z[f] = z0 + (j + w) * dz;
      const speed = Math.max(minSpeed, flowX[j * pitch + f]! / (dz * b));
      if (f > 0) time[f] = time[f - 1]! + (2 * dx) / (speed + previous);
      previous = speed;
    }
    lanes.push({ x, z, time, duration: time[nx]! });
  }
  return lanes;
}

/** The point a parcel reaches `time` s along a streamline (clamped to its ends), as [x, z]. */
export function streamlinePoint(lane: Streamline, time: number): [number, number] {
  const target = Math.max(0, Math.min(lane.duration, time));
  let a = 0,
    b = lane.time.length - 1;
  while (b - a > 1) {
    const mid = (a + b) >> 1;
    if (lane.time[mid]! < target) a = mid;
    else b = mid;
  }
  const span = lane.time[b]! - lane.time[a]!,
    w = span > 0 ? (target - lane.time[a]!) / span : 0;
  return [lane.x[a]! + (lane.x[b]! - lane.x[a]!) * w, lane.z[a]! + (lane.z[b]! - lane.z[a]!) * w];
}
