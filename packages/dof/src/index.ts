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
import { render, group, compute } from '../../shared/gpu.js';
import { orthographic } from '../../shared/projection.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { cocShader, coarseShader, bokehShader, presentShader, groupMax } from './shaders.js';
import { MargoError } from '@margoengine/math/errors';
import { applyView, viewLoadOp, viewSize } from '../../shared/view-rect.js';
import { coreShaderRequired, linearShader } from '../../shared/display.js';
import { loadCompatRoute } from '../../shared/compat.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  STORAGE_BINDING: number;
  COPY_SRC: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Lens settings, read from `dof.options` every frame. */
export interface DOFOptions {
  /** Scene units, measured along the camera's viewing axis. Default 5. */
  focalDistance?: number;
  /** Same units as focalDistance; default 0.05 for a metre-based scene. */
  focalLength?: number;
  /** Lens f-number, default 2.8. */
  aperture?: number;
  /** Maximum disk radius in pixels, 1-32. Default 16. */
  maxRadius?: number;
  /** False skips the blur and presents the scene sharp. Default true; also settable as `dof.enabled`. */
  enabled?: boolean;
}

/**
 * Depth of field: thin-lens circle of confusion from reversed-Z depth, near and far bokeh gathered separately; reads
 * `dof.options` each frame. `DOF.attach(engine, options)` alone, or inside a `PostStack` to combine it with SSAO,
 * Bloom, Tonemap or FXAA. WebGPU only.
 * @throws RangeError when an option is out of range or the lens scale overflows float32; TypeError when `enabled` is
 * not a boolean.
 * @throws MargoError `'unsupported'` on a WebGL engine or when another plugin replaced core's lighting shader,
 * `'disposed'` after `dispose()`, `'attached'` when attached twice, `'state'` when SSAO, Bloom or PostProcessing owns
 * the scene capture.
 */
export class DOF implements EnginePlugin {
  readonly name = 'dof';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private cocPipeline?: GPUComputePipeline;
  private bokehPipeline?: GPUComputePipeline;
  private coarsePipeline?: GPUComputePipeline;
  // The WebGL2 layer's route (./compat.js): the CoC kernel without tile maxima, which this pass computes instead.
  private tilesPipeline?: GPUComputePipeline;
  private tilesGroup?: GPUBindGroup;
  private presentPipeline?: GPURenderPipeline;
  private scene?: GPUTexture;
  private depth?: GPUTexture;
  private coc?: GPUTexture;
  private tiles?: GPUTexture;
  private coarse?: GPUTexture;
  private output?: GPUTexture;
  private sceneView?: GPUTextureView;
  private depthView?: GPUTextureView;
  private groups: GPUBindGroup[] = [];
  private originalColor?: GPUTextureView;
  private originalDepth?: GPUTextureView;
  private format?: GPUTextureFormat;
  private depthFormat?: GPUTextureFormat;
  private readonly values = new Float32Array(12);
  private readonly shaders = new Map<string, string>();
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly presentation: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  private captureTarget?: SceneTarget;
  private disposed = false;
  private host?: StackHost;
  private input?: GPUTextureView;
  private sceneDepth?: GPUTexture;
  private cocView?: GPUTextureView;
  private tileView?: GPUTextureView;
  private coarseView?: GPUTextureView;
  private outputView?: GPUTextureView;
  private key = '';

