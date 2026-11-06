// Statements inside node graphs: mutable variables, branches that run one side only, loops that can exit early.
// A statement is a node pushed onto `effects.list` in the order the body made it, so a ComputePass, a `block` and a
// branch body all run the same way, and an unused feature leaves nothing in the generated shader.
import {
  FIXED,
  LEAF,
  MUTABLE,
  Node,
  ONCE,
  STMT,
  cast,
  constant,
  isMatrix,
  scalarOf,
  sizeOf,
  unique,
  type Builder,
  type NodeInput,
  type Resource,
  type Type,
} from './node.js';
import { effects, type Write } from './scope.js';

type Body = () => unknown;
const fail = (message: string): never => {
  throw new TypeError(message);
};
/** @internal Adds a statement to the body being recorded. */
export function push<T extends Node>(n: T, name: string): T {
  (effects.list ?? fail(`${name} runs inside block(), a ComputePass body or another statement body`)).push(n);
  return n;
}
/** @internal A node that writes statements and has no value. */
export const statement = (args: Node[], emit: (b: Builder, n: Node) => void): Node =>
  new Node(
    'bool',
    'S' + unique(),
    args,
    (b, n) => {
      emit(b, n);
      return 'false';
    },
    STMT,
  );
/** A storage write made in a statement body: it happens here, in order with the statements around it. */
function write(w: Write): void {
  push(
    statement([w.index, w.value], (b, n) => {
      if (b.stage.kind !== 'compute') fail('Storage writes are only available in ComputePass nodes');
      const [i, v] = n.args.map((a) => b.expr(a)),
        at = `${b.resource(w.buffer as unknown as Resource)}[${i}]`;
      b.line(w.buffer.atomic ? `atomicStore(&${at}, ${v});` : `${at} = ${v};`);
    }),
    'store',
  );
}
/** Runs `body`, returning the statements it made. */
function record(body: Body): Node[] {
  const { list, store } = effects,
    made: Node[] = (effects.list = []);
  effects.store = write;
  try {
    body();
  } finally {
    effects.list = list;
    effects.store = store;
  }
  return made;
}
// How many loops and switches enclose the statement being emitted; a `block` starts again, since a value cannot break.
const depth = new WeakMap<Builder, { loops: number; breaks: number }>(),
  nesting = (b: Builder) => {
    let d = depth.get(b);
    if (!d) depth.set(b, (d = { loops: 0, breaks: 0 }));
    return d;
  };
const declared = new WeakMap<Node, Node>();
/** Emits `list` into the current scope; its variables end with it. */
function run(b: Builder, list: readonly Node[], after?: () => void): void {
  for (const s of list) b.expr(s);
  after?.();
  for (const s of list) {
    const v = declared.get(s);
    if (v) b.unbind(v);
  }
}
/** Emits `list` in a scope of its own and returns the lines, indented for a `{ ... }`. */
function scoped(b: Builder, list: readonly Node[]): string[] {
  b.push();
  run(b, list);
  return b.pop().map((l) => '  ' + l);
}
function lines(b: Builder, text: readonly string[]): void {
  for (const l of text) b.line(l);
}
function assignment(target: Node, at: Node | undefined, value: Node): void {
  push(
    statement(at ? [target, at, value] : [target, value], (b, n) => {
      const parts = n.args.map((a) => b.expr(a));
      b.epoch++;
      b.line(at ? `${parts[0]}[${parts[1]}] = ${parts[2]};` : `${parts[0]} = ${parts[1]};`);
    }),
    'assign',
  );
}

/**
 * A variable that statements can change: `const sum = Var(vec3(0)); sum.assign(sum.add(c));`. It is a node, so it reads
 * like any other. A node that reads it is worked out where it is used, so it sees the value at that statement;
 * {@link Let} keeps a value as it is now.
 */
