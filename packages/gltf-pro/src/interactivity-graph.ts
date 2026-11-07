// KHR_interactivity behaviour graphs: the checks of the specification's Validation section, then the runtime. Time is the
// graph's own clock, moved by `tick`, so a run is the same on any machine. Nothing here touches the engine.
import { ops, quatMul, quatSlerp, type GraphRef, type GraphValue } from './interactivity-ops.js';
import { ACTIVE_LIMIT, type ObjectModel } from './interactivity-model.js';

type Json = Record<string, any>;
type Sampler = (channel: { times: Float32Array; values: Float32Array; width: number; interpolation: any }, time: number) => number[];

/** Why a file's interactivity does not run: `extension` for the whole object, otherwise the selected graph. */
export class GraphRejected extends Error {
  constructor(
    message: string,
    readonly extension: boolean,
  ) {
    super(message);
    this.name = 'GraphRejected';
  }
}
const assert = (condition: unknown, what: string): void => {
  if (!condition) throw new GraphRejected(`${what}; fix the KHR_interactivity object`, true);
};
const reject = (what: string): never => {
  throw new GraphRejected(`${what}; fix the behaviour graph`, false);
};

const lengths: Record<string, number> = {
  bool: 1,
  float: 1,
  float2: 2,
  float3: 3,
  float4: 4,
  float2x2: 4,
  float3x3: 9,
  float4x4: 16,
  int: 1,
  ref: 1,
};
const signatures = new Set([...Object.keys(lengths), 'custom']);
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 2147483648;
const isInt = (v: unknown): v is number => typeof v === 'number' && v === (v | 0);
const filled = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 0;
const hasKeys = (v: unknown): v is Json => isObject(v) && Object.keys(v).length > 0;
const validPointer = (v: unknown): v is string => typeof v === 'string' && /^(\/([^~]|~[01])*)*$/.test(v);

/** The type-default value of a signature. */
export function typeDefault(type: string): GraphValue {
  if (type === 'bool') return false;
  if (type === 'int') return 0;
  if (type === 'ref' || type === 'custom') return null;
  return type === 'float' ? NaN : new Array<number>(lengths[type]).fill(NaN);
}

interface Param {
  id: string;
  ref: boolean;
  at: number;
}
/** A JSON Pointer Template: path segments, with the parameters at their places. */
export interface PointerTemplate {
  segments: string[];
  params: Param[];
}
const unescape = (s: string) => s.replaceAll('~1', '/').replaceAll('~0', '~');
/** Parses a pointer template as the specification lays out; undefined for bad syntax. */
export function parseTemplate(text: unknown): PointerTemplate | undefined {
  if (!validPointer(text)) return undefined;
  const segments = text.split('/'),
    params: Param[] = [];
  for (let at = 0; at < segments.length; at++) {
    const s = segments[at];
    if (s === '[' || s === '{') return undefined;
    const open = s[0],
      close = open === '[' ? ']' : '}';
    if ((open === '[' || open === '{') && s[1] !== open) {
      const inner = s.slice(1, -1);
      if (!s.endsWith(close) || !inner || /[[\]{}]/.test(inner)) return undefined;
      const id = unescape(inner);
      if (params.some((p) => p.id === id)) return undefined;
      params.push({ id, ref: open === '{', at });
    } else if ((s.match(/\[+|\]+|\{+|\}+/g) ?? []).some((run) => run.length % 2)) return undefined;
  }
  return { segments, params };
}
const literal = (s: string) => s.replaceAll('[[', '[').replaceAll(']]', ']').replaceAll('{{', '{').replaceAll('}}', '}');

/** Parses a `debug/log` message: its parameter ids, or undefined for bad syntax. */
function messageParams(message: string): { from: number; to: number; id: string }[] | undefined {
  const found: { from: number; to: number; id: string }[] = [];
  let state = 0,
    start = 0;
  for (let i = 0; i < message.length; i++) {
    const c = message[i];
    if (c === '{') {
      if (state > 1) return undefined;
      state = state ? 0 : 1;
    } else if (c === '}') {
      if (state === 1) return undefined;
      if (state === 2) found.push({ from: start, to: i, id: message.slice(start + 1, i) });
      state = state === 0 ? 3 : 0;
    } else if (state === 1) {
      start = i - 1;
      state = 2;
    } else if (state === 3) return undefined;
  }
  return state ? undefined : found;
}

/** Bezier easing of `variable/interpolate` and `pointer/interpolate`: the y of the curve where its x is `t`. */
export function ease(p1: number[], p2: number[], t: number): number {
  const curve = (a: number, b: number, u: number) => (3 * a - 3 * b + 1) * u ** 3 + (-6 * a + 3 * b) * u * u + 3 * a * u;
  let low = 0,
    high = 1,
    u = t;
  for (let i = 0; i < 60; i++) {
    const x = curve(p1[0], p2[0], u);
    if (Math.abs(x - t) < 1e-12) break;
    if (x < t) low = u;
    else high = u;
    u = (low + high) / 2;
  }
  return curve(p1[1], p2[1], u);
}

interface Source {
  node?: Live;
  socket?: string;
  constant?: GraphValue;
  type: string;
}
/** A node of a running graph. */
interface Live {
  index: number;
  op: string;
  noop: boolean;
  inputs: Record<string, Source>;
  outputs: Record<string, string>;
  flows: Record<string, { node: number; socket: string }>;
  /** What the configuration settled. */
  config: Json;
  /** Output values held between activations. */
  state: Json;
  memo?: Record<string, GraphValue>;
  memoEpoch: number;
  /** Input flow sockets, when not just `in`. */
  entries?: string[];
}
interface EventDef {
  id?: string;
  values: Record<string, { type: string; value: GraphValue }>;
}
interface Compiled {
  nodes: Live[];
  variables: { type: string; value: GraphValue; name?: string }[];
  events: EventDef[];
}

