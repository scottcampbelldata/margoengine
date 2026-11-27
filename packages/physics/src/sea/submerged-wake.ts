import { MargoError } from '@margoengine/math/errors';
import type { RealFft2 } from '@margoengine/math/fft';
import { cos, exp } from '@margoengine/math/pinned';
import type { FieldDescriptor } from '../world/solver.js';

const PI = 3.141592653589793;

/** An opt-in submerged wake source. Depths are metres down from still water, beginning at zero. */
export interface SubmergedWakeSource {
  /** The solver-local layout-1 f64 field of x, z, radius, band index and signed volume rows. */
  readonly field: FieldDescriptor;
  /** The edges of up to eight depth bands shared by all bodies on the field. */
  readonly depths: readonly number[];
}

/** The layout of a submerged wake port, separate from the legacy surface source. */
export const SUBMERGED_WAKE_LAYOUT = 1;
/** A submerged source row is x, z, radius, depth band index and signed volume. */
export const SUBMERGED_WAKE_WORDS = 5;
export const SUBMERGED_WAKE_MAX_ROWS = 16384;
export const SUBMERGED_WAKE_MAX_CELLS = 1048576;
export const SUBMERGED_WAKE_QUANTITY = 'submergedSeaSource';

export function wakeDepths(depths: readonly number[]): readonly number[] {
  if (
    !Array.isArray(depths) ||
    depths.length < 2 ||
    depths.length > 9 ||
    depths[0] !== 0 ||
    depths.findIndex((value, i) => !Number.isFinite(value) || (i > 0 && !(value > depths[i - 1]!))) >= 0
  )
    throw new MargoError(
      'state',
      'Wake depth edges must start at zero and increase over one through eight finite bands; pass depths in metres.',
    );
  return Object.freeze([...depths]);
}

export interface WakeSourceGrid {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly x0: number;
  readonly z0: number;
}

/** Scatter a raised cosine with unit area integral for flux. Pressure uses the peak, not that normalization. */
export function wakePatch(
  grid: WakeSourceGrid,
  x: number,
  z: number,
  radius: number,
  volume: number,
  h: Float64Array,
  pressure = 0,
  press?: Float64Array,
): void {
  const { nx, nz, dx, x0, z0 } = grid,
    i0 = Math.max(0, Math.floor((x - radius - x0) / dx)),
    i1 = Math.min(nx - 1, Math.ceil((x + radius - x0) / dx)),
    j0 = Math.max(0, Math.floor((z - radius - z0) / dx)),
    j1 = Math.min(nz - 1, Math.ceil((z + radius - z0) / dx));
  let weight = 0;
  for (let pass = 0; pass < 2; pass++)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * dx - x,
          pz = z0 + (j + 0.5) * dx - z,
          r = Math.sqrt(px * px + pz * pz);
        if (r < radius) {
          const b = 0.5 * (1 + cos((PI * r) / radius));
          if (pass === 0) weight += b * dx * dx;
          else {
            if (press) press[i + nx * j]! += pressure * b;
            if (volume && weight > 0) h[i + nx * j]! += (volume * b) / weight;
          }
        }
      }
  if (!press && weight === 0)
    throw new MargoError(
      'state',
      'A submerged wake source missed the grid; enclose the hull and use a radius greater than half the cell diagonal.',
    );
}

/**
 * Translate the centred radial stencil by cloud-in-cell weights. Each tap carries
 * both its volume and its first horizontal moments as the source crosses a cell.
 */
function projectedPatch(
  grid: WakeSourceGrid,
  x: number,
  z: number,
  radius: number,
  volume: number,
  height: Float64Array,
): void {
  const { nx, nz, dx, x0, z0 } = grid;
  const u = (x - x0) / dx - 0.5,
    v = (z - z0) / dx - 0.5,
    i0 = Math.floor(u),
    j0 = Math.floor(v),
    cells = Math.max(1, radius / dx),
    reach = Math.ceil(cells) - 1;
  // A clipped patch at the edge can retain its volume, but has no symmetric support.
  if (i0 - reach < 0 || i0 + reach + 1 >= nx || j0 - reach < 0 || j0 + reach + 1 >= nz) {
    wakePatch(grid, x, z, radius, volume, height);
    return;
  }
  const fx = u - i0,
    fz = v - j0,
    left = 1 - fx,
    back = 1 - fz;
  let sum = 0;
  for (let pass = 0; pass < 2; pass++)
    for (let j = -reach; j <= reach; j++)
      for (let i = -reach; i <= reach; i++) {
        const r = Math.sqrt(i * i + j * j) / cells;
        if (r >= 1) continue;
        const weight = 0.5 * (1 + cos(PI * r));
        if (pass === 0) sum += weight;
        else {
          const h = (volume * weight) / (sum * dx * dx);
          const k = i + i0 + (j + j0) * nx;
          height[k]! += h * left * back;
          height[k + 1]! += h * fx * back;
          height[k + nx]! += h * left * fz;
          height[k + nx + 1]! += h * fx * fz;
        }
      }
}

