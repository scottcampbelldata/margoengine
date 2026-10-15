/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import type { EngineKernel, Mesh } from '@margoengine/core';
import { viewMatrix } from '../../shared/view.js';
import { GlyphAtlas } from './atlas.js';
import { LinearToSRGB as encodeSrgb } from '@margoengine/math/color';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { textShader } from './shader.js';
import { Text } from './text.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

type GpuContext = Extract<PassContext, { backend: 'webgpu' }>;
const GLYPH_FLOATS = 12,
  BLOCK_BYTES = 160;

interface Resources {
  uniform: GPUBuffer;
  glyphs: GPUBuffer;
  group: GPUBindGroup;
  capacity: number;
  /** Layout version and atlas state the glyph buffer was written for. */
  written: number;
  count: number;
  block: ArrayBuffer;
  floats: Float32Array;
  uints: Uint32Array;
  last: Float32Array;
  instances: Float32Array;
  model: Float32Array;
  depth: number;
}

let warned = false;

/** World matrix of a live, visible core mesh after the latest transform tick, or null. */
export function meshWorldMatrix(engine: EngineKernel, mesh: Mesh): Float32Array | null {
  const runtime = engineRuntime(engine),
    object = meshRuntime(mesh),
    id = object.id;
  if (runtime.disposed || runtime.meshes.get(id) !== (mesh as unknown)) return null;
  for (
    let current = id, depth = 0;
    current >= 0 && depth < 64;
    current = runtime.store.parents?.[current] ?? -1, depth++
  )
    if (runtime.store.hidden[current]) return null;
  return object.matrix ?? runtime.store.matrices.subarray(id * 16, id * 16 + 16);
}

export interface TextRendererOptions {
  /** Plugin name, unique per engine. Default 'text'. */
  name?: string;
  /** Frame graph order. Default 22: after the scene, particles and lines, before post-processing resolves at 30. */
  order?: number;
  /** SDF atlas page size in texels. Default 1024 (one megabyte per page). */
  atlasSize?: number;
  /** Color (emoji) atlas page size in texels. Default 512. */
  colorAtlasSize?: number;
  /** Page limit per atlas, capped by the device's maxTextureArrayLayers. Default 64. */
  maxPages?: number;
}

/**
 * Engine plugin that draws `Text` blocks: one instanced draw call per block over the scene color and
 * depth, reversed-Z depth test without depth writes, premultiplied alpha blending, blocks sorted back to
 * front. Replaces troika-three-text's `Text` and the label use cases of three.js `TextGeometry`.
 * WebGPU only; on the WebGL2 backend it warns once and draws nothing.
 */