/** The operations an extension brings, with the sockets it declares, the types by id. */
const extensionOps: Record<string, Record<string, { inputs?: Record<string, string>; outputs?: Record<string, string>; flows?: string[]; implied?: boolean }>> = {
  KHR_node_selectability: {
    'event/onSelect': {
      outputs: { selectedNode: 'ref', controllerIndex: 'int', selectionPoint: 'float3', selectionRayOrigin: 'float3', event: 'ref' },
    },
  },
  KHR_node_hoverability: {
    'event/onHoverIn': { outputs: { hoveredNode: 'ref', controllerIndex: 'int', event: 'ref' } },
    'event/onHoverOut': { outputs: { hoveredNode: 'ref', controllerIndex: 'int', event: 'ref' } },
  },
  KHR_physics_rigid_bodies: {
    'rigid_body/applyImpulse': { inputs: { nodeIndex: 'int', linearImpulse: 'float3', angularImpulse: 'float3' }, flows: ['in'], implied: true },
    'rigid_body/applyPointImpulse': { inputs: { nodeIndex: 'int', impulse: 'float3', position: 'float3' }, flows: ['in'], implied: true },
    'rigid_body/rayCast': {
      inputs: { rayStart: 'float3', rayEnd: 'float3', collisionFilterIndex: 'int' },
      outputs: { hitNodeIndex: 'int', hitFraction: 'float', hitNormal: 'float3' },
      flows: ['in'],
      implied: true,
    },
    'event/rigid_body_triggerEntered': { outputs: { colliderNodeIndex: 'int', motionNodeIndex: 'int' }, implied: true },
    'event/rigid_body_triggerExited': { outputs: { colliderNodeIndex: 'int', motionNodeIndex: 'int' }, implied: true },
  },
};
// Sockets of the operations with flows, config-free part: inputs, outputs and the extra input flows.
const flowOps: Record<string, { inputs?: Record<string, string>; outputs?: Record<string, string>; entries?: string[] }> = {
  'flow/sequence': {},
  'flow/branch': { inputs: { condition: 'bool' } },
  'flow/switch': { inputs: { selection: 'int' } },
  'flow/while': { inputs: { condition: 'bool' } },
  'flow/for': { inputs: { startIndex: 'int', endIndex: 'int' }, outputs: { index: 'int' } },
  'flow/doN': { inputs: { n: 'int' }, outputs: { currentCount: 'int' }, entries: ['in', 'reset'] },
  'flow/multiGate': { outputs: { lastIndex: 'int' }, entries: ['in', 'reset'] },
  'flow/waitAll': { outputs: { remainingInputs: 'int' } },
  'flow/throttle': { inputs: { duration: 'float' }, outputs: { lastRemainingTime: 'float' }, entries: ['in', 'reset'] },
  'flow/setDelay': { inputs: { duration: 'float' }, outputs: { lastDelay: 'ref' }, entries: ['in', 'cancel'] },
  'flow/cancelDelay': { inputs: { delay: 'ref' } },
  'variable/get': {},
  'variable/set': {},
  'variable/interpolate': { inputs: { duration: 'float', p1: 'float2', p2: 'float2' } },
  'pointer/get': {},
  'pointer/set': {},
  'pointer/interpolate': { inputs: { duration: 'float', p1: 'float2', p2: 'float2' } },
  'animation/start': { inputs: { animation: 'ref', startTime: 'float', endTime: 'float', speed: 'float' } },
  'animation/stop': { inputs: { animation: 'ref' } },
  'animation/stopAt': { inputs: { animation: 'ref', stopTime: 'float' } },
  'event/onStart': { outputs: { event: 'ref' } },
  'event/onTick': { outputs: { timeSinceStart: 'float', timeSinceLastTick: 'float', event: 'ref' } },
  'event/stopPropagation': { inputs: { stopImmediate: 'bool', event: 'ref' } },
  'event/receive': {},
  'event/send': {},
  'debug/log': {},
  'math/switch': {},
  'math/random': { outputs: { value: 'float' } },
  'math/quatFromAngles': { inputs: { x: 'float', y: 'float', z: 'float' }, outputs: { value: 'float4' } },
};
const noConfig = Object.freeze({});

function inline(value: unknown, type: string, model: ObjectModel): GraphValue {
  assert(filled(value), 'An inline value is not a non-empty array');
  if (type === 'custom') return null;
  const items = value as unknown[];
  if (items.length !== lengths[type]) reject(`A ${type} value has ${items.length} elements`);
  const [first] = items;
  if (type === 'bool') return typeof first === 'boolean' ? first : reject('A bool value is not a boolean');
  if (type === 'int') return isInt(first) ? first | 0 : reject('An int value is not a 32-bit integer');
  if (type === 'ref') return validPointer(first) ? model.resolveRef(first) : reject('A ref value is not a JSON pointer');
  if (!items.every((v) => typeof v === 'number')) reject(`A ${type} value holds something other than numbers`);
  return type === 'float' ? (first as number) : (items as number[]).slice();
}

