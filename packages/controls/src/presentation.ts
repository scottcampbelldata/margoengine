import type { Camera, EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Spring, type SpringOptions } from '@margoengine/tween';
import { Raycaster } from '@margoengine/bvh';
import { add, normalize, scale, sub } from '@margoengine/math/vec3';
import {
  axisAngleToQuaternion,
  multiplyQuaternions,
  rotateByQuaternion,
  conjugateQuaternion,
} from '@margoengine/math/quat';
import { Controls, type ControlElement, type EventTargetLike, type InputEventListener } from './controls.js';
import { IDENTITY, invertAffine, transformPoint, quatFromMatrix, type Q4, type V3 } from './math.js';
import { rollFrame, ray } from './view.js';

const clamp = (v: number, min = 0, max = 1): number => Math.max(min, Math.min(max, v));
const time = (delta: number): void => {
  if (!Number.isFinite(delta) || delta < 0)
    throw new RangeError('Control delta must be finite and nonnegative; pass seconds');
};
const vector = (p: ArrayLike<number>): V3 => {
  if (p.length !== 3 || ![p[0], p[1], p[2]].every(Number.isFinite))
    throw new RangeError('Path points must have three finite components; return [x,y,z]');
  return [p[0], p[1], p[2]];
};
const blend = (now: number, target: number, delta: number, damping: number, maxSpeed: number): number => {
  const diff = target - now,
    step = damping === 0 ? diff : diff * -Math.expm1(-delta / damping);
  return now + Math.sign(step) * Math.min(Math.abs(step), Number.isFinite(maxSpeed) ? maxSpeed * delta : Infinity);
};
/** Pointer-driven product rotation options. */
export interface PresentationOptions {
  /** Event element. Default engine canvas. */
  element?: ControlElement | null;
  /** Local X rotation limits in radians relative to the starting pose. Default [-PI/2, PI/2]. */
  polar?: readonly [number, number];
  /** Local Y rotation limits in radians relative to the starting pose. Default [-Infinity,Infinity]. */
  azimuth?: readonly [number, number];
  /** Drag rotation multiplier. Default 1. */
  speed?: number;
  /** Return to the starting pose when released. Default false. */
  snap?: boolean;
  /** Scale multiplier at the polar limit. Default 1. */
  zoom?: number;
  /** Exact spring settings. Defaults stiffness 170, damping 26, precision 0.000001. */
  spring?: SpringOptions;
  /** Drag anywhere on the element instead of only on the product. Default false. */
  global?: boolean;
}
/** Rotate a product with bounded spring motion, polar zoom and optional snap-back. */
export class PresentationControls extends Controls {
  /** The product being presented. */
  readonly object: Mesh;
  /** Return to the initial rotation on release. Default false. */
  snap: boolean;
  /** Drag speed multiplier. Default 1. */
  speed: number;
  /** Scale multiplier at the polar limit. Default 1. */
  zoom: number;
  /** Drag anywhere on the element. Default false (product hits only). */
  global: boolean;
  /** Local X limits in radians. */
  readonly polar: readonly [number, number];
  /** Local Y limits in radians. */
  readonly azimuth: readonly [number, number];
  private readonly pitch: Spring;
  private readonly yaw: Spring;
  private readonly initial: Q4;
  private readonly size: V3;
  private drag: { id: number; x: number; y: number; pitch: number; yaw: number } | null = null;
  private action: string | null = null;
  private dead = false;
  private readonly picker = new Raycaster();
  constructor(engine: EngineKernel, object: Mesh, options: PresentationOptions = {}) {
    const polar = options.polar ?? [-Math.PI / 2, Math.PI / 2],
      azimuth = options.azimuth ?? [-Infinity, Infinity];
    if (
      polar.length !== 2 ||
      !polar.every(Number.isFinite) ||
      polar[0] > 0 ||
      polar[1] < 0 ||
      azimuth.length !== 2 ||
      azimuth.some(Number.isNaN) ||
      azimuth[0] > 0 ||
      azimuth[1] < 0 ||
      !Number.isFinite(options.speed ?? 1) ||
      (options.speed ?? 1) < 0 ||
      !Number.isFinite(options.zoom ?? 1) ||
      (options.zoom ?? 1) <= 0
    )
      throw new RangeError(
        'Presentation limits must contain zero and speed/zoom must be finite with speed >= 0 and zoom > 0; pass valid options',
      );
    const settings =
      options.spring?.duration === undefined
        ? { stiffness: 170, damping: 26, precision: 1e-6, ...options.spring }
        : { precision: 1e-6, ...options.spring };
    const pitch = new Spring({ ...settings, value: 0, target: 0 }),
      yaw = new Spring({ ...settings, value: 0, target: 0 });
    if (engineRuntime(engine).meshes.get(meshRuntime(object).id) !== object)
      throw new TypeError('Presentation needs a live product mesh from its engine; pass one');
    super(engine, options.element);
    this.object = object;
    this.polar = [...polar];
    this.azimuth = [...azimuth];
    this.speed = options.speed ?? 1;
    this.zoom = options.zoom ?? 1;
    this.snap = options.snap ?? false;
    this.global = options.global ?? false;
    this.picker.side = 'double';
    this.pitch = pitch;
    this.yaw = yaw;
    const t = engineRuntime(engine).store.transforms,
      id = meshRuntime(object).id;
    this.initial = [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
    this.size = [t.sx[id], t.sy[id], t.sz[id]];
    this.init();
  }
  /** Current local pitch/yaw in radians, relative to the original product pose. */
  get angles(): readonly [number, number] {
    return [this.pitch.value, this.yaw.value];
  }
  /** Return to the initial product pose, smoothly by default. */
  reset(immediate = false): void {
    this.pitch.target = this.yaw.target = 0;
    if (immediate) {
      this.pitch.value = this.yaw.value = this.pitch.velocity = this.yaw.velocity = 0;
      this.update(0);
    }
  }
  protected override bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    if (element.style) {
      this.action = element.style.touchAction;
      element.style.touchAction = 'none';
    }
    return [
      [element, 'pointerdown', this.down],
      [element, 'pointermove', this.move],
      [element, 'pointerup', this.up],
      [element, 'pointercancel', this.cancel],
    ];
  }
  private down = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0 || this.drag || this.dead || !this.element) return;
    if (!this.global) {
      const p = this.local(e),
        r = ray(rollFrame(this.camera), p.x, p.y, this.element.clientWidth, this.element.clientHeight);
      this.picker.set(r.origin, r.direction);
      const runtime = engineRuntime(this.engine!), root = meshRuntime(this.object).id;
      const products = [...runtime.meshes.values()].filter((mesh) => {
        for (let id = mesh.id; id !== -1; id = runtime.store.parents[id]) if (id === root) return true;
        return false;
      });
      if (!this.picker.intersectObjects(this.engine!, products).length) return;
    }
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pitch: this.pitch.target, yaw: this.yaw.target };
    this.capture(e.pointerId);
    e.preventDefault();
    this.dispatchEvent({ type: 'start' });
  };
  private move = (e: PointerEvent): void => {
    if (!this.enabled || !this.drag || e.pointerId !== this.drag.id) return;
    const factor = (Math.PI * this.speed) / Math.max(1, this.element?.clientHeight ?? 1);
    this.pitch.target = clamp(this.drag.pitch + (e.clientY - this.drag.y) * factor, ...this.polar);
    this.yaw.target = clamp(this.drag.yaw + (e.clientX - this.drag.x) * factor, ...this.azimuth);
  };
  private finish(): void {
    if (!this.drag) return;
    this.release(this.drag.id);
    this.drag = null;
    if (this.snap) this.reset();
    this.dispatchEvent({ type: 'end' });
  }
  private up = (e: PointerEvent): void => {
    if (e.pointerId === this.drag?.id) this.finish();
  };
  private cancel = (e: PointerEvent): void => {
    if (e.pointerId === this.drag?.id) {
      this.finish();
      this.reset();
    }
  };
  protected override onDisconnect(): void {
    this.finish();
    if (this.element?.style && this.action !== null) this.element.style.touchAction = this.action;
    this.action = null;
  }
  override update(delta = 1 / 60): boolean {
    time(delta);
    if (this.dead || !this.enabled) return false;
    if (engineRuntime(this.engine!).meshes.get(meshRuntime(this.object).id) !== this.object) {
      this.dispose();
      return false;
    }
    const before = [this.pitch.value, this.yaw.value];
    const p = clamp(this.pitch.update(delta), ...this.polar),
      y = clamp(this.yaw.update(delta), ...this.azimuth);
    if (p !== this.pitch.value) {
      this.pitch.value = p;
      this.pitch.velocity = 0;
    }
    if (y !== this.yaw.value) {
      this.yaw.value = y;
      this.yaw.velocity = 0;
    }
    const q = multiplyQuaternions(
      this.initial,
      multiplyQuaternions(axisAngleToQuaternion([0, 1, 0], y), axisAngleToQuaternion([1, 0, 0], p)),
    );
    const extent = Math.max(Math.abs(this.polar[0]), Math.abs(this.polar[1]), 1e-6),
      z = 1 + (this.zoom - 1) * clamp(Math.abs(p) / extent);
    this.object.setQuaternion(q).setScale(scale(this.size, z));
    const changed = p !== before[0] || y !== before[1];
    if (changed) this.dispatchEvent({ type: 'change' });
    return changed;
  }
  override dispose(): void {
    if (this.dead) return;
    this.dead = true;
    super.dispose();
  }
}

