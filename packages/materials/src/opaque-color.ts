import { PBRModel } from '@margoengine/gltf-pro';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { SceneTarget, sceneTarget } from '../../shared/msaa.js';
import { fullscreen } from '../../shared/gpu.js';
import { Cleanup } from '../../shared/cleanup.js';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type Update = (view: GPUTextureView) => void;

const copyShader =
  fullscreen +
  `@group(0) @binding(0) var source:texture_2d<f32>;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{return textureLoad(source,vec2i(p.xy),0);}`;
const captures = new WeakMap<Engine, OpaqueColor>();

interface Capture {
  width: number;
  height: number;
  format: GPUTextureFormat;
  samples: number;
  depthFormat: GPUTextureFormat;
  textures: GPUTexture[];
  snapshot: GPUTexture;
  view: GPUTextureView;
  source: GPUTexture;
  target?: SceneTarget;
  borrowed?: SceneTarget;
  sourceView: GPUTextureView;
  copy: GPURenderPipeline;
  group: GPUBindGroup;
  present?: GPURenderPipeline;
  presentation?: GPUBindGroup;
}

/** A shared scene snapshot. Only positive transmission installations acquire it. */
class OpaqueColor implements EnginePlugin {
  readonly name = 'materials:opaque-color';
  readonly updates = new Set<Update>();
  private device?: GPUDevice;
  private placeholder?: GPUTexture;
  private placeholderView?: GPUTextureView;
  private capture?: Capture;
  private frame?: {
    context: Context;
    capture: Capture;
    original: GPUTextureView;
    depth: GPUTextureView;
    format: GPUTextureFormat;
    descriptor: GPURenderPipelineDescriptor;
  };
  private disposed = false;
  constructor(private readonly engine: Engine) {}
  get view(): GPUTextureView {
    return this.capture?.view ?? this.placeholderView!;
  }
  texture(): GPUTexture | undefined {
    return this.capture?.snapshot ?? this.placeholder;
  }
  setup(engine: Engine): void {
    if (this.disposed || engine !== this.engine || !engine.gpu)
      throw new Error('Opaque color capture requires its WebGPU engine');
    this.device = engine.gpu;
    // A valid borrowed view lets callers install a bind-group description before the first frame.
    this.placeholder = this.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.placeholderView = this.placeholder.createView();
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':begin',
      order: -0.1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.begin(c);
      },
    });
    graph.add({
      name: this.name + ':copy',
      order: 8,
      execute: (c) => {
        if (c.backend === 'webgpu') this.snapshot(c);
      },
    });
    graph.add({
      name: this.name + ':blend',
      order: 8.1,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.frame) return;
        try {
          PBRModel.endOpaquePass(c);
        } catch (error) {
          this.abort(c, error);
        }
      },
    });
    graph.add({
      name: this.name + ':present',
      order: 8.2,
      execute: (c) => {
        if (c.backend === 'webgpu') this.present(c);
      },
    });
  }
  private create(c: Context, borrowed?: SceneTarget): Capture {
    const textures: GPUTexture[] = [];
    let target: SceneTarget | undefined;
    try {
      const samples = c.descriptor.multisample?.count ?? 1,
        depthFormat = c.descriptor.depthStencil!.format;
      if (samples !== 1 && samples !== 4) throw new RangeError('Transmission scene samples must be 1 or 4');
      const texture = (format: GPUTextureFormat) => {
        const value = c.device.createTexture({
          size: [c.width, c.height],
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        textures.push(value);
        return value;
      };
      const snapshot = texture(c.format),
        source = borrowed?.resolvedColor ?? texture(c.format),
        view = snapshot.createView(),
        sourceView = source.createView();
      if (!borrowed && samples === 4) target = new SceneTarget(c.device, source, texture(depthFormat), samples);
      const module = c.device.createShaderModule({ code: copyShader });
      const pipeline = (count: number) =>
        c.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
          multisample: { count },
        });
      const copy = pipeline(1),
        group = c.device.createBindGroup({
          layout: copy.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: sourceView }],
        });
      // SceneTarget presents its own MSAA capture. At 1x keep the original depth attachment throughout.
      const present = !borrowed && !target ? pipeline(samples) : undefined;
      const presentation = present
        ? c.device.createBindGroup({
            layout: present.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: sourceView }],
          })
        : undefined;
      return {
        width: c.width,
        height: c.height,
        format: c.format,
        samples,
        depthFormat,
        textures,
        snapshot,
        view,
        source,
        sourceView,
        target,
        borrowed,
        copy,
        group,
        present,
        presentation,
      };
    } catch (error) {
      const cleanup = new Cleanup(error);
      cleanup.run(() => target?.dispose());
      for (const texture of textures) cleanup.run(() => texture.destroy());
      cleanup.finish();
      throw error;
    }
  }
  private releaseCapture(capture: Capture | undefined): void {
    if (!capture) return;
    const cleanup = new Cleanup();
    cleanup.run(() => capture.target?.dispose());
    for (const texture of capture.textures) cleanup.run(() => texture.destroy());
    cleanup.finish();
  }
  private begin(c: Context): void {
    const borrowed = sceneTarget(c),
      old = this.capture;
    if (
      !old ||
      old.width !== c.width ||
      old.height !== c.height ||
      old.format !== c.format ||
      old.samples !== (c.descriptor.multisample?.count ?? 1) ||
      old.depthFormat !== c.descriptor.depthStencil!.format ||
      old.borrowed !== borrowed
    ) {
      // Build every replacement before retiring the previous frame's resources.
      this.capture = this.create(c, borrowed);
      this.releaseCapture(old);
    }
    const capture = this.capture!;
    for (const update of this.updates) update(capture.view);
    this.frame = { context: c, capture, original: c.color, depth: c.depth, format: c.format, descriptor: c.descriptor };
    try {
      if (capture.target) capture.target.begin(c);
      else if (!capture.borrowed) c.color = capture.sourceView;
      PBRModel.beginOpaquePass(c);
    } catch (error) {
      this.abort(c, error);
    }
  }
  private snapshot(c: Context): void {
    const frame = this.frame;
    if (!frame || frame.context !== c) return;
    try {
      const capture = frame.capture;
      (capture.borrowed ?? capture.target)?.resolve(c.encoder);
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: capture.view, loadOp: 'clear', storeOp: 'store' }],
      });
      try {
        pass.setPipeline(capture.copy);
        pass.setBindGroup(0, capture.group);
        pass.draw(3);
      } finally {
        pass.end();
      }
    } catch (error) {
      this.abort(c, error);
    }
  }
  private restore(c: Context): void {
    const frame = this.frame;
    if (!frame) return;
    this.frame = undefined;
    try {
      frame.capture.target?.restore(c);
    } finally {
      Object.assign(c, {
        color: frame.original,
        depth: frame.depth,
        format: frame.format,
        descriptor: frame.descriptor,
      });
    }
  }
  private abort(c: Context, ...errors: unknown[]): void {
    const cleanup = new Cleanup(...errors);
    cleanup.run(() => PBRModel.cancelOpaquePass(c)).run(() => this.restore(c));
    cleanup.finish();
  }
  private present(c: Context): void {
    const frame = this.frame;
    if (!frame || frame.context !== c) return;
    try {
      const capture = frame.capture;
      if (capture.target) capture.target.present(c);
      else if (!capture.borrowed) {
        const pass = c.encoder.beginRenderPass({
          colorAttachments: [{ view: frame.original, loadOp: 'clear', storeOp: 'store' }],
        });
        try {
          pass.setPipeline(capture.present!);
          pass.setBindGroup(0, capture.presentation!);
          pass.draw(3);
        } finally {
          pass.end();
        }
      }
      this.restore(c);
    } catch (error) {
      this.abort(c, error);
    }
  }
  private release(): void {
    const cleanup = new Cleanup();
    if (this.frame) cleanup.run(() => this.abort(this.frame!.context));
    const capture = this.capture;
    this.capture = undefined;
    cleanup.run(() => this.releaseCapture(capture)).run(() => this.placeholder?.destroy());
    this.placeholder = this.placeholderView = undefined;
    cleanup.finish();
  }
  onDeviceRestored(engine: Engine): void {
    // A failed frame's old encoder belongs to the lost device; retire it without encoding depth copies.
    if (this.frame) {
      const frame = this.frame;
      PBRModel.cancelOpaquePass(frame.context);
      Object.assign(frame.context, {
        color: frame.original,
        depth: frame.depth,
        format: frame.format,
        descriptor: frame.descriptor,
      });
      this.frame = undefined;
    }
    this.release();
    this.setup(engine);
    for (const update of this.updates) update(this.view);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cleanup = new Cleanup();
    cleanup.run(() => this.engine.removePlugin(this.name)).run(() => this.release());
    this.updates.clear();
    if (captures.get(this.engine) === this) captures.delete(this.engine);
    cleanup.finish();
  }
}

/** Acquires one shared opaque snapshot; views are borrowed and replaced after resize/device recovery. */
export function acquireOpaqueColor(
  engine: Engine,
  update: Update,
): { readonly view: GPUTextureView; texture(): GPUTexture | undefined; release(): void } {
  if (typeof update !== 'function') throw new TypeError('Expected an opaque color view callback');
  let capture = captures.get(engine);
  if (!capture) {
    capture = new OpaqueColor(engine);
    engine.use(capture);
    captures.set(engine, capture);
  }
  const value = capture,
    listener: Update = (view) => update(view);
  value.updates.add(listener);
  try {
    update(value.view);
  } catch (error) {
    value.updates.delete(listener);
    if (!value.updates.size) value.dispose();
    throw error;
  }
  let released = false;
  return {
    get view() {
      return value.view;
    },
    texture: () => value.texture(),
    release() {
      if (released) return;
      released = true;
      value.updates.delete(listener);
      if (!value.updates.size) value.dispose();
    },
  };
}
