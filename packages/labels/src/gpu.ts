/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import type { Font, GlyphBitmap, ShelfPacker, TextLayout, AtlasSlot } from '@margoengine/text';
import { applyView } from '../../shared/view-rect.js';
import { fault, rangeError } from '../../shared/errors.js';
import { gpuLabelShader } from './gpu-shader.js';
import { LabelGL } from './gpu-gl.js';

type TextAPI = typeof import('@margoengine/text');
/** A GPU label. Positions use world units; fontSize and offset use CSS pixels. */
export interface GPULabel {
  text: string;
  position: readonly [number, number, number];
  /** Default 16 CSS pixels, independent of camera distance and device pixel ratio. */
  fontSize?: number;
  /** Straight RGBA in [0, 1]. Default white. */
  color?: readonly [number, number, number, number];
  /** Higher priorities win decluttering. Default 0; ties keep input order. */
  priority?: number;
  offset?: readonly [number, number];
  visible?: boolean;
}
/** Options for the optional, one-draw GPU label plugin. */
export interface GPULabelOptions {
  font?: Font;
  /** Default 'gpu-labels'. */
  name?: string;
  /** Default 24, after opaque geometry. */
  order?: number;
  /** Default true. Exact glyph bounds are tested through a screen-space grid. */
  declutter?: boolean;
  /** Grid side in CSS pixels. Default 64. */
  cell?: number;
  /** Label spacing in CSS pixels. Default 2. */
  padding?: number;
  /** Atlas page side in texels. Default 1024. */
  atlasSize?: number;
  /** Maximum atlas pages. Default 32; device limits still apply. */
  maxPages?: number;
  signal?: AbortSignal;
}

interface GlyphRecord {
  bitmap: GlyphBitmap;
  slot: AtlasSlot;
  pixels: Uint8Array;
}
interface Shape {
  layout: TextLayout;
  glyphs: { record: GlyphRecord; rect: number[] }[];
  bounds: number[];
}

let attachSerial = 0;


/** Waits for `work`, but rejects with the signal's reason the moment it aborts (the work then ends unobserved). */
async function untilOrAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await work;
    return;
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  work.catch(() => {});
  try {
    await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
  signal.throwIfAborted();
}

/** The canvas's content box in CSS pixels: its bounding rectangle less any border and padding the drawing never covers. */
function contentRect(canvas: HTMLCanvasElement): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  if (typeof Element === 'undefined' || !(canvas instanceof Element) || typeof getComputedStyle !== 'function') return rect;
  const style = getComputedStyle(canvas),
    px = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
  return {
    width: rect.width - px('border-left-width') - px('border-right-width') - px('padding-left') - px('padding-right'),
    height: rect.height - px('border-top-width') - px('border-bottom-width') - px('padding-top') - px('padding-bottom'),
  };
}

/**
 * Screen-constant, SDF label layer with one instanced draw across all labels and atlas pages.
 * Create asynchronously, then attach with engine.use(layer). No DOM elements per point.
 */
export class GPULabelLayer implements EnginePlugin {
  /** Loads the font and registers the layer. Default options match create(). */
  static async attach(engine: EngineKernel, options: GPULabelOptions = {}): Promise<GPULabelLayer> {
    // Snapshot the active scene before the load yields: the layer joins the scene attach was called for.
    const runtime = engine as Engine;
    let scene: ReturnType<Engine['sceneOf']>;
    const scope: EnginePlugin = {
      name: 'gpu-labels:attach:' + attachSerial++,
      setup() {
        scene = runtime.sceneOf(scope);
      },
    };
    runtime.use(scope);
    scene!.removePlugin(scope.name);
    const layer = await GPULabelLayer.create(options);
    try {
      options.signal?.throwIfAborted();
      scene!.use(layer);
      return layer;
    } catch (error) {
      layer.dispose();
      throw error;
    }
  }
  readonly name: string;
  readonly order: number;
  readonly font: Font;
  /** Latest prepared label and glyph counts, exact grid comparisons, and actual draw calls. */
  readonly stats = { labels: 0, glyphs: 0, hidden: 0, comparisons: 0, drawCalls: 0 };
  private labels: readonly GPULabel[] = [];
  private readonly shapes = new Map<string, Shape>();
  private readonly records = new Map<GlyphBitmap, GlyphRecord>();
  private readonly packer: ShelfPacker;
  private readonly options: Required<
    Pick<GPULabelOptions, 'declutter' | 'cell' | 'padding' | 'atlasSize' | 'maxPages'>
  >;
  private revision = -1;
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private instances?: GPUBuffer;
  private texture?: GPUTexture;
  private group?: GPUBindGroup;
  private sampler?: GPUSampler;
  private pipeline?: GPURenderPipeline;
  private pipelineKey = '';
  private capacity = 0;
  private uploaded = -1;
  private gl?: LabelGL;
  private data = new Float32Array(0);
  private readonly matrix = new Float32Array(16);
  private readonly frame = new Float32Array(20);

