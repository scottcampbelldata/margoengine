import { MargoError } from '@margoengine/math/errors';
import type { StateMachine, Transition } from './index.js';
import type { ParallelRegions } from './parallel.js';

/** Where parallel regions are: plain data, inside a {@link MachineSnapshot}. */
export interface RegionsSnapshot {
  /** Whether the regions are running. */
  running: boolean;
  /** Where each region starts next, in region order. */
  starts: string[];
  /** Each region's machine, in region order. */
  machines: MachineSnapshot[];
}
/** Where a machine is, as plain data, so it saves as JSON or goes over a network. The definition is not in it. */
export interface MachineSnapshot {
  /** Format version; 1. */
  version: 1;
  /** Current state. */
  state: string;
  /** State being cross-faded from, or null. */
  previous: string | null;
  /** Seconds since the last state change. */
  elapsed: number;
  /** Length of the running cross-fade in seconds. */
  duration: number;
  /** The machine's running time. */
  clock: number;
  /** When each active state was entered, as name and clock pairs. */
  entered: [string, number][];
  /**
   * Delayed transitions that started waiting again while their `from` stayed active, as index in `transitions` and
   * clock pairs. Optional: a snapshot without it restores with none.
   */
  waits?: [number, number][];
  /** What states remember, as name and child pairs. */
  memory: [string, string][];
  /** The regions held by states, as state name and snapshot pairs. */
  regions: [string, RegionsSnapshot][];
}
/** One state change seen by a {@link MachineTrace}. */
export interface TraceRecord {
  /** Which machine: empty for the traced one, else the state and region names down to it, such as `alive/weapon`. */
  machine: string;
  /** That machine's `clock` at the change. */
  clock: number;
  /** State left, or null when regions started. */
  from: string | null;
  /** State reached, or null when regions stopped. */
  to: string | null;
  /** The event that caused it; null for `goto` and delays. */
  event: string | null;
  /** The delay that caused it; null for `goto` and events. */
  after: number | null;
}
/** Options of {@link MachineTrace}. */
export interface TraceOptions {
  /** Most records kept; the oldest go first. A whole number of at least 1. Default 256. */
  capacity?: number;
}

// The state a stopped region rests in; every other name in a machine comes from its definition.
const isStopped = (name: string) => name.charCodeAt(0) === 0;

const held = <C>(machine: StateMachine<C>): [string, ParallelRegions<C>][] => {
  const found: [string, ParallelRegions<C>][] = [];
  for (const name of Object.keys(machine.states)) {
    const { regions } = machine.states[name];
    if (regions) found.push([name, regions]);
  }
  return found;
};
const regionMachines = <C>(regions: ParallelRegions<C>) => Object.values(regions.machines);

/**
 * Where `machine` is now, parallel regions included.
 * @throws MargoError `'state'` when called from a hook during a change, where the machine is half way.
 */
export function snapshotMachine<C>(machine: StateMachine<C>): MachineSnapshot {
  if (machine.changing) throw new MargoError('state', 'Snapshot during a state change; take it after the hook returns');
  return {
    version: 1,
    state: machine.state,
    previous: machine.previous,
    elapsed: machine.elapsed,
    duration: machine.duration,
    clock: machine.clock,
    entered: [...machine.entered],
    waits: [...machine.waits],
    memory: [...machine.memory],
    regions: held(machine).map(([name, regions]) => {
      if (regions.busy) throw new MargoError('state', 'Snapshot during a delivery; take it after the hook returns');
      return [
        name,
        { running: regions.running, starts: [...regions.starts], machines: regionMachines(regions).map(snapshotMachine) },
      ];
    }),
  };
}

const known = <C>(machine: StateMachine<C>, name: unknown): name is string =>
  typeof name === 'string' && Object.hasOwn(machine.states, name);
