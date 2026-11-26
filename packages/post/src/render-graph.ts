/// <reference lib="esnext.disposable" preserve="true" />
// RenderGraph: a data-driven, serializable pass graph run on core's frame graph. A JSON description lists textures and
// tasks; each task names a registered type and binds its typed input and output slots to texture names. Building
// validates the description (unknown types and slots, a missing input, a second writer, a slot type mismatch, a cycle),
// orders the tasks topologically and assigns the transient textures to as few physical textures as their lifetimes
// allow; executing runs the tasks in that order once a frame. `history` textures ping-pong: a task reads last frame's
// value as `name@previous`, which is no dependency, so a feedback loop through a history texture is not a cycle.
// Sources: Y. O'Donnell, "FrameGraph: Extensible Rendering Architecture in Frostbite", GDC 2017; T. Wihlidal,
// "Halcyon: Rapid Innovation using Modern Graphics", Reboot Develop 2019 (render graph, transient resource aliasing);
// A. B. Kahn, "Topological sorting of large networks", CACM 5(11), 1962, https://doi.org/10.1145/368996.369025;
// interval-graph colouring for lifetime aliasing as in M. Poletto and V. Sarkar, "Linear Scan Register Allocation",
// ACM TOPLAS 21(5), 1999, https://doi.org/10.1145/330249.330250.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { SceneTarget } from '../../shared/msaa.js';
import { fullscreen, group } from '../../shared/gpu.js';
import { displayFor, displayShader, linearShader, coreShaderRequired } from '../../shared/display.js';
import { fault, margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { captureFormat } from './capture.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** What a slot holds: linear HDR colour (`'hdr'`), display colour (`'ldr'`), either (`'color'`) or depth. */
export type RenderGraphSlotType = 'hdr' | 'ldr' | 'color' | 'depth';
/** A texture of the description. Without `size`, it is `scale` times the canvas. */
export interface RenderGraphTextureJSON {
  /** Default from the writing slot: `'rgba16float'` for HDR or any colour, `'rgba8unorm'` for display colour. */
  format?: GPUTextureFormat;
  /** Fraction of the canvas size in (0, 1]. Default 1. */
  scale?: number;
  /** Fixed [width, height] in texels instead of `scale`. */
  size?: readonly [number, number];
  /** Kept across frames and never shared with another texture. Default false. */
  persistent?: boolean;
  /** Two textures that swap each frame: `name` is written, `name@previous` reads last frame's (black at first).
   * Implies persistent. Default false. */
  history?: boolean;
}
/** A task of the description. `inputs` and `outputs` map the type's slot names to texture names; `'screen'` is the
 * canvas, an output only. */
export interface RenderGraphTaskJSON {
  name: string;
  type: string;
  inputs?: Readonly<Record<string, string>>;
  outputs?: Readonly<Record<string, string>>;
  /** JSON values passed to the type's `create`. */
  params?: Readonly<Record<string, unknown>>;
}
/** The serializable description: `new RenderGraph(json)`, `load(json)` and `toJSON()`. */
export interface RenderGraphJSON {
  version: 1;
  textures?: Readonly<Record<string, RenderGraphTextureJSON>>;
  tasks: readonly RenderGraphTaskJSON[];
}
/** A texture bound to a slot this frame. */
export interface RenderGraphTexture {
  view: GPUTextureView;
  format: GPUTextureFormat;
  width: number;
  height: number;
  /** The canvas output's sample count (1 elsewhere): pipelines writing `'screen'` use it. */
  multisample: GPUMultisampleState;
  /** True for the canvas. */
  screen: boolean;
}
/** What `execute` reads and writes. */
export interface RenderGraphIO {
  input(slot: string): RenderGraphTexture;
  output(slot: string): RenderGraphTexture;
  /** Makes `view` this frame's value of output `slot` (a task that keeps its own result texture); not for `'screen'`. */
  replace(slot: string, view: GPUTextureView): void;
  readonly engine: Engine;
  /** The scene capture, when a `'scene'` task runs: post effects read its depth from here. */
  readonly host: StackHost;
}
/** A task made by its type: its slots and what it does each frame. */
export interface RenderGraphTask {
  readonly inputs: Readonly<Record<string, RenderGraphSlotType>>;
  readonly outputs: Readonly<Record<string, RenderGraphSlotType>>;
  /** Canvas-sized slots only (post effects draw at the canvas size). Default false. */
  readonly canvasSized?: boolean;
  /** Runs once when the graph attaches it (or after a rebuild or device restore). */
  setup?(engine: Engine, host: StackHost): void;
  execute(context: Context, io: RenderGraphIO): void;
  dispose?(): void;
}
/** A registered task type: `create` makes a task from its JSON `params` without touching the GPU, and throws for bad
 * params. */
export interface RenderGraphTaskType {
  create(params: Readonly<Record<string, unknown>>): RenderGraphTask;
}
/** The error of a description the graph refuses: `code` names the problem. */
export type RenderGraphErrorCode =
  | 'invalid-graph'
  | 'unknown-task'
  | 'unknown-slot'
  | 'missing-input'
  | 'duplicate-writer'
  | 'type-mismatch'
  | 'size-mismatch'
  | 'cycle';
export type RenderGraphError = TypeError & { code: RenderGraphErrorCode };

const ANCHOR = 'render-graph';
const graphError = (code: RenderGraphErrorCode, message: string): RenderGraphError =>
  Object.assign(new TypeError(`RenderGraph ${message}; see https://margoengine.com/errors#${ANCHOR}`), { code });
const fail = (code: RenderGraphErrorCode, message: string): never => {
  throw graphError(code, message);
};
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hdrFormat = (format: string) => /float/.test(format);
const fits = (written: RenderGraphSlotType, read: RenderGraphSlotType) =>
  written === read || (written !== 'depth' && read !== 'depth' && (written === 'color' || read === 'color'));
const single = { count: 1 };
const copyShader = `${fullscreen}
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
@fragment fn fragment(v:Vertex)->@location(0) vec4f {return textureSampleLevel(source,bilinear,v.uv,0.0);}`;
const displayCopy = `${fullscreen}${displayShader}
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
 let c=textureSampleLevel(source,bilinear,v.uv,0.0);
 return vec4f(toDisplay(c.rgb),c.a);
}`;

/** Draws `source` over `target` with a linear sampler; `display` encodes linear HDR for the screen. */
class Copy implements RenderGraphTask {
  readonly inputs = { source: 'color' } as const;
  readonly outputs: Record<string, RenderGraphSlotType>;
  private engine?: Engine;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly groups = new WeakMap<GPURenderPipeline, WeakMap<GPUTextureView, GPUBindGroup>>();
  private sampler?: GPUSampler;
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  constructor(private readonly display: boolean) {
    this.outputs = { target: display ? 'ldr' : 'color' };
  }
  setup(engine: Engine): void {
    this.engine = engine;
    this.pipelines.clear();
    this.sampler = undefined;
  }
  execute(c: Context, io: RenderGraphIO): void {
    const source = io.input('source'),
      target = io.output('target'),
      encode = this.display && hdrFormat(source.format),
      key = `${encode}:${target.format}:${target.multisample.count ?? 1}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ code: encode ? displayFor(this.engine, displayCopy) : copyShader });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format }] },
        multisample: target.multisample,
      });
      this.pipelines.set(key, pipeline);
    }
    this.sampler ??= c.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    let byView = this.groups.get(pipeline);
    if (!byView) this.groups.set(pipeline, (byView = new WeakMap()));
    let bindings = byView.get(source.view);
    if (!bindings) byView.set(source.view, (bindings = group(c.device, pipeline, [source.view, this.sampler])));
    this.attachment.view = target.view;
    this.attachment.loadOp = target.screen ? viewLoadOp(c, 'clear') : 'clear';
    const pass = c.encoder.beginRenderPass(this.descriptor);
    try {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      if (target.screen) applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }
}

/** Clears `target` to `params.color` (linear RGBA, default opaque black). */
class Clear implements RenderGraphTask {
  readonly inputs = {};
  readonly outputs = { target: 'color' } as const;
  private readonly attachment: GPURenderPassColorAttachment;
  constructor(params: Readonly<Record<string, unknown>>) {
    const color = params.color ?? [0, 0, 0, 1];
    if (!Array.isArray(color) || color.length !== 4 || !color.every(Number.isFinite))
      fail('invalid-graph', 'clear color must be four finite numbers [r, g, b, a]');
    const [r, g, b, a] = color as number[];
    this.attachment = { view: undefined!, loadOp: 'clear', storeOp: 'store', clearValue: { r, g, b, a } };
  }
  execute(c: Context, io: RenderGraphIO): void {
    const target = io.output('target');
    this.attachment.view = target.view;
    this.attachment.loadOp = target.screen ? viewLoadOp(c, 'clear') : 'clear';
    c.encoder.beginRenderPass({ colorAttachments: [this.attachment] }).end();
  }
}

/** Marks the scene capture: the main pass draws into `color` (linear HDR unless `params.hdr` is false) and `depth`. */
class Scene implements RenderGraphTask {
  readonly inputs = {};
  readonly outputs: Record<string, RenderGraphSlotType>;
  constructor(readonly hdr: boolean) {
    this.outputs = { color: hdr ? 'hdr' : 'ldr', depth: 'depth' };
  }
  execute(): void {}
}

/** The built-in task types: `'clear'`, `'scene'`, `'copy'` and `'blit'` (to the screen, HDR display-encoded). */
export const renderGraphTasks: Readonly<Record<string, RenderGraphTaskType>> = Object.freeze({
  clear: { create: (params) => new Clear(params) },
  scene: {
    create(params) {
      if (params.hdr !== undefined && typeof params.hdr !== 'boolean')
        fail('invalid-graph', 'scene hdr must be a boolean');
      return new Scene(params.hdr !== false);
    },
  },
  copy: { create: () => new Copy(false) },
  blit: { create: () => new Copy(true) },
});

/** A post effect that joins a PostStack (Bloom, SSAO, KawaseBlur, Tonemap, FXAA, ...). */
type StackEffect = EnginePlugin & { joinStack?(host: StackHost): StackStage };
/**
 * A task type running a post effect class from this package: `params` are its options, input `source`, output
 * `target`. HDR effects read HDR and write HDR (or tonemap into a display or screen output); a display effect reads
 * HDR and writes display colour; LDR effects read and write display colour. One task per effect class and graph.
 */
export function effectTask(Effect: new (options?: never) => EnginePlugin): RenderGraphTaskType {
  return {
    create(params) {
      const effect = new Effect(params as never) as StackEffect;
      if (typeof effect.joinStack !== 'function')
        fail('unknown-task', `effect ${effect.name} does not run in a PostStack`);
      let stage: StackStage | undefined;
      const host: StackHost = {};
      stage = effect.joinStack!(host);
      const kind = stage.kind;
      return {
        inputs: { source: kind === 'ldr' ? 'ldr' : 'hdr' },
        outputs: { target: kind === 'hdr' ? 'color' : 'ldr' },
        canvasSized: true,
        setup(engine, graphHost) {
          Object.defineProperties(host, {
            target: { get: () => graphHost.target, configurable: true },
            depthTexture: { get: () => graphHost.depthTexture, configurable: true },
          });
          if (!engine.sceneOf(effect)) engine.use(effect);
        },
        execute(c, io) {
          const target = io.output('target'),
            output: StageOutput = {
              view: target.view,
              format: target.format,
              multisample: target.multisample,
              hdr: hdrFormat(target.format) && !target.screen,
            };
          const own = stage!.render(c, io.input('source').view, output);
          if (own && !target.screen) io.replace('target', own);
        },
        dispose() {
          stage = undefined;
          effect.dispose?.();
        },
      };
    },
  };
}

/** One texture of the plan: where it lives each frame. */
interface Resource {
  name: string;
  format?: GPUTextureFormat;
  type: RenderGraphSlotType;
  scale: number;
  size?: readonly [number, number];
  kind: 'transient' | 'persistent' | 'history' | 'scene-color' | 'scene-depth' | 'screen';
  /** Physical slot of a transient texture. */
  slot: number;
}
interface Step {
  name: string;
  task: RenderGraphTask;
  inputs: Record<string, { resource: Resource; previous: boolean }>;
  outputs: Record<string, Resource>;
}
interface Plan {
  steps: Step[];
  resources: Map<string, Resource>;
  /** Transient physical slots: format and size key per slot. */
  slots: { format?: GPUTextureFormat; scale: number; size?: readonly [number, number]; type: RenderGraphSlotType }[];
  scene?: Step;
}

/** Checks `json` and builds its plan: steps in dependency order and the transient textures' physical slots. */
function compile(json: RenderGraphJSON, types: Readonly<Record<string, RenderGraphTaskType>>): Plan {
  if (!isObject(json) || json.version !== 1 || !Array.isArray(json.tasks))
    fail('invalid-graph', 'description must be {version: 1, tasks: [...]}');
  const declared = json.textures ?? {};
  if (!isObject(declared)) fail('invalid-graph', 'textures must be an object of texture descriptions');
  for (const [name, t] of Object.entries(declared)) {
    if (!isObject(t) || name === 'screen' || name.includes('@'))
      fail('invalid-graph', `texture ${name} must be an object, and not be named screen or contain @`);
    if (t.format !== undefined && typeof t.format !== 'string')
      fail('invalid-graph', `texture ${name} format must be a string`);
    if (t.scale !== undefined && !(typeof t.scale === 'number' && t.scale > 0 && t.scale <= 1))
      fail('invalid-graph', `texture ${name} scale must be in (0, 1]`);
    if (
      t.size !== undefined &&
      !(Array.isArray(t.size) && t.size.length === 2 && t.size.every((v) => Number.isInteger(v) && v >= 1))
    )
      fail('invalid-graph', `texture ${name} size must be [width, height] in whole texels`);
    for (const key of ['persistent', 'history'] as const)
      if (t[key] !== undefined && typeof t[key] !== 'boolean')
        fail('invalid-graph', `texture ${name} ${key} must be a boolean`);
  }
  const tasks: { json: RenderGraphTaskJSON; task: RenderGraphTask }[] = [],
    names = new Set<string>();
  try {
    for (const t of json.tasks) {
      if (!isObject(t) || typeof t.name !== 'string' || !t.name || names.has(t.name) || typeof t.type !== 'string')
        fail('invalid-graph', 'every task needs a unique non-empty name and a type');
      names.add(t.name);
      for (const key of ['inputs', 'outputs', 'params'] as const)
        if (t[key] !== undefined && !isObject(t[key])) fail('invalid-graph', `task ${t.name} ${key} must be an object`);
      const type = Object.hasOwn(types, t.type) ? types[t.type] : undefined;
      if (!type) fail('unknown-task', `task ${t.name} has the unknown type ${t.type}; register it in tasks`);
      tasks.push({ json: t, task: type!.create(t.params ?? {}) });
    }
    return plan(tasks, declared);
  } catch (error) {
    for (const { task } of tasks) task.dispose?.();
    throw error;
  }
}

function plan(
  tasks: { json: RenderGraphTaskJSON; task: RenderGraphTask }[],
  declared: Readonly<Record<string, RenderGraphTextureJSON>>,
): Plan {
  const resources = new Map<string, Resource>(),
    writers = new Map<string, number>();
  let scene: number | undefined;
  // Outputs first: every texture has exactly one writer, and its type comes from the writing slot.
  tasks.forEach(({ json, task }, i) => {
    for (const slot of Object.keys(task.outputs))
      if (!json.outputs?.[slot]) fail('missing-input', `task ${json.name} output ${slot} is not bound to a texture`);
    if (task instanceof Scene) {
      if (scene !== undefined) fail('duplicate-writer', 'a graph has at most one scene task');
      scene = i;
    }
    for (const [slot, name] of Object.entries(json.outputs ?? {})) {
      const type = task.outputs[slot];
      if (!type) fail('unknown-slot', `task ${json.name} (${json.type}) has no output ${slot}`);
      if (typeof name !== 'string' || !name || name.includes('@'))
        fail('invalid-graph', `task ${json.name} output ${slot} must name a texture (no @)`);
      if (writers.has(name)) fail('duplicate-writer', `texture ${name} is written by two tasks`);
      writers.set(name, i);
      const d = declared[name] ?? {};
      if (name === 'screen' && (type === 'depth' || type === 'hdr'))
        fail('type-mismatch', `task ${json.name} output ${slot} (${type}) cannot write the screen`);
      if (task instanceof Scene && declared[name])
        fail('invalid-graph', `texture ${name} is the scene's own capture; do not declare it`);
      resources.set(name, {
        name,
        type,
        format: d.format,
        scale: d.scale ?? 1,
        size: d.size,
        kind:
          name === 'screen'
            ? 'screen'
            : task instanceof Scene
              ? type === 'depth'
                ? 'scene-depth'
                : 'scene-color'
              : d.history
                ? 'history'
                : d.persistent
                  ? 'persistent'
                  : 'transient',
        slot: -1,
      });
    }
  });
  for (const name of Object.keys(declared))
    if (!writers.has(name)) fail('missing-input', `texture ${name} is declared but no task writes it`);
  if (scene !== undefined && !writers.has('screen'))
    fail('missing-input', 'a graph with a scene task must write the screen');
  // Inputs: bound, written by some task (or last frame's history), of a fitting type.
  const edges = tasks.map(() => new Set<number>()),
    steps: Step[] = tasks.map(({ json, task }) => ({ name: json.name, task, inputs: {}, outputs: {} }));
  tasks.forEach(({ json, task }, i) => {
    for (const slot of Object.keys(task.inputs))
      if (!json.inputs?.[slot]) fail('missing-input', `task ${json.name} input ${slot} is not bound to a texture`);
    for (const [slot, ref] of Object.entries(json.inputs ?? {})) {
      const type = task.inputs[slot];
      if (!type) fail('unknown-slot', `task ${json.name} (${json.type}) has no input ${slot}`);
      if (typeof ref !== 'string') fail('invalid-graph', `task ${json.name} input ${slot} must name a texture`);
      const previous = ref.endsWith('@previous'),
        name = previous ? ref.slice(0, -9) : ref,
        resource = resources.get(name);
      if (!resource || name === 'screen')
        fail('missing-input', `task ${json.name} input ${slot} reads ${ref}, which no task writes`);
      if (previous && resource!.kind !== 'history')
        fail('missing-input', `task ${json.name} reads ${ref}, but ${name} is not a history texture`);
      if (!fits(resource!.type, type))
        fail('type-mismatch', `task ${json.name} input ${slot} takes ${type}, but ${name} holds ${resource!.type}`);
      steps[i].inputs[slot] = { resource: resource!, previous };
      if (!previous) edges[writers.get(name)!].add(i);
    }
    for (const [slot, name] of Object.entries(json.outputs ?? {})) steps[i].outputs[slot] = resources.get(name)!;
    if (task.canvasSized)
      for (const r of [...Object.values(steps[i].outputs), ...Object.values(steps[i].inputs).map((x) => x.resource)])
        if (r.size || r.scale !== 1)
          fail('size-mismatch', `task ${json.name} draws at the canvas size; texture ${r.name} must be canvas-sized`);
  });
  // Kahn's topological order, ties in description order.
  const indegree = steps.map(() => 0);
  for (const set of edges) for (const j of set) indegree[j]++;
  const order: number[] = [],
    ready = indegree.flatMap((d, i) => (d ? [] : [i]));
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const i = ready.shift()!;
    order.push(i);
    for (const j of edges[i]) if (!--indegree[j]) ready.push(j);
  }
  if (order.length !== steps.length)
    fail(
      'cycle',
      `tasks form a cycle: ${steps
        .filter((_, i) => indegree[i] > 0)
        .map((s) => s.name)
        .join(', ')}`,
    );
  const ordered = order.map((i) => steps[i]);
  // Lifetimes: a transient texture lives from its writer to its last reader; a slot freed after a task is taken by a
  // later texture of the same format and size (the formats are resolved from the slot types where undeclared).
  const last = new Map<Resource, number>();
  ordered.forEach((step, at) => {
    for (const r of Object.values(step.outputs)) if (!last.has(r)) last.set(r, at);
    for (const { resource } of Object.values(step.inputs)) last.set(resource, at);
  });
  const slots: Plan['slots'] = [],
    free: number[] = [],
    key = (r: { format?: string; scale: number; size?: readonly number[]; type: string }) =>
      `${r.format ?? defaultFormat(r.type as RenderGraphSlotType)}:${r.size ? r.size.join('x') : r.scale}`;
  ordered.forEach((step, at) => {
    for (const r of Object.values(step.outputs)) {
      if (r.kind !== 'transient') continue;
      const k = key(r),
        reuse = free.findIndex((s) => key(slots[s]) === k);
      r.slot =
        reuse >= 0
          ? free.splice(reuse, 1)[0]
          : slots.push({ format: r.format, scale: r.scale, size: r.size, type: r.type }) - 1;
    }
    for (const [r, end] of last) if (end === at && r.kind === 'transient' && r.slot >= 0) free.push(r.slot);
  });
  return { steps: ordered, resources, slots, scene: scene === undefined ? undefined : steps[scene] };
}
const defaultFormat = (type: RenderGraphSlotType): GPUTextureFormat => (type === 'ldr' ? 'rgba8unorm' : 'rgba16float');

