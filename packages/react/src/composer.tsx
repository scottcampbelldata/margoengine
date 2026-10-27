import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { Bloom as BloomEffect, BloomOptions } from '@margoengine/post/bloom';
import type { SSAO as SSAOEffect, SSAOOptions } from '@margoengine/post/ssao';
import type { DOF as DepthOfFieldEffect, DOFOptions } from '@margoengine/dof';
import type { Tonemap as TonemapEffect, TonemapOptions, CubeLUT } from '@margoengine/tonemap';
import type { TAA as TAAEffect, TAAOptions, VelocityPrimitive, VelocitySource } from '@margoengine/taa';
import type { GTAO as GTAOEffect, GTAOOptions } from '@margoengine/post/gtao';
import type { SSR as SSREffect, SSROptions } from '@margoengine/post/ssr';
import type { SSGI as SSGIEffect, SSGIOptions } from '@margoengine/post/ssgi';
import type { MotionBlur as MotionBlurEffect, MotionBlurOptions } from '@margoengine/post/motion-blur';
import type { LensFlare as LensFlareEffect, LensFlareOptions } from '@margoengine/post/lens-flare';
import type { SMAA as SMAAEffect, SMAAOptions } from '@margoengine/post/smaa';
import type { FXAA as FXAAEffect } from '@margoengine/post/fxaa';
import type { Glitch as GlitchEffect, GlitchOptions } from '@margoengine/post/glitch';
import type { Afterimage as AfterimageEffect, AfterimageOptions } from '@margoengine/post/afterimage';
import type { PostStack } from '@margoengine/post/stack';
import { useScene, useCommit, useResourceEffect, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';
import { MargoError } from '@margoengine/math/errors';

// Stack order: HDR effects, the display effect, then LDR effects (PostStack's rule); TAA attaches on its own, last.
const order = [
  'ssao',
  'gtao',
  'ssgi',
  'ssr',
  'motionBlur',
  'dof',
  'bloom',
  'lensFlare',
  'afterimage',
  'tonemap',
  'smaa',
  'fxaa',
  'glitch',
  'taa',
] as const;
/** The effect kinds, in stack order. */
type Kind = (typeof order)[number];
/** Any effect plugin the composer manages. */
type Effect =
  | BloomEffect
  | SSAOEffect
  | DepthOfFieldEffect
  | TonemapEffect
  | TAAEffect
  | SSREffect
  | SSGIEffect
  | MotionBlurEffect
  | LensFlareEffect
  | SMAAEffect
  | FXAAEffect
  | GlitchEffect
  | AfterimageEffect;
/** Options of one effect. */
type Options = Record<string, unknown>;
/** `onReady` and `onError` of an effect component. */
interface Callbacks<T> {
  onReady?: (effect: T) => void;
  onError?: (error: unknown) => void;
}
/** Props of the EffectComposer component; every prop is optional unless noted. */
export interface EffectComposerProps {
  children?: ReactNode;
  enabled?: boolean;
  onError?: (error: unknown) => void;
}
/** Props of the Bloom component; every prop is optional unless noted. */
export interface BloomProps extends BloomOptions, Callbacks<BloomEffect> {}
/** Props of the SSAO component; every prop is optional unless noted. */
export interface SSAOProps extends SSAOOptions, Callbacks<SSAOEffect> {}
/** Props of the DepthOfField component; every prop is optional unless noted. */
export interface DepthOfFieldProps extends DOFOptions, Callbacks<DepthOfFieldEffect> {}
/** Props of the Tonemap component; every prop is optional unless noted. */
export interface TonemapProps extends TonemapOptions, Callbacks<TonemapEffect> {
  lut?: CubeLUT | string | null;
}
/** Props of the TAA component; every prop is optional unless noted. */
export interface TAAProps extends TAAOptions, Callbacks<TAAEffect> {}
/** Props of `<GTAO>`: ground-truth ambient occlusion, SSAO's options plus GTAO's own. */
export interface GTAOProps extends GTAOOptions, Callbacks<GTAOEffect> {}
/** Props of `<SSR>`: screen-space reflections on the Canvas's PBR models. */
export interface SSRProps extends SSROptions, Callbacks<SSREffect> {}
/** Props of `<SSGI>`: screen-space indirect light on the Canvas's PBR models. */
export interface SSGIProps extends SSGIOptions, Callbacks<SSGIEffect> {}
/** Props of `<MotionBlur>`. `velocity` defaults to the motion vectors of a `<TAA>` in the same composer. */
export interface MotionBlurProps extends Partial<MotionBlurOptions>, Callbacks<MotionBlurEffect> {}
/** Props of `<LensFlare>`. */
export interface LensFlareProps extends LensFlareOptions, Callbacks<LensFlareEffect> {}
/** Props of `<SMAA>`: morphological anti-aliasing (one of SMAA or FXAA per composer). */
export interface SMAAProps extends SMAAOptions, Callbacks<SMAAEffect> {}
/** Props of `<FXAA>`: fast approximate anti-aliasing (one of SMAA or FXAA per composer). */
export interface FXAAProps extends Callbacks<FXAAEffect> {}
/** Props of `<Glitch>`. */
export interface GlitchProps extends GlitchOptions, Callbacks<GlitchEffect> {}
/** Props of `<Afterimage>`: frames fade into the next. */
export interface AfterimageProps extends AfterimageOptions, Callbacks<AfterimageEffect> {}
interface Pass {
  kind: Kind;
  /** Imports the effect class: the component brings it, so the composer imports no effect package. */
  load: () => Promise<EffectClass>;
  options: Options;
  lut?: CubeLUT | string | null;
  onReady?: (effect: Effect) => void;
  onError?: (error: unknown) => void;
}
class PassLoadFailure {
  constructor(
    readonly pass: Pass,
    readonly failure: unknown,
  ) {}
}
type Model = Scene['resources']['models'] extends Set<infer T> ? T : never;
interface SourceBinding {
  remove: () => void;
  refresh?: () => void;
}
interface RecordEntry {
  pass: Pass;
  effect: Effect;
  options: Options;
  lut?: CubeLUT | string | null;
  sources: Map<Model, SourceBinding>;
  /** Owned by the composer's PostStack, which detaches it. */
  stacked?: boolean;
}
interface Lease {
  active: boolean;
  closed: boolean;
}
/** An effect plugin class: constructed for a stack, or attached on its own. */
export interface EffectClass {
  new (options: never): Effect;
  attach(engine: EngineKernel, options: never): Effect;
}
const priority = Object.fromEntries(order.map((kind, index) => [kind, index])) as Record<Kind, number>;
// Effects that add each PBR model as a source.
const modelKinds = new Set<Kind>(['ssao', 'gtao', 'ssr', 'ssgi', 'taa']);
declare const GPUBufferUsage: { VERTEX: number; STORAGE: number; COPY_DST: number };

// Native static glTF vertex buffers are VERTEX-only. TAA's snapshot compute
// needs STORAGE too; retain a separate upload without changing the model or its
// beauty/shadow buffers. Animation's STORAGE buffers already satisfy that API.
function velocitySource(scene: Scene, model: Model) {
  const copies = new Map<GPUBuffer, { buffer: GPUBuffer; vertices: Float32Array }>();
  let device = scene.engine.gpu,
    closed = false,
    primitives: VelocityPrimitive[] = [];
  const release = () => {
    for (const copy of copies.values()) copy.buffer.destroy();
    copies.clear();
  };
  const refresh = () => {
    if (closed || model.disposed || scene.engine.disposed) {
      release();
      primitives = [];
      return;
    }
    if (device !== scene.engine.gpu) {
      release();
      device = scene.engine.gpu;
    }
    if (!device) {
      primitives = [];
      return;
    }
    const inputs = model.primitives.filter((primitive) => primitive.material.settings[0] !== 2),
      originals = model.shadowPrimitives,
      used = new Set<GPUBuffer>(),
      next: VelocityPrimitive[] = [];
    try {
      for (let index = 0; index < originals.length; index++) {
        const primitive = originals[index];
        if (primitive.vertex.usage & GPUBufferUsage.STORAGE) {
          next.push(primitive);
          continue;
        }
        const input = inputs[index];
        if (
          !input ||
          input.node !== primitive.node ||
          input.indices.length !== primitive.count ||
          input.deformed ||
          input.vertices.byteLength !== primitive.vertex.size
        )
          throw new MargoError(
            'state',
            'TAA requires matching static PBR vertex data or a storage-capable deformed buffer; remove TAA or use static meshes.',
          );
        used.add(primitive.vertex);
        let copy = copies.get(primitive.vertex);
        if (copy && copy.vertices !== input.vertices) {
          copy.buffer.destroy();
          copies.delete(primitive.vertex);
          copy = undefined;
        }
        if (!copy) {
          const buffer = device.createBuffer({
            size: input.vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          try {
            device.queue.writeBuffer(buffer, 0, input.vertices as Float32Array<ArrayBuffer>);
          } catch (error) {
            buffer.destroy();
            throw error;
          }
          copy = { buffer, vertices: input.vertices };
          copies.set(primitive.vertex, copy);
        }
        next.push({ ...primitive, vertex: copy.buffer });
      }
      for (const [original, copy] of copies)
        if (!used.has(original)) {
          copy.buffer.destroy();
          copies.delete(original);
        }
      primitives = next;
    } catch (error) {
      release();
      primitives = [];
      throw error;
    }
  };
  const source: VelocitySource = {
    get shadowPrimitives() {
      refresh();
      return primitives;
    },
    get disposed() {
      return closed || model.disposed || scene.engine.disposed;
    },
  };
  return {
    source,
    refresh,
    dispose() {
      closed = true;
      release();
      primitives = [];
    },
  };
}

// A lifecycle coordinator over the native plugins. One effect (plus TAA) attaches on its own; two or more share one
// HDR scene capture through a PostStack, in stack order, so any combination works (one display effect, one of SMAA
// and FXAA). A change in which effects are present rebuilds the stack; option changes update the live effects.
function composer(scene: Scene, error: () => EffectComposerProps['onError']) {
  const passes = new Set<Pass>(),
    records = new Map<Kind, RecordEntry>();
  let lease: Lease | undefined,
    revision = 0,
    scheduled = false,
    queue = Promise.resolve(),
    stack: { key: string; plugin: PostStack } | null = null;
  const live = (current = lease) =>
    !!current && current === lease && current.active && !current.closed && !scene.engine.disposed;
  const report = (failure: unknown, pass?: Pass) => {
    const handler = pass?.onError ?? error();
    if (handler) handler(failure);
    else scene.engine.onError(failure);
  };
  const dispose = (record: RecordEntry) => {
    for (const binding of record.sources.values()) binding.remove();
    record.sources.clear();
    record.effect.dispose();
  };
  // The stack detaches its effects first; their own dispose then frees what they hold.
  const clearStack = () => {
    if (!stack) return;
    stack.plugin.dispose();
    stack = null;
    for (const [kind, record] of [...records].reverse())
      if (record.stacked) {
        dispose(record);
        records.delete(kind);
      }
  };
  const clear = () => {
    clearStack();
    for (const record of [...records.values()].reverse()) dispose(record);
    records.clear();
  };
  const depth = () => {
    if (stack) return stack.plugin.depthTexture;
    const record = records.get('dof') ?? records.get('ssao') ?? records.get('bloom');
    return record ? (record.effect as DepthOfFieldEffect | SSAOEffect | BloomEffect).depthTexture : undefined;
  };
  const velocity = () => (records.get('taa')?.effect as TAAEffect | undefined)?.velocity;
  const syncSources = () => {
    if (!live()) return;
    for (const [kind, record] of records) {
      if (!modelKinds.has(kind)) continue;
      for (const [model, binding] of record.sources)
        if (!scene.resources.models.has(model) || model.disposed) {
          binding.remove();
          record.sources.delete(model);
        } else binding.refresh?.();
      for (const model of scene.resources.models)
        if (!model.disposed && !record.sources.has(model)) {
          if (kind !== 'taa')
            record.sources.set(model, {
              remove: (record.effect as SSAOEffect | SSREffect | SSGIEffect).add(model as never),
            });
          else {
            const adapter = velocitySource(scene, model);
            try {
              const remove = (record.effect as TAAEffect).add(adapter.source);
              record.sources.set(model, {
                refresh: adapter.refresh,
                remove() {
                  remove();
                  adapter.dispose();
                },
              });
            } catch (error) {
              adapter.dispose();
              throw error;
            }
          }
        }
    }
  };
  const validate = (desired: Pass[]) => {
    const kinds = new Set<Kind>();
    for (const pass of desired) {
      if (kinds.has(pass.kind))
        throw new MargoError(
          'state',
          `EffectComposer cannot attach duplicate ${pass.kind} passes; keep one of each kind.`,
        );
      kinds.add(pass.kind);
    }
    if (kinds.has('smaa') && kinds.has('fxaa'))
      throw new TypeError('EffectComposer takes one anti-aliasing effect; keep <SMAA> or <FXAA>, not both');
    if (kinds.has('ssao') && kinds.has('gtao'))
      throw new TypeError('EffectComposer takes one ambient occlusion effect; keep <SSAO> or <GTAO>, not both');
    if (desired.some((pass) => pass.kind === 'motionBlur' && !pass.options.velocity) && !kinds.has('taa'))
      throw new TypeError('MotionBlur reads TAA motion vectors; add <TAA> to the same EffectComposer or pass velocity');
  };
  const update = (record: RecordEntry, pass: Pass, options: Options) => {
    record.pass = pass;
    const changed = Object.keys({ ...record.options, ...options }).some((key) => record.options[key] !== options[key]);
    if (changed) {
      // FXAA has no options, so FXAA props never change here.
      const target = (record.effect as unknown as { options: Options }).options;
      for (const key of Object.keys(target)) if (!(key in options)) delete target[key];
      Object.assign(target, options);
      record.options = options;
      if (pass.kind === 'taa') (record.effect as TAAEffect).reset();
    }
    if (pass.kind === 'tonemap' && record.lut !== pass.lut) {
      (record.effect as TonemapEffect).setLUT(pass.lut ?? null);
      record.lut = pass.lut;
    }
  };
  const created = (record: RecordEntry) => {
    records.set(record.pass.kind, record);
    if (record.pass.kind === 'tonemap' && record.pass.lut !== undefined) {
      (record.effect as TonemapEffect).setLUT(record.pass.lut);
      record.lut = record.pass.lut;
    }
    record.pass.onReady?.(record.effect);
  };
  const reconcile = async (version: number) => {
    const current = lease;
    if (!live(current) || version !== revision) return;
    const desired = [...passes].sort((a, b) => priority[a.kind] - priority[b.kind]);
    let attaching: Pass | undefined;
    try {
      if (desired.length && (scene.engine.backend !== 'webgpu' || !scene.engine.gpu))
        throw new MargoError(
          'unsupported',
          'EffectComposer requires WebGPU; use an engine created with a WebGPU backend.',
        );
      validate(desired);
      const effects = desired.filter((pass) => pass.kind !== 'taa'),
        stacked = effects.length > 1;
      const [imports, Stack] = await Promise.all([
        Promise.all(
          desired.map(async (pass) => {
            try {
              return [pass.kind, await pass.load()] as const;
            } catch (failure) {
              throw new PassLoadFailure(pass, failure);
            }
          }),
        ),
        stacked
          ? optionalPeer('@margoengine/post/stack', () => import('@margoengine/post/stack')).then(
              (api) => api.PostStack,
            )
          : null,
      ]);
      if (!live(current) || version !== revision) return;
      const classes = new Map(imports),
        kinds = new Set(desired.map((pass) => pass.kind));
      const optionsFor = (pass: Pass): Options => ({
        ...pass.options,
        ...(pass.kind === 'taa' && !pass.options.depth && kinds.size > 1 ? { depth } : {}),
        ...(pass.kind === 'motionBlur' && !pass.options.velocity ? { velocity } : {}),
      });
      // Effects whose stack (or lack of one) no longer matches go first; TAA is kept unless its pass changed.
      const key = stacked ? effects.map((pass) => pass.kind).join() : '';
      if (stack && (stack.key !== key || effects.some((pass) => records.get(pass.kind)?.pass !== pass))) clearStack();
      for (const [kind, record] of [...records].reverse()) {
        const next = desired.find((pass) => pass.kind === kind);
        // Tonemap reads `source` once, when it is created.
        const source = kind === 'tonemap' && next && record.options.source !== optionsFor(next).source;
        if (!record.stacked && (!next || next !== record.pass || source || (stacked && kind !== 'taa'))) {
          dispose(record);
          records.delete(kind);
        }
      }
      if (stacked && !stack) {
        const made: RecordEntry[] = [];
        try {
          for (const pass of effects) {
            attaching = pass;
            const options = optionsFor(pass),
              Effect = classes.get(pass.kind)!;
            made.push({ pass, effect: new Effect(options as never), options, sources: new Map(), stacked: true });
          }
          attaching = undefined;
          stack = {
            key,
            plugin: Stack!.attach(
              scene.engine as unknown as EngineKernel,
              made.map((r) => r.effect),
            ),
          };
        } catch (failure) {
          for (const record of made) record.effect.dispose();
          throw failure;
        }
        for (const record of made) created(record);
      }
      for (const pass of desired) {
        attaching = pass;
        const options = optionsFor(pass),
          record = records.get(pass.kind);
        if (record) update(record, pass, options);
        else {
          const effect = classes.get(pass.kind)!.attach(scene.engine as unknown as EngineKernel, options as never);
          created({ pass, effect, options, sources: new Map() });
        }
      }
      syncSources();
    } catch (failure) {
      if (live(current)) {
        clear();
        if (failure instanceof PassLoadFailure) report(failure.failure, failure.pass);
        else report(failure, attaching);
      }
    }
  };
  const schedule = () => {
    revision++;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const version = revision;
      queue = queue
        .then(() => reconcile(version))
        .catch((failure) => {
          if (live()) report(failure);
        });
    });
  };
  return {
    passes,
    schedule,
    start(current: Lease) {
      lease = current;
      scene.frames.callbacks.add(syncSources);
      schedule();
      return () => {
        if (lease !== current) return;
        lease = undefined;
        revision++;
        scene.frames.callbacks.delete(syncSources);
        clear();
      };
    },
  };
}

type Composer = ReturnType<typeof composer>;
const Context = createContext<Composer | null>(null);
/** The effect composer component. */
export function EffectComposer({ children, enabled = true, onError }: EffectComposerProps) {
  const scene = useScene(),
    errors = useRef(onError);
  errors.current = onError;
  const manager = useMemo(() => composer(scene, () => errors.current), [scene.engine, scene.resources, scene.frames]);
  useResourceEffect((lease) => (enabled ? manager.start(lease) : undefined), [manager, enabled]);
  return <Context.Provider value={manager}>{children}</Context.Provider>;
}
/** Adds one effect to the enclosing `<EffectComposer>` for the life of the component. */
export function usePass<T extends Effect>(
  kind: Kind,
  load: () => Promise<EffectClass>,
  options: Options,
  callbacks: Callbacks<T>,
  lut?: CubeLUT | string | null,
) {
  const manager = useContext(Context);
  if (!manager) throw new MargoError('state', 'Post effects require <EffectComposer>; render them inside one.');
  const pass = useMemo<Pass>(() => ({ kind, load, options: {} }), [manager, kind]);
  pass.load = load;
  pass.options = options;
  pass.lut = lut;
  pass.onReady = callbacks.onReady as Pass['onReady'];
  pass.onError = callbacks.onError;
  useResourceEffect(() => {
    manager.passes.add(pass);
    manager.schedule();
    return () => {
      manager.passes.delete(pass);
      manager.schedule();
    };
  }, [manager, pass]);
  useCommit(() => {
    manager.schedule();
  });
}
