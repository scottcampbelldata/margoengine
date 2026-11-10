// Reading a WebGPU canvas in a later task than the frame that drew it. The browser presents the canvas texture at its
// next rendering update, and a drawImage, toDataURL or toBlob after that sees transparent black (Chromium 157, native
// WebGPU, measured 2026-11-10 on packages/terrain/test/overlays.browser.mjs: every pixel 0,0,0,0). Whether an update
// falls between the draw and the read depends on how long the awaits in between take (a mapAsync, a queue fence), so
// such a read passes on a quiet machine and fails on a busy one.
// watchCanvas() marks the canvas's frame current when its 'webgpu' context hands out a texture and expired when that
// task ends (the next timer task or animation frame, whichever runs first). readCanvas() throws on an expired frame, so
// the race fails on every run instead of on a busy one. The WebGL2 compatibility layer keeps its last frame on the page,
// but the same rule holds there, so a check passes or fails alike on both. Page-side, like gpu-ready.js.

/** Canvas to whether its frame was drawn in the running task. */
const watched = new WeakMap();

/**
 * Tracks the frames of a canvas's 'webgpu' context (native or the compatibility layer's). Call it once the context
 * exists (after Engine.create) and before the frame to read.
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 */
export function watchCanvas(canvas) {
  if (watched.has(canvas)) return;
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('canvas-frame: watchCanvas needs a canvas with a webgpu context');
  const original = context.getCurrentTexture;
  watched.set(canvas, false);
  context.getCurrentTexture = function (...args) {
    watched.set(canvas, true);
    // Any later task means this one ended; the browser may present at the first rendering update after it.
    const expire = () => watched.set(canvas, false);
    setTimeout(expire, 0);
    globalThis.requestAnimationFrame?.(expire);
    return original.apply(this, args);
  };
}

/**
 * Whether the canvas's last frame was drawn in the running task.
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 */
export function frameIsCurrent(canvas) {
  if (!watched.has(canvas)) throw new Error('canvas-frame: call watchCanvas(canvas) before its first frame');
  return watched.get(canvas);
}

/**
 * The canvas's RGBA pixels, read in the task that drew its frame. Throws when that task has ended, because the
 * browser may already have presented the texture and the read would see transparent black.
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 * @returns {Uint8ClampedArray}
 */
export function readCanvas(canvas, width = canvas.width, height = canvas.height) {
  if (!frameIsCurrent(canvas))
    throw new Error(
      'canvas-frame: read after the task that drew the frame ended; render and read with no await in between',
    );
  const context = new OffscreenCanvas(width, height).getContext('2d');
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, width, height).data;
}
