import type { Label, LabelLayout, LayoutContext } from './renderer.js';
import { rangeError } from '../../shared/errors.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Options of Callouts: the layout run first and how the leader lines look. */
export interface CalloutsOptions {
  /** Layout run first, for example `new Declutter()`; its hide and place decisions are kept. Default none. */
  layout?: LabelLayout | null;
  /** Line and dot colour, any CSS colour. Default `'currentColor'`, the overlay's text colour. */
  color?: string;
  /** Line width in CSS pixels. Default 1. */
  width?: number;
  /** Radius of the dot drawn on the point, in CSS pixels; 0 draws none. Default 2. */
  dot?: number;
  /** Lines shorter than this, in CSS pixels, are not drawn (the label is next to its point). Default 2. */
  minLength?: number;
  /** Optional class name of the SVG element that holds the lines, for styling them with CSS. */
  className?: string;
}

interface Line {
  readonly line: Element;
  readonly dot: Element | null;
  readonly cache: Record<string, string>;
  readonly dotCache: Record<string, string>;
  frame: number;
}

const checkLength = (value: number, message: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw rangeError(message, 'labels');
  return value;
};
const text = (value: number): string => String(Math.round(value * 100) / 100 || 0);

/**
 * A label layout that draws leader lines: for every shown label whose box does not cover its projected point (one
 * moved off it with `screenOffset`, or placed away by another layout), a line from the point to the nearest point of
 * the label's box, with a dot on the point. Lines sit in one SVG under the labels. Pass it as the renderer's
 * `layout`; wrap another layout with the `layout` option.
 */
export class Callouts implements LabelLayout {
  /** Layout run first; its hide and place decisions are kept. */
  layout: LabelLayout | null;
  readonly color: string;
  readonly width: number;
  readonly dot: number;
  readonly minLength: number;
  /** The SVG element holding the lines, made at the first update; null after `clear()`. */
  svg: Element | null = null;
  /** Lines drawn at the last update. */
  lines = 0;
  /** SVG attribute writes made during the last update (0 on a still frame). */
  writes = 0;
  private readonly className: string;
  private readonly records = new Map<Label, Line>();
  private readonly hidden = new Set<Label>();
  private readonly anchors = new Map<Label, readonly [number, number]>();
  private frame = 0;
  private outer: LayoutContext | null = null;
  /** The context the wrapped layout gets: the renderer's, with each hide and place recorded on the way through. */
  private readonly recorder: LayoutContext;

  constructor(options: CalloutsOptions = {}) {
    this.layout = options.layout ?? null;
    this.color = options.color ?? 'currentColor';
    this.width = checkLength(options.width ?? 1, 'width must be a finite number of CSS pixels, 0 or more');
    this.dot = checkLength(options.dot ?? 2, 'dot must be a finite number of CSS pixels, 0 or more');
    this.minLength = checkLength(options.minLength ?? 2, 'minLength must be a finite number of CSS pixels, 0 or more');
    this.className = options.className ?? '';
    const self = this;
    this.recorder = {
      get width() {
        return self.outer!.width;
      },
      get height() {
        return self.outer!.height;
      },
      get root() {
        return self.outer!.root;
      },
      size: (label) => this.outer!.size(label),
      hide: (label) => {
        this.outer!.hide(label);
        this.hidden.add(label);
      },
      place: (label, anchor) => {
        this.outer!.place(label, anchor);
        this.anchors.set(label, [anchor[0], anchor[1]]);
      },
    };
  }

  arrange(labels: readonly Label[], context: LayoutContext): void {
    this.outer = context;
    this.hidden.clear();
    this.anchors.clear();
    this.layout?.arrange(labels, this.recorder);
    this.writes = 0;
    this.lines = 0;
    const frame = ++this.frame;
    for (const label of labels) {
      if (this.hidden.has(label)) continue;
      const anchor = this.anchors.get(label) ?? label.anchor,
        [dx, dy] = label.screenOffset;
      // A box on its own point (no offset, anchor inside the element) needs no line, and no measuring.
      if (dx === 0 && dy === 0 && anchor[0] >= 0 && anchor[0] <= 1 && anchor[1] >= 0 && anchor[1] <= 1) continue;
      const [w0, h0] = context.size(label),
        w = w0 * label.scale,
        h = h0 * label.scale,
        x = label.screen.x,
        y = label.screen.y,
        left = x + dx - anchor[0] * w,
        top = y + dy - anchor[1] * h;
      // The nearest point of the box to the projected point.
      const ex = Math.min(Math.max(x, left), left + w),
        ey = Math.min(Math.max(y, top), top + h);
      if (Math.hypot(ex - x, ey - y) < this.minLength) continue;
      const record = this.line(label, context.root);
      record.frame = frame;
      this.set(record.line, record.cache, 'x1', text(x));
      this.set(record.line, record.cache, 'y1', text(y));
      this.set(record.line, record.cache, 'x2', text(ex));
      this.set(record.line, record.cache, 'y2', text(ey));
      this.set(record.line, record.cache, 'display', 'inline');
      if (record.dot) {
        this.set(record.dot, record.dotCache, 'cx', text(x));
        this.set(record.dot, record.dotCache, 'cy', text(y));
        this.set(record.dot, record.dotCache, 'display', 'inline');
      }
      this.lines++;
    }
    // Lines of labels not drawn this update are hidden; those of removed labels are deleted.
    for (const [label, record] of this.records) {
      if (record.frame === frame) continue;
      if (label.owner === null) {
        record.line.remove();
        record.dot?.remove();
        this.records.delete(label);
        continue;
      }
      this.set(record.line, record.cache, 'display', 'none');
      if (record.dot) this.set(record.dot, record.dotCache, 'display', 'none');
    }
  }

  /** Removes the SVG and every line; the next update starts again. */
  clear(): void {
    this.svg?.remove();
    this.svg = null;
    this.records.clear();
  }

  private line(label: Label, root: HTMLElement): Line {
    const svg = this.mount(root);
    let record = this.records.get(label);
    if (!record) {
      const document = svg.ownerDocument,
        line = document.createElementNS(SVG, 'line'),
        dot = this.dot > 0 ? document.createElementNS(SVG, 'circle') : null;
      line.setAttribute('stroke', this.color);
      line.setAttribute('stroke-width', String(this.width));
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
      if (dot) {
        dot.setAttribute('r', String(this.dot));
        dot.setAttribute('fill', this.color);
        svg.appendChild(dot);
      }
      this.records.set(label, (record = { line, dot, cache: {}, dotCache: {}, frame: 0 }));
    }
    return record;
  }
  private mount(root: HTMLElement): Element {
    let svg = this.svg;
    if (!svg) {
      svg = root.ownerDocument.createElementNS(SVG, 'svg');
      if (this.className) svg.setAttribute('class', this.className);
      svg.setAttribute('aria-hidden', 'true');
      const style = (svg as unknown as HTMLElement).style;
      style.position = 'absolute';
      style.left = '0px';
      style.top = '0px';
      style.width = '100%';
      style.height = '100%';
      style.overflow = 'visible';
      style.pointerEvents = 'none';
      style.zIndex = '0';
      this.svg = svg;
    }
    // Under every label (first child of the overlay), and again in a new overlay after the renderer is set up anew.
    if (svg.parentElement !== root) root.insertBefore(svg, root.firstChild);
    return svg;
  }
  private set(element: Element, cache: Record<string, string>, name: string, value: string): void {
    if (cache[name] === value) return;
    cache[name] = value;
    element.setAttribute(name, value);
    this.writes++;
  }
}
