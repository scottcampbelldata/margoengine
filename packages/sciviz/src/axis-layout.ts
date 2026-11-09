// Screen-space layout belongs to the axes, rather than to particular datasets or cameras.
import type { Label, LabelLayout, LayoutContext } from '@margoengine/labels';
import type { EngineKernel } from '@margoengine/core';
import { projectPoint } from '@margoengine/math/mat4';

type Rect = { x: number; y: number; w: number; h: number };
const GAP = 8;
const overlaps = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 + GAP && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + GAP;

/** @internal Tick anchors lie on the box edges; offsets and collision tests are in CSS pixels. */
export class AxisLayout implements LabelLayout {
  constructor(
    readonly engine: EngineKernel,
    readonly center: readonly [number, number, number],
  ) {}

  arrange(labels: readonly Label[], context: LayoutContext): void {
    const center = projectPoint(this.engine.camera.matrix, ...this.center, context.width, context.height);
    const root = context.root.getBoundingClientRect(),
      ratio = context.width / root.width;
    const occupied: Rect[] = Array.from(
      context.root.parentElement?.querySelectorAll('[aria-label^="Colour scale"]') ?? [],
      (element) => {
        const r = element.getBoundingClientRect();
        // End ticks extend half a line beyond the colour bar's own box.
        return {
          x: (r.x - root.x + r.width / 2) * ratio,
          y: (r.y - root.y + r.height / 2) * ratio,
          w: r.width * ratio,
          h: (r.height + 16) * ratio,
        };
      },
    );
    for (const title of [false, true]) {
      for (const label of labels) {
        if ((label.element.dataset.axisTitle === 'true') !== title) continue;
        const axis = label.element.dataset.axis;
        const ticks = labels.filter((l) => l.element.dataset.axis === axis && l.element.dataset.axisTitle !== 'true');
        const first = ticks[0]?.screen ?? label.screen,
          last = ticks.at(-1)?.screen ?? label.screen;
        // The edge normal points away from the projected box centre, for any camera orientation.
        let nx = -(last.y - first.y),
          ny = last.x - first.x;
        if (Math.hypot(nx, ny) < 1) {
          nx = label.screen.x - center.x;
          ny = label.screen.y - center.y;
        }
        if (nx * (label.screen.x - center.x) + ny * (label.screen.y - center.y) < 0) {
          nx = -nx;
          ny = -ny;
        }
        const length = Math.hypot(nx, ny) || 1;
        nx /= length;
        ny /= length;
        // offsetWidth/offsetHeight round to integer CSS pixels. Enclose fractional DOM bounds outward.
        const measure = (item: Label) => context.size(item).map((v) => v + 1);
        const [w, h] = measure(label);
        const support = (width: number, height: number) => (Math.abs(nx) * width + Math.abs(ny) * height) / 2;
        const distance = GAP + support(w, h) + (title ? h + GAP : 0);
        const box: Rect = { x: label.screen.x + nx * distance, y: label.screen.y + ny * distance, w, h };
        if (title) {
          // Clamp to the view, then choose the nearest clear measured position beside an obstacle.
          box.x = Math.max(w / 2 + GAP, Math.min(context.width - w / 2 - GAP, box.x));
          box.y = Math.max(h / 2 + GAP, Math.min(context.height - h / 2 - GAP, box.y));
          const candidates = [box];
          for (const r of occupied)
            for (const sign of [-1, 1]) {
              candidates.push({ ...box, x: r.x + sign * ((w + r.w) / 2 + GAP) });
              candidates.push({ ...box, y: r.y + sign * ((h + r.h) / 2 + GAP) });
            }
          const clear = candidates.filter(
            (r) =>
              r.x >= w / 2 &&
              r.x <= context.width - w / 2 &&
              r.y >= h / 2 &&
              r.y <= context.height - h / 2 &&
              !occupied.some((other) => overlaps(r, other)),
          );
          const cost = (r: Rect) => (r.x - box.x) ** 2 + (r.y - box.y) ** 2;
          clear.sort((a, b) => cost(a) - cost(b));
          if (clear.length) Object.assign(box, clear[0]);
        }
        if (!title && occupied.some((r) => overlaps(box, r))) {
          context.hide(label);
          continue;
        }
        label.screenOffset = [box.x - label.screen.x, box.y - label.screen.y];
        context.place(label, [0.5, 0.5]);
        occupied.push(box);
      }
    }
  }
}
