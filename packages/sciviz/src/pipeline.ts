import { fault, rangeError, typeError } from '../../shared/errors.js';

/** JSON values accepted in a portable pipeline description. */
export type PipelineValue =
  | null
  | boolean
  | number
  | string
  | readonly PipelineValue[]
  | { readonly [key: string]: PipelineValue };
/** Serializable source, filter or layer definition. IDs are local to a graph. */
export interface PipelineSpec {
  readonly id: string;
  readonly type: string;
  readonly inputs?: readonly string[];
  readonly params?: PipelineValue;
}
/** Versioned graph, with no closures, live resources or computed data. */
export interface PipelineJSON {
  readonly version: 1;
  readonly nodes: readonly PipelineSpec[];
}
/** One execution. Inputs are borrowed and must not be mutated or disposed. */
export interface PipelineContext {
  readonly inputs: readonly unknown[];
  readonly params: PipelineValue;
  readonly time: number;
  readonly signal: AbortSignal;
}
/** Registry entry; implementations load their optional filter on demand. */
export interface PipelineOperator {
  readonly kind: 'source' | 'filter' | 'layer';
  /** Default false. True makes this node and descendants depend on requested time. */
  readonly timeDependent?: boolean;
  readonly execute: (context: PipelineContext) => unknown | Promise<unknown>;
  /** Release owned output only, never borrowed inputs. Default no release. */
  readonly release?: (output: unknown) => void;
}
/** Operator names are stable identifiers used when restoring JSON. */
export type PipelineRegistry = Readonly<Record<string, PipelineOperator>>;
/** Time defaults to 0. Cancellation retains successful upstream cache entries. */
export interface PipelineRunOptions {
  readonly time?: number;
  readonly signal?: AbortSignal;
}

interface RecordNode {
  spec: PipelineSpec;
  operator: PipelineOperator;
  cached: boolean;
  value: unknown;
  time: number;
  temporal: boolean;
}

function jsonCopy(value: PipelineValue): PipelineValue {
  const seen = new Set<object>();
  const visit = (v: PipelineValue): PipelineValue => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'object' || seen.has(v))
      throw typeError('Pipeline params must be acyclic finite JSON; use plain values', 'sciviz');
    seen.add(v);
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
      throw typeError('Pipeline params must use plain objects; store data in a source operator', 'sciviz');
    const result = Array.isArray(v)
      ? Array.from(v, visit)
      : Object.fromEntries(Object.entries(v).map(([key, item]) => [key, visit(item)]));
    seen.delete(v);
    return Object.freeze(result);
  };
  return visit(value);
}

/** Lazy demand-driven DAG. All outputs are owned until invalidation or disposal.
 * Runs are serialized, coalescing diamond dependencies and concurrent demands through the cache.
 * Mutations cancel affected active runs. No execution or module loading occurs on construction.
 */
export class FilterPipeline {
  private readonly registry: Map<string, PipelineOperator>;
  private readonly nodes = new Map<string, RecordNode>();
  private readonly active = new Map<AbortController, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private dead = false;

  constructor(registry: PipelineRegistry) {
    this.registry = new Map(
      Object.entries(registry).map(([name, op]) => {
        if (!name || !op || !['source', 'filter', 'layer'].includes(op.kind) || typeof op.execute !== 'function')
          throw typeError('Invalid pipeline operator; provide a kind and execute function', 'sciviz');
        return [name, Object.freeze({ ...op })];
      }),
    );
  }

  private live(): void {
    if (this.dead) throw fault('disposed', 'Pipeline is disposed; create a new graph');
  }

  private node(id: string): RecordNode {
    const node = this.nodes.get(id);
    if (!node) throw rangeError(`Unknown pipeline node ${id}; add it before connecting`, 'sciviz');
    return node;
  }

  /** Add a node. Inputs must already exist, allowing only acyclic construction. */
  add(spec: PipelineSpec): this {
    this.live();
    if (!spec || typeof spec.id !== 'string' || !spec.id || this.nodes.has(spec.id))
      throw typeError('Pipeline node ID must be a unique nonempty string; choose another ID', 'sciviz');
    const operator = this.registry.get(spec.type);
    if (!operator) throw typeError(`Unknown pipeline operator ${spec.type}; register it before adding nodes`, 'sciviz');
    const inputs = [...(spec.inputs ?? [])];
    if (operator.kind === 'source' ? inputs.length !== 0 : inputs.length === 0)
      throw typeError('Sources need no inputs and filters/layers need inputs; correct the connections', 'sciviz');
    for (const id of inputs) this.node(id);
    this.nodes.set(spec.id, {
      spec: Object.freeze({
        id: spec.id,
        type: spec.type,
        inputs: Object.freeze(inputs),
        params: jsonCopy(spec.params ?? null),
      }),
      operator,
      cached: false,
      value: undefined,
      time: 0,
      temporal: !!operator.timeDependent || inputs.some((id) => this.node(id).temporal),
    });
    return this;
  }

