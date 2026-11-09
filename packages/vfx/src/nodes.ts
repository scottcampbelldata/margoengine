import { MargoError } from '@margoengine/math/errors';
import type { VFXExtension, VFXNode, VFXNodeSample, VFXNodes, VFXState } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Most operators in one graph. */
export const MAX_NODES = 32;
/** Most numeric literals (const and scale), packed into the binding 24 uniform. */
export const MAX_NODE_CONSTS = 16;

const OPS = new Set([
  'const',
  'attribute',
  'add',
  'mul',
  'sub',
  'mix',
  'min',
  'max',
  'scale',
  'normalize',
  'length',
  'force',
  'drag',
]);
const ATTRIBUTES = new Set(['position', 'velocity', 'size', 'color', 'life', 'age']);
const BINARY = new Set(['add', 'mul', 'sub', 'min', 'max']);

/**
 * The force sum, plain and after `fields` has appended its term. Obstacles rewrites that sum into `var force`, so
 * either form is the acceleration added before `* dt`. Node acceleration goes after fields.
 */
const FIELD_FORCE = 'f.gravityDelta.xyz+curlNoise(p.positionLife.xyz)+fieldForce(p.positionLife.xyz)';
const PLAIN_FORCE = 'f.gravityDelta.xyz+curlNoise(p.positionLife.xyz)';
const COLD_LOAD = 'var p=Particle(particles[at],particles[at+1],vec4f(0),vec4f(0));';

const signatures = new WeakMap<object, string>();

const attrWidth = (name: string): 1 | 3 => (name === 'position' || name === 'velocity' || name === 'color' ? 3 : 1);
const attrExpr = (name: string): string =>
  ({
    position: 'p.positionLife.xyz',
    velocity: 'p.velocitySize.xyz',
    size: 'p.velocitySize.w',
    color: 'p.color.rgb',
    life: 'p.positionLife.w',
    age: '(p.rotation.z-p.positionLife.w)',
  })[name]!;

interface Prepared {
  signature: string;
  /** Declarations inserted before `fn update`, including `fn nodeAccel`. */
  wgsl: string;
  /** Empty when the live graph has no numeric literal, so binding 24 is not used. */
  constants: Float32Array;
  needsCold: boolean;
}

function fail(message: string): never {
  throw new TypeError(message);
}

const finite = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`VFX nodes ${what} needs a finite number`);
  if (!Number.isFinite(Math.fround(value)))
    throw new RangeError(`VFX nodes ${what} is not a finite f32; see https://margoengine.com/errors#vfx-f32`);
  return value;
};

/**
 * Operators in dataflow order. A node runs after the nodes it reads (Kahn 1962). Numeric literals are not part of
 * the signature, so they can change every frame; the operators and the wires cannot.
 */
