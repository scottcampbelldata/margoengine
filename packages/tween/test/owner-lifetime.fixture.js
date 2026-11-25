import { lifetimeFault, ownedByEngine } from '../../../tests/support/owner-shell.js';

// What the scroll links hang on: in a browser, a real scrolling element and the page's window; in Node, stand-ins with
// the same shape (an EventTarget that scrolls, a window that runs animation frames).
function scroller() {
  if (globalThis.document?.body) {
    const element = document.createElement('div');
    element.style.cssText = 'position:fixed;left:0;top:0;width:40px;height:40px;overflow:auto';
    element.innerHTML = '<div style="height:400px"></div>';
    document.body.append(element);
    return { source: element, done: () => element.remove() };
  }
  const frames = new Set();
  const view = Object.assign(new EventTarget(), {
    requestAnimationFrame: (fn) => {
      frames.add(fn);
      return frames.size;
    },
    cancelAnimationFrame: () => frames.clear(),
  });
  const source = Object.assign(new EventTarget(), {
    scrollTop: 0,
    scrollHeight: 400,
    clientHeight: 40,
    ownerDocument: { defaultView: view },
    getBoundingClientRect: () => ({ top: 0 }),
  });
  return { source, view, frames, done() {} };
}

export async function fixtures(load = (entry) => import(entry)) {
  const { Timeline } = await load('../dist/index.js');
  const { scrollTimeline } = await load('../dist/scroll.js');
  const { pinTimeline } = await load('../dist/scroll-pin.js');
  const { Timeline: FullTimeline } = await load('../dist/full-timeline.js');
  const { AsyncTween, AsyncTimeline } = await load('../dist/async.js');
  const { TweenControl } = await load('../dist/control.js');
  const { inertia } = await load('../dist/inertia.js');
  const entries = [];
  const timeline = () => new Timeline().to({ x: 0 }, 'x', 1, { duration: 1 });
  // The app's AbortSignal outlives every one of these: its abort listener goes with the object.
  const withSignal = (name, make) =>
    entries.push({
      name,
      create({ scene }) {
        const controller = new AbortController(),
          made = make(controller.signal);
        return ownedByEngine(scene, name, made.release, { cleanup: made.cleanup });
      },
    });
  const scrolling = (name, options) =>
    entries.push({
      name,
      create({ scene }) {
        const { source, view, frames, done } = scroller(),
          controller = new AbortController();
        const link = scrollTimeline(timeline(), { source, signal: controller.signal, ...options });
        source.scrollTop = 120;
        source.dispatchEvent(new Event('scroll'));
        return ownedByEngine(scene, name, () => link.dispose(), {
          cleanup() {
            done();
            if (frames?.size) lifetimeFault('a disposed scroll link leaves an animation frame queued');
          },
        });
      },
    });
  scrolling('scrollTimeline', {});
  scrolling('scrollTimeline.scrub', { scrub: 0.2 });
  if (globalThis.document?.body)
    entries.push({
      name: 'pinTimeline',
      create({ scene }) {
        const holder = document.createElement('div'),
          pin = document.createElement('div'),
          controller = new AbortController();
        holder.style.cssText = 'height:2000px';
        pin.style.cssText = 'height:20px';
        holder.append(pin);
        document.body.append(holder);
        const link = pinTimeline(new FullTimeline().to({ x: 0 }, 'x', 1, { duration: 1 }), {
          pin,
          signal: controller.signal,
          scrub: 0.2,
        });
        return ownedByEngine(scene, 'pinTimeline', () => link.dispose(), { cleanup: () => holder.remove() });
      },
    });
  withSignal('Timeline', (signal) => {
    const line = new FullTimeline({ signal }).to({ x: 0 }, 'x', 1, { duration: 1 });
    line.finished?.catch?.(() => {});
    return { release: () => line.dispose() };
  });
  withSignal('AsyncTween.to', (signal) => {
    const tween = new AsyncTween(),
      task = tween.to({ x: 0 }, 'x', 1, { duration: 1, signal });
    task.finished.catch(() => {});
    return { release: () => task.cancel() };
  });
  withSignal('AsyncTimeline', (signal) => {
    const line = new AsyncTimeline({ signal });
    line.finished.catch(() => {});
    return { release: () => line.cancel() };
  });
  withSignal('TweenControl.to', (signal) => {
    const world = new TweenControl(),
      tween = world.to({ x: 0 }, { x: 1 }, { duration: 1, signal });
    tween.finished.catch(() => {});
    return { release: () => world.dispose() };
  });
  withSignal('inertia', (signal) => {
    const motion = inertia({ x: 0 }, 'x', { velocity: 50, signal });
    motion.finished.catch(() => {});
    return { release: () => motion.cancel() };
  });
  return entries;
}
