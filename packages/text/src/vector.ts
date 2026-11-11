/// <reference lib="esnext.disposable" preserve="true" />
import { requireWebGPU } from '../../shared/require-webgpu.js';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { LinearToSRGB as encodeSrgb } from '@margoengine/math/color';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { viewMatrix } from '../../shared/view.js';
import { applyView, viewSize } from '../../shared/view-rect.js';
import { overlayPass } from '../../shared/pass.js';
import { FontOutlines, parseFontOutlines } from './font-outlines.js';
import type { FontVariationOptions } from './font-variation.js';
import { Font } from './font.js';
import { Text } from './text.js';
import { toQuadratics, VectorGlyphStore, type VectorGlyph } from './vector-glyph.js';
import { vectorTextShader } from './vector-shader.js';

export { toQuadratics, vectorCoverage, VectorGlyphStore, CUBIC_TOLERANCE, MAX_BANDS, BAND_TARGET, ROOT_CODES, WINDOW_SLOTS, DEFAULT_RAYS, SMALL_PPEM } from './vector-glyph.js';
export type { Quadratic, VectorGlyph, VectorCoverageOptions } from './vector-glyph.js';
export { vectorTextShader } from './vector-shader.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number } | undefined;
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number } | undefined;

const STAGE_VERTEX = typeof GPUShaderStage !== 'undefined' ? GPUShaderStage.VERTEX : 1;
const STAGE_FRAGMENT = typeof GPUShaderStage !== 'undefined' ? GPUShaderStage.FRAGMENT : 2;
const UNIFORM_COPY = typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST : 0x0040 | 0x0008;
const STORAGE_COPY = typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST : 0x0080 | 0x0008;
const GLYPH_FLOATS = 12,
  BLOCK_BYTES = 160,
  FRAME_BYTES = 112;

/** Default-ignorable code points (joiners, variation selectors) draw nothing in the vector path. */
const IGNORABLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;
let families = 0;

/** Options for `new VectorFont(...)`. */
export interface VectorFontOptions extends FontVariationOptions {
  /** CSS family the font registers under for measurement and the `TextRenderer` fallback. Default a unique name. */
  family?: string;
}

/** A glyph of a cluster: the packed glyph and its pen offset in em. */
export interface VectorClusterGlyph {
  readonly glyph: VectorGlyph;
  readonly x: number;
}

/**
 * A font for vector text: the outline file itself (TrueType or CFF, variable fonts at fixed axis values). Text
 * using it lays out with the file's own advances and ascent; where a FontFace can be registered (browsers and
 * workers) it also measures pair kerning through it and still works with the SDF `TextRenderer`. Glyph bands are
 * built once per glyph, on first use, into a store shared by every renderer.
 */
export class VectorFont extends Font {
  /** The parsed outlines. */
  readonly outlines: FontOutlines;
  /** Packed bands of every glyph built so far. */
  readonly store = new VectorGlyphStore();
  private readonly packed = new Map<number, VectorGlyph>();
  private readonly clusters = new Map<string, VectorClusterGlyph[]>();
  private readonly varied: boolean;

  constructor(data: ArrayBuffer | ArrayBufferView, options: VectorFontOptions = {}) {
    const outlines = parseFontOutlines(data, options);
    const family = options.family ?? `margo-vector-${++families}`;
    let face: FontFace | undefined;
    if (typeof FontFace !== 'undefined') {
      const settings = Object.entries(options.variations ?? {})
        .map(([tag, value]) => `"${tag}" ${value}`)
        .join(', ');
      face = new FontFace(family, data as BufferSource, settings ? { variationSettings: settings } : {});
    }
    super({ family, face });
    this.outlines = outlines;
    this.varied = Object.keys(options.variations ?? {}).length > 0;
  }

  /** Units per em of the font file. */
  get unitsPerEm(): number {
    return this.outlines.unitsPerEm;
  }

