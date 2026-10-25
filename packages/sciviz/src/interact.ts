// Pointer interaction for a figure: hover picking with an HTML tooltip (one pick per animation frame), and box or
// lasso selection drawn as an SVG outline over the canvas. The figure supplies the picking and selection; this file
// owns only the DOM: listeners, the tooltip element and the outline.
import type { Theme } from './axes.js';
import type { SelectRegion } from './pick.js';

/** How a left-button drag on the canvas acts: orbit the camera (default), or select points in a box or a lasso. */
export type DragMode = 'orbit' | 'box' | 'lasso';

/** @internal What the interaction asks of its figure. */
interface InteractionHooks<Hit> {
  /** The hit under (x, y), CSS pixels from the canvas's top-left, or null. */
  pick(x: number, y: number): Hit | null;
  /** Tooltip text for a hit, or null for none. */
  describe(hit: Hit): string | null;
  /** The hovered hit changed. */
  hover(hit: Hit | null): void;
  /** A drag selection finished. */
  select(region: SelectRegion): void;
  /** Camera controls to pause while a selection drag mode is on. */
  controls(): { enabled: boolean } | undefined;
}

const SVG = 'http://www.w3.org/2000/svg';

/** @internal A figure's pointer interaction. */
export class Interaction<Hit extends { readonly layer: unknown; readonly index: number }> {
  readonly #canvas: HTMLCanvasElement;
  readonly #theme: Theme;
  readonly #hooks: InteractionHooks<Hit>;
  #mode: DragMode = 'orbit';
  #tooltip: HTMLDivElement | undefined;
  #outline: SVGSVGElement | undefined;
  #path: number[] = [];
  #dragging = false;
  #frame = 0;
  #last: { x: number; y: number } | undefined;
  #hit: Hit | null = null;
  #controlsWere = true;
  readonly #abort = new AbortController();

