export interface Orthographic {sx: number; sy: number; sz: number; ox: number; oy: number; near: number; far: number}
export function orthographic(matrix: ArrayLike<number> | undefined, eye: ArrayLike<number>): Orthographic | null;
