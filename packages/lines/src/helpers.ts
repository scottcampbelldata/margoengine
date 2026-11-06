// Debug helpers: grids, axes, boxes, arrows, camera frusta, planes and vertex normals, each a `Line` drawn as
// segments (two points per segment). Static helpers build their points once (and again when a setter is called);
// BoxHelper, CameraHelper and VertexNormalsHelper follow a mesh or camera and rebuild in `update` only when what they
// draw changed, writing into arrays they keep so steady frames neither allocate nor bump `version`.
import type { Camera, EngineKernel, Geometry, Mesh, Vec3 } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import { invertMatrix } from '@margoengine/math/mat4';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { meshTriangles, type MeshSource } from '../../shared/mesh-source.js';
import { parseColor, type ColorInput } from './color.js';
import { Line, type LineMaterialOptions } from './line.js';
import { copyIfChanged, finiteArray, transformPoint } from './math.js';

/**
 * Material options shared by every helper: everything a `LineMaterial` takes except `color`. Helpers default to
 * `cap: 'butt'` and `join: 'miter'`; options given here win.
 */
export type HelperOptions = Omit<LineMaterialOptions, 'color'>;

// Default palette. Mid-tone, saturated colours so every helper stays readable on both a dark and a light
// background (pure yellow vanishes on white, pure blue on black).
const GRID_CENTRE = '#8f8f8f';
const GRID_LINES = '#5e5e5e';
const OUTLINE = '#f0931e'; // Box3Helper, BoxHelper, ArrowHelper, PlaneHelper
const NORMALS = '#e8459a';
// Axes: a saturated colour at the origin fading to a lighter tint of the same hue at the tip.
const AXES: readonly (readonly [string, string])[] = [
  ['#f03c3c', '#ff9c9c'],
  ['#2fbf3f', '#9ee8a6'],
  ['#3a78f2', '#a3c1ff'],
];
// CameraHelper: frustum, eye-to-near cone, up marker, view axis, centre markers.
const CAMERA_FRUSTUM = '#f0a030';
const CAMERA_CONE = '#e0503c';
const CAMERA_UP = '#33b8e8';
const CAMERA_AXIS = '#a0a0a0';
const CAMERA_CENTRE = '#5cc45c';

/** Arrow head length as a fraction of the arrow length when `headLength` is not given. */
const HEAD_LENGTH = 0.25;
/** Arrow head diameter as a fraction of the head length when `headWidth` is not given (a cone of about 14 degrees). */
const HEAD_WIDTH = 0.5;
/** Spokes (and rim chords) of the arrow's wire cone: twelve reads as round at any size a debug arrow is drawn. */
const ARROW_SPOKES = 12;
/**
 * Above this |direction.y| the perpendicular basis is built from +Z instead of +Y, so the cross product never
 * degenerates; the switch sits far from the near-+Y directions people actually use, which therefore never flip.
 */
const BASIS_SWITCH = 0.999;

const styled = (options: HelperOptions) => ({ cap: 'butt' as const, join: 'miter' as const, ...options });
const linear = (color: ColorInput): number[] => Array.from(parseColor(color) as ArrayLike<number>);

function vector(value: ArrayLike<number> | undefined, label: string): [number, number, number] {
  if (!value || typeof value.length !== 'number' || value.length !== 3)
    throw new TypeError(`${label} needs 3 values; pass [x, y, z]`);
  finiteArray(value, label);
  return [value[0], value[1], value[2]];
}

function unitDirection(value: ArrayLike<number> | undefined, label: string): [number, number, number] {
  const [x, y, z] = vector(value, label),
    length = Math.hypot(x, y, z);
  if (!(length > 0)) throw new RangeError(`${label} must be nonzero; pass a direction with a length`);
  return [x / length, y / length, z / length];
}

