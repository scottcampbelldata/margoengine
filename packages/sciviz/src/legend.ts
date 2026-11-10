// A legend: an HTML box over the canvas listing the named layers, each with a swatch in its colour (a stroke for lines,
// a dot for scatters, a square for bars, histograms, heatmaps and surfaces).
import type { Theme } from './axes.js';
import type { Figure } from './figure.js';
import { registerPublicationLabel } from './publication-labels.js';
import { rangeError, typeError } from '../../shared/errors.js';

/** Shapes for redundant visual encoding. */
export type LegendShape = 'line' | 'dot' | 'square' | 'triangle' | 'diamond' | 'cross' | 'hexagon';
const polygons: Partial<Record<LegendShape, readonly number[]>> = {
  triangle: [0.5, 0, 1, 1, 0, 1],
  diamond: [0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5],
  cross: [
    0.33, 0, 0.67, 0, 0.67, 0.33, 1, 0.33, 1, 0.67, 0.67, 0.67, 0.67, 1, 0.33, 1, 0.33, 0.67, 0, 0.67, 0, 0.33, 0.33,
    0.33,
  ],
  hexagon: [0.25, 0, 0.75, 0, 1, 0.5, 0.75, 1, 0.25, 1, 0, 0.5],
};

/** One legend row. */
export interface LegendEntry {
  readonly name: string;
  readonly color: string;
  readonly shape: LegendShape;
  /** Diameter or side length in CSS pixels. Default 8 for dots, 10 for filled shapes. */
  readonly size?: number;
}

/** Where the legend sits: a corner of the plot area. */
export type LegendPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

/** The figure's legend. Shown by the figure when two or more layers have a `name` (or always with `legend: true`). */
export class Legend {
  /** The root element (absolutely positioned over the canvas's container). */
  readonly element: HTMLDivElement;
  #disposed = false;

  /** @internal The figure creates it. */
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly theme: Theme,
  ) {
    const host = canvas.parentElement ?? document.body;
    if (host !== document.body && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const root = document.createElement('div');
    root.setAttribute('role', 'list');
    root.setAttribute('aria-label', 'Legend');
    root.dataset.scivizLegend = '';
    root.style.cssText = `position: absolute; z-index: 1; display: grid; gap: 3px; padding: 6px 9px; border-radius: 4px; pointer-events: none; font: 12px system-ui, sans-serif; color: ${theme.text}; background: ${theme.background}d9; border: 1px solid ${theme.grid}`;
    host.append(root);
    this.element = root;
  }

  /** Shows `entries` in the corner `position`, inset from the canvas edges by `inset` CSS pixels. */
  update(
    entries: readonly LegendEntry[],
    position: LegendPosition,
    inset: { top: number; right: number; bottom: number; left: number },
  ): void {
    const root = this.element,
      c = this.canvas;
    root.hidden = entries.length === 0;
    root.replaceChildren(
      ...entries.map(({ name, color, shape, size: diameter }) => {
        if (diameter !== undefined && (!Number.isFinite(diameter) || diameter <= 0 || diameter > 256))
          throw rangeError('Legend size must be in (0,256] CSS pixels; correct size', 'sciviz');
        if (!['line', 'dot', 'square', ...Object.keys(polygons)].includes(shape))
          throw typeError('Unknown legend shape; choose a LegendShape', 'sciviz');
        const row = document.createElement('div');
        row.setAttribute('role', 'listitem');
        row.style.cssText = 'display: flex; align-items: center; gap: 7px; white-space: nowrap';
        const swatch = document.createElement('span');
        swatch.dataset.scivizSwatch = '';
        swatch.dataset.scivizShape = shape;
        const size =
          shape === 'line'
            ? 'width: 16px; height: 3px; border-radius: 2px'
            : shape === 'dot'
              ? 'width: 8px; height: 8px; border-radius: 50%; margin: 0 4px'
              : 'width: 10px; height: 10px; border-radius: 2px; margin: 0 3px';
        swatch.style.cssText = `display: inline-block; flex: none; ${size}; background: ${color}`;
        if (diameter !== undefined || polygons[shape]) {
          const d = diameter ?? 10;
          swatch.style.width = `${d}px`;
          swatch.style.height = `${shape === 'line' ? 3 : d}px`;
          swatch.style.margin = '0 3px';
        }
        const points = polygons[shape];
        if (points) {
          swatch.style.borderRadius = '0';
          swatch.dataset.scivizPolygon = points.join(',');
          swatch.style.clipPath = `polygon(${Array.from({ length: points.length / 2 }, (_, i) => `${points[i * 2] * 100}% ${points[i * 2 + 1] * 100}%`).join(',')})`;
        }
        const label = document.createElement('span');
        label.textContent = name;
        row.append(swatch, label);
        return row;
      }),
    );
    // Offsets inside the host from the canvas's box, so the legend stays in the plot area's corner.
    const host = root.parentElement!,
      [v, h] = position.split('-');
    root.style.top = v === 'top' ? `${c.offsetTop + inset.top + 8}px` : '';
    root.style.bottom =
      v === 'bottom' ? `${host.clientHeight - c.offsetTop - c.clientHeight + inset.bottom + 8}px` : '';
    root.style.left = h === 'left' ? `${c.offsetLeft + inset.left + 8}px` : '';
    root.style.right = h === 'right' ? `${host.clientWidth - c.offsetLeft - c.clientWidth + inset.right + 8}px` : '';
  }

  /** Removes the legend. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.element.remove();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** An encoding legend owned by its figure, also included by PNG, SVG, PDF and tiled media exports. */
export interface EncodingLegendHandle {
  readonly element: HTMLDivElement;
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Show size/shape/category keys. Sizes are actual rendered diameters, not areas or undocumented multipliers. */
export function encodingLegend(
  figure: Figure,
  entries: readonly LegendEntry[],
  options: { readonly title?: string; readonly position?: LegendPosition } = {},
): EncodingLegendHandle {
  const canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
  const legend = new Legend(canvas, figure.theme);
  try {
    legend.update(entries, options.position ?? 'bottom-right', { top: 0, right: 0, bottom: 0, left: 0 });
  } catch (error) {
    legend.dispose();
    throw error;
  }
  if (options.title) {
    const title = document.createElement('div');
    title.textContent = options.title;
    title.style.fontWeight = '600';
    legend.element.prepend(title);
  }
  const remove = registerPublicationLabel(figure, legend.element);
  const dispose = () => {
    remove();
    legend.dispose();
  };
  return { element: legend.element, dispose, [Symbol.dispose]: dispose };
}
