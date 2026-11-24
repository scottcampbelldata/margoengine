/// <reference lib="esnext.disposable" preserve="true" />
import type { Mesh } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import type { PickHit } from '@margoengine/selection';
import { fault, rangeError } from '../../shared/errors.js';
import type { XRController } from './controller.js';
import type { XRFrameState, XRInputSource, XRNativeSession } from './types.js';

/** XR interaction modes, in default priority order: touch, grab, ray. */
export type XRPointerType = 'ray' | 'grab' | 'touch';
/** A selection picker; SpatialPicking from @margoengine/selection/spatial implements it. */
export interface XRPointerPicker {
  ray(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    near?: number,
    far?: number,
    signal?: AbortSignal,
  ): Promise<PickHit | null>;
  sphere(center: ArrayLike<number>, radius: number, signal?: AbortSignal): Promise<PickHit | null>;
}
/** The session and frame subscription of an XR manager. */
export interface XRPointerHost {
  readonly session: XRNativeSession | null;
  readonly controllers: readonly XRController[];
  onFrame(callback: (state: XRFrameState) => void): () => void;
}
/** The same event vocabulary for controller rays, grip proximity and fingertip touch. */
export interface XRPointerEvent {
  type: 'pointerover' | 'pointerout' | 'pointermove' | 'pointerdown' | 'pointerup' | 'pointercancel' | 'click';
  pointerId: number;
  pointerType: XRPointerType;
  inputSource: XRInputSource;
  controller: XRController;
  hit: PickHit;
  target: PickHit['mesh'];
  buttons: number;
  readonly stopped: boolean;
  stopPropagation(): void;
  /** Capture redirects subsequent events through release, even when the pointer misses. */
  setPointerCapture(target?: Mesh): void;
  releasePointerCapture(target?: Mesh): void;
  hasPointerCapture(target?: Mesh): boolean;
}
/** Options are copied at attachment. Distances are metres. */
export interface XRPointerOptions {
  /** Receives the hit event. React bindings bubble it through mesh parents. */
  onEvent(event: XRPointerEvent): void;
  /** Required error receiver for an attached asynchronous picker. */
  onError(error: unknown): void;
  /** Default ['touch', 'grab', 'ray']; the first mode with a hit wins per input. */
  types?: readonly XRPointerType[];
  /** Fingertip sphere radius, added to the tracked joint radius. Default 0.01. */
  touchRadius?: number;
  /** Grip sphere radius. Default 0.08. */
  grabRadius?: number;
  /** Ray range. Default 0.0001 and 1000. */
  near?: number;
  far?: number;
  /** Aborting detaches listeners and cancels all active pointers. */
  signal?: AbortSignal;
}
interface Sample {
  controller: XRController;
  source: XRInputSource;
  ray: Float32Array | null;
  grip: Float32Array | null;
  tip: Float32Array | null;
  tipRadius: number;
  select: boolean;
  squeeze: boolean;
}
interface Pointer {
  id: number;
  sample: Sample;
  type: XRPointerType;
  hover: PickHit | null;
  down: PickHit | null;
  capture: PickHit | null;
  pressed: boolean;
}
let nextId = 1000;

/** One stable pointer per input source, with mode priority, hover, press/release/click and capture. */
export class XRPointerEvents {
  private readonly stop: () => void;
  private readonly pointers = new Map<XRInputSource, Pointer>();
  private readonly native = new Map<XRInputSource, { select?: boolean; squeeze?: boolean }>();
  private session: XRNativeSession | null = null;
  private last: Sample[] = [];
  private queue: Sample[][] = [];
  private running = false;
  private pending = new AbortController();
  private disposed = false;
  private generation = 0;
  private readonly types: readonly XRPointerType[];
  private readonly touchRadius: number;
  private readonly grabRadius: number;
  private readonly near: number;
  private readonly far: number;

