// KB-L4-W1: Playwright's WebKit kept resolving the WebGPU promises of a document after the tab had navigated away
// from it, and that document's late `window.ready = true` / `window.check = ...` landed on the document the tab then
// showed (every document of a tab shares one WindowProxy). On the Mac 1 fresh-folder sky check in about 10 ran its
// first `check.run` in the old, pageless document, at the default 300 x 150 canvas size. openBrowser now installs
// holdStaleDocumentGpu (scripts/support/stale-document.js) in every page.
//
// The first test runs in any browser. The second is the navigation itself: without the init script it fails under
// MARGO_BROWSER=webkit (Apple M6 Mac, 2026-11-11) and passes in Chromium either way. Both pass in WebKit with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../scripts/browser.js';

// A page whose start-up waits on the GPU `n` times after its load event, then publishes on `window`.
const page = `<!doctype html><script type="module">
const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
window.device = device;
const n = Number(new URLSearchParams(location.search).get('n') ?? 0);
for (let i = 0; i < n; i++) { device.queue.submit([]); await device.queue.onSubmittedWorkDone(); }
window.marks = (window.marks ?? []).concat(location.search);
window.ready = true;
</script>`;

async function withPage(run) {
  const dir = `tests/.stale-document-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'page.html'), page);
  const context = await openBrowser({ startPath: `/${dir}/page.html`, port: 'free', softwareAdapterOk: true });
  try {
    await run(context.page, `${new URL(context.page.url()).origin}/${dir}/page.html`);
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a document the tab has left settles no more GPU promises until it is shown again', { timeout: 120_000 }, () =>
  withPage(async (page) => {
    await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.state = 'waiting';
      window.device.queue.onSubmittedWorkDone().then(() => (window.state = 'ran'));
      // A page shown with persisted false is a fresh load, not this document again: nothing is released.
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    // wall-clock: an empty queue's onSubmittedWorkDone settles within milliseconds; half a second is far past it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await page.evaluate(() => window.state), 'waiting', 'a GPU promise settled in a document the tab left');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.waitForFunction(() => window.state === 'ran', null, { timeout: 10_000 });
  }),
);

test('a document left while starting up writes nothing into the next one', { timeout: 300_000 }, () =>
  withPage(async (page, url) => {
    await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
    for (let i = 0; i < 3; i++) {
      // The first document is still waiting on the GPU when the tab leaves it. The second does twice the work, so by
      // the time it is ready the first would have finished and published, had it been let run.
      await page.goto(`${url}?n=1500&run=a${i}`);
      await page.goto(`${url}?n=3000&run=b${i}`);
      await page.waitForFunction(() => window.ready, null, { timeout: 120_000 });
      assert.deepEqual(await page.evaluate(() => window.marks), [`?n=3000&run=b${i}`]);
    }
  }),
);