const prepare = (graph: readonly VFXNode[]): Prepared => {
  if (!Array.isArray(graph) || graph.length > MAX_NODES)
    fail(`VFX nodes graph must be an array of at most ${MAX_NODES} operators`);
  const count = graph.length;
  const inputs = graph.map((node, index) => {
    if (!node || typeof node !== 'object' || !OPS.has(node.op)) fail(`VFX nodes graph[${index}] needs a known op`);
    const list = node.inputs ?? [];
    if (
      !Array.isArray(list) ||
      list.some((input) => !Number.isInteger(input) || input < 0 || input >= count || input === index)
    )
      fail(`VFX nodes graph[${index}].inputs must be indices of other operators`);
    return list as number[];
  });
  const need = (index: number, n: number) => {
    if (inputs[index].length !== n) fail(`VFX nodes graph[${index}] (${graph[index].op}) needs ${n} inputs`);
  };
  graph.forEach((node, index) => {
    if (node.op === 'const' || node.op === 'attribute') need(index, 0);
    else if (BINARY.has(node.op)) need(index, 2);
    else if (node.op === 'mix') need(index, 3);
    else need(index, 1);
    if (node.op === 'attribute' && (typeof node.value !== 'string' || !ATTRIBUTES.has(node.value)))
      fail('VFX nodes attribute needs position, velocity, size, color, life or age');
    if (node.op === 'const') {
      const literal = node.value;
      if (Array.isArray(literal)) {
        if (literal.length !== 3) fail('VFX nodes const vector needs 3 finite numbers');
        finite(literal[0], 'const[0]');
        finite(literal[1], 'const[1]');
        finite(literal[2], 'const[2]');
      } else finite(literal, 'const');
    }
    if (node.op === 'scale') finite(node.value, 'scale');
  });
  const deps = Array.from({ length: count }, () => 0);
  const next: number[][] = Array.from({ length: count }, () => []);
  inputs.forEach((list, index) => {
    for (const input of list) {
      deps[index] += 1;
      next[input].push(index);
    }
  });
  const queue = deps.flatMap((used, index) => (used === 0 ? [index] : []));
  const order: number[] = [];
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    order.push(index);
    for (const child of next[index]) {
      deps[child] -= 1;
      if (deps[child] === 0) queue.push(child);
    }
  }
  if (order.length !== count) fail('VFX nodes graph has a cycle');

  const widths = Array.from({ length: count }, () => 0 as 0 | 1 | 3);
  const output = (index: number, want: 1 | 3): 1 | 3 => {
    const width = widths[index];
    if (width === 0) fail(`VFX nodes graph[${index}] has no output (force and drag only add acceleration)`);
    if (width !== want && !(width === 1 && want === 3))
      fail(`VFX nodes graph[${index}] is the wrong width for this input`);
    return width;
  };
  for (const index of order) {
    const node = graph[index];
    const read = inputs[index];
    if (node.op === 'const') widths[index] = Array.isArray(node.value) ? 3 : 1;
    else if (node.op === 'attribute') widths[index] = attrWidth(node.value as string);
    else if (BINARY.has(node.op)) {
      const left = output(read[0], 3);
      const right = output(read[1], 3);
      widths[index] = left === 3 || right === 3 ? 3 : 1;
      if (left === 1) output(read[0], 1);
      if (right === 1) output(read[1], 1);
    } else if (node.op === 'mix') {
      const left = output(read[0], 3);
      const right = output(read[1], 3);
      output(read[2], 1);
      widths[index] = left === 3 || right === 3 ? 3 : 1;
    } else if (node.op === 'scale' || node.op === 'normalize' || node.op === 'force') {
      output(read[0], 3);
      if (widths[read[0]] !== 3) fail(`VFX nodes graph[${index}] (${node.op}) needs a vector`);
      widths[index] = node.op === 'force' ? 0 : 3;
    } else if (node.op === 'length') {
      output(read[0], 3);
      if (widths[read[0]] !== 3) fail('VFX nodes length needs a vector');
      widths[index] = 1;
    } else if (node.op === 'drag') {
      output(read[0], 1);
      if (widths[read[0]] !== 1) fail('VFX nodes drag needs a number');
    }
  }

  const live = new Set<number>();
  const mark = (index: number) => {
    if (live.has(index)) return;
    live.add(index);
    for (const input of inputs[index]) mark(input);
  };
  graph.forEach((node, index) => {
    if (node.op === 'force' || node.op === 'drag') mark(index);
  });

  const slots: number[] = [];
  const pack: number[] = [];
  const take = (x: number, y = 0, z = 0): number => {
    if (pack.length / 4 >= MAX_NODE_CONSTS) fail(`VFX nodes supports at most ${MAX_NODE_CONSTS} numeric literals`);
    const slot = pack.length / 4;
    pack.push(x, y, z, 0);
    return slot;
  };
  for (const index of order) {
    if (!live.has(index)) continue;
    const node = graph[index];
    if (node.op === 'const' && Array.isArray(node.value))
      slots[index] = take(node.value[0], node.value[1], node.value[2]);
    else if (node.op === 'const') slots[index] = take(node.value as number);
    else if (node.op === 'scale') slots[index] = take(node.value as number);
  }

  const ref = (index: number, want: 1 | 3): string => {
    const name = `n${index}`;
    if (widths[index] === want) return name;
    return `vec3f(${name})`;
  };
  const lines = ['fn nodeAccel(p:Particle)->vec3f{', 'var a=vec3f(0.0);'];
  let norm = false;
  const opOf = (name: string) => (name === 'add' ? '+' : name === 'sub' ? '-' : name === 'mul' ? '*' : name);
  for (const index of order) {
    if (!live.has(index)) continue;
    const node = graph[index];
    const read = inputs[index];
    if (node.op === 'const')
      lines.push(`let n${index}=nodeParams[${slots[index]}].${widths[index] === 3 ? 'xyz' : 'x'};`);
    else if (node.op === 'attribute') lines.push(`let n${index}=${attrExpr(node.value as string)};`);
    else if (BINARY.has(node.op)) {
      const want = widths[index] as 1 | 3;
      const fn = opOf(node.op);
      lines.push(
        fn === '+' || fn === '-' || fn === '*'
          ? `let n${index}=${ref(read[0], want)}${fn}${ref(read[1], want)};`
          : `let n${index}=${fn}(${ref(read[0], want)},${ref(read[1], want)});`,
      );
    } else if (node.op === 'mix') {
      const want = widths[index] as 1 | 3;
      lines.push(`let n${index}=mix(${ref(read[0], want)},${ref(read[1], want)},${ref(read[2], 1)});`);
    } else if (node.op === 'scale') lines.push(`let n${index}=${ref(read[0], 3)}*nodeParams[${slots[index]}].x;`);
    else if (node.op === 'normalize') {
      norm = true;
      lines.push(`let n${index}=nodeNorm(n${read[0]});`);
    } else if (node.op === 'length') lines.push(`let n${index}=length(n${read[0]});`);
    else if (node.op === 'force') lines.push(`a+=${ref(read[0], 3)};`);
    else lines.push(`a-=${ref(read[0], 1)}*p.velocitySize.xyz;`);
  }
  lines.push('return a;}');
  const body = lines.join('\n');
  // Scaled Euclidean length (Blue, ACM TOMS 4(1), 1978): divide by the largest absolute component, then by that
  // vector's length. The CPU evaluator below uses the same steps, and WebGL2 translates this function as written.
  const scaled = norm
    ? 'fn nodeNorm(v:vec3f)->vec3f{let a=max(abs(v.x),max(abs(v.y),abs(v.z)));if(a==0.0){return vec3f(0.0);}let s=v/a;return s/length(s);}\n'
    : '';
  const uniform =
    pack.length === 0 ? '' : `@group(0) @binding(24) var<uniform> nodeParams:array<vec4f,${pack.length / 4}>;\n`;
  const needsCold = order.some(
    (index) =>
      live.has(index) &&
      graph[index].op === 'attribute' &&
      (graph[index].value === 'color' || graph[index].value === 'age'),
  );
  const signature = graph
    .map((node, index) => {
      const kind =
        node.op === 'const'
          ? Array.isArray(node.value)
            ? 'v'
            : 's'
          : node.op === 'attribute'
            ? String(node.value)
            : node.op === 'scale'
              ? 's'
              : '';
      return `${node.op}:${inputs[index].join('.')}:${kind}`;
    })
    .join('|');
  return { signature, wgsl: uniform + scaled + body + '\n', constants: new Float32Array(pack), needsCold };
};

