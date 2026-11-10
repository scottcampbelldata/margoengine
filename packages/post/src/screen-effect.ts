/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { render, group } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';

/** GPU frame context for optional screen passes. */
export type ScreenContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Resource ownership for optional screen effects; no import from the post root. */
export abstract class ScreenEffect implements EnginePlugin {
  protected host?: StackHost;
  protected engine?: Engine;
  protected stack?: PostStack;
  protected uniform?: GPUBuffer;
  protected readonly textures: GPUTexture[] = [];
  private readonly views: GPUTextureView[] = [];
  private disposed = false;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly groups = new Map<string, { resources: GPUBindingResource[]; group: GPUBindGroup }>();
  protected abstract readonly kind: StackStage['kind'];
  abstract readonly name: string;
  protected abstract frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void;
  protected abstract check(): void;
  private joinStack(host: StackHost): StackStage {
    if (this.host || this.disposed) throw margoError('attached', 'Screen effect already joined; create a new effect');
    this.host = host;
    return {
      kind: this.kind,
      render: (c, input, output) => {
        this.check();
        this.frame(c, input, output);
      },
    };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Screen effect disposed; create a new effect');
    if (!this.host) throw margoError('state', 'Use an effect inside PostStack or call its attach method');
    if (!engine.gpu) throw margoError('unsupported', 'Screen effects require a GPU backend; use WebGPU or full WebGL2');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 64, usage: 0x40 | 0x8 });
  }
  protected target(c: ScreenContext, index: number, format: GPUTextureFormat = 'rgba16float'): GPUTextureView {
    let t = this.textures[index];
    if (t?.width !== c.width || t.height !== c.height || t.format !== format) {
      t?.destroy();
      t = this.textures[index] = c.device.createTexture({ size: [c.width, c.height], format, usage: 0x10 | 0x4 });
      this.views[index] = t.createView();
      this.groups.clear();
    }
    return this.views[index];
  }
  protected draw(c: ScreenContext, code: string, output: StageOutput, resources: GPUBindingResource[]): void {
    const key = `${output.format}:${output.multisample.count}:${code}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = render(c.device, code, output.format, { multisample: output.multisample });
      this.pipelines.set(key, pipeline);
    }
    let binding = this.groups.get(key);
    if (!binding || resources.some((r, i) => r !== binding!.resources[i])) {
      binding = { resources, group: group(c.device, pipeline, resources) };
      this.groups.set(key, binding);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    try {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, binding.group);
      applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }
  protected release(): void {
    this.uniform?.destroy();
    this.uniform = undefined;
    for (const t of this.textures) t.destroy();
    this.textures.length = 0;
    this.views.length = 0;
    this.pipelines.clear();
    this.groups.clear();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
