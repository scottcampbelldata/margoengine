// A colour bar: an HTML legend over the canvas's right edge (a vertical gradient of the colour map with nice-number
// ticks and a title), so it stays crisp at any pixel ratio and needs no text rendering on the GPU.
import { rangeError } from '../../shared/errors.js';
import type { Colormap } from './colormaps.js';
import { ticks } from './ticks.js';
import type { Theme } from './axes.js';

/** Options for a colour bar. */
export interface ColorBarOptions {
  /** Title above the bar. Default none. */
  readonly label?: string;
  /** About how many ticks. Default 5. */
  readonly ticks?: number;
}

/** A colour bar legend. Create it with `figure.colorbar(colormap, range, options)`. */
export class ColorBar {
  /** The root element (absolutely positioned over the canvas's container). */
  readonly element: HTMLDivElement;
  /** The colour map the bar shows. */
  readonly colormap: Colormap;
  /** @internal The gradient element, for export. */
  readonly bar: HTMLDivElement;
  #disposed = false;

  /** @internal Use `figure.colorbar()`. */
  constructor(
    canvas: HTMLCanvasElement,
    map: Colormap,
    range: readonly [number, number],
    theme: Theme,
    options: ColorBarOptions = {},
  ) {
    const [lo, hi] = range;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo))
      throw rangeError(`Colour bar range must be finite [min, max] with min < max, got [${lo}, ${hi}]`, 'sciviz');
    const host = canvas.parentElement ?? document.body;
    if (host !== document.body && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const root = document.createElement('div');
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', `Colour scale${options.label ? ` for ${options.label}` : ''} from ${lo} to ${hi}`);
    root.style.cssText = `position: absolute; right: 16px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; align-items: flex-start; gap: 6px; pointer-events: none; font: 12px system-ui, sans-serif; color: ${theme.text}; text-shadow: 0 0 3px ${theme.background}`;
    if (options.label) {
      const title = document.createElement('div');
      title.textContent = options.label;
      title.style.fontWeight = '600';
      root.append(title);
    }
    const body = document.createElement('div');
    body.style.cssText = 'position: relative; display: flex; gap: 6px; height: min(50vh, 260px)';
    const bar = document.createElement('div');
    bar.style.cssText = `width: 14px; height: 100%; border-radius: 3px; border: 1px solid ${theme.axis}; background: ${map.css(32, 'to top')}`;
    const scale = document.createElement('div');
    scale.style.cssText = 'position: relative; height: 100%; min-width: 3ch; font-variant-numeric: tabular-nums';
    const t = ticks(lo, hi, options.ticks ?? 5);
    t.values.forEach((v, k) => {
      const tick = document.createElement('span');
      tick.textContent = t.labels[k];
      tick.style.cssText = `position: absolute; left: 0; bottom: ${((v - lo) / (hi - lo)) * 100}%; transform: translateY(50%); white-space: nowrap`;
      scale.append(tick);
    });
    body.append(bar, scale);
    root.append(body);
    host.append(root);
    this.element = root;
    this.colormap = map;
    this.bar = bar;
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
