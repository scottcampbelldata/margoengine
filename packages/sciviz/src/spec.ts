import { Figure as BaseFigure } from '@margoengine/sciviz';
import type { CreateFigureOptions, FigureOptions, Layer, PointSelection } from './figure.js';
import type { EngineKernel } from '@margoengine/core';
import { Camera } from '@margoengine/core';
import type { DType } from '@margoengine/compute';
import type { FilterPipeline, PipelineJSON, PipelineRegistry } from './pipeline.js';
import { fault, typeError } from '../../shared/errors.js';
import {
  specHash,
  ValueIO,
  copySpecArray,
  snapshotConsumedInput,
  type SpecIOOptions,
  type SpecValue,
} from './spec-values.js';
import { attachSpecRecorder } from './spec-hooks.js';
import { isGpuArray } from './layer.js';
export { loadSpecData, specHash } from './spec-values.js';
export type { SpecDataURL, SpecDType, SpecIOOptions, SpecValue } from './spec-values.js';
export type * from './figure.js';
export type * from '@margoengine/sciviz';
export { figureSchema } from './spec-schema.js';

/** Encode a standalone portable value with the same hash and allocation rules as a figure. */
export async function encodeFigureValue(value: unknown, options: SpecIOOptions = {}): Promise<SpecValue> {
  return new ValueIO(options).encode(value);
}
/** Decode a standalone portable value; executable callbacks and unknown tags reject. */
export async function decodeFigureValue(value: SpecValue, options: SpecIOOptions = {}): Promise<unknown> {
  return new ValueIO(options).decode(value);
}

/** Versioned portable figure state. Resource IDs are local and ordered by dependency. */
export interface FigureSpec {
  readonly version: 1;
  /** SHA-256 of compact JSON with this field omitted, including plain-array data. */
  readonly sha256?: string;
  readonly options: SpecValue;
  readonly camera: CameraState;
  readonly limits: readonly number[];
  readonly dragMode: string;
  readonly resources: readonly FigureResource[];
  readonly layers: readonly string[];
  readonly selection?: SpecValue;
  readonly pipeline?: PipelineJSON;
  readonly annotations?: SpecValue;
  readonly time?: {
    readonly times: readonly number[];
    readonly index: number;
    readonly frames: readonly FigureSpec[];
    readonly options?: SpecValue;
  };
}
/** Look-at perspective settings; 2D projection follows the saved figure options and limits. */
export interface CameraState {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly fov: number;
  readonly near: number;
  readonly far: number;
}
/** One declarative creation recipe and its later mutations. No executable text occurs in the format. */
export interface FigureResource {
  readonly id: string;
  readonly kind: string;
  readonly args: SpecValue;
  readonly state: SpecValue;
  readonly updates: readonly { readonly method: string; readonly args: SpecValue }[];
}
/** Saving defaults to inline arrays and captures every timeline frame. */
export interface FigureSaveOptions extends SpecIOOptions {
  readonly data?: 'inline' | 'url';
  readonly timeline?: boolean;
}
/** A codec owns optional layer creation and state restoration, including annotations. */
export interface FigureCodec {
  readonly create: (figure: Figure, args: readonly unknown[], signal?: AbortSignal) => object | Promise<object>;
  readonly snapshot?: (object: object) => unknown | Promise<unknown>;
  readonly restore?: (object: object, state: unknown, signal?: AbortSignal) => void | Promise<void>;
}
/** Restore registry defaults empty; unknown custom kinds reject rather than fetching executable code. */
export interface FigureLoadOptions extends SpecIOOptions {
  readonly codecs?: Readonly<Record<string, FigureCodec>>;
  readonly registry?: PipelineRegistry;
  readonly engine?: EngineKernel;
}
/** A figure with explicit portable state, opt-in recipe support and no import-time prototype changes. */
export interface Figure extends BaseFigure {
  toJSON(options?: FigureSaveOptions): Promise<FigureSpec>;
  /** Retained graph description. Operators are provided explicitly when a spec is restored. */
  pipeline?: FilterPipeline;
  /** A dormant graph retained when the restoring application has not supplied its operator registry yet. */
  pipelineState?: PipelineJSON;
  /** JSON annotation definitions; annotation renderers can register a codec through recipe(). */
  annotations?: unknown;
  /** Register and record a custom layer with its stable, application-defined kind. */
  recipe(kind: string, args: readonly unknown[], codec: FigureCodec): Promise<object>;
  /** Apply exact point indices from a notebook or restored spec and dispatch selection. */
  setSelection(selection: PointSelection | undefined, options?: { readonly emit?: boolean }): void;
}

