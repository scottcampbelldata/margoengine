// The demos of the visual check's WebGL2 compatibility run and how one is opened, shared by its two steps:
// scripts/visual-compat.mjs (pixels, a shared GPU slot) and scripts/visual-compat-budget.mjs (frame cost, the GPU held
// exclusively in chunks). Site demos run the layer the way a visitor without WebGPU gets it: `navigator.gpu` is removed
// before the page loads, so the page's own gate (examples/needs-webgpu.js) downloads @margoengine/webgl2-compat from the
// site build and installs it. Khronos models (a dev-server page without the gate) get the layer from compat-shim.js.
import { resolve } from 'node:path';
import { createServer, preview } from 'vite';
import { compatShim } from './compat-shim.js';
import { demos } from './visual-demos.js';

const root = resolve(import.meta.dirname, '../..');

const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const views = {
  high: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, query: '?quality=high' },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: iphone,
    query: '',
  },
  model: { viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, query: '' },
};
export const withQuery = (path, query) => (query && path.includes('?') ? `${path}&${query.slice(1)}` : path + query);
// Site demos the visual check leaves out (no baselines: their native picture is not pinned), compared here all the
// same, so every demo on the site runs on the layer. The dual viewport page runs both paths itself.
// mask: live readouts painted over (sciviz points' status line states the plot time).
export const extraDemos = [
  ...[
    'compute-lab',
    'sciviz-volume',
    'sciviz-points',
    'sciviz-surface',
    'sciviz-head',
    'sciviz-stars',
    'sciviz-wind',
    'ui-game',
  ].map((id) => ({
    id,
    path: `demos/${id}.html`,
    ready: "document.querySelector('canvas')?.dataset.ready==='true'",
    ...(id === 'sciviz-points' ? { mask: ['#status'] } : {}),
  })),
  { id: 'animator', path: 'demos/animator/', ready: '!!window.animatorDemo' },
];
// One view per demo: the desktop one (the gallery's model view). The robot page is character-animation's old URL.
export const allCases = [...demos, ...extraDemos]
  .filter((demo) => demo.id !== 'robot-expressive')
  .map((demo) => {
    const view = demo.dev ? 'model' : (demo.views ?? ['high']).includes('high') ? 'high' : demo.views[0];
    return { id: demo.id, demo, view: views[view], viewName: view };
  });
// Demos that stop their frame loop under reduced motion and draw on demand: their still frame has no frames to time, so
// the timed run opens them with motion on and times the running demo, the most they ask of a frame.
const PAUSED_DEMOS = new Set(['gameplay-sandbox', 'windy-meadow']);
/** The cases `--only=<a>,<b>` picks (an id containing one of them), or every case. */
export const selectCases = (only) => allCases.filter((c) => !only.length || only.some((o) => c.id.includes(o)));

/** Page init script: the page has no WebGPU, so its gate loads the layer (a visitor without WebGPU). */
function noWebGPU() {
  delete Navigator.prototype.gpu;
  if (globalThis.WorkerNavigator) delete WorkerNavigator.prototype.gpu;
}
/** Page init script: times each animation frame's callbacks (main-thread work) and the frames' timestamps. */
function frameTimer() {
  const frames = (globalThis.__margoFrames = []),
    raf = requestAnimationFrame.bind(globalThis);
  let current;
  globalThis.requestAnimationFrame = (callback) =>
    raf((time) => {
      if (current?.time !== time) frames.push((current = { time, work: 0 }));
      const start = performance.now();
      try {
        callback(time);
      } finally {
        current.work += performance.now() - start;
      }
    });
}
export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : NaN;
};
/** Median main-thread work and interval over the next 60 frames of a page opened with `timed`, in ms. */
export async function frameCost(page) {
  const cost = await page.evaluate(
    () =>
      new Promise((done) => {
        const frames = globalThis.__margoFrames,
          from = frames.length;
        const started = performance.now();
        const wait = () => {
          // A page that draws no frame gives no median: give up after 3 s without one, and the budget step fails it.
          const waited = performance.now() - started;
          if (frames.length - from >= 61 || waited > 20_000 || (waited > 3000 && frames.length === from)) {
            const list = frames.slice(from, from + 61),
              work = list.slice(0, -1).map((f) => f.work),
              interval = list.slice(1).map((f, i) => f.time - list[i].time);
            done({ frames: work.length, work, interval });
          } else setTimeout(wait, 100); // fixed-wait: polls the frame list, which only grows when the page draws
        };
        wait();
      }),
  );
  return { frames: cost.frames, work: median(cost.work), interval: median(cost.interval) };
}

