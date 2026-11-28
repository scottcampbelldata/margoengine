import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import { hypot, pow } from '@margoengine/math/pinned';
import { MIN_DIAMETER, STANDARD_DENSITY, STANDARD_TEMPERATURE } from '../airborne/environment.js';
import { regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { BODIES_FIELD } from '../world/solvers/rigid.js';
import { advanceDrop, DropDrag, MAX_FLIGHT_DIAMETER, midpointDropDrag } from './drop-drag.js';
import {
  FILM_IMPACT_WORDS,
  FILM_SWEPT_IMPACT_LAYOUT,
  FILM_SWEPT_IMPACT_WORDS,
  prepareReceiver,
  receiverImpact,
  receiverPose,
  type ReceiverSweep,
  sweepReceiver,
  type ThinFilmDropReceiver,
} from './drop-receiver.js';
import { turningImpact } from './drop-turn.js';
import { FILM_DROP_WORDS } from './drips.js';

type Vec3 = readonly [number, number, number];
const LAYOUT = 1;
const BYTES = 8;

/** Position xyz, velocity xyz, volume, diameter, age and stable ID, all f64. Zero volume denotes an empty row. */
export const FILM_FLIGHT_WORDS = 10;

/**
 * Optional connections of the thin-film drop flight solver: `rigid` reads registered rigid poses for a mounted
 * film receiver (default false).
 */
export interface ThinFilmDropFlightConnections {
  /** Read registered rigid poses for a mounted film receiver. Defaults to false. */
  readonly rigid?: boolean;
}

/**
 * Options for the thin-film drop flight solver: tracked drop capacity (default 256), flight time in s (default
 * 10), origin cell width, water density, surface tension, air density and air temperature, with SI defaults.
 */
export interface ThinFilmDropFlightOptions {
  /** Simultaneously tracked drops. Defaults to 256. */
  readonly capacity?: number;
  /** End the tracked trajectory at this age in seconds. Defaults to 10. */
  readonly flightTime?: number;
  /** Use the same origin-cell width as the issuing film. Defaults to 4096 m. */
  readonly originCellSize?: number;
  /** Liquid water density. Defaults to 998.2 kg/m³. */
  readonly waterDensity?: number;
  /** Liquid water surface tension. Defaults to 0.07275 N/m. */
  readonly surfaceTension?: number;
  /** Uniform background air density without a wind field. Zero gives vacuum. Defaults to 1.225 kg/m³. */
  readonly airDensity?: number;
  /** Uniform background air temperature without a wind field. Defaults to 288.15 K. */
  readonly airTemperature?: number;
  /** Live air velocity, temperature and density in the droplet's neighbourhood. Defaults to still air. */
  readonly wind?: Wind;
  /** Optional absorbing plane, registered at its matching film's free surface. */
  readonly receiver?: ThinFilmDropReceiver;
}

/** One drop in flight: position, velocity, volume, diameter, age and stable ID. */
export interface ThinFilmFlyingDrop {
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  readonly volume: number;
  readonly diameter: number;
  readonly age: number;
  readonly id: number;
}

interface FlightState {
  readonly memory: WebAssembly.Memory;
  readonly gravity: Vec3;
  readonly gravityLength: number;
  readonly capacity: number;
  readonly lifetime: number;
  readonly cellSize: number;
  readonly water: number;
  readonly tension: number;
  readonly air: FlowSample;
  readonly windSample: FlowSample;
  readonly wind?: Wind;
  readonly drag: DropDrag;
  readonly drops: Region;
  readonly candidate: Region;
  readonly meta: Region;
  readonly impacts: Region;
  readonly receiver?: {
    readonly plane: ReturnType<typeof prepareReceiver>;
    readonly draft: Region;
    readonly ledger: Region;
    readonly pose?: Region;
    readonly impactStride: number;
  };
}

function range(name: string, value: number, min: number, max: number): number {
  if (!(Number.isFinite(value) && value >= min && value <= max))
    throw invalid(`Invalid drop flight ${name}. Choose a value in [${min}, ${max}].`);
  return value;
}

function invalid(message: string): RangeError {
  return Object.assign(new RangeError(message), { code: 'PHYSICS_INPUT_RANGE' });
}

function words(s: FlightState, region: Region): Float64Array {
  return regionWords(s.memory, region) as Float64Array;
}

/** Track the emitted drops from a thin-film rim through the surrounding air. */
export class ThinFilmDropFlight implements Solver<ThinFilmDropFlightOptions> {
  readonly particleField: FieldDescriptor;
  readonly impactField: FieldDescriptor;
  private readonly rigid: boolean;
  private state?: FlightState;

  constructor(
    private readonly source: FieldDescriptor,
    private readonly id = 'thin-film-drop-flight',
    { rigid = false }: ThinFilmDropFlightConnections = {},
  ) {
    if (
      source?.kind !== 'surfaceSampleSet' ||
      source.quantity !== 'detachedWaterDrop' ||
      source.centring !== 'particle'
    )
      throw invalid('Drop flight needs a film drop source. Pass the ThinFilmSolver dropsField.');
    this.rigid = rigid;
    this.particleField = Object.freeze({
      name: `${id}.particles`,
      kind: 'surfaceSampleSet',
      quantity: 'flyingWaterDrop',
      unit: 'SI',
      centring: 'particle',
    });
    this.impactField = Object.freeze({
      name: `${id}.impacts`,
      kind: 'surfaceSampleSet',
      quantity: 'thinFilmImpact',
      unit: 'SI',
      centring: 'particle',
    });
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: this.source, access: 'read' },
        ...(this.rigid ? [{ field: BODIES_FIELD, access: 'read' as const }] : []),
        { field: this.particleField, access: 'write' },
        { field: this.impactField, access: 'write' },
      ],
      rate: 0,
      stableRate: () => 0,
    };
  }

  init(host: SolverHost, opts: ThinFilmDropFlightOptions = {}): void {
    if (this.state) throw new MargoError('state', 'Drop flight already belongs to a world. Make a new flight solver.');
    const capacity = opts.capacity ?? 256;
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw invalid('Invalid drop flight capacity. Use a positive whole number of flying drops.');
    const lifetime = range('time in seconds', opts.flightTime ?? 10, Number.MIN_VALUE, Number.MAX_VALUE);
    const cellSize = range('origin cell width', opts.originCellSize ?? 4096, Number.MIN_VALUE, Number.MAX_VALUE);
    const water = range('water density', opts.waterDensity ?? 998.2, 900, 1100);
    const tension = range('surface tension', opts.surfaceTension ?? 0.07275, 0.05, 0.09);
    const air: FlowSample = {
      velocity: [0, 0, 0],
      density: range('air density', opts.airDensity ?? STANDARD_DENSITY, 0, 3),
      temperature: range('air temperature', opts.airTemperature ?? STANDARD_TEMPERATURE, 200, 340),
    };
    const gravityLength = hypot(...host.gravity);
    const plane = opts.receiver === undefined ? undefined : prepareReceiver(opts.receiver);
    const mountedRow = plane?.bodyRow;
    if ((mountedRow !== undefined) !== this.rigid)
      throw invalid('Mounted drop flight needs its rigid connection and receiver bodyRow. Provide both or omit both.');
    const initialPose =
      plane && mountedRow !== undefined ? receiverPose(host.memory, host.port(BODIES_FIELD.name), plane) : undefined;
    const arrayBytes = BYTES * FILM_FLIGHT_WORDS * capacity;
    const drops = host.allocate('flying-drops', arrayBytes, 'f64', LAYOUT);
    const candidate = host.allocate('working-flying-drops', arrayBytes, 'f64', LAYOUT);
    const meta = host.allocate('flight-ledger', BYTES * 9, 'f64', LAYOUT);
    const impactStride = plane?.followsRotation ? FILM_SWEPT_IMPACT_WORDS : FILM_IMPACT_WORDS;
    const impactLayout = plane?.followsRotation ? FILM_SWEPT_IMPACT_LAYOUT : LAYOUT;
    const impactBytes = BYTES * impactStride * (plane ? 2 * capacity : 1);
    const impacts = host.allocate('drop-impacts', impactBytes, 'f64', impactLayout);
    const receiver = plane && {
      plane,
      draft: host.allocate('working-drop-impacts', impactBytes, 'f64', impactLayout),
      ledger: host.allocate('impact-ledger', BYTES * 2, 'f64', LAYOUT),
      pose: initialPose ? host.allocate('receiver-pose', BYTES * initialPose.length, 'f64', impactLayout) : undefined,
      impactStride,
    };
    if (receiver?.pose && initialPose) regionWords(host.memory, receiver.pose).set(initialPose);
    regionWords(host.memory, meta)[1] = -1;
    this.state = {
      memory: host.memory,
      gravity: host.gravity,
      gravityLength,
      capacity,
      lifetime,
      cellSize,
      water,
      tension,
      air,
      windSample: { velocity: [0, 0, 0], density: air.density, temperature: air.temperature },
      wind: opts.wind,
      drag: new DropDrag(gravityLength, water, air.density, air.temperature, tension),
      drops,
      candidate,
      meta,
      impacts,
      receiver,
    };
  }

  private live(): FlightState {
    if (!this.state) throw new MargoError('state', 'Drop flight has no world. Add the solver before reading it.');
    return this.state;
  }

  private carry(
    s: FlightState,
    target: Float64Array,
    at: number,
    interval: number,
    now: number,
    cell: Cell,
    sweep?: ReceiverSweep,
    elapsed?: number,
  ): readonly number[] | undefined {
    if (interval === 0 && !s.receiver) return;
    const wind = s.wind;
    const air =
      wind?.sample(
        target[at]! + 0.5 * interval * target[at + 3]! + (cell[0] - wind.cell[0]) * s.cellSize,
        target[at + 1]! + 0.5 * interval * target[at + 4]! + (cell[1] - wind.cell[1]) * s.cellSize,
        target[at + 2]! + 0.5 * interval * target[at + 5]! + (cell[2] - wind.cell[2]) * s.cellSize,
        now + interval * 0.5,
        s.windSample,
      ) ?? s.air;
    const drag =
      air.density === s.air.density && air.temperature === s.air.temperature
        ? s.drag
        : new DropDrag(
            s.gravityLength,
            s.water,
            range('sampled air density', air.density, 0, 3),
            range('sampled air temperature', air.temperature, 200, 340),
            s.tension,
          );
    if (!air.velocity.every(Number.isFinite))
      throw invalid('Wind returned invalid drop flight velocity. Supply three finite components.');
    const rate = midpointDropDrag(target, at, interval, target[at + 7]!, s.gravity, air.velocity, drag);
    if (s.receiver) {
      const impact = sweep?.turn
        ? turningImpact(
            sweep.plane,
            sweep.turn,
            target,
            at,
            interval,
            s.gravity,
            air.velocity,
            drag.buoyancy,
            rate,
            cell,
            s.cellSize,
            elapsed ?? 0,
          )
        : receiverImpact(
            sweep?.plane ?? s.receiver.plane,
            target,
            at,
            interval,
            s.gravity,
            air.velocity,
            drag.buoyancy,
            rate,
            cell,
            s.cellSize,
            sweep?.velocity,
            elapsed,
          );
      if (impact) return impact;
    }
    advanceDrop(target, at, interval, s.gravity, air.velocity, drag.buoyancy, rate);
    target[at + 8]! += interval;
    for (let i = 0; i < 6; i++)
      if (!Number.isFinite(target[at + i]))
        throw new MargoError('failed', 'Drop flight exceeded numeric range. Use finite coordinates and wind speeds.');
  }

  step(context: StepContext, dt: number): void {
    const s = this.live();
    const meta = words(s, s.meta);
    const previous = words(s, s.drops);
    const next = words(s, s.candidate);
    const start = context.tick * dt;
    const origin = context.cell;
    const receiver = s.receiver;
    const pending = receiver && words(s, receiver.draft);
    const capture = receiver && words(s, receiver.ledger);
    const pose = receiver?.pose && words(s, receiver.pose);
    const endPose = pose && receiverPose(s.memory, context.inputs.get(BODIES_FIELD.name), receiver!.plane);
    const sweep = pose && endPose && sweepReceiver(receiver!.plane, pose, endPose, dt, s.cellSize);
    const stride = receiver?.impactStride ?? FILM_IMPACT_WORDS;
    let hits = 0;
    let totalCaptured = capture?.[0] ?? 0;
    let live = 0;
    let last = meta[1]!;
    let id = meta[2]!;
    let received = meta[3]!;
    let outflow = meta[4]!;
    let airborne = 0;
    const record = (impact: readonly number[]) => {
      pending!.set(impact, hits++ * stride);
      totalCaptured += impact[3]!;
    };
    for (let i = 0; i < meta[0]!; i++) {
      const source = FILM_FLIGHT_WORDS * i;
      const age = previous[source + 8]!;
      const volume = previous[source + 6]!;
      const expiring = age + dt >= s.lifetime;
      if (expiring && !receiver) {
        outflow += volume;
        continue;
      }
      const at = live * FILM_FLIGHT_WORDS;
      next.set(previous.subarray(source, source + FILM_FLIGHT_WORDS), at);
      for (let axis = 0; axis < 3; axis++) next[at + axis]! += (meta[6 + axis]! - origin[axis]!) * s.cellSize;
      const impact = this.carry(s, next, at, Math.min(dt, s.lifetime - age), start, origin, sweep);
      if (impact || expiring) {
        if (impact) record(impact);
        outflow += volume;
        continue;
      }
      live++;
      airborne += volume;
    }

    const port = context.inputs.get(this.source.name);
    if (port && port.tick > last) {
      const { region, cell } = port;
      if (region.layout !== LAYOUT || region.type !== 'f64' || region.byteLength % (FILM_DROP_WORDS * BYTES) !== 0)
        throw invalid('Invalid drop flight field layout. Use the layout-1 thin-film drop records.');
      const rows = words(s, region);
      let emitted = 0;
      for (let i = 0; i < rows.length; i += FILM_DROP_WORDS) {
        const count = rows[i + 9]!;
        if (count === 0) continue;
        const volume = rows[i + 6]!;
        const diameter = pow((6 * volume) / Math.PI, 1 / 3);
        const first = rows[i + 7]!;
        const period = rows[i + 8]!;
        const finish = first + (count - 1) * period;
        const tolerance = 64 * Number.EPSILON * dt;
        if (
          !(
            Number.isSafeInteger(count) &&
            count > 0 &&
            volume > 0 &&
            first >= 0 &&
            period > 0 &&
            finish <= dt + tolerance
          )
        )
          throw invalid('Invalid drop flight timing. Use positive thin-film volumes and current-step release offsets.');
        range('drop diameter in metres', diameter, MIN_DIAMETER, MAX_FLIGHT_DIAMETER);
        const expired = receiver ? 0 : Math.max(0, Math.min(count, Math.floor((dt - s.lifetime - first) / period) + 1));
        emitted += count - expired;
        if (emitted > s.capacity || count - expired > s.capacity - live || !Number.isSafeInteger(id + count))
          throw new MargoError(
            'failed',
            'Too many flying drops. Increase flight capacity or reduce the flow or flight time.',
          );
        received += volume * count;
        outflow += volume * expired;
        id += expired;
        for (let event = expired; event < count; event++) {
          const age = Math.max(0, dt - (first + event * period));
          id++;
          const at = live * FILM_FLIGHT_WORDS;
          for (let axis = 0; axis < 3; axis++) {
            const velocity = rows[i + 3 + axis]!;
            const position = rows[i + axis]! + (cell[axis]! - origin[axis]!) * s.cellSize;
            if (!Number.isFinite(position) || !Number.isFinite(velocity))
              throw invalid('Drop flight received an invalid release pose. Publish finite positions and velocities.');
            // Event rows give the rim position at the end of the source step.
            next[at + axis] = position - velocity * age;
            next[at + 3 + axis] = velocity;
          }
          next.set([volume, diameter, 0, id], at + 6);
          const elapsed = dt - age;
          const impact = this.carry(s, next, at, Math.min(age, s.lifetime), start + dt - age, origin, sweep, elapsed);
          if (impact || age >= s.lifetime) {
            if (impact) record(impact);
            outflow += volume;
            continue;
          }
          live++;
          airborne += volume;
        }
      }
      last = port.tick;
    }
    previous.set(next.subarray(0, live * FILM_FLIGHT_WORDS));
    previous.fill(0, live * FILM_FLIGHT_WORDS, meta[0]! * FILM_FLIGHT_WORDS);
    if (pending && capture) {
      const impacts = words(s, s.impacts);
      impacts.set(pending.subarray(0, hits * stride));
      impacts.fill(0, hits * stride, capture[1]! * stride);
      capture.set([totalCaptured, hits]);
    }
    if (pose && endPose) pose.set(endPose);
    meta.set([live, last, id, received, outflow, airborne, ...origin]);
  }

  /** Copy the flying drops in stable emission order. */
  readDrops(): readonly ThinFilmFlyingDrop[] {
    const s = this.live();
    const drops = regionWords(s.memory, s.drops);
    return Array.from({ length: regionWords(s.memory, s.meta)[0]! }, (_, i) => {
      const at = FILM_FLIGHT_WORDS * i;
      return {
        position: [drops[at]!, drops[at + 1]!, drops[at + 2]!],
        velocity: [drops[at + 3]!, drops[at + 4]!, drops[at + 5]!],
        volume: drops[at + 6]!,
        diameter: drops[at + 7]!,
        age: drops[at + 8]!,
        id: drops[at + 9]!,
      };
    });
  }

  /** Total received, airborne and departed volume in m³. Departures include impacts. */
  get budget(): { readonly received: number; readonly airborne: number; readonly outflow: number } {
    const s = this.live();
    const meta = regionWords(s.memory, s.meta);
    return { received: meta[3]!, airborne: meta[5]!, outflow: meta[4]! };
  }

  /** Cumulative volume transferred to the receiver, also included in budget.outflow. */
  get depositedVolume(): number {
    const s = this.live();
    return s.receiver ? words(s, s.receiver.ledger)[0]! : 0;
  }

  importPorts(): void {}

  exportPorts(tick: number): readonly Port[] {
    const s = this.live();
    const meta = regionWords(s.memory, s.meta);
    const cell: Cell = [meta[6]!, meta[7]!, meta[8]!];
    return [
      { field: this.particleField.name, region: s.drops, tick, cell },
      { field: this.impactField.name, region: s.impacts, tick, cell },
    ];
  }

  stateRegions(): readonly Region[] {
    const s = this.live();
    const receiver = s.receiver;
    if (!receiver) return [s.drops, s.meta];
    const regions = [s.drops, s.meta, s.impacts, receiver.ledger];
    if (receiver.pose) regions.push(receiver.pose);
    return regions;
  }

  extraState(): readonly Region[] {
    return [];
  }
}
