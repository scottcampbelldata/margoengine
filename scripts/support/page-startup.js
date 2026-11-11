// A page whose start throws (engine.create rejecting with "WebGPU adapter unavailable", say) never sets `window.ready`,
// and a suite waiting for it used to wait out its whole timeout (120 s in shadows scale-browser.mjs) with the cause only
// in its own page-error list, printed after the timeout (KB-C34i, 2026-11-11). Here a wait on `window.ready` fails at
// once on an uncaught page error raised while the page was not ready, naming the error; a page that is already ready
// keeps its errors to itself (a suite may provoke and check them), and so does every other wait.

/** Error code of a wait on `window.ready` ended by an uncaught page error raised before the page was ready. */
export const PAGE_STARTUP_ERROR = 'page-startup-error';

/** True for a `waitForFunction` predicate that waits on `window.ready` (a function or its source text). */
export const waitsForReady = (predicate) => /\bwindow\.ready\b/.test(String(predicate));

/**
 * Makes every `page.waitForFunction` on `window.ready` reject with code PAGE_STARTUP_ERROR as soon as the current
 * document has thrown an uncaught error (Playwright's 'pageerror') or the page has crashed while `window.ready` was not
 * set, including an error raised before the wait began. A main-frame navigation starts a new document and clears it.
 * Returns `{ errors }`, the startup errors seen.
 */
export function watchStartupErrors(page) {
  const errors = [],
    waiting = new Set();
  let startup = null;
  const fail = (cause, what) => {
    if (startup) return;
    startup = Object.assign(
      new Error(`the page ${what} before it set window.ready: ${cause?.message ?? cause}`, { cause }),
      { code: PAGE_STARTUP_ERROR },
    );
    errors.push(startup);
    for (const reject of waiting) reject(startup);
  };
  page.on('framenavigated', (frame) => {
    if (typeof page.mainFrame === 'function' && frame === page.mainFrame()) startup = null;
  });
  page.on('pageerror', async (error) => {
    let ready = false;
    try {
      ready = await page.evaluate(() => Boolean(globalThis.ready));
    } catch {
      // A page that cannot answer (closed, navigating, crashed) is not ready.
    }
    if (!ready) fail(error, 'threw');
  });
  page.on('crash', () => fail(new Error('renderer process crashed'), 'crashed'));
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (predicate, ...rest) => {
    if (!waitsForReady(predicate)) return waitForFunction(predicate, ...rest);
    if (startup) return Promise.reject(startup);
    return new Promise((resolve, reject) => {
      waiting.add(reject);
      // The losing wait still settles later (its own timeout): it is handled here, so it never goes unhandled.
      waitForFunction(predicate, ...rest)
        .then(resolve, reject)
        .finally(() => waiting.delete(reject));
    });
  };
  return { errors };
}