export class VarNode<T extends Type = Type> extends Node<T> {
  constructor(type: T) {
    super(type, 'V' + unique(), [], (b, n) => b.param(n), LEAF | MUTABLE);
  }
  /** `this = value`. */
  assign(value: NodeInput<T>): void {
    assignment(this, undefined, cast(value, this.type, 'assigned value'));
  }
  /** `this += value`; `value` follows the rules of `add`. */
  addAssign(value: NodeInput): void {
    this.assign(this.add(value as never) as never);
  }
  /** `this -= value`. */
  subAssign(value: NodeInput): void {
    this.assign(this.sub(value as never) as never);
  }
  /** `this *= value`. */
  mulAssign(value: NodeInput): void {
    this.assign(this.mul(value as never) as never);
  }
  /** `this /= value`. */
  divAssign(value: NodeInput): void {
    this.assign(this.div(value as never) as never);
  }
  /** `this[index] = value`: one component of a vector, or one column of a matrix. */
  assignElement(index: NodeInput<'i32' | 'u32'>, value: NodeInput): void {
    const matrix = isMatrix(this.type);
    if (!matrix && sizeOf(this.type) === 1) fail('assignElement() needs a vector or matrix Var');
    const at = index instanceof Node ? index : constant(index, 'i32'),
      element = (matrix ? `vec${this.type[3]}f` : scalarOf(this.type)) as Type;
    assignment(this, at, cast(value, element, 'assigned element'));
  }
}
/**
 * Declares a variable here, set to `init`. A number is f32 unless `type` says otherwise: `Var(0, 'u32')`.
 * @throws TypeError outside a statement body, or when `init` is not of `type`.
 */
export function Var<T extends Type>(init: Node<T>): VarNode<T>;
export function Var(init: number): VarNode<'f32'>;
export function Var<T extends Type>(init: NodeInput<T> | boolean, type: T): VarNode<T>;
export function Var<T extends Type>(init: NodeInput | boolean, type?: T): VarNode<T> {
  const first = cast(
      init,
      type ?? (init instanceof Node ? init.type : typeof init === 'boolean' ? 'bool' : 'f32'),
      'Var value',
    ),
    v = new VarNode(first.type as T);
  const s = statement([first], (b, n) => {
    const value = b.expr(n.args[0]),
      name = b.name();
    b.line(`var ${name}:${v.type} = ${value};`);
    b.bind(v, name);
  });
  push(s, 'Var');
  declared.set(s, v);
  return v;
}
/** Keeps `value` as it is at this point of the body, whatever is assigned later. Use it in this body or ones inside it. */
export function Let<T extends Type>(value: Node<T>): Node<T> {
  return push(
    new Node(
      value.type,
      'S' + unique(),
      [value],
      (b, n) => {
        const code = b.expr(n.args[0]),
          name = b.name();
        b.line(`let ${name} = ${code};`);
        return name;
      },
      STMT | FIXED | ONCE,
    ),
    'Let',
  );
}
/**
 * A value worked out by statements. The body runs at build time and records them; what it returns is the value:
 * `colorNode: block(() => { const c = Var(vec3(0)); If(a, () => c.assign(b)); return c; })`.
 * @throws TypeError when the body returns no node.
 */
export function block<T extends Type>(body: () => Node<T>): Node<T> {
  let value: Node<T> | undefined;
  const list = record(() => {
    value = body();
  });
  if (!(value instanceof Node)) fail('A block() body must return the node it worked out');
  const result = value as Node<T>;
  return new Node(
    result.type,
    'S' + unique(),
    [...list, result],
    (b) => {
      const outer = nesting(b),
        name = b.name();
      depth.set(b, { loops: 0, breaks: 0 });
      run(b, list, () => b.line(`let ${name} = ${b.expr(result)};`));
      depth.set(b, outer);
      return name;
    },
    STMT | FIXED,
  );
}
/** What `If` returns, to add the other branches. */
export interface Branch {
  /** Runs `body` when the earlier conditions failed and `condition` holds; its condition is only worked out then. */
  ElseIf(condition: NodeInput<'bool'> | boolean, body: Body): Branch;
  /** Runs `body` when every condition failed. */
  Else(body: Body): void;
}
/**
 * Runs `body` only when `condition` holds, unlike `select`, which works out both sides. Chain `.ElseIf()` and `.Else()`.
 * @throws TypeError outside a statement body, or when `condition` is not a bool (a bool vector needs `select`).
 */
