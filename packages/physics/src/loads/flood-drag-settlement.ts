import type { ShallowWaterParams, ShallowWaterSolver } from '../hydro/index.js';
import { regionWords } from '../world/memory.js';
import {
  type Cell,
  type FieldDescriptor,
  type FieldUse,
  isRateLevel,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import {
  BODIES_FIELD,
  BODY_IMPULSES_FIELD,
  BODY_MOBILITY_FIELD,
  BODY_WORDS,
  bodyRowsOf,
  IMPULSE_WORDS,
} from '../world/solvers/rigid.js';
import { invalidLoad } from './errors.js';
import {
  type FloodBodyDragBody,
  type FloodDragProfile,
  floodDragProfiles,
  solveFloodProfile,
} from './flood-body-drag.js';
import { FloodDragGrid, type PeriodicDragAxes } from './flood-drag-grid.js';
import { rigidMobilityWords } from './rigid-mobility.js';

/** Fixed-origin, same-rate participants for a projected drag exchange. */
export interface ProjectedFloodDragOptions {
  readonly id?: string;
  readonly rigidId?: string;
  readonly rate?: RateLevel;
  /** Read the rigid body's axis locks (default true). Disable to restore a matching legacy scene checkpoint. */
  readonly readMobility?: boolean;
  readonly signal?: AbortSignal;
}

export interface ProjectedFloodDragCoupling {
  readonly water: ShallowWaterSolver;
  readonly request: Solver<Record<string, never>>;
  readonly relay: Solver<Record<string, never>>;
  readonly order: readonly [string, string, string, string];
  /** Optional layout-1 request (configured f32 rigid records) and accepted receipt (f64 six-word rigid wrenches). */
  readonly fields: { readonly request: FieldDescriptor; readonly receipt: FieldDescriptor };
}

const ZERO: Cell = [0, 0, 0];
const LAYOUT = 1;
const RIGID_BODY_LAYOUT = 2;

function sameCell(a: Cell, b: Cell): boolean {
  return a.every((coordinate, axis) => coordinate === b[axis]);
}

/** Hydro owns this state; requests are fixed-layout snapshots, with one writer. */
export class ProjectedFloodDragWater {
  readonly fields: ProjectedFloodDragCoupling['fields'];
  readonly mobilityFields: readonly FieldUse[];
  private host!: SolverHost;
  private grid!: FloodDragGrid;
  private periodic!: PeriodicDragAxes;
  private receiptState!: Region;
  private waterWork!: Float64Array<ArrayBuffer>;
  private receiptWork!: Float64Array<ArrayBuffer>;

  constructor(
    waterId: string,
    private readonly profiles: readonly FloodDragProfile[],
    readonly rate: RateLevel,
    readMobility: boolean,
  ) {
    this.mobilityFields = readMobility ? [{ field: BODY_MOBILITY_FIELD, access: 'read', optional: true }] : [];
    this.fields = {
      request: {
        name: `${waterId}.projectedDragRequest`,
        kind: 'surfaceSampleSet',
        quantity: 'projectedDragRequest',
        unit: 'm, m/s, rad/s, 1/kg, 1/(kg m^2)',
        centring: 'particle',
      },
      receipt: {
        name: `${waterId}.projectedDragReceipt`,
        kind: 'bodySet',
        quantity: 'acceptedHydrodynamicImpulse',
        unit: 'N s, N m s',
        centring: 'particle',
      },
    };
  }

  init(host: SolverHost, params: ShallowWaterParams, periodic: PeriodicDragAxes): void {
    if (params.timeScale !== undefined && params.timeScale !== 1)
      throw invalidLoad('Use unit shallow-water time scale for the paired projected drag impulse.');
    this.grid = new FloodDragGrid(params);
    this.periodic = periodic;
    this.host = host;
    if (!sameCell(host.cell, params.bed.cell))
      throw invalidLoad('Register Hydro in the same origin cell as the bed used for projected drag.');
    const size =
      bodyRowsOf(
        host,
        this.fields.receipt.name,
        this.profiles.map(({ row }) => row),
      ) * IMPULSE_WORDS;
    this.receiptState = host.allocate('projected-drag-accepted', size * 8, 'f64', LAYOUT);
    this.receiptWork = new Float64Array(size);
    this.waterWork = new Float64Array(this.grid.count * 3);
  }

  request({ cell, inputs, level, tick }: StepContext): { body: Float32Array; mobility: Float32Array | undefined } {
    const port = inputs.get(this.fields.request.name);
    if (
      !port ||
      port.tick !== tick ||
      level !== this.rate ||
      !sameCell(port.cell, cell) ||
      port.region.type !== 'f32' ||
      port.region.layout !== LAYOUT ||
      port.region.byteLength !== this.profiles.length * BODY_WORDS * 4
    )
      throw invalidLoad('Run the projected drag request before water at the same rate and in the same origin cell.');
    return {
      body: regionWords(this.host.memory, port.region) as Float32Array,
      mobility: rigidMobilityWords(
        this.host.memory,
        inputs.get(BODY_MOBILITY_FIELD.name),
        tick - 1,
        cell,
        this.receiptWork.length / IMPULSE_WORDS,
      ),
    };
  }

  settle(
    request: ReturnType<ProjectedFloodDragWater['request']>,
    water: Float64Array,
    bottom: Float64Array,
    dt: number,
  ): void {
    const { waterWork, receiptWork, grid, profiles } = this;
    waterWork.set(water);
    receiptWork.fill(0);
    const densityArea = grid.density * grid.cellArea;
    const cell = this.host.cell;
    for (const [record, profile] of profiles.entries()) {
      const result = solveFloodProfile(grid, profile, request.body, record * BODY_WORDS, cell, {
        water: waterWork,
        waterCell: cell,
        dt,
        bottom,
        periodic: this.periodic,
        mobility: request.mobility,
      });
      if (!result) continue;
      const { exchange, sample, bodyCentre } = result;
      const at = profile.row * IMPULSE_WORDS;
      for (const [sampleIndex, [cell, impulseX, impulseZ]] of exchange.cellImpulses.entries()) {
        const x = 3 * cell + 1;
        const z = x + 1;
        const oldX = waterWork[x]!;
        const oldZ = waterWork[z]!;
        const newX = oldX + impulseX / densityArea;
        const newZ = oldZ + impulseZ / densityArea;
        const jx = (oldX - newX) * densityArea;
        const jz = (oldZ - newZ) * densityArea;
        const point = sample.cells[sampleIndex]!;
        const rx = point.x - bodyCentre[0];
        const ry = point.wetCentre - bodyCentre[1];
        const rz = point.z - bodyCentre[2];
        waterWork[x] = newX;
        waterWork[z] = newZ;
        receiptWork[at]! += jx;
        receiptWork[at + 2]! += jz;
        receiptWork[at + 3]! += ry * jz;
        receiptWork[at + 4]! += rz * jx - rx * jz;
        receiptWork[at + 5]! -= ry * jx;
      }
    }
    if (!waterWork.every(Number.isFinite) || !receiptWork.every(Number.isFinite))
      throw invalidLoad('Choose a finite projected drag impulse and shallow-water velocity.');
    water.set(waterWork);
    (regionWords(this.host.memory, this.receiptState) as Float64Array).set(receiptWork);
  }

  receipt(tick: number, cell: Cell): Port {
    return { field: this.fields.receipt.name, region: this.receiptState, tick, cell };
  }

  stateRegions(): readonly Region[] {
    return [this.receiptState];
  }
}

export function projectedFloodDragCoupling(
  water: ShallowWaterSolver,
  bodies: readonly FloodBodyDragBody[],
  options: ProjectedFloodDragOptions,
): { readonly endpoint: ProjectedFloodDragWater; readonly coupling: ProjectedFloodDragCoupling } {
  const profiles = floodDragProfiles(bodies);
  const rate = options.rate ?? 0;
  if (!isRateLevel(rate))
    throw invalidLoad('Choose a common projected drag, shallow-water and rigid rate from 0 to 7.');
  const waterId = options.id ?? 'water';
  const rigidId = options.rigidId ?? 'rigid';
  const endpoint = new ProjectedFloodDragWater(waterId, profiles, rate, options.readMobility ?? true);
  const { request: requestField, receipt: receiptField } = endpoint.fields;
  const requestId = `${waterId}.projectedDrag`;
  const relayId = `${waterId}.projectedDragRelay`;
  const rows = profiles.map(({ row }) => row);
  let requestHost: SolverHost;
  let requestState: Region;
  let requestBodyRows: number;
  const request: ProjectedFloodDragCoupling['request'] = {
    describe: () => ({
      id: requestId,
      rate,
      stableRate: () => rate,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: requestField, access: 'write' },
      ],
    }),
    init(host) {
      requestHost = host;
      requestBodyRows = bodyRowsOf(host, requestId, rows);
      requestState = host.allocate('projected-drag-request', profiles.length * BODY_WORDS * 4, 'f32', LAYOUT);
    },
    step({ inputs, tick, cell, level }) {
      const body = inputs.get(BODIES_FIELD.name);
      if (
        !body ||
        body.tick !== tick - 1 ||
        level !== rate ||
        !sameCell(body.cell, cell) ||
        body.region.type !== 'f32' ||
        body.region.layout !== RIGID_BODY_LAYOUT ||
        body.region.byteLength !== requestBodyRows * BODY_WORDS * 4
      )
        throw invalidLoad(
          'Run the projected drag request before the same-rate rigid solver in the fixed water origin.',
        );
      const state = regionWords(requestHost.memory, body.region) as Float32Array;
      const out = regionWords(requestHost.memory, requestState) as Float32Array;
      for (const [record, row] of rows.entries()) {
        const at = row * BODY_WORDS;
        out.set(state.subarray(at, at + BODY_WORDS), record * BODY_WORDS);
      }
    },
    importPorts() {},
    exportPorts: (tick) => [{ field: requestField.name, region: requestState, tick, cell: ZERO }],
    stateRegions: () => [requestState],
    extraState: () => [],
  };

  let relayHost: SolverHost;
  let relayState: Region;
  const relay: ProjectedFloodDragCoupling['relay'] = {
    describe: () => ({
      id: relayId,
      rate,
      stableRate: () => rate,
      fields: [
        { field: receiptField, access: 'read' },
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
      ],
    }),
    init(host) {
      relayHost = host;
      const capacity = bodyRowsOf(host, relayId, rows);
      relayState = host.allocate('projected-drag-relay', capacity * IMPULSE_WORDS * 8, 'f64', LAYOUT);
    },
    step({ inputs, tick, cell, level }) {
      const receipt = inputs.get(receiptField.name);
      const body = inputs.get(BODIES_FIELD.name);
      if (
        !receipt ||
        receipt.tick !== tick ||
        body?.tick !== tick - 1 ||
        level !== rate ||
        !sameCell(receipt.cell, cell) ||
        receipt.region.type !== 'f64' ||
        receipt.region.layout !== LAYOUT ||
        receipt.region.byteLength !== relayState.byteLength
      )
        throw invalidLoad('Put the projected drag relay after water and before the same-rate rigid solver.');
      (regionWords(relayHost.memory, relayState) as Float64Array).set(regionWords(relayHost.memory, receipt.region));
    },
    importPorts() {},
    exportPorts: (tick) => [{ field: BODY_IMPULSES_FIELD.name, region: relayState, tick, cell: ZERO }],
    stateRegions: () => [relayState],
    extraState: () => [],
  };
  return {
    endpoint,
    coupling: { water, request, relay, order: [requestId, waterId, relayId, rigidId], fields: endpoint.fields },
  };
}
