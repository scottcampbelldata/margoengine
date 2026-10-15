/// <reference lib="esnext.disposable" preserve="true" />
// Display P3 and HDR (extended-range) canvas output without a core change.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type FrameGraph, type PassContext } from '@margoengine/core/extension';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
type GPUContext = Extract<PassContext, { backend: 'webgpu' }>;
type Configuration = GPUCanvasConfiguration & {
  colorSpace?: PredefinedColorSpace;
  toneMapping?: { mode?: 'standard' | 'extended' };
};
type Canvas = GPUCanvasContext & { getConfiguration?(): Configuration | null };
/** What Tonemap reads from the pass context between the two ColorOutput passes (no import between the packages). */
interface Frame {
  peak: number;
  p3: boolean;
  excess?: (width: number, height: number) => GPUTextureView;
}
const OUTPUT = Symbol.for('margoengine.color-output');

export interface ColorOutputOptions {
  /** 'p3' (default): Display P3 canvas where the display reports `(color-gamut: p3)`. 'srgb': keep the sRGB canvas. */
  gamut?: 'srgb' | 'p3';
  /** Default true: extended-range (HDR) float16 canvas where the display reports `(dynamic-range: high)`. */
  hdr?: boolean;
  /** Brightest HDR output relative to SDR white, 1 to 16; default 4. Tonemap rolls highlights off toward it. */
  peak?: number;
  /** Skip the display media queries and request what the options ask (tests, or a display they misreport). */
  force?: boolean;
}

// Reads the canvas-format image the frame drew (sRGB-encoded, Rec.709), adds Tonemap's linear excess (HDR highlights
// and colours outside sRGB), converts to linear P3 when asked, clamps to the output range and encodes again.
const shader = /* wgsl */ `
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var excess:texture_2d<f32>;
@group(0) @binding(2) var<uniform> o:vec4f;
@vertex fn vertexMain(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(vec2f(f32((i<<1u)&2u),f32(i&2u))*2.0-1.0,0.0,1.0);}
@fragment fn fragmentMain(@builtin(position) p:vec4f)->@location(0) vec4f {
  let q=vec2i(p.xy);let s=textureLoad(image,q,0);let a=select(1.0,s.a,o.w==1.0);let e=select(s.rgb,s.rgb/a,a>0.0&&a<1.0);
  var c=select(e/12.92,pow((e+0.055)/1.055,vec3f(2.4)),e>vec3f(0.04045))+textureLoad(excess,q,0).rgb*o.z;
  if(o.y==1.0){c=mat3x3f(0.822462,0.033194,0.017083,0.177538,0.966806,0.072397,0.0,0.0,0.910520)*c;}
  c=clamp(c,vec3f(0.0),vec3f(o.x));
  return vec4f(select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>vec3f(0.0031308))*a,a);
}`;

/**
 * Display P3 and/or HDR canvas output (three.js `renderer.outputColorSpace` / WebGPU `toneMapping: 'extended'`) as one
 * plugin with zero core bytes. Where the display supports it, the canvas is reconfigured (`colorSpace: 'display-p3'`;
 * HDR: `rgba16float` with `toneMapping: {mode: 'extended'}`), core's frame is redirected into an offscreen copy of the
 * canvas texture, and a final pass writes the real canvas: sRGB content converted exactly to P3 (it looks the same),
 * plus Tonemap's highlights above SDR white and colours outside sRGB. Unsupported displays, browsers and the WebGL2
 * fallback leave the canvas and every GPU call untouched. Reapplied after `engine.rebootDevice()`; `dispose()` restores
 * the sRGB/SDR canvas.
 */