const pathOf = <C>(machine: StateMachine<C>, name: string): string[] => {
  const path: string[] = [];
  for (let at: string | undefined = name; at !== undefined; at = machine.states[at].parent) path.unshift(at);
  return path;
};
const time = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Every check comes before any write, so a bad snapshot leaves the machine as it was.
function check<C>(machine: StateMachine<C>, value: MachineSnapshot, where: string): void {
  const fail = (message: string): never => {
    throw new TypeError(`Invalid snapshot of machine ${where}, ${message}; restore into the machine it came from`);
  };
  if (value?.version !== 1) fail('unknown version; this reader takes version 1');
  if (!known(machine, value.state)) fail(`unknown state ${value.state}`);
  if (value.previous !== null && !known(machine, value.previous)) fail(`unknown state ${value.previous}`);
  if (!time(value.elapsed) || !time(value.duration) || !time(value.clock)) fail('times are numbers of 0 or more');
  if (!Array.isArray(value.entered) || !Array.isArray(value.memory) || !Array.isArray(value.regions))
    fail('entered, memory and regions are lists');
  const path = pathOf(machine, value.state);
  if (value.entered.length !== path.length) fail('entered must hold exactly the active states');
  for (const [name, at] of value.entered)
    if (!path.includes(name) || !time(at) || at > value.clock) fail(`bad entry for ${name}`);
  if (value.waits !== undefined && !Array.isArray(value.waits)) fail('waits is a list');
  for (const [index, at] of value.waits ?? [])
    if (machine.transitions[index]?.after === undefined || !time(at) || at > value.clock)
      fail(`bad wait for transition ${index}`);
  for (const [name, child] of value.memory)
    if (!known(machine, name) || !known(machine, child) || !pathOf(machine, child).includes(name) || name === child)
      fail(`${name} cannot remember ${child}`);
  const holders = held(machine);
  if (holders.length !== value.regions.length) fail('it holds other regions than this machine');
  holders.forEach(([name, regions], index) => {
    const [saved, data] = value.regions[index],
      inner = regionMachines(regions);
    if (saved !== name || data?.machines?.length !== inner.length || data.starts?.length !== inner.length)
      fail(`it holds other regions than state ${name}`);
    if (data.running !== path.includes(name)) fail(`regions of ${name} run only while it is active`);
    inner.forEach((region, i) => {
      if (!known(region, data.starts[i])) fail(`unknown start ${data.starts[i]} of a region of ${name}`);
      check(region, data.machines[i], `${where}/${name}`);
    });
  });
}
function write<C>(machine: StateMachine<C>, value: MachineSnapshot): void {
  machine.state = value.state;
  machine.previous = value.previous;
  machine.elapsed = value.elapsed;
  machine.duration = value.duration;
  machine.clock = value.clock;
  machine.entered.clear();
  for (const [name, at] of value.entered) machine.entered.set(name, at);
  machine.waits.clear();
  for (const [index, at] of value.waits ?? []) machine.waits.set(index, at);
  machine.memory.clear();
  for (const [name, child] of value.memory) machine.memory.set(name, child);
  held(machine).forEach(([, regions], index) => {
    const data = value.regions[index][1];
    regions.running = data.running;
    data.starts.forEach((start, i) => {
      regions.starts[i] = start;
    });
    regionMachines(regions).forEach((region, i) => write(region, data.machines[i]));
  });
}

/**
 * Put `machine` where a snapshot says. Runs no hooks: the snapshot holds the machine, and what hooks did to your context
 * is yours to save. The machine must have the definition the snapshot was taken from.
 * @throws TypeError when the snapshot does not fit this machine; the machine is then unchanged.
 * @throws MargoError `'state'` when called from a hook during a change.
 */
export function restoreMachine<C>(machine: StateMachine<C>, snapshot: MachineSnapshot): void {
  if (machine.changing) throw new MargoError('state', 'Restore during a state change; call it after the hook returns');
  check(machine, snapshot, 'root');
  write(machine, snapshot);
}

/**
 * A rolling record of a machine's state changes, parallel regions included, for debugging. Tracing costs one object per
 * change; a machine that is not traced pays nothing. `dispose()` (or `using`) stops it.
 */
export class MachineTrace<C> {
  private readonly ring: TraceRecord[] = [];
  private readonly capacity: number;
  private readonly attached: StateMachine<C>[] = [];
  private next = 0;
  /**
   * @throws RangeError for a bad `capacity`.
   * @throws MargoError `'attached'` when a machine already has a `listener`.
   */
  constructor(machine: StateMachine<C>, options: TraceOptions = {}) {
    const { capacity = 256 } = options;
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError('Invalid trace capacity; pass a whole number of at least 1');
    this.capacity = capacity;
    try {
      this.attach(machine, '');
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  /** The records kept, oldest first. */
  get records(): TraceRecord[] {
    return [...this.ring.slice(this.next), ...this.ring.slice(0, this.next)];
  }
  /** Forget the records kept so far. */
  clear(): void {
    this.ring.length = 0;
    this.next = 0;
  }
  /** Stop tracing. Safe to call twice. */
  dispose(): void {
    for (const machine of this.attached) machine.listener = null;
    this.attached.length = 0;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private attach(machine: StateMachine<C>, name: string): void {
    if (machine.listener) throw new MargoError('attached', 'Machine already has a listener; dispose that trace first');
    machine.listener = (from, to, transition) => this.push(name, machine.clock, from, to, transition);
    this.attached.push(machine);
    for (const [state, regions] of held(machine))
      for (const key of Object.keys(regions.machines))
        this.attach(regions.machines[key], `${name ? `${name}/` : ''}${state}/${key}`);
  }
  private push(
    machine: string,
    clock: number,
    from: string,
    to: string,
    transition: Transition<C> | null,
  ): void {
    const record: TraceRecord = {
      machine,
      clock,
      from: isStopped(from) ? null : from,
      to: isStopped(to) ? null : to,
      event: transition?.event ?? null,
      after: transition?.after ?? null,
    };
    if (this.ring.length < this.capacity) this.ring.push(record);
    else {
      this.ring[this.next] = record;
      this.next = (this.next + 1) % this.capacity;
    }
  }
}