  constructor(readonly options: DOFOptions = {}) {
    this.validate();
  }
  static attach(instance: EngineKernel, options: DOFOptions = {}): DOF {
    const effect = new DOF(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  get depthTexture(): GPUTexture | undefined {
    return this.host ? this.host.depthTexture : this.depth;
  }
  get outputTexture(): GPUTexture | undefined {
    return this.output;
  }
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('DOF enabled must be boolean');
    this.options.enabled = value;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw new MargoError('attached', 'DOF is already attached; create a new DOF');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const o = this.options,
      f = o.focalLength ?? 0.05,
      d = o.focalDistance ?? 5,
      a = o.aperture ?? 2.8,
      r = o.maxRadius ?? 16;
    if (
      !Number.isFinite(Math.fround(f)) ||
      Math.fround(f) <= 0 ||
      !Number.isFinite(Math.fround(d)) ||
      Math.fround(d) <= Math.fround(f) ||
      !Number.isFinite(Math.fround(a)) ||
      Math.fround(a) <= 0 ||
      !Number.isFinite(r) ||
      r < 1 ||
      r > 32 ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean')
    )
      throw new RangeError(
        'Invalid DOF options; use focalLength > 0, focalDistance > focalLength, aperture > 0 and maxRadius from 1 to 32',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'DOF requires WebGPU and a live effect; attach a new DOF to a WebGPU engine',
      );
    if (
      !this.host &&
      (engine.hasPlugin('ssao') ||
        engine.hasPlugin('bloom') ||
        engine.hasPlugin('post-processing') ||
        (engine.hasPlugin('tonemap') && !engine.hasPlugin(this.name)))
    )
      throw new MargoError('state', 'DOF owns scene capture; attach it before Tonemap, without SSAO or PostProcessing');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cocPipeline = engine.gpu.createComputePipeline({
      layout: 'auto',
      compute: { module: engine.gpu.createShaderModule({ code: cocShader }), entryPoint: 'main' },
    });
    this.bokehPipeline = compute(engine.gpu, bokehShader);
    this.coarsePipeline = compute(engine.gpu, coarseShader);
    const uniform = this.uniform;
    loadCompatRoute(engine.gpu, () => import('./compat.js'))?.then(({ dofCompatPipelines }) => {
      if (this.uniform !== uniform) return;
      ({
        coc: this.cocPipeline,
        tiles: this.tilesPipeline,
        bokeh: this.bokehPipeline,
      } = dofCompatPipelines(engine.gpu!, { cocShader, bokehShader, groupMax }));
      this.releaseTextures();
    });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'dof:capture',
      order: -55,
      execute: (c) => {
        if (c.backend === 'webgpu') this.capture(c);
      },
    });
    if (this.host) return;
    graph.add({
      name: 'dof:coc',
      order: 20,
      execute: (c) => {
        if (c.backend === 'webgpu') this.circles(c);
      },
    });
    graph.add({
      name: 'dof:bokeh',
      order: 21,
      execute: (c) => {
        if (c.backend === 'webgpu') this.blur(c);
      },
    });
    graph.add({
      name: 'dof:present',
      order: 30,
      execute: (c) => {
        if (c.backend === 'webgpu') this.present(c);
      },
    });
  }
  private capture(c: Context): void {
    this.validate();
    const o = this.options,
      v = this.values;
    const [, viewHeight] = viewSize(c);
    v[0] = o.focalDistance ?? 5;
    v[1] = o.focalLength ?? 0.05;
    v[2] = o.aperture ?? 2.8;
    v[3] = o.maxRadius ?? 16;
    v[4] = c.camera.near;
    v[5] = c.camera.far;
    v[6] = (v[1] * viewHeight) / (4 * v[2] * (v[0] - v[1]) * Math.tan((c.camera.fov * Math.PI) / 360));
    v[7] = +this.enabled;
    v[8] = 0;
    // Orthographic clip matrix (e.g. @margoengine/cameras): linear depth and a blur linear in defocus, scaled like a
    // perspective lens whose pixel size at the focal distance matches the orthographic zoom.
    const ortho = orthographic(c.camera.matrix, c.camera.position);
    if (ortho) {
      v[4] = ortho.near;
      v[5] = ortho.far;
      v[6] = (v[1] * viewHeight * ortho.sy * v[0]) / (4 * v[2] * (v[0] - v[1]));
      v[8] = 1;
    }
    if (!Number.isFinite(v[6]))
      throw new RangeError(
        'DOF lens scale exceeds float32; use a larger aperture or a focalDistance further from focalLength',
      );
    if (!this.host) {
      if (
        this.engine!.hasPlugin('ssao') ||
        this.engine!.hasPlugin('post-processing') ||
        this.engine!.hasPlugin('bloom')
      )
        throw new MargoError(
          'state',
          'DOF cannot share scene capture with another post effect; put both effects in one PostStack',
        );
      this.resize(c);
      this.originalColor = c.color;
      this.originalDepth = c.depth;
      let shader = this.shaders.get(c.shader);
      if (shader === undefined) {
        shader = linearShader(c.shader);
        if (shader === c.shader) throw new MargoError('unsupported', coreShaderRequired('DOF'));
        this.shaders.set(c.shader, shader);
      }
      c.shader = shader;
      this.captureTarget!.begin(c);
    }
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
  }
  private resize(c: Context): void {
    const depthFormat = c.descriptor.depthStencil!.format;
    if (
      this.presentPipeline &&
      this.scene?.width === c.width &&
      this.scene.height === c.height &&
      this.format === c.format &&
      this.depthFormat === depthFormat &&
      this.captureTarget?.samples === (c.descriptor.multisample?.count ?? 4)
    )
      return;
    this.releaseTextures();
    this.format = c.format;
    this.depthFormat = depthFormat;
    const sampled = GPUTextureUsage.TEXTURE_BINDING;
    this.scene = c.device.createTexture({
      size: [c.width, c.height],
      format: 'rgba16float',
      usage: sampled | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depth = c.device.createTexture({
      size: [c.width, c.height],
      format: depthFormat,
      usage: sampled | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.targets(c.device, c.width, c.height);
    this.captureTarget = new SceneTarget(c.device, this.scene, this.depth, c.descriptor.multisample?.count ?? 4);
    this.sceneView = this.scene.createView();
    this.depthView = this.depth.createView();
    const cocView = this.cocView!,
      outputView = this.outputView!,
      tileView = this.tileView!,
      coarseView = this.coarseView!;
    const module = c.device.createShaderModule({ code: presentShader });
    this.presentPipeline = c.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
      multisample: c.descriptor.multisample,
    });
    this.groups = [
      this.cocGroup(c.device, this.depth, true),
      c.device.createBindGroup({
        layout: this.bokehPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: this.sceneView },
          { binding: 2, resource: cocView },
          { binding: 3, resource: outputView },
          { binding: 4, resource: tileView },
          { binding: 5, resource: coarseView },
        ],
      }),
      c.device.createBindGroup({
        layout: this.presentPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: outputView }],
      }),
      group(c.device, this.coarsePipeline!, [{ buffer: this.uniform! }, this.sceneView, cocView, coarseView]),
    ];
  }
  /** The CoC pass's bind group; on the WebGL2 route also the tile pass's (`tilesGroup`). */
  private cocGroup(device: GPUDevice, depth: GPUTexture, direct = false): GPUBindGroup {
    if (this.tilesPipeline) {
      this.tilesGroup = group(device, this.tilesPipeline, [this.cocView!, this.tileView!]);
      return group(device, this.cocPipeline!, [
        { buffer: this.uniform! },
        depth.createView({ aspect: 'depth-only' }),
        this.cocView!,
      ]);
    }
    // The WebGPU route keeps its calls in the order the proofs recorded (layout first when made directly).
    if (direct)
      return device.createBindGroup({
        layout: this.cocPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: depth.createView({ aspect: 'depth-only' }) },
          { binding: 2, resource: this.cocView! },
          { binding: 3, resource: this.tileView! },
        ],
      });
    return group(device, this.cocPipeline!, [
      { buffer: this.uniform! },
      depth.createView({ aspect: 'depth-only' }),
      this.cocView!,
      this.tileView!,
    ]);
  }

  /** CoC and 8x8 tile maxima: one kernel on WebGPU, two on the WebGL2 route. */
  private circles(c: Context): void {
    this.dispatch(c, this.cocPipeline!, this.groups[0]);
    if (this.tilesPipeline) this.dispatch(c, this.tilesPipeline, this.tilesGroup!, 64);
  }
  private blur(c: Context): void {
    this.dispatch(c, this.coarsePipeline!, this.groups[3], 16);
    this.dispatch(c, this.bokehPipeline!, this.groups[1]);
  }
  private dispatch(c: Context, pipeline: GPUComputePipeline, group: GPUBindGroup, block = 8): void {
    if (pipeline === this.cocPipeline) this.captureTarget?.resolve(c.encoder, true);
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(c.width / block), Math.ceil(c.height / block));
    pass.end();
  }
  private present(c: Context): void {
    this.attachment.view = this.originalColor!;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.presentPipeline!);
    pass.setBindGroup(0, this.groups[2]);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
    this.captureTarget!.restore(c);
  }
  /** Stacked: blur `input` by the shared depth into outputTexture, handed on as linear light or presented as the display output. */
  private stage(c: Context, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    const device = c.device,
      depth = this.host!.depthTexture!,
      key = output.format + output.multisample.count;
    if (this.coc?.width !== c.width || this.coc.height !== c.height) {
      this.releaseTextures();
      this.targets(device, c.width, c.height);
    }
    if (this.sceneDepth !== depth) {
      this.sceneDepth = depth;
      this.groups[0] = this.cocGroup(device, depth);
    }
    if (this.input !== input) {
      this.input = input;
      this.groups[1] = group(device, this.bokehPipeline!, [
        { buffer: this.uniform! },
        input,
        this.cocView!,
        this.outputView!,
        this.tileView!,
        this.coarseView!,
      ]);
      this.groups[3] = group(device, this.coarsePipeline!, [
        { buffer: this.uniform! },
        input,
        this.cocView!,
        this.coarseView!,
      ]);
    }
    this.circles(c);
    this.blur(c);
    if (output.hdr) return this.outputView;
    if (this.key !== key) {
      this.key = key;
      this.presentPipeline = render(device, presentShader, output.format, { multisample: output.multisample });
      this.groups[2] = group(device, this.presentPipeline, [this.outputView!]);
    }
    this.attachment.view = output.view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.presentPipeline!);
    pass.setBindGroup(0, this.groups[2]);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  /** CoC (radius, view depth), the blurred output, 8x8-tile near-radius maxima and 2x2-block wide far gathers. */
  private targets(device: GPUDevice, width: number, height: number): void {
    const storage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    this.coc = device.createTexture({ size: [width, height], format: 'rg32float', usage: storage });
    this.output = device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: storage | GPUTextureUsage.COPY_SRC,
    });
    this.tiles = device.createTexture({
      size: [Math.ceil(width / 8), Math.ceil(height / 8)],
      format: 'r32float',
      usage: storage,
    });
    this.coarse = device.createTexture({
      size: [Math.ceil(width / 2), Math.ceil(height / 2)],
      format: 'rgba16float',
      usage: storage,
    });
    this.cocView = this.coc.createView();
    this.outputView = this.output.createView();
    this.tileView = this.tiles.createView();
    this.coarseView = this.coarse.createView();
  }
  private releaseTextures(): void {
    this.captureTarget?.dispose();
    this.captureTarget = undefined;
    this.scene?.destroy();
    this.depth?.destroy();
    this.coc?.destroy();
    this.output?.destroy();
    this.tiles?.destroy();
    this.coarse?.destroy();
    this.scene = this.depth = this.coc = this.output = this.tiles = this.coarse = undefined;
    this.sceneView = this.depthView = undefined;
    this.groups = [];
    this.presentPipeline = undefined;
    this.input = this.sceneDepth = this.cocView = this.outputView = this.tileView = this.coarseView = undefined;
    this.key = '';
  }
  private release(): void {
    this.releaseTextures();
    this.uniform?.destroy();
    this.uniform = undefined;
    this.cocPipeline = this.bokehPipeline = this.coarsePipeline = this.tilesPipeline = undefined;
    this.originalColor = this.originalDepth = undefined;
    this.shaders.clear();
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
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