  private constructor(
    private readonly api: TextAPI,
    options: GPULabelOptions,
  ) {
    this.name = options.name ?? 'gpu-labels';
    this.order = options.order ?? 24;
    this.font = options.font ?? new api.Font();
    this.options = {
      declutter: options.declutter ?? true,
      cell: options.cell ?? 64,
      padding: options.padding ?? 2,
      atlasSize: options.atlasSize ?? 1024,
      maxPages: options.maxPages ?? 32,
    };
    if (!this.name || !Number.isFinite(this.order)) throw rangeError('give a nonempty name and finite order', 'labels');
    const { cell, padding, atlasSize, maxPages } = this.options;
    if (!Number.isFinite(cell) || cell < 1 || !Number.isFinite(padding) || padding < 0)
      throw rangeError('use cell >= 1 and padding >= 0 in CSS pixels', 'labels');
    this.packer = new api.ShelfPacker(atlasSize, maxPages, 1);
  }

  /** Lazily loads text support and fonts. Cancellation is checked before and after loading. */
  static async create(options: GPULabelOptions = {}): Promise<GPULabelLayer> {
    options.signal?.throwIfAborted();
    const layer = new GPULabelLayer(await import('@margoengine/text'), options);
    await untilOrAborted(layer.font.load(), options.signal);
    return layer;
  }

  /** Replaces the collection. Label fields may also be edited between frames. */
  setLabels(labels: readonly GPULabel[]): this {
    this.labels = labels;
    return this;
  }

