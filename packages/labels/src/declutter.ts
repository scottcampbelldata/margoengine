import type { Label, LabelLayout, LayoutContext } from './renderer.js';
import { rangeError } from '../../shared/errors.js';

/** An anchor a label can be placed with: which point of the element sits on its projected point, as fractions. */
export type Anchor = readonly [number, number];

/**
 * The eight positions around a point, most preferred first: above right, above left, below right, below left, right,
 * left, above, below (each an anchor of the element, so `[0, 1]` puts the element's lower left corner on the point).
 */
export const eightPositions: readonly Anchor[] = [
  [0, 1],
  [1, 1],
  [0, 0],
  [1, 0],
  [0, 0.5],
  [1, 0.5],
  [0.5, 1],
  [0.5, 0],
];
/** The four corner positions of {@link eightPositions}. */
export const fourPositions: readonly Anchor[] = eightPositions.slice(0, 4);

/** Options of Declutter: the gap kept between labels, the positions tried, and how ties are kept steady. */
export interface DeclutterOptions {
  /** Gap kept free between two labels, in CSS pixels. Default 2. */
  padding?: number;
  /**
   * Anchors tried, in order, after a label's own anchor overlaps another label. Default none: an overlapping label is
   * hidden. `eightPositions` or `fourPositions` move labels around their point first.
   */
  positions?: readonly Anchor[];
  /** Keep labels whole inside the view rectangle: a position that sticks out counts as an overlap. Default false. */
  inside?: boolean;
  /**
   * Among labels of equal priority, the ones shown at the last update are kept first, so labels do not swap places
   * as the camera moves. Default true.
   */
  sticky?: boolean;
  /** Side of the grid cells the overlap test buckets labels into, in CSS pixels. Default 64. */
  cell?: number;
}

const checkAnchor = (anchor: Anchor): Anchor => {
  if (!anchor || anchor.length !== 2 || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1]))
    throw rangeError('positions must be [x, y] anchors of two finite numbers', 'labels');
  return [anchor[0], anchor[1]];
};

/**
 * A label layout that removes overlaps: labels are taken by priority (higher first), then, among equal priorities,
 * those shown at the last update, then nearer ones. Each is placed with its own anchor or the first of `positions`
 * that overlaps no label placed before it, and hidden when none is free. Pass it as the renderer's `layout`.
 */
export class Declutter implements LabelLayout {
  readonly padding: number;
  readonly positions: readonly Anchor[];
  readonly inside: boolean;
  readonly sticky: boolean;
  readonly cell: number;
  /** Labels hidden at the last update because every position overlapped. */
  hidden = 0;
  /** Labels placed at one of `positions` instead of their own anchor at the last update. */
  moved = 0;
  /** The update each label was last shown at. */
  private readonly shownAt = new WeakMap<Label, number>();
  private frame = 0;
  private readonly order: number[] = [];
  private readonly keys: number[] = [];
  /** Accepted rectangles: left, top, right, bottom per label. */
  private rects = new Float64Array(64);
  private count = 0;
  private readonly grid = new Map<number, number[]>();

  constructor(options: DeclutterOptions = {}) {
    const padding = options.padding ?? 2,
      cell = options.cell ?? 64;
    if (!Number.isFinite(padding) || padding < 0)
      throw rangeError('padding must be a finite number of CSS pixels, 0 or more', 'labels');
    if (!Number.isFinite(cell) || cell < 1)
      throw rangeError('cell must be a finite number of CSS pixels, 1 or more', 'labels');
    if (options.positions !== undefined && !Array.isArray(options.positions))
      throw rangeError('positions must be [x, y] anchors of two finite numbers', 'labels');
    this.padding = padding;
    this.cell = cell;
    this.positions = (options.positions ?? []).map(checkAnchor);
    this.inside = options.inside ?? false;
    this.sticky = options.sticky ?? true;
  }

