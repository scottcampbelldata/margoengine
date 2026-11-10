/// <reference lib="esnext.disposable" preserve="true" />
import type { Label, LabelLayout, LayoutContext } from './renderer.js';
import { rangeError } from '../../shared/errors.js';

/** A visible cluster, including its original label handles for picking and drill-down. */
export interface LabelClusterInfo {
  readonly members: readonly Label[];
  readonly count: number;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly element: HTMLElement;
}
/** Pixel clustering configuration. Recomputed from projected anchors on every layout update. */
export interface ClusterLabelsOptions {
  /** Maximum neighbor distance in CSS pixels; connected neighbors form a cluster. Default 40. */
  radius?: number;
  /** Minimum group count shown as a bubble. Default 2. */
  minCount?: number;
  /** Logical zoom level supplied by the application. Default 0. Projection changes always recluster. */
  zoom?: number;
  /** Disable clusters above this logical zoom. Default Infinity. */
  maxZoom?: number;
  /** CSS class on count bubbles. Default 'margo-label-cluster'. */
  className?: string;
  /** Optional layout for the unclustered labels. */
  layout?: LabelLayout;
}
interface Bucket {
  indices: number[];
  first: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Optional screen-space label clustering. A radius graph is grouped into connected components,
 * with a count bubble at each component's centroid. Camera zoom/motion recomputes the groups.
 */
export class ClusterLabels implements LabelLayout {
  readonly radius: number;
  readonly minCount: number;
  readonly maxZoom: number;
  readonly layout?: LabelLayout;
  private level: number;
  private readonly className: string;
  private readonly bubbles = new Map<Label, HTMLElement>();
  private result: LabelClusterInfo[] = [];
  /** Exact distance tests in the latest update; no elapsed-time measurement. */
  comparisons = 0;
  constructor(options: ClusterLabelsOptions = {}) {
    this.radius = options.radius ?? 40;
    this.minCount = options.minCount ?? 2;
    this.maxZoom = options.maxZoom ?? Infinity;
    this.level = options.zoom ?? 0;
    this.className = options.className ?? 'margo-label-cluster';
    this.layout = options.layout;
    if (
      !Number.isFinite(this.radius) ||
      this.radius < 1 ||
      !Number.isInteger(this.minCount) ||
      this.minCount < 2 ||
      !Number.isFinite(this.level) ||
      !(this.maxZoom >= 0)
    )
      throw rangeError('use radius >= 1, integer minCount >= 2, finite zoom and maxZoom >= 0', 'labels');
  }
  /** Count bubbles from the latest update. Members preserve input order. */
  get clusters(): readonly LabelClusterInfo[] {
    return this.result;
  }
  /** Updates the optional logical zoom limit; screen projection still controls spatial grouping. */
  setZoom(zoom: number): this {
    if (!Number.isFinite(zoom)) throw rangeError('zoom must be finite', 'labels');
    this.level = zoom;
    return this;
  }
  arrange(labels: readonly Label[], context: LayoutContext): void {
    this.comparisons = 0;
    this.result = [];
    if (this.level > this.maxZoom) {
      this.removeUnused(new Set());
      this.layout?.arrange(labels, context);
      return;
    }
    const n = labels.length,
      parent = Array.from({ length: n }, (_, i) => i),
      rank = new Uint8Array(n);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a: number, b: number): void => {
      a = find(a);
      b = find(b);
      if (a === b) return;
      if (rank[a] < rank[b]) parent[a] = b;
      else {
        parent[b] = a;
        if (rank[a] === rank[b]) rank[a]++;
      }
    };
    const grid = new Map<string, Bucket>(),
      cell = this.radius / Math.SQRT2;
    for (let i = 0; i < n; i++) {
      const { x, y } = labels[i].screen;
      if (!Number.isFinite(x) || !Number.isFinite(y))
        throw rangeError('cluster anchors must have finite projected coordinates', 'labels');
      const cx = Math.floor(x / cell),
        cy = Math.floor(y / cell),
        key = `${cx},${cy}`;
      const own = grid.get(key);
      // Every cell's diagonal is <= radius, so its contents are already connected.
      if (own) union(i, own.first);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const bucket = grid.get(`${cx + dx},${cy + dy}`);
          if (!bucket || find(i) === find(bucket.first)) continue;
          const nx = Math.max(bucket.minX, Math.min(x, bucket.maxX)),
            ny = Math.max(bucket.minY, Math.min(y, bucket.maxY));
          if (Math.hypot(nx - x, ny - y) > this.radius) continue;
          for (const j of bucket.indices) {
            this.comparisons++;
            if (Math.hypot(labels[j].screen.x - x, labels[j].screen.y - y) <= this.radius) {
              union(i, bucket.first);
              break;
            }
          }
        }
      if (own) {
        own.indices.push(i);
        own.minX = Math.min(own.minX, x);
        own.maxX = Math.max(own.maxX, x);
        own.minY = Math.min(own.minY, y);
        own.maxY = Math.max(own.maxY, y);
      } else grid.set(key, { indices: [i], first: i, minX: x, maxX: x, minY: y, maxY: y });
    }
    const groups = new Map<number, Label[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      let group = groups.get(root);
      if (!group) groups.set(root, (group = []));
      group.push(labels[i]);
    }
    const singles: Label[] = [],
      used = new Set<Label>();
    for (const members of groups.values()) {
      if (members.length < this.minCount) {
        for (const member of members) singles.push(member);
        continue;
      }
      let x = 0,
        y = 0;
      for (const member of members) {
        context.hide(member);
        x += member.screen.x / members.length;
        y += member.screen.y / members.length;
      }
      const representative = members[0];
      used.add(representative);
      let element = this.bubbles.get(representative);
      if (!element) {
        element = context.root.ownerDocument.createElement('div');
        element.className = this.className;
        element.setAttribute('data-margoengine-cluster', '');
        Object.assign(element.style, {
          position: 'absolute',
          transform: 'translate(-50%, -50%)',
          borderRadius: '999px',
          background: '#2457d6',
          color: '#fff',
          padding: '6px 9px',
          font: '600 12px system-ui',
          pointerEvents: 'auto',
          zIndex: '1',
        });
        this.bubbles.set(representative, element);
      }
      const count = String(members.length);
      if (element.textContent !== count) element.textContent = count;
      if (element.style.left !== `${x}px`) element.style.left = `${x}px`;
      if (element.style.top !== `${y}px`) element.style.top = `${y}px`;
      if (element.parentElement !== context.root) context.root.appendChild(element);
      this.result.push({ members, count: members.length, x, y, zoom: this.level, element });
    }
    this.removeUnused(used);
    this.layout?.arrange(singles, context);
  }
  private removeUnused(used: Set<Label>): void {
    for (const [label, element] of this.bubbles)
      if (!used.has(label)) {
        element.remove();
        this.bubbles.delete(label);
      }
  }
  /** Removes bubbles immediately. The next arrange may build them again. */
  clear(): void {
    this.removeUnused(new Set());
    this.result = [];
  }
  dispose(): void {
    this.clear();
  }
  [Symbol.dispose](): void {
    this.clear();
  }
}
