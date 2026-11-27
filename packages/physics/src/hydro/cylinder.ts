import { MargoError } from '@margoengine/math/errors';
import { regionWords } from '../world/memory.js';
import type { Port, Region, SolverHost, StepContext } from '../world/solver.js';
import {
  type BlockageFootprint,
  blockageGeometry,
  type CylinderGeometry,
  cylinderFootprint,
  cylinderPistonDepth,
  prepareFootprint,
} from './moving-blockage.js';
import {
  type ShallowBlockageFields,
  type ShallowMovingCylinder,
  type ShallowMovingFootprint,
  SHALLOW_BLOCKAGE_LAYOUT,
  SHALLOW_BLOCKAGE_MOTION_WORDS,
  SHALLOW_BLOCKAGE_REACTION_WORDS,
  SHALLOW_RIGID_BLOCKAGE_LAYOUT,
  SHALLOW_RIGID_BLOCKAGE_MOTION_WORDS,
} from './blockage-contract.js';
import { DRY, type ShallowGrid, shallowOpenRates, velocityOf } from './shallow.js';

type Point = readonly [number, number];
type Impulse = [number, number, number, number, number, number];
const UNMERGED_AREA_FRACTION = Math.PI / 4;

function bad(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#hydrodynamic-loads`);
}

function wrapped(value: number, period: number): number {
  const r = value % period;
  return r < 0 ? r + period : r;
}

interface Rates {
  readonly depth: Float64Array;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly force: Impulse;
}

function rates(
  grid: ShallowGrid,
  geometry: CylinderGeometry,
  h: Float64Array,
  hu: Float64Array,
  hv: Float64Array,
  wallVelocity: Point,
  elevation: number,
): Rates {
  const count = h.length;
  const depth = new Float64Array(count);
  const x = new Float64Array(count);
  const z = new Float64Array(count);
  shallowOpenRates(grid, h, hu, hv, 0, depth, x, z, geometry.openX, geometry.openZ);
  const force: Impulse = [0, 0, 0, 0, 0, 0];
  const area = grid.dx * grid.dz;
  const bed = grid.bed[0]!;
  const reference = h[0]!;
  const pressureScale = 0.5 * grid.g;
  const arm = bed - elevation;
  for (const wall of geometry.walls) {
    const cell = wall.cell;
    const height = h[cell]!;
    const [nx, nz] = wall.inward;
    const relative =
      (velocityOf(height, hu[cell]!) - wallVelocity[0]) * nx + (velocityOf(height, hv[cell]!) - wallVelocity[1]) * nz;
    const star = cylinderPistonDepth(height, relative, grid.g);
    // Remove the cell's hydrostatic pressure on its whole closed contour.
    // The matching open-face difference is taken inside the HLL flux.
    const fluidPressure = pressureScale * (star - height) * (star + height);
    x[cell]! -= (fluidPressure * wall.normal[0]) / area;
    z[cell]! -= (fluidPressure * wall.normal[1]) / area;
    // A constant pressure produces no wrench on the closed solid. Remove
    // the common reference before summing its force and hydrostatic moment.
    const pressure = pressureScale * (star - reference) * (star + reference);
    const moment =
      pressure * arm +
      (pressureScale / 3) * (star - reference) * (star * star + star * reference + reference * reference);
    const fx = pressure * wall.normal[0];
    const fz = pressure * wall.normal[1];
    force[0] += fx;
    force[2] += fz;
    force[3] += moment * wall.normal[1];
    force[4] += wall.centre[1] * fx - wall.centre[0] * fz;
    force[5] -= moment * wall.normal[0];
  }
  return { depth, x, z, force };
}

function update(value: number, storageChange: number, openArea: number, integral: number): number {
  return value + (storageChange * value + integral) / openArea;
}

function stagedHeight(value: number): number {
  if (!(value > DRY && Number.isFinite(value)))
    throw bad(
      'A moving shallow-water cylinder requires wet cells; increase the channel depth or use HYDRO-01 without it.',
    );
  return value;
}

interface CutCellMerge {
  readonly cut: number;
  readonly neighbour: number;
  readonly from: number;
  readonly to: number;
}

