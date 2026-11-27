import { MargoError } from '@margoengine/math/errors';
import type { QuayPotentialGrid } from '../loads/quay-potential.js';

type Vector = readonly [number, number, number];
type Wrench = readonly [number, number, number, number, number, number];
type FaceAxis = 'x' | 'z' | 'down';

interface HullFace {
  readonly cell: number;
  /** Face-normal area followed by its moment about the reference hull centre. */
  readonly basis: Wrench;
}

export interface WakeHullBoundaryOptions {
  readonly grid: QuayPotentialGrid;
  /** One byte per volume cell, X then Z then depth. Set one for the mean wetted hull. */
  readonly hull: Uint8Array;
  /** Horizontal corner of the grid, in metres. Defaults to [0, 0]. */
  readonly origin?: readonly [number, number];
  /** Hull centre of moment in metres, Y positive above still water. */
  readonly centre: Vector;
}

const atRest: Vector = [0, 0, 0];

function facePairing(basis: Wrench, motion: ArrayLike<number>): number {
  const [x, y, z, rx, ry, rz] = basis;
  return x * motion[0]! + y * motion[1]! + z * motion[2]! + rx * motion[3]! + ry * motion[4]! + rz * motion[5]!;
}

/**
 * Impermeable mean hull and its paired motion/pressure operators for a linear potential wake.
 * The wet geometry stays fixed. Small motion prescribes normal velocity at the mean wetted surface
 * (Cummins 1962, eq. 34), and the transpose returns the linear Bernoulli impulse at those same faces.
 */
export class WakeHullBoundary {
  readonly grid: QuayPotentialGrid;
  private readonly faces: readonly HullFace[];
  private readonly volumeCells: number;
  private readonly directed = {
    x: new Map<number, Wrench>(),
    z: new Map<number, Wrench>(),
    down: new Map<number, Wrench>(),
  };

  constructor({ grid, hull, origin = [0, 0], centre }: WakeHullBoundaryOptions) {
    const {
      cells: [nx, nz],
      cellSize: dx,
      depths,
      wet,
      openX,
      openZ,
    } = grid;
    const layers = depths.length - 1;
    const plane = nx * nz;
    const count = plane * layers;
    if (
      ![nx, nz].every((value) => Number.isSafeInteger(value) && value > 0) ||
      !(Number.isFinite(dx) && dx > 0) ||
      depths[0] !== 0 ||
      layers < 1 ||
      depths.some((depth, i) => !Number.isFinite(depth) || (i > 0 && depth <= depths[i - 1]!)) ||
      !Number.isSafeInteger(count) ||
      count > 0x1fffffff ||
      !(hull instanceof Uint8Array) ||
      hull.length !== count ||
      [wet, openX, openZ].some((field) => field && field.length !== count) ||
      origin.length !== 2 ||
      centre.length !== 3 ||
      !origin.every(Number.isFinite) ||
      !centre.every(Number.isFinite)
    )
      throw new MargoError(
        'state',
        'Give the wake hull a finite layered grid, a matching hull mask and a finite centre.',
      );
    if (
      hull.some((solid, i) => solid > 1 || (solid === 1 && wet?.[i] === 0)) ||
      (wet && Array.prototype.some.call(wet, (value: number) => value !== 0 && value !== 1)) ||
      [openX, openZ].some((field) => field && Array.prototype.some.call(field, (v: number) => !(v >= 0 && v <= 1)))
    )
      throw new MargoError(
        'state',
        'Put the mean hull only inside the reference water and give faces open fractions from zero to one.',
      );
    const available = Uint8Array.from(hull, (solid, i) => Number(!solid && (wet?.[i] ?? 1) !== 0));
    const faces: HullFace[] = [];
    const surfaceArea = dx * dx;
    const add = (cell: number, axis: FaceAxis, face: number, area: number, x: number, y: number, z: number) => {
      const ax = axis === 'x' ? area : 0;
      const ay = axis === 'down' ? -area : 0;
      const az = axis === 'z' ? area : 0;
      if (!available[cell] || !(ax || ay || az)) return;
      const [rx, ry, rz] = [x - centre[0], y - centre[1], z - centre[2]];
      const basis: Wrench = [ax, ay, az, ry * az - rz * ay, rz * ax - rx * az, rx * ay - ry * ax];
      if (!basis.every(Number.isFinite))
        throw new MargoError('state', 'Measure the hull faces and moment arms at a finite scale near the wake.');
      faces.push({ cell, basis });
      this.directed[axis].set(face, area > 0 ? basis : [-ax, -ay, -az, -basis[3], -basis[4], -basis[5]]);
    };
    for (let i = 0; i < count; i++) {
      if (!hull[i]) continue;
      const column = i % plane;
      const ix = column % nx;
      const iz = Math.floor(column / nx);
      const layer = Math.floor(i / plane);
      const top = depths[layer]!;
      const bottom = depths[layer + 1]!;
      const wallArea = dx * (bottom - top);
      const x = origin[0] + ix * dx;
      const z = origin[1] + iz * dx;
      const xc = x + dx / 2;
      const yc = -(top + bottom) / 2;
      const zc = z + dx / 2;
      // Every face points from the solid into water. A fixed exterior cut contributes only its open area.
      if (ix > 0) add(i - 1, 'x', i - 1, -wallArea * (openX?.[i - 1] ?? 1), x, yc, zc);
      if (ix + 1 < nx) add(i + 1, 'x', i, wallArea * (openX?.[i] ?? 1), x + dx, yc, zc);
      if (iz > 0) add(i - nx, 'z', i - nx, -wallArea * (openZ?.[i - nx] ?? 1), xc, yc, z);
      if (iz + 1 < nz) add(i + nx, 'z', i, wallArea * (openZ?.[i] ?? 1), xc, yc, z + dx);
      if (layer > 0) add(i - plane, 'down', i - plane, -surfaceArea, xc, -top, zc);
      if (layer + 1 < layers) add(i + plane, 'down', i, surfaceArea, xc, -bottom, zc);
    }
    if (!faces.length)
      throw new MargoError('state', 'Give the mean hull at least one open face against surrounding water.');
    this.faces = faces;
    this.volumeCells = count;
    this.grid = {
      cells: [nx, nz],
      cellSize: dx,
      depths: [...depths],
      horizontalOrder: grid.horizontalOrder,
      wet: available,
      openX: openX && Float64Array.from(openX),
      openZ: openZ && Float64Array.from(openZ),
    };
  }