/** Scroll-capable element; a plain canvas can use wheel-based progress instead. */
export interface ScrollElement extends ControlElement {
  /** Native vertical offset, in CSS pixels. */
  scrollTop?: number;
  /** Native horizontal offset, in CSS pixels. */
  scrollLeft?: number;
  /** Native content height. */
  readonly scrollHeight?: number;
  /** Native content width. */
  readonly scrollWidth?: number;
}
/** DOM scroll-area settings. */
export interface ScrollAreaOptions {
  /** Number of viewport pages. Default 1. */
  pages?: number;
  /** Scroll travel multiplier. Default 1. */
  distance?: number;
  /** Horizontal instead of vertical. Default false. */
  horizontal?: boolean;
  /** Insert before the canvas instead of after it. Default false. */
  prepend?: boolean;
}
/** Native keyboard/touch/wheel scroll container over a canvas, with an HTML content slot and explicit ownership. */
export class ScrollArea {
  /** Scroll viewport; pass as ScrollControls' element. */
  readonly element: HTMLDivElement;
  /** HTML content area, sized in viewport pages. */
  readonly content: HTMLDivElement;
  private readonly parent: HTMLElement;
  private readonly previous: string;
  private readonly positioned: boolean;
  private disposed = false;
  constructor(canvas: HTMLCanvasElement, options: ScrollAreaOptions = {}) {
    const pages = options.pages ?? 1,
      distance = options.distance ?? 1;
    if (!Number.isFinite(pages) || pages < 1 || !Number.isFinite(distance) || distance <= 0)
      throw new RangeError('ScrollArea needs finite pages >= 1 and distance > 0; pass valid options');
    const parent = canvas.parentElement;
    if (!parent) throw new TypeError('ScrollArea needs a mounted canvas; append it to a parent first');
    this.parent = parent;
    this.previous = parent.style.position;
    this.positioned = (canvas.ownerDocument.defaultView?.getComputedStyle(parent).position || 'static') === 'static';
    if (this.positioned) parent.style.position = 'relative';
    const element = (this.element = canvas.ownerDocument.createElement('div')),
      content = (this.content = canvas.ownerDocument.createElement('div'));
    element.tabIndex = 0;
    element.setAttribute('role', 'region');
    element.setAttribute('aria-label', 'Product presentation');
    Object.assign(element.style, {
      position: 'absolute',
      inset: '0',
      overflowX: options.horizontal ? 'auto' : 'hidden',
      overflowY: options.horizontal ? 'hidden' : 'auto',
      overscrollBehavior: 'contain',
      touchAction: options.horizontal ? 'pan-x' : 'pan-y',
    });
    Object.assign(content.style, {
      position: 'relative',
      width: options.horizontal ? `${pages * distance * 100}%` : '100%',
      height: options.horizontal ? '100%' : `${pages * distance * 100}%`,
    });
    element.append(content);
    if (options.prepend) parent.insertBefore(element, canvas);
    else parent.append(element);
  }
  /** Remove owned DOM and restore the parent positioning when still owned. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.remove();
    if (this.positioned && this.parent.style.position === 'relative') this.parent.style.position = this.previous;
  }
  /** Dispose owned DOM with a using declaration. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Scroll progress settings. */
export interface ScrollControlOptions {
  /** Native scroller or wheel surface. Default engine canvas. */
  element?: ScrollElement | null;
  /** Page count for a wheel surface. Default 1. */
  pages?: number;
  /** Scroll travel multiplier. Default 1. */
  distance?: number;
  /** Horizontal instead of vertical scrolling. Default false. */
  horizontal?: boolean;
  /** Wrap scroll progress. Default false. */
  infinite?: boolean;
  /** Smoothing time constant, seconds. Default 0.2; zero immediate. */
  damping?: number;
  /** Maximum progress units per second. Default Infinity. */
  maxSpeed?: number;
  /** Settle precision. Default 0.00001. */
  eps?: number;
}
/** Damped native-scroll or wheel progress, with range, bell-curve and visibility helpers. */
export class ScrollControls extends Controls {
  /** Damped normalized offset. */
  get offset(): number {
    return this.infinite ? ((this.current % 1) + 1) % 1 : this.current;
  }
  /** Signed change in normalized progress during the last update. */
  delta = 0;
  /** Native horizontal scrolling. Default false. */
  horizontal: boolean;
  /** Wrap progress, retaining continuous movement across the seam. Default false. */
  infinite: boolean;
  /** Time constant in seconds. Default 0.2. */
  damping: number;
  /** Progress speed cap per second. Default Infinity. */
  maxSpeed: number;
  /** Settle precision. Default 0.00001. */
  eps: number;
  private current = 0;
  private goal = 0;
  private readonly pages: number;
  private readonly distance: number;
  private dead = false;
  private nativeLast: number | null = null;
  constructor(source: Camera | EngineKernel, options: ScrollControlOptions = {}) {
    const pages = options.pages ?? 1,
      distance = options.distance ?? 1,
      damping = options.damping ?? 0.2,
      maxSpeed = options.maxSpeed ?? Infinity,
      eps = options.eps ?? 1e-5;
    if (
      !Number.isFinite(pages) ||
      pages < 1 ||
      !Number.isFinite(distance) ||
      distance <= 0 ||
      !Number.isFinite(damping) ||
      damping < 0 ||
      !(maxSpeed > 0) ||
      !Number.isFinite(eps) ||
      eps < 0
    )
      throw new RangeError(
        'Scroll needs pages >= 1, positive distance/maxSpeed and nonnegative damping/eps; pass finite options except maxSpeed=Infinity',
      );
    super(source, options.element);
    this.pages = pages;
    this.distance = distance;
    this.damping = damping;
    this.maxSpeed = maxSpeed;
    this.eps = eps;
    this.horizontal = options.horizontal ?? false;
    this.infinite = options.infinite ?? false;
    this.init();
  }
  /** Set normalized target progress; values outside [0,1] wrap only in infinite mode. */
  setProgress(progress: number, immediate = false): void {
    if (this.dead) throw new MargoError('disposed', 'Scroll controls are disposed; create new controls');
    if (!Number.isFinite(progress)) throw new RangeError('Scroll progress must be finite; pass normalized progress');
    this.goal = this.infinite ? progress : clamp(progress);
    if (immediate) {
      this.current = this.goal;
      this.delta = 0;
      this.dispatchEvent({ type: 'change', offset: this.offset, delta: 0 });
    }
  }
  /** Linear 0..1 progress over a normalized interval, including optional margin on both sides. */
  range(from: number, length: number, margin = 0): number {
    this.interval(from, length, margin);
    return clamp((this.offset - from + margin) / (length + 2 * margin));
  }
  /** Smooth 0..1..0 bell over the interval. */
  curve(from: number, length: number, margin = 0): number {
    return Math.sin(Math.PI * this.range(from, length, margin));
  }
  /** Whether offset lies in the interval plus margins. */
  visible(from: number, length: number, margin = 0): boolean {
    this.interval(from, length, margin);
    return this.offset >= from - margin && this.offset <= from + length + margin;
  }
  private interval(from: number, length: number, margin: number): void {
    if (![from, length, margin].every(Number.isFinite) || length <= 0 || margin < 0)
      throw new RangeError(
        'Scroll interval needs finite start, positive length and nonnegative margin; pass normalized units',
      );
  }
  protected override bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    const el = element as ScrollElement,
      travel = this.horizontal ? (el.scrollWidth ?? 0) - el.clientWidth : (el.scrollHeight ?? 0) - el.clientHeight;
    this.nativeLast = null;
    if (travel > 0) {
      if (this.infinite) {
        this.nativeLast = 0.5;
        if (this.horizontal) el.scrollLeft = travel / 2;
        else el.scrollTop = travel / 2;
      } else this.goal = clamp((this.horizontal ? (el.scrollLeft ?? 0) : (el.scrollTop ?? 0)) / travel);
    }
    return [
      [element, 'scroll', this.scroll],
      [element, 'wheel', this.wheel, { passive: false }],
    ];
  }
  private scroll = (): void => {
    if (!this.enabled || this.dead) return;
    const e = this.element as ScrollElement | null;
    if (!e) return;
    const travel = this.horizontal ? (e.scrollWidth ?? 0) - e.clientWidth : (e.scrollHeight ?? 0) - e.clientHeight;
    if (travel > 0) {
      const p = (this.horizontal ? (e.scrollLeft ?? 0) : (e.scrollTop ?? 0)) / travel;
      if (this.infinite) {
        this.goal += p - (this.nativeLast ?? p);
        this.nativeLast = p;
        if (p <= 0 || p >= 1) {
          this.nativeLast = 0.5;
          if (this.horizontal) e.scrollLeft = travel / 2;
          else e.scrollTop = travel / 2;
        }
      } else this.goal = clamp(p);
    }
  };
  private wheel = (e: WheelEvent): void => {
    if (!this.enabled || this.dead || !this.element) return;
    const el = this.element as ScrollElement,
      extent = this.horizontal ? (el.scrollWidth ?? 0) - el.clientWidth : (el.scrollHeight ?? 0) - el.clientHeight;
    if (extent > 0) return; // Native scrolling remains accessible to touch, keyboard and browser defaults.
    const pixels =
      (this.horizontal ? e.deltaX || e.deltaY : e.deltaY) *
      (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.element.clientHeight : 1);
    const goal =
      this.goal +
      pixels /
        (Math.max(1, this.pages - 1) * this.distance * Math.max(1, this.horizontal ? el.clientWidth : el.clientHeight));
    this.setProgress(goal);
    e.preventDefault();
  };
  override update(delta = 1 / 60): boolean {
    time(delta);
    if (this.dead || !this.enabled) return false;
    if (
      !Number.isFinite(this.damping) ||
      this.damping < 0 ||
      !(this.maxSpeed > 0) ||
      !Number.isFinite(this.eps) ||
      this.eps < 0
    )
      throw new RangeError(
        'Scroll damping/eps must be finite and nonnegative and maxSpeed positive; restore valid settings',
      );
    const before = this.current;
    this.current = blend(before, this.goal, delta, this.damping, this.maxSpeed);
    if (Math.abs(this.goal - this.current) <= this.eps) this.current = this.goal;
    this.delta = this.current - before;
    if (this.delta) this.dispatchEvent({ type: 'change', offset: this.offset, delta: this.delta });
    return this.delta !== 0;
  }
  override dispose(): void {
    if (this.dead) return;
    this.dead = true;
    super.dispose();
  }
}

