/// <reference lib="esnext.disposable" preserve="true" />
// An animation state graph in plain data, like the animator controllers of the big engines: typed parameters
// (float, int, bool, trigger), transitions whose conditions compare them, crossfades, interruption rules and timed
// events, compiled onto an Animator's states and blend trees. The document is JSON, so a tool can save and load it.
// Kept out of the Animator class so an app that writes its own `when` predicates does not bundle it.
import type { Animation } from '@margoengine/animation';
import { MargoError } from '@margoengine/math/errors';
import {
  Animator,
  type AnimatorEvent,
  type AnimatorEventMap,
  type AnimatorTransition,
  type BlendTree,
} from './index.js';

/** A parameter's type: a float or int read by blend trees and comparisons, a bool, or a trigger that a transition consumes. */
export type GraphParameterType = 'float' | 'int' | 'bool' | 'trigger';
/** A parameter declaration: its type, or the type with a starting value (default 0 or false). */
export type GraphParameter =
  | GraphParameterType
  | { type: 'float' | 'int'; default?: number }
  | { type: 'bool'; default?: boolean }
  | { type: 'trigger' };
/** How a condition compares a float or int parameter with a number. */
export type GraphComparison = '>' | '>=' | '<' | '<=' | '==' | '!=';
/**
 * One condition of a transition: `[bool]` holds while the bool is true, `[trigger]` while the trigger is set (taking
 * the transition clears it), `[bool, '==' | '!=', true | false]`, and `[float or int, comparison, number]`.
 */
export type GraphCondition =
  | readonly [parameter: string]
  | readonly [parameter: string, comparison: GraphComparison, value: number | boolean];
/** A transition of the graph. It is taken when every condition holds and its `exitTime`, when it has one, is reached. */
export interface GraphTransition {
  /** The state it leaves, or `'*'` for any state but `to`. */
  from: string;
  /** The state it enters. */
  to: string;
  /** Conditions that must all hold. Default: none (then `exitTime` is required). */
  conditions?: readonly GraphCondition[];
  /** Normalized time of `from` (1 is the end of its longest clip) from which it may be taken. Default: any time. */
  exitTime?: number;
  /** Crossfade length in seconds. Default 0.15. */
  duration?: number;
  /**
   * While this transition's crossfade runs, may another transition cut in (from the blended pose)? Default true;
   * false holds every other transition until the crossfade ends (a landing that must finish).
   */
  interruptible?: boolean;
}
/** An animation state graph: plain data, so it saves and loads as JSON. */
export interface AnimatorGraphDocument {
  /** Typed parameters by name. Default: none. */
  parameters?: Record<string, GraphParameter>;
  /** Named states: a clip name or a blend tree whose parameters are float or int parameters. */
  states: Record<string, BlendTree>;
  /** The starting state. */
  initial: string;
  /** Transitions, checked once per frame in order; the first that holds is taken. Default: none. */
  transitions?: readonly GraphTransition[];
  /** Timed events per state (footsteps, hit frames). Default: none. */
  events?: readonly AnimatorEvent[];
}

const COMPARISONS = new Set(['>', '>=', '<', '<=', '==', '!=']);
const TYPES = new Set(['float', 'int', 'bool', 'trigger']);

interface Compiled {
  name: string;
  type: GraphParameterType;
  comparison?: GraphComparison;
  value?: number;
}

/**
 * An Animator driven by an {@link AnimatorGraphDocument}: set typed parameters and triggers, and the graph's
 * transitions crossfade between its states. `dispose()` (or `using`) removes the Animator.
 * @example
 * const graph = AnimatorGraph.attach(Animation.attach(model), {
 *   parameters: { speed: 'float', grounded: { type: 'bool', default: true }, jump: 'trigger' },
 *   initial: 'move',
 *   states: { move: { parameter: 'speed', samples: [{ value: 0, clip: 'Idle' }, { value: 1, clip: 'Run' }] }, jump: 'Jump' },
 *   transitions: [
 *     { from: 'move', to: 'jump', conditions: [['jump'], ['grounded']], interruptible: false },
 *     { from: 'jump', to: 'move', exitTime: 0.9, duration: 0.2 },
 *   ],
 * });
 * graph.set('speed', 0.8).trigger('jump');
 */