// Apply the no-flux bed Green identity to a vertical Fourier mode with source q. With y up from the
// still surface, multiply phi''-k^2 phi=q by G=cosh(k(y+D))/cosh(kD) and integrate. The surface's
// additional normal flux is the integral of G q. The deep-water limit is the exp(k y) in Tuck,
// Scullen and Lazauskas (2000), "Ship-wave patterns in the spirit of Michell", Eq. 4.
// Average G exactly over a band. The series avoids subtraction loss for the longest waves.
function bandTransfer(k: number, depth: number, upper: number, lower: number): number {
  if (k === 0) return 1;
  const slab = k * (lower - upper);
  const average =
    slab < 1e-3 ? 1 + slab * (-1 / 2 + slab * (1 / 6 + slab * (-1 / 24 + slab / 120))) : (1 - exp(-slab)) / slab;
  return (average * (exp(-k * upper) + exp(-k * (2 * depth - lower)))) / (1 + exp(-2 * k * depth));
}

/** Scratch buffers and a fixed set of transfer multipliers. Their values never affect a restored state. */
export class ProjectedWakeSource {
  private readonly active: Uint8Array;
  private readonly transfers: readonly Float64Array[];
  private readonly flux: Float64Array;
  private readonly spectrum: Float64Array;
  rows = 0;
  bands = 0;

  constructor(
    private readonly grid: WakeSourceGrid,
    depths: readonly number[],
    depth: number,
  ) {
    const { nx, nz, dx } = grid;
    if (depths.at(-1)! > depth)
      throw new MargoError(
        'state',
        'The projected wake bands extend below the bed; set their deepest edge at or above the wake depth.',
      );
    const half = nx / 2 + 1;
    const modes = new Float64Array(half * nz);
    for (let j = 0; j < nz; j++) {
      const kz = (2 * PI * (j < nz / 2 ? j : j - nz)) / (nz * dx);
      for (let i = 0; i < half; i++) {
        const kx = (2 * PI * i) / (nx * dx);
        modes[i + half * j] = Math.sqrt(kx * kx + kz * kz);
      }
    }
    this.active = new Uint8Array(depths.length - 1);
    this.transfers = depths
      .slice(1)
      .map((lower, i) => Float64Array.from(modes, (k) => bandTransfer(k, depth, depths[i]!, lower)));
    this.flux = new Float64Array(nx * nz);
    this.spectrum = new Float64Array(2 * modes.length);
  }

  add(rows: Float64Array, fft: RealFft2, heightSpectrum: Float64Array): void {
    this.active.fill(0);
    this.rows = this.bands = 0;
    for (let i = 0; i < rows.length; i += SUBMERGED_WAKE_WORDS) {
      const x = rows[i]!,
        z = rows[i + 1]!,
        radius = rows[i + 2]!,
        band = rows[i + 3]!,
        volume = rows[i + 4]!;
      if (volume === 0) continue;
      if (
        !(
          Number.isFinite(x) &&
          Number.isFinite(z) &&
          Number.isFinite(radius) &&
          radius > 0 &&
          Number.isFinite(volume)
        ) ||
        !(Number.isInteger(band) && band >= 0 && band < this.active.length)
      )
        throw new MargoError(
          'state',
          'A submerged wake source is x, z, positive radius, a valid depth band and signed volume; write finite values.',
        );
      this.active[band] = 1;
      this.rows++;
    }
    for (let band = 0; band < this.active.length; band++) {
      if (!this.active[band]) continue;
      this.bands++;
      this.flux.fill(0);
      for (let i = 0; i < rows.length; i += SUBMERGED_WAKE_WORDS)
        if (rows[i + 4] !== 0 && rows[i + 3] === band)
          projectedPatch(this.grid, rows[i]!, rows[i + 1]!, rows[i + 2]!, rows[i + 4]!, this.flux);
      fft.forward(this.flux, this.spectrum);
      const transfer = this.transfers[band]!;
      for (let i = 0; i < transfer.length; i++) {
        heightSpectrum[2 * i]! += this.spectrum[2 * i]! * transfer[i]!;
        heightSpectrum[2 * i + 1]! += this.spectrum[2 * i + 1]! * transfer[i]!;
      }
    }
  }
}
