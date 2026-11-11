import { themeFont } from './theme-style.js';
// Optional chart presentation and interaction. Clean-room research: docs/clean-room.md, batch 177 job 4.
import type { Figure, Layer, LineLayer, ScatterLayer, LineLayerOptions, ScatterLayerOptions } from './figure.js';
import { RectsLayer } from './rects.js';
import { axisScale, type Scale } from './scales.js';
import { ticks } from './ticks.js';
import { rangeError, fault } from '../../shared/errors.js';
import { markupText, renderMarkup, type Markup } from './markup.js';
import { chartDataAdapters } from './chart-data.js';

/** Numeric display. Defaults: locale en-US, mode number, maximumFractionDigits 3. Dates use UTC unless timeZone is supplied. */
export interface NumberFormatOptions {
  readonly locale?: string;
  readonly mode?: 'number' | 'si' | 'engineering' | 'percent' | 'fixed' | 'date';
  readonly digits?: number;
  readonly date?: Intl.DateTimeFormatOptions;
}
/** Locale-aware number/date formatting using ECMA-402, with explicit SI and engineering powers of 1000. */
export function numberFormatter(options: NumberFormatOptions = {}): (value: number) => string {
  const { locale = 'en-US', mode = 'number', digits = 3 } = options;
  if (!Number.isInteger(digits) || digits < 0 || digits > 15)
    throw rangeError('Set digits to an integer from 0 to 15', 'sciviz');
  if (mode === 'date') {
    const fmt = new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...options.date,
    });
    return (v) => fmt.format(v);
  }
  if (!['number', 'si', 'engineering', 'percent', 'fixed'].includes(mode))
    throw rangeError('Choose a supported number format mode', 'sciviz');
  const fmt = new Intl.NumberFormat(locale, {
      maximumFractionDigits: digits,
      minimumFractionDigits: mode === 'fixed' ? digits : 0,
      style: mode === 'percent' ? 'percent' : 'decimal',
    }),
    si = ['y', 'z', 'a', 'f', 'p', 'n', 'µ', 'm', '', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
  return (value) => {
    if (!Number.isFinite(value)) return String(value);
    if (mode !== 'si' && mode !== 'engineering') return fmt.format(Object.is(value, -0) ? 0 : value);
    let e = value === 0 ? 0 : 3 * Math.floor(Math.log10(Math.abs(value)) / 3);
    if (mode === 'si') e = Math.max(-24, Math.min(24, e));
    let v = e < -306 ? (value / 10 ** (e + 3)) * 1000 : value / 10 ** e;
    const rounded = Number(
      new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: digits }).format(v),
    );
    if (Math.abs(rounded) >= 1000) {
      e += 3;
      v = value / 10 ** e;
    }
    return fmt.format(v) + (mode === 'si' && e >= -24 && e <= 24 ? si[e / 3 + 8] : `e${e}`);
  };
}
/** A finite increasing domain and optional removed intervals. Gap is a fraction of the complete axis, default .035 per break. */
export interface BrokenScaleOptions {
  readonly domain: readonly [number, number];
  readonly breaks?: readonly (readonly [number, number])[];
  readonly gap?: number;
}
/** Axis mapping with normalized visible gaps and a partial inverse. */
export interface BrokenScale {
  readonly domain: readonly [number, number];
  readonly gaps: readonly (readonly [number, number])[];
  forward(value: number): number;
  inverse(position: number): number;
}
/** Piecewise affine mapping with visible gaps. Values in removed intervals map into the masked gaps; inverse returns NaN there. */
export function brokenScale(options: BrokenScaleOptions): BrokenScale {
  const [lo, hi] = options.domain,
    gap = options.gap ?? 0.035,
    b = (options.breaks ?? []).map((v) => [...v] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (
    !Number.isFinite(lo) ||
    !Number.isFinite(hi) ||
    hi <= lo ||
    !Number.isFinite(gap) ||
    gap < 0 ||
    gap * b.length >= 0.8 ||
    b.some(
      (v, i) => !v.every(Number.isFinite) || v[0] <= lo || v[1] >= hi || v[1] <= v[0] || (i > 0 && v[0] <= b[i - 1][1]),
    )
  )
    throw rangeError('Supply an increasing domain, disjoint interior breaks and a total gap below .8', 'sciviz');
  const removed = b.reduce((s, v) => s + v[1] - v[0], 0),
    scale = (1 - gap * b.length) / (hi - lo - removed),
    gaps: [number, number][] = [];
  let skipped = 0;
  b.forEach((v, i) => {
    const start = (v[0] - lo - skipped) * scale + i * gap;
    gaps.push([start, start + gap]);
    skipped += v[1] - v[0];
  });
  return {
    domain: [lo, hi],
    gaps,
    forward(v) {
      let skip = 0;
      for (let i = 0; i < b.length; i++) {
        const [a, z] = b[i];
        if (v < a) return (v - lo - skip) * scale + i * gap;
        if (v <= z) return gaps[i][0] + (gap * (v - a)) / (z - a);
        skip += z - a;
      }
      return (v - lo - skip) * scale + b.length * gap;
    },
    inverse(p) {
      let skip = 0;
      for (let i = 0; i < b.length; i++) {
        const [a, z] = gaps[i];
        if (p < a) return lo + skip + (p - i * gap) / scale;
        if (p <= z) return p === a ? b[i][0] : p === z ? b[i][1] : NaN;
        skip += b[i][1] - b[i][0];
      }
      return lo + skip + (p - b.length * gap) / scale;
    },
  };
}
/** Subdivide adjacent major ticks, excluding the majors themselves; default four minor ticks. */
export function minorTicks(major: readonly number[], count = 4): readonly number[] {
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    count > 100 ||
    major.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= major[i - 1]))
  )
    throw rangeError('Use increasing finite major ticks and minor count from 0 to 100', 'sciviz');
  return major
    .slice(1)
    .flatMap((v, i) => Array.from({ length: count }, (_, j) => major[i] + ((v - major[i]) * (j + 1)) / (count + 1)));
}
/** Replaces {name}, {x}, {y}, {value}, optionally followed by :fixed.N/:si/:percent/:date. Unknown placeholders remain literal. Output is text, never HTML. */
export function tooltipTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(name|x|y|value)(?::(fixed\.\d+|si|percent|date))?\}/g, (full, key, spec) => {
    const v = values[key];
    if (v === undefined) return full;
    if (typeof v === 'string') return v;
    if (!spec) return numberFormatter()(v);
    return numberFormatter(
      spec.startsWith('fixed.') ? { mode: 'fixed', digits: Number(spec.slice(6)) } : { mode: spec },
    )(v);
  });
}
// Set by a selection binding or density replacement on the source it hides while it draws that layer itself.
const LINKED_DRAW: unique symbol = Symbol.for('@margoengine/sciviz/linked-draw') as never;
type Shown = { visible?: boolean; [LINKED_DRAW]?: { visible: boolean } };
// What draws the layer: its replacement when bound (KB5736b), else its own source.
const drawn = (l: Layer): Shown | undefined => {
  const source = ('cloud' in l ? l.cloud : 'line' in l ? l.line : 'visible' in l ? l : undefined) as Shown | undefined;
  return source?.[LINKED_DRAW] ?? source;
};
const visible = (l: Layer) => drawn(l)?.visible !== false;
const visibility = (l: Layer, v: boolean) => {
  const shown = drawn(l);
  if (shown) shown.visible = v;
};
/** Chart domains default to existing data. Optional secondaryY has its own domain/label/format. Minor ticks default 4, crosshair and unified hover true, tooltip text template below. */
export interface ChartPolishOptions {
  /** Ordered band labels with numeric centers i+.5. */
  readonly categories?: { readonly x?: readonly string[]; readonly y?: readonly string[] };
  readonly x?: Partial<BrokenScaleOptions>;
  readonly y?: Partial<BrokenScaleOptions>;
  readonly secondaryY?: BrokenScaleOptions & { readonly label?: string; readonly format?: NumberFormatOptions };
  readonly xFormat?: NumberFormatOptions;
  readonly yFormat?: NumberFormatOptions;
  readonly xLabel?: string;
  readonly yLabel?: string;
  readonly minor?: number;
  readonly crosshair?: boolean;
  readonly unifiedHover?: boolean;
  readonly tooltip?: string;
  readonly signal?: AbortSignal;
}
/** A unified-hover observation in original data coordinates. */
export interface ChartHover {
  readonly layer: LineLayer | ScatterLayer;
  readonly index: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}
