import type { EngineKernel } from '@margoengine/core';

/** What {@link warmUp} did. */
export interface WarmUpReport {
  /** Render and compute pipelines created with the async API ahead of their first visible frame. */
  pipelines: number;
  /** Pipelines that had to be created synchronously after all (the retried call did not match its warmed descriptor). */
  fallbacks: number;
  /** Warm render calls, including the stopped ones that discovered a pipeline. */
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
}

type Kind = 'createRenderPipeline' | 'createComputePipeline';
type Method = Kind | 'createShaderModule' | 'createCommandEncoder';
type Call = (this: GPUDevice, descriptor?: object) => object;
type Pass = GPURenderPassEncoder | GPUComputePassEncoder;
const methods: Method[] = [
  'createRenderPipeline',
  'createComputePipeline',
  'createShaderModule',
  'createCommandEncoder',
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
 * ponytail: a feature that is off (`enabled = false`) or attached later is not warmed; call warmUp again after
 * attaching it.
 */
export async function warmUp(
  engine: EngineKernel,
  { frames = 2, maxRounds = 256 }: WarmUpOptions = {},
): Promise<WarmUpReport> {
  const report: WarmUpReport = { pipelines: 0, fallbacks: 0, rounds: 0, rebooted: false };
  const gpu = (): GPUDevice | null | undefined => (engine as unknown as { gpu?: GPUDevice | null }).gpu;
  const device = gpu() as (GPUDevice & Record<Method, Call>) | null | undefined;
  const context = engine.canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!device || !context || engine.backend !== 'webgpu') return report;
  const original = Object.fromEntries(methods.map((name) => [name, device[name]])) as Record<Method, Call>;
  // Shader modules are often recreated on every call, so descriptors are keyed by their code; other GPU objects by identity.
  const sources = new Map<string, number>(),
    code = new WeakMap<object, number>(),
    ids = new WeakMap<object, number>(),
    ready = new Map<string, object>();
  // This round's command encoders, each with its open pass (if any), in creation order.
  const encoders: Array<{ encoder: GPUCommandEncoder; pass?: Pass; finished?: boolean }> = [];
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
      if (loose) return 'object';
      if (!ids.has(value)) ids.set(value, next++);
      return 'object:' + ids.get(value);
    });
  const create = (kind: Kind): Call =>
    function (descriptor) {
      if (!warming) return original[kind].call(this, descriptor);
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
    override(device, 'createCommandEncoder', function (this: GPUDevice, descriptor?: GPUCommandEncoderDescriptor) {
      const encoder = original.createCommandEncoder.call(this, descriptor) as GPUCommandEncoder;
      if (!warming) return encoder;
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
    for (let complete = 0; complete < frames && report.rounds < maxRounds && !engine.disposed; ) {
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
  } finally {
    unpatch();
    target?.destroy();
  }
  return report;
}