function compile(graph: unknown, model: ObjectModel, extensions: string[]): Compiled {
  assert(isObject(graph), 'A graph is not an object');
  const g = graph as Json,
    types: string[] = [],
    typeOf = (v: unknown): string => {
      assert(isIndex(v), 'A type index is not an index');
      return (v as number) < types.length ? types[v as number] : reject(`Type ${v} does not exist`);
    };
  if ('types' in g) {
    assert(filled(g.types), 'types is empty');
    for (const t of g.types) {
      assert(isObject(t) && typeof t.signature === 'string', 'A type has no signature');
      if (!signatures.has(t.signature)) reject(`Unknown type signature ${t.signature}`);
      if (t.signature !== 'custom' && types.includes(t.signature)) reject(`Type ${t.signature} is repeated`);
      types.push(t.signature);
    }
  }
  const variables: Compiled['variables'] = [];
  if ('variables' in g) {
    assert('types' in g, 'variables need types');
    assert(filled(g.variables), 'variables is empty');
    for (const v of g.variables) {
      assert(isObject(v), 'A variable is not an object');
      const type = typeOf(v.type);
      if ('name' in v) assert(typeof v.name === 'string', 'A variable name is not a string');
      variables.push({ type, value: 'value' in v ? inline(v.value, type, model) : typeDefault(type), name: v.name });
    }
  }
  const events: EventDef[] = [];
  if ('events' in g) {
    assert(filled(g.events), 'events is empty');
    const ids = new Set<string>();
    for (const e of g.events) {
      assert(isObject(e), 'An event is not an object');
      if ('id' in e) {
        assert(typeof e.id === 'string', 'An event id is not a string');
        if (ids.has(e.id)) reject(`Event id ${e.id} is repeated`);
        ids.add(e.id);
      }
      if ('name' in e) assert(typeof e.name === 'string', 'An event name is not a string');
      const values: EventDef['values'] = {};
      if ('values' in e) {
        assert(hasKeys(e.values), 'An event has empty values');
        for (const [id, v] of Object.entries<any>(e.values)) {
          assert(id !== 'event', 'An event value is called event');
          assert(isObject(v), 'An event value is not an object');
          const type = typeOf(v.type);
          values[id] = { type, value: 'value' in v ? inline(v.value, type, model) : typeDefault(type) };
        }
      }
      events.push({ id: e.id, values });
    }
  }
  interface Declaration {
    op: string;
    extension?: string;
    inputs?: Record<string, string>;
    outputs?: Record<string, string>;
    supported: boolean;
  }
  const declarations: Declaration[] = [];
  if ('declarations' in g) {
    assert(filled(g.declarations), 'declarations is empty');
    const seen = new Set<string>();
    for (const d of g.declarations) {
      assert(isObject(d) && typeof d.op === 'string', 'A declaration has no op');
      const sockets = (name: string) => {
        if (!(name in d)) return undefined;
        assert(hasKeys(d[name]), `${name} is empty`);
        assert('types' in g, `${name} needs types`);
        return Object.fromEntries(
          Object.entries<any>(d[name]).map(([id, socket]) => {
            assert(isObject(socket), 'A declared socket is not an object');
            return [id, typeOf(socket.type)];
          }),
        );
      };
      if (!('extension' in d)) {
        if (!ops.has(d.op) && !flowOps[d.op]) reject(`Unknown operation ${d.op}`);
        if ('inputValueSockets' in d || 'outputValueSockets' in d) reject(`${d.op} declares sockets of its own`);
      } else assert(typeof d.extension === 'string', 'A declaration extension is not a string');
      const inputs = sockets('inputValueSockets'),
        outputs = sockets('outputValueSockets');
      const key = JSON.stringify([d.op, d.extension, Object.entries(d.inputValueSockets ?? {}).map(([id, s]: [string, any]) => [id, s.type]).sort()]);
      if (seen.has(key)) reject(`Declarations of ${d.op} are equal`);
      seen.add(key);
      const known = extensions.includes(d.extension) ? extensionOps[d.extension]?.[d.op] : undefined,
        match = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) =>
          (!a && known?.implied) || JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
      declarations.push({
        op: d.op,
        extension: d.extension,
        // The draft physics extension's own samples leave its sockets out.
        inputs: known?.implied && !inputs ? known.inputs : inputs,
        outputs: known?.implied && !outputs ? known.outputs : outputs,
        supported: 'extension' in d ? !!known && match(inputs, known.inputs) && match(outputs, known.outputs) : true,
      });
    }
  }
  const nodes: Live[] = [];
  if ('nodes' in g) {
    assert('declarations' in g, 'nodes need declarations');
    assert(filled(g.nodes), 'nodes is empty');
    (g.nodes as unknown[]).forEach((raw, index) => {
      assert(isObject(raw) && isIndex((raw as Json).declaration), 'A node has no declaration');
      const n = raw as Json;
      if (n.declaration >= declarations.length) reject(`Declaration ${n.declaration} does not exist`);
      const declaration = declarations[n.declaration];
      if ('configuration' in n) {
        assert(hasKeys(n.configuration), 'A node has an empty configuration');
        for (const c of Object.values<any>(n.configuration)) assert(isObject(c) && filled(c.value), 'A configuration has no value');
      }
      const inputs: Live['inputs'] = {};
      if ('values' in n) {
        assert(hasKeys(n.values), 'A node has empty values');
        for (const [id, v] of Object.entries<any>(n.values)) {
          assert(isObject(v), 'An input value is not an object');
          if ('node' in v) {
            assert(!('value' in v) && isIndex(v.node), 'An input names no node');
            if (v.node >= index) reject('An input refers to a later node');
            const socket = 'socket' in v ? v.socket : 'value';
            assert(typeof socket === 'string', 'An input socket is not a string');
            const type = nodes[v.node].outputs[socket];
            if (!type) reject(`Node ${v.node} has no output ${socket}`);
            if ('type' in v && typeOf(v.type) !== type) reject(`An input does not match the type of output ${socket}`);
            inputs[id] = { node: nodes[v.node], socket, type };
          } else {
            const type = typeOf(v.type);
            inputs[id] = { type, constant: 'value' in v ? inline(v.value, type, model) : typeDefault(type) };
          }
        }
      }
      const flows: Live['flows'] = {};
      if ('flows' in n) {
        assert(hasKeys(n.flows), 'A node has empty flows');
        for (const [id, f] of Object.entries<any>(n.flows)) {
          assert(isObject(f) && isIndex(f.node), 'A flow names no node');
          if (f.node <= index || f.node >= g.nodes.length) reject('A flow goes back or past the end');
          if ('socket' in f) assert(typeof f.socket === 'string', 'A flow socket is not a string');
          flows[id] = { node: f.node, socket: f.socket ?? 'in' };
        }
      }
      nodes.push(settle(index, declaration, n, inputs, flows, { types, variables, events, typeOf }));
    });
  }
  if ('name' in g) assert(typeof g.name === 'string', 'A graph name is not a string');
  return { nodes, variables, events };
}

interface Scope {
  types: string[];
  variables: Compiled['variables'];
  events: EventDef[];
  typeOf(v: unknown): string;
}
const need = (inputs: Live['inputs'], id: string, type: string | undefined, op: string) => {
  const found = inputs[id];
  if (!found) reject(`${op} has no input ${id}`);
  if (type && found.type !== type) reject(`${op} input ${id} is ${found.type}, not ${type}`);
};
const configInt = (n: Json, name: string) => {
  const value = n.configuration?.[name]?.value;
  return value?.length === 1 && isInt(value[0]) ? (value[0] as number) : undefined;
};
const configBool = (n: Json, name: string) => {
  const value = n.configuration?.[name]?.value;
  return value?.length === 1 && typeof value[0] === 'boolean' ? (value[0] as boolean) : undefined;
};
const configString = (n: Json, name: string) => {
  const value = n.configuration?.[name]?.value;
  return value?.length === 1 && typeof value[0] === 'string' ? (value[0] as string) : undefined;
};
/** The `cases` of a switch as distinct numbers; empty for the default configuration. */
const configCases = (n: Json): number[] => {
  const value = n.configuration?.cases?.value;
  return Array.isArray(value) && value.every(isInt) ? [...new Set<number>(value)] : [];
};