/** Causon, Ingram and Mingham (2001, §3.4): integrate disappearing cells with a wet neighbour. */
function smallCutCellMerge(grid: ShallowGrid, geometry: CylinderGeometry, motion: Point): CutCellMerge | undefined {
  const { occupiedStart, occupiedEnd, openX, openZ } = geometry;
  const { nx, nz, dx, dz } = grid;
  // The change in overlap is bounded by a full face length in each direction.
  // From the nearer endpoint, occupation can gain at most half the swept fraction.
  const sweep = Math.abs(motion[0]) / dx + Math.abs(motion[1]) / dz;
  for (let cut = 0; cut < occupiedStart.length; cut++) {
    const old = occupiedStart[cut]!,
      next = occupiedEnd[cut]!;
    if (Math.max(old, next) + sweep / 2 <= UNMERGED_AREA_FRACTION) continue;
    // The Courant limit bounds sweep by 0.5 (1 - π/4). A candidate had
    // more than half a cell of solid at the start, so there can only be one.
    const column = cut % nx,
      row = Math.floor(cut / nx),
      west = row * nx + ((column + nx - 1) % nx),
      east = row * nx + ((column + 1) % nx),
      south = ((row + nz - 1) % nz) * nx + column,
      north = ((row + 1) % nz) * nx + column;
    const faces = [
      { cell: west, open: openX[cut]! * dz },
      { cell: east, open: openX[east]! * dz },
      { cell: south, open: openZ[cut]! * dx },
      { cell: north, open: openZ[north]! * dx },
    ];
    let neighbour = -1,
      aperture = 0;
    for (const { cell, open } of faces)
      if (open > aperture || (open > 0 && open === aperture && cell < neighbour)) {
        aperture = open;
        neighbour = cell;
      }
    if (neighbour < 0) {
      if (old === 1 && next === 1) return undefined;
      throw bad('The small cut cell has no open face to wet water; use a narrower obstacle or a shorter common step.');
    }
    return {
      cut,
      neighbour,
      from: 2 - (old + occupiedStart[neighbour]!),
      to: 2 - (next + occupiedEnd[neighbour]!),
    };
  }
  return undefined;
}

/** Project intensive states without changing their joint extensive quantity. */
function mergeState(state: Float64Array, merge: CutCellMerge, occupiedStart: Float64Array): void {
  const { cut, neighbour, from } = merge;
  const reference = state[neighbour]!;
  state[cut] = state[neighbour] = reference + ((1 - occupiedStart[cut]!) / from) * (state[cut]! - reference);
}

type WaterState = readonly [Float64Array, Float64Array, Float64Array];

/** Use the same beginning/end geometry in both stages and evolve the aggregate before dividing by its storage. */
function evolveStage(
  before: WaterState,
  after: WaterState,
  geometry: CylinderGeometry,
  merge: CutCellMerge | undefined,
  first: Rates,
  dt: number,
  second?: Rates,
): void {
  const { occupiedStart, occupiedEnd } = geometry;
  const scale = second ? 0.5 * dt : dt;
  for (const [axis, name] of (['depth', 'x', 'z'] as const).entries()) {
    const start = before[axis]!,
      state = after[axis]!,
      a = first[name],
      b = second?.[name];
    for (let k = 0; k < start.length; k++) {
      if (k === merge?.cut || k === merge?.neighbour) continue;
      const from = 1 - occupiedStart[k]!,
        to = 1 - occupiedEnd[k]!;
      // A solid cell throughout the substep owns neither storage nor open-face flux.
      if (from === 0 && to === 0) {
        state[k] = start[k]!;
        continue;
      }
      if (!(from > 0 && to > 0))
        throw bad('The cut-cell storage cannot be represented; use a narrower footprint or resize the water grid.');
      const rate = b ? a[k]! + b[k]! : a[k]!;
      const value = update(start[k]!, from - to, to, scale * rate);
      state[k] = axis === 0 ? stagedHeight(value) : value;
    }
    if (merge) {
      const { cut, neighbour, from, to } = merge;
      const r0 = a[cut]! + a[neighbour]!;
      const rate = b ? r0 + (b[cut]! + b[neighbour]!) : r0;
      const value = update(start[neighbour]!, from - to, to, scale * rate);
      state[cut] = state[neighbour] = axis === 0 ? stagedHeight(value) : value;
    }
  }
}

function waterEnergy(
  occupied: Float64Array,
  h: Float64Array,
  hu: Float64Array,
  hv: Float64Array,
  referenceDepth: number,
  gravity: number,
): number {
  let energy = 0;
  for (let k = 0; k < h.length; k++) {
    const depth = h[k]!;
    const eta = depth - referenceDepth;
    const x = hu[k]!;
    const z = hv[k]!;
    energy += (1 - occupied[k]!) * ((x * x + z * z) / depth + gravity * eta * eta);
  }
  return energy;
}

