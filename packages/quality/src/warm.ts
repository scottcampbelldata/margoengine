import type { EngineKernel } from '@margoengine/core';
import { HOLDS_LINKS } from '../../shared/queue-hold.js';

/** What {@link warmUp} did. */
export interface WarmUpReport {
  /**
   * Render and compute pipelines created with the async API ahead of their first visible frame; on the WebGL2 layer's
   * frame route (see {@link warmUp}), the distinct pipelines the warm frames made, whose links the layer held them for.
   */
  pipelines: number;
  /** Pipelines that had to be created synchronously after all (the retried call did not match its warmed descriptor). */
  fallbacks: number;
  /** Warm render calls, including the stopped ones that discovered a pipeline (on the frame route every one is whole). */
  rounds: number;
  /** A feature failed after a stopped warm frame, so the device was restored (`engine.rebootDevice()`) and the
   * remaining warm frames created their pipelines synchronously. */
  rebooted: boolean;
}

/** Options for {@link warmUp}. */
export interface WarmUpOptions {
  /** Complete warm frames to render once no new pipeline is found; the second catches history-dependent variants. Default 2. */
  frames?: number;
  /** Safety cap on warm render calls. Default 256. */
  maxRounds?: number;
  /** Stops the warm-up: the promise rejects with `signal.reason` and the device is left unpatched. */
  signal?: AbortSignal;
}

type Kind = 'createRenderPipeline' | 'createComputePipeline';
type Method = Kind | 'createShaderModule' | 'createCommandEncoder' | 'createBindGroupLayout' | 'createPipelineLayout';
type Call = (this: GPUDevice, descriptor?: object) => object;
type Pass = GPURenderPassEncoder | GPUComputePassEncoder;
const methods: Method[] = [
  'createRenderPipeline',
  'createComputePipeline',
  'createShaderModule',
  'createCommandEncoder',
  'createBindGroupLayout',
  'createPipelineLayout',
];
/** Thrown inside a warm frame to stop it at a pipeline that is still compiling; never escapes warmUp. */
class Compiling extends Error {}
/** Replace `object[name]` with an own property; returns the undo. */
function override<T extends object>(object: T, name: string, value: unknown): () => void {
  const own = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { configurable: true, writable: true, value });
  return () => {
    if (own) Object.defineProperty(object, name, own);
    else delete (object as Record<string, unknown>)[name];
  };
}

/**
 * Create the GPU pipelines of every attached feature with the async WebGPU API, so their first visible frame does not
 * stall on shader compilation. Call during loading, after attaching features and adding the scene and before
 * `engine.start()`. Features create pipelines lazily inside their passes, so warmUp renders warm frames (delta 0) into
 * an offscreen target (nothing is presented): when a frame reaches a pipeline that does not exist yet, the frame is
 * stopped there (an exception out of the synchronous create call), the work it already encoded is submitted (one-time
 * work such as lookup tables and static shadow casters stays done), the pipeline compiles with
 * `createRenderPipelineAsync` / `createComputePipelineAsync`, and the frame is rendered again until one completes; the
 * retried call is answered with the finished pipeline. Frames rendered meanwhile by the engine's own loop are
 * untouched. It resolves once the GPU has finished the warm frames, so pipelines a feature created synchronously at
 * attach have compiled by then too. Without WebGPU it resolves at once. A feature that stores state before creating its pipeline (so the
 * retry skips the creation) fails on the retry; then every feature is reset through device restoration and the warm
 * frames finish with synchronous creation (`report.rebooted`).
 * On the WebGL2 compatibility layer with KHR_parallel_shader_compile (its queue carries the link hold,
 * `Symbol.for('margoengine.queue.holdsLinks')`) no frame is stopped: each warm frame runs whole with the hold on, so the
 * layer keeps that frame's submits, and the writes after them in order, in its queue until every program the frame made
 * has linked and drawn once, and all of a frame's links run side by side on the driver's threads instead of one per
 * round (KB-QUALITY-WARMSERIAL1). It ends after `frames` frames in a row that made no new pipeline.
 * The layer then replays a held frame in tasks of about 50 ms, each after the GPU has run the one before, so the page
 * stays responsive while it plays back.
 * Limit: call it before `engine.start()`. On the layer's frame route the frames a running loop renders meanwhile wait
 * in the queue behind the held frame (their tapes and write copies kept) and replay after it.
 * ponytail: a feature that is off (`enabled = false`) or attached later is not warmed; call warmUp again after
 * attaching it.
 */
