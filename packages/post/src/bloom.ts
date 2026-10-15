/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type DrawOptions,
} from '@margoengine/core/extension';
import { agxShader } from '../../shared/agx.js';
import { render, group } from '../../shared/gpu.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  COPY_SRC: number;
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  STORAGE_BINDING: number;
};

type Context = Extract<PassContext, { backend: 'webgpu' }>;
export interface BloomOptions {
  strength?: number;
  threshold?: number;
  exposure?: number;
}
const filter = `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(2) var<uniform> settings:vec4f;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(output);if(any(id.xy>=size)){return;}
 let p=vec2i(id.xy*textureDimensions(source)/size);let limit=vec2i(textureDimensions(source))-1;
 var color=vec3f(0);var weights=0.0;
 for(var i=-4;i<=4;i++){
  let w=exp(-f32(i*i)*0.125);let q=clamp(p+vec2i(settings.xy)*i,vec2i(0),limit);
  var c=textureLoad(source,q,0).rgb;
  if(settings.z>0){c*=max(0.0,max(c.r,max(c.g,c.b))-settings.w)/max(0.0001,max(c.r,max(c.g,c.b)));}
  color+=c*w;weights+=w;
 }textureStore(output,vec2i(id.xy),vec4f(color/weights,1));
}`;
const composite =
  agxShader +
  `
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var bloom:texture_2d<f32>;
@group(0) @binding(2) var<uniform> settings:vec4f;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let uv=p.xy/vec2f(textureDimensions(scene));
 let q=clamp(vec2i(uv*vec2f(textureDimensions(bloom))),vec2i(0),vec2i(textureDimensions(bloom))-1);
 let s=textureLoad(scene,vec2i(p.xy),0);let hdr=s.rgb+textureLoad(bloom,q,0).rgb*settings.x;
 let c=agx(max(hdr,vec3f(0))*exp2(settings.y));
 let o=select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));return vec4f(o,max(s.a,max(o.r,max(o.g,o.b))));
}`;
// Alpha: scene coverage (premultiplied), raised to the glow's brightest channel so glow over a transparent canvas stays valid.
// In a PostStack, a non-final Bloom hands linear light (with its exposure) to the next effect.
const linear = composite.replace(/let c=agx[^\n]+\n[^\n]+/, 'return vec4f(max(hdr,vec3f(0))*exp2(settings.y),s.a);');

/** Owns linear HDR scene capture, half-resolution bloom and a single AgX presentation. */
export class Bloom implements EnginePlugin {
  readonly name = 'bloom';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private kernels: GPUBuffer[] = [];
  private textures: GPUTexture[] = [];
  private groups: GPUBindGroup[] = [];
  private blur?: GPUComputePipeline;
  private present?: GPURenderPipeline;
  private capture?: SceneTarget;
  private scene?: GPUTextureView;
  private depth?: GPUTextureView;
  private original?: GPUTextureView;
  private originalDepth?: GPUTextureView;
  private originalFormat?: GPUTextureFormat;
  private linearShader = '';
  private sourceShader = '';
  private originalDraw?: PassContext['draw'];
  private readonly scenePipelines = new Map<string, GPURenderPipeline>();
  private readonly sceneOptions: DrawOptions = {};
  private readonly drawScene = (options?: DrawOptions): void => this.originalDraw!(options ?? this.sceneOptions);
  private readonly values = new Float32Array(4);
  private readonly horizontal = new Float32Array([1, 0, 1, 1]);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly presentation: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  private disposed = false;
  private host?: StackHost;
  private input?: GPUTextureView;
  private key = '';

