// A game definition shared by server and client: the schema, which structs are the state and the input, the tick
// rate and the deterministic step. Both ends run the same step, which is what makes prediction converge.
import type { Infer, SchemaShape, TypeName, UntypedSchema } from './schema.js';

/** What `defineGame` takes. */
export interface GameDefinition<S extends SchemaShape, SN extends TypeName<S>, IN extends TypeName<S>> {
  /** The compiled schema both ends share. */
  schema: { readonly definition: S; readonly names: readonly string[] };
  /** The struct that holds the whole simulated state. */
  state: SN;
  /** The struct of one player's input for one tick. */
  input: IN;
  /** Fixed simulation ticks per second, an integer from 1 to 240 (default 30). */
  tickRate?: number;
  /** The state at tick 0. Called once by the server. */
  initial(): Infer<S, SN>;
  /**
   * Advances `state` in place by one tick of `dt` seconds (`1 / tickRate`). `inputs` holds one input per player; a
   * player with no input this tick is absent (treat it as idle). Must be deterministic: the same state and inputs
   * give the same result on every machine, so use only `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.abs`,
   * `Math.min` and `Math.max` on numbers, and iterate maps (always sorted by id) rather than objects of your own.
   */
  step(state: Infer<S, SN>, inputs: ReadonlyMap<number, Infer<S, IN>>, tick: number, dt: number): void;
  /** Adds player `player` to `state` (server only, at the start of a tick). */
  join?(state: Infer<S, SN>, player: number): void;
  /** Removes player `player` from `state` (server only, at the start of a tick). */
  leave?(state: Infer<S, SN>, player: number): void;
}

/** A checked game definition: give it to `GameServer` and `GameClient`. */
export interface Game<State = unknown, Input = unknown> {
  /** The schema. */
  readonly schema: UntypedSchema;
  /** Name of the state struct. */
  readonly stateType: string;
  /** Name of the input struct. */
  readonly inputType: string;
  /** Ticks per second. */
  readonly tickRate: number;
  /** Milliseconds per tick. */
  readonly tickMs: number;
  /** The state at tick 0. */
  initial(): State;
  /** The deterministic step. */
  step(state: State, inputs: ReadonlyMap<number, Input>, tick: number, dt: number): void;
  /** Adds a player. */
  join(state: State, player: number): void;
  /** Removes a player. */
  leave(state: State, player: number): void;
}

/**
 * Checks a game definition.
 *
 * @example
 * ```ts
 * const game = defineGame({
 *   schema, state: 'State', input: 'Input', tickRate: 30,
 *   initial: () => ({ boxes: new Map() }),
 *   join: (state, id) => void state.boxes.set(id, { x: 0, y: 0, owner: id }),
 *   leave: (state, id) => void state.boxes.delete(id),
 *   step(state, inputs, _tick, dt) {
 *     for (const [id, input] of inputs) { const box = state.boxes.get(id); if (box) box.x += input.x * 5 * dt; }
 *   },
 * });
 * ```
 * @throws TypeError when `state` or `input` names no struct of the schema, or `initial` or `step` is missing;
 * RangeError for a tick rate that is not an integer from 1 to 240.
 */
export function defineGame<const S extends SchemaShape, const SN extends TypeName<S>, const IN extends TypeName<S>>(
  definition: GameDefinition<S, SN, IN>,
): Game<Infer<S, SN>, Infer<S, IN>> {
  const { schema, state, input } = definition;
  for (const [role, name] of [
    ['state', state],
    ['input', input],
  ] as const)
    if (!schema?.names?.includes(name))
      throw new TypeError(`Game ${role} type '${name}' is not in the schema; name one of its structs`);
  if (typeof definition.initial !== 'function' || typeof definition.step !== 'function')
    throw new TypeError('Game needs initial() and step(state, inputs, tick, dt) functions; add them');
  const tickRate = definition.tickRate ?? 30;
  if (!Number.isInteger(tickRate) || tickRate < 1 || tickRate > 240)
    throw new RangeError(`Game tickRate is ${tickRate}; pass an integer from 1 to 240 ticks per second`);
  const noop = () => {};
  return {
    schema: schema as unknown as UntypedSchema,
    stateType: state,
    inputType: input,
    tickRate,
    tickMs: 1000 / tickRate,
    initial: definition.initial,
    step: definition.step,
    join: definition.join ?? noop,
    leave: definition.leave ?? noop,
  };
}