export async function warmUp(
  engine: EngineKernel,
  { frames = 2, maxRounds = 256, signal }: WarmUpOptions = {},
): Promise<WarmUpReport> {
  signal?.throwIfAborted();
  const report: WarmUpReport = { pipelines: 0, fallbacks: 0, rounds: 0, rebooted: false };
  const gpu = (): GPUDevice | null | undefined => (engine as unknown as { gpu?: GPUDevice | null }).gpu;
  const device = gpu() as (GPUDevice & Record<Method, Call>) | null | undefined;
  const context = engine.canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!device || !context || engine.backend !== 'webgpu') return report;
  const hold = (device.queue as unknown as Partial<Record<symbol, (on: boolean) => void>>)[HOLDS_LINKS];
  const original = Object.fromEntries(methods.map((name) => [name, device[name]])) as Record<Method, Call>;
  // Shader modules are often recreated on every call, so descriptors are keyed by their code; other GPU objects by identity.
  const sources = new Map<string, number>(),
    code = new WeakMap<object, number>(),
    // Layouts by what they hold: two layouts made from the same descriptor are group-equivalent (WebGPU), so a feature
    // that makes its layout again on every call (terrain's surface height) still matches its warmed pipeline.
    layouts = new WeakMap<object, string>(),
    ids = new WeakMap<object, number>(),
    ready = new Map<string, object>();
  // This round's command encoders, each with its open pass (if any), in creation order.
  const encoders: Array<{ encoder: GPUCommandEncoder; pass?: Pass; finished?: boolean }> = [];
  // The frame route (hold): the loose keys of the pipelines warm frames made, and whether this round made a new one.
  const seen = new Set<string>();
  let made = false;
  let warming = false,
    lastMiss = '',
    next = 0,
    pending: Promise<unknown> | undefined,
    target: GPUTexture | undefined;
  const key = (kind: Kind, descriptor: object, loose: boolean): string =>
    kind +
    JSON.stringify(descriptor, (_, value: unknown) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) === Object.prototype
      )
        return value;
      const source = code.get(value);
      if (source !== undefined) return 'module' + source;
      const layout = layouts.get(value);
      if (layout !== undefined) return 'layout' + layout;
      if (loose) return 'object';
      if (!ids.has(value)) ids.set(value, next++);
      return 'object:' + ids.get(value);
    });
  const create = (kind: Kind): Call =>
    function (descriptor) {
      if (!warming) return original[kind].call(this, descriptor);
      if (hold) {
        const loose = key(kind, descriptor!, true);
        if (!seen.has(loose)) {
          seen.add(loose);
          report.pipelines++;
          made = true;
        }
        return original[kind].call(this, descriptor);
      }
      const strict = key(kind, descriptor!, false),
        done = ready.get(strict);
      if (done) return done;
      const loose = key(kind, descriptor!, true);
      // The retried call of the previous round, with an identity that changed (a recreated layout): create it here.
      if (loose === lastMiss) {
        lastMiss = '';
        report.fallbacks++;
        return original[kind].call(this, descriptor);
      }
      lastMiss = loose;
      report.pipelines++;
      const async = (this as unknown as Record<string, (descriptor: object) => Promise<object>>)[kind + 'Async'];
      pending = async.call(this, descriptor!).then(
        (pipeline) => {
          ready.set(strict, pipeline);
        },
        () => {},
      );
      throw new Compiling(kind);
    };
  const undo = [
    override(device, 'createRenderPipeline', create('createRenderPipeline')),
    override(device, 'createComputePipeline', create('createComputePipeline')),
    override(device, 'createShaderModule', function (this: GPUDevice, descriptor: GPUShaderModuleDescriptor) {
      const module = original.createShaderModule.call(this, descriptor);
      if (!sources.has(descriptor.code)) sources.set(descriptor.code, sources.size);
      code.set(module, sources.get(descriptor.code)!);
      return module;
    }),
    override(device, 'createBindGroupLayout', function (this: GPUDevice, descriptor: GPUBindGroupLayoutDescriptor) {
      const layout = original.createBindGroupLayout.call(this, descriptor);
      layouts.set(layout, key('createRenderPipeline', { entries: descriptor.entries }, false));
      return layout;
    }),
    override(device, 'createPipelineLayout', function (this: GPUDevice, descriptor: GPUPipelineLayoutDescriptor) {
      const layout = original.createPipelineLayout.call(this, descriptor);
      layouts.set(layout, key('createRenderPipeline', { groups: descriptor.bindGroupLayouts }, false));
      return layout;
    }),
    override(device, 'createCommandEncoder', function (this: GPUDevice, descriptor?: GPUCommandEncoderDescriptor) {
      const encoder = original.createCommandEncoder.call(this, descriptor) as GPUCommandEncoder;
      if (!warming || hold) return encoder;
      const record: (typeof encoders)[number] = { encoder };
      encoders.push(record);
      for (const name of ['beginRenderPass', 'beginComputePass'] as const) {
        const begin = encoder[name] as (descriptor?: object) => Pass;
        override(encoder, name, (descriptor?: object) => {
          const pass = (record.pass = begin.call(encoder, descriptor)),
            end = pass.end;
          override(pass, 'end', () => {
            record.pass = undefined;
            end.call(pass);
          });
          return pass;
        });
      }
      const finish = encoder.finish;
      override(encoder, 'finish', (descriptor?: GPUCommandBufferDescriptor) => {
        record.finished = true;
        return finish.call(encoder, descriptor);
      });
      return encoder;
    }),
    // Warm frames draw into an offscreen texture shaped like the canvas texture, so no warm frame is presented.
    override(context, 'getCurrentTexture', function (this: GPUCanvasContext) {
      if (!warming) return GPUCanvasContext.prototype.getCurrentTexture.call(this);
      const { width, height } = engine.canvas,
        { format, usage = 0x10 } = context.getConfiguration()!;
      if (target?.width !== width || target.height !== height || target.format !== format) {
        target?.destroy();
        target = device.createTexture({ size: [width, height], format, usage: usage | 0x10 });
      }
      return target;
    }),
  ];
  const unpatch = (): void => {
    for (const step of undo.splice(0)) step();
  };
  try {
    // The layer's frame route: whole frames, each held in the layer's queue until its programs can draw.
    for (let complete = 0; hold && complete < frames && report.rounds < maxRounds && !engine.disposed; ) {
      signal?.throwIfAborted();
      report.rounds++;
      made = false;
      warming = gpu() === device;
      hold(true);
      try {
        engine.render({ delta: 0 });
      } finally {
        warming = false;
        hold(false);
      }
      await device.queue.onSubmittedWorkDone();
      complete = made ? 0 : complete + 1;
    }
    for (let complete = 0; !hold && complete < frames && report.rounds < maxRounds && !engine.disposed; ) {
      signal?.throwIfAborted();
      report.rounds++;
      pending = undefined;
      encoders.length = 0;
      warming = gpu() === device;
      try {
        engine.render({ delta: 0 });
        complete++;
      } catch (error) {
        if (error instanceof Compiling) {
          // Submit what the stopped frame encoded, in creation order, so work a feature marked done is really done.
          // A pass cut short may be invalid; its error is kept out of the engine's uncaptured-error handler.
          device.pushErrorScope('validation');
          const buffers = encoders
            .filter((e) => !e.finished)
            .map((e) => {
              e.pass?.end();
              return e.encoder.finish();
            });
          if (buffers.length) device.queue.submit(buffers);
          void device.popErrorScope();
          continue;
        }
        // A stopped frame left some feature half-initialised: restore every feature's GPU state on a fresh device and
        // finish without stopping frames. A failure without any stopped frame is the scene's own and is rethrown.
        if (!report.pipelines || report.rebooted) throw error;
        report.rebooted = true;
        warming = false;
        unpatch();
        await engine.rebootDevice();
      } finally {
        warming = false;
        if (pending) await pending;
      }
    }
    // Pipelines a feature created synchronously (at attach, before warmUp) compile on the GPU queue: wait them out here.
    if (!engine.disposed) await gpu()?.queue.onSubmittedWorkDone();
    signal?.throwIfAborted();
  } finally {
    unpatch();
    target?.destroy();
  }
  return report;
}
