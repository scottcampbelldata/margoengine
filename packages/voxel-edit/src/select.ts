// Clean-room homogeneous projection and even-odd selection; research: docs/clean-room.md.
import type { GridSource } from './edit.js';
import { cellAt, cellIndex, cellLimit, checkGrid, checkOptions, type GridLimits } from './grid.js';
import { pickRay, raycastGrid } from './pick.js';
import { SparseGrid } from './sparse.js';

/** Normalized device coordinates (-1 to 1, Y up). Convert pointer pixels before calling. */
export type ScreenPoint = readonly [number, number];
/** A closed screen shape, boundary included. Lasso uses the even-odd rule, including self-crossings. */
export type ScreenShape =
  | { type: 'rectangle'; min: ScreenPoint; max: ScreenPoint }
  | { type: 'lasso'; points: readonly ScreenPoint[] };

/** Projection and visibility options for voxel selections. */
export interface ScreenSelectionOptions extends GridLimits {
  /** Optional column-major grid-local to world matrix. Default identity. */
  modelMatrix?: ArrayLike<number>;
  /** Only cells whose projected centre ray hits that cell first. Default false (select through). */
  visibleOnly?: boolean;
  /** Cancellation checked before iteration and for each occupied cell. */
  signal?: AbortSignal;
}

/** Colour similarity options. */
export interface ColorSelectionOptions extends ScreenSelectionOptions {
  /** Euclidean RGBA8 distance divided by 510, in [0, 1]. Default 0 (exact RGBA). */
  tolerance?: number;
}

function point(p: ScreenPoint): void {
  if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
    throw new TypeError('screen point must have two finite coordinates; pass [ndcX, ndcY]');
}

function matrix(value: ArrayLike<number>): number[] {
  if (value?.length !== 16 || !Array.from(value).every(Number.isFinite))
    throw new TypeError('selection matrix must hold 16 finite numbers; pass the camera view-projection matrix');
  return Array.from(value);
}

function contains(shape: ScreenShape): (x: number, y: number) => boolean {
  checkOptions(shape, 'selection shape');
  if (shape.type === 'rectangle') {
    point(shape.min);
    point(shape.max);
    const lo = [Math.min(shape.min[0], shape.max[0]), Math.min(shape.min[1], shape.max[1])],
      hi = [Math.max(shape.min[0], shape.max[0]), Math.max(shape.min[1], shape.max[1])];
    return (x, y) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1];
  }
  if (shape.type !== 'lasso' || !Array.isArray(shape.points) || shape.points.length < 3 || shape.points.length > 65536)
    throw new RangeError(
      'selection lasso needs 3 to 65536 points; pass a closed polygon without repeating the endpoint',
    );
  shape.points.forEach(point);
  const vertices = shape.points.map((p) => [...p]);
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const [ax, ay] = vertices[j],
        [bx, by] = vertices[i],
        cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
      if (
        cross === 0 &&
        x >= Math.min(ax, bx) &&
        x <= Math.max(ax, bx) &&
        y >= Math.min(ay, by) &&
        y <= Math.max(ay, by)
      )
        return true;
      if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
    }
    return inside;
  };
}

