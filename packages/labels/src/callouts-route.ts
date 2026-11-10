/// <reference lib="esnext.disposable" preserve="true" />
import type { Label, LabelLayout, LayoutContext } from './renderer.js';
import { rangeError, fault } from '../../shared/errors.js';

/** A leader from one input source to one reordered label port, with an angled elbow. */
export interface CalloutLeaderRoute {
  readonly source: number;
  readonly port: number;
  readonly points: readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
}
/** A finite projected point in CSS pixels. */
export type CalloutScreenPoint = readonly [number, number];
interface Node {
  id: number;
  blue: boolean;
  x: number;
  y: number;
}

// Integer coordinates in units of 2^-1074 represent every finite binary64 exactly.
function predicates(): (a: Node, b: Node, c: Node) => number {
  const bits = new DataView(new ArrayBuffer(8)),
    cache = new Map<number, bigint>();
  const integer = (n: number): bigint => {
    let v = cache.get(n);
    if (v !== undefined) return v;
    bits.setFloat64(0, n);
    const raw = bits.getBigUint64(0),
      exponent = Number((raw >> 52n) & 2047n);
    const mantissa = (raw & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
    v = (raw >> 63n ? -mantissa : mantissa) << BigInt(Math.max(0, exponent - 1));
    cache.set(n, v);
    return v;
  };
  return (a, b, c) => {
    const left = (b.x - a.x) * (c.y - a.y),
      right = (b.y - a.y) * (c.x - a.x),
      det = left - right,
      total = Math.abs(left) + Math.abs(right);
    if (Number.isFinite(det) && total > 1e-300 && Math.abs(det) > 16 * Number.EPSILON * total) return Math.sign(det);
    const ax = integer(a.x),
      ay = integer(a.y),
      exact = (integer(b.x) - ax) * (integer(c.y) - ay) - (integer(b.y) - ay) * (integer(c.x) - ax);
    return exact < 0n ? -1 : exact > 0n ? 1 : 0;
  };
}

/**
 * Crossing-free source/port assignment. Ports share one column, with distinct y coordinates;
 * bendX lies strictly between every source and that column. Labels may be reordered.
 * Each leader has one angled segment and one horizontal segment, meeting on bendX.
 * Coincident sources may share their origin; they never share a leader segment.
 */
export function routeCalloutLeaders(
  sources: readonly CalloutScreenPoint[],
  ports: readonly CalloutScreenPoint[],
  bendX: number,
): CalloutLeaderRoute[] {
  if (
    sources.length !== ports.length ||
    !Number.isFinite(bendX) ||
    [...sources, ...ports].some((p) => p.length !== 2 || !p.every(Number.isFinite))
  )
    throw rangeError('provide equal counts of finite 2D sources/ports and a finite bendX', 'labels');
  if (!sources.length) return [];
  const column = ports[0][0],
    side = column > bendX ? 1 : -1;
  if (
    column === bendX ||
    ports.some((p) => p[0] !== column) ||
    new Set(ports.map((p) => p[1])).size !== ports.length ||
    sources.some((p) => side * (bendX - p[0]) <= 0)
  )
    throw rangeError(
      'use distinct port heights in one column and place bendX strictly between all sources and ports',
      'labels',
    );
  const nodes: Node[] = [
    ...sources.map((p, id) => ({ id, blue: false, x: p[0] * side, y: p[1] })),
    ...ports.map((p, id) => ({ id, blue: true, x: bendX * side, y: p[1] })),
  ];
  const stack: Node[][] = [nodes],
    result: CalloutLeaderRoute[] = new Array(sources.length),
    orient = predicates();
  while (stack.length) {
    const task = stack.pop()!;
    if (!task.length) continue;
    // The extreme source puts every other point into the same angular half-plane.
    let pivot: Node | undefined;
    for (const p of task)
      if (
        !p.blue &&
        (!pivot || p.x < pivot.x || (p.x === pivot.x && (p.y < pivot.y || (p.y === pivot.y && p.id < pivot.id))))
      )
        pivot = p;
    if (!pivot) throw fault('state', 'unbalanced callout partition; check source/port counts', 'labels');
    const origin = pivot,
      order = task.filter((p) => p !== origin);
    order.sort((a, b) => {
      const az = a.x === origin.x && a.y === origin.y,
        bz = b.x === origin.x && b.y === origin.y;
      if (az !== bz) return az ? -1 : 1;
      const sign = orient(origin, a, b);
      if (sign) return -sign;
      return a.x - b.x || a.y - b.y || Number(a.blue) - Number(b.blue) || a.id - b.id;
    });
    let balance = 1,
      cut = -1;
    for (let i = 0; i < order.length; i++) {
      balance += order[i].blue ? -1 : 1;
      if (balance === 0) {
        cut = i;
        break;
      }
    }
    if (cut < 0 || !order[cut].blue)
      throw fault('state', 'unbalanced callout partition; check source/port counts', 'labels');
    const target = order[cut];
    result[origin.id] = {
      source: origin.id,
      port: target.id,
      points: [[...sources[origin.id]], [bendX, ports[target.id][1]], [...ports[target.id]]],
    };
    stack.push(order.slice(0, cut), order.slice(cut + 1));
  }
  return result;
}

/** Configuration for a crossing-free external callout column. */
export interface RoutedCalloutsOptions {
  /** Default auto: choose the side with more room. */
  side?: 'left' | 'right' | 'auto';
  /** Source-to-elbow and elbow-to-label minimum gap in CSS pixels. Default 16. */
  gap?: number;
  /** Gap between label boxes in CSS pixels. Default 4. */
  padding?: number;
  /** View edge margin in CSS pixels. Default 8. */
  margin?: number;
  /** Stroke color, default currentColor. */
  color?: string;
  /** Stroke width in CSS pixels, default 1. */
  width?: number;
  /** Permit the callout column to extend beyond the view when it cannot fit. Default true. */
  overflow?: boolean;
}
interface RouteElement {
  element: Element;
  points: string;
}

/**
 * One-column external callout layout. Reorders label slots with a planar matching, places
 * boxes without overlaps, and draws one angled elbow per label in a shared SVG.
 */
export class RoutedCallouts implements LabelLayout {
  private readonly options: Required<RoutedCalloutsOptions>;
  private readonly records = new Map<Label, RouteElement>();
  private root?: HTMLElement;
  private originalOverflow = '';
  /** Shared SVG, created at the first nonempty update. */
  svg: Element | null = null;
  /** Routes in the most recent update, in the input label order. */
  routes: readonly CalloutLeaderRoute[] = [];
  /** Number of SVG geometry writes in the last update, zero on a still frame. */
  writes = 0;
  constructor(options: RoutedCalloutsOptions = {}) {
    this.options = {
      side: options.side ?? 'auto',
      gap: options.gap ?? 16,
      padding: options.padding ?? 4,
      margin: options.margin ?? 8,
      color: options.color ?? 'currentColor',
      width: options.width ?? 1,
      overflow: options.overflow ?? true,
    };
    const o = this.options;
    if (
      !['left', 'right', 'auto'].includes(o.side) ||
      ![o.gap, o.padding, o.margin, o.width].every(Number.isFinite) ||
      o.gap <= 0 ||
      o.width <= 0 ||
      o.padding < 0 ||
      o.margin < 0
    )
      throw rangeError('use a valid side, positive finite gap/width and nonnegative finite padding/margin', 'labels');
  }
  arrange(labels: readonly Label[], context: LayoutContext): void {
    this.writes = 0;
    if (!labels.length) {
      this.routes = [];
      for (const r of this.records.values()) r.element.remove();
      this.records.clear();
      return;
    }
    const sizes = labels.map((l) => {
      const [w, h] = context.size(l);
      return [w * l.scale, h * l.scale] as const;
    });
    if (sizes.some((s) => !s.every((v) => Number.isFinite(v) && v > 0)))
      throw rangeError('routed callouts require nonzero finite measured label boxes', 'labels');
    const maxWidth = Math.max(...sizes.map((s) => s[0])),
      maxHeight = Math.max(...sizes.map((s) => s[1]));
    const minX = Math.min(...labels.map((l) => l.screen.x)),
      maxX = Math.max(...labels.map((l) => l.screen.x));
    const { gap, margin, padding, overflow } = this.options;
    const side = this.options.side === 'auto' ? (minX >= context.width - maxX ? 'left' : 'right') : this.options.side;
    const right = side === 'right';
    const column = right
      ? Math.max(context.width - margin - maxWidth, maxX + 2 * gap)
      : Math.min(margin + maxWidth, minX - 2 * gap);
    const bendX = column + (right ? -gap : gap),
      total = labels.length * maxHeight + (labels.length - 1) * padding;
    const meanY = labels.reduce((sum, l) => sum + l.screen.y / labels.length, 0);
    const top = Math.max(margin, Math.min(context.height - margin - total, meanY - total / 2));
    if (
      !overflow &&
      (column - (right ? 0 : maxWidth) < 0 ||
        column + (right ? maxWidth : 0) > context.width ||
        top + total > context.height - margin)
    )
      throw rangeError(
        'callout column does not fit the viewport; enable overflow or reduce label count/size',
        'labels',
      );
    const ports = labels.map((_, i) => [column, top + i * (maxHeight + padding) + maxHeight / 2] as const);
    this.routes = routeCalloutLeaders(
      labels.map((l) => [l.screen.x, l.screen.y] as const),
      ports,
      bendX,
    );
    this.mount(context.root);
    const used = new Set<Label>();
    for (const route of this.routes) {
      const label = labels[route.source],
        [w, h] = sizes[route.source],
        port = route.points[2];
      used.add(label);
      const left = right ? column : column - w,
        labelTop = port[1] - h / 2;
      context.place(label, [
        (label.screen.x + label.screenOffset[0] - left) / w,
        (label.screen.y + label.screenOffset[1] - labelTop) / h,
      ]);
      let r = this.records.get(label);
      if (!r) {
        const element = context.root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        element.setAttribute('fill', 'none');
        element.setAttribute('stroke', this.options.color);
        element.setAttribute('stroke-width', String(this.options.width));
        element.setAttribute('stroke-linejoin', 'round');
        this.svg!.appendChild(element);
        this.records.set(label, (r = { element, points: '' }));
      }
      const points = route.points.map((p) => p.join(',')).join(' ');
      if (r.points !== points) {
        r.element.setAttribute('points', points);
        r.points = points;
        this.writes++;
      }
    }
    for (const [label, r] of this.records)
      if (!used.has(label)) {
        r.element.remove();
        this.records.delete(label);
      }
  }
  private mount(root: HTMLElement): void {
    if (this.root !== root) {
      this.restoreOverflow();
      this.root = root;
      this.originalOverflow = root.style.overflow ?? '';
    }
    if (this.options.overflow && root.style.overflow !== 'visible') root.style.overflow = 'visible';
    if (!this.svg) {
      this.svg = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.svg.setAttribute('aria-hidden', 'true');
      Object.assign((this.svg as unknown as HTMLElement).style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: '0',
      });
    }
    if (this.svg.parentElement !== root) root.insertBefore(this.svg, root.firstChild);
  }
  private restoreOverflow(): void {
    if (this.root && this.options.overflow && this.root.style.overflow === 'visible')
      this.root.style.overflow = this.originalOverflow;
  }
  /** Removes every leader and restores the overlay's previous overflow style. */
  clear(): void {
    this.svg?.remove();
    this.svg = null;
    this.records.clear();
    this.routes = [];
    this.restoreOverflow();
    this.root = undefined;
  }
  dispose(): void {
    this.clear();
  }
  [Symbol.dispose](): void {
    this.clear();
  }
}