/** Two unit vectors perpendicular to unit `d` and to each other (u, v, d right-handed). Shared by arrows and planes. */
function perpendiculars(d: readonly number[]): [number[], number[]] {
  // Reference axis r: +Y normally, +Z for directions within BASIS_SWITCH of the Y axis. u = r x d.
  const useZ = Math.abs(d[1]) > BASIS_SWITCH;
  let ux = useZ ? -d[1] : d[2],
    uy = useZ ? d[0] : 0,
    uz = useZ ? 0 : -d[0];
  const l = Math.hypot(ux, uy, uz);
  ux /= l;
  uy /= l;
  uz /= l;
  // v = d x u
  return [
    [ux, uy, uz],
    [d[1] * uz - d[2] * uy, d[2] * ux - d[0] * uz, d[0] * uy - d[1] * ux],
  ];
}

/** Writes the 12 edges of the box (x0..x1, y0..y1, z0..z1) into out as 24 points. */
function writeBoxEdges(out: Float32Array, lo: ArrayLike<number>, hi: ArrayLike<number>): void {
  let o = 0;
  const put = (a: number, b: number) => {
    // Corner bits: 1 = x high, 2 = y high, 4 = z high.
    for (const c of [a, b]) {
      out[o++] = c & 1 ? hi[0] : lo[0];
      out[o++] = c & 2 ? hi[1] : lo[1];
      out[o++] = c & 4 ? hi[2] : lo[2];
    }
  };
  // Each edge joins two corners that differ in one bit.
  for (let c = 0; c < 8; c++) for (const bit of [1, 2, 4]) if (!(c & bit)) put(c, c | bit);
}

/**
 * Square grid in the XZ plane (y = 0), centred on the origin: `divisions + 1` lines along each axis, `size` across.
 * With even `divisions` the two lines through the origin use `color1`, every other line `color2`; with odd
 * `divisions` no line passes through the origin and all use `color2`.
 * Defaults: size 10, divisions 10, color1 '#8f8f8f', color2 '#5e5e5e'.
 * @throws RangeError when `size` is not positive or `divisions` is not an integer from 1 to 10000.
 */
export class GridHelper extends Line {
  constructor(
    options: { size?: number; divisions?: number; color1?: ColorInput; color2?: ColorInput } & HelperOptions = {},
  ) {
    const { size = 10, divisions = 10, color1 = GRID_CENTRE, color2 = GRID_LINES, ...style } = options;
    if (!(size > 0) || !Number.isFinite(size) || !Number.isInteger(divisions) || divisions < 1 || divisions > 10000)
      throw new RangeError('Invalid grid size or divisions; pass a positive size and an integer divisions 1..10000');
    super({ ...styled(style), mode: 'segments' });
    const centre = linear(color1),
      rest = linear(color2),
      half = size / 2,
      lines = divisions + 1,
      positions = new Float32Array(lines * 12),
      colors = new Float32Array(lines * 12);
    let p = 0,
      c = 0;
    for (let i = 0; i < lines; i++) {
      const at = -half + (i * size) / divisions,
        colour = divisions % 2 === 0 && i * 2 === divisions ? centre : rest;
      // Parallel to X at z = at, then parallel to Z at x = at.
      positions.set([-half, 0, at, half, 0, at, at, 0, -half, at, 0, half], p);
      p += 12;
      for (let k = 0; k < 4; k++, c += 3) colors.set(colour, c);
    }
    this.setPositions(positions, colors);
  }
}

/**
 * Polar grid in the XZ plane: `sectors` radial lines from the origin and `rings` concentric circles (radius,
 * radius * (rings - 1) / rings, ... down to radius / rings), each drawn with `divisions` chords. Angles start on +Z and
 * turn toward +X (a point at angle a is (sin a, 0, cos a) * r). Sectors and rings alternate `color1` (even index,
 * the outermost ring first) and `color2`.
 * Defaults: radius 5, sectors 12, rings 5, divisions 72, color1 '#8f8f8f', color2 '#5e5e5e'.
 * @throws RangeError when `radius` is not positive, `sectors`, `rings` or `divisions` is not an integer in 0..4096,
 * or `divisions` is below 3.
 */
