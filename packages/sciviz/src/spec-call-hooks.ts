import type { Figure } from './figure.js';
/** @internal Successful resource operations observed by the optional provenance entry. */
export interface FigureCall {
  readonly type: 'create' | 'recipe' | 'call' | 'set';
  readonly object: object;
  readonly id?: string;
  readonly method: string;
  readonly args: readonly unknown[];
}
const callObservers = new WeakMap<Figure, Set<(call: FigureCall) => void>>();
/** @internal Observe only this instance, returning an explicit lifetime handle. */
export function observeFigureCalls(figure: Figure, listener: (call: FigureCall) => void): () => void {
  let observers = callObservers.get(figure);
  if (!observers) {
    observers = new Set();
    callObservers.set(figure, observers);
  }
  observers.add(listener);
  return () => {
    observers.delete(listener);
    if (!observers.size) callObservers.delete(figure);
  };
}
/** @internal Publish a successful operation without modifying prototypes or import-time globals. */
export function emitFigureCall(figure: Figure, call: FigureCall): void {
  for (const listener of callObservers.get(figure) ?? []) listener(call);
}
