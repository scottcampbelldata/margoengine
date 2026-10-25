// Axes for a figure: the data box outline, grid lines at the ticks on the floor and the two back walls (fat lines from
// @margoengine/lines, in data units through the figure's transform), and HTML tick labels and axis titles
// (@margoengine/labels) placed just outside the box. Both packages are loaded with import() when axes are first drawn.
import type { Line, Lines } from '@margoengine/lines';
import type { Label, LabelRenderer } from '@margoengine/labels';
import type { EngineKernel } from '@margoengine/core';
import { ticks } from './ticks.js';
import { toScene, type Bounds } from './layer.js';

/** Colours of a figure's chrome. */
export interface Theme {
  readonly background: string;
  readonly axis: string;
  readonly grid: string;
  readonly text: string;
}

/** The built-in themes. */
export const THEMES: Readonly<Record<'dark' | 'light', Theme>> = {
  dark: { background: '#0f141c', axis: '#7d8ba1', grid: '#2c3646', text: '#c9d4e3' },
  light: { background: '#ffffff', axis: '#6b7686', grid: '#dde2e8', text: '#2b3442' },
};

/** Options for axes. */
export interface AxesOptions {
  /** Axis titles. Default 'x', 'y', 'z'. */
  readonly titles?: { readonly x?: string; readonly y?: string; readonly z?: string };
  /** About how many ticks per axis. Default 5. */
  readonly ticks?: number;
  /** Grid lines on the floor and back walls. Default true. */
  readonly grid?: boolean;
}

/** @internal The figure's axes. */
export class Axes {
  #lines: Lines | undefined;
  #labels: LabelRenderer | undefined;
  readonly #drawn: Line[] = [];
  readonly #texts: Label[] = [];
  #loading: Promise<void> | undefined;
  #disposed = false;

  /** @param lines The figure's lines plugin (shared: one per engine under its default name). */
  constructor(
    readonly engine: EngineKernel,
    readonly theme: Theme,
    readonly options: AxesOptions,
    readonly lines: () => Promise<Lines>,
  ) {}