export class PolarGridHelper extends Line {
  constructor(
    options: {
      radius?: number;
      sectors?: number;
      rings?: number;
      divisions?: number;
      color1?: ColorInput;
      color2?: ColorInput;
    } & HelperOptions = {},
  ) {
    const {
      radius = 5,
      sectors = 12,
      rings = 5,
      divisions = 72,
      color1 = GRID_CENTRE,
      color2 = GRID_LINES,
      ...style
    } = options;
    const count = (n: number) => Number.isInteger(n) && n >= 0 && n <= 4096;
    if (
      !(radius > 0) ||
      !Number.isFinite(radius) ||
      !count(sectors) ||
      !count(rings) ||
      !count(divisions) ||
      divisions < 3
    )
      throw new RangeError(
        'Invalid polar grid options; pass a positive radius, sectors and rings 0..4096 and divisions 3..4096',
      );
    super({ ...styled(style), mode: 'segments' });
    const even = linear(color1),
      odd = linear(color2),
      points = 2 * sectors + 2 * rings * divisions,
      positions = new Float32Array(points * 3),
      colors = new Float32Array(points * 3);
    let p = 0;
    const put = (x: number, z: number, colour: number[]) => {
      positions[p] = x;
      positions[p + 2] = z;
      colors.set(colour, p);
      p += 3;
    };
    for (let i = 0; i < sectors; i++) {
      const a = (2 * Math.PI * i) / sectors,
        colour = i % 2 ? odd : even;
      put(0, 0, colour);
      put(Math.sin(a) * radius, Math.cos(a) * radius, colour);
    }
    for (let k = 0; k < rings; k++) {
      const r = (radius * (rings - k)) / rings,
        colour = k % 2 ? odd : even;
      for (let j = 0; j < divisions; j++) {
        const a0 = (2 * Math.PI * j) / divisions,
          a1 = (2 * Math.PI * (j + 1)) / divisions;
        put(Math.sin(a0) * r, Math.cos(a0) * r, colour);
        put(Math.sin(a1) * r, Math.cos(a1) * r, colour);
      }
    }
    this.setPositions(positions, colors);
  }
}

/**
 * The three positive axes from the origin, `size` long: X red, Y green, Z blue, each from a saturated colour at the
 * origin to a lighter tint at the tip. Default size 1.
 * @throws RangeError when `size` is not positive.
 */
export class AxesHelper extends Line {
  constructor(options: { size?: number } & HelperOptions = {}) {
    const { size = 1, ...style } = options;
    if (!(size > 0) || !Number.isFinite(size)) throw new RangeError('Axes size must be positive; pass a size above 0');
    super({ ...styled(style), mode: 'segments' });
    const colors: number[] = [];
    for (const [base, tip] of AXES) colors.push(...linear(base), ...linear(tip));
    this.setPositions([0, 0, 0, size, 0, 0, 0, 0, 0, 0, size, 0, 0, 0, 0, 0, 0, size], colors);
  }
  /**
   * With three colours: one flat colour per axis, in X, Y, Z order. Any other call (per-point numbers, or null to
   * remove the colours) is `Line.setColors`.
   */
  override setColors(x: ColorInput | ArrayLike<number> | null, y?: ColorInput, z?: ColorInput): this {
    if (y === undefined || z === undefined) return super.setColors(x as ArrayLike<number> | null);
    const colors: number[] = [];
    for (const colour of [x as ColorInput, y, z]) {
      const rgb = linear(colour);
      colors.push(...rgb, ...rgb);
    }
    return super.setColors(colors);
  }
}

/**
 * The 12 edges of the axis-aligned box from `min` to `max` (default -0.5..0.5 on every axis). A box with equal min
 * and max components is allowed. Default colour '#f0931e'.
 * @throws TypeError when min or max is not 3 values; RangeError when a value is not finite or min exceeds max.
 */
export class Box3Helper extends Line {
  private readonly corners = new Float32Array(72);
  constructor(
    min: Vec3 = [-0.5, -0.5, -0.5],
    max: Vec3 = [0.5, 0.5, 0.5],
    options: { color?: ColorInput } & HelperOptions = {},
  ) {
    const { color = OUTLINE, ...style } = options;
    super({ ...styled(style), color, mode: 'segments' });
    this.setBox(min, max);
  }
  /** Replaces the box, reusing the line's buffers. */
  setBox(min: Vec3, max: Vec3): this {
    const lo = vector(min, 'Box min'),
      hi = vector(max, 'Box max');
    if (lo.some((v, i) => v > hi[i])) throw new RangeError('Box min exceeds max; pass min <= max on every axis');
    writeBoxEdges(this.corners, lo, hi);
    return this.setPositions(this.corners);
  }
}

