import type { Timeline } from './index.js';

/** What scrolls: a scrolling element, or the page (a window). */
export type ScrollSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> &
  (Pick<Element, 'scrollTop' | 'scrollHeight' | 'clientHeight'> | Pick<Window, 'scrollY' | 'innerHeight' | 'document'>);

/** Options for {@link scrollTimeline}. */
export interface ScrollTimelineOptions {
  /** What scrolls. Default the page. */
  source?: ScrollSource;
  /** Follow this element through the view instead of the whole scroll range. */
  element?: Element;
  /**
   * With `element`, the same words as CSS view timelines. 'cover': 0 when its top enters the bottom of the view, 1 when
   * its bottom leaves the top. 'contain': 0 when its top reaches the top of the view, 1 when its bottom reaches the
   * bottom, the one for a tall section with a sticky canvas. Default 'cover'.
   */
  range?: 'cover' | 'contain';
  /** Seconds the timeline takes to catch up with the scroll, for a soft feel; 0 follows at once. Default 0. */
  scrub?: number;
  /** Ends the link, like `dispose`. */
  signal?: AbortSignal;
  /** Called with the progress 0..1 each time the timeline moves. */
  onUpdate?: (progress: number) => void;
}

/** The running link from {@link scrollTimeline}. */
export interface ScrollLink extends Disposable {
  /** Where the scroll is, 0..1. */
  readonly target: number;
  /** Where the timeline is, 0..1; behind `target` while `scrub` catches up. */
  readonly progress: number;
  /** Read the scroll again now; the link does this itself on scroll and on resize. */
  refresh(): void;
  /** Remove the listeners. The timeline stays where it is. */
  dispose(): void;
}

const isWindow = (source: ScrollSource): source is ScrollSource & Window => 'document' in source;

/** Scroll position, view height and the most it scrolls, of a page or an element. */
function metrics(source: ScrollSource): { top: number; view: number; most: number; origin: number } {
  if (isWindow(source)) {
    const view = source.innerHeight;
    return {
      top: source.scrollY,
      view,
      most: source.document.documentElement.scrollHeight - view,
      origin: 0,
    };
  }
  const element = source as Element;
  return {
    top: element.scrollTop,
    view: element.clientHeight,
    most: element.scrollHeight - element.clientHeight,
    origin: element.getBoundingClientRect?.().top ?? 0,
  };
}

/** Progress 0..1 of the scroll, or of an element through the view. A range with no length is at 0. */
function measure(source: ScrollSource, element: Element | undefined, range: 'cover' | 'contain'): number {
  const { top, view, most, origin } = metrics(source);
  let from = 0,
    to = most;
  if (element) {
    const box = element.getBoundingClientRect(),
      start = box.top - origin + top;
    from = range === 'cover' ? start - view : start;
    to = range === 'cover' ? start + box.height : start + box.height - view;
  }
  return to > from ? Math.min(1, Math.max(0, (top - from) / (to - from))) : 0;
}

/**
 * Drive a timeline from scroll, for pages that tell a 3D story as the reader scrolls: the timeline stops running by the
 * clock and its position follows the scroll, both ways. Values are written at once, on attach too. `Timeline.call`
 * callbacks do not run, as for any seek; use `onUpdate`.
 *
 * ```ts
 * using link = scrollTimeline(timeline, {element: section, range: 'contain', scrub: 0.2});
 * ```
 * @throws TypeError with no `source` where there is no page, or a `scrub` that is not finite and >= 0.
 */
export function scrollTimeline(timeline: Timeline, options: ScrollTimelineOptions = {}): ScrollLink {
  const { element, range = 'cover', scrub = 0, signal, onUpdate } = options,
    source = options.source ?? (globalThis as { window?: ScrollSource }).window;
  if (!source) throw new TypeError('scrollTimeline needs a page; pass source where there is no window');
  if (!Number.isFinite(scrub) || scrub < 0) throw new TypeError('scrub must be finite seconds >= 0');
  if (range !== 'cover' && range !== 'contain') throw new TypeError("range must be 'cover' or 'contain'");
  // The clock of the animation frames: the page's own, which a scrolling element shares.
  const view = (isWindow(source) ? source : (source as Element).ownerDocument?.defaultView) as Window | null | undefined,
    frames = view ?? (globalThis as unknown as Window);
  let target = 0,
    progress = 0,
    last = 0,
    frame = 0,
    done = false;
  const write = (next: number) => {
    progress = next;
    timeline.seek(progress * timeline.duration);
    onUpdate?.(progress);
  };
  const step = (now: number) => {
    frame = 0;
    // The first frame after a rest has no step behind it, so it uses none; the next ones use the real time.
    const delta = last ? (now - last) / 1000 : 0,
      next = target + (progress - target) * Math.exp(-delta / scrub);
    last = now;
    // Within a ten-thousandth of the scroll it is there, and the frames stop until the scroll moves again.
    if (Math.abs(next - target) < 1e-4) {
      last = 0;
      write(target);
    } else {
      write(next);
      frame = frames.requestAnimationFrame(step);
    }
  };
  const refresh = () => {
    if (done) return;
    const next = measure(source, element, range);
    if (next === target && next === progress) return;
    target = next;
    if (!scrub) write(target);
    else if (!frame) frame = frames.requestAnimationFrame(step);
  };
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : undefined;
  const dispose = () => {
    if (done) return;
    done = true;
    source.removeEventListener('scroll', refresh);
    view?.removeEventListener('resize', refresh);
    resized?.disconnect();
    signal?.removeEventListener('abort', dispose);
    if (frame) frames.cancelAnimationFrame(frame);
    frame = 0;
  };
  timeline.pause();
  target = progress = measure(source, element, range);
  timeline.seek(progress * timeline.duration);
  onUpdate?.(progress);
  source.addEventListener('scroll', refresh, { passive: true });
  view?.addEventListener('resize', refresh);
  const content = isWindow(source) ? source.document.documentElement : (source as unknown as Element);
  resized?.observe(content);
  if (element) resized?.observe(element);
  if (signal?.aborted) dispose();
  else signal?.addEventListener('abort', dispose, { once: true });
  return {
    get target() {
      return target;
    },
    get progress() {
      return progress;
    },
    refresh,
    dispose,
    [Symbol.dispose]: dispose,
  };
}
