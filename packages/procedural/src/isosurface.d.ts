declare module 'isosurface' {
  export function marchingCubes(dimensions: readonly number[], field: (x: number, y: number, z: number) => number, bounds: readonly (readonly number[])[]): {positions: number[][]; cells: number[][]};
}
