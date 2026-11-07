import { type State, StateMachine, type Transition } from './index.js';
import { ParallelRegions, type Region } from './parallel.js';

/** A transition as data. As {@link Transition}, with `guard` naming a function of {@link MachineBindings}. */
export interface TransitionDocument {
  /** Source state. */
  from: string;
  /** Target state. */
  to: string;
  /** Event name. Give this or `after`. */
  event?: string;
  /** Delay in seconds, above 0. Give this or `event`. */
  after?: number;
  /** Cross-fade time in seconds. Default 0. */
  duration?: number;
  /** Name in `bindings.guards`. Default none. */
  guard?: string;
}
/** A state as data. Hooks are names in `bindings.hooks`, as functions do not fit in JSON. */
export interface StateDocument {
  /** Name of the parent state. */
  parent?: string;
  /** Descendant to go on to. */
  initial?: string;
  /** What the state remembers. */
  history?: 'shallow' | 'deep';
  /** Hook name, called on entry. */
  enter?: string;
  /** Hook name, called on exit. */
  exit?: string;
  /** Hook name, called with the context and delta on update. */
  update?: string;
  /** Parallel regions by name, run while this state is active. A state with regions takes no hooks. */
  regions?: Record<string, RegionDocument>;
  /** With `regions`: each region resumes where it stopped. Default false. */
  regionHistory?: boolean;
}
/** A region as data: states, a starting state and transitions. */
export interface RegionDocument {
  /** States by name. */
  states: Record<string, StateDocument>;
  /** The starting state. */
  initial: string;
  /** Transitions. Default none. */
  transitions?: TransitionDocument[];
}
/** A whole machine as plain data, so it saves and loads as JSON. */
export interface MachineDocument extends RegionDocument {
  /** Format version; 1. */
  version: 1;
}
/** The functions a document names. */
export interface MachineBindings<C> {
  /** Hooks by name; `enter` and `exit` hooks get the context, `update` hooks the context and delta. */
  hooks?: Readonly<Record<string, (context: C, delta: number) => void>>;
  /** Guards by name. */
  guards?: Readonly<Record<string, (context: C) => boolean>>;
}
/** One thing wrong with a document. */
export interface MachineIssue {
  /** Where, such as `states.run.parent` or `transitions[2].to`. */
  path: string;
  /** What is wrong and how to fix it. */
  message: string;
}