function select(
  source: GridSource,
  camera: ArrayLike<number>,
  shape: ScreenShape,
  options: ScreenSelectionOptions,
  accept: (value: number) => boolean,
): Float64Array {
  checkOptions(options, 'screen selection');
  options.signal?.throwIfAborted();
  const limit = cellLimit(options),
    sparse = source instanceof SparseGrid;
  if (!sparse) checkGrid(source, limit);
  else if (source.stats.filled > limit)
    throw new RangeError('screen selection exceeds maxCells; raise the occupied-cell budget');
  let clip = matrix(camera);
  if (options.modelMatrix !== undefined) {
    const model = matrix(options.modelMatrix),
      combined = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) combined[c * 4 + r] += clip[k * 4 + r] * model[c * 4 + k];
    clip = combined;
    if (!clip.every(Number.isFinite))
      throw new RangeError('selection transform overflowed; rescale the model and camera');
  }
  const visible = options.visibleOnly ?? false;
  if (typeof visible !== 'boolean') throw new TypeError('visibleOnly must be boolean; pass true or false');
  const inside = contains(shape),
    out: number[] = [];
  function visit(x: number, y: number, z: number, value: number) {
    options.signal?.throwIfAborted();
    if (!accept(value)) return;
    const px = x + 0.5,
      py = y + 0.5,
      pz = z + 0.5,
      w = clip[3] * px + clip[7] * py + clip[11] * pz + clip[15];
    if (!(w > 0)) return;
    const cx = clip[0] * px + clip[4] * py + clip[8] * pz + clip[12],
      cy = clip[1] * px + clip[5] * py + clip[9] * pz + clip[13],
      cz = clip[2] * px + clip[6] * py + clip[10] * pz + clip[14];
    // Margo's camera matrices use zero-to-one reverse depth on both GPU backends.
    if (!Number.isFinite(cx + cy + cz + w) || cx < -w || cx > w || cy < -w || cy > w || cz < 0 || cz > w) return;
    const sx = cx / w,
      sy = cy / w;
    if (!inside(sx, sy)) return;
    if (visible) {
      const ray = pickRay(clip, sx, sy),
        hit = ray && raycastGrid(source, ray);
      if (!hit || hit.cell[0] !== x || hit.cell[1] !== y || hit.cell[2] !== z) return;
    }
    out.push(cellIndex(source.size, x, y, z));
  }
  if (sparse) for (const [x, y, z, value] of source.filled()) visit(x, y, z, value);
  else
    for (let i = 0; i < source.voxels.length; i++)
      if (source.voxels[i]) visit(...cellAt(source.size, i), source.voxels[i]);
  return Float64Array.from(out.sort((a, b) => a - b));
}

/**
 * Selects filled cells whose centres project into a closed shape and the camera frustum, as indexes like ./edit.
 * Camera is the column-major view-projection (engine.camera.matrix), with optional modelMatrix for placement.
 * Sparse results preserve indexes above 2^32; dense and sparse results are sorted in ascending index order.
 * @throws RangeError for invalid lasso, budgets or overflowing transforms; pass bounded selection options.
 * @throws TypeError for invalid matrices, points or options; pass finite NDC inputs.
 */
export function screenSelection(
  source: GridSource,
  camera: ArrayLike<number>,
  shape: ScreenShape,
  options: ScreenSelectionOptions = {},
): Float64Array {
  return select(source, camera, shape, options, () => true);
}

/** Rectangle selection; either drag direction, boundary included, select-through by default. */
export function rectangleSelection(
  source: GridSource,
  camera: ArrayLike<number>,
  a: ScreenPoint,
  b: ScreenPoint,
  options: ScreenSelectionOptions = {},
): Float64Array {
  return screenSelection(source, camera, { type: 'rectangle', min: a, max: b }, options);
}

/** Closed even-odd lasso selection, including concave shapes and boundary centres. */
export function lassoSelection(
  source: GridSource,
  camera: ArrayLike<number>,
  points: readonly ScreenPoint[],
  options: ScreenSelectionOptions = {},
): Float64Array {
  return screenSelection(source, camera, { type: 'lasso', points }, options);
}

/**
 * Selects cells within a camera/shape whose RGBA matches reference palette index (1 to 255) within tolerance.
 * Equal RGBA entries match even with different palette indexes; this is global within the shape, not a flood.
 * @throws RangeError for invalid reference, palette or tolerance; pass 1024 palette bytes and a tolerance in [0,1].
 */
export function colorSelection(
  source: GridSource,
  camera: ArrayLike<number>,
  shape: ScreenShape,
  palette: Uint8Array,
  reference: number,
  options: ColorSelectionOptions = {},
): Float64Array {
  checkOptions(options, 'color selection');
  const tolerance = options.tolerance ?? 0;
  if (
    !(palette instanceof Uint8Array) ||
    palette.length !== 1024 ||
    !Number.isInteger(reference) ||
    reference < 1 ||
    reference > 255
  )
    throw new RangeError(
      'colour selection needs 1024 palette bytes and index 1 to 255; pass a valid palette and reference',
    );
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1)
    throw new RangeError('colour tolerance must be 0 to 1; pass a normalized RGBA distance');
  const matches = new Uint8Array(256),
    distance = (tolerance * 510) ** 2;
  for (let i = 1; i < 256; i++) {
    let sum = 0;
    for (let c = 0; c < 4; c++) sum += (palette[4 * i + c] - palette[4 * reference + c]) ** 2;
    if (sum <= distance) matches[i] = 1;
  }
  return select(source, camera, shape, options, (value) => !!matches[value]);
}