/** Acceleration a graph adds, for the same sample the shader reads. `force` sums, `drag` subtracts coefficient times velocity. */
export const evaluateNodes = (graph: readonly VFXNode[], sample: VFXNodeSample): [number, number, number] => {
  prepare(graph);
  const count = graph.length;
  const inputs = graph.map((node) => node.inputs ?? []);
  const deps = Array.from({ length: count }, () => 0);
  const next: number[][] = Array.from({ length: count }, () => []);
  inputs.forEach((list, index) => {
    for (const input of list) {
      deps[index] += 1;
      next[input].push(index);
    }
  });
  const queue = deps.flatMap((used, index) => (used === 0 ? [index] : []));
  const order: number[] = [];
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    order.push(index);
    for (const child of next[index]) {
      deps[child] -= 1;
      if (deps[child] === 0) queue.push(child);
    }
  }
  const values: ({ kind: 1; n: number } | { kind: 3; v: [number, number, number] } | { kind: 0 })[] = [];
  const read = (index: number) => values[index];
  const vec = (index: number): [number, number, number] => {
    const value = read(index);
    if (value.kind === 3) return value.v;
    if (value.kind === 1) return [value.n, value.n, value.n];
    return fail(`VFX nodes graph[${index}] has no output`);
  };
  const num = (index: number): number => {
    const value = read(index);
    if (value.kind === 1) return value.n;
    return fail(`VFX nodes graph[${index}] needs to be a number`);
  };
  let ax = 0,
    ay = 0,
    az = 0;
  const attr = (name: string) => {
    if (name === 'position') return { kind: 3 as const, v: [...sample.position] as [number, number, number] };
    if (name === 'velocity') return { kind: 3 as const, v: [...sample.velocity] as [number, number, number] };
    if (name === 'color') return { kind: 3 as const, v: [...sample.color] as [number, number, number] };
    if (name === 'size') return { kind: 1 as const, n: sample.size };
    if (name === 'life') return { kind: 1 as const, n: sample.life };
    return { kind: 1 as const, n: sample.age };
  };
  for (const index of order) {
    const node = graph[index];
    const list = inputs[index];
    if (node.op === 'const') {
      values[index] = Array.isArray(node.value)
        ? { kind: 3, v: [node.value[0], node.value[1], node.value[2]] }
        : { kind: 1, n: node.value as number };
    } else if (node.op === 'attribute') values[index] = attr(node.value as string);
    else if (BINARY.has(node.op) || node.op === 'mix') {
      const wider = read(list[0]).kind === 3 || read(list[1]).kind === 3;
      const pick = (side: number) => (wider ? vec(side) : [num(side), 0, 0]);
      const left = pick(list[0]);
      const right = pick(list[1]);
      const t = node.op === 'mix' ? num(list[2]) : 0;
      const each = (fn: (a: number, b: number) => number): [number, number, number] => [
        fn(left[0], right[0]),
        fn(left[1], right[1]),
        fn(left[2], right[2]),
      ];
      const mixed = each((a, b) => a * (1 - t) + b * t);
      const out =
        node.op === 'add'
          ? each((a, b) => a + b)
          : node.op === 'sub'
            ? each((a, b) => a - b)
            : node.op === 'mul'
              ? each((a, b) => a * b)
              : node.op === 'min'
                ? each((a, b) => Math.min(a, b))
                : node.op === 'max'
                  ? each((a, b) => Math.max(a, b))
                  : mixed;
      values[index] = wider ? { kind: 3, v: out } : { kind: 1, n: out[0] };
    } else if (node.op === 'scale') {
      const v = vec(list[0]);
      const s = node.value as number;
      values[index] = { kind: 3, v: [v[0] * s, v[1] * s, v[2] * s] };
    } else if (node.op === 'normalize') {
      const v = vec(list[0]);
      const scale = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
      if (scale === 0) values[index] = { kind: 3, v: [0, 0, 0] };
      else {
        const sx = v[0] / scale,
          sy = v[1] / scale,
          sz = v[2] / scale,
          len = Math.hypot(sx, sy, sz);
        values[index] = { kind: 3, v: [sx / len, sy / len, sz / len] };
      }
    } else if (node.op === 'length') values[index] = { kind: 1, n: Math.hypot(...vec(list[0])) };
    else if (node.op === 'force') {
      const v = vec(list[0]);
      ax += v[0];
      ay += v[1];
      az += v[2];
      values[index] = { kind: 0 };
    } else {
      const s = num(list[0]);
      ax -= s * sample.velocity[0];
      ay -= s * sample.velocity[1];
      az -= s * sample.velocity[2];
      values[index] = { kind: 0 };
    }
  }
  return [ax, ay, az];
};