export class AnimatorGraph {
  /** The Animator the graph drives: its `on('event' | 'statechange')`, layers, IK and `playing` all work. */
  readonly animator: Animator;
  private readonly types = new Map<string, GraphParameterType>();
  private readonly bools = new Map<string, boolean>();
  private readonly triggers = new Set<string>();
  /** The transition whose `when` just passed, read by the statechange listener that follows it. */
  private taking?: GraphTransition;
  /** Seconds into the current state during which no transition may cut in (an uninterruptible crossfade). */
  private hold = 0;
  private readonly off: () => void;
  private disposed = false;

  /** Validates `document` and builds its Animator on `animation` (not yet attached to the engine). */
  constructor(animation: Animation, document: AnimatorGraphDocument) {
    if (!document || typeof document !== 'object')
      throw new TypeError('An animator graph needs a document: {states, initial, parameters?, transitions?}.');
    const parameters: Record<string, number> = {};
    for (const [name, spec] of Object.entries(document.parameters ?? {})) {
      const type = typeof spec === 'string' ? spec : spec?.type;
      if (!name || !TYPES.has(type as string))
        throw new TypeError(
          `Animator graph parameter "${name}" needs a type: 'float', 'int', 'bool' or 'trigger' (or {type, default}).`,
        );
      this.types.set(name, type as GraphParameterType);
      const value = typeof spec === 'object' && 'default' in spec ? spec.default : undefined;
      if (type === 'bool') {
        if (value !== undefined && typeof value !== 'boolean')
          throw new TypeError(`Animator graph bool "${name}" needs a true or false default.`);
        this.bools.set(name, value === true);
      } else if (type !== 'trigger') parameters[name] = this.check(name, type as GraphParameterType, value ?? 0);
    }
    for (const tree of Object.values(document.states ?? {}))
      if (tree && typeof tree === 'object')
        for (const name of 'parameter' in tree ? [tree.parameter] : tree.parameters) {
          const type = this.types.get(name);
          if (type !== 'float' && type !== 'int')
            throw new TypeError(`Animator graph blend tree reads "${name}"; declare it as a float or int parameter.`);
        }
    const transitions: AnimatorTransition[] = (document.transitions ?? []).map((transition) =>
      this.compile(transition),
    );
    this.animator = new Animator(animation, {
      states: document.states,
      initial: document.initial,
      parameters,
      transitions,
      events: document.events,
    });
    this.off = this.animator.on('statechange', (change) => this.changed(change));
  }

  /** Builds the graph and attaches its Animator to the animation's scene (attach the Animation first). */
  static attach(animation: Animation, document: AnimatorGraphDocument): AnimatorGraph {
    const graph = new AnimatorGraph(animation, document);
    const engine = animation.model.root.engine;
    engine.use(graph.animator, engine.sceneOf(animation) ?? animation.model.root.scene);
    return graph;
  }

  private compile(transition: GraphTransition): AnimatorTransition {
    if (!transition || typeof transition !== 'object')
      throw new TypeError('Animator graph transitions must be objects: {from, to, conditions?, exitTime?}.');
    const { conditions = [], interruptible = true } = transition;
    if (!Array.isArray(conditions) || typeof interruptible !== 'boolean')
      throw new TypeError('Animator graph transition conditions must be an array and interruptible a boolean.');
    if (!conditions.length && transition.exitTime === undefined)
      throw new TypeError(
        `Animator graph transition ${transition.from} to ${transition.to} needs conditions or an exitTime; it would fire every frame.`,
      );
    const compiled = conditions.map((condition) => this.condition(condition));
    const consumed = compiled.filter((c) => c.type === 'trigger').map((c) => c.name);
    return {
      from: transition.from,
      to: transition.to,
      exitTime: transition.exitTime,
      duration: transition.duration,
      when: (values) => {
        if (this.animator.time < this.hold) return false;
        for (const c of compiled) if (!this.holds(c, values)) return false;
        // The Animator takes the transition whenever `when` passes, so consume its triggers now.
        for (const name of consumed) this.triggers.delete(name);
        this.taking = transition;
        return true;
      },
    };
  }

