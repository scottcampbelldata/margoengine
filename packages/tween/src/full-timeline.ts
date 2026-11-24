import { MargoError } from '@margoengine/math/errors';
import { linear, lerpArray, type Easing, type ArrayTweenOptions } from './index.js';

/** Timing of a child within a timeline. */
export interface ClipOptions {
  /** Duration in seconds, finite and >= 0. */
  duration: number;
  /** Start seconds or a label with optional +/- seconds. Default append. */
  at?: number | string;
  /** Easing per pass. Default linear. */
  easing?: Easing;
}
/** Playback options for a timeline group. */
export interface FullTimelineOptions {
  /** Playback speed > 0. Default 1. */
  speed?: number;
  /** Extra passes, integer >= 0 or Infinity. Default 0. */
  repeat?: number;
  /** Alternate direction between passes. Default false. */
  yoyo?: boolean;
  /** Completion notification. Default none. */
  onComplete?: () => void;
  /** Cancels playback and rejects finished with the exact reason. Default none. */
  signal?: AbortSignal;
}
type Clip = { start: number; length: () => number; render: (local: number) => void; restore: () => void; seen: boolean; child?: Timeline };
type ArrayTarget = number[] | Float32Array | Float64Array;
const finite = (value: number, name: string) => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and >= 0; pass seconds`);
  return value;
};

/** Seekable mixed-media timelines with nested local clocks. No timers or globals. */
export class Timeline implements Disposable, PromiseLike<void> {
  private readonly clips: Clip[] = [];
  private readonly callbacks: { at: number; fn: () => void }[] = [];
  private readonly labels = new Map<string, number>();
  private position = 0;
  private running = false;
  private direction = 1;
  /** Yoyo leg: -1 on a backward pass. Kept apart from direction so a replay starts the way reverse() set. */
  private leg = 1;
  private repeats = 0;
  private ended = false;
  private began = false;
  private applying = false;
  private rate = 1;
  private parent?: Timeline;
  private promise!: Promise<void>;
  private resolveFinished!: () => void;
  private rejectFinished!: (reason: unknown) => void;
  private settled = false;
  private cancelled = false;
  private readonly aborted = () => this.cancel(this.options.signal!.reason);
  constructor(private readonly options: FullTimelineOptions = {}) {
    const { repeat = 0, yoyo = false, onComplete } = options;
    if ((repeat !== Infinity && (!Number.isInteger(repeat) || repeat < 0)) || typeof yoyo !== 'boolean' || (onComplete !== undefined && typeof onComplete !== 'function')) throw new RangeError('Invalid timeline options; use integer repeat >= 0, boolean yoyo and a completion function');
    this.speed = options.speed ?? 1;
    this.repeats = repeat;
    this.resetPromise();
  }
  private resetPromise(): void {
    this.settled = false; this.cancelled = false;
    this.promise = new Promise<void>((resolve, reject) => { this.resolveFinished = resolve; this.rejectFinished = reject; });
    if (this.options.signal?.aborted) this.cancel(this.options.signal.reason);
    else this.options.signal?.addEventListener('abort', this.aborted, {once: true});
  }
  private complete(): void {
    if (this.settled) return;
    try { this.options.onComplete?.(); }
    catch(error) { this.cancel(error); throw error; }
    if (this.settled) return;
    this.settled = true;
    this.options.signal?.removeEventListener('abort', this.aborted);
    this.resolveFinished();
  }
  /** Completion for the current run; renewed on replay. Cancellation rejects it. */
  get finished(): Promise<void> { return this.promise; }
  then<TResult1 = void, TResult2 = never>(onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> { return this.finished.then(onfulfilled, onrejected); }
  /** Stop this timeline and its children, preserving values; default reason AbortError. */
  cancel(reason: unknown = new DOMException('Timeline cancelled', 'AbortError')): void {
    if (this.cancelled) return;
    this.running = false; this.cancelled = true;
    for (const clip of this.clips) clip.child?.cancel(reason);
    if(this.parent && !this.parent.cancelled) this.parent.cancel(reason);
    if (this.settled) return;
    this.settled = true; this.options.signal?.removeEventListener('abort', this.aborted); this.rejectFinished(reason);
  }
  /** One pass length in this timeline's seconds, reflecting nested speeds. */
  get duration(): number { let end=0; for(const clip of this.clips) end=Math.max(end,clip.start+clip.length()); for(const call of this.callbacks) end=Math.max(end,call.at); return end; }
  /** Time within the current pass. */
  get time(): number { return this.position; }
  /** Whether update advances this timeline. */
  get playing(): boolean { return this.running; }
  /** Local speed > 0. A parent includes this multiplier exactly once. Default 1. */
  get speed(): number { return this.rate; }
  set speed(value: number) { if (!Number.isFinite(value) || value <= 0) throw new RangeError('Timeline speed must be finite and > 0'); this.rate = value; }
  private editable(): void { if (this.applying) throw new MargoError('state', 'Cannot edit during timeline callbacks; edit after update returns'); }
  private resolve(at?: number | string): number {
    if (at === undefined) return this.duration;
    if (typeof at === 'number') return finite(at, 'Timeline position');
    const match = /^(.*?)([+-](?:\d+(?:\.\d*)?|\.\d+))?$/.exec(at);
    const base = match && this.labels.get(match[1]);
    if (base === undefined || base === null) throw new RangeError('Unknown timeline label; add it with label first');
    return finite(base + Number(match?.[2] ?? 0), 'Label position');
  }
  private insert(clip: Clip): this {
    this.editable();
    this.clips.push(clip);
    this.clips.sort((a, b) => a.start - b.start);
    return this;
  }
  private effect(render: (progress: number) => void, capture: () => void, restore: () => void, options: ClipOptions): this {
    this.editable();
    const duration = finite(options.duration, 'Clip duration'), start = this.resolve(options.at), easing = options.easing ?? linear;
    if (typeof easing !== 'function') throw new TypeError('Clip easing must be a function');
    let captured = false;
    return this.insert({ start, length: () => duration, seen: false, restore,
      render: (local) => {
        if (!captured) { capture(); captured = true; }
        const phase = duration ? Math.max(0, Math.min(1, local / duration)) : 1;
        const t = phase === 0 || phase === 1 ? phase : easing(phase);
        if (!Number.isFinite(t)) throw new RangeError('Clip easing must return a finite number');
        render(t);
      },
    });
  }
  /** Add a scalar property tween, lazily capturing its starting value. */
  to(target: Record<string, number>, key: string, value: number, options: ClipOptions): this {
    if (!Number.isFinite(value)) throw new RangeError('Destination must be a finite number');
    let from = 0;
    return this.effect((t) => { target[key] = t === 0 ? from : t === 1 ? value : from * (1 - t) + value * t; }, () => {
      from = target[key];
      if (!Number.isFinite(from)) throw new RangeError('Target must have a finite numeric property');
    }, () => { target[key] = from; }, options);
  }
  /** Add an array/colour/quaternion tween. Defaults to componentwise interpolation. */
  array(target: ArrayTarget, value: ArrayLike<number>, options: ClipOptions & Pick<ArrayTweenOptions, 'interpolate'>): this {
    if (value.length !== target.length || Array.from(value).some((v) => !Number.isFinite(v))) throw new RangeError('Arrays must have equal lengths and finite values');
    const from = new Float64Array(target.length), end = Float64Array.from(value), interpolate = options.interpolate ?? lerpArray;
    if (typeof interpolate !== 'function') throw new TypeError('interpolate must be a function');
    return this.effect((t) => interpolate(target, from, end, t), () => {
      for (let i = 0; i < target.length; i++) { if (!Number.isFinite(target[i])) throw new RangeError('Target array must contain finite numbers'); from[i] = target[i]; }
    }, () => { for (let i = 0; i < target.length; i++) target[i] = from[i]; }, options);
  }
  /** Add any progress sampler; seeking samples it, without firing timeline callbacks. */
  custom(apply: (progress: number) => void, options: ClipOptions): this {
    if (typeof apply !== 'function') throw new TypeError('custom needs a progress function');
    return this.effect(apply, () => {}, () => apply(0), options);
  }
  /** Add a point moving along a caller-supplied path. */
  path(target: ArrayTarget, path: (t: number, out: number[]) => number[], options: ClipOptions): this {
    if (typeof path !== 'function') throw new TypeError('path needs a sampling function');
    const initial = new Float64Array(target.length), out = new Array<number>(target.length);
    return this.effect((t) => {
      path(t, out);
      for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) throw new RangeError('Path must write finite coordinates');
      for (let i = 0; i < out.length; i++) target[i] = out[i];
    }, () => { initial.set(target); }, () => { for (let i = 0; i < initial.length; i++) target[i] = initial[i]; }, options);
  }
  /** Nest a timeline at a time/label. One parent per child, with cycle detection. */
  add(child: Timeline, at?: number | string): this {
    this.editable();
    if (child.parent) throw new MargoError('state', 'Child already has a parent; remove it before adding it again');
    for (let ancestor: Timeline | undefined = this; ancestor; ancestor = ancestor.parent)
      if (ancestor === child) throw new MargoError('state', 'Timeline cycle; add a child that is not an ancestor');
    const start = this.resolve(at);
    child.parent = this;
    // The parent carries failure propagation; avoid an unobserved child rejection.
    void child.finished.then(() => {}, (reason: unknown) => { if (child.parent === this && !this.cancelled) this.cancel(reason); });
    child.pause();
    return this.insert({ start, child, length: () => child.totalDuration / child.speed, seen: false,
      render: (local) => child.sampleTotal(local * child.speed), restore: () => child.restore(),
    });
  }
  /** Detach a child; it can then be attached to a different timeline. */
  remove(child: Timeline): this {
    this.editable();
    const index = this.clips.findIndex((clip) => clip.child === child);
    if (index >= 0) { this.clips.splice(index, 1); child.parent = undefined; }
    return this;
  }
  /** Total local span including repeats; Infinity for an endless child. */
  get totalDuration(): number { return this.duration === 0 ? 0 : this.duration * ((this.options.repeat ?? 0) + 1); }
  private sampleTotal(time: number): void {
    if(this.cancelled) return;
    const duration = this.duration;
    const end = this.totalDuration;
    const clamped = Math.max(0, Math.min(end, time));
    const pass = duration ? Math.min(this.options.repeat ?? 0, Math.max(0, Math.ceil(clamped / duration) - 1)) : 0;
    const local = duration ? clamped - pass * duration : 0;
    const reversed = (this.options.yoyo && pass % 2 ? -1 : 1) * this.direction < 0;
    this.seek(reversed ? duration - local : local);
  }
  /** Add a label at seconds or another label; default append. */
  label(name: string, at?: number | string): this { this.editable(); if (!name) throw new TypeError('label needs a nonempty name'); this.labels.set(name, this.resolve(at)); return this; }
  /** A defensive snapshot of label times for scroll snapping and editors. */
  get labelTimes(): ReadonlyMap<string, number> { return new Map(this.labels); }
  /** Add a callback, fired by playback crossings, never by seek. */
  call(fn: () => void, at?: number | string): this { this.editable(); if (typeof fn !== 'function') throw new TypeError('call needs a function'); this.callbacks.push({at: this.resolve(at), fn}); this.callbacks.sort((a, b) => a.at - b.at); return this; }
  /** Play/resume; a completed run resets its repeat budget. */
  play(): this {
    if (this.parent) throw new MargoError('state', 'Nested clock belongs to its parent; play the parent timeline');
    if(this.options.signal?.aborted) return this;
    if(this.settled) this.prepareReplay();
    if (this.ended) { this.repeats = this.options.repeat ?? 0; this.leg = 1; this.ended = false; this.began = false; this.seek(this.direction > 0 ? 0 : this.duration); }
    this.running = true; return this;
  }
  private prepareReplay(): void {
    if(this.settled) this.resetPromise();
    for(const clip of this.clips) if(clip.child) {
      const child=clip.child;
      child.prepareReplay();
      void child.finished.then(()=>{},(reason: unknown)=>{ if(child.parent===this && !this.cancelled) this.cancel(reason); });
    }
  }
  /** Pause this owner. A parent's clock still samples an attached child. */
  pause(): this { this.running = false; return this; }
  /** Flip direction while retaining the playhead. */
  reverse(): this { this.direction *= -1; return this; }
  private restore(): void {
    for (let i = this.clips.length - 1; i >= 0; i--) if (this.clips[i].seen) this.clips[i].restore();
  }
  /** Sample deterministically at seconds in 0..duration. No call/onComplete notifications. */
  seek(time: number): this {
    if (!Number.isFinite(time)) throw new RangeError('Seek time must be finite; pass seconds');
    this.editable();
    if(this.cancelled) return this;
    this.position = Math.max(0, Math.min(this.duration, time));
    this.applying = true;
    try {
      for (let i = this.clips.length - 1; i >= 0; i--) {
        const clip = this.clips[i];
        if (this.position < clip.start && clip.seen) clip.restore();
      }
      // Capture new clips at their own start, even when a first seek jumps over overlapping clips.
      for (let i=0;i<this.clips.length;i++) {
        if(this.cancelled) break;
        const clip=this.clips[i];
        if(this.position < clip.start || clip.seen) continue;
        for(let j=0;j<i;j++) { const earlier=this.clips[j]; earlier.render(Math.min(earlier.length(),clip.start-earlier.start)); }
        clip.render(0); clip.seen=true;
      }
      for (const clip of this.clips) if (!this.cancelled && this.position >= clip.start) {
        clip.render(Math.min(clip.length(), this.position - clip.start));
        clip.seen = true;
      }
    } finally { this.applying = false; }
    return this;
  }
  private collect(from: number, to: number, initial: boolean): {at: number; fn: () => void}[] {
    const forward=to>=from;
    const events=this.callbacks.filter(call=>forward ? (call.at>from || (initial && call.at===from)) && call.at<=to : call.at<from && call.at>=to).map(call=>({...call}));
    for(const clip of this.clips) if(clip.child && !clip.child.cancelled && Math.max(from,to)>=clip.start && Math.min(from,to)<=clip.start+clip.length()) {
      const child=clip.child;
      const a=Math.max(0,from-clip.start)*child.speed, b=Math.max(0,to-clip.start)*child.speed;
      for(const event of child.collectTotal(a,b,initial || from<clip.start)) events.push({at:clip.start+event.at/child.speed,fn:event.fn});
    }
    return events;
  }
  private collectTotal(from: number,to: number,initial: boolean): {at: number; fn: () => void}[] {
    const duration=this.duration, end=this.totalDuration;
    if(!duration) return initial ? [...this.collect(0,0,true),{at:0,fn:()=>this.complete()}] : [];
    from=Math.min(end,from); to=Math.min(end,to);
    const forward=to>=from, events: {at: number; fn: () => void}[]=[];
    let cursor=from;
    do {
      const pass=Math.min(this.options.repeat??0,forward?Math.floor(cursor/duration):Math.max(0,Math.ceil(cursor/duration)-1));
      const boundary=forward?Math.min(to,(pass+1)*duration):Math.max(to,pass*duration);
      const flip=(this.options.yoyo && pass%2 ? -1:1)*this.direction<0;
      const a=cursor-pass*duration,b=boundary-pass*duration;
      for(const event of this.collect(flip?duration-a:a,flip?duration-b:b,initial)) events.push({at:pass*duration+(flip?duration-event.at:event.at),fn:event.fn});
      if(boundary===cursor || boundary===to) break;
      cursor=boundary;initial=true;
    }while(cursor!==to);
    if(to===end && from<end) events.push({at:end,fn:()=>this.complete()});
    return events;
  }
  private guard(active: boolean): void {
    this.applying=active;
    for(const clip of this.clips) clip.child?.guard(active);
  }
  private dispatch(from: number,to: number,initial: boolean): void {
    const events=this.collect(from,to,initial).sort((a,b)=>to>=from?a.at-b.at:b.at-a.at);
    for(const event of events) {
      if(!this.running) return;
      this.seek(event.at);
      this.guard(true);
      try { event.fn(); } finally { this.guard(false); }
    }
    if(this.running) this.seek(to);
  }
  /** Advance all nested clocks, carrying overshoot across every repeat. */
  update(delta: number): void {
    finite(delta, 'Update delta'); this.editable();
    if (!this.running) return;
    let remaining = delta * this.speed;
    if (!Number.isFinite(remaining)) throw new RangeError('Scaled delta must be finite; reduce speed or delta');
    if (!this.duration && this.repeats === Infinity) throw new RangeError('An infinite repeat needs positive duration; add a clip');
    try { for (;;) {
      const way = this.direction * this.leg, from = this.position, end = way > 0 ? this.duration : 0;
      const distance = Math.abs(end - from), consumed = Math.min(distance, remaining);
      this.seek(from + consumed * way);
      this.dispatch(from, this.position, !this.began);
      if(!this.running) return;
      this.began = true;
      remaining -= consumed;
      if (consumed < distance) return;
      if (this.repeats === 0) { this.running = false; this.ended = true; this.complete(); return; }
      if (this.repeats !== Infinity) this.repeats--;
      if (this.options.yoyo) this.leg *= -1;
      else { this.seek(way > 0 ? 0 : this.duration); this.began = false; }
      if (!remaining) return;
    } } catch(error) { this.cancel(error); throw error; }
  }
  /** Stop and detach children. Values remain at their last sample. */
  dispose(): void { this.editable(); this.cancel(); for (const clip of this.clips) if (clip.child) clip.child.parent = undefined; this.clips.length = 0; this.callbacks.length = 0; this.labels.clear(); }
  /** Dispose this timeline. */
  [Symbol.dispose](): void { this.dispose(); }
}