export class ColorOutput {
  readonly name = 'color-output';
  readonly peak: number;
  private engine?: EngineKernel;
  private context?: Canvas;
  private wantP3 = false;
  private wantHDR = false;
  private p3 = false;
  private extended = false;
  private on = false;
  private used = false;
  private disposed = false;
  private original?: PropertyDescriptor | null;
  private real?: () => GPUTexture;
  private image?: { device: GPUDevice; texture: GPUTexture; view: GPUTextureView };
  private excessTarget?: { device: GPUDevice; texture: GPUTexture; view: GPUTextureView };
  private state?: {
    device: GPUDevice;
    uniform: GPUBuffer;
    module: GPUShaderModule;
    pipelines: Map<string, GPURenderPipeline>;
    group?: GPUBindGroup;
    key?: unknown[];
  };
  private readonly frame: Frame = {
    peak: 1,
    p3: false,
    excess: (width, height) => {
      const device = engineRuntime(this.engine!).gpu!,
        target = this.excessTarget;
      if (target?.device !== device || target.texture.width !== width || target.texture.height !== height) {
        target?.texture.destroy();
        const texture = device.createTexture({
          label: 'color output excess',
          size: [width, height],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.excessTarget = { device, texture, view: texture.createView() };
      }
      this.used = true;
      return this.excessTarget!.view;
    },
  };
  private readonly values = new Float32Array(4);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly passDescriptor: GPURenderPassDescriptor = {
    label: 'color output',
    colorAttachments: [this.attachment],
  };
  private readonly resolveAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'load',
    storeOp: 'store',
  };
  private readonly resolveDescriptor: GPURenderPassDescriptor = {
    label: 'color output resolve',
    colorAttachments: [this.resolveAttachment],
  };

  /** Same as `engine.use(new ColorOutput(...))`; returns the ColorOutput. */
  static attach(engine: EngineKernel, options?: ColorOutputOptions): ColorOutput {
    const value = new ColorOutput(options);
    engine.use(value);
    return value;
  }
  constructor(readonly options: Readonly<ColorOutputOptions> = {}) {
    const { gamut = 'p3', hdr = true, peak = 4, force = false } = options;
    if (
      (gamut !== 'srgb' && gamut !== 'p3') ||
      typeof hdr !== 'boolean' ||
      typeof force !== 'boolean' ||
      !(peak >= 1 && peak <= 16)
    )
      throw new RangeError('Invalid ColorOutput options');
    this.peak = peak;
  }
  /** Gamut of the canvas now: 'p3' only when the display, the browser and the options all allow it. */
  get gamut(): 'srgb' | 'p3' {
    return this.p3 ? 'p3' : 'srgb';
  }
  /** True while the canvas is extended-range (float16, `toneMapping: 'extended'`). */
  get hdr(): boolean {
    return this.extended;
  }

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new Error('ColorOutput is disposed');
    this.engine = engine;
    if (engine.backend !== 'webgpu') return;
    const { gamut = 'p3', hdr = true, force } = this.options,
      media = (query: string) => force || (typeof matchMedia === 'function' && matchMedia(query).matches);
    this.wantP3 = gamut === 'p3' && media('(color-gamut: p3)');
    this.wantHDR = hdr && media('(dynamic-range: high)');
    this.apply();
  }
  // Passes only when active: registering any pass changes how core stores its multisampled frame.
  registerPasses(graph: FrameGraph): void {
    if (!this.on) return;
    graph.add({
      name: 'color-output:begin',
      order: -1e5,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.on) {
          this.used = false;
          (c as { [OUTPUT]?: Frame })[OUTPUT] = this.frame;
        }
      },
    });
    graph.add({
      name: 'color-output',
      order: 1e5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.present(c);
      },
    });
  }
  onDeviceRestored(): void {
    this.release();
    this.apply();
  }
  /** Restores the sRGB/SDR canvas and detaches from the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frame.excess = undefined;
    if (this.on) {
      this.configure(false, false);
      this.patch(false);
    }
    this.on = this.p3 = this.extended = false;
    this.release();
    const engine = this.engine;
    this.engine = undefined;
    if (engine && !engine.disposed && engineRuntime(engine).plugins.get(this.name) === this)
      engine.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  // Merges with the current configuration so TransparentCanvas (alphaMode) and a SceneFade (usage) survive.
  private configure(hdr: boolean, p3: boolean): void {
    const context = this.context!,
      current = context.getConfiguration?.();
    context.configure({
      ...current,
      device: engineRuntime(this.engine!).gpu!,
      alphaMode: current?.alphaMode ?? 'opaque',
      format: hdr ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat(),
      colorSpace: p3 ? 'display-p3' : 'srgb',
      toneMapping: { mode: hdr ? 'extended' : 'standard' },
    } as Configuration);
  }
  private apply(): void {
    const engine = this.engine,
      wasOn = this.on;
    this.on = this.p3 = this.extended = false;
    if (!engine || engine.disposed || this.disposed || !engineRuntime(engine).gpu || !(this.wantP3 || this.wantHDR))
      return;
    this.context ??= (engine.canvas.getContext('webgpu') as Canvas | null) ?? undefined;
    if (!this.context) return;
    this.configure(this.wantHDR, this.wantP3);
    // A browser without extended tone mapping (or P3 canvases) drops the member; getConfiguration() shows what stuck.
    const applied = this.context.getConfiguration?.();
    this.extended = this.wantHDR && (!applied || applied.toneMapping?.mode === 'extended');
    this.p3 = this.wantP3 && (!applied || applied.colorSpace === 'display-p3');
    if (this.wantHDR !== this.extended) this.configure(false, this.p3);
    this.on = this.p3 || this.extended;
    if (wasOn || this.on) this.patch(this.on);
    this.frame.peak = this.extended ? this.peak : 1;
    this.frame.p3 = this.p3;
  }
  // Core asks the context for its texture once per frame; it gets an offscreen one in the canvas format instead.
  private patch(on: boolean): void {
    const context = this.context!;
    if (on && this.original === undefined) {
      this.original = Object.getOwnPropertyDescriptor(context, 'getCurrentTexture') ?? null;
      this.real = context.getCurrentTexture;
      Object.defineProperty(context, 'getCurrentTexture', { configurable: true, writable: true, value: this.texture });
    } else if (!on && this.original !== undefined) {
      if (this.original) Object.defineProperty(context, 'getCurrentTexture', this.original);
      else Reflect.deleteProperty(context, 'getCurrentTexture');
      this.original = this.real = undefined;
    }
  }
  private readonly texture = (): GPUTexture => {
    const engine = this.engine!,
      device = engineRuntime(engine).gpu!,
      { width, height } = engine.canvas,
      image = this.image;
    if (image?.device !== device || image.texture.width !== width || image.texture.height !== height) {
      image?.texture.destroy();
      const texture = device.createTexture({
        label: 'color output image',
        size: [width, height],
        format: navigator.gpu.getPreferredCanvasFormat(),
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      this.image = { device, texture, view: texture.createView() };
    }
    return this.image!.texture;
  };

  private present(c: GPUContext): void {
    delete (c as { [OUTPUT]?: Frame })[OUTPUT];
    const image = this.image,
      { device } = c;
    if (!this.on || image?.device !== device) return;
    if (this.state?.device !== device) {
      this.release(true);
      const uniform = device.createBuffer({
        label: 'color output',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      try {
        this.state = {
          device,
          uniform,
          module: device.createShaderModule({ label: 'color output', code: shader }),
          pipelines: new Map(),
        };
      } catch (error) {
        uniform.destroy();
        throw error;
      }
    }
    const state = this.state,
      format: GPUTextureFormat = this.extended ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat();
    let pipeline = state.pipelines.get(format);
    if (!pipeline)
      state.pipelines.set(
        format,
        (pipeline = device.createRenderPipeline({
          label: 'color output',
          layout: 'auto',
          vertex: { module: state.module, entryPoint: 'vertexMain' },
          fragment: { module: state.module, entryPoint: 'fragmentMain', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        })),
      );
    // Passes after the scene may have drawn into core's multisampled target only; core resolves it after the graph.
    if ((c.descriptor.multisample?.count ?? 1) > 1) {
      this.resolveAttachment.view = c.color;
      this.resolveAttachment.resolveTarget = image.view;
      c.encoder.beginRenderPass(this.resolveDescriptor).end();
    }
    const excess = this.used && this.excessTarget?.device === device ? this.excessTarget.view : image.view,
      key = [pipeline, image.view, excess];
    if (!state.group || state.key!.some((value, i) => value !== key[i])) {
      state.group = device.createBindGroup({
        label: 'color output',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: image.view },
          { binding: 1, resource: excess },
          { binding: 2, resource: { buffer: state.uniform } },
        ],
      });
      state.key = key;
    }
    const v = this.values;
    v[0] = this.extended ? this.peak : 1;
    v[1] = +this.p3;
    v[2] = +(excess !== image.view);
    v[3] = +(this.context!.getConfiguration?.()?.alphaMode === 'premultiplied');
    device.queue.writeBuffer(state.uniform, 0, v);
    this.attachment.view = this.real!.call(this.context!).createView();
    const pass = c.encoder.beginRenderPass(this.passDescriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, state.group);
    pass.draw(3);
    pass.end();
  }
  private release(keepTargets = false): void {
    this.state?.uniform.destroy();
    this.state = undefined;
    if (keepTargets) return;
    this.image?.texture.destroy();
    this.excessTarget?.texture.destroy();
    this.image = this.excessTarget = undefined;
  }
}