  private condition(condition: GraphCondition): Compiled {
    if (!Array.isArray(condition) || (condition.length !== 1 && condition.length !== 3))
      throw new TypeError(
        "Animator graph conditions must be [name] or [name, comparison, value], e.g. ['speed', '>', 0.1] or ['grounded'].",
      );
    const [name, comparison, value] = condition as [string, GraphComparison?, (number | boolean)?];
    const type = this.types.get(name);
    if (!type) throw new TypeError(`Animator graph condition uses "${name}"; declare it under parameters first.`);
    if (condition.length === 1) {
      if (type !== 'bool' && type !== 'trigger')
        throw new TypeError(
          `Animator graph condition ["${name}"] needs a bool or trigger; compare a ${type} with a value.`,
        );
      return { name, type };
    }
    if (!COMPARISONS.has(comparison as string))
      throw new TypeError(`Animator graph comparison "${comparison}" is unknown; use >, >=, <, <=, == or !=.`);
    if (type === 'trigger')
      throw new TypeError(`Animator graph trigger "${name}" takes no comparison; write ["${name}"].`);
    if (type === 'bool') {
      if (typeof value !== 'boolean' || (comparison !== '==' && comparison !== '!='))
        throw new TypeError(`Animator graph bool "${name}" must compare with == or != and true or false.`);
      return { name, type, comparison, value: +value };
    }
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new TypeError(`Animator graph ${type} "${name}" must compare with a finite number.`);
    return { name, type, comparison, value };
  }

  private holds(c: Compiled, values: Readonly<Record<string, number>>): boolean {
    if (c.type === 'trigger') return this.triggers.has(c.name);
    const actual = c.type === 'bool' ? +this.bools.get(c.name)! : (values[c.name] ?? 0);
    if (c.comparison === undefined) return actual === 1;
    const value = c.value!;
    switch (c.comparison) {
      case '>':
        return actual > value;
      case '>=':
        return actual >= value;
      case '<':
        return actual < value;
      case '<=':
        return actual <= value;
      case '==':
        return actual === value;
      default:
        return actual !== value;
    }
  }

  private changed(change: AnimatorEventMap['statechange']): void {
    const taken = this.taking;
    this.taking = undefined;
    // A state entered by animator.transition() (not a graph transition) holds nothing.
    this.hold = taken?.interruptible === false ? change.duration : 0;
  }

  private check(name: string, type: GraphParameterType, value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'int' && !Number.isInteger(value)))
      throw new RangeError(`Animator graph ${type} "${name}" needs a finite ${type === 'int' ? 'integer' : 'number'}.`);
    return value;
  }
  private live(name: string): GraphParameterType {
    if (this.disposed) throw new MargoError('disposed', 'Animator graph is disposed; create a new AnimatorGraph.');
    const type = this.types.get(name);
    if (!type) throw new TypeError(`Animator graph has no parameter "${name}"; declare it under parameters.`);
    return type;
  }

  /** The current state's name. */
  get state(): string {
    return this.animator.state;
  }
  /** Sets a float, int or bool parameter; the value must match its type. */
  set(name: string, value: number | boolean): this {
    const type = this.live(name);
    if (type === 'trigger') throw new TypeError(`Animator graph "${name}" is a trigger; call trigger("${name}").`);
    if (type === 'bool') {
      if (typeof value !== 'boolean')
        throw new TypeError(`Animator graph bool "${name}" takes true or false; pass a boolean.`);
      this.bools.set(name, value);
    } else this.animator.parameters[name] = this.check(name, type, value);
    return this;
  }
  /** Reads a parameter: a number for float and int, a boolean for bool, and whether a trigger is set. */
  get(name: string): number | boolean {
    const type = this.live(name);
    if (type === 'bool') return this.bools.get(name)!;
    if (type === 'trigger') return this.triggers.has(name);
    return this.animator.parameters[name] ?? 0;
  }
  /** Sets a trigger: it stays set until a transition that lists it is taken, or {@link AnimatorGraph.resetTrigger}. */
  trigger(name: string): this {
    if (this.live(name) !== 'trigger') throw new TypeError(`Animator graph "${name}" is not a trigger; use set().`);
    this.triggers.add(name);
    return this;
  }
  /** Clears a trigger no transition has taken. */
  resetTrigger(name: string): this {
    if (this.live(name) !== 'trigger') throw new TypeError(`Animator graph "${name}" is not a trigger; use set().`);
    this.triggers.delete(name);
    return this;
  }
  /** Subscribes to the Animator's timed events or state changes. Returns an unsubscribe function. */
  on<K extends keyof AnimatorEventMap>(type: K, listener: (event: AnimatorEventMap[K]) => void): () => void {
    return this.animator.on(type, listener);
  }
  /** Removes the Animator (the Animation plays on). Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.animator.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