interface Trace {
  layer: LineLayer | ScatterLayer;
  x: Float64Array;
  y: Float64Array;
  secondary: boolean;
}
/** Controller extends a 2D Figure's existing line/scatter data, axis chrome, interactions and SVG export. */
export class ChartPolish extends EventTarget {
  readonly figure: Figure;
  readonly element: SVGSVGElement;
  readonly tooltip: HTMLDivElement;
  readonly x: BrokenScale;
  readonly y: BrokenScale;
  readonly secondaryY: BrokenScale | undefined;
  readonly #options: ChartPolishOptions;
  readonly #traces: Trace[] = [];
  readonly #abort = new AbortController();
  readonly #resize: ResizeObserver;
  readonly #oldScales: readonly [Scale, Scale, Scale];
  readonly #oldAxes: Promise<void>;
  readonly #legendObserver: MutationObserver;
  readonly #controls: HTMLElement[] = [];
  #legendElement: HTMLElement | undefined;
  #layoutKey = '';
  #frame: () => void;
  #hover: readonly ChartHover[] = [];
  #pointer: [number, number] | undefined;
  #disposed = false;
  #parent: ChartPolish | undefined;
  readonly #insets: {
    chart: ChartPolish;
    rect: readonly [number, number, number, number];
    host: HTMLElement;
    parent: Node;
    next: Node | null;
    style: string;
  }[] = [];
  /** Use polishFigure(), which waits for axis resources before attachment. */
  constructor(figure: Figure, options: ChartPolishOptions = {}) {
    super();
    if (chartDataAdapters.has(figure))
      throw fault('state', 'Reuse the existing chart controller or dispose it first', 'sciviz');
    options.signal?.throwIfAborted();
    minorTicks([0, 1], options.minor ?? 4);
    numberFormatter(options.xFormat);
    numberFormatter(options.yFormat);
    numberFormatter(options.secondaryY?.format);
    if (!figure.is2d) throw rangeError('Create a 2D Figure before polishing chart axes', 'sciviz');
    if (figure.layers.some((l) => !('cloud' in l) && !('line' in l)))
      throw rangeError(
        'Attach chart polish before adding images or heatmaps; existing traces must be lines or scatter',
        'sciviz',
      );
    this.figure = figure;
    this.#options = options;
    this.#oldScales = figure.axisScales;
    const b = figure.bounds,
      domain = (i: number): [number, number] => {
        const a = this.#oldScales[i].inverse(b[i * 2]),
          z = this.#oldScales[i].inverse(b[i * 2 + 1]);
        return a < z ? [a, z] : [a - 0.5, a + 0.5];
      };
    for (const labels of [options.categories?.x, options.categories?.y])
      if (labels && (!labels.length || new Set(labels).size !== labels.length))
        throw rangeError('Use nonempty unique categorical axis labels', 'sciviz');
    this.x = brokenScale({
      domain: options.x?.domain ?? (options.categories?.x ? [0, options.categories.x.length] : domain(0)),
      ...options.x,
    });
    this.y = brokenScale({
      domain: options.y?.domain ?? (options.categories?.y ? [0, options.categories.y.length] : domain(1)),
      ...options.y,
    });
    this.secondaryY = options.secondaryY ? brokenScale(options.secondaryY) : undefined;
    const canvas = this.canvas,
      host = canvas.parentElement;
    if (!host) throw rangeError('Place the figure canvas in a positioned container', 'sciviz');
    const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    root.dataset.scivizPolish = '';
    root.style.cssText = 'position:absolute;pointer-events:none;overflow:visible;z-index:2';
    host.append(root);
    this.element = root;
    this.tooltip = document.createElement('div');
    this.tooltip.dataset.scivizUnifiedHover = '';
    this.tooltip.style.cssText = `position:absolute;z-index:4;pointer-events:none;white-space:pre;font:${themeFont(figure.theme)};padding:8px;border:1px solid ${figure.theme.axis};color:${figure.theme.text};background:${figure.theme.background}`;
    this.tooltip.hidden = true;
    host.append(this.tooltip);
    for (const layer of figure.layers)
      if ('cloud' in layer || 'line' in layer) {
        const n = layer.positions.length / 3;
        this.#traces.push({
          layer,
          x: Float64Array.from({ length: n }, (_, i) => this.#oldScales[0].inverse(layer.positions[i * 3])),
          y: Float64Array.from({ length: n }, (_, i) => this.#oldScales[1].inverse(layer.positions[i * 3 + 1])),
          secondary: false,
        });
      }
    this.#oldAxes = figure.setAxes(false, options.signal);
    figure.setAxisScales([axisScale(), axisScale(), axisScale()]);
    figure.setLimits([0, 1, 0, 1]);
    this.#traces.forEach((t) => this.#upload(t));
    const signal = this.#abort.signal;
    canvas.addEventListener(
      'pointermove',
      (e) => {
        const r = canvas.getBoundingClientRect();
        this.#pointer = [e.clientX - r.left, e.clientY - r.top];
        this.#updateHover();
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerleave',
      () => {
        this.#pointer = undefined;
        this.#hover = [];
        this.tooltip.hidden = true;
        this.relayout();
      },
      { signal },
    );
    this.#legendObserver = new MutationObserver(() => this.#legendRows());
    this.#bindLegend();
    this.#resize = new ResizeObserver(() => this.relayout());
    this.#resize.observe(canvas);
    this.#frame = () => this.relayout();
    const off = figure.engine.onFrame(this.#frame);
    this.#frame = off;
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true, signal });
    chartDataAdapters.set(figure, {
      read: (layer) => {
        const t = this.#traces.find((t) => t.layer === layer);
        return t
          ? {
              x: t.x,
              y: t.y,
              color: layer.values,
              size: layer.kind === 'scatter' ? (layer.cloud.sizes ?? undefined) : undefined,
            }
          : undefined;
      },
      update: async (layer, data, signal) => {
        this.#check();
        const t = this.#traces.find((t) => t.layer === layer);
        if (!t) throw rangeError('Add the live trace through this chart controller before binding it', 'sciviz');
        const sy = t.secondary ? this.secondaryY! : this.y;
        await figure.updateData(
          layer,
          { ...data, x: Array.from(data.x, (v) => this.x.forward(v)), y: Array.from(data.y, (v) => sy.forward(v)) },
          { signal },
        );
        t.x = Float64Array.from(data.x);
        t.y = Float64Array.from(data.y);
        this.#updateHover();
      },
      forwardX: (value) => this.x.forward(value),
      inverseX: (value) => this.x.inverse(value),
    });
    this.relayout();
  }
  #bindLegend(): void {
    const legend = this.figure.legend?.element;
    if (legend === this.#legendElement) return;
    this.#legendElement = legend;
    this.#legendObserver.disconnect();
    const signal = this.#abort.signal;
    if (legend) {
      this.#legendObserver.observe(legend, { childList: true, subtree: true });
      legend.style.pointerEvents = 'auto';
      legend.style.zIndex = '4';
      legend.addEventListener('click', (e) => this.#legendClick(e, false), { signal });
      legend.addEventListener('dblclick', (e) => this.#legendClick(e, true), { signal });
      legend.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.#legendClick(e, e.shiftKey);
          }
        },
        { signal },
      );
      this.#legendRows();
    }
  }
  /** The figure's original canvas. */
  get canvas(): HTMLCanvasElement {
    return (this.figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
  }
  /** Last nearest-x observation from every visible trace, in data units. */
  get hover(): readonly ChartHover[] {
    return this.#hover;
  }
  /** Wait for the initial native axis removal. */
  ready(): Promise<void> {
    return this.#oldAxes;
  }
  #check() {
    if (this.#disposed) throw fault('disposed', 'Create a new chart polish controller after disposal', 'sciviz');
  }
  #upload(t: Trace) {
    const sy = t.secondary ? this.secondaryY! : this.y,
      p = t.layer.positions;
    for (let i = 0; i < t.x.length; i++) {
      p[i * 3] = this.x.forward(t.x[i]);
      p[i * 3 + 1] = sy.forward(t.y[i]);
      p[i * 3 + 2] = 0;
    }
    if ('cloud' in t.layer) t.layer.cloud.updatePositions(0, p);
    else t.layer.line.setPositions(p);
    const b = t.layer.bounds;
    for (let axis = 0; axis < 2; axis++) {
      let lo = Infinity,
        hi = -Infinity;
      for (let i = axis; i < p.length; i += 3)
        if (Number.isFinite(p[i])) {
          lo = Math.min(lo, p[i]);
          hi = Math.max(hi, p[i]);
        }
      b[axis * 2] = lo <= hi ? lo : 0;
      b[axis * 2 + 1] = lo <= hi ? hi : 1;
    }
  }
  /** Plot a line against the primary or secondary y scale; coordinates are retained for original-data hover. */
  async line(
    data: { readonly x: ArrayLike<number>; readonly y: ArrayLike<number> },
    options: LineLayerOptions & { readonly secondary?: boolean } = {},
  ): Promise<LineLayer> {
    this.#check();
    if (options.secondary && !this.secondaryY)
      throw rangeError('Configure secondaryY before adding a secondary trace', 'sciviz');
    const sy = options.secondary ? this.secondaryY! : this.y,
      layer = await this.figure.line(
        { x: Array.from(data.x, (v) => this.x.forward(v)), y: Array.from(data.y, (v) => sy.forward(v)) },
        options,
      );
    this.#traces.push({
      layer,
      x: Float64Array.from(data.x),
      y: Float64Array.from(data.y),
      secondary: options.secondary ?? false,
    });
    this.#legendRows();
    return layer;
  }
  /** Plot points against the primary or secondary y scale. */
  async scatter(
    data: { readonly x: ArrayLike<number>; readonly y: ArrayLike<number> },
    options: ScatterLayerOptions & { readonly secondary?: boolean } = {},
  ): Promise<ScatterLayer> {
    this.#check();
    if (options.secondary && !this.secondaryY)
      throw rangeError('Configure secondaryY before adding a secondary trace', 'sciviz');
    const sy = options.secondary ? this.secondaryY! : this.y,
      layer = await this.figure.scatter(
        { x: Array.from(data.x, (v) => this.x.forward(v)), y: Array.from(data.y, (v) => sy.forward(v)) },
        options,
      );
    this.#traces.push({
      layer,
      x: Float64Array.from(data.x),
      y: Float64Array.from(data.y),
      secondary: options.secondary ?? false,
    });
    this.#legendRows();
    return layer;
  }
  /** Change the visible x range in original data units; y ranges remain independent. */
  setRange(lo: number, hi: number): void {
    this.#check();
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo)
      throw rangeError('Use a finite increasing data zoom range', 'sciviz');
    const b = this.figure.bounds;
    this.figure.setLimits([this.x.forward(lo), this.x.forward(hi), b[2], b[3]]);
    this.relayout();
  }
  /** Hide or show a layer. Hidden layers are excluded from rendering, picks, selection, unified hover and SVG. */
  setVisible(layer: Layer, value: boolean): void {
    this.#check();
    if (!this.figure.layers.includes(layer)) throw rangeError('Choose a layer belonging to this figure', 'sciviz');
    visibility(layer, value);
    this.#legendRows();
    this.#updateHover();
  }
  #legendRows() {
    this.#bindLegend();
    this.figure.legend?.element.setAttribute('role', 'group');
    const rows = this.figure.legend?.element.querySelectorAll('[role="listitem"]') ?? [];
    for (const row of rows) {
      const r = row as HTMLElement;
      r.tabIndex = 0;
      r.setAttribute('role', 'button');
      r.setAttribute('data-chart-legend', '');
      r.style.minHeight = '24px';
      r.style.minWidth = '24px';
    }
    for (const row of this.figure.legend?.element.querySelectorAll('[data-chart-legend]') ?? []) {
      const name = row.textContent ?? '',
        layers = this.figure.layers.filter((l) => 'name' in l && l.name === name),
        on = layers.some(visible);
      row.setAttribute('aria-pressed', String(on));
      const style = (row as HTMLElement).style;
      style.opacity = on ? '1' : '.4';
      style.minHeight = style.minWidth = '24px';
    }
  }
  #legendClick(event: Event, isolate: boolean) {
    const row = (event.target as Element).closest('[data-chart-legend]');
    if (!row) return;
    const name = row.textContent,
      layers = this.figure.layers.filter((l) => 'name' in l && l.name);
    const own = layers.filter((l) => 'name' in l && l.name === name),
      allOtherHidden = layers.filter((l) => !own.includes(l)).every((l) => !visible(l));
    const targetVisible = !own.some(visible);
    for (const l of layers)
      if (isolate) visibility(l, allOtherHidden || own.includes(l));
      else if (own.includes(l)) visibility(l, targetVisible);
    this.#legendRows();
    this.#updateHover();
  }
  #pixel(x: number, y: number): [number, number] {
    const p = this.figure.plotArea,
      b = this.figure.bounds;
    return [p.x + (p.width * (x - b[0])) / (b[1] - b[0] || 1), p.y + p.height * (1 - (y - b[2]) / (b[3] - b[2] || 1))];
  }
  #updateHover() {
    if (!this.#pointer) return;
    const [px, py] = this.#pointer,
      p = this.figure.plotArea,
      b = this.figure.bounds,
      xp = b[0] + ((px - p.x) * (b[1] - b[0])) / p.width,
      raw = this.x.inverse(xp);
    this.#hover = [];
    if (px < p.x || px > p.x + p.width || py < p.y || py > p.y + p.height || !Number.isFinite(raw)) {
      this.tooltip.hidden = true;
      this.relayout();
      return;
    }
    const hits: ChartHover[] = [];
    for (const t of this.#traces) {
      if (!visible(t.layer) || !this.figure.layers.includes(t.layer)) continue;
      let i = -1,
        dist = Infinity;
      for (let j = 0; j < t.x.length; j++) {
        const d = Math.abs(t.x[j] - raw);
        if (Number.isFinite(t.y[j]) && d < dist) {
          i = j;
          dist = d;
        }
      }
      if (i >= 0) hits.push({ layer: t.layer, index: i, name: t.layer.name ?? 'Series', x: t.x[i], y: t.y[i] });
    }
    this.#hover = this.#options.unifiedHover === false ? hits.slice(0, 1) : hits;
    this.tooltip.textContent = this.#hover
      .map((h) =>
        tooltipTemplate(this.#options.tooltip ?? '{name}: {x} / {y}', { name: h.name, x: h.x, y: h.y, value: h.y }),
      )
      .join('\n');
    this.tooltip.hidden = !this.#hover.length;
    this.tooltip.style.left = `${this.canvas.offsetLeft + Math.min(px + 12, this.canvas.clientWidth - 210)}px`;
    this.tooltip.style.top = `${this.canvas.offsetTop + Math.max(0, py - 20)}px`;
    this.dispatchEvent(new CustomEvent('hover', { detail: this.#hover }));
    this.relayout();
  }
  #markup(): Markup[] {
    const p = this.figure.plotArea,
      b = this.figure.bounds,
      theme = this.figure.theme,
      xf = numberFormatter(this.#options.xFormat),
      yf = numberFormatter(this.#options.yFormat),
      out: Markup[] = [];
    const path = (d: string, c = theme.axis, w = theme.axisWidth ?? 1) =>
        out.push({ tag: 'path', attributes: { d, stroke: c, 'stroke-width': w, fill: 'none' } }),
      text = (x: number, y: number, s: string, anchor = 'middle') =>
        out.push({
          tag: 'text',
          attributes: {
            x,
            y,
            'text-anchor': anchor,
            fill: theme.text,
            'font-family': theme.fontFamily ?? 'system-ui',
            'font-size': theme.fontSize ?? 12,
          },
          children: [s],
        });
    const axis = (mapping: BrokenScale, vertical: boolean, secondary = false) => {
      const bound = (v: number, side: 0 | 1) => {
          const x = mapping.inverse(v);
          if (Number.isFinite(x)) return x;
          const g = mapping.gaps.find((g) => v > g[0] && v < g[1]);
          return g ? mapping.inverse(g[side]) : NaN;
        },
        low = bound(vertical ? b[2] : b[0], 1),
        high = bound(vertical ? b[3] : b[1], 0);
      if (!Number.isFinite(low) || !Number.isFinite(high)) return;
      const categories = secondary ? undefined : vertical ? this.#options.categories?.y : this.#options.categories?.x,
        major = (
          categories
            ? categories.map((_, i) => i + 0.5).filter((v) => v >= low && v <= high)
            : ticks(low, high, theme.tickCount ?? 6).values
        ).filter((v) => Number.isFinite(mapping.inverse(mapping.forward(v)))),
        fmt = categories
          ? (v: number) => categories[Math.floor(v)]
          : secondary
            ? numberFormatter(this.#options.secondaryY?.format)
            : vertical
              ? yf
              : xf;
      const pos = (v: number) =>
        this.#pixel(vertical ? b[1] : mapping.forward(v), vertical ? mapping.forward(v) : b[2]);
      for (const v of major) {
        const [x, y] = pos(v);
        if (vertical) {
          if (!secondary && theme.gridStyle !== 'none')
            path(`M${p.x},${y}h${p.width}`, theme.grid, theme.gridWidth ?? 1);
          path(`M${secondary ? p.x + p.width : p.x},${y}h${(secondary ? 1 : -1) * (theme.tickSize ?? 5)}`);
          text(secondary ? p.x + p.width + 9 : p.x - 9, y + 4, fmt(v), secondary ? 'start' : 'end');
        } else {
          if (theme.gridStyle !== 'none') path(`M${x},${p.y}v${p.height}`, theme.grid, theme.gridWidth ?? 1);
          path(`M${x},${p.y + p.height}v${theme.tickSize ?? 5}`);
          text(x, p.y + p.height + 20, fmt(v));
        }
      }
      for (const v of minorTicks(major, categories ? 0 : (this.#options.minor ?? 4))) {
        if (!Number.isFinite(mapping.inverse(mapping.forward(v)))) continue;
        const [x, y] = pos(v);
        path(
          vertical
            ? `M${secondary ? p.x + p.width : p.x},${y}h${(secondary ? 1 : -1) * (theme.tickSize === undefined ? 3 : theme.tickSize * 0.6)}`
            : `M${x},${p.y + p.height}v${theme.tickSize === undefined ? 3 : theme.tickSize * 0.6}`,
        );
      }
    };
    axis(this.x, false);
    axis(this.y, true);
    if (this.secondaryY) axis(this.secondaryY, true, true);
    path(`M${p.x},${p.y}h${p.width}v${p.height}h${-p.width}Z`);
    const gap = (mapping: BrokenScale, vertical: boolean) => {
      for (const [a, z] of mapping.gaps) {
        const pa = this.#pixel(a, a),
          pz = this.#pixel(z, z);
        if (vertical) {
          const y = pz[1],
            h = pa[1] - y;
          out.push({
            tag: 'rect',
            attributes: { x: p.x - 2, y, width: p.width + 4, height: h, fill: theme.background },
          });
          path(`M${p.x - 4},${y + 2}l8,-4M${p.x - 4},${y + h + 2}l8,-4`);
        } else {
          const x = pa[0],
            w = pz[0] - x;
          out.push({
            tag: 'rect',
            attributes: { x, y: p.y - 2, width: w, height: p.height + 4, fill: theme.background },
          });
          path(`M${x - 2},${p.y + p.height + 4}l4,-8M${x + w - 2},${p.y + p.height + 4}l4,-8`);
        }
      }
    };
    gap(this.x, false);
    gap(this.y, true);
    text(p.x + p.width / 2, this.canvas.clientHeight - 6, this.#options.xLabel ?? 'x');
    text(Math.max(8, p.x - 48), p.y - 5, this.#options.yLabel ?? 'y', 'start');
    if (this.secondaryY) text(p.x + p.width + 8, p.y - 5, this.#options.secondaryY?.label ?? 'y2', 'start');
    if (this.#pointer && this.#hover.length && (this.#options.crosshair ?? true)) {
      const [x, y] = this.#pointer;
      path(`M${x},${p.y}v${p.height}M${p.x},${y}h${p.width}`, theme.axis);
      for (const h of this.#hover) {
        const t = this.#traces.find((t) => t.layer === h.layer)!,
          [a, z] = this.#pixel(this.x.forward(h.x), (t.secondary ? this.secondaryY! : this.y).forward(h.y));
        path(`M${a},${p.y + p.height}V${z}H${p.x}`, theme.axis);
      }
    }
    return out;
  }
  /** Update axis chrome and inset layout after resize, zoom or data changes. Automatically called on figure frames. */
  relayout(): void {
    if (this.#disposed) return;
    const canvas = this.canvas;
    this.#bindLegend();
    const key = [
      canvas.clientWidth,
      canvas.clientHeight,
      canvas.offsetLeft,
      canvas.offsetTop,
      ...this.figure.bounds,
      JSON.stringify(this.figure.theme),
      ...(this.#pointer ?? []),
      ...this.#hover.flatMap((h) => [h.x, h.y]),
    ].join(',');
    if (key === this.#layoutKey) return;
    this.#layoutKey = key;
    this.element.setAttribute('width', String(canvas.clientWidth));
    this.element.setAttribute('height', String(canvas.clientHeight));
    this.element.style.left = canvas.offsetLeft + 'px';
    this.element.style.top = canvas.offsetTop + 'px';
    Object.assign(this.tooltip.style, {
      font: themeFont(this.figure.theme),
      color: this.figure.theme.text,
      background: this.figure.theme.background,
      borderColor: this.figure.theme.axis,
    });
    renderMarkup(this.element, 'http://www.w3.org/2000/svg', this.#markup());
    for (const i of this.#insets) {
      i.host.style.left = canvas.offsetLeft + i.rect[0] * canvas.clientWidth + 'px';
      i.host.style.top = canvas.offsetTop + i.rect[1] * canvas.clientHeight + 'px';
      i.host.style.width = i.rect[2] * canvas.clientWidth + 'px';
      i.host.style.height = i.rect[3] * canvas.clientHeight + 'px';
    }
  }
  /** Attach an independently configured inset Figure/controller at normalized [left,top,width,height]. Borrowed resources remain caller owned. */
  addInset(chart: ChartPolish, rect: readonly [number, number, number, number]): void {
    this.#check();
    chart.#check();
    for (let p: ChartPolish | undefined = this; p; p = p.#parent)
      if (p === chart) throw rangeError('Use an acyclic inset hierarchy', 'sciviz');
    if (chart.#parent) throw rangeError('Remove an inset from its current parent before attaching it again', 'sciviz');
    if (
      chart === this ||
      !rect.every(Number.isFinite) ||
      rect[0] < 0 ||
      rect[1] < 0 ||
      rect[2] <= 0 ||
      rect[3] <= 0 ||
      rect[0] + rect[2] > 1 ||
      rect[1] + rect[3] > 1
    )
      throw rangeError('Use a distinct inset and a positive rectangle inside [0,1]', 'sciviz');
    const host = chart.canvas.parentElement!,
      parent = host.parentNode!,
      next = host.nextSibling,
      style = host.style.cssText;
    host.style.position = 'absolute';
    host.style.zIndex = '3';
    this.canvas.parentElement!.append(host);
    chart.#parent = this;
    this.#insets.push({ chart, rect: [...rect], host, parent, next, style });
    this.#layoutKey = '';
    this.relayout();
  }
  /** Add two accessible zoom sliders and named trailing-span buttons. Domain defaults to the full x data domain. */
  rangeSelector(spans: readonly { readonly label: string; readonly span: number }[] = []): HTMLElement {
    this.#check();
    if (spans.some((v) => !Number.isFinite(v.span) || v.span <= 0))
      throw rangeError('Use positive finite range-selector spans', 'sciviz');
    const root = document.createElement('div');
    root.dataset.scivizRange = '';
    const [lo, hi] = this.x.domain,
      sliders = [0, 1].map((i) => {
        const s = document.createElement('input');
        s.type = 'range';
        s.min = '0';
        s.max = '1000';
        s.value = i ? '1000' : '0';
        s.setAttribute('aria-label', i ? 'Range end' : 'Range start');
        s.addEventListener(
          'input',
          () => {
            const a = Number(sliders[0].value) / 1000,
              z = Number(sliders[1].value) / 1000;
            if (a < z) this.setRange(lo + a * (hi - lo), lo + z * (hi - lo));
          },
          { signal: this.#abort.signal },
        );
        return s;
      });
    root.append(...sliders);
    for (const s of [...spans, { label: 'All', span: hi - lo }]) {
      const button = document.createElement('button');
      button.textContent = s.label;
      button.addEventListener(
        'click',
        () => {
          const a = Math.max(lo, hi - s.span);
          this.setRange(a, hi);
          sliders[0].value = String((1000 * (a - lo)) / (hi - lo));
          sliders[1].value = '1000';
        },
        { signal: this.#abort.signal },
      );
      root.append(button);
    }
    this.canvas.parentElement!.after(root);
    this.#controls.push(root);
    return root;
  }
  /** Export the Figure's vectors plus custom axes, breaks, spikes and nested insets. */
  async toSVG(): Promise<string> {
    this.#check();
    const base = await this.figure.toSVG();
    let body = markupText(this.#markup());
    for (const [index, i] of this.#insets.entries()) {
      const s = (await i.chart.toSVG())
        .replace(/id="([^"]+)"/g, (_, id) => `id="inset${index}-${id}"`)
        .replace(/url\(#([^)]*)\)/g, (_, id) => `url(#inset${index}-${id})`);
      body += s
        .replace(
          '<svg ',
          `<svg x="${i.rect[0] * this.canvas.clientWidth}" y="${i.rect[1] * this.canvas.clientHeight}" `,
        )
        .replace(
          /width="[^"]+" height="[^"]+"/,
          `width="${i.rect[2] * this.canvas.clientWidth}" height="${i.rect[3] * this.canvas.clientHeight}"`,
        );
    }
    return base.replace('</svg>', body + '</svg>');
  }
  /** Remove controller UI and listeners. The Figure and its layers remain caller owned. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    chartDataAdapters.delete(this.figure);
    this.#abort.abort();
    this.#resize.disconnect();
    this.#legendObserver.disconnect();
    this.#frame();
    this.element.remove();
    this.tooltip.remove();
    this.#controls.forEach((e) => e.remove());
    for (const i of this.#insets) {
      i.chart.#parent = undefined;
      i.host.style.cssText = i.style;
      i.parent.insertBefore(i.host, i.next?.parentNode === i.parent ? i.next : null);
    }
  }
  /** Same as dispose(), for using. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Attach chart presentation after native Figure resources settle. The caller owns controller disposal. */
export async function polishFigure(figure: Figure, options: ChartPolishOptions = {}): Promise<ChartPolish> {
  options.signal?.throwIfAborted();
  await figure.ready();
  options.signal?.throwIfAborted();
  const c = new ChartPolish(figure, options);
  await c.ready();
  return c;
}
