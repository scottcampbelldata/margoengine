/// <reference lib="esnext.disposable" preserve="true" />
import { requireWebGPU } from '../../shared/require-webgpu.js';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { CAPS, JOINS, MODES, VERTICES_PER_SEGMENT } from './geometry.js';
import { Line } from './line.js';
import { lineFrame, type LineExtension } from './extension.js';
import { fillFrame } from './math.js';
import {
  biasedShader,
  dashCapShader,
  filledShader,
  foggedLineShader,
  lineShader,
  phasedShader,
  pointWidthShader,
  ribbonShader,
} from './shader.js';
import { checkFog, FOG_BYTES, writeFog, type FogLike } from '../../shared/fog.js';
import { applyView } from '../../shared/view-rect.js';
import { overlayDepthPass, overlayPass, alphaBlend } from '../../shared/pass.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

interface Resources {
  extra?: ReturnType<LineExtension['create']>;
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
  /** The buffer of the line's solid triangles, with `group` over it in place of the points. */
  fill?: { buffer: GPUBuffer; group: GPUBindGroup; bytes: number; version: number };
}

/**
 * Bytes of the per-line Style uniform: model (0), color (64), a (80), b (96), flags (112: mode, count, bits, clipping
 * plane count) and 6 clipping planes (128). A flat ribbon's normal takes the dash fields, as it has no dashes.
 */
const STYLE_BYTES = 224;

/**
 * Pipeline variant bits: draw over the scene, fogged, write depth, a width per point, only behind the scene, a depth
 * bias, alpha to coverage, round or square dash ends, solid triangles, a flat ribbon; the draw step (shader.ts) sits
 * above them.
 */
const ON_TOP = 1,
  FOGGED = 2,
  WRITE = 4,
  WIDTHS = 8,
  BEHIND = 16,
  BIAS = 32,
  COVER = 64,
  ROUND_DASH = 128,
  SQUARE_DASH = 256,
  FILL = 512,
  RIBBON = 1024,
  STEP = 2048;

/** Solid triangles write depth when nothing about them is translucent. */
const fillWrites = (line: Line): boolean => line['fillOpaque'] && line.material.opacity === 1 && !line.material.behind;