  /** The packed bands of a glyph id, built on first use. */
  vectorGlyph(id: number): VectorGlyph {
    let glyph = this.packed.get(id);
    if (!glyph) {
      glyph = this.store.add(id, toQuadratics(this.outlines.getGlyphSegments(id)));
      this.packed.set(id, glyph);
    }
    return glyph;
  }

  /** Glyphs of a grapheme cluster with their pen offsets: one per code point, default-ignorable ones skipped. */
  clusterGlyphs(cluster: string): readonly VectorClusterGlyph[] {
    let list = this.clusters.get(cluster);
    if (!list) {
      list = [];
      let x = 0;
      for (const char of cluster) {
        if (IGNORABLE.test(char)) continue;
        const id = this.outlines.glyphIndex(char);
        list.push({ glyph: this.vectorGlyph(id), x });
        x += this.outlines.glyphAdvance(id);
      }
      this.clusters.set(cluster, list);
    }
    return list;
  }

  /** Advance in em from the font file (variations applied): the sum over the cluster's code points. */
  override advance(cluster: string): number {
    let total = 0;
    for (const char of cluster) if (!IGNORABLE.test(char)) total += this.outlines.glyphAdvance(this.outlines.glyphIndex(char));
    return total;
  }

  /** Pair kerning measured through the registered FontFace once it has loaded; 0 without one or for a variable instance. */
  override kerning(left: string, right: string): number {
    if (this.varied || !this.face || this.face.status !== 'loaded') return 0;
    return super.kerning(left, right);
  }

  /** Ascent and descent in em from the font's horizontal header. */
  override metrics(): { ascent: number; descent: number } {
    return { ascent: this.outlines.ascender / this.unitsPerEm, descent: -this.outlines.descender / this.unitsPerEm };
  }
}

/** Options for the `VectorTextRenderer` plugin. */
export interface VectorTextRendererOptions {
  /** Plugin name, unique per engine. Default 'text:vector'. */
  name?: string;
  /** Frame graph order. Default 22, the same slot as `TextRenderer`. */
  order?: number;
  /**
   * Outline growth in screen pixels, 0 to 1; makes small text darker without changing its layout. Default 0:
   * coverage is the exact box-filtered area along each axis, which keeps every stem (docs/limits.md).
   */
  dilation?: number;
  /**
   * Rays per pixel and axis: 1, 3 or 5, or 'auto' for 5 under 7.5 pixels per em and 3 from there up. More rays resolve corners
   * and crossing strokes better and cost more only near curves (pixels wholly in or out cast one per axis).
   * Default 'auto'.
   */
  rays?: 'auto' | 1 | 3 | 5;
}

interface FontGpu {
  buffer: GPUBuffer;
  /** Bytes. */
  capacity: number;
  /** u32 words uploaded. */
  uploaded: number;
  generation: number;
}

