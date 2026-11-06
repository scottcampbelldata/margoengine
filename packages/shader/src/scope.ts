import type { Node } from './node.js';
/** What a storage write hands to the statement list it is made in. */
export interface Write {
  readonly buffer: { readonly atomic: boolean };
  readonly index: Node;
  readonly value: Node;
}
/**
 * Side-effect nodes (atomics, statements) made while a ComputePass, `block` or control-flow body runs, in order; `store`
 * is set inside statement bodies, where a storage write is a statement. Loop and Fn bodies collect nothing: they run
 * their atomics only where the result is used.
 */
export const effects: { list?: Node[]; store?: (write: Write) => void } = {};
/** Runs a loop or Fn body without collecting its effects. */
export const nested = <R>(body: () => R): R => {
  const { list, store } = effects;
  effects.list = effects.store = undefined;
  try {
    return body();
  } finally {
    effects.list = list;
    effects.store = store;
  }
};
