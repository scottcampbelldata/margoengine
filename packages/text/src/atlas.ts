/// <reference lib="esnext.disposable" preserve="true" />
import type { GlyphBitmap } from './font.js';
import { ShelfPacker, type AtlasSlot } from './packer.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number };

/**
 * A growable texture-array glyph atlas. Glyphs are shelf-packed on demand and uploaded one by one with
 * writeTexture. When the pages run out the array grows (doubling its layers, copying the old ones on the
 * GPU), so existing slots stay valid. CPU bitmaps are kept by the fonts, so a restored device re-uploads them.
 */
export class GlyphAtlas {
  readonly packer: ShelfPacker;
  readonly slots = new Map<GlyphBitmap, AtlasSlot>();
  /** Bumped whenever the texture object changes; bind groups must be rebuilt then. */
  generation = 0;
  private texture?: GPUTexture;
  private textureView?: GPUTextureView;
  private layers = 0;

  constructor(
    private device: GPUDevice,
    readonly format: 'r8unorm' | 'rgba8unorm',
    size: number,
    maxPages: number,
  ) {
    this.packer = new ShelfPacker(size, maxPages, 1);
  }

  get size(): number {
    return this.packer.size;
  }
  get pages(): number {
    return this.packer.pageCount;
  }
  private get bytesPerTexel(): number {
    return this.format === 'r8unorm' ? 1 : 4;
  }

  /** The array view to bind; a 1x1 placeholder until the first glyph arrives. */
  get view(): GPUTextureView {
    if (!this.textureView) this.allocate(0);
    return this.textureView!;
  }

  private allocate(layers: number): void {
    const size = layers ? this.size : 1,
      count = Math.max(1, layers);
    const texture = this.device.createTexture({
      size: [size, size, count],
      format: this.format,
      dimension: '2d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    const previous = this.texture,
      previousLayers = this.layers;
    if (previous && previousLayers && layers) {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture: previous }, { texture }, [
        this.size,
        this.size,
        Math.min(previousLayers, layers),
      ]);
      this.device.queue.submit([encoder.finish()]);
    }
    previous?.destroy();
    this.texture = texture;
    this.textureView = texture.createView({ dimension: '2d-array' });
    this.layers = layers;
    this.generation++;
  }

  /** Returns the glyph's slot, packing and uploading it first if needed. Throws when the atlas is full. */
  place(glyph: GlyphBitmap): AtlasSlot {
    let slot = this.slots.get(glyph);
    if (slot) return slot;
    const packed = this.packer.pack(glyph.width, glyph.height);
    if (!packed) throw new RangeError(`Glyph atlas is full (${this.packer.maxPages} pages of ${this.size}px)`);
    slot = packed;
    if (slot.page >= this.layers)
      this.allocate(Math.min(this.packer.maxPages, Math.max(slot.page + 1, this.layers * 2)));
    this.upload(glyph, slot);
    this.slots.set(glyph, slot);
    return slot;
  }

  private upload(glyph: GlyphBitmap, slot: AtlasSlot): void {
    this.device.queue.writeTexture(
      { texture: this.texture!, origin: [slot.x, slot.y, slot.page] },
      glyph.data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: glyph.width * this.bytesPerTexel, rowsPerImage: glyph.height },
      [glyph.width, glyph.height, 1],
    );
  }

  /** Recreates the texture on a new device and re-uploads every glyph at its existing slot. */
  restore(device: GPUDevice): void {
    this.device = device;
    this.texture = this.textureView = undefined;
    const layers = this.layers;
    this.layers = 0;
    this.allocate(layers);
    for (const [glyph, slot] of this.slots) this.upload(glyph, slot);
  }

  dispose(): void {
    this.texture?.destroy();
    this.texture = this.textureView = undefined;
    this.layers = 0;
    this.slots.clear();
    this.packer.clear();
    this.generation++;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