/** Settles a node's sockets from its operation, configuration and input types. */
function settle(index: number, d: { op: string; inputs?: Record<string, string>; outputs?: Record<string, string>; supported: boolean; extension?: string }, n: Json, inputs: Live['inputs'], flows: Live['flows'], scope: Scope): Live {
  const live: Live = { index, op: d.op, noop: false, inputs, outputs: {}, flows, config: noConfig, state: {}, memoEpoch: -1 };
  if (d.extension !== undefined) {
    for (const [id, type] of Object.entries(d.inputs ?? {})) need(inputs, id, type, d.op);
    live.outputs = d.outputs ?? {};
    if (!d.supported) live.noop = true;
    else {
      const nodeIndex = configInt(n, 'nodeIndex');
      live.config = { nodeIndex: nodeIndex !== undefined && nodeIndex >= 0 ? nodeIndex : undefined };
      for (const [id, type] of Object.entries(live.outputs)) live.state[id] = id === 'controllerIndex' ? -1 : typeDefault(type);
    }
    return live;
  }
  const pure = ops.get(d.op);
  if (pure) {
    const types = pure.inputs.map((id) => {
      need(inputs, id, undefined, d.op);
      return inputs[id].type;
    });
    const outs = pure.resolve(types);
    if (!outs) reject(`${d.op} does not take ${types.join(', ')}`);
    live.outputs = outs!;
    return live;
  }
  const shape = flowOps[d.op];
  for (const [id, type] of Object.entries(shape.inputs ?? {})) need(inputs, id, type, d.op);
  live.outputs = { ...shape.outputs };
  live.entries = shape.entries;
  const variable = (value: number | undefined) =>
    value !== undefined && value >= 0 && value < scope.variables.length ? value : reject(`${d.op} names no variable`);
  const event = () => {
    const i = configInt(n, 'event');
    return i !== undefined && i >= 0 && i < scope.events.length ? i : reject(`${d.op} names no custom event`);
  };
  const pointer = (extra: string[]) => {
    const template = parseTemplate(configString(n, 'pointer'));
    if (!template) reject(`${d.op} has no valid pointer`);
    const type = configInt(n, 'type');
    if (type === undefined || type < 0 || type >= scope.types.length) reject(`${d.op} has no valid type`);
    for (const p of template!.params) {
      if (extra.includes(p.id)) reject(`${d.op} pointer uses the parameter ${p.id}`);
      need(inputs, p.id, p.ref ? 'ref' : 'int', d.op);
    }
    live.config = { template: template!, type: scope.types[type!] };
    return scope.types[type!];
  };
  switch (d.op) {
    case 'flow/sequence':
    case 'flow/multiGate': {
      live.config = {
        order: Object.keys(flows).sort(),
        isRandom: false,
        isLoop: false,
      };
      const isRandom = configBool(n, 'isRandom'),
        isLoop = configBool(n, 'isLoop');
      if (isRandom !== undefined && isLoop !== undefined) Object.assign(live.config, { isRandom, isLoop });
      live.state = { lastIndex: -1, used: new Array(live.config.order.length).fill(false) };
      break;
    }
    case 'flow/switch':
      live.config = { cases: configCases(n) };
      break;
    case 'math/switch': {
      need(inputs, 'selection', 'int', d.op);
      need(inputs, 'default', undefined, d.op);
      const cases = configCases(n);
      for (const c of cases) need(inputs, String(c), inputs.default.type, d.op);
      live.config = { cases };
      live.outputs = { value: inputs.default.type };
      break;
    }
    case 'math/quatFromAngles': {
      const order = configString(n, 'order');
      live.config = { order: order && /^(xyz|xzy|yxz|yzx|zxy|zyx)$/.test(order) ? order : 'yxz' };
      break;
    }
    case 'flow/for':
      live.state = { index: configInt(n, 'initialIndex') ?? 0 };
      break;
    case 'flow/doN':
      live.state = { currentCount: 0 };
      break;
    case 'flow/waitAll': {
      const count = configInt(n, 'inputFlows'),
        inputFlows = count !== undefined && count >= 0 && count <= 64 ? count : 0;
      live.config = { inputFlows };
      live.entries = [...Array.from({ length: inputFlows }, (_, i) => String(i)), 'reset'];
      live.state = { remainingInputs: inputFlows, seen: new Array(inputFlows).fill(false) };
      break;
    }
    case 'flow/throttle':
      live.state = { lastRemainingTime: NaN, stamp: 0 };
      break;
    case 'flow/setDelay':
      live.state = { lastDelay: null, pending: [] };
      break;
    case 'variable/get': {
      const v = variable(configInt(n, 'variable'));
      live.config = { variable: v };
      live.outputs = { value: scope.variables[v].type };
      break;
    }
    case 'variable/set': {
      const list = n.configuration?.variables?.value;
      if (!filled(list)) reject('variable/set has no variables');
      const unique = [...new Set(list as number[])];
      for (const v of unique) {
        if (!isIndex(v)) reject('variable/set names no variable');
        need(inputs, String(variable(v)), scope.variables[v].type, d.op);
      }
      live.config = { variables: unique };
      break;
    }
    case 'variable/interpolate': {
      const v = variable(configInt(n, 'variable')),
        type = scope.variables[v].type,
        useSlerp = configBool(n, 'useSlerp');
      if (type === 'bool' || type === 'int' || type === 'ref' || type === 'custom') reject(`variable/interpolate cannot move a ${type}`);
      if (useSlerp === undefined || (useSlerp && type !== 'float4')) reject('variable/interpolate has no valid useSlerp');
      need(inputs, 'value', type, d.op);
      live.config = { variable: v, useSlerp };
      break;
    }
    case 'pointer/get':
      live.outputs = { value: pointer([]), isValid: 'bool' };
      break;
    case 'pointer/set':
      need(inputs, 'value', pointer(['value']), d.op);
      break;
    case 'pointer/interpolate': {
      const type = pointer(['value', 'duration', 'p1', 'p2']);
      if (type === 'bool' || type === 'int' || type === 'ref' || type === 'custom') reject(`pointer/interpolate cannot move a ${type}`);
      need(inputs, 'value', type, d.op);
      break;
    }
    case 'event/receive': {
      const e = event();
      live.config = { event: e };
      live.outputs = { event: 'ref' };
      for (const [id, v] of Object.entries(scope.events[e].values)) {
        live.outputs[id] = v.type;
        live.state[id] = v.value;
      }
      live.state.event = null;
      break;
    }
    case 'event/send': {
      const e = event();
      live.config = { event: e };
      for (const [id, v] of Object.entries(scope.events[e].values)) need(inputs, id, v.type, d.op);
      break;
    }
    case 'event/onStart':
      live.state = { event: null };
      break;
    case 'event/onTick':
      live.state = { timeSinceStart: NaN, timeSinceLastTick: NaN, event: null };
      break;
    case 'debug/log': {
      const severity = configInt(n, 'severity'),
        message = configString(n, 'message'),
        params = message === undefined ? undefined : messageParams(message);
      const ok = severity !== undefined && params;
      live.config = { severity: ok ? severity : 0, message: ok ? message : '', params: ok ? params : [] };
      for (const p of live.config.params) need(inputs, p.id, undefined, d.op);
      break;
    }
  }
  return live;
}

/** Options of a {@link BehaviorGraph}. */
export interface BehaviorGraphOptions {
  /** Receives `debug/log` output. Default: dropped. */
  log?: (message: string, severity: number) => void;
  /**
   * Flow activations one call may run before the graph stops for good, so a graph that never ends cannot hang the page.
   * Default 1,000,000.
   */
  maxActivations?: number;
  /** Custom events run in one tick; the rest wait for the next. Default 10,000. */
  maxEventsPerTick?: number;
  /** Samples an animation channel. Without it `animation/start` activates `err`. */
  sample?: Sampler;
  /** Runs `rigid_body/*` operations; absent, they do nothing. */
  physics?: GraphPhysics;
}
/** The rigid body operations a host can run for a graph. */
export interface GraphPhysics {
  applyImpulse(nodeIndex: number, linear: number[], angular: number[]): void;
  applyPointImpulse(nodeIndex: number, impulse: number[], position: number[]): void;
  rayCast(start: number[], end: number[], filter: number): { nodeIndex: number; fraction: number; normal: number[] } | undefined;
}
/** One selection, as `select` takes it. */
export interface SelectInfo {
  controllerIndex?: number;
  /** Where the ray met the node, in global space. */
  point?: readonly number[];
  /** Where the ray started, in global space. */
  origin?: readonly number[];
}
type Occurrence = { ref: GraphRef; stopped: boolean; immediate: boolean };
type Listener = (values: Record<string, GraphValue>) => void;