  static attach(xr: XRPointerHost, picker: XRPointerPicker, options: XRPointerOptions): XRPointerEvents {
    options.signal?.throwIfAborted();
    return new XRPointerEvents(xr, picker, options);
  }
  private constructor(
    private readonly xr: XRPointerHost,
    private readonly picker: XRPointerPicker,
    private readonly options: XRPointerOptions,
  ) {
    this.types = [...(options.types ?? ['touch', 'grab', 'ray'])];
    this.touchRadius = options.touchRadius ?? 0.01;
    this.grabRadius = options.grabRadius ?? 0.08;
    this.near = options.near ?? 0.0001;
    this.far = options.far ?? 1000;
    if (
      typeof options.onEvent !== 'function' ||
      typeof options.onError !== 'function' ||
      !this.types.length ||
      new Set(this.types).size !== this.types.length ||
      this.types.some((t) => !['touch', 'grab', 'ray'].includes(t)) ||
      ![this.touchRadius, this.grabRadius, this.near, this.far].every(Number.isFinite) ||
      this.touchRadius < 0 ||
      this.grabRadius < 0 ||
      this.near <= 0 ||
      this.far <= this.near
    )
      throw rangeError(
        'XRPointerEvents needs event/error receivers, unique pointer types and valid distances; pass valid pointer options',
        'arguments',
      );
    this.bind();
    this.stop = xr.onFrame(() => {
      this.bind();
      const samples = this.xr.controllers.map((controller) => {
        const source = controller.source,
          native = this.native.get(source);
        const tipIndex = source.hand ? [...source.hand.keys()].indexOf('index-finger-tip') : -1;
        const thumbIndex = source.hand ? [...source.hand.keys()].indexOf('thumb-tip') : -1;
        const tip =
          tipIndex >= 0 && controller.handTracked[tipIndex]
            ? controller.handMatrices.slice(tipIndex * 16, tipIndex * 16 + 16)
            : null;
        const thumb =
          thumbIndex >= 0 && controller.handTracked[thumbIndex]
            ? controller.handMatrices.subarray(thumbIndex * 16, thumbIndex * 16 + 16)
            : null;
        const pinch =
          !!tip && !!thumb && Math.hypot(tip[12] - thumb[12], tip[13] - thumb[13], tip[14] - thumb[14]) < 0.025;
        return {
          controller,
          source,
          ray: controller.targetRay ? controller.targetRayMatrix.slice() : null,
          grip: controller.grip ? controller.gripMatrix.slice() : null,
          tip,
          tipRadius: tipIndex >= 0 ? controller.handRadii[tipIndex] : 0,
          select: native?.select ?? (!!controller.buttons[1] || pinch),
          squeeze: native?.squeeze ?? (!!controller.buttons[4] || pinch),
        };
      });
      this.last = samples;
      this.enqueue(samples);
    });
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }
  private bind(): void {
    if (this.session === this.xr.session) return;
    this.unbind();
    this.cancel();
    this.session = this.xr.session;
    for (const type of ['selectstart', 'selectend', 'squeezestart', 'squeezeend'])
      this.session?.addEventListener(type, this.action);
    this.session?.addEventListener('end', this.ended);
    this.session?.addEventListener('inputsourceschange', this.sources);
  }
  private unbind(): void {
    for (const type of ['selectstart', 'selectend', 'squeezestart', 'squeezeend'])
      this.session?.removeEventListener(type, this.action);
    this.session?.removeEventListener('end', this.ended);
    this.session?.removeEventListener('inputsourceschange', this.sources);
    this.session = null;
    this.native.clear();
  }
  private readonly action = (event: Event): void => {
    const source = (event as Event & { inputSource: XRInputSource }).inputSource;
    if (!source) return;
    const value = this.native.get(source) ?? {};
    if (event.type.startsWith('select')) value.select = event.type === 'selectstart';
    else value.squeeze = event.type === 'squeezestart';
    this.native.set(source, value);
    this.enqueue(this.last.map((sample) => (sample.source === source ? { ...sample, ...value } : sample)));
  };
  private readonly sources = (): void => {
    // Invalidate pending readbacks as soon as a source goes away, before the next XR frame.
    const sources = new Set(this.session?.inputSources);
    for (const [source, pointer] of this.pointers)
      if (!sources.has(source)) {
        this.finish(pointer);
        this.pointers.delete(source);
        this.native.delete(source);
      }
    this.generation++;
    this.last = this.last.filter((s) => sources.has(s.source));
    this.queue = this.queue.map((samples) => samples.filter((s) => sources.has(s.source)));
  };
  private readonly ended = (): void => {
    this.unbind();
    this.cancel();
  };
  private readonly abort = (): void => {
    this.dispose();
  };
  private enqueue(samples: Sample[]): void {
    if (this.disposed) return;
    const previous = this.queue.at(-1);
    // Only moves coalesce. Every press/release transition remains ordered behind an in-flight pick.
    if (
      previous &&
      previous.length === samples.length &&
      previous.every(
        (s, i) => s.source === samples[i].source && s.select === samples[i].select && s.squeeze === samples[i].squeeze,
      )
    )
      this.queue[this.queue.length - 1] = samples;
    else this.queue.push(samples);
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.disposed && this.queue.length) {
        const samples = this.queue.shift()!,
          epoch = this.generation;
        const active = new Set(samples.map((s) => s.source));
        for (const [source, pointer] of this.pointers)
          if (!active.has(source)) {
            this.finish(pointer);
            this.pointers.delete(source);
          }
        for (const sample of samples) {
          let pointer = this.pointers.get(sample.source);
          if (!pointer) {
            pointer = { id: nextId++, sample, type: 'ray', hover: null, down: null, capture: null, pressed: false };
            this.pointers.set(sample.source, pointer);
          }
          const signal = this.pending.signal;
          let found;
          try {
            found = await this.pick(sample, pointer, signal);
          } catch (error) {
            if (signal.aborted) break;
            throw error;
          }
          if (this.disposed || epoch !== this.generation) break;
          pointer.sample = sample;
          this.update(pointer, found);
        }
      }
    } catch (error) {
      this.cancel();
      this.options.onError(error);
    } finally {
      this.running = false;
      if (this.queue.length && !this.disposed) void this.drain();
    }
  }
  private async pick(
    sample: Sample,
    pointer: Pointer,
    signal: AbortSignal,
  ): Promise<{ type: XRPointerType; hit: PickHit | null }> {
    for (const type of pointer.pressed ? [pointer.type] : this.types) {
      let hit: PickHit | null = null;
      if (type === 'ray' && sample.ray)
        hit = await this.picker.ray(
          sample.ray.subarray(12, 15),
          [-sample.ray[8], -sample.ray[9], -sample.ray[10]],
          this.near,
          this.far,
          signal,
        );
      if (type === 'grab' && sample.grip)
        hit = await this.picker.sphere(sample.grip.subarray(12, 15), this.grabRadius, signal);
      if (type === 'touch' && sample.tip)
        hit = await this.picker.sphere(sample.tip.subarray(12, 15), this.touchRadius + sample.tipRadius, signal);
      if (hit) return { type, hit };
    }
    return { type: pointer.type, hit: null };
  }
  private update(pointer: Pointer, found: { type: XRPointerType; hit: PickHit | null }): void {
    const { sample } = pointer;
    const tracked = found.type === 'ray' ? sample.ray : found.type === 'grab' ? sample.grip : sample.tip;
    if (!tracked) {
      this.finish(pointer);
      return;
    }
    const hit = pointer.capture ?? found.hit;
    if (
      pointer.hover?.mesh !== hit?.mesh ||
      pointer.hover?.instanceId !== hit?.instanceId ||
      pointer.type !== found.type
    ) {
      if (pointer.hover) this.fire('pointerout', pointer, pointer.hover);
      if (this.disposed) return;
      pointer.hover = hit;
      pointer.type = found.type;
      if (hit) this.fire('pointerover', pointer, hit);
      if (this.disposed) return;
    }
    if (hit) this.fire('pointermove', pointer, hit);
    if (this.disposed) return;
    const pressed = found.type === 'touch' ? !!found.hit : found.type === 'grab' ? sample.squeeze : sample.select;
    if (pressed && !pointer.pressed) {
      pointer.pressed = true;
      pointer.down = hit;
      if (hit) this.fire('pointerdown', pointer, hit);
    } else if (!pressed && pointer.pressed) {
      pointer.pressed = false;
      const captured = pointer.capture;
      const released = hit ?? (found.type === 'touch' ? pointer.down : null);
      if (released) this.fire('pointerup', pointer, released);
      if (this.disposed) return;
      if (released && (captured || (pointer.down?.mesh === released.mesh && pointer.down?.instanceId === released.instanceId)))
        this.fire('click', pointer, released);
      pointer.down = pointer.capture = null;
    }
  }
  private fire(type: XRPointerEvent['type'], pointer: Pointer, hit: PickHit): void {
    let stopped = false;
    this.options.onEvent({
      type,
      pointerId: pointer.id,
      pointerType: pointer.type,
      controller: pointer.sample.controller,
      inputSource: pointer.sample.source,
      hit,
      target: hit.mesh,
      buttons: +pointer.pressed,
      get stopped() {
        return stopped;
      },
      stopPropagation() {
        stopped = true;
      },
      setPointerCapture(target = hit.mesh) {
        if (pointer.pressed) pointer.capture = { ...hit, mesh: meshRuntime(target) };
      },
      releasePointerCapture(target = hit.mesh) {
        if (pointer.capture?.mesh === target) pointer.capture = null;
      },
      hasPointerCapture(target = hit.mesh) {
        return pointer.capture?.mesh === target;
      },
    });
  }
  private finish(pointer: Pointer): void {
    const down = pointer.pressed ? (pointer.capture ?? pointer.down) : null,
      hover = pointer.hover;
    pointer.pressed = false;
    pointer.down = pointer.hover = pointer.capture = null;
    if (down) this.fire('pointercancel', pointer, down);
    if (hover) this.fire('pointerout', pointer, hover);
  }
  private cancel(): void {
    this.pending.abort(fault('state', 'XR pointer session changed; attach to a live session'));
    this.pending = new AbortController();
    this.generation++;
    this.queue = [];
    this.last = [];
    const pointers = [...this.pointers.values()];
    this.pointers.clear();
    for (const pointer of pointers) this.finish(pointer);
  }
  /** Cancels active pointers, removes session/frame/signal listeners and ignores pending readbacks. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.unbind();
    this.cancel();
    this.options.signal?.removeEventListener('abort', this.abort);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
