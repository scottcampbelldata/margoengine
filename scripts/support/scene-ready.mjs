// Waiting for a page to have drawn, by looking at what it drew, instead of sleeping a fixed time (bug 62). On the
// Intel Arc laptop of the pre-launch audit a fixed 1.2 s was not long enough for the reference pages' pipelines to
// compile and the captures were completely blank. A wait here ends when the picture itself shows the scene (and, for a
// frozen scene, when two pictures in a row are the same), and past the limit it fails naming what was not ready.
import { cpus, totalmem } from 'node:os';

/**
 * Takes pictures of `page` until one is ready, and returns its pixels.
 * `shoot(page)` returns a screenshot, `pixels(png)` decodes it, `ready(pixels)` says whether the scene is drawn (a
 * string names what is missing; true or null means ready). With `stable`, the picture must also equal the one before
 * (`same(a, b)`), which a frozen scene reaches once its last pipeline is in.
 * Throws an Error that names `label`, what was not ready, the seconds waited and the page's own problems.
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
      throw new Error(`${label} was not ready after ${Math.round((now() - begun) / 1000)} s: ${missing}${problems}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
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