interface Resources {
  uniform: GPUBuffer;
  glyphs: GPUBuffer;
  group: GPUBindGroup;
  font: VectorFont;
  fontGeneration: number;
  capacity: number;
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

type GpuContext = Extract<PassContext, { backend: 'webgpu' }>;

let warnedOutline = false;

/**
 * Engine plugin that draws `Text` blocks whose font is a {@link VectorFont} from the glyph outlines themselves:
 * no atlas, sharp at every size, zoom and rotation, thin stems kept at 4 px. One instanced draw per block over the
 * scene color and depth, reversed-Z depth test without depth writes, premultiplied alpha, blocks sorted back to
 * front. Fill, opacity, hard or blurred shadows, billboards, on-top, clip rectangles, mesh attachment and curved
 * baselines work as in `TextRenderer`; outlines (`outlineWidth`) are not drawn. WebGPU and the WebGL2
 * compatibility layer; the small WebGL2 preview throws `unsupported`.
 */
export class VectorTextRenderer implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  /** Outline growth in pixels; may be changed at any time (0..1). */
  dilation: number;
  /** Rays per pixel and axis ('auto', 1, 3 or 5); may be changed at any time. */
  rays: 'auto' | 1 | 3 | 5;
  /** Work counts of the latest frame. */
  readonly stats = { texts: 0, glyphs: 0, drawCalls: 0, bufferWrites: 0, bytesWritten: 0, bindGroups: 0 };
  private readonly members = new Set<Text>();
  private readonly resources = new Map<Text, Resources>();
  private readonly fonts = new Map<VectorFont, FontGpu>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private engine?: Engine;
  private device?: GPUDevice;
  private module?: GPUShaderModule;
  private layouts?: { frame: GPUBindGroupLayout; block: GPUBindGroupLayout; pipeline: GPUPipelineLayout };
  private frameBuffer?: GPUBuffer;
  private frameGroup?: GPUBindGroup;
  private readonly frameData = new Float32Array(FRAME_BYTES / 4);
  private readonly view = new Float32Array(16);
  private readonly depthTexts: Array<Resources> = [];
  private readonly topTexts: Array<Resources> = [];
  private readonly frameTexts: Array<{ text: Text; font: VectorFont; parent: Float32Array | null; built?: { data: Float32Array; count: number } }> = [];
  private readonly descriptor = overlayPass();
  private readonly colorAttachment = this.descriptor.colorAttachments[0];
  private readonly depthAttachment = this.descriptor.depthStencilAttachment;

  /** Same as `engine.use(new VectorTextRenderer(...))`; returns the renderer. */
  static attach(engine: EngineKernel, options?: VectorTextRendererOptions): VectorTextRenderer {
    const value = new VectorTextRenderer(options);
    engine.use(value);
    return value;
  }

  constructor(options: VectorTextRendererOptions = {}) {
    this.name = options.name ?? 'text:vector';
    this.order = options.order ?? 22;
    this.dilation = options.dilation ?? 0;
    this.rays = options.rays ?? 'auto';
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw new TypeError('Invalid VectorTextRenderer options; give name a non-empty string and order a finite number.');
    this.checkOptions();
  }

  private checkOptions(): void {
    if (typeof this.dilation !== 'number' || !(this.dilation >= 0 && this.dilation <= 1))
      throw new RangeError('VectorTextRenderer dilation must be 0..1 pixels');
    if (this.rays !== 'auto' && this.rays !== 1 && this.rays !== 3 && this.rays !== 5)
      throw new RangeError("VectorTextRenderer rays must be 'auto', 1, 3 or 5");
  }

  /** Texts currently drawn by this plugin. */
  get texts(): ReadonlySet<Text> {
    return this.members;
  }