export class CylinderBlockage {
  readonly fields: ShallowBlockageFields;
  private readonly footprint: BlockageFootprint;
  private pose!: Region;
  private occupied!: Region;
  private receipt!: Region;
  private host!: SolverHost;

  constructor(
    id: string,
    private readonly spec: ShallowMovingCylinder | ShallowMovingFootprint,
  ) {
    if (
      !Number.isSafeInteger(spec.bodyRow) ||
      spec.bodyRow < 0 ||
      spec.centre?.length !== 2 ||
      !spec.centre.every(Number.isFinite)
    )
      throw bad('Invalid shallow-water body; pass a body row and finite centre.');
    this.spec = { ...spec, centre: [spec.centre[0], spec.centre[1]] };
    if ('radius' in spec) {
      const r = spec.radius;
      if (!(r > 0 && Number.isFinite(r)))
        throw bad('Invalid shallow-water cylinder radius; pass a positive finite radius.');
      this.footprint = {
        vertices: cylinderFootprint(r),
        low: [-r, -r],
        high: [r, r],
        area: Math.PI * r * r,
        margin: r,
      };
    } else {
      const footprint = spec.footprint && prepareFootprint(spec.footprint);
      if (!footprint)
        throw bad(
          'Invalid shallow-water footprint; pass a strictly convex ordered perimeter enclosing the rigid centre.',
        );
      this.footprint = footprint;
    }
    this.fields = {
      motion: {
        name: `${id}.blockageMotion`,
        kind: 'surfaceSampleSet',
        quantity: 'cylinderMotion',
        unit: 'm',
        centring: 'particle',
      },
      reaction: {
        name: `${id}.blockageReaction`,
        kind: 'surfaceSampleSet',
        quantity: 'cylinderReactionImpulse',
        unit: 'N s, N m s',
        centring: 'particle',
      },
    };
  }

  init(host: SolverHost, grid: ShallowGrid): void {
    if (!(grid.nx >= 3 && grid.nz >= 3 && grid.g > 0) || !grid.sides.every((side) => side === 'periodic'))
      throw bad('A shallow-water blockage needs positive gravity and at least 3×3 periodic cells.');
    const { low, high, area } = this.footprint;
    if (high[0] - low[0] > grid.dx || high[1] - low[1] > grid.dz || !(area <= grid.dx * grid.dz))
      throw bad(
        'The blockage footprint exceeds the cut-cell capacity; fit each extent within one cell and its area within the cell area.',
      );

    this.host = host;
    this.pose = host.allocate('blockage-pose', 2 * 8, 'f64', SHALLOW_BLOCKAGE_LAYOUT);
    this.occupied = host.allocate('blockage-occupied-area', grid.nx * grid.nz * 8, 'f64', SHALLOW_BLOCKAGE_LAYOUT);
    this.receipt = host.allocate(
      'blockage-reaction',
      SHALLOW_BLOCKAGE_REACTION_WORDS * 8,
      'f64',
      SHALLOW_BLOCKAGE_LAYOUT,
    );
    const centre = this.centre(grid, this.spec.centre[0], this.spec.centre[1]);
    this.words(this.pose).set(centre);
    this.words(this.occupied).set(blockageGeometry(grid, this.footprint, centre, centre).occupiedStart);
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }

  private centre(grid: ShallowGrid, x: number, z: number): Point {
    return [wrapped(x - (grid.x0 ?? 0), grid.nx * grid.dx), wrapped(z - (grid.z0 ?? 0), grid.nz * grid.dz)];
  }

  private displacement(from: number, to: number, period: number): number {
    return wrapped(to - from + 0.5 * period, period) - 0.5 * period;
  }