export function If(condition: NodeInput<'bool'> | boolean, body: Body): Branch {
  const conditions = [cast(condition, 'bool', 'If condition')],
    bodies = [record(body)],
    args: Node[] = [conditions[0], ...bodies[0]];
  let otherwise: Node[] | undefined;
  const chain = (b: Builder, i: number): void => {
    const test = b.expr(conditions[i]),
      then = scoped(b, bodies[i]);
    let rest = otherwise && i + 1 === conditions.length ? scoped(b, otherwise) : undefined;
    if (i + 1 < conditions.length) {
      b.push();
      chain(b, i + 1);
      rest = b.pop().map((l) => '  ' + l);
    }
    b.line(`if (${test}) {`);
    lines(b, then);
    if (rest) {
      b.line('} else {');
      lines(b, rest);
    }
    b.line('}');
  };
  push(
    statement(args, (b) => chain(b, 0)),
    'If',
  );
  const branch: Branch = {
    ElseIf(next, then) {
      if (otherwise) fail('ElseIf comes before Else');
      const test = cast(next, 'bool', 'ElseIf condition'),
        list = record(then);
      conditions.push(test);
      bodies.push(list);
      args.push(test, ...list);
      return branch;
    },
    Else(then) {
      if (otherwise) fail('If has two Else bodies');
      otherwise = record(then);
      args.push(...otherwise);
    },
  };
  return branch;
}
/** The bounds of a {@link Loop}: `i` runs from `from` (default 0) up to but not including `to`, by `step` (default 1). A negative step counts down, stopping before `to`. */
export interface LoopRange {
  from?: NodeInput<'i32' | 'u32'>;
  to: NodeInput<'i32' | 'u32'>;
  step?: number;
}
const bound = (x: NodeInput<'i32' | 'u32'>): Node<'i32'> =>
  x instanceof Node ? (x.type === 'i32' ? (x as Node<'i32'>) : (x.toInt() as Node<'i32'>)) : constant(x, 'i32');
/** Emits a loop's body with the loop nesting raised. */
function inLoop(b: Builder, list: readonly Node[]): string[] {
  const d = nesting(b);
  d.loops++;
  d.breaks++;
  const body = scoped(b, list);
  d.loops--;
  d.breaks--;
  return body;
}
/**
 * Runs `body` for each `i`, with `Break()` and `Continue()` available: `Loop(64, i => { ...; If(done, () => Break()); })`.
 * Takes a count or a {@link LoopRange}. `loop` is the plain fold; this one is for early exits and for changing several `Var`s.
 * @throws TypeError outside a statement body, or for a step that is not a non-zero integer.
 */
export function Loop(range: NodeInput<'i32' | 'u32'> | LoopRange, body: (i: Node<'i32'>) => unknown): void {
  const { from = 0, to, step = 1 } = typeof range === 'number' || range instanceof Node ? { to: range } : range;
  if (!Number.isInteger(step) || step === 0) fail('Loop step must be a non-zero integer');
  const i = new Node('i32', 'p' + unique(), [], (b, n) => b.param(n), LEAF),
    list = record(() => body(i));
  push(
    statement([bound(from), bound(to), ...list], (b, n) => {
      const start = b.expr(n.args[0]),
        limit = b.expr(n.args[1]),
        end = b.name(),
        k = b.name();
      // The bound is worked out once: the body may change a Var it reads.
      b.line(`let ${end} = ${limit};`);
      b.bind(i, k);
      b.epoch++;
      const code = inLoop(b, list);
      b.line(`for (var ${k} = ${start}; ${k} ${step > 0 ? '<' : '>'} ${end}; ${k} += ${step}i) {`);
      lines(b, code);
      b.line('}');
    }),
    'Loop',
  );
}
/**
 * Runs `body` while `condition` holds, tested before each pass, so it must read a `Var` that the body changes:
 * `While(n.greaterThan(1), () => n.assign(n.div(2)))`. A condition that never fails hangs the GPU until the browser resets it.
 * @throws TypeError outside a statement body, or when `condition` is not a bool.
 */