/** The default graph of a file's KHR_interactivity, or why it does not run. */
export function compileInteractivity(doc: Json, model: ObjectModel, extensions: string[]): Compiled | undefined {
  const extension = doc.extensions?.KHR_interactivity;
  if (extension === undefined) return undefined;
  assert(isObject(extension) && filled(extension.graphs), 'graphs is empty or missing');
  let chosen: Compiled | undefined,
    failure: GraphRejected | undefined;
  const selected = 'graph' in extension ? extension.graph : 0;
  assert(isIndex(selected), 'graph is not an index');
  if (selected >= extension.graphs.length) throw new GraphRejected('graph names no graph; fix the KHR_interactivity object', true);
  (extension.graphs as unknown[]).forEach((graph, i) => {
    try {
      const compiled = compile(graph, model, extensions);
      if (i === selected) chosen = compiled;
    } catch (error) {
      if (!(error instanceof GraphRejected) || error.extension) throw error;
      if (i === selected) failure = error;
    }
  });
  if (failure) throw failure;
  return chosen;
}

/**
 * A running behaviour graph. `start` activates `event/onStart`; `tick` moves the clock, and with it delays, interpolations,
 * animations and `event/onTick`. Custom events go in through `send` and out through `on`.
 */
export class BehaviorGraph {
  /** Set when the graph stopped for good, with the reason. */
  halted?: string;
  /** Seconds since `start`. */
  time = 0;
  private readonly nodes: Live[];
  private readonly variableList: Compiled['variables'];
  private readonly events: EventDef[];
  private readonly model: ObjectModel;
  private readonly options: BehaviorGraphOptions;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly queue: { event: number; values: Record<string, GraphValue> }[] = [];
  private delays: { ref: GraphRef; node: Live; at: number; serial: number }[] = [];
  private variableMoves: { variable: number; start: number; duration: number; from: number | number[]; to: number | number[]; p1: number[]; p2: number[]; slerp: boolean; node: Live }[] = [];
  private pointerMoves: { pointer: string; start: number; duration: number; from: number | number[]; to: number | number[]; p1: number[]; p2: number[]; slerp: boolean; node: Live }[] = [];
  private playing: { index: number; start: number; end: number; stop: number; speed: number; created: number; endDone: Live; stopDone?: Live }[] = [];
  private readonly refsMade = new Set<GraphRef>();
  private readonly hovered = new Map<number, number>();
  private epoch = 0;
  private budget = 0;
  private serial = 0;
  private ticked = false;
  private lastTick = 0;
  private started = false;
  private running = false;
  private readonly peers = new Set<BehaviorGraph>();

  constructor(compiled: Compiled, model: ObjectModel, options: BehaviorGraphOptions = {}) {
    this.nodes = compiled.nodes;
    this.variableList = compiled.variables;
    this.events = compiled.events;
    this.model = model;
    this.options = options;
  }

  /** Whether the graph has a working node of `op`, such as `event/onSelect`. */
  handles(op: string): boolean {
    return this.of(op).length > 0;
  }
  /** The value of a variable by index or name. */
  variable(which: number | string): GraphValue {
    const found = typeof which === 'number' ? this.variableList[which] : this.variableList.find((v) => v.name === which);
    return found ? found.value : null;
  }
  /** Calls `listener` when the graph sends the custom event `id`; returns a remover. */
  on(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }
  /** Sends the custom event `id` into the graph. Values left out take their initial values. */
  send(id: string, values: Record<string, GraphValue> = {}): boolean {
    const event = this.events.findIndex((e) => e.id === id);
    if (event < 0) return false;
    this.queue.push({ event, values });
    this.slice(() => this.drain());
    return true;
  }
  /**
   * Forwards this graph's public custom events, those with an id not starting with `_`, to `other` and back, for two files
   * loaded together. Returns a remover.
   */
  link(other: BehaviorGraph): () => void {
    this.peers.add(other);
    other.peers.add(this);
    return () => {
      this.peers.delete(other);
      other.peers.delete(this);
    };
  }
  private slice(run: () => void): void {
    // A call from inside a running step leaves its work to that step's drain.
    if (this.halted || this.running) return;
    this.running = true;
    this.budget = this.options.maxActivations ?? 1_000_000;
    try {
      run();
    } catch (error) {
      if (error !== BehaviorGraph.spent) throw error;
      this.halted = 'The graph ran past its activation limit in one step; raise maxActivations or end its loop';
    } finally {
      this.running = false;
    }
  }
  private static readonly spent = Symbol('spent');

  private occurrence(): Occurrence {
    const ref = this.model.ref(`/extensions/KHR_interactivity/events/${this.serial++}`);
    this.refsMade.add(ref);
    return { ref, stopped: false, immediate: false };
  }
  private readonly occurrences = new Map<GraphRef, Occurrence>();
  /** Runs `targets` in JSON order as one occurrence of an event. */
  private dispatch(targets: Live[], occurrence: Occurrence, fill?: (node: Live) => void): void {
    this.occurrences.set(occurrence.ref, occurrence);
    // Every handler of one occurrence reads the same values, even before its own turn.
    for (const node of targets) {
      fill?.(node);
      node.state.event = occurrence.ref;
    }
    for (const node of targets) {
      if (occurrence.immediate) break;
      this.fire(node, 'out');
    }
  }
  private of(op: string): Live[] {
    return this.nodes.filter((n) => n.op === op && !n.noop);
  }

  /** Activates `event/onStart`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.slice(() => {
      this.dispatch(this.of('event/onStart'), this.occurrence());
      this.drain();
    });
  }

  /** Moves the clock by `seconds`, then runs what came due and `event/onTick`. The first tick is at time zero. */
  tick(seconds: number): void {
    if (!this.started) this.start();
    const first = !this.ticked;
    this.ticked = true;
    if (!first) this.time += seconds;
    this.slice(() => {
      this.epoch++;
      this.runAnimations();
      this.runDelays();
      this.runMoves();
      const since = this.time,
        last = first ? NaN : this.time - this.lastTick;
      this.lastTick = this.time;
      this.dispatch(this.of('event/onTick'), this.occurrence(), (node) => {
        node.state.timeSinceStart = since;
        node.state.timeSinceLastTick = last;
      });
      this.drain(this.options.maxEventsPerTick ?? 10_000);
    });
  }