  /** Replace parameters atomically, invalidating this node and its descendants only. */
  setParams(id: string, params: PipelineValue): this {
    this.live();
    const node = this.node(id),
      next = jsonCopy(params);
    this.invalidate(id);
    node.spec = Object.freeze({ ...node.spec, params: next });
    return this;
  }

  private affected(id: string): Set<string> {
    this.node(id);
    const result = new Set([id]);
    for (const [key, node] of this.nodes) if (node.spec.inputs?.some((input) => result.has(input))) result.add(key);
    return result;
  }

  private clear(node: RecordNode): void {
    if (!node.cached) return;
    const value = node.value;
    node.value = undefined;
    node.cached = false;
    node.operator.release?.(value);
  }

  /** Notify the graph of externally changed source data. Re-execution remains lazy. */
  invalidate(id: string): this {
    this.live();
    const affected = this.affected(id);
    for (const [controller, visited] of this.active)
      if ([...affected].some((key) => visited.has(key)))
        controller.abort(fault('state', 'Pipeline changed during execution; request the updated output'));
    for (const [key, node] of [...this.nodes].reverse()) if (affected.has(key)) this.clear(node);
    return this;
  }

  /** Whether a node needs execution for this time (default 0). */
  isDirty(id: string, time = 0): boolean {
    this.live();
    const node = this.node(id);
    return !node.cached || (node.temporal && node.time !== time);
  }

  /** Compute only ancestors of the requested node. Output is borrowed until invalidated. */
  run<T = unknown>(id: string, options: PipelineRunOptions = {}): Promise<T> {
    this.live();
    const time = options.time ?? 0;
    if (!Number.isFinite(time)) throw rangeError('Pipeline time must be finite; provide a finite step', 'sciviz');
    const visited = new Set<string>();
    const collect = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      for (const input of this.node(key).spec.inputs ?? []) collect(input);
    };
    collect(id);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    this.active.set(controller, visited);
    const signal = controller.signal;
    const work = async (): Promise<T> => {
      signal.throwIfAborted();
      this.live();
      // Only temporal ancestors of this demand change time. Their other descendants also become stale.
      const changed = new Set<string>();
      for (const key of visited) {
        const node = this.node(key);
        if (node.cached && node.temporal && node.time !== time)
          for (const downstream of this.affected(key)) changed.add(downstream);
      }
      for (const [key, node] of [...this.nodes].reverse()) if (changed.has(key)) this.clear(node);
      const evaluate = async (key: string): Promise<unknown> => {
        signal.throwIfAborted();
        const node = this.node(key);
        if (node.cached) return node.value;
        const inputs = [];
        for (const input of node.spec.inputs ?? []) inputs.push(await evaluate(input));
        signal.throwIfAborted();
        const value = await node.operator.execute({ inputs, params: node.spec.params ?? null, time, signal });
        if (signal.aborted) {
          node.operator.release?.(value);
          signal.throwIfAborted();
        }
        node.value = value;
        node.time = time;
        node.cached = true;
        return value;
      };
      return (await evaluate(id)) as T;
    };
    const result = this.queue.then(work);
    // Keep rejected requests from poisoning the scheduling queue; caller still receives the rejection.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.active.delete(controller);
      options.signal?.removeEventListener('abort', abort);
    });
  }

  /** Snapshot the portable graph. Register the same operator types before restoring it. */
  toJSON(): PipelineJSON {
    this.live();
    return { version: 1, nodes: [...this.nodes.values()].map((node) => node.spec) };
  }

  /** Restore a topologically ordered JSON description without running it. */
  static fromJSON(value: PipelineJSON, registry: PipelineRegistry): FilterPipeline {
    if (!value || value.version !== 1 || !Array.isArray(value.nodes))
      throw typeError('Unsupported pipeline JSON; use version 1 with a nodes array', 'sciviz');
    const pipeline = new FilterPipeline(registry);
    for (const spec of value.nodes) pipeline.add(spec);
    return pipeline;
  }

  /** Abort pending runs and release cached outputs in reverse dependency order. Idempotent. */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    for (const controller of this.active.keys())
      controller.abort(fault('disposed', 'Pipeline disposed; create a new graph'));
    for (const node of [...this.nodes.values()].reverse()) this.clear(node);
  }

  /** Enable explicit resource management with `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