const boundsCache = new WeakMap<object, Float32Array>();

/**
 * Local axis-aligned bounds of a core Geometry as [minX, minY, minZ, maxX, maxY, maxZ], computed once per Geometry
 * (core geometries are immutable) and cached. An empty geometry gives infinite minima and negative infinite maxima.
 */
export function geometryBounds(geometry: Geometry): Float32Array {
  let bounds = boundsCache.get(geometry);
  if (bounds) return bounds;
  bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const v = geometry.vertices;
  // Core vertices: position xyz then normal xyz.
  for (let i = 0; i + 2 < v.length; i += 6)
    for (let axis = 0; axis < 3; axis++) {
      const value = v[i + axis];
      if (value < bounds[axis]) bounds[axis] = value;
      if (value > bounds[axis + 3]) bounds[axis + 3] = value;
    }
  boundsCache.set(geometry, bounds);
  return bounds;
}

/** Bind-pose bounds of a gltf-pro mesh source, cached per source (the bind pose does not change). */
function sourceBounds(source: MeshSource): Float32Array {
  let bounds = boundsCache.get(source);
  if (!bounds) boundsCache.set(source, (bounds = Float32Array.from(source.bounds)));
  return bounds;
}

const allFinite = (values: ArrayLike<number>): boolean => {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false;
  return true;
};

/**
 * World-space bounding box of a core mesh or a loaded gltf-pro (PBR) mesh: the axis-aligned box around the mesh's
 * local bounds transformed by its world matrix, refreshed each frame. PBR meshes use their bind-pose bounds (skinning
 * and morphing are not followed); nothing is read back from the GPU. Hidden while the mesh is removed or hidden.
 * Default colour '#f0931e'.
 * @throws whatever `mesh.check()` throws for a disposed mesh.
 */
export class BoxHelper extends Line {
  private followed: Mesh;
  private readonly seenMatrix = new Float32Array(16).fill(NaN);
  private readonly seenBounds = new Float32Array(6).fill(NaN);
  private seenSource: object | null = null;
  private readonly lo = new Float32Array(3);
  private readonly hi = new Float32Array(3);
  private readonly corner = new Float32Array(3);
  private readonly out = new Float32Array(72);
  constructor(mesh: Mesh, options: { color?: ColorInput } & HelperOptions = {}) {
    mesh.check();
    const { color = OUTLINE, ...style } = options;
    super({ ...styled(style), color, mode: 'segments' });
    this.followed = mesh;
    this.setPositions(this.out);
  }
  /** Follows another mesh from the next update on. */
  setFromMesh(mesh: Mesh): this {
    mesh.check();
    this.followed = mesh;
    this.seenSource = null;
    return this;
  }
  override update(engine: EngineKernel): boolean {
    const matrix = meshWorldMatrix(engine, this.followed);
    if (!matrix) return false;
    const triangles = meshTriangles(meshRuntime(this.followed) as unknown as Mesh);
    if (!triangles) return false;
    const [key, bounds] =
      triangles.kind === 'core'
        ? [triangles.geometry, geometryBounds(triangles.geometry)]
        : [triangles.source, sourceBounds(triangles.source)];
    if (!allFinite(matrix) || !allFinite(bounds)) return false;
    const sourceChanged = key !== this.seenSource,
      matrixChanged = copyIfChanged(this.seenMatrix, matrix),
      boundsChanged = copyIfChanged(this.seenBounds, bounds);
    if (!sourceChanged && !matrixChanged && !boundsChanged) return true;
    this.seenSource = key;
    const { lo, hi, corner } = this;
    lo.fill(Infinity);
    hi.fill(-Infinity);
    for (let c = 0; c < 8; c++) {
      transformPoint(corner, 0, matrix, bounds[c & 1 ? 3 : 0], bounds[c & 2 ? 4 : 1], bounds[c & 4 ? 5 : 2]);
      for (let axis = 0; axis < 3; axis++) {
        lo[axis] = Math.min(lo[axis], corner[axis]);
        hi[axis] = Math.max(hi[axis], corner[axis]);
      }
    }
    writeBoxEdges(this.out, lo, hi);
    this.setPositions(this.out);
    return true;
  }
}