  private drain(limit = Infinity): void {
    let count = 0;
    while (this.queue.length && count++ < limit) {
      const { event, values } = this.queue.shift()!,
        def = this.events[event],
        targets = this.of('event/receive').filter((n) => n.config.event === event);
      this.dispatch(targets, this.occurrence(), (node) => {
        for (const [id, socket] of Object.entries(def.values)) node.state[id] = id in values ? values[id] : socket.value;
      });
    }
  }

  private runDelays(): void {
    const due = this.delays.filter((d) => d.at <= this.time).sort((a, b) => a.at - b.at || a.serial - b.serial);
    for (const delay of due) {
      if (!this.delays.includes(delay)) continue;
      this.removeDelay(delay.ref);
      this.fire(delay.node, 'done');
    }
  }
  private removeDelay(ref: GraphRef): void {
    const found = this.delays.find((d) => d.ref === ref);
    if (!found) return;
    this.delays = this.delays.filter((d) => d !== found);
    found.node.state.pending = found.node.state.pending.filter((r: GraphRef) => r !== ref);
  }
  private mixed(move: { from: number | number[]; to: number | number[]; p1: number[]; p2: number[]; slerp: boolean }, t: number): number | number[] {
    const q = ease(move.p1, move.p2, t),
      { from, to } = move;
    if (typeof from === 'number') return (1 - q) * from + q * (to as number);
    if (move.slerp) return quatSlerp(from, to as number[], q);
    return from.map((x, i) => (1 - q) * x + q * (to as number[])[i]);
  }
  private runMoves(): void {
    for (const move of this.variableMoves.slice()) {
      if (!this.variableMoves.includes(move)) continue;
      const t = (this.time - move.start) / move.duration;
      if (t <= 0) continue;
      if (Number.isNaN(t) || t >= 1) {
        this.variableList[move.variable].value = move.to;
        this.variableMoves = this.variableMoves.filter((m) => m !== move);
        this.fire(move.node, 'done');
      } else this.variableList[move.variable].value = this.mixed(move, t);
    }
    for (const move of this.pointerMoves.slice()) {
      if (!this.pointerMoves.includes(move)) continue;
      const t = (this.time - move.start) / move.duration,
        property = this.model.property(move.pointer);
      if (t <= 0) continue;
      if (Number.isNaN(t) || t >= 1) {
        property?.set?.(move.to);
        this.pointerMoves = this.pointerMoves.filter((m) => m !== move);
        this.fire(move.node, 'done');
      } else property?.set?.(this.mixed(move, t));
    }
  }
  private applyAnimation(index: number, requested: number): void {
    const state = this.model.animations[index],
      T = state.maxTime;
    let t = 0;
    if (T !== 0) {
      const s = requested > 0 ? Math.ceil((requested - T) / T) : Math.floor(requested / T);
      t = requested - s * T;
    }
    state.playhead = t;
    state.virtualPlayhead = requested;
    for (const channel of state.channels) this.model.animate(channel.pointer, this.options.sample!(channel, t));
  }
  private finish(entry: BehaviorGraph['playing'][number], at: number, done: Live | undefined): void {
    this.applyAnimation(entry.index, at);
    this.playing = this.playing.filter((e) => e !== entry);
    this.model.animations[entry.index].isPlaying = false;
    if (done) this.fire(done, 'done');
  }
  private runAnimations(): void {
    for (const entry of this.playing.slice()) {
      if (!this.playing.includes(entry)) continue;
      const { start, end, stop, speed } = entry;
      if (start === end) {
        this.finish(entry, start, entry.endDone);
        continue;
      }
      const forward = start < end,
        scaled = (this.time - entry.created) * speed,
        now = start + (forward ? scaled : -scaled);
      if (forward ? now >= stop && stop >= start && stop < end : now <= stop && stop <= start && stop > end)
        this.finish(entry, stop, entry.stopDone);
      else if (forward ? now >= end : now <= end) this.finish(entry, end, entry.endDone);
      else this.applyAnimation(entry.index, now);
    }
  }

  private input(node: Live, id: string): any {
    const source = node.inputs[id];
    return source.node ? this.output(source.node, source.socket!) : source.constant;
  }
  private output(node: Live, socket: string): GraphValue {
    if (node.noop) return typeDefault(node.outputs[socket]);
    const pure = ops.get(node.op);
    if (pure || node.op === 'math/switch' || node.op === 'pointer/get' || node.op === 'variable/get' || node.op === 'math/random' || node.op === 'math/quatFromAngles') {
      if (node.memoEpoch !== this.epoch || !node.memo) {
        node.memoEpoch = this.epoch;
        node.memo = this.compute(node, pure);
      }
      return node.memo[socket];
    }
    return node.state[socket];
  }
  private compute(node: Live, pure: ReturnType<typeof ops.get>): Record<string, GraphValue> {
    if (pure) {
      const values = pure.inputs.map((id) => this.input(node, id)),
        result = pure.run(values, pure.inputs.map((id) => node.inputs[id].type));
      return pure.multi ? result : { value: result };
    }
    switch (node.op) {
      case 'math/random':
        return { value: Math.random() };
      case 'math/quatFromAngles': {
        // Intrinsic angles: the first axis of the order is the outermost rotation.
        let value = [0, 0, 0, 1];
        for (const axis of node.config.order as string) {
          const half = this.input(node, axis) / 2,
            turn = [0, 0, 0, Math.cos(half)];
          turn['xyz'.indexOf(axis)] = Math.sin(half);
          value = quatMul(value, turn);
        }
        return { value };
      }
      case 'variable/get':
        return { value: this.variableList[node.config.variable].value };
      case 'math/switch': {
        const selection = this.input(node, 'selection') as number;
        return { value: this.input(node, node.config.cases.includes(selection) ? String(selection) : 'default') };
      }
    }
    const pointer = this.effective(node),
      type: string = node.config.type,
      found = pointer === undefined ? undefined : this.lookup(pointer);
    return found?.type === type ? { value: found.get(), isValid: true } : { value: typeDefault(type), isValid: false };
  }
  /** Resolves a pointer, the graph's own delay and event references included. */
  private lookup(pointer: string) {
    const own = /^\/extensions\/KHR_interactivity\/(delays|events)\/\d+$/.exec(pointer);
    if (!own) return this.model.property(pointer);
    const ref = this.model.ref(pointer),
      live = own[1] === 'delays' ? this.delays.some((d) => d.ref === ref) : this.refsMade.has(ref);
    return live ? { type: 'ref', get: () => ref as GraphValue, set: undefined } : undefined;
  }
  /** The effective pointer of a node, or undefined for a negative index or a null reference. */
  private effective(node: Live): string | undefined {
    const template: PointerTemplate = node.config.template,
      parts = template.segments.map(literal);
    for (const { id, ref, at } of template.params) {
      const value = this.input(node, id);
      if (ref) {
        if (value === null) return undefined;
        const path: string = value.path,
          cut = path.lastIndexOf('/');
        parts[at] = path.slice(0, cut) === parts.slice(0, at).join('/') ? path.slice(cut + 1) : '-';
      } else {
        if (value < 0) return undefined;
        parts[at] = String(value);
      }
    }
    return parts.join('/');
  }

