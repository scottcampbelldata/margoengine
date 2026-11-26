import { MargoError } from '@margoengine/math/errors';
import type { FlowField } from '@margoengine/math/fields';
import { ln } from '@margoengine/math/pinned';

/** Evaluate bed pickup under a resolved propeller or thruster flow. */
export interface TracerBedWash {
  /** The wash velocity field, for example `ShipSolver.water`. */
  water: FlowField;
  /** Bounds in x and z from the tracer origin cell, m, as [minX, minZ, maxX, maxZ]. */
  bounds: readonly [number, number, number, number];
  /** Cell counts in x and z (default [12, 12], at most 65,536 total). One midpoint stress sample per cell. */
  cells?: readonly [number, number];
  /** Sampling height normal to the bed, m, inside the local logarithmic layer. */
  referenceHeight: number;
  /** Hydraulic roughness length in metres. For a fully rough sand bed this is k_s/30. */
  roughnessLength: number;
}

export interface BedWashGrid {
  water: FlowField;
  referenceHeight: number;
  stressFactor: number;
  x: number;
  z: number;
  nx: number;
  nz: number;
  dx: number;
  dz: number;
}

export function bedWashGrid(options: TracerBedWash, density: number): BedWashGrid {
  const { water, bounds, cells = [12, 12], referenceHeight, roughnessLength } = options;
  const [x, z, maxX, maxZ] = bounds;
  const [nx, nz] = cells;
  if (!(bounds.every(Number.isFinite) && maxX > x && maxZ > z && water.medium === 'water'))
    throw new MargoError(
      'unsupported',
      'The bed wash needs a nonempty rectangle and a water velocity field; supply ordered finite bounds and water.',
    );
  if (!(Number.isInteger(nx) && Number.isInteger(nz) && nx > 0 && nz > 0 && nx * nz <= 65536))
    throw new MargoError(
      'unsupported',
      'Bed wash grid counts are outside range; supply whole cell counts with at most 65,536 samples.',
    );
  if (!(referenceHeight > roughnessLength && roughnessLength > 0 && Number.isFinite(referenceHeight)))
    throw new MargoError(
      'unsupported',
      'The bed wash reference height must exceed its roughness length; supply a finite sample height within the log layer.',
    );
  const dx = (maxX - x) / nx;
  const dz = (maxZ - z) / nz;
  // u_* = κ U_t / ln(z/z₀), with κ = 0.4 and the supplied hydraulic roughness length.
  const wallScale = 0.4 / (ln(referenceHeight) - ln(roughnessLength));
  const stressFactor = density * wallScale * wallScale;
  if (!(dx * dz > 0 && Number.isFinite(dx * dz) && stressFactor > 0 && Number.isFinite(stressFactor)))
    throw new MargoError(
      'unsupported',
      'Bed wash cell area or stress scale exceeds numeric range; use physical bounds and roughness.',
    );
  return { water, x, z, nx, nz, dx, dz, referenceHeight, stressFactor };
}
