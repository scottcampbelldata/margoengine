/** Structural shapes the math types accept, so any `{x, y, z}` (including a core `mesh.position`) works as input. */
export interface Vec2Like {
  x: number;
  y: number;
}
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
export interface Vec4Like {
  x: number;
  y: number;
  z: number;
  w: number;
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
