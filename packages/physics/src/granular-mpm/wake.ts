import { MargoError } from '@margoengine/math/errors';
import type { Vec3 } from '@margoengine/math';
import type { Bed } from '@margoengine/math/fields';
import { hypot } from '@margoengine/math/pinned';
import { SWIM_WAKE_FIELD, SWIM_WAKE_LAYOUT, SWIM_WAKE_WORDS } from '../life/wake.js';
import { regionWords } from '../world/memory.js';
import type { Cell, Region, SolverHost, StepContext } from '../world/solver.js';

export type WakeKernel = (points: number, kicks: number, count: number, jet: number) => number;

type Delivered = { tick: number; x: number; z: number };

/** Transfers the tangential part of a live swimmer's bed-directed impulse to the material points. */
export class GranularWake {
  readonly kicks: Region;
  readonly ledger: Region;
  private readonly jet: Region;
  private readonly zero: Delivered = { tick: -1, x: 0, z: 0 };

  constructor(
    private readonly host: SolverHost,
    private readonly bed: Bed,
    private readonly depth: number,
    private readonly fraction: number,
    private readonly cellSize: number,
    count: number,
    private readonly kernel: WakeKernel,
  ) {
    this.kicks = host.allocate('granular-wake-kicks', count * 3 * 8, 'f64', 1);
    this.ledger = host.allocate('granular-wake-clock-and-impulse', 3 * 8, 'f64', 1);
    this.jet = host.allocate('granular-wake-footprint', 8 * 8, 'f64', 1);
    this.words(this.ledger)[0] = -1;
  }

  prepare(context: StepContext, points: Region, count: number): Delivered {
    this.words(this.kicks).fill(0);
    const wake = context.inputs.get(SWIM_WAKE_FIELD.name);
    if (!wake || wake.tick <= this.words(this.ledger)[0]!) return this.zero;
    const region = wake.region;
    if (region.layout !== SWIM_WAKE_LAYOUT || region.type !== 'f64' || region.byteLength % (8 * SWIM_WAKE_WORDS))
      throw new MargoError('state', 'Connect the layout-1 swim wake impulse port.');
    const source = regionWords(region.memory ?? this.host.memory, region) as Float64Array;
    const intoSolver = this.offset(wake.cell, context.cell);
    const intoBed = this.offset(context.cell, this.bed.cell);
    const sample = { elevation: 0, normal: [0, 1, 0] as [number, number, number] };
    const state = this.words(this.jet);
    const delivered = { tick: wake.tick, x: 0, z: 0 };
    for (let i = 0; i < source.length; i += SWIM_WAKE_WORDS) {
      const x = source[i]! + intoSolver[0];
      const y = source[i + 1]! + intoSolver[1];
      const z = source[i + 2]! + intoSolver[2];
      const down = -source[i + 4]!;
      const spread = source[i + 6]!;
      if (!(down > 0 && spread > 0 && source[i + 7]! > 0)) continue;
      const surface = this.bed.sample(x + intoBed[0], z + intoBed[2], sample).elevation - intoBed[1];
      const height = y - surface;
      if (!(height > 0)) continue;
      const dx = (height * source[i + 3]!) / down;
      const dz = (height * source[i + 5]!) / down;
      const cx = x + dx;
      const cz = z + dz;
      const elevation = this.bed.sample(cx + intoBed[0], cz + intoBed[2], sample).elevation - intoBed[1];
      const radius = spread + 0.1 * hypot(dx, height, dz);
      const ix = this.fraction * source[i + 3]!;
      const iz = this.fraction * source[i + 5]!;
      if (!(y > elevation && Number.isFinite(radius))) continue;
      state.set([cx, cz, elevation, radius, this.depth, ix, iz, this.fraction * down]);
      const captured = this.kernel(points.byteOffset, this.kicks.byteOffset, count, this.jet.byteOffset);
      delivered.x += ix * captured;
      delivered.z += iz * captured;
    }
    return delivered;
  }

  commit(delivered: Delivered): void {
    if (delivered.tick < 0) return;
    const state = this.words(this.ledger);
    state[0] = delivered.tick;
    state[1] = state[1]! + delivered.x;
    state[2] = state[2]! + delivered.z;
  }

  get impulse(): Vec3 {
    const state = this.words(this.ledger);
    return [state[1]!, 0, state[2]!];
  }

  private offset(from: Cell, to: Cell): Vec3 {
    return [(from[0] - to[0]) * this.cellSize, (from[1] - to[1]) * this.cellSize, (from[2] - to[2]) * this.cellSize];
  }

  private words(region: Region): Float64Array {
    return regionWords(this.host.memory, region) as Float64Array;
  }
}