/** Starts the site preview (site/dist) and the dev server the cases need: `{ origin, devOrigin, servers }`. */
export async function startServers(cases) {
  const server = cases.some((c) => !c.demo.dev)
    ? await preview({
        configFile: false,
        root,
        build: { outDir: 'site/dist' },
        preview: { port: 0, strictPort: true },
        logLevel: 'error',
      })
    : undefined;
  const devServer = cases.some((c) => c.demo.dev)
    ? await (
        await createServer({
          configFile: false,
          root,
          logLevel: 'error',
          optimizeDeps: { noDiscovery: true, include: [] },
          server: { port: 0, hmr: false, watch: null },
        })
      ).listen()
    : undefined;
  return {
    origin: server && new URL(server.resolvedUrls.local[0]).origin,
    devOrigin: devServer && new URL(devServer.resolvedUrls.local[0]).origin,
    servers: [server, devServer],
  };
}

/**
 * Opens one case natively or on the layer (`compat`) and waits for its still frame: `{ context, page, errors, started,
 * refused?, off? }`. `refused` is the text of the layer's refusal box, `off` a page kept off the layer. Throws when the
 * page does not get ready; the caller closes `context` either way (it is on the error as `error.context`).
 */
export async function openCase(browser, { demo, view }, { compat, origin, devOrigin, timed = false }) {
  const { query, ...options } = view,
    url = (demo.dev ? devOrigin : origin) + '/' + withQuery(demo.path, query);
  const context = await browser.newContext({
      ...options,
      reducedMotion: timed && PAUSED_DEMOS.has(demo.id) ? 'no-preference' : 'reduce',
    }),
    page = await context.newPage(),
    errors = [],
    started = Date.now();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const opened = { context, page, errors, started };
  try {
    if (timed) await page.addInitScript(frameTimer);
    if (compat) await page.addInitScript(demo.dev ? compatShim : noWebGPU);
    await page.goto(url, { timeout: 90_000 });
    // On the layer, a refusal box is an answer too, and so is the needs-WebGPU message of a page kept off the layer.
    const ready = compat
      ? `(${demo.ready})||!!document.querySelector('[data-webgpu-refused],[data-no-webgpu]')`
      : demo.ready;
    await page.waitForFunction(ready, null, { timeout: compat ? 240_000 : 120_000 });
    const refusedText = await page
      .locator('[data-webgpu-refused]')
      .innerText({ timeout: 1 })
      .catch(() => null);
    if (refusedText) return { ...opened, refused: refusedText.replace(/\s+/g, ' ').trim() };
    if (compat && (await page.locator('[data-no-webgpu]').count())) return { ...opened, off: true };
    if (compat && !demo.dev) {
      const marked = await page.evaluate(() => 'webgpuCompat' in document.documentElement.dataset);
      if (!marked) throw new Error('the page did not install the WebGL2 compatibility layer');
    }
    // The page's own 'WebGL2 compatibility mode' note is not part of the scene.
    await page.addStyleTag({ content: '[data-webgpu-compat-note]{display:none!important}' });
    // fixed-wait: late UI text settles (the sandbox clock label ticks every 500 ms), as in visual-regression.js
    await page.waitForTimeout(1000);
    return opened;
  } catch (error) {
    errors.push(`capture: ${String(error.message ?? error).split('\n')[0]}`);
    throw Object.assign(error, { context, page, errors, started });
  }
}
