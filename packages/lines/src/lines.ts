/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { CAPS, JOINS, MODES, VERTICES_PER_SEGMENT } from './geometry.js';
import { Line } from './line.js';
import { fillFrame } from './math.js';
import { biasedShader, foggedLineShader, lineShader, phasedShader, pointWidthShader } from './shader.js';
import { checkFog, FOG_BYTES, writeFog, type FogLike } from '../../shared/fog.js';
import { applyView } from '../../shared/view-rect.js';
import { overlayDepthPass, overlayPass, alphaBlend } from '../../shared/pass.js';

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

/**
 * Bytes of the per-line Style uniform: model (0), color (64), a (80), b (96), flags (112: mode, count, bits, clipping
 * plane count) and 6 clipping planes (128).
 */
const STYLE_BYTES = 224;

/**
 * Pipeline variant bits: draw over the scene, fogged, write depth, a width per point, only behind the scene, a depth
 * bias; the draw step (shader.ts) sits above them.
 */
const ON_TOP = 1,
  FOGGED = 2,
  WRITE = 4,
  WIDTHS = 8,
  BEHIND = 16,
  BIAS = 32,
  STEP = 1024;

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
  /** Told when a line joins or leaves (LinePicking's stand-in meshes). */
  private readonly watchers = new Set<{ added(line: Line): void; removed(line: Line): void }>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly modules = new Map<number, GPUShaderModule>();
  private engine?: Engine;
  private device?: GPUDevice;
  private layouts?: { frame: GPUBindGroupLayout; style: GPUBindGroupLayout; pipeline: GPUPipelineLayout };
  private frameBuffer?: GPUBuffer;
  private frameGroup?: GPUBindGroup;
  private readonly frameData = new Float32Array(24);
  /** This frame's lines in draw order: depth-tested writers, depth-tested, on-top writers, on-top. */
  private readonly drawLists: Array<Array<[Line, Resources]>> = [[], [], [], []];
  private readonly descriptor = overlayPass();
  private readonly writeDescriptor = overlayDepthPass();
  private fogSource: FogLike | null = null;
  private fogGpu?: {
    layout: GPUBindGroupLayout;
    pipeline: GPUPipelineLayout;
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
      throw new TypeError('Invalid Lines options; pass the documented option types');
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
    for (const watcher of this.watchers) watcher.added(line);
    return line;
  }

  remove(line: Line): void {
    if (!this.members.delete(line)) return;
    for (const watcher of this.watchers) watcher.removed(line);
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
        uniform(STYLE_BYTES, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: 16 } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: 16 } },
      ],
    });
    this.layouts = { frame, style, pipeline: device.createPipelineLayout({ bindGroupLayouts: [frame, style] }) };
    this.module(0);
    this.frameBuffer = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameGroup = device.createBindGroup({
      layout: frame,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  /** The shader module of a variant, made when first used. */
  private module(variant: number): GPUShaderModule {
    const key = variant & ~(ON_TOP | WRITE | BEHIND);
    let module = this.modules.get(key);
    if (!module) {
      let code = variant & FOGGED ? foggedLineShader() : lineShader;
      if (variant & WIDTHS) code = pointWidthShader(code);
      if (variant & BIAS) code = biasedShader(code);
      code = phasedShader(code, Math.floor(variant / STEP));
      module = this.device!.createShaderModule({ code });
      this.modules.set(key, module);
    }
    return module;
  }

  private pipeline(
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    count: number,
    variant: number,
  ): GPURenderPipeline {
    const key = `${format}|${depthFormat}|${count}|${variant}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const fogged = (variant & FOGGED) !== 0,
        fog = fogged ? this.fogResources() : undefined,
        module = this.module(variant);
      pipeline = this.device!.createRenderPipeline({
        layout: fog?.pipeline ?? this.layouts!.pipeline,
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format,
              blend: alphaBlend,
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count },
        depthStencil: {
          format: depthFormat,
          depthWriteEnabled: (variant & WRITE) !== 0,
          depthCompare: variant & ON_TOP ? 'always' : variant & BEHIND ? 'less' : 'greater-equal',
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
      buffer = device.createBuffer({ size: FOG_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return (this.fogGpu = {
      layout,
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
      const uniform = make(STYLE_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
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
      const style = new ArrayBuffer(STYLE_BYTES);
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
        written: new Float32Array(STYLE_BYTES / 4).fill(NaN),
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

  /** Updates every drawable line, uploads what changed and sorts the lines into `drawLists`. */
  private collect(engine: EngineKernel, delta: number): void {
    const device = this.device!,
      lists = this.drawLists;
    for (const list of lists) list.length = 0;
    for (const line of this.members) {
      if (!line.visible || line.update(engine, delta) === false) continue;
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
      f[27] = material.depthBias;
      const vertexColors = (material.vertexColors ?? true) && line.colors !== null;
      u[28] = MODES.indexOf(line.mode);
      u[29] = line.count;
      u[30] =
        JOINS.indexOf(material.join) |
        (CAPS.indexOf(material.cap) << 2) |
        (material.worldUnits ? 16 : 0) |
        (material.dashed ? 32 : 0) |
        (vertexColors ? 64 : 0);
      // Clipping planes: count in flags.w (bit 16: intersection), planes from byte 128, unused slots zeroed.
      const planes = material['clipping'];
      u[31] = planes.length / 4 + (material.clipIntersection ? 65536 : 0);
      f.set(planes, 32);
      f.fill(0, 32 + planes.length);
      let changed = false;
      for (let i = 0; i < f.length; i++)
        if (!Object.is(r.written[i], f[i])) {
          changed = true;
          break;
        }
      if (changed) {
        device.queue.writeBuffer(r.uniform, 0, r.style);
        r.written.set(f);
      }
      lists[(material.onTop ? 2 : 0) + (material.depthWrite && !material.behind ? 0 : 1)].push([line, r]);
    }
  }

  private readonly execute = (context: PassContext): void => {
    const stats = this.stats;
    stats.lines = stats.segments = stats.drawCalls = 0;
    if (context.backend !== 'webgpu' || !this.device || !this.engine) return;
    if (context.device !== this.device) return;
    const engine = this.engine as unknown as EngineKernel,
      device = this.device,
      lists = this.drawLists;
    this.collect(engine, context.delta);
    for (const list of lists)
      for (const [line] of list) {
        stats.lines++;
        stats.segments += line.segmentCount;
      }
    if (!stats.lines) return;
    const canvas = engine.canvas,
      data = this.frameData,
      camera = context.camera;
    fillFrame(
      data,
      camera.matrix,
      camera,
      context.width,
      context.height,
      canvas.clientWidth ? context.width / canvas.clientWidth : 1,
      context.height,
      context.format.endsWith('-srgb') || context.format.includes('float') ? 0 : 1,
    );
    device.queue.writeBuffer(this.frameBuffer!, 0, data);
    const fog = this.fogSource;
    let fogged = false;
    if (fog) for (const list of lists) for (const [line] of list) fogged ||= line.material.fog;
    if (fogged) {
      writeFog(fog!, camera.position, this.fogData);
      device.queue.writeBuffer(this.fogResources().buffer, 0, this.fogData);
    }
    // Depth stays read only unless a line writes it.
    const descriptor = lists[0].length || lists[2].length ? this.writeDescriptor : this.descriptor;
    descriptor.colorAttachments[0].view = context.color;
    descriptor.depthStencilAttachment.view = context.depth;
    const pass = context.encoder.beginRenderPass(descriptor);
    applyView(pass, context);
    pass.setBindGroup(0, this.frameGroup!);
    if (fogged) pass.setBindGroup(2, this.fogGpu!.group);
    // Writers first, so a line that writes no depth still sorts against them, and their edge ramps after all their
    // solid parts, so a ramp blends over the line it crosses instead of being cut by it.
    for (let i = 0; i < 4; i += 2) {
      const onTop = i ? ON_TOP : 0;
      this.drawList(pass, context, lists[i], fogged, onTop | WRITE | STEP);
      this.drawList(pass, context, lists[i], fogged, onTop | (2 * STEP));
      this.drawList(pass, context, lists[i + 1], fogged, onTop);
    }
    pass.end();
    for (const list of lists) list.length = 0;
  };

  /** Draws `list` with pipeline `variant`, fogged per material. The edge ramp step skips lines that have no ramp. */
  private drawList(
    pass: GPURenderPassEncoder,
    context: PassContext & { backend: 'webgpu' },
    list: ReadonlyArray<[Line, Resources]>,
    fogged: boolean,
    variant: number,
  ): void {
    const depthFormat = context.descriptor.depthStencil!.format,
      count = context.descriptor.multisample?.count ?? 1,
      edge = variant >= 2 * STEP;
    let current: GPURenderPipeline | undefined;
    for (const [line, r] of list) {
      const { fog, antialias, dashed, behind, depthBias } = line.material;
      if (edge && !antialias) continue;
      const bits =
          (line['pointWidths'] && !dashed ? WIDTHS : 0) |
          (behind ? BEHIND : 0) |
          (depthBias ? BIAS : 0) |
          (fogged && fog ? FOGGED : 0),
        next = this.pipeline(context.format, depthFormat, count, variant | bits);
      if (next !== current) pass.setPipeline((current = next));
      pass.setBindGroup(1, r.group);
      pass.draw(VERTICES_PER_SEGMENT, line.segmentCount);
      this.stats.drawCalls++;
    }
  }

  onDeviceRestored(engine: Engine): void {
    this.releaseGpu();
    this.setup(engine);
  }

  private releaseGpu(): void {
    for (const line of [...this.resources.keys()]) this.release(line);
    this.frameBuffer?.destroy();
    this.fogGpu?.buffer.destroy();
    this.frameBuffer = this.frameGroup = this.layouts = this.device = this.fogGpu = undefined;
    this.pipelines.clear();
    this.modules.clear();
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
