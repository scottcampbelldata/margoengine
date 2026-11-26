// @ts-check
// The in-page side of a playable ad (`margo-convert playable`): MRAID 3.0 when the ad SDK injects it (IAB Tech Lab,
// "Mobile Rich Media Ad Interface Definitions (MRAID) Version 3.0", 2017; link in the margo-convert README),
// Meta's FbPlayableAd call to action, and the plain page otherwise. It runs as written in a dev server too (no MRAID:
// the page's own visibility and window.open), and the published file maps `margo-convert/playable-runtime` to this file.
// Nothing runs on import.

/**
 * @typedef {object} MraidLike The part of MRAID 3.0 this file uses (section 5: getState, addEventListener,
 * removeEventListener, isViewable, open, close).
 * @property {() => string} getState 'loading' until the container is ready.
 * @property {(event: string, listener: (...args: any[]) => void) => void} addEventListener
 * @property {(event: string, listener: (...args: any[]) => void) => void} removeEventListener
 * @property {() => boolean} isViewable
 * @property {(url: string) => void} open
 * @property {() => void} close
 */

/** @returns {MraidLike | undefined} */
const mraidOf = () => /** @type {any} */ (globalThis).mraid;

/** True when an MRAID container injected `window.mraid`. */
export const hasMraid = () => typeof mraidOf()?.getState === 'function';

/**
 * Resolves once the ad may set itself up: after MRAID's `ready` event (at once when MRAID is not `loading`), or, with no
 * MRAID, once the document is parsed. Rejects with the signal's reason when `signal` aborts first.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<void>}
 */
export function ready({ signal } = {}) {
  signal?.throwIfAborted();
  const mraid = mraidOf();
  if (hasMraid() && mraid && mraid.getState() !== 'loading') return Promise.resolve();
  if (!hasMraid() && (typeof document === 'undefined' || document.readyState !== 'loading')) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      if (mraid && hasMraid()) mraid.removeEventListener('ready', done);
      else document.removeEventListener('DOMContentLoaded', done);
      signal?.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => {
      if (mraid && hasMraid()) mraid.removeEventListener('ready', done);
      else document.removeEventListener('DOMContentLoaded', done);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (mraid && hasMraid()) mraid.addEventListener('ready', done);
    else document.addEventListener('DOMContentLoaded', done);
  });
}

/** True when the ad is on screen: `mraid.isViewable()`, or the page's visibility with no MRAID. */
export function isViewable() {
  const mraid = mraidOf();
  if (mraid && hasMraid()) return mraid.isViewable() === true;
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Calls `listener(viewable)` each time the ad comes on or goes off screen: MRAID's `viewableChange`, or the page's
 * `visibilitychange` with no MRAID. Pause the game and mute audio on false, resume on true. Returns the function that
 * stops listening (also callable through `using`).
 * @param {(viewable: boolean) => void} listener
 * @returns {(() => void) & Disposable}
 */
export function onViewableChange(listener) {
  if (typeof listener !== 'function') throw new TypeError('onViewableChange needs a function; pass (viewable) => {}');
  const mraid = mraidOf();
  /** @type {() => void} */ let stop;
  if (mraid && hasMraid()) {
    const handle = (/** @type {unknown} */ viewable) => listener(viewable === true);
    mraid.addEventListener('viewableChange', handle);
    stop = () => mraid.removeEventListener('viewableChange', handle);
  } else {
    const handle = () => listener(isViewable());
    document.addEventListener('visibilitychange', handle);
    stop = () => document.removeEventListener('visibilitychange', handle);
  }
  return Object.assign(stop, { [Symbol.dispose]: stop });
}

/**
 * Resolves once the ad is ready and on screen (Unity Ads and MRAID 3.0: start only then).
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<void>}
 */
export async function whenViewable({ signal } = {}) {
  await ready({ signal });
  if (isViewable()) return;
  await new Promise((resolve, reject) => {
    const stop = onViewableChange((viewable) => {
      if (!viewable) return;
      stop();
      signal?.removeEventListener('abort', abort);
      resolve(undefined);
    });
    const abort = () => {
      stop();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * The click-through: Meta's `FbPlayableAd.onCTAClick()` when present, else `mraid.open(url)`, else
 * `window.open(url, '_blank')`. Call it from a tap on the call to action. Returns which way it went.
 * @param {string} url the store or landing page
 * @returns {'meta' | 'mraid' | 'window'}
 */
export function open(url) {
  if (typeof url !== 'string' || !url) throw new TypeError('open needs the click-through URL as a string');
  const meta = /** @type {any} */ (globalThis).FbPlayableAd;
  if (typeof meta?.onCTAClick === 'function') {
    meta.onCTAClick();
    return 'meta';
  }
  const mraid = mraidOf();
  if (mraid && hasMraid()) {
    mraid.open(url);
    return 'mraid';
  }
  globalThis.open?.(url, '_blank');
  return 'window';
}

/** Asks the container to close the ad (`mraid.close()`). Returns false with no MRAID, where a page cannot close itself. */
export function close() {
  const mraid = mraidOf();
  if (!mraid || !hasMraid()) return false;
  mraid.close();
  return true;
}

/**
 * The URL to load a bundled file from: a blob or in-page URL in the published file, `path` itself elsewhere (a dev
 * server serves it). `path` is relative to the published folder, as `assets/logo.png`.
 * @param {string} path
 * @returns {string}
 */
export function assetURL(path) {
  const map = /** @type {any} */ (globalThis).__margoPlayable;
  return map ? map.url(path) : path;
}