  /**
   * Draws (or redraws) the axes for `bounds` under the figure transform `model`; `flat` draws 2D axes (a frame, grid
   * lines and labels on the left and bottom, below everything at data z -1).
   */
  async update(bounds: Bounds, model: Float32Array, flat = false): Promise<void> {
    this.#loading ??= (async () => {
      const [lines, { LabelRenderer }] = await Promise.all([this.lines(), import('@margoengine/labels')]);
      if (this.#disposed) return;
      this.#lines = lines;
      this.#labels = LabelRenderer.attach(this.engine);
    })();
    await this.#loading;
    if (this.#disposed || !this.#lines || !this.#labels) return;
    const { Line } = await import('@margoengine/lines');
    for (const line of this.#drawn.splice(0)) this.#lines.remove(line);
    for (const label of this.#texts.splice(0)) label.remove();
    const [x0, x1, y0, y1, z0, z1] = bounds,
      count = this.options.ticks ?? 5,
      tx = ticks(x0, x1, count),
      ty = ticks(y0, y1, count),
      tz = ticks(z0, z1, count);
    if (flat) return this.#flat(Line, bounds, model, tx, ty);
    // The box: 12 edges.
    const box = [
      [x0, y0, z0, x1, y0, z0],
      [x0, y1, z0, x1, y1, z0],
      [x0, y0, z1, x1, y0, z1],
      [x0, y1, z1, x1, y1, z1],
      [x0, y0, z0, x0, y1, z0],
      [x1, y0, z0, x1, y1, z0],
      [x0, y0, z1, x0, y1, z1],
      [x1, y0, z1, x1, y1, z1],
      [x0, y0, z0, x0, y0, z1],
      [x1, y0, z0, x1, y0, z1],
      [x0, y1, z0, x0, y1, z1],
      [x1, y1, z0, x1, y1, z1],
    ].flat();
    this.#drawn.push(
      this.#lines.add(
        new Line({ mode: 'segments', positions: box, color: this.theme.axis, width: 1.5, matrix: model }),
      ),
    );
    if (this.options.grid ?? true) {
      const grid: number[] = [];
      // Floor (z = z0), back wall (y = y1) and left wall (x = x0).
      for (const x of tx.values) grid.push(x, y0, z0, x, y1, z0, x, y1, z0, x, y1, z1);
      for (const y of ty.values) grid.push(x0, y, z0, x1, y, z0, x0, y, z0, x0, y, z1);
      for (const z of tz.values) grid.push(x0, y1, z, x1, y1, z, x0, y0, z, x0, y1, z);
      if (grid.length)
        this.#drawn.push(
          this.#lines.add(
            new Line({ mode: 'segments', positions: grid, color: this.theme.grid, width: 1, matrix: model }),
          ),
        );
    }
    const span = (lo: number, hi: number) => (hi - lo || 1) * 0.06,
      dx = span(x0, x1),
      dy = span(y0, y1),
      dz = span(z0, z1);
    const text = (content: string, data: [number, number, number], strong = false) => {
      const element = document.createElement('span');
      element.textContent = content;
      element.style.cssText = `font: ${strong ? '600 13px' : '12px'} system-ui, sans-serif; color: ${this.theme.text}; white-space: nowrap; font-variant-numeric: tabular-nums; text-shadow: 0 0 3px ${this.theme.background}`;
      this.#texts.push(this.#labels!.add(element, { position: toScene(model, ...data) }));
    };
    tx.values.forEach((v, k) => text(tx.labels[k], [v, y0 - dy, z0]));
    ty.values.forEach((v, k) => text(ty.labels[k], [x1 + dx, v, z0]));
    tz.values.forEach((v, k) => text(tz.labels[k], [x0 - dx, y0 - dy, v]));
    const titles = this.options.titles ?? {};
    text(titles.x ?? 'x', [(x0 + x1) / 2, y0 - 3 * dy, z0], true);
    text(titles.y ?? 'y', [x1 + 3 * dx, (y0 + y1) / 2, z0], true);
    text(titles.z ?? 'z', [x0 - 3 * dx, y0 - 3 * dy, (z0 + z1) / 2 + dz], true);
  }

  #span(content: string, css = ''): HTMLSpanElement {
    const element = document.createElement('span');
    element.textContent = content;
    element.style.cssText = `font: 12px system-ui, sans-serif; color: ${this.theme.text}; white-space: nowrap; font-variant-numeric: tabular-nums; ${css}`;
    return element;
  }

  // 2D axes: the frame and grid at data z -1, tick labels outside the left and bottom edges (pixel padding, so they
  // keep their distance at any zoom), and titles below and, turned, left of the plot.
  #flat(
    Line: typeof import('@margoengine/lines').Line,
    bounds: Bounds,
    model: Float32Array,
    tx: { values: readonly number[]; labels: readonly string[] },
    ty: { values: readonly number[]; labels: readonly string[] },
  ): void {
    const [x0, x1, y0, y1] = bounds,
      z = -1;
    const frame = [x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z];
    if (this.options.grid ?? true) {
      const grid: number[] = [];
      for (const x of tx.values) grid.push(x, y0, z, x, y1, z);
      for (const y of ty.values) grid.push(x0, y, z, x1, y, z);
      if (grid.length)
        this.#drawn.push(
          this.#lines!.add(
            new Line({ mode: 'segments', positions: grid, color: this.theme.grid, width: 1, matrix: model }),
          ),
        );
    }
    this.#drawn.push(
      this.#lines!.add(
        new Line({ mode: 'segments', positions: frame, color: this.theme.axis, width: 1.5, matrix: model }),
      ),
    );
    const place = (element: HTMLElement, x: number, y: number, anchor: readonly [number, number]) =>
      this.#texts.push(
        this.#labels!.add(element, { position: toScene(model, x, y, 0), anchor, frustumCulling: false }),
      );
    tx.values.forEach((v, k) => place(this.#span(tx.labels[k], 'padding-top: 6px'), v, y0, [0.5, 0]));
    ty.values.forEach((v, k) => place(this.#span(ty.labels[k], 'padding-right: 8px'), x0, v, [1, 0.5]));
    const titles = this.options.titles ?? {};
    place(this.#span(titles.x ?? 'x', 'font-weight: 600; padding-top: 24px'), (x0 + x1) / 2, y0, [0.5, 0]);
    const yTitle = this.#span('', 'padding-right: 44px; display: inline-block');
    yTitle.append(
      this.#span(
        titles.y ?? 'y',
        'font-weight: 600; display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg)',
      ),
    );
    place(yTitle, x0, (y0 + y1) / 2, [1, 0.5]);
  }

  /** Removes the lines, the labels and both plugins. */
  dispose(): void {
    this.#disposed = true;
    for (const label of this.#texts.splice(0)) label.remove();
    const engine = this.engine as unknown as { removePlugin(name: string): void };
    for (const line of this.#drawn.splice(0)) this.#lines?.remove(line);
    if (this.#labels) engine.removePlugin(this.#labels.name);
  }
}
