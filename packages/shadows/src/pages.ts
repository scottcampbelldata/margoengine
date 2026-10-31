// Virtual shadow map page bookkeeping: pure CPU, no GPU types, so all of it runs under Node. A clipmap of `levels` square
// light-space windows around the camera, each PAGES_PER_SIDE pages wide, each level's pages twice the size of the one
// before. A page's address (level, ix, iy) is absolute in light space, so camera motion only requests new pages at the
// window edges; the table slot is the address modulo the window (toroidal), so a table entry stays put while its page is
// in the window. Virtual texturing and clipmap residency: Tanner et al. 1998 "The Clipmap"; Fernando et al. 2001
// "Adaptive Shadow Maps"; Lefebvre, Darbon & Neyret 2004 "Unified Texture Management"; Epic's public Unreal docs on
// virtual shadow maps (page pool, page table, cached static pages).

/** Pages per side of one clipmap level's window. */
export const PAGES_PER_SIDE = 16;
/** Texels per side of one physical page. */
export const PAGE_TEXELS = 128;
/** Texels each page repeats of its neighbour on every side, so a bilinear comparison stays seamless across pages. */
export const PAGE_GUARD = 1;
/** Texels per side of a page's own light-space square. */
export const PAGE_INTERIOR = PAGE_TEXELS - 2 * PAGE_GUARD;
/** Bit of a table entry: the entry names a resident page. */
export const ENTRY_VALID = 0x10000;
/** Bit of a table entry: the page holds static casters only (no moving caster reaches it). */
export const ENTRY_CACHED = 0x20000;

/**
 * World size of one page at level 0: the coarsest window reaches at least `distance` from the camera in every
 * light-space direction, wherever the camera sits inside its centre page.
 */
export const basePageSize = (distance: number, levels: number): number =>
  distance / (PAGES_PER_SIDE / 2 - 1) / 2 ** (levels - 1);
/** World size of one page of `level`. */
export const pageSize = (base: number, level: number): number => base * 2 ** level;
/** The page index holding light-space coordinate `x` on a level with pages of `size`. */
export const pageIndex = (x: number, size: number): number => Math.floor(x / size);
/** The table slot of a page: its layer `level`, row and column taken modulo the window. */
export const tableSlot = (level: number, ix: number, iy: number): number => {
  const mask = PAGES_PER_SIDE - 1;
  return (level * PAGES_PER_SIDE + (iy & mask)) * PAGES_PER_SIDE + (ix & mask);
};
/** Whether page index `i` lies in the window centred on page `center`. */
export const inWindow = (i: number, center: number): boolean =>
  i >= center - PAGES_PER_SIDE / 2 && i < center + PAGES_PER_SIDE / 2;

/** Options of a {@link PagePool}. */
export interface PagePoolOptions {
  /** Clipmap levels. */
  levels: number;
  /** World size of a level 0 page. */
  base: number;
  /** Physical pages per side of the pool. */
  poolPages: number;
  /** Most resident pages, at most the pool's. Default the pool's. */
  budgetPages?: number;
}
const key = (level: number, ix: number, iy: number) =>
  (((ix + 2 ** 23) * 2 ** 24 + (iy + 2 ** 23)) * 16 + level) as number;
const EMPTY = -1;
/**
 * The resident set of a virtual shadow map: which absolute pages hold a physical slot, the last frame each was
 * requested, and which need drawing. Eviction happens only when the budget is full and takes the least recently
 * requested page (the finer on a tie); a page requested this frame is never evicted.
 */
