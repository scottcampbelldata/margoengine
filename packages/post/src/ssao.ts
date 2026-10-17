/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { viewMatrix } from '../../shared/view.js';
import { preset } from '../../shared/preset.js';
import { orthographic } from '../../shared/projection.js';
import { fullscreen, render, group as bind } from '../../shared/gpu.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { extractShader, ssaoShader, blurShader, compositeShader } from './shaders.js';
const linearComposite = compositeShader.replace(/c=c\/\(1\+c\);[^\n]+/, 'return vec4f(c,s.a);');
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  STORAGE_BINDING: number;
  COPY_DST: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;
export interface SSAOOptions {
  radius?: number;
  bias?: number;
  samples?: number;
  enabled?: boolean;
}
export interface SSAOSource {
  draw(
    context: Context,
    mode: 'gbuffer' | 'ambient' | 'occlusion',
    color: GPUTextureView,
    depth: GPUTextureView,
    phase?: 'all' | 'opaque' | 'blend',
    external?: { pass: GPURenderPassEncoder; view: ArrayLike<number>; depthCompare: GPUCompareFunction },
  ): void;
}
function kernel(): Float32Array {
  const values = new Float32Array(128);
  for (let i = 0; i < 32; i++) {
    const z = (i + 0.5) / 32,
      angle = i * 2.399963229728653,
      r = Math.sqrt(1 - z * z),
      scale = 0.1 + 0.9 * (i / 31) ** 2;
    values.set([Math.cos(angle) * r * scale, Math.sin(angle) * r * scale, z * scale, 0], i * 4);
  }
  return values;
}
export class SSAO implements EnginePlugin {
  readonly name = 'ssao';
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private samples?: GPUBuffer;
  private noise?: GPUTexture;
  private extract?: GPUComputePipeline;
  private occlusion?: GPUComputePipeline;
  private blur?: GPUComputePipeline;
  private composite?: GPURenderPipeline;
  private captureTarget?: SceneTarget;
  private textures: GPUTexture[] = [];
  private directions: GPUBuffer[] = [];
  private groups: GPUBindGroup[] = [];
  private width = 0;
  private height = 0;
  private original?: GPUTextureView;
  private originalFormat?: GPUTextureFormat;
  private scene?: GPUTextureView;
  private depth?: GPUTextureView;
  private gbuffer?: GPUTextureView;
  private ambient?: GPUTextureView;
  private ambientPipeline?: GPURenderPipeline;
  private ambientShader = '';
  private readonly sources = new Set<SSAOSource>();
  private replayViews: GPUTextureView[] = [];
  private replayCopy?: GPURenderPipeline;
  private replayGroup?: GPUBindGroup;
  private disposed = false;
  private host?: StackHost;
  private ao?: GPUTextureView;
  private input?: GPUTextureView;
  private key = '';
  // Shader patches are cached per source string; pass descriptors are rebuilt with their targets in resize().
  private captureSource?: string;
  private captureShader = '';
  private ambientSource?: string;
  private ambientCode = '';
  private ambientAll = false;
  private readonly compositeAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  };
  private readonly compositePass: GPURenderPassDescriptor = { colorAttachments: [this.compositeAttachment] };
  private replayPass?: GPURenderPassDescriptor;
  private clearPass?: GPURenderPassDescriptor;
  private resolvePass?: GPURenderPassDescriptor;
  private readonly geometryColors: GPURenderPassColorAttachment[] = [
    { view: undefined!, loadOp: 'load', storeOp: 'store' },
    {
      view: undefined!,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    },
  ];
  private readonly geometryDepth: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
  };
  private readonly geometryPass: GPURenderPassDescriptor = {
    colorAttachments: this.geometryColors,
    depthStencilAttachment: this.geometryDepth,
  };
  private readonly drawView = new Float32Array(16);
  private readonly values = new Float32Array(56);
  private readonly inverseWorkspace = new Float64Array(52);
  private readonly inverse = this.values.subarray(0, 16);
  private readonly view = this.values.subarray(16, 32);
  private readonly projection = this.values.subarray(32, 48);
  private readonly directionValues = [new Float32Array([1, 0, 0.5, 0]), new Float32Array([0, 1, 0.5, 0])];
  constructor(readonly options: SSAOOptions = {}) {
    this.options = preset('ssao', options);
    this.validate();
  }
  static attach(instance: EngineKernel, options: SSAOOptions = {}): SSAO {
    const effect = new SSAO(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  get depthTexture(): GPUTexture | undefined {
    return this.host ? this.host.depthTexture : this.textures[1];
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed) throw new Error('SSAO is already attached');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('SSAO enabled must be boolean');
    this.options.enabled = value;
  }
  add(source: SSAOSource): () => void {
    if (!source || typeof source.draw !== 'function') throw new TypeError('Invalid SSAO source');
    this.sources.add(source);
    return () => this.sources.delete(source);
  }
  private validate(): void {
    const o = this.options,
      r = o.radius ?? 0.5,
      b = o.bias ?? 0.025,
      s = o.samples ?? 32;
    if (
      !Number.isFinite(Math.fround(r)) ||
      r <= 0 ||
      r > 100 ||
      !Number.isFinite(b) ||
      b < 0 ||
      b > r ||
      !Number.isInteger(s) ||
      s < 1 ||
      s > 32 ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean')
    )
      throw new RangeError('Invalid SSAO options');
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new Error('SSAO is disposed');
    if (!engine.gpu) throw new Error('SSAO requires WebGPU');
    if (!this.host && (engine.hasPlugin('post-processing') || engine.hasPlugin('bloom')))
      throw new Error('SSAO owns the output target; remove the other post effect first');
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = this.device.createBuffer({ size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.samples = this.device.createBuffer({ size: 512, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.samples, 0, kernel() as Float32Array<ArrayBuffer>);
    const create = (code: string) =>
      this.device!.createComputePipeline({
        layout: 'auto',
        compute: { module: this.device!.createShaderModule({ code }), entryPoint: 'main' },
      });
    this.extract = create(extractShader);
    this.occlusion = create(ssaoShader);
    this.blur = create(blurShader);
    this.noise = this.device.createTexture({
      size: [4, 4],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const noise = new Uint8Array(64);
    for (let i = 0; i < 16; i++) {
      const a = i * 2.399963229728653;
      noise.set(
        [Math.round((Math.cos(a) * 0.5 + 0.5) * 255), Math.round((Math.sin(a) * 0.5 + 0.5) * 255), 128, 255],
        i * 4,
      );
    }
    this.device.queue.writeTexture({ texture: this.noise }, noise, { bytesPerRow: 16 }, [4, 4]);
    for (const data of this.directionValues) {
      data[2] = 0.5;
      const b = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.directions.push(b);
      this.device.queue.writeBuffer(b, 0, data);
    }
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'ssao:capture',
      order: -60,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.validate();
        if (!this.host && (this.engine!.hasPlugin('post-processing') || this.engine!.hasPlugin('bloom')))
          throw new Error('SSAO cannot share the output target with another post effect');
        this.resize(c);
        if (!this.host) {
          this.original = c.color;
          this.originalFormat = c.format;
          this.captureTarget!.begin(c);
          if (this.captureSource !== c.shader) {
            this.captureSource = c.shader;
            this.captureShader = c.shader.replace(
              /let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/,
              'return vec4f(linear,1);',
            );
          }
          c.shader = this.captureShader;
        }
        if (!invertMatrixStable(c.camera.matrix, this.inverse, this.inverseWorkspace))
          throw new Error('Invalid SSAO camera');
        viewMatrix(this.view, c.camera);
        // View-space projection for the samples: the camera's own when it is orthographic (constant clip w, signed near/far), else core's perspective.
        const p = this.projection,
          o = orthographic(c.camera.matrix, c.camera.position);
        p.fill(0);
        if (o) {
          p[0] = o.sx;
          p[5] = o.sy;
          p[10] = o.sz;
          p[12] = o.ox;
          p[13] = o.oy;
          p[14] = o.far * o.sz;
          p[15] = 1;
        } else {
          const near = c.camera.near,
            far = c.camera.far,
            f = 1 / Math.tan((c.camera.fov * Math.PI) / 360);
          p[0] = (f * c.height) / c.width;
          p[5] = f;
          p[10] = near / (far - near);
          p[11] = -1;
          p[14] = (far * near) / (far - near);
        }
        const v = this.values;
        v[48] = this.options.radius ?? 0.5;
        v[49] = this.options.bias ?? 0.025;
        v[50] = this.options.samples ?? 32;
        v[51] = +this.enabled;
        v[52] = c.width;
        v[53] = c.height;
        v[54] = v[55] = 0;
        c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
        for (let i = 0; i < 2; i++) {
          this.directionValues[i][2] = this.options.radius ?? 0.5;
          c.device.queue.writeBuffer(this.directions[i], 0, this.directionValues[i]);
        }
      },
    });
    graph.add({
      name: 'ssao:extract',
      order: 10,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        try {
          this.extractScene(c);
        } catch (error) {
          if (!this.host) this.captureTarget!.restore(c);
          throw error;
        }
      },
    });
    graph.add({
      name: 'ssao:occlusion',
      order: 11,
      execute: (c) => {
        if (c.backend === 'webgpu') this.dispatch(c, this.occlusion!, this.groups[1]);
      },
    });
    graph.add({
      name: 'ssao:blur-x',
      order: 12,
      execute: (c) => {
        if (c.backend === 'webgpu') this.dispatch(c, this.blur!, this.groups[2]);
      },
    });
    graph.add({
      name: 'ssao:blur-y',
      order: 13,
      execute: (c) => {
        if (c.backend === 'webgpu') this.dispatch(c, this.blur!, this.groups[3]);
      },
    });
    graph.add({
      name: 'ssao:composite',
      order: 30,
      execute: (c) => {
        if (c.backend !== 'webgpu' || this.host) return;
        this.present(c, this.original!);
        this.captureTarget!.restore(c);
      },
    });
  }
  private present(c: Context, view: GPUTextureView): void {
    this.compositeAttachment.view = view;
    const pass = c.encoder.beginRenderPass(this.compositePass);
    pass.setPipeline(this.composite!);
    pass.setBindGroup(0, this.groups[4]);
    pass.draw(3);
    pass.end();
  }
  /** Stacked: darken the ambient term of `input`; Reinhard-encoded only as the display output. */
  private stage(c: Context, input: GPUTextureView, output: StageOutput): void {
    const key = output.format + output.multisample.count + output.hdr;
    if (this.key !== key) {
      this.key = key;
      this.composite = render(c.device, output.hdr ? linearComposite : compositeShader, output.format, {
        multisample: output.multisample,
      });
      this.groups.length = 4;
    }
    if (this.input !== input || !this.groups[4]) {
      this.input = input;
      this.groups[4] = bind(c.device, this.composite!, [input, this.ambient!, this.ao!]);
    }
    this.present(c, output.view);
  }
  private resize(c: Context): void {
    const host = this.host;
    if (
      this.width === c.width &&
      this.height === c.height &&
      (host
        ? this.captureTarget === host.target
        : this.originalFormat === c.format &&
          this.textures[1]?.format === c.descriptor.depthStencil!.format &&
          this.captureTarget?.samples === (c.descriptor.multisample?.count ?? 4))
    )
      return;
    if (!host) this.captureTarget?.dispose();
    for (const t of this.textures) t.destroy();
    this.textures = [];
    this.width = c.width;
    this.height = c.height;
    const texture = (format: GPUTextureFormat, usage: number) => {
      const t = c.device.createTexture({ size: [c.width, c.height], format, usage });
      this.textures.push(t);
      return t;
    };
    const sampled = GPUTextureUsage.TEXTURE_BINDING,
      render = sampled | GPUTextureUsage.RENDER_ATTACHMENT,
      storage = sampled | GPUTextureUsage.STORAGE_BINDING;
    let depth: GPUTexture;
    // Stacked, the scene and depth belong to the PostStack.
    if (host) {
      this.captureTarget = host.target;
      depth = host.depthTexture!;
    } else {
      this.scene = texture('rgba16float', render).createView();
      depth = texture(c.descriptor.depthStencil!.format, render);
      this.captureTarget = new SceneTarget(c.device, this.textures[0], depth, c.descriptor.multisample?.count ?? 4);
    }
    this.depth = depth.createView();
    const depthOnly = depth.createView({ aspect: 'depth-only' });
    // shortcut: linear depth fits 65,504 scene units, use a separate r32float target for larger scenes.
    this.gbuffer = texture('rgba16float', storage | GPUTextureUsage.RENDER_ATTACHMENT).createView();
    this.ambient = texture('rgba16float', render).createView();
    const raw = texture('r32float', storage).createView(),
      x = texture('r32float', storage).createView(),
      y = texture('r32float', storage).createView();
    this.replayViews = [];
    this.replayCopy = undefined;
    this.replayGroup = undefined;
    if (this.captureTarget!.samples === 4) {
      for (let i = 0; i < 2; i++) {
        const t = c.device.createTexture({
          size: [c.width, c.height],
          format: 'rgba16float',
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.textures.push(t);
        this.replayViews.push(t.createView());
      }
      const module = c.device.createShaderModule({
        code:
          fullscreen +
          '@group(0) @binding(0) var source:texture_2d<f32>;@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{return textureLoad(source,vec2i(p.xy),0);}',
      });
      this.replayCopy = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
        multisample: c.descriptor.multisample,
      });
      this.replayGroup = c.device.createBindGroup({
        layout: this.replayCopy.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: this.gbuffer }],
      });
    }
    const group = (p: GPUComputePipeline | GPURenderPipeline, resources: (GPUTextureView | GPUBufferBinding)[]) =>
      c.device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource })),
      });
    if (!host) {
      const module = c.device.createShaderModule({ code: compositeShader });
      this.composite = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
      });
    }
    this.groups = [
      group(this.extract!, [{ buffer: this.uniform! }, depthOnly, this.gbuffer]),
      group(this.occlusion!, [
        { buffer: this.uniform! },
        depthOnly,
        this.gbuffer,
        this.noise!.createView(),
        { buffer: this.samples! },
        raw,
      ]),
      group(this.blur!, [raw, this.gbuffer, x, { buffer: this.directions[0] }]),
      group(this.blur!, [x, this.gbuffer, y, { buffer: this.directions[1] }]),
    ];
    if (!host) this.groups.push(group(this.composite!, [this.scene!, this.ambient, y]));
    this.ao = y;
    this.ambientPipeline = undefined;
    this.replayPass = {
      colorAttachments: [{ view: this.replayViews[0] ?? this.gbuffer, loadOp: 'clear', storeOp: 'store' }],
    };
    this.clearPass = {
      colorAttachments: [
        {
          view: this.replayViews[1] ?? this.ambient,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    };
    this.resolvePass = {
      colorAttachments: this.replayViews.map((view, i) => ({
        view,
        resolveTarget: i === 0 ? this.gbuffer! : this.ambient!,
        loadOp: 'load',
        storeOp: 'discard',
      })),
    };
    this.geometryColors[0].view = this.replayViews[0] ?? this.gbuffer!;
    this.geometryColors[1].view = this.replayViews[1] ?? this.ambient!;
  }
  private dispatch(c: Context, pipeline: GPUComputePipeline, group: GPUBindGroup): void {
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(c.width / 8), Math.ceil(c.height / 8));
    pass.end();
  }
  private extractScene(c: Context): void {
    this.captureTarget!.resolve(c.encoder);
    this.dispatch(c, this.extract!, this.groups[0]);
    const gbuffer = this.replayViews[0] ?? this.gbuffer!,
      ambient = this.replayViews[1] ?? this.ambient!;
    // Replays must test the same coverage samples as the scene; their sampled outputs stay 1x.
    if (this.replayCopy) {
      const pass = c.encoder.beginRenderPass(this.replayPass!);
      pass.setPipeline(this.replayCopy);
      pass.setBindGroup(0, this.replayGroup!);
      pass.draw(3);
      pass.end();
    }
    if (this.sources.size) {
      this.geometryDepth.view = c.depth;
      const stencil = c.descriptor.depthStencil!.format.includes('stencil');
      this.geometryDepth.stencilLoadOp = stencil ? 'load' : undefined;
      this.geometryDepth.stencilStoreOp = stencil ? 'store' : undefined;
      const pass = c.encoder.beginRenderPass(this.geometryPass);
      try {
        for (const source of this.sources)
          source.draw(c, 'occlusion', gbuffer, c.depth, 'all', {
            pass,
            view: viewMatrix(this.drawView, c.camera),
            depthCompare: 'equal',
          });
      } finally {
        pass.end();
      }
    } else c.encoder.beginRenderPass(this.clearPass!).end();
    // Convention: a plugin that replaces the ambient light (environment IBL) names it `let margoAmbient=`. Then the replay keeps the
    // whole shader and only returns margoAmbient (`_=` keeps every binding statically used, so all of c.bindings fit the layout).
    if (this.ambientSource !== c.shader) {
      this.ambientSource = c.shader;
      this.ambientAll = c.shader.includes('let margoAmbient=');
      this.ambientCode = this.ambientAll
        ? c.shader.replace(/(let direct=[\s\S]*)return (vec4f\([^\n]+\));/, '$1_=$2;return vec4f(margoAmbient,1);')
        : c.shader.replace(
            /let direct=[\s\S]*return vec4f\([^\n]+\);/,
            c.shader.includes('skyAmbient.rgb')
              ? 'return vec4f(i.color*(1.0-i.material.y)*skyAmbient.rgb,1);'
              : 'return vec4f(i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb,1);',
          );
    }
    const code = this.ambientCode;
    if (!this.ambientPipeline || this.ambientShader !== code) {
      if (code === c.shader) throw new Error('SSAO requires the standard core lighting shader');
      const module = c.device.createShaderModule({ code });
      this.ambientPipeline = c.device.createRenderPipeline({
        ...c.descriptor,
        layout: 'auto',
        vertex: { ...c.descriptor.vertex, module },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
        depthStencil: { ...c.descriptor.depthStencil!, depthWriteEnabled: false, depthCompare: 'equal' },
      });
      this.ambientShader = code;
    }
    const color = c.color;
    c.color = ambient;
    // Retain TAA's vertex camera and Sky's absolute ambient color when either is used by the replay.
    try {
      c.draw({
        pipeline: this.ambientPipeline,
        clear: false,
        bindings: this.ambientAll
          ? c.bindings
          : c.bindings.filter(
              (entry) => entry.binding === 18 || (entry.binding === 8 && c.shader.includes('skyAmbient.rgb')),
            ),
      });
    } finally {
      c.color = color;
    }
    if (this.replayViews.length) c.encoder.beginRenderPass(this.resolvePass!).end();
    // A PostStack resolves its shared capture once, after every effect has replayed into it.
    if (!this.host) this.captureTarget!.resolve(c.encoder, true);
  }
  private release(): void {
    if (!this.host) this.captureTarget?.dispose();
    this.captureTarget = undefined;
    this.ao = this.input = undefined;
    this.key = '';
    for (const t of this.textures) t.destroy();
    for (const b of this.directions) b.destroy();
    this.uniform?.destroy();
    this.samples?.destroy();
    this.noise?.destroy();
    this.textures = [];
    this.directions = [];
    this.groups = [];
    this.width = this.height = 0;
    this.uniform = this.samples = undefined;
    this.noise = undefined;
    this.extract = this.occlusion = this.blur = undefined;
    this.composite = this.ambientPipeline = undefined;
    this.original = this.scene = this.depth = this.gbuffer = this.ambient = undefined;
    this.originalFormat = undefined;
    this.replayViews = [];
    this.replayCopy = undefined;
    this.replayGroup = undefined;
    this.replayPass = this.clearPass = this.resolvePass = undefined;
    this.geometryColors[0].view = this.geometryColors[1].view = this.geometryDepth.view = undefined!;
    this.geometryDepth.stencilLoadOp = this.geometryDepth.stencilStoreOp = undefined;
    this.compositeAttachment.view = undefined!;
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
    this.sources.clear();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