  /**
   * Prepares packed glyph instances without drawing, also useful for headless layout inspection.
   * matrix is the camera view-projection; dimensions are positive CSS pixels. Returned storage is reused.
   */
  prepare(
    matrix: ArrayLike<number>,
    width: number,
    height: number,
    backend: 'webgpu' | 'webgl2' = 'webgpu',
  ): Float32Array {
    if (
      matrix.length !== 16 ||
      !Array.from(matrix).every(Number.isFinite) ||
      !Number.isFinite(width) ||
      width <= 0 ||
      !Number.isFinite(height) ||
      height <= 0
    )
      throw rangeError('provide a finite 4x4 matrix and positive CSS viewport dimensions', 'labels');
    if (this.revision !== this.font.revision) {
      this.shapes.clear();
      this.revision = this.font.revision;
    }
    const stats = this.stats;
    stats.labels = stats.glyphs = stats.hidden = stats.comparisons = stats.drawCalls = 0;
    const grid = new Map<string, number[]>(),
      rects: number[][] = [];
    const order = this.labels.map((_, i) => i);
    for (const l of this.labels) {
      if (
        typeof l.text !== 'string' ||
        l.position.length !== 3 ||
        !l.position.every(Number.isFinite) ||
        !Number.isFinite(l.fontSize ?? 16) ||
        (l.fontSize ?? 16) <= 0 ||
        !Number.isFinite(l.priority ?? 0) ||
        (l.offset && (l.offset.length !== 2 || !l.offset.every(Number.isFinite))) ||
        (l.color && (l.color.length !== 4 || !l.color.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)))
      )
        throw rangeError('use text, finite positions and priorities, positive fontSize, and RGBA in [0,1]', 'labels');
    }
    order.sort((a, b) => (this.labels[b].priority ?? 0) - (this.labels[a].priority ?? 0) || a - b);
    const { cell, padding, declutter } = this.options;
    const used = new Set<string>();
    for (const index of order) {
      const l = this.labels[index];
      if (l.visible === false || !l.text) {
        stats.hidden++;
        continue;
      }
      const [x, y, z] = l.position;
      const cx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        cy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      const cz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
        cw = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
      if (cw <= 0 || cz > cw || cz < (backend === 'webgpu' ? 0 : -cw)) {
        stats.hidden++;
        continue;
      }
      const key = JSON.stringify([l.text, l.fontSize ?? 16]);
      used.add(key);
      const shape = this.shape(key, l),
        dx = l.offset?.[0] ?? 0,
        dy = l.offset?.[1] ?? 0;
      const sx = ((cx / cw + 1) * width) / 2 + dx,
        sy = ((1 - cy / cw) * height) / 2 + dy;
      const box = [sx + shape.bounds[0], sy + shape.bounds[1], sx + shape.bounds[2], sy + shape.bounds[3]];
      if (box[2] < 0 || box[0] > width || box[3] < 0 || box[1] > height) {
        stats.hidden++;
        continue;
      }
      const cells: string[] = [];
      // Clip the grid to the viewport: long labels cannot create unbounded offscreen cell loops.
      for (
        let r = Math.floor(Math.max(-padding, box[1] - padding) / cell);
        r <= Math.floor(Math.min(height + padding, box[3] + padding) / cell);
        r++
      )
        for (
          let c = Math.floor(Math.max(-padding, box[0] - padding) / cell);
          c <= Math.floor(Math.min(width + padding, box[2] + padding) / cell);
          c++
        )
          cells.push(`${c},${r}`);
      let overlaps = false;
      if (declutter) {
        const seen = new Set<number>();
        for (const k of cells)
          for (const i of grid.get(k) ?? []) {
            if (seen.has(i)) continue;
            seen.add(i);
            stats.comparisons++;
            const b = rects[i];
            if (
              box[0] < b[2] + padding &&
              b[0] < box[2] + padding &&
              box[1] < b[3] + padding &&
              b[1] < box[3] + padding
            )
              overlaps = true;
          }
      }
      if (overlaps) {
        stats.hidden++;
        continue;
      }
      if (declutter) {
        const i = rects.push(box) - 1;
        for (const k of cells) {
          let bucket = grid.get(k);
          if (!bucket) grid.set(k, (bucket = []));
          bucket.push(i);
        }
      }
      if (this.data.length < (stats.glyphs + shape.glyphs.length) * 20) {
        const grown = new Float32Array(Math.max((stats.glyphs + shape.glyphs.length) * 20, this.data.length * 2, 320));
        grown.set(this.data);
        this.data = grown;
      }
      for (const g of shape.glyphs) {
        const { bitmap, slot } = g.record,
          o = stats.glyphs++ * 20,
          size = this.options.atlasSize;
        this.data.set(
          [
            x,
            y,
            z,
            1,
            g.rect[0] + dx,
            g.rect[1] + dy,
            g.rect[2] + dx,
            g.rect[3] + dy,
            slot.x / size,
            slot.y / size,
            (slot.x + bitmap.width) / size,
            (slot.y + bitmap.height) / size,
            ...(l.color ?? [1, 1, 1, 1]),
            slot.page,
            bitmap.color ? 1 : 0,
            this.font.radius,
            this.font.cutoff,
          ],
          o,
        );
      }
      stats.labels++;
    }
    for (const key of this.shapes.keys()) if (!used.has(key)) this.shapes.delete(key);
    return this.data.subarray(0, stats.glyphs * 20);
  }

  private shape(key: string, label: GPULabel): Shape {
    let shape = this.shapes.get(key);
    if (shape) return shape;
    const size = label.fontSize ?? 16,
      scale = size / this.font.size;
    const layout = this.api.layoutText(label.text, { fontSize: size, anchorX: 'center', anchorY: 'middle' }, this.font);
    shape = { layout, glyphs: [], bounds: [Infinity, Infinity, -Infinity, -Infinity] };
    for (const g of layout.glyphs) {
      if (g.whitespace) continue;
      const bitmap = this.font.glyph(g.cluster);
      if (!bitmap) continue;
      let record = this.records.get(bitmap);
      if (!record) {
        const slot = this.packer.pack(bitmap.width, bitmap.height);
        if (!slot) throw fault('state', 'label atlas full; increase atlasSize or maxPages', 'labels');
        const pixels = new Uint8Array(bitmap.width * bitmap.height * 4);
        if (bitmap.color) pixels.set(bitmap.data);
        else
          for (let p = 0; p < bitmap.data.length; p++) {
            pixels[p * 4] = bitmap.data[p];
            pixels[p * 4 + 3] = 255;
          }
        record = { bitmap, slot, pixels };
        this.records.set(bitmap, record);
      }
      const left = g.x + bitmap.left * scale,
        top = -g.y - bitmap.top * scale;
      const rect = [left, top, left + bitmap.width * scale, top + bitmap.height * scale];
      for (let i = 0; i < 4; i++)
        shape.bounds[i] = i < 2 ? Math.min(shape.bounds[i], rect[i]) : Math.max(shape.bounds[i], rect[i]);
      shape.glyphs.push({ record, rect });
    }
    this.shapes.set(key, shape);
    return shape;
  }

  setup(engine: Engine): void {
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: this.order, execute: (c) => this.draw(c) });
  }
  private draw(context: PassContext): void {
    const canvas = this.engine!.canvas,
      rect = contentRect(canvas);
    const viewport = context.view?.viewport ?? [0, 0, context.width, context.height];
    const width = (viewport[2] * (rect.width || context.width)) / context.width;
    const height = (viewport[3] * (rect.height || context.height)) / context.height;
    this.matrix.set(context.camera.matrix);
    const data = this.prepare(this.matrix, width, height, context.backend);
    if (!data.length) return;
    const records = [...this.records.values()];
    if (context.backend === 'webgl2') {
      this.gl ??= new LabelGL(context.gl);
      this.gl.draw(context, data, this.matrix, width, height, this.options.atlasSize, this.packer.pageCount, records);
    } else this.drawGPU(context, data, width, height, records);
    this.stats.drawCalls = 1;
  }
  private drawGPU(
    context: Extract<PassContext, { backend: 'webgpu' }>,
    data: Float32Array,
    width: number,
    height: number,
    records: GlyphRecord[],
  ): void {
    const device = context.device;
    if (device !== this.device) {
      this.releaseGPU();
      this.device = device;
    }
    const key = `${context.format}/${context.descriptor.multisample?.count ?? 1}`;
    if (!this.pipeline || key !== this.pipelineKey) {
      const module = device.createShaderModule({ code: gpuLabelShader });
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 80,
              stepMode: 'instance',
              attributes: Array.from({ length: 5 }, (_, i) => ({
                shaderLocation: i,
                offset: i * 16,
                format: 'float32x4' as const,
              })),
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: context.format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
        multisample: context.descriptor.multisample,
      });
      this.pipelineKey = key;
      this.group = undefined;
    }
    this.uniform ??= device.createBuffer({ size: 80, usage: 0x40 | 0x08 });
    this.sampler ??= device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    if (!this.instances || data.byteLength > this.capacity) {
      this.instances?.destroy();
      this.capacity = Math.max(320, data.byteLength);
      if (this.capacity > device.limits.maxBufferSize)
        throw rangeError('glyph buffer exceeds device limit; reduce collection size', 'labels');
      this.instances = device.createBuffer({ size: this.capacity, usage: 0x20 | 0x08 });
    }
    if (this.uploaded !== records.length) {
      this.texture?.destroy();
      this.texture = device.createTexture({
        size: [this.options.atlasSize, this.options.atlasSize, this.packer.pageCount],
        format: 'rgba8unorm',
        usage: 0x04 | 0x02,
      });
      for (const r of records)
        device.queue.writeTexture(
          { texture: this.texture, origin: [r.slot.x, r.slot.y, r.slot.page] },
          r.pixels as Uint8Array<ArrayBuffer>,
          { bytesPerRow: r.bitmap.width * 4 },
          [r.bitmap.width, r.bitmap.height, 1],
        );
      this.uploaded = records.length;
      this.group = undefined;
    }
    this.group ??= device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.texture!.createView({ dimension: '2d-array' }) },
      ],
    });
    this.frame.set(this.matrix);
    this.frame.set([width, height, 0, 0], 16);
    device.queue.writeBuffer(this.uniform, 0, this.frame);
    device.queue.writeBuffer(this.instances, 0, data as Float32Array<ArrayBuffer>);
    const pass = context.encoder.beginRenderPass({
      colorAttachments: [{ view: context.color, loadOp: 'load', storeOp: 'store' }],
    });
    applyView(pass, context);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.setVertexBuffer(0, this.instances);
    pass.draw(6, data.length / 20);
    pass.end();
  }
  private releaseGPU(): void {
    this.uniform?.destroy();
    this.instances?.destroy();
    this.texture?.destroy();
    this.uniform = this.instances = undefined;
    this.texture = undefined;
    this.group = undefined;
    this.pipeline = undefined;
    this.sampler = undefined;
    this.device = undefined;
    this.uploaded = -1;
  }
  onDeviceRestored(engine: Engine): void {
    this.releaseGPU();
    this.gl?.dispose();
    this.gl = undefined;
    this.engine = engine;
  }
  /** Releases GPU resources; CPU labels can be reused after attaching again. */
  dispose(): void {
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.releaseGPU();
    this.gl?.dispose();
    this.gl = undefined;
    this.engine = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