  private fire(node: Live, flow: string): void {
    const link = node.flows[flow];
    if (link) this.activate(this.nodes[link.node], link.socket);
  }
  private activate(node: Live, socket: string): void {
    if (--this.budget < 0) throw BehaviorGraph.spent;
    this.epoch++;
    if (node.noop || !(node.entries ?? ['in']).includes(socket)) return;
    if (node.op === 'flow/sequence') {
      for (const id of node.config.order) this.fire(node, id);
      return;
    }
    this.flow(node, socket);
  }
  private flow(node: Live, socket: string): void {
    const s = node.state,
      input = (id: string) => this.input(node, id);
    switch (node.op) {
      case 'flow/branch':
        return this.fire(node, input('condition') ? 'true' : 'false');
      case 'flow/switch': {
        const selection = input('selection');
        return this.fire(node, node.config.cases.includes(selection) ? String(selection) : 'default');
      }
      case 'flow/while':
        while (input('condition')) {
          this.fire(node, 'loopBody');
          if (--this.budget < 0) throw BehaviorGraph.spent;
          this.epoch++;
        }
        return this.fire(node, 'completed');
      case 'flow/for':
        s.index = input('startIndex');
        while (s.index < input('endIndex')) {
          this.fire(node, 'loopBody');
          s.index = (s.index + 1) | 0;
          if (--this.budget < 0) throw BehaviorGraph.spent;
          this.epoch++;
        }
        return this.fire(node, 'completed');
      case 'flow/doN':
        if (socket === 'reset') {
          s.currentCount = 0;
          return;
        }
        if (s.currentCount < input('n')) {
          s.currentCount++;
          this.fire(node, 'out');
        }
        return;
      case 'flow/multiGate':
        return this.gate(node, socket);
      case 'flow/waitAll': {
        if (socket === 'reset') {
          s.remainingInputs = node.config.inputFlows;
          s.seen.fill(false);
          return;
        }
        if (!s.seen[+socket]) {
          s.seen[+socket] = true;
          s.remainingInputs--;
        }
        return this.fire(node, s.remainingInputs ? 'out' : 'completed');
      }
      case 'flow/throttle': {
        if (socket === 'reset') {
          s.lastRemainingTime = NaN;
          return;
        }
        const duration = input('duration');
        if (!Number.isFinite(duration) || duration < 0) return this.fire(node, 'err');
        if (!Number.isNaN(s.lastRemainingTime)) {
          const elapsed = this.time - s.stamp;
          if (duration > elapsed) {
            s.lastRemainingTime = duration - elapsed;
            return;
          }
        }
        s.stamp = this.time;
        s.lastRemainingTime = 0;
        return this.fire(node, 'out');
      }
      case 'flow/setDelay': {
        if (socket === 'cancel') {
          s.lastDelay = null;
          for (const ref of s.pending.slice()) this.removeDelay(ref);
          return;
        }
        const duration = input('duration');
        if (!Number.isFinite(duration) || duration < 0 || this.delays.length >= ACTIVE_LIMIT) return this.fire(node, 'err');
        const serial = this.serial++,
          ref = this.model.ref(`/extensions/KHR_interactivity/delays/${serial}`);
        s.lastDelay = ref;
        s.pending.push(ref);
        this.delays.push({ ref, node, at: this.time + duration, serial });
        return this.fire(node, 'out');
      }
      case 'flow/cancelDelay': {
        const ref = input('delay');
        if (ref) this.removeDelay(ref);
        return this.fire(node, 'out');
      }
      case 'variable/set': {
        const values = node.config.variables.map((v: number) => input(String(v)));
        node.config.variables.forEach((v: number, i: number) => {
          this.variableMoves = this.variableMoves.filter((m) => m.variable !== v);
          this.variableList[v].value = values[i];
        });
        return this.fire(node, 'out');
      }
      case 'variable/interpolate': {
        const { variable, useSlerp } = node.config,
          move = this.motion(node);
        if (!move || this.variableMoves.length >= ACTIVE_LIMIT) return this.fire(node, 'err');
        this.variableMoves = this.variableMoves.filter((m) => m.variable !== variable);
        this.variableMoves.push({ ...move, variable, from: this.variableList[variable].value as number, slerp: useSlerp, node });
        return this.fire(node, 'out');
      }
      case 'pointer/set': {
        const value = input('value'),
          pointer = this.effective(node),
          found = pointer === undefined ? undefined : this.lookup(pointer);
        if (found?.type !== node.config.type || !found?.set) return this.fire(node, 'err');
        this.pointerMoves = this.pointerMoves.filter((m) => m.pointer !== pointer);
        found.set(value);
        return this.fire(node, 'out');
      }
      case 'pointer/interpolate': {
        const pointer = this.effective(node),
          found = pointer === undefined ? undefined : this.lookup(pointer),
          move = this.motion(node);
        if (found?.type !== node.config.type || !found?.set || !move || this.pointerMoves.length >= ACTIVE_LIMIT)
          return this.fire(node, 'err');
        this.pointerMoves = this.pointerMoves.filter((m) => m.pointer !== pointer);
        this.pointerMoves.push({
          ...move,
          pointer: pointer!,
          from: found.get() as number,
          slerp: found.type === 'float4' && pointer!.endsWith('/rotation'),
          node,
        });
        return this.fire(node, 'out');
      }
      case 'animation/start':
      case 'animation/stop':
      case 'animation/stopAt':
        return this.control(node);
      case 'event/stopPropagation': {
        const occurrence = this.occurrences.get(input('event')),
          immediate = input('stopImmediate');
        if (occurrence) {
          occurrence.stopped = true;
          if (immediate) occurrence.immediate = true;
        }
        return this.fire(node, 'out');
      }
      case 'event/send': {
        const def = this.events[node.config.event],
          values = Object.fromEntries(Object.keys(def.values).map((id) => [id, input(id)]));
        this.queue.push({ event: node.config.event, values });
        if (def.id !== undefined) {
          for (const listener of [...(this.listeners.get(def.id) ?? [])]) listener(values);
          if (!def.id.startsWith('_')) for (const peer of this.peers) peer.send(def.id, values);
        }
        return this.fire(node, 'out');
      }
      case 'debug/log': {
        let message: string = node.config.message;
        for (const { from, to, id } of [...node.config.params].reverse())
          message = message.slice(0, from) + show(input(id)).replaceAll('{', '{{').replaceAll('}', '}}') + message.slice(to + 1);
        this.options.log?.(message.replaceAll('{{', '{').replaceAll('}}', '}'), node.config.severity);
        return this.fire(node, 'out');
      }
      case 'rigid_body/applyImpulse':
        return this.options.physics?.applyImpulse(input('nodeIndex'), input('linearImpulse'), input('angularImpulse'));
      case 'rigid_body/applyPointImpulse':
        return this.options.physics?.applyPointImpulse(input('nodeIndex'), input('impulse'), input('position'));
      case 'rigid_body/rayCast': {
        const hit = this.options.physics?.rayCast(input('rayStart'), input('rayEnd'), input('collisionFilterIndex'));
        if (!hit) return this.fire(node, 'miss');
        Object.assign(s, { hitNodeIndex: hit.nodeIndex, hitFraction: hit.fraction, hitNormal: hit.normal });
        return this.fire(node, 'hit');
      }
    }
  }
  private motion(node: Live) {
    const duration = this.input(node, 'duration'),
      p1: number[] = this.input(node, 'p1'),
      p2: number[] = this.input(node, 'p2'),
      to = this.input(node, 'value');
    if (!Number.isFinite(duration) || duration < 0) return undefined;
    if (![...p1, ...p2].every(Number.isFinite) || p1[0] < 0 || p1[0] > 1 || p2[0] < 0 || p2[0] > 1) return undefined;
    return { start: this.time, duration, to, p1, p2 };
  }
  private gate(node: Live, socket: string): void {
    const s = node.state,
      { order, isRandom, isLoop } = node.config;
    if (socket === 'reset') {
      s.lastIndex = -1;
      s.used.fill(false);
      return;
    }
    const free = order.flatMap((_: string, i: number) => (s.used[i] ? [] : [i]));
    let i: number = free.length ? (isRandom ? free[Math.floor(Math.random() * free.length)] : free[0]) : -1;
    if (i < 0) {
      if (!isLoop || !order.length) return;
      s.used.fill(false);
      i = isRandom ? Math.floor(Math.random() * order.length) : 0;
    }
    s.used[i] = true;
    s.lastIndex = i;
    this.fire(node, order[i]);
  }
  private control(node: Live): void {
    const ref = this.input(node, 'animation') as GraphRef | null,
      index = /^\/animations\/(\d+)$/.exec(ref?.path ?? '')?.[1],
      state = index === undefined ? undefined : this.model.animations[+index];
    if (!state) return this.fire(node, 'err');
    const i = +index!,
      entry = this.playing.find((e) => e.index === i);
    if (node.op === 'animation/stop') {
      if (entry) {
        this.playing = this.playing.filter((e) => e !== entry);
        state.isPlaying = false;
      }
      return this.fire(node, 'out');
    }
    if (node.op === 'animation/stopAt') {
      const stopTime = this.input(node, 'stopTime');
      if (Number.isNaN(stopTime)) return this.fire(node, 'err');
      if (entry) {
        entry.stop = stopTime;
        entry.stopDone = node;
      }
      return this.fire(node, 'out');
    }
    const start = this.input(node, 'startTime'),
      end = this.input(node, 'endTime'),
      speed = this.input(node, 'speed');
    if (Number.isNaN(start) || Number.isNaN(end) || !Number.isFinite(start)) return this.fire(node, 'err');
    if (!Number.isFinite(speed) || speed <= 0) return this.fire(node, 'err');
    if (!this.options.sample || !state.channels.length || (!entry && this.playing.length >= ACTIVE_LIMIT)) return this.fire(node, 'err');
    this.playing = this.playing.filter((e) => e !== entry);
    this.playing.push({ index: i, start, end, stop: end, speed, created: this.time, endDone: node });
    state.isPlaying = true;
    this.fire(node, 'out');
  }