export class TextRenderer implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  /** Counts for the latest frame. */
  readonly stats = { texts: 0, glyphs: 0, drawCalls: 0 };
  private readonly members = new Set<Text>();
  private readonly resources = new Map<Text, Resources>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly options: Required<Omit<TextRendererOptions, 'name' | 'order'>>;
  private engine?: Engine;
  private device?: GPUDevice;
  private module?: GPUShaderModule;
  private layouts?: { frame: GPUBindGroupLayout; block: GPUBindGroupLayout; pipeline: GPUPipelineLayout };
  private sampler?: GPUSampler;
  private frameBuffer?: GPUBuffer;
  private frameGroup?: GPUBindGroup;
  private frameGroupKey = '';
  private sdfAtlas?: GlyphAtlas;
  private colorAtlas?: GlyphAtlas;
  private readonly frameData = new Float32Array(28);
  private readonly view = new Float32Array(16);
  private readonly depthTexts: Array<[Text, Resources]> = [];
  private readonly topTexts: Array<[Text, Resources]> = [];
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
  private atlasEpoch = 0;

  /** Same as `engine.use(new TextRenderer(...))`; returns the TextRenderer. */
  static attach(engine: EngineKernel, options?: TextRendererOptions): TextRenderer {
    const value = new TextRenderer(options);
    engine.use(value);
    return value;
  }
  constructor(options: TextRendererOptions = {}) {
    this.name = options.name ?? 'text';
    this.order = options.order ?? 22;
    this.options = {
      atlasSize: options.atlasSize ?? 1024,
      colorAtlasSize: options.colorAtlasSize ?? 512,
      maxPages: options.maxPages ?? 64,
    };
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw new TypeError('Invalid TextRenderer options');
    for (const value of Object.values(this.options))
      if (!Number.isInteger(value) || value < 1)
        throw new RangeError('Atlas sizes and page limits must be positive integers');
    if (this.options.atlasSize < 64 || this.options.colorAtlasSize < 64)
      throw new RangeError('Atlas pages must be at least 64 texels');
  }

  /** Texts currently drawn by this plugin. */
  get texts(): ReadonlySet<Text> {
    return this.members;
  }

  /** Atlas usage: pages and glyphs of the SDF and color atlases. */
  get atlas(): { sdfPages: number; colorPages: number; glyphs: number; colorGlyphs: number; pageSize: number } {
    return {
      sdfPages: this.sdfAtlas?.pages ?? 0,
      colorPages: this.colorAtlas?.pages ?? 0,
      glyphs: this.sdfAtlas?.slots.size ?? 0,
      colorGlyphs: this.colorAtlas?.slots.size ?? 0,
      pageSize: this.options.atlasSize,
    };
  }

  add<T extends Text>(text: T): T {
    if (!(text instanceof Text)) throw new TypeError('Expected a Text');
    text.bind(this);
    this.members.add(text);
    return text;
  }

  remove(text: Text): void {
    if (!this.members.delete(text)) return;
    this.release(text);
    text.bind(undefined);
  }

  clear(): void {
    for (const text of [...this.members]) this.remove(text);
  }

  setup(engine: Engine): void {
    this.engine = engine;
    if (engine.backend !== 'webgpu' || !engine.gpu) {
      if (!warned) {
        warned = true;
        console.warn('@margoengine/text: the WebGL2 backend is not supported, text will not be drawn.');
      }
      return;
    }
    const device = (this.device = engine.gpu),
      both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const frame = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform', minBindingSize: 112 } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d-array' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d-array' },
        },
      ],
    });
    const block = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform', minBindingSize: BLOCK_BYTES } },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage', minBindingSize: GLYPH_FLOATS * 4 },
        },
      ],
    });
    this.layouts = { frame, block, pipeline: device.createPipelineLayout({ bindGroupLayouts: [frame, block] }) };
    this.module = device.createShaderModule({ code: textShader });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.frameBuffer = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const maxPages = Math.min(this.options.maxPages, device.limits.maxTextureArrayLayers, 2048),
      limit = device.limits.maxTextureDimension2D;
    if (this.sdfAtlas && this.colorAtlas) {
      this.sdfAtlas.restore(device);
      this.colorAtlas.restore(device);
    } else {
      this.sdfAtlas = new GlyphAtlas(device, 'r8unorm', Math.min(this.options.atlasSize, limit), maxPages);
      this.colorAtlas = new GlyphAtlas(device, 'rgba8unorm', Math.min(this.options.colorAtlasSize, limit), maxPages);
    }
    this.frameGroup = undefined;
    this.frameGroupKey = '';
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  private pipeline(
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    onTop: boolean,
    count: number,
  ): GPURenderPipeline {
    const key = `${format}|${depthFormat}|${onTop}|${count}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.module!,
        blend: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
      pipeline = this.device!.createRenderPipeline({
        layout: this.layouts!.pipeline,
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format, blend: { color: blend, alpha: blend } }] },
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

  private ensure(text: Text, count: number): Resources {
    const device = this.device!;
    let r = this.resources.get(text);
    if (r && r.capacity >= count) return r;
    const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    const created: GPUBuffer[] = [];
    try {
      const make = (size: number, usage: number) => {
        const buffer = device.createBuffer({ size, usage });
        created.push(buffer);
        return buffer;
      };
      const uniform = r?.uniform ?? make(BLOCK_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const glyphs = make(capacity * GLYPH_FLOATS * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const group = device.createBindGroup({
        layout: this.layouts!.block,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: glyphs } },
        ],
      });
      r?.glyphs.destroy();
      const block = r?.block ?? new ArrayBuffer(BLOCK_BYTES);
      r = {
        uniform,
        glyphs,
        group,
        capacity,
        written: -1,
        count: 0,
        block,
        floats: r?.floats ?? new Float32Array(block),
        uints: r?.uints ?? new Uint32Array(block),
        last: r?.last ?? new Float32Array(BLOCK_BYTES / 4).fill(NaN),
        instances: r?.instances ?? new Float32Array(0),
        model: r?.model ?? new Float32Array(16),
        depth: 0,
      };
    } catch (error) {
      for (const buffer of created) buffer.destroy();
      throw error;
    }
    this.resources.set(text, r);
    return r;
  }

  private release(text: Text): void {
    const r = this.resources.get(text);
    if (!r) return;
    r.uniform.destroy();
    r.glyphs.destroy();
    this.resources.delete(text);
  }

  /** Builds the glyph instance array for a text, placing glyphs in the atlases. Returns the glyph count. */
  private build(text: Text, r: Resources | undefined): { data: Float32Array; count: number } {
    const layout = text.layout,
      font = text.font,
      scale = text.fontSize / font.size;
    let data = r?.instances ?? new Float32Array(0),
      count = 0;
    if (data.length < layout.glyphs.length * GLYPH_FLOATS)
      data = new Float32Array(Math.max(16, 2 ** Math.ceil(Math.log2(layout.glyphs.length))) * GLYPH_FLOATS);
    const uints = new Uint32Array(data.buffer);
    for (const g of layout.glyphs) {
      if (g.whitespace) continue;
      const bitmap = font.glyph(g.cluster);
      if (!bitmap) continue;
      const atlas = bitmap.color ? this.colorAtlas! : this.sdfAtlas!,
        slot = atlas.place(bitmap),
        size = atlas.size,
        o = count * GLYPH_FLOATS;
      const left = g.x + bitmap.left * scale,
        top = g.y + bitmap.top * scale;
      data[o] = left;
      data[o + 1] = top - bitmap.height * scale;
      data[o + 2] = left + bitmap.width * scale;
      data[o + 3] = top;
      data[o + 4] = slot.x / size;
      data[o + 5] = slot.y / size;
      data[o + 6] = (slot.x + bitmap.width) / size;
      data[o + 7] = (slot.y + bitmap.height) / size;
      uints[o + 8] = slot.page;
      uints[o + 9] = bitmap.color ? 1 : 0;
      uints[o + 10] = 0;
      uints[o + 11] = 0;
      count++;
    }
    return { data, count };
  }

  private readonly execute = (context: PassContext): void => {
    this.stats.texts = this.stats.glyphs = this.stats.drawCalls = 0;
    if (context.backend !== 'webgpu' || !this.device || !this.engine) return;
    if (context.device !== this.device) return;
    this.draw(context);
  };

  private draw(context: GpuContext): void {
    const engine = this.engine as unknown as EngineKernel,
      device = this.device!,
      camera = context.camera;
    const linearTarget = context.format.endsWith('-srgb') || context.format.includes('float');
    const encode = (value: number) => (linearTarget ? value : encodeSrgb(Math.min(1, value)));
    this.depthTexts.length = this.topTexts.length = 0;
    for (const text of this.members) {
      if (!text.visible) continue;
      if (!text.font.loaded) {
        void text.font.load();
        continue;
      }
      text.validate();
      const mesh = text.attachedMesh,
        parent = mesh ? meshWorldMatrix(engine, mesh) : null;
      if (mesh && !parent) continue;
      const layout = text.layout,
        version = text.layoutVersion * 4096 + this.atlasEpoch;
      let r = this.resources.get(text);
      if (!r || r.written !== version) {
        const { data, count } = this.build(text, r);
        r = this.ensure(text, count);
        r.instances = data;
        r.count = count;
        if (count) device.queue.writeBuffer(r.glyphs, 0, data as Float32Array<ArrayBuffer>, 0, count * GLYPH_FLOATS);
        r.written = version;
      }
      if (!r.count) continue;
      const model = parent ? multiplyMatrices(parent, text.matrix, r.model) : text.matrix;
      const f = r.floats,
        u = r.uints,
        opacity = text.opacity,
        fontScale = text.font.size / text.fontSize;
      f.set(model, 0);
      f[16] = encode(text.color[0]);
      f[17] = encode(text.color[1]);
      f[18] = encode(text.color[2]);
      f[19] = opacity;
      f[20] = encode(text.outlineColor[0]);
      f[21] = encode(text.outlineColor[1]);
      f[22] = encode(text.outlineColor[2]);
      f[23] = opacity * text.outlineOpacity;
      f[24] = encode(text.shadowColor[0]);
      f[25] = encode(text.shadowColor[1]);
      f[26] = encode(text.shadowColor[2]);
      f[27] = opacity * text.shadowOpacity;
      // Outline and blur live inside the field's outer range (radius * (1 - cutoff) texels) minus a texel of margin.
      const reach = text.font.radius * (1 - text.font.cutoff) - 1;
      const outline = text.outlineOpacity > 0 ? Math.min(text.outlineWidth * fontScale, reach) : 0;
      const blur = Math.min((text.shadowBlur * fontScale) / 2, Math.max(0, reach - outline));
      f[28] = outline;
      f[29] = blur;
      f[30] = text.shadowOffset[0];
      f[31] = text.shadowOffset[1];
      let layers = 0,
        kinds = 0;
      if (text.shadowOpacity > 0) {
        kinds |= 0 << (layers * 2);
        layers++;
      }
      if (outline > 0) {
        kinds |= 1 << (layers * 2);
        layers++;
      }
      kinds |= 2 << (layers * 2);
      layers++;
      u[32] = r.count;
      u[33] = layers;
      u[34] = kinds;
      u[35] = text.billboard ? 1 : 0;
      f[36] = text.font.radius;
      f[37] = text.font.cutoff;
      f[38] = 0;
      f[39] = 0;
      let changed = false;
      for (let i = 0; i < 40; i++)
        if (!Object.is(r.last[i], f[i])) {
          changed = true;
          break;
        }
      if (changed) {
        device.queue.writeBuffer(r.uniform, 0, r.block);
        r.last.set(f);
      }
      const dx = model[12] - camera.position[0],
        dy = model[13] - camera.position[1],
        dz = model[14] - camera.position[2];
      r.depth = dx * dx + dy * dy + dz * dz;
      (text.onTop ? this.topTexts : this.depthTexts).push([text, r]);
      this.stats.texts++;
      this.stats.glyphs += r.count;
      void layout;
    }
    if (!this.depthTexts.length && !this.topTexts.length) return;
    this.writeFrame(context, linearTarget);
    const key = `${this.sdfAtlas!.generation}|${this.colorAtlas!.generation}`;
    if (!this.frameGroup || key !== this.frameGroupKey) {
      this.frameGroup = device.createBindGroup({
        layout: this.layouts!.frame,
        entries: [
          { binding: 0, resource: { buffer: this.frameBuffer! } },
          { binding: 1, resource: this.sampler! },
          { binding: 2, resource: this.sdfAtlas!.view },
          { binding: 3, resource: this.colorAtlas!.view },
        ],
      });
      this.frameGroupKey = `${this.sdfAtlas!.generation}|${this.colorAtlas!.generation}`;
    }
    this.colorAttachment.view = context.color;
    this.depthAttachment.view = context.depth;
    const depthFormat = context.descriptor.depthStencil!.format;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    pass.setBindGroup(0, this.frameGroup);
    for (const [list, onTop] of [
      [this.depthTexts, false],
      [this.topTexts, true],
    ] as const) {
      if (!list.length) continue;
      list.sort((a, b) => b[1].depth - a[1].depth);
      pass.setPipeline(this.pipeline(context.format, depthFormat, onTop, context.descriptor.multisample?.count ?? 1));
      for (const [, r] of list) {
        pass.setBindGroup(1, r.group);
        pass.draw(6, r.count * r.uints[33]);
        this.stats.drawCalls++;
      }
    }
    pass.end();
    this.depthTexts.length = this.topTexts.length = 0;
  }

  private writeFrame(context: GpuContext, linearTarget: boolean): void {
    const camera = context.camera,
      data = this.frameData;
    data.set(camera.matrix, 0);
    // Camera basis (right, up), as Camera.update builds its view matrix including camera.up.
    const v = viewMatrix(this.view, camera);
    data[16] = v[0];
    data[17] = v[4];
    data[18] = v[8];
    data[19] = 0;
    data[20] = v[1];
    data[21] = v[5];
    data[22] = v[9];
    data[23] = 0;
    data[24] = linearTarget ? 1 : 0;
    data[25] = data[26] = data[27] = 0;
    this.device!.queue.writeBuffer(this.frameBuffer!, 0, data);
  }

  onDeviceRestored(engine: Engine): void {
    this.releaseGpu(false);
    this.setup(engine);
  }

  private releaseGpu(atlases: boolean): void {
    for (const text of [...this.resources.keys()]) this.release(text);
    this.frameBuffer?.destroy();
    if (atlases) {
      this.sdfAtlas?.dispose();
      this.colorAtlas?.dispose();
      this.sdfAtlas = this.colorAtlas = undefined;
      this.atlasEpoch++;
    }
    this.frameBuffer = this.frameGroup = this.module = this.layouts = this.sampler = this.device = undefined;
    this.pipelines.clear();
  }

  /** Releases every GPU resource, atlases included. Texts stay registered, so the plugin can be used again. */
  dispose(): void {
    this.releaseGpu(true);
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
