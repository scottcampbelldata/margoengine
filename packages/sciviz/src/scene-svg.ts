// An engine scene as a vector picture: every visible mesh, line and point cloud is projected through a camera and written as
// SVG paths with the hidden surfaces removed. The hidden-surface step is `exportVectorScene`'s (this package's `export-vector`):
// a binary space partition of the projected polygons painted back to front (the painter's algorithm of Newell, Newell and
// Sancha, "A Solution to the Hidden Surface Problem", ACM Annual Conference 1972, with the splitting of crossing polygons that
// the ordering needs; Sutherland, Sproull and Schumacker, "A Characterization of Ten Hidden-Surface Algorithms", ACM Computing
// Surveys 6(1), 1974, on the sort-and-paint class; Fuchs, Kedem and Naylor, "On Visible Surface Generation by A Priori Tree
// Structures", SIGGRAPH 1980, for the partition tree). This file collects the scene, puts it in world space and shades it.
import type { Camera, EngineKernel } from '@margoengine/core';
import { rangeError } from '../../shared/errors.js';
import type { VectorExport, VectorExportOptions, VectorGeometry } from './export-vector.js';
import { exportVectorScene } from './export-vector.js';

/** What {@link exportSceneSVG} projects: an engine, or an exporters scene (`{nodes}`). */
export type SceneSVGSource = Parameters<typeof import('@margoengine/exporters/collect').collect>[0];
/** Options for {@link exportSceneSVG}; the budget options of `exportVectorScene` apply too. */
export interface SceneSVGOptions extends VectorExportOptions {
  /** Output width in CSS pixels. Default the engine canvas's width, else 800. */
  width?: number;
  /** Output height in CSS pixels. Default the engine canvas's height, else 600. */
  height?: number;
  /** The view: a core `Camera`, or a column-major view-projection matrix in the WebGPU depth convention. Default `engine.camera`. */
  camera?: Camera | { matrix: ArrayLike<number> };
  /** CSS background. Default transparent. */
  background?: string;
  /** Skip hidden meshes and their descendants. Default true. */
  onlyVisible?: boolean;
  /** Draw only this engine mesh and its descendants. Default the whole scene. */
  root?: unknown;
  /** Shade each triangle by a light at the camera: ambient plus the cosine to the viewer. Default true; false paints flat material colours. */
  shade?: boolean;
  /** Ambient share of the shading, 0 to 1. Default 0.3. */
  ambient?: number;
  /** Drop triangles facing away from a `Camera` when their material is single-sided. Default true. */
  cullBackFaces?: boolean;
  /** CSS width of a line. Default 1.5. */
  lineWidth?: number;
  /** CSS diameter of a point. Default 3. */
  pointSize?: number;
}

const srgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Projects the scene's meshes, lines and points through the camera into SVG, hidden surfaces removed.
 * @throws RangeError for a bad size, ambient or camera (nothing is written), and the budget errors of `exportVectorScene`.
 */
export async function exportSceneSVG(source: SceneSVGSource, options: SceneSVGOptions = {}): Promise<VectorExport> {
  const { collect, drawables, polylines } = await import('@margoengine/exporters/collect');
  const engine = source as Partial<EngineKernel> & { canvas?: { width: number; height: number } };
  const width = options.width ?? engine.canvas?.width ?? 800,
    height = options.height ?? engine.canvas?.height ?? 600,
    ambient = options.ambient ?? 0.3,
    shade = options.shade ?? true,
    lineWidth = options.lineWidth ?? 1.5,
    pointSize = options.pointSize ?? 3;
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width + height))
    throw rangeError('exportSceneSVG needs a finite width and height above 0', 'sciviz');
  if (!(ambient >= 0 && ambient <= 1)) throw rangeError('ambient must be from 0 to 1', 'sciviz');
  const camera = (options.camera ?? engine.camera) as (Camera | { matrix: ArrayLike<number> }) | undefined;
  if (!camera) throw rangeError('exportSceneSVG needs a camera: pass `camera`, or an engine that has one', 'sciviz');
  let eye: ArrayLike<number> | undefined;
  if ('update' in camera && typeof camera.update === 'function') {
    camera.update(width / height, true);
    eye = camera.position;
  }
  const matrix = Array.from(camera.matrix);
  if (matrix.length !== 16 || matrix.some((x) => !Number.isFinite(x)))
    throw rangeError('camera.matrix must be 16 finite numbers', 'sciviz');
  const items = drawables(
    collect(source, { onlyVisible: options.onlyVisible, root: options.root as never }, undefined, 'refuse', [
      'points',
      'lines',
    ]),
    true,
  );
  const geometry: VectorGeometry[] = [];
  for (const { geometry: g, material, world } of items) {
    const base = material?.color ?? [1, 1, 1, 1],
      rgb = [srgb(clamp01(base[0])), srgb(clamp01(base[1])), srgb(clamp01(base[2]))],
      alpha = clamp01(base[3] ?? 1),
      at = (i: number, out: number[]) => {
        const x = g.positions[3 * i],
          y = g.positions[3 * i + 1],
          z = g.positions[3 * i + 2];
        out[0] = world[0] * x + world[4] * y + world[8] * z + world[12];
        out[1] = world[1] * x + world[5] * y + world[9] * z + world[13];
        out[2] = world[2] * x + world[6] * y + world[10] * z + world[14];
      };
    const a = [0, 0, 0],
      b = [0, 0, 0],
      c = [0, 0, 0];
    if (g.topology === 'points') {
      const positions: number[] = [];
      for (const i of g.indices) {
        at(i, a);
        positions.push(a[0], a[1], a[2]);
      }
      if (positions.length)
        geometry.push({
          kind: 'points',
          positions,
          colors: Array.from({ length: positions.length / 3 }, () => [...rgb, alpha]).flat(),
          width: pointSize,
        });
      continue;
    }
    if (g.topology === 'lines') {
      for (const run of polylines(g.indices)) {
        const positions: number[] = [];
        for (const i of run) {
          at(i, a);
          positions.push(a[0], a[1], a[2]);
        }
        geometry.push({
          kind: 'line',
          positions,
          colors: Array.from({ length: run.length }, () => [...rgb, alpha]).flat(),
          width: lineWidth,
        });
      }
      continue;
    }
    const positions: number[] = [],
      colors: number[] = [],
      cull = (options.cullBackFaces ?? true) && eye !== undefined && !material?.doubleSided;
    for (let t = 0; t + 2 < g.indices.length; t += 3) {
      at(g.indices[t], a);
      at(g.indices[t + 1], b);
      at(g.indices[t + 2], c);
      let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const length = Math.hypot(nx, ny, nz);
      if (!length) continue;
      nx /= length;
      ny /= length;
      nz /= length;
      let facing = 1;
      if (eye) {
        const dx = eye[0] - (a[0] + b[0] + c[0]) / 3,
          dy = eye[1] - (a[1] + b[1] + c[1]) / 3,
          dz = eye[2] - (a[2] + b[2] + c[2]) / 3,
          d = Math.hypot(dx, dy, dz) || 1;
        facing = (nx * dx + ny * dy + nz * dz) / d;
        if (cull && facing < 0) continue;
      }
      const light = shade ? ambient + (1 - ambient) * Math.abs(facing) : 1;
      positions.push(...a, ...b, ...c);
      for (let k = 0; k < 3; k++) colors.push(rgb[0] * light, rgb[1] * light, rgb[2] * light, alpha);
    }
    if (positions.length) geometry.push({ kind: 'triangles', positions, colors });
  }
  return exportVectorScene({ width, height, matrix, geometry, background: options.background }, options);
}