  constructor(canvas: HTMLCanvasElement, theme: Theme, hooks: InteractionHooks<Hit>) {
    this.#canvas = canvas;
    this.#theme = theme;
    this.#hooks = hooks;
    const signal = this.#abort.signal;
    canvas.addEventListener('pointermove', (e) => this.#move(e), { signal });
    canvas.addEventListener('pointerleave', () => this.#leave(), { signal });
    canvas.addEventListener('pointerdown', (e) => this.#down(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.#up(e), { signal });
    canvas.addEventListener('pointercancel', () => this.#cancel(), { signal });
  }

  get mode(): DragMode {
    return this.#mode;
  }
  set mode(mode: DragMode) {
    const controls = this.#hooks.controls();
    if (this.#mode === 'orbit' && mode !== 'orbit' && controls) {
      this.#controlsWere = controls.enabled;
      controls.enabled = false;
    } else if (this.#mode !== 'orbit' && mode === 'orbit' && controls) controls.enabled = this.#controlsWere;
    this.#mode = mode;
    this.#canvas.style.cursor = mode === 'orbit' ? '' : 'crosshair';
  }

  /** The hit under the pointer, or null. */
  get hovered(): Hit | null {
    return this.#hit;
  }

  #local(e: PointerEvent): { x: number; y: number } {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  #host(): HTMLElement {
    const host = this.#canvas.parentElement ?? document.body;
    if (host !== document.body && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    return host;
  }

  #move(e: PointerEvent): void {
    const p = this.#local(e);
    if (this.#dragging) {
      if (this.#mode === 'lasso') this.#path.push(p.x, p.y);
      else this.#path.splice(2, 2, p.x, p.y);
      this.#draw();
      return;
    }
    // No picking while a button is held (the camera is moving).
    if (e.buttons) {
      this.#leave();
      return;
    }
    this.#last = p;
    this.#frame ||= requestAnimationFrame(() => {
      this.#frame = 0;
      if (this.#last) this.update(this.#last.x, this.#last.y);
    });
  }

  /** Picks at (x, y), moves the tooltip there and reports a changed hit. */
  update(x: number, y: number): Hit | null {
    const hit = this.#hooks.pick(x, y);
    if (hit?.layer !== this.#hit?.layer || hit?.index !== this.#hit?.index) {
      this.#hit = hit;
      this.#hooks.hover(hit);
    }
    const text = hit ? this.#hooks.describe(hit) : null;
    if (!text) {
      if (this.#tooltip) this.#tooltip.hidden = true;
      return hit;
    }
    const tip = (this.#tooltip ??= this.#makeTooltip());
    tip.textContent = text;
    tip.hidden = false;
    const left = this.#canvas.offsetLeft + x + 14,
      top = this.#canvas.offsetTop + y + 14,
      maxLeft = this.#canvas.offsetLeft + this.#canvas.clientWidth - tip.offsetWidth - 4;
    tip.style.left = `${Math.max(this.#canvas.offsetLeft, Math.min(left, maxLeft))}px`;
    tip.style.top = `${top}px`;
    return hit;
  }

  #makeTooltip(): HTMLDivElement {
    const tip = document.createElement('div');
    tip.setAttribute('role', 'tooltip');
    tip.dataset.scivizTooltip = '';
    const t = this.#theme;
    tip.style.cssText = `position: absolute; z-index: 2; pointer-events: none; white-space: pre; padding: 5px 8px; border-radius: 4px; font: 12px system-ui, sans-serif; font-variant-numeric: tabular-nums; color: ${t.text}; background: ${t.background}e6; border: 1px solid ${t.grid}; box-shadow: 0 2px 8px #0004`;
    this.#host().append(tip);
    return tip;
  }

  #leave(): void {
    this.#last = undefined;
    if (this.#tooltip) this.#tooltip.hidden = true;
    if (this.#hit !== null) {
      this.#hit = null;
      this.#hooks.hover(null);
    }
  }

  #down(e: PointerEvent): void {
    if (this.#mode === 'orbit' || e.button !== 0) return;
    const p = this.#local(e);
    this.#dragging = true;
    this.#path = [p.x, p.y, p.x, p.y];
    this.#canvas.setPointerCapture?.(e.pointerId);
    if (this.#tooltip) this.#tooltip.hidden = true;
    e.preventDefault();
    this.#draw();
  }

  #up(e: PointerEvent): void {
    if (!this.#dragging) return;
    this.#dragging = false;
    this.#canvas.releasePointerCapture?.(e.pointerId);
    const path = this.#path;
    this.#outline?.replaceChildren();
    if (this.#mode === 'box') this.#hooks.select({ rect: [path[0], path[1], path[2], path[3]] });
    else if (path.length >= 6) this.#hooks.select({ polygon: Float64Array.from(path) });
  }

  #cancel(): void {
    this.#dragging = false;
    this.#outline?.replaceChildren();
  }

  #draw(): void {
    if (!this.#outline) {
      const svg = document.createElementNS(SVG, 'svg');
      svg.style.cssText = 'position: absolute; z-index: 1; pointer-events: none; overflow: visible';
      this.#host().append(svg);
      this.#outline = svg;
    }
    const svg = this.#outline;
    svg.style.left = `${this.#canvas.offsetLeft}px`;
    svg.style.top = `${this.#canvas.offsetTop}px`;
    svg.setAttribute('width', String(this.#canvas.clientWidth));
    svg.setAttribute('height', String(this.#canvas.clientHeight));
    const p = this.#path;
    const shape = document.createElementNS(SVG, this.#mode === 'box' ? 'rect' : 'polygon');
    if (this.#mode === 'box') {
      shape.setAttribute('x', String(Math.min(p[0], p[2])));
      shape.setAttribute('y', String(Math.min(p[1], p[3])));
      shape.setAttribute('width', String(Math.abs(p[2] - p[0])));
      shape.setAttribute('height', String(Math.abs(p[3] - p[1])));
    } else shape.setAttribute('points', p.join(' '));
    shape.setAttribute('fill', `${this.#theme.text}22`);
    shape.setAttribute('stroke', this.#theme.text);
    shape.setAttribute('stroke-dasharray', '4 3');
    svg.replaceChildren(shape);
  }

  /** Removes the listeners, the tooltip and the outline. */
  dispose(): void {
    this.#abort.abort();
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#tooltip?.remove();
    this.#outline?.remove();
  }
}
