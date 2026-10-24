// Page helpers the three multi-view demos share (cad-views, split-screen, minimap): an outlined, labelled box over
// each view that its controls listen on, click-to-pick through that view, the reduced-motion pause and a frame timer.
// Only public APIs: engine.views, engine.render({views}), engine.pick(x, y, view).
import type { EngineKernel, Mesh, RenderView } from 'margoengine';
import { engineRuntime } from '@margoengine/core/extension';

/** Prefers-reduced-motion: the demos hold still at t = 0 (the visual check's deterministic frame). */
export const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A box over one view's rectangle: controls listen on it, a click on it picks through its view. */
export function viewBox(host: HTMLElement, label: string): HTMLDivElement {
  const box = document.createElement('div'),
    tag = document.createElement('span');
  box.className = 'view';
  tag.className = 'view-label';
  tag.textContent = label;
  box.append(tag);
  host.append(box);
  return box;
}

/** Places `box` over `viewport` (fractions of the canvas, from the top left). */
export function place(box: HTMLElement, [x, y, w, h]: readonly number[]): void {
  Object.assign(box.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
}

/**
 * Calls `picked` with the mesh under a click (not a drag) on `box`, picked through `view()`, or null for empty space.
 */
export function pickOnClick(
  engine: EngineKernel,
  box: HTMLElement,
  view: () => RenderView,
  picked: (mesh: Mesh | null) => void,
  signal: AbortSignal,
): void {
  let down: { x: number; y: number } | null = null,
    pending = false;
  box.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }), { signal });
  box.addEventListener(
    'pointerup',
    async (e) => {
      // Core runs one pick at a time; a click while one is in flight is dropped.
      if (!down || pending || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      down = null;
      pending = true;
      try {
        const rect = engine.canvas.getBoundingClientRect(),
          mesh = await engine.pick(e.clientX - rect.left, e.clientY - rect.top, view());
        if (!signal.aborted) picked(mesh);
      } finally {
        pending = false;
      }
    },
    { signal },
  );
}

/**
 * Milliseconds per frame for drawing `views`: the median of `frames` renders, each waiting until the GPU has finished
 * (CPU and GPU time together, no overlap). Stops the frame loop while it runs and restarts it.
 */
export async function frameTime(
  engine: EngineKernel,
  views: () => readonly RenderView[],
  frames = 60,
): Promise<number> {
  const queue = engineRuntime(engine).gpu!.queue,
    times: number[] = [];
  engine.stop();
  try {
    for (let i = 0; i < frames + 5; i++) {
      const start = performance.now();
      engine.render({ views: views(), delta: 0 });
      await queue.onSubmittedWorkDone();
      if (i >= 5) times.push(performance.now() - start);
    }
  } finally {
    engine.start();
  }
  times.sort((a, b) => a - b);
  return times[times.length >> 1];
}