/** GPUColorWrite's red, green and blue. */
const RGB = 7;

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
  /** @internal Live per-line inventory; shared frame and pipeline resources are excluded. */
  memoryFor(line: Line): { cpu: readonly ArrayLike<number>[]; gpu: readonly GPUBuffer[] } {
    const r = this.resources.get(line);
    return r
      ? {
          cpu: [r.floats, r.uints, r.written],
          gpu: [r.uniform, r.points, r.colors, ...(r.fill ? [r.fill.buffer] : [])],
        }
      : { cpu: [], gpu: [] };
  }
  readonly name: string;
  readonly order: number;
  /** Lines and draw calls of the latest frame. */
  readonly stats = { lines: 0, segments: 0, drawCalls: 0 };
  private readonly members = new Set<Line>();
  private readonly resources = new Map<Line, Resources>();
  /** Told when a line joins or leaves (LinePicking's stand-in meshes). */
  private readonly watchers = new Set<{ added(line: Line): void; removed(line: Line): void }>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly extendedLayouts = new Map<string, GPUBindGroupLayout>();
  private engine?: Engine;
  private device?: GPUDevice;
  private layouts?: { frame: GPUBindGroupLayout; style: GPUBindGroupLayout; pipeline: GPUPipelineLayout };
  private frameBuffer?: GPUBuffer;
  private frameGroup?: GPUBindGroup;
  private frameData = new Float32Array(24);
  private frameBits = new Uint32Array(this.frameData.buffer);
  private frameWritten = new Uint32Array(24);
  private frameValid = false;
  /** This frame's lines in draw order: depth-tested writers, depth-tested, on-top writers, on-top. */
  private readonly drawLists: Array<Array<[Line, Resources]>> = [[], [], [], []];
  /** This frame's lines with solid triangles: depth-tested, on-top. */
  private readonly fillLists: Array<Array<[Line, Resources]>> = [[], []];
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
    requireWebGPU(engine, 'Lines');
    this.engine = engine;
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
    this.frameValid = false;
    this.frameGroup = device.createBindGroup({
      layout: frame,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  /** The shader module of a variant, made when first used. */
  private module(variant: number, extension?: LineExtension): GPUShaderModule {
    const key = `${variant & ~(ON_TOP | WRITE | BEHIND | COVER)}|${extension?.key ?? ''}`;
    let module = this.modules.get(key);
    if (!module) {
      let code = variant & FOGGED ? foggedLineShader() : lineShader;
      if (variant & RIBBON) code = ribbonShader(code);
      if (variant & WIDTHS) code = pointWidthShader(code);
      if (variant & BIAS) code = biasedShader(code);
      if (variant & ROUND_DASH) code = dashCapShader(code, 'round');
      if (variant & SQUARE_DASH) code = dashCapShader(code, 'square');
      if (variant & FILL) code = filledShader(code);
      code = phasedShader(code, Math.floor(variant / STEP));
      if (extension) code = extension.shader(code);
      if (lineFrame.hook) code = lineFrame.hook.shader(code);
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
    extension?: LineExtension,
  ): GPURenderPipeline {
    const key = `${format}|${depthFormat}|${count}|${variant}|${extension?.key ?? ''}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const fogged = (variant & FOGGED) !== 0,
        covered = (variant & COVER) !== 0,
        fog = fogged ? this.fogResources() : undefined,
        module = this.module(variant, extension);
      pipeline = this.device!.createRenderPipeline({
        layout: extension
          ? this.device!.createPipelineLayout({
              bindGroupLayouts: [this.layouts!.frame, this.styleLayout(extension), ...(fog ? [fog.layout] : [])],
            })
          : (fog?.pipeline ?? this.layouts!.pipeline),
        vertex: { module, entryPoint: variant & FILL ? 'fillVertex' : variant & RIBBON ? 'ribbonVertex' : 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          // Coverage replaces blending; the scene's own alpha stays.
          targets: [covered ? { format, writeMask: RGB } : { format, blend: alphaBlend }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: covered ? { count, alphaToCoverageEnabled: true } : { count },
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
    let extra: Resources['extra'];
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
      extra = line['extension']?.create(device);
      const group = device.createBindGroup({
        layout: this.styleLayout(line['extension']),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: points } },
          { binding: 2, resource: { buffer: colorBuffer } },
          ...(extra?.entries ?? []),
        ],
      });
      const style = new ArrayBuffer(STYLE_BYTES);
      r = {
        extra,
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
      extra?.dispose();
      for (const buffer of created) buffer.destroy();
      throw error;
    }
    this.resources.set(line, r);
    return r;
  }

  /** Layout shared by colour and picking for an optional entry. */
  private styleLayout(extension?: LineExtension): GPUBindGroupLayout {
    if (!extension) return this.layouts!.style;
    let layout = this.extendedLayouts.get(extension.key);
    if (!layout) {
      layout = this.device!.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 3, buffer: { type: 'uniform', minBindingSize: STYLE_BYTES } },
          { binding: 1, visibility: 1, buffer: { type: 'read-only-storage', minBindingSize: 16 } },
          { binding: 2, visibility: 1, buffer: { type: 'read-only-storage', minBindingSize: 16 } },
          ...extension.entries,
        ],
      });
      this.extendedLayouts.set(extension.key, layout);
    }
    return layout;
  }

  private release(line: Line): void {
    const r = this.resources.get(line);
    if (!r) return;
    r.extra?.dispose();
    r.uniform.destroy();
    r.points.destroy();
    r.colors.destroy();
    r.fill?.buffer.destroy();
    this.resources.delete(line);
  }

  /** Uploads a line's solid triangles when they changed. */
  private uploadFill(line: Line, r: Resources, corners: Float32Array): void {
    const device = this.device!;
    if (r.fill?.bytes !== corners.byteLength) {
      r.fill?.buffer.destroy();
      const buffer = device.createBuffer({
        size: corners.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      r.fill = {
        buffer,
        group: device.createBindGroup({
          layout: this.layouts!.style,
          entries: [
            { binding: 0, resource: { buffer: r.uniform } },
            { binding: 1, resource: { buffer } },
            { binding: 2, resource: { buffer: r.colors } },
          ],
        }),
        bytes: corners.byteLength,
        version: -1,
      };
    }
    if (r.fill.version !== line['fillVersion']) {
      device.queue.writeBuffer(r.fill.buffer, 0, corners as Float32Array<ArrayBuffer>);
      r.fill.version = line['fillVersion'];
    }
  }

  /** Updates every drawable line, uploads what changed and sorts the lines into `drawLists`. */
  private collect(engine: EngineKernel, delta: number): void {
    const device = this.device!,
      lists = this.drawLists;
    for (const list of lists) list.length = 0;
    for (const list of this.fillLists) list.length = 0;
    for (const line of this.members) {
      if (!line.visible || line.update(engine, delta) === false) continue;
      const mesh = line.attachedMesh,
        model = mesh ? meshWorldMatrix(engine, mesh) : line.matrix;
      if (!model) continue;
      const segments = line.segmentCount,
        material = line.material;
      if (!segments) continue;
      material.validate();
      if (material.dashed || line['extension']) line.updateDistances(model);
      const r = this.ensure(line);
      r.extra?.update();
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
      if (line['flatNormal']) f.set(line['flatNormal'], 22);
      else {
        f[22] = material.dashSize;
        f[23] = material.gapSize;
        f[24] = material.dashOffset;
      }
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
        (material.dashed && !line['flatNormal'] ? 32 : 0) |
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
      const corners = line['fill'];
      if (corners?.length) {
        this.uploadFill(line, r, corners);
        this.fillLists[material.onTop ? 1 : 0].push([line, r]);
      }
    }
  }

  private readonly execute = (context: PassContext): void => {
    const stats = this.stats;
    stats.lines = stats.segments = stats.drawCalls = 0;
    if (context.backend !== 'webgpu' || !this.device || !this.engine) return;
    if (context.device !== this.device) return;
    lineFrame.hook?.lines(this);
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
    let changed = !this.frameValid;
    for (let i = 0; !changed && i < this.frameBits.length; i++) changed = this.frameBits[i] !== this.frameWritten[i];
    if (changed) {
      device.queue.writeBuffer(this.frameBuffer!, 0, data);
      this.frameWritten.set(this.frameBits);
      this.frameValid = true;
    }
    const fog = this.fogSource;
    let fogged = false;
    if (fog) for (const list of lists) for (const [line] of list) fogged ||= line.material.fog;
    if (fogged) {
      writeFog(fog!, camera.position, this.fogData);
      device.queue.writeBuffer(this.fogResources().buffer, 0, this.fogData);
    }
    // Depth stays read only unless a line or an opaque fill writes it.
    const fills = this.fillLists,
      writes = lists[0].length || lists[2].length || fills.some((list) => list.some(([line]) => fillWrites(line))),
      descriptor = writes ? this.writeDescriptor : this.descriptor;
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
      this.drawFills(pass, context, fills[i / 2], fogged, onTop);
      this.drawList(pass, context, lists[i], fogged, onTop | WRITE | STEP);
      this.drawList(pass, context, lists[i], fogged, onTop | (2 * STEP));
      this.drawList(pass, context, lists[i + 1], fogged, onTop);
    }
    pass.end();
    for (const list of lists) list.length = 0;
  };

  /** Draws the solid triangles of `list`. */
  private drawFills(
    pass: GPURenderPassEncoder,
    context: PassContext & { backend: 'webgpu' },
    list: ReadonlyArray<[Line, Resources]>,
    fogged: boolean,
    onTop: number,
  ): void {
    const depthFormat = context.descriptor.depthStencil!.format,
      count = context.descriptor.multisample?.count ?? 1;
    for (const [line, r] of list) {
      const { fog, behind } = line.material,
        bits = (fillWrites(line) ? WRITE : 0) | (behind ? BEHIND : 0) | (fogged && fog ? FOGGED : 0);
      pass.setPipeline(this.pipeline(context.format, depthFormat, count, FILL | onTop | bits));
      pass.setBindGroup(1, r.fill!.group);
      pass.draw(line['fill']!.length / 4);
      this.stats.drawCalls++;
    }
  }

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
      const { fog, antialias, dashed, dashCap, behind, depthBias, alphaToCoverage } = line.material,
        covered = alphaToCoverage && count > 1;
      // Coverage needs no steps: the edge is in the samples, so the first draw is the whole line.
      if (edge && (!antialias || covered)) continue;
      const bits =
          (line['pointWidths'] && !dashed ? WIDTHS : 0) |
          (line['flatNormal'] ? RIBBON : 0) |
          (behind ? BEHIND : 0) |
          (depthBias ? BIAS : 0) |
          (covered ? COVER : 0) |
          (dashed && dashCap === 'round' ? ROUND_DASH : 0) |
          (dashed && dashCap === 'square' ? SQUARE_DASH : 0) |
          (fogged && fog ? FOGGED : 0),
        next = this.pipeline(
          context.format,
          depthFormat,
          count,
          (covered ? variant % STEP : variant) | bits,
          line['extension'],
        );
      if (next !== current) pass.setPipeline((current = next));
      pass.setBindGroup(1, r.group);
      pass.draw(this.vertexCount(line), line.segmentCount);
      this.stats.drawCalls++;
    }
  }

  /** Independent non-round segments have no joins or cap fans. Extensions keep their full vertex contract. */
  private vertexCount(line: Line): number {
    return line.mode === 'segments' && line.material.cap !== 'round' && !line['extension']
      ? 6
      : VERTICES_PER_SEGMENT;
  }

  onDeviceRestored(engine: Engine): void {
    this.releaseGpu();
    this.setup(engine);
  }

  private releaseGpu(): void {
    for (const line of [...this.resources.keys()]) this.release(line);
    this.extendedLayouts.clear();
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