/**
 * An arrow: a shaft from `origin` along `direction` (normalised; its length does not matter) and a wire-cone head
 * whose tip is `length` from the origin. The head is `headLength` long with a base `headWidth` across.
 * Defaults: direction [0, 0, 1], origin [0, 0, 0], length 1, headLength 0.25 * length, headWidth 0.5 * headLength,
 * colour '#f0931e', and `solidHead` false: true fills the cone, in the arrow's colour and unlit, and writes depth. The
 * first segment is the shaft, origin to head base.
 * @throws TypeError when direction or origin is not 3 values; RangeError when a value is not finite, the direction has
 * zero length, `length` is not positive, or a head size is negative or the head is longer than the arrow.
 */
export class ArrowHelper extends Line {
  private direction: number[];
  private origin: number[];
  private length = 1;
  private headLength = HEAD_LENGTH;
  private headWidth = HEAD_LENGTH * HEAD_WIDTH;
  private readonly out = new Float32Array((1 + 2 * ARROW_SPOKES) * 6);
  /** Each spoke's side and base triangle when the head is solid, else null. */
  private readonly cone: Float32Array | null;
  constructor(
    options: {
      direction?: Vec3;
      origin?: Vec3;
      length?: number;
      color?: ColorInput;
      headLength?: number;
      headWidth?: number;
      solidHead?: boolean;
    } & HelperOptions = {},
  ) {
    const {
      direction = [0, 0, 1],
      origin = [0, 0, 0],
      length = 1,
      color = OUTLINE,
      headLength,
      headWidth,
      solidHead = false,
      ...style
    } = options;
    super({ ...styled(style), color, mode: 'segments' });
    this.cone = solidHead ? new Float32Array(ARROW_SPOKES * 24) : null;
    this.direction = unitDirection(direction, 'Direction');
    this.origin = vector(origin, 'Arrow origin');
    this.setLength(length, headLength, headWidth);
  }
  /** Points the arrow along `direction` (normalised). */
  setDirection(direction: Vec3): this {
    this.direction = unitDirection(direction, 'Direction');
    return this.build();
  }
  /** Moves the arrow's start. */
  setOrigin(origin: Vec3): this {
    this.origin = vector(origin, 'Arrow origin');
    return this.build();
  }
  /** Sets the length; omitted head sizes take their defaults from the new length (0.25 of it, width half of that). */
  setLength(length: number, headLength = length * HEAD_LENGTH, headWidth = headLength * HEAD_WIDTH): this {
    const sizes = [length, headLength, headWidth];
    if (!sizes.every(Number.isFinite) || sizes.some((v) => v < 0) || length === 0 || headLength > length)
      throw new RangeError(
        'Invalid arrow length; pass a positive length and head sizes of 0 or more with headLength <= length',
      );
    this.length = length;
    this.headLength = headLength;
    this.headWidth = headWidth;
    return this.build();
  }
  private build(): this {
    const d = this.direction,
      o = this.origin,
      out = this.out,
      [u, v] = perpendiculars(d),
      along = this.length - this.headLength,
      radius = this.headWidth / 2,
      base = [o[0] + d[0] * along, o[1] + d[1] * along, o[2] + d[2] * along],
      tip = [o[0] + d[0] * this.length, o[1] + d[1] * this.length, o[2] + d[2] * this.length];
    out.set(o, 0);
    out.set(base, 3);
    const rim = (i: number, at: number) => {
      const a = (2 * Math.PI * i) / ARROW_SPOKES,
        cu = Math.cos(a) * radius,
        cv = Math.sin(a) * radius;
      for (let k = 0; k < 3; k++) out[at + k] = base[k] + u[k] * cu + v[k] * cv;
    };
    for (let i = 0; i < ARROW_SPOKES; i++) {
      const spoke = 6 + i * 12;
      out.set(tip, spoke);
      rim(i, spoke + 3);
      rim(i, spoke + 6);
      rim(i + 1, spoke + 9);
    }
    const cone = this.cone;
    if (cone) {
      const corner = (at: number, from: ArrayLike<number>, offset: number) => {
        for (let k = 0; k < 3; k++) cone[at + k] = from[offset + k];
        cone[at + 3] = 1;
      };
      for (let i = 0; i < ARROW_SPOKES; i++) {
        const spoke = 6 + i * 12,
          at = i * 24;
        corner(at, tip, 0);
        corner(at + 4, out, spoke + 6);
        corner(at + 8, out, spoke + 9);
        corner(at + 12, base, 0);
        corner(at + 16, out, spoke + 9);
        corner(at + 20, out, spoke + 6);
      }
      this.setFill(cone, true);
    }
    return this.setPositions(out);
  }
}