  /** Runs `event/onSelect` for a selection on `nodeIndex`, lowest node first; false when the node is not selectable. */
  select(nodeIndex: number, info: SelectInfo = {}): boolean {
    if (!this.model.inherited(nodeIndex, 'selectability/selectable')) return false;
    const occurrence = this.occurrence(),
      handlers = this.of('event/onSelect');
    this.slice(() => {
      for (let at = nodeIndex; at >= 0 && !occurrence.stopped; at = this.model.parent(at))
        this.dispatch(
          handlers.filter((n) => n.config.nodeIndex === at),
          occurrence,
          (node) =>
            Object.assign(node.state, {
              selectedNode: this.model.ref(`/nodes/${nodeIndex}`),
              controllerIndex: info.controllerIndex ?? 0,
              selectionPoint: info.point ? [...info.point] : [NaN, NaN, NaN],
              selectionRayOrigin: info.origin ? [...info.origin] : [NaN, NaN, NaN],
            }),
        );
      this.drain();
    });
    return true;
  }
  /** Moves the hover of a controller to `nodeIndex`, or off everything with undefined. */
  hover(nodeIndex: number | undefined, controllerIndex = 0): void {
    const target = nodeIndex !== undefined && this.model.inherited(nodeIndex, 'hoverability/hoverable') ? nodeIndex : -1,
      before = this.hovered.get(controllerIndex) ?? -1;
    if (target === before) return;
    this.hovered.set(controllerIndex, target);
    const chain = (node: number) => {
        const list: number[] = [];
        for (let at = node; at >= 0; at = this.model.parent(at)) list.push(at);
        return list;
      },
      old = chain(before),
      fresh = chain(target);
    const run = (op: string, nodes: number[], origin: number) => {
      const occurrence = this.occurrence(),
        handlers = this.of(op);
      for (const at of nodes) {
        if (occurrence.stopped) break;
        this.dispatch(
          handlers.filter((n) => n.config.nodeIndex === at),
          occurrence,
          (node) => Object.assign(node.state, { hoveredNode: this.model.ref(`/nodes/${origin}`), controllerIndex }),
        );
      }
    };
    this.slice(() => {
      run('event/onHoverOut', old.filter((n) => !fresh.includes(n)), before);
      run('event/onHoverIn', fresh.filter((n) => !old.includes(n)), target);
      this.drain();
    });
  }
  /** Runs a physics trigger event of `op` for the trigger at `nodeIndex`. */
  trigger(op: 'event/rigid_body_triggerEntered' | 'event/rigid_body_triggerExited', nodeIndex: number, colliderNodeIndex: number, motionNodeIndex: number): void {
    this.slice(() => {
      this.dispatch(
        this.of(op).filter((n) => n.config.nodeIndex === nodeIndex),
        this.occurrence(),
        (node) => Object.assign(node.state, { colliderNodeIndex, motionNodeIndex }),
      );
      this.drain();
    });
  }
}

const show = (value: GraphValue): string => {
  if (value === null) return 'null';
  if (typeof value === 'object' && !Array.isArray(value)) return value.path;
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
};