export function While(condition: Node<'bool'>, body: Body): void {
  const test = cast(condition, 'bool', 'While condition'),
    list = record(body);
  push(
    statement([test, ...list], (b) => {
      b.epoch++;
      b.push();
      b.line(`  if (!(${b.expr(test)})) { break; }`);
      lines(b, inLoop(b, list));
      const code = b.pop();
      b.line('loop {');
      lines(b, code);
      b.line('}');
    }),
    'While',
  );
}
/** Leaves the innermost `Loop`, `While` or `Switch` (inside a `Case` it ends the Switch, as in C and WGSL). */
export function Break(): void {
  push(
    statement([], (b) => {
      if (!nesting(b).breaks) fail('Break() needs a Loop, While or Switch around it in the same block');
      b.line('break;');
    }),
    'Break',
  );
}
/** Goes on to the next pass of the innermost `Loop` or `While`. */
export function Continue(): void {
  push(
    statement([], (b) => {
      if (!nesting(b).loops) fail('Continue() needs a Loop or While around it in the same block');
      b.line('continue;');
    }),
    'Continue',
  );
}
/** What `Switch` returns, to add its cases. */
export interface Cases {
  /** Runs `body` when the selector equals one of `values` (integers, one or more). There is no fall-through. */
  Case(values: number | readonly number[], body: Body): Cases;
  /** Runs `body` when no case matched. Without it nothing runs. */
  Default(body: Body): void;
}
/**
 * Picks one body by an integer: `Switch(mode).Case(0, () => ...).Case([1, 2], () => ...).Default(() => ...)`.
 * @throws TypeError outside a statement body, when `selector` is not i32 or u32, for a repeated case, or for a second Default.
 */
export function Switch(selector: Node<'i32' | 'u32'>): Cases {
  const type = selector?.type;
  if (type !== 'i32' && type !== 'u32') fail(`Switch needs an i32 or u32 node, got ${type}`);
  const clauses: { labels: Node[]; list: Node[] }[] = [],
    seen = new Set<number>(),
    args: Node[] = [selector];
  let fallback: Node[] | undefined;
  push(
    statement(args, (b) => {
      const value = b.expr(selector),
        d = nesting(b),
        arm = (list: readonly Node[]) => {
          d.breaks++;
          const code = scoped(b, list);
          d.breaks--;
          return code.map((l) => '  ' + l);
        },
        code = clauses.map((c) => [c.labels.map((l) => b.expr(l)).join(', '), arm(c.list)] as const),
        other = arm(fallback ?? []);
      b.line(`switch (${value}) {`);
      for (const [labels, body] of code) {
        b.line(`  case ${labels}: {`);
        lines(b, body);
        b.line('  }');
      }
      b.line('  default: {');
      lines(b, other);
      b.line('  }');
      b.line('}');
    }),
    'Switch',
  );
  const cases: Cases = {
    Case(values, body) {
      const labels = [values].flat() as number[];
      if (!labels.length) fail('Case needs at least one value');
      for (const v of labels) {
        if (seen.has(v)) fail(`Switch has two cases for ${v}`);
        seen.add(v);
      }
      const list = record(body);
      clauses.push({ labels: labels.map((v) => constant(v, type)), list });
      args.push(...list);
      return cases;
    },
    Default(body) {
      if (fallback) fail('Switch has two Default bodies');
      fallback = record(body);
      args.push(...fallback);
    },
  };
  return cases;
}
