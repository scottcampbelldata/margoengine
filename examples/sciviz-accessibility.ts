// Example-page integration is explicit. Importing the optional package alone changes no document or globals.
import { attachAccessibility, figureForCanvas, type AccessibilityHandle } from '@margoengine/sciviz/a11y';
import { applyTheme, type ThemeHandle, type ThemeName } from '@margoengine/sciviz/themes';
const printTheme = new URLSearchParams(location.search).get('theme');
const themeHandles: ThemeHandle[] = [],
  pending = new Set<HTMLCanvasElement>();
const handles = new Map<HTMLCanvasElement, AccessibilityHandle>();
const style = document.createElement('style');
style.textContent =
  ':focus-visible{outline:3px solid Highlight;outline-offset:3px}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}';
if (printTheme === 'print' || printTheme === 'print-mono')
  style.textContent +=
    'html,body{color-scheme:light;background:#ffffff!important;color:#111111!important}p,label,section,footer{color:inherit!important}a{color:#004488!important}button,select,input{color:#111111!important;background:#ffffff!important;border-color:#555555!important}canvas{background:#ffffff!important}';
document.head.append(style);
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
const start = Date.now();
function scan() {
  if (disposed) return;
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas')) {
    if (pending.has(canvas) || handles.has(canvas) || canvas.dataset.margoExplore !== undefined) continue;
    const fig = figureForCanvas(canvas);
    if (!fig || !fig.layers.length) continue;
    pending.add(canvas);
    void (async () => {
      if (printTheme) themeHandles.push(await applyTheme(fig, printTheme as ThemeName));
      if (disposed) return;
      const title = canvas.getAttribute('aria-label') || `${document.title}: ${canvas.id || 'figure'}`;
      const handle = attachAccessibility(fig, { title });
      handles.set(canvas, handle);
      await handle.ready;
      canvas.dataset.accessibleReady = 'true';
      if (printTheme) canvas.dataset.themeReady = printTheme;
    })()
      .catch((error) => {
        canvas.dataset.accessibleError = String(error);
      })
      .finally(() => pending.delete(canvas));
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
    for (const h of themeHandles) h.dispose();
    style.remove();
  },
  { once: true },
);
