import {
  SURFACE_GRAPH_LIMITS,
  SURFACE_OPERATIONS,
  inspectSurfaceGraph,
  serializeSurfaceGraph,
  validateSurfaceGraph,
  type SurfaceFallback,
  type SurfaceGraph,
  type SurfaceGraphNode,
  type SurfaceOperation,
} from './graph.js';

/** A material output slot a graph can drive. */
export type OutputSlot = 'color' | 'roughness' | 'metalness' | 'emissive' | 'opacity' | 'normal';
/** Where each node sits, in editor pixels, by node id; the key `output` is the material output panel. */
export type GraphLayout = Record<string, readonly [number, number]>;
/** One node of the graph being edited. `inputs[i]` is the id of the node wired to input `i`, or null. */
export interface EditorNode {
  id: string;
  op: SurfaceOperation;
  /** Source node id per input, null while unconnected. */
  inputs: (string | null)[];
  /** The constant of a `float` or `vec3` node, or the component index (0, 1, 2) of a `component` node. */
  value?: number | [number, number, number];
  /** Constants typed into unconnected inputs that have a default; undefined keeps the operation's default. */
  inline: (number | undefined)[];
  x: number;
  y: number;
}
/** What {@link GraphModel.status} reports. */
export interface EditorStatus {
  /** True when the graph validates and can be compiled. */
  ok: boolean;
  /** A short sentence: what is valid, or what to fix. */
  message: string;
  /** The node the message is about, when it names one. */
  node: string | null;
  /** Output type of every node while `ok` (f32 or vec3f), else empty. */
  types: Record<string, 'f32' | 'vec3f'>;
}
/** Why a listener was called: `graph` for any change to nodes, wires, values or outputs (including undo), `layout` for moves only. */
export type ModelEvent = 'graph' | 'layout';
/** The kinds of node on the palette, in the order shown. */
export type OperationGroup = 'Input' | 'Constant' | 'Math' | 'Vector' | 'Shaping';
/** Palette entry of one operation. */
export interface EditorOperation {
  op: SurfaceOperation;
  label: string;
  group: OperationGroup;
  description: string;
}