  arrange(labels: readonly Label[], context: LayoutContext): void {
    const order = this.order,
      keys = this.keys,
      shownAt = this.shownAt,
      last = this.frame++,
      n = labels.length;
    order.length = n;
    keys.length = n;
    for (let i = 0; i < n; i++) {
      order[i] = i;
      keys[i] = this.sticky && shownAt.get(labels[i]) === last ? 1 : 0;
    }
    // Priority first, then shown last time, then nearer, then the order added (a stable, deterministic order).
    order.sort((a, b) => {
      const la = labels[a],
        lb = labels[b];
      return lb.priority - la.priority || keys[b] - keys[a] || la.distance - lb.distance || a - b;
    });
    // Empty the buckets but keep them; a grid grown past 4,096 cells (labels far outside the view) starts again.
    if (this.grid.size > 4096) this.grid.clear();
    else for (const bucket of this.grid.values()) bucket.length = 0;
    this.count = 0;
    this.hidden = 0;
    this.moved = 0;
    const now = this.frame,
      { width, height } = context;
    for (let k = 0; k < n; k++) {
      const label = labels[order[k]],
        [w0, h0] = context.size(label),
        w = w0 * label.scale,
        h = h0 * label.scale,
        x = label.screen.x,
        y = label.screen.y;
      let placed = false;
      for (let p = -1; p < this.positions.length && !placed; p++) {
        const [ax, ay] = p < 0 ? label.anchor : this.positions[p];
        const left = x - ax * w,
          top = y - ay * h,
          right = left + w,
          bottom = top + h;
        if (this.inside && (left < 0 || top < 0 || right > width || bottom > height)) continue;
        if (this.overlaps(left, top, right, bottom)) continue;
        this.accept(left, top, right, bottom);
        if (p >= 0) {
          context.place(label, this.positions[p]);
          this.moved++;
        }
        placed = true;
      }
      if (placed) shownAt.set(label, now);
      else {
        context.hide(label);
        this.hidden++;
      }
    }
  }

  /** Forgets which labels were shown, so the next update ranks by priority and distance alone. */
  reset(): void {
    this.frame++;
  }

  private overlaps(left: number, top: number, right: number, bottom: number): boolean {
    const pad = this.padding,
      rects = this.rects;
    const c0 = Math.floor((left - pad) / this.cell),
      c1 = Math.floor((right + pad) / this.cell),
      r0 = Math.floor((top - pad) / this.cell),
      r1 = Math.floor((bottom + pad) / this.cell);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const bucket = this.grid.get(key(c, r));
        if (!bucket) continue;
        for (const i of bucket) {
          const o = i * 4;
          // Touching at exactly the padding is free; any closer is an overlap.
          if (
            left < rects[o + 2] + pad &&
            rects[o] < right + pad &&
            top < rects[o + 3] + pad &&
            rects[o + 1] < bottom + pad
          )
            return true;
        }
      }
    return false;
  }

  private accept(left: number, top: number, right: number, bottom: number): void {
    const i = this.count++;
    if (this.rects.length < this.count * 4) {
      const grown = new Float64Array(this.rects.length * 2);
      grown.set(this.rects);
      this.rects = grown;
    }
    const o = i * 4;
    this.rects[o] = left;
    this.rects[o + 1] = top;
    this.rects[o + 2] = right;
    this.rects[o + 3] = bottom;
    const c0 = Math.floor(left / this.cell),
      c1 = Math.floor(right / this.cell),
      r0 = Math.floor(top / this.cell),
      r1 = Math.floor(bottom / this.cell);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const id = key(c, r);
        let bucket = this.grid.get(id);
        if (!bucket) this.grid.set(id, (bucket = []));
        bucket.push(i);
      }
  }
}

// Cells within 32,768 cells of the view corner get distinct keys; farther ones may share a bucket, which costs only
// extra exact rectangle tests.
const key = (c: number, r: number): number => (c + 32768) * 65536 + (r + 32768);
