// @ts-check
// The in-page side of a mobile wrapper (`margo-convert mobile`): safe-area insets as CSS variables and a JS getter,
// a canvas that fits inside them and follows rotation, and the orientation lock. Sources: CSS Environment Variables
// Module Level 1 (W3C, env(safe-area-inset-*)), Screen Orientation (W3C, screen.orientation.lock). It runs as
// written in a browser or a Capacitor web view. Nothing runs on import.

/** @typedef {{top: number, right: number, bottom: number, left: number}} Insets pixels */

const SIDES = /** @type {const} */ (['top', 'right', 'bottom', 'left']);

/**
 * The safe-area insets in CSS pixels, read from `env(safe-area-inset-*)` (all 0 on a screen with no cutout, and in a
 * page without `viewport-fit=cover` on iOS). `root` is where the probe element goes (default `document.body`).
 * @param {{root?: Element}} [options]
 * @returns {Insets}
 */
export function getSafeArea({ root } = {}) {
  const parent = root ?? document.body ?? document.documentElement;
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    SIDES.map((s) => `padding-${s}:env(safe-area-inset-${s},0px)`).join(';');
  parent.append(probe);
  try {
    const style = getComputedStyle(probe);
    const out = /** @type {Insets} */ ({ top: 0, right: 0, bottom: 0, left: 0 });
    for (const s of SIDES) out[s] = Number.parseFloat(style.getPropertyValue(`padding-${s}`)) || 0;
    return out;
  } finally {
    probe.remove();
  }
}

/**
 * Sets `--safe-area-top`, `--safe-area-right`, `--safe-area-bottom` and `--safe-area-left` (in px) on `target`
 * (default the document element) now, and again on resize and orientation change until `signal` aborts or the
 * returned handle is disposed.
 * @param {{target?: HTMLElement, signal?: AbortSignal, onChange?: (insets: Insets) => void}} [options]
 * @returns {{readonly insets: Insets, update(): Insets, dispose(): void, [Symbol.dispose](): void}}
 */
export function watchSafeArea({ target, signal, onChange } = {}) {
  signal?.throwIfAborted();
  const el = target ?? document.documentElement;
  let insets = getSafeArea();
  const apply = () => {
    for (const s of SIDES) el.style.setProperty(`--safe-area-${s}`, `${insets[s]}px`);
  };
  apply();
  const update = () => {
    insets = getSafeArea();
    apply();
    onChange?.(insets);
    return insets;
  };
  const targets = /** @type {EventTarget[]} */ ([window, screen.orientation, window.visualViewport].filter(Boolean));
  const events = ['resize', 'orientationchange', 'change'];
  for (const t of targets) for (const e of events) t.addEventListener(e, update);
  let done = false;
  const dispose = () => {
    if (done) return;
    done = true;
    for (const t of targets) for (const e of events) t.removeEventListener(e, update);
    signal?.removeEventListener('abort', dispose);
  };
  signal?.addEventListener('abort', dispose, { once: true });
  return {
    get insets() {
      return insets;
    },
    update,
    dispose,
    [Symbol.dispose]: dispose,
  };
}

/**
 * Fits a canvas inside the safe area: it is fixed to the area's rectangle and its drawing buffer follows its CSS size
 * times `pixelRatio`, on load, resize and orientation change. `onResize(width, height, insets)` is called each time with
 * the buffer size so the app can resize its engine.
 * @param {HTMLCanvasElement} canvas
 * @param {{pixelRatio?: number, safeArea?: boolean, signal?: AbortSignal, onResize?: (width: number, height: number, insets: Insets) => void}} [options]
 * `pixelRatio` defaults to `devicePixelRatio`; `safeArea` (default true) keeps the canvas out of the cutouts.
 * @returns {{readonly width: number, readonly height: number, readonly insets: Insets, update(): void, dispose(): void, [Symbol.dispose](): void}}
 */
export function fitCanvasToSafeArea(canvas, { pixelRatio, safeArea = true, signal, onResize } = {}) {
  signal?.throwIfAborted();
  let width = 0,
    height = 0;
  const watch = watchSafeArea({ signal, onChange: () => fit() });
  function fit() {
    const insets = safeArea ? watch.insets : { top: 0, right: 0, bottom: 0, left: 0 };
    const cssW = Math.max(1, window.innerWidth - insets.left - insets.right);
    const cssH = Math.max(1, window.innerHeight - insets.top - insets.bottom);
    const ratio = pixelRatio ?? window.devicePixelRatio ?? 1;
    Object.assign(canvas.style, {
      position: 'fixed',
      left: `${insets.left}px`,
      top: `${insets.top}px`,
      width: `${cssW}px`,
      height: `${cssH}px`,
    });
    width = Math.max(1, Math.round(cssW * ratio));
    height = Math.max(1, Math.round(cssH * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    onResize?.(width, height, insets);
  }
  fit();
  const dispose = () => watch.dispose();
  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get insets() {
      return watch.insets;
    },
    update: () => {
      watch.update();
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

/**
 * Locks the screen to `orientation` with `screen.orientation.lock` ('any' unlocks). Resolves true when the lock
 * holds and false where the platform has no lock or refuses it (a browser tab allows it only in fullscreen; a Capacitor
 * web view follows the native lock instead, see the project's README).
 * @param {'portrait' | 'landscape' | 'any'} orientation
 * @returns {Promise<boolean>}
 */
export async function lockOrientation(orientation) {
  if (orientation !== 'portrait' && orientation !== 'landscape' && orientation !== 'any')
    throw new RangeError(`Orientation must be 'portrait', 'landscape' or 'any', got ${orientation}`);
  const so = /** @type {any} */ (typeof screen === 'undefined' ? undefined : screen.orientation);
  if (!so) return false;
  if (orientation === 'any') {
    if (typeof so.unlock === 'function') so.unlock();
    return true;
  }
  if (typeof so.lock !== 'function') return false;
  try {
    await so.lock(orientation);
    return true;
  } catch {
    return false; // NotSupportedError or SecurityError: the platform's answer, reported as false
  }
}

/**
 * What the injected page script calls: the orientation lock, the safe-area variables and, with a canvas, the fit.
 * @param {{orientation?: 'portrait' | 'landscape' | 'any', canvas?: HTMLCanvasElement, signal?: AbortSignal, onResize?: (width: number, height: number, insets: Insets) => void}} [options]
 */
export async function startMobile({ orientation = 'any', canvas, signal, onResize } = {}) {
  const locked = await lockOrientation(orientation);
  const handle = canvas ? fitCanvasToSafeArea(canvas, { signal, onResize }) : watchSafeArea({ signal });
  return { locked, handle };
}
