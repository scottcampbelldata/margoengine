// The packed-browser step of `modern:test:packages` waited a fixed 30 s for `window.modern` and missed it when the
// machine was busy (docs/known-bugs.md, fixed 2026-10-31). It now waits on the dev server (scripts/support/page-ready.js)
// with a hard outer limit. The first test holds the page's last module back in a real dev server and a real browser, for
// as long as the test says, so the order is the same however busy the machine is: the fixed wait fails, the new wait passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../scripts/browser.js';
import { waitForPageReady } from '../scripts/support/page-ready.js';

const FIXED_WAIT_MS = 1000;
const held = ({ asked, release }) => ({
  name: 'hold-the-last-module-back',
  configureServer(server) {
    server.middlewares.use('/held.html', (_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<!doctype html><title>held</title><script>addEventListener('load', () => import('/@id/__x00__held-last'))</script>`,
      );
    });
  },
  resolveId: (id) => (id === 'held-last' ? '\0held-last' : undefined),
  async load(id) {
    if (id !== '\0held-last') return undefined;
    asked.resolve();
    await release.promise;
    return 'window.modern = { ready: true };';
  },
});

test('a page whose last module the dev server serves late: the fixed wait fails, waiting on the server passes', {
  timeout: 5 * 60_000,
}, async () => {
  const asked = Promise.withResolvers(),
    release = Promise.withResolvers();
  // The page is plain HTML: no GPU is needed, so a runner's software adapter is fine here.
  const browser = await openBrowser({
    startPath: '/held.html',
    plugins: [held({ asked, release })],
    port: 'free',
    softwareAdapterOk: true,
  });
  try {
    const { page } = browser;
    await asked.promise;
    // The old code: a fixed limit against load.
    await assert.rejects(
      page.waitForFunction(() => window.modern, undefined, { timeout: FIXED_WAIT_MS }),
      /Timeout/,
      'a fixed wait shorter than the load fails',
    );
    let served = false,
      polls = 0;
    const waited = await waitForPageReady({
      what: 'held page',
      ready: async () => {
        const ready = await page.evaluate(() => Boolean(window.modern)).catch(() => false);
        // The module is let go only after the wait has seen a page not ready, with the server still on it.
        if (!ready && ++polls === 3) {
          served = true;
          release.resolve();
        }
        return ready;
      },
      idle: () => browser.server.waitForRequestsIdle(),
    });
    assert.ok(served, 'the wait held on while the server had the module');
    assert.ok(
      waited >= 0 && (await page.evaluate(() => window.modern.ready)),
      'the server finished and the page is ready',
    );
  } finally {
    release.resolve();
    await browser.close();
  }
});

test('a real hang fails at the hard limit and says what it waited for', async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    waitForPageReady({
      what: 'hung page',
      ready: async () => false,
      idle: () => never,
      hardMs: 400,
      describe: () => 'url x',
    }),
    /hung page: not ready within the hard limit of 0.4 s \(dev server still serving requests\).*after 0 s; url x/s,
  );
});

test('a server that went idle with the page not ready fails after the grace, not at the hard limit', async () => {
  const begun = Date.now();
  await assert.rejects(
    waitForPageReady({
      what: 'idle page',
      ready: async () => false,
      idle: async () => {},
      graceMs: 300,
      hardMs: 60_000,
    }),
    /idle page: the dev server went idle but the page was still not ready/,
  );
  assert.ok(Date.now() - begun < 5000); // wall-clock: the wait gives up at the 300 ms grace, not the 60 s hard limit
});

test('ready as soon as the page says so, however long the server stays busy', async () => {
  let ready = false;
  setTimeout(() => (ready = true), 300);
  await waitForPageReady({ what: 'busy', ready: async () => ready, idle: () => new Promise(() => {}), hardMs: 60_000 });
});
