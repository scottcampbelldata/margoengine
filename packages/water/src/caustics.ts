/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { PostStack } from '@margoengine/post/stack';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fault, rangeError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { group, render } from '../../shared/gpu.js';
import type { Water, WaterShadowSource } from './index.js';
import type { FFTOcean } from './fft.js';
import { queryStates, type QueryState } from './query-state.js';
import { surfacePass } from './surface-pass.js';
import { SurfaceCapture } from './surface-capture.js';
import { causticBeams, causticCopy, causticProject, causticRange } from './caustics-shader.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Live settings except surface, resolution and layers, which are copied. */
export interface CausticsOptions {
  /** Live Water or FFTOcean in the same engine and scene. Required. */
  surface: Water | FFTOcean;
  /** World-space map width and water-field width, 0.1..100000 m. Default 100. */
  size?: number;
  /** Bottom and top world-space receiver heights. Default [-20, 0]. */
  heightRange?: readonly [number, number];
  /** Map side, power of two 32..2048. Default 256. */
  resolution?: number;
  /** Horizontal depth slices, integer 2..32. Default 12. */
  layers?: number;
  /** Additional refracted direct-light multiplier, 0..100. Default 1. */
  intensity?: number;
  /** RGB absorption per metre, each 0..100. Default [0.38, 0.1, 0.045]. */
  absorption?: readonly [number, number, number];
  /** Linear RGB light tint, each 0..100. Default [1, 1, 1]. */
  color?: readonly [number, number, number];
  /** Water/air index ratio, 1..2. Default 1.333. */
  refractiveIndex?: number;
  /** Shadows source for surface-entry and receiver occlusion. Default none. */
  shadows?: WaterShadowSource;
  /** False preserves the scene. Default true. */
  enabled?: boolean;
}

/** Refracted wave beams light opaque submerged geometry before the water draw. */
export class Caustics implements EnginePlugin {
  readonly name = 'water:caustics';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private disposed = false;
  private removePass?: () => void;
  private readonly surface: Water | FFTOcean;
  private readonly resolution: number;
  private readonly layers: number;
  private readonly values = new Float32Array(96);
  private readonly workspace = new Float64Array(52);
  private readonly capture = new SurfaceCapture();
  private uniform?: GPUBuffer;
  private coordinates?: GPUBuffer;
  private token?: GPUBuffer;
  private sampler?: GPUSampler;
  private opaque?: GPUTexture;
  private depth?: GPUTexture;
  private masks: GPUTexture[] = [];
  private depths: GPUTexture[] = [];
  private maps: GPUTexture[] = [];
  private beam?: GPURenderPipeline;
  private range?: GPUBuffer;
  private measure?: GPUComputePipeline;
  private reduce?: GPUComputePipeline;
  private project?: GPURenderPipeline;
  private readonly copies = new Map<string, GPURenderPipeline>();
  private beamShadow = '';
  private beamShader = '';
  private projectKey = '';
  private prepared?: GPUCommandEncoder;

