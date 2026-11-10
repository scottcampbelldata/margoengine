// Example-page integration is explicit. Importing the optional package alone changes no document or globals.
import { attachAccessibility, figureForCanvas, type AccessibilityHandle } from '@margoengine/sciviz/a11y';
const handles = new Map<HTMLCanvasElement, AccessibilityHandle>();
const style = document.createElement('style');
style.textContent =
  ':focus-visible{outline:3px solid Highlight;outline-offset:3px}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}';
document.head.append(style);
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
const start = Date.now();
function scan() {
  if (disposed) return;
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas')) {
    if (handles.has(canvas) || canvas.dataset.margoExplore !== undefined) continue;
    const fig = figureForCanvas(canvas);
    if (!fig || !fig.layers.length) continue;
    const title = canvas.getAttribute('aria-label') || `${document.title}: ${canvas.id || 'figure'}`;
    const handle = attachAccessibility(fig, { title });
    handles.set(canvas, handle);
    void handle.ready.then(
      () => {
        canvas.dataset.accessibleReady = 'true';
      },
      (error) => {
        canvas.dataset.accessibleError = String(error);
      },
    );
  }
  if (Date.now() - start < 120000) timer = setTimeout(scan, 250);
}
scan();
window.addEventListener(
  'pagehide',
  () => {
    disposed = true;
    clearTimeout(timer);
    for (const h of handles.values()) h.dispose();
    handles.clear();
    style.remove();
  },
  { once: true },
);