  /** Add outward hull face flux in m³/s to its adjacent water cells, leaving other volume sources there. */
  addFlux(source: Float64Array, linear: Vector, angular: Vector = atRest): void {
    if (linear.length !== 3 || angular.length !== 3)
      throw new MargoError('state', 'Give the wake hull xyz linear and angular velocities.');
    this.addMotionFlux(source, [...linear, ...angular]);
  }

  /** Add the six-component motion's flux and return the net imposed volume rate in m³/s. */
  addMotionFlux(source: Float64Array, motion: ArrayLike<number>): number {
    if (source.length !== this.volumeCells || motion.length < 6 || !Array.prototype.every.call(motion, Number.isFinite))
      throw new MargoError('state', 'Pass the wake bulk flux buffer and finite linear and angular hull velocities.');
    let net = 0;
    for (const { cell, basis } of this.faces) {
      const flux = facePairing(basis, motion);
      source[cell]! += flux;
      net += flux;
    }
    if (!Number.isFinite(net))
      throw new MargoError('state', 'Scale the wake hull velocities and areas to finite fluxes.');
    return net;
  }

  /** Moving wall flux in the same axis and orientation as QuayPotential.faceFlux. */
  normalFlux(axis: FaceAxis, cell: number, motion: ArrayLike<number>): number {
    const basis = this.directed[axis].get(cell);
    return basis ? facePairing(basis, motion) : 0;
  }

  /** Sum of the bulk potential times the moving hull's outward flux, before density and the energy factor. */
  potentialFlux(bulk: Float64Array, motion: ArrayLike<number>): number {
    let pairing = 0;
    for (const { cell, basis } of this.faces) pairing += bulk[cell]! * facePairing(basis, motion);
    return pairing;
  }

  /** Body impulse and angular impulse from the same faces, in N·s and N·m·s, about the mean hull centre. */
  pressureImpulse(start: Float64Array, end: Float64Array, density: number): Wrench {
    if (
      start.length !== this.volumeCells ||
      end.length !== this.volumeCells ||
      !(Number.isFinite(density) && density > 0)
    )
      throw new MargoError('state', 'Use both accepted wake bulk potentials and a finite positive water density.');
    const impulse: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
    // p = -rho d(phi)/dt. Pressure on the solid is opposite its outward normal, so the signs cancel.
    for (const { cell, basis } of this.faces) {
      const pressure = density * (end[cell]! - start[cell]!);
      for (let i = 0; i < impulse.length; i++) impulse[i]! += pressure * basis[i]!;
    }
    if (!impulse.every(Number.isFinite))
      throw new MargoError('state', 'Keep the accepted hull potential changes and density at a finite scale.');
    return impulse;
  }
}