// CameraHelper layout, in normalised device coordinates (WebGPU, reversed Z: near z = 1, far z = 0). Each entry is one
// segment: [x0, y0, z0, x1, y1, z1, colour index]; NaN coordinates stand for the camera position.
const E = Number.NaN;
const NEAR = 1,
  FAR = 0;
const CAMERA_SEGMENTS: readonly (readonly number[])[] = (() => {
  const s: number[][] = [];
  const rect = (z: number) => {
    const c = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (let i = 0; i < 4; i++) s.push([...c[i], z, ...c[(i + 1) % 4], z, 0]);
  };
  rect(NEAR);
  rect(FAR);
  for (const [x, y] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    s.push([x, y, NEAR, x, y, FAR, 0]);
    s.push([E, E, E, x, y, NEAR, 1]);
  }
  // Up marker: an arrow standing on the near plane above its top edge (stem and two barbs).
  s.push([0, 1.15, NEAR, 0, 1.75, NEAR, 2]);
  s.push([-0.3, 1.45, NEAR, 0, 1.75, NEAR, 2]);
  s.push([0.3, 1.45, NEAR, 0, 1.75, NEAR, 2]);
  // View axis, near centre to far centre.
  s.push([0, 0, NEAR, 0, 0, FAR, 3]);
  // Centre crosses on both planes and the line from the eye to the near centre.
  for (const z of [NEAR, FAR]) {
    s.push([-0.25, 0, z, 0.25, 0, z, 4]);
    s.push([0, -0.25, z, 0, 0.25, z, 4]);
  }
  s.push([E, E, E, 0, 0, NEAR, 4]);
  return s;
})();

/**
 * A core `Camera`'s view frustum in world space, unprojected from `camera.matrix` each time it changes: the 12
 * frustum edges (amber '#f0a030'), lines from the camera position to the near corners (red '#e0503c'), an up arrow
 * above the near plane's top edge (sky blue '#33b8e8'), the view axis from near centre to far centre (grey
 * '#a0a0a0'), and centre crosses on both planes plus a line from the camera to the near centre (green '#5cc45c').
 * A camera other than the engine's is updated first with `aspect`, or the canvas aspect when that is unset.
 * Expects a WebGPU reversed-Z matrix (near plane at z = 1).
 */
export class CameraHelper extends Line {
  /** Aspect ratio for updating a camera that is not the engine's; unset uses the canvas width over height. */
  aspect?: number;
  private readonly seen = new Float32Array(16).fill(NaN);
  private readonly inverse = new Float64Array(16);
  private readonly out = new Float32Array(CAMERA_SEGMENTS.length * 6);
  constructor(
    /** The camera drawn. */
    readonly camera: Camera,
    options: { aspect?: number } & HelperOptions = {},
  ) {
    const { aspect, ...style } = options;
    super({ ...styled(style), mode: 'segments' });
    this.aspect = aspect;
    const palette = [CAMERA_FRUSTUM, CAMERA_CONE, CAMERA_UP, CAMERA_AXIS, CAMERA_CENTRE].map(linear),
      colors: number[] = [];
    for (const segment of CAMERA_SEGMENTS) colors.push(...palette[segment[6]], ...palette[segment[6]]);
    this.setPositions(this.out, colors);
  }
  override update(engine: EngineKernel): boolean {
    const camera = this.camera;
    if (camera !== engine.camera)
      camera.update(this.aspect ?? engine.canvas.width / Math.max(1, engine.canvas.height), true);
    const m = camera.matrix;
    let changed = false;
    for (let i = 0; i < 16; i++) if (this.seen[i] !== m[i]) changed = true;
    if (!changed || !invertMatrix(m, this.inverse)) return true;
    this.seen.set(m);
    const inv = this.inverse,
      out = this.out,
      eye = camera.position;
    let o = 0;
    const put = (x: number, y: number, z: number) => {
      if (Number.isNaN(x)) {
        out[o] = eye[0];
        out[o + 1] = eye[1];
        out[o + 2] = eye[2];
      } else {
        const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15] || 1;
        out[o] = (inv[0] * x + inv[4] * y + inv[8] * z + inv[12]) / w;
        out[o + 1] = (inv[1] * x + inv[5] * y + inv[9] * z + inv[13]) / w;
        out[o + 2] = (inv[2] * x + inv[6] * y + inv[10] * z + inv[14]) / w;
      }
      o += 3;
    };
    for (const s of CAMERA_SEGMENTS) {
      put(s[0], s[1], s[2]);
      put(s[3], s[4], s[5]);
    }
    if (allFinite(out)) this.setPositions(out);
    return true;
  }
}

