// Optional categorical scales, RGB traces and hierarchical heatmaps. Clean room from published descriptions.
import type { Figure } from './figure.js';
import { RectsLayer, packColour } from './rects.js';
import { rangeError } from '../../shared/errors.js';
import { colormap, type Colormap } from './colormaps.js';

/** Ordered unique categories, output interval default [0,1], paddingInner .1, paddingOuter .05. */
export interface BandOptions {
  readonly range?: readonly [number, number];
  readonly paddingInner?: number;
  readonly paddingOuter?: number;
}
/** Owned category order, absolute bandwidth and signed step in output coordinates. */
export interface BandScale {
  readonly domain: readonly string[];
  readonly bandwidth: number;
  readonly step: number;
  start(category: string): number;
  center(category: string): number;
  invert(position: number): string | undefined;
}
/** Equal categorical bands, including reversed output intervals. Unknown categories map to NaN. */
export function bandScale(categories: readonly string[], options: BandOptions = {}): BandScale {
  const [a, b] = options.range ?? [0, 1],
    inner = options.paddingInner ?? 0.1,
    outer = options.paddingOuter ?? 0.05;
  if (
    !categories.length ||
    new Set(categories).size !== categories.length ||
    ![a, b, inner, outer].every(Number.isFinite) ||
    a === b ||
    inner < 0 ||
    inner >= 1 ||
    outer < 0
  )
    throw rangeError('Use unique nonempty categories, a finite nonzero range and paddingInner in [0,1)', 'sciviz');
  const domain = [...categories],
    step = (b - a) / (categories.length - inner + 2 * outer),
    bandwidth = Math.abs(step) * (1 - inner),
    index = new Map(domain.map((c, i) => [c, i])),
    start = (c: string) => {
      const i = index.get(c);
      return i === undefined ? NaN : a + step * (outer + i) + (step < 0 ? -bandwidth : 0);
    };
  return {
    domain,
    bandwidth,
    step,
    start,
    center: (c) => start(c) + bandwidth / 2,
    invert: (p) => {
      const i = Math.floor((p - a) / step - outer),
        c = domain[i];
      if (c === undefined) return undefined;
      const s = start(c);
      return p >= s && p <= s + bandwidth ? c : undefined;
    },
  };
}
/** Stable seed-based jitter, centered on each band; width defaults to 80% of its bandwidth. */
export function jitterCategories(
  values: readonly string[],
  scale: BandScale,
  options: { readonly seed?: number; readonly width?: number } = {},
): Float64Array {
  const width = options.width ?? 0.8,
    seed = options.seed ?? 1;
  if (!Number.isFinite(width) || width < 0 || width > 1 || !Number.isSafeInteger(seed))
    throw rangeError('Use jitter width in [0,1] and an integer seed', 'sciviz');
  let state = seed >>> 0;
  return Float64Array.from(values, (c) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return scale.center(c) + (state / 4294967296 - 0.5) * width * scale.bandwidth;
  });
}
/** Packed row-major RGB/RGBA bytes, origin top-left. Extent defaults [0,width,0,height]. */
export interface RGBImage {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  readonly channels?: 3 | 4;
}
/** Image coordinate extent and optional legend name. */
export interface ImageTraceOptions {
  readonly extent?: readonly [number, number, number, number];
  readonly name?: string;
}
/** One native instanced rectangle per pixel; exact sRGB bytes, including SVG export. Alpha is composited against the Figure background. */
export function imageTrace(figure: Figure, image: RGBImage, options: ImageTraceOptions = {}): RectsLayer {
  const { width, height, data, channels = 3 } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 1048576 ||
    (channels !== 3 && channels !== 4) ||
    data.length !== width * height * channels
  )
    throw rangeError('Supply an RGB/RGBA image with integer dimensions and at most 1048576 pixels', 'sciviz');
  const e = options.extent ?? [0, width, 0, height];
  if (!e.every(Number.isFinite) || e[1] <= e[0] || e[3] <= e[2])
    throw rangeError('Use an increasing finite image extent [xmin,xmax,ymin,ymax]', 'sciviz');
  const rects = new Float32Array(width * height * 4),
    values = new Float32Array(width * height),
    colors = new Uint32Array(width * height),
    bg = figure.theme.background.match(/[0-9a-f]{2}/gi)!.map((v) => parseInt(v, 16) / 255);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const k = j * width + i,
        p = k * channels;
      for (let c = 0; c < channels; c++)
        if (!Number.isInteger(data[p + c]) || data[p + c] < 0 || data[p + c] > 255)
          throw rangeError('Image channels must be integer bytes in [0,255]', 'sciviz');
      const alpha = channels === 4 ? data[p + 3] / 255 : 1,
        rgb = [0, 1, 2].map((c) => (data[p + c] / 255) * alpha + bg[c] * (1 - alpha));
      colors[k] = packColour(rgb[0], rgb[1], rgb[2]);
      values[k] = (data[p] + data[p + 1] + data[p + 2]) / 3;
      rects.set(
        [
          e[0] + (i * (e[1] - e[0])) / width,
          e[3] - ((j + 1) * (e[3] - e[2])) / height,
          e[0] + ((i + 1) * (e[1] - e[0])) / width,
          e[3] - (j * (e[3] - e[2])) / height,
        ],
        k * 4,
      );
    }
  return figure.addChartLayer(
    new RectsLayer(figure.renderer, 'heatmap', rects, values, colors, { name: options.name, swatch: '#808080' }),
  );
}
/** Hierarchy merge: leaf indices are 0..n-1, each merge has index n+i. Distances use Euclidean row vectors. */
export interface ClusterMerge {
  readonly left: number;
  readonly right: number;
  readonly distance: number;
  readonly size: number;
}
/** Owned stepwise dendrogram and deterministic compatible leaf order. */
export interface HierarchicalClustering {
  readonly merges: readonly ClusterMerge[];
  readonly order: readonly number[];
}
/** Agglomerative single/complete/size-weighted average linkage. Default average, deterministic ties by cluster index. Max 256 rows. */
export function hierarchicalCluster(
  rows: readonly ArrayLike<number>[],
  linkage: 'single' | 'complete' | 'average' = 'average',
): HierarchicalClustering {
  const n = rows.length,
    cols = rows[0]?.length ?? 0;
  if (
    n < 1 ||
    n > 256 ||
    cols < 1 ||
    !['single', 'complete', 'average'].includes(linkage) ||
    rows.some((r) => r.length !== cols || Array.from(r).some((v) => !Number.isFinite(v)))
  )
    throw rangeError('Cluster 1..256 equally sized finite vectors with single, complete or average linkage', 'sciviz');
  const dist = Array.from({ length: 2 * n - 1 }, () => new Float64Array(2 * n - 1)),
    size = Array(2 * n - 1).fill(1),
    active = new Set(Array.from({ length: n }, (_, i) => i)),
    merges: ClusterMerge[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++) {
      let d = 0;
      for (let k = 0; k < cols; k++) d = Math.hypot(d, rows[i][k] - rows[j][k]);
      if (!Number.isFinite(d))
        throw rangeError('Rescale cluster values so Euclidean distances are representable', 'sciviz');
      dist[i][j] = dist[j][i] = d;
    }
  while (active.size > 1) {
    let a = -1,
      b = -1,
      best = Infinity;
    for (const i of active)
      for (const j of active)
        if (i < j && dist[i][j] < best) {
          a = i;
          b = j;
          best = dist[i][j];
        }
    const id = n + merges.length;
    merges.push({ left: a, right: b, distance: best, size: size[a] + size[b] });
    size[id] = size[a] + size[b];
    for (const k of active)
      if (k !== a && k !== b)
        dist[id][k] = dist[k][id] =
          linkage === 'single'
            ? Math.min(dist[a][k], dist[b][k])
            : linkage === 'complete'
              ? Math.max(dist[a][k], dist[b][k])
              : dist[a][k] * (size[a] / size[id]) + dist[b][k] * (size[b] / size[id]);
    active.delete(a);
    active.delete(b);
    active.add(id);
  }
  const order: number[] = [];
  const visit = (id: number) => {
    if (id < n) order.push(id);
    else {
      const m = merges[id - n];
      visit(m.left);
      visit(m.right);
    }
  };
  visit(2 * n - 2);
  return { merges, order };
}
/** Dendrogram segments as x0,y0,x1,y1 in leaf-index/distance coordinates. */
export function dendrogramSegments(clustering: HierarchicalClustering): Float64Array {
  const n = clustering.order.length;
  if (!n || clustering.merges.length !== n - 1)
    throw rangeError('Use a complete hierarchical clustering result', 'sciviz');
  const x = Array(2 * n - 1).fill(0),
    y = Array(2 * n - 1).fill(0),
    out: number[] = [];
  clustering.order.forEach((v, i) => (x[v] = i + 0.5));
  clustering.merges.forEach((m, i) => {
    if (m.left < 0 || m.right < 0 || m.left >= n + i || m.right >= n + i || !Number.isFinite(m.distance))
      throw rangeError('Use backward cluster references and finite distances', 'sciviz');
    const a = m.left,
      b = m.right,
      k = n + i;
    x[k] = (x[a] + x[b]) / 2;
    y[k] = m.distance;
    out.push(x[a], y[a], x[a], y[k], x[a], y[k], x[b], y[k], x[b], y[k], x[b], y[b]);
  });
  return Float64Array.from(out);
}
/** Both row and column dendrograms, with a reordered native heatmap. Inputs are row-major. */
export interface ClusterHeatmapOptions {
  readonly linkage?: 'single' | 'complete' | 'average';
  readonly colormap?: Colormap;
  readonly name?: string;
}
/** Native heatmap trace, owned reorderings, attached dendrogram and combined SVG exporter. */
export interface ClusterHeatmap {
  readonly layer: RectsLayer;
  readonly rows: HierarchicalClustering;
  readonly columns: HierarchicalClustering;
  readonly dendrogram: SVGSVGElement;
  toSVG(): Promise<string>;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Cluster both dimensions and render attached, resize-aware row/column dendrograms. Figure remains caller owned. */
export function dendrogramHeatmap(
  figure: Figure,
  matrix: readonly ArrayLike<number>[],
  options: ClusterHeatmapOptions = {},
): ClusterHeatmap {
  if (!matrix.length || matrix[0].length > 256)
    throw rangeError('Use a nonempty matrix with at most 256 columns', 'sciviz');
  const rows = hierarchicalCluster(matrix, options.linkage),
    columns = hierarchicalCluster(
      Array.from({ length: matrix[0].length }, (_, j) => matrix.map((r) => r[j])),
      options.linkage,
    ),
    ny = matrix.length,
    nx = matrix[0].length,
    values = rows.order.flatMap((i) => columns.order.map((j) => matrix[i][j])),
    lo = Math.min(...values),
    hi = Math.max(...values),
    map = options.colormap ?? colormap('viridis'),
    colors = new Uint32Array(values.length),
    rects = new Float32Array(values.length * 4);
  values.forEach((v, k) => {
    const c = map.sample(hi > lo ? (v - lo) / (hi - lo) : 0.5);
    colors[k] = packColour(c[0], c[1], c[2]);
    const i = k % nx,
      j = Math.floor(k / nx);
    rects.set(
      [
        0.18 + (0.8 * i) / nx,
        0.18 + (0.8 * (ny - j - 1)) / ny,
        0.18 + (0.8 * (i + 1)) / nx,
        0.18 + (0.8 * (ny - j)) / ny,
      ],
      k * 4,
    );
  });
  const layer = figure.addChartLayer(
    new RectsLayer(figure.renderer, 'heatmap', rects, Float32Array.from(values), colors, {
      name: options.name,
      swatch: '#808080',
    }),
  );
  figure.setLimits([0, 1, 0, 1]);
  const canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas,
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.dataset.scivizDendrogram = '';
  svg.style.cssText = 'position:absolute;pointer-events:none;z-index:2';
  canvas.parentElement!.append(svg);
  const draw = () => {
    const p = figure.plotArea,
      b = figure.bounds,
      pixel = (x: number, y: number) => [
        p.x + ((x - b[0]) * p.width) / (b[1] - b[0]),
        p.y + (1 - (y - b[2]) / (b[3] - b[2])) * p.height,
      ],
      segments = (c: HierarchicalClustering, vertical: boolean) => {
        const a = dendrogramSegments(c),
          max = c.merges.at(-1)?.distance || 1;
        let d = '';
        for (let i = 0; i < a.length; i += 4) {
          const point = (k: number) =>
            vertical
              ? pixel(0.18 - (0.15 * a[k + 1]) / max, 0.98 - (0.8 * a[k]) / c.order.length)
              : pixel(0.18 + (0.8 * a[k]) / c.order.length, 0.18 - (0.15 * a[k + 1]) / max);
          d += `M${point(i)}L${point(i + 2)}`;
        }
        return d;
      };
    svg.setAttribute('width', String(canvas.clientWidth));
    svg.setAttribute('height', String(canvas.clientHeight));
    svg.style.left = canvas.offsetLeft + 'px';
    svg.style.top = canvas.offsetTop + 'px';
    svg.innerHTML = `<path d="${segments(rows, true)} ${segments(columns, false)}" fill="none" stroke="${figure.theme.text}" stroke-width="1.5"/>`;
  };
  const resize = new ResizeObserver(draw);
  resize.observe(canvas);
  const off = figure.engine.onFrame(draw);
  draw();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    off();
    resize.disconnect();
    svg.remove();
    figure.remove(layer);
  };
  return {
    layer,
    rows,
    columns,
    dendrogram: svg,
    async toSVG() {
      draw();
      return (await figure.toSVG()).replace('</svg>', svg.innerHTML + '</svg>');
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}