export class PagePool {
  readonly levels: number;
  readonly base: number;
  readonly poolPages: number;
  /** Most resident pages. */
  readonly capacity: number;
  /** Pages asked for this frame that found no slot: every slot was requested this frame too. */
  overflow = 0;
  private readonly slots = new Map<number, number>();
  private readonly free: number[] = [];
  private readonly pageLevel: Uint8Array;
  private readonly pageX: Int32Array;
  private readonly pageY: Int32Array;
  private readonly lastUsed: Int32Array;
  private readonly used: Uint8Array;
  /** Per slot: the static casters must draw again. */
  readonly stale: Uint8Array;
  /** Per slot: a moving caster's bounds reached the page this frame. */
  readonly touched: Uint8Array;
  /** Per slot: a moving caster's bounds reached the page last frame, so it holds that caster's old depth. */
  readonly touchedBefore: Uint8Array;
  private frame = 0;
  constructor({ levels, base, poolPages, budgetPages }: PagePoolOptions) {
    this.levels = levels;
    this.base = base;
    this.poolPages = poolPages;
    const pages = poolPages * poolPages;
    this.capacity = budgetPages ?? pages;
    this.pageLevel = new Uint8Array(pages);
    this.pageX = new Int32Array(pages);
    this.pageY = new Int32Array(pages);
    this.lastUsed = new Int32Array(pages);
    this.used = new Uint8Array(pages);
    this.stale = new Uint8Array(pages);
    this.touched = new Uint8Array(pages);
    this.touchedBefore = new Uint8Array(pages);
    for (let slot = this.capacity - 1; slot >= 0; slot--) this.free.push(slot);
  }
  /** Resident pages now. */
  get resident(): number {
    return this.slots.size;
  }
  /** Starts a frame: pages requested from here on count as requested now. */
  beginFrame(): void {
    this.frame++;
    this.overflow = 0;
    this.touchedBefore.set(this.touched);
    this.touched.fill(0);
  }
  /** The slot of a page, or -1 when it is not resident. */
  find(level: number, ix: number, iy: number): number {
    return this.slots.get(key(level, ix, iy)) ?? EMPTY;
  }
  /**
   * Makes a page resident and marks it requested this frame. A new page is stale, so it draws. Returns its slot, or -1
   * when the budget is full of pages requested this frame (the receiver then reads a coarser level).
   */
  request(level: number, ix: number, iy: number): number {
    const k = key(level, ix, iy);
    let slot = this.slots.get(k) ?? EMPTY;
    if (slot === EMPTY) {
      slot = this.free.length ? this.free.pop()! : this.evict();
      if (slot === EMPTY) {
        this.overflow++;
        return EMPTY;
      }
      this.slots.set(k, slot);
      this.used[slot] = 1;
      this.pageLevel[slot] = level;
      this.pageX[slot] = ix;
      this.pageY[slot] = iy;
      this.stale[slot] = 1;
      this.touched[slot] = this.touchedBefore[slot] = 0;
    }
    this.lastUsed[slot] = this.frame;
    return slot;
  }
  private evict(): number {
    let best = EMPTY;
    for (let slot = 0; slot < this.capacity; slot++) {
      if (!this.used[slot] || this.lastUsed[slot] === this.frame) continue;
      if (
        best === EMPTY ||
        this.lastUsed[slot] < this.lastUsed[best] ||
        (this.lastUsed[slot] === this.lastUsed[best] && this.pageLevel[slot] < this.pageLevel[best])
      )
        best = slot;
    }
    if (best !== EMPTY) {
      this.slots.delete(key(this.pageLevel[best], this.pageX[best], this.pageY[best]));
      this.used[best] = 0;
    }
    return best;
  }
  /** Whether slot `slot` holds a page. */
  isUsed(slot: number): boolean {
    return this.used[slot] === 1;
  }
  /** The address of the page in `slot` into `out` (level, ix, iy). */
  address(slot: number, out: number[]): number[] {
    out[0] = this.pageLevel[slot];
    out[1] = this.pageX[slot];
    out[2] = this.pageY[slot];
    return out;
  }
  /** Whether a light-space circle reaches the page in `slot`, its guard texels included. */
  reaches(slot: number, x: number, y: number, radius: number): boolean {
    const size = pageSize(this.base, this.pageLevel[slot]),
      guard = (size * PAGE_GUARD) / PAGE_INTERIOR,
      low = this.pageX[slot] * size - guard,
      bottom = this.pageY[slot] * size - guard,
      reach = size + 2 * guard,
      dx = x - (x < low ? low : x > low + reach ? low + reach : x),
      dy = y - (y < bottom ? bottom : y > bottom + reach ? bottom + reach : y);
    return dx * dx + dy * dy <= radius * radius;
  }
  /** Marks every resident page the static casters must draw again. */
  invalidateAll(): void {
    this.stale.set(this.used);
  }
  /** Marks stale exactly the resident pages a light-space circle reaches; returns how many. */
  invalidateCircle(x: number, y: number, radius: number): number {
    let marked = 0;
    for (let slot = 0; slot < this.capacity; slot++)
      if (this.used[slot] && this.reaches(slot, x, y, radius)) {
        this.stale[slot] = 1;
        marked++;
      }
    return marked;
  }
  /** Marks exactly the resident pages a moving caster's light-space circle reaches this frame; returns how many. */
  touchCircle(x: number, y: number, radius: number): number {
    let marked = 0;
    for (let slot = 0; slot < this.capacity; slot++)
      if (this.used[slot] && this.reaches(slot, x, y, radius)) {
        this.touched[slot] = 1;
        marked++;
      }
    return marked;
  }
  /** Marks every resident page reached by a moving caster of unknown bounds. */
  touchAll(): void {
    this.touched.set(this.used);
  }
  /**
   * Writes the page table: one u32 per slot of `table` (tableSlot), a resident page inside its level's window gets its
   * physical x, y and the valid bit, every other slot 0. `centers` holds each level's centre page, x then y.
   */
  writeTable(table: Uint32Array, centers: ArrayLike<number>): void {
    table.fill(0);
    for (let slot = 0; slot < this.capacity; slot++) {
      if (!this.used[slot]) continue;
      const level = this.pageLevel[slot],
        ix = this.pageX[slot],
        iy = this.pageY[slot];
      if (!inWindow(ix, centers[level * 2]) || !inWindow(iy, centers[level * 2 + 1])) continue;
      table[tableSlot(level, ix, iy)] =
        (slot % this.poolPages) |
        (Math.floor(slot / this.poolPages) << 8) |
        ENTRY_VALID |
        (this.touched[slot] || this.touchedBefore[slot] ? 0 : ENTRY_CACHED);
    }
  }
}
/**
 * The light-space-to-clip matrix of one page (16 floats, column-major): the page's square plus its guard texels fill
 * the page's viewport, x along `right`, y along `up` (row 0 of the page at the smallest y), depth 0 to 1 over `range`
 * world units from `origin` along `forward`.
 */
export function pageMatrix(
  out: Float32Array,
  right: ArrayLike<number>,
  up: ArrayLike<number>,
  forward: ArrayLike<number>,
  origin: number,
  range: number,
  size: number,
  ix: number,
  iy: number,
): Float32Array {
  const guard = (size * PAGE_GUARD) / PAGE_INTERIOR,
    reach = size + 2 * guard,
    sx = 2 / reach,
    sy = -2 / reach;
  for (let k = 0; k < 3; k++) {
    out[k * 4] = right[k] * sx;
    out[k * 4 + 1] = up[k] * sy;
    out[k * 4 + 2] = forward[k] / range;
    out[k * 4 + 3] = 0;
  }
  out[12] = -(ix * size - guard) * sx - 1;
  out[13] = -(iy * size - guard) * sy + 1;
  out[14] = -origin / range;
  out[15] = 1;
  return out;
}