/** Every operation the portable surface graph supports, with the name and one-line help the palette shows. */
export const EDITOR_OPERATIONS: readonly EditorOperation[] = Object.freeze([
  {
    op: 'position',
    label: 'Position',
    group: 'Input',
    description: 'Object-space position of the surface point (vec3).',
  },
  { op: 'worldPosition', label: 'World position', group: 'Input', description: 'World-space position (vec3).' },
  { op: 'normal', label: 'Normal', group: 'Input', description: 'Object-space surface normal (vec3).' },
  { op: 'worldNormal', label: 'World normal', group: 'Input', description: 'World-space surface normal (vec3).' },
  { op: 'color', label: 'Vertex color', group: 'Input', description: 'Linear vertex color (vec3).' },
  { op: 'uv', label: 'UV', group: 'Input', description: 'Texture coordinates as (u, v, 0) (vec3).' },
  { op: 'float', label: 'Number', group: 'Constant', description: 'A constant number (f32).' },
  { op: 'vec3', label: 'Vector', group: 'Constant', description: 'A constant vector or linear RGB color (vec3).' },
  { op: 'add', label: 'Add', group: 'Math', description: 'A + B; a number combines with a vector.' },
  { op: 'sub', label: 'Subtract', group: 'Math', description: 'A - B.' },
  { op: 'mul', label: 'Multiply', group: 'Math', description: 'A * B, per component.' },
  { op: 'div', label: 'Divide', group: 'Math', description: 'A / B, per component.' },
  { op: 'min', label: 'Minimum', group: 'Math', description: 'The smaller of A and B.' },
  { op: 'max', label: 'Maximum', group: 'Math', description: 'The larger of A and B.' },
  { op: 'pow', label: 'Power', group: 'Math', description: 'Base raised to Exponent.' },
  { op: 'sin', label: 'Sine', group: 'Math', description: 'Sine of the value in radians.' },
  { op: 'cos', label: 'Cosine', group: 'Math', description: 'Cosine of the value in radians.' },
  { op: 'abs', label: 'Absolute', group: 'Math', description: 'Absolute value.' },
  { op: 'floor', label: 'Floor', group: 'Shaping', description: 'Round down to a whole number.' },
  { op: 'fract', label: 'Fraction', group: 'Shaping', description: 'The part after the decimal point.' },
  { op: 'saturate', label: 'Saturate', group: 'Shaping', description: 'Clamp to the range 0 to 1.' },
  { op: 'mix', label: 'Mix', group: 'Shaping', description: 'Blend A to B by Factor (0 gives A, 1 gives B).' },
  { op: 'clamp', label: 'Clamp', group: 'Shaping', description: 'Limit Value to between Min and Max.' },
  { op: 'length', label: 'Length', group: 'Vector', description: 'Length of a vector (f32).' },
  { op: 'dot', label: 'Dot', group: 'Vector', description: 'Dot product of two vectors (f32).' },
  { op: 'normalize', label: 'Normalize', group: 'Vector', description: 'Scale a vector to length 1.' },
  { op: 'component', label: 'Component', group: 'Vector', description: 'One component (X, Y or Z) of a vector (f32).' },
  { op: 'combine', label: 'Combine', group: 'Vector', description: 'Build a vector from three numbers (vec3).' },
]);
const labels: Partial<Record<SurfaceOperation, string[]>> = {
  add: ['A', 'B'],
  sub: ['A', 'B'],
  mul: ['A', 'B'],
  div: ['A', 'B'],
  min: ['A', 'B'],
  max: ['A', 'B'],
  pow: ['Base', 'Exponent'],
  mix: ['A', 'B', 'Factor'],
  clamp: ['Value', 'Min', 'Max'],
  dot: ['A', 'B'],
  combine: ['X', 'Y', 'Z'],
  component: ['Vector'],
  length: ['Vector'],
  normalize: ['Vector'],
};
/** Name of input `index` of an operation, as the editor labels its socket (`A`, `Factor`, `Vector`, ...). */
export const inputLabel = (op: SurfaceOperation, index: number): string => labels[op]?.[index] ?? 'Value';
/**
 * The constant an unconnected input takes, per operation and input; undefined means the input must be wired. The editor
 * adds these as hidden `float` nodes when it exports, so an unconnected `Factor` mixes halfway and `B` of `Multiply` is 1.
 */
export const INPUT_DEFAULTS: Readonly<Partial<Record<SurfaceOperation, readonly (number | undefined)[]>>> =
  Object.freeze({
    add: [undefined, 0],
    sub: [undefined, 0],
    mul: [undefined, 1],
    div: [undefined, 1],
    min: [undefined, 1],
    max: [undefined, 0],
    pow: [undefined, 1],
    mix: [undefined, undefined, 0.5],
    clamp: [undefined, 0, 1],
    combine: [0, 0, 0],
  });
/** The output slots, in the order the output panel lists them, with the type each accepts. */
export const OUTPUT_SLOTS: readonly { slot: OutputSlot; label: string; type: 'f32' | 'vec3f' }[] = Object.freeze([
  { slot: 'color', label: 'Color', type: 'vec3f' },
  { slot: 'roughness', label: 'Roughness', type: 'f32' },
  { slot: 'metalness', label: 'Metalness', type: 'f32' },
  { slot: 'emissive', label: 'Emissive', type: 'vec3f' },
  { slot: 'opacity', label: 'Opacity', type: 'f32' },
  { slot: 'normal', label: 'Normal', type: 'vec3f' },
] as const);

/** Width of every node in editor pixels. */
export const NODE_WIDTH = 176;
/** Height of a node's title bar. */
export const HEAD_HEIGHT = 26;
/** Height of one row (an input, a value field or the output label). */
export const ROW_HEIGHT = 24;
/** Padding above and below a node's rows. */
export const ROW_PADDING = 6;
/** Rows below the six slots on the output panel: fallback color, emissive and the three scalars. */
export const OUTPUT_EXTRA_ROWS = 3;
const hasValue = (op: SurfaceOperation): boolean => op === 'float' || op === 'vec3' || op === 'component';
/** Number of rows a node draws: its inputs, then its value field, with at least one for the output label. */
export const rowCount = (node: Pick<EditorNode, 'op' | 'inputs'>): number =>
  Math.max(1, node.inputs.length + (hasValue(node.op) ? 1 : 0));