/** Path interface supported directly by @margoengine/splines Spline. */
export interface ControlPath {
  /** Evaluate normalized parameter. Copy the returned point before calling again. */
  at(t: number): ArrayLike<number>;
  /** Optional world length for arc-length parameterization. */
  readonly length?: number;
  /** Optional arc-length sampling. Used with length when present. */
  atDistance?(distance: number): ArrayLike<number>;
}
/** Camera or mesh path settings. */
export interface PathControlOptions {
  /** Mesh to animate; omitted drives the camera. Default null. */
  object?: Mesh | null;
  /** Optional shared scroll progress. Default null. */
  scroll?: Pick<ScrollControls, 'offset'> | null;
  /** Look at a world point or a live mesh. Default null (look along path). */
  focus?: readonly [number, number, number] | Mesh | null;
  /** Loop at the ends. Default true. */
  loop?: boolean;
  /** Initial normalized path progress. Default 0. */
  offset?: number;
  /** Progress smoothing time, seconds. Default 0.1; zero immediate. */
  damping?: number;
  /** Progress speed cap per second. Default Infinity. */
  maxSpeed?: number;
  /** Normalized look-ahead distance. Default 0.001. */
  lookAhead?: number;
  /** World focus-point smoothing time, seconds. Default 0.1; zero immediate. */
  focusDamping?: number;
}
/** Scroll-driven or imperative camera/mesh motion along a curve, sampled at uniform arc length where supported. */
export class PathControls extends Controls {
  /** Desired unbounded progress; wrapping is controlled by loop. */
  current: number;
  /** Current normalized progress after smoothing. */
  offset: number;
  /** Wrap at the ends. Default true. */
  loop: boolean;
  /** Smoothing time in seconds. Default 0.1. */
  damping: number;
  /** Progress speed limit. Default Infinity. */
  maxSpeed: number;
  /** Focus-point time constant in seconds. Default 0.1. */
  focusDamping: number;
  /** Shared scroll driver, null for imperative current. */
  scroll: Pick<ScrollControls, 'offset'> | null;
  /** Look-at point or mesh, null for path tangent. */
  focus: readonly [number, number, number] | Mesh | null;
  /** Mesh target, null for the camera. */
  readonly object: Mesh | null;
  /** Curve adapter. */
  readonly path: ControlPath;
  private readonly lookAhead: number;
  private progress: number;
  private dead = false;
  private lookTarget: V3 | null = null;
  constructor(source: Camera | EngineKernel, path: ControlPath, options: PathControlOptions = {}) {
    const offset = options.offset ?? 0,
      damping = options.damping ?? 0.1,
      maxSpeed = options.maxSpeed ?? Infinity,
      ahead = options.lookAhead ?? 0.001,
      focusDamping = options.focusDamping ?? 0.1;
    if (
      !path ||
      typeof path.at !== 'function' ||
      !Number.isFinite(offset) ||
      !Number.isFinite(damping) ||
      damping < 0 ||
      !(maxSpeed > 0) ||
      !Number.isFinite(ahead) ||
      ahead <= 0 ||
      ahead >= 1 ||
      !Number.isFinite(focusDamping) ||
      focusDamping < 0
    )
      throw new RangeError(
        'Path controls need a curve, finite offset, damping >= 0, maxSpeed > 0 and lookAhead in (0,1); pass valid options',
      );
    super(source, null);
    this.path = path;
    this.object = options.object ?? null;
    this.scroll = options.scroll ?? null;
    this.focus = options.focus ?? null;
    this.loop = options.loop ?? true;
    this.damping = damping;
    this.maxSpeed = maxSpeed;
    this.focusDamping = focusDamping;
    this.lookAhead = ahead;
    this.current = this.progress = offset;
    this.offset = this.normalize(offset);
    if (this.object && !this.engine) {
      this.dispose();
      throw new TypeError('Mesh path controls need an engine; pass the owning engine');
    }
    if (this.object && engineRuntime(this.engine!).meshes.get(meshRuntime(this.object).id) !== this.object) {
      this.dispose();
      throw new TypeError('Path mesh must belong to its engine; pass a live mesh from that engine');
    }
  }
  private normalize(p: number): number {
    return this.loop ? ((p % 1) + 1) % 1 : clamp(p);
  }
  private point(t: number): V3 {
    return vector(
      this.path.atDistance && this.path.length !== undefined
        ? this.path.atDistance(t * this.path.length)
        : this.path.at(t),
    );
  }
  protected override bind(
    _element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    return [];
  }
  override update(delta = 1 / 60): boolean {
    time(delta);
    if (this.dead || !this.enabled) return false;
    const goal = this.scroll?.offset ?? this.current;
    if (
      !Number.isFinite(goal) ||
      !Number.isFinite(this.damping) ||
      this.damping < 0 ||
      !(this.maxSpeed > 0) ||
      !Number.isFinite(this.focusDamping) ||
      this.focusDamping < 0
    )
      throw new RangeError(
        'Path progress must be finite, damping/focusDamping nonnegative and maxSpeed positive; restore valid settings',
      );
    let desired = this.normalize(goal);
    if (this.loop) desired = this.progress + (((desired - this.normalize(this.progress) + 1.5) % 1) - 0.5);
    this.progress = blend(this.progress, desired, delta, this.damping, this.maxSpeed);
    this.offset = this.normalize(this.progress);
    const point = this.point(this.offset),
      ahead = this.loop ? this.normalize(this.offset + this.lookAhead) : clamp(this.offset + this.lookAhead);
    let target: V3;
    if (this.focus) {
      if (Array.isArray(this.focus)) target = vector(this.focus);
      else {
        const focus = this.focus as Mesh,
          r = meshRuntime(focus);
        if (r.engine.disposed || r.engine.meshes.get(r.id) !== focus)
          throw new MargoError('disposed', 'Path focus is disposed; select a live focus mesh');
        target = transformPoint(r.engine.store.matrices.subarray(r.id * 16, r.id * 16 + 16), [0, 0, 0]);
      }
    } else if (ahead !== this.offset) target = this.point(ahead);
    else target = add(point, sub(point, this.point(Math.max(0, this.offset - this.lookAhead))));
    if (this.focus && this.lookTarget && this.focusDamping > 0)
      target = target.map((v, i) => blend(this.lookTarget![i], v, delta, this.focusDamping, Infinity)) as V3;
    this.lookTarget = [...target];
    let forward = sub(target, point);
    if (Math.hypot(...forward) < 1e-9) forward = [0, 0, -1];
    if (this.object) {
      const runtime = engineRuntime(this.engine!),
        id = meshRuntime(this.object).id;
      if (runtime.meshes.get(id) !== this.object) {
        this.dispose();
        return false;
      }
      const parent = runtime.store.parents[id],
        m = parent < 0 ? IDENTITY : runtime.store.matrices.subarray(parent * 16, parent * 16 + 16);
      this.object.setPosition(transformPoint(invertAffine(m), point));
      const up: V3 = Math.abs(normalize(forward)[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0],
        z = normalize(scale(forward, -1));
      const x = normalize([up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]),
        y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
      this.object.setQuaternion(
        multiplyQuaternions(
          conjugateQuaternion(quatFromMatrix(m)),
          quatFromMatrix([...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1]),
        ),
      );
    } else {
      this.camera.position = point;
      this.camera.target = add(point, forward);
      if (Math.abs(normalize(forward)[1]) > 0.999) this.camera.up = [0, 0, 1];
      else this.camera.up = [0, 1, 0];
    }
    this.dispatchEvent({ type: 'change', offset: this.offset });
    return true;
  }
  override dispose(): void {
    if (this.dead) return;
    this.dead = true;
    super.dispose();
  }
}
/** Familiar motion-path name for PathControls. */
export { PathControls as MotionPathControls };
