// Optional layer factories publish their creation recipe only to an opted-in figure.
// This module has no renderer dependency, global hooks or side effects on import.
import type { Figure } from './figure.js';
const recorders = new WeakMap<Figure, (kind: string, args: unknown[], object: object) => void>();
const selections = new WeakMap<object, () => unknown>();
/** @internal Opt a store into portable value encoding without loading the renderer. */
export function recordSelectionValue(value: object, snapshot: () => unknown): void {
  selections.set(value, snapshot);
}
/** @internal A registered selection value, or undefined for ordinary values. */
export function selectionValue(value: object): (() => unknown) | undefined {
  return selections.get(value);
}
/** @internal Install one instance's recorder. */
export function attachSpecRecorder(
  figure: Figure,
  record: (kind: string, args: unknown[], object: object) => void,
): void {
  recorders.set(figure, record);
}
/** @internal Preserve factory return identity while recording an optional resource. */
export function trackSpecLayer<T extends object>(figure: Figure, kind: string, args: unknown[], object: T): T {
  recorders.get(figure)?.(kind, args, object);
  return object;
}
