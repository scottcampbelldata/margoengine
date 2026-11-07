// Seeded statecharts and scripts, written once as plain data so that Margo and an outside interpreter run the same thing.
// A chart: { root: { name, children, initial, parallel, history, transitions } }. A script: events and ticks of one second.
// `traces.json` holds what Sismic did with these charts, so `outside.test.js` replays it with no Python installed.
import { loadMachine } from '../../dist/document.js';

export const CHART_COUNT = 150;
export const SCRIPT_LENGTH = 40;
const EVENTS = ['e0', 'e1', 'e2', 'e3'];

function random(seed) {
  let value = seed >>> 0 || 1;
  return (limit) => {
    value ^= value << 13;
    value >>>= 0;
    value ^= value >>> 17;
    value ^= value << 5;
    value >>>= 0;
    return value % limit;
  };
}

// The states of one machine: this state and what lies below it, stopping at the regions of a parallel state.
function scope(state, into = []) {
  into.push(state);
  if (!state.parallel) for (const child of state.children) scope(child, into);
  return into;
}
const below = (state, other) => state !== other && scope(state).includes(other);

function grow(next, state, depth, counter) {
  const name = () => `s${counter.value++}`;
  const make = (level) => {
    const child = { name: name(), children: [], transitions: [] };
    grow(next, child, level, counter);
    return child;
  };
  if (depth >= 3 || next(100) < 35) return;
  if (next(100) < 35) {
    state.parallel = true;
    const regions = 2 + next(2);
    for (let i = 0; i < regions; i++) {
      const region = { name: name(), children: [], transitions: [] };
      const count = 2 + next(2);
      for (let j = 0; j < count; j++) region.children.push(make(depth + 2));
      region.initial = region.children[next(count)].name;
      state.children.push(region);
    }
  } else {
    const count = 2 + next(3);
    for (let i = 0; i < count; i++) state.children.push(make(depth + 1));
    state.initial = state.children[next(count)].name;
  }
}

function wire(next, machineRoot, top) {
  // `top` holds the states of the whole chart, for guards; a transition stays inside its own machine.
  const states = scope(machineRoot).filter((state) => state !== machineRoot || machineRoot.region);
  for (const source of states) {
    const taken = new Set(),
      count = next(3);
    for (let i = 0; i < count; i++) {
      const target = states[next(states.length)],
        event = EVENTS[next(EVENTS.length)];
      if (target === source || below(source, target) || below(target, source) || target.region) continue;
      if (taken.has(event)) continue;
      taken.add(event);
      const transition = { to: target.name, event };
      if (next(100) < 25) transition.active = top[next(top.length)].name;
      source.transitions.push(transition);
    }
    // One delay per state at most: two ending together in one state is a choice Sismic refuses.
    if (next(100) < 45) {
      const target = states[next(states.length)];
      if (target !== source && !below(source, target) && !below(target, source) && !target.region) {
        const transition = { to: target.name, after: 1 + next(4) };
        if (next(100) < 25) transition.active = top[next(top.length)].name;
        source.transitions.push(transition);
      }
    }
  }
  for (const state of states)
    if (state.parallel)
      for (const region of state.children) {
        region.region = true;
        wire(next, region, top);
      }
}

function everyState(state, into = []) {
  into.push(state);
  for (const child of state.children) everyState(child, into);
  return into;
}

// History goes where Margo's property and a history target mean the same: not on a child a parent enters by `initial`,
// not under a shallow parent, and deep only with no regions below, as Margo's regions keep their own memory.
function remember(next, state, shallowAbove) {
  for (const child of state.children) {
    const entered = state.initial === child.name || state.parallel || child.region,
      compound = child.children.length && !child.parallel,
      holdsRegions = everyState(child).some((inner) => inner.parallel);
    if (compound && !entered && !shallowAbove && next(100) < 60)
      child.history = holdsRegions || next(2) ? 'shallow' : 'deep';
    remember(next, child, child.history === 'shallow');
  }
}

/** The chart of one seed: compound and parallel states, history, event transitions, guards on what is active. */
export function makeChart(seed) {
  const next = random(seed * 2654435761 + 1),
    root = { name: 'root', children: [], transitions: [], initial: '' },
    counter = { value: 0 };
  const count = 3 + next(3);
  for (let i = 0; i < count; i++) {
    const child = { name: `s${counter.value++}`, children: [], transitions: [] };
    grow(next, child, 1, counter);
    root.children.push(child);
  }
  root.initial = root.children[0].name;
  wire(next, root, everyState(root));
  remember(next, root, false);
  const script = [];
  for (let i = 0; i < SCRIPT_LENGTH; i++) script.push(next(100) < 40 ? 'tick' : EVENTS[next(EVENTS.length)]);
  return { root, script };
}

function regionDocument(top, initial, guards) {
  const states = {},
    transitions = [];
  const add = (state, parent) => {
    const entry = {};
    if (parent) entry.parent = parent.name;
    if (state.initial) entry.initial = state.initial;
    if (state.history) entry.history = state.history;
    if (state.parallel) {
      entry.regions = {};
      for (const region of state.children) entry.regions[region.name] = regionDocument([region], region.name, guards);
    }
    states[state.name] = entry;
    for (const { to, event, after, active } of state.transitions) {
      const transition = { from: state.name, to };
      if (after) transition.after = after;
      else transition.event = event;
      if (active) {
        guards.add(active);
        transition.guard = `active ${active}`;
      }
      transitions.push(transition);
    }
    if (!state.parallel) for (const child of state.children) add(child, state);
  };
  for (const state of top) add(state, null);
  return transitions.length ? { states, initial, transitions } : { states, initial };
}

/** The chart as a machine document, and the state names its guards ask about. */
export function chartDocument({ root }) {
  const guards = new Set();
  return { document: { version: 1, ...regionDocument(root.children, root.initial, guards) }, guards: [...guards] };
}

function runningRegions(machine) {
  const found = [];
  for (const name of Object.keys(machine.states)) {
    const { regions } = machine.states[name];
    if (regions && machine.matches(name)) found.push(...Object.values(regions.machines));
  }
  return found;
}
function collect(machine, into) {
  into.push(machine.state);
  for (const region of runningRegions(machine)) collect(region, into);
  return into;
}

/**
 * Runs a chart's script on a machine and gives the active leaves, sorted and joined, after the start and every step.
 * `swap` may replace the machine after each step.
 */
export function traceOf(first, { root, script }, swap = (machine) => machine) {
  const byName = new Map(everyState(root).map((state) => [state.name, state]));
  let machine = first;
  const atoms = () =>
    collect(machine, [])
      .filter((name) => !byName.get(name).children.length)
      .sort()
      .join(' ');
  const trace = [atoms()];
  for (const step of script) {
    if (step === 'tick') machine.update(1);
    else machine.send(step);
    trace.push(atoms());
    machine = swap(machine);
  }
  return trace;
}
/** True while `name` is active anywhere in the machine, for the guards of a chart. */
traceOf.active = (machine, name) =>
  name === 'root' || machine.matches(name) || runningRegions(machine).some((region) => traceOf.active(region, name));

/** Margo's run of a chart, through its document. */
export function runMargo(chart) {
  const { document, guards: names } = chartDocument(chart),
    guards = {};
  let machine = null;
  for (const name of names) guards[`active ${name}`] = () => traceOf.active(machine, name);
  machine = loadMachine(document, {}, { guards });
  return traceOf(machine, chart);
}
