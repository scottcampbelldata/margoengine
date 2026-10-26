// A legend: an HTML box over the canvas listing the named layers, each with a swatch in its colour (a stroke for lines,
// a dot for scatters, a square for bars, histograms, heatmaps and surfaces).
import type { Theme } from './axes.js';

/** One legend row. */
export interface LegendEntry {
  readonly name: string;
  readonly color: string;
  readonly shape: 'line' | 'dot' | 'square';
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
      ...entries.map(({ name, color, shape }) => {
        const row = document.createElement('div');
        row.setAttribute('role', 'listitem');
        row.style.cssText = 'display: flex; align-items: center; gap: 7px; white-space: nowrap';
        const swatch = document.createElement('span');
        swatch.dataset.scivizSwatch = '';
        const size =
          shape === 'line'
            ? 'width: 16px; height: 3px; border-radius: 2px'
            : shape === 'dot'
              ? 'width: 8px; height: 8px; border-radius: 50%; margin: 0 4px'
              : 'width: 10px; height: 10px; border-radius: 2px; margin: 0 3px';
        swatch.style.cssText = `display: inline-block; flex: none; ${size}; background: ${color}`;
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
