/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { CAPS, JOINS, MODES, VERTICES_PER_SEGMENT } from './geometry.js';
import { Line } from './line.js';
import { foggedLineShader, lineShader } from './shader.js';
import { checkFog, FOG_BYTES, writeFog, type FogLike } from './fog.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

interface Resources {
  uniform: GPUBuffer;
  points: GPUBuffer;
  colors: GPUBuffer;
  group: GPUBindGroup;
  capacity: number;
  version: number;
  style: ArrayBuffer;
  floats: Float32Array;
  uints: Uint32Array;
  written: Float32Array;
}

let warned = false;

/** Options for the `Lines` plugin. An empty name or non-finite order throws a TypeError. */
export interface LinesOptions {
  /** Plugin name, unique per engine. Default 'lines'. */
  name?: string;
  /** Frame graph order. Default 20: after the scene and particles, before post-processing resolves at 30. */
  order?: number;
}

/**
 * Engine plugin that draws `Line` objects and helpers in one render pass over the scene color and depth.
 * WebGPU only; on the WebGL2 backend it warns once and draws nothing.
 */
export class Lines implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  /** Lines and draw calls of the latest frame. */
  readonly stats = { lines: 0, segments: 0, drawCalls: 0 };
  private readonly members = new Set<Line>();
  private readonly resources = new Map<Line, Resources>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private engine?: Engine;
  private device?: GPUDevice;
  private module?: GPUShaderModule;
  private layouts?: { frame: GPUBindGroupLayout; style: GPUBindGroupLayout; pipeline: GPUPipelineLayout };
  private frameBuffer?: GPUBuffer;
  private frameGroup?: GPUBindGroup;
  private readonly frameData = new Float32Array(24);
  private readonly depthLines: Array<[Line, Resources]> = [];
  private readonly topLines: Array<[Line, Resources]> = [];
  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'load',
    storeOp: 'store',
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthReadOnly: true,
    stencilReadOnly: true,
  };
  private readonly descriptor: GPURenderPassDescriptor = {
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: this.depthAttachment,
  };
  private fogSource: FogLike | null = null;
  private fogGpu?: {
    layout: GPUBindGroupLayout;
    pipeline: GPUPipelineLayout;
    module: GPUShaderModule;
    buffer: GPUBuffer;
    group: GPUBindGroup;
  };
  private readonly fogData = new Float32Array(12);

  /** Same as `engine.use(new Lines(...))`; returns the Lines. */
  static attach(engine: EngineKernel, options?: LinesOptions): Lines {
    const value = new Lines(options);
    engine.use(value);
    return value;
  }
  constructor(options: LinesOptions = {}) {
    this.name = options.name ?? 'lines';
    this.order = options.order ?? 20;
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw new TypeError('Invalid Lines options');
  }

  /** Lines currently drawn by this plugin. */
  get lines(): ReadonlySet<Line> {
    return this.members;
  }

  /** The fog lines are drawn in (see `setFog`), or null. */
  get fog(): FogLike | null {
    return this.fogSource;
  }

  /**
   * Fogs every line whose material has `fog` true (the default): `fog` is `@margoengine/environment`'s `Fog` or any
   * object with its fields, read every frame, with Fog's maths (linear near/far, exp2 density, height falloff). A line
   * fades toward the fog colour by the distance of its centre line. `null` (the default) draws exactly as without fog.
   * The first fogged frame compiles a second shader; changing the fog or its `enabled` flag never does.
   * @throws TypeError when `fog` is neither an object nor null; RangeError or TypeError for an invalid field.
   */
  setFog(fog: FogLike | null): this {
    this.fogSource = checkFog(fog);
    return this;
  }

  add<T extends Line>(line: T): T {
    if (!(line instanceof Line)) throw new TypeError('Expected a Line');
    line.bind(this);
    this.members.add(line);
    return line;
  }

  remove(line: Line): void {
    if (!this.members.delete(line)) return;
    this.release(line);
    line.bind(undefined);
  }

  clear(): void {
    for (const line of [...this.members]) this.remove(line);
  }

  setup(engine: Engine): void {
    this.engine = engine;
    if (engine.backend !== 'webgpu' || !engine.gpu) {
      if (!warned) {
        warned = true;
        console.warn('@margoengine/lines: the WebGL2 backend is not supported, lines will not be drawn.');
      }
      return;
    }
    const device = (this.device = engine.gpu);
    const uniform = (size: number, visibility: number): GPUBindGroupLayoutEntry => ({
      binding: 0,
      visibility,
      buffer: { type: 'uniform', minBindingSize: size },
    });
    const frame = device.createBindGroupLayout({
      entries: [uniform(96, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT)],
    });
    const style = device.createBindGroupLayout({
      entries: [
        uniform(128, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: 16 } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: 16 } },
      ],
    });
    this.layouts = { frame, style, pipeline: device.createPipelineLayout({ bindGroupLayouts: [frame, style] }) };
    this.module = device.createShaderModule({ code: lineShader });
    this.frameBuffer = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameGroup = device.createBindGroup({
      layout: frame,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  private pipeline(
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    onTop: boolean,
    count: number,
    fogged = false,
  ): GPURenderPipeline {
    const key = `${format}|${depthFormat}|${onTop}|${count}${fogged ? '|fog' : ''}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const fog = fogged ? this.fogResources() : undefined,
        module = fog?.module ?? this.module!;
      pipeline = this.device!.createRenderPipeline({
        layout: fog?.pipeline ?? this.layouts!.pipeline,
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count },
        depthStencil: {
          format: depthFormat,
          depthWriteEnabled: false,
          depthCompare: onTop ? 'always' : 'greater-equal',
        },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** The fog uniform, its group 2 and the fogged shader, made on the first fogged frame. */
  private fogResources(): NonNullable<Lines['fogGpu']> {
    if (this.fogGpu) return this.fogGpu;
    const device = this.device!,
      layouts = this.layouts!,
      layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: FOG_BYTES } },
        ],
      }),
      module = device.createShaderModule({ code: foggedLineShader() }),
      buffer = device.createBuffer({ size: FOG_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return (this.fogGpu = {
      layout,
      module,
      buffer,
      pipeline: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.style, layout] }),
      group: device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }] }),
    });
  }

  private ensure(line: Line): Resources {
    const device = this.device!,
      colors = line.colors;
    let r = this.resources.get(line);
    if (r && r.capacity === line.capacityVersion) return r;
    if (r) this.release(line);
    const created: GPUBuffer[] = [];
    try {
      const make = (size: number, usage: number) => {
        const buffer = device.createBuffer({ size, usage });
        created.push(buffer);
        return buffer;
      };
      const uniform = make(128, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const points = make(Math.max(16, line.points.byteLength), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const colorBuffer = make(
        Math.max(16, colors?.byteLength ?? 16),
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      const group = device.createBindGroup({
        layout: this.layouts!.style,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: points } },
          { binding: 2, resource: { buffer: colorBuffer } },
        ],
      });
      const style = new ArrayBuffer(128);
      r = {
        uniform,
        points,
        colors: colorBuffer,
        group,
        capacity: line.capacityVersion,
        version: -1,
        style,
        floats: new Float32Array(style),
        uints: new Uint32Array(style),
        written: new Float32Array(32).fill(NaN),
      };
    } catch (error) {
      for (const buffer of created) buffer.destroy();
      throw error;
    }
    this.resources.set(line, r);
    return r;
  }

  private release(line: Line): void {
    const r = this.resources.get(line);
    if (!r) return;
    r.uniform.destroy();
    r.points.destroy();
    r.colors.destroy();
    this.resources.delete(line);
  }

  private readonly execute = (context: PassContext): void => {
    this.stats.lines = this.stats.segments = this.stats.drawCalls = 0;
    if (context.backend !== 'webgpu' || !this.device || !this.engine) return;
    if (context.device !== this.device) return;
    const engine = this.engine as unknown as EngineKernel,
      device = this.device;
    this.depthLines.length = this.topLines.length = 0;
    for (const line of this.members) {
      if (!line.visible || line.update(engine) === false) continue;
      const mesh = line.attachedMesh,
        model = mesh ? meshWorldMatrix(engine, mesh) : line.matrix;
      if (!model) continue;
      const segments = line.segmentCount,
        material = line.material;
      if (!segments) continue;
      material.validate();
      if (material.dashed) line.updateDistances(model);
      const r = this.ensure(line);
      if (r.version !== line.version) {
        device.queue.writeBuffer(r.points, 0, line.points as Float32Array<ArrayBuffer>, 0, line.count * 4);
        if (line.colors)
          device.queue.writeBuffer(r.colors, 0, line.colors as Float32Array<ArrayBuffer>, 0, line.count * 4);
        r.version = line.version;
      }
      const f = r.floats,
        u = r.uints;
      f.set(model, 0);
      f.set(material.color, 16);
      f[19] = material.opacity;
      f[20] = material.width;
      f[21] = material.miterLimit;
      f[22] = material.dashSize;
      f[23] = material.gapSize;
      f[24] = material.dashOffset;
      f[25] = line.totalDistance;
      f[26] = material.antialias ? 1 : 0;
      f[27] = 0;
      const vertexColors = (material.vertexColors ?? true) && line.colors !== null;
      u[28] = MODES.indexOf(line.mode);
      u[29] = line.count;
      u[30] =
        JOINS.indexOf(material.join) |
        (CAPS.indexOf(material.cap) << 2) |
        (material.worldUnits ? 16 : 0) |
        (material.dashed ? 32 : 0) |
        (vertexColors ? 64 : 0);
      u[31] = 0;
      let changed = false;
      for (let i = 0; i < 32; i++)
        if (!Object.is(r.written[i], f[i])) {
          changed = true;
          break;
        }
      if (changed) {
        device.queue.writeBuffer(r.uniform, 0, r.style);
        r.written.set(f);
      }
      (material.onTop ? this.topLines : this.depthLines).push([line, r]);
      this.stats.lines++;
      this.stats.segments += segments;
    }
    if (!this.depthLines.length && !this.topLines.length) return;
    const canvas = engine.canvas,
      data = this.frameData,
      camera = context.camera,
      m = camera.matrix;
    data.set(m, 0);
    data[16] = context.width;
    data[17] = context.height;
    data[18] = canvas.clientWidth ? context.width / canvas.clientWidth : 1;
    // Pixels per world unit at clip w 1. Orthographic (clip w constant, e.g. @margoengine/cameras): from the y row's length.
    data[19] =
      m[3] || m[7] || m[11]
        ? (0.5 * context.height) / Math.tan((camera.fov * Math.PI) / 360)
        : 0.5 * context.height * Math.hypot(m[1], m[5], m[9]);
    data[20] = context.format.endsWith('-srgb') || context.format.includes('float') ? 0 : 1;
    device.queue.writeBuffer(this.frameBuffer!, 0, data);
    const fog = this.fogSource;
    let fogged = false;
    if (fog)
      for (const list of [this.depthLines, this.topLines]) for (const [line] of list) fogged ||= line.material.fog;
    if (fogged) {
      writeFog(fog!, camera.position, this.fogData);
      device.queue.writeBuffer(this.fogResources().buffer, 0, this.fogData);
    }
    this.colorAttachment.view = context.color;
    this.depthAttachment.view = context.depth;
    const depthFormat = context.descriptor.depthStencil!.format,
      count = context.descriptor.multisample?.count ?? 1;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    pass.setBindGroup(0, this.frameGroup!);
    if (fogged) pass.setBindGroup(2, this.fogGpu!.group);
    for (const [list, onTop] of [
      [this.depthLines, false],
      [this.topLines, true],
    ] as const) {
      if (!list.length) continue;
      const plain = this.pipeline(context.format, depthFormat, onTop, count);
      let current = plain;
      pass.setPipeline(plain);
      for (const [line, r] of list) {
        if (fogged) {
          const next = line.material.fog ? this.pipeline(context.format, depthFormat, onTop, count, true) : plain;
          if (next !== current) pass.setPipeline((current = next));
        }
        pass.setBindGroup(1, r.group);
        pass.draw(VERTICES_PER_SEGMENT, line.segmentCount);
        this.stats.drawCalls++;
      }
    }
    pass.end();
    this.depthLines.length = this.topLines.length = 0;
  };

  onDeviceRestored(engine: Engine): void {
    this.releaseGpu();
    this.setup(engine);
  }

  private releaseGpu(): void {
    for (const line of [...this.resources.keys()]) this.release(line);
    this.frameBuffer?.destroy();
    this.fogGpu?.buffer.destroy();
    this.frameBuffer = this.frameGroup = this.module = this.layouts = this.device = this.fogGpu = undefined;
    this.pipelines.clear();
  }

  /** Releases every GPU resource. Lines stay registered, so the plugin can be used again. */
  dispose(): void {
    this.releaseGpu();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