/** Height of a node in editor pixels. */
export const nodeHeight = (node: Pick<EditorNode, 'op' | 'inputs'>): number =>
  HEAD_HEIGHT + 2 * ROW_PADDING + ROW_HEIGHT * rowCount(node);
/** Height of the output panel in editor pixels. */
export const OUTPUT_HEIGHT = HEAD_HEIGHT + 2 * ROW_PADDING + ROW_HEIGHT * (OUTPUT_SLOTS.length + OUTPUT_EXTRA_ROWS);
/** Centre of input socket `index` of a node, or of slot `index` of the output panel, in editor pixels. */
export const inputSocket = (at: { x: number; y: number }, index: number): [number, number] => [
  at.x,
  at.y + HEAD_HEIGHT + ROW_PADDING + ROW_HEIGHT * (index + 0.5),
];
/** Centre of a node's output socket in editor pixels. */
export const outputSocket = (at: { x: number; y: number }): [number, number] => [
  at.x + NODE_WIDTH,
  at.y + HEAD_HEIGHT + ROW_PADDING + ROW_HEIGHT * 0.5,
];

const COLUMN = NODE_WIDTH + 64;
const GAP = 20;
const HISTORY = 200;
const defaultFallback = (): SurfaceFallback => ({
  color: [0.8, 0.8, 0.8],
  emissive: [0, 0, 0],
  roughness: 0.5,
  metalness: 0,
  opacity: 1,
});
interface Snapshot {
  nodes: EditorNode[];
  outputs: Partial<Record<OutputSlot, string>>;
  fallback: SurfaceFallback;
  output: { x: number; y: number };
}
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(Math.fround(v)) && Math.abs(v) <= 1e6;
const escapeId = (id: string): string => id.replace(/-/g, '\\-');

/**
 * The editable state behind {@link NodeEditor}, with no DOM: nodes with positions, wires, constants, output wiring, undo
 * and redo. Incomplete graphs are allowed while editing (an unconnected input is just empty); {@link GraphModel.status}
 * says whether the graph validates and {@link GraphModel.toGraph} returns the portable `SurfaceGraph` once it does.
 * Unconnected inputs that have a default (see {@link INPUT_DEFAULTS}) become hidden constants on export.
 */
export class GraphModel {
  /** The nodes in creation order. Read them; change them through the methods so history and listeners stay right. */
  readonly nodes: EditorNode[] = [];
  /** Source node id per output slot. */
  outputs: Partial<Record<OutputSlot, string>> = {};
  /** Constants for hosts that cannot run graphs; see `SurfaceFallback`. */
  fallback: SurfaceFallback = defaultFallback();
  /** Position of the material output panel. */
  output = { x: 0, y: 0 };
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private readonly listeners = new Set<(event: ModelEvent) => void>();
  private depth = 0;
  private version = 0;
  private cached?: { version: number; status: EditorStatus };

  /**
   * @param graph A valid portable graph to edit; omit for an empty one.
   * @param layout Node positions by id (and `output`); nodes without one are arranged automatically.
   * @throws TypeError or RangeError from `validateSurfaceGraph` when `graph` is invalid (the message names the fix).
   */
  constructor(graph?: SurfaceGraph, layout?: GraphLayout) {
    if (graph) {
      validateSurfaceGraph(graph);
      this.fill(graph, layout);
    }
  }