/**
 * The plane `normal . p + constant = 0` (the normal need not be unit length): a square `size` across centred on the
 * point of the plane nearest the origin, with both diagonals. Its in-plane rotation uses the same basis as ArrowHelper.
 * `fillOpacity` above 0 also fills the square in the same colour, unlit; at 1 it writes depth.
 * Defaults: normal [0, 1, 0], constant 0, size 1, colour '#f0931e', fillOpacity 0.
 * @throws TypeError when the normal is not 3 values; RangeError when it is not finite or zero, `constant` is not
 * finite, `size` is not positive, or `fillOpacity` is outside 0..1.
 */
export class PlaneHelper extends Line {
  private readonly out = new Float32Array(36);
  /** Two triangles when the plane is filled, else null. */
  private readonly square: Float32Array | null;
  private readonly fillOpacity: number;
  constructor(
    options: { normal?: Vec3; constant?: number; size?: number; color?: ColorInput; fillOpacity?: number } & HelperOptions = {},
  ) {
    const { normal = [0, 1, 0], constant = 0, size = 1, color = OUTLINE, fillOpacity = 0, ...style } = options;
    super({ ...styled(style), color, mode: 'segments' });
    if (!(fillOpacity >= 0 && fillOpacity <= 1)) throw new RangeError('Fill opacity must be 0..1');
    this.fillOpacity = fillOpacity;
    this.square = fillOpacity ? new Float32Array(24) : null;
    this.setPlane(normal, constant, size);
  }
  /** Replaces the plane, reusing the line's buffers. */
  setPlane(normal: Vec3, constant = 0, size = 1): this {
    const raw = vector(normal, 'Direction'),
      length = Math.hypot(raw[0], raw[1], raw[2]);
    if (!(length > 0)) throw new RangeError('Direction must be nonzero; pass a plane normal with a length');
    if (!Number.isFinite(constant) || !(size > 0) || !Number.isFinite(size))
      throw new RangeError('Invalid plane; pass a finite constant and a positive size');
    const n = raw.map((v) => v / length),
      offset = -constant / length,
      centre = n.map((v) => v * offset),
      [u, v] = perpendiculars(n),
      h = size / 2,
      corner = (a: number, b: number) => [0, 1, 2].map((k) => centre[k] + (u[k] * a + v[k] * b) * h);
    const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    let o = 0;
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [0, 2],
      [1, 3],
    ]) {
      this.out.set(c[a], o);
      this.out.set(c[b], o + 3);
      o += 6;
    }
    const square = this.square;
    if (square) {
      [0, 1, 2, 0, 2, 3].forEach((corner, i) => {
        square.set(c[corner], i * 4);
        square[i * 4 + 3] = this.fillOpacity;
      });
      this.setFill(square, this.fillOpacity === 1);
    }
    return this.setPositions(this.out);
  }
}

/** Vertex arrays of a mesh's triangle source with their stride and normal offset. */
function vertexArrays(triangles: NonNullable<ReturnType<typeof meshTriangles>>): {
  arrays: readonly ArrayLike<number>[];
  stride: number;
  normal: number;
} {
  if (triangles.kind === 'core') return { arrays: [triangles.geometry.vertices], stride: 6, normal: 3 };
  return { arrays: triangles.source.primitives.map((p) => p.vertices), stride: 20, normal: 4 };
}

