import { multiplyMatrices } from '@margoengine/math/mat4';
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure, Layer } from './figure.js';
import type { VectorGeometry } from './vector-types.js';

export type { VectorGeometry } from './vector-types.js';

/** A publication scene; the matrix maps data to reversed-Z WebGPU clip coordinates. */
export interface VectorScene {
  readonly width: number;
  readonly height: number;
  readonly matrix: ArrayLike<number>;
  readonly geometry: readonly VectorGeometry[];
  /** CSS background, default transparent. */
  readonly background?: string;
}
/** Bounded vector conversion. No geometry is silently dropped on budget exhaustion. */
export interface VectorExportOptions {
  /** Input triangle limit before colour subdivision, default 20000. */
  readonly maxTriangles?: number;
  /** Input line segments and points combined, default 50000. */
  readonly maxMarks?: number;
  /** Maximum generated facets including BSP fragments, default 200000. */
  readonly maxFragments?: number;
  /** Triangle colour subdivisions, 0..4, default 2 (16 facets per coloured triangle). */
  readonly colorDepth?: number;
  readonly signal?: AbortSignal;
  /** Entire SVG fallback, required when a standalone scene exceeds its budget. */
  readonly raster?: () => Promise<string>;
}
/** SVG plus an explicit machine-readable report of vector/raster choice. */
export interface VectorExport {
  readonly svg: string;
  readonly mode: 'vector' | 'raster';
  readonly reason?: string;
  readonly triangles: number;
  readonly fragments: number;
}
type V = number[]; // clip xyzw, then RGBA; after projection xyz, 1/w, RGBA/w
type Poly = V[];
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const mix = (a: V, b: V, t: number): V => a.map((x, i) => x + (b[i] - x) * t);
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const rgba = (v: V) => v.slice(4).map((x) => x / v[3]);
const fill = (p: Poly): string => {
  const v = p.reduce((a, b) => a.map((x, i) => x + b[i] / p.length), Array(8).fill(0));
  const c = rgba(v);
  return `fill="rgb(${c
    .slice(0, 3)
    .map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255))
    .join(' ')})" fill-opacity="${Math.max(0, Math.min(1, c[3]))}"`;
};
function cut(p: Poly, distance: (v: V) => number): Poly {
  const out: Poly = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length],
      da = distance(a),
      db = distance(b);
    if (da >= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) out.push(mix(a, b, da / (da - db)));
  }
  return out;
}
const planes = [
  (v: V) => v[3] + v[0],
  (v: V) => v[3] - v[0],
  (v: V) => v[3] + v[1],
  (v: V) => v[3] - v[1],
  (v: V) => v[2],
  (v: V) => v[3] - v[2],
  (v: V) => v[3] - 1e-12,
];
const project = (v: V): V => [v[0] / v[3], v[1] / v[3], v[2] / v[3], 1 / v[3], ...v.slice(4).map((x) => x / v[3])];
function plane(p: Poly): V | undefined {
  for (let i = 1; i + 1 < p.length; i++) {
    const a = p[0],
      b = p[i],
      c = p[i + 1],
      bx = b[0] - a[0],
      by = b[1] - a[1],
      bz = b[2] - a[2],
      cx = c[0] - a[0],
      cy = c[1] - a[1],
      cz = c[2] - a[2],
      d = bx * cy - by * cx;
    if (Math.abs(d) <= 1e-18) continue;
    const sign = Math.sign(d),
      nx = (by * cz - bz * cy) * sign,
      ny = (bz * cx - bx * cz) * sign,
      nz = Math.abs(d),
      length = Math.hypot(nx, ny, nz);
    const n = [nx / length, ny / length, nz / length];
    return [...n, n[0] * a[0] + n[1] * a[1] + n[2] * a[2]];
  }
  return undefined;
}
const distance = (v: V, p: V): number => p[0] * v[0] + p[1] * v[1] + p[2] * v[2] - p[3];
function sides(p: Poly, splitter: V): [boolean, boolean] {
  let front = false,
    back = false;
  for (const v of p) {
    const d = distance(v, splitter);
    front ||= d > 1e-10;
    back ||= d < -1e-10;
  }
  return [front, back];
}
function splitter(polys: Poly[]): { plane: V; polygon: Poly } {
  let best = plane(polys[0])!,
    polygon = polys[0],
    cost = Infinity;
  for (let s = 0; s < Math.min(polys.length, 9); s++) {
    const candidate = plane(polys[Math.floor((s * polys.length) / Math.min(polys.length, 9))])!;
    let a = 0,
      b = 0,
      splits = 0;
    for (const p of polys) {
      const [f, r] = sides(p, candidate);
      if (f) a++;
      if (r) b++;
      if (f && r) splits++;
    }
    const score = Math.max(a, b) + 8 * splits;
    if (score < cost) {
      cost = score;
      best = candidate;
      polygon = polys[Math.floor((s * polys.length) / Math.min(polys.length, 9))];
    }
  }
  return { plane: best, polygon };
}
const positive = (n: number, what: string) => {
  if (!Number.isSafeInteger(n) || n < 1)
    throw rangeError(`${what} must be a positive safe integer; reduce the scene or set a valid limit`, 'sciviz');
  return n;
};
const annotate = (svg: string, mode: string, reason?: string) =>
  svg.replace(/<svg\b/, `<svg data-sciviz-export="${mode}"${reason ? ` data-sciviz-fallback="${xml(reason)}"` : ''}`);

