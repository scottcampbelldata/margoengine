import { RealFft2 } from '@margoengine/math/fft';
import { gravityMagnitude } from '@margoengine/math/gravity';
import {
  ProjectedWakeSource,
  SUBMERGED_WAKE_LAYOUT,
  SUBMERGED_WAKE_MAX_CELLS,
  SUBMERGED_WAKE_MAX_ROWS,
  SUBMERGED_WAKE_QUANTITY,
  SUBMERGED_WAKE_WORDS,
  type SubmergedWakeSource,
  wakeDepths,
} from '../sea/submerged-wake.js';
import { WAKE_HEIGHT_FIELD, WAKE_LAYOUT, type WakeParams } from '../sea/wake.js';
import { regionWords } from '../world/memory.js';
import type { Port, Region, Solver, SolverDescription, SolverHost, StepContext } from '../world/solver.js';
import { invalidLoad } from './errors.js';

type WakeGrid = Readonly<Required<Pick<WakeParams, 'cells' | 'cellSize' | 'centre' | 'depth' | 'density'>>>;

/** Geometry and density of the wake taking the scripted hull's volume. */
export interface PrescribedWakeWorkOptions {
  /** The same displaced-volume field the receiving WakeSolver reads. */
  readonly source: SubmergedWakeSource;
  /** The complete receiving grid. Use these values for WakeSolver too. */
  readonly grid: WakeGrid;
  /** Record energy of the wet half of a symmetric image domain. Defaults to false. */
  readonly mirrored?: boolean;
}

/**
 * Books the work of a prescribed hull's projected volume kick. The wave is advanced by the receiving
 * WakeSolver. Use the same submerged port as the wake, with no other volume or pressure forcing in that
 * wake. Order the volume publisher, this meter, then the wake in the same 60 Hz staggered group.
 * The work includes the kick's quadratic term and excludes later wave dissipation.
 */
export class PrescribedWakeWork implements Solver<undefined> {
  private readonly options: PrescribedWakeWorkOptions;
  private readonly projector: ProjectedWakeSource;
  private readonly fft: RealFft2;
  private readonly spectrum: Float64Array;
  private readonly displacement: Float64Array;
  private host!: SolverHost;
  private values!: Region;
  private scale = 0;

  constructor(
    options: PrescribedWakeWorkOptions,
    readonly id = 'prescribedWakeWork',
  ) {
    const grid = options?.grid;
    const source = options?.source;
    if (
      !source?.field?.name ||
      source.field.kind !== 'surfaceSampleSet' ||
      source.field.quantity !== SUBMERGED_WAKE_QUANTITY ||
      source.field.unit !== 'SI'
    )
      throw invalidLoad('Pass the same submerged SI source field that drives the receiving wake.');
    if (
      !grid?.cells ||
      grid.cells.length !== 2 ||
      !grid.cells.every((side) => {
        if (!Number.isSafeInteger(side) || side < 4) return false;
        for (const factor of [2, 3, 5]) while (side % factor === 0) side /= factor;
        return side === 1;
      }) ||
      grid.cells[0] % 2 !== 0 ||
      grid.cells[0] * grid.cells[1] > SUBMERGED_WAKE_MAX_CELLS ||
      !grid.centre ||
      grid.centre.length !== 2 ||
      !grid.centre.every(Number.isFinite) ||
      !(grid.cellSize > 0 && Number.isFinite(grid.cellSize)) ||
      !(grid.density > 0 && Number.isFinite(grid.density) && grid.depth > 0) ||
      (options.mirrored !== undefined && typeof options.mirrored !== 'boolean') ||
      (options.mirrored && grid.cells[1] % 2 !== 0)
    )
      throw invalidLoad(
        'Use the bounded even-X wake grid, finite positive spacing and density, and positive depth. Use an even Z size for a mirror domain.',
      );
    const depths = wakeDepths(source.depths);
    const [nx, nz] = grid.cells;
    const [x, z] = grid.centre;
    this.options = {
      ...options,
      source: { field: Object.freeze({ ...source.field }), depths },
      grid: {
        ...grid,
        cells: [nx, nz],
        centre: [x, z],
      },
    };
    const dx = grid.cellSize;
    this.fft = new RealFft2(nx, nz);
    this.projector = new ProjectedWakeSource(
      { nx, nz, dx, x0: x - (nx * dx) / 2, z0: z - (nz * dx) / 2 },
      depths,
      grid.depth,
    );
    this.spectrum = new Float64Array(2 * (nx / 2 + 1) * nz);
    this.displacement = new Float64Array(nx * nz);
  }