const STATE_KEYS = new Set(['parent', 'initial', 'history', 'enter', 'exit', 'update', 'regions', 'regionHistory']);
const TRANSITION_KEYS = new Set(['from', 'to', 'event', 'after', 'duration', 'guard']);
const HOOKS = ['enter', 'exit', 'update'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function checkTransition(
  value: unknown,
  path: string,
  states: Record<string, unknown>,
  add: (path: string, message: string) => void,
  bindings: MachineBindings<never> | undefined,
): void {
  if (!isRecord(value)) return add(path, 'A transition is an object');
  for (const key of Object.keys(value)) if (!TRANSITION_KEYS.has(key)) add(`${path}.${key}`, 'Unknown key; remove it');
  for (const key of ['from', 'to'])
    if (!isName(value[key]) || !Object.hasOwn(states, value[key]))
      add(`${path}.${key}`, 'Unknown state; name one of the states');
  const { event, after, duration, guard } = value;
  if ((event === undefined) === (after === undefined)) add(path, 'Give event or after, not both or neither');
  if (event !== undefined && !isName(event)) add(`${path}.event`, 'An event is a non-empty string');
  if (after !== undefined && !(typeof after === 'number' && Number.isFinite(after) && after > 0))
    add(`${path}.after`, 'A delay is a number of seconds above 0');
  if (duration !== undefined && !(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0))
    add(`${path}.duration`, 'A cross-fade is a number of seconds, 0 or more');
  if (guard !== undefined) {
    if (!isName(guard)) add(`${path}.guard`, 'A guard is the name of a function in bindings');
    else if (bindings && !Object.hasOwn(bindings.guards ?? {}, guard))
      add(`${path}.guard`, `No guard named ${guard} in bindings`);
  }
}

function checkState(
  value: unknown,
  name: string,
  path: string,
  states: Record<string, unknown>,
  add: (path: string, message: string) => void,
  bindings: MachineBindings<never> | undefined,
): void {
  if (!isRecord(value)) return add(path, 'A state is an object');
  for (const key of Object.keys(value)) if (!STATE_KEYS.has(key)) add(`${path}.${key}`, 'Unknown key; remove it');
  const { parent, initial, history, regions, regionHistory } = value;
  if (parent !== undefined && (!isName(parent) || !Object.hasOwn(states, parent)))
    add(`${path}.parent`, 'Unknown parent; name one of the states');
  // The parent chain of a name, or null if it goes round or leaves the states.
  const chain = (start: string): string[] | null => {
    const seen: string[] = [];
    for (let at: unknown = start; at !== undefined; ) {
      if (!isName(at) || !Object.hasOwn(states, at) || seen.includes(at)) return null;
      seen.push(at);
      const state = states[at];
      at = isRecord(state) ? state.parent : undefined;
    }
    return seen;
  };
  if (!chain(name) && parent !== undefined && isName(parent) && Object.hasOwn(states, parent))
    add(`${path}.parent`, 'Hierarchy cycle; a state cannot be its own ancestor');
  if (initial !== undefined) {
    const line = isName(initial) && Object.hasOwn(states, initial) ? chain(initial) : null;
    if (!line?.includes(name) || initial === name) add(`${path}.initial`, 'Name one of the descendants of this state');
  }
  if (history !== undefined && history !== 'shallow' && history !== 'deep')
    add(`${path}.history`, "Use 'shallow' or 'deep'");
  for (const hook of HOOKS) {
    const named = value[hook];
    if (named === undefined) continue;
    if (!isName(named)) add(`${path}.${hook}`, 'A hook is the name of a function in bindings');
    else if (bindings && !Object.hasOwn(bindings.hooks ?? {}, named))
      add(`${path}.${hook}`, `No hook named ${named} in bindings`);
    if (regions !== undefined) add(`${path}.${hook}`, 'A state with regions takes no hooks; put them on its parent');
  }
  if (regionHistory !== undefined) {
    if (typeof regionHistory !== 'boolean') add(`${path}.regionHistory`, 'Use true or false');
    if (regions === undefined) add(`${path}.regionHistory`, 'Only a state with regions has this');
  }
  if (regions !== undefined) {
    if (!isRecord(regions) || !Object.keys(regions).length) add(`${path}.regions`, 'Name at least one region');
    else
      for (const key of Object.keys(regions)) checkRegion(regions[key], `${path}.regions.${key}`, add, bindings, false);
  }
}

function checkRegion(
  value: unknown,
  path: string,
  add: (path: string, message: string) => void,
  bindings: MachineBindings<never> | undefined,
  top: boolean,
): void {
  const at = (key: string) => (path ? `${path}.${key}` : key);
  if (!isRecord(value)) return add(path || 'document', 'A machine is an object');
  for (const key of Object.keys(value))
    if (key !== 'states' && key !== 'initial' && key !== 'transitions' && !(top && key === 'version'))
      add(at(key), 'Unknown key; remove it');
  const { states, initial, transitions } = value;
  if (!isRecord(states) || !Object.keys(states).length) return add(at('states'), 'Name at least one state');
  for (const key of Object.keys(states)) checkState(states[key], key, at(`states.${key}`), states, add, bindings);
  if (!isName(initial) || !Object.hasOwn(states, initial)) add(at('initial'), 'Unknown state; name one of the states');
  if (transitions === undefined) return;
  if (!Array.isArray(transitions)) return add(at('transitions'), 'Transitions are a list');
  transitions.forEach((transition, index) =>
    checkTransition(transition, at(`transitions[${index}]`), states, add, bindings),
  );
}

/**
 * Every problem in a document, or an empty list. With `bindings`, each hook and guard must also name a function there.
 * Takes any value, so it can check what `JSON.parse` returned.
 */
export function validateMachine<C>(value: unknown, bindings?: MachineBindings<C>): MachineIssue[] {
  const issues: MachineIssue[] = [],
    add = (path: string, message: string) => void issues.push({ path, message });
  if (isRecord(value) && value.version !== 1) add('version', 'Unknown version; this reader takes version 1');
  else if (!isRecord(value)) add('document', 'A machine is an object');
  checkRegion(value, '', add, bindings as MachineBindings<never> | undefined, true);
  return issues;
}

function buildRegion<C>(
  document: RegionDocument,
  context: C,
  bindings: MachineBindings<C>,
  holder: { machine?: StateMachine<C> },
): Region<C> {
  const states: Record<string, State<C>> = Object.create(null);
  for (const name of Object.keys(document.states)) {
    const { parent, initial, history, enter, exit, update, regions, regionHistory } = document.states[name],
      state: State<C> = {};
    if (regions) {
      // A region's own machine holds what is nested in it, and exists only once the regions are built.
      const inner: Record<string, { machine?: StateMachine<C> }> = Object.create(null),
        built: Record<string, Region<C>> = Object.create(null);
      for (const key of Object.keys(regions)) {
        inner[key] = {};
        built[key] = buildRegion(regions[key], context, bindings, inner[key]);
      }
      const running = new ParallelRegions(built, context, {
        history: regionHistory,
        forward: (event) => void holder.machine?.send(event),
      });
      for (const key of Object.keys(regions)) inner[key].machine = running.machines[key];
      Object.assign(state, running.asState());
    }
    if (parent !== undefined) state.parent = parent;
    if (initial !== undefined) state.initial = initial;
    if (history !== undefined) state.history = history;
    if (enter !== undefined) state.enter = bindings.hooks![enter] as (context: C) => void;
    if (exit !== undefined) state.exit = bindings.hooks![exit] as (context: C) => void;
    if (update !== undefined) state.update = bindings.hooks![update];
    states[name] = state;
  }
  const transitions = (document.transitions ?? []).map(({ guard, ...rest }) => {
    const transition: Transition<C> = rest;
    if (guard !== undefined) transition.guard = bindings.guards![guard];
    return transition;
  });
  return { states, initial: document.initial, transitions };
}

/**
 * Build a machine from a document. Its `enter` hooks run, as for `new StateMachine`.
 * @throws TypeError listing every issue of {@link validateMachine}.
 */
export function loadMachine<C>(document: MachineDocument, context: C, bindings: MachineBindings<C> = {}): StateMachine<C> {
  const issues = validateMachine(document, bindings);
  if (issues.length)
    throw new TypeError(`Invalid machine; ${issues.map(({ path, message }) => `${path}: ${message}`).join('; ')}`);
  const holder: { machine?: StateMachine<C> } = {},
    { states, initial, transitions } = buildRegion(document, context, bindings, holder);
  return (holder.machine = new StateMachine(states, initial, context, transitions));
}

function nameOf<T>(table: Readonly<Record<string, T>> | undefined, value: T, where: string): string {
  for (const name of Object.keys(table ?? {})) if (table![name] === value) return name;
  throw new TypeError(`No name for ${where} in bindings; add the function to bindings`);
}

function saveRegion<C>(
  states: Readonly<Record<string, State<C>>>,
  initial: string,
  transitions: readonly Transition<C>[],
  bindings: MachineBindings<C>,
): RegionDocument {
  const saved: Record<string, StateDocument> = Object.create(null);
  for (const name of Object.keys(states)) {
    const state = states[name],
      out: StateDocument = {};
    if (state.parent !== undefined) out.parent = state.parent;
    if (state.initial !== undefined) out.initial = state.initial;
    if (state.history !== undefined) out.history = state.history;
    if (state.regions) {
      const { definition, options } = state.regions;
      out.regions = Object.create(null) as Record<string, RegionDocument>;
      for (const key of Object.keys(definition)) {
        const region = definition[key];
        out.regions[key] = saveRegion(region.states, region.initial, region.transitions ?? [], bindings);
      }
      if (options.history) out.regionHistory = true;
    } else {
      if (state.plan) throw new TypeError(`Unsupported plan hook on state ${name}; a document holds only named hooks and regions`);
      for (const hook of HOOKS) {
        const value = state[hook];
        if (value) out[hook] = nameOf(bindings.hooks, value as (context: C, delta: number) => void, `${hook} of ${name}`);
      }
    }
    saved[name] = out;
  }
  const document: RegionDocument = { states: saved, initial };
  if (transitions.length)
    document.transitions = transitions.map(({ guard, ...rest }, index) => {
      const out: TransitionDocument = { ...rest } as TransitionDocument;
      if (guard) out.guard = nameOf(bindings.guards, guard, `the guard of transition ${index}`);
      return out;
    });
  return document;
}

/**
 * The document of a machine, for `JSON.stringify`: its definition, not where it is now; for that see `fsm/trace`.
 * @throws TypeError for a hook or guard that is not in `bindings`.
 */
export function saveMachine<C>(machine: StateMachine<C>, bindings: MachineBindings<C> = {}): MachineDocument {
  return { version: 1, ...saveRegion(machine.states, machine.initial, machine.transitions, bindings) };
}
