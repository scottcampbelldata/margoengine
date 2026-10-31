// The `lines` entry: picking for @margoengine/lines. It takes the ray from the Raycaster, the one CPU picking path, and
// nothing that draws lines imports it, so lines cost nothing until something picks them. Line shapes are structural:
// this module has no dependency on the lines package.
import type { Engine, Mesh } from '@margoengine/core';
import type { MutableVec3 } from '@margoengine/math';
import { invertMatrix } from '@margoengine/math/mat4';
import { hiddenInTree } from '../../shared/visibility.js';
import type { BVHBuildOptions } from './build.js';
import { SegmentTree } from './segment-tree.js';

/** The ray fields `intersectLines` reads. A `Raycaster` has them all. */
export interface LinePickRay {
  readonly origin: ArrayLike<number>;
  /** Unit length, as `Raycaster` keeps it. */
  readonly direction: ArrayLike<number>;
  readonly near: number;
  readonly far: number;
  /** Return only the nearest hit. Default false. */
  readonly firstHitOnly?: boolean;
  /** Options for the segment BVHs built on demand. */
  readonly bvhOptions?: BVHBuildOptions;
}

/** The fields of a @margoengine/lines `Line` that picking reads. Helpers such as `GridHelper` are lines too. */
export interface PickableLine {
  readonly points: Float32Array;
  readonly count: number;
  readonly segmentCount: number;
  readonly mode: 'segments' | 'strip' | 'loop';
  readonly version: number;
  readonly visible: boolean;
  readonly matrix: ArrayLike<number>;
  readonly attachedMesh: Mesh | null;
  readonly material: {
    readonly width: number;
    readonly worldUnits: boolean;
    readonly clippingPlanes: readonly (readonly number[])[];
    readonly clipIntersection: boolean;
    validate(): void;
  };
  update(engine: never): boolean | void;
}

