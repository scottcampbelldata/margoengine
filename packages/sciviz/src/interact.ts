// Pointer interaction for a figure: hover picking with an HTML tooltip (one pick per animation frame), box or lasso
// selection drawn as an SVG outline over the canvas, and for 2D charts drag to pan, wheel to zoom about the pointer
// and double-click to reset. The figure supplies the picking, selection and navigation; this file owns only the DOM:
// listeners, the tooltip element and the outline.
import type { Theme } from './axes.js';
import type { SelectRegion } from './pick.js';

/**
 * How a left-button drag on the canvas acts: move the view (`'orbit'` in 3D, `'pan'` in 2D; the two are the same
 * setting), or select points in a box or a lasso.
 */
export type DragMode = 'orbit' | 'pan' | 'box' | 'lasso';

const navigating = (mode: DragMode): boolean => mode === 'orbit' || mode === 'pan';

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
  /** 2D navigation: pan by a pointer move in CSS pixels, zoom by a factor about a point, reset the view. */
  readonly navigate?: {
    pan(dx: number, dy: number): void;
    zoom(factor: number, x: number, y: number): void;
    reset(): void;
  };
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
  #panning: { x: number; y: number; id: number } | undefined;
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
    if (hooks.navigate) {
      const navigate = hooks.navigate;
      this.#mode = 'pan';
      canvas.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          // Lines and pages are about 16 and 400 pixels; 400 pixels of wheel halve or double the span.
          const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1),
            p = this.#local(e);
          navigate.zoom(2 ** (pixels / 400), p.x, p.y);
        },
        { signal, passive: false },
      );
      canvas.addEventListener('dblclick', () => navigate.reset(), { signal });
      canvas.style.touchAction = 'none';
    }
  }

  get mode(): DragMode {
    return this.#mode;
  }
  set mode(mode: DragMode) {
    const controls = this.#hooks.controls();
    if (navigating(this.#mode) && !navigating(mode) && controls) {
      this.#controlsWere = controls.enabled;
      controls.enabled = false;
    } else if (!navigating(this.#mode) && navigating(mode) && controls) controls.enabled = this.#controlsWere;
    // A 2D chart reports its navigation mode as 'pan', a 3D figure as 'orbit'.
    this.#mode = navigating(mode) ? (this.#hooks.navigate ? 'pan' : 'orbit') : mode;
    this.#canvas.style.cursor = navigating(mode) ? '' : 'crosshair';
  }

  /** The hit under the pointer, or null. */
  get hovered(): Hit | null {
    return this.#hit;
  }

  #local(e: MouseEvent): { x: number; y: number } {
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
    if (this.#panning && e.pointerId === this.#panning.id) {
      this.#hooks.navigate!.pan(p.x - this.#panning.x, p.y - this.#panning.y);
      this.#panning = { ...this.#panning, x: p.x, y: p.y };
      return;
    }
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
    if (e.button !== 0) return;
    const p = this.#local(e);
    if (navigating(this.#mode)) {
      if (!this.#hooks.navigate) return;
      this.#panning = { x: p.x, y: p.y, id: e.pointerId };
      this.#canvas.setPointerCapture?.(e.pointerId);
      this.#leave();
      e.preventDefault();
      return;
    }
    this.#dragging = true;
    this.#path = [p.x, p.y, p.x, p.y];
    this.#canvas.setPointerCapture?.(e.pointerId);
    if (this.#tooltip) this.#tooltip.hidden = true;
    e.preventDefault();
    this.#draw();
  }

  #up(e: PointerEvent): void {
    if (this.#panning && e.pointerId === this.#panning.id) {
      this.#panning = undefined;
      this.#canvas.releasePointerCapture?.(e.pointerId);
      return;
    }
    if (!this.#dragging) return;
    this.#dragging = false;
    this.#canvas.releasePointerCapture?.(e.pointerId);
    const path = this.#path;
    this.#outline?.replaceChildren();
    if (this.#mode === 'box') this.#hooks.select({ rect: [path[0], path[1], path[2], path[3]] });
    else if (path.length >= 6) this.#hooks.select({ polygon: Float64Array.from(path) });
  }

  #cancel(): void {
    this.#panning = undefined;
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
