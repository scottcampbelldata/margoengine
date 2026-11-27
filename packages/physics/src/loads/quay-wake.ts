import {
  SUBMERGED_WAKE_LAYOUT,
  SUBMERGED_WAKE_MAX_ROWS,
  SUBMERGED_WAKE_QUANTITY,
  SUBMERGED_WAKE_WORDS,
  type SubmergedWakeSource,
} from '../sea/submerged-wake.js';
import {
  WAKE_SOURCE_LAYOUT,
  WAKE_SOURCE_WORDS,
  type WakeParams,
  type WakeSample,
  type WakeSolver,
} from '../sea/wake.js';
import { regionWords } from '../world/memory.js';
import type { FieldDescriptor, Port, Region, Solver, SolverDescription, SolverHost, StepContext } from '../world/solver.js';
import { invalidLoad } from './errors.js';

/** The vertical quay is parallel to X and has water on its +Z side. */
export interface QuayWakeOptions {
  /** The physical wet face, in metres in the wake grid's cell. */
  readonly wallZ: number;
  /** Optional advancing hull surface pressure and displaced volume field. */
  readonly surface?: FieldDescriptor;
  /** Optional projected submerged hull displacement and its depth band edges. */
  readonly submerged?: SubmergedWakeSource;
}

interface SourcePair {
  readonly input: FieldDescriptor;
  readonly image: FieldDescriptor;
  readonly words: number;
  readonly layout: number;
  readonly maxRows: number;
}

function activeRow(pair: SourcePair, input: Float64Array, at: number): boolean {
  return input[at + 4] !== 0 || (pair.input.quantity === 'seaSource' && input[at + 3] !== 0);
}

/**
 * Reflects the live dispersive wake at a straight, rigid, fully reflecting quay. Even continuation of the
 * initial surface and the hull forcing leaves the Fourier dispersion operator unchanged and makes the
 * normal gradient of the velocity potential zero at the face. See Rim et al. (2025), section 2,
 * DOI 10.1002/eng2.70041. The negative-Z half is an image domain for the +Z water.
 * Use the straight-wall model away from quay ends, corners, and breaking or overtopping.
 */
export class QuayWakeBoundary implements Solver<undefined> {
  readonly wallZ: number;
  /** Connect to the WakeSolver instead of the original surface field. This field contains original and image rows. */
  readonly surfaceSource?: FieldDescriptor;
  /** Connect to the WakeSolver instead of the original submerged source. Both copies share the original depth bands. */
  readonly submergedSource?: SubmergedWakeSource;
  private readonly pairs: readonly SourcePair[];
  private readonly regions: Region[] = [];
  private host!: SolverHost;

  constructor(options: QuayWakeOptions, readonly id = 'quayWake') {
    if (!Number.isFinite(options?.wallZ)) throw invalidLoad('Set the straight quay face to a finite Z in metres.');
    this.wallZ = options.wallZ;
    const pairs: SourcePair[] = [];
    const bind = (
      input: FieldDescriptor,
      quantity: string,
      suffix: string,
      words: number,
      layout: number,
      maxRows: number,
    ): FieldDescriptor => {
      const image = Object.freeze({ ...input, name: `${id}.${suffix}` });
      if (input?.quantity !== quantity || input.unit !== 'SI' || input.name === image.name)
        throw invalidLoad('Connect a distinct hull wake source field in SI units to the quay.');
      pairs.push({ input: Object.freeze({ ...input }), image, words, layout, maxRows });
      return image;
    };
    if (options.surface)
      this.surfaceSource = bind(options.surface, 'seaSource', 'surface', WAKE_SOURCE_WORDS, WAKE_SOURCE_LAYOUT, Infinity);
    if (options.submerged) {
      const field = bind(
        options.submerged.field,
        SUBMERGED_WAKE_QUANTITY,
        'submerged',
        SUBMERGED_WAKE_WORDS,
        SUBMERGED_WAKE_LAYOUT,
        SUBMERGED_WAKE_MAX_ROWS / 2,
      );
      this.submergedSource = Object.freeze({ field, depths: Object.freeze([...options.submerged.depths]) });
    }
    this.pairs = pairs;
  }

