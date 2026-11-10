/// <reference lib="esnext.disposable" preserve="true" />
import type { Clustered, ClusteredOptions, ClusteredReceiver, PointLight, SpotLight } from '@margoengine/clustered';
import type { AreaLights, RectAreaLight } from '@margoengine/clustered/area';
import type { DirectionalLight, DirectionalLights } from '@margoengine/clustered/directional';
import { engineRuntime } from '@margoengine/core/extension';
import type { Stage } from './index.js';
import { optionalPackage, stageSignal } from './feature.js';
import { Cleanup } from '../../shared/cleanup.js';
import { fault, typeError } from '../../shared/errors.js';

/** One world-space light. Colours are linear RGB; lengths are metres and cone angles are radians. */
export type StageLight =
  | ({ type: 'point' } & Omit<PointLight, 'range'> & { range?: number })
  | ({ type: 'spot' } & Omit<SpotLight, 'range'> & { range?: number })
  | ({ type: 'area' } & RectAreaLight)
  | ({ type: 'directional' } & DirectionalLight);

/** Options for the optional one-call lights entry. */
export interface AddLightsOptions {
  /** Cluster grid and integrated shadow settings, used only when creating the stage's first Clustered. */
  clustered?: ClusteredOptions;
  /** Extra receivers beyond the stage's models, such as a caller-owned terrain. */
  receivers?: Iterable<ClusteredReceiver>;
  /** Discover current and subsequently loaded lighting receivers on each stage tick. Default true. */
  autoReceivers?: boolean;
  /** Cancel package imports; stage disposal also cancels them. */
  signal?: AbortSignal;
}

/** Shared clustered lighting plus this call's owned light contribution. */
export interface StageLights {
  /** Point/spot lighting, also shared by area and directional lights. */
  readonly clustered: Clustered;
  /** Area lighting, null when this call has no area lights. */
  readonly area: AreaLights | null;
  /** Extra directional lighting, null when this call has none. */
  readonly directional: DirectionalLights | null;
  /** Attach a receiver, with shared ownership across helpers. Returns an idempotent remover. */
  add(receiver: ClusteredReceiver): () => void;
  /** Remove this call's lights and receivers, preserving other calls and pre-existing plugins. */
  dispose(): void;
  [Symbol.dispose](): void;
}

type List<T> = { readonly list: readonly T[]; setLights(lights: readonly T[]): unknown; dispose(): void };
const plugins = new WeakMap<object, { users: number; owned: boolean }>(),
  receivers = new WeakMap<Clustered, Map<ClusteredReceiver, { users: number; remove?: () => void }>>();

function retain<T>(plugin: List<T>, owned: boolean, undo: (() => void)[]): void {
  const state = plugins.get(plugin) ?? { users: 0, owned };
  plugins.set(plugin, state);
  state.users++;
  undo.push(() => {
    if (
      --state.users === 0 &&
      state.owned &&
      !plugin.list.length &&
      !('area' in plugin && plugin.area) &&
      !('directional' in plugin && plugin.directional)
    )
      plugin.dispose();
  });
}
function contribute<T>(plugin: List<T>, own: T[], undo: (() => void)[]): void {
  plugin.setLights([...plugin.list, ...own]);
  undo.push(() => plugin.setLights(plugin.list.filter((light) => !own.includes(light))));
}

/**
 * Adds point, spot, rectangular area and extra directional lights in one call. Existing light lists and plugins are
 * shared; each returned handle owns only its contribution. Models loaded before or after the call receive the light.
 * Area and directional packages import only when requested. Requires native WebGPU or its compatibility device.
 */
