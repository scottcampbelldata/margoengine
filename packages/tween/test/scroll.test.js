import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../dist/index.js';
import { scrollTimeline } from '../dist/scroll.js';

/** A page: what scrollTimeline reads of a window, with a clock for its animation frames. */
function fakePage({ height = 3000, view = 1000 } = {}) {
  const listeners = new Map(),
    frames = new Map();
  let nextFrame = 1;
  const page = {
    scrollY: 0,
    innerHeight: view,
    document: { documentElement: { scrollHeight: height } },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    requestAnimationFrame(fn) {
      frames.set(nextFrame, fn);
      return nextFrame++;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    listeners,
    frames,
    scrollTo(y) {
      page.scrollY = y;
      listeners.get('scroll')?.();
    },
    tick(now) {
      const due = [...frames.values()];
      frames.clear();
      for (const fn of due) fn(now);
    },
  };
  return page;
}
const scene = () => {
  const box = { x: 0 };
  return { box, timeline: new Timeline().to(box, 'x', 10, { duration: 2 }) };
};
/** An element in a page at `top`, as getBoundingClientRect reports it after the scroll. */
const placed = (page, top, height) => ({
  getBoundingClientRect: () => ({ top: top - page.scrollY, height }),
});

test('the scroll position is the timeline position, both ways', () => {
  const page = fakePage(),
    { box, timeline } = scene();
  scrollTimeline(timeline, { source: page });
  assert.equal(box.x, 0);
  page.scrollTo(1000); // half of the 2,000 px the page scrolls
  assert.equal(timeline.time, 1);
  assert.equal(box.x, 5);
  page.scrollTo(2000);
  assert.equal(box.x, 10);
  page.scrollTo(500);
  assert.equal(box.x, 2.5);
});

test('it starts from where the page already is, and the clock no longer drives the timeline', () => {
  const page = fakePage(),
    { box, timeline } = scene();
  page.scrollY = 1000;
  timeline.play();
  const link = scrollTimeline(timeline, { source: page });
  assert.equal(box.x, 5);
  assert.equal(link.progress, 0.5);
  assert.equal(timeline.playing, false);
  timeline.update(1);
  assert.equal(box.x, 5);
});

test('a scrolling element reads its own range', () => {
  const listeners = new Map(),
    source = {
      scrollTop: 0,
      scrollHeight: 1400,
      clientHeight: 400,
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
      getBoundingClientRect: () => ({ top: 50 }),
    },
    { box, timeline } = scene();
  scrollTimeline(timeline, { source });
  source.scrollTop = 250;
  listeners.get('scroll')();
  assert.equal(box.x, 2.5);
});

test('cover runs from entering the view to leaving it', () => {
  const page = fakePage({ height: 5000, view: 1000 }),
    { box, timeline } = scene();
  scrollTimeline(timeline, { source: page, element: placed(page, 2000, 500) });
  page.scrollTo(1000); // its top is at the bottom of the view
  assert.equal(box.x, 0);
  page.scrollTo(1750); // half of the 1,500 px it takes to cross
  assert.equal(box.x, 5);
  page.scrollTo(2500); // its bottom is at the top of the view
  assert.equal(box.x, 10);
  page.scrollTo(4000);
  assert.equal(box.x, 10);
});

test('contain runs while a tall section fills the view', () => {
  const page = fakePage({ height: 8000, view: 1000 }),
    { box, timeline } = scene();
  scrollTimeline(timeline, { source: page, element: placed(page, 2000, 3000), range: 'contain' });
  page.scrollTo(1999);
  assert.equal(box.x, 0);
  page.scrollTo(3000); // half of the 2,000 px between top at top and bottom at bottom
  assert.equal(box.x, 5);
  page.scrollTo(4000);
  assert.equal(box.x, 10);
});

test('an element inside a scrolling element counts from that element', () => {
  const listeners = new Map(),
    source = {
      scrollTop: 0,
      scrollHeight: 3000,
      clientHeight: 1000,
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ top: 300 }),
    },
    element = { getBoundingClientRect: () => ({ top: 300 + 2000 - source.scrollTop, height: 500 }) },
    { box, timeline } = scene();
  scrollTimeline(timeline, { source, element, range: 'cover' });
  source.scrollTop = 1750;
  listeners.get('scroll')();
  assert.equal(box.x, 5);
});