let graphs = 0;
/**
 * A data-driven render graph on core's frame graph: build it from a JSON description, then it runs once a frame.
 * `load(json)` rebuilds (a task, a texture or the whole graph), `toJSON()` returns the description, and a resize
 * re-creates the textures. With a `'scene'` task the main pass draws into the graph's capture, as a PostStack does,
 * and the graph must write `'screen'`; without one, its tasks run after the main pass. Not with a PostStack in the
 * same scene.
 * @throws a {@link RenderGraphError} (TypeError with `code`) for a description it refuses; MargoError
 * `'unsupported'` without WebGPU or the WebGL2 layer, `'attached'` next to a PostStack, `'disposed'` after
 * `dispose()`.
 */
export class RenderGraph implements EnginePlugin {
  readonly name = `post:render-graph:${++graphs}`;
  private engine?: Engine;
  private disposed = false;
  private json: RenderGraphJSON;
  private current: Plan;
  private readonly types: Readonly<Record<string, RenderGraphTaskType>>;
  private readonly host: StackHost = {};
  private color?: GPUTexture;
  private shaderSource?: string;
  private linear = '';
  private textures: (GPUTexture | undefined)[] = [];
  private kept = new Map<Resource, GPUTexture[]>();
  private frameViews = new Map<Resource, RenderGraphTexture>();
  private readonly wrapped = new WeakMap<GPUTexture, RenderGraphTexture>();
  private step?: Step;
  private context?: Context;
  private readonly io: RenderGraphIO = ((graph) => ({
    get engine() {
      return graph.engine!;
    },
    get host() {
      return graph.host;
    },
    input(slot: string) {
      const step = graph.step!,
        bound = step.inputs[slot];
      if (!bound) return fail('unknown-slot', `task ${step.name} has no input ${slot}`);
      return bound.previous
        ? graph.texture(graph.context!, bound.resource, true)
        : graph.frameViews.get(bound.resource)!;
    },
    output(slot: string) {
      const step = graph.step!,
        r = step.outputs[slot];
      if (!r) return fail('unknown-slot', `task ${step.name} has no output ${slot}`);
      return graph.frameViews.get(r)!;
    },
    replace(slot: string, view: GPUTextureView) {
      const r = graph.step!.outputs[slot];
      if (r && r.kind !== 'screen') graph.frameViews.set(r, { ...graph.frameViews.get(r)!, view });
    },
  }))(this);
  private screen?: RenderGraphTexture;
  private captured = false;
  private swap = false;
  private flip = 0;
  /** Physical textures the plan uses at the current size: transient slots plus persistent and history textures. */
  get textureCount(): number {
    return (
      this.current.slots.length +
      [...this.current.resources.values()].reduce(
        (n, r) => n + (r.kind === 'history' ? 2 : r.kind === 'persistent' ? 1 : 0),
        0,
      )
    );
  }
  /** Task names in execution order. */
  get order(): readonly string[] {
    return this.current.steps.map((s) => s.name);
  }