/** A camera and canvas size for pixel widths and tolerances, when picking without an `engine`. */
export interface LinePickView {
  /** View-projection matrix (column-major) with WebGPU clip depth, as lines draw with. */
  matrix: ArrayLike<number>;
  /** Canvas width in CSS pixels. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
}

/** Options for {@link intersectLines}. */
export interface LinePickOptions {
  /** Supplies the view, world matrices of attached lines and helper updates. An attached line needs it. */
  engine?: Engine;
  /** The view for pixel measures. Default: the engine's camera and canvas. */
  view?: LinePickView;
  /**
   * Least distance from the centre line that still hits, in `toleranceUnits`. A line drawn wider than this hits across
   * its drawn width instead. Default 3 pixels when there is a view; without one, 0, and a line with a pixel width needs
   * a world `tolerance` (it has no size in world units without a view).
   */
  tolerance?: number;
  /** 'pixels' (CSS pixels, default) or 'world'. Pixels need `engine` or `view`. */
  toleranceUnits?: 'pixels' | 'world';
  /** Run the transform kernel first so attached lines reflect transform edits since the last render. Default true. */
  refresh?: boolean;
}

/** One place a ray crosses a line. */
export interface LineHit<T extends PickableLine = PickableLine> {
  line: T;
  /** Index of the segment, 0 to `line.segmentCount - 1`; for a 'loop' the last one is the closing segment. */
  segment: number;
  /** The nearest point on the segment's centre line, in world space. */
  point: MutableVec3;
  /** World distance along the ray to `point`. */
  distance: number;
  /** World distance from the ray to `point`: how far off the centre line the pick landed. */
  offset: number;
}

// Structural views of the engine fields used, as in raycaster.ts: this module never imports core at runtime.
interface RuntimeEngine {
  store: { matrices: Float32Array; parents: Float32Array; hidden: Uint8Array; tick(culling?: boolean): void };
  meshes: Map<number, unknown>;
  camera: { matrix: ArrayLike<number>; update(aspect: number, webgpu: boolean): void };
  canvas: HTMLCanvasElement;
  backend: 'webgpu' | 'webgl2';
  disposed: boolean;
}

interface Updatable {
  update(engine: unknown): boolean | void;
}
interface Cached {
  tree: SegmentTree;
  version: number;
  count: number;
  mode: PickableLine['mode'];
}
const trees = new WeakMap<PickableLine, Cached>();

const endOf = (mode: PickableLine['mode'], count: number, segment: number): number =>
  mode === 'segments' ? segment * 2 + 1 : segment + 1 === count ? 0 : segment + 1;

function treeOf(line: PickableLine, options?: BVHBuildOptions): SegmentTree {
  const { version, mode, count } = line;
  let cached = trees.get(line);
  if (!cached || cached.version !== version || cached.mode !== mode || cached.count !== count) {
    const segments = line.segmentCount,
      pairs = new Uint32Array(segments * 2);
    for (let i = 0; i < segments; i++) {
      pairs[i * 2] = mode === 'segments' ? i * 2 : i;
      pairs[i * 2 + 1] = endOf(mode, count, i);
    }
    cached = { tree: new SegmentTree(line.points, 4, pairs, options), version, mode, count };
    trees.set(line, cached);
  }
  return cached.tree;
}

function checkOptions(ray: LinePickRay, options: LinePickOptions): void {
  const { tolerance, toleranceUnits = 'pixels', view } = options;
  if (!(ray.near >= 0) || !(ray.far >= ray.near)) throw new RangeError('Expected 0 <= near <= far on the ray');
  if (toleranceUnits !== 'pixels' && toleranceUnits !== 'world')
    throw new TypeError("Unknown toleranceUnits; use 'pixels' or 'world'");
  if (tolerance !== undefined && !(tolerance >= 0 && Number.isFinite(tolerance)))
    throw new RangeError('Line pick tolerance must be finite and not negative');
  if (view && !(view.width > 0 && view.height > 0 && view.matrix?.length === 16))
    throw new RangeError('Line pick view needs a 16-number matrix and a positive width and height');
}

/**
 * Tests lines against a ray: pass the `Raycaster` you set with `setFromEngine` or `setFromCamera`, so lines and meshes
 * share one ray and can be merged by `distance`. A segment hits when the pick lands within half its drawn width of the
 * centre line, or within `tolerance` if that is more. Each segment's area is a capsule: joins and ends count as round
 * whatever the material's join and cap, so a butt end picks up to half a width past where it is drawn.
 *
 * Dash gaps hit: a dashed line picks as one continuous line, so a hover does not flicker along it. Hidden lines (also
 * under a hidden mesh) are skipped, and so is a point cut away by the material's clipping planes. Hits behind the ray
 * origin or outside `near`..`far` do not count.
 *
 * Hits are sorted by distance. Neighbouring segments inside the tolerance count as one crossing and give one hit, the
 * segment closest to the ray; a line that crosses the ray twice gives two. Long lines use a BVH per line, built on the
 * first pick and again after the line changes (`line.version`; a dashed line bumps it when its matrix moves).
 *
 * @throws TypeError for unknown units, an attached line without `engine`, or a pixel measure without a view.
 * @throws RangeError for a negative tolerance, a bad view or bad ray limits.
 */
export function intersectLines<T extends PickableLine>(
  ray: LinePickRay,
  lines: Iterable<T>,
  options: LinePickOptions = {},
): LineHit<T>[] {
  checkOptions(ray, options);
  const { engine, tolerance, toleranceUnits = 'pixels', refresh = true } = options,
    runtime = engine as unknown as RuntimeEngine | undefined;
  if (runtime?.disposed) throw new TypeError('Engine is disposed; pick lines on a live Engine');
  let view = options.view;
  if (runtime) {
    if (refresh) runtime.store.tick(false);
    if (!view) {
      const canvas = runtime.canvas;
      runtime.camera.update(canvas.width / canvas.height, runtime.backend === 'webgpu');
      view = {
        matrix: runtime.camera.matrix,
        width: canvas.clientWidth || canvas.width,
        height: canvas.clientHeight || canvas.height,
      };
    }
  }
  if (!view && tolerance !== undefined && toleranceUnits === 'pixels')
    throw new TypeError("A pixel tolerance needs a view; pass engine or view, or toleranceUnits: 'world'");
  const worldTolerance = toleranceUnits === 'world' ? (tolerance ?? 0) : 0,
    pixelTolerance = toleranceUnits === 'pixels' && view ? (tolerance ?? 3) : 0;
  const pick = view ? pixelView(ray, view) : null,
    hits: LineHit<T>[] = [];
  for (const line of lines) {
    if (!line.visible || (runtime && (line as unknown as Updatable).update(runtime) === false)) continue;
    const model = worldMatrix(line, runtime);
    if (!model || !line.segmentCount) continue;
    const material = line.material;
    material.validate();
    if (!view && !material.worldUnits && tolerance === undefined)
      throw new TypeError("A line with a pixel width needs a view; pass engine or view, or a 'world' tolerance");
    const worldRadius = Math.max(material.worldUnits ? material.width / 2 : 0, worldTolerance),
      pixelRadius = Math.max(material.worldUnits ? 0 : material.width / 2, pixelTolerance);
    crossings(line, model, ray, pick, worldRadius, pick ? pixelRadius : 0, hits);
  }
  hits.sort((a, b) => a.distance - b.distance);
  if (ray.firstHitOnly) hits.length = Math.min(hits.length, 1);
  return hits;
}

function worldMatrix(line: PickableLine, runtime: RuntimeEngine | undefined): ArrayLike<number> | null {
  const mesh = line.attachedMesh as unknown as { id: number; matrix?: Float32Array } | null;
  if (!mesh) return line.matrix;
  if (!runtime) throw new TypeError('An attached line needs the engine; pass engine in the pick options');
  if (runtime.meshes.get(mesh.id) !== mesh || hiddenInTree(runtime.store, mesh.id)) return null;
  return mesh.matrix ?? runtime.store.matrices.subarray(mesh.id * 16, mesh.id * 16 + 16);
}

interface PixelView {
  matrix: ArrayLike<number>;
  halfWidth: number;
  halfHeight: number;
  /** The pointer in pixels, or null when the ray does not run through the view. */
  pointer: [number, number] | null;
  /** World size of one pixel at clip w 1, the larger of the two axes. */
  worldPerPixel: number;
}

function pixelView(ray: LinePickRay, view: LinePickView): PixelView {
  const m = view.matrix,
    halfWidth = view.width / 2,
    halfHeight = view.height / 2,
    o = ray.origin,
    d = ray.direction,
    x = o[0] + d[0],
    y = o[1] + d[1],
    z = o[2] + d[2],
    w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return {
    matrix: m,
    halfWidth,
    halfHeight,
    pointer:
      w > 0
        ? [
            ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * halfWidth,
            ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * halfHeight,
          ]
        : null,
    worldPerPixel: Math.max(
      1 / (halfWidth * Math.hypot(m[0], m[4], m[8])),
      1 / (halfHeight * Math.hypot(m[1], m[5], m[9])),
    ),
  };
}

const INVERSE = new Float64Array(16),
  MODEL = new Float64Array(16);

/** Appends the line's crossings to `out`. */
function crossings<T extends PickableLine>(
  line: T,
  model: ArrayLike<number>,
  ray: LinePickRay,
  view: PixelView | null,
  worldRadius: number,
  pixelRadius: number,
  out: LineHit<T>[],
): void {
  for (let i = 0; i < 16; i++) MODEL[i] = model[i];
  if (!invertMatrix(MODEL, INVERSE)) return;
  const M = MODEL,
    I = INVERSE,
    o = ray.origin,
    d = ray.direction,
    { points, mode, count } = line,
    planes = line.material.clippingPlanes,
    anyPlane = !line.material.clipIntersection,
    found: LineHit<T>[] = [];
  const v = view?.matrix,
    depth = v
      ? [
          v[3] * M[0] + v[7] * M[1] + v[11] * M[2],
          v[3] * M[4] + v[7] * M[5] + v[11] * M[6],
          v[3] * M[8] + v[7] * M[9] + v[11] * M[10],
          v[3] * M[12] + v[7] * M[13] + v[11] * M[14] + v[15],
        ]
      : [0, 0, 0, 0],
    pointer = view?.pointer ?? null;
  const visit = (segment: number) => {
    const ia = (mode === 'segments' ? segment * 2 : segment) * 4,
      ib = endOf(mode, count, segment) * 4,
      ax = points[ia],
      ay = points[ia + 1],
      az = points[ia + 2],
      bx = points[ib],
      by = points[ib + 1],
      bz = points[ib + 2],
      a0 = M[0] * ax + M[4] * ay + M[8] * az + M[12],
      a1 = M[1] * ax + M[5] * ay + M[9] * az + M[13],
      a2 = M[2] * ax + M[6] * ay + M[10] * az + M[14],
      e0 = M[0] * bx + M[4] * by + M[8] * bz + M[12] - a0,
      e1 = M[1] * bx + M[5] * by + M[9] * bz + M[13] - a1,
      e2 = M[2] * bx + M[6] * by + M[10] * bz + M[14] - a2;
    let s = closestOnRay(o, d, a0, a1, a2, e0, e1, e2, ray.near, ray.far),
      gap = gapAt(o, d, a0 + s * e0, a1 + s * e1, a2 + s * e2);
    if (gap > worldRadius) {
      // Not in the world radius: the pixel test, on the projected segment as the shader draws it.
      if (!pointer || !view || !(pixelRadius > 0)) return;
      s = closestOnScreen(view, pointer, pixelRadius, a0, a1, a2, e0, e1, e2);
      if (s < 0) return;
      gap = gapAt(o, d, a0 + s * e0, a1 + s * e1, a2 + s * e2);
    }
    const point: MutableVec3 = [a0 + s * e0, a1 + s * e1, a2 + s * e2],
      distance = (point[0] - o[0]) * d[0] + (point[1] - o[1]) * d[1] + (point[2] - o[2]) * d[2];
    if (distance < ray.near || distance > ray.far) return;
    if (planes.length && clipped(planes, anyPlane, point)) return;
    found.push({ line, segment, point, distance, offset: gap });
  };
  const localDirection = [
    I[0] * d[0] + I[4] * d[1] + I[8] * d[2],
    I[1] * d[0] + I[5] * d[1] + I[9] * d[2],
    I[2] * d[0] + I[6] * d[1] + I[10] * d[2],
  ];
  treeOf(line, ray.bvhOptions).query(
    {
      origin: [
        I[0] * o[0] + I[4] * o[1] + I[8] * o[2] + I[12],
        I[1] * o[0] + I[5] * o[1] + I[9] * o[2] + I[13],
        I[2] * o[0] + I[6] * o[1] + I[10] * o[2] + I[14],
      ],
      direction: localDirection,
      near: ray.near,
      far: ray.far,
      radius: worldRadius,
      spread: pixelRadius * (view?.worldPerPixel ?? 0),
      depth,
      // Frobenius norm of the inverse: at least its largest singular value.
      scale: Math.hypot(I[0], I[1], I[2], I[4], I[5], I[6], I[8], I[9], I[10]),
    },
    visit,
  );
  collapse(found, mode, line.segmentCount, out);
}

/** Fraction along the segment (a, a + e) closest to the ray limited to near..far. */
function closestOnRay(
  o: ArrayLike<number>,
  d: ArrayLike<number>,
  a0: number,
  a1: number,
  a2: number,
  e0: number,
  e1: number,
  e2: number,
  near: number,
  far: number,
): number {
  const r0 = o[0] - a0,
    r1 = o[1] - a1,
    r2 = o[2] - a2,
    ee = e0 * e0 + e1 * e1 + e2 * e2;
  if (!ee) return 0;
  const b = d[0] * e0 + d[1] * e1 + d[2] * e2,
    c = d[0] * r0 + d[1] * r1 + d[2] * r2,
    f = e0 * r0 + e1 * r1 + e2 * r2,
    denominator = ee - b * b;
  // Parallel: start from the end nearer the ray origin.
  let s = denominator > 1e-12 * ee ? Math.min(Math.max((f - b * c) / denominator, 0), 1) : b > 0 ? 0 : 1;
  const t = s * b - c;
  if (t < near) s = Math.min(Math.max((f + near * b) / ee, 0), 1);
  else if (t > far) s = Math.min(Math.max((f + far * b) / ee, 0), 1);
  return s;
}

/** Distance from a point to the infinite ray line through `o` along unit `d`. */
function gapAt(o: ArrayLike<number>, d: ArrayLike<number>, x: number, y: number, z: number): number {
  const px = x - o[0],
    py = y - o[1],
    pz = z - o[2],
    t = px * d[0] + py * d[1] + pz * d[2];
  return Math.hypot(px - t * d[0], py - t * d[1], pz - t * d[2]);
}

/**
 * Fraction along the world segment (a, a + e) nearest the pointer on screen, or -1 when it is further than `radius`
 * pixels away or wholly behind the near plane. Clips at the near plane and projects as the line shader does.
 */
function closestOnScreen(
  view: PixelView,
  pointer: [number, number],
  radius: number,
  a0: number,
  a1: number,
  a2: number,
  e0: number,
  e1: number,
  e2: number,
): number {
  const m = view.matrix,
    wa = m[3] * a0 + m[7] * a1 + m[11] * a2 + m[15],
    we = m[3] * e0 + m[7] * e1 + m[11] * e2,
    za = m[2] * a0 + m[6] * a1 + m[10] * a2 + m[14],
    ze = m[2] * e0 + m[6] * e1 + m[10] * e2,
    fa = wa - za,
    fb = fa + we - ze;
  if (fa < 0 && fb < 0) return -1;
  const start = fa < 0 ? fa / (fa - fb) : 0,
    end = fb < 0 ? fa / (fa - fb) : 1,
    xa = m[0] * a0 + m[4] * a1 + m[8] * a2 + m[12],
    xe = m[0] * e0 + m[4] * e1 + m[8] * e2,
    ya = m[1] * a0 + m[5] * a1 + m[9] * a2 + m[13],
    ye = m[1] * e0 + m[5] * e1 + m[9] * e2,
    w0 = wa + start * we,
    w1 = wa + end * we;
  if (!(w0 > 0 && w1 > 0)) return -1;
  const x0 = ((xa + start * xe) / w0) * view.halfWidth,
    y0 = ((ya + start * ye) / w0) * view.halfHeight,
    dx = ((xa + end * xe) / w1) * view.halfWidth - x0,
    dy = ((ya + end * ye) / w1) * view.halfHeight - y0,
    px = pointer[0] - x0,
    py = pointer[1] - y0,
    length2 = dx * dx + dy * dy,
    along = length2 > 0 ? Math.min(Math.max((px * dx + py * dy) / length2, 0), 1) : 0;
  if (Math.hypot(px - along * dx, py - along * dy) > radius) return -1;
  // Straight on screen is not uniform in world under perspective: 1/w runs linearly on screen.
  const correct = (along * w0) / ((1 - along) * w1 + along * w0);
  return start + correct * (end - start);
}

/** Whether a world point is cut away, by the test the line shader applies. Planes are unit, from the material. */
function clipped(planes: readonly (readonly number[])[], any: boolean, p: MutableVec3): boolean {
  let behind = 0;
  for (const q of planes) if (q[0] * p[0] + q[1] * p[1] + q[2] * p[2] + q[3] < 0) behind++;
  return any ? behind > 0 : behind === planes.length;
}

/** Moves one hit per crossing to `out`: in a strip or loop, a run of neighbouring segments keeps its closest. */
function collapse<T extends PickableLine>(
  found: LineHit<T>[],
  mode: PickableLine['mode'],
  segments: number,
  out: LineHit<T>[],
): void {
  if (mode === 'segments') {
    out.push(...found);
    return;
  }
  found.sort((a, b) => a.segment - b.segment);
  const runs: LineHit<T>[] = [];
  let wraps = false;
  for (let i = 0; i < found.length; i++) {
    const hit = found[i],
      last = runs[runs.length - 1];
    if (i && hit.segment === found[i - 1].segment + 1) {
      // Equal to within rounding keeps the lower segment, so a pick on a shared point has one answer.
      if (hit.offset < last.offset - 1e-9 * (last.offset + hit.distance)) runs[runs.length - 1] = hit;
    } else runs.push(hit);
    wraps ||= mode === 'loop' && hit.segment === segments - 1 && found[0].segment === 0;
  }
  // A loop's closing segment touches segment 0: the first and last runs are one crossing.
  if (wraps && runs.length > 1) {
    const end = runs.pop()!;
    if (end.offset < runs[0].offset) runs[0] = end;
  }
  out.push(...runs);
}
