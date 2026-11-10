import { MargoError } from '@margoengine/math/errors';
import type { Json } from './document.js';

/** A player from animation or animator; definitions and procedural callbacks belong to the app. */
export interface PlaybackBinding {
  captureState(): object;
  restoreState(state: never): unknown;
}
/** Clustered, DirectionalLights and AreaLights expose this interface, including per-light shadow settings. */
export interface LightBinding {
  readonly list: readonly object[];
  setLights(lights: never): unknown;
}
/** Stable application/model ids connect a document to its loaded objects. No GPU objects are serialized. */
export interface SceneStateBindings {
  animations?: Readonly<Record<string, PlaybackBinding>>;
  lights?: Readonly<Record<string, LightBinding>>;
  /** Directional Shadows.options or other mutable shadow settings, by stable id. */
  shadows?: Readonly<Record<string, object>>;
}
/** Versioned detached values for stable playback, light and shadow bindings. */
export interface SavedSceneState {
  version: 1;
  animations: Record<string, Json>;
  lights: Record<string, Json>;
  shadows: Record<string, Json>;
}
function portable(value: unknown, seen = new Set<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || seen.has(value))
    throw new MargoError(
      'state',
      'Scene state must contain finite JSON values; keep callbacks and GPU resources in the bindings',
    );
  seen.add(value);
  let out: Json;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) out = Array.from(value as number[], (v) => portable(v, seen));
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new MargoError('state', 'Scene state contains a runtime object; bind its portable settings instead');
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    out = Object.fromEntries(entries.map(([key, v]) => [key, portable(v, seen)]));
  }
  seen.delete(value);
  return out;
}
/** Capture exact clip times, blend parameters, weights, masks, fades, triggers and light/shadow objects. */
export function captureSceneState(bindings: SceneStateBindings): SavedSceneState {
  return {
    version: 1,
    animations: Object.fromEntries(
      Object.entries(bindings.animations ?? {}).map(([id, p]) => [id, portable(p.captureState())]),
    ),
    lights: Object.fromEntries(Object.entries(bindings.lights ?? {}).map(([id, p]) => [id, portable(p.list)])),
    shadows: Object.fromEntries(Object.entries(bindings.shadows ?? {}).map(([id, p]) => [id, portable(p)])),
  };
}
/** Apply to already loaded models and installed lighting; failure rolls back every changed binding. */
export function restoreSceneState(state: SavedSceneState, bindings: SceneStateBindings): void {
  const value = portable(state) as unknown as SavedSceneState;
  if (value.version !== 1) throw new MargoError('state', 'Unknown scene state version; use version 1');
  const actions: { apply(): void; undo(): void }[] = [];
  for (const kind of ['animations', 'lights', 'shadows'] as const) {
    const group = value[kind];
    if (!group || Array.isArray(group) || typeof group !== 'object')
      throw new MargoError('state', `Missing scene state ${kind}; capture the complete state`);
    for (const [id, saved] of Object.entries(group)) {
      const target = bindings[kind]?.[id];
      if (!target || !Object.hasOwn(bindings[kind]!, id))
        throw new MargoError('state', `Missing ${kind} binding '${id}'; load and bind that object before restoring`);
      if (kind === 'animations') {
        const player = target as PlaybackBinding,
          before = portable(player.captureState());
        actions.push({
          apply: () => {
            player.restoreState(saved as never);
          },
          undo: () => {
            player.restoreState(before as never);
          },
        });
      } else if (kind === 'lights') {
        if (!Array.isArray(saved)) throw new MargoError('state', `Light state '${id}' must be an array`);
        const light = target as LightBinding,
          before = portable(light.list);
        actions.push({
          apply: () => {
            light.setLights(saved as never);
          },
          undo: () => {
            light.setLights(before as never);
          },
        });
      } else {
        if (!saved || Array.isArray(saved) || typeof saved !== 'object')
          throw new MargoError('state', `Shadow state '${id}' must be an object`);
        const before = portable(target) as object;
        const replace = (settings: object) => {
          for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
          Object.assign(target, settings);
        };
        actions.push({ apply: () => replace(saved), undo: () => replace(before) });
      }
    }
  }
  let applied = 0;
  try {
    for (const action of actions) {
      applied++;
      action.apply();
    }
  } catch (error) {
    const failures: unknown[] = [error];
    while (applied) {
      try {
        actions[--applied].undo();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Scene state restore and rollback failed');
    throw error;
  }
}
