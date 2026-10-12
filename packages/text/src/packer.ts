/** A rectangle placed in an atlas page, in texels. */
export interface AtlasSlot {page: number; x: number; y: number; width: number; height: number}

interface Shelf {y: number; height: number; x: number}

/**
 * Shelf packer over square pages. Each glyph goes on the first shelf of similar height with room left,
 * otherwise on a new shelf, otherwise on a new page. Slots never move, so growing the atlas only appends pages.
 */
export class ShelfPacker {
  readonly pages: Shelf[][] = [];
  private readonly used: number[] = [];

  /**
   * @param size Page width and height in texels.
   * @param maxPages Pages allowed before `pack` returns null.
   * @param padding Empty texels kept between neighbours so filtering never bleeds.
   */
  constructor(readonly size: number, readonly maxPages = 256, readonly padding = 1) {
    if (!Number.isInteger(size) || size < 8 || !Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(padding) || padding < 0) throw new RangeError('Invalid atlas packer options');
  }

  /** Pages in use. */
  get pageCount(): number {return this.pages.length;}

  /** Fraction of the allocated pages' area covered by packed rectangles. */
  get occupancy(): number {
    if (!this.pages.length) return 0;
    return this.used.reduce((sum, value) => sum + value, 0) / (this.pages.length * this.size * this.size);
  }

  /** Reserves width x height texels. Returns null when the rectangle cannot fit even on an empty page or maxPages is reached. */
  pack(width: number, height: number): AtlasSlot | null {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('Packed rectangles need positive integer sizes');
    const w = width + this.padding, h = height + this.padding, size = this.size;
    if (w > size || h > size) return null;
    for (let page = 0; page < this.pages.length; page++) {
      const shelves = this.pages[page];
      let best: Shelf | undefined;
      for (const shelf of shelves) if (shelf.height >= h && shelf.height <= Math.ceil(h * 1.3) + 2 && shelf.x + w <= size && (!best || shelf.height < best.height)) best = shelf;
      if (!best) {
        const last = shelves[shelves.length - 1], y = last ? last.y + last.height : 0;
        if (y + h <= size) {best = {y, height: h, x: 0}; shelves.push(best);}
        else {
          // A tall rectangle that leaves short shelves unused still fits on any shelf with room and height.
          for (const shelf of shelves) if (shelf.height >= h && shelf.x + w <= size) {best = shelf; break;}
        }
      }
      if (best) {
        const slot = {page, x: best.x, y: best.y, width, height};
        best.x += w; this.used[page] += width * height;
        return slot;
      }
    }
    if (this.pages.length >= this.maxPages) return null;
    this.pages.push([{y: 0, height: h, x: w}]); this.used.push(width * height);
    return {page: this.pages.length - 1, x: 0, y: 0, width, height};
  }

  /** Forgets every slot. */
  clear(): void {this.pages.length = 0; this.used.length = 0;}
}
