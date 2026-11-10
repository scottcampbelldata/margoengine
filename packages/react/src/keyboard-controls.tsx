import { createContext, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { MargoError } from '@margoengine/math/errors';
import { useCommit } from './internal.js';

/** A named action matching either KeyboardEvent.key or KeyboardEvent.code. */
export interface KeyboardControlsEntry<T extends string = string> {
  name: T;
  keys: readonly string[];
  /** Clear on keyup. Default true; false leaves the action latched until blur. */
  up?: boolean;
}
/** Immutable snapshot of named keyboard actions. */
export type KeyboardControlsState<T extends string = string> = Readonly<Record<T, boolean>>;
/** Subscribe to a selected action; the returned function releases the subscription. */
export type KeyboardSubscribe<T extends string = string> = <V>(
  selector: (state: KeyboardControlsState<T>) => V,
  listener: (value: V, previous: V) => void,
) => () => void;
type Store = {
  get: () => KeyboardControlsState;
  listen: (listener: () => void) => () => void;
  event: (event: KeyboardEvent, down: boolean) => void;
  reset: () => void;
};
const KeyboardContext = createContext<Store | null>(null);
function createStore(map: readonly KeyboardControlsEntry[], change: (name: string, down: boolean, state: KeyboardControlsState) => void): Store {
  const pressed = new Map<string, { key: string; code: string }>(), listeners = new Set<() => void>();
  let state: KeyboardControlsState = Object.freeze(Object.fromEntries(map.map(({ name }) => [name, false])));
  const update = (reset = false) => {
    const next = { ...state }, changed: string[] = [];
    for (const entry of map) {
      const down = !reset && ((entry.up === false && state[entry.name]) || [...pressed.values()].some(e => entry.keys.includes(e.code) || entry.keys.includes(e.key)));
      if (down !== state[entry.name]) { next[entry.name] = down; changed.push(entry.name); }
    }
    if (!changed.length) return;
    state = Object.freeze(next);
    for (const name of changed) change(name, state[name], state);
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    listen(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    event(event, down) {
      const id = event.code || event.key;
      if (down) pressed.set(id, { key: event.key, code: event.code });
      else pressed.delete(id);
      update();
    },
    reset() { pressed.clear(); update(true); },
  };
}
/** Named keyboard actions shared by descendants, inside or outside Canvas. */
export interface KeyboardControlsProps<T extends string = string> {
  map: readonly KeyboardControlsEntry<T>[];
  children?: ReactNode;
  domElement?: HTMLElement | Window;
  onChange?: (name: T, pressed: boolean, state: KeyboardControlsState<T>) => void;
}
/** Owns key listeners and clears held keys on focus loss, visibility loss and unmount. */
export function KeyboardControls<T extends string = string>({ map, children, domElement, onChange }: KeyboardControlsProps<T>) {
  const latest = useRef(onChange); latest.current = onChange;
  const store = useMemo(() => createStore(map, (name, down, state) => latest.current?.(name as T, down, state)), [map]);
  useCommit(() => {
    const source = domElement ?? window, doc = 'ownerDocument' in source ? source.ownerDocument : source.document;
    const down = (event: Event) => store.event(event as KeyboardEvent, true), up = (event: Event) => store.event(event as KeyboardEvent, false);
    const hidden = () => { if (doc.hidden) store.reset(); };
    source.addEventListener('keydown', down); source.addEventListener('keyup', up); source.addEventListener('blur', store.reset);
    source.addEventListener('focusout', store.reset); doc.addEventListener('visibilitychange', hidden);
    const win = doc.defaultView; win?.addEventListener('blur', store.reset);
    return () => {
      source.removeEventListener('keydown', down); source.removeEventListener('keyup', up); source.removeEventListener('blur', store.reset);
      source.removeEventListener('focusout', store.reset); doc.removeEventListener('visibilitychange', hidden);
      win?.removeEventListener('blur', store.reset); store.reset();
    };
  }, [store, domElement]);
  return <KeyboardContext.Provider value={store}>{children}</KeyboardContext.Provider>;
}
/** Read actions without rerendering, or subscribe to a selected action. */
export function useKeyboardControls<T extends string = string>(): [KeyboardSubscribe<T>, () => KeyboardControlsState<T>];
/** Rerender when the selected action changes. */
export function useKeyboardControls<T extends string = string, V = boolean>(selector: (state: KeyboardControlsState<T>) => V): V;
export function useKeyboardControls<T extends string = string, V = boolean>(selector?: (state: KeyboardControlsState<T>) => V): V | [KeyboardSubscribe<T>, () => KeyboardControlsState<T>] {
  const store = useContext(KeyboardContext);
  if (!store) throw new MargoError('state', 'useKeyboardControls requires KeyboardControls; wrap the component in it.');
  const selected = useMemo(() => {
    let last: KeyboardControlsState | undefined, value: V;
    return () => {
      const next = store.get();
      if (next !== last) { last = next; value = selector ? selector(next as KeyboardControlsState<T>) : null as V; }
      return value;
    };
  }, [store, selector]);
  const snapshot = useSyncExternalStore(selector ? store.listen : () => () => {}, selected, selected);
  const api = useMemo<[KeyboardSubscribe<T>, () => KeyboardControlsState<T>]>(() => [
    (select, listener) => {
      let previous = select(store.get() as KeyboardControlsState<T>);
      return store.listen(() => {
        const next = select(store.get() as KeyboardControlsState<T>);
        if (!Object.is(next, previous)) { const old = previous; previous = next; listener(next, old); }
      });
    },
    store.get as () => KeyboardControlsState<T>,
  ], [store]);
  return selector ? snapshot : api;
}