const splice = (code: string, prepared: Prepared): string => {
  const force = code.includes(FIELD_FORCE) ? FIELD_FORCE : code.includes(PLAIN_FORCE) ? PLAIN_FORCE : '';
  if (!force || code.split(force).length !== 2)
    throw new MargoError('unsupported', 'VFX nodes need the simulation shader they were written for; update the edit');
  let next = code.replace(force, `${force}+nodeAccel(p)`);
  if (prepared.needsCold) {
    if (!next.includes(COLD_LOAD))
      throw new MargoError(
        'unsupported',
        'VFX nodes need the simulation shader they were written for; update the edit',
      );
    next = next.replace(COLD_LOAD, 'var p=Particle(particles[at],particles[at+1],particles[cold],particles[cold+1]);');
  }
  return next.replace('fn update(', `${prepared.wgsl}fn update(`);
};

/**
 * Custom particle update: a graph of operators compiled into the simulation, after gravity, curl and fields.
 * Built from Reeves 1983 (velocity, then position, from acceleration times the step) and a dataflow graph
 * (Dennis 1974; Kahn 1962 for the order). Pass `{nodes}` from this entry. Const and scale numbers are read
 * every frame from one uniform (group 0 binding 24); the operators and wires are fixed at attach.
 */
export const nodes: VFXExtension<VFXNodes> = {
  validate(value) {
    if (!value || typeof value !== 'object') fail('VFX nodes must be an object; pass {graph}');
    const prepared = prepare(value.graph);
    const fixed = signatures.get(value);
    if (fixed !== undefined && fixed !== prepared.signature)
      fail('VFX nodes are fixed at attach; change const and scale values in place');
  },
  simulation(code, value) {
    const prepared = prepare(value.graph);
    signatures.set(value, prepared.signature);
    return splice(code, prepared);
  },
  create(state: VFXState, value, owned) {
    const first = prepare(value.graph);
    const buffer =
      first.constants.length === 0
        ? undefined
        : state.device.createBuffer({
            size: first.constants.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
    if (buffer) owned.push(buffer);
    return {
      compute: buffer ? [{ binding: 24, resource: { buffer } }] : [],
      write(c) {
        const now = state.options.nodes;
        if (now !== value) fail('VFX nodes are fixed at attach; change const and scale values in place');
        const next = prepare(now.graph);
        if (next.signature !== first.signature)
          fail('VFX nodes are fixed at attach; change const and scale values in place');
        if (buffer) c.device.queue.writeBuffer(buffer, 0, next.constants as Float32Array<ArrayBuffer>);
      },
    };
  },
};
