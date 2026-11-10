/// <reference lib="esnext.disposable" />
/** A seekable animation, including the root and full optional Timeline classes. */
export interface ScrollAnimation {
  /** One pass in seconds. Must be positive and finite. */
  readonly duration: number;
  /** Pause the automatic caller clock. */
  pause(): unknown;
  /** Sample without playback callbacks. */
  seek(time: number): unknown;
  /** Optional label snapshot, provided by tween/timeline. */
  readonly labelTimes?: ReadonlyMap<string, number>;
}
/** Normalized snap stops, an interval, labels, or a custom destination. */
export type ScrollSnap = 'labels' | 'labelsDirectional' | number | readonly number[] | ((progress: number, direction: number) => number);
/** Vertical scroll pinning and idle snapping options. */
export interface PinTimelineOptions {
  /** Section to hold during the scroll range. Its DOM and inline styles are restored on disposal. */
  pin: HTMLElement;
  /** Scrolling window or element. Default the pin's window. */
  source?: Window | HTMLElement;
  /** Start scroll offset, or a function read on refresh. Default the section's natural offset. */
  start?: number | (() => number);
  /** Scroll distance in pixels, or a function read on refresh. Default one viewport height. */
  distance?: number | (() => number);
  /** Reserve scroll distance in layout. Default true. */
  pinSpacing?: boolean;
  /** Snap after scrolling stops. Default disabled. */
  snap?: ScrollSnap;
  /** Label times for a root Timeline; defaults to timeline.labelTimes. */
  labels?: ReadonlyMap<string, number>;
  /** Idle seconds before snapping, finite >= 0. Default 0.2. */
  snapDelay?: number;
  /** Snap transition seconds, finite >= 0. Default 0.25. */
  snapDuration?: number;
  /** Exponential scrub catch-up seconds, finite >= 0. Default 0. */
  scrub?: number;
  /** Dispose on abort. Default none. */
  signal?: AbortSignal;
  /** Notification after each timeline sample. Default none. */
  onUpdate?: (progress: number) => void;
}
/** A disposable scroll owner. It never starts the timeline's playback clock. */
export interface PinTimelineLink extends Disposable {
  /** Current animation progress. */
  readonly progress: number;
  /** Whether an idle snap is active. */
  readonly snapping: boolean;
  /** Recalculate responsive layout, ranges and labels. */
  refresh(): void;
  /** Remove listeners, frames and spacer; restore the pin's styles. */
  dispose(): void;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const nonnegative = (value: number, name: string) => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and >= 0; pass seconds or pixels`);
  return value;
};

/** Select a snap stop deterministically. Directional labels prefer the direction of travel. */
export function scrollSnapPoint(progress: number, stops: readonly number[], direction = 0): number {
  if (!Number.isFinite(progress) || !stops.length || stops.some(value => !Number.isFinite(value) || value < 0 || value > 1))
    throw new RangeError('Snap stops must be finite progress values in 0..1; provide at least one stop');
  const ordered = [...new Set(stops)].sort((a, b) => a - b);
  const candidates = direction > 0 ? ordered.filter(value => value >= progress) : direction < 0 ? ordered.filter(value => value <= progress) : ordered;
  const points = candidates.length ? candidates : [direction > 0 ? ordered[ordered.length - 1] : ordered[0]];
  return points.reduce((best, value) => Math.abs(value - progress) < Math.abs(best - progress) ? value : best);
}

/** Pin a section while a timeline scrubs, then snap the scroll position to its stops when idle. */
export function pinTimeline(timeline: ScrollAnimation, options: PinTimelineOptions): PinTimelineLink {
  const {pin, signal, snap, snapDelay = 0.2, snapDuration = 0.25, scrub = 0} = options;
  const view = pin.ownerDocument.defaultView;
  if (!view || !pin.parentNode) throw new TypeError('Pinning needs an attached element and its window');
  nonnegative(snapDelay, 'snapDelay'); nonnegative(snapDuration, 'snapDuration'); nonnegative(scrub, 'scrub');
  if (options.onUpdate !== undefined && typeof options.onUpdate !== 'function') throw new TypeError('onUpdate must be a function');
  const source = options.source ?? view, page = 'document' in source;
  const top = () => page ? (source as Window).scrollY : (source as HTMLElement).scrollTop;
  const height = () => page ? (source as Window).innerHeight : (source as HTMLElement).clientHeight;
  const origin = () => page ? 0 : (source as HTMLElement).getBoundingClientRect().top + (source as HTMLElement).clientTop;
  const writeScroll = (value: number) => source.scrollTo({top:value, behavior:'instant'});
  const spacer = pin.ownerDocument.createElement('div'), originalStyle = pin.getAttribute('style');
  const restoreStyle = () => originalStyle === null ? pin.removeAttribute('style') : pin.setAttribute('style',originalStyle);
  let disposed = false, installed = false, frame = 0, start = 0, distance = 0, progress = 0, target = 0;
  let previousTop = top(), direction = 0, idleAt = 0, last = 0, pendingSnap = false;
  let snapping = false, snapAt = 0, snapFrom = 0, snapTo = 0, expectedTop: number | undefined;
  let stops: number[] = [];
  const now = () => view.performance.now();
  const restore = () => { restoreStyle(); if (spacer.parentNode) { spacer.replaceWith(pin); } installed = false; };
  const readRange = () => {
    if (!Number.isFinite(timeline.duration) || timeline.duration <= 0) throw new RangeError('Scroll timeline duration must be finite and positive; add a clip');
    restoreStyle();
    const box=pin.getBoundingClientRect(), natural=box.top-origin()+top();
    start = options.start === undefined ? natural : typeof options.start === 'function' ? options.start() : options.start;
    distance = options.distance === undefined ? height() : typeof options.distance === 'function' ? options.distance() : options.distance;
    nonnegative(start,'start'); nonnegative(distance,'distance');
    if(!distance) throw new RangeError('Pin distance must be positive; pass scroll pixels');
    if(typeof snap === 'number') {
      if(!Number.isFinite(snap) || snap<=0 || snap>1) throw new RangeError('Snap interval must be in (0,1]; pass a normalized interval');
      // Intervals are computed analytically; never allocate a list proportional to their reciprocal.
      stops=[];
    } else if(typeof snap === 'string') {
      if(snap!=='labels' && snap!=='labelsDirectional') throw new RangeError('Unknown snap mode; use labels or labelsDirectional');
      const labels=options.labels ?? timeline.labelTimes;
      stops=labels ? [...labels.values()].map(value=>value/timeline.duration) : [];
      scrollSnapPoint(0,stops);
    } else if(Array.isArray(snap)) { stops=[...snap]; scrollSnapPoint(0,stops); }
    else if(snap!==undefined && typeof snap!=='function') throw new TypeError('snap needs labels, an interval, stops or a function');
    return box;
  };
  const sample = (next: number) => { progress=next; timeline.seek(next*timeline.duration); options.onUpdate?.(next); };
  const position = () => {
    const value=top();
    pin.style.top=`${Math.max(0,Math.min(distance,value-start))}px`;
    target=clamp((value-start)/distance);
    return value;
  };
  const destination = () => {
    const value = typeof snap==='function' ? snap(target,direction) : typeof snap==='number' ? Math.round(target/snap)*snap : scrollSnapPoint(target,stops,snap==='labelsDirectional'?direction:0);
    if(!Number.isFinite(value)) throw new RangeError('Snap function must return a finite progress value');
    return clamp(value);
  };
  const schedule = () => { if(!disposed && !frame) frame=view.requestAnimationFrame(step); };
  const step = (time: number) => {
    frame=0;
    if(disposed) return;
    const delta=last ? Math.max(0,time-last)/1000 : 0; last=time;
    if(pendingSnap && !snapping && time-idleAt>=snapDelay*1000) {
      pendingSnap=false;
      if(top()>=start && top()<=start+distance) {
        snapFrom=top(); snapTo=start+destination()*distance; snapAt=time;
        snapping=Math.abs(snapFrom-snapTo)>0.5;
      }
    }
    if(snapping) {
      const t=snapDuration ? clamp((time-snapAt)/(snapDuration*1000)) : 1;
      expectedTop=snapFrom+(snapTo-snapFrom)*(1-Math.pow(1-t,3));
      writeScroll(expectedTop); position();
      if(t===1) snapping=false;
    }
    const next=scrub ? target+(progress-target)*Math.exp(-delta/scrub) : target;
    sample(Math.abs(next-target)<1e-4 ? target : next);
    if(!disposed && (snapping || pendingSnap || progress!==target)) schedule(); else last=0;
  };
  const scrolled = () => {
    if(disposed) return;
    const value=top(), owned=expectedTop!==undefined && Math.abs(value-expectedTop)<=1;
    if(!owned) {
      snapping=false; direction=Math.sign(value-previousTop)||direction; idleAt=now(); pendingSnap=snap!==undefined;
    }
    previousTop=value; position();
    if(!scrub) sample(target);
    schedule();
  };
  const interrupt = () => { snapping=false; pendingSnap=false; expectedTop=undefined; };
  const observer = typeof view.ResizeObserver==='function' ? new view.ResizeObserver(()=>refresh()) : undefined;
  const dispose = () => {
    if(disposed) return;
    disposed=true;
    if(frame) view.cancelAnimationFrame(frame);
    frame=0; snapping=false; observer?.disconnect();
    source.removeEventListener('scroll',scrolled); view.removeEventListener('resize',refresh);
    for(const event of ['wheel','pointerdown','touchstart','keydown']) source.removeEventListener(event,interrupt);
    signal?.removeEventListener('abort',dispose);
    if(installed) restore();
  };
  const refresh = () => {
    if(disposed) return;
    interrupt();
    const preserved=top();
    try {
    // Measure in the original flow, so viewport changes and responsive widths are read correctly.
    if(installed) restore();
    const box=readRange();
    spacer.style.cssText=`position:relative;box-sizing:border-box;width:${box.width}px;height:${box.height+(options.pinSpacing===false?0:distance)}px;`;
    pin.before(spacer); spacer.append(pin); installed=true;
    Object.assign(pin.style,{position:'absolute',left:'0',top:'0',width:`${box.width}px`,height:`${box.height}px`,margin:'0',boxSizing:'border-box'});
    // Reparenting can move the browser's scroll anchor. Refresh preserves the caller's scroll offset.
    expectedTop=preserved; writeScroll(preserved); previousTop=top();
    position(); sample(target);
    } catch(error) { dispose(); throw error; }
  };
  // Validate before taking ownership or writing to the timeline/DOM.
  readRange();
  if(!signal?.aborted) {
    timeline.pause(); refresh();
    source.addEventListener('scroll',scrolled,{passive:true}); view.addEventListener('resize',refresh);
    for(const event of ['wheel','pointerdown','touchstart','keydown']) source.addEventListener(event,interrupt,{passive:true});
    observer?.observe(pin); signal?.addEventListener('abort',dispose,{once:true});
  } else disposed=true;
  return {get progress(){return progress;},get snapping(){return snapping;},refresh,dispose,[Symbol.dispose]:dispose};
}
