/// <reference lib="esnext.disposable" preserve="true" />
import type { GlyphBitmap } from './font.js';
import { ShelfPacker, type AtlasSlot } from './packer.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number } | undefined;

const ATLAS_TEXTURE_USAGE =
  typeof GPUTextureUsage !== 'undefined'
    ? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
    : 0x04 | 0x02 | 0x01;

/** Sizes for {@link glyphAtlases}. */
export interface GlyphAtlasSizes {
  /** SDF page size in texels. */
  atlasSize: number;
  /** Colour (emoji) page size in texels. */
  colorAtlasSize: number;
  /** Page limit of each atlas. */
  maxPages: number;
}

/**
 * The two atlases a glyph renderer draws from on `device`: single-channel SDF glyphs and RGBA colour glyphs, each page
 * limited by the device's texture size. Pass the pair a previous device used as `previous` to restore its glyphs on this one.
 */
export function glyphAtlases(
  device: GPUDevice,
  sizes: GlyphAtlasSizes,
  previous?: { sdf: GlyphAtlas; color: GlyphAtlas },
): { sdf: GlyphAtlas; color: GlyphAtlas } {
  if (previous) {
    previous.sdf.restore(device);
    previous.color.restore(device);
    return previous;
  }
  const limit = device.limits.maxTextureDimension2D;
  return {
    sdf: new GlyphAtlas(device, 'r8unorm', Math.min(sizes.atlasSize, limit), sizes.maxPages),
    color: new GlyphAtlas(device, 'rgba8unorm', Math.min(sizes.colorAtlasSize, limit), sizes.maxPages),
  };
}

/**
 * Removes `glyph`'s slot from `slots` and clears its page in `packer` when no other slot is left on it. Returns the
 * freed page, -1 when the page still holds other slots, or undefined when the glyph had no slot. Shared by atlases
 * that pack with a ShelfPacker (the WebGPU GlyphAtlas and the UI's WebGL2 atlas).
 */
export function releaseSlot(slots: Map<GlyphBitmap, AtlasSlot>, packer: ShelfPacker, glyph: GlyphBitmap): number | undefined {
  const slot = slots.get(glyph);
  if (!slot) return undefined;
  slots.delete(glyph);
  for (const other of slots.values()) if (other.page === slot.page) return -1;
  packer.clearPage(slot.page);
  return slot.page;
}

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
  private readonly pageLastUsed: number[] = [];
  private clock = 0;

  /** Optional predicate deciding whether `page` may be evicted. Return true to permit eviction. */
  canEvict?: (page: number, atlas: GlyphAtlas) => boolean;

  /** Optional callback invoked when `page` is evicted. */
  onEvict?: (page: number, atlas: GlyphAtlas) => void;

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
      usage: ATLAS_TEXTURE_USAGE,
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

  /** Touches a page so LRU eviction knows when it was last accessed. */
  touch(page: number): void {
    this.pageLastUsed[page] = ++this.clock;
  }

  /**
   * Frees a page and removes all its glyph slots so new glyphs can be packed into it.
   * Returns true if the page was evicted, false if the page index was invalid.
   */
  evictPage(page: number): boolean {
    if (!Number.isInteger(page) || page < 0 || page >= this.packer.pageCount) return false;
    for (const [glyph, slot] of this.slots) {
      if (slot.page === page) {
        this.slots.delete(glyph);
      }
    }
    this.packer.clearPage(page);
    this.pageLastUsed[page] = 0;
    this.onEvict?.(page, this);
    this.generation++;
    return true;
  }

  /**
   * Frees a page and removes all glyph slots on it.
   * If `page` is omitted, evicts the least recently used evictable page.
   * Returns true if a page was evicted, false if no page could be evicted.
   */
  evict(page?: number): boolean {
    if (page !== undefined) return this.evictPage(page);
    let candidate = -1;
    let oldest = Infinity;
    for (let p = 0; p < this.packer.pageCount; p++) {
      if (this.canEvict && !this.canEvict(p, this)) continue;
      const last = this.pageLastUsed[p] ?? 0;
      if (last < oldest) {
        oldest = last;
        candidate = p;
      }
    }
    if (candidate >= 0) return this.evictPage(candidate);
    return false;
  }

  /**
   * Drops one bitmap's slot (an image no longer drawn), so the atlas stops holding it; a page left with no slot is freed
   * for new bitmaps. Returns false when the bitmap had no slot.
   */
  release(glyph: GlyphBitmap): boolean {
    const page = releaseSlot(this.slots, this.packer, glyph);
    if (page !== undefined && page >= 0) this.pageLastUsed[page] = 0;
    return page !== undefined;
  }

  /** Returns the glyph's slot, packing and uploading it first if needed. Throws when the atlas is full. */
  place(glyph: GlyphBitmap): AtlasSlot {
    let slot = this.slots.get(glyph);
    if (slot) {
      this.touch(slot.page);
      return slot;
    }
    let packed = this.packer.pack(glyph.width, glyph.height);
    if (!packed && this.evict()) {
      packed = this.packer.pack(glyph.width, glyph.height);
    }
    if (!packed)
      throw new RangeError(
        `Glyph atlas is full (${this.packer.maxPages} pages of ${this.size}px); raise maxPages or atlasSize, or use fewer glyphs and sizes.`,
      );
    slot = packed;
    this.touch(slot.page);
    if (slot.page >= this.layers)
      this.allocate(Math.min(this.packer.maxPages, Math.max(slot.page + 1, this.layers * 2)));
    this.upload(glyph, slot);
    this.slots.set(glyph, slot);
    return slot;
  }

  private upload(glyph: GlyphBitmap, slot: AtlasSlot): void {
    this.device.queue.writeTexture(
      { texture: this.texture!, origin: [slot.x, slot.y, slot.page] },
      (this.bytesPerTexel === 4 ? glyph.msdf ?? glyph.data : glyph.data) as Uint8Array<ArrayBuffer>,
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
    this.pageLastUsed.length = 0;
    this.clock = 0;
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
