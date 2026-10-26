/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { GlyphAtlas, SDF_DEFAULTS } from '@margoengine/text';
import { rangeError, typeError } from '../../shared/errors.js';
import { overlayPass } from '../../shared/pass.js';
import type { DrawList, TextCommand } from './draw.js';
import { uiShader } from './shader.js';
import type { Ui } from './ui.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

type GpuContext = Extract<PassContext, { backend: 'webgpu' }>;
const RECT_FLOATS = 16,
  GLYPH_FLOATS = 16;

/** Options for {@link UiRenderer}. */
export interface UiRendererOptions {
  /** Plugin name, unique per engine. Default `'ui'`. */
  name?: string;
  /** Frame graph order. Default 1000: after the scene and post-processing, so the UI is never tone mapped or blurred. */
  order?: number;
  /** SDF atlas page size in texels. Default 1024. */
  atlasSize?: number;
  /** Colour (emoji) atlas page size in texels. Default 512. */
  colorAtlasSize?: number;
  /** Page limit per atlas. Default 16. */
  maxPages?: number;
}

interface Run {
  glyphs: boolean;
  first: number;
  count: number;
  clip: readonly [number, number, number, number] | null;
}

let warned = false;

/**
 * Engine plugin that draws a {@link Ui} over the finished frame, in the engine's own render pass: rounded rectangles
 * and signed distance field text from the text package, in device pixels, so it works in fullscreen and in exported
 * games with no DOM involved. It also steps the UI each frame (`ui.update`) and keeps its size in step with the canvas.
 * WebGPU only; on the WebGL2 backend it warns once, draws nothing, and the UI still updates and mirrors to the DOM.
 *
 * @example
 * const ui = new Ui();
 * UiRenderer.attach(engine, ui);
 */