  step(
    grid: ShallowGrid,
    state: Float64Array,
    context: StepContext,
    dt: number,
    density: number,
    courant: number,
  ): number {
    if (!grid.bed.every((value) => value === grid.bed[0]))
      throw bad('Cylinder cut cells currently require a flat bed; remove bed relief or use standard shallow water.');
    const request = context.inputs.get(this.fields.motion.name);
    const rigid = request?.region.layout === SHALLOW_RIGID_BLOCKAGE_LAYOUT;
    const words = rigid ? SHALLOW_RIGID_BLOCKAGE_MOTION_WORDS : SHALLOW_BLOCKAGE_MOTION_WORDS;
    if (
      !request ||
      request.tick !== context.tick ||
      (!rigid && request.region.layout !== SHALLOW_BLOCKAGE_LAYOUT) ||
      request.region.type !== 'f64' ||
      request.region.byteLength !== words * 8 ||
      request.cell.some((value, i) => value !== context.cell[i])
    )
      throw bad(
        'Missing exact-tick shallow-water cylinder motion; publish the ticket and endpoint in this origin cell.',
      );
    const [ticket, commandX, commandZ, cy, vx, vz, inverseMass] = this.words(request.region);
    if (!(Number.isSafeInteger(ticket) && ticket! > 0 && [commandX, commandZ, cy].every(Number.isFinite)))
      throw bad(
        'Invalid cylinder motion; publish a positive integer ticket and finite endpoint and centre-of-mass elevation.',
      );
    const pose = this.words(this.pose);
    if (rigid) {
      if (!(Number.isFinite(vx) && Number.isFinite(vz) && Number.isFinite(inverseMass) && inverseMass! > 0))
        throw bad(
          'Invalid cylinder mobility; bind a live dynamic body with finite horizontal velocity and positive inverse mass.',
        );
      const spanX = grid.nx * grid.dx;
      const spanZ = grid.nz * grid.dz;
      if (Math.abs(vx! * dt) >= spanX / 2 || Math.abs(vz! * dt) >= spanZ / 2)
        throw bad(
          'The rigid cylinder crosses half the periodic domain in one tick; use a larger domain or a smaller common step.',
        );
      const [x, z] = this.centre(grid, commandX! - vx! * dt, commandZ! - vz! * dt);
      const deltaX = this.displacement(pose[0]!, x, spanX);
      const deltaZ = this.displacement(pose[1]!, z, spanZ);
      // The initial obstacle must coincide with the body. Later, the
      // predicted and actual footprints must overlap around their centres.
      const limit =
        context.tick === 0 ? Math.max(1, Math.abs(commandX!), Math.abs(commandZ!)) / 8388608 : this.footprint.margin;
      if (deltaX * deltaX + deltaZ * deltaZ > limit * limit)
        throw bad(
          'The rigid pose is outside its water footprint; match the initial centre and use guided motion at a smaller step.',
        );
    }
    const centre = this.centre(grid, commandX!, commandZ!);
    const dx = this.displacement(pose[0]!, centre[0], grid.nx * grid.dx);
    const dz = this.displacement(pose[1]!, centre[1], grid.nz * grid.dz);
    const wallVelocity: Point = [dx / dt, dz / dt];
    const cellArea = grid.dx * grid.dz;
    const mergeSmallCells = this.footprint.area > UNMERGED_AREA_FRACTION * cellArea;
    // A pair's aggregate is at least half open because the one obstacle occupies at most one cell.
    const cutAreaLowerBound = 1 - (mergeSmallCells ? UNMERGED_AREA_FRACTION : this.footprint.area / cellArea);
    const n = grid.nx * grid.nz;
    const h = new Float64Array(n);
    const hu = new Float64Array(n);
    const hv = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      h[k] = stagedHeight(state[3 * k]!);
      hu[k] = state[3 * k + 1]!;
      hv[k] = state[3 * k + 2]!;
    }
    const referenceDepth = h[0]!;
    const energyFactor = 0.5 * density * grid.dx * grid.dz;
    const beforeEnergy = rigid
      ? energyFactor * waterEnergy(this.words(this.occupied), h, hu, hv, referenceDepth, grid.g)
      : 0;
    const h1 = new Float64Array(n);
    const hu1 = new Float64Array(n);
    const hv1 = new Float64Array(n);
    const impulse: Impulse = [0, 0, 0, 0, 0, 0];
    let elapsed = 0;
    let substeps = 0;
    let geometry: CylinderGeometry | undefined;
    while (elapsed < dt) {
      let rate = Math.abs(wallVelocity[0]) / grid.dx + Math.abs(wallVelocity[1]) / grid.dz;
      let advection = rate,
        waves = 0;
      for (let k = 0; k < n; k++) {
        const c = Math.sqrt(grid.g * h[k]!);
        const x = Math.abs(velocityOf(h[k]!, hu[k]!)) + Math.abs(wallVelocity[0]) + c;
        const z = Math.abs(velocityOf(h[k]!, hv[k]!)) + Math.abs(wallVelocity[1]) + c;
        rate = Math.max(rate, x / grid.dx + z / grid.dz);
        if (mergeSmallCells) {
          advection = Math.max(advection, (x - c) / grid.dx + (z - c) / grid.dz);
          waves = Math.max(waves, c);
        }
      }
      if (mergeSmallCells) rate = Math.max(rate, advection + waves * (1 / grid.dx + 1 / grid.dz));
      const sub = Math.min(dt - elapsed, (courant * cutAreaLowerBound) / rate);
      if (!(sub > 0 && Number.isFinite(sub) && elapsed + sub > elapsed))
        throw bad(
          'The cylinder step cannot resolve these wave speeds; use finite motion and water depth at a smaller scale.',
        );
      const start: Point = [pose[0]! + elapsed * wallVelocity[0], pose[1]! + elapsed * wallVelocity[1]];
      const end: Point = [start[0] + sub * wallVelocity[0], start[1] + sub * wallVelocity[1]];
      geometry = blockageGeometry(grid, this.footprint, start, end);
      const merge = mergeSmallCells
        ? smallCutCellMerge(grid, geometry, [end[0] - start[0], end[1] - start[1]])
        : undefined;
      const before = [h, hu, hv] as const;
      const staged = [h1, hu1, hv1] as const;
      if (merge) for (const component of before) mergeState(component, merge, geometry.occupiedStart);
      const r0 = rates(grid, geometry, h, hu, hv, wallVelocity, cy!);
      evolveStage(before, staged, geometry, merge, r0, sub);
      const r1 = rates(grid, geometry, h1, hu1, hv1, wallVelocity, cy!);
      evolveStage(before, before, geometry, merge, r0, sub, r1);
      for (let k = 0; k < impulse.length; k++) impulse[k]! += 0.5 * sub * density * (r0.force[k]! + r1.force[k]!);
      elapsed += sub;
      substeps++;
    }
    if (!impulse.every(Number.isFinite) || !hu.every(Number.isFinite) || !hv.every(Number.isFinite))
      throw bad('A shallow-water cylinder produced nonfinite momentum; use finite motion within its wet-flow regime.');
    if (rigid) {
      const afterEnergy = energyFactor * waterEnergy(geometry!.occupiedEnd, h, hu, hv, referenceDepth, grid.g);
      // The registry stores the summed impulse in f32; the rigid integrator
      // multiplies that impulse and adds it to velocity in the same precision.
      const nextX = Math.fround(vx! + Math.fround(inverseMass! * Math.fround(impulse[0])));
      const nextZ = Math.fround(vz! + Math.fround(inverseMass! * Math.fround(impulse[2])));
      const bodyWork = ((nextX - vx!) * (nextX + vx!) + (nextZ - vz!) * (nextZ + vz!)) / (2 * inverseMass!);
      const exchange = afterEnergy - beforeEnergy + bodyWork;
      // The free-surface reference energy cancels at fixed volume and solid
      // area. This budget covers the finite-volume sums and impulse products.
      const budget = 64 * (n + substeps) * Number.EPSILON * (afterEnergy + beforeEnergy + Math.abs(bodyWork));
      if (!Number.isFinite(exchange) || exchange > budget)
        throw bad(
          'This cylinder step would create coupled energy; use a heavier guided body or a smaller common step.',
        );
    }
    for (let k = 0; k < n; k++) {
      state[3 * k] = h[k]!;
      state[3 * k + 1] = hu[k]!;
      state[3 * k + 2] = hv[k]!;
    }
    pose.set(centre);
    this.words(this.occupied).set(geometry!.occupiedEnd);
    this.words(this.receipt).set([ticket!, this.spec.bodyRow, ...impulse]);
    return substeps;
  }

  reaction(tick: number, cell: StepContext['cell']): Port {
    return { field: this.fields.reaction.name, region: this.receipt, cell, tick };
  }

  states(): readonly Region[] {
    return [this.pose, this.occupied, this.receipt];
  }

  occupiedFractions(): Float64Array {
    return this.words(this.occupied);
  }

  volume(state: Float64Array, cellArea: number): number {
    const occupied = this.occupiedFractions();
    let total = 0;
    for (let k = 0; k < occupied.length; k++) total += (1 - occupied[k]!) * state[3 * k]!;
    return total * cellArea;
  }
}
