/// <reference lib="esnext.disposable" preserve="true" />
// Massive line batches: every segment is one 32-byte instance of a 6-vertex quad in a vertex buffer, so a wire view of
// millions of segments is one draw and no per-line work. It gives up joins, round caps, dashes and fog for that; the
// fat lines of `Line` draw 78 vertices a segment.
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel, Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { parseColor, type ColorInput } from './color.js';
import { fillFrame, finiteArray, identity, type Mat4 } from './math.js';
import { alphaBlend, attachableMesh, overlayPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';

declare const GPUBufferUsage: { UNIFORM: number; VERTEX: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Bytes per segment: x, y, z and rgba8 at each end. */
const STRIDE = 32;
/** Segments one batch takes: 2 GiB of CPU copy. */
export const MAX_BATCH_SEGMENTS = 2 ** 26;
const STYLE_BYTES = 96;

const batchShader = /* wgsl */ `
struct Frame{viewProj:mat4x4f,viewport:vec4f,extra:vec4f}
struct Style{model:mat4x4f,color:vec4f,a:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(1) @binding(0) var<uniform> style:Style;
struct In{@location(0) a:vec3f,@location(1) colorA:vec4f,@location(2) b:vec3f,@location(3) colorB:vec4f}
struct Out{@builtin(position) clip:vec4f,@location(0) color:vec4f,@location(1) @interpolate(linear) edge:vec2f}
fn linear(c:vec3f)->vec3f{return select(c/12.92,pow((c+0.055)/1.055,vec3f(2.4)),c>vec3f(0.04045));}
fn encode(c:vec3f)->vec3f{return select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));}
fn screen(c:vec4f)->vec2f{return c.xy/c.w*0.5*frame.viewport.xy;}
fn halfWidth(c:vec4f)->f32{
  if(style.a.y>0.5){return 0.5*style.a.x*frame.viewport.w/c.w;}
  return 0.5*style.a.x*frame.viewport.z;
}
@vertex fn vertex(i:In,@builtin(vertex_index) vi:u32)->Out{
  var o:Out;o.clip=vec4f(2.0,2.0,0.0,1.0);o.color=vec4f(0.0);o.edge=vec2f(0.0,1.0);
  let m=frame.viewProj*style.model;
  let oa=m*vec4f(i.a,1.0);let ob=m*vec4f(i.b,1.0);
  let fa=oa.w-oa.z;let fb=ob.w-ob.z;
  if(fa<0.0&&fb<0.0){return o;}
  var ta=0.0;var tb=1.0;
  if(fa<0.0){ta=fa/(fa-fb);}
  if(fb<0.0){tb=fa/(fa-fb);}
  let ca=mix(oa,ob,ta);let cb=mix(oa,ob,tb);
  let seg=screen(cb)-screen(ca);let len=length(seg);
  let dir=select(vec2f(1.0,0.0),seg/len,len>1e-4);let nrm=vec2f(-dir.y,dir.x);
  let ends=array<u32,6>(0u,0u,1u,0u,1u,1u);let sides=array<f32,6>(-1.0,1.0,1.0,-1.0,1.0,-1.0);
  let atB=ends[vi]==1u;let side=sides[vi];
  let base=select(ca,cb,atB);
  let raw=halfWidth(base);let hw=max(raw,0.5);
  let aa=style.a.z;let hwG=hw+aa;
  // Square ends: segments that share a point overlap at the corner instead of leaving a notch.
  let off=nrm*(side*hwG)+dir*select(-hw,hw,atB);
  o.clip=vec4f(base.xy+off/(0.5*frame.viewport.xy)*base.w,base.z,base.w);
  o.edge=vec2f(side*hwG,hw);
  let c=select(mix(i.colorA,i.colorB,ta),mix(i.colorA,i.colorB,tb),atB);
  let fade=select(1.0,min(1.0,2.0*raw),aa>0.0);
  o.color=vec4f(linear(c.rgb)*style.color.rgb,c.a*style.color.a*fade);
  return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f{
  var cover=1.0;
  if(style.a.z>0.0){cover=clamp(i.edge.y+0.5-abs(i.edge.x),0.0,1.0);}
  var rgb=max(i.color.rgb,vec3f(0.0));
  if(frame.extra.x>0.5){rgb=encode(min(rgb,vec3f(1.0)));}
  return vec4f(rgb,i.color.a*cover);
}`;

const encodeByte = (linear: number): number => {
  const v = Math.min(1, Math.max(0, linear)),
    s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

/** Options for `new LineBatch(...)`. Malformed data throws a RangeError, a bad flag or colour a TypeError. */
export interface LineBatchOptions {
  /** x, y, z per end point: two points a segment, or any number of points with `indices`. */
  positions?: ArrayLike<number>;
  /** Pairs of point indices, one pair a segment: a mesh's edges share their points this way. Default none. */
  indices?: ArrayLike<number>;
  /**
   * Linear r, g, b or r, g, b, a: one colour per point, or one per segment without \`indices\`. Stored at 8 bits a
   * channel, sRGB encoded. Default white.
   */
  colors?: ArrayLike<number> | null;
  /** Multiplied with the colours. Default white. */
  color?: ColorInput;
  /** 0..1. Default 1. */
  opacity?: number;
  /** CSS pixels, or world units with `worldUnits`. Default 1. */
  width?: number;
  /** Default false. */
  worldUnits?: boolean;
  /** Skip the depth test. Default false. */
  onTop?: boolean;
  /** One-pixel coverage ramp along the sides. Default true. */
  antialias?: boolean;
  /** Follow this mesh's world matrix. */
  mesh?: Mesh | null;
  /** Model matrix when not attached to a mesh (column-major). Default identity. */
  matrix?: Mat4;
  /** Default true. */
  visible?: boolean;
}

interface BatchOwner {
  remove(batch: LineBatch): void;
}

/**
 * Millions of independent segments in one buffer and one draw. Style applies to the whole batch and colours to its
 * segments. Segments have square ends and no joins, dashes, fog, clipping planes or picking: use `Line` for those.
 * @throws RangeError for malformed data or past 67,108,864 segments, TypeError for a bad flag.
 */
export class LineBatch {
  readonly color = new Float32Array([1, 1, 1]);
  opacity = 1;
  width = 1;
  worldUnits = false;
  onTop = false;
  antialias = true;
  visible: boolean;
  /** Model matrix used when the batch is not attached to a mesh. Edit in place. */
  readonly matrix: Float32Array;
  /** The packed segments: 32 bytes each, kept to refill the GPU after a device loss. */
  data = new ArrayBuffer(0);
  /** Bumped when the segment count changes. */
  capacityVersion = 0;
  /** First segment and end (exclusive) changed since the last upload. */
  dirtyStart = 0;
  dirtyEnd = 0;
  private segments = 0;
  private target: Mesh | null = null;
  private owner?: BatchOwner;

  constructor(options: LineBatchOptions = {}) {
    const { positions, indices, colors, color, opacity, width, worldUnits, onTop, antialias, mesh = null, matrix } = options;
    if (color !== undefined) parseColor(color, this.color);
    if (opacity !== undefined) this.opacity = opacity;
    if (width !== undefined) this.width = width;
    if (worldUnits !== undefined) this.worldUnits = worldUnits;
    if (onTop !== undefined) this.onTop = onTop;
    if (antialias !== undefined) this.antialias = antialias;
    this.visible = options.visible ?? true;
    this.validate();
    this.matrix = identity();
    if (matrix) {
      if (matrix.length !== 16) throw new TypeError('Matrix needs 16 values');
      finiteArray(matrix, 'Line batch matrix');
      this.matrix.set(Array.from(matrix));
    }
    if (positions) this.setSegments(positions, colors, indices);
    else if (colors || indices) throw new TypeError('Colors and indices need positions');
    this.attach(mesh);
  }

  /** Segments in the batch. */
  get count(): number {
    return this.segments;
  }
  get attachedMesh(): Mesh | null {
    return this.target;
  }

  /** Follow a core mesh's world matrix (the points are then in the mesh's local space), or null for world space. */
  attach(mesh: Mesh | null): this {
    this.target = attachableMesh(mesh);
    return this;
  }

  /** Throws when a style field is out of range. Called on every frame the batch draws. */
  validate(): void {
    finiteArray(this.color, 'Line batch color');
    if (!(this.opacity >= 0 && this.opacity <= 1)) throw new RangeError('Line batch opacity must be 0..1');
    if (!(this.width > 0) || !Number.isFinite(this.width)) throw new RangeError('Line batch width must be positive');
    for (const flag of [this.worldUnits, this.onTop, this.antialias])
      if (typeof flag !== 'boolean') throw new TypeError('Line batch flags must be boolean');
  }

  /**
   * Replaces every segment. The same segment count reuses the CPU and GPU buffers.
   * @throws RangeError for malformed data.
   */
  setSegments(positions: ArrayLike<number>, colors?: ArrayLike<number> | null, indices?: ArrayLike<number>): this {
    const count = this.countOf(positions, indices);
    if (count !== this.segments) {
      this.data = new ArrayBuffer(count * STRIDE);
      this.segments = count;
      this.capacityVersion++;
    }
    this.pack(0, count, positions, colors, !colors, indices);
    return this;
  }

  /**
   * Replaces `positions.length / 6` segments from segment `first`, uploading only those. `colors` as for one segment
   * or point each; left out, they stay. Takes no indices.
   * @throws RangeError past the end of the batch.
   */
  updateSegments(first: number, positions: ArrayLike<number>, colors?: ArrayLike<number> | null): this {
    const count = this.countOf(positions);
    if (!Number.isInteger(first) || first < 0 || first + count > this.segments)
      throw new RangeError('Line batch update runs past the end; pass a first segment inside the batch');
    this.pack(first, count, positions, colors, colors === null);
    return this;
  }

  private countOf(positions: ArrayLike<number>, indices?: ArrayLike<number>): number {
    if (positions.length % 3) throw new RangeError('Positions need x, y, z per point');
    finiteArray(positions, 'Line batch positions');
    if (indices && indices.length % 2) throw new RangeError('Indices need two points per segment');
    if (!indices && positions.length % 6) throw new RangeError('Positions need two points per segment');
    const count = indices ? indices.length / 2 : positions.length / 6;
    if (count > MAX_BATCH_SEGMENTS)
      throw new RangeError('Too many segments for one batch; split it into several batches');
    return count;
  }

  /** Packs `count` segments from segment `first`. Without `colors`, `white` paints them white, else they stay. */
  private pack(
    first: number,
    count: number,
    positions: ArrayLike<number>,
    colors: ArrayLike<number> | null | undefined,
    white: boolean,
    indices?: ArrayLike<number>,
  ): void {
    const floats = new Float32Array(this.data),
      bytes = new Uint8Array(this.data),
      points = positions.length / 3,
      perPoint = colors ? (indices ? points : count * 2) : 0,
      perSegment = colors && !indices ? count : 0,
      channels = !colors
        ? 0
        : colors.length === perPoint * 4 || colors.length === perSegment * 4
          ? 4
          : colors.length === perPoint * 3 || colors.length === perSegment * 3
            ? 3
            : -1;
    if (channels < 0) throw new RangeError('Colors need r, g, b or r, g, b, a per point or per segment');
    if (colors) finiteArray(colors, 'Line batch colors');
    const each = colors ? colors.length / channels : 0,
      segmentColors = each === perSegment && each !== perPoint;
    for (let i = 0; i < count; i++) {
      const o = (first + i) * 8;
      for (let end = 0; end < 2; end++) {
        const point = indices ? indices[i * 2 + end] : i * 2 + end;
        if (!(point >= 0 && point < points) || !Number.isInteger(point))
          throw new RangeError('Line batch index out of range; pass point indices inside positions');
        floats[o + end * 4] = positions[point * 3];
        floats[o + end * 4 + 1] = positions[point * 3 + 1];
        floats[o + end * 4 + 2] = positions[point * 3 + 2];
        const byte = (o + end * 4 + 3) * 4;
        if (colors) {
          const c = (segmentColors ? i : point) * channels;
          bytes[byte] = encodeByte(colors[c]);
          bytes[byte + 1] = encodeByte(colors[c + 1]);
          bytes[byte + 2] = encodeByte(colors[c + 2]);
          bytes[byte + 3] = channels === 4 ? Math.round(Math.min(1, Math.max(0, colors[c + 3])) * 255) : 255;
        } else if (white) bytes[byte] = bytes[byte + 1] = bytes[byte + 2] = bytes[byte + 3] = 255;
      }
    }
    this.dirtyStart = this.dirtyEnd > this.dirtyStart ? Math.min(this.dirtyStart, first) : first;
    this.dirtyEnd = Math.max(this.dirtyEnd, first + count);
  }

  /** @internal */
  bind(owner: BatchOwner | undefined): void {
    if (owner && this.owner && this.owner !== owner)
      throw new MargoError('attached', 'LineBatch already belongs to another LineBatches plugin; remove it first');
    this.owner = owner;
  }

  /** Removes the batch from its plugin and releases its GPU buffers. It can be added again later. */
  dispose(): void {
    this.owner?.remove(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

interface Resources {
  buffers: GPUBuffer[];
  /** Segments per buffer. */
  chunk: number;
  capacity: number;
  uniform: GPUBuffer;
  group: GPUBindGroup;
  style: Float32Array;
  written: Float32Array;
}

/** Options for the `LineBatches` plugin. */
export interface LineBatchesOptions {
  /** Plugin name, unique per engine. Default 'line-batches'. */
  name?: string;
  /** Frame graph order. Default 20, with the lines. */
  order?: number;
}

let warned = false;

/**
 * Engine plugin that draws `LineBatch` objects, one draw each (one per buffer past the device's `maxBufferSize`).
 * WebGPU only; on the WebGL2 backend it warns once and draws nothing.
 */
export class LineBatches implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  /** Batches, segments and draw calls of the latest frame. */
  readonly stats = { batches: 0, segments: 0, drawCalls: 0 };
  private readonly members = new Set<LineBatch>();
  private readonly resources = new Map<LineBatch, Resources>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private engine?: Engine;
  private device?: GPUDevice;
  private module?: GPUShaderModule;
  private layouts?: { frame: GPUBindGroupLayout; style: GPUBindGroupLayout; pipeline: GPUPipelineLayout };
  private frameBuffer?: GPUBuffer;
  private frameGroup?: GPUBindGroup;
  private readonly frameData = new Float32Array(24);
  private readonly descriptor = overlayPass();

  /** Same as `engine.use(new LineBatches(...))`; returns the plugin. */
  static attach(engine: EngineKernel, options?: LineBatchesOptions): LineBatches {
    const value = new LineBatches(options);
    engine.use(value);
    return value;
  }
  constructor(options: LineBatchesOptions = {}) {
    this.name = options.name ?? 'line-batches';
    this.order = options.order ?? 20;
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw new TypeError('Invalid LineBatches options; pass the documented option types');
  }

  /** Batches currently drawn. */
  get batches(): ReadonlySet<LineBatch> {
    return this.members;
  }

  add<T extends LineBatch>(batch: T): T {
    if (!(batch instanceof LineBatch)) throw new TypeError('Expected a LineBatch');
    batch.bind(this);
    this.members.add(batch);
    return batch;
  }

  remove(batch: LineBatch): void {
    if (!this.members.delete(batch)) return;
    this.release(batch);
    batch.bind(undefined);
  }

  clear(): void {
    for (const batch of [...this.members]) this.remove(batch);
  }

  setup(engine: Engine): void {
    this.engine = engine;
    if (engine.backend !== 'webgpu' || !engine.gpu) {
      if (!warned) {
        warned = true;
        console.warn('@margoengine/lines/batch: the WebGL2 backend is not supported, batches will not be drawn.');
      }
      return;
    }
    const device = (this.device = engine.gpu),
      uniform = (size: number): GPUBindGroupLayoutEntry => ({
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: size },
      }),
      frame = device.createBindGroupLayout({ entries: [uniform(96)] }),
      style = device.createBindGroupLayout({ entries: [uniform(STYLE_BYTES)] });
    this.layouts = { frame, style, pipeline: device.createPipelineLayout({ bindGroupLayouts: [frame, style] }) };
    this.module = device.createShaderModule({ code: batchShader });
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
    count: number,
    onTop: boolean,
  ): GPURenderPipeline {
    const key = `${format}|${depthFormat}|${count}|${onTop}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.module!;
      pipeline = this.device!.createRenderPipeline({
        layout: this.layouts!.pipeline,
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: STRIDE,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
                { shaderLocation: 2, offset: 16, format: 'float32x3' },
                { shaderLocation: 3, offset: 28, format: 'unorm8x4' },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format, blend: alphaBlend }] },
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

  /** The GPU side of `batch`: the buffers split at the device's limit, refilled when the segment count changed. */
  private ensure(batch: LineBatch): Resources {
    const device = this.device!;
    let r = this.resources.get(batch);
    if (r && r.capacity === batch.capacityVersion) return r;
    if (r) this.release(batch);
    const chunk = Math.floor(Math.min(device.limits.maxBufferSize, 2 ** 30) / STRIDE),
      buffers: GPUBuffer[] = [];
    for (let left = batch.count; left > 0; left -= chunk)
      buffers.push(
        device.createBuffer({
          size: Math.min(left, chunk) * STRIDE,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      );
    const uniform = device.createBuffer({
      size: STYLE_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    r = {
      buffers,
      chunk,
      capacity: batch.capacityVersion,
      uniform,
      group: device.createBindGroup({
        layout: this.layouts!.style,
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      }),
      style: new Float32Array(STYLE_BYTES / 4),
      written: new Float32Array(STYLE_BYTES / 4).fill(NaN),
    };
    this.resources.set(batch, r);
    batch.dirtyStart = 0;
    batch.dirtyEnd = batch.count;
    return r;
  }

  private upload(batch: LineBatch, r: Resources): void {
    const { dirtyStart, dirtyEnd } = batch;
    if (dirtyEnd <= dirtyStart) return;
    for (let i = 0; i < r.buffers.length; i++) {
      const low = Math.max(dirtyStart, i * r.chunk),
        high = Math.min(dirtyEnd, (i + 1) * r.chunk);
      if (high > low)
        this.device!.queue.writeBuffer(
          r.buffers[i],
          (low - i * r.chunk) * STRIDE,
          batch.data,
          low * STRIDE,
          (high - low) * STRIDE,
        );
    }
    batch.dirtyStart = batch.dirtyEnd = 0;
  }

  private release(batch: LineBatch): void {
    const r = this.resources.get(batch);
    if (!r) return;
    for (const buffer of r.buffers) buffer.destroy();
    r.uniform.destroy();
    this.resources.delete(batch);
  }

  private readonly execute = (context: PassContext): void => {
    const stats = this.stats;
    stats.batches = stats.segments = stats.drawCalls = 0;
    if (context.backend !== 'webgpu' || !this.device || !this.engine || context.device !== this.device) return;
    const engine = this.engine as unknown as EngineKernel,
      device = this.device,
      draws: Array<[LineBatch, Resources]> = [];
    for (const batch of this.members) {
      if (!batch.visible || !batch.count) continue;
      const mesh = batch.attachedMesh,
        model = mesh ? meshWorldMatrix(engine, mesh) : batch.matrix;
      if (!model) continue;
      batch.validate();
      const r = this.ensure(batch);
      this.upload(batch, r);
      const f = r.style;
      f.set(model, 0);
      f.set(batch.color, 16);
      f[19] = batch.opacity;
      f[20] = batch.width;
      f[21] = batch.worldUnits ? 1 : 0;
      f[22] = batch.antialias ? 1 : 0;
      if (f.some((v, i) => !Object.is(v, r.written[i]))) {
        device.queue.writeBuffer(r.uniform, 0, f as Float32Array<ArrayBuffer>);
        r.written.set(f);
      }
      draws.push([batch, r]);
      stats.batches++;
      stats.segments += batch.count;
    }
    if (!draws.length) return;
    const canvas = engine.canvas,
      camera = context.camera;
    fillFrame(
      this.frameData,
      camera.matrix,
      camera,
      context.width,
      context.height,
      canvas.clientWidth ? context.width / canvas.clientWidth : 1,
      context.height,
      context.format.endsWith('-srgb') || context.format.includes('float') ? 0 : 1,
    );
    device.queue.writeBuffer(this.frameBuffer!, 0, this.frameData as Float32Array<ArrayBuffer>);
    const descriptor = this.descriptor,
      depthFormat = context.descriptor.depthStencil!.format,
      count = context.descriptor.multisample?.count ?? 1;
    descriptor.colorAttachments[0].view = context.color;
    descriptor.depthStencilAttachment.view = context.depth;
    const pass = context.encoder.beginRenderPass(descriptor);
    applyView(pass, context);
    pass.setBindGroup(0, this.frameGroup!);
    // Depth-tested batches first, then the ones drawn over the scene.
    for (const onTop of [false, true]) {
      let set = false;
      for (const [batch, r] of draws) {
        if (batch.onTop !== onTop) continue;
        if (!set) pass.setPipeline(this.pipeline(context.format, depthFormat, count, onTop));
        set = true;
        pass.setBindGroup(1, r.group);
        for (let i = 0; i < r.buffers.length; i++) {
          pass.setVertexBuffer(0, r.buffers[i]);
          pass.draw(6, Math.min(r.chunk, batch.count - i * r.chunk));
          stats.drawCalls++;
        }
      }
    }
    pass.end();
  };

  onDeviceRestored(engine: Engine): void {
    this.releaseGpu();
    this.setup(engine);
  }

  private releaseGpu(): void {
    for (const batch of [...this.resources.keys()]) this.release(batch);
    this.frameBuffer?.destroy();
    this.frameBuffer = this.frameGroup = this.module = this.layouts = this.device = undefined;
    this.pipelines.clear();
  }

  /** Releases every GPU resource. Batches stay registered, so the plugin can be used again. */
  dispose(): void {
    this.releaseGpu();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