  /** Centres an even number of Z rows at the face, mirrors initial state and callback sources, and preserves the sponge. */
  wakeParams({ centreX = 0, ...params }: Omit<WakeParams, 'centre'> & { readonly centreX?: number } = {}): WakeParams {
    const { cells = [256, 256], initial, sources } = params;
    if (!Number.isInteger(cells[1]) || cells[1] % 2)
      throw invalidLoad('Use an even number of WakeSolver Z rows at a quay.');
    const wall = this.wallZ;
    return {
      ...params,
      cells,
      centre: [centreX, wall],
      initial: initial && ((x, z) => initial(x, wall + Math.abs(z - wall))),
      sources: sources && ((time) => sources(time).flatMap((source) => [source, { ...source, z: this.reflectedZ(source.z) }])),
    };
  }

  /** Reads actual height (m), slopes and velocity (m/s) at the reflecting face. Positive Y velocity is a rising crest. */
  sampleWall(wake: Pick<WakeSolver, 'sample'>, x: number, out?: WakeSample): WakeSample {
    return wake.sample(x, this.wallZ, out);
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: this.pairs.flatMap(({ input, image }) => [
        { field: input, access: 'read' as const },
        { field: image, access: 'write' as const },
      ]),
    };
  }

  init(host: SolverHost): void {
    this.host = host;
    for (const pair of this.pairs) {
      const port = this.sourcePort(host.port(pair.input.name), pair);
      this.regions.push(host.allocate(pair.image.name, 2 * port.region.byteLength, 'f64', pair.layout));
    }
  }

  step({ cell, inputs, tick }: StepContext): void {
    // Reject an invalid source before touching either publication.
    this.pairs.forEach((pair, i) => {
      const port = this.sourcePort(inputs.get(pair.input.name), pair);
      const { region } = port;
      const output = this.regions[i]!;
      if (2 * region.byteLength !== output.byteLength || port.tick !== tick || cell.some((v, axis) => v !== port.cell[axis]))
        throw invalidLoad('Step the fixed-size hull, quay and wake in that order at 60 Hz in the same cell.');
      const input = regionWords(region.memory ?? this.host.memory, region) as Float64Array;
      for (let at = 0; at < input.length; at += pair.words)
        if (activeRow(pair, input, at)) this.reflectedZ(input[at + 1]!);
    });
    this.pairs.forEach((pair, i) => {
      const { region } = inputs.get(pair.input.name)!;
      const input = regionWords(region.memory ?? this.host.memory, region) as Float64Array;
      const output = this.regions[i]!;
      const both = regionWords(this.host.memory, output) as Float64Array;
      both.set(input);
      both.set(input, input.length);
      for (let at = 0; at < input.length; at += pair.words)
        if (activeRow(pair, input, at)) both[input.length + at + 1] = this.imageZ(input[at + 1]!);
    });
  }

  exportPorts(tick: number): readonly Port[] {
    return this.regions.map((region, i) => ({ field: this.pairs[i]!.image.name, region, tick, cell: this.host.cell }));
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return this.regions;
  }

  extraState(): readonly Region[] {
    return [];
  }

  private sourcePort(port: Port | undefined, { input, words, layout, maxRows }: SourcePair): Port {
    if (
      !port ||
      port.region.type !== 'f64' ||
      port.region.layout !== layout ||
      !port.region.byteLength ||
      port.region.byteLength % (words * 8) ||
      port.region.byteLength / (words * 8) > maxRows
    )
      throw invalidLoad(`Add the hull first and connect its bounded layout-${layout} f64 ${input.quantity} field.`);
    return port;
  }

  private reflectedZ(z: number): number {
    const image = this.imageZ(z);
    if (z < this.wallZ || !Number.isFinite(image))
      throw invalidLoad('Place every active hull wave source at or seaward of the quay face.');
    return image;
  }

  private imageZ(z: number): number {
    return this.wallZ + (this.wallZ - z);
  }
}
