// The one home of the type-only shapes the Margo packages share (HANDOFF 5k gate 5). Everything here is erased at
// build time: importing it costs 0 runtime bytes. Packages import these instead of declaring their own copies.

/**
 * A 3D point, direction or Euler angle triple `[x, y, z]` (world units or radians, by context). Read-only, so any
 * `[x, y, z]` array (including a {@link MutableVec3}) is accepted. Declared once in `@margoengine/core` (frozen, and
 * upstream of this package) and re-exported here; import it from `@margoengine/math`.
 */
export type { Vec3 } from '@margoengine/core';

/** A 2D point or vector `[x, y]`. Read-only, so it accepts any `[x, y]` array. */
export type Vec2 = readonly [x: number, y: number];
/** A 4D vector `[x, y, z, w]`, e.g. a homogeneous point or an RGBA colour. Read-only. */
export type Vec4 = readonly [x: number, y: number, z: number, w: number];
/** A rotation quaternion `[x, y, z, w]` (unit length; w is the scalar part), as core `Mesh.setQuaternion` takes. */
export type Quat = readonly [x: number, y: number, z: number, w: number];
/** A writable `[x, y]`, for results callers may modify in place (curve points, polygon vertices). */
export type MutableVec2 = [x: number, y: number];
/** A writable `[x, y, z]`, for freshly allocated results callers may modify in place (the `vec3` helpers return it). */
export type MutableVec3 = [x: number, y: number, z: number];
/**
 * A column-major 4x4 matrix: 16 numbers (`number[]`, `Float32Array`, `Float64Array`), the layout of core
 * `camera.matrix`, mesh world matrices and WGSL `mat4x4f`. Element `[c * 4 + r]` is row r of column c.
 */
export type Mat4 = ArrayLike<number>;
/**
 * A colour as the packages accept it: `'#rrggbb'` or `'#rgb'` (sRGB), a `0xrrggbb` number (sRGB), or `[r, g, b]`
 * in linear RGB 0..1 like core `PbrMaterial`. Decode it with `parseColor` from `@margoengine/math/color`.
 */
export type ColorInput = string | number | readonly number[];
/** Ground height in world units at world position (x, z); must return a finite number for every finite input. */
export type HeightField = (x: number, z: number) => number;

/** Structural shapes the math classes accept, so any `{x, y}` works as input. */
export interface Vec2Like {
  x: number;
  y: number;
}
/** Any `{x, y, z}`, including a core `mesh.position` or a {@link Vector3}. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
/** Any `{x, y, z, w}`, including a {@link Vector4} or {@link Quaternion}. */
export interface Vec4Like {
  x: number;
  y: number;
  z: number;
  w: number;
}
/** A sphere: `center` and `radius` in world units (a negative radius means empty), such as a {@link Sphere}. */
export interface SphereLike {
  center: Vec3Like;
  radius: number;
}
/** A plane `normal · p + constant = 0` (`normal` unit length), such as a {@link Plane}. */
export interface PlaneLike {
  normal: Vec3Like;
  constant: number;
}
/** An axis-aligned box from `min` to `max` corners (empty when any min exceeds its max), such as a {@link Box3}. */
export interface BoxLike {
  min: Vec3Like;
  max: Vec3Like;
}
/** Column-major 3x3 (9) or 4x4 (16) elements, as in WGSL/WebGPU and three.js. */
export interface MatrixLike {
  readonly elements: ArrayLike<number>;
}
/** Anything indexable that can receive numbers: `number[]`, `Float32Array`, `Float64Array`, a GPU staging buffer view. */
export type NumberArray = { [index: number]: number };
/** Color space tags, spelled like three.js (`SRGBColorSpace`, `LinearSRGBColorSpace`). */
export type ColorSpace = 'srgb' | 'srgb-linear';
/** Euler rotation orders. `XYZ` matches core `mesh.rotation` and `setRotation`. */
export type EulerOrder = 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY';