  constructor(readonly options: CausticsOptions) {
    this.validate();
    if (!queryStates.has(options.surface)) throw fault('state', 'Caustics surface must be Water or FFTOcean');
    this.surface = options.surface;
    this.resolution = options.resolution ?? 256;
    this.layers = options.layers ?? 12;
  }
  /** Attach alone; to combine effects add new Caustics(options) to a PostStack. */
  static attach(engine: EngineKernel, options: CausticsOptions): Caustics {
    const effect = new Caustics(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  private validate(): void {
    const o = this.options;
    if (!o || typeof o !== 'object') throw fault('state', 'Caustics needs options.surface');
    for (const [name, min, max, integer] of [
      ['size', 0.1, 100000, false],
      ['resolution', 32, 2048, true],
      ['layers', 2, 32, true],
      ['intensity', 0, 100, false],
      ['refractiveIndex', 1, 2, false],
    ] as const) {
      const value = o[name];
      if (
        value !== undefined &&
        (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      )
        throw rangeError(`Caustics ${name} must be ${integer ? 'an integer' : 'finite'} in ${min}..${max}`, 'geometry');
    }
    if (o.resolution !== undefined && o.resolution & (o.resolution - 1))
      throw rangeError('Caustics resolution must be a power of two', 'geometry');
    const range = o.heightRange;
    if (
      range !== undefined &&
      (range.length !== 2 ||
        !range.every(Number.isFinite) ||
        range[0] >= range[1] ||
        Math.fround(range[0]) >= Math.fround(range[1]) ||
        range.some((v) => Math.abs(v) > 100000))
    )
      throw rangeError('Caustics heightRange needs finite bottom < top, each in -100000..100000 m', 'geometry');
    for (const name of ['absorption', 'color'] as const) {
      const value = o[name];
      if (value !== undefined && (value.length !== 3 || value.some((v) => !Number.isFinite(v) || v < 0 || v > 100)))
        throw rangeError(`Caustics ${name} needs three finite channels in 0..100`, 'geometry');
    }
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw fault('state', 'Caustics enabled must be boolean');
    if (o.shadows !== undefined && (typeof o.shadows.pbr !== 'function' || typeof o.shadows.bindings !== 'function'))
      throw fault('state', 'Caustics shadows must expose pbr and bindings');
  }
  private joinStack(host: StackHost): StackStage {
    if (this.disposed) throw fault('disposed', 'Caustics is disposed; create another Caustics');
    if (this.host || this.engine)
      throw fault('attached', 'Caustics is already attached; create another Caustics for the other stack', 'state');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.copy(c, input, output) };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'Caustics is disposed; create another Caustics');
    if (this.engine)
      throw fault('attached', 'Caustics is already attached; create another Caustics for the other stack', 'state');
    if (!this.host) throw fault('state', 'Use Caustics.attach or add Caustics to a PostStack');
    if (!engine.gpu) throw fault('unsupported', 'Caustics requires WebGPU or full WebGL2 compatibility', 'webgpu');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 384, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = engine.gpu.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.removePass = surfacePass(this.surface, 0, (c) => this.illuminate(c));
  }
  private textures(c: Context): void {
    const target = this.host!.target!;
    if (
      this.opaque?.width === c.width &&
      this.opaque.height === c.height &&
      this.opaque.format === target.resolvedColor.format
    )
      return;
    this.releaseTextures();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.opaque = c.device.createTexture({
      size: [c.width, c.height],
      format: target.resolvedColor.format,
      usage: usage | GPUTextureUsage.COPY_DST,
    });
    this.depth = c.device.createTexture({ size: [c.width, c.height], format: 'depth32float', usage });
    for (const [width, height] of [
      [c.width, c.height],
      [this.resolution, this.resolution],
      [1, 1],
    ]) {
      this.masks.push(c.device.createTexture({ size: [width, height], format: 'rgba32float', usage }));
      this.depths.push(c.device.createTexture({ size: [width, height], format: 'depth32float', usage }));
    }
    for (let i = 0; i < 3; i++)
      this.maps.push(
        c.device.createTexture({ size: [this.resolution, this.resolution, this.layers], format: 'rgba16float', usage }),
      );
  }
  private buildBeams(c: Context, state: QueryState, shadow: string): void {
    if (this.token === state.token && this.beamShadow === shadow && this.beamShader === state.shader) return;
    this.coordinates?.destroy();
    this.coordinates = undefined;
    if (state.positions) {
      this.coordinates = c.device.createBuffer({
        size: state.positions.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      c.device.queue.writeBuffer(this.coordinates, 0, state.positions as Float32Array<ArrayBuffer>);
    }
    const module = c.device.createShaderModule({ code: causticBeams(state, shadow) });
    const blend = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    } as const;
    this.beam = c.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'beamVertex' },
      fragment: {
        module,
        entryPoint: 'beamFragment',
        targets: Array.from({ length: 3 }, () => ({ format: 'rgba16float', blend })),
      },
      primitive: { cullMode: 'none' },
    });
    this.token = state.token;
    this.beamShadow = shadow;
    this.beamShader = state.shader;
    this.range?.destroy();
    this.range = c.device.createBuffer({
      size: Math.ceil((state.segments ** 2 * 2) / 64) * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    const range = c.device.createShaderModule({ code: causticRange(state) });
    this.measure = c.device.createComputePipeline({
      layout: 'auto',
      compute: { module: range, entryPoint: 'measure' },
    });
    this.reduce = c.device.createComputePipeline({ layout: 'auto', compute: { module: range, entryPoint: 'reduce' } });
  }
  private illuminate(c: Context): boolean {
    this.validate();
    const o = this.options,
      target = this.host?.target,
      state = queryStates.get(this.surface)?.();
    if (
      !target ||
      !state ||
      state.device !== c.device ||
      this.engine!.sceneOf(this) !== this.engine!.sceneOf(this.surface)
    )
      throw fault('state', 'Caustics and its live surface must share an engine, scene and PostStack');
    this.prepared = c.encoder;
    if (o.enabled === false || o.intensity === 0) return false;
    this.textures(c);
    const v = this.values,
      light = this.engine!.lighting;
    v.set(c.camera.matrix);
    if (!invertMatrixStable(c.camera.matrix, v.subarray(16, 32), this.workspace))
      throw fault('state', 'Caustics needs an invertible camera');
    v.set(c.camera.position, 32);
    const length = Math.hypot(light.direction[0], light.direction[1], light.direction[2]) || 1;
    v.set(
      [light.direction[0] / length, light.direction[1] / length, light.direction[2] / length, (o.size ?? 100) / 2],
      48,
    );
    v.set([light.radiance[0], light.radiance[1], light.radiance[2], light.direction[3]], 52);
    v.set(c.view?.viewport ?? [0, 0, c.width, c.height], 56);
    v[72] = this.resolution;
    v.set([...(o.heightRange ?? [-20, 0]), this.layers, o.intensity ?? 1], 80);
    v.set([o.refractiveIndex ?? 1.333, this.resolution, 0, 0], 84);
    v.set(o.absorption ?? [0.38, 0.1, 0.045], 88);
    v.set(o.color ?? [1, 1, 1], 92);
    c.device.queue.writeBuffer(this.uniform!, 0, v);
    this.capture.draw(c, this.surface, this.uniform!, this.masks, this.depths);
    this.buildBeams(c, state, o.shadows?.pbr(2).declarations ?? '');
    const resources =
      state.kind === 'water'
        ? [
            { binding: 0, resource: { buffer: state.token } },
            { binding: 3, resource: state.resources![3] },
            { binding: 7, resource: state.resources![7] },
            ...(state.extraBindings ?? []),
          ]
        : [
            { binding: 0, resource: { buffer: state.token } },
            { binding: 1, resource: { buffer: state.field! } },
          ];
    const settings = [
      { binding: 0, resource: { buffer: this.uniform! } },
      ...(this.coordinates ? [{ binding: 1, resource: { buffer: this.coordinates } }] : []),
      { binding: 2, resource: { buffer: this.range! } },
    ];
    const first = c.device.createBindGroup({ layout: this.beam!.getBindGroupLayout(0), entries: resources });
    const second = c.device.createBindGroup({ layout: this.beam!.getBindGroupLayout(1), entries: settings });
    const measure = c.encoder.beginComputePass();
    measure.setPipeline(this.measure!);
    measure.setBindGroup(
      0,
      c.device.createBindGroup({ layout: this.measure!.getBindGroupLayout(0), entries: resources }),
    );
    measure.setBindGroup(
      1,
      c.device.createBindGroup({ layout: this.measure!.getBindGroupLayout(1), entries: settings }),
    );
    measure.dispatchWorkgroups(Math.ceil((state.segments ** 2 * 2) / 64));
    measure.end();
    const reduce = c.encoder.beginComputePass();
    reduce.setPipeline(this.reduce!);
    reduce.setBindGroup(
      1,
      c.device.createBindGroup({
        layout: this.reduce!.getBindGroupLayout(1),
        entries: [{ binding: 2, resource: { buffer: this.range! } }],
      }),
    );
    reduce.dispatchWorkgroups(1);
    reduce.end();
    for (let layer = 0; layer < this.layers; layer++) {
      const pass = c.encoder.beginRenderPass({
        colorAttachments: this.maps.map((map) => ({
          view: map.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
          loadOp: 'clear',
          storeOp: 'store',
        })),
      });
      pass.setPipeline(this.beam!);
      pass.setBindGroup(0, first);
      pass.setBindGroup(1, second);
      if (o.shadows)
        pass.setBindGroup(
          2,
          c.device.createBindGroup({ layout: this.beam!.getBindGroupLayout(2), entries: o.shadows.bindings() }),
        );
      pass.draw(state.segments * state.segments * 12, 1, 0, layer);
      pass.end();
    }
    target.resolve(c.encoder);
    c.encoder.copyTextureToTexture({ texture: target.resolvedColor }, { texture: this.opaque! }, [c.width, c.height]);
    target.copyDepth(c.encoder, this.depth!.createView(), 1, 'depth32float');
    const shadow = o.shadows?.pbr(1).declarations ?? '';
    const key = target.resolvedColor.format + ':' + target.samples + ':' + shadow;
    if (key !== this.projectKey) {
      const module = c.device.createShaderModule({ code: causticProject(shadow) });
      const blend = {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      } as const;
      this.project = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.resolvedColor.format, blend }] },
        multisample: { count: target.samples },
      });
      this.projectKey = key;
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: target.color, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.project!);
    pass.setBindGroup(
      0,
      group(c.device, this.project!, [
        { buffer: this.uniform! },
        this.opaque!.createView(),
        this.depth!.createView(),
        ...this.maps.map((map) => map.createView({ dimension: '2d-array' })),
        this.masks[1].createView(),
        this.sampler!,
        { buffer: this.range! },
      ]),
    );
    if (o.shadows)
      pass.setBindGroup(
        1,
        c.device.createBindGroup({ layout: this.project!.getBindGroupLayout(1), entries: o.shadows.bindings() }),
      );
    applyView(pass, c);
    pass.draw(3);
    pass.end();
    target.resolve(c.encoder);
    return true;
  }
  private copy(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    if (this.prepared !== c.encoder)
      throw fault('state', 'Render the live Caustics surface in the same scene before composition');
    const key = `${output.format}:${output.multisample.count ?? 1}:${+output.hdr}`;
    let pipeline = this.copies.get(key);
    if (!pipeline) {
      pipeline = render(c.device, causticCopy(!output.hdr), output.format, { multisample: output.multisample });
      this.copies.set(key, pipeline);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c), storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group(c.device, pipeline, [input]));
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  private releaseTextures(): void {
    for (const texture of [this.opaque, this.depth, ...this.masks, ...this.depths, ...this.maps]) texture?.destroy();
    this.opaque = this.depth = undefined;
    this.masks = [];
    this.depths = [];
    this.maps = [];
  }
  private release(): void {
    this.removePass?.();
    this.removePass = undefined;
    this.releaseTextures();
    this.capture.dispose();
    this.uniform?.destroy();
    this.coordinates?.destroy();
    this.range?.destroy();
    this.range = undefined;
    this.measure = this.reduce = undefined;
    this.uniform = this.coordinates = this.token = undefined;
    this.sampler = this.beam = this.project = undefined;
    this.projectKey = '';
    this.beamShader = '';
    this.copies.clear();
    this.prepared = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
