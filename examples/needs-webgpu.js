// The one place margoengine.com demos check for WebGPU (scripts/build-site.js builds every demo that uses it).
// A demo page loads this first and imports its own code only when WebGPU answers, so a browser without WebGPU
// downloads no engine code and shows a plain message in the canvas area instead of failing quietly.
// scripts/test-no-webgpu-browser.mjs loads every demo with WebGPU removed and checks this message appears.

/** Shown in the canvas area when the browser has no WebGPU. */
export const message = 'This demo needs a browser with WebGPU: Chrome, Edge or Safari.';
/** The help line linked under the message: which browser versions to update to. */
export const help = 'https://margoengine.com/webgpu.html';

/**
 * Resolves true when the browser can run WebGPU (an adapter answers). Otherwise shows {@link message} over `area`
 * (an element or a CSS selector, by default the page's first canvas) and resolves false.
 * @param {Element | string} [area]
 * @returns {Promise<boolean>}
 */
export async function needsWebGPU(area = 'canvas') {
  try {
    if (await navigator.gpu?.requestAdapter()) return true;
  } catch {
    // A browser that throws here has no usable WebGPU either.
  }
  const target = (typeof area === 'string' ? document.querySelector(area) : area) ?? document.body,
    host = target instanceof HTMLCanvasElement ? target.parentElement : target,
    box = document.createElement('div'),
    text = document.createElement('p'),
    link = document.createElement('a');
  // A full-page canvas (fixed, or straight in <body>) gets a full-page message; any other area gets one over itself.
  const page = host === document.body || getComputedStyle(target).position === 'fixed';
  if (!page && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  box.dataset.noWebgpu = '';
  box.setAttribute('role', 'alert');
  box.style.cssText =
    `position:${page ? 'fixed' : 'absolute'};inset:0;z-index:1000;display:grid;place-content:center;gap:8px;padding:24px;text-align:center;` +
    'background:#101418;color:#f2f4f6;font:16px/1.5 system-ui,sans-serif';
  text.style.margin = '0';
  text.textContent = message;
  link.href = help;
  link.textContent = 'What to update';
  link.style.color = '#8cc8ff';
  box.append(text, link);
  host.append(box);
  // Loading lines would otherwise wait forever beside the message.
  for (const element of document.querySelectorAll('[data-webgpu-status]')) element.style.display = 'none';
  return false;
}