/** Clean-room clip, colour-facet and BSP painter export, with a bounded raster fallback. */
export async function exportVectorScene(scene: VectorScene, options: VectorExportOptions = {}): Promise<VectorExport> {
  const { signal } = options;
  signal?.throwIfAborted();
  const maxTriangles = positive(options.maxTriangles ?? 20000, 'maxTriangles'),
    maxMarks = positive(options.maxMarks ?? 50000, 'maxMarks'),
    maxFragments = positive(options.maxFragments ?? 200000, 'maxFragments'),
    depth = options.colorDepth ?? 2;
  if (
    !Number.isInteger(depth) ||
    depth < 0 ||
    depth > 4 ||
    !(scene.width > 0 && scene.height > 0) ||
    !Number.isFinite(scene.width + scene.height) ||
    scene.matrix.length !== 16 ||
    Array.from(scene.matrix).some((x) => !Number.isFinite(x))
  )
    throw rangeError('Set finite positive SVG dimensions, a finite 4x4 matrix and colorDepth in 0..4', 'sciviz');
  let triangles = 0,
    marks = 0,
    fragments = 0;
  for (const g of scene.geometry) {
    if (
      !['triangles', 'line', 'points'].includes(g.kind) ||
      g.positions.length % (g.kind === 'triangles' ? 9 : g.kind === 'line' && g.segments ? 6 : 3) ||
      (g.colors && g.colors.length !== (g.positions.length / 3) * 4) ||
      (g.sizes &&
        (g.sizes.length !== g.positions.length / 3 || Array.from(g.sizes).some((x) => !Number.isFinite(x) || x < 0))) ||
      (g.width !== undefined && (!(g.width > 0) || !Number.isFinite(g.width))) ||
      (g.shape !== undefined && !['round', 'square'].includes(g.shape))
    )
      throw rangeError(
        'Geometry needs complete xyz primitives, RGBA per vertex and positive CSS widths; repair the input',
        'sciviz',
      );
    if (g.colors && Array.from(g.colors).some((x) => !Number.isFinite(x) || x < 0 || x > 1))
      throw rangeError('Vector colours must be finite sRGB RGBA in 0..1; convert the input colours', 'sciviz');
    if (g.kind === 'triangles') triangles += g.positions.length / 9;
    else
      marks +=
        g.kind === 'line' && g.segments
          ? g.positions.length / 6
          : Math.max(0, g.positions.length / 3 - (g.kind === 'line' ? 1 : 0));
  }
  const fallback = async (reason: string): Promise<VectorExport> => {
    signal?.throwIfAborted();
    if (!options.raster)
      throw fault('unsupported', `${reason}; provide raster() or increase the vector budget`, 'sciviz');
    const svg = await options.raster();
    signal?.throwIfAborted();
    return { svg: annotate(svg, 'raster', reason), mode: 'raster', reason, triangles, fragments };
  };
  if (triangles > maxTriangles || marks > maxMarks)
    return fallback(`input limit: ${triangles} triangles, ${marks} marks`);
  const polys: Poly[] = [];
  const add = (p: Poly) => {
    if (plane(p)) polys.push(p);
  };
  const facet = (p: Poly, level: number) => {
    const todo: { p: Poly; level: number }[] = [{ p, level }];
    while (todo.length) {
      const item = todo.pop()!,
        [a, b, c] = item.p;
      if (!item.level) {
        add(item.p);
        continue;
      }
      const ab = mix(a, b, 0.5),
        bc = mix(b, c, 0.5),
        ca = mix(c, a, 0.5);
      for (const q of [
        [a, ab, ca],
        [ab, b, bc],
        [ca, bc, c],
        [ab, bc, ca],
      ])
        todo.push({ p: q, level: item.level - 1 });
    }
  };
  for (const g of scene.geometry) {
    const vertices: V[] = [],
      m = scene.matrix;
    for (let i = 0; i < g.positions.length / 3; i++) {
      if (i % 2048 === 0) {
        await pause();
        signal?.throwIfAborted();
      }
      const x = g.positions[i * 3],
        y = g.positions[i * 3 + 1],
        z = g.positions[i * 3 + 2];
      vertices.push(
        Array.from({ length: 4 }, (_, k) => m[k] * x + m[k + 4] * y + m[k + 8] * z + m[k + 12]).concat(
          g.colors ? Array.from({ length: 4 }, (_, k) => g.colors![i * 4 + k]) : [0.6, 0.78, 1, 1],
        ),
      );
    }
    for (let i = 0; i < vertices.length; i += g.kind === 'triangles' ? 3 : g.kind === 'line' && g.segments ? 2 : 1) {
      if (i % 1024 === 0) {
        await pause();
        signal?.throwIfAborted();
      }
      if (polys.length > maxFragments) {
        fragments = polys.length;
        return fallback('colour facet limit');
      }
      if (g.kind === 'triangles') {
        let p = vertices.slice(i, i + 3);
        if (p.some((v) => v.some((x) => !Number.isFinite(x)))) continue; // missing-data holes
        for (const f of planes) p = cut(p, f);
        p = p.map(project);
        const varying = g.colors && p.some((v) => rgba(v).some((c, k) => Math.abs(c - rgba(p[0])[k]) > 1e-6));
        for (let k = 1; k + 1 < p.length; k++) facet([p[0], p[k], p[k + 1]], varying ? depth : 0);
      } else if (g.kind === 'line') {
        if (i + 1 === vertices.length) continue;
        let a = vertices[i],
          b = vertices[i + 1];
        if ([...a, ...b].some((x) => !Number.isFinite(x))) continue;
        let visible = true;
        for (const f of planes) {
          const da = f(a),
            db = f(b);
          if (da < 0 && db < 0) {
            visible = false;
            break;
          }
          if (da < 0) a = mix(a, b, da / (da - db));
          else if (db < 0) b = mix(a, b, da / (da - db));
        }
        if (!visible) continue;
        a = project(a);
        b = project(b);
        const dx = (b[0] - a[0]) * scene.width,
          dy = (b[1] - a[1]) * scene.height,
          len = Math.hypot(dx, dy);
        if (!len) continue;
        const width = g.width ?? 2,
          ox = ((-dy / len) * width) / scene.width,
          oy = ((dx / len) * width) / scene.height;
        const offset = (v: V, sign: number): V => [v[0] + sign * ox, v[1] + sign * oy, ...v.slice(2)];
        // Split coloured strokes into 16 constant-colour depth-correct segments.
        const steps = g.colors ? 16 : 1;
        for (let k = 0; k < steps; k++) {
          const u = mix(a, b, k / steps),
            v = mix(a, b, (k + 1) / steps);
          add([offset(u, 1), offset(v, 1), offset(v, -1), offset(u, -1)]);
        }
      } else {
        const v = vertices[i];
        if (v.some((x) => !Number.isFinite(x)) || planes.some((f) => f(v) < 0)) continue;
        const p = project(v),
          n = g.shape === 'square' ? 4 : 24,
          size = g.sizes?.[i] ?? g.width ?? 3;
        add(
          Array.from({ length: n }, (_, k) => {
            const angle = (k * 2 * Math.PI) / n + (n === 4 ? Math.PI / 4 : 0),
              r = n === 4 ? Math.SQRT2 : 1;
            return [
              p[0] + (Math.cos(angle) * r * size) / scene.width,
              p[1] + (Math.sin(angle) * r * size) / scene.height,
              ...p.slice(2),
            ];
          }),
        );
      }
    }
  }
  fragments = polys.length;
  if (fragments > maxFragments) return fallback('colour facet limit');
  const ordered: Poly[] = [],
    tasks: { polys: Poly[]; emit?: boolean }[] = [{ polys }];
  let work = 0;
  while (tasks.length) {
    if (work++ % 32 === 0) {
      await pause();
      signal?.throwIfAborted();
    }
    const task = tasks.pop()!;
    if (task.emit || task.polys.length < 2) {
      for (const p of task.polys) ordered.push(p);
      continue;
    }
    const choice = splitter(task.polys),
      split = choice.plane,
      back: Poly[] = [],
      front: Poly[] = [],
      coplanar: Poly[] = [];
    for (const p of task.polys) {
      if (p === choice.polygon) {
        coplanar.push(p);
        continue;
      }
      const [f, b] = sides(p, split);
      if (f && b) {
        const a = cut(p, (v) => distance(v, split)),
          c = cut(p, (v) => -distance(v, split));
        if (plane(a)) front.push(a);
        if (plane(c)) back.push(c);
        if (++fragments > maxFragments) return fallback('BSP fragment limit');
      } else if (f) front.push(p);
      else if (b) back.push(p);
      else coplanar.push(p);
    }
    if (front.length) tasks.push({ polys: front });
    tasks.push({ polys: coplanar, emit: true });
    if (back.length) tasks.push({ polys: back });
  }
  const shapes: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (i % 2048 === 0) {
      await pause();
      signal?.throwIfAborted();
    }
    const p = ordered[i];
    shapes.push(
      `<path d="M${p.map((v) => `${((v[0] + 1) * scene.width) / 2},${((1 - v[1]) * scene.height) / 2}`).join('L')}Z" ${fill(p)}/>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" data-sciviz-export="vector"><desc>Depth-ordered BSP vector export; ${triangles} input triangles, ${fragments} fragments; colour subdivision ${depth}.</desc>${scene.background ? `<rect width="100%" height="100%" fill="${xml(scene.background)}"/>` : ''}<svg width="100%" height="100%" overflow="hidden">${shapes.join('')}</svg></svg>`;
  return { svg, mode: 'vector', triangles, fragments };
}

/** Export the current 3D figure, retaining its HTML text, colour bars and legend as SVG overlays. */
export async function exportVector(figure: Figure, options: VectorExportOptions = {}): Promise<VectorExport> {
  options.signal?.throwIfAborted();
  await figure.ready();
  options.signal?.throwIfAborted();
  figure.render();
  const geometry: VectorGeometry[] = [];
  for (const layer of figure.layers) {
    const provider = layer as Layer & {
      visible?: boolean;
      vectorSupported?: boolean;
      vectorGeometry?: (options: { signal?: AbortSignal }) => Promise<VectorGeometry>;
    };
    if (provider.visible === false) continue;
    if (provider.vectorGeometry && provider.vectorSupported !== false)
      geometry.push(await provider.vectorGeometry({ signal: options.signal }));
    else if ('kind' in layer && (layer.kind === 'line' || layer.kind === 'scatter')) {
      const { seriesSnapshot } = await import('./vector-snapshot.js');
      const style = seriesSnapshot(layer);
      if (!style.visible) continue;
      geometry.push(style);
    } else {
      const svg = await figure.toSVG({ vector: false });
      return {
        svg: annotate(svg, 'raster', 'unsupported layer'),
        mode: 'raster',
        reason: 'unsupported layer',
        triangles: 0,
        fragments: 0,
      };
    }
  }
  const { seriesSnapshot } = await import('./vector-snapshot.js');
  for (const line of figure.vectorAxes()) if (line.visible) geometry.push(seriesSnapshot(line));
  const canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas,
    box = canvas.getBoundingClientRect();
  const matrix = new Float64Array(16);
  multiplyMatrices(figure.engine.camera.matrix, figure.model, matrix);
  const result = await exportVectorScene(
    {
      width: box.width || canvas.width,
      height: box.height || canvas.height,
      matrix,
      geometry,
      background: figure.theme.background,
    },
    { ...options, raster: options.raster ?? (() => figure.toSVG({ vector: false })) },
  );
  if (result.mode === 'raster') return result;
  // Use the existing overlay collector without requiring any new figure-root rendering dependency.
  const overlay = await figure.toSVG({ vector: false });
  options.signal?.throwIfAborted();
  const body = result.svg.slice(result.svg.indexOf('>') + 1, result.svg.lastIndexOf('</svg>'));
  return { ...result, svg: annotate(overlay.replace(/<image\b[^>]*\/>/, body), 'vector') };
}
