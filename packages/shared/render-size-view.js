import { margoError } from './errors.js';

/**
 * The view an upscaler (TAAUpscale, SpatialUpscale) draws at render size, or undefined for a plain frame. Core passes a
 * frame whose scene has a `background` or a camera layer mask as one full-canvas view; that view's rectangles shrink
 * with the render size. Several views, a partial rectangle or a view into a target throw `message` (code unsupported),
 * or give null when there is no `message`.
 */
export function renderSizeView(view, canvas, size, message) {
  if (!view) return undefined;
  const full = (r) => !r || (r[0] === 0 && r[1] === 0 && r[2] === canvas[0] && r[3] === canvas[1]);
  if (view.count === 1 && !view.target && full(view.viewport) && full(view.scissor))
    return { ...view, viewport: [0, 0, size[0], size[1]], scissor: view.scissor && [0, 0, size[0], size[1]] };
  if (message === undefined) return null;
  throw margoError('unsupported', message);
}
