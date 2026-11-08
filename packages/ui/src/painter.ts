import { type GlyphAtlas, SDF_DEFAULTS, glyphAtlases } from '@margoengine/text';
import type { DrawList, TextCommand } from './draw.js';
import { uiShader } from './shader.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Premultiplied alpha: colour and alpha both blend as source + destination * (1 - source alpha). */
export const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const ATLAS: GPUTextureBindingLayout = { sampleType: 'float', viewDimension: '2d-array' };
/** Two triangles per instance, both faces drawn. */
const OVERLAY = { primitive: { topology: 'triangle-list', cullMode: 'none' } } as const;
const RECT_FLOATS = 16,
  GLYPH_FLOATS = 16;

/** Atlas options of a painter. */
export interface PainterOptions {
  atlasSize: number;
  colorAtlasSize: number;
  maxPages: number;
}

/** The target a painter draws into: its size in pixels, colour format, depth format (none for a plain texture) and samples. */
export interface PaintTarget {
  width: number;
  height: number;
  format: GPUTextureFormat;
  depthFormat?: GPUTextureFormat;
  samples: number;
}

/** Counts for the latest frame. */
export interface PaintStats {
  rects: number;
  glyphs: number;
  drawCalls: number;
  uploads: number;
}

interface Run {
  glyphs: boolean;
  first: number;
  count: number;
  clip: readonly [number, number, number, number] | null;
}

/**
 * The WebGPU drawing core shared by the screen renderer and world panels: turns a {@link DrawList} into rounded
 * rectangle and SDF glyph instances, uploads them only when the list or the atlases changed, and encodes the instanced
 * draws into a render pass the caller opened.
 * @internal
 */
export class UiPainter {
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
  private readonly frameData = new Float32Array(8);
  private rects: Float32Array<ArrayBuffer> = new Float32Array(RECT_FLOATS * 256);
  private glyphs: Float32Array<ArrayBuffer> = new Float32Array(GLYPH_FLOATS * 1024);
  private runs: Run[] = [];
  private rectCount = 0;
  private glyphCount = 0;
  private uploaded = -1;
  private uploadedAtlas = '';
  private fresh = false;

  constructor(
    private readonly options: PainterOptions,
    readonly stats: PaintStats,
  ) {}

  /** Create the GPU resources on `device` (again after a device loss). Atlases survive a restore and are re-uploaded. */
  setup(device: GPUDevice): void {
    this.device = device;
    const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform', minBindingSize: 32 } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // The SDF atlas and the colour atlas, then the rectangle and glyph instance buffers.
        ...[2, 3].map(
          (binding): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: ATLAS }),
        ),
        ...[4, 5].map(
          (binding): GPUBindGroupLayoutEntry => ({ binding, visibility: both, buffer: { type: 'read-only-storage' } }),
        ),
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
    const atlases = glyphAtlases(
      device,
      { ...this.options, maxPages: Math.min(this.options.maxPages, device.limits.maxTextureArrayLayers) },
      this.sdfAtlas && this.colorAtlas ? { sdf: this.sdfAtlas, color: this.colorAtlas } : undefined,
    );
    this.sdfAtlas = atlases.sdf;
    this.colorAtlas = atlases.color;
    this.group = undefined;
    this.groupKey = '';
    this.uploaded = -1;
  }

  get ready(): boolean {
    return !!this.device;
  }

  /** The version of the last list uploaded, or -1. */
  get version(): number {
    return this.uploaded;
  }

  /** The key of the atlas pages the last upload placed glyphs on; it changes when a page is added or rebuilt. */
  get atlasKey(): string {
    return `${this.sdfAtlas?.generation}|${this.colorAtlas?.generation}`;
  }

  /**
   * Upload `list` when it or the atlases changed since the last call. Returns false when there is nothing to draw.
   * Resets the stats.
   */
  prepare(list: DrawList): boolean {
    const stats = this.stats;
    stats.rects = stats.glyphs = stats.drawCalls = stats.uploads = 0;
    if (!this.device) return false;
    const device = this.device;
    if (this.uploaded !== list.version || this.uploadedAtlas !== this.atlasKey) {
      this.build(list);
      this.fresh = this.ensureBuffers(this.rectCount, this.glyphCount) || this.fresh;
      if (this.rectCount) device.queue.writeBuffer(this.rectBuffer!, 0, this.rects, 0, this.rectCount * RECT_FLOATS);
      if (this.glyphCount)
        device.queue.writeBuffer(this.glyphBuffer!, 0, this.glyphs, 0, this.glyphCount * GLYPH_FLOATS);
      stats.uploads++;
      // Building may have grown the atlases; the key then changes and the glyph pages are re-read.
      this.uploaded = list.version;
      this.uploadedAtlas = this.atlasKey;
    }
    stats.rects = this.rectCount;
    stats.glyphs = this.glyphCount;
    return this.runs.length > 0;
  }

  /** Encode the prepared draws into `pass`, an open render pass on `target`. */
  encode(pass: GPURenderPassEncoder, target: PaintTarget): void {
    const device = this.device!;
    const key = this.atlasKey;
    if (!this.group || this.fresh || key !== this.groupKey) {
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
      this.fresh = false;
    }
    const { width, height, format } = target;
    const f = this.frameData;
    f[0] = width;
    f[1] = height;
    f[2] = format.endsWith('-srgb') || format.includes('float') ? 1 : 0;
    f[3] = 0;
    f[4] = SDF_DEFAULTS.radius;
    f[5] = SDF_DEFAULTS.cutoff;
    device.queue.writeBuffer(this.frameBuffer!, 0, f);
    pass.setBindGroup(0, this.group);
    let current: boolean | undefined;
    for (const run of this.runs) {
      if (run.glyphs !== current) {
        pass.setPipeline(this.pipeline(target, run.glyphs));
        current = run.glyphs;
      }
      const c = run.clip,
        x = c ? Math.max(0, Math.min(width, c[0])) : 0,
        y = c ? Math.max(0, Math.min(height, c[1])) : 0,
        w = c ? Math.max(0, Math.min(width - x, c[2] - (x - c[0]))) : width,
        h = c ? Math.max(0, Math.min(height - y, c[3] - (y - c[1]))) : height;
      if (!w || !h) continue;
      pass.setScissorRect(x, y, w, h);
      pass.draw(6, run.count, 0, run.first);
      this.stats.drawCalls++;
    }
  }

  private pipeline(target: PaintTarget, glyphs: boolean): GPURenderPipeline {
    const { format, depthFormat, samples } = target;
    const key = `${format}|${depthFormat}|${samples}|${glyphs}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.module!,
        stage = glyphs ? 'glyph' : 'rect';
      pipeline = this.device!.createRenderPipeline({
        ...OVERLAY,
        layout: this.pipelineLayout!,
        vertex: { module, entryPoint: `${stage}Vertex` },
        fragment: { module, entryPoint: `${stage}Fragment`, targets: [{ format, blend: PREMULTIPLIED }] },
        multisample: { count: samples },
        ...(depthFormat
          ? { depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' as const } }
          : {}),
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

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

  /** Release the GPU resources; with `atlases`, the glyph atlases too. */
  release(atlases: boolean): void {
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
}

function grow(array: Float32Array<ArrayBuffer>, needed: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(Math.max(needed, array.length * 2));
  next.set(array);
  return next;
}
