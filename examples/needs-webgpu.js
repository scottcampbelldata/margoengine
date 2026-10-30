// The one place margoengine.com demos check for WebGPU (scripts/build-site.js builds every demo that uses it).
// A demo page loads this first and imports its own code only once a GPU answers. Without WebGPU (no `navigator.gpu`,
// or `requestAdapter()` answers null) it loads the WebGL2 compatibility layer (@margoengine/webgl2-compat) with a
// dynamic import, so browsers with WebGPU never download it, and the demo runs its usual WebGPU code on WebGL2.
// Without WebGL2 at the layer's minimum tier it shows a plain message in the canvas area instead of failing quietly.
// A part of a demo that refuses the layer (MargoError code `unsupported`, e.g. the voxel path tracer) shows the
// refusal over the canvas, naming the code. scripts/test-no-webgpu-browser.mjs loads every demo both ways and checks
// it; scripts/visual-compat.mjs compares every demo on the layer with native WebGPU (docs/webgl2-compat-demos.md).

/** Shown in the canvas area when the browser has neither WebGPU nor WebGL2 at the layer's minimum tier. */
export const message = 'This demo needs a browser with WebGPU: Chrome, Edge or Safari.';
/** The help line linked under the message: which browser versions to update to, and the compatibility mode. */
export const help = 'https://margoengine.com/webgpu.html';
/** Shown, with the error's own message, when a demo refuses the WebGL2 compatibility layer. */
export const refusal = 'This part of the demo needs WebGPU; the WebGL2 compatibility mode cannot run it.';

/** The element the messages cover: `area` (an element or a CSS selector), else the page's body. */
function host(area) {
  const target = (typeof area === 'string' ? document.querySelector(area) : area) ?? document.body,
    parent = target instanceof HTMLCanvasElement ? target.parentElement : target;
  // A full-page canvas (fixed, or straight in <body>) gets a full-page message; any other area gets one over itself.
  const page = parent === document.body || getComputedStyle(target).position === 'fixed';
  if (!page && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  return { parent, page };
}

/** A message box over `area`: `lines` are [text, href?] pairs. Returns the box. */
function show(area, kind, lines) {
  const { parent, page } = host(area),
    box = document.createElement('div');
  box.dataset[kind] = '';
  box.setAttribute('role', 'alert');
  box.style.cssText =
    `position:${page ? 'fixed' : 'absolute'};inset:0;z-index:1000;display:grid;place-content:center;gap:8px;padding:24px;text-align:center;` +
    'background:#101418;color:#f2f4f6;font:16px/1.5 system-ui,sans-serif';
  for (const [text, href] of lines) {
    const line = document.createElement(href ? 'a' : 'p');
    line.textContent = text;
    if (href) {
      line.href = href;
      line.style.color = '#8cc8ff';
    } else line.style.margin = '0';
    box.append(line);
  }
  parent.append(box);
  // Loading lines would otherwise wait forever beside the message.
  for (const element of document.querySelectorAll('[data-webgpu-status]')) element.style.display = 'none';
  return box;
}

/** On the layer: a demo part that refuses it (MargoError code `unsupported`) shows the refusal instead of a blank. */
function watchRefusals(area) {
  let shown = false;
  const refused = (error) => {
    if (shown || error?.name !== 'MargoError' || error.code !== 'unsupported') return;
    shown = true;
    show(area, 'webgpuRefused', [
      [refusal],
      [`${String(error.message).split('; see ')[0]} (MargoError code unsupported)`],
      ['What to update', help],
    ]);
  };
  addEventListener('unhandledrejection', (event) => refused(event.reason));
  addEventListener('error', (event) => refused(event.error));
}

/**
 * Resolves true when the demo can run: the browser's WebGPU answers, or the WebGL2 compatibility layer installed
 * (then `document.documentElement.dataset.webgpuCompat` is set and a small note says so). Otherwise shows
 * {@link message} over `area` (an element or a CSS selector, by default the page's first canvas) and resolves false.
 * `layer: false` keeps a demo off the layer (the message shows instead) while docs/known-bugs.md lists it as wrong there.
 * @param {Element | string} [area]
 * @param {{ layer?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function needsWebGPU(area = 'canvas', { layer = true } = {}) {
  try {
    if (await navigator.gpu?.requestAdapter()) return true;
  } catch {
    // A browser that throws here has no usable WebGPU either.
  }
  try {
    if (!layer) throw new Error('kept off the WebGL2 layer');
    // Downloaded only here, by a browser without WebGPU.
    const { install } = await import('@margoengine/webgl2-compat');
    if ((await install()).installed) {
      document.documentElement.dataset.webgpuCompat = '';
      watchRefusals(area);
      const note = document.createElement('a');
      note.dataset.webgpuCompatNote = '';
      note.href = help;
      note.textContent = 'WebGL2 compatibility mode';
      note.style.cssText =
        'position:fixed;left:8px;bottom:8px;z-index:999;padding:2px 8px;border-radius:4px;background:#101418cc;' +
        'color:#f2f4f6;font:13px/1.6 system-ui,sans-serif;text-decoration:none';
      document.body.append(note);
      return true;
    }
  } catch {
    // Below the layer's minimum tier (no WebGL2, or no float colour targets): the message below says what to do.
  }
  show(area, 'noWebgpu', [[message], ['What to update', help]]);
  return false;
}
