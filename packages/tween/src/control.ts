import { MargoError } from '@margoengine/math/errors';
import { to, type PropertyValues, type PropertyTween } from './props.js';
import type { AsyncTweenOptions } from './async.js';

/** Controls how new work replaces registered target properties. */
export interface ControlTweenOptions extends AsyncTweenOptions {
  /** false: coexist; 'auto': remove matching keys; 'all': remove every key of the target. Default 'auto'. */
  overwrite?: false | 'auto' | 'all';
}
/** A registered operation; its frame clock belongs to its TweenControl. */
export interface ControlledTween extends PromiseLike<void>, Disposable {
  /** Completion promise, rejected only if cancelled entirely or on error. */
  readonly finished: Promise<void>;
  /** The actual target object. */
  readonly target: object;
  /** Keys still owned by this operation. */
  readonly keys: readonly string[];
  /** Pause only this operation, including its delay. */
  pause(): this;
  /** Resume from its current local time. */
  play(): this;
  /** Local playback multiplier >= 0. Default 1. */
  speed: number;
  /** Remove some keys, or all keys when omitted. Returns the number removed. */
  kill(keys?: readonly string[]): number;
  /** Cancel every remaining key with an optional rejection reason. */
  cancel(reason?: unknown): void;
}
type Channel = { key: string; operation: PropertyTween; shadow: Record<string, number>; done: boolean; removed: boolean };
const abortError = () => new DOMException('Animation cancelled', 'AbortError');
class Group implements ControlledTween {
  readonly finished: Promise<void>;
  private resolve!: () => void;
  private reject!: (reason: unknown) => void;
  private paused = false;
  private scale = 1;
  private settled = false;
  private repeated = false;
  readonly channels: Channel[] = [];
  private readonly abort = () => this.cancel(this.options.signal!.reason);
  constructor(readonly target: object, values: Record<string, unknown>, private readonly options: ControlTweenOptions) {
    if ((options.onComplete !== undefined && typeof options.onComplete !== 'function') || (options.onRepeat !== undefined && typeof options.onRepeat !== 'function')) throw new TypeError('Callbacks must be functions; pass onComplete/onRepeat functions');
    const object = target as Record<string, unknown>;
    // Build on private values, so one invalid property cannot change a target or destroy prior work.
    for (const [key, value] of Object.entries(values)) {
      const shadow = { [key]: object[key] } as Record<string, number>;
      const channel = {key, shadow, done: false, removed: false} as Channel;
      channel.operation = to(shadow, {[key]: value} as PropertyValues<typeof shadow>, {
        ...options, signal: undefined, onComplete: () => { channel.done = true; }, onRepeat: () => { this.repeated = true; },
      });
      // Observe child cancellation internally; this group's promise carries the outcome to the caller.
      void channel.operation.finished.then(() => {}, (reason: unknown) => { if (!channel.removed) this.cancel(reason); });
      this.channels.push(channel);
    }
    if (!this.channels.length) throw new RangeError('A controlled tween needs numeric properties; pass at least one key');
    this.finished = new Promise<void>((yes, no) => { this.resolve = yes; this.reject = no; });
  }
  attach(): void {
    if (this.options.signal?.aborted) { this.cancel(this.options.signal.reason); return; }
    this.options.signal?.addEventListener('abort', this.abort, {once: true});
    for (const channel of this.channels) (this.target as Record<string, number>)[channel.key] = channel.shadow[channel.key];
  }
  get keys(): readonly string[] { return this.channels.filter((channel) => !channel.removed && !channel.done).map((channel) => channel.key); }
  get active(): boolean { return !this.settled; }
  get speed(): number { return this.scale; }
  set speed(value: number) { if (!Number.isFinite(value) || value < 0) throw new RangeError('Tween speed must be finite and >= 0'); this.scale = value; }
  pause(): this { this.paused = true; return this; }
  play(): this { this.paused = false; return this; }
  advance(delta: number): void {
    if (this.settled || this.paused || this.scale === 0) return;
    try {
      this.repeated = false;
      for (const channel of this.channels) if (!channel.removed && !channel.done) {
        channel.operation.update(delta * this.scale);
        if (!channel.removed) (this.target as Record<string, number>)[channel.key] = channel.shadow[channel.key];
      }
      if (!this.settled && this.repeated) this.options.onRepeat?.();
      if (!this.settled && this.channels.every((channel) => channel.removed || channel.done)) {
        this.options.onComplete?.();
        this.settled = true; this.detach(); this.resolve();
      }
    } catch (error) { this.cancel(error); throw error; }
  }
  private detach(): void { this.options.signal?.removeEventListener('abort', this.abort); }
  kill(keys?: readonly string[]): number {
    let count = 0;
    for (const channel of this.channels) if (!channel.removed && !channel.done && (keys === undefined || keys.includes(channel.key))) {
      channel.removed = true;
      channel.operation.cancel();
      count++;
    }
    if (count && this.channels.every((channel) => channel.removed || channel.done)) this.cancel();
    return count;
  }
  cancel(reason: unknown = abortError()): void {
    if (this.settled) return;
    this.settled = true; this.detach();
    for (const channel of this.channels) if (!channel.removed && !channel.done) { channel.removed = true; channel.operation.cancel(reason); }
    this.reject(reason);
  }
  then<TResult1 = void, TResult2 = never>(onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> { return this.finished.then(onfulfilled, onrejected); }
  [Symbol.dispose](): void { this.cancel(); }
}

/** An explicit animation world: one global time scale and target/key registry, without module globals. */
export class TweenControl implements Disposable {
  private readonly groups: Group[] = [];
  private updating = false;
  private scale = 1;
  /** Global multiplier for every operation in this world. Finite >= 0, default 1. */
  get timeScale(): number { return this.scale; }
  set timeScale(value: number) { if (!Number.isFinite(value) || value < 0) throw new RangeError('Global timeScale must be finite and >= 0'); this.scale = value; }
  /** Create a multi-property operation, atomically validating before applying overwrite policy. */
  to<T extends object>(target: T, values: PropertyValues<T>, options: ControlTweenOptions): ControlledTween {
    const overwrite = options.overwrite ?? 'auto';
    if (overwrite !== false && overwrite !== 'auto' && overwrite !== 'all') throw new RangeError('overwrite must be false, auto or all');
    const group = new Group(target, values, options);
    if (!options.signal?.aborted && overwrite !== false) this.killTweensOf(target, overwrite === 'all' ? undefined : Object.keys(values));
    this.groups.push(group); group.attach();
    return group;
  }
  /** Remove all or selected keys, including paused and delayed work. Returns the number of removed keys. */
  killTweensOf(target: object, keys?: readonly string[]): number { let count = 0; for (const group of this.groups) if (group.target === target) count += group.kill(keys); return count; }
  /** Snapshot of operations still running, paused or delayed for a target. */
  getTweensOf(target: object): readonly ControlledTween[] { return this.groups.filter((group) => group.target === target && group.active); }
  /** Advance registered work once. Work created in callbacks starts on the next update. */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0 || !Number.isFinite(delta * this.scale)) throw new RangeError('Scaled update delta must be finite and >= 0');
    if (this.updating) throw new MargoError('state', 'Recursive control update; call update after the callback returns');
    if (this.scale === 0) return;
    const count = this.groups.length;
    this.updating = true;
    try { for (let i = 0; i < count; i++) this.groups[i].advance(delta * this.scale); }
    finally {
      this.updating = false;
      let live = 0;
      for (const group of this.groups) if (group.active) this.groups[live++] = group;
      this.groups.length = live;
    }
  }
  /** Cancel all operations in this world. */
  dispose(): void { for (const group of this.groups) group.cancel(); if (!this.updating) this.groups.length = 0; }
  /** Dispose this world. */
  [Symbol.dispose](): void { this.dispose(); }
}