test('a page that cannot scroll stays at 0, with no division by zero', () => {
  const page = fakePage({ height: 1000, view: 1000 }),
    { box, timeline } = scene();
  const link = scrollTimeline(timeline, { source: page });
  assert.equal(link.progress, 0);
  assert.equal(box.x, 0);
  page.scrollTo(0);
  assert.equal(box.x, 0);
});

test('scrub eases toward the scroll by the time passed, whatever the frame rate, then stops asking for frames', () => {
  const run = (frames) => {
    const page = fakePage(),
      { timeline } = scene(),
      link = scrollTimeline(timeline, { source: page, scrub: 0.5 });
    page.scrollTo(2000);
    assert.equal(link.target, 1);
    assert.equal(link.progress, 0, 'no jump before a frame');
    page.tick(1000); // the first frame only starts the clock
    for (let i = 1; i <= frames; i++) page.tick(1000 + (500 * i) / frames);
    return { link, page };
  };
  // After one time constant, 1 - 1/e of the way, at 5 frames or at 500.
  for (const frames of [5, 500]) {
    const { link } = run(frames);
    assert.ok(Math.abs(link.progress - (1 - Math.exp(-1))) <= 1e-12, `${frames}: ${link.progress}`);
  }
  const { link, page } = run(5);
  let now = 2000;
  for (let i = 0; i < 100 && page.frames.size; i++) page.tick((now += 500));
  assert.equal(page.frames.size, 0);
  assert.equal(link.progress, 1);
});

test('onUpdate reports each move, and an unmoved scroll is not one', () => {
  const page = fakePage(),
    { timeline } = scene(),
    seen = [];
  scrollTimeline(timeline, { source: page, onUpdate: (p) => seen.push(p) });
  page.scrollTo(1000);
  page.scrollTo(1000);
  assert.deepEqual(seen, [0, 0.5]);
});

test('dispose and an abort remove every listener and frame, and the timeline stays put', () => {
  const page = fakePage(),
    { box, timeline } = scene(),
    link = scrollTimeline(timeline, { source: page, scrub: 1 });
  page.scrollTo(2000);
  assert.equal(page.frames.size, 1);
  link.dispose();
  link.dispose();
  assert.equal(page.listeners.size, 0);
  assert.equal(page.frames.size, 0);
  link.refresh();
  assert.equal(box.x, 0);

  const second = fakePage(),
    controller = new AbortController();
  scrollTimeline(scene().timeline, { source: second, signal: controller.signal });
  assert.equal(second.listeners.size, 2);
  controller.abort();
  assert.equal(second.listeners.size, 0);

  const third = fakePage();
  scrollTimeline(scene().timeline, { source: third, signal: AbortSignal.abort() });
  assert.equal(third.listeners.size, 0);

  // What `using` calls at the end of a block.
  const fourth = fakePage();
  scrollTimeline(scene().timeline, { source: fourth })[Symbol.dispose]();
  assert.equal(fourth.listeners.size, 0);
});

test('a timeline that grows is read at its new length', () => {
  const page = fakePage(),
    { box, timeline } = scene(),
    other = { y: 0 };
  scrollTimeline(timeline, { source: page });
  timeline.to(other, 'y', 1, { duration: 2 });
  page.scrollTo(1000);
  assert.equal(timeline.time, 2);
  assert.equal(box.x, 10);
});

test('bad input throws, and with no page it says so', () => {
  const { timeline } = scene();
  assert.equal(globalThis.window, undefined);
  assert.throws(() => scrollTimeline(timeline), TypeError);
  assert.throws(() => scrollTimeline(timeline, { source: fakePage(), scrub: -1 }), TypeError);
  assert.throws(() => scrollTimeline(timeline, { source: fakePage(), scrub: NaN }), TypeError);
  assert.throws(() => scrollTimeline(timeline, { source: fakePage(), range: 'exit' }), TypeError);
});
