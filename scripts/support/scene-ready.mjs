// Waiting for a page to have drawn, by looking at what it drew, instead of sleeping a fixed time (bug 62). On the
// Intel Arc laptop of the pre-launch audit a fixed 1.2 s was not long enough for the reference pages' pipelines to
// compile and the captures were completely blank. A wait here ends when the picture itself shows the scene (and, for a
// frozen scene, when two pictures in a row are the same), and past the limit it fails naming what was not ready.
//
// A page that never draws leaves evidence before the wait throws (the Intel Arc startup hang of 2026-10-30: the 4th
// live WebGPU page in one browser never finished starting, with no error anywhere): a screenshot, the page's
// visibility, the size of every canvas (300x150 is the HTML default, so the engine never sized it) and how many
// animation frames run per second (frames running but nothing drawn means the page is alive and the engine stuck).
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';

/** `promise`, or `fallback` once `ms` pass first: an evidence step on a stuck page must not hang the dump. */
const within = (promise, ms, fallback) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch((error) => `failed: ${error?.message ?? error}`),
    new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms))),
  ]).finally(() => clearTimeout(timer));
};

/** Runs in the page: visibility, canvas sizes and animation frames counted over one second (bounded at 1.5 s). */
const probePage = () =>
  new Promise((resolve) => {
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({
      width: c.width,
      height: c.height,
      clientWidth: c.clientWidth,
      clientHeight: c.clientHeight,
    }));
    let ticks = 0;
    const begun = performance.now(),
      done = () =>
        resolve({
          visibilityState: document.visibilityState,
          canvases,
          rafTicksPerSecond: Math.round((ticks * 1000) / Math.max(1, performance.now() - begun)),
          status: document.querySelector('#status')?.textContent ?? null,
          webgpu: 'gpu' in navigator,
        });
    const timer = setTimeout(done, 1500);
    const tick = () => {
      ticks++;
      if (performance.now() - begun < 1000) requestAnimationFrame(tick);
      else {
        clearTimeout(timer);
        done();
      }
    };
    requestAnimationFrame(tick);
  });

/**
 * Writes what a page that was not ready looked like to `dir`: `<name>.png` (a screenshot) and `<name>.json`
 * (visibilityState, canvas sizes, rAF ticks per second, the status line, the page's logged problems, the reason).
 * Every step has its own limit (`stepMs`), so a stuck page still gets a dump. Returns the JSON file's path.
 */
export async function dumpEvidence(page, { dir, name, shoot, reason, stepMs = 5000 }) {
  mkdirSync(dir, { recursive: true });
  const png = join(dir, `${name}.png`),
    file = join(dir, `${name}.json`);
  const picture = await within(
    (async () => {
      const shot = await shoot(page);
      writeFileSync(png, shot);
      return png;
    })(),
    stepMs,
    `no screenshot within ${stepMs} ms`,
  );
  const probe = await within(page.evaluate(probePage), stepMs, `the page did not answer within ${stepMs} ms`);
  writeFileSync(
    file,
    `${JSON.stringify({ reason, url: page.url?.() ?? null, screenshot: picture, ...(typeof probe === 'object' ? probe : { probe }), problems: page.problems ?? [] }, null, 2)}\n`,
  );
  return file;
}

/**
 * Takes pictures of `page` until one is ready, and returns its pixels.
 * `shoot(page)` returns a screenshot, `pixels(png)` decodes it, `ready(pixels)` says whether the scene is drawn (a
 * string names what is missing; true or null means ready). With `stable`, the picture must also equal the one before
 * (`same(a, b)`), which a frozen scene reaches once its last pipeline is in.
 * Throws an Error that names `label`, what was not ready, the seconds waited and the page's own problems. With
 * `evidenceDir`, it first writes the page's evidence there (see `dumpEvidence`) and names the file in the error.
 */
export async function waitForPicture(
  page,
  {
    label,
    shoot,
    pixels,
    ready,
    stable = false,
    same = (a, b) => a.lum.length === b.lum.length && a.lum.every((v, i) => v === b.lum[i]),
    timeoutMs = 120_000,
    intervalMs = 100,
    now = Date.now,
    evidenceDir,
    evidenceStepMs,
  },
) {
  const begun = now();
  let previous = null,
    missing = 'no picture taken yet';
  for (;;) {
    const current = await pixels(await shoot(page)),
      verdict = ready(current);
    if (verdict === true || verdict == null) {
      if (!stable) return current;
      if (previous && same(previous, current)) return current;
      missing = 'the picture was still changing between two shots';
    } else missing = String(verdict);
    previous = current;
    if (now() - begun >= timeoutMs) {
      const problems = page.problems?.length ? `; the page logged: ${page.problems.join(' | ')}` : '';
      const reason = `${label} was not ready after ${Math.round((now() - begun) / 1000)} s: ${missing}${problems}`;
      const evidence = evidenceDir
        ? `; evidence in ${await dumpEvidence(page, {
            dir: evidenceDir,
            name: `failed-${label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`,
            shoot,
            reason,
            stepMs: evidenceStepMs,
          })}`
        : '';
      throw new Error(`${reason}${evidence}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Opens, settles and closes pages ONE AT A TIME, in order: `open(item)` gives a page, `settle(page, item)` its result,
 * then the page is closed (`close(page)`) before the next opens, also when settling throws. The quickstart's
 * reference pages go through here: on an Intel Arc 140V the 3rd and 4th WebGPU pages alive at once in one browser
 * process got slower and slower to get a device or compile a pipeline, and the 4th never did, so a check that opened
 * them together measured the driver's limit instead of the page. Returns the results in order.
 */
export async function settleOneAtATime(items, { open, settle, close }) {
  const results = [];
  for (const item of items) {
    const page = await open(item);
    try {
      results.push(await settle(page, item));
    } finally {
      await close(page);
    }
  }
  return results;
}

/**
 * The hardware a timing was measured on, for the report that prints the time: the processor, the memory, and the WebGPU
 * adapter the page was given (read in the page, so it is the one the browser really used).
 */
export async function describeHardware(page) {
  const adapter = await page.evaluate(async () => {
    const found = await navigator.gpu?.requestAdapter();
    const info = found?.info;
    return info
      ? {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
          fallback: info.isFallbackAdapter ?? found.isFallbackAdapter ?? null,
        }
      : null;
  });
  const processors = cpus();
  return {
    cpu: processors[0]?.model?.trim() ?? 'unknown',
    logicalCores: processors.length,
    memoryGB: Number((totalmem() / 2 ** 30).toFixed(1)),
    platform: process.platform,
    adapter,
  };
}

/** One line for the log and the report: `Intel Core ..., 16 cores, 31.7 GB, adapter intel arc (fallback false)`. */
export function hardwareLine(hardware) {
  const a = hardware.adapter,
    adapter = a
      ? [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(' ') +
        ` (software fallback: ${a.fallback})`
      : 'no WebGPU adapter';
  return `${hardware.cpu}, ${hardware.logicalCores} logical cores, ${hardware.memoryGB} GB memory, ${hardware.platform}; WebGPU adapter ${adapter}`;
}
