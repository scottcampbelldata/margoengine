import { MargoError } from '@margoengine/math/errors';

/** Gesture kinds reported by {@link Gestures}. */
export type GestureType = 'tap' | 'doubletap' | 'swipe' | 'pinch' | 'rotate';

/** One recognised gesture. */
export interface GestureEvent {
  type: GestureType;
  /** Gesture centre in CSS pixels, relative to the viewport. */
  x: number;
  y: number;
  /** `swipe` only: dominant direction. */
  direction?: 'left' | 'right' | 'up' | 'down';
  /** `swipe` only: speed in pixels per second. */
  velocity?: number;
  /** `pinch` only: ratio of the current finger spread to the previous event (above 1 spreads, below 1 pinches). */
  scale?: number;
  /** `rotate` only: radians turned since the previous event, positive clockwise on screen. */
  rotation?: number;
}

/** Thresholds for {@link Gestures}. All optional. */
export interface GestureOptions {
  /** Minimum travel in pixels for a swipe. Default 40. */
  swipeDistance?: number;
  /** Minimum speed in pixels per second for a swipe. Default 300. */
  swipeVelocity?: number;
  /** Longest press in milliseconds still counted as a tap. Default 250. */
  tapTime?: number;
  /** Largest movement in pixels still counted as a tap. Default 10. */
  tapSlop?: number;
  /** Longest gap in milliseconds between two taps for a double tap. Default 300. */
  doubleTapTime?: number;
  /** Clock in milliseconds. Default `performance.now`. */
  now?: () => number;
}

interface Pointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
}

/**
 * Touch and pen gesture recogniser: tap, double tap, swipe, two-finger pinch and rotate. Mouse is ignored so it never
 * competes with orbit controls. Listeners attach to `element`; call `dispose` (or use `using`) to remove them.
 * Set `touch-action: none` on the element so the browser does not claim the gestures itself.
 *
 * ```ts
 * using gestures = new Gestures(canvas);
 * gestures.on('pinch', (e) => (zoom *= e.scale!));
 * ```
 */
export class Gestures {
  private readonly pointers = new Map<number, Pointer>();
  private readonly handlers = new Map<GestureType, Set<(event: GestureEvent) => void>>();
  private readonly cleanups: (() => void)[] = [];
  private readonly o: Required<GestureOptions>;
  private lastTap: { x: number; y: number; time: number } | null = null;
  private moved = false;
  private disposed = false;
  constructor(
    readonly element: EventTarget,
    options: GestureOptions = {},
  ) {
    this.o = {
      swipeDistance: 40,
      swipeVelocity: 300,
      tapTime: 250,
      tapSlop: 10,
      doubleTapTime: 300,
      now: () => performance.now(),
      ...options,
    };
    for (const [k, v] of Object.entries(this.o))
      if (k !== 'now' ? !(Number.isFinite(v) && (v as number) > 0) : typeof v !== 'function')
        throw new RangeError(`Invalid gesture option ${k}; thresholds must be positive numbers and now a function`);
    this.listen('pointerdown', (e) => this.down(e as PointerEvent));
    this.listen('pointermove', (e) => this.move(e as PointerEvent));
    this.listen('pointerup', (e) => this.up(e as PointerEvent));
    this.listen('pointercancel', (e) => {
      this.pointers.delete((e as PointerEvent).pointerId);
    });
  }
  private listen(type: string, listener: EventListener): void {
    this.element.addEventListener(type, listener);
    this.cleanups.push(() => this.element.removeEventListener(type, listener));
  }
  /**
   * Subscribe to one gesture kind. Returns a function that unsubscribes.
   * @throws MargoError `'disposed'` after {@link Gestures.dispose}.
   */
  on(type: GestureType, handler: (event: GestureEvent) => void): () => void {
    if (this.disposed) throw new MargoError('disposed', 'Gestures is disposed; create a new Gestures');
    const set = this.handlers.get(type) ?? this.handlers.set(type, new Set()).get(type)!;
    set.add(handler);
    return () => set.delete(handler);
  }
  private emit(event: GestureEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event);
  }
  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    const t = this.o.now();
    if (this.pointers.size === 0) this.moved = false;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, startTime: t });
  }
  private move(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > this.o.tapSlop) this.moved = true;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()],
        before = { dx: b.x - a.x, dy: b.y - a.y };
      p.x = e.clientX;
      p.y = e.clientY;
      const after = { dx: b.x - a.x, dy: b.y - a.y },
        d0 = Math.hypot(before.dx, before.dy),
        d1 = Math.hypot(after.dx, after.dy),
        cx = (a.x + b.x) / 2,
        cy = (a.y + b.y) / 2;
      if (d0 > 0 && d1 > 0 && d0 !== d1) this.emit({ type: 'pinch', x: cx, y: cy, scale: d1 / d0 });
      let turn = Math.atan2(after.dy, after.dx) - Math.atan2(before.dy, before.dx);
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      if (d0 > 0 && d1 > 0 && turn !== 0) this.emit({ type: 'rotate', x: cx, y: cy, rotation: turn });
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
  }
  private up(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const single = this.pointers.size === 1;
    this.pointers.delete(e.pointerId);
    if (!single) return;
    const now = this.o.now(),
      dt = Math.max(1, now - p.startTime),
      dx = e.clientX - p.startX,
      dy = e.clientY - p.startY,
      dist = Math.hypot(dx, dy);
    if (!this.moved && dt <= this.o.tapTime) {
      const last = this.lastTap;
      if (
        last &&
        now - last.time <= this.o.doubleTapTime &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) <= this.o.tapSlop * 3
      ) {
        this.lastTap = null;
        this.emit({ type: 'doubletap', x: e.clientX, y: e.clientY });
      } else {
        this.lastTap = { x: e.clientX, y: e.clientY, time: now };
        this.emit({ type: 'tap', x: e.clientX, y: e.clientY });
      }
      return;
    }
    const velocity = (dist / dt) * 1000;
    if (this.moved && dist >= this.o.swipeDistance && velocity >= this.o.swipeVelocity)
      this.emit({
        type: 'swipe',
        x: e.clientX,
        y: e.clientY,
        velocity,
        direction: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up',
      });
  }
  /** Remove all listeners and subscriptions. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.handlers.clear();
    this.pointers.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
