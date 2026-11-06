// Real-browser proof (run from the repository root after building packages): node packages/tween/test/scroll-browser.mjs
// A real page really scrolls, by script and by the mouse wheel, and a Timeline on @margoengine/tween/scroll follows it:
// the whole page, a section through 'cover' and 'contain', a scrolling element, scrub on real animation frames, a page
// that grows, and an abort that ends it. test/scroll.test.js covers the arithmetic on a stand-in page; this is the DOM.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const app = await openBrowser({ startPath: '/packages/tween/test/scroll-browser.html', port: 'free' }),
  { page } = app,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const near = (actual, expected, eps, label) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label}: ${actual} vs ${expected}`);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const scrollTo = (y) =>
    page.evaluate(
      (top) =>
        new Promise((done) => {
          window.scrollTo({ top, behavior: 'instant' });
          // The scroll event is delivered with the next frame.
          requestAnimationFrame(() => requestAnimationFrame(done));
        }),
      y,
    );
  const state = () => page.evaluate(() => window.state());

  const { most, sectionTop, sectionHeight, view } = await state();
  assert.ok(most > 3000, 'the page must really scroll');
  await scrollTo(most / 2);
  let s = await state();
  // Scroll positions are whole or fractional device pixels: half a pixel of `most`, in a 0..10 range.
  const pixel = (0.5 / most) * 10 + 1e-9;
  near(s.page, 5, pixel, 'half way down the page');

  // 'cover': top at the bottom of the view is 0, bottom at the top of the view is 10.
  await scrollTo(sectionTop - view);
  near((await state()).cover, 0, 0.01, 'cover start');
  await scrollTo(sectionTop + sectionHeight);
  near((await state()).cover, 10, 0.01, 'cover end');
  // 'contain': top at the top of the view is 0, bottom at the bottom is 10.
  await scrollTo(sectionTop);
  near((await state()).contain, 0, 0.01, 'contain start');
  await scrollTo(sectionTop + (sectionHeight - view) / 2);
  near((await state()).contain, 5, 0.01, 'contain middle');
  await scrollTo(sectionTop + sectionHeight - view);
  near((await state()).contain, 10, 0.01, 'contain end');

  // A real wheel turn, not a script.
  await scrollTo(0);
  await page.mouse.move(200, 200);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 5000 });
  // The wheel scrolls smoothly and has no event for its end: it has ended when ten frames in a row show one position.
  await page.evaluate(
    () =>
      new Promise((done) => {
        let last = -1,
          same = 0;
        const look = () => {
          same = window.scrollY === last ? same + 1 : 0;
          last = window.scrollY;
          if (same >= 10) done();
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
  );
  s = await state();
  near(s.page, (s.scrollY / most) * 10, pixel, 'after the wheel');
  assert.ok(s.page > 0);

  // A scrolling element inside the page.
  await page.evaluate(() => {
    window.box.scrollTop = window.box.scrollHeight - window.box.clientHeight;
  });
  await page.waitForFunction(() => window.state().inner === 10, null, { timeout: 5000 });

  // Scrub: behind at first, there in the end, on real frames.
  await scrollTo(0);
  await page.waitForFunction(() => window.state().soft === 0, null, { timeout: 5000 });
  const trail = await page.evaluate(
    (top) =>
      new Promise((done) => {
        const seen = [];
        window.scrollTo({ top, behavior: 'instant' });
        const look = () => {
          seen.push(window.state().soft);
          if (seen.at(-1) >= 10 || seen.length > 600) done(seen);
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
    most,
  );
  assert.ok(trail.some((v) => v > 0.1 && v < 9.9), `scrub went through the middle: ${trail.slice(0, 8)}`);
  assert.ok(trail.every((v, i) => !i || v >= trail[i - 1]), 'scrub only moves toward the scroll');
  assert.equal(trail.at(-1), 10);

  // The page grows with no scroll event: a ResizeObserver reads it. The position stays, so the progress falls.
  const before = await state();
  await page.evaluate(() => {
    document.querySelector('#spacer').style.height = '8000px';
  });
  await page.waitForFunction((was) => window.state().page < was, before.page, { timeout: 5000 });
  s = await state();
  near(s.page, (s.scrollY / s.most) * 10, (0.5 / s.most) * 10 + 1e-9, 'after the page grew');

  // Abort: nothing follows any more, and no listener is left to throw.
  await page.evaluate(() => window.controller.abort());
  const stopped = (await state()).page;
  await scrollTo(0);
  assert.equal((await state()).page, stopped);
  assert.deepEqual(errors, []);
  console.log('scroll: page, cover, contain, wheel, element, scrub, growth and abort pass on a real page');
} finally {
  await app.close();
}