interface Recipe {
  id: string;
  kind: string;
  args: unknown[];
  object: object;
  updates: { method: string; args: unknown[] }[];
  codec?: FigureCodec;
  refreshInput?: () => Promise<unknown>;
  dead: boolean;
}
interface RecordState {
  options: FigureOptions;
  records: Recipe[];
  refs: Map<object, string>;
  gpuData: { dispose(): void }[];
  pending: Set<Promise<unknown>>;
  nextId: number;
  disposed: boolean;
  selection?: PointSelection;
  timeline?: { object: ReturnType<BaseFigure['timeline']>; options: unknown };
}
const records = new WeakMap<BaseFigure, RecordState>();
const canvases = new WeakMap<HTMLCanvasElement, Figure>();
/** Look up an opted-in figure on a canvas without retaining detached canvases. */
export function recordedFigure(canvas: HTMLCanvasElement): Figure | undefined {
  return canvases.get(canvas);
}
const methods = [
  'scatter',
  'line',
  'quiver',
  'streamlines',
  'surface',
  'volume',
  'isosurface',
  'bar',
  'histogram',
  'heatmap',
  'colorbar',
] as const;
const properties = [
  'visible',
  'range',
  'contours',
  'grid',
  'opacity',
  'mode',
  'density',
  'quality',
  'shading',
  'clip',
  'position',
] as const;
const updates = [
  'setHeights',
  'update',
  'setClassification',
  'setLabels',
  'setPositions',
  'setPhase',
  'setTime',
  'setFrame',
  'load',
  'advance',
  'setDate',
] as const;
function signalArguments(args: readonly unknown[], signal: AbortSignal | undefined, kind: string): unknown[] {
  if (!signal || !['glyph','lic','tiles','particles','globe','selection-binding'].includes(kind)) return [...args];
  const result = [...args],
    last = result.length - 1;
  result[last] = { ...(result[last] as Record<string, unknown>), signal };
  return result;
}
async function builtinCodec(kind: string): Promise<FigureCodec | undefined> {
  switch (kind) {
    case 'selection-store':
      return { create: (_f, args) => args[0] as object };
    case 'selection-binding': {
      const { bindSelection } = await import('@margoengine/sciviz/link');
      return {
        create: (f, args, signal) => Reflect.apply(bindSelection, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
    case 'particles': {
      const { flowParticles } = await import('@margoengine/sciviz/flow');
      return {
        create: (f, args, signal) => Reflect.apply(flowParticles, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
    case 'globe': {
      const { globeAtmosphere } = await import('@margoengine/sciviz/atmosphere');
      return {
        create: (f, args, signal) => Reflect.apply(globeAtmosphere, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
    case 'globe.ground':
      return { create: (_f, args) => (args[0] as { ground: object }).ground };
    case 'globe.mesh':
    case 'globe.flow':
    case 'globe.points':
    case 'globe.clouds':
      return {
        create: (_f, args) => {
          const [globe, ...rest] = args;
          return Reflect.apply((globe as Record<string, (...a: unknown[]) => object>)[kind.slice(6)], globe, rest);
        },
      };
    case 'mesh': {
      const { meshLayer } = await import('@margoengine/sciviz/grids');
      return {
        create: (f, args, signal) => Reflect.apply(meshLayer, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
    case 'glyph': {
      const { glyphLayer } = await import('@margoengine/sciviz/glyph');
      return {
        create: (f, args, signal) => Reflect.apply(glyphLayer, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
    case 'graph': {
      const { graphLayer } = await import('@margoengine/sciviz/graph');
      return {
        create: (f, args, signal) => Reflect.apply(graphLayer, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
    case 'tiles': {
      const { tileLayer } = await import('@margoengine/sciviz/geo');
      return {
        create: (f, args, signal) => Reflect.apply(tileLayer, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
    case 'fusion': {
      const { fusionVolume } = await import('@margoengine/sciviz/labels');
      return {
        create: (f, args, signal) => Reflect.apply(fusionVolume, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
    case 'lic': {
      const { lic } = await import('@margoengine/sciviz/lic');
      return { create: (f, args, signal) => Reflect.apply(lic, undefined, [f, ...signalArguments(args, signal, kind)]) };
    }
    case 'cinematic': {
      const { cinematicVolume } = await import('@margoengine/sciviz/cinematic');
      return {
        create: (f, args, signal) => Reflect.apply(cinematicVolume, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
    case 'bricks': {
      const { brickedVolume } = await import('@margoengine/sciviz/bricks');
      return {
        create: (f, args, signal) => Reflect.apply(brickedVolume, undefined, [f, ...signalArguments(args, signal, kind)]),
      };
    }
  }
}
const cleanOptions = (options: FigureOptions): FigureOptions => {
  const { signal: _signal, ...result } = options as CreateFigureOptions;
  return result;
};

// Inputs are borrowed by some renderers. Keep those references so later data updates are reflected at save time.
function observe(
  figure: Figure,
  state: RecordState,
  kind: string,
  args: unknown[],
  object: object,
  codec?: FigureCodec,
): object {
  if (state.disposed) throw fault('disposed', 'Recorded figure disposed; create a new one', 'sciviz');
  if (state.refs.has(object)) {
    const existing = state.records.find((item) => item.object === object)!;
    if (existing.kind !== kind) {
      existing.kind = kind;
      existing.args = args.map((arg) => snapshotInput(arg, state.refs));
      existing.codec = codec;
    }
    return object;
  }
  const savedArgs = args.map((arg) => snapshotInput(arg, state.refs));
  const recipe: Recipe = {
    id: `r${state.nextId++}`,
    kind,
    args: savedArgs,
    object,
    updates: [],
    codec,
    dead: false,
  };
  state.records.push(recipe);
  state.refs.set(object, recipe.id);
  const target = object as Record<string, unknown>;
  if (typeof target.dispose === 'function') {
    const dispose = (target.dispose as () => void).bind(object);
    target.dispose = () => {
      recipe.dead = true;
      state.refs.delete(object);
      const index = state.records.indexOf(recipe);
      if (index >= 0) state.records.splice(index, 1);
      dispose();
    };
  }
  for (const method of updates)
    if (typeof target[method] === 'function') {
      const call = (target[method] as (...a: unknown[]) => unknown).bind(object);
      target[method] = (...a: unknown[]) => {
        const result = call(...a);
        const remember = () => {
          const replaces =
            method.startsWith('set') || (method === 'update' && ['mesh', 'isosurface'].includes(recipe.kind));
          if (replaces)
            recipe.updates = recipe.updates.filter(
              (old) => old.method !== method || (method === 'setLabels' && old.args[0] !== a[0]),
            );
          recipe.updates.push({ method, args: a.map((arg) => snapshotInput(arg, state.refs)) });
        };
        if (result instanceof Promise) {
          const pending = result.then(async (value) => {
            if (method === 'update' && recipe.refreshInput) recipe.args[0] = await recipe.refreshInput();
            remember();
            return value;
          });
          state.pending.add(pending);
          const remove = () => state.pending.delete(pending);
          pending.then(remove, remove);
          return pending;
        }
        remember();
        return result;
      };
    }
  if (typeof target.slice === 'function') {
    const slice = (target.slice as (...a: unknown[]) => object).bind(object);
    target.slice = (...a: unknown[]) => observe(figure, state, 'slice', [object, ...a], slice(...a));
  }
  return object;
}

function snapshotInput(value: unknown, refs?: ReadonlyMap<object, string>): unknown {
  if (value && typeof value === 'object' && refs?.has(value)) return value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return copySpecArray(value);
  if (Array.isArray(value)) return value.map((item) => snapshotInput(item, refs));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'opacity' && typeof item === 'function'
          ? Array.from({ length: 256 }, (_, i) => [i / 255, item(i / 255)])
          : snapshotInput(item, refs),
      ]),
    );
  return value;
}

function portable(base: BaseFigure, options: FigureOptions): Figure {
  if (records.has(base)) return base as Figure;
  const figure = base as Figure,
    state: RecordState = {
      options: cleanOptions(options),
      records: [],
      refs: new Map(),
      gpuData: [],
      pending: new Set(),
      nextId: 0,
      disposed: false,
    };
  records.set(base, state);
  const canvas = (base.engine as unknown as { canvas?: HTMLCanvasElement }).canvas;
  if (canvas) canvases.set(canvas, figure);
  attachSpecRecorder(base, (kind, args, object) => {
    observe(figure, state, kind, args, object);
  });
  const removeLayer = figure.remove.bind(figure),
    disposeFigure = figure.dispose.bind(figure);
  figure.remove = (layer) => {
    for (const item of [...state.records])
      if (item.kind === 'selection-binding' && item.args[0] === layer) (item.object as { dispose(): void }).dispose();
    try {
      removeLayer(layer);
    } finally {
      state.refs.delete(layer);
      const index = state.records.findIndex((item) => item.object === layer);
      if (index >= 0) state.records.splice(index, 1);
    }
  };
  figure.dispose = () => {
    for (const item of [...state.records])
      if (item.kind === 'selection-binding') (item.object as { dispose(): void }).dispose();
    state.disposed = true;
    try {
      disposeFigure();
    } finally {
      state.records.length = 0;
      state.refs.clear();
      if (canvas && canvases.get(canvas) === figure) canvases.delete(canvas);
      for (const array of state.gpuData) array.dispose();
      state.gpuData.length = 0;
    }
  };
  for (const method of methods) {
    const original = (base[method] as (...args: unknown[]) => unknown).bind(base);
    Object.defineProperty(figure, method, {
      configurable: true,
      value: (...args: unknown[]) => {
        const result = original(...args);
        if (result instanceof Promise) {
          const pending = result.then(async (layer) => {
            try {
              const object = observe(figure, state, method, (await snapshotConsumedInput(args)) as unknown[], layer);
              if (method === 'isosurface' && isGpuArray(args[0]))
                state.records.find((item) => item.object === object)!.refreshInput = () => snapshotConsumedInput(args[0]);
              return object;
            } catch (error) {
              figure.remove(layer as Layer);
              throw error;
            }
          });
          state.pending.add(pending);
          const remove = () => {
            state.pending.delete(pending);
          };
          pending.then(remove, remove);
          return pending;
        }
        return observe(figure, state, method, args, result as object);
      },
    });
  }
  Object.defineProperty(figure, 'toJSON', {
    value: (opts?: FigureSaveOptions) => saveFigure(figure, typeof opts === 'object' ? opts : {}),
  });
  Object.defineProperty(figure, 'recipe', {
    value: async (kind: string, args: unknown[], codec: FigureCodec) => {
      if (!kind || methods.includes(kind as (typeof methods)[number]) || kind === 'slice')
        throw typeError('Custom recipe needs a unique kind; use a namespaced identifier', 'sciviz');
      return observe(figure, state, kind, args, await codec.create(figure, args), codec);
    },
  });
  let selection: PointSelection | undefined;
  let clearingSelection = false;
  Object.defineProperty(figure, 'selection', { get: () => selection });
  Object.defineProperty(figure, 'setSelection', {
    value: (value: PointSelection | undefined, options: { readonly emit?: boolean } = {}) => {
      if (state.disposed) throw fault('disposed', 'Recorded figure disposed; create a new one', 'sciviz');
      if (value)
        for (const item of value.points) {
          if (
            !figure.layers.includes(item.layer) ||
            !(item.indices instanceof Uint32Array) ||
            !item.indices.every((i) => i < item.layer.positions.length / 3)
          )
            throw typeError(
              'Selection needs indices within this figure layers; correct the point references',
              'sciviz',
            );
        }
      selection = value;
      state.selection = value;
      if (options.emit === false) return;
      clearingSelection = value === undefined;
      try {
        figure.dispatchEvent(
          new CustomEvent('selection', { detail: value ?? { region: { rect: [0, 0, 0, 0] }, points: [] } }),
        );
      } finally {
        clearingSelection = false;
      }
    },
  });
  figure.addEventListener('selection', (event) => {
    if (clearingSelection) return;
    selection = event.detail;
    state.selection = selection;
  });
  const timeline = figure.timeline.bind(figure);
  figure.timeline = (times, frame, opts = {}) => {
    const result = timeline(times, frame, opts);
    state.timeline = { object: result, options: opts };
    return result;
  };
  return figure;
}

/** Capture a figure created by this entry; figures created elsewhere must be recorded before adding layers. */
export async function saveFigure(figure: Figure, options: FigureSaveOptions = {}): Promise<FigureSpec> {
  const result = await captureFigure(figure, options, new ValueIO(options));

  const sha256 = await specHash(new TextEncoder().encode(JSON.stringify(result)));
  options.signal?.throwIfAborted();
  return { ...result, sha256 };
}

async function captureFigure(figure: Figure, options: FigureSaveOptions, io: ValueIO): Promise<FigureSpec> {
  const state = records.get(figure);
  if (!state)
    throw typeError(
      'Figure was not recorded; create it with the spec entry or call Figure.record before plotting',
      'sciviz',
    );
  if (state.disposed) throw fault('disposed', 'Recorded figure disposed; create a new one', 'sciviz');
  io.check();
  await Promise.all(state.pending);
  await figure.ready();
  io.check();
  const resources: FigureResource[] = [];
  const live = state.records.filter(
    (recipe) =>
      !recipe.dead &&
      (recipe.kind === 'colorbar' ||
        recipe.kind === 'slice' ||
        recipe.kind === 'cinematic' ||
        recipe.kind === 'selection-store' ||
        recipe.kind === 'selection-binding' ||
        figure.layers.includes(recipe.object as Layer)),
  );
  const order = new Map(figure.layers.map((layer, i) => [layer as object, i]));
  for (const item of live) if (item.kind === 'selection-store') order.set(item.object, -1);
  live.sort(
    (a, b) =>
      (order.get(a.object) ?? order.get(a.args[0] as object) ?? Infinity) -
      (order.get(b.object) ?? order.get(b.args[0] as object) ?? Infinity),
  );
  for (const recipe of live) {
    if (recipe.kind === 'slice' && !figure.layers.includes(recipe.args[0] as Layer)) continue;
    const object = recipe.object as Record<string, unknown>,
      saved: Record<string, unknown> = {};
    for (const key of properties) if (key in object) saved[key] = object[key];
    if (recipe.codec?.snapshot) saved.custom = await recipe.codec.snapshot(recipe.object);
    const argumentRefs = new Map(state.refs);
    argumentRefs.delete(recipe.object);
    resources.push({
      id: recipe.id,
      kind: recipe.kind,
      args: await io.encode(recipe.args, argumentRefs, options.data === 'url'),
      state: await io.encode(saved, state.refs, options.data === 'url'),
      updates: await Promise.all(
        recipe.updates.map(async (u) => ({
          method: u.method,
          args: await io.encode(u.args, state.refs, options.data === 'url'),
        })),
      ),
    });
  }
  const layers = figure.layers.map((layer) => {
    const id = state.refs.get(layer);
    if (!id) throw typeError('Unrecorded optional layer; create it with figure.recipe and a portable codec', 'sciviz');
    return id;
  });
  const camera = figure.engine.camera;
  const spec: FigureSpec = {
    version: 1,
    options: await io.encode(state.options),
    camera: {
      position: [...camera.position],
      target: [...camera.target],
      up: [...camera.up],
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
    },
    limits: [...figure.bounds],
    dragMode: figure.dragMode,
    resources,
    layers,
    ...(state.selection ? { selection: await io.encode(state.selection, state.refs) } : {}),
    ...(figure.pipeline || figure.pipelineState ? { pipeline: figure.pipeline?.toJSON() ?? figure.pipelineState } : {}),
    ...(figure.annotations !== undefined ? { annotations: await io.encode(figure.annotations) } : {}),
  };
  if (state.timeline && options.timeline !== false) {
    const timeline = state.timeline.object,
      index = timeline.index;
    timeline.pause();
    const frames: FigureSpec[] = [];
    try {
      for (let i = 0; i < timeline.times.length; i++) {
        io.check();
        await timeline.seek(i);
        frames.push(await captureFigure(figure, { ...options, timeline: false }, io));
      }
    } finally {
      if (index >= 0) await timeline.seek(index);
    }
    return {
      ...spec,
      time: { times: [...timeline.times], index, frames, options: await io.encode(state.timeline.options) },
    };
  }
  return spec;
}

/** Validate structure before allocating resources or executing any codec. */
export function validateFigureSpec(input: unknown): asserts input is FigureSpec {
  const v = input as FigureSpec;
  if (v?.sha256 !== undefined && (typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)))
    throw typeError('Invalid spec SHA-256; supply the pinned version 1 JSON', 'sciviz');
  if (
    !v ||
    v.version !== 1 ||
    !Array.isArray(v.resources) ||
    !Array.isArray(v.layers) ||
    !v.camera ||
    !Array.isArray(v.limits) ||
    ![4, 6].includes(v.limits.length) ||
    !v.limits.every(Number.isFinite)
  )
    throw typeError('Invalid figure version or structure; use the version 1 schema', 'sciviz');
  for (const key of ['position', 'target', 'up'] as const)
    if (!Array.isArray(v.camera[key]) || v.camera[key].length !== 3 || !v.camera[key].every(Number.isFinite))
      throw typeError('Invalid camera vector; supply three finite components', 'sciviz');
  if (
    !(v.camera.fov > 0 && v.camera.fov < 180 && v.camera.near > 0 && v.camera.far > v.camera.near) ||
    ![v.camera.fov, v.camera.near, v.camera.far].every(Number.isFinite)
  )
    throw typeError('Invalid camera projection; correct fov and clip distances', 'sciviz');
  if (!['orbit', 'pan', 'box', 'lasso'].includes(v.dragMode))
    throw typeError('Invalid dragMode; use orbit, pan, box or lasso', 'sciviz');
  const camera = new Camera(v.camera);
  camera.up = v.camera.up;
  camera.update(1, true);
  const ids = new Set<string>();
  for (const resource of v.resources) {
    if (
      !resource ||
      typeof resource.id !== 'string' ||
      !resource.id ||
      ids.has(resource.id) ||
      typeof resource.kind !== 'string' ||
      !Array.isArray(resource.updates)
    )
      throw typeError('Invalid figure resource; supply unique IDs and ordered updates', 'sciviz');
    ids.add(resource.id);
    for (const update of resource.updates)
      if (!updates.includes(update.method as (typeof updates)[number]))
        throw typeError('Unknown layer mutation; use a supported declarative update', 'sciviz');
  }
  if (v.layers.some((id) => !ids.has(id)) || new Set(v.layers).size !== v.layers.length)
    throw typeError('Invalid layer order; reference each resource once', 'sciviz');
  if (
    v.time &&
    (!Array.isArray(v.time.times) ||
      !v.time.times.length ||
      !v.time.times.every(Number.isFinite) ||
      !Number.isInteger(v.time.index) ||
      v.time.index < -1 ||
      v.time.index >= v.time.times.length ||
      v.time.frames.length !== v.time.times.length)
  )
    throw typeError('Invalid timeline; supply one frame per finite time', 'sciviz');
}

async function populate(figure: Figure, spec: FigureSpec, options: FigureLoadOptions): Promise<void> {
  const state = records.get(figure)!;
  const io = new ValueIO(options, async (data, shape, dtype) => {
      const gpu = await figure.renderer.compute();
      const array = gpu.array(data, { shape, dtype: dtype as DType });
      state.gpuData.push(array);
      return array;
    }),
    refs = new Map<string, object>();
  for (const layer of [...figure.layers]) figure.remove(layer);
  for (const recipe of [...state.records])
    if (!recipe.dead && ['slice', 'colorbar', 'cinematic'].includes(recipe.kind))
      (recipe.object as { dispose(): void }).dispose();
  state.records.length = 0;
  state.refs.clear();
  for (const data of state.gpuData) data.dispose();
  state.gpuData.length = 0;
  for (const resource of spec.resources) {
    io.check();
    const args = (await io.decode(resource.args, refs)) as unknown[];
    if (!Array.isArray(args)) throw typeError('Recipe arguments must be an array; correct the saved recipe', 'sciviz');
    if (resource.kind === 'isosurface') args[2] = { ...(args[2] as object), signal: options.signal };
    let object: object;
    if (methods.includes(resource.kind as (typeof methods)[number]))
      object = await (figure[resource.kind as (typeof methods)[number]] as (...a: unknown[]) => object)(...args);
    else if (resource.kind === 'slice') {
      const [volume, ...rest] = args as [{ slice: (...a: unknown[]) => object }, ...unknown[]];
      if (!volume || typeof volume.slice !== 'function')
        throw typeError('Slice needs an earlier volume; correct the resource order', 'sciviz');
      object = volume.slice(...rest);
    } else {
      const codec = options.codecs?.[resource.kind] ?? (await builtinCodec(resource.kind));
      if (!codec) throw fault('unsupported', `Unknown recipe ${resource.kind}; provide its codec explicitly`, 'sciviz');
      object = await codec.create(figure, args, options.signal);
      observe(figure, records.get(figure)!, resource.kind, args, object, codec);
    }
    refs.set(resource.id, object);
    for (const update of resource.updates) {
      const call = (object as Record<string, unknown>)[update.method];
      if (typeof call !== 'function')
        throw typeError('Mutation is not supported by this layer; correct the recipe', 'sciviz');
      await call.apply(object, (await io.decode(update.args, refs)) as unknown[]);
    }
    const saved = (await io.decode(resource.state, refs)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(saved)) {
      if (key === 'custom') {
        await options.codecs?.[resource.kind]?.restore?.(object, value, options.signal);
        continue;
      }
      if (!properties.includes(key as (typeof properties)[number]) || !(key in object))
        throw typeError(`Unsupported saved ${resource.kind}.${key}; correct the layer state`, 'sciviz');
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object), key);
      if (!descriptor?.get || descriptor.set) (object as Record<string, unknown>)[key] = value;
    }
  }
  const wanted = spec.layers.map((id) => refs.get(id) as Layer);
  for (const layer of figure.layers) if (!wanted.includes(layer)) figure.remove(layer);
  if (wanted.some((layer, i) => figure.layers[i] !== layer))
    throw typeError('Resource order differs from layer order; save layers in creation order', 'sciviz');
  figure.setLimits(spec.limits as [number, number, number, number, number, number], { space: 'plot' });
  Object.assign(figure.engine.camera, spec.camera);
  figure.dragMode = spec.dragMode as Figure['dragMode'];
  if (spec.selection) figure.setSelection((await io.decode(spec.selection, refs)) as PointSelection, { emit: false });
  else figure.setSelection(undefined, { emit: false });
  if (spec.annotations !== undefined) figure.annotations = await io.decode(spec.annotations);
  state.selection = figure.selection;
  await figure.ready();
  io.check();
}

/** Optional figure factories. No renderer or package loads until create/attach/fromJSON is called. */
export const Figure = {
  /** Create an ordinary figure and record only this instance's portable operations. */
  async create(canvas: HTMLCanvasElement, options: CreateFigureOptions = {}): Promise<Figure> {
    return portable(await BaseFigure.create(canvas, options), options);
  },
  /** Record a figure attached to a caller-owned engine. */
  attach(engine: EngineKernel, options: FigureOptions = {}): Figure {
    return portable(BaseFigure.attach(engine, options), options);
  },
  /** Opt an existing, empty figure into recording. Supply the options used to create it. */
  record(figure: BaseFigure, options: FigureOptions = {}): Figure {
    if (figure.layers.length && !records.has(figure))
      throw typeError('Recording must begin before plotting; use the spec Figure factory', 'sciviz');
    return portable(figure, options);
  },
  /** Restore version 1 state onto a new canvas or caller-owned engine; failures dispose partial resources. */
  async fromJSON(spec: FigureSpec, canvas: HTMLCanvasElement, options: FigureLoadOptions = {}): Promise<Figure> {
    validateFigureSpec(spec);
    if (spec.sha256) {
      const { sha256, ...body } = spec;

      if ((await specHash(new TextEncoder().encode(JSON.stringify(body)))) !== sha256)
        throw fault('failed', 'Spec hash mismatch; restore the original JSON or create a new spec', 'sciviz');
    }
    const io = new ValueIO(options),
      opts = (await io.decode(spec.options)) as CreateFigureOptions;
    const figure = options.engine
      ? Figure.attach(options.engine, opts)
      : await Figure.create(canvas, { ...opts, signal: options.signal });
    try {
      await populate(figure, spec, options);
      if (spec.pipeline) {
        const { FilterPipeline } = await import('@margoengine/sciviz/pipeline');
        figure.pipelineState = spec.pipeline;
        if (options.registry) figure.pipeline = FilterPipeline.fromJSON(spec.pipeline, options.registry);
      }
      if (spec.time) {
        const frames = spec.time.frames;
        for (const frame of frames) validateFigureSpec(frame);
        const timeline = figure.timeline(
          spec.time.times,
          async (index) => {
            await populate(figure, frames[index], options);
          },
          spec.time.options ? ((await io.decode(spec.time.options)) as Parameters<Figure['timeline']>[2]) : {},
        );
        await timeline.seek(Math.max(0, spec.time.index));
      }
      return figure;
    } catch (error) {
      figure.dispose();
      throw error;
    }
  },
};