/**
 * One world-space line per vertex of a core mesh or a loaded gltf-pro (PBR) mesh (bind pose), from the vertex along
 * its normal, `size` long (default 1). Normals go through the inverse transpose of the world matrix, so non-uniform
 * scales and mirrors keep them perpendicular to the surface. Hidden while the mesh is removed or hidden or its world
 * matrix is singular. Default colour '#e8459a'.
 * @throws whatever `mesh.check()` throws for a disposed mesh; RangeError from `update` when `size` is not finite.
 */
export class VertexNormalsHelper extends Line {
  /** Line length in world units. */
  size: number;
  private readonly seenMatrix = new Float32Array(16).fill(NaN);
  private seenSource: object | null = null;
  private seenSize = NaN;
  private valid = false;
  private out = new Float32Array(6);
  constructor(
    /** The mesh whose normals are drawn. */
    readonly mesh: Mesh,
    options: { size?: number; color?: ColorInput } & HelperOptions = {},
  ) {
    mesh.check();
    const { size = 1, color = NORMALS, ...style } = options;
    super({ ...styled(style), color, mode: 'segments' });
    this.size = size;
    this.setPositions(this.out);
  }
  override update(engine: EngineKernel): boolean {
    if (!Number.isFinite(this.size))
      throw new RangeError('VertexNormalsHelper size must be finite; set size to a length in world units');
    const m = meshWorldMatrix(engine, this.mesh);
    if (!m) return false;
    const triangles = meshTriangles(meshRuntime(this.mesh) as unknown as Mesh);
    if (!triangles || !allFinite(m)) return false;
    const key = triangles.kind === 'core' ? triangles.geometry : triangles.source,
      matrixChanged = copyIfChanged(this.seenMatrix, m);
    if (!matrixChanged && key === this.seenSource && this.size === this.seenSize) return this.valid;
    this.seenSource = key;
    this.seenSize = this.size;
    // Columns of the upper 3x3, and the inverse transpose as (a1 x a2, a2 x a0, a0 x a1) / det.
    const a0 = [m[0], m[1], m[2]],
      a1 = [m[4], m[5], m[6]],
      a2 = [m[8], m[9], m[10]],
      cross = (p: number[], q: number[]) => [
        p[1] * q[2] - p[2] * q[1],
        p[2] * q[0] - p[0] * q[2],
        p[0] * q[1] - p[1] * q[0],
      ],
      c0 = cross(a1, a2),
      c1 = cross(a2, a0),
      c2 = cross(a0, a1),
      det = a0[0] * c0[0] + a0[1] * c0[1] + a0[2] * c0[2];
    if (!det || !Number.isFinite(det)) return (this.valid = false);
    const { arrays, stride, normal } = vertexArrays(triangles);
    let count = 0;
    for (const array of arrays) count += Math.floor(array.length / stride);
    if (!count) return (this.valid = false);
    if (this.out.length !== count * 6) this.out = new Float32Array(count * 6);
    const out = this.out,
      sign = det < 0 ? -1 : 1;
    let o = 0;
    for (const v of arrays)
      for (let i = 0; i + stride <= v.length; i += stride) {
        transformPoint(out, o, m, v[i], v[i + 1], v[i + 2]);
        const nx = v[i + normal],
          ny = v[i + normal + 1],
          nz = v[i + normal + 2];
        let wx = (c0[0] * nx + c1[0] * ny + c2[0] * nz) * sign,
          wy = (c0[1] * nx + c1[1] * ny + c2[1] * nz) * sign,
          wz = (c0[2] * nx + c1[2] * ny + c2[2] * nz) * sign;
        const l = Math.hypot(wx, wy, wz);
        const scale = l > 0 ? this.size / l : 0;
        wx *= scale;
        wy *= scale;
        wz *= scale;
        out[o + 3] = out[o] + wx;
        out[o + 4] = out[o + 1] + wy;
        out[o + 5] = out[o + 2] + wz;
        o += 6;
      }
    if (!allFinite(out)) return (this.valid = false);
    this.setPositions(out);
    return (this.valid = true);
  }
}