  constructor(readonly options: BloomOptions = {}) {
    this.validate();
  }
  static attach(engine: EngineKernel, options: BloomOptions = {}): Bloom {
    const bloom = new Bloom(options);
    engineRuntime(engine).use(bloom);
    return bloom;
  }
  get depthTexture(): GPUTexture | undefined {
    return this.host ? this.host.depthTexture : this.textures[1];
  }
  /** Captured linear scene; undefined in a PostStack. */
  get sceneTexture(): GPUTexture | undefined {
    return this.host ? undefined : this.textures[0];
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed) throw new Error('Bloom is already attached');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const s = this.options.strength ?? 0.8,
      t = this.options.threshold ?? 1,
      e = this.options.exposure ?? 0;
    if (
      !Number.isFinite(s) ||
      s < 0 ||
      s > 4 ||
      !Number.isFinite(t) ||
      t < 0 ||
      t > 100 ||
      !Number.isFinite(e) ||
      Math.abs(e) > 10
    )
      throw new RangeError('Invalid bloom options');
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('Bloom requires WebGPU and a live effect');
    if (!this.host && (engine.hasPlugin('ssao') || engine.hasPlugin('post-processing') || engine.hasPlugin('tonemap')))
      throw new Error('Bloom owns the output target; remove the other post effect first');
    this.engine = engine;
    const device = engine.gpu;
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    for (const data of [this.horizontal, new Float32Array([0, 1, 0, 0])]) {
      const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.kernels.push(buffer);
      device.queue.writeBuffer(buffer, 0, data);
    }
    this.blur = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: filter }), entryPoint: 'main' },
    });
  }
  registerPasses(graph: FrameGraph): void {
    if (this.host) return;
    graph.add({
      name: 'bloom:capture',
      order: -60,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.validate();
        if (
          this.engine!.hasPlugin('ssao') ||
          this.engine!.hasPlugin('post-processing') ||
          this.engine!.hasPlugin('tonemap')
        )
          throw new Error('Bloom cannot share its output target');
        this.resize(c);
        this.original = c.color;
        this.originalDepth = c.depth;
        this.originalFormat = c.format;
        this.capture!.begin(c);
        if (this.sourceShader !== c.shader) {
          this.sourceShader = c.shader;
          this.linearShader = c.shader.replace(
            /let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/,
            'return vec4f(linear,1);',
          );
          if (this.linearShader === c.shader) throw new Error('Bloom requires the standard core lighting shader');
        }
        c.shader = this.linearShader;
      },
    });
    graph.add({
      name: 'bloom:scene-pipeline',
      order: -0.25,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        let pipeline = this.scenePipelines.get(c.shader);
        if (!pipeline) {
          const module = c.device.createShaderModule({ code: c.shader });
          pipeline = c.device.createRenderPipeline({
            ...c.descriptor,
            layout: 'auto',
            vertex: { ...c.descriptor.vertex, module },
            fragment: { ...c.descriptor.fragment!, module, targets: [{ format: 'rgba16float' }] },
          });
          this.scenePipelines.set(c.shader, pipeline);
        }
        // Supply the retained HDR variant directly, avoiding a large shader-key concatenation in core.
        this.sceneOptions.pipeline = pipeline;
        this.originalDraw = c.draw;
        c.draw = this.drawScene;
      },
    });
    graph.add({
      name: 'bloom:AgX',
      order: 30,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private resize(c: Context): void {
    if (
      this.textures[0]?.width === c.width &&
      this.textures[0]?.height === c.height &&
      this.originalFormat === c.format &&
      this.textures[1]?.format === c.descriptor.depthStencil!.format &&
      this.capture?.samples === (c.descriptor.multisample?.count ?? 4)
    )
      return;
    if (
      this.textures[1]?.format !== c.descriptor.depthStencil!.format ||
      this.capture?.samples !== (c.descriptor.multisample?.count ?? 4)
    )
      this.scenePipelines.clear();
    this.capture?.dispose();
    this.capture = undefined;
    for (const texture of this.textures) texture.destroy();
    this.textures = [];
    const device = c.device,
      width = Math.max(1, Math.ceil(c.width / 2)),
      height = Math.max(1, Math.ceil(c.height / 2));
    this.textures.push(
      device.createTexture({
        size: [c.width, c.height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      }),
    );
    this.textures.push(
      device.createTexture({
        size: [c.width, c.height],
        format: c.descriptor.depthStencil!.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    for (let i = 0; i < 2; i++)
      this.textures.push(
        device.createTexture({
          size: [width, height],
          format: 'rgba16float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
    this.capture = new SceneTarget(device, this.textures[0], this.textures[1], c.descriptor.multisample?.count ?? 4);
    this.scene = this.textures[0].createView();
    this.depth = this.textures[1].createView();
    const a = this.textures[2].createView(),
      b = this.textures[3].createView(),
      module = device.createShaderModule({ code: composite });
    this.present = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
      multisample: c.descriptor.multisample,
    });
    const group = (pipeline: GPUComputePipeline | GPURenderPipeline, resources: GPUBindingResource[]) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource })),
      });
    this.groups = [
      group(this.blur!, [this.scene, a, { buffer: this.kernels[0] }]),
      group(this.blur!, [a, b, { buffer: this.kernels[1] }]),
      group(this.present, [this.scene, b, { buffer: this.uniform! }]),
    ];
  }
  private draw(c: Context): void {
    this.capture!.resolve(c.encoder, true);
    this.apply(c, this.original!);
    this.capture!.restore(c);
    c.draw = this.originalDraw!;
  }
  /** Stacked: blur `input` at half resolution and composite into `output`, AgX-encoded only as the display output. */
  private stage(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    const device = c.device,
      width = Math.max(1, Math.ceil(c.width / 2)),
      height = Math.max(1, Math.ceil(c.height / 2)),
      key = output.format + output.multisample.count + output.hdr;
    if (this.textures[0]?.width !== width || this.textures[0].height !== height) {
      for (const texture of this.textures) texture.destroy();
      this.input = undefined;
      this.textures = [0, 1].map(() =>
        device.createTexture({
          size: [width, height],
          format: 'rgba16float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
    }
    if (this.key !== key) {
      this.key = key;
      this.input = undefined;
      this.present = render(device, output.hdr ? linear : composite, output.format, {
        multisample: output.multisample,
      });
    }
    if (this.input !== input) {
      const a = this.textures[0].createView(),
        b = this.textures[1].createView();
      this.input = input;
      this.groups = [
        group(device, this.blur!, [input, a, { buffer: this.kernels[0] }]),
        group(device, this.blur!, [a, b, { buffer: this.kernels[1] }]),
        group(device, this.present!, [input, b, { buffer: this.uniform! }]),
      ];
    }
    this.apply(c, output.view);
  }
  private apply(c: Context, view: GPUTextureView): void {
    this.values[0] = this.options.strength ?? 0.8;
    this.values[1] = this.options.exposure ?? 0;
    this.horizontal[3] = this.options.threshold ?? 1;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    c.device.queue.writeBuffer(this.kernels[0], 0, this.horizontal);
    const compute = c.encoder.beginComputePass();
    compute.setPipeline(this.blur!);
    for (let i = 0; i < 2; i++) {
      compute.setBindGroup(0, this.groups[i]);
      compute.dispatchWorkgroups(
        Math.ceil(this.textures.at(-1)!.width / 8),
        Math.ceil(this.textures.at(-1)!.height / 8),
      );
    }
    compute.end();
    this.attachment.view = view;
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.present!);
    pass.setBindGroup(0, this.groups[2]);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.capture?.dispose();
    this.capture = undefined;
    this.uniform?.destroy();
    for (const buffer of this.kernels) buffer.destroy();
    for (const texture of this.textures) texture.destroy();
    this.uniform = undefined;
    this.kernels = [];
    this.textures = [];
    this.groups = [];
    this.blur = this.present = undefined;
    this.scene = this.depth = this.original = this.originalDepth = undefined;
    this.originalFormat = undefined;
    this.sourceShader = this.linearShader = this.key = '';
    this.input = undefined;
    this.scenePipelines.clear();
    this.sceneOptions.pipeline = undefined;
    this.originalDraw = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
