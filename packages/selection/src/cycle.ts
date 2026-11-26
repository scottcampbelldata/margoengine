import { rangeError } from '../../shared/errors.js';

/** Settings of {@link CycleRaycast}. */
export interface CycleRaycastOptions {
  /** CSS pixels the pointer may drift before a repeat counts as a new pick. Default 3. */
  tolerance?: number;
  /** Wrap from the last hit back to the first (and the reverse). Default true; false stops at the ends. */
  wrap?: boolean;
  /** What makes two hits the same between picks. Default the hit's `mesh` when it has one, else the hit itself. */
  identity?: (hit: any) => unknown;
  /** Key that steps through the hits (Shift steps back). Default 'Tab'. */
  key?: string;
  /** Modifier held with the wheel to step: 'alt', 'ctrl', 'shift', 'meta' or 'none'. Default 'alt'. */
  wheelModifier?: 'alt' | 'ctrl' | 'shift' | 'meta' | 'none';
}

/**
 * Step through the overlapping hits under one pointer position: the first pick answers the nearest hit, each repeat at
 * the same spot answers the next one back, so a hidden part can be picked without moving the pointer. Give it the
 * depth-sorted hit list of a ray (for example `Raycaster.intersectEngine`) and it tracks which one is current.
 */
export class CycleRaycast<T = unknown> {
  private x = Number.NaN;
  private y = Number.NaN;
  private list: readonly T[] = [];
  private at = -1;
  private readonly tolerance: number;
  private readonly wrap: boolean;
  private readonly key: string;
  private readonly same: (hit: any) => unknown;
  private readonly wheelModifier: NonNullable<CycleRaycastOptions['wheelModifier']>;
  constructor(options: CycleRaycastOptions = {}) {
    const { tolerance = 3, wrap = true, key = 'Tab', wheelModifier = 'alt', identity } = options;
    this.same = identity ?? ((hit) => (hit && typeof hit === 'object' && 'mesh' in hit ? hit.mesh : hit));
    if (!Number.isFinite(tolerance) || tolerance < 0)
      throw rangeError('CycleRaycast tolerance must be a finite number of CSS pixels, 0 or more; pass a valid tolerance', 'arguments');
    this.tolerance = tolerance;
    this.wrap = wrap;
    this.key = key;
    this.wheelModifier = wheelModifier;
  }
  /** Index of the current hit in the last list, or -1 before the first pick. */
  get index(): number {
    return this.at;
  }
  /** The current hit, or null when there is none. */
  get current(): T | null {
    return this.list[this.at] ?? null;
  }
  /**
   * A pick at (x, y) in CSS pixels with the depth-sorted `hits` there. A different spot, or a list with different
   * members than last time, restarts at the nearest hit; the same spot and list steps by `step` (default 1).
   * @returns The current hit, or null for an empty list.
   */
  pick(x: number, y: number, hits: readonly T[], step = 1): T | null {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw rangeError('CycleRaycast.pick needs a finite pointer x and y in CSS pixels; pass valid coordinates', 'arguments');
    const same =
      Math.hypot(x - this.x, y - this.y) <= this.tolerance &&
      hits.length === this.list.length &&
      hits.every((hit, i) => this.same(hit) === this.same(this.list[i]));
    this.x = x;
    this.y = y;
    this.list = hits.slice();
    if (!hits.length) return (this.at = -1), null;
    if (!same) this.at = 0;
    else this.step(step);
    return this.list[this.at];
  }
  /** Moves by `delta` hits without a new pick (+1 farther, -1 nearer); wraps or clamps per `wrap`. */
  step(delta: number): T | null {
    const n = this.list.length;
    if (!n) return null;
    const next = this.at + Math.sign(delta) * Math.min(Math.abs(Math.trunc(delta)), n);
    this.at = this.wrap ? ((next % n) + n) % n : Math.min(n - 1, Math.max(0, next));
    return this.list[this.at];
  }
  /** Forgets the last pick so the next one starts at the nearest hit. */
  reset(): void {
    this.x = this.y = Number.NaN;
    this.list = [];
    this.at = -1;
  }
  /**
   * Steps for a keyboard or wheel event: the configured key (Shift reverses) or a wheel turn with the configured
   * modifier. Returns the hit now current, or undefined when the event does not cycle (nothing is changed then).
   * The caller should `preventDefault()` when the result is not undefined.
   */
  handle(event: Pick<KeyboardEvent & WheelEvent, 'type' | 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'deltaY'>): T | null | undefined {
    if (event.type === 'keydown' && event.key === this.key) return this.step(event.shiftKey ? -1 : 1);
    if (event.type === 'wheel' && event.deltaY) {
      const m = this.wheelModifier;
      const held = m === 'none' || (m === 'alt' ? event.altKey : m === 'ctrl' ? event.ctrlKey : m === 'meta' ? event.metaKey : event.shiftKey);
      if (held) return this.step(Math.sign(event.deltaY));
    }
    return undefined;
  }
}