export class UiRenderer implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  /** Counts for the latest frame. */
  readonly stats = { rects: 0, glyphs: 0, drawCalls: 0, uploads: 0 };
  private engine?: Engine;
  private device?: GPUDevice;
  private module?: GPUShaderModule;
  private layout?: GPUBindGroupLayout;
  private pipelineLayout?: GPUPipelineLayout;
  private sampler?: GPUSampler;
  private frameBuffer?: GPUBuffer;
  private rectBuffer?: GPUBuffer;
  private glyphBuffer?: GPUBuffer;
  private group?: GPUBindGroup;
  private groupKey = '';
  private rectCapacity = 0;
  private glyphCapacity = 0;
  private sdfAtlas?: GlyphAtlas;
  private colorAtlas?: GlyphAtlas;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly descriptor = overlayPass();
  private readonly frameData = new Float32Array(8);
  private rects: Float32Array<ArrayBuffer> = new Float32Array(RECT_FLOATS * 256);
  private glyphs: Float32Array<ArrayBuffer> = new Float32Array(GLYPH_FLOATS * 1024);
  private runs: Run[] = [];
  private uploaded = -1;
  private uploadedAtlas = '';
  private readonly options: Required<Omit<UiRendererOptions, 'name' | 'order'>>;
  private disposed = false;

  /** Same as `engine.use(new UiRenderer(ui, options))`; returns the renderer. */
  static attach(engine: EngineKernel, ui: Ui, options?: UiRendererOptions): UiRenderer {
    const value = new UiRenderer(ui, options);
    engine.use(value);
    return value;
  }

  /**
   * @throws TypeError for a missing `ui`, an empty name or a non-finite order.
   * @throws RangeError for an atlas size under 64 texels or a page limit that is not a positive integer.
   */
  constructor(
    readonly ui: Ui,
    options: UiRendererOptions = {},
  ) {
    if (!ui || typeof ui.draw !== 'function') throw typeError('UiRenderer needs a Ui: new UiRenderer(new Ui())', 'ui');
    this.name = options.name ?? 'ui';
    this.order = options.order ?? 1000;
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw typeError('Invalid UiRenderer options', 'ui');
    this.options = {
      atlasSize: options.atlasSize ?? 1024,
      colorAtlasSize: options.colorAtlasSize ?? 512,
      maxPages: options.maxPages ?? 16,
    };
    for (const value of Object.values(this.options))
      if (!Number.isInteger(value) || value < 1)
        throw rangeError('Atlas sizes and page limits must be positive integers', 'ui');
    if (this.options.atlasSize < 64 || this.options.colorAtlasSize < 64)
      throw rangeError('Atlas pages must be at least 64 texels', 'ui');
  }

  setup(engine: Engine): void {
    this.engine = engine;
    if (engine.backend !== 'webgpu' || !engine.gpu) {
      if (!warned) {
        warned = true;
        console.warn(
          '@margoengine/ui: the WebGL2 backend is not supported, the UI will not be drawn (the accessibility mirror still works).',
        );
      }
      return;
    }
    const device = (this.device = engine.gpu),
      both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform', minBindingSize: 32 } },
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
        { binding: 4, visibility: both, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: both, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.module = device.createShaderModule({ code: uiShader });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.frameBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const maxPages = Math.min(this.options.maxPages, device.limits.maxTextureArrayLayers),
      limit = device.limits.maxTextureDimension2D;
    if (this.sdfAtlas && this.colorAtlas) {
      this.sdfAtlas.restore(device);
      this.colorAtlas.restore(device);
    } else {
      this.sdfAtlas = new GlyphAtlas(device, 'r8unorm', Math.min(this.options.atlasSize, limit), maxPages);
      this.colorAtlas = new GlyphAtlas(device, 'rgba8unorm', Math.min(this.options.colorAtlasSize, limit), maxPages);
    }
    this.group = undefined;
    this.groupKey = '';
    this.uploaded = -1;
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  onPreUpdate(delta: number): void {
    if (!this.disposed) this.ui.update(delta);
  }

  private pipeline(
    format: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    count: number,
    glyphs: boolean,
  ): GPURenderPipeline {
    const key = `${format}|${depthFormat}|${count}|${glyphs}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.module!,
        blend: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
      pipeline = this.device!.createRenderPipeline({
        layout: this.pipelineLayout!,
        vertex: { module, entryPoint: glyphs ? 'glyphVertex' : 'rectVertex' },
        fragment: {
          module,
          entryPoint: glyphs ? 'glyphFragment' : 'rectFragment',
          targets: [{ format, blend: { color: blend, alpha: blend } }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private readonly execute = (context: PassContext): void => {
    this.stats.rects = this.stats.glyphs = this.stats.drawCalls = this.stats.uploads = 0;
    if (context.backend !== 'webgpu' || !this.device || !this.engine || context.device !== this.device) return;
    const view = context.view;
    if (view && view.index !== view.count - 1) return;
    this.draw(context);
  };

  /** Turn the draw list into rect and glyph instances and the runs that draw them. */
  private build(list: DrawList): void {
    this.runs.length = 0;
    let rectCount = 0,
      glyphCount = 0;
    const clips: [number, number, number, number][] = [];
    let clip: readonly [number, number, number, number] | null = null;
    const push = (glyphs: boolean, count: number) => {
      const last = this.runs.at(-1);
      const first = glyphs ? glyphCount - count : rectCount - count;
      if (last && last.glyphs === glyphs && last.clip === clip && last.first + last.count === first)
        last.count += count;
      else this.runs.push({ glyphs, first, count, clip });
    };
    for (const command of list.commands) {
      switch (command.type) {
        case 'clip':
          clips.push((clip = [command.x, command.y, command.width, command.height]));
          break;
        case 'unclip':
          clips.pop();
          clip = clips.at(-1) ?? null;
          break;
        case 'rect': {
          if ((rectCount + 1) * RECT_FLOATS > this.rects.length)
            this.rects = grow(this.rects, (rectCount + 1) * RECT_FLOATS);
          const o = rectCount++ * RECT_FLOATS,
            r = this.rects;
          r.set([command.x, command.y, command.width, command.height], o);
          r.set(command.fill, o + 4);
          r.set(command.border, o + 8);
          r.set([command.radius, command.borderWidth, command.blur, 0], o + 12);
          push(false, 1);
          break;
        }
        case 'text': {
          const before = glyphCount;
          glyphCount = this.placeText(command, glyphCount);
          if (glyphCount > before) push(true, glyphCount - before);
          break;
        }
      }
    }
    this.rectCount = rectCount;
    this.glyphCount = glyphCount;
  }
  private rectCount = 0;
  private glyphCount = 0;

  /** Place the glyphs of a text command into `this.glyphs` from index `at`; an outline is a layer drawn under the fill. */
  private placeText(command: TextCommand, at: number): number {
    const { layout, font, scale } = command;
    if (!font.loaded) {
      void font.load();
      return at;
    }
    const k = layout.fontSize / font.size,
      layers = command.outlineWidth > 0 ? 2 : 1;
    for (let layer = 0; layer < layers; layer++) {
      const outline = layers === 2 && layer === 0,
        color = outline ? command.outlineColor : command.color;
      for (const g of layout.glyphs) {
        if (g.whitespace) continue;
        const bitmap = font.glyph(g.cluster);
        if (!bitmap || (outline && bitmap.color)) continue;
        const atlas = bitmap.color ? this.colorAtlas! : this.sdfAtlas!,
          slot = atlas.place(bitmap),
          size = atlas.size;
        if ((at + 1) * GLYPH_FLOATS > this.glyphs.length) this.glyphs = grow(this.glyphs, (at + 1) * GLYPH_FLOATS);
        const o = at++ * GLYPH_FLOATS,
          d = this.glyphs,
          x0 = command.x + (g.x + bitmap.left * k) * scale,
          baseline = command.y - g.y * scale,
          y0 = baseline - bitmap.top * k * scale;
        d[o] = x0;
        d[o + 1] = y0;
        d[o + 2] = x0 + bitmap.width * k * scale;
        d[o + 3] = y0 + bitmap.height * k * scale;
        d[o + 4] = slot.x / size;
        d[o + 5] = slot.y / size;
        d[o + 6] = (slot.x + bitmap.width) / size;
        d[o + 7] = (slot.y + bitmap.height) / size;
        d.set(color, o + 8);
        d[o + 12] = slot.page;
        d[o + 13] = bitmap.color ? 1 : 0;
        d[o + 14] = outline ? command.outlineWidth : 0;
        d[o + 15] = 0;
      }
    }
    return at;
  }

  private ensureBuffers(rects: number, glyphs: number): boolean {
    const device = this.device!;
    let changed = false;
    if (!this.rectBuffer || rects > this.rectCapacity) {
      this.rectBuffer?.destroy();
      this.rectCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, rects))));
      this.rectBuffer = device.createBuffer({
        size: this.rectCapacity * RECT_FLOATS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      changed = true;
    }
    if (!this.glyphBuffer || glyphs > this.glyphCapacity) {
      this.glyphBuffer?.destroy();
      this.glyphCapacity = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, glyphs))));
      this.glyphBuffer = device.createBuffer({
        size: this.glyphCapacity * GLYPH_FLOATS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      changed = true;
    }
    return changed;
  }

  private draw(context: GpuContext): void {
    const ui = this.ui,
      device = this.device!,
      canvas = (this.engine as unknown as { canvas?: HTMLCanvasElement }).canvas,
      cssWidth = canvas?.clientWidth || 0,
      ratio = cssWidth > 0 ? context.width / cssWidth : (globalThis.devicePixelRatio ?? 1);
    // The drawing buffer is the canvas in device pixels; the UI works in CSS pixels times the pixel ratio.
    ui.resize(context.width / ratio, context.height / ratio, ratio);
    const list = ui.draw(),
      atlasKey = `${this.sdfAtlas!.generation}|${this.colorAtlas!.generation}`;
    let fresh = false;
    if (this.uploaded !== list.version || this.uploadedAtlas !== atlasKey) {
      this.build(list);
      fresh = this.ensureBuffers(this.rectCount, this.glyphCount);
      if (this.rectCount)
        device.queue.writeBuffer(
          this.rectBuffer!,
          0,
          this.rects as Float32Array<ArrayBuffer>,
          0,
          this.rectCount * RECT_FLOATS,
        );
      if (this.glyphCount)
        device.queue.writeBuffer(
          this.glyphBuffer!,
          0,
          this.glyphs as Float32Array<ArrayBuffer>,
          0,
          this.glyphCount * GLYPH_FLOATS,
        );
      this.stats.uploads++;
      // Building may have grown the atlases; the key then changes and the glyph pages are re-read.
      this.uploaded = list.version;
      this.uploadedAtlas = `${this.sdfAtlas!.generation}|${this.colorAtlas!.generation}`;
    }
    this.stats.rects = this.rectCount;
    this.stats.glyphs = this.glyphCount;
    if (!this.runs.length) return;
    const key = `${this.sdfAtlas!.generation}|${this.colorAtlas!.generation}`;
    if (!this.group || fresh || key !== this.groupKey) {
      this.group = device.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: { buffer: this.frameBuffer! } },
          { binding: 1, resource: this.sampler! },
          { binding: 2, resource: this.sdfAtlas!.view },
          { binding: 3, resource: this.colorAtlas!.view },
          { binding: 4, resource: { buffer: this.rectBuffer! } },
          { binding: 5, resource: { buffer: this.glyphBuffer! } },
        ],
      });
      this.groupKey = key;
    }
    const linear = context.format.endsWith('-srgb') || context.format.includes('float');
    const f = this.frameData;
    f[0] = context.width;
    f[1] = context.height;
    f[2] = linear ? 1 : 0;
    f[3] = 0;
    f[4] = SDF_DEFAULTS.radius;
    f[5] = SDF_DEFAULTS.cutoff;
    device.queue.writeBuffer(this.frameBuffer!, 0, f);
    this.descriptor.colorAttachments[0].view = context.color;
    this.descriptor.depthStencilAttachment.view = context.depth;
    const depthFormat = context.descriptor.depthStencil!.format,
      samples = context.descriptor.multisample?.count ?? 1;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    pass.setBindGroup(0, this.group);
    let current: boolean | undefined;
    for (const run of this.runs) {
      if (run.glyphs !== current) {
        pass.setPipeline(this.pipeline(context.format, depthFormat, samples, run.glyphs));
        current = run.glyphs;
      }
      const c = run.clip,
        x = c ? Math.max(0, Math.min(context.width, c[0])) : 0,
        y = c ? Math.max(0, Math.min(context.height, c[1])) : 0,
        w = c ? Math.max(0, Math.min(context.width - x, c[2] - (x - c[0]))) : context.width,
        h = c ? Math.max(0, Math.min(context.height - y, c[3] - (y - c[1]))) : context.height;
      if (!w || !h) continue;
      pass.setScissorRect(x, y, w, h);
      pass.draw(6, run.count, 0, run.first);
      this.stats.drawCalls++;
    }
    pass.end();
  }

  onDeviceRestored(engine: Engine): void {
    this.releaseGpu(false);
    this.setup(engine);
  }

  private releaseGpu(atlases: boolean): void {
    this.frameBuffer?.destroy();
    this.rectBuffer?.destroy();
    this.glyphBuffer?.destroy();
    if (atlases) {
      this.sdfAtlas?.dispose();
      this.colorAtlas?.dispose();
      this.sdfAtlas = this.colorAtlas = undefined;
    }
    this.frameBuffer =
      this.rectBuffer =
      this.glyphBuffer =
      this.group =
      this.module =
      this.layout =
      this.pipelineLayout =
      this.sampler =
      this.device =
        undefined;
    this.rectCapacity = this.glyphCapacity = 0;
    this.pipelines.clear();
    this.uploaded = -1;
  }

  /** Release every GPU resource, atlases included. The `Ui` is not disposed. */
  dispose(): void {
    this.disposed = true;
    this.releaseGpu(true);
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol.for('Symbol.dispose')) as symbol](): void {
    this.dispose();
  }
}

function grow(array: Float32Array<ArrayBuffer>, needed: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(Math.max(needed, array.length * 2));
  next.set(array);
  return next;
}