  constructor(json: RenderGraphJSON, { tasks = {} }: { tasks?: Readonly<Record<string, RenderGraphTaskType>> } = {}) {
    this.types = { ...renderGraphTasks, ...tasks };
    this.current = compile(json, this.types);
    this.json = structuredClone(json);
  }
  /** Same as `engine.use(new RenderGraph(json, options))`; returns it. */
  static attach(
    engine: EngineKernel,
    json: RenderGraphJSON,
    options?: { tasks?: Readonly<Record<string, RenderGraphTaskType>> },
  ): RenderGraph {
    const graph = new RenderGraph(json, options);
    engine.use(graph);
    return graph;
  }
  /** Checks `json` against the built-in and given task types without building a graph; throws as `load` does. */
  static validate(
    json: RenderGraphJSON,
    { tasks = {} }: { tasks?: Readonly<Record<string, RenderGraphTaskType>> } = {},
  ): void {
    for (const step of compile(json, { ...renderGraphTasks, ...tasks }).steps) step.task.dispose?.();
  }
  /** The description in effect, a copy safe to change and `load` again. */
  toJSON(): RenderGraphJSON {
    return structuredClone(this.json);
  }
  /** Replaces the description; the old graph keeps running when `json` is refused. Outside a frame. */
  load(json: RenderGraphJSON): void {
    if (this.disposed) throw fault('disposed', 'RenderGraph is disposed; create a new one', 'disposed');
    const next = compile(json, this.types),
      old = this.current;
    this.current = next;
    this.json = structuredClone(json);
    for (const step of old.steps) step.task.dispose?.();
    this.releaseTextures();
    if (this.engine) this.setupTasks();
  }

  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'RenderGraph is disposed; create a new one', 'disposed');
    if (!engine.gpu) throw fault('unsupported', 'RenderGraph needs WebGPU or the WebGL2 layer', 'webgpu');
    if (engine.hasPlugin('post:stack'))
      throw margoError('attached', 'RenderGraph replaces the PostStack; run post effects as graph tasks (effectTask)');
    this.engine = engine;
    this.setupTasks();
  }
  private setupTasks(): void {
    for (const step of this.current.steps) step.task.setup?.(this.engine!, this.host);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name + ':capture', order: -65, execute: (c) => c.backend === 'webgpu' && this.capture(c) });
    graph.add({ name: this.name, order: 30, execute: (c) => c.backend === 'webgpu' && this.run(c) });
  }
  /** History textures swap once a frame, whatever the number of views. */
  onPreUpdate(): void {
    this.swap = true;
  }
  /** Textures are made again at the next frame; tasks set up again (effect tasks restore as plugins). */
  onDeviceRestored(engine: Engine): void {
    this.releaseTextures();
    this.engine = engine;
    this.setupTasks();
  }
  /** Disposes the tasks and textures and removes the graph. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    for (const step of this.current.steps) step.task.dispose?.();
    this.releaseTextures();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private capture(c: Context): void {
    this.captured = false;
    const scene = this.current.scene;
    this.screen = {
      view: c.color,
      format: c.format,
      width: c.width,
      height: c.height,
      multisample: c.descriptor.multisample ?? single,
      screen: true,
    };
    if (!scene) return;
    const hdr = (scene.task as Scene).hdr;
    if (hdr && this.shaderSource !== c.shader) {
      const linear = linearShader(c.shader);
      if (linear === c.shader) throw margoError('unsupported', coreShaderRequired('RenderGraph'));
      this.shaderSource = c.shader;
      this.linear = linear;
    }
    const samples = c.descriptor.multisample?.count ?? 4,
      depth = c.descriptor.depthStencil!.format,
      format = hdr ? captureFormat(c.device, samples) : c.format,
      h = this.host;
    if (
      this.color?.width !== c.width ||
      this.color.height !== c.height ||
      this.color.format !== format ||
      h.depthTexture!.format !== depth ||
      h.target!.samples !== samples
    ) {
      this.releaseCapture();
      // RENDER_ATTACHMENT | TEXTURE_BINDING (| COPY_SRC for colour)
      this.color = c.device.createTexture({ size: [c.width, c.height], format, usage: 0x10 | 0x4 | 0x1 });
      h.depthTexture = c.device.createTexture({ size: [c.width, c.height], format: depth, usage: 0x10 | 0x4 });
      h.target = new SceneTarget(c.device, this.color, h.depthTexture, samples);
    }
    h.target!.begin(c);
    if (hdr) c.shader = this.linear;
    this.captured = true;
  }

  private run(c: Context): void {
    const plan = this.current,
      screen = this.screen ?? {
        view: c.color,
        format: c.format,
        width: c.width,
        height: c.height,
        multisample: c.descriptor.multisample ?? single,
        screen: true,
      };
    this.screen = undefined;
    if (plan.scene && !this.captured) return;
    if (this.swap) {
      this.flip ^= 1;
      this.swap = false;
    }
    try {
      if (this.captured) this.host.target!.resolve(c.encoder, true);
      const views = this.frameViews;
      views.clear();
      for (const r of plan.resources.values()) views.set(r, r.kind === 'screen' ? screen : this.texture(c, r, false));
      this.context = c;
      for (const step of plan.steps) {
        this.step = step;
        step.task.execute(c, this.io);
      }
    } finally {
      this.step = this.context = undefined;
      if (this.captured) this.host.target!.restore(c);
      this.captured = false;
    }
  }

  /** The texture of `r` this frame (`previous`: last frame's half of a history pair), made at the current size. */
  private texture(c: Context, r: Resource, previous: boolean): RenderGraphTexture {
    if (r.kind === 'scene-color' || r.kind === 'scene-depth') {
      const t = r.kind === 'scene-color' ? this.color! : this.host.depthTexture!;
      return this.wrap(t);
    }
    const width = r.size?.[0] ?? Math.max(1, Math.round(c.width * r.scale)),
      height = r.size?.[1] ?? Math.max(1, Math.round(c.height * r.scale)),
      format = r.format ?? defaultFormat(r.type),
      make = () => c.device.createTexture({ size: [width, height], format, usage: 0x10 | 0x4 | 0x1 | 0x2 }),
      fitsSize = (t?: GPUTexture) => t?.width === width && t.height === height && t.format === format;
    if (r.kind === 'transient') {
      if (!fitsSize(this.textures[r.slot])) {
        this.textures[r.slot]?.destroy();
        this.textures[r.slot] = make();
      }
      return this.wrap(this.textures[r.slot]!);
    }
    let pair = this.kept.get(r);
    if (!pair || !fitsSize(pair[0])) {
      for (const t of pair ?? []) t.destroy();
      pair = r.kind === 'history' ? [make(), make()] : [make()];
      this.kept.set(r, pair);
    }
    return this.wrap(r.kind === 'history' ? pair[this.flip ^ +previous] : pair[0]);
  }
  private wrap(t: GPUTexture): RenderGraphTexture {
    let w = this.wrapped.get(t);
    if (!w)
      this.wrapped.set(
        t,
        (w = {
          view: t.createView(),
          format: t.format,
          width: t.width,
          height: t.height,
          multisample: single,
          screen: false,
        }),
      );
    return w;
  }
  private releaseCapture(): void {
    this.host.target?.dispose();
    this.color?.destroy();
    this.host.depthTexture?.destroy();
    this.host.target = this.host.depthTexture = this.color = undefined;
  }
  private releaseTextures(): void {
    this.releaseCapture();
    for (const t of this.textures) t?.destroy();
    for (const pair of this.kept.values()) for (const t of pair) t.destroy();
    this.textures = [];
    this.kept.clear();
    this.frameViews.clear();
  }
}