  /** Adds a text whose font is a VectorFont. Throws a TypeError otherwise. */
  add<T extends Text>(text: T): T {
    if (!(text instanceof Text)) throw new TypeError('Expected a Text');
    if (!(text.font instanceof VectorFont))
      throw new TypeError('VectorTextRenderer draws Text with a VectorFont; pass font: new VectorFont(bytes)');
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
    requireWebGPU(engine, 'VectorTextRenderer');
    this.engine = engine;
    const device = (this.device = engine.gpu),
      both = STAGE_VERTEX | STAGE_FRAGMENT;
    const frame = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: both, buffer: { type: 'uniform', minBindingSize: FRAME_BYTES } }],
    });
    const block = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform', minBindingSize: BLOCK_BYTES } },
        { binding: 1, visibility: STAGE_VERTEX, buffer: { type: 'read-only-storage', minBindingSize: GLYPH_FLOATS * 4 } },
        { binding: 2, visibility: STAGE_FRAGMENT, buffer: { type: 'read-only-storage', minBindingSize: 16 } },
      ],
    });
    this.layouts = { frame, block, pipeline: device.createPipelineLayout({ bindGroupLayouts: [frame, block] }) };
    this.module = device.createShaderModule({ code: vectorTextShader });
    this.frameBuffer = device.createBuffer({ size: FRAME_BYTES, usage: UNIFORM_COPY });
    this.frameGroup = device.createBindGroup({ layout: frame, entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }] });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  private pipeline(format: GPUTextureFormat, depthFormat: GPUTextureFormat, onTop: boolean, count: number): GPURenderPipeline {
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
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: onTop ? 'always' : 'greater-equal' },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** Uploads rows the font's store gained since the last frame; reallocates (new generation) when full. */
  private syncFont(font: VectorFont): FontGpu {
    const device = this.device!,
      store = font.store;
    let gpu = this.fonts.get(font);
    const bytes = Math.max(16, store.length * 4);
    if (!gpu || gpu.capacity < bytes) {
      const limit = device.limits.maxStorageBufferBindingSize;
      if (bytes > limit)
        throw new MargoError('unsupported', `VectorFont bands need ${bytes} bytes, over this device's ${limit}-byte storage binding limit; draw fewer distinct glyphs per font`);
      let capacity = Math.max(65536, gpu?.capacity ?? 0);
      while (capacity < bytes) capacity *= 2;
      capacity = Math.min(capacity, limit - (limit % 16));
      gpu?.buffer.destroy();
      gpu = { buffer: device.createBuffer({ size: capacity, usage: STORAGE_COPY }), capacity, uploaded: 0, generation: (gpu?.generation ?? 0) + 1 };
      this.fonts.set(font, gpu);
    }
    if (gpu.uploaded < store.length) {
      device.queue.writeBuffer(gpu.buffer, gpu.uploaded * 4, store.data as Uint32Array<ArrayBuffer>, gpu.uploaded, store.length - gpu.uploaded);
      this.stats.bufferWrites++;
      this.stats.bytesWritten += (store.length - gpu.uploaded) * 4;
      gpu.uploaded = store.length;
    }
    return gpu;
  }

  private ensure(text: Text, font: VectorFont, gpu: FontGpu, count: number): Resources {
    const device = this.device!;
    let r = this.resources.get(text);
    if (r && r.capacity >= count && r.font === font && r.fontGeneration === gpu.generation) return r;
    const capacity = r && r.capacity >= count ? r.capacity : Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    const created: GPUBuffer[] = [];
    try {
      const make = (size: number, usage: number) => {
        const buffer = device.createBuffer({ size, usage });
        created.push(buffer);
        return buffer;
      };
      const uniform = r?.uniform ?? make(BLOCK_BYTES, UNIFORM_COPY);
      const reuse = r && r.capacity >= count;
      const glyphs = reuse ? r!.glyphs : make(capacity * GLYPH_FLOATS * 4, STORAGE_COPY);
      const group = device.createBindGroup({
        layout: this.layouts!.block,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: glyphs } },
          { binding: 2, resource: { buffer: gpu.buffer } },
        ],
      });
      this.stats.bindGroups++;
      if (!reuse) r?.glyphs.destroy();
      const block = r?.block ?? new ArrayBuffer(BLOCK_BYTES);
      r = {
        uniform,
        glyphs,
        group,
        font,
        fontGeneration: gpu.generation,
        capacity,
        written: reuse ? r!.written : -1,
        count: r?.count ?? 0,
        block,
        floats: r?.floats ?? new Float32Array(block),
        uints: r?.uints ?? new Uint32Array(block),
        last: r?.last ?? new Float32Array(BLOCK_BYTES / 4).fill(Number.NaN),
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

  /** Glyph instances of a text: placed em boxes, band offsets. Builds missing glyph bands. */
  private build(text: Text, font: VectorFont, data: Float32Array): { data: Float32Array; count: number } {
    const layout = text.layout,
      size = text.fontSize;
    let count = 0,
      uints = new Uint32Array(data.buffer);
    for (const g of layout.glyphs) {
      if (g.whitespace) continue;
      for (const part of font.clusterGlyphs(g.cluster)) {
        const glyph = part.glyph;
        if (!glyph.bands) continue;
        if (data.length < (count + 1) * GLYPH_FLOATS) {
          const next = new Float32Array(Math.max(16 * GLYPH_FLOATS, data.length * 2));
          next.set(data);
          data = next;
        }
        if (uints.buffer !== data.buffer) uints = new Uint32Array(data.buffer);
        const o = count * GLYPH_FLOATS,
          [x0, y0, x1, y1] = glyph.box;
        data[o] = g.x + (part.x + x0) * size;
        data[o + 1] = g.y + y0 * size;
        data[o + 2] = g.x + (part.x + x1) * size;
        data[o + 3] = g.y + y1 * size;
        data[o + 4] = x0;
        data[o + 5] = y0;
        data[o + 6] = x1;
        data[o + 7] = y1;
        uints[o + 8] = glyph.base;
        uints[o + 9] = glyph.bands;
        uints[o + 10] = glyph.orientation > 0 ? 1 : 0;
        uints[o + 11] = 0;
        count++;
      }
    }
    return { data, count };
  }

  private readonly execute = (context: PassContext): void => {
    const stats = this.stats;
    stats.texts = stats.glyphs = stats.drawCalls = stats.bufferWrites = stats.bytesWritten = stats.bindGroups = 0;
    if (context.backend !== 'webgpu' || !this.device || !this.engine || context.device !== this.device) return;
    this.checkOptions();
    this.draw(context);
  };

  private draw(context: GpuContext): void {
    const engine = this.engine as unknown as EngineKernel,
      device = this.device!,
      camera = context.camera;
    const linearTarget = context.format.endsWith('-srgb') || context.format.includes('float');
    const encode = (value: number) => (linearTarget ? value : encodeSrgb(Math.min(1, value)));
    this.depthTexts.length = this.topTexts.length = 0;
    const frame = this.frameTexts;
    frame.length = 0;
    // Pass 1, CPU only: layouts and new glyph bands, so every font store is final before any GPU buffer is sized.
    for (const text of this.members) {
      if (!text.visible) continue;
      const font = text.font;
      if (!(font instanceof VectorFont)) continue;
      if (!font.loaded) {
        void font.load();
        continue;
      }
      text.validate();
      if (text.outlineWidth > 0 && text.outlineOpacity > 0 && !warnedOutline) {
        warnedOutline = true;
        console.warn('@margoengine/text/vector: outlineWidth is not drawn by VectorTextRenderer; use TextRenderer for outlined text.');
      }
      const mesh = text.attachedMesh,
        parent = mesh ? meshWorldMatrix(engine, mesh) : null;
      if (mesh && !parent) continue;
      text.layout;
      const r = this.resources.get(text),
        built = !r || r.written !== text.layoutVersion || r.font !== font ? this.build(text, font, r?.instances ?? new Float32Array(0)) : undefined;
      frame.push({ text, font, parent, built });
    }
    for (const entry of frame) this.syncFont(entry.font);
    for (const { text, font, parent, built } of frame) {
      const layout = text.layout;
      const r = this.ensure(text, font, this.fonts.get(font)!, built ? built.count : this.resources.get(text)!.count);
      if (built) {
        r.instances = built.data;
        r.count = built.count;
        if (built.count) {
          device.queue.writeBuffer(r.glyphs, 0, built.data as Float32Array<ArrayBuffer>, 0, built.count * GLYPH_FLOATS);
          this.stats.bufferWrites++;
          this.stats.bytesWritten += built.count * GLYPH_FLOATS * 4;
        }
        r.written = text.layoutVersion;
      }
      if (!r.count) continue;
      const model = parent ? multiplyMatrices(parent, text.matrix, r.model) : text.matrix;
      const f = r.floats,
        u = r.uints,
        opacity = text.opacity;
      f.set(model, 0);
      f[16] = encode(text.color[0]);
      f[17] = encode(text.color[1]);
      f[18] = encode(text.color[2]);
      f[19] = opacity;
      f[20] = encode(text.shadowColor[0]);
      f[21] = encode(text.shadowColor[1]);
      f[22] = encode(text.shadowColor[2]);
      f[23] = opacity * text.shadowOpacity;
      f[24] = text.shadowOffset[0];
      f[25] = text.shadowOffset[1];
      f[26] = text.shadowBlur;
      f[27] = this.dilation;
      const shadow = text.shadowOpacity > 0;
      u[28] = r.count;
      u[29] = shadow ? 2 : 1;
      u[30] = shadow ? 0 | (2 << 2) : 2;
      u[31] = text.billboard ? 1 : 0;
      f[32] = text.fontSize;
      f[33] = layout.curveRadius ?? 0;
      f[34] = layout.curveSegments ?? 1;
      f[35] = this.rays === 'auto' ? 0 : this.rays;
      f.set(layout.clipRect ?? [-3.4e38, -3.4e38, 3.4e38, 3.4e38], 36);
      let changed = false;
      for (let i = 0; i < BLOCK_BYTES / 4; i++)
        if (!Object.is(r.last[i], f[i])) {
          changed = true;
          break;
        }
      if (changed) {
        device.queue.writeBuffer(r.uniform, 0, r.block);
        r.last.set(f);
        this.stats.bufferWrites++;
        this.stats.bytesWritten += BLOCK_BYTES;
      }
      const dx = model[12] - camera.position[0],
        dy = model[13] - camera.position[1],
        dz = model[14] - camera.position[2];
      r.depth = dx * dx + dy * dy + dz * dz;
      (text.onTop ? this.topTexts : this.depthTexts).push(r);
      this.stats.texts++;
      this.stats.glyphs += r.count;
    }
    if (!this.depthTexts.length && !this.topTexts.length) return;
    this.writeFrame(context, linearTarget);
    this.colorAttachment.view = context.color;
    this.depthAttachment.view = context.depth;
    const depthFormat = context.descriptor.depthStencil!.format;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    applyView(pass, context);
    pass.setBindGroup(0, this.frameGroup!);
    for (const [list, onTop] of [
      [this.depthTexts, false],
      [this.topTexts, true],
    ] as const) {
      if (!list.length) continue;
      list.sort((a, b) => b.depth - a.depth);
      pass.setPipeline(this.pipeline(context.format, depthFormat, onTop, context.descriptor.multisample?.count ?? 1));
      for (const r of list) {
        pass.setBindGroup(1, r.group);
        pass.draw(6 * r.floats[34], r.count * r.uints[29]);
        this.stats.drawCalls++;
      }
    }
    pass.end();
    this.depthTexts.length = this.topTexts.length = 0;
  }

  private writeFrame(context: GpuContext, linearTarget: boolean): void {
    const camera = context.camera,
      data = this.frameData,
      [width, height] = viewSize(context);
    data.set(camera.matrix, 0);
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
    data[25] = width;
    data[26] = height;
    data[27] = 0;
    // The frame uniform is written every drawn frame (camera may move): one 112-byte write.
    this.device!.queue.writeBuffer(this.frameBuffer!, 0, data);
    this.stats.bufferWrites++;
    this.stats.bytesWritten += FRAME_BYTES;
  }

  onDeviceRestored(engine: Engine): void {
    this.releaseGpu();
    this.setup(engine);
  }

  private releaseGpu(): void {
    for (const text of [...this.resources.keys()]) this.release(text);
    for (const gpu of this.fonts.values()) gpu.buffer.destroy();
    this.fonts.clear();
    this.pipelines.clear();
    this.frameBuffer?.destroy();
    this.frameBuffer = this.frameGroup = this.module = this.layouts = this.device = undefined;
  }

  /** Releases every GPU resource. Texts stay registered, so the plugin can be used again. */
  dispose(): void {
    this.releaseGpu();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