export async function addLights(
  stage: Stage,
  lights: readonly StageLight[],
  options: AddLightsOptions = {},
): Promise<StageLights> {
  if (
    !Array.isArray(lights) ||
    lights.some((light) => !light || !['point', 'spot', 'area', 'directional'].includes(light.type))
  )
    throw typeError('Lights: pass an array with type point, spot, area or directional', 'arguments');
  if (options.autoReceivers !== undefined && typeof options.autoReceivers !== 'boolean')
    throw typeError('autoReceivers: pass a boolean', 'arguments');
  const abort = stageSignal(stage, options.signal);
  abort.throwIfAborted();
  const local: (PointLight | SpotLight)[] = [],
    areas: RectAreaLight[] = [],
    suns: DirectionalLight[] = [];
  for (const light of lights) {
    const { type, ...value } = light;
    if (type === 'area') areas.push(value as RectAreaLight);
    else if (type === 'directional') suns.push(value as DirectionalLight);
    else {
      const spot = value as SpotLight;
      local.push({
        ...value,
        range: spot.range === undefined ? 0 : spot.range,
        ...(type === 'spot' && spot.angle === undefined && spot.outerAngle === undefined
          ? spot.penumbra === undefined
            ? { outerAngle: Math.PI / 4 }
            : { angle: Math.PI / 4 }
          : {}),
      } as PointLight | SpotLight);
    }
  }
  const [base, areaModule, sunModule] = await Promise.all([
    optionalPackage('@margoengine/clustered', () => import('@margoengine/clustered'), abort),
    areas.length
      ? optionalPackage('@margoengine/clustered/area', () => import('@margoengine/clustered/area'), abort)
      : null,
    suns.length
      ? optionalPackage('@margoengine/clustered/directional', () => import('@margoengine/clustered/directional'), abort)
      : null,
  ]);
  abort.throwIfAborted();
  const runtime = engineRuntime(stage.engine),
    undo: (() => void)[] = [];
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stage.signal.removeEventListener('abort', dispose);
    const cleanup = new Cleanup();
    if (!stage.signal.aborted) for (const action of undo.splice(0).reverse()) cleanup.run(action);
    cleanup.finish();
  };
  try {
    const previous = runtime.plugins.get('clustered') as Clustered | undefined;
    if (previous && options.clustered)
      throw fault('state', 'Clustered already exists; set options on the first addLights call');
    const clustered = previous ?? stage.use(new base.Clustered(options.clustered));
    retain(clustered, !previous, undo);
    contribute(clustered, local, undo);
    let area: AreaLights | null = null,
      directional: DirectionalLights | null = null;
    if (areaModule) {
      const previous = runtime.plugins.get('clustered:area') as AreaLights | undefined;
      area = previous ?? stage.use(new areaModule.AreaLights({ lights: clustered }));
      retain(area, !previous, undo);
      contribute(area, areas, undo);
    }
    if (sunModule) {
      const previous = runtime.plugins.get('clustered:directional') as DirectionalLights | undefined;
      directional = previous ?? stage.use(new sunModule.DirectionalLights({ lights: clustered }));
      retain(directional, !previous, undo);
      contribute(directional, suns, undo);
    }
    const attached = new Map<ClusteredReceiver, () => void>(),
      shared = receivers.get(clustered) ?? new Map<ClusteredReceiver, { users: number; remove?: () => void }>();
    receivers.set(clustered, shared);
    const add = (receiver: ClusteredReceiver): (() => void) => {
      if (disposed) throw fault('disposed', 'Lights disposed; create another addLights handle');
      const prior = attached.get(receiver);
      if (prior) return prior;
      let state = shared.get(receiver);
      if (!state) {
        state = { users: 0, remove: clustered.hasReceiver(receiver) ? undefined : clustered.add(receiver) };
        shared.set(receiver, state);
      }
      state.users++;
      let removed = false;
      const remove = (): void => {
        if (removed) return;
        removed = true;
        attached.delete(receiver);
        if (--state!.users === 0) {
          state!.remove?.();
          shared.delete(receiver);
        }
      };
      attached.set(receiver, remove);
      undo.push(remove);
      return remove;
    };
    for (const receiver of options.receivers ?? []) add(receiver);
    if (options.autoReceivers !== false) {
      const sync = (): void => {
        for (const plugin of runtime.plugins.values())
          if ('addLighting' in plugin && typeof plugin.addLighting === 'function') add(plugin as ClusteredReceiver);
      };
      sync();
      undo.push(stage.onTick(sync));
    }
    stage.signal.addEventListener('abort', dispose, { once: true });
    return { clustered, area, directional, add, dispose, [Symbol.dispose]: dispose };
  } catch (error) {
    const cleanup = new Cleanup(error);
    cleanup.run(dispose).finish();
    throw error;
  }
}