  private fill(graph: SurfaceGraph, layout?: GraphLayout): void {
    this.nodes.length = 0;
    for (const n of graph.nodes)
      this.nodes.push({
        id: n.id,
        op: n.op,
        inputs: [...n.inputs],
        ...(n.value === undefined
          ? {}
          : { value: Array.isArray(n.value) ? ([...n.value] as [number, number, number]) : n.value }),
        inline: n.inputs.map(() => undefined),
        x: layout?.[n.id]?.[0] ?? Number.NaN,
        y: layout?.[n.id]?.[1] ?? Number.NaN,
      });
    this.outputs = { ...graph.outputs };
    this.fallback = structuredClone(graph.fallback);
    this.output = { x: layout?.output?.[0] ?? Number.NaN, y: layout?.output?.[1] ?? Number.NaN };
    if (this.nodes.some((n) => Number.isNaN(n.x) || Number.isNaN(n.y)) || Number.isNaN(this.output.x))
      this.arrange(true);
  }

  /** Node by id, or undefined. */
  node(id: string): EditorNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }
  /** Positions of every node and the output panel, to save beside the graph and pass back to the constructor. */
  get layout(): GraphLayout {
    return {
      ...Object.fromEntries(this.nodes.map((n) => [n.id, [n.x, n.y] as const])),
      output: [this.output.x, this.output.y],
    };
  }
  /** True when {@link GraphModel.undo} has a step to undo. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  /** True when {@link GraphModel.redo} has a step to redo. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  /** Calls `listener` after every change; returns a function that stops it. */
  subscribe(listener: (event: ModelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private snapshot(): string {
    return JSON.stringify({
      nodes: this.nodes,
      outputs: this.outputs,
      fallback: this.fallback,
      output: this.output,
    } satisfies Snapshot);
  }
  private restore(text: string): void {
    const s = JSON.parse(text) as Snapshot;
    this.nodes.splice(0, this.nodes.length, ...s.nodes);
    this.outputs = s.outputs;
    this.fallback = s.fallback;
    this.output = s.output;
  }
  private emit(event: ModelEvent): void {
    if (event === 'graph') this.version++;
    for (const listener of [...this.listeners]) listener(event);
  }
  /**
   * Records an undo step before the next change. Every editing method does this itself; call it once yourself before a
   * series of {@link GraphModel.move} calls (a drag) so the whole drag undoes in one step.
   */
  checkpoint(): void {
    if (this.depth) return;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  /**
   * Runs `edit` as one undo step with one notification. If it throws, the graph is restored and the error rethrown.
   */
  batch(edit: () => void): void {
    if (this.depth) return edit();
    const before = this.snapshot();
    this.checkpoint();
    this.depth++;
    try {
      edit();
    } catch (error) {
      this.restore(before);
      this.undoStack.pop();
      throw error;
    } finally {
      this.depth--;
    }
    if (this.snapshot() === before) {
      this.undoStack.pop(); // nothing changed: no undo step, no notification
      return;
    }
    this.emit('graph');
  }
  private change(edit: () => void): void {
    this.batch(edit);
  }

  private freshId(base: string): string {
    const taken = new Set(this.nodes.map((n) => n.id));
    for (let i = 1; ; i++) if (!taken.has(base + i)) return base + i;
  }
  private need(id: string): EditorNode {
    const n = this.node(id);
    if (!n) throw new RangeError(`There is no node "${id}"; pass the id of a node in this graph`);
    return n;
  }
  private dependsOn(id: string, target: string, seen = new Set<string>()): boolean {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (this.node(id)?.inputs ?? []).some((source) => source !== null && this.dependsOn(source, target, seen));
  }
  private checkValue(op: SurfaceOperation, value: unknown): number | [number, number, number] {
    if (op === 'float') {
      if (!finite(value))
        throw new RangeError('A float value must be a finite number within +-1000000; type a smaller number');
      return value;
    }
    if (op === 'vec3') {
      if (!Array.isArray(value) || value.length !== 3 || !value.every(finite))
        throw new RangeError('A vec3 value must be three finite numbers within +-1000000; pass [x, y, z]');
      return [value[0], value[1], value[2]];
    }
    if (op === 'component') {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2)
        throw new RangeError('A component index must be 0, 1 or 2; pick X, Y or Z');
      return value as number;
    }
    throw new TypeError(`A ${op} node has no value; only float, vec3 and component nodes do`);
  }

  /**
   * Adds a node of `op` at editor position `at` (default: the next free spot) and returns it.
   * @throws RangeError when the graph already has 128 nodes or `op` is unknown; the message names the fix.
   */
  addNode(op: SurfaceOperation, at?: readonly [number, number], value?: number | [number, number, number]): EditorNode {
    if (typeof op !== 'string' || !Object.hasOwn(SURFACE_OPERATIONS, op))
      throw new RangeError(
        `"${String(op)}" is not a surface operation; use one of ${Object.keys(SURFACE_OPERATIONS).join(', ')}`,
      );
    if (this.nodes.length >= SURFACE_GRAPH_LIMITS.nodes)
      throw new RangeError(`A graph holds at most ${SURFACE_GRAPH_LIMITS.nodes} nodes; delete some before adding more`);
    const node: EditorNode = {
      id: '',
      op,
      inputs: Array<string | null>(SURFACE_OPERATIONS[op]).fill(null),
      inline: Array<number | undefined>(SURFACE_OPERATIONS[op]).fill(undefined),
      x: at?.[0] ?? 0,
      y: at?.[1] ?? 0,
    };
    if (hasValue(op)) node.value = this.checkValue(op, value ?? (op === 'vec3' ? [1, 1, 1] : 0));
    else if (value !== undefined) this.checkValue(op, value);
    this.change(() => {
      node.id = this.freshId(op);
      if (!at) node.x = node.y = (this.nodes.length % 8) * 24;
      this.nodes.push(node);
    });
    return node;
  }

  /** Deletes nodes; wires from them are cleared and output slots that used them are emptied. Unknown ids are ignored. */
  removeNodes(ids: Iterable<string>): void {
    const gone = new Set(ids);
    if (![...gone].some((id) => this.node(id))) return;
    this.change(() => {
      for (let i = this.nodes.length - 1; i >= 0; i--) if (gone.has(this.nodes[i].id)) this.nodes.splice(i, 1);
      for (const n of this.nodes)
        n.inputs = n.inputs.map((source) => (source !== null && gone.has(source) ? null : source));
      for (const slot of Object.keys(this.outputs) as OutputSlot[])
        if (gone.has(this.outputs[slot]!)) delete this.outputs[slot];
    });
  }
  /**
   * Wires the output of `from` into input `input` (0-based) of `to`, replacing what was there.
   * @throws RangeError for an unknown node or input, or when the wire would make a loop (`to` already feeds `from`).
   */
  connect(from: string, to: string, input: number): void {
    this.need(from);
    const target = this.need(to);
    if (!Number.isInteger(input) || input < 0 || input >= target.inputs.length)
      throw new RangeError(
        `${to} (${target.op}) has ${target.inputs.length} inputs; pass an input index from 0 to ${target.inputs.length - 1}`,
      );
    if (this.dependsOn(from, to))
      throw new RangeError(
        `Wiring ${from} into ${to} would make a loop because ${to} already feeds ${from}; wire from a node that does not depend on ${to}`,
      );
    if (target.inputs[input] === from) return;
    this.change(() => {
      target.inputs[input] = from;
    });
  }
  /** Wires the output of `from` to a material output slot. */
  connectOutput(from: string, slot: OutputSlot): void {
    this.need(from);
    if (!OUTPUT_SLOTS.some((s) => s.slot === slot))
      throw new RangeError(
        `"${String(slot)}" is not an output slot; use ${OUTPUT_SLOTS.map((s) => s.slot).join(', ')}`,
      );
    if (this.outputs[slot] === from) return;
    this.change(() => {
      this.outputs[slot] = from;
    });
  }
  /** Clears input `input` of `to`. */
  disconnect(to: string, input: number): void {
    const target = this.need(to);
    if (target.inputs[input] == null) return;
    this.change(() => {
      target.inputs[input] = null;
    });
  }
  /** Empties an output slot. */
  disconnectOutput(slot: OutputSlot): void {
    if (this.outputs[slot] === undefined) return;
    this.change(() => {
      delete this.outputs[slot];
    });
  }
  /** Sets the constant of a `float`, `vec3` or `component` node. */
  setValue(id: string, value: number | readonly [number, number, number]): void {
    const n = this.need(id),
      next = this.checkValue(n.op, value);
    if (JSON.stringify(n.value) === JSON.stringify(next)) return;
    this.change(() => {
      n.value = next;
    });
  }
  /** Types a constant into an unconnected input that has a default; pass undefined to go back to the default. */
  setInline(id: string, input: number, value: number | undefined): void {
    const n = this.need(id);
    if (!INPUT_DEFAULTS[n.op] || INPUT_DEFAULTS[n.op]![input] === undefined)
      throw new RangeError(`Input ${input + 1} of ${id} (${n.op}) has no default; wire a node to it instead`);
    if (value !== undefined && !finite(value))
      throw new RangeError('An input constant must be a finite number within +-1000000');
    if (n.inline[input] === value) return;
    this.change(() => {
      n.inline[input] = value;
    });
  }
  /** Changes the fallback constants; each given field replaces the old one. */
  setFallback(patch: Partial<SurfaceFallback>): void {
    const next = { ...this.fallback, ...patch };
    const rgb = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((c) => finite(c) && c >= 0);
    if (
      !rgb(next.color) ||
      !rgb(next.emissive) ||
      ![next.roughness, next.metalness, next.opacity].every((v) => finite(v) && v >= 0 && v <= 1)
    )
      throw new RangeError(
        'Fallback needs nonnegative finite RGB for color and emissive and roughness, metalness and opacity from 0 to 1',
      );
    this.change(() => {
      this.fallback = {
        color: [...next.color],
        emissive: [...next.emissive],
        roughness: next.roughness,
        metalness: next.metalness,
        opacity: next.opacity,
      };
    });
  }
  /**
   * Moves nodes by (dx, dy). `output` moves the output panel. Does not record history: call {@link GraphModel.checkpoint}
   * first when a gesture starts.
   */
  move(ids: Iterable<string>, dx: number, dy: number): void {
    if (![dx, dy].every(Number.isFinite)) throw new RangeError('Move by finite distances; pass numbers for dx and dy');
    for (const id of ids) {
      const target = id === 'output' ? this.output : this.node(id);
      if (target) {
        target.x += dx;
        target.y += dy;
      }
    }
    this.emit('layout');
  }
  /**
   * Copies nodes (and the wires between them) 24 px down and right, keeping wires from outside the copy, and returns
   * the new ids.
   */
  duplicate(ids: Iterable<string>): string[] {
    const wanted = new Set(ids),
      chosen = this.nodes.filter((n) => wanted.has(n.id));
    if (!chosen.length) return [];
    if (this.nodes.length + chosen.length > SURFACE_GRAPH_LIMITS.nodes)
      throw new RangeError(`A graph holds at most ${SURFACE_GRAPH_LIMITS.nodes} nodes; delete some before duplicating`);
    const rename = new Map<string, string>(),
      taken = new Set(this.nodes.map((n) => n.id));
    for (const n of chosen) {
      let i = 1;
      while (taken.has(n.op + i)) i++;
      rename.set(n.id, n.op + i);
      taken.add(n.op + i);
    }
    this.change(() => {
      for (const n of chosen)
        this.nodes.push({
          ...structuredClone(n),
          id: rename.get(n.id)!,
          inputs: n.inputs.map((s) => (s === null ? null : (rename.get(s) ?? s))),
          x: n.x + 24,
          y: n.y + 24,
        });
    });
    return [...rename.values()];
  }
  /** Lays nodes out in columns by depth, sources on the left and the output panel on the right. */
  arrange(silent = false): void {
    const apply = () => {
      const level = new Map<string, number>();
      const depth = (n: EditorNode, trail = new Set<string>()): number => {
        if (level.has(n.id)) return level.get(n.id)!;
        if (trail.has(n.id)) return 0;
        trail.add(n.id);
        const d =
          1 + Math.max(-1, ...n.inputs.map((s) => (s === null || !this.node(s) ? -1 : depth(this.node(s)!, trail))));
        trail.delete(n.id);
        level.set(n.id, d);
        return d;
      };
      this.nodes.forEach((n) => depth(n));
      const used = new Map<number, number>();
      for (const n of this.nodes) {
        const l = level.get(n.id)!,
          y = used.get(l) ?? 0;
        n.x = l * COLUMN;
        n.y = y;
        used.set(l, y + nodeHeight(n) + GAP);
      }
      this.output.x = (Math.max(-1, ...level.values()) + 1) * COLUMN;
      this.output.y = 0;
    };
    if (silent) return apply();
    this.change(apply);
  }

  /** Steps back one change. Returns false when there is nothing to undo. */
  undo(): boolean {
    const before = this.undoStack.pop();
    if (before === undefined) return false;
    this.redoStack.push(this.snapshot());
    this.restore(before);
    this.emit('graph');
    return true;
  }
  /** Steps forward one undone change. Returns false when there is nothing to redo. */
  redo(): boolean {
    const after = this.redoStack.pop();
    if (after === undefined) return false;
    this.undoStack.push(this.snapshot());
    this.restore(after);
    this.emit('graph');
    return true;
  }
  /** Replaces the whole graph (one undo step). Same errors as the constructor. */
  load(graph: SurfaceGraph, layout?: GraphLayout): void {
    validateSurfaceGraph(graph);
    this.change(() => this.fill(graph, layout));
  }

  private raw(): SurfaceGraph {
    const nodes: SurfaceGraphNode[] = [],
      taken = new Set(this.nodes.map((n) => n.id));
    for (const n of this.nodes) {
      const inputs = n.inputs.map((source, i) => {
        if (source !== null) return source;
        const value = n.inline[i] ?? INPUT_DEFAULTS[n.op]?.[i];
        if (value === undefined)
          throw new TypeError(
            `Surface graph is incomplete; connect a node to input ${i + 1} (${inputLabel(n.op, i)}) of ${n.id}, or delete ${n.id}`,
          );
        let id = `${n.id.slice(0, 40)}-i${i}`;
        while (taken.has(id)) id += '_';
        taken.add(id);
        nodes.push({ id, op: 'float', inputs: [], value });
        return id;
      });
      nodes.push({ id: n.id, op: n.op, inputs, ...(n.value === undefined ? {} : { value: n.value }) });
    }
    return { version: 1, nodes, outputs: { ...this.outputs }, fallback: structuredClone(this.fallback) };
  }
  /**
   * The portable graph, validated. Hidden constants for unconnected inputs are included as `float` nodes.
   * @throws TypeError or RangeError (the `validateSurfaceGraph` errors, or "incomplete" for an unconnected input without a default).
   */
  toGraph(): SurfaceGraph {
    return JSON.parse(serializeSurfaceGraph(this.raw())) as SurfaceGraph;
  }
  /** Canonical JSON of {@link GraphModel.toGraph}. */
  toJSON(): string {
    return serializeSurfaceGraph(this.raw());
  }
  /** Whether the graph validates, with the type of every node or the first thing to fix. Cached until the graph changes. */
  status(): EditorStatus {
    if (this.cached?.version === this.version) return this.cached.status;
    let status: EditorStatus;
    try {
      const graph = this.toGraph(),
        all = inspectSurfaceGraph(graph).types,
        types = Object.fromEntries(this.nodes.map((n) => [n.id, all[n.id]]));
      const driven = Object.keys(this.outputs);
      status = {
        ok: true,
        message: driven.length
          ? `Valid graph driving ${driven.join(', ')}.`
          : 'Valid graph. Wire a node to an output to change the material.',
        node: null,
        types,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error),
        found = this.nodes.find((n) =>
          new RegExp(`(^|[^A-Za-z0-9_-])${escapeId(n.id)}([^A-Za-z0-9_-]|$)`).test(message),
        );
      status = { ok: false, message, node: found?.id ?? null, types: {} };
    }
    this.cached = { version: this.version, status };
    return status;
  }
}