  /** The receiving grid settings alongside optional propagation and initial-state settings. */
  wakeParams(options: Pick<WakeParams, 'initial' | 'sponge' | 'waterBelow'> = {}): WakeParams {
    return { ...options, ...this.options.grid };
  }

  /** Last prescribed work increment and total signed work in joules. */
  work(): { step: number; total: number } {
    if (!this.host) throw invalidLoad('Add the prescribed wake work meter to its world before reading it.');
    const values = regionWords(this.host.memory, this.values) as Float64Array;
    return { step: values[0]!, total: values[1]! };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: this.options.source.field, access: 'read' },
        { field: WAKE_HEIGHT_FIELD, access: 'read' },
      ],
    };
  }

  init(host: SolverHost): void {
    const gravity = gravityMagnitude(host.gravity);
    const { density, cellSize } = this.options.grid;
    const scale = density * gravity * cellSize * cellSize * (this.options.mirrored ? 0.5 : 1);
    if (!(scale > 0 && Number.isFinite(scale)))
      throw invalidLoad('Set positive finite world gravity and a finite wake cell area before adding the work meter.');
    this.host = host;
    this.scale = scale;
    this.values = host.allocate('prescribed-work', 24, 'f64', 1);
  }

  step({ inputs, tick, cell }: StepContext): void {
    const source = inputs.get(this.options.source.field.name);
    const wake = inputs.get(WAKE_HEIGHT_FIELD.name);
    const bytesPerRow = 8 * SUBMERGED_WAKE_WORDS;
    if (
      !source ||
      source.tick !== tick ||
      source.region.type !== 'f64' ||
      source.region.layout !== SUBMERGED_WAKE_LAYOUT ||
      source.region.byteLength % bytesPerRow !== 0 ||
      source.region.byteLength / bytesPerRow > SUBMERGED_WAKE_MAX_ROWS ||
      !wake ||
      wake.tick !== tick - 1 ||
      wake.region.type !== 'f64' ||
      wake.region.layout !== WAKE_LAYOUT ||
      wake.region.byteLength !== this.displacement.byteLength ||
      !cell.every((coordinate, i) => coordinate === source.cell[i] && coordinate === wake.cell[i])
    )
      throw invalidLoad(
        'Step the matching volume publisher, prescribed wake work meter and receiving wake in that order in one cell.',
      );
    const memory = this.host.memory;
    const rows = regionWords(memory, source.region) as Float64Array;
    this.spectrum.fill(0);
    this.projector.add(rows, this.fft, this.spectrum);
    let increment = 0;
    if (this.projector.bands > 0) {
      const eta = regionWords(memory, wake.region) as Float64Array;
      this.fft.inverse(this.spectrum, this.displacement);
      for (let i = 0; i < this.displacement.length; i++) {
        const delta = this.displacement[i]!;
        increment += delta * (eta[i]! + 0.5 * delta);
      }
      increment *= this.scale;
    }
    const values = regionWords(memory, this.values) as Float64Array;
    // Sum through seek as well as continuous playback; the compensation is part of snapshot state.
    const corrected = increment - values[2]!;
    const total = values[1]! + corrected;
    if (!Number.isFinite(increment) || !Number.isFinite(total))
      throw invalidLoad('Use finite wake heights and displacements before adding the prescribed hull work.');
    values[0] = increment;
    values[2] = total - values[1]! - corrected;
    values[1] = total;
  }

  exportPorts(): readonly Port[] {
    return [];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.values];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
